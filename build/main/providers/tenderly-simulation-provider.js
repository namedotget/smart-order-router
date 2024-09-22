"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TenderlySimulator = exports.FallbackTenderlySimulator = exports.TENDERLY_NOT_SUPPORTED_CHAINS = void 0;
const http_1 = __importDefault(require("http"));
const https_1 = __importDefault(require("https"));
const constants_1 = require("@ethersproject/constants");
const permit2_sdk_1 = require("@uniswap/permit2-sdk");
const sdk_core_1 = require("@uniswap/sdk-core");
const universal_router_sdk_1 = require("@uniswap/universal-router-sdk");
const axios_1 = __importDefault(require("axios"));
const ethers_1 = require("ethers/lib/ethers");
const routers_1 = require("../routers");
const Erc20__factory_1 = require("../types/other/factories/Erc20__factory");
const Permit2__factory_1 = require("../types/other/factories/Permit2__factory");
const util_1 = require("../util");
const callData_1 = require("../util/callData");
const gas_factory_helpers_1 = require("../util/gas-factory-helpers");
const simulation_provider_1 = require("./simulation-provider");
var TenderlySimulationType;
(function (TenderlySimulationType) {
    TenderlySimulationType["QUICK"] = "quick";
    TenderlySimulationType["FULL"] = "full";
    TenderlySimulationType["ABI"] = "abi";
})(TenderlySimulationType || (TenderlySimulationType = {}));
const TENDERLY_BATCH_SIMULATE_API = (tenderlyBaseUrl, tenderlyUser, tenderlyProject) => `${tenderlyBaseUrl}/api/v1/account/${tenderlyUser}/project/${tenderlyProject}/simulate-batch`;
const TENDERLY_NODE_API = (chainId, tenderlyNodeApiKey) => {
    switch (chainId) {
        case sdk_core_1.ChainId.MAINNET:
            return `https://mainnet.gateway.tenderly.co/${tenderlyNodeApiKey}`;
        default:
            throw new Error(`ChainId ${chainId} does not correspond to a tenderly node endpoint`);
    }
};
exports.TENDERLY_NOT_SUPPORTED_CHAINS = [
    sdk_core_1.ChainId.CELO,
    sdk_core_1.ChainId.CELO_ALFAJORES,
    sdk_core_1.ChainId.ZKSYNC,
];
// We multiply tenderly gas limit by this to overestimate gas limit
const DEFAULT_ESTIMATE_MULTIPLIER = 1.3;
class FallbackTenderlySimulator extends simulation_provider_1.Simulator {
    constructor(chainId, provider, portionProvider, tenderlySimulator, ethEstimateGasSimulator) {
        super(provider, portionProvider, chainId);
        this.tenderlySimulator = tenderlySimulator;
        this.ethEstimateGasSimulator = ethEstimateGasSimulator;
    }
    async simulateTransaction(fromAddress, swapOptions, swapRoute, providerConfig) {
        // Make call to eth estimate gas if possible
        // For erc20s, we must check if the token allowance is sufficient
        const inputAmount = swapRoute.trade.inputAmount;
        if ((inputAmount.currency.isNative && this.chainId == sdk_core_1.ChainId.MAINNET) ||
            (await this.checkTokenApproved(fromAddress, inputAmount, swapOptions, this.provider))) {
            util_1.log.info('Simulating with eth_estimateGas since token is native or approved.');
            try {
                const swapRouteWithGasEstimate = await this.ethEstimateGasSimulator.ethEstimateGas(fromAddress, swapOptions, swapRoute, providerConfig);
                return swapRouteWithGasEstimate;
            }
            catch (err) {
                util_1.log.info({ err: err }, 'Error simulating using eth_estimateGas');
                return Object.assign(Object.assign({}, swapRoute), { simulationStatus: simulation_provider_1.SimulationStatus.Failed });
            }
        }
        try {
            return await this.tenderlySimulator.simulateTransaction(fromAddress, swapOptions, swapRoute, providerConfig);
        }
        catch (err) {
            util_1.log.error({ err: err }, 'Failed to simulate via Tenderly');
            if (err instanceof Error && err.message.includes('timeout')) {
                routers_1.metric.putMetric('TenderlySimulationTimeouts', 1, routers_1.MetricLoggerUnit.Count);
            }
            return Object.assign(Object.assign({}, swapRoute), { simulationStatus: simulation_provider_1.SimulationStatus.Failed });
        }
    }
}
exports.FallbackTenderlySimulator = FallbackTenderlySimulator;
class TenderlySimulator extends simulation_provider_1.Simulator {
    constructor(chainId, tenderlyBaseUrl, tenderlyUser, tenderlyProject, tenderlyAccessKey, tenderlyNodeApiKey, v2PoolProvider, v3PoolProvider, provider, portionProvider, overrideEstimateMultiplier, tenderlyRequestTimeout, tenderlyNodeApiSamplingPercent, tenderlyNodeApiEnabledChains) {
        super(provider, portionProvider, chainId);
        this.tenderlyNodeApiEnabledChains = [];
        this.tenderlyServiceInstance = axios_1.default.create({
            // keep connections alive,
            // maxSockets default is Infinity, so Infinity is read as 50 sockets
            httpAgent: new http_1.default.Agent({ keepAlive: true }),
            httpsAgent: new https_1.default.Agent({ keepAlive: true }),
        });
        this.tenderlyBaseUrl = tenderlyBaseUrl;
        this.tenderlyUser = tenderlyUser;
        this.tenderlyProject = tenderlyProject;
        this.tenderlyAccessKey = tenderlyAccessKey;
        this.tenderlyNodeApiKey = tenderlyNodeApiKey;
        this.v2PoolProvider = v2PoolProvider;
        this.v3PoolProvider = v3PoolProvider;
        this.overrideEstimateMultiplier = overrideEstimateMultiplier !== null && overrideEstimateMultiplier !== void 0 ? overrideEstimateMultiplier : {};
        this.tenderlyRequestTimeout = tenderlyRequestTimeout;
        this.tenderlyNodeApiSamplingPercent = tenderlyNodeApiSamplingPercent;
        this.tenderlyNodeApiEnabledChains = tenderlyNodeApiEnabledChains;
    }
    async simulateTransaction(fromAddress, swapOptions, swapRoute, providerConfig) {
        var _a;
        const currencyIn = swapRoute.trade.inputAmount.currency;
        const tokenIn = currencyIn.wrapped;
        const chainId = this.chainId;
        if (exports.TENDERLY_NOT_SUPPORTED_CHAINS.includes(chainId)) {
            const msg = `${exports.TENDERLY_NOT_SUPPORTED_CHAINS.toString()} not supported by Tenderly!`;
            util_1.log.info(msg);
            return Object.assign(Object.assign({}, swapRoute), { simulationStatus: simulation_provider_1.SimulationStatus.NotSupported });
        }
        if (!swapRoute.methodParameters) {
            const msg = 'No calldata provided to simulate transaction';
            util_1.log.info(msg);
            throw new Error(msg);
        }
        const { calldata } = swapRoute.methodParameters;
        util_1.log.info({
            calldata: swapRoute.methodParameters.calldata,
            fromAddress: fromAddress,
            chainId: chainId,
            tokenInAddress: tokenIn.address,
            router: swapOptions.type,
        }, 'Simulating transaction on Tenderly');
        const blockNumber = await (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.blockNumber);
        let estimatedGasUsed;
        const estimateMultiplier = (_a = this.overrideEstimateMultiplier[chainId]) !== null && _a !== void 0 ? _a : DEFAULT_ESTIMATE_MULTIPLIER;
        if (swapOptions.type == routers_1.SwapType.UNIVERSAL_ROUTER) {
            // simulating from beacon chain deposit address that should always hold **enough balance**
            if (currencyIn.isNative && this.chainId == sdk_core_1.ChainId.MAINNET) {
                fromAddress = util_1.BEACON_CHAIN_DEPOSIT_ADDRESS;
            }
            // Do initial onboarding approval of Permit2.
            const erc20Interface = Erc20__factory_1.Erc20__factory.createInterface();
            const approvePermit2Calldata = erc20Interface.encodeFunctionData('approve', [(0, permit2_sdk_1.permit2Address)(this.chainId), constants_1.MaxUint256]);
            // We are unsure if the users calldata contains a permit or not. We just
            // max approve the Universal Router from Permit2 instead, which will cover both cases.
            const permit2Interface = Permit2__factory_1.Permit2__factory.createInterface();
            const approveUniversalRouterCallData = permit2Interface.encodeFunctionData('approve', [
                tokenIn.address,
                (0, universal_router_sdk_1.UNIVERSAL_ROUTER_ADDRESS)(this.chainId),
                util_1.MAX_UINT160,
                Math.floor(new Date().getTime() / 1000) + 10000000,
            ]);
            const approvePermit2 = {
                network_id: chainId,
                estimate_gas: true,
                input: approvePermit2Calldata,
                to: tokenIn.address,
                value: '0',
                from: fromAddress,
                block_number: blockNumber,
                simulation_type: TenderlySimulationType.QUICK,
                save_if_fails: providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.saveTenderlySimulationIfFailed,
            };
            const approveUniversalRouter = {
                network_id: chainId,
                estimate_gas: true,
                input: approveUniversalRouterCallData,
                to: (0, permit2_sdk_1.permit2Address)(this.chainId),
                value: '0',
                from: fromAddress,
                block_number: blockNumber,
                simulation_type: TenderlySimulationType.QUICK,
                save_if_fails: providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.saveTenderlySimulationIfFailed,
            };
            const swap = {
                network_id: chainId,
                input: calldata,
                estimate_gas: true,
                to: (0, universal_router_sdk_1.UNIVERSAL_ROUTER_ADDRESS)(this.chainId),
                value: currencyIn.isNative ? swapRoute.methodParameters.value : '0',
                from: fromAddress,
                block_number: blockNumber,
                simulation_type: TenderlySimulationType.QUICK,
                save_if_fails: providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.saveTenderlySimulationIfFailed,
            };
            const body = {
                simulations: [approvePermit2, approveUniversalRouter, swap],
                estimate_gas: true,
            };
            const opts = {
                headers: {
                    'X-Access-Key': this.tenderlyAccessKey,
                },
                timeout: this.tenderlyRequestTimeout,
            };
            const url = TENDERLY_BATCH_SIMULATE_API(this.tenderlyBaseUrl, this.tenderlyUser, this.tenderlyProject);
            routers_1.metric.putMetric('TenderlySimulationUniversalRouterRequests', 1, routers_1.MetricLoggerUnit.Count);
            const before = Date.now();
            const { data: resp, status: httpStatus } = await this.tenderlyServiceInstance
                .post(url, body, opts)
                .finally(() => {
                routers_1.metric.putMetric('TenderlySimulationLatencies', Date.now() - before, routers_1.MetricLoggerUnit.Milliseconds);
            });
            // fire tenderly node endpoint sampling and forget
            this.sampleNodeEndpoint(approvePermit2, approveUniversalRouter, swap, body, resp);
            const latencies = Date.now() - before;
            util_1.log.info(`Tenderly simulation universal router request body: ${JSON.stringify(body, null, 2)} with result ${JSON.stringify(resp, null, 2)}, having latencies ${latencies} in milliseconds.`);
            routers_1.metric.putMetric('TenderlySimulationUniversalRouterLatencies', Date.now() - before, routers_1.MetricLoggerUnit.Milliseconds);
            routers_1.metric.putMetric(`TenderlySimulationUniversalRouterResponseStatus${httpStatus}`, 1, routers_1.MetricLoggerUnit.Count);
            // Validate tenderly response body
            if (!resp ||
                resp.simulation_results.length < 3 ||
                !resp.simulation_results[2].transaction ||
                resp.simulation_results[2].transaction.error_message) {
                this.logTenderlyErrorResponse(resp);
                return Object.assign(Object.assign({}, swapRoute), { simulationStatus: simulation_provider_1.SimulationStatus.Failed });
            }
            // Parse the gas used in the simulation response object, and then pad it so that we overestimate.
            estimatedGasUsed = ethers_1.BigNumber.from((resp.simulation_results[2].transaction.gas * estimateMultiplier).toFixed(0));
            util_1.log.info({
                body,
                approvePermit2GasUsed: resp.simulation_results[0].transaction.gas_used,
                approveUniversalRouterGasUsed: resp.simulation_results[1].transaction.gas_used,
                swapGasUsed: resp.simulation_results[2].transaction.gas_used,
                approvePermit2Gas: resp.simulation_results[0].transaction.gas,
                approveUniversalRouterGas: resp.simulation_results[1].transaction.gas,
                swapGas: resp.simulation_results[2].transaction.gas,
                swapWithMultiplier: estimatedGasUsed.toString(),
            }, 'Successfully Simulated Approvals + Swap via Tenderly for Universal Router. Gas used.');
            util_1.log.info({
                body,
                swapSimulation: resp.simulation_results[2].simulation,
                swapTransaction: resp.simulation_results[2].transaction,
            }, 'Successful Tenderly Swap Simulation for Universal Router');
        }
        else if (swapOptions.type == routers_1.SwapType.SWAP_ROUTER_02) {
            const approve = {
                network_id: chainId,
                input: callData_1.APPROVE_TOKEN_FOR_TRANSFER,
                estimate_gas: true,
                to: tokenIn.address,
                value: '0',
                from: fromAddress,
                simulation_type: TenderlySimulationType.QUICK,
            };
            const swap = {
                network_id: chainId,
                input: calldata,
                to: (0, util_1.SWAP_ROUTER_02_ADDRESSES)(chainId),
                estimate_gas: true,
                value: currencyIn.isNative ? swapRoute.methodParameters.value : '0',
                from: fromAddress,
                block_number: blockNumber,
                simulation_type: TenderlySimulationType.QUICK,
            };
            const body = { simulations: [approve, swap] };
            const opts = {
                headers: {
                    'X-Access-Key': this.tenderlyAccessKey,
                },
                timeout: this.tenderlyRequestTimeout,
            };
            const url = TENDERLY_BATCH_SIMULATE_API(this.tenderlyBaseUrl, this.tenderlyUser, this.tenderlyProject);
            routers_1.metric.putMetric('TenderlySimulationSwapRouter02Requests', 1, routers_1.MetricLoggerUnit.Count);
            const before = Date.now();
            const { data: resp, status: httpStatus } = await this.tenderlyServiceInstance.post(url, body, opts);
            routers_1.metric.putMetric(`TenderlySimulationSwapRouter02ResponseStatus${httpStatus}`, 1, routers_1.MetricLoggerUnit.Count);
            const latencies = Date.now() - before;
            util_1.log.info(`Tenderly simulation swap router02 request body: ${body}, having latencies ${latencies} in milliseconds.`);
            routers_1.metric.putMetric('TenderlySimulationSwapRouter02Latencies', latencies, routers_1.MetricLoggerUnit.Milliseconds);
            // Validate tenderly response body
            if (!resp ||
                resp.simulation_results.length < 2 ||
                !resp.simulation_results[1].transaction ||
                resp.simulation_results[1].transaction.error_message) {
                const msg = `Failed to Simulate Via Tenderly!: ${resp.simulation_results[1].transaction.error_message}`;
                util_1.log.info({ err: resp.simulation_results[1].transaction.error_message }, msg);
                return Object.assign(Object.assign({}, swapRoute), { simulationStatus: simulation_provider_1.SimulationStatus.Failed });
            }
            // Parse the gas used in the simulation response object, and then pad it so that we overestimate.
            estimatedGasUsed = ethers_1.BigNumber.from((resp.simulation_results[1].transaction.gas * estimateMultiplier).toFixed(0));
            util_1.log.info({
                body,
                approveGasUsed: resp.simulation_results[0].transaction.gas_used,
                swapGasUsed: resp.simulation_results[1].transaction.gas_used,
                approveGas: resp.simulation_results[0].transaction.gas,
                swapGas: resp.simulation_results[1].transaction.gas,
                swapWithMultiplier: estimatedGasUsed.toString(),
            }, 'Successfully Simulated Approval + Swap via Tenderly for SwapRouter02. Gas used.');
            util_1.log.info({
                body,
                swapTransaction: resp.simulation_results[1].transaction,
                swapSimulation: resp.simulation_results[1].simulation,
            }, 'Successful Tenderly Swap Simulation for SwapRouter02');
        }
        else {
            throw new Error(`Unsupported swap type: ${swapOptions}`);
        }
        const { estimatedGasUsedUSD, estimatedGasUsedQuoteToken, estimatedGasUsedGasToken, quoteGasAdjusted, } = await (0, gas_factory_helpers_1.calculateGasUsed)(chainId, swapRoute, estimatedGasUsed, this.v2PoolProvider, this.v3PoolProvider, this.provider, providerConfig);
        return Object.assign(Object.assign({}, (0, gas_factory_helpers_1.initSwapRouteFromExisting)(swapRoute, this.v2PoolProvider, this.v3PoolProvider, this.portionProvider, quoteGasAdjusted, estimatedGasUsed, estimatedGasUsedQuoteToken, estimatedGasUsedUSD, swapOptions, estimatedGasUsedGasToken)), { simulationStatus: simulation_provider_1.SimulationStatus.Succeeded });
    }
    logTenderlyErrorResponse(resp) {
        util_1.log.info({
            resp,
        }, 'Failed to Simulate on Tenderly');
        util_1.log.info({
            err: resp.simulation_results.length >= 1
                ? resp.simulation_results[0].transaction
                : {},
        }, 'Failed to Simulate on Tenderly #1 Transaction');
        util_1.log.info({
            err: resp.simulation_results.length >= 1
                ? resp.simulation_results[0].simulation
                : {},
        }, 'Failed to Simulate on Tenderly #1 Simulation');
        util_1.log.info({
            err: resp.simulation_results.length >= 2
                ? resp.simulation_results[1].transaction
                : {},
        }, 'Failed to Simulate on Tenderly #2 Transaction');
        util_1.log.info({
            err: resp.simulation_results.length >= 2
                ? resp.simulation_results[1].simulation
                : {},
        }, 'Failed to Simulate on Tenderly #2 Simulation');
        util_1.log.info({
            err: resp.simulation_results.length >= 3
                ? resp.simulation_results[2].transaction
                : {},
        }, 'Failed to Simulate on Tenderly #3 Transaction');
        util_1.log.info({
            err: resp.simulation_results.length >= 3
                ? resp.simulation_results[2].simulation
                : {},
        }, 'Failed to Simulate on Tenderly #3 Simulation');
    }
    async sampleNodeEndpoint(approvePermit2, approveUniversalRouter, swap, gatewayReq, gatewayResp) {
        var _a, _b;
        if (Math.random() * 100 < ((_a = this.tenderlyNodeApiSamplingPercent) !== null && _a !== void 0 ? _a : 0) &&
            ((_b = this.tenderlyNodeApiEnabledChains) !== null && _b !== void 0 ? _b : []).find((chainId) => chainId === this.chainId)) {
            const nodeEndpoint = TENDERLY_NODE_API(this.chainId, this.tenderlyNodeApiKey);
            const blockNumber = swap.block_number
                ? ethers_1.BigNumber.from(swap.block_number).toHexString().replace('0x0', '0x')
                : 'latest';
            const body = {
                id: 1,
                jsonrpc: '2.0',
                method: 'tenderly_estimateGasBundle',
                params: [
                    [
                        {
                            from: approvePermit2.from,
                            to: approvePermit2.to,
                            data: approvePermit2.input,
                        },
                        {
                            from: approveUniversalRouter.from,
                            to: approveUniversalRouter.to,
                            data: approveUniversalRouter.input,
                        },
                        { from: swap.from, to: swap.to, data: swap.input },
                    ],
                    blockNumber,
                ],
            };
            util_1.log.info(`About to invoke Tenderly Node Endpoint for gas estimation bundle ${JSON.stringify(body, null, 2)}.`);
            const before = Date.now();
            try {
                // For now, we don't timeout tenderly node endpoint, but we should before we live switch to node endpoint
                const { data: resp, status: httpStatus } = await this.tenderlyServiceInstance.post(nodeEndpoint, body);
                const latencies = Date.now() - before;
                routers_1.metric.putMetric('TenderlyNodeGasEstimateBundleLatencies', latencies, routers_1.MetricLoggerUnit.Milliseconds);
                routers_1.metric.putMetric('TenderlyNodeGasEstimateBundleSuccess', 1, routers_1.MetricLoggerUnit.Count);
                util_1.log.info(`Tenderly estimate gas bundle request body: ${JSON.stringify(body, null, 2)} with http status ${httpStatus} result ${JSON.stringify(resp, null, 2)}, having latencies ${latencies} in milliseconds.`);
                if (httpStatus !== 200) {
                    util_1.log.error(`Failed to invoke Tenderly Node Endpoint for gas estimation bundle ${JSON.stringify(body, null, 2)}. HTTP Status: ${httpStatus}`, { resp });
                    return;
                }
                if (gatewayResp.simulation_results.length !== resp.result.length) {
                    routers_1.metric.putMetric('TenderlyNodeGasEstimateBundleLengthMismatch', 1, routers_1.MetricLoggerUnit.Count);
                    return;
                }
                let gasEstimateMismatch = false;
                for (let i = 0; i <
                    Math.min(gatewayResp.simulation_results.length, resp.result.length); i++) {
                    const singleNodeResp = resp.result[i];
                    const singleGatewayResp = gatewayResp.simulation_results[i];
                    if (singleNodeResp.gas &&
                        singleNodeResp.gasUsed) {
                        const gatewayGas = singleGatewayResp === null || singleGatewayResp === void 0 ? void 0 : singleGatewayResp.transaction.gas;
                        const nodeGas = Number(singleNodeResp.gas);
                        const gatewayGasUsed = singleGatewayResp === null || singleGatewayResp === void 0 ? void 0 : singleGatewayResp.transaction.gas_used;
                        const nodeGasUsed = Number(singleNodeResp.gasUsed);
                        if (gatewayGas !== nodeGas) {
                            util_1.log.error(`Gateway gas and node gas estimates do not match for index ${i}`, { gatewayGas, nodeGas, blockNumber });
                            routers_1.metric.putMetric(`TenderlyNodeGasEstimateBundleGasMismatch${i}`, 1, routers_1.MetricLoggerUnit.Count);
                            gasEstimateMismatch = true;
                        }
                        if (gatewayGasUsed !== nodeGasUsed) {
                            util_1.log.error(`Gateway gas and node gas used estimates do not match for index ${i}`, { gatewayGas, nodeGas, blockNumber });
                            routers_1.metric.putMetric(`TenderlyNodeGasEstimateBundleGasUsedMismatch${i}`, 1, routers_1.MetricLoggerUnit.Count);
                            gasEstimateMismatch = true;
                        }
                    }
                    else if (singleNodeResp.error) {
                        if (!(singleGatewayResp === null || singleGatewayResp === void 0 ? void 0 : singleGatewayResp.transaction.error_message)) {
                            util_1.log.error(`Gateway and node error messages do not match for index ${i}`, { blockNumber });
                            routers_1.metric.putMetric(`TenderlyNodeGasEstimateBundleErrorMismatch${i}`, 1, routers_1.MetricLoggerUnit.Count);
                            gasEstimateMismatch = true;
                        }
                    }
                }
                if (!gasEstimateMismatch) {
                    routers_1.metric.putMetric('TenderlyNodeGasEstimateBundleMatch', 1, routers_1.MetricLoggerUnit.Count);
                }
                else {
                    util_1.log.error(`Gateway gas and node gas estimates do not match
              gateway request body ${JSON.stringify(gatewayReq, null, 2)}
              node request body ${JSON.stringify(body, null, 2)}`);
                }
            }
            catch (err) {
                util_1.log.error({ err }, `Failed to invoke Tenderly Node Endpoint for gas estimation bundle ${JSON.stringify(body, null, 2)}. Error: ${err}`);
                routers_1.metric.putMetric('TenderlyNodeGasEstimateBundleFailure', 1, routers_1.MetricLoggerUnit.Count);
            }
        }
    }
}
exports.TenderlySimulator = TenderlySimulator;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoidGVuZGVybHktc2ltdWxhdGlvbi1wcm92aWRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9wcm92aWRlcnMvdGVuZGVybHktc2ltdWxhdGlvbi1wcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7Ozs7QUFBQSxnREFBd0I7QUFDeEIsa0RBQTBCO0FBRTFCLHdEQUFzRDtBQUV0RCxzREFBc0Q7QUFDdEQsZ0RBQTRDO0FBQzVDLHdFQUF5RTtBQUN6RSxrREFBa0Q7QUFDbEQsOENBQThDO0FBRTlDLHdDQU9vQjtBQUNwQiw0RUFBeUU7QUFDekUsZ0ZBQTZFO0FBQzdFLGtDQUtpQjtBQUNqQiwrQ0FBOEQ7QUFDOUQscUVBR3FDO0FBSXJDLCtEQUkrQjtBQTBDL0IsSUFBSyxzQkFJSjtBQUpELFdBQUssc0JBQXNCO0lBQ3pCLHlDQUFlLENBQUE7SUFDZix1Q0FBYSxDQUFBO0lBQ2IscUNBQVcsQ0FBQTtBQUNiLENBQUMsRUFKSSxzQkFBc0IsS0FBdEIsc0JBQXNCLFFBSTFCO0FBeUNELE1BQU0sMkJBQTJCLEdBQUcsQ0FDbEMsZUFBdUIsRUFDdkIsWUFBb0IsRUFDcEIsZUFBdUIsRUFDdkIsRUFBRSxDQUNGLEdBQUcsZUFBZSxtQkFBbUIsWUFBWSxZQUFZLGVBQWUsaUJBQWlCLENBQUM7QUFFaEcsTUFBTSxpQkFBaUIsR0FBRyxDQUFDLE9BQWdCLEVBQUUsa0JBQTBCLEVBQUUsRUFBRTtJQUN6RSxRQUFRLE9BQU8sRUFBRTtRQUNmLEtBQUssa0JBQU8sQ0FBQyxPQUFPO1lBQ2xCLE9BQU8sdUNBQXVDLGtCQUFrQixFQUFFLENBQUM7UUFDckU7WUFDRSxNQUFNLElBQUksS0FBSyxDQUNiLFdBQVcsT0FBTyxrREFBa0QsQ0FDckUsQ0FBQztLQUNMO0FBQ0gsQ0FBQyxDQUFDO0FBRVcsUUFBQSw2QkFBNkIsR0FBRztJQUMzQyxrQkFBTyxDQUFDLElBQUk7SUFDWixrQkFBTyxDQUFDLGNBQWM7SUFDdEIsa0JBQU8s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QyxDQUFDLENBQUMsQ0FBQyxXQUFXO2dCQUN4QyxDQUFDLENBQUMsRUFBRTtTQUNULEVBQ0QsK0NBQStDLENBQ2hELENBQUM7UUFDRixVQUFHLENBQUMsSUFBSSxDQUNOO1lBQ0UsR0FBRyxFQUNELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLElBQUksQ0FBQztnQkFDakMsQ0FBQyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVO2dCQUN2QyxDQUFDLENBQUMsRUFBRTtTQUNULEVBQ0QsOENBQThDLENBQy9DLENBQUM7UUFDRixVQUFHLENBQUMsSUFBSSxDQUNOO1lBQ0UsR0FBRyxFQUNELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLElBQUksQ0FBQztnQkFDakMsQ0FBQyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXO2dCQUN4QyxDQUFDLENBQUMsRUFBRTtTQUNULEVBQ0QsK0NBQStDLENBQ2hELENBQUM7UUFDRixVQUFHLENBQUMsSUFBSSxDQUNOO1lBQ0UsR0FBRyxFQUNELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLElBQUksQ0FBQztnQkFDakMsQ0FBQyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxVQUFVO2dCQUN2QyxDQUFDLENBQUMsRUFBRTtTQUNULEVBQ0QsOENBQThDLENBQy9DLENBQUM7UUFDRixVQUFHLENBQUMsSUFBSSxDQUNOO1lBQ0UsR0FBRyxFQUNELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLElBQUksQ0FBQztnQkFDakMsQ0FBQyxDQUFDLElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxXQUFXO2dCQUN4QyxDQUFDLENBQUMsRUFBRTtTQUNULEVBQ0QsK0NBQStDLENBQ2hELENBQUM7UUFDRixVQUFHLENBQUMsSUFBSSxDQUNOO1lBQ0UsR0FBRyxFQUNELElBQUksQ0FBQyxrQkFBa0IsQ0FBQyxNQUFNLElBQUksQ0FBQztnQkFDakMs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