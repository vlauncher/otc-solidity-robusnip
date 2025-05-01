async function main() {
    const [deployer] = await ethers.getSigners();
  
    console.log("Deploying contracts with account:", deployer.address);
  
    // Get the contract factory
    const P2PTokenEscrow = await ethers.getContractFactory("P2PTokenEscrow");
  
    // Deploy the contract
    const escrow = await P2PTokenEscrow.deploy(deployer.address);
  
    // Wait for the deployment transaction to be mined
    await escrow.waitForDeployment();
  
    // Get the deployed contract address
    const escrowAddress = await escrow.getAddress();
  
    console.log("P2PTokenEscrow deployed to:", escrowAddress);
  }
  
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });