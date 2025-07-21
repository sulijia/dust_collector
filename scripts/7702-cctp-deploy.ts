import { MaxUint256 } from "@uniswap/sdk-core";
import { ethers } from "hardhat";
import {encodePathAndFee} from "../test/helper"
import { FeeAmount } from "@uniswap/v3-sdk";
import {getAssociatedTokenAddressSync} from "@solana/spl-token";
import {
    PublicKey,
} from "@solana/web3.js";
import axios from 'axios';
import { serialize } from 'binary-layout';
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import {
  getPermitSignature, PermitSingle,PermitBatch, PermitDetails,getPermitBatchSignature,
  signPermit
} from '../test/permit2'
import { abi as PERMIT2_ABI } from '../test/permit2/src/interfaces/IPermit2.sol/IPermit2.json'
import {abi as CCTP7702} from './DustCollector7702CCTP.json'

const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH  = "0x4200000000000000000000000000000000000006";
const DAI   = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const USDT  = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const AAVE  = "0x63706e401c06ac8513145b7687a14804d17f814b";


const PERMIT2       = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const COLLECTOR     = "0x6094Fe8437dd5853B928F40A278c0cDFBf629014";
const USDC_MINT     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/* ---------- ABI ---------- */
const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

async function delegateToContract(wallet, provider, targetContract) {
    console.log('\n🔗 ====== EIP-7702 DELEGATION PROCESS ======');
    
    const code = await provider.getCode(wallet.address);
    
    if (code !== "0x") {
      if (code.startsWith("0xef0100")) {
        const currentDelegation = "0x" + code.slice(8);
        console.log("⚠️  EOA currently delegated to:", currentDelegation);
        
        if (currentDelegation.toLowerCase() === targetContract.toLowerCase()) {
          console.log("✅ Already delegated to target contract. Ready to proceed!");
          return true;
        }
      }
    } else {
      console.log("📋 EOA has no current delegation. Will delegate now...");
    }

    const contractCode = await provider.getCode(targetContract);
    if (contractCode === "0x") {
      throw new Error("Target address is not a contract");
    }

    const network = await provider.getNetwork();
    const currentNonce = await wallet.getNonce();
    
    console.log("Network Chain ID:", network.chainId);
    console.log("Delegating EOA to:", targetContract);

    const authorization = await wallet.authorize({
      address: targetContract,
      nonce: currentNonce + 1,
      chainId: network.chainId,
    });
    // TIP:前端需要签名
    const tx = await wallet.sendTransaction({
      type: 4,
      to: wallet.address,
      authorizationList: [authorization],
    });

    console.log("✅ Sent delegate tx:", tx.hash);
    const receipt = await tx.wait();
    console.log("✅ Confirmed in block:", receipt.blockNumber);

    await new Promise(resolve => setTimeout(resolve, 3000));

    let retries = 0;
    const maxRetries = 5;
    
    while (retries < maxRetries) {
      const newCode = await provider.getCode(wallet.address);
      
      if (newCode.startsWith("0xef0100")) {
        const delegatedTo = "0x" + newCode.slice(8);
        if (delegatedTo.toLowerCase() === targetContract.toLowerCase()) {
          console.log("✅ Delegation successful! Delegated to:", delegatedTo);
          console.log("🎉 EIP-7702 delegation completed successfully!");
          return true;
        }
      }
      
      retries++;
      if (retries < maxRetries) {
        console.log(`⏳ Retry ${retries}/${maxRetries} - waiting for state update...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    throw new Error("Failed to verify delegation");
  }
// 参数:
// DustCollector: cctp 版本dust collector 合约
// TOKENS: 需要swap的token数组信息
// signer:签名钱包
// targetToken: 要swap成什么token
// dstChain: 如果需要跨链，这里是目标链的chain id,为0不需要跨链
// dstDomain
// recipient: 如果需要跨链，这里是另一条链上的接收地址,为ZeroHash不需要跨链
// arbiterFee: 给relayer的费用，一般可以为0
// value: 需要转的eth，看具体场景取值
// signedQuote, relayInstructions, estimatedCost:调用接口得到的返回值
async function swap(TOKENS, signer, targetToken, dstChain,dstDomain, recipient, arbiterFee, value, signedQuote, relayInstructions, estimatedCost) {
  const abi      = ethers.AbiCoder.defaultAbiCoder();
  await delegateToContract(signer, signer.provider, COLLECTOR)
  let commands = '';
  const inputs   = [];
  for (const tk of TOKENS) {
    tk.amtWei = ethers.parseUnits(tk.amt, tk.dec);
    if(tk.version == "V3") {
      commands += '00';
      inputs.push(
        abi.encode(
          ['address', 'uint256', 'uint256', 'bytes', 'bool'],
          [signer.address, tk.amtWei, 0, encodePathAndFee(tk.path, tk.fee), false]
        )
      );
    } else if(tk.version == "V2") {
        commands += '08';
        inputs.push(
          abi.encode(
            ['address', 'uint256', 'uint256', 'address[]', 'bool'],
            [signer.address, tk.amtWei, 0, tk.path, false]
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
  const DustCollectorContract = new ethers.Contract(signer.address, CCTP7702, signer);
  const tx = await DustCollectorContract.batchCollectWithUniversalRouter7702(
    {
        commands,
        inputs,
        deadline,
        targetToken: targetToken,
        dstChain:    dstChain,
        dstDomain:   dstDomain,
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
    },
    pullTokens,
    pullAmounts,
    { value: value}
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
const EXECUTION_MODE = process.env.EXECUTION_MODE || 'drop'; // 'gas' 或 'drop'
const DESTINATION_CALLER = process.env.DESTINATION_CALLER || ethers.ZeroHash;
const MAX_FEE = BigInt(process.env.MAX_FEE || '100');
const MIN_FINALITY_THRESHOLD = parseInt(process.env.MIN_FINALITY_THRESHOLD || '0');
const GAS_DROP_LIMIT = BigInt(process.env.GAS_DROP_LIMIT || '1000000'); // gas drop 模式的 gas limit
const SOLANA_GAS_LIMIT = BigInt(process.env.SOLANA_GAS_LIMIT || '1000000'); // Solana 专用 gas limit (CU)
const SOLANA_GAS_DROP = BigInt(process.env.SOLANA_GAS_DROP || '500000');
const EXECUTOR_API   = process.env.EXECUTOR_API || 'https://executor.labsapis.com';
const FEE_DBPS = parseInt(process.env.FEE_DBPS || '0');
const FEE_PAYEE = process.env.FEE_PAYEE || ethers.ZeroAddress;

// 🔧 Binary Layout Definitions
// Custom conversion for hex strings (JavaScript version)
const hexConversion = {
  to: (encoded) => {
    return `0x${Buffer.from(encoded).toString('hex')}`;
  },
  from: (decoded) => {
    const hex = decoded.startsWith('0x') ? decoded.slice(2) : decoded;
    return Uint8Array.from(Buffer.from(hex, 'hex'));
  },
};

// Define instruction layouts according to official spec
const gasInstructionLayout = [
  { name: "gasLimit", binary: "uint", size: 16 },
  { name: "msgValue", binary: "uint", size: 16 },
];

const gasDropOffInstructionLayout = [
  { name: "dropOff", binary: "uint", size: 16 },
  { name: "recipient", binary: "bytes", size: 32, custom: hexConversion },
];

const relayInstructionLayout = [
  {
    name: "request",
    binary: "switch",
    idSize: 1,
    idTag: "type",
    layouts: [
      [[1, "GasInstruction"], gasInstructionLayout],
      [[2, "GasDropOffInstruction"], gasDropOffInstructionLayout],
    ],
  },
];

const relayInstructionsLayout = [
  {
    name: "requests",
    binary: "array",
    layout: relayInstructionLayout,
  },
];
// 🔧 Serialization using binary-layout (MODIFIED to support multiple instructions)
function serializeRelayInstructions(apiDstChain, recipient, mode = EXECUTION_MODE) {
  console.log(`🔧 Serializing relay instructions with binary-layout...`);
  console.log(`   📍 Destination chain: ${apiDstChain}`);
  console.log(`   🎯 Execution mode: ${mode.toUpperCase()}`);
  
  let instructions = [];
  
  if (mode === 'drop') {
    // Mode 1: GasDropOffInstruction - auto gas delivery
    console.log(`   📦 Using GasDropOffInstruction for ${apiDstChain === 1 ? 'Solana' : 'EVM'} chain`);
    const recipientBytes32 = addressToBytes32(recipient);
    
    // Use appropriate gas limit based on destination chain
    const dropOffAmount = apiDstChain === 1 ? SOLANA_GAS_DROP : GAS_DROP_LIMIT;
    
    // 1. Add GasDropOffInstruction
    instructions.push({
      request: {
        type: "GasDropOffInstruction",
        dropOff: dropOffAmount,
        recipient: recipientBytes32
      }
    });
    
    // 2. 🆕  also add GasInstruction to set compute unit limit
    if (apiDstChain === 1) {
      console.log(`   🚀 Adding GasInstruction for Solana compute unit limit`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,  // 1.4M CU
          msgValue: 5000000n  // msg value needed
        }
      });
    }else {
      console.log(`  🚀 Adding GasInstruction for for EVM chain`);
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 400000n,  // gas, arb 252,206  eth 199,635
          msgValue: 0n        // No msg value
        }
      });
    }
    
    console.log(`   💸 Drop off amount: ${dropOffAmount} ${apiDstChain === 1 ? 'lamports' : 'gas'}`);
    console.log(`   📍 Recipient: ${recipient}`);
    if (apiDstChain === 1) {
      console.log(`   💻 Compute Unit Limit: ${SOLANA_GAS_LIMIT} CU`);
    }
    
  } else {
    // Mode 2: GasInstruction - manual gas deposit required
    console.log(`   🚀 Using GasInstruction (manual gas deposit required)`);
    
    if (apiDstChain === 1) {
      // Solana: Higher compute units
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: SOLANA_GAS_LIMIT,
          msgValue: 5000000n // 1M lamports
        }
      });
    } else {
      // EVM chains: Standard gas limit
      instructions.push({
        request: {
          type: "GasInstruction",
          gasLimit: 200000n, // 200k gas
          msgValue: 0n       // No msg value
        }
      });
    }
  }
  
  // Create the instructions array
  const relayInstructions = {
    requests: instructions  // Now supports multiple instructions
  };
  
  // Serialize using binary-layout
  const serialized = serialize(relayInstructionsLayout, relayInstructions);
  const result = '0x' + Buffer.from(serialized).toString('hex');
  
  // Log details
  console.log(`   📊 Total instructions: ${instructions.length}`);
  instructions.forEach((inst, index) => {
    const instructionType = inst.request.type;
    console.log(`   📋 Instruction ${index + 1}:`);
    console.log(`      - Type: ${instructionType}`);
    if (instructionType === "GasInstruction") {
      console.log(`      - Gas Limit: ${inst.request.gasLimit}`);
      console.log(`      - Msg Value: ${inst.request.msgValue}`);
    } else {
      console.log(`      - Drop Off: ${inst.request.dropOff}`);
      console.log(`      - Recipient: ${inst.request.recipient}`);
    }
  });
  console.log(`   📝 Serialized: ${result}`);
  console.log(`   📏 Length: ${result.length} chars`);
  
  return result;
}



// 🔧 Get quote from executor API
async function getQuoteFromExecutor(apiSrcChain, apiDstChain, recipient) {
  const relayInstructions = serializeRelayInstructions(apiDstChain, recipient);
  
  const requestPayload = {
    srcChain: apiSrcChain,
    dstChain: apiDstChain,
    relayInstructions
  };
  
  console.log('\n📤 Requesting quote from executor...');
  console.log('🔍 API Request:', JSON.stringify(requestPayload, null, 2));
  
  try {
    const res = await axios.post(`${EXECUTOR_API}/v0/quote`, requestPayload, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    
    console.log('✅ Quote received successfully');
    console.log(`📊 Estimated cost: ${res.data.estimatedCost || 'N/A'} wei`);
    
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
  const signer = await ethers.provider.getSigner();
  let arbiterFee = 0n;
  // 例子1: 1个token通过swap转为一个token， 下面例子具体是USDT转为USDT,并通过CCTP协议跨链到SOLANA
  // 实现步骤如下:
  // 1. 通过https://apptest.bolarity.xyz/router_api/quote
  //    查询得到USDT转USDC的fees跟tokens, version,
  // 2. 构造TOKENS数组(如果是多个tokenswap成一个token，则数组成员相应的填充多个token信息)
  let TOKENS = [
  {
    addr :  USDC,
    dec  :  6,
    amt  :  '0.01', // 要转的金额，这里的0.01,代表0.011 USDT
    amtWei: 0n,
    fee  : [100], // 查询得到的fees
    path : [USDC, USDT], // 查询得到的tokens
    version : "V3",
  },
];
    let dstChain = 0; // 要跨跨链的目标链ID,如果为0,则不跨链，具体的值可参考 https://wormhole.com/docs/products/reference/chain-ids/
    let dstDomain = 0; // https://developers.circle.com/cctp/supported-domains
    let srcChain = 30; // 要跨跨链的源链ID，具体的值可参考 https://wormhole.com/docs/products/reference/chain-ids/
    let recipient = "0x1Cdc84ba2A54F50997dDB06B0a6DfCb4868DB098"; // 跨链到的目标链地址
    let recipientBytes32 = ethers.ZeroHash;
    let signedQuote = "0x00";
    let relayInstructions = "0x00";
    let estimatedCost = 0n;
    if(dstChain != 0) { //需要跨链
        ({ signedQuote, relayInstructions, estimatedCost } = await getQuoteFromExecutor(
          srcChain,
          dstChain,
          recipient
        ));
      if(dstChain == 1) { // SOLANA
          const userATA = getAssociatedTokenAddressSync(
            new PublicKey(USDC_MINT), // USDC mint
            new PublicKey(recipient),
            true,
          );
        recipient = userATA.toBase58();
      }
      recipientBytes32 = addressToBytes32(recipient);
    }
  estimatedCost = estimatedCost;
  await swap(TOKENS, signer, USDT, dstChain, dstDomain, recipientBytes32, arbiterFee, arbiterFee + estimatedCost,
    signedQuote, relayInstructions, estimatedCost);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
