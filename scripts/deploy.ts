import { ethers } from "hardhat";

async function main() {
    const DustCollector = await ethers.deployContract("DustCollectorUniversalPermit2",
      ["0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
        "0x4a8bc80Ed5a4067f1CCf107057b8270E0cC11A78",
        "0xDB5492265f6038831E89f495670FF909aDe94bd9",
        "0x000000000022D473030F116dDEE9F6B43aC78BA3",
      "0x1Cdc84ba2A54F50997dDB06B0a6DfCb4868DB098"]);

    await DustCollector.waitForDeployment();

    console.log(
      `deployed to ${DustCollector.target}`
    );
        // const receipt = await UniProxy.setRegisteredSender(SOLANA_CHAIN_ID, targetContractAddressHex);
    // console.log(receipt.hash)
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
