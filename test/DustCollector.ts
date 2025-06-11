import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Currency, Token } from '@uniswap/sdk-core'
import { abi as TOKEN_ABI } from './solmate/src/tokens/ERC20.sol/ERC20.json'
import hre from 'hardhat'
import {
  ALICE_ADDRESS,
  DAI,
  USDC,
  WETH,
  MAX_UINT,
  MAX_UINT160,
  DEADLINE,
} from './const'
import {
  deployUniversalRouter,
  PERMIT2,
} from './helper'

import {
  RoutePlanner,
  CommandType,
} from './planner'

import {
  getPermitSignature
} from './permit2'

import {
  executeRouter
} from './executeRouter'


const{BigNumber}=require('ethers');
const WETH9 = require('./WETH9.json')
const UniswapV2Factoryx = require('./UniswapV2Factory.json')
const UniswapV2Router01x = require('./UniswapV2Router01.json')
const UniswapV2Router02x = require('./UniswapV2Router02.json')
const UniswapV2Pairx = require('./UniswapV2Pair.json');

export const resetFork = async () => {
  await hre.network.provider.request({
    method: 'hardhat_reset',
    params: [
      {
        forking: {
          jsonRpcUrl: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
          blockNumber: 20010000,
        },
      },
    ],
  })
}

describe("Dust collector", function () {
  let alice: any
  let bob: any
  let daiContract: any
  let wethContract: any
  let usdcContract: any

  beforeEach(async () => {
    await resetFork()
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [ALICE_ADDRESS],
    })
    alice = await ethers.getSigner(ALICE_ADDRESS)
    bob = (await ethers.getSigners())[1]
    daiContract = new ethers.Contract(DAI.address, TOKEN_ABI, bob)
    wethContract = new ethers.Contract(WETH.address, TOKEN_ABI, bob)
    usdcContract = new ethers.Contract(USDC.address, TOKEN_ABI, bob)
  });


  async function deployFixture() {
    const [owner, addr1, addr2, addr3,addr4,addr5] = await ethers.getSigners();

    let MyToken = await ethers.getContractFactory("MyERC20");

    return { MyToken, owner, addr1, addr2, addr3,addr4,addr5};
  }

  describe("Test", function () {
    it("all test", async function () {
      let start_at = new Date().getTime();
      const { MyToken, owner, addr1, addr2, addr3,addr4,addr5} = await loadFixture(deployFixture);

      const daiToken = await MyToken.deploy("DAI","DAI");
      const usdtToken = await MyToken.deploy("USDT","USDT");
      const usdcToken = await MyToken.deploy("USDT","USDT");
      const daiTokenAddress = await daiToken.getAddress();
      const usdtTokenAddress = await usdtToken.getAddress();
      const usdcTokenAddress = await usdcToken.getAddress();

      await daiToken.mint(owner.address, BigInt("100000000000000000000000000000"));
      await usdtToken.mint(owner.address, BigInt("100000000000000000000000000000"));
      await usdcToken.mint(owner.address, BigInt("100000000000000000000000000000"));

      const WETH = await ethers.getContractFactory(WETH9.abi, WETH9.bytecode);
      const WETHContract = await WETH.deploy();
      const WETHAddress = await WETHContract.getAddress();

      const UniswapV2Factory = await ethers.getContractFactory(UniswapV2Factoryx.abi, UniswapV2Factoryx.bytecode);
      const UniswapV2FactoryContract = await UniswapV2Factory.deploy(owner.address);
      const UniswapV2FactoryAddress = await UniswapV2FactoryContract.getAddress();

      const UniswapV2Router02 = await ethers.getContractFactory(UniswapV2Router02x.abi, UniswapV2Router02x.bytecode);
      const UniswapV2Router02Contract = await UniswapV2Router02.deploy(UniswapV2FactoryAddress,WETHAddress);
      const UniswapV2RouterAddress = await UniswapV2Router02Contract.getAddress();

      await usdtToken.approve(UniswapV2RouterAddress, BigInt("1000000000000000000000000000"));
      await daiToken.approve(UniswapV2RouterAddress, BigInt("1000000000000000000000000000"));
      await usdcToken.approve(UniswapV2RouterAddress, BigInt("1000000000000000000000000000"));

      //DAI-USDT
      await UniswapV2Router02Contract.addLiquidity(daiTokenAddress,usdtTokenAddress, 
        BigInt("100000000000000000000"), BigInt("100000000000000000000"),
        BigInt("90000000000000000000"),BigInt("90000000000000000000"),
        owner.address, start_at);

      let pairAddress = await UniswapV2FactoryContract.getPair(daiTokenAddress, usdtTokenAddress);
      let pair = await ethers.getContractFactory(UniswapV2Pairx.abi, UniswapV2Pairx.bytecode)
      let pairContract = await pair.attach(pairAddress);
      let [reserv0,reserv1] = await pairContract.getReserves();
      console.log("==============" + reserv0 + ":" + reserv1);
      //USDC-USDT
      await UniswapV2Router02Contract.addLiquidity(usdcTokenAddress,usdtTokenAddress, 
        BigInt("100000000000000000000"), BigInt("100000000000000000000"),
        BigInt("90000000000000000000"),BigInt("90000000000000000000"),
        owner.address, start_at);

      pairAddress = await UniswapV2FactoryContract.getPair(usdcTokenAddress, usdtTokenAddress);
      pairContract = await pair.attach(pairAddress);
      [reserv0,reserv1] = await pairContract.getReserves();
      console.log("==============" + reserv0 + ":" + reserv1);

      const DustCollector = await ethers.getContractFactory("DustCollector");
      const DustCollectorContract = await DustCollector.deploy(UniswapV2RouterAddress);
      const DustCollectorAddress = await DustCollectorContract.getAddress();
      await daiToken.transfer(addr1.address, BigInt("100000000000000000000"));
      await usdcToken.transfer(addr1.address, BigInt("100000000000000000000"));
      console.log("before swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      await daiToken.balanceOf(addr1.address)+ ":"+
      await usdcToken.balanceOf(addr1.address)
      );
      await daiToken.connect(addr1).approve(DustCollectorAddress, BigInt("1000000000000000000000000000"));
      await usdcToken.connect(addr1).approve(DustCollectorAddress, BigInt("1000000000000000000000000000"));
      await DustCollectorContract.connect(addr1).swapDust([daiTokenAddress, usdcTokenAddress], usdtTokenAddress);

      console.log("after swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      await daiToken.balanceOf(addr1.address)+ ":"+
      await usdcToken.balanceOf(addr1.address)
      );
    });

    it("universal router test", async function () {
      let daiBalanceBefore = await daiContract.balanceOf(bob.address)
      console.log(daiBalanceBefore);
      await daiContract.connect(alice).transfer(bob.address, BigInt("100000000000000000000000") )
      daiBalanceBefore = await daiContract.balanceOf(bob.address)
      console.log(daiBalanceBefore);
      await wethContract.connect(alice).transfer(bob.address, BigInt("100000000000000000000"))
      await usdcContract.connect(alice).transfer(bob.address, BigInt("100000000000"))


      let permit2 = PERMIT2.connect(bob)
      let permit2Address = await permit2.getAddress();

      let router = await deployUniversalRouter(bob.address);

      let routerAddress = await router.getAddress();
      let planner = new RoutePlanner();

      await daiContract.connect(bob).approve(permit2Address, MAX_UINT)
      await wethContract.connect(bob).approve(permit2Address, MAX_UINT)
      await usdcContract.connect(bob).approve(permit2Address, MAX_UINT)

      await permit2.approve(DAI.address, routerAddress, MAX_UINT160, DEADLINE)
      let allow = await daiContract.allowance(bob.address, permit2Address);
      console.log(allow);
      await permit2.approve(WETH.address, routerAddress, MAX_UINT160, DEADLINE)

      // start test
      await permit2.approve(DAI.address, routerAddress, 0, 0)
      // const permit = {
      //   details: {
      //     token: DAI.address,
      //     amount:  BigInt("100000000000000000000"),
      //     expiration: 0, // expiration of 0 is block.timestamp
      //     nonce: 0, // this is his first trade
      //   },
      //   spender: routerAddress,
      //   sigDeadline: DEADLINE,
      // }
      // const sig = await getPermitSignature(permit, bob, permit2)

      // // 1) permit the router to access funds, not allowing revert
      // planner.addCommand(CommandType.PERMIT2_PERMIT, [permit, sig])

      // // 2) permit the router to access funds again, allowing revert
      // planner.addCommand(CommandType.PERMIT2_PERMIT, [permit, sig], true)
    
      // let nonce = (await permit2.allowance(bob.address, DAI.address, routerAddress)).nonce
      // expect(nonce).to.eq(0)

      // await executeRouter(planner, bob, router, wethContract, daiContract, usdcContract)
    
      // nonce = (await permit2.allowance(bob.address, DAI.address, routerAddress)).nonce
      // expect(nonce).to.eq(1)

      let amountInDAI = BigInt("100000000000000000000");
      const minAmountOutWETH =BigInt("20000000000000000");
      const MSG_SENDER: string = '0x0000000000000000000000000000000000000001'
      const SOURCE_MSG_SENDER: boolean = true
      let permit = {
        details: {
          token: DAI.address,
          amount: amountInDAI,
          expiration: 0, // expiration of 0 is block.timestamp
          nonce: 0, // this is his first trade
        },
        spender: routerAddress,
        sigDeadline: DEADLINE,
      }
      const sig = await getPermitSignature(permit, bob, permit2)
      planner.addCommand(CommandType.PERMIT2_PERMIT, [permit, sig])
      planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
        MSG_SENDER,
        amountInDAI,
        minAmountOutWETH,
        [DAI.address, WETH.address],
        SOURCE_MSG_SENDER,
      ])
      const { wethBalanceBefore, wethBalanceAfter, daiBalanceAfter, daiBalanceBefore:daiBalanceBeforex } = await executeRouter(
        planner,
        bob,
        router,
        wethContract,
        daiContract,
        usdcContract
      )
      console.log(wethBalanceBefore, wethBalanceAfter, daiBalanceAfter, daiBalanceBeforex);
      expect(wethBalanceAfter-wethBalanceBefore).to.be.gte(minAmountOutWETH)
      expect(daiBalanceBefore- daiBalanceAfter).to.be.eq(amountInDAI)
      // expect(BigInt(wethBalanceAfter.toString()) - BigInt(wethBalanceBefore.toString())).to.be.gte(minAmountOutWETH)
      // expect(BigInt(daiBalanceBefore.toString())- BigInt(daiBalanceAfter.toString())).to.be.eq(amountInDAI)
    });

  });


});
