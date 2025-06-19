import {
  time,
  loadFixture,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Currency, MaxUint256, Token } from '@uniswap/sdk-core'
import { Pool, Position, nearestUsableTick,FeeAmount } from '@uniswap/v3-sdk'
import { abi as TOKEN_ABI } from './solmate/src/tokens/ERC20.sol/ERC20.json'
import hre from 'hardhat'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {ContractFactory, parseUnits, solidityPacked, AbiCoder, ZeroHash, Contract} from 'ethers'
import {
  ALICE_ADDRESS,
  DAI,
  USDC,
  WETH,
  MAX_UINT,
  MAX_UINT160,
  DEADLINE,
  V2_FACTORY_MAINNET,
  V3_FACTORY_MAINNET,
  WORMHOLE_CORE_ADDRESS,
  WORMHOLE_BRIDGE_ADDRESS,
  ChainId,
} from './const'
import {
  deployUniversalRouter,
  PERMIT2,
  encodePathExactInput,
} from './helper'

import {
  RoutePlanner,
  CommandType,
} from './planner'

import {
  getPermitSignature, PermitSingle,PermitBatch, PermitDetails,getPermitBatchSignature,
  signPermit
} from './permit2'

import {
  executeRouter
} from './executeRouter'
import { universalRouter } from "../typechain-types/factories/@uniswap";

const artifacts = {
  UniswapV3Factory: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json"),
  SwapRouter: require("@uniswap/v3-periphery/artifacts/contracts/SwapRouter.sol/SwapRouter.json"),
  NFTDescriptor: require("@uniswap/v3-periphery/artifacts/contracts/libraries/NFTDescriptor.sol/NFTDescriptor.json"),
  NonfungibleTokenPositionDescriptor: require("@uniswap/v3-periphery/artifacts/contracts/NonfungibleTokenPositionDescriptor.sol/NonfungibleTokenPositionDescriptor.json"),
  NonfungiblePositionManager: require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json"),
  UniswapV3Pool: require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json"),
};
const bn =require('bignumber.js');
// bn.config({ EXPONENTIAL_AT: 999999, DECIMAL_PLACES: 40 })
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
  let WETHAddress:any
  let nonfungiblePositionManager:any
  let v3Factory:any
  let nonfungiblePositionManagerAddress:any
  let WETHContract:any

  interface LinkReferences {
    [fileName: string]: {
      [contractName: string]: Array<{
        start: number;
        length: number;
      }>;
    };
  }
  interface Libraries {
    [contractName: string]: string;
  }

  const linkLibraries = ({ bytecode, linkReferences }:
    { bytecode: string; linkReferences:LinkReferences }, libraries: Libraries):string => {
    Object.keys(linkReferences).forEach((fileName) => {
      Object.keys(linkReferences[fileName]).forEach((contractName) => {
        if (!libraries.hasOwnProperty(contractName)) {
          throw new Error(`Missing link library name ${contractName}`)
        }
        const address = ethers
          .getAddress(libraries[contractName])
          .toLowerCase()
          .slice(2)
        linkReferences[fileName][contractName].forEach(
          ({ start, length }) => {
            const start2 = 2 + start * 2
            const length2 = length * 2
            bytecode = bytecode
              .slice(0, start2)
              .concat(address)
              .concat(bytecode.slice(start2 + length2, bytecode.length))
          }
        )
      })
    })
    return bytecode
  }

  function encodePriceSqrt(reserve1: string | number | bigint, reserve0: string | number | bigint): bigint {
    const priceAsBn = new bn(reserve1.toString())
      .div(reserve0.toString())
      .sqrt()
      .multipliedBy(new bn(2).pow(96))
      .integerValue(3);
      const priceAsString = priceAsBn.toFixed(0);
    return BigInt(priceAsString);
  }

  async function getPoolData(poolContract:Contract) {
    const [tickSpacing, fee, liquidity, slot0] = await Promise.all([
      poolContract.tickSpacing(),
      poolContract.fee(),
      poolContract.liquidity(),
      poolContract.slot0(),
    ])

    return {
      tickSpacing: tickSpacing,
      fee: fee,
      liquidity: liquidity,
      sqrtPriceX96: slot0[0],
      tick: slot0[1],
    }
  }
  async function ensureApproval(token:string, wallet:SignerWithAddress, spender:string, amount:bigint) {
    const t = new ethers.Contract(token, MyToken.interface, wallet);
    const allowance = await t.allowance(wallet.address, spender);
    if (allowance < amount) {
      console.log(`⏳ [Approve] ${token} -> Permit2`);
      await (await t.approve(spender, MAX_UINT)).wait();
      console.log(`✅ Approved`);
    }
  }

  const toJson = (obj:any) =>
    JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);

  const v3Path = (a:string, b:string, fee:number) =>
    solidityPacked(['address', 'uint24', 'address'], [a, fee, b]);

  /**
  * 为指定 token 确保：
  * ① ERC20 → Permit2 已授权；
  * ② Permit2 → Collector 已授权。
  */
  async function ensurePermit2(token:string, owner:SignerWithAddress, amount:bigint) {
    const erc20  = new ethers.Contract(token, MyToken.interface  , owner);
    const permit = new ethers.Contract(permit2Address, permit2.interface, owner);

    /* === 1. ERC20 → Permit2 === */
    const curErc20Allow = await erc20.allowance(owner.address, permit2Address);
    if (curErc20Allow < amount) {
      console.log(`  · Approving ERC20 → Permit2   (${token})`);
      await (await erc20.approve(permit2Address, MAX_UINT)).wait();
    }

    /* === 2. Permit2 → DustCollector === */
    const [allowAmt] = await permit.allowance(owner.address, token, DustCollectorAddress);
    if (allowAmt < amount) {
      console.log(`  · Approving Permit2 → Collector (${token})`);
      const maxUint160 = (1n << 160n) - 1n;               // 2¹⁶⁰-1
      const expiration = Math.floor(Date.now() / 1e3) + 3600 * 24 * 30; // 30 天
      await (await permit.approve(token, DustCollectorAddress, maxUint160, expiration)).wait();
    }
  }

  async function createV3PoolAndAddLiquidity(tokenA:Token, tokenB:Token, poolFee:number, price:bigint, owner:SignerWithAddress, liquidity:number) {
    await nonfungiblePositionManager.connect(owner).createAndInitializePoolIfNecessary(
      tokenA.address,
      tokenB.address,
      poolFee,
      price,
      // { gasLimit: 5000000 }
    )
    const poolAddress = await v3Factory.connect(owner).getPool(
      tokenA.address,
      tokenB.address,
      poolFee,
    )
    // addLiquidity
    const poolContract = new ethers.Contract(poolAddress, artifacts.UniswapV3Pool.abi, owner)

    let poolData = await getPoolData(poolContract)

    let tokenAContract = new ethers.Contract(tokenA.address, usdtToken.interface, owner);
    let tokenBContract = new ethers.Contract(tokenB.address, usdtToken.interface, owner);
    await tokenAContract.approve(nonfungiblePositionManagerAddress, MAX_UINT);
    await tokenBContract.approve(nonfungiblePositionManagerAddress, MAX_UINT);


    const pool = new Pool(
      tokenA,
      tokenB,
      Number(poolData.fee) as FeeAmount,
      poolData.sqrtPriceX96.toString(),
      poolData.liquidity.toString(),
      Number(poolData.tick)
    )

    const position = new Position({
      pool: pool,
      liquidity: liquidity,
      tickLower: nearestUsableTick(Number(poolData.tick), Number(poolData.tickSpacing)) - Number(poolData.tickSpacing) * 2,
      tickUpper: nearestUsableTick(Number(poolData.tick),Number(poolData.tickSpacing)) + Number(poolData.tickSpacing) * 2,
    })
    const { amount0: amount0Desired, amount1: amount1Desired} = position.mintAmounts;

    let params = {
      token0: tokenA.address,
      token1: tokenB.address,
      fee: poolData.fee,
      tickLower: nearestUsableTick(Number(poolData.tick), Number(poolData.tickSpacing)) - Number(poolData.tickSpacing) * 2,
      tickUpper: nearestUsableTick(Number(poolData.tick), Number(poolData.tickSpacing)) + Number(poolData.tickSpacing) * 2,
      amount0Desired: amount0Desired.toString(),
      amount1Desired: amount1Desired.toString(),
      amount0Min: 0,
      amount1Min: 0,
      recipient: owner.address,
      deadline: Math.floor(Date.now() / 1000) + (60 * 10)
    }

    await nonfungiblePositionManager.connect(owner).mint(
      params,
      { gasLimit: '1000000' }
    );
  }

  beforeEach(async () => {
    await resetFork()
    await hre.network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [ALICE_ADDRESS],
    })
    // alice = await ethers.getSigner(ALICE_ADDRESS)
    alice = (await ethers.getSigners())[0]
    bob = (await ethers.getSigners())[1]
    // deploy erc20 token
    MyToken = await ethers.getContractFactory("MyERC20");
    daiToken = await MyToken.deploy("DAI","DAI");
    usdtToken = await MyToken.deploy("USDT","USDT");
    usdcToken = await MyToken.deploy("USDC","USDC");
    daiTokenAddress = await daiToken.getAddress();
    usdtTokenAddress = await usdtToken.getAddress();
    usdcTokenAddress = await usdcToken.getAddress();

    WETHContract = new ethers.Contract(WETH.address ,WETH9.abi, alice);
    WETHAddress = await WETHContract.getAddress();
    // alice deposit eth
    await WETHContract.deposit({ value: ethers.parseUnits("10", "ether") })

    // deploy uniswap v2 contract
    UniswapV2FactoryContract = new ethers.Contract(V2_FACTORY_MAINNET, UniswapV2Factoryx.abi, bob)
    UniswapV2FactoryAddress = await UniswapV2FactoryContract.getAddress();
    const UniswapV2Router02 = new ContractFactory(UniswapV2Router02x.abi, UniswapV2Router02x.bytecode, alice);
    UniswapV2Router02Contract = await UniswapV2Router02.deploy(UniswapV2FactoryAddress,WETHAddress);
    UniswapV2RouterAddress = await UniswapV2Router02Contract.getAddress();

    // mint test erc20 token, transfer token to test address.
    const MAX_MINT = BigInt("100000000000000000000000000000");
    const INIT_AMOUNT = BigInt("100000000000000000000");
    await daiToken.mint(alice.address, MAX_MINT);
    await usdtToken.mint(alice.address, MAX_MINT);
    await usdcToken.mint(alice.address, MAX_MINT);
    await usdtToken.transfer(bob.address,  INIT_AMOUNT);
    await daiToken.transfer(bob.address,  INIT_AMOUNT);
    await usdcToken.transfer(bob.address, INIT_AMOUNT);

    // approve token to uniswapv2 router.
    await usdtToken.approve(UniswapV2RouterAddress, MAX_UINT);
    await daiToken.approve(UniswapV2RouterAddress, MAX_UINT);
    await usdcToken.approve(UniswapV2RouterAddress, MAX_UINT);

    router = await deployUniversalRouter(bob.address);
    routerAddress = await router.getAddress();
    permit2 = PERMIT2.connect(bob)
    permit2Address = await permit2.getAddress();

    // deploy uniswap v3 contract
    v3Factory = new ethers.Contract(V3_FACTORY_MAINNET, artifacts.UniswapV3Factory.abi, alice);
    let factoryAddress = await v3Factory.getAddress();
    let SwapRouter = new ContractFactory(artifacts.SwapRouter.abi, artifacts.SwapRouter.bytecode, alice);
    let swapRouter = await SwapRouter.deploy(factoryAddress, WETHAddress);
    let swapRouterAddress = await swapRouter.getAddress();

    // deploy dust collector contract
    // const DustCollector = await ethers.getContractFactory("DustCollector");
    // DustCollectorContract = await DustCollector.deploy(UniswapV2RouterAddress, routerAddress, permit2Address, swapRouterAddress);
    // DustCollectorAddress = await DustCollectorContract.getAddress();
    const DustCollector = await ethers.getContractFactory("DustCollectorUniversalPermit2");
    DustCollectorContract = await DustCollector.deploy(routerAddress,WORMHOLE_CORE_ADDRESS,WORMHOLE_BRIDGE_ADDRESS, permit2Address, alice.address);
    DustCollectorAddress = await DustCollectorContract.getAddress();

    // deploy v3 pool
    let NFTDescriptor = new ContractFactory(artifacts.NFTDescriptor.abi, artifacts.NFTDescriptor.bytecode, alice);
    let nftDescriptor = await NFTDescriptor.deploy();
    let nftDescriptorAddress = await nftDescriptor.getAddress();

    const linkedBytecode = linkLibraries(
      {
        bytecode: artifacts.NonfungibleTokenPositionDescriptor.bytecode,
        linkReferences: {
          "NFTDescriptor.sol": {
            NFTDescriptor: [
              {
                length: 20,
                start: 1681,
              },
            ],
          },
        },
      },
      {
        NFTDescriptor: nftDescriptorAddress,
      }
    );

    let NonfungibleTokenPositionDescriptor = new ContractFactory(artifacts.NonfungibleTokenPositionDescriptor.abi, linkedBytecode, alice);
    const nativeCurrencyLabelBytes = ethers.encodeBytes32String('WETH')
    let nonfungibleTokenPositionDescriptor = await NonfungibleTokenPositionDescriptor.deploy(WETHAddress, nativeCurrencyLabelBytes);
    let nonfungibleTokenPositionDescriptorAddress = await nonfungibleTokenPositionDescriptor.getAddress();

    let NonfungiblePositionManager = new ContractFactory(artifacts.NonfungiblePositionManager.abi, artifacts.NonfungiblePositionManager.bytecode, alice);
    nonfungiblePositionManager = await NonfungiblePositionManager.deploy(factoryAddress, WETHAddress, nonfungibleTokenPositionDescriptorAddress);
    nonfungiblePositionManagerAddress = await nonfungiblePositionManager.getAddress();

    // deploy v3 pool
    let price = encodePriceSqrt(1, 2);
    const poolFee = 500;
    const tokenA = new Token(1, usdtTokenAddress, 18, 'USDT', 'USDT')
    const tokenB = new Token(1, usdcTokenAddress, 18, 'USDC', 'USDC')
    const tokenC = new Token(1, daiTokenAddress, 18, 'DAI', 'DAI')
    const tokenD = new Token(1, WETHAddress, 18, 'WETH', 'WETH')
    await createV3PoolAndAddLiquidity(tokenA, tokenB, poolFee, price, alice, Number(ethers.parseEther('1')))
    await createV3PoolAndAddLiquidity(tokenA, tokenC, poolFee, price, alice, Number(ethers.parseEther('1')))
    price = encodePriceSqrt(1000, 1);
    await createV3PoolAndAddLiquidity(tokenC, tokenD, poolFee, price, alice, Number(ethers.parseEther('1')))
  });

  describe("Test", function () {

    async function signPerimit(TOKENS:any, owner:SignerWithAddress) {
   /* step 0: prepare amounts */
   for (const tk of TOKENS) tk.amtWei = parseUnits(tk.amt, tk.dec);
   /* step 1: ERC20 -> Permit2 approvals */
    console.log('📋 Step 1) ERC20 approvals');
    for (const tk of TOKENS)
      await ensureApproval(tk.addr, owner, permit2Address, tk.amtWei);

    /* step 2: build batch-permit typed-data & sign */
    console.log('\n📋 Step 2) Build & sign Permit2 batch');

    const expiration  = Math.floor(Date.now() / 1e3) + 86400 * 30;   // 30d
    const sigDeadline = Math.floor(Date.now() / 1e3) + 3600;        // 1h

    const details:PermitDetails[] = [];
    for (const tk of TOKENS) {
      const [, , nonce] = await permit2.allowance(owner.address, tk.addr, DustCollectorAddress);
      details.push({ token: tk.addr, amount: tk.amtWei, expiration, nonce });
    }
    const permitBatch:PermitBatch = { details, spender: DustCollectorAddress, sigDeadline };

    const domain = { name: 'Permit2', chainId:ChainId, verifyingContract: permit2Address };
    const types  = {
      PermitBatch:   [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
    };

    // console.log('📝 TypedData:\n', toJson({ domain, types, permitBatch }), '\n');
    const signature = await owner.signTypedData(domain, types, permitBatch);
    console.log('🔑 Signature:', signature, '\n');

    /* step 3: send permit tx */
    console.log('📋 Step 3) Send permit() tx');
    const permitTx = await permit2["permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)"](owner.address, permitBatch, signature);
    console.log('⛓️  Permit TxHash:', permitTx.hash);
    await permitTx.wait();
    console.log('✅ Permit tx confirmed\n');
    }

    it("uniswap v3 test 1", async function () {
      let TOKENS = [
        { addr: usdcTokenAddress, dec: 18, amt: '0.01', fee: 500, amtWei: 0n },
        { addr: daiTokenAddress, dec: 18, amt: '0.02', fee: 500, amtWei: 0n }
      ];
      await signPerimit(TOKENS, bob);
      /* step 4: build swap commands & call collector */
      console.log('📋 Step 4) Call DustCollector swap');

      const abi      = AbiCoder.defaultAbiCoder();
      const commands = '0x' + '00'.repeat(TOKENS.length);
      const inputs   = TOKENS.map(tk =>
        abi.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [DustCollectorAddress, tk.amtWei, 0, v3Path(tk.addr, usdtTokenAddress, tk.fee), false]
        )
      );
      console.log("before swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address)
      );
      const dust = new ethers.Contract(DustCollectorAddress, DustCollectorContract.interface, bob);
      const swapTx = await dust.batchCollectWithUniversalRouter(
        {
          commands,
          inputs,
          deadline:    Math.floor(Date.now() / 1e3) + 1800,
          targetToken: usdtTokenAddress,
          dstChain:    0,
          recipient:   ZeroHash,
          arbiterFee:  0
        },
        TOKENS.map(t => t.addr),
        TOKENS.map(t => t.amtWei),
        {
          // gasLimit: 1_000_000,
          value: 0,
        }
      );
      console.log('⛓️  Swap  TxHash:', swapTx.hash);
      const rc = await swapTx.wait();
      console.log(
        rc.status === 1
          ? `🎉 Swap SUCCESS  | GasUsed: ${rc.gasUsed}`
          : '❌ Swap FAILED'
      );
      console.log("after swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address)
      );
    });

    it("uniswap v3 test 2", async function () {
      let TOKENS = [
        { addr: usdcTokenAddress, dec: 18, amt: '0.01', fee: 500, amtWei: 0n },
        { addr: daiTokenAddress, dec: 18, amt: '0.02', fee: 500, amtWei: 0n }
      ];
      /* step 0: prepare amounts */
      for (const tk of TOKENS) tk.amtWei = parseUnits(tk.amt, tk.dec);
      /* ---------- 1. 逐币授权 ---------- */
      for (const tk of TOKENS) {
        tk.amtWei = parseUnits(tk.amt, tk.dec);          // BigInt 数量
        await ensurePermit2(tk.addr, bob, tk.amtWei);
      }
      /* ---------- 2. 组装 UniversalRouter commands/inputs ---------- */
      const abiCoder = AbiCoder.defaultAbiCoder();
      let   commands = '';                               // 每个代币一条 0x00
      const inputs   = [];

      for (const tk of TOKENS) {
        commands += '00';
        inputs.push(
          abiCoder.encode(
            ['address','uint256','uint256','bytes','bool'],
            [DustCollectorAddress, tk.amtWei, 0, v3Path(tk.addr, usdtTokenAddress, tk.fee), false]  // payerIsUser = false
          )
        );
      }
      commands  = '0x' + commands;
      const deadline = Math.floor(Date.now() / 1e3) + 1800;  // 30 分钟

    /* ---------- 3. pullTokens & pullAmounts ---------- */
    const pullTokens  = TOKENS.map(t => t.addr);
    const pullAmounts = TOKENS.map(t => t.amtWei);
    /* ---------- 4. 调 DustCollector ---------- */
    const collector = new ethers.Contract(DustCollectorAddress, DustCollectorContract.interface, bob);
    console.log("before swap:" + await usdtToken.balanceOf(bob.address) + ":"+
    await daiToken.balanceOf(bob.address)+ ":"+
    await usdcToken.balanceOf(bob.address)
    );
    console.log('⏳  Sending transaction …');
    const tx = await collector.batchCollectWithUniversalRouter(
      {
        commands,
        inputs,
        deadline,
        targetToken: usdtTokenAddress,
        dstChain:    0,
        recipient:   ZeroHash,
        arbiterFee:  0
      },
      pullTokens,
      pullAmounts,
      { value: 0 }
    );

    console.log(`📨  Tx hash: ${tx.hash}`);
    const rc = await tx.wait();
    console.log(rc.status === 1 ? '✅  SUCCESS' : '❌  FAILED');
    console.log("after swap:" + await usdtToken.balanceOf(bob.address) + ":"+
    await daiToken.balanceOf(bob.address)+ ":"+
    await usdcToken.balanceOf(bob.address)
    );
    });

    // tokenA->tokenB->tokenC
    it("uniswap v3 test 3", async function () {
      let TOKENS = [
        { addr: usdcTokenAddress, dec: 18, amt: '0.01', fee: 500, amtWei: 0n },
      ];

      await signPerimit(TOKENS, bob);
      /* step 4: build swap commands & call collector */
      console.log('📋 Step 4) Call DustCollector swap');

      const abi      = AbiCoder.defaultAbiCoder();
      const commands = '0x' + '00'.repeat(TOKENS.length);
      const inputs   = TOKENS.map(tk =>
        abi.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [DustCollectorAddress, tk.amtWei, 0, encodePathExactInput([tk.addr, usdtTokenAddress, daiTokenAddress]), false]
        )
      );
      console.log("before swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address)
      );
      const dust = new ethers.Contract(DustCollectorAddress, DustCollectorContract.interface, bob);
      const swapTx = await dust.batchCollectWithUniversalRouter(
        {
          commands,
          inputs,
          deadline:    Math.floor(Date.now() / 1e3) + 1800,
          targetToken: daiTokenAddress,
          dstChain:    0,
          recipient:   ZeroHash,
          arbiterFee:  0
        },
        TOKENS.map(t => t.addr),
        TOKENS.map(t => t.amtWei),
        {
          // gasLimit: 1_000_000,
          value: 0,
        }
      );
      console.log('⛓️  Swap  TxHash:', swapTx.hash);
      const rc = await swapTx.wait();
      console.log(
        rc.status === 1
          ? `🎉 Swap SUCCESS  | GasUsed: ${rc.gasUsed}`
          : '❌ Swap FAILED'
      );
      console.log("after swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address)
      );
    });
    // erc20->eth
    it("uniswap v3 test 4", async function () {
      let TOKENS = [
        { addr: daiTokenAddress, dec: 18, amt: '0.01', fee: 500, amtWei: 0n },
      ];

      await signPerimit(TOKENS, bob);
      /* step 4: build swap commands & call collector */
      console.log('📋 Step 4) Call DustCollector swap');

      const abi      = AbiCoder.defaultAbiCoder();
      const commands = '0x' + '00'.repeat(TOKENS.length);
      const inputs   = TOKENS.map(tk =>
        abi.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [DustCollectorAddress, tk.amtWei, 0, encodePathExactInput([tk.addr, WETHAddress]), false]
        )
      );
      console.log("before swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address) + ":"+
      await WETHContract.balanceOf(bob.address)
      );
      const dust = new ethers.Contract(DustCollectorAddress, DustCollectorContract.interface, bob);
      const swapTx = await dust.batchCollectWithUniversalRouter(
        {
          commands,
          inputs,
          deadline:    Math.floor(Date.now() / 1e3) + 1800,
          targetToken: WETHAddress,
          dstChain:    0,
          recipient:   ZeroHash,
          arbiterFee:  0
        },
        TOKENS.map(t => t.addr),
        TOKENS.map(t => t.amtWei),
        {
          // gasLimit: 1_000_000,
          value: 0,
        }
      );
      console.log('⛓️  Swap  TxHash:', swapTx.hash);
      const rc = await swapTx.wait();
      console.log(
        rc.status === 1
          ? `🎉 Swap SUCCESS  | GasUsed: ${rc.gasUsed}`
          : '❌ Swap FAILED'
      );
      console.log("after swap:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address) + ":"+
      await WETHContract.balanceOf(bob.address)
      );
      await WETHContract.connect(bob).withdraw(await WETHContract.balanceOf(bob.address));
      console.log("after withdraw:" + await usdtToken.balanceOf(bob.address) + ":"+
      await daiToken.balanceOf(bob.address)+ ":"+
      await usdcToken.balanceOf(bob.address) + ":"+
      await WETHContract.balanceOf(bob.address)
      );
    });


  });
});
