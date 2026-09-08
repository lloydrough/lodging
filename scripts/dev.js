// All-in-one local dev orchestrator: starts an in-process Hardhat node, deploys
// the contract, then launches the API + web server. Handy for `npm run dev`.
const { spawn } = require("child_process");
const path = require("path");

const root = path.join(__dirname, "..");
const children = [];

function run(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: "inherit", ...opts });
  child.on("exit", (code) => {
    console.log(`[${label}] exited with code ${code}`);
  });
  children.push(child);
  return child;
}

function runToCompletion(label, cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: root, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`))
    );
  });
}

function shutdown() {
  for (const c of children) {
    try {
      c.kill("SIGINT");
    } catch (_) {}
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  run("chain", "npx", ["hardhat", "node"]);
  await runToCompletion("wait-for-rpc", "node", ["scripts/wait-for-rpc.js"]);
  await runToCompletion("deploy", "npx", [
    "hardhat",
    "run",
    "scripts/deploy.js",
    "--network",
    "localhost",
  ]);
  run("server", "node", ["server/index.js"]);
}

main().catch((err) => {
  console.error(err);
  shutdown();
});
