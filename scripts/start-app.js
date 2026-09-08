// Used by the "app" terminal: wait for the chain (started in its own terminal),
// deploy the contract, then run the API + web server in the foreground.
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");

function runToCompletion(label, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))
    );
  });
}

async function main() {
  await runToCompletion("wait-for-rpc", "node", ["scripts/wait-for-rpc.js"]);
  await runToCompletion("deploy", "npx", [
    "hardhat",
    "run",
    "scripts/deploy.js",
    "--network",
    "localhost",
  ]);
  // Hand off to the server in the foreground so its logs stay visible.
  const server = spawn("node", ["server/index.js"], { cwd: root, stdio: "inherit" });
  server.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
