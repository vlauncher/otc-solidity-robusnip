const hre = require("hardhat");

async function main() {
  // Get the deployer account (works for any network)
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying from:", deployer.address);

  // Deploy the contract (replace "P2PTokenEscrow" with your contract name)
  const P2PTokenEscrow = await hre.ethers.getContractFactory("P2PTokenEscrow");
  const escrow = await P2PTokenEscrow.deploy(deployer.address); // Pass initial owner if required
  await escrow.waitForDeployment();

  console.log("P2PTokenEscrow deployed to:", await escrow.getAddress());
}

// Execute the deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });