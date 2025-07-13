import { MaxUint256 } from "@uniswap/sdk-core";
import { ethers } from "hardhat";
import {encodePathAndFee} from "../test/helper"
import { FeeAmount } from "@uniswap/v3-sdk";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    PublicKey,
} from "@solana/web3.js";
import axios from 'axios';

const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH  = "0x4200000000000000000000000000000000000006";
const DAI   = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const USDT  = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const AAVE  = "0x63706e401c06ac8513145b7687a14804d17f814b";


const PERMIT2       = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// const COLLECTOR     = "0x0d6997d96bB769FFB6C755f6d3d04Fa6DF95AA71";
const COLLECTOR     = "0x35407375AC1f0b51B90A5ad28a4A73F3FD35E717";
// const COLLECTOR     = "0xa124646027Dcd8F04aE25e67fE06FC34980650eE"; raw
const WORMHOLE_CORE = "0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";

/* ---------- ABI ---------- */
const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

const PERMIT2_ABI = [
  // returns (uint160 amount, uint48 expiration, uint48 nonce)
  'function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)',
  'function approve(address token,address spender,uint160 amount,uint48 expiration) external'
];

// function base58Decode(str) {
//   const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
//   let result = 0n;
//   for (let i = 0; i < str.length; i++) {
//     const index = alphabet.indexOf(str[i]);
//     if (index === -1) throw new Error('Invalid base58 character');
//     result = result * 58n + BigInt(index);
//   }
  
//   const bytes = [];
//   while (result > 0n) {
//     bytes.unshift(Number(result % 256n));
//     result = result / 256n;
//   }
  
//   for (let i = 0; i < str.length && str[i] === '1'; i++) {
//     bytes.unshift(0);
//   }
//   console.log(bytes);
//   return new Uint8Array(bytes);
// }

// function toBytes32(addr) {
//   if (!addr || addr.trim() === '') return ethers.ZeroHash;
  
//   addr = addr.trim();
  
//   if (addr.startsWith('0x')) {
//     return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
//   } else if (addr.length === 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(addr)) {
//     // Solana 地址
//     const decoded = base58Decode(addr);
//     if (decoded.length !== 32) throw new Error(`Invalid Solana address length: ${decoded.length}`);
//     return '0x' + Array.from(decoded).map(b => b.toString(16).padStart(2, '0')).join('');
//   } else {
//     const hex = addr.replace(/^0x/, '');
//     if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`Invalid address format: ${addr}`);
//     return '0x' + hex.toLowerCase().padStart(64, '0');
//   }
// }
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

async function swap(DustCollector, TOKENS, signer, targetToken, dstChain, recipient, arbiterFee, value, isToETH:boolean, signedQuote, relayInstructions, estimatedCost) {
  const abi      = ethers.AbiCoder.defaultAbiCoder();
  for (const tk of TOKENS) {
    tk.amtWei = ethers.parseUnits(tk.amt, tk.dec);
    await ensurePermit2(tk.addr, signer, tk.amtWei);
  }

  let commands = '';
  const inputs   = [];
  for (const tk of TOKENS) {
    commands += '00';
    inputs.push(
    abi.encode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool'],
      [COLLECTOR, tk.amtWei, 0, encodePathAndFee(tk.path, tk.fee), false]
    )
    );
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
  console.log(    {
        commands,
        inputs,
        deadline,
        targetToken: targetToken,
        dstChain:    dstChain,
        dstDomain:   0,
        recipient:   recipient,
        arbiterFee:  arbiterFee,
        destinationCaller: DESTINATION_CALLER,
        maxFee: MAX_FEE,
        minFinalityThreshold: MIN_FINALITY_THRESHOLD,
        executorArgs: {
            refundAddress: signer.address,
            signedQuote: signedQuote,
            instructions: relayInstructions
        },
        feeArgs: {
          dbps: FEE_DBPS,
          payee: FEE_PAYEE
        },
        estimatedCost: estimatedCost
    });
  const tx = await DustCollector.batchCollectWithUniversalRouter(
    {
        commands,
        inputs,
        deadline,
        targetToken: targetToken,
        dstChain:    dstChain,
        dstDomain:   0,
        recipient:   recipient,
        arbiterFee:  arbiterFee,
        destinationCaller: DESTINATION_CALLER,
        maxFee: MAX_FEE,
        minFinalityThreshold: MIN_FINALITY_THRESHOLD,
        executorArgs: {
            refundAddress: signer.address,
            signedQuote: signedQuote,
            instructions: relayInstructions
        },
        feeArgs: {
          dbps: FEE_DBPS,
          payee: signer.address
        },
        estimatedCost: estimatedCost
    },
    pullTokens,
    pullAmounts,
    { value: estimatedCost }
  );

  console.log(`📨  Tx hash: ${tx.hash}`);
  const rc = await tx.wait();
  console.log(rc.status === 1 ? '✅  SUCCESS' : '❌  FAILED');
}
// 🔧 Base58 解码函数（仅用于 Solana 地址）
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
  for (let i = 0; i < str.length && str[i] === '1'; i++) bytes.unshift(0);
  return '0x' + Buffer.from(bytes).toString('hex').padStart(64, '0');
}

// 🔧 智能检测地址类型
function detectAddressType(address) {
  // 检测以太坊地址 (0x开头，42字符)
  if (ethers.isAddress(address)) {
    return 'ethereum';
  }
  
  // 检测 Solana 地址 (base58格式，32-44字符，不包含0、O、I、l)
  const solanaPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  if (solanaPattern.test(address)) {
    return 'solana';
  }
  
  // 检测 hex 格式
  if (address.startsWith('0x') && address.length === 66) {
    return 'hex';
  }
  
  return 'unknown';
}

// 🔧 将地址转换为 bytes32 格式
function addressToBytes32(address) {
  const addressType = detectAddressType(address);
  
  switch (addressType) {
    case 'ethereum':
      // 以太坊地址 20 bytes -> 32 bytes (左填充 0)
      const cleanAddr = address.toLowerCase().replace('0x', '');
      return '0x' + '000000000000000000000000' + cleanAddr;
      
    case 'solana':
      // Solana 地址通过 base58 解码得到 32 bytes
      return base58Decode(address);
      
    case 'hex':
      // 已经是 hex 格式，确保是 32 bytes
      return '0x' + address.replace('0x', '').padStart(64, '0');
      
    default:
      throw new Error(`Unsupported address format: ${address}. Expected Ethereum (0x...) or Solana (base58) address.`);
  }
}
// 🆕 模式选择配置
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'gas'; // 'gas' 或 'drop'
const DESTINATION_CALLER = process.env.DESTINATION_CALLER || ethers.ZeroHash;
const MAX_FEE = BigInt(process.env.MAX_FEE || '100');
const MIN_FINALITY_THRESHOLD = parseInt(process.env.MIN_FINALITY_THRESHOLD || '0');
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '500000'); // gas drop 模式的 gas limit
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1000000'); // Solana 专用 gas limit (CU)
const EXECUTOR_API   = process.env.EXECUTOR_API || 'https://executor.labsapis.com';
const FEE_DBPS = parseInt(process.env.FEE_DBPS || '0');
const FEE_PAYEE = process.env.FEE_PAYEE || ethers.ZeroHash;
// 🔧 修正的序列化函数 - 支持两种模式
function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing for destination chain: ${apiDstChain}`);
  console.log(`🎯 Execution Mode: ${mode.toUpperCase()}`);
  
  if (mode === 'drop') {
    // 🔄 模式1: GasDropOffInstruction - 自动gas发送到指定地址
    if (apiDstChain === 1) {
      // Solana: 使用 GasInstruction（Solana 不支持 dropOff）
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0');
      const recipientHex = addressToBytes32(recipient).replace('0x', '');
      return '0x02' +                              // Type 1: GasDropOffInstruction
             dropOffHex +                        // gasLimit: 动态设置的 CU (16 bytes)
             recipientHex;   // msgValue: 0 (16 bytes)
    } else {
      // EVM 链: 使用 GasDropOffInstruction
      console.log(`🔧 Using GasDropOffInstruction for EVM chain`);
      
      // 将 gas limit 转换为16字节的十六进制
      const dropOffHex = GAS_DROP_LIMIT.toString(16).padStart(32, '0'); // 16 bytes
      
      // 确保 recipient 是正确的 32 bytes 格式
      const recipientHex = addressToBytes32(recipient).replace('0x', '');
      
      const result = '0x02' + dropOffHex + recipientHex;
      
      console.log(`🔧 DropOff (16 bytes): ${dropOffHex} (${GAS_DROP_LIMIT} gas)`);
      console.log(`🔧 Recipient (32 bytes): ${recipientHex}`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 130)`);
      
      return result;
    }
  } else {
    // 🚀 模式2: GasInstruction - 需要手动deposit gas
    console.log(`🔧 Using GasInstruction mode (manual gas required)`);
    
    let gasLimit;
    if (apiDstChain === 1) {
      // Solana: 使用更高的计算单位 - 1,000,000 CU
      gasLimit = SOLANA_GAS_LIMIT.toString(16).padStart(32, '0'); // 动态设置

      const result = '0x01' +                        // Type 1: GasInstruction
             gasLimit +                              // gasLimit: 16 bytes
             '000000000000000000000000000f4240';    //manually set to 1,000,000 CU

      console.log(`🔧 Solana gasLimit: ${SOLANA_GAS_LIMIT} CU`);
      console.log(`🔧 EVM gasLimit: 200,000 gas`);
      console.log(`🔧 GasLimit (16 bytes): ${gasLimit}`);
      console.log(`🔧 MsgValue (16 bytes): 000000000000000000000000000f4240`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 66)`);
      return  result;
    } else {
      // EVM limited: 200,000 gas 
      gasLimit = '00000000000000000000000000030d40'; // 200,000 gas

      const result = '0x01' +                        // Type 1: GasInstruction
                     gasLimit +                      // gasLimit: 16 bytes
                     '00000000000000000000000000000000'; // msgValue: 0 (16 bytes)
      console.log(`🔧 EVM gasLimit: 200,000 gas`);
      console.log(`🔧 GasLimit (16 bytes): ${gasLimit}`);
      console.log(`🔧 MsgValue (16 bytes): 00000000000000000000000000000000`);
      console.log(`🔧 Final relayInstructions: ${result}`);
      console.log(`🔧 Total length: ${result.length} chars (should be 66)`);

      return result;
    }
    

  }
}



// 🔧 修正的 API 调用函数
async function getQuoteFromExecutor(apiSrcChain, apiDstChain, recipient) {
  const relayInstructions = serializeRelayInstructions(apiDstChain, recipient);
  
  const requestPayload = {
    srcChain: apiSrcChain,
    dstChain: apiDstChain,
    relayInstructions
  };
  
  console.log('🔍 API Request:', JSON.stringify(requestPayload, null, 2));
  
  try {
    const res = await axios.post(`${EXECUTOR_API}/v0/quote`, requestPayload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log('✅ API Response received');
    console.log('📊 Estimated cost:', res.data.estimatedCost || 'N/A');
    
    return {
      signedQuote: res.data.signedQuote,
      relayInstructions,
      estimatedCost: BigInt(res.data.estimatedCost || '0')
    };
  } catch (error) {
    console.error('\n❌ ====== API ERROR DETAILS ======');
    console.error('Status:', error.response?.status);
    console.error('Data:', error.response?.data);
    console.error('Request Data:', JSON.stringify(requestPayload, null, 2));
    console.error('================================\n');
    throw error;
  }
}

async function main() {
    let apiSrcChain = 30;
    let apiDstChain = 1;
    const { signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
      apiSrcChain,
      apiDstChain,
      "HD4ktk6LUewd5vMePdQF6ZtvKi3mC41AD3ZM3qJW8N8e"  // 传递原始地址，函数内部会处理转换
    );
// const DustCollector = await ethers.deployContract("DustCollectorUniversalPermit2CCTPRaw", 
//     [UNIVERSAL_ROUTER, PERMIT2, "0xbd8d42f40a11b37bD1b3770D754f9629F7cd5679",  "0x52389e164444e68178ABFa97d32908f00716A408"]
// );
  
//   await DustCollector.waitForDeployment();
  
//   console.log(
//     `deployed to ${DustCollector.target}`
//   );
  const DustCollector_factory = await ethers.getContractFactory("DustCollectorUniversalPermit2CCTP");
  const DustCollector = await DustCollector_factory.attach(COLLECTOR);
  const signer = await ethers.provider.getSigner();
  let msgFee = 0n;
  let arbiterFee = 0n;
//   // USDT-USDC
  let TOKENS = [
  {
    addr :  USDT,
    dec  :  6,
    amt  :  '1',
    amtWei: 0n,
    fee  : [100],
    path : [USDT, USDC]
  },
];
  const userATA = getAssociatedTokenAddressSync(
      new PublicKey("EfqRM8ZGWhDTKJ7BHmFvNagKVu3AxQRDQs8WMMaoBCu6"), // wormhole USDC mint
      new PublicKey("HD4ktk6LUewd5vMePdQF6ZtvKi3mC41AD3ZM3qJW8N8e"),
      true,
  );
  await swap(DustCollector, TOKENS, signer, USDC, apiDstChain, base58Decode(userATA.toBase58()), arbiterFee, msgFee + arbiterFee, false, 
    signedQuote, relayInstructions, estimatedCost);
// console.log(await DustCollector.cctp());
//   USDC-WETH-DAI
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
// await swap(DustCollector, TOKENS, signer, AAVE, 0, ethers.ZeroHash, arbiterFee, msgFee + arbiterFee, false);
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
