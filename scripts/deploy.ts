import { MaxUint256 } from "@uniswap/sdk-core";
import { ethers } from "hardhat";
import {encodePathAndFee} from "../test/helper"
import { FeeAmount } from "@uniswap/v3-sdk";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    PublicKey,
} from "@solana/web3.js";
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
  getPermitSignature, PermitSingle,PermitBatch, PermitDetails,getPermitBatchSignature,
  signPermit
} from '../test/permit2'
import { abi as PERMIT2_ABI } from '../test/permit2/src/interfaces/IPermit2.sol/IPermit2.json'

const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH  = "0x4200000000000000000000000000000000000006";
const DAI   = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const USDT  = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const AAVE  = "0x63706e401c06ac8513145b7687a14804d17f814b";


const PERMIT2       = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const COLLECTOR     = "0xE0166322CFA24d22825123103aC531f056F8a30B";
const WORMHOLE_CORE = "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";

/* ---------- ABI ---------- */
const DUST_ABI = [
  'function batchCollectWithUniversalRouter((' +
    'bytes commands,bytes[] inputs,uint256 deadline,' +
    'address targetToken,uint16 dstChain,bytes32 recipient,uint256 arbiterFee' +
  '), address[] pullTokens, uint256[] pullAmounts) payable'
];

const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

const CORE_ABI = [
  'function messageFee() external view returns (uint256)'
];

function base58Decode(str) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let result = 0n;
  for (let i = 0; i < str.length; i++) {
    const index = alphabet.indexOf(str[i]);
    if (index === -1) throw new Error('Invalid base58 character');
    result = result * 58n + BigInt(index);
  }
  
  const bytes = [];
  while (result > 0n) {
    bytes.unshift(Number(result % 256n));
    result = result / 256n;
  }
  
  for (let i = 0; i < str.length && str[i] === '1'; i++) {
    bytes.unshift(0);
  }
  
  return new Uint8Array(bytes);
}

function toBytes32(addr) {
  if (!addr || addr.trim() === '') return ethers.ZeroHash;
  
  addr = addr.trim();
  
  if (addr.startsWith('0x')) {
    return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
  } else if (addr.length === 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) {
    // Solana 地址
    const decoded = base58Decode(addr);
    if (decoded.length !== 32) throw new Error(`Invalid Solana address length: ${decoded.length}`);
    return '0x' + Array.from(decoded).map(b => b.toString(16).padStart(2, '0')).join('');
  } else {
    const hex = addr.replace(/^0x/, '');
    if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid address format: ${addr}`);
    return '0x' + hex.toLowerCase().padStart(64, '0');
  }
}

async function ensureApproval(token:string, wallet:SignerWithAddress, spender:string, amount:bigint) {
    const t  = new ethers.Contract(token, ERC20_ABI  , wallet);
    const allowance = await t.allowance(wallet.address, spender);
    if (allowance < amount) {
      console.log(`⏳ [Approve] ${token} -> Permit2`);
      // TIPS:前端需要签名
      await (await t.approve(spender, ethers.MaxUint256)).wait();
      console.log(`✅ Approved`);
    }
}

async function signPerimit(TOKENS:any, owner:SignerWithAddress) {
  const permit2 = new ethers.Contract(PERMIT2, PERMIT2_ABI, owner);
  const ChainId = 8453; // base mainnet
   /* step 0: prepare amounts */
   for (const tk of TOKENS) tk.amtWei = ethers.parseUnits(tk.amt, tk.dec);
   /* step 1: ERC20 -> Permit2 approvals */
    console.log('📋 Step 1) ERC20 approvals');
    // 一个token只需要approve一次
    for (const tk of TOKENS)
      await ensureApproval(tk.addr, owner, PERMIT2, tk.amtWei);

    /* step 2: build batch-permit typed-data & sign */
    console.log('\n📋 Step 2) Build & sign Permit2 batch');

    const expiration  = Math.floor(Date.now() / 1e3) + 86400 * 30;   // 30d
    const sigDeadline = Math.floor(Date.now() / 1e3) + 3600;        // 1h

    const details:PermitDetails[] = [];
    for (const tk of TOKENS) {
      const [, , nonce] = await permit2.allowance(owner.address, tk.addr, COLLECTOR);
      details.push({ token: tk.addr, amount: tk.amtWei, expiration, nonce });
    }
    const permitBatch:PermitBatch = { details, spender: COLLECTOR, sigDeadline };

    const domain = { name: 'Permit2', chainId:ChainId, verifyingContract: PERMIT2 };
    const types  = {
      PermitBatch:   [{ name: 'details', type: 'PermitDetails[]' }, { name: 'spender', type: 'address' }, { name: 'sigDeadline', type: 'uint256' }],
      PermitDetails: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]
    };

    // TIPS:前端需要签名
    const signature = await owner.signTypedData(domain, types, permitBatch);
    console.log('🔑 Signature:', signature, '\n');

    /* step 3: send permit tx */
    console.log('📋 Step 3) Send permit() tx');
    // TIPS:前端需要签名
    const permitTx = await permit2["permit(address,((address,uint160,uint48,uint48)[],address,uint256),bytes)"](owner.address, permitBatch, signature);
    console.log('⛓️  Permit TxHash:', permitTx.hash);
    await permitTx.wait();
    console.log('✅ Permit tx confirmed\n');
  }
// 参数:
// DustCollector: dust collector 合约
// TOKENS: 需要swap的token数组信息
// signer:签名钱包
// targetToken: 要swap成什么token
// dstChain: 如果需要跨链，这里是目标链的chain id,为0不需要跨链
// recipient: 如果需要跨链，这里是另一条链上的接收地址,为ZeroHash不需要跨链
// arbiterFee: 给relayer的费用，一般可以为0
// value: 需要转的eth，看具体场景取值
async function swap(DustCollector, TOKENS, signer, targetToken, dstChain, recipient, arbiterFee, value) {
  const abi      = ethers.AbiCoder.defaultAbiCoder();
  // 把所有token授权给permit2
  await signPerimit(TOKENS, signer)

  let commands = '';
  const inputs   = [];
  for (const tk of TOKENS) {
    if(tk.version == "V3") {
      commands += '00';
      inputs.push(
        abi.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [COLLECTOR, tk.amtWei, 0, encodePathAndFee(tk.path, tk.fee), false]
        )
      );
    } else if(tk.version == "V2") {
        commands += '08';
        inputs.push(
          abi.encode(
            ['address', 'uint256', 'uint256', 'address[]', 'bool'],
            [COLLECTOR, tk.amtWei, 0, tk.path, false]
          )
        );
    }
  }

  commands  = '0x' + commands;

  const deadline = Math.floor(Date.now() / 1e3) + 1800;  // 30 分钟

  /* ---------- 3. pullTokens & pullAmounts ---------- */
  const pullTokens  = TOKENS.map(t => t.addr);
  const pullAmounts = TOKENS.map(t => t.amtWei);

  /* ---------- 4. 调 DustCollector ---------- */
  console.log('⏳  Sending transaction …');
  // TIPS:前端需要签名
  const tx = await DustCollector.batchCollectWithUniversalRouter(
    {
      commands,
      inputs,
      deadline,
      targetToken: targetToken,
      dstChain:    dstChain,
      recipient:   recipient,
      arbiterFee:  arbiterFee
    },
    pullTokens,
    pullAmounts,
    { value: value }
  );

  console.log(`📨  Tx hash: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(rc.status === 1 ? '✅  SUCCESS' : '❌  FAILED');
}

async function main() {
  const DustCollector_factory = await ethers.getContractFactory("DustCollectorUniversalPermit2");
  const DustCollector = await DustCollector_factory.attach(COLLECTOR);
  const signer = await ethers.provider.getSigner();
  let msgFee = 0n;
  let arbiterFee = 0n;
  const core = new ethers.Contract(WORMHOLE_CORE, CORE_ABI, ethers.provider);
  msgFee = await core.messageFee();
  console.log(`📦 MessageFee: ${msgFee.toString()} wei`);

  // 例子1: 2个token通过swap转为一个token， 下面例子具体是USDC跟DAI, 转为USDT
  // 实现步骤如下:
  // 1. 通过https://apptest.bolarity.xyz/router_api/quote
  //    查询得到USDC转USDT的fees跟tokens, version,
  //    查询得到DAI转USDT的fees跟tokens, version,
  // 2. 构造TOKENS数组
  let TOKENS = [
  {
    addr :  USDC,
    dec  :  6,
    amt  :  '1', // 要转的金额，这里的1,代表1 USDC
    amtWei: 0n,
    fee  : [100], // 查询得到的fees
    path : [USDC, USDT], // 查询得到的tokens
    version : "V3",
  },
  {
    addr :  DAI,
    dec  :  18,
    amt  :  '0.1', // 要转的金额，这里的0.1,代表1 DAI
    amtWei: 0n,
    fee  : [100], // 查询得到的fees
    path : [DAI, USDT], // 查询得到的tokens
    version : "V3",
  },
];

  await swap(DustCollector, TOKENS, signer, USDT, 0, ethers.ZeroHash, arbiterFee, msgFee + arbiterFee);
//   // USDC-WETH-DAI
//   let TOKENS = [
//   {
//     addr :  USDC,
//     dec  :  6,
//     amt  :  '1',
//     amtWei: 0n,
//     fee  : [100, 3000],
//     path : [USDC, WETH, AAVE]
//   },
// ];
//   // USDT-WETH
//   let TOKENS = [
//   {
//     addr :  USDT,
//     dec  :  6,
//     amt  :  '0.9',
//     amtWei: 0n,
//     fee  : [500],
//     path : [USDT, WETH]
//   },
// ];

  // 跨链到solana
  // const userATA = getAssociatedTokenAddressSync(
  //     new PublicKey("EfqRM8ZGWhDTKJ7BHmFvNagKVu3AxQRDQs8WMMaoBCu6"), // wormhole USDC mint
  //     new PublicKey("HD4ktk6LUewd5vMePdQF6ZtvKi3mC41AD3ZM3qJW8N8e"),
  //     true,
  // );
  // await swap(DustCollector, TOKENS, signer, USDC, 1, toBytes32(userATA.toBase58()), arbiterFee, msgFee + arbiterFee);

}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
