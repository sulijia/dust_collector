import type { Contract } from '@ethersproject/contracts'
import { TransactionReceipt } from '@ethersproject/abstract-provider'
import { parseEvents, V2_EVENTS, V3_EVENTS } from './parseEvents'
import {  BigNumberish } from 'ethers'
import { DEADLINE } from './const'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { RoutePlanner } from './planner'
import hre from 'hardhat'
import { bigint } from 'hardhat/internal/core/params/argumentTypes'
const { ethers } = hre

type V2SwapEventArgs = {
  amount0In: BigInt
  amount0Out: BigInt
  amount1In: BigInt
  amount1Out: BigInt
}

type V3SwapEventArgs = {
  amount0: BigInt
  amount1: BigInt
}

type ExecutionParams = {
  wethBalanceBefore: BigInt
  wethBalanceAfter: BigInt
  daiBalanceBefore: BigInt
  daiBalanceAfter: BigInt
  usdcBalanceBefore: BigInt
  usdcBalanceAfter: BigInt
  ethBalanceBefore: BigInt
  ethBalanceAfter: BigInt
  v2SwapEventArgs: V2SwapEventArgs | undefined
  v3SwapEventArgs: V3SwapEventArgs | undefined
  receipt: TransactionReceipt
  gasSpent: BigInt
}

export async function executeRouter(
  planner: RoutePlanner,
  caller: SignerWithAddress,
  router: any,
  wethContract: Contract,
  daiContract: Contract,
  usdcContract: Contract,
  value?: BigNumberish
): Promise<ExecutionParams> {
  const ethBalanceBefore: BigInt = await ethers.provider.getBalance(caller.address)
  const wethBalanceBefore: BigInt = await wethContract.balanceOf(caller.address)
  const daiBalanceBefore: BigInt = await daiContract.balanceOf(caller.address)
  const usdcBalanceBefore: BigInt = await usdcContract.balanceOf(caller.address)

  const { commands, inputs } = planner
  // console.log(commands, inputs, DEADLINE, { value });
  const receipt = await (
    await router.connect(caller)['execute(bytes,bytes[],uint256)'](commands, inputs, DEADLINE, { value })
  ).wait()
  // console.log(receipt);
  const gasSpent = receipt.gasUsed;
  const v2SwapEventArgs = parseEvents(V2_EVENTS, receipt)[0]?.args as unknown as V2SwapEventArgs
  const v3SwapEventArgs = parseEvents(V3_EVENTS, receipt)[0]?.args as unknown as V3SwapEventArgs

  const ethBalanceAfter: BigInt = await ethers.provider.getBalance(caller.address)
  const wethBalanceAfter: BigInt = await wethContract.balanceOf(caller.address)
  const daiBalanceAfter: BigInt = await daiContract.balanceOf(caller.address)
  const usdcBalanceAfter: BigInt = await usdcContract.balanceOf(caller.address)

  return {
    wethBalanceBefore,
    wethBalanceAfter,
    daiBalanceBefore,
    daiBalanceAfter,
    usdcBalanceBefore,
    usdcBalanceAfter,
    ethBalanceBefore,
    ethBalanceAfter,
    v2SwapEventArgs,
    v3SwapEventArgs,
    receipt,
    gasSpent,
  }
}
