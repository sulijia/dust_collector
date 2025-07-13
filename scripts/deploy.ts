import { MaxUint256 } from "@uniswap/sdk-core";
import { ethers } from "hardhat";
import {encodePathAndFee} from "../test/helper"
import { FeeAmount } from "@uniswap/v3-sdk";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    PublicKey,
} from "@solana/web3.js";

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

const PERMIT2_ABI = [
  // returns (uint160 amount, uint48 expiration, uint48 nonce)
  'function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration) external'
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
/**
 * 为指定 token 确保：
 * ① ERC20 → Permit2 已授权；
 * ② Permit2 → Collector 已授权。
 */
async function ensurePermit2(token, owner, amount) {
  const erc20  = new ethers.Contract(token, ERC20_ABI  , owner);
  const permit = new ethers.Contract(PERMIT2, PERMIT2_ABI, owner);

  /* === 1. ERC20 → Permit2 === */
  const curErc20Allow = await erc20.allowance(owner.address, PERMIT2);
  if (curErc20Allow < amount) {
    console.log(`  · Approving ERC20 → Permit2   (${token})`);
    await (await erc20.approve(PERMIT2, ethers.MaxUint256)).wait();
  }

  /* === 2. Permit2 → DustCollector === */
  const [allowAmt] = await permit.allowance(owner.address, token, COLLECTOR);
  if (allowAmt < amount) {
    console.log(`  · Approving Permit2 → Collector (${token})`);
    const maxUint160 = (1n << 160n) - 1n;               // 2¹⁶⁰-1
    const expiration = Math.floor(Date.now() / 1e3) + 3600 * 24 * 30; // 30 天
    await (await permit.approve(token, COLLECTOR, maxUint160, expiration)).wait();
  }
}

async function swap(DustCollector, TOKENS, signer, targetToken, dstChain, recipient, arbiterFee, value, isToETH:boolean) {
  const abi      = ethers.AbiCoder.defaultAbiCoder();
  for (const tk of TOKENS) {
    tk.amtWei = ethers.parseUnits(tk.amt, tk.dec);
    await ensurePermit2(tk.addr, signer, tk.amtWei);
  }

  let commands = '';
  const inputs   = [];
  let index = 0;
  for (const tk of TOKENS) {
    commands += '00';
    inputs.push(
    abi.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [COLLECTOR, tk.amtWei, 0, encodePathAndFee(tk.path, tk.fee), false]
    )
    );
    index+=1;
  }

  commands  = '0x' + commands;
  if(isToETH) {
      // commands += '05';
      // inputs.push(
      //     abi.encode(
      //       ['address','address','uint256'],
      //       [WETH, COLLECTOR, 300000000000000]
      //     )
      // );
      commands += '0c';
      inputs.push(
          abi.encode(
            ['address','uint256'],
            [COLLECTOR, 0]
          )
      );
  }

  const deadline = Math.floor(Date.now() / 1e3) + 1800;  // 30 分钟

  /* ---------- 3. pullTokens & pullAmounts ---------- */
  const pullTokens  = TOKENS.map(t => t.addr);
  const pullAmounts = TOKENS.map(t => t.amtWei);

  /* ---------- 4. 调 DustCollector ---------- */
  console.log('⏳  Sending transaction …');
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
  // USDC-USDT
  let TOKENS = [
  {
    addr :  USDC,
    dec  :  6,
    amt  :  '1',
    amtWei: 0n,
    fee  : [100],
    path : [USDC, USDT]
  },
];
  // const userATA = getAssociatedTokenAddressSync(
  //     new PublicKey("EfqRM8ZGWhDTKJ7BHmFvNagKVu3AxQRDQs8WMMaoBCu6"), // wormhole USDC mint
  //     new PublicKey("HD4ktk6LUewd5vMePdQF6ZtvKi3mC41AD3ZM3qJW8N8e"),
  //     true,
  // );
  // await swap(DustCollector, TOKENS, signer, USDC, 1, toBytes32(userATA.toBase58()), arbiterFee, msgFee + arbiterFee);
  await swap(DustCollector, TOKENS, signer, USDT, 0, ethers.ZeroHash, arbiterFee, msgFee + arbiterFee, false);
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

//   await swap(DustCollector, TOKENS, signer, WETH, 0, ethers.ZeroHash, arbiterFee, msgFee + arbiterFee, true);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
