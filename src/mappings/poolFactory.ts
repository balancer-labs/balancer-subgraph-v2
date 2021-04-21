import { ZERO_BD, VAULT_ADDRESS } from './constants';
import { newPoolEntity, createPoolTokenEntity, getPoolTokenId, scaleDown } from './helpers';

import { BigInt, Address, Bytes } from '@graphprotocol/graph-ts';
import { PoolCreated } from '../types/WeightedPoolFactory/WeightedPoolFactory';
import { Balancer, Pool, PoolToken } from '../types/schema';

// datasource
import { WeightedPool as WeightedPoolTemplate } from '../types/templates';
import { StablePool as StablePoolTemplate } from '../types/templates';

import { Vault } from '../types/Vault/Vault';
import { WeightedPool } from '../types/templates/WeightedPool/WeightedPool';
import { StablePool } from '../types/templates/StablePool/StablePool';

export function handleNewWeightedPool(event: PoolCreated): void {
  let poolAddress: Address = event.params.pool;
  let poolContract = WeightedPool.bind(poolAddress);

  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value;

  let swapFeeCall = poolContract.try_getSwapFeePercentage();
  let swapFee = swapFeeCall.value;

  let pool = handleNewPool(event, poolId, swapFee) as Pool;
  pool.poolType = 'Weighted';

  let vaultContract = Vault.bind(VAULT_ADDRESS);
  let tokensCall = vaultContract.try_getPoolTokens(poolId);
  let weightsCall = poolContract.try_getNormalizedWeights();

  if (!tokensCall.reverted && !weightsCall.reverted) {
    let tokens = tokensCall.value.value0;
    let weights = weightsCall.value;
    let tokensList = pool.tokensList;
    let totalWeight = ZERO_BD;

    for (let i: i32 = 0; i < tokens.length; i++) {
      let tokenAddress = tokens[i];
      let weight = weights[i];

      let poolTokenId = getPoolTokenId(poolId.toHexString(), tokenAddress);

      if (tokensList.indexOf(tokenAddress) == -1) {
        tokensList.push(tokenAddress);
      }
      createPoolTokenEntity(poolId.toHexString(), tokenAddress);
      let poolToken = PoolToken.load(poolTokenId);
      poolToken.weight = scaleDown(weight, 18);
      poolToken.save();

      totalWeight = totalWeight.plus(scaleDown(weight, 18));
    }

    pool.tokensList = tokensList;
    pool.totalWeight = totalWeight;
    pool.save();
  }

  WeightedPoolTemplate.create(poolAddress);
}

export function handleNewStablePool(event: PoolCreated): void {
  let poolAddress: Address = event.params.pool;
  let poolContract = StablePool.bind(poolAddress);

  let poolIdCall = poolContract.try_getPoolId();
  let poolId = poolIdCall.value;

  let swapFeeCall = poolContract.try_getSwapFeePercentage();
  let swapFee = swapFeeCall.value;

  let pool = handleNewPool(event, poolId, swapFee);
  pool.poolType = 'Stable';

  StablePoolTemplate.create(poolAddress);

  let ampCall = poolContract.try_getAmplificationParameter();
  let amp = ampCall.value;
  pool.amp = amp;
  pool.save();
}

function findOrInitializeVault(): Balancer {
  let vault: Balancer | null = Balancer.load('2');
  if (vault !== null) return vault as Balancer;

  // if no vault yet, set up blank initial
  vault = new Balancer('2');
  vault.poolCount = 0;
  vault.totalLiquidity = ZERO_BD;
  vault.totalSwapVolume = ZERO_BD;
  vault.totalSwapFee = ZERO_BD;
  return vault as Balancer;
}

function handleNewPool(event: PoolCreated, poolId: Bytes, swapFee: BigInt): Pool | null {
  let vault = findOrInitializeVault();

  let poolAddress: Address = event.params.pool;

  let pool = Pool.load(poolId.toHexString());
  if (pool == null) {
    pool = newPoolEntity(poolId.toHexString());

    pool.swapFee = scaleDown(swapFee, 18);
    pool.createTime = event.block.timestamp.toI32();
    pool.address = poolAddress;
    pool.tx = event.transaction.hash;
  }

  vault.poolCount = vault.poolCount + 1;
  vault.save();

  pool.save();
  return pool;
}
