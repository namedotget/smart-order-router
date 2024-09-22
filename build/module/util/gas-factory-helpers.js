import { BigNumber } from '@ethersproject/bignumber';
import { Protocol } from '@uniswap/router-sdk';
import { ChainId, Percent, Token, TradeType } from '@uniswap/sdk-core';
import { FeeAmount } from '@uniswap/v3-sdk';
import brotli from 'brotli';
import JSBI from 'jsbi';
import _ from 'lodash';
import { getQuoteThroughNativePool, MixedRouteWithValidQuote, SwapType, usdGasTokensByChain, V2RouteWithValidQuote, V3RouteWithValidQuote, } from '../routers';
import { CurrencyAmount, log, WRAPPED_NATIVE_CURRENCY } from '../util';
import { opStackChains } from './l2FeeChains';
import { buildSwapMethodParameters, buildTrade } from './methodParameters';
import { estimateL1Gas, estimateL1GasCost } from '@eth-optimism/sdk';
export async function getV2NativePool(token, poolProvider, providerConfig) {
    const chainId = token.chainId;
    const weth = WRAPPED_NATIVE_CURRENCY[chainId];
    const poolAccessor = await poolProvider.getPools([[weth, token]], providerConfig);
    const pool = poolAccessor.getPool(weth, token);
    if (!pool || pool.reserve0.equalTo(0) || pool.reserve1.equalTo(0)) {
        log.error({
            weth,
            token,
            reserve0: pool === null || pool === void 0 ? void 0 : pool.reserve0.toExact(),
            reserve1: pool === null || pool === void 0 ? void 0 : pool.reserve1.toExact(),
        }, `Could not find a valid WETH V2 pool with ${token.symbol} for computing gas costs.`);
        return null;
    }
    return pool;
}
export async function getHighestLiquidityV3NativePool(token, poolProvider, providerConfig) {
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[token.chainId];
    const nativePools = _([
        FeeAmount.HIGH,
        FeeAmount.MEDIUM,
        FeeAmount.LOW,
        FeeAmount.LOWEST,
    ])
        .map((feeAmount) => {
        return [nativeCurrency, token, feeAmount];
    })
        .value();
    const poolAccessor = await poolProvider.getPools(nativePools, providerConfig);
    const pools = _([
        FeeAmount.HIGH,
        FeeAmount.MEDIUM,
        FeeAmount.LOW,
        FeeAmount.LOWEST,
    ])
        .map((feeAmount) => {
        return poolAccessor.getPool(nativeCurrency, token, feeAmount);
    })
        .compact()
        .value();
    if (pools.length == 0) {
        log.error({ pools }, `Could not find a ${nativeCurrency.symbol} pool with ${token.symbol} for computing gas costs.`);
        return null;
    }
    const maxPool = pools.reduce((prev, current) => {
        return JSBI.greaterThan(prev.liquidity, current.liquidity) ? prev : current;
    });
    return maxPool;
}
export async function getHighestLiquidityV3USDPool(chainId, poolProvider, providerConfig) {
    const usdTokens = usdGasTokensByChain[chainId];
    const wrappedCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
    if (!usdTokens) {
        throw new Error(`Could not find a USD token for computing gas costs on ${chainId}`);
    }
    const usdPools = _([
        FeeAmount.HIGH,
        FeeAmount.MEDIUM,
        FeeAmount.LOW,
        FeeAmount.LOWEST,
    ])
        .flatMap((feeAmount) => {
        return _.map(usdTokens, (usdToken) => [
            wrappedCurrency,
            usdToken,
            feeAmount,
        ]);
    })
        .value();
    const poolAccessor = await poolProvider.getPools(usdPools, providerConfig);
    const pools = _([
        FeeAmount.HIGH,
        FeeAmount.MEDIUM,
        FeeAmount.LOW,
        FeeAmount.LOWEST,
    ])
        .flatMap((feeAmount) => {
        const pools = [];
        for (const usdToken of usdTokens) {
            const pool = poolAccessor.getPool(wrappedCurrency, usdToken, feeAmount);
            if (pool) {
                pools.push(pool);
            }
        }
        return pools;
    })
        .compact()
        .value();
    if (pools.length == 0) {
        const message = `Could not find a USD/${wrappedCurrency.symbol} pool for computing gas costs.`;
        log.error({ pools }, message);
        throw new Error(message);
    }
    const maxPool = pools.reduce((prev, current) => {
        return JSBI.greaterThan(prev.liquidity, current.liquidity) ? prev : current;
    });
    return maxPool;
}
export function getGasCostInNativeCurrency(nativeCurrency, gasCostInWei) {
    // wrap fee to native currency
    const costNativeCurrency = CurrencyAmount.fromRawAmount(nativeCurrency, gasCostInWei.toString());
    return costNativeCurrency;
}
export function getArbitrumBytes(data) {
    if (data == '')
        return BigNumber.from(0);
    const compressed = brotli.compress(Buffer.from(data.replace('0x', ''), 'hex'), {
        mode: 0,
        quality: 1,
        lgwin: 22,
    });
    // TODO: This is a rough estimate of the compressed size
    // Brotli 0 should be used, but this brotli library doesn't support it
    // https://github.com/foliojs/brotli.js/issues/38
    // There are other brotli libraries that do support it, but require async
    // We workaround by using Brotli 1 with a 20% bump in size
    return BigNumber.from(compressed.length).mul(120).div(100);
}
export function calculateArbitrumToL1FeeFromCalldata(calldata, gasData, chainId) {
    const { perL2TxFee, perL1CalldataFee, perArbGasTotal } = gasData;
    // calculates gas amounts based on bytes of calldata, use 0 as overhead.
    const l1GasUsed = getL2ToL1GasUsed(calldata, chainId);
    // multiply by the fee per calldata and add the flat l2 fee
    const l1Fee = l1GasUsed.mul(perL1CalldataFee).add(perL2TxFee);
    const gasUsedL1OnL2 = l1Fee.div(perArbGasTotal);
    return [l1GasUsed, l1Fee, gasUsedL1OnL2];
}
export async function calculateOptimismToL1FeeFromCalldata(calldata, chainId, provider) {
    const tx = {
        data: calldata,
        chainId: chainId,
        type: 2 // sign the transaction as EIP-1559, otherwise it will fail at maxFeePerGas
    };
    const [l1GasUsed, l1GasCost] = await Promise.all([estimateL1Gas(provider, tx), estimateL1GasCost(provider, tx)]);
    return [l1GasUsed, l1GasCost];
}
export function getL2ToL1GasUsed(data, chainId) {
    switch (chainId) {
        case ChainId.ARBITRUM_ONE:
        case ChainId.ARBITRUM_GOERLI: {
            // calculates bytes of compressed calldata
            const l1ByteUsed = getArbitrumBytes(data);
            return l1ByteUsed.mul(16);
        }
        default:
            return BigNumber.from(0);
    }
}
export async function calculateGasUsed(chainId, route, simulatedGasUsed, v2PoolProvider, v3PoolProvider, provider, providerConfig) {
    const quoteToken = route.quote.currency.wrapped;
    const gasPriceWei = route.gasPriceWei;
    // calculate L2 to L1 security fee if relevant
    let l2toL1FeeInWei = BigNumber.from(0);
    // Arbitrum charges L2 gas for L1 calldata posting costs.
    // See https://github.com/Uniswap/smart-order-router/pull/464/files#r1441376802
    if (opStackChains.includes(chainId)) {
        l2toL1FeeInWei = (await calculateOptimismToL1FeeFromCalldata(route.methodParameters.calldata, chainId, provider))[1];
    }
    // add l2 to l1 fee and wrap fee to native currency
    const gasCostInWei = gasPriceWei.mul(simulatedGasUsed).add(l2toL1FeeInWei);
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
    const costNativeCurrency = getGasCostInNativeCurrency(nativeCurrency, gasCostInWei);
    const usdPool = await getHighestLiquidityV3USDPool(chainId, v3PoolProvider, providerConfig);
    /** ------ MARK: USD logic  -------- */
    const gasCostUSD = getQuoteThroughNativePool(chainId, costNativeCurrency, usdPool);
    /** ------ MARK: Conditional logic run if gasToken is specified  -------- */
    let gasCostInTermsOfGasToken = undefined;
    if (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.gasToken) {
        if (providerConfig.gasToken.equals(nativeCurrency)) {
            gasCostInTermsOfGasToken = costNativeCurrency;
        }
        else {
            const nativeAndSpecifiedGasTokenPool = await getHighestLiquidityV3NativePool(providerConfig.gasToken, v3PoolProvider, providerConfig);
            if (nativeAndSpecifiedGasTokenPool) {
                gasCostInTermsOfGasToken = getQuoteThroughNativePool(chainId, costNativeCurrency, nativeAndSpecifiedGasTokenPool);
            }
            else {
                log.info(`Could not find a V3 pool for gas token ${providerConfig.gasToken.symbol}`);
            }
        }
    }
    /** ------ MARK: Main gas logic in terms of quote token -------- */
    let gasCostQuoteToken = undefined;
    // shortcut if quote token is native currency
    if (quoteToken.equals(nativeCurrency)) {
        gasCostQuoteToken = costNativeCurrency;
    }
    // get fee in terms of quote token
    else {
        const nativePools = await Promise.all([
            getHighestLiquidityV3NativePool(quoteToken, v3PoolProvider, providerConfig),
            getV2NativePool(quoteToken, v2PoolProvider, providerConfig),
        ]);
        const nativePool = nativePools.find((pool) => pool !== null);
        if (!nativePool) {
            log.info('Could not find any V2 or V3 pools to convert the cost into the quote token');
            gasCostQuoteToken = CurrencyAmount.fromRawAmount(quoteToken, 0);
        }
        else {
            gasCostQuoteToken = getQuoteThroughNativePool(chainId, costNativeCurrency, nativePool);
        }
    }
    // Adjust quote for gas fees
    let quoteGasAdjusted;
    if (route.trade.tradeType == TradeType.EXACT_OUTPUT) {
        // Exact output - need more of tokenIn to get the desired amount of tokenOut
        quoteGasAdjusted = route.quote.add(gasCostQuoteToken);
    }
    else {
        // Exact input - can get less of tokenOut due to fees
        quoteGasAdjusted = route.quote.subtract(gasCostQuoteToken);
    }
    return {
        estimatedGasUsedUSD: gasCostUSD,
        estimatedGasUsedQuoteToken: gasCostQuoteToken,
        estimatedGasUsedGasToken: gasCostInTermsOfGasToken,
        quoteGasAdjusted: quoteGasAdjusted,
    };
}
export function initSwapRouteFromExisting(swapRoute, v2PoolProvider, v3PoolProvider, portionProvider, quoteGasAdjusted, estimatedGasUsed, estimatedGasUsedQuoteToken, estimatedGasUsedUSD, swapOptions, estimatedGasUsedGasToken) {
    const currencyIn = swapRoute.trade.inputAmount.currency;
    const currencyOut = swapRoute.trade.outputAmount.currency;
    const tradeType = swapRoute.trade.tradeType.valueOf()
        ? TradeType.EXACT_OUTPUT
        : TradeType.EXACT_INPUT;
    const routesWithValidQuote = swapRoute.route.map((route) => {
        switch (route.protocol) {
            case Protocol.V3:
                return new V3RouteWithValidQuote({
                    amount: CurrencyAmount.fromFractionalAmount(route.amount.currency, route.amount.numerator, route.amount.denominator),
                    rawQuote: BigNumber.from(route.rawQuote),
                    sqrtPriceX96AfterList: route.sqrtPriceX96AfterList.map((num) => BigNumber.from(num)),
                    initializedTicksCrossedList: [...route.initializedTicksCrossedList],
                    quoterGasEstimate: BigNumber.from(route.gasEstimate),
                    percent: route.percent,
                    route: route.route,
                    gasModel: route.gasModel,
                    quoteToken: new Token(currencyIn.chainId, route.quoteToken.address, route.quoteToken.decimals, route.quoteToken.symbol, route.quoteToken.name),
                    tradeType: tradeType,
                    v3PoolProvider: v3PoolProvider,
                });
            case Protocol.V2:
                return new V2RouteWithValidQuote({
                    amount: CurrencyAmount.fromFractionalAmount(route.amount.currency, route.amount.numerator, route.amount.denominator),
                    rawQuote: BigNumber.from(route.rawQuote),
                    percent: route.percent,
                    route: route.route,
                    gasModel: route.gasModel,
                    quoteToken: new Token(currencyIn.chainId, route.quoteToken.address, route.quoteToken.decimals, route.quoteToken.symbol, route.quoteToken.name),
                    tradeType: tradeType,
                    v2PoolProvider: v2PoolProvider,
                });
            case Protocol.MIXED:
                return new MixedRouteWithValidQuote({
                    amount: CurrencyAmount.fromFractionalAmount(route.amount.currency, route.amount.numerator, route.amount.denominator),
                    rawQuote: BigNumber.from(route.rawQuote),
                    sqrtPriceX96AfterList: route.sqrtPriceX96AfterList.map((num) => BigNumber.from(num)),
                    initializedTicksCrossedList: [...route.initializedTicksCrossedList],
                    quoterGasEstimate: BigNumber.from(route.gasEstimate),
                    percent: route.percent,
                    route: route.route,
                    mixedRouteGasModel: route.gasModel,
                    v2PoolProvider,
                    quoteToken: new Token(currencyIn.chainId, route.quoteToken.address, route.quoteToken.decimals, route.quoteToken.symbol, route.quoteToken.name),
                    tradeType: tradeType,
                    v3PoolProvider: v3PoolProvider,
                });
        }
    });
    const trade = buildTrade(currencyIn, currencyOut, tradeType, routesWithValidQuote);
    const quoteGasAndPortionAdjusted = swapRoute.portionAmount
        ? portionProvider.getQuoteGasAndPortionAdjusted(swapRoute.trade.tradeType, quoteGasAdjusted, swapRoute.portionAmount)
        : undefined;
    const routesWithValidQuotePortionAdjusted = portionProvider.getRouteWithQuotePortionAdjusted(swapRoute.trade.tradeType, routesWithValidQuote, swapOptions);
    return {
        quote: swapRoute.quote,
        quoteGasAdjusted,
        quoteGasAndPortionAdjusted,
        estimatedGasUsed,
        estimatedGasUsedQuoteToken,
        estimatedGasUsedGasToken,
        estimatedGasUsedUSD,
        gasPriceWei: BigNumber.from(swapRoute.gasPriceWei),
        trade,
        route: routesWithValidQuotePortionAdjusted,
        blockNumber: BigNumber.from(swapRoute.blockNumber),
        methodParameters: swapRoute.methodParameters
            ? {
                calldata: swapRoute.methodParameters.calldata,
                value: swapRoute.methodParameters.value,
                to: swapRoute.methodParameters.to,
            }
            : undefined,
        simulationStatus: swapRoute.simulationStatus,
        portionAmount: swapRoute.portionAmount,
    };
}
export const calculateL1GasFeesHelper = async (route, chainId, usdPool, quoteToken, nativePool, provider, l2GasData) => {
    const swapOptions = {
        type: SwapType.UNIVERSAL_ROUTER,
        recipient: '0x0000000000000000000000000000000000000001',
        deadlineOrPreviousBlockhash: 100,
        slippageTolerance: new Percent(5, 10000),
    };
    let mainnetGasUsed = BigNumber.from(0);
    let mainnetFeeInWei = BigNumber.from(0);
    let gasUsedL1OnL2 = BigNumber.from(0);
    if (opStackChains.includes(chainId)) {
        [mainnetGasUsed, mainnetFeeInWei] = await calculateOptimismToL1SecurityFee(route, swapOptions, chainId, provider);
    }
    else if (chainId == ChainId.ARBITRUM_ONE ||
        chainId == ChainId.ARBITRUM_GOERLI) {
        [mainnetGasUsed, mainnetFeeInWei, gasUsedL1OnL2] =
            calculateArbitrumToL1SecurityFee(route, swapOptions, l2GasData, chainId);
    }
    // wrap fee to native currency
    const nativeCurrency = WRAPPED_NATIVE_CURRENCY[chainId];
    const costNativeCurrency = CurrencyAmount.fromRawAmount(nativeCurrency, mainnetFeeInWei.toString());
    // convert fee into usd
    const gasCostL1USD = getQuoteThroughNativePool(chainId, costNativeCurrency, usdPool);
    let gasCostL1QuoteToken = costNativeCurrency;
    // if the inputted token is not in the native currency, quote a native/quote token pool to get the gas cost in terms of the quote token
    if (!quoteToken.equals(nativeCurrency)) {
        if (!nativePool) {
            log.info('Could not find a pool to convert the cost into the quote token');
            gasCostL1QuoteToken = CurrencyAmount.fromRawAmount(quoteToken, 0);
        }
        else {
            const nativeTokenPrice = nativePool.token0.address == nativeCurrency.address
                ? nativePool.token0Price
                : nativePool.token1Price;
            gasCostL1QuoteToken = nativeTokenPrice.quote(costNativeCurrency);
        }
    }
    // gasUsedL1 is the gas units used calculated from the bytes of the calldata
    // gasCostL1USD and gasCostL1QuoteToken is the cost of gas in each of those tokens
    return {
        gasUsedL1: mainnetGasUsed,
        gasUsedL1OnL2,
        gasCostL1USD,
        gasCostL1QuoteToken,
    };
    /**
     * To avoid having a call to optimism's L1 security fee contract for every route and amount combination,
     * we replicate the gas cost accounting here.
     */
    async function calculateOptimismToL1SecurityFee(routes, swapConfig, chainId, provider) {
        const route = routes[0];
        const amountToken = route.tradeType == TradeType.EXACT_INPUT
            ? route.amount.currency
            : route.quote.currency;
        const outputToken = route.tradeType == TradeType.EXACT_INPUT
            ? route.quote.currency
            : route.amount.currency;
        // build trade for swap calldata
        const trade = buildTrade(amountToken, outputToken, route.tradeType, routes);
        const data = buildSwapMethodParameters(trade, swapConfig, ChainId.OPTIMISM).calldata;
        const [l1GasUsed, l1GasCost] = await calculateOptimismToL1FeeFromCalldata(data, chainId, provider);
        return [l1GasUsed, l1GasCost];
    }
    function calculateArbitrumToL1SecurityFee(routes, swapConfig, gasData, chainId) {
        const route = routes[0];
        const amountToken = route.tradeType == TradeType.EXACT_INPUT
            ? route.amount.currency
            : route.quote.currency;
        const outputToken = route.tradeType == TradeType.EXACT_INPUT
            ? route.quote.currency
            : route.amount.currency;
        // build trade for swap calldata
        const trade = buildTrade(amountToken, outputToken, route.tradeType, routes);
        const data = buildSwapMethodParameters(trade, swapConfig, ChainId.ARBITRUM_ONE).calldata;
        return calculateArbitrumToL1FeeFromCalldata(data, gasData, chainId);
    }
};
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiZ2FzLWZhY3RvcnktaGVscGVycy5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy91dGlsL2dhcy1mYWN0b3J5LWhlbHBlcnMudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUEsT0FBTyxFQUFFLFNBQVMsRUFBRSxNQUFNLDBCQUEwQixDQUFDO0FBQ3JELE9BQU8sRUFBRSxRQUFRLEVBQUUsTUFBTSxxQkFBcUIsQ0FBQztBQUMvQyxPQUFPLEVBQUUsT0FBTyxFQUFFLE9BQU8sRUFBRSxLQUFLLEVBQUUsU0FBUyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFDdkUsT0FBTyxFQUFFLFNBQVMsRUFBUSxNQUFNLGlCQUFpQixDQUFDO0FBQ2xELE9BQU8sTUFBTSxNQUFNLFFBQVEsQ0FBQztBQUM1QixPQUFPLElBQUksTUFBTSxNQUFNLENBQUM7QUFDeEIsT0FBTyxDQUFDLE1BQU0sUUFBUSxDQUFDO0FBUXZCLE9BQU8sRUFFTCx5QkFBeUIsRUFFekIsd0JBQXdCLEVBS3hCLFFBQVEsRUFDUixtQkFBbUIsRUFDbkIscUJBQXFCLEVBQ3JCLHFCQUFxQixHQUN0QixNQUFNLFlBQVksQ0FBQztBQUNwQixPQUFPLEVBQUUsY0FBYyxFQUFFLEdBQUcsRUFBRSx1QkFBdUIsRUFBRSxNQUFNLFNBQVMsQ0FBQztBQUd2RSxPQUFPLEVBQUUsYUFBYSxFQUFFLE1BQU0sZUFBZSxDQUFDO0FBQzlDLE9BQU8sRUFBRSx5QkFBeUIsRUFBRSxVQUFVLEVBQUUsTUFBTSxvQkFBb0IsQ0FBQztBQUMzRSxPQUFPLEVBQUUsYUFBYSxFQUFFLGlCQUFpQixFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFHckUsTUFBTSxDQUFDLEtBQUssVUFBVSxlQUFlLENBQ25DLEtBQVksRUFDWixZQUE2QixFQUM3QixjQUF1QztJQUV2QyxNQUFNLE9BQU8sR0FBRyxLQUFLLENBQUMsT0FBa0IsQ0FBQztJQUN6QyxNQUFNLElBQUksR0FBRyx1QkFBdUIsQ0FBQyxPQUFPLENB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