import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Currency, MaxUint256, Token } from '@uniswap/sdk-core'
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
  V2_FACTORY_MAINNET,
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
  let owner:any
  let addr1:any
  let MyToken:any
  let daiToken:any
  let usdtToken:any
  let usdcToken:any
  let UniswapV2FactoryContract:any
  let UniswapV2FactoryAddress:any
  let UniswapV2Router02Contract:any
  let UniswapV2RouterAddress:any
  let daiTokenAddress:any
  let usdtTokenAddress:any
  let usdcTokenAddress:any
  let DustCollectorContract:any
  let DustCollectorAddress:any
  let router:any
  let routerAddress:any
  let permit2:any
  let permit2Address:any

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

    owner = (await ethers.getSigners())[0];
    addr1 = (await ethers.getSigners())[1];
    MyToken = await ethers.getContractFactory("MyERC20");
    daiToken = await MyToken.deploy("DAI","DAI");
    usdtToken = await MyToken.deploy("USDT","USDT");
    usdcToken = await MyToken.deploy("USDT","USDT");
    const WETH9v2 = await ethers.getContractFactory(WETH9.abi, WETH9.bytecode);
    const WETHContractv2 = await WETH9v2.deploy();
    const WETHAddress = await WETHContractv2.getAddress();
  
  //   const UniswapV2Factory = await ethers.getContractFactory(UniswapV2Factoryx.abi, UniswapV2Factoryx.bytecode);
  //   = await UniswapV2Factory.deploy(owner.address);
  UniswapV2FactoryContract = new ethers.Contract(V2_FACTORY_MAINNET, UniswapV2Factoryx.abi, bob)
   UniswapV2FactoryAddress = await UniswapV2FactoryContract.getAddress();
  console.log(UniswapV2FactoryAddress);
    const UniswapV2Router02 = await ethers.getContractFactory(UniswapV2Router02x.abi, UniswapV2Router02x.bytecode);
   UniswapV2Router02Contract = await UniswapV2Router02.deploy(UniswapV2FactoryAddress,WETHAddress);
   UniswapV2RouterAddress = await UniswapV2Router02Contract.getAddress();
    daiTokenAddress = await daiToken.getAddress();
    usdtTokenAddress = await usdtToken.getAddress();
    usdcTokenAddress = await usdcToken.getAddress();

   const MAX_MINT = BigInt("100000000000000000000000000000");
   await daiToken.mint(owner.address, MAX_MINT);
   await usdtToken.mint(owner.address, MAX_MINT);
   await usdcToken.mint(owner.address, MAX_MINT);
   await daiToken.transfer(addr1.address, BigInt("100000000000000000000"));
   await usdcToken.transfer(addr1.address, BigInt("100000000000000000000"));

   await usdtToken.approve(UniswapV2RouterAddress, MAX_UINT);
   await daiToken.approve(UniswapV2RouterAddress, MAX_UINT);
   await usdcToken.approve(UniswapV2RouterAddress, MAX_UINT);

   const DustCollector = await ethers.getContractFactory("DustCollector");
   router = await deployUniversalRouter(bob.address);
   routerAddress = await router.getAddress();
   permit2 = PERMIT2.connect(bob)
   permit2Address = await permit2.getAddress();
  console.log(routerAddress, permit2Address);
   DustCollectorContract = await DustCollector.deploy(UniswapV2RouterAddress, routerAddress, permit2Address);
   DustCollectorAddress = await DustCollectorContract.getAddress();

   await daiToken.connect(addr1).approve(DustCollectorAddress, MAX_UINT);
   await usdcToken.connect(addr1).approve(DustCollectorAddress, MAX_UINT);

   await daiContract.connect(addr1).approve(DustCollectorAddress, MAX_UINT);
  });


  describe("Test", function () {
    it("all test", async function () {
      let start_at = new Date().getTime();

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

      console.log("before swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      await daiToken.balanceOf(addr1.address)+ ":"+
      await usdcToken.balanceOf(addr1.address)
      );

      await DustCollectorContract.connect(addr1).swapDust([daiTokenAddress, usdcTokenAddress], usdtTokenAddress);

      console.log("after swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      await daiToken.balanceOf(addr1.address)+ ":"+
      await usdcToken.balanceOf(addr1.address)
      );
    });

    it("universal router test", async function () {
      // await daiContract.connect(alice).transfer(bob.address, BigInt("100000000000000000000000") )
      // await wethContract.connect(alice).transfer(bob.address, BigInt("100000000000000000000"))
      // await usdcContract.connect(alice).transfer(bob.address, BigInt("100000000000"))

      // await daiContract.connect(bob).approve(permit2Address, MAX_UINT)
      // await wethContract.connect(bob).approve(permit2Address, MAX_UINT)
      // await usdcContract.connect(bob).approve(permit2Address, MAX_UINT)

      // await permit2.approve(DAI.address, routerAddress, MAX_UINT160, DEADLINE)
      // await permit2.approve(WETH.address, routerAddress, MAX_UINT160, DEADLINE)

      // start test
      let planner = new RoutePlanner();
      // await permit2.approve(DAI.address, routerAddress, 0, 0)
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

      // let amountInDAI = BigInt("100000000000000000000");
      // const minAmountOutWETH =BigInt("20000000000000000");
      // const MSG_SENDER: string = '0x0000000000000000000000000000000000000001'
      // const SOURCE_MSG_SENDER: boolean = true
      // let permit = {
      //   details: {
      //     token: DAI.address,
      //     amount: amountInDAI,
      //     expiration: 0, // expiration of 0 is block.timestamp
      //     nonce: 0, // this is his first trade
      //   },
      //   spender: routerAddress,
      //   sigDeadline: DEADLINE,
      // }
      // const sig = await getPermitSignature(permit, bob, permit2)
      // planner.addCommand(CommandType.PERMIT2_PERMIT, [permit, sig])
      // planner.addCommand(CommandType.V2_SWAP_EXACT_IN, [
      //   MSG_SENDER,
      //   amountInDAI,
      //   minAmountOutWETH,
      //   [DAI.address, WETH.address],
      //   SOURCE_MSG_SENDER,
      // ])
      // const { wethBalanceBefore, wethBalanceAfter, daiBalanceAfter, daiBalanceBefore:daiBalanceBeforex } = await executeRouter(
      //   planner,
      //   bob,
      //   router,
      //   wethContract,
      //   daiContract,
      //   usdcContract
      // )
      // console.log(wethBalanceBefore, wethBalanceAfter, daiBalanceAfter, daiBalanceBeforex);
      // expect(wethBalanceAfter-wethBalanceBefore).to.be.gte(minAmountOutWETH)
      // expect(daiBalanceBefore- daiBalanceAfter).to.be.eq(amountInDAI)

      //   console.log("before swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      //   await daiContract.balanceOf(addr1.address)+ ":"+
      //   await usdcContract.balanceOf(addr1.address)
      //   );
      // await DustCollectorContract.connect(addr1).swapDustUni([DAI.address], USDC.address);
      // console.log("after swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      // await daiContract.balanceOf(addr1.address)+ ":"+
      // await usdcContract.balanceOf(addr1.address)
      // );
  
      // await daiToken.connect(addr1).approve(permit2Address, MAX_UINT)
      // await permit2.connect(addr1).approve(daiTokenAddress, routerAddress, MAX_UINT160, DEADLINE)

    let start_at = new Date().getTime();

    //DAI-USDT
    await UniswapV2Router02Contract.addLiquidity(daiTokenAddress,usdtTokenAddress, 
      BigInt("100000000000000000000"), BigInt("100000000000000000000"),
      BigInt("90000000000000000000"),BigInt("90000000000000000000"),
      owner.address, start_at);
      //USDC-USDT
      await UniswapV2Router02Contract.addLiquidity(usdcTokenAddress,usdtTokenAddress, 
        BigInt("100000000000000000000"), BigInt("100000000000000000000"),
        BigInt("90000000000000000000"),BigInt("90000000000000000000"),
        owner.address, start_at);

      console.log("before swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
      await daiToken.balanceOf(addr1.address)+ ":"+
      await usdcToken.balanceOf(addr1.address)
      );

     await DustCollectorContract.connect(addr1).swapDustUni([daiTokenAddress, usdcTokenAddress], usdtTokenAddress);
    console.log("after swap:" + await usdtToken.balanceOf(addr1.address) + ":"+
    await daiToken.balanceOf(addr1.address)+ ":"+
    await usdcToken.balanceOf(addr1.address)
    );
    });

  });


});
