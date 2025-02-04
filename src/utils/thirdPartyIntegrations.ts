import {
  ALETH_POOL_NAME,
  BTC_POOL_NAME,
  ChainId,
  D4_POOL_NAME,
  PoolName,
  TBTC_METAPOOL_NAME,
  VETH2_POOL_NAME,
} from "../constants"
import { AddressZero, Zero } from "@ethersproject/constants"
import { getMulticallProvider, shiftBNDecimals } from "../utils"

import ALCX_REWARDS_ABI from "../constants/abis/alchemixStakingPools.json"
import { AlchemixStakingPools } from "../../types/ethers-contracts/AlchemixStakingPools"
import { BigNumber } from "@ethersproject/bignumber"
import { Contract } from "ethcall"
import KEEP_REWARDS_ABI from "../constants/abis/keepRewards.json"
import { KeepRewards } from "../../types/ethers-contracts/KeepRewards"
import { MulticallContract } from "../types/ethcall"
import SGT_REWARDS_ABI from "../constants/abis/sharedStakeStakingRewards.json"
import { SharedStakeStakingRewards } from "../../types/ethers-contracts/SharedStakeStakingRewards"
import { TokenPricesUSD } from "../state/application"
import { Web3Provider } from "@ethersproject/providers"
import { parseUnits } from "@ethersproject/units"

export type Partners = "keep" | "sharedStake" | "alchemix" | "frax"

type ThirdPartyData = {
  aprs: Partial<
    Record<
      Partners,
      {
        symbol: string
        apr: BigNumber
      }
    >
  >
  amountsStaked: Partial<Record<Partners, BigNumber>>
}
export async function getThirdPartyDataForPool(
  library: Web3Provider,
  chainId: ChainId,
  accountId: string | undefined | null,
  poolName: PoolName,
  tokenPricesUSD: TokenPricesUSD,
  lpTokenPriceUSD: BigNumber,
): Promise<ThirdPartyData> {
  const result: ThirdPartyData = {
    aprs: {},
    amountsStaked: {},
  }
  if (poolName === ALETH_POOL_NAME) {
    const rewardSymbol = "ALCX"
    const [apr, userStakedAmount] = await getAlEthData(
      library,
      chainId,
      lpTokenPriceUSD,
      tokenPricesUSD?.[rewardSymbol],
      accountId,
    )
    result.aprs.alchemix = { apr, symbol: rewardSymbol }
    result.amountsStaked.alchemix = userStakedAmount
  } else if (poolName === VETH2_POOL_NAME) {
    const rewardSymbol = "SGT"
    const [apr, userStakedAmount] = await getSharedStakeData(
      library,
      chainId,
      lpTokenPriceUSD,
      tokenPricesUSD?.[rewardSymbol],
      accountId,
    )
    result.aprs.sharedStake = { apr, symbol: rewardSymbol }
    result.amountsStaked.sharedStake = userStakedAmount
  } else if (poolName === TBTC_METAPOOL_NAME) {
    const rewardSymbol = "KEEP"
    const [apr, userStakedAmount] = await getKeepData(
      library,
      chainId,
      lpTokenPriceUSD,
      TBTC_METAPOOL_NAME,
      tokenPricesUSD?.[rewardSymbol],
      accountId,
    )
    result.aprs.keep = { apr, symbol: rewardSymbol }
    result.amountsStaked.keep = userStakedAmount
  } else if (poolName === D4_POOL_NAME) {
    // this is a slight bastardization of how this is supposed to work
    // TODO: update once we have UI for multiple APYS
    const rewardSymbol = "ALCX/FXS/LQTY/TRIBE"
    const [apr, userStakedAmount] = await getFraxData(
      library,
      chainId,
      lpTokenPriceUSD,
    )
    result.aprs.frax = { apr, symbol: rewardSymbol }
    result.amountsStaked.frax = userStakedAmount
  }
  return result
}

type FraxCombinedData = {
  liq_staking: { "Saddle alUSD/FEI/FRAX/LUSD": { apy: number } }
}
async function getFraxData(
  library: Web3Provider,
  chainId: ChainId,
  lpTokenPrice: BigNumber,
): Promise<[BigNumber, BigNumber]> {
  if (library == null || lpTokenPrice.eq("0") || chainId !== ChainId.MAINNET)
    return [Zero, Zero]
  const fetchFraxData = (): Promise<FraxCombinedData> =>
    fetch("https://api.frax.finance/combineddata/")
      .then((r) => r.json())
      .then((data: FraxCombinedData) => data)
  const fraxData = await fetchFraxData()
  const resApy = fraxData?.["liq_staking"]["Saddle alUSD/FEI/FRAX/LUSD"]["apy"]
  const apy = resApy ? parseUnits(resApy.toFixed(4), 16) : Zero // comes back as 1e-2 so we do 18-2
  return [apy, Zero]
}

type KeepPoolName = typeof BTC_POOL_NAME | typeof TBTC_METAPOOL_NAME

// LPRewardsTBTCSaddle and LPRewardsTBTCv2Saddle have the same interface
// https://github.com/keep-network/keep-ecdsa/blob/main/solidity/contracts/LPRewards.sol#L267
// https://github.com/keep-network/tbtc-v2/blob/main/yearn/contracts/SaddleStrategy.sol#L42

async function getKeepData(
  library: Web3Provider,
  chainId: ChainId,
  lpTokenPrice: BigNumber,
  keepPoolName: KeepPoolName,
  keepPrice = 0,
  accountId?: string | null,
): Promise<[BigNumber, BigNumber]> {
  if (
    library == null ||
    lpTokenPrice.eq("0") ||
    keepPrice === 0 ||
    chainId !== ChainId.MAINNET
  )
    return [Zero, Zero]

  const rewardsContractAddress =
    keepPoolName == BTC_POOL_NAME
      ? "0x78aa83bd6c9de5de0a2231366900ab060a482edd" // v1 prod address
      : "0x6aD9E8e5236C0E2cF6D755Bb7BE4eABCbC03f76d" // v2 prod address

  const ethcallProvider = await getMulticallProvider(library, chainId)
  const rewardsContract = new Contract(
    rewardsContractAddress,
    KEEP_REWARDS_ABI,
  ) as MulticallContract<KeepRewards>
  const multicalls = [
    rewardsContract.rewardRate(), // 1e18
    rewardsContract.totalSupply(), // 1e18
    rewardsContract.balanceOf(accountId || AddressZero),
  ]
  const [rewardRate, totalStaked, userStakedAmount] = await ethcallProvider.all(
    multicalls,
    {},
  )
  const WEEKS_IN_YEAR = 52
  const WEEK_IN_SECONDS = 604800
  const rewardsPerWeek = rewardRate.mul(WEEK_IN_SECONDS) // 1e18
  const rewardsPerWeekUSD = rewardsPerWeek.mul(
    parseUnits(keepPrice.toFixed(2), 2),
  ) // 1e20
  const totalStakedUSD = lpTokenPrice.mul(totalStaked) // 1e36
  const apr = shiftBNDecimals(rewardsPerWeekUSD.mul(WEEKS_IN_YEAR), 34).div(
    totalStakedUSD,
  ) // 1e18
  return [apr, userStakedAmount]
}

async function getSharedStakeData(
  library: Web3Provider,
  chainId: ChainId,
  lpTokenPrice: BigNumber,
  sgtPrice = 0,
  accountId?: string | null,
): Promise<[BigNumber, BigNumber]> {
  // https://github.com/SharedStake/SharedStake-ui/blob/main/src/components/Earn/geyser.vue#L336
  if (
    library == null ||
    lpTokenPrice.eq("0") ||
    sgtPrice === 0 ||
    chainId !== ChainId.MAINNET
  )
    return [Zero, Zero]
  const ethcallProvider = await getMulticallProvider(library, chainId)
  const rewardsContract = new Contract(
    "0xcf91812631e37c01c443a4fa02dfb59ee2ddba7c", // prod address
    SGT_REWARDS_ABI,
  ) as MulticallContract<SharedStakeStakingRewards>
  const multicalls = [
    rewardsContract.periodFinish(), // 1e0 timestamp in seconds
    rewardsContract.rewardsDuration(), // 1e0 seconds
    rewardsContract.getRewardForDuration(), // 1e18
    rewardsContract.totalSupply(), // 1e18
    rewardsContract.balanceOf(accountId || AddressZero),
  ]
  const [
    until,
    rewardsDuration,
    sgtRewardsPerPeriod,
    totalStaked,
    userStakedAmount,
  ] = await ethcallProvider.all(multicalls, {})

  const nowSeconds = BigNumber.from(Math.floor(Date.now() / 1000))
  const remainingDays = until.sub(nowSeconds).div(60 * 60 * 24) // 1e0
  const rewardsDurationDays = rewardsDuration.div(60 * 60 * 24) // 1e0
  if (
    remainingDays.lte(Zero) ||
    rewardsDurationDays.eq(Zero) ||
    sgtRewardsPerPeriod.eq(Zero) ||
    totalStaked.eq(Zero)
  ) {
    return [Zero, userStakedAmount]
  }
  const remainingRewards = remainingDays.mul(
    sgtRewardsPerPeriod.div(rewardsDurationDays),
  ) // 1e18

  const remainingRewardsValueUSD = parseUnits(sgtPrice.toFixed(2), 4).mul(
    remainingRewards,
  ) // 1e22
  const annualCoefficient = BigNumber.from(365)
    .mul(BigNumber.from(10).pow(18))
    .div(remainingDays) // 1e18

  const totalStakedUSD = totalStaked.mul(lpTokenPrice) // 1e36
  const pctYieldForPool = remainingRewardsValueUSD
    .mul(BigNumber.from(10).pow(14))
    .div(totalStakedUSD) // 1e18
  const apr = pctYieldForPool.mul(annualCoefficient) // 1e18

  return [apr, userStakedAmount]
}

async function getAlEthData(
  library: Web3Provider,
  chainId: ChainId,
  lpTokenPrice: BigNumber,
  alcxPrice = 0,
  accountId?: string | null,
): Promise<[BigNumber, BigNumber]> {
  if (
    library == null ||
    lpTokenPrice.eq("0") ||
    alcxPrice === 0 ||
    chainId !== ChainId.MAINNET
  )
    return [Zero, Zero]
  const ethcallProvider = await getMulticallProvider(library, chainId)
  const rewardsContract = new Contract(
    "0xAB8e74017a8Cc7c15FFcCd726603790d26d7DeCa", // prod address
    ALCX_REWARDS_ABI,
  ) as MulticallContract<AlchemixStakingPools>
  const POOL_ID = 6
  const multicalls = [
    rewardsContract.getPoolRewardRate(POOL_ID),
    rewardsContract.getPoolTotalDeposited(POOL_ID),
    rewardsContract.getStakeTotalDeposited(accountId || AddressZero, POOL_ID),
  ]
  const [
    alcxRewardPerBlock,
    poolTotalDeposited,
    userStakedAmount,
  ] = await ethcallProvider.all(multicalls, {})
  const alcxPerYear = alcxRewardPerBlock.mul(52 * 45000) // 1e18 // blocks/year rate from Alchemix's own logic
  const alcxPerYearUSD = alcxPerYear.mul(parseUnits(alcxPrice.toFixed(2), 2)) // 1e20
  const totalDepositedUSD = poolTotalDeposited.mul(lpTokenPrice) // 1e36
  const alcxApr = alcxPerYearUSD
    .mul(BigNumber.from(10).pow(34))
    .div(totalDepositedUSD) // 1e18
  return [alcxApr, userStakedAmount]
}
