import { BigInt, BigDecimal, Address, log, ethereum } from '@graphprotocol/graph-ts';
import {
  Swap as SwapEvent,
  PoolBalanceChanged,
  PoolBalanceManaged,
  InternalBalanceChanged,
} from '../types/Vault/Vault';
import {
  Balancer,
  Pool,
  Swap,
  JoinExit,
  TokenPrice,
  UserInternalBalance,
  ManagementOperation,
  Token,
  PoolContract,
} from '../types/schema';
import {
  tokenToDecimal,
  getTokenPriceId,
  scaleDown,
  scaleUp,
  createUserEntity,
  getTokenDecimals,
  loadPoolToken,
  getToken,
  getTokenSnapshot,
  uptickSwapsForToken,
  updateTokenBalances,
  getTradePairSnapshot,
  getTradePair,
  getBalancerSnapshot,
  getPoolShare,
} from './helpers/misc';
import { updatePoolWeights } from './helpers/weighted';
import {
  isPricingAsset,
  addHistoricalPoolLiquidityRecord,
  valueInUSD,
  swapValueInUSD,
  getPreferentialPricingAsset,
  updateLatestPrice,
  updatePoolLiquidity,
  setWrappedTokenPrice,
} from './pricing';
import {
  MIN_POOL_LIQUIDITY,
  MIN_SWAP_VALUE_USD,
  SWAP_IN,
  SWAP_OUT,
  VAULT_ADDRESS,
  ZERO,
  ZERO_ADDRESS,
  ZERO_BD,
} from './helpers/constants';
import {
  hasVirtualSupply,
  isVariableWeightPool,
  isStableLikePool,
  PoolType,
  isLinearPool,
  isFXPool,
  isComposableStablePool,
  isManagedPool,
} from './helpers/pools';
import { calculateInvariant, AMP_PRECISION, updateAmpFactor } from './helpers/stable';
import { USDC_ADDRESS } from './helpers/assets';
import { Transfer } from '../types/Vault/ERC20';
import { handleTransfer } from './poolController';

/************************************
 ******** INTERNAL BALANCES *********
 ************************************/

export function handleInternalBalanceChange(event: InternalBalanceChanged): void {
  createUserEntity(event.params.user);

  let userAddress = event.params.user.toHexString();
  const tokenAddress = event.params.token;
  const token = getToken(tokenAddress);
  let balanceId = userAddress.concat(token.id);

  let userBalance = UserInternalBalance.load(balanceId);
  if (userBalance == null) {
    userBalance = new UserInternalBalance(balanceId);

    userBalance.userAddress = userAddress;
    userBalance.tokenInfo = token.id;
    userBalance.token = tokenAddress;
    userBalance.balance = ZERO_BD;
  }

  let transferAmount = event.params.delta;
  let scaledTransferAmount = tokenToDecimal(transferAmount, getTokenDecimals(tokenAddress));
  userBalance.balance = userBalance.balance.plus(scaledTransferAmount);

  userBalance.save();

  // if the token is a pool's BPT, update the user's total shares
  let poolContract = PoolContract.load(tokenAddress.toHexString());
  if (poolContract == null) return;
  let mockFrom = VAULT_ADDRESS;
  let mockTo = event.params.user;
  let mockAmount = transferAmount;
  if (transferAmount.lt(ZERO)) {
    mockFrom = event.params.user;
    mockTo = VAULT_ADDRESS;
    mockAmount = transferAmount.neg();
  }
  const mockEvent = new Transfer(
    tokenAddress,
    event.logIndex,
    event.transactionLogIndex,
    event.logType,
    event.block,
    event.transaction,
    [
      new ethereum.EventParam('from', ethereum.Value.fromAddress(mockFrom)),
      new ethereum.EventParam('to', ethereum.Value.fromAddress(mockTo)),
      new ethereum.EventParam('value', ethereum.Value.fromUnsignedBigInt(mockAmount)),
    ],
    event.receipt
  );
  handleTransfer(mockEvent);
}

/************************************
 ****** DEPOSITS & WITHDRAWALS ******
 ************************************/

export function handleBalanceChange(event: PoolBalanceChanged): void {
  let amounts: BigInt[] = event.params.deltas;

  if (amounts.length === 0) {
    return;
  }
  let total: BigInt = amounts.reduce<BigInt>((sum, amount) => sum.plus(amount), new BigInt(0));
  if (total.gt(ZERO)) {
    handlePoolJoined(event);
  } else {
    handlePoolExited(event);
  }
}

function handlePoolJoined(event: PoolBalanceChanged): void {
  let poolId: string = event.params.poolId.toHexString();
  let amounts: BigInt[] = event.params.deltas;
  let protocolFeeAmounts: BigInt[] = event.params.protocolFeeAmounts;
  let blockTimestamp = event.block.timestamp.toI32();
  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;

  let pool = Pool.load(poolId);
  if (pool == null) {
    log.warning('Pool not found in handlePoolJoined: {} {}', [poolId, transactionHash.toHexString()]);
    return;
  }

  if (!pool.isInitialized) pool.isInitialized = true;

  // if a pool that was paused is joined, it means it's pause has expired
  // TODO: fix this for when pool.isPaused is null
  // TODO: handle the case where the pool's actual swapEnabled is false
  // if (pool.isPaused) {
  //   pool.isPaused = false;
  //   pool.swapEnabled = true;
  // }

  let tokenAddresses = pool.tokensList;

  let joinId = transactionHash.toHexString().concat(logIndex.toString());
  let join = new JoinExit(joinId);
  join.sender = event.params.liquidityProvider;
  let joinAmounts = new Array<BigDecimal>(amounts.length);
  let valueUSD = ZERO_BD;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) {
      throw new Error('poolToken not found');
    }
    let joinAmount = scaleDown(amounts[i], poolToken.decimals);
    joinAmounts[i] = joinAmount;
    let tokenJoinAmountInUSD = valueInUSD(joinAmount, tokenAddress);
    valueUSD = valueUSD.plus(tokenJoinAmountInUSD);
  }
  join.type = 'Join';
  join.amounts = joinAmounts;
  join.pool = event.params.poolId.toHexString();
  join.user = event.params.liquidityProvider.toHexString();
  join.timestamp = blockTimestamp;
  join.tx = transactionHash;
  join.valueUSD = valueUSD;
  join.block = event.block.number;
  join.save();

  let protocolFeeUSD = ZERO_BD;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);

    // adding initial liquidity
    if (poolToken == null) {
      throw new Error('poolToken not found');
    }
    let amountIn = amounts[i].minus(protocolFeeAmounts[i]);
    let tokenAmountIn = tokenToDecimal(amountIn, poolToken.decimals);
    let newBalance = poolToken.balance.plus(tokenAmountIn);
    let paidProtocolFees = poolToken.paidProtocolFees ? poolToken.paidProtocolFees : ZERO_BD;
    let protocolFeeAmount = tokenToDecimal(protocolFeeAmounts[i], poolToken.decimals);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    poolToken.paidProtocolFees = paidProtocolFees!.plus(protocolFeeAmount);
    poolToken.balance = newBalance;
    poolToken.save();

    let protocolFeeAmountUSD = valueInUSD(protocolFeeAmount, tokenAddress);
    protocolFeeUSD = protocolFeeUSD.plus(protocolFeeAmountUSD);

    let token = getToken(tokenAddress);
    const tokenTotalBalanceNotional = token.totalBalanceNotional.plus(tokenAmountIn);
    const tokenTotalBalanceUSD = valueInUSD(tokenTotalBalanceNotional, tokenAddress);
    token.totalBalanceNotional = tokenTotalBalanceNotional;
    token.totalBalanceUSD = tokenTotalBalanceUSD;
    token.save();

    let tokenSnapshot = getTokenSnapshot(tokenAddress, event);
    tokenSnapshot.totalBalanceNotional = tokenTotalBalanceNotional;
    tokenSnapshot.totalBalanceUSD = tokenTotalBalanceUSD;
    tokenSnapshot.save();
  }

  let totalProtocolFee = pool.totalProtocolFee ? pool.totalProtocolFee : ZERO_BD;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  pool.totalProtocolFee = totalProtocolFee!.plus(protocolFeeUSD);

  let vault = Balancer.load('2') as Balancer;
  let vaultProtocolFee = vault.totalProtocolFee ? vault.totalProtocolFee : ZERO_BD;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  vault.totalProtocolFee = vaultProtocolFee!.plus(protocolFeeUSD);
  vault.save();
  // create or update balancer's vault snapshot
  getBalancerSnapshot(vault.id, blockTimestamp);

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    if (isPricingAsset(tokenAddress)) {
      let success = addHistoricalPoolLiquidityRecord(poolId, event.block.number, tokenAddress);
      // Some pricing assets may not have a route back to USD yet
      // so we keep trying until we find one
      if (success) {
        break;
      }
    }
  }

  pool.save();

  // Managed, StablePhantom and ComposableStable pools only emit the PoolBalanceChanged event
  // with a non-zero value for the BPT amount when the pool is initialized,
  // when the amount of BPT informed in the event corresponds to the "excess" BPT that was preminted
  // and therefore must be subtracted from totalShares
  if (pool.poolType == PoolType.StablePhantom || isComposableStablePool(pool) || isManagedPool(pool)) {
    let preMintedBpt = ZERO;
    let scaledPreMintedBpt = ZERO_BD;
    for (let i: i32 = 0; i < tokenAddresses.length; i++) {
      if (tokenAddresses[i] == pool.address) {
        preMintedBpt = amounts[i];
        scaledPreMintedBpt = scaleDown(preMintedBpt, 18);
      }
    }
    pool.totalShares = pool.totalShares.minus(scaledPreMintedBpt);

    pool.save();

    // This amount will also be transferred to the vault,
    // causing the vault's 'user shares' to incorrectly
    // increase, so we need to subtract it.
    const vaultPoolShare = getPoolShare(poolId, VAULT_ADDRESS);
    vaultPoolShare.balance = vaultPoolShare.balance.minus(tokenToDecimal(preMintedBpt, 18));
    vaultPoolShare.save();
  }

  updatePoolLiquidity(poolId, event.block.number, event.block.timestamp);
}

function handlePoolExited(event: PoolBalanceChanged): void {
  let poolId = event.params.poolId.toHex();
  let amounts = event.params.deltas;
  let protocolFeeAmounts: BigInt[] = event.params.protocolFeeAmounts;
  let blockTimestamp = event.block.timestamp.toI32();
  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;

  let pool = Pool.load(poolId);
  if (pool == null) {
    log.warning('Pool not found in handlePoolExited: {} {}', [poolId, transactionHash.toHexString()]);
    return;
  }
  let tokenAddresses = pool.tokensList;

  let exitId = transactionHash.toHexString().concat(logIndex.toString());
  let exit = new JoinExit(exitId);
  exit.sender = event.params.liquidityProvider;
  let exitAmounts = new Array<BigDecimal>(amounts.length);
  let valueUSD = ZERO_BD;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) {
      throw new Error('poolToken not found');
    }
    let exitAmount = scaleDown(amounts[i].neg(), poolToken.decimals);
    exitAmounts[i] = exitAmount;
    let tokenExitAmountInUSD = valueInUSD(exitAmount, tokenAddress);
    valueUSD = valueUSD.plus(tokenExitAmountInUSD);
  }
  exit.type = 'Exit';
  exit.amounts = exitAmounts;
  exit.pool = event.params.poolId.toHexString();
  exit.user = event.params.liquidityProvider.toHexString();
  exit.timestamp = blockTimestamp;
  exit.tx = transactionHash;
  exit.valueUSD = valueUSD;
  exit.block = event.block.number;
  exit.save();

  let protocolFeeUSD = ZERO_BD;
  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    let poolToken = loadPoolToken(poolId, tokenAddress);

    // adding initial liquidity
    if (poolToken == null) {
      throw new Error('poolToken not found');
    }
    let amountOut = amounts[i].minus(protocolFeeAmounts[i]).neg();
    let tokenAmountOut = tokenToDecimal(amountOut, poolToken.decimals);
    let newBalance = poolToken.balance.minus(tokenAmountOut);
    let paidProtocolFees = poolToken.paidProtocolFees ? poolToken.paidProtocolFees : ZERO_BD;
    let protocolFeeAmount = tokenToDecimal(protocolFeeAmounts[i], poolToken.decimals);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    poolToken.paidProtocolFees = paidProtocolFees!.plus(protocolFeeAmount);
    poolToken.balance = newBalance;
    poolToken.save();

    let protocolFeeAmountUSD = valueInUSD(protocolFeeAmount, tokenAddress);
    protocolFeeUSD = protocolFeeUSD.plus(protocolFeeAmountUSD);

    let token = getToken(tokenAddress);
    const tokenTotalBalanceNotional = token.totalBalanceNotional.minus(tokenAmountOut);
    const tokenTotalBalanceUSD = valueInUSD(tokenTotalBalanceNotional, tokenAddress);
    token.totalBalanceNotional = tokenTotalBalanceNotional;
    token.totalBalanceUSD = tokenTotalBalanceUSD;
    token.save();

    let tokenSnapshot = getTokenSnapshot(tokenAddress, event);
    tokenSnapshot.totalBalanceNotional = tokenTotalBalanceNotional;
    tokenSnapshot.totalBalanceUSD = tokenTotalBalanceUSD;
    tokenSnapshot.save();
  }

  let totalProtocolFee = pool.totalProtocolFee ? pool.totalProtocolFee : ZERO_BD;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  pool.totalProtocolFee = totalProtocolFee!.plus(protocolFeeUSD);
  pool.save();

  let vault = Balancer.load('2') as Balancer;
  let vaultProtocolFee = vault.totalProtocolFee ? vault.totalProtocolFee : ZERO_BD;
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  vault.totalProtocolFee = vaultProtocolFee!.plus(protocolFeeUSD);
  vault.save();
  // create or update balancer's vault snapshot
  getBalancerSnapshot(vault.id, blockTimestamp);

  for (let i: i32 = 0; i < tokenAddresses.length; i++) {
    let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
    if (isPricingAsset(tokenAddress)) {
      let success = addHistoricalPoolLiquidityRecord(poolId, event.block.number, tokenAddress);
      // Some pricing assets may not have a route back to USD yet
      // so we keep trying until we find one
      if (success) {
        break;
      }
    }
  }

  updatePoolLiquidity(poolId, event.block.number, event.block.timestamp);
}

/************************************
 ********** INVESTMENTS *************
 ************************************/
export function handleBalanceManage(event: PoolBalanceManaged): void {
  let poolId = event.params.poolId;
  let pool = Pool.load(poolId.toHex());
  if (pool == null) {
    log.warning('Pool not found in handleBalanceManage: {}', [poolId.toHexString()]);
    return;
  }

  let tokenAddress: Address = event.params.token;

  let cashDelta = event.params.cashDelta;
  let managedDelta = event.params.managedDelta;

  let poolToken = loadPoolToken(poolId.toHexString(), tokenAddress);
  if (poolToken == null) {
    throw new Error('poolToken not found');
  }

  let cashDeltaAmount = tokenToDecimal(cashDelta, poolToken.decimals);
  let managedDeltaAmount = tokenToDecimal(managedDelta, poolToken.decimals);
  let deltaAmount = cashDeltaAmount.plus(managedDeltaAmount);

  poolToken.balance = poolToken.balance.plus(deltaAmount);
  poolToken.cashBalance = poolToken.cashBalance.plus(cashDeltaAmount);
  poolToken.managedBalance = poolToken.managedBalance.plus(managedDeltaAmount);
  poolToken.save();

  let token = getToken(tokenAddress);
  const tokenTotalBalanceNotional = token.totalBalanceNotional.plus(deltaAmount);
  const tokenTotalBalanceUSD = valueInUSD(tokenTotalBalanceNotional, tokenAddress);
  token.totalBalanceNotional = tokenTotalBalanceNotional;
  token.totalBalanceUSD = tokenTotalBalanceUSD;
  token.save();

  let tokenSnapshot = getTokenSnapshot(tokenAddress, event);
  tokenSnapshot.totalBalanceNotional = tokenTotalBalanceNotional;
  tokenSnapshot.totalBalanceUSD = tokenTotalBalanceUSD;
  tokenSnapshot.save();

  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;
  let managementId = transactionHash.toHexString().concat(logIndex.toHexString());

  let management = new ManagementOperation(managementId);
  if (cashDeltaAmount.gt(ZERO_BD)) {
    management.type = 'Deposit';
  } else if (cashDeltaAmount.lt(ZERO_BD)) {
    management.type = 'Withdraw';
  } else {
    management.type = 'Update';
  }
  management.poolTokenId = poolToken.id;
  management.cashDelta = cashDeltaAmount;
  management.managedDelta = managedDeltaAmount;
  management.timestamp = event.block.timestamp.toI32();
  management.save();

  setWrappedTokenPrice(pool, poolId.toHex(), event.block.number, event.block.timestamp);
}

/************************************
 ************** SWAPS ***************
 ************************************/
export function handleSwapEvent(event: SwapEvent): void {
  createUserEntity(event.transaction.from);
  let poolId = event.params.poolId;

  let pool = Pool.load(poolId.toHexString());
  if (pool == null) {
    log.warning('Pool not found in handleSwapEvent: {}', [poolId.toHexString()]);
    return;
  }

  // if a swap happens in a pool that was paused, it means it's pause has expired
  // TODO: fix this for when pool.isPaused is null
  // TODO: handle the case where the pool's actual swapEnabled is false
  // if (pool.isPaused) {
  //   pool.isPaused = false;
  //   pool.swapEnabled = true;
  // }

  if (isVariableWeightPool(pool)) {
    // Some pools' weights update over time so we need to update them after each swap
    updatePoolWeights(poolId.toHexString());
  } else if (isStableLikePool(pool)) {
    // Stablelike pools' amplification factors update over time so we need to update them after each swap
    updateAmpFactor(pool, event.block.timestamp);
  }

  // If swapping on a pool with preminted BPT and the BPT itself is being swapped then this is equivalent to a mint/burn in a regular pool
  // We need to update the pool's totalShares and add/subtract from the vault's share of that pool, to negate the corresponding transfer event of the BPT
  if (hasVirtualSupply(pool)) {
    if (event.params.tokenIn == pool.address) {
      const scaledAmount = tokenToDecimal(event.params.amountIn, 18);
      pool.totalShares = pool.totalShares.minus(scaledAmount);
      let vaultPoolShare = getPoolShare(poolId.toHexString(), VAULT_ADDRESS);
      let vaultPoolShareBalance = vaultPoolShare == null ? ZERO_BD : vaultPoolShare.balance;
      vaultPoolShareBalance = vaultPoolShareBalance.minus(scaledAmount);
      vaultPoolShare.balance = vaultPoolShareBalance;
      vaultPoolShare.save();
    }
    if (event.params.tokenOut == pool.address) {
      const scaledAmount = tokenToDecimal(event.params.amountOut, 18);
      pool.totalShares = pool.totalShares.plus(scaledAmount);
      let vaultPoolShare = getPoolShare(poolId.toHexString(), VAULT_ADDRESS);
      let vaultPoolShareBalance = vaultPoolShare == null ? ZERO_BD : vaultPoolShare.balance;
      vaultPoolShareBalance = vaultPoolShareBalance.plus(scaledAmount);
      vaultPoolShare.balance = vaultPoolShareBalance;
      vaultPoolShare.save();
    }
  }

  let poolAddress = pool.address;
  let tokenInAddress: Address = event.params.tokenIn;
  let tokenOutAddress: Address = event.params.tokenOut;

  let logIndex = event.logIndex;
  let transactionHash = event.transaction.hash;
  let blockTimestamp = event.block.timestamp.toI32();

  let poolTokenIn = loadPoolToken(poolId.toHexString(), tokenInAddress);
  let poolTokenOut = loadPoolToken(poolId.toHexString(), tokenOutAddress);
  if (poolTokenIn == null || poolTokenOut == null) {
    log.warning('PoolToken not found in handleSwapEvent: (tokenIn: {}), (tokenOut: {})', [
      tokenInAddress.toHexString(),
      tokenOutAddress.toHexString(),
    ]);
    return;
  }

  let tokenAmountIn: BigDecimal = scaleDown(event.params.amountIn, poolTokenIn.decimals);
  let tokenAmountOut: BigDecimal = scaleDown(event.params.amountOut, poolTokenOut.decimals);

  let swapValueUSD = ZERO_BD;
  let swapFeesUSD = ZERO_BD;

  // Swap events are emitted when joining/exitting from pools with preminted BPT.
  // Since we want this type of swap to register tokens prices but not counting as volume
  // we defined two variables: 1. valueUSD - the value in USD of the transaction;
  // 2. swapValueUSD - equal to valueUSD if trade, zero otherwise, and used to update metrics.
  const valueUSD = swapValueInUSD(tokenInAddress, tokenAmountIn, tokenOutAddress, tokenAmountOut);

  if (poolAddress != tokenInAddress && poolAddress != tokenOutAddress) {
    swapValueUSD = valueUSD;
    if (!isLinearPool(pool) && !isFXPool(pool)) {
      let swapFee = pool.swapFee;
      swapFeesUSD = swapValueUSD.times(swapFee);
    } else if (isFXPool(pool)) {
      // Custom logic for calculating trading fee for FXPools
      let isTokenInBase = tokenOutAddress == USDC_ADDRESS;
      let baseToken = Token.load((isTokenInBase ? tokenInAddress : tokenOutAddress).toHexString());
      let quoteToken = Token.load((isTokenInBase ? tokenOutAddress : tokenInAddress).toHexString());
      let baseRate = baseToken != null ? baseToken.latestFXPrice : null;
      let quoteRate = quoteToken != null ? quoteToken.latestFXPrice : null;

      if (baseRate && quoteRate) {
        if (isTokenInBase) {
          swapFeesUSD = tokenAmountIn.times(baseRate).minus(tokenAmountOut.times(quoteRate));
        } else {
          swapFeesUSD = tokenAmountIn.times(quoteRate).minus(tokenAmountOut.times(baseRate));
        }
      }
    }
  }

  let newInAmount = poolTokenIn.balance.plus(tokenAmountIn);
  poolTokenIn.balance = newInAmount;
  poolTokenIn.volume = poolTokenIn.volume.plus(tokenAmountIn);
  poolTokenIn.swapFees = poolTokenIn.swapFees.plus(tokenAmountIn.times(pool.swapFee));
  poolTokenIn.save();

  let newOutAmount = poolTokenOut.balance.minus(tokenAmountOut);
  poolTokenOut.balance = newOutAmount;
  poolTokenOut.volume = poolTokenOut.volume.plus(tokenAmountOut);
  poolTokenOut.swapFees = poolTokenOut.swapFees.plus(tokenAmountOut.times(pool.swapFee));
  poolTokenOut.save();

  let swapId = transactionHash.toHexString().concat(logIndex.toString());

  const isJoinExitSwap = poolAddress == tokenInAddress || poolAddress == tokenOutAddress;
  if (isJoinExitSwap) {
    if (isComposableStablePool(pool)) {
      let tokenAddresses = pool.tokensList;
      let balances: BigInt[] = [];
      for (let i: i32 = 0; i < tokenAddresses.length; i++) {
        let tokenAddress: Address = Address.fromString(tokenAddresses[i].toHexString());
        if (tokenAddresses[i] == pool.address) {
          continue;
        }
        let poolToken = loadPoolToken(pool.id, tokenAddress);
        if (poolToken == null) {
          throw new Error('poolToken not found');
        }
        let balance = scaleUp(poolToken.balance.times(poolToken.priceRate), 18);
        balances.push(balance);
      }
      if (pool.amp) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        let amp = pool.amp!.times(AMP_PRECISION);
        let invariantInt = calculateInvariant(amp, balances, swapId);
        let invariant = scaleDown(invariantInt, 18);
        pool.lastPostJoinExitInvariant = invariant;
        pool.lastJoinExitAmp = pool.amp;
      }
    }
  }

  let swap = new Swap(swapId);
  swap.tokenIn = tokenInAddress;
  swap.tokenInSym = poolTokenIn.symbol;
  swap.tokenAmountIn = tokenAmountIn;

  swap.tokenOut = tokenOutAddress;
  swap.tokenOutSym = poolTokenOut.symbol;
  swap.tokenAmountOut = tokenAmountOut;

  swap.valueUSD = valueUSD;

  swap.caller = event.transaction.from;
  swap.userAddress = event.transaction.from.toHex();
  swap.poolId = poolId.toHex();

  swap.timestamp = blockTimestamp;
  swap.tx = transactionHash;
  swap.block = event.block.number;
  swap.save();

  // update pool swapsCount
  // let pool = Pool.load(poolId.toHex());
  pool.swapsCount = pool.swapsCount.plus(BigInt.fromI32(1));
  pool.totalSwapVolume = pool.totalSwapVolume.plus(swapValueUSD);
  pool.totalSwapFee = pool.totalSwapFee.plus(swapFeesUSD);

  pool.save();

  // update vault total swap volume
  let vault = Balancer.load('2') as Balancer;
  vault.totalSwapVolume = vault.totalSwapVolume.plus(swapValueUSD);
  vault.totalSwapFee = vault.totalSwapFee.plus(swapFeesUSD);
  vault.totalSwapCount = vault.totalSwapCount.plus(BigInt.fromI32(1));
  vault.save();

  let vaultSnapshot = getBalancerSnapshot(vault.id, blockTimestamp);
  vaultSnapshot.totalSwapVolume = vault.totalSwapVolume;
  vaultSnapshot.totalSwapFee = vault.totalSwapFee;
  vaultSnapshot.totalSwapCount = vault.totalSwapCount;
  vaultSnapshot.save();

  // update swap counts for token
  // updates token snapshots as well
  uptickSwapsForToken(tokenInAddress, event);
  uptickSwapsForToken(tokenOutAddress, event);

  // update volume and balances for the tokens
  // updates token snapshots as well
  updateTokenBalances(tokenInAddress, swapValueUSD, tokenAmountIn, SWAP_IN, event);
  updateTokenBalances(tokenOutAddress, swapValueUSD, tokenAmountOut, SWAP_OUT, event);

  let tradePair = getTradePair(tokenInAddress, tokenOutAddress);
  tradePair.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePair.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePair.save();

  let tradePairSnapshot = getTradePairSnapshot(tradePair.id, blockTimestamp);
  tradePairSnapshot.totalSwapVolume = tradePair.totalSwapVolume.plus(swapValueUSD);
  tradePairSnapshot.totalSwapFee = tradePair.totalSwapFee.plus(swapFeesUSD);
  tradePairSnapshot.save();

  if (swap.tokenAmountOut == ZERO_BD || swap.tokenAmountIn == ZERO_BD) {
    return;
  }

  // Capture price
  // TODO: refactor these if statements using a helper function
  let blockNumber = event.block.number;
  let tokenInWeight = poolTokenIn.weight;
  let tokenOutWeight = poolTokenOut.weight;
  if (
    !isJoinExitSwap &&
    isPricingAsset(tokenInAddress) &&
    pool.totalLiquidity.gt(MIN_POOL_LIQUIDITY) &&
    valueUSD.gt(MIN_SWAP_VALUE_USD)
  ) {
    let tokenPriceId = getTokenPriceId(poolId.toHex(), tokenOutAddress, tokenInAddress, blockNumber);
    let tokenPrice = new TokenPrice(tokenPriceId);
    //tokenPrice.poolTokenId = getPoolTokenId(poolId, tokenOutAddress);
    tokenPrice.poolId = poolId.toHexString();
    tokenPrice.block = blockNumber;
    tokenPrice.timestamp = blockTimestamp;
    tokenPrice.asset = tokenOutAddress;
    tokenPrice.amount = tokenAmountIn;
    tokenPrice.pricingAsset = tokenInAddress;

    if (tokenInWeight && tokenOutWeight) {
      // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
      // based on the pool's weights and updated balances after the swap.
      tokenPrice.price = newInAmount.div(tokenInWeight).div(newOutAmount.div(tokenOutWeight));
    } else {
      // Otherwise we can get a simple measure of the price from the ratio of amount in vs amount out
      tokenPrice.price = tokenAmountIn.div(tokenAmountOut);
    }

    tokenPrice.save();

    updateLatestPrice(tokenPrice, event.block.timestamp);
  }
  if (
    !isJoinExitSwap &&
    isPricingAsset(tokenOutAddress) &&
    pool.totalLiquidity.gt(MIN_POOL_LIQUIDITY) &&
    valueUSD.gt(MIN_SWAP_VALUE_USD)
  ) {
    let tokenPriceId = getTokenPriceId(poolId.toHex(), tokenInAddress, tokenOutAddress, blockNumber);
    let tokenPrice = new TokenPrice(tokenPriceId);
    //tokenPrice.poolTokenId = getPoolTokenId(poolId, tokenInAddress);
    tokenPrice.poolId = poolId.toHexString();
    tokenPrice.block = blockNumber;
    tokenPrice.timestamp = blockTimestamp;
    tokenPrice.asset = tokenInAddress;
    tokenPrice.amount = tokenAmountOut;
    tokenPrice.pricingAsset = tokenOutAddress;

    if (tokenInWeight && tokenOutWeight) {
      // As the swap is with a WeightedPool, we can easily calculate the spot price between the two tokens
      // based on the pool's weights and updated balances after the swap.
      tokenPrice.price = newOutAmount.div(tokenOutWeight).div(newInAmount.div(tokenInWeight));
    } else {
      // Otherwise we can get a simple measure of the price from the ratio of amount out vs amount in
      tokenPrice.price = tokenAmountOut.div(tokenAmountIn);
    }

    tokenPrice.save();

    updateLatestPrice(tokenPrice, event.block.timestamp);
  }

  const preferentialToken = getPreferentialPricingAsset([tokenInAddress, tokenOutAddress]);
  if (preferentialToken != ZERO_ADDRESS) {
    addHistoricalPoolLiquidityRecord(poolId.toHex(), blockNumber, preferentialToken);
  }

  updatePoolLiquidity(poolId.toHex(), blockNumber, event.block.timestamp);
}
