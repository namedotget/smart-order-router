import { BigNumber } from '@ethersproject/bignumber';
import { ChainId } from '@uniswap/sdk-core';
import { TokenFeeDetector__factory } from '../types/other/factories/TokenFeeDetector__factory';
import { log, metric, MetricLoggerUnit, WRAPPED_NATIVE_CURRENCY, } from '../util';
const DEFAULT_TOKEN_BUY_FEE_BPS = BigNumber.from(0);
const DEFAULT_TOKEN_SELL_FEE_BPS = BigNumber.from(0);
// on detector failure, assume no fee
export const DEFAULT_TOKEN_FEE_RESULT = {
    buyFeeBps: DEFAULT_TOKEN_BUY_FEE_BPS,
    sellFeeBps: DEFAULT_TOKEN_SELL_FEE_BPS,
};
// address at which the FeeDetector lens is deployed
const FEE_DETECTOR_ADDRESS = (chainId) => {
    switch (chainId) {
        case ChainId.MAINNET:
            return '0x19C97dc2a25845C7f9d1d519c8C2d4809c58b43f';
        case ChainId.OPTIMISM:
            return '0xa7c17505B43955A474fb6AFE61E093907a7567c9';
        case ChainId.BNB:
            return '0x331f6D0AAB4A1F039f0d75A613a7F1593DbDE1BB';
        case ChainId.POLYGON:
            return '0x92bCCCb6c8c199AAcA38408621E38Ab6dBfA00B5';
        case ChainId.BASE:
            return '0x331f6D0AAB4A1F039f0d75A613a7F1593DbDE1BB';
        case ChainId.ARBITRUM_ONE:
            return '0x64CF365CC5CCf5E64380bc05Acd5df7D0618c118';
        case ChainId.CELO:
            return '0x3dfF0145E68a5880EAbE8F56b6Bc30C4AdCF3413';
        case ChainId.AVALANCHE:
            return '0xBF2B9F6A6eCc4541b31ab2dCF8156D33644Ca3F3';
        default:
            // just default to mainnet contract
            return '0x19C97dc2a25845C7f9d1d519c8C2d4809c58b43f';
    }
};
// Amount has to be big enough to avoid rounding errors, but small enough that
// most v2 pools will have at least this many token units
// 100000 is the smallest number that avoids rounding errors in bps terms
// 10000 was not sufficient due to rounding errors for rebase token (e.g. stETH)
const AMOUNT_TO_FLASH_BORROW = '100000';
// 1M gas limit per validate call, should cover most swap cases
const GAS_LIMIT_PER_VALIDATE = 1000000;
export class OnChainTokenFeeFetcher {
    constructor(chainId, rpcProvider, tokenFeeAddress = FEE_DETECTOR_ADDRESS(chainId), gasLimitPerCall = GAS_LIMIT_PER_VALIDATE, amountToFlashBorrow = AMOUNT_TO_FLASH_BORROW) {
        var _a;
        this.chainId = chainId;
        this.tokenFeeAddress = tokenFeeAddress;
        this.gasLimitPerCall = gasLimitPerCall;
        this.amountToFlashBorrow = amountToFlashBorrow;
        this.BASE_TOKEN = (_a = WRAPPED_NATIVE_CURRENCY[this.chainId]) === null || _a === void 0 ? void 0 : _a.address;
        this.contract = TokenFeeDetector__factory.connect(this.tokenFeeAddress, rpcProvider);
    }
    async fetchFees(addresses, providerConfig) {
        const tokenToResult = {};
        const addressesWithoutBaseToken = addresses.filter((address) => address.toLowerCase() !== this.BASE_TOKEN.toLowerCase());
        const functionParams = addressesWithoutBaseToken.map((address) => [
            address,
            this.BASE_TOKEN,
            this.amountToFlashBorrow,
        ]);
        const results = await Promise.all(functionParams.map(async ([address, baseToken, amountToBorrow]) => {
            try {
                // We use the validate function instead of batchValidate to avoid poison pill problem.
                // One token that consumes too much gas could cause the entire batch to fail.
                const feeResult = await this.contract.callStatic.validate(address, baseToken, amountToBorrow, {
                    gasLimit: this.gasLimitPerCall,
                    blockTag: providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.blockNumber,
                });
                metric.putMetric('TokenFeeFetcherFetchFeesSuccess', 1, MetricLoggerUnit.Count);
                return { address, ...feeResult };
            }
            catch (err) {
                log.error({ err }, `Error calling validate on-chain for token ${address}`);
                metric.putMetric('TokenFeeFetcherFetchFeesFailure', 1, MetricLoggerUnit.Count);
                // in case of FOT token fee fetch failure, we return null
                // so that they won't get returned from the token-fee-fetcher
                // and thus no fee will be applied, and the cache won't cache on FOT tokens with failed fee fetching
                return { address, buyFeeBps: undefined, sellFeeBps: undefined };
            }
        }));
        results.forEach(({ address, buyFeeBps, sellFeeBps }) => {
            if (buyFeeBps || sellFeeBps) {
                tokenToResult[address] = { buyFeeBps, sellFeeBps };
            }
        });
        return tokenToResult;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidG9rZW4tZmVlLWZldGNoZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zcmMvcHJvdmlkZXJzL3Rva2VuLWZlZS1mZXRjaGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxTQUFTLEVBQUUsTUFBTSwwQkFBMEIsQ0FBQztBQUVyRCxPQUFPLEVBQUUsT0FBTyxFQUFFLE1BQU0sbUJBQW1CLENBQUM7QUFFNUMsT0FBTyxFQUFFLHlCQUF5QixFQUFFLE1BQU0sb0RBQW9ELENBQUM7QUFFL0YsT0FBTyxFQUNMLEdBQUcsRUFDSCxNQUFNLEVBQ04sZ0JBQWdCLEVBQ2hCLHVCQUF1QixHQUN4QixNQUFNLFNBQVMsQ0FBQztBQUlqQixNQUFNLHlCQUF5QixHQUFHLFNBQVMsQ0FBQyxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7QUFDcEQsTUFBTSwwQkFBMEIsR0FBRyxTQUFTLENBQUMsSUFBSSxDQUFDLENBQUMsQ0FBQyxDQUFDO0FBRXJELHFDQUFxQztBQUNyQyxNQUFNLENBQUMsTUFBTSx3QkFBd0IsR0FBRztJQUN0QyxTQUFTLEVBQUUseUJBQXlCO0lBQ3BDLFVBQVUsRUFBRSwwQkFBMEI7Q0FDdkMsQ0FBQztBQVVGLG9EQUFvRDtBQUNwRCxNQUFNLG9CQUFvQixHQUFHLENBQUMsT0FBZ0IsRUFBRSxFQUFFO0lBQ2hELFFBQVEsT0FBTyxFQUFFO1FBQ2YsS0FBSyxPQUFPLENBQUMsT0FBTztZQUNsQixPQUFPLDRDQUE0QyxDQUFDO1FBQ3RELEtBQUssT0FBTyxDQUFDLFFBQVE7WUFDbkIsT0FBTyw0Q0FBNEMsQ0FBQztRQUN0RCxLQUFLLE9BQU8sQ0FBQyxHQUFHO1lBQ2QsT0FBTyw0Q0FBNEMsQ0FBQztRQUN0RCxLQUFLLE9BQU8sQ0FBQyxPQUFPO1lBQ2xCLE9BQU8sNENBQTRDLENBQUM7UUFDdEQsS0FBSyxPQUFPLENBQUMsSUFBSTtZQUNmLE9BQU8sNENBQTRDLENBQUM7UUFDdEQsS0FBSyxPQUFP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