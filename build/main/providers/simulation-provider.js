"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Simulator = exports.SimulationStatus = void 0;
const sdk_core_1 = require("@uniswap/sdk-core");
const ethers_1 = require("ethers/lib/ethers");
const routers_1 = require("../routers");
const Erc20__factory_1 = require("../types/other/factories/Erc20__factory");
const Permit2__factory_1 = require("../types/other/factories/Permit2__factory");
const util_1 = require("../util");
const permit2_sdk_1 = require("@uniswap/permit2-sdk");
var SimulationStatus;
(function (SimulationStatus) {
    SimulationStatus[SimulationStatus["NotSupported"] = 0] = "NotSupported";
    SimulationStatus[SimulationStatus["Failed"] = 1] = "Failed";
    SimulationStatus[SimulationStatus["Succeeded"] = 2] = "Succeeded";
    SimulationStatus[SimulationStatus["InsufficientBalance"] = 3] = "InsufficientBalance";
    SimulationStatus[SimulationStatus["NotApproved"] = 4] = "NotApproved";
})(SimulationStatus = exports.SimulationStatus || (exports.SimulationStatus = {}));
/**
 * Provider for dry running transactions.
 *
 * @export
 * @class Simulator
 */
class Simulator {
    /**
     * Returns a new SwapRoute with simulated gas estimates
     * @returns SwapRoute
     */
    constructor(provider, portionProvider, chainId) {
        this.chainId = chainId;
        this.provider = provider;
        this.portionProvider = portionProvider;
    }
    async simulate(fromAddress, swapOptions, swapRoute, amount, quote, providerConfig) {
        const neededBalance = swapRoute.trade.tradeType == sdk_core_1.TradeType.EXACT_INPUT ? amount : quote;
        if ((neededBalance.currency.isNative && this.chainId == sdk_core_1.ChainId.MAINNET) ||
            (await this.userHasSufficientBalance(fromAddress, swapRoute.trade.tradeType, amount, quote))) {
            util_1.log.info('User has sufficient balance to simulate. Simulating transaction.');
            try {
                return this.simulateTransaction(fromAddress, swapOptions, swapRoute, providerConfig);
            }
            catch (e) {
                util_1.log.error({ e }, 'Error simulating transaction');
                return Object.assign(Object.assign({}, swapRoute), { simulationStatus: SimulationStatus.Failed });
            }
        }
        else {
            util_1.log.error('User does not have sufficient balance to simulate.');
            return Object.assign(Object.assign({}, swapRoute), { simulationStatus: SimulationStatus.InsufficientBalance });
        }
    }
    async userHasSufficientBalance(fromAddress, tradeType, amount, quote) {
        try {
            const neededBalance = tradeType == sdk_core_1.TradeType.EXACT_INPUT ? amount : quote;
            let balance;
            if (neededBalance.currency.isNative) {
                balance = await this.provider.getBalance(fromAddress);
            }
            else {
                const tokenContract = Erc20__factory_1.Erc20__factory.connect(neededBalance.currency.address, this.provider);
                balance = await tokenContract.balanceOf(fromAddress);
            }
            const hasBalance = balance.gte(ethers_1.BigNumber.from(neededBalance.quotient.toString()));
            util_1.log.info({
                fromAddress,
                balance: balance.toString(),
                neededBalance: neededBalance.quotient.toString(),
                neededAddress: neededBalance.wrapped.currency.address,
                hasBalance,
            }, 'Result of balance check for simulation');
            return hasBalance;
        }
        catch (e) {
            util_1.log.error(e, 'Error while checking user balance');
            return false;
        }
    }
    async checkTokenApproved(fromAddress, inputAmount, swapOptions, provider) {
        // Check token has approved Permit2 more than expected amount.
        const tokenContract = Erc20__factory_1.Erc20__factory.connect(inputAmount.currency.wrapped.address, provider);
        if (swapOptions.type == routers_1.SwapType.UNIVERSAL_ROUTER) {
            const permit2Allowance = await tokenContract.allowance(fromAddress, (0, permit2_sdk_1.permit2Address)(this.chainId));
            // If a permit has been provided we don't need to check if UR has already been allowed.
            if (swapOptions.inputTokenPermit) {
                util_1.log.info({
                    permitAllowance: permit2Allowance.toString(),
                    inputAmount: inputAmount.quotient.toString(),
                }, 'Permit was provided for simulation on UR, checking that Permit2 has been approved.');
                return permit2Allowance.gte(ethers_1.BigNumber.from(inputAmount.quotient.toString()));
            }
            // Check UR has been approved from Permit2.
            const permit2Contract = Permit2__factory_1.Permit2__factory.connect((0, permit2_sdk_1.permit2Address)(this.chainId), provider);
            const { amount: universalRouterAllowance, expiration: tokenExpiration } = await permit2Contract.allowance(fromAddress, inputAmount.currency.wrapped.address, (0, util_1.SWAP_ROUTER_02_ADDRESSES)(this.chainId));
            const nowTimestampS = Math.round(Date.now() / 1000);
            const inputAmountBN = ethers_1.BigNumber.from(inputAmount.quotient.toString());
            const permit2Approved = permit2Allowance.gte(inputAmountBN);
            const universalRouterApproved = universalRouterAllowance.gte(inputAmountBN);
            const expirationValid = tokenExpiration > nowTimestampS;
            util_1.log.info({
                permitAllowance: permit2Allowance.toString(),
                tokenAllowance: universalRouterAllowance.toString(),
                tokenExpirationS: tokenExpiration,
                nowTimestampS,
                inputAmount: inputAmount.quotient.toString(),
                permit2Approved,
                universalRouterApproved,
                expirationValid,
            }, `Simulating on UR, Permit2 approved: ${permit2Approved}, UR approved: ${universalRouterApproved}, Expiraton valid: ${expirationValid}.`);
            return permit2Approved && universalRouterApproved && expirationValid;
        }
        else if (swapOptions.type == routers_1.SwapType.SWAP_ROUTER_02) {
            if (swapOptions.inputTokenPermit) {
                util_1.log.info({
                    inputAmount: inputAmount.quotient.toString(),
                }, 'Simulating on SwapRouter02 info - Permit was provided for simulation. Not checking allowances.');
                return true;
            }
            const allowance = await tokenContract.allowance(fromAddress, (0, util_1.SWAP_ROUTER_02_ADDRESSES)(this.chainId));
            const hasAllowance = allowance.gte(ethers_1.BigNumber.from(inputAmount.quotient.toString()));
            util_1.log.info({
                hasAllowance,
                allowance: allowance.toString(),
                inputAmount: inputAmount.quotient.toString(),
            }, `Simulating on SwapRouter02 - Has allowance: ${hasAllowance}`);
            // Return true if token allowance is greater than input amount
            return hasAllowance;
        }
        throw new Error(`Unsupported swap type ${swapOptions}`);
    }
}
exports.Simulator = Simulator;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2ltdWxhdGlvbi1wcm92aWRlci5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uLy4uL3NyYy9wcm92aWRlcnMvc2ltdWxhdGlvbi1wcm92aWRlci50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSxnREFBdUQ7QUFDdkQsOENBQThDO0FBRTlDLHdDQUtvQjtBQUNwQiw0RUFBeUU7QUFDekUsZ0ZBQTZFO0FBQzdFLGtDQUF3RTtBQUd4RSxzREFBc0Q7QUFZdEQsSUFBWSxnQkFNWDtBQU5ELFdBQVksZ0JBQWdCO0lBQzFCLHVFQUFnQixDQUFBO0lBQ2hCLDJEQUFVLENBQUE7SUFDVixpRUFBYSxDQUFBO0lBQ2IscUZBQXVCLENBQUE7SUFDdkIscUVBQWUsQ0FBQTtBQUNqQixDQUFDLEVBTlcsZ0JBQWdCLEdBQWhCLHdCQUFnQixLQUFoQix3QkFBZ0IsUUFNM0I7QUFFRDs7Ozs7R0FLRztBQUNILE1BQXNCLFNBQVM7SUFJN0I7OztPQUdHO0lBQ0gsWUFDRSxRQUF5QixFQUN6QixlQUFpQyxFQUN2QixPQUFnQjtRQUFoQixZQUFPLEdBQVAsT0FBTyxDQUFTO1FBRTFCLElBQUksQ0FBQyxRQUFRLEdBQUcsUUFBUSxDQUFDO1FBQ3pCLElBQUksQ0FBQyxlQUFlLEdBQUcsZUFBZSxDQUFDO0lBQ3pDLENBQUM7SUFFTSxLQUFLLENBQUMsUUFBUSxDQUNuQixXQUFtQixFQUNuQixXQUF3QixFQUN4QixTQUFvQixFQUNwQixNQUFzQixFQUN0QixLQUFxQixFQUNyQixjQUF1QztRQUV2QyxNQUFNLGFBQWEsR0FDakIsU0FBUyxDQUFDLEtBQUssQ0FBQyxTQUFTLElBQUksb0JBQVMsQ0FBQyxXQUFXLENBQUMsQ0FBQyxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsS0FBSyxDQUFDO1FBQ3RFLElBQ0UsQ0FBQyxhQUFhLENBQUMsUUFBUSxDQUFDLFFBQVEsSUFBSSxJQUFJLENBQUMsT0FBTyxJQUFJLGtCQUFPLENBQUMsT0FBTyxDQUFDO1lBQ3BF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