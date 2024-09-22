import { ChainId } from '@uniswap/sdk-core';
import retry from 'async-retry';
import Timeout from 'await-timeout';
import { gql, GraphQLClient } from 'graphql-request';
import _ from 'lodash';
import { log, metric } from '../../util';
export const printV3SubgraphPool = (s) => `${s.token0.id}/${s.token1.id}/${s.feeTier}`;
export const printV2SubgraphPool = (s) => `${s.token0.id}/${s.token1.id}`;
const SUBGRAPH_URL_BY_CHAIN = {
    [ChainId.MAINNET]: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
    [ChainId.OPTIMISM]: 'https://api.thegraph.com/subgraphs/name/ianlapham/optimism-post-regenesis',
    // todo: add once subgraph is live
    [ChainId.OPTIMISM_SEPOLIA]: '',
    [ChainId.ARBITRUM_ONE]: 'https://api.thegraph.com/subgraphs/name/ianlapham/arbitrum-minimal',
    // todo: add once subgraph is live
    [ChainId.ARBITRUM_SEPOLIA]: '',
    [ChainId.POLYGON]: 'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-polygon',
    [ChainId.CELO]: 'https://api.thegraph.com/subgraphs/name/jesse-sawa/uniswap-celo',
    [ChainId.GOERLI]: 'https://api.thegraph.com/subgraphs/name/ianlapham/uniswap-v3-gorli',
    [ChainId.BNB]: 'https://api.thegraph.com/subgraphs/name/ilyamk/uniswap-v3---bnb-chain',
    [ChainId.AVALANCHE]: 'https://api.thegraph.com/subgraphs/name/lynnshaoyu/uniswap-v3-avax',
    [ChainId.BASE]: 'https://api.studio.thegraph.com/query/48211/uniswap-v3-base/version/latest',
    [ChainId.BLAST]: 'https://gateway-arbitrum.network.thegraph.com/api/0ae45f0bf40ae2e73119b44ccd755967/subgraphs/id/2LHovKznvo8YmKC9ZprPjsYAZDCc4K5q4AYz8s3cnQn1',
};
const PAGE_SIZE = 1000; // 1k is max possible query size from subgraph.
export class V3SubgraphProvider {
    constructor(chainId, retries = 2, timeout = 30000, rollback = true, trackedEthThreshold = 0.01, untrackedUsdThreshold = Number.MAX_VALUE, subgraphUrlOverride) {
        var _a;
        this.chainId = chainId;
        this.retries = retries;
        this.timeout = timeout;
        this.rollback = rollback;
        this.trackedEthThreshold = trackedEthThreshold;
        this.untrackedUsdThreshold = untrackedUsdThreshold;
        this.subgraphUrlOverride = subgraphUrlOverride;
        const subgraphUrl = (_a = this.subgraphUrlOverride) !== null && _a !== void 0 ? _a : SUBGRAPH_URL_BY_CHAIN[this.chainId];
        if (!subgraphUrl) {
            throw new Error(`No subgraph url for chain id: ${this.chainId}`);
        }
        this.client = new GraphQLClient(subgraphUrl);
    }
    async getPools(_tokenIn, _tokenOut, providerConfig) {
        const beforeAll = Date.now();
        let blockNumber = (providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.blockNumber)
            ? await providerConfig.blockNumber
            : undefined;
        const query = gql `
      query getPools($pageSize: Int!, $id: String) {
        pools(
          first: $pageSize
          ${blockNumber ? `block: { number: ${blockNumber} }` : ``}
          where: { id_gt: $id }
        ) {
          id
          token0 {
            symbol
            id
          }
          token1 {
            symbol
            id
          }
          feeTier
          liquidity
          totalValueLockedUSD
          totalValueLockedETH
          totalValueLockedUSDUntracked
        }
      }
    `;
        let pools = [];
        log.info(`Getting V3 pools from the subgraph with page size ${PAGE_SIZE}${(providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.blockNumber)
            ? ` as of block ${providerConfig === null || providerConfig === void 0 ? void 0 : providerConfig.blockNumber}`
            : ''}.`);
        let retries = 0;
        await retry(async () => {
            const timeout = new Timeout();
            const getPools = async () => {
                let lastId = '';
                let pools = [];
                let poolsPage = [];
                // metrics variables
                let totalPages = 0;
                do {
                    totalPages += 1;
                    const poolsResult = await this.client.request(query, {
                        pageSize: PAGE_SIZE,
                        id: lastId,
                    });
                    poolsPage = poolsResult.pools;
                    pools = pools.concat(poolsPage);
                    lastId = pools[pools.length - 1].id;
                    metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.paginate.pageSize`, poolsPage.length);
                } while (poolsPage.length > 0);
                metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.paginate`, totalPages);
                metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.pools.length`, pools.length);
                return pools;
            };
            /* eslint-disable no-useless-catch */
            try {
                const getPoolsPromise = getPools();
                const timerPromise = timeout.set(this.timeout).then(() => {
                    throw new Error(`Timed out getting pools from subgraph: ${this.timeout}`);
                });
                pools = await Promise.race([getPoolsPromise, timerPromise]);
                return;
            }
            catch (err) {
                throw err;
            }
            finally {
                timeout.clear();
            }
            /* eslint-enable no-useless-catch */
        }, {
            retries: this.retries,
            onRetry: (err, retry) => {
                retries += 1;
                if (this.rollback &&
                    blockNumber &&
                    _.includes(err.message, 'indexed up to')) {
                    metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.indexError`, 1);
                    blockNumber = blockNumber - 10;
                    log.info(`Detected subgraph indexing error. Rolled back block number to: ${blockNumber}`);
                }
                metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.timeout`, 1);
                pools = [];
                log.info({ err }, `Failed to get pools from subgraph. Retry attempt: ${retry}`);
            },
        });
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.retries`, retries);
        const untrackedPools = pools.filter(pool => parseInt(pool.liquidity) > 0 ||
            parseFloat(pool.totalValueLockedETH) > this.trackedEthThreshold ||
            parseFloat(pool.totalValueLockedUSDUntracked) > this.untrackedUsdThreshold);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.untracked.length`, untrackedPools.length);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.untracked.percent`, (untrackedPools.length / pools.length) * 100);
        const beforeFilter = Date.now();
        const poolsSanitized = pools
            .filter((pool) => parseInt(pool.liquidity) > 0 ||
            parseFloat(pool.totalValueLockedETH) > this.trackedEthThreshold)
            .map((pool) => {
            const { totalValueLockedETH, totalValueLockedUSD } = pool;
            return {
                id: pool.id.toLowerCase(),
                feeTier: pool.feeTier,
                token0: {
                    id: pool.token0.id.toLowerCase(),
                },
                token1: {
                    id: pool.token1.id.toLowerCase(),
                },
                liquidity: pool.liquidity,
                tvlETH: parseFloat(totalValueLockedETH),
                tvlUSD: parseFloat(totalValueLockedUSD),
            };
        });
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.filter.latency`, Date.now() - beforeFilter);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.filter.length`, poolsSanitized.length);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.filter.percent`, (poolsSanitized.length / pools.length) * 100);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools`, 1);
        metric.putMetric(`V3SubgraphProvider.chain_${this.chainId}.getPools.latency`, Date.now() - beforeAll);
        log.info(`Got ${pools.length} V3 pools from the subgraph. ${poolsSanitized.length} after filtering`);
        return poolsSanitized;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic3ViZ3JhcGgtcHJvdmlkZXIuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi8uLi9zcmMvcHJvdmlkZXJzL3YzL3N1YmdyYXBoLXByb3ZpZGVyLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLE9BQU8sRUFBRSxPQUFPLEVBQVMsTUFBTSxtQkFBbUIsQ0FBQztBQUNuRCxPQUFPLEtBQUssTUFBTSxhQUFhLENBQUM7QUFDaEMsT0FBTyxPQUFPLE1BQU0sZUFBZSxDQUFDO0FBQ3BDLE9BQU8sRUFBRSxHQUFHLEVBQUUsYUFBYSxFQUFFLE1BQU0saUJBQWlCLENBQUM7QUFDckQsT0FBTyxDQUFDLE1BQU0sUUFBUSxDQUFDO0FBRXZCLE9BQU8sRUFBRSxHQUFHLEVBQUUsTUFBTSxFQUFFLE1BQU0sWUFBWSxDQUFDO0FBbUN6QyxNQUFNLENBQUMsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLENBQWlCLEVBQUUsRUFBRSxDQUN2RCxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxPQUFPLEVBQUUsQ0FBQztBQUUvQyxNQUFNLENBQUMsTUFBTSxtQkFBbUIsR0FBRyxDQUFDLENBQWlCLEVBQUUsRUFBRSxDQUN2RCxHQUFHLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxJQUFJLENBQUMsQ0FBQyxNQUFNLENBQUMsRUFBRSxFQUFFLENBQUM7QUFFbEMsTUFBTSxxQkFBcUIsR0FBc0M7SUFDL0QsQ0FBQyxPQUFPLENBQUMsT0FBTyxDQUFDLEVBQ2YsNERBQTREO0lBQzlELENBQUMsT0FBTyxDQUFDLFFBQVEsQ0FBQyxFQUNoQiwyRUFBMkU7SUFDN0Usa0NBQWtDO0lBQ2xDLENBQUMsT0FBTyxDQUFDLGdCQUFnQixDQUFDLEVBQUUsRUFBRTtJQUM5QixDQUFDLE9BQU8sQ0FBQyxZQUFZLENBQUMsRUFDcEIsb0VBQW9FO0lBQ3RFLGtDQUFrQztJQUNsQyxDQUFD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