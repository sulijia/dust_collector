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
import { fetchQuote, 	addresses,
	swapFromEvm,
	type Erc20Permit,
	type Quote,
    getSwapFromEvmTxPayload, } from "@mayanfinance/swap-sdk";

const USDC  = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH  = "0x4200000000000000000000000000000000000006";
const DAI   = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
const USDT  = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const AAVE  = "0x63706e401c06ac8513145b7687a14804d17f814b";


const PERMIT2       = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
// const COLLECTOR     = "0xC53C1B0a0C1bfa059A6aB6A7C3e27271e35Be0D3"; // mayan version
const COLLECTOR     = "0xd961047a7e9cDACe82d131e9B98a7de103c5852E";
const USDC_MINT     = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const UNIVERSAL_ROUTER = "0x6ff5693b99212da76ad316178a184ab56d299b43";
/* ---------- ABI ---------- */
const ERC20_ABI = [
  'function approve(address,uint256) external returns (bool)',
  'function allowance(address,address) view returns (uint256)'
];

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
async function swap(DustCollector, TOKENS, signer, targetToken, dstChain,dstDomain, recipient, value,permitParams,mayanProtocol,protocolData, estimatedCost) {
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
	// protocolData =   abi.encode(
    //       [ 'bytes'],
    //       [protocolData]
    //     )
	// protocolData = '0x' + protocolData;
  commands  = '0x' + commands;

  const deadline = Math.floor(Date.now() / 1e3) + 1800;  // 30 分钟

  /* ---------- 3. pullTokens & pullAmounts ---------- */
  const pullTokens  = TOKENS.map(t => t.addr);
  const pullAmounts = TOKENS.map(t => t.amtWei);

  /* ---------- 4. 调 DustCollector ---------- */
  console.log('⏳  Sending transaction …');
  console.log(
	 {
        commands,
        inputs,
        deadline,
        targetToken: targetToken,
        dstChain:    dstChain,
        recipient:   recipient,
		permitParams: permitParams,
        mayanProtocol:mayanProtocol,
        protocolData:protocolData,
        estimatedCost: estimatedCost
    }
  );
  const tx = await DustCollector.batchCollectWithUniversalRouter(
    {
        commands,
        inputs,
        deadline,
        targetToken: targetToken,
        dstChain:    dstChain,
        recipient:   recipient,
		permitParams: permitParams,
        mayanProtocol:mayanProtocol,
        protocolData:protocolData,
        estimatedCost: estimatedCost
    },
    pullTokens,
    pullAmounts,
    { value: value }
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
// 	const DustCollector = await ethers.deployContract("DustCollectorUniversalPermit2Mayan", 
//     [UNIVERSAL_ROUTER, PERMIT2,"0x337685fdaB40D39bd02028545a4FfA7D287cC3E2", "0x52389e164444e68178ABFa97d32908f00716A408"]
// 	);
  
//   await DustCollector.waitForDeployment();
  
//   console.log(
//     `deployed to ${DustCollector.target}`
//   );
  const DustCollector_factory = await ethers.getContractFactory("DustCollectorUniversalPermit2Mayan");
  const DustCollector = await DustCollector_factory.attach(COLLECTOR);
  const signer = await ethers.provider.getSigner();
  // 例子1: 1个token通过swap转为一个token， 下面例子具体是USDT转为USDT,并通过CCTP协议跨链到SOLANA
  // 实现步骤如下:
  // 1. 通过https://apptest.bolarity.xyz/router_api/quote
  //    查询得到USDT转USDC的fees跟tokens, version,
  // 2. 构造TOKENS数组(如果是多个tokenswap成一个token，则数组成员相应的填充多个token信息)
  let TOKENS = [
  {
    addr :  USDC,
    dec  :  6,
    amt  :  '3', // 要转的金额，这里的0.01,代表0.011 USDT
    amtWei: 0n,
    fee  : [100], // 查询得到的fees
    path : [USDC, USDC], // 查询得到的tokens
    version : "V3",
  },
];
    let dstChain = 1; // 要跨跨链的目标链ID,如果为0,则不跨链，具体的值可参考 https://wormhole.com/docs/products/reference/chain-ids/
    let dstDomain = 5; // https://developers.circle.com/cctp/supported-domains
    let srcChain = 30; // 要跨跨链的源链ID，具体的值可参考 https://wormhole.com/docs/products/reference/chain-ids/
    let recipient = "HD4ktk6LUewd5vMePdQF6ZtvKi3mC41AD3ZM3qJW8N8e"; // 跨链到的目标链地址
    let recipientBytes32 = ethers.ZeroHash;
    let estimatedCost = 0n;
	let permitParams;
	let mayanProtocol;
	let protocolData;
    if(dstChain != 0) { //需要跨链
		const quotes = await fetchQuote({
			fromChain: 'base',
			toChain: 'solana',
			fromToken: USDC,
			toToken: USDC_MINT,
			amountIn64: "3000000",
			slippageBps: "auto"
		});
		const quote = quotes[0];
		// console.log(quote);
		if(dstChain == 1) { // SOLANA
			const swapRes = await getSwapFromEvmTxPayload(
				quote,
				COLLECTOR,
				recipient,
				null,
				COLLECTOR,
				8453,
				null,
				null,
			)
			// console.log(swapRes);
			console.log(swapRes._forwarder.params[2])
			console.log(swapRes._forwarder.params[3])
			console.log(swapRes._forwarder.params[4])
			permitParams = swapRes._forwarder.params[2];
			mayanProtocol = swapRes._forwarder.params[3];
			protocolData = swapRes._forwarder.params[4]
		}
	}

  await swap(DustCollector, TOKENS, signer, USDC, dstChain, dstDomain, recipientBytes32, estimatedCost,
	permitParams,mayanProtocol,protocolData,  estimatedCost);
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
