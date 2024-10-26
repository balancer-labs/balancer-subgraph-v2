import { Address, BigDecimal, BigInt, Bytes, log, store } from '@graphprotocol/graph-ts';
import { OracleEnabledChanged } from '../types/templates/WeightedPool2Tokens/WeightedPool2Tokens';
import { PausedStateChanged, SwapFeePercentageChanged } from '../types/templates/WeightedPool/WeightedPool';
import {
  GradualWeightUpdateScheduled,
  SwapEnabledSet,
} from '../types/templates/LiquidityBootstrappingPool/LiquidityBootstrappingPool';
import { ManagementFeePercentageChanged } from '../types/templates/InvestmentPool/InvestmentPool';
import {
  ManagementAumFeePercentageChanged,
  MustAllowlistLPsSet,
  GradualSwapFeeUpdateScheduled,
  CircuitBreakerSet,
  ProtocolFeePercentageCacheUpdated as EncodedProtocolFeePercentageCacheUpdated,
  TokenAdded,
  TokenRemoved,
  JoinExitEnabledSet,
  ManagementAumFeeCollected,
} from '../types/templates/ManagedPool/ManagedPool';
import { TargetsSet } from '../types/templates/LinearPool/LinearPool';
import {
  AmpUpdateStarted,
  AmpUpdateStopped,
  PriceRateCacheUpdated,
  PriceRateProviderSet,
} from '../types/templates/MetaStablePool/MetaStablePool';
import {
  TokenRateCacheUpdated,
  TokenRateProviderSet,
} from '../types/templates/StablePhantomPoolV2/ComposableStablePool';
import { ParametersSet } from '../types/templates/FXPool/FXPool';
import {
  Pool,
  PriceRateProvider,
  GradualWeightUpdate,
  AmpUpdate,
  SwapFeeUpdate,
  CircuitBreaker,
  PoolContract,
  Balancer,
  PoolToken,
} from '../types/schema';

import {
  tokenToDecimal,
  scaleDown,
  loadPoolToken,
  getPoolTokenId,
  loadPriceRateProvider,
  getPoolShare,
  computeCuratedSwapEnabled,
  createPoolTokenEntity,
  bytesToAddress,
  getProtocolFeeCollector,
  createPoolSnapshot,
  hexToBigInt,
  getBalancerSnapshot,
  createPoolSnapshotHourly,
} from './helpers/misc';
import { ONE_BD, ProtocolFeeType, VAULT_ADDRESS, ZERO_ADDRESS, ZERO_BD } from './helpers/constants';
import { updateAmpFactor } from './helpers/stable';
import { getPoolTokenManager, getPoolTokens } from './helpers/pools';
import {
  ProtocolFeePercentageCacheUpdated,
  RecoveryModeStateChanged,
} from '../types/WeightedPoolV2Factory/WeightedPoolV2';
import { PausedLocally, UnpausedLocally } from '../types/templates/Gyro2Pool/Gyro2V2Pool';
import { WeightedPoolV2 } from '../types/templates/WeightedPoolV2/WeightedPoolV2';
import { Transfer } from '../types/Vault/ERC20';
import { valueInUSD } from './pricing';

/************************************
 ********** MANAGED POOLS ***********
 ************************************/

export function handleMustAllowlistLPsSet(event: MustAllowlistLPsSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.mustAllowlistLPs = event.params.mustAllowlistLPs;
  pool.save();
}

export function handleJoinExitEnabledSet(event: JoinExitEnabledSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.joinExitEnabled = event.params.joinExitEnabled;
  pool.save();
}

export function handleManagementAumFeeCollected(event: ManagementAumFeeCollected): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  let bptCollected = scaleDown(event.params.bptAmount, 18);
  let totalCollected = pool.totalAumFeeCollectedInBPT ? pool.totalAumFeeCollectedInBPT : ZERO_BD;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  pool.totalAumFeeCollectedInBPT = totalCollected!.plus(bptCollected);
  pool.save();
}

export function handleCircuitBreakerSet(event: CircuitBreakerSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  // ID for PoolToken and CircuitBreaker is built in the same way
  let id = getPoolTokenId(poolContract.pool, event.params.token);
  let circuitBreaker = new CircuitBreaker(id);
  circuitBreaker.pool = poolContract.pool;
  circuitBreaker.token = id;
  circuitBreaker.bptPrice = scaleDown(event.params.bptPrice, 18);
  circuitBreaker.lowerBoundPercentage = scaleDown(event.params.lowerBoundPercentage, 18);
  circuitBreaker.upperBoundPercentage = scaleDown(event.params.upperBoundPercentage, 18);
  circuitBreaker.save();

  let poolToken = PoolToken.load(id);
  if (!poolToken) return;

  poolToken.circuitBreaker = id;
  poolToken.save();
}

export function handleTokenAdded(event: TokenAdded): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  let poolIdBytes = Bytes.fromHexString(poolContract.pool);
  let tokens = getPoolTokens(poolIdBytes);
  if (tokens == null) return;
  pool.tokensList = tokens;
  pool.save();

  let tokenAdded = event.params.token;

  let assetManager = getPoolTokenManager(poolIdBytes, tokenAdded);
  if (!assetManager) return;

  let tokenAddedId = tokens.indexOf(tokenAdded);

  createPoolTokenEntity(pool, tokenAdded, tokenAddedId, assetManager);
}

export function handleTokenRemoved(event: TokenRemoved): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  let poolIdBytes = Bytes.fromHexString(poolContract.pool);
  let tokens = getPoolTokens(poolIdBytes);
  if (tokens == null) return;
  pool.tokensList = tokens;
  pool.save();

  for (let i: i32 = 0; i < pool.tokensList.length; i++) {
    let tokenAdress = bytesToAddress(pool.tokensList[i]);
    let poolToken = loadPoolToken(pool.id, tokenAdress) as PoolToken;
    poolToken.index = i;
    poolToken.save();
  }

  let poolTokenRemovedId = getPoolTokenId(poolContract.pool, event.params.token);
  store.remove('PoolToken', poolTokenRemovedId);
}

/************************************
 *********** PROTOCOL FEE ***********
 ************************************/

export function handleProtocolFeePercentageCacheUpdated(event: ProtocolFeePercentageCacheUpdated): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  const feeType = event.params.feeType.toI32();
  const feePercentage = scaleDown(event.params.protocolFeePercentage, 18);

  if (feeType == ProtocolFeeType.Swap) {
    pool.protocolSwapFeeCache = feePercentage;
  } else if (feeType == ProtocolFeeType.Yield) {
    pool.protocolYieldFeeCache = feePercentage;
  } else if (feeType == ProtocolFeeType.Aum) {
    pool.protocolAumFeeCache = feePercentage;
  }

  pool.save();
}

// For Managed Pools, the feeCache is encoded into bytes as follows:
// [  8 bytes |    8 bytes    |     8 bytes     |     8 bytes    ]
// [  unused  | AUM fee cache | Yield fee cache | Swap fee cache ]
// [MSB                                                       LSB]
export function handleEncodedProtocolFeePercentageCacheUpdated(event: EncodedProtocolFeePercentageCacheUpdated): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  // Convert to hex and remove the 0x prefix
  const feeCache = event.params.feeCache.toHex().slice(2);

  // Each byte represents 2 hex digits
  // Thus each fee is represented by 16 chars
  let encodedAumFee = feeCache.slice(16, 32);
  let encodedYieldFee = feeCache.slice(32, 48);
  let encodedSwapFee = feeCache.slice(48, 64);

  pool.protocolAumFeeCache = scaleDown(hexToBigInt(encodedAumFee), 18);
  pool.protocolYieldFeeCache = scaleDown(hexToBigInt(encodedYieldFee), 18);
  pool.protocolSwapFeeCache = scaleDown(hexToBigInt(encodedSwapFee), 18);

  pool.save();
}

/************************************
 *********** SWAP ENABLED ***********
 ************************************/

export function handleOracleEnabledChanged(event: OracleEnabledChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.oracleEnabled = event.params.enabled;
  pool.save();
}

/************************************
 *********** SWAP ENABLED ***********
 ************************************/

export function handleSwapEnabledSet(event: SwapEnabledSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  let swapEnabledInternal = event.params.swapEnabled;
  pool.swapEnabledInternal = swapEnabledInternal;
  pool.swapEnabled = computeCuratedSwapEnabled(pool.isPaused, pool.swapEnabledCurationSignal, swapEnabledInternal);
  pool.save();
}

export function handlePausedStateChanged(event: PausedStateChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;
  let pool = Pool.load(poolContract.pool) as Pool;
  let isPaused = event.params.paused;
  pool.isPaused = isPaused;
  pool.swapEnabled = computeCuratedSwapEnabled(isPaused, pool.swapEnabledCurationSignal, pool.swapEnabledInternal);
  pool.save();
}

export function handleRecoveryModeStateChanged(event: RecoveryModeStateChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;
  let pool = Pool.load(poolContract.pool) as Pool;
  pool.isInRecoveryMode = event.params.enabled;
  if (event.params.enabled) {
    pool.protocolAumFeeCache = ZERO_BD;
    pool.protocolSwapFeeCache = ZERO_BD;
    pool.protocolYieldFeeCache = ZERO_BD;
  } else {
    let weightedContract = WeightedPoolV2.bind(poolAddress);

    let protocolSwapFee = weightedContract.try_getProtocolFeePercentageCache(BigInt.fromI32(ProtocolFeeType.Swap));
    let protocolYieldFee = weightedContract.try_getProtocolFeePercentageCache(BigInt.fromI32(ProtocolFeeType.Yield));
    let protocolAumFee = weightedContract.try_getProtocolFeePercentageCache(BigInt.fromI32(ProtocolFeeType.Aum));

    pool.protocolSwapFeeCache = protocolSwapFee.reverted ? null : scaleDown(protocolSwapFee.value, 18);
    pool.protocolYieldFeeCache = protocolYieldFee.reverted ? null : scaleDown(protocolYieldFee.value, 18);
    pool.protocolAumFeeCache = protocolAumFee.reverted ? null : scaleDown(protocolAumFee.value, 18);
  }
  pool.save();
}

export function handlePauseGyroPool(event: PausedLocally): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.isPaused = true;
  pool.swapEnabledInternal = false;
  pool.swapEnabled = false;
  pool.save();
}

export function handleUnpauseGyroPool(event: UnpausedLocally): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.isPaused = false;
  pool.swapEnabledInternal = true;
  pool.swapEnabled = computeCuratedSwapEnabled(pool.isPaused, pool.swapEnabledCurationSignal, true);
  pool.save();
}

/************************************
 ********** WEIGHT UPDATES **********
 ************************************/

export function handleGradualWeightUpdateScheduled(event: GradualWeightUpdateScheduled): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let id = event.transaction.hash.toHexString().concat(event.transactionLogIndex.toString());
  let weightUpdate = new GradualWeightUpdate(id);
  weightUpdate.poolId = poolContract.pool;
  weightUpdate.scheduledTimestamp = event.block.timestamp.toI32();
  weightUpdate.startTimestamp = event.params.startTime;
  weightUpdate.endTimestamp = event.params.endTime;
  weightUpdate.startWeights = event.params.startWeights;
  weightUpdate.endWeights = event.params.endWeights;
  weightUpdate.save();
}

/************************************
 *********** AMP UPDATES ************
 ************************************/

export function handleAmpUpdateStarted(event: AmpUpdateStarted): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let poolId = poolContract.pool;

  let id = event.transaction.hash.toHexString().concat(event.transactionLogIndex.toString());
  let ampUpdate = new AmpUpdate(id);
  ampUpdate.poolId = poolId;
  ampUpdate.scheduledTimestamp = event.block.timestamp.toI32();
  ampUpdate.startTimestamp = event.params.startTime;
  ampUpdate.endTimestamp = event.params.endTime;
  ampUpdate.startAmp = event.params.startValue;
  ampUpdate.endAmp = event.params.endValue;
  ampUpdate.save();

  let pool = Pool.load(poolId);
  if (pool == null) return;

  pool.latestAmpUpdate = ampUpdate.id;
  pool.save();

  updateAmpFactor(pool, event.block.timestamp);
}

export function handleAmpUpdateStopped(event: AmpUpdateStopped): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let poolId = poolContract.pool;

  let id = event.transaction.hash.toHexString().concat(event.transactionLogIndex.toString());
  let ampUpdate = new AmpUpdate(id);
  ampUpdate.poolId = poolId;
  ampUpdate.scheduledTimestamp = event.block.timestamp.toI32();
  ampUpdate.startTimestamp = event.block.timestamp;
  ampUpdate.endTimestamp = event.block.timestamp;
  ampUpdate.startAmp = event.params.currentValue;
  ampUpdate.endAmp = event.params.currentValue;
  ampUpdate.save();

  let pool = Pool.load(poolId);
  if (pool == null) return;

  pool.latestAmpUpdate = ampUpdate.id;
  pool.save();

  updateAmpFactor(pool, event.block.timestamp);
}

/************************************
 *********** SWAP FEES ************
 ************************************/

export function handleSwapFeePercentageChange(event: SwapFeePercentageChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  const newSwapFee = scaleDown(event.params.swapFeePercentage, 18);
  pool.swapFee = newSwapFee;
  pool.save();

  const swapFeeUpdateID = event.transaction.hash.toHexString().concat(event.transactionLogIndex.toString());
  createSwapFeeUpdate(
    swapFeeUpdateID,
    pool,
    event.block.timestamp.toI32(),
    event.block.timestamp,
    event.block.timestamp,
    newSwapFee,
    newSwapFee
  );
}

export function handleGradualSwapFeeUpdateScheduled(event: GradualSwapFeeUpdateScheduled): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  const startSwapFee = scaleDown(event.params.startSwapFeePercentage, 18);
  const endSwapFee = scaleDown(event.params.endSwapFeePercentage, 18);

  const swapFeeUpdateID = event.transaction.hash.toHexString().concat(event.transactionLogIndex.toString());
  createSwapFeeUpdate(
    swapFeeUpdateID,
    pool,
    event.block.timestamp.toI32(),
    event.params.startTime,
    event.params.endTime,
    startSwapFee,
    endSwapFee
  );
}

export function createSwapFeeUpdate(
  _id: string,
  _pool: Pool,
  _blockTimestamp: i32,
  _startTimestamp: BigInt,
  _endTimestamp: BigInt,
  _startSwapFeePercentage: BigDecimal,
  _endSwapFeePercentage: BigDecimal
): void {
  let swapFeeUpdate = new SwapFeeUpdate(_id);
  swapFeeUpdate.pool = _pool.id;
  swapFeeUpdate.scheduledTimestamp = _blockTimestamp;
  swapFeeUpdate.startTimestamp = _startTimestamp;
  swapFeeUpdate.endTimestamp = _endTimestamp;
  swapFeeUpdate.startSwapFeePercentage = _startSwapFeePercentage;
  swapFeeUpdate.endSwapFeePercentage = _endSwapFeePercentage;
  swapFeeUpdate.save();
}

/************************************
 ********* MANAGEMENT FEES **********
 ************************************/

export function handleManagementFeePercentageChanged(event: ManagementFeePercentageChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.managementFee = scaleDown(event.params.managementFeePercentage, 18);
  pool.save();
}

export function handleManagementAumFeePercentageChanged(event: ManagementAumFeePercentageChanged): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  pool.managementAumFee = scaleDown(event.params.managementAumFeePercentage, 18);
  pool.save();
}

/************************************
 ************* TARGETS **************
 ************************************/

export function handleTargetsSet(event: TargetsSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.lowerTarget = tokenToDecimal(event.params.lowerTarget, 18);
  pool.upperTarget = tokenToDecimal(event.params.upperTarget, 18);
  pool.save();
}

/************************************
 ******** PRICE RATE UPDATE *********
 ************************************/

export function handlePriceRateProviderSet(event: PriceRateProviderSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  setPriceRateProvider(
    poolContract.pool,
    event.params.token,
    event.params.provider,
    event.params.cacheDuration.toI32(),
    event.block.timestamp.toI32()
  );
}

export function handleTokenRateProviderSet(event: TokenRateProviderSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  let token = pool.tokensList[event.params.tokenIndex.toI32()];
  let tokenAddress = Address.fromString(token.toHexString());

  setPriceRateProvider(
    poolContract.pool,
    tokenAddress,
    event.params.provider,
    event.params.cacheDuration.toI32(),
    event.block.timestamp.toI32()
  );
}

export function setPriceRateProvider(
  poolId: string,
  tokenAddress: Address,
  providerAdress: Address,
  cacheDuration: i32,
  blockTimestamp: i32
): void {
  let provider = loadPriceRateProvider(poolId, tokenAddress);
  if (provider == null) {
    // Price rate providers and pooltokens share an ID
    let providerId = getPoolTokenId(poolId, tokenAddress);
    provider = new PriceRateProvider(providerId);
    provider.poolId = poolId;
    provider.token = providerId;

    // Default to a rate of one, this should be updated in `handlePriceRateCacheUpdated` eventually
    provider.rate = ONE_BD;
    provider.lastCached = blockTimestamp;
    provider.cacheExpiry = blockTimestamp + cacheDuration;
  }

  provider.address = providerAdress;
  provider.cacheDuration = cacheDuration;

  provider.save();
}

export function handlePriceRateCacheUpdated(event: PriceRateCacheUpdated): void {
  let poolAddress = event.address;

  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  setPriceRateCache(poolContract.pool, event.params.token, event.params.rate, event.block.timestamp.toI32());
}

export function handleTokenRateCacheUpdated(event: TokenRateCacheUpdated): void {
  let poolAddress = event.address;

  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;

  let token = pool.tokensList[event.params.tokenIndex.toI32()];
  let tokenAddress = Address.fromString(token.toHexString());

  setPriceRateCache(poolContract.pool, tokenAddress, event.params.rate, event.block.timestamp.toI32());
}

export function setPriceRateCache(poolId: string, tokenAddress: Address, rate: BigInt, blockTimestamp: i32): void {
  let rateScaled = scaleDown(rate, 18);
  let provider = loadPriceRateProvider(poolId, tokenAddress);
  if (provider == null) {
    log.warning('Provider not found in handlePriceRateCacheUpdated: {} {}', [poolId, tokenAddress.toHexString()]);
  } else {
    provider.rate = rateScaled;
    provider.lastCached = blockTimestamp;
    provider.cacheExpiry = blockTimestamp + provider.cacheDuration;

    provider.save();
  }

  // Attach the rate onto the PoolToken entity
  let poolToken = loadPoolToken(poolId, tokenAddress);
  if (poolToken == null) return;
  poolToken.oldPriceRate = poolToken.priceRate;
  poolToken.priceRate = rateScaled;
  poolToken.save();
}

/************************************
 *********** POOL SHARES ************
 ************************************/

export function handleTransfer(event: Transfer): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let poolId = poolContract.pool;

  let isMint = event.params.from == ZERO_ADDRESS;
  let isBurn = event.params.to == ZERO_ADDRESS;

  let poolShareFrom = getPoolShare(poolId, event.params.from);
  let poolShareFromBalance = poolShareFrom == null ? ZERO_BD : poolShareFrom.balance;

  let poolShareTo = getPoolShare(poolId, event.params.to);
  let poolShareToBalance = poolShareTo == null ? ZERO_BD : poolShareTo.balance;

  let pool = Pool.load(poolId) as Pool;

  let BPT_DECIMALS = 18;

  if (isMint) {
    poolShareTo.balance = poolShareTo.balance.plus(tokenToDecimal(event.params.value, BPT_DECIMALS));
    poolShareTo.save();
    pool.totalShares = pool.totalShares.plus(tokenToDecimal(event.params.value, BPT_DECIMALS));

    // mint of BPT to the fee collector means the pool is paying protocol fees
    let vault = Balancer.load('2') as Balancer;
    let protocolFeeCollector = vault.protocolFeesCollector;
    if (!protocolFeeCollector) {
      protocolFeeCollector = getProtocolFeeCollector();
      vault.protocolFeesCollector = protocolFeeCollector;
      vault.save();
    }

    if (protocolFeeCollector && poolShareTo.userAddress == protocolFeeCollector.toHex()) {
      let protocolFeePaid = tokenToDecimal(event.params.value, BPT_DECIMALS);
      let totalProtocolFee = pool.totalProtocolFeePaidInBPT ? pool.totalProtocolFeePaidInBPT : ZERO_BD;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      pool.totalProtocolFeePaidInBPT = totalProtocolFee!.plus(protocolFeePaid);

      let protocolFeeUSD = valueInUSD(protocolFeePaid, poolAddress);
      let totalProtocolFeeUSD = pool.totalProtocolFee ? pool.totalProtocolFee : ZERO_BD;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      pool.totalProtocolFee = totalProtocolFeeUSD!.plus(protocolFeeUSD);

      // create or update pool's snapshot
      createPoolSnapshot(pool, event.block.timestamp.toI32());
      createPoolSnapshotHourly(pool, event.block.timestamp.toI32());

      let vault = Balancer.load('2') as Balancer;
      let vaultProtocolFee = vault.totalProtocolFee ? vault.totalProtocolFee : ZERO_BD;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vault.totalProtocolFee = vaultProtocolFee!.plus(protocolFeeUSD);
      vault.save();
      // create or update balancer's vault snapshot
      getBalancerSnapshot(vault.id, event.block.timestamp.toI32());
    }
  } else if (isBurn) {
    poolShareFrom.balance = poolShareFrom.balance.minus(tokenToDecimal(event.params.value, BPT_DECIMALS));
    poolShareFrom.save();
    pool.totalShares = pool.totalShares.minus(tokenToDecimal(event.params.value, BPT_DECIMALS));
  } else {
    poolShareTo.balance = poolShareTo.balance.plus(tokenToDecimal(event.params.value, BPT_DECIMALS));
    poolShareTo.save();

    poolShareFrom.balance = poolShareFrom.balance.minus(tokenToDecimal(event.params.value, BPT_DECIMALS));
    poolShareFrom.save();
  }

  if (
    poolShareTo !== null &&
    poolShareTo.balance.notEqual(ZERO_BD) &&
    poolShareToBalance.equals(ZERO_BD) &&
    poolShareTo.userAddress != VAULT_ADDRESS.toHex()
  ) {
    pool.holdersCount = pool.holdersCount.plus(BigInt.fromI32(1));
  }

  if (
    poolShareFrom !== null &&
    poolShareFrom.balance.equals(ZERO_BD) &&
    poolShareFromBalance.notEqual(ZERO_BD) &&
    poolShareFrom.userAddress != VAULT_ADDRESS.toHex()
  ) {
    pool.holdersCount = pool.holdersCount.minus(BigInt.fromI32(1));
  }

  pool.save();
}

/************************************
 ************* FXPOOL ***************
 ************************************/

export function handleParametersSet(event: ParametersSet): void {
  let poolAddress = event.address;
  let poolContract = PoolContract.load(poolAddress.toHexString());
  if (poolContract == null) return;

  let pool = Pool.load(poolContract.pool) as Pool;
  pool.alpha = scaleDown(event.params.alpha, 18);
  pool.beta = scaleDown(event.params.beta, 18);
  pool.delta = scaleDown(event.params.delta, 18);
  pool.epsilon = scaleDown(event.params.epsilon, 18);
  pool.lambda = scaleDown(event.params.lambda, 18);
  pool.save();
}
