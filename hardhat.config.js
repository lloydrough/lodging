require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // In-process chain used by `hardhat test`.
    hardhat: {},
    // Standalone JSON-RPC node started with `npm run node`.
    localhost: {
      url: "http://127.0.0.1:8545",
    },
  },
};
