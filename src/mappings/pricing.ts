import { Address, Bytes, BigInt, BigDecimal, log, dataSource } from '@graphprotocol/graph-ts';
import { Pool, TokenPrice, Balancer, PoolHistoricalLiquidity, LatestPrice, Token, FXOracle } from '../types/schema';
import {
  ZERO_BD,
  PRICING_ASSETS,
  USD_STABLE_ASSETS,
  ONE_BD,
  ZERO_ADDRESS,
  MIN_POOL_LIQUIDITY,
} from './helpers/constants';
import { hasVirtualSupply, isComposableStablePool, isLinearPool, isFXPool, PoolType } from './helpers/pools';
import {
  bytesToAddress,
  createPoolSnapshot,
  createPoolSnapshotHourly,
  getBalancerSnapshot,
  getToken,
  getTokenPriceId,
  loadPoolToken,
  scaleDown,
} from './helpers/misc';
import { AaveLinearPool } from '../types/AaveLinearPoolFactory/AaveLinearPool';
import {
  FX_ASSET_AGGREGATORS,
  MAX_POS_PRICE_CHANGE,
  MAX_NEG_PRICE_CHANGE,
  MAX_TIME_DIFF_FOR_PRICING,
} from './helpers/constants';
import { AnswerUpdated } from '../types/templates/OffchainAggregator/AccessControlledOffchainAggregator';
export function isPricingAsset(asset: Address): boolean {
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (PRICING_ASSETS[i] == asset) return true;
  }
  return false;
}

export function getPreferentialPricingAsset(assets: Address[]): Address {
  // Assumes PRICING_ASSETS are sorted by order of preference
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (assets.includes(PRICING_ASSETS[i])) return PRICING_ASSETS[i];
  }
  return ZERO_ADDRESS;
}

export function addHistoricalPoolLiquidityRecord(poolId: string, block: BigInt, pricingAsset: Address): boolean {
  let pool = Pool.load(poolId);
  if (pool == null) return false;

  let tokensList: Bytes[] = pool.tokensList;
  if (tokensList.length < 2) return false;
  if (hasVirtualSupply(pool) && pool.address == pricingAsset) return false;

  let poolValue: BigDecimal = ZERO_BD;

  for (let j: i32 = 0; j < tokensList.length; j++) {
    let tokenAddress: Address = Address.fromString(tokensList[j].toHexString());

    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) continue;

    if (tokenAddress == pricingAsset) {
      poolValue = poolValue.plus(poolToken.balance);
      continue;
    }
    let poolTokenQuantity: BigDecimal = poolToken.balance;

    let price: BigDecimal = ZERO_BD;
    let latestPriceId = getLatestPriceId(tokenAddress, pricingAsset);
    let latestPrice = LatestPrice.load(latestPriceId);

    // note that we can only meaningfully report liquidity once assets are traded with
    // the pricing asset
    if (latestPrice) {
      // value in terms of priceableAsset
      price = latestPrice.price;
    } else if (pool.poolType == PoolType.StablePhantom || isComposableStablePool(pool)) {
      // try to estimate token price in terms of pricing asset
      let pricingAssetInUSD = valueInUSD(ONE_BD, pricingAsset);
      let currentTokenInUSD = valueInUSD(ONE_BD, tokenAddress);

      if (pricingAssetInUSD.equals(ZERO_BD) || currentTokenInUSD.equals(ZERO_BD)) {
        continue;
      }

      price = currentTokenInUSD.div(pricingAssetInUSD);
    }

    // Exclude virtual supply from pool value
    if (hasVirtualSupply(pool) && pool.address == tokenAddress) {
      continue;
    }

    if (price.gt(ZERO_BD)) {
      let poolTokenValue = price.times(poolTokenQuantity);
      poolValue = poolValue.plus(poolTokenValue);
    }
  }

  const newPoolLiquidity: BigDecimal = valueInUSD(poolValue, pricingAsset) || ZERO_BD;

  // If the pool isn't empty but we have a zero USD value then it's likely that we have a bad pricing asset
  // Don't commit any changes and just report the failure.
  if (poolValue.gt(ZERO_BD) != newPoolLiquidity.gt(ZERO_BD)) {
    return false;
  }

  // Take snapshot of pool state
  let phlId = getPoolHistoricalLiquidityId(poolId, pricingAsset, block);
  let phl = new PoolHistoricalLiquidity(phlId);
  phl.poolId = poolId;
  phl.pricingAsset = pricingAsset;
  phl.block = block;
  phl.poolTotalShares = pool.totalShares;
  phl.poolLiquidity = poolValue;
  phl.poolShareValue = pool.totalShares.gt(ZERO_BD) ? poolValue.div(pool.totalShares) : ZERO_BD;
  phl.save();

  return true;
}

export function updatePoolLiquidity(poolId: string, block_number: BigInt, timestamp: BigInt): boolean {
  let pool = Pool.load(poolId);
  if (pool == null) return false;
  let tokensList: Bytes[] = pool.tokensList;
  let newPoolLiquidity: BigDecimal = ZERO_BD;
  let newPoolLiquiditySansBPT: BigDecimal = ZERO_BD;

  for (let j: i32 = 0; j < tokensList.length; j++) {
    let tokenAddress: Address = Address.fromString(tokensList[j].toHexString());
    // Exclude virtual supply from pool value
    if (hasVirtualSupply(pool) && pool.address == tokenAddress) {
      continue;
    }

    let poolToken = loadPoolToken(poolId, tokenAddress);
    if (poolToken == null) continue;

    let poolTokenQuantity: BigDecimal = poolToken.balance;
    let poolTokenValue: BigDecimal = ZERO_BD;
    if (!isFXPool(pool)) {
      poolTokenValue = valueInUSD(poolTokenQuantity, tokenAddress);
    } else {
      // Custom computation for FXPool tokens
      poolTokenValue = valueInFX(poolTokenQuantity, tokenAddress);
    }

    newPoolLiquidity = newPoolLiquidity.plus(poolTokenValue);

    let token = getToken(tokenAddress);
    if (token.pool == null) {
      newPoolLiquiditySansBPT = newPoolLiquiditySansBPT.plus(poolTokenValue);
    }
  }

  // Update pool stats
  let liquidityChange = ZERO_BD;
  let oldPoolLiquidity = pool.totalLiquidity;
  let oldPoolLiquiditySansBPT = pool.totalLiquiditySansBPT;

  if (dataSource.network() == 'arbitrum' || dataSource.network() == 'matic') {
    // keep old logic on arbitrum and polygon to avoid breaking liquidity charts
    liquidityChange = newPoolLiquidity.minus(oldPoolLiquidity);
  } else if (oldPoolLiquiditySansBPT) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    liquidityChange = newPoolLiquiditySansBPT.minus(oldPoolLiquiditySansBPT!);
  }

  pool.totalLiquiditySansBPT = newPoolLiquiditySansBPT;
  pool.totalLiquidity = newPoolLiquidity;
  pool.save();

  // We want to avoid too frequently calling setWrappedTokenPrice because it makes a call to the rate provider
  // Doing it here allows us to do it only once, when the MIN_POOL_LIQUIDITY threshold is crossed
  if (oldPoolLiquidity < MIN_POOL_LIQUIDITY) {
    setWrappedTokenPrice(pool, poolId, block_number, timestamp);
  }

  // update BPT price
  if (newPoolLiquidity.gt(MIN_POOL_LIQUIDITY)) {
    updateBptPrice(pool);
  }

  // Create or update pool snapshots
  createPoolSnapshot(pool, timestamp.toI32());
  createPoolSnapshotHourly(pool, timestamp.toI32());

  // Update global stats
  let vault = Balancer.load('2') as Balancer;
  vault.totalLiquidity = vault.totalLiquidity.plus(liquidityChange);
  vault.save();

  let vaultSnapshot = getBalancerSnapshot(vault.id, timestamp.toI32());
  vaultSnapshot.totalLiquidity = vault.totalLiquidity;
  vaultSnapshot.save();

  return true;
}

export function valueInUSD(value: BigDecimal, asset: Address): BigDecimal {
  let usdValue = ZERO_BD;

  if (isUSDStable(asset)) {
    usdValue = value;
  } else {
    // convert to USD
    let token = getToken(asset);

    if (token.latestUSDPrice) {
      const latestUSDPrice = token.latestUSDPrice as BigDecimal;
      usdValue = value.times(latestUSDPrice);
    }
  }

  return usdValue;
}

export function valueInFX(value: BigDecimal, asset: Address): BigDecimal {
  let token = getToken(asset);

  if (token.latestFXPrice) {
    // convert to USD using latestFXPrice
    const latestFXPrice = token.latestFXPrice as BigDecimal;
    return value.times(latestFXPrice);
  } else {
    // fallback if latestFXPrice is not available
    return valueInUSD(value, asset);
  }
}

export function updateBptPrice(pool: Pool): void {
  if (pool.totalShares.equals(ZERO_BD)) return;

  const bptAddress = Address.fromString(pool.address.toHexString());
  let bptToken = getToken(bptAddress);
  bptToken.latestUSDPrice = pool.totalLiquidity.div(pool.totalShares);
  bptToken.save();
}

export function swapValueInUSD(
  tokenInAddress: Address,
  tokenAmountIn: BigDecimal,
  tokenOutAddress: Address,
  tokenAmountOut: BigDecimal
): BigDecimal {
  let swapValueUSD = ZERO_BD;

  if (isUSDStable(tokenOutAddress)) {
    // if one of the tokens is a stable, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
    return swapValueUSD;
  } else if (isUSDStable(tokenInAddress)) {
    // if one of the tokens is a stable, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
    return swapValueUSD;
  }

  if (isPricingAsset(tokenInAddress) && !isPricingAsset(tokenOutAddress)) {
    // if only one of the tokens is a pricing asset, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
    if (swapValueUSD.gt(ZERO_BD)) return swapValueUSD;
  }

  if (isPricingAsset(tokenOutAddress) && !isPricingAsset(tokenInAddress)) {
    // if only one of the tokens is a pricing asset, it takes precedence
    swapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
    if (swapValueUSD.gt(ZERO_BD)) return swapValueUSD;
  }

  // if none or both tokens are pricing assets, take the average of the known prices
  let tokenInSwapValueUSD = valueInUSD(tokenAmountIn, tokenInAddress);
  let tokenOutSwapValueUSD = valueInUSD(tokenAmountOut, tokenOutAddress);
  let divisor =
    tokenInSwapValueUSD.gt(ZERO_BD) && tokenOutSwapValueUSD.gt(ZERO_BD) ? BigDecimal.fromString('2') : ONE_BD;
  swapValueUSD = tokenInSwapValueUSD.plus(tokenOutSwapValueUSD).div(divisor);

  return swapValueUSD;
}

export function getLatestPriceId(tokenAddress: Address, pricingAsset: Address): string {
  return tokenAddress.toHexString().concat('-').concat(pricingAsset.toHexString());
}

export function updateLatestPrice(tokenPrice: TokenPrice, blockTimestamp: BigInt): void {
  let tokenAddress = Address.fromString(tokenPrice.asset.toHexString());
  let pricingAsset = Address.fromString(tokenPrice.pricingAsset.toHexString());

  let latestPriceId = getLatestPriceId(tokenAddress, pricingAsset);
  let latestPrice = LatestPrice.load(latestPriceId);

  if (latestPrice == null) {
    latestPrice = new LatestPrice(latestPriceId);
    latestPrice.asset = tokenPrice.asset;
    latestPrice.pricingAsset = tokenPrice.pricingAsset;
  }

  latestPrice.block = tokenPrice.block;
  latestPrice.poolId = tokenPrice.poolId;
  latestPrice.price = tokenPrice.price;
  latestPrice.save();

  let token = getToken(tokenAddress);
  const pricingAssetAddress = Address.fromString(tokenPrice.pricingAsset.toHexString());
  const currentUSDPrice = valueInUSD(tokenPrice.price, pricingAssetAddress);

  if (currentUSDPrice == ZERO_BD) return;

  let oldUSDPrice = token.latestUSDPrice;
  if (!oldUSDPrice || oldUSDPrice.equals(ZERO_BD)) {
    token.latestUSDPriceTimestamp = blockTimestamp;
    token.latestUSDPrice = currentUSDPrice;
    token.latestPrice = latestPrice.id;
    token.save();
    return;
  }

  let change = currentUSDPrice.minus(oldUSDPrice).div(oldUSDPrice);
  if (
    !token.latestUSDPriceTimestamp ||
    (change.lt(MAX_POS_PRICE_CHANGE) && change.gt(MAX_NEG_PRICE_CHANGE)) ||
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    blockTimestamp.minus(token.latestUSDPriceTimestamp!).gt(MAX_TIME_DIFF_FOR_PRICING)
  ) {
    token.latestUSDPriceTimestamp = blockTimestamp;
    token.latestUSDPrice = currentUSDPrice;
    token.latestPrice = latestPrice.id;
    token.save();
  }
}

function getPoolHistoricalLiquidityId(poolId: string, tokenAddress: Address, block: BigInt): string {
  return poolId.concat('-').concat(tokenAddress.toHexString()).concat('-').concat(block.toString());
}

export function isUSDStable(asset: Address): boolean {
  for (let i: i32 = 0; i < USD_STABLE_ASSETS.length; i++) {
    if (USD_STABLE_ASSETS[i] == asset) return true;
  }
  return false;
}

// The wrapped token in a linear pool is hardly ever traded, meaning we rarely compute its USD price
// This creates an exceptional entry for the token price of the wrapped token,
// with the main token as the pricing asset even if it's not globally defined as one
export function setWrappedTokenPrice(pool: Pool, poolId: string, block_number: BigInt, timestamp: BigInt): void {
  if (isLinearPool(pool)) {
    if (pool.totalLiquidity.gt(MIN_POOL_LIQUIDITY)) {
      const poolAddress = bytesToAddress(pool.address);
      let poolContract = AaveLinearPool.bind(poolAddress);
      let rateCall = poolContract.try_getWrappedTokenRate();
      if (rateCall.reverted) {
        log.info('getWrappedTokenRate reverted', []);
      } else {
        const rate = rateCall.value;
        const amount = BigDecimal.fromString('1');
        const asset = bytesToAddress(pool.tokensList[pool.wrappedIndex]);
        const pricingAsset = bytesToAddress(pool.tokensList[pool.mainIndex]);
        const price = scaleDown(rate, 18);
        let tokenPriceId = getTokenPriceId(poolId, asset, pricingAsset, block_number);
        let tokenPrice = new TokenPrice(tokenPriceId);
        tokenPrice.poolId = poolId;
        tokenPrice.block = block_number;
        tokenPrice.timestamp = timestamp.toI32();
        tokenPrice.asset = asset;
        tokenPrice.pricingAsset = pricingAsset;
        tokenPrice.amount = amount;
        tokenPrice.price = price;
        tokenPrice.save();
        updateLatestPrice(tokenPrice, timestamp);
      }
    }
  }
}

export function handleAnswerUpdated(event: AnswerUpdated): void {
  const aggregatorAddress = event.address;
  const answer = event.params.current;
  const tokenAddressesToUpdate: Address[] = [];

  // Check if the aggregator is under FX_ASSET_AGGREGATORS first (FXPoolFactory version)
  for (let i = 0; i < FX_ASSET_AGGREGATORS.length; i++) {
    if (aggregatorAddress == FX_ASSET_AGGREGATORS[i][1]) {
      tokenAddressesToUpdate.push(FX_ASSET_AGGREGATORS[i][0]);
    }
  }

  // Also check if aggregator exists from FXOracle entity (FXPoolDeployer version)
  let oracle = FXOracle.load(aggregatorAddress.toHexString());
  if (oracle) {
    for (let i = 0; i < oracle.tokens.length; i++) {
      const tokenAddress = Address.fromBytes(oracle.tokens[i]);
      const tokenExists = tokenAddressesToUpdate.includes(tokenAddress);
      if (!tokenExists) {
        tokenAddressesToUpdate.push(tokenAddress);
      }
    }
  } else {
    log.warning('Oracle not found: {}', [aggregatorAddress.toHexString()]);
  }

  // Update all tokens using this aggregator
  for (let i = 0; i < tokenAddressesToUpdate.length; i++) {
    const tokenAddress = tokenAddressesToUpdate[i];

    const token = Token.load(tokenAddress.toHexString());
    if (token == null) {
      log.warning('Token with address {} not found', [tokenAddress.toHexString()]);
      continue;
    }

    // All tokens we track have oracles with 8 decimals
    if (!token.fxOracleDecimals) {
      token.fxOracleDecimals = 8; // @todo: get decimals on-chain
    }

    if (tokenAddress == Address.fromString('0xc8bb8eda94931ca2f20ef43ea7dbd58e68400400')) {
      // XAU-USD oracle returns an answer with price unit of "USD per troy ounce"
      // For VNXAU however, we wanna use a price unit of "USD per gram"
      const divisor = '3110347680'; // 31.1034768 * 1e8 (31.10 gram per troy ounce)
      const multiplier = '100000000'; // 1 * 1e8
      const pricePerGram = answer.times(BigInt.fromString(multiplier)).div(BigInt.fromString(divisor));
      token.latestFXPrice = scaleDown(pricePerGram, 8);
    } else if (oracle && oracle.divisor !== null && oracle.decimals) {
      const updatedAnswer = answer
        .times(BigInt.fromString('10').pow(oracle.decimals as u8))
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        .div(BigInt.fromString(oracle.divisor!));
      token.latestFXPrice = scaleDown(updatedAnswer, 8);
    } else {
      token.latestFXPrice = scaleDown(answer, 8);
    }

    token.save();
  }
}
