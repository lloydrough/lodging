const fs = require("fs");
const path = require("path");
const { ethers, artifacts } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying LodgingBooking with account:", deployer.address);

  const Factory = await ethers.getContractFactory("LodgingBooking");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log("LodgingBooking deployed to:", address);

  // Persist the address + ABI so the backend can connect to this deployment.
  const artifact = await artifacts.readArtifact("LodgingBooking");
  const out = {
    address,
    abi: artifact.abi,
    network: "localhost",
    chainId: 31337,
  };
  const outDir = path.join(__dirname, "..", "server");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "deployment.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Wrote deployment info to:", outPath);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
