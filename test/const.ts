import { Currency, Token, WETH9 } from '@uniswap/sdk-core'

export const ALICE_ADDRESS = '0x28c6c06298d514db089934071355e5743bf21d60'
export const DAI = new Token(1, '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, 'DAI', 'Dai Stablecoin');
export const WETH = WETH9[1]
export const USDC = new Token(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'USDC', 'USD//C')
// Router Helpers
export const MAX_UINT = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
export const MAX_UINT128 = '0xffffffffffffffffffffffffffffffff'
export const MAX_UINT160 = '0xffffffffffffffffffffffffffffffffffffffff'
export const DEADLINE = 2000000000

// Constructor Params
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const V2_FACTORY_MAINNET = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f'
export const V3_FACTORY_MAINNET = '0x1F98431c8aD98523631AE4a59f267346ea31F984'
export const V3_INIT_CODE_HASH_MAINNET = '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54'
export const V2_INIT_CODE_HASH_MAINNET = '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f'
export const V3_NFT_POSITION_MANAGER_MAINNET = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88'
export const V4_POSITION_DESCRIPTOR_ADDRESS = '0x0000000000000000000000000000000000000000' // TODO, deploy this in-line and use the proper address in posm's constructor
export const WETH_MAINNET = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'

export const WORMHOLE_CORE_ADDRESS = '0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B'
export const WORMHOLE_BRIDGE_ADDRESS = '0x3ee18B2214AFF97000D974cf647E7C347E8fa585'
export const WORMHOLE_CCTP_ADDRESS = '0x2703483B1a5a7c577e8680de9Df8Be03c6f30e3c'
export const ChainId = 1

export declare enum FeeAmount {
    LOWEST = 100,
    LOW = 500,
    MEDIUM = 3000,
    HIGH = 10000
}