import hre from 'hardhat'
const { ethers } = hre
import { abi as PERMIT2_ABI } from './permit2/src/interfaces/IPermit2.sol/IPermit2.json'
const PoolManager = require('./@uniswap/v4-core/src/PoolManager.sol/PoolManager.json')
const UniversalRouter = require('./UniversalRouter/UniversalRouter.sol/UniversalRouter.json')
const PositionManager = require('./@uniswap/v4-periphery/src/PositionManager.sol/PositionManager.json')
import {
  V2_FACTORY_MAINNET,
  V3_FACTORY_MAINNET,
  V2_INIT_CODE_HASH_MAINNET,
  V3_INIT_CODE_HASH_MAINNET,
  PERMIT2_ADDRESS,
  V3_NFT_POSITION_MANAGER_MAINNET,
  V4_POSITION_DESCRIPTOR_ADDRESS,
  WETH_MAINNET,
  FeeAmount,
} from './const'

export async function deployV4PoolManager(owner: string): Promise<any> {
    const poolManagerFactory = await ethers.getContractFactory(PoolManager.abi, PoolManager.bytecode)
    const poolManager = (await poolManagerFactory.deploy(owner)) as unknown as any
    return poolManager
  }

export async function deployV4PositionManager(
    v4PoolManager: string,
    permit2: string,
    v4PositionDescriptor: string,
    weth: string
  ): Promise<any> {
    const positionManagerFactory = await ethers.getContractFactory(PositionManager.abi, PositionManager.bytecode)
    const positionManager = (await positionManagerFactory.deploy(
      v4PoolManager,
      permit2,
      50000,
      v4PositionDescriptor,
      weth
    )) as unknown as any
    return positionManager
}

export async function deployUniversalRouter(
  owner?: string,
  v4PoolManager?: string,
  mockReentrantWETH?: string,
): Promise<any> {
  let poolManager: string

  if (v4PoolManager) {
    poolManager = v4PoolManager
  } else if (owner !== undefined) {
    poolManager = await (await deployV4PoolManager(owner)).getAddress();
  } else {
    throw new Error('Either v4PoolManager must be set or owner must be provided')
  }
  const routerParameters = {
    permit2: PERMIT2_ADDRESS,
    weth9: mockReentrantWETH ?? '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    v2Factory: V2_FACTORY_MAINNET,
    v3Factory: V3_FACTORY_MAINNET,
    pairInitCodeHash: V2_INIT_CODE_HASH_MAINNET,
    poolInitCodeHash: V3_INIT_CODE_HASH_MAINNET,
    v4PoolManager: poolManager,
    v3NFTPositionManager: V3_NFT_POSITION_MANAGER_MAINNET,
    v4PositionManager: await(
      await deployV4PositionManager(poolManager, PERMIT2_ADDRESS, V4_POSITION_DESCRIPTOR_ADDRESS, WETH_MAINNET)
    ).getAddress(),
  }

  const routerFactory = await ethers.getContractFactory(UniversalRouter.abi, UniversalRouter.bytecode)
  const router = (await routerFactory.deploy(routerParameters)) as unknown as any
  return router
}
export const PERMIT2 = new ethers.Contract(PERMIT2_ADDRESS, PERMIT2_ABI)

export default deployUniversalRouter

export function getFeeTier(tokenA: string, tokenB: string): number {
  return 500;
}

const FEE_SIZE = 3

// v3
export function encodePath(path: string[]): string {
  let encoded = '0x'
  for (let i = 0; i < path.length - 1; i++) {
    // 20 byte encoding of the address
    encoded += path[i].slice(2)
    // 3 byte encoding of the fee
    encoded += getFeeTier(path[i], path[i + 1])
      .toString(16)
      .padStart(2 * FEE_SIZE, '0')
  }
  // encode the final token
  encoded += path[path.length - 1].slice(2)
  return encoded.toLowerCase();
}

export function encodePathExactInput(tokens: string[]): string {
  return encodePath(tokens)
}

// v3
export function encodePathAndFee(path: string[], fee: number[]): string {
  let encoded = '0x'
  for (let i = 0; i < path.length - 1; i++) {
    // 20 byte encoding of the address
    encoded += path[i].slice(2)
    // 3 byte encoding of the fee
    encoded += fee[i]
      .toString(16)
      .padStart(2 * FEE_SIZE, '0')
  }
  // encode the final token
  encoded += path[path.length - 1].slice(2)
  return encoded.toLowerCase();
}