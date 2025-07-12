import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from 'dotenv'
dotenv.config()

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  solidity: "0.8.24",
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      chainId: 1,
      forking: {
        url: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
        blockNumber: 20010000,
      },
    },
    sepolia: {
          url: process.env.EVM_RPC!,
          chainId: 11155111,
          accounts: [
              process.env.PRIVATE!,
          ]
    },
    base: {
          url: process.env.EVM_RPC!,
          chainId: 8453,
          accounts: [
              process.env.PRIVATE!,
          ]
    },
  },
};
export default config;