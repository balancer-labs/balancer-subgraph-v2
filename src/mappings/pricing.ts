import { PRICING_ASSETS, USD_STABLE_ASSETS, USDC, DAI} from './constants';
import { getTokenPriceId, getPoolTokenId, scaleDown } from './helpers';
import { Address, Bytes, BigInt, BigDecimal } from '@graphprotocol/graph-ts';
import { Pool, PoolToken, TokenPrice, Balancer, PoolHistoricalLiquidity, LatestPrice } from '../types/schema';

export function isPricingAsset(asset: Address): boolean {
  //for (let pa of PRICING_ASSETS) {
  for (let i: i32 = 0; i < PRICING_ASSETS.length; i++) {
    if (PRICING_ASSETS[i] == asset) return true;
  }
  return false;
}

export function isUSDStable(asset: Address): boolean {
  //for (let pa of PRICING_ASSETS) {
  for (let i: i32 = 0; i < USD_STABLE_ASSETS.length; i++) {
    if (USD_STABLE_ASSETS[i] == asset) return true;
  }
  return false;
}

export function updatePoolLiquidity(poolId: string, block: BigInt, pricingAsset: Address): void {
  let pool = Pool.load(poolId);
  if (pool == null) return;
  if (pool.tokensCount.lt(BigInt.fromI32(2))) return;

  let tokensList: Bytes[] = pool.tokensList;
  if (tokensList.length == 0) return;

  let phlId = getPoolHistoricalLiquidityId(poolId, pricingAsset, block);
  let phl = new PoolHistoricalLiquidity(phlId)
  phl.poolId = poolId;
  phl.pricingAsset = pricingAsset;
  phl.block = block;

  let poolValue: BigDecimal = BigDecimal.fromString('0');

  for (let j: i32 = 0; j < tokensList.length; j++) {
    let tokenAddress: Address = Address.fromString(tokensList[j].toHexString());

    let poolTokenId: string = getPoolTokenId(poolId, tokenAddress)
    let poolToken = PoolToken.load(poolTokenId)

    if (tokenAddress == pricingAsset) {
      poolValue = poolValue.plus(poolToken.balance)
      continue;
    }
    let poolTokenQuantity: BigDecimal = poolToken.balance;

    // compare any new token price with the last price
    let tokenPriceId = getTokenPriceId(poolId, tokenAddress, pricingAsset, block);
    let tokenPrice = TokenPrice.load(tokenPriceId)
    let price: BigDecimal | null;
    let latestPriceId = getLatestPriceId(tokenAddress, pricingAsset);
    let latestPrice = LatestPrice.load(latestPriceId)

    if (tokenPrice == null && latestPrice != null) {
      price = latestPrice.price;
    }
    // note that we can only meaningfully report liquidity once assets are traded with
    // the pricing asset
    if (tokenPrice) {
      //value in terms of priceableAsset
      price = tokenPrice.price;

      // Possibly update latest price
      if (latestPrice == null) {
        latestPrice = new LatestPrice(latestPriceId)
        latestPrice.asset = tokenAddress
        latestPrice.pricingAsset = pricingAsset;
      }
      latestPrice.price = price!;
      latestPrice.block = block;
      latestPrice.poolId = poolId;
      latestPrice.save();
    }
    if (price) {
      let poolTokenValue = price.times(poolTokenQuantity);
      poolValue = poolValue.plus(poolTokenValue)
    }
  }
  phl.poolLiquidity = poolValue;
  phl.save()

  let oldPoolLiquidity: BigDecimal = pool.liquidity
  let newPoolLiquidity: BigDecimal = poolLiquidityInUSD(poolValue, pricingAsset);

  if (newPoolLiquidity && oldPoolLiquidity) {
    let vault = Balancer.load('2');
    let liquidityChange: BigDecimal = newPoolLiquidity.minus(oldPoolLiquidity)
    vault.totalLiquidity = vault.totalLiquidity.plus(liquidityChange);
    vault.save();
    pool.liquidity = newPoolLiquidity;
    pool.save();
  }
}

function poolLiquidityInUSD(poolValue: BigDecimal, pricingAsset: Address): BigDecimal {
  let newPoolLiquidity: BigDecimal;

  if (isUSDStable(pricingAsset)) {
    newPoolLiquidity = poolValue;
  } else {
    // convert to USD
    let pricingAssetInUSDId: string = getLatestPriceId(pricingAsset, USDC);
    let pricingAssetInUSD = LatestPrice.load(pricingAssetInUSDId)

    if (!pricingAssetInUSD) {
      pricingAssetInUSDId = getLatestPriceId(pricingAsset, DAI);
      pricingAssetInUSD = LatestPrice.load(pricingAssetInUSDId)
    }

    if (pricingAssetInUSD) {
      newPoolLiquidity = poolValue.times(pricingAssetInUSD.price)
    }
  }

  return newPoolLiquidity || BigDecimal.fromString('0')
}

export function getLatestPriceId(tokenAddress: Address, pricingAsset: Address): string {
  return tokenAddress.toHexString().concat('-').concat(pricingAsset.toHexString());
}

export function getLatestPrice(tokenAddress: Address, pricingAsset: Address): BigDecimal | null {
  let id = getLatestPriceId(tokenAddress, pricingAsset)
  let lprice = LatestPrice.load(id)
  return lprice.price
}

export function getPoolHistoricalLiquidityId(poolId: string, tokenAddress: Address, block: BigInt): string {
  return poolId.concat('-').concat(tokenAddress.toHexString()).concat('-').concat(block.toString());
}


