// Poll a JSON-RPC endpoint until it responds or a timeout elapses.
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const TIMEOUT_MS = Number(process.env.RPC_WAIT_TIMEOUT_MS || 60000);

async function ping() {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  });
  const data = await res.json();
  return Boolean(data.result);
}

async function main() {
  const start = Date.now();
  while (Date.now() - start < TIMEOUT_MS) {
    try {
      if (await ping()) {
        console.log(`RPC ready at ${RPC_URL}`);
        return;
      }
    } catch (_) {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.error(`Timed out waiting for RPC at ${RPC_URL}`);
  process.exit(1);
}

main();
