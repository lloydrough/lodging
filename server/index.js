const fs = require("fs");
const path = require("path");
const express = require("express");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const PORT = process.env.PORT || 3000;
const DEPLOYMENT_PATH = path.join(__dirname, "deployment.json");

if (!fs.existsSync(DEPLOYMENT_PATH)) {
  console.error(
    "Missing server/deployment.json. Start the chain and run `npm run deploy:local` first."
  );
  process.exit(1);
}

const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
const provider = new ethers.JsonRpcProvider(RPC_URL);

// In-memory registry so the UI can show the human-readable terms behind each hash.
const termsByHash = {};

function hashTerms(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(text));
}

async function contractFor(signerIndex) {
  const signer =
    signerIndex === undefined ? provider : await provider.getSigner(signerIndex);
  return new ethers.Contract(deployment.address, deployment.abi, signer);
}

const STATUS = [
  "None",
  "Booked",
  "CheckedOut",
  "Completed",
  "DepositClaimed",
  "Cancelled",
];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/api/health", async (req, res) => {
  try {
    const network = await provider.getNetwork();
    res.json({
      ok: true,
      rpc: RPC_URL,
      chainId: Number(network.chainId),
      contract: deployment.address,
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

app.get("/api/accounts", async (req, res) => {
  try {
    const accounts = await provider.listAccounts();
    const withBalances = await Promise.all(
      accounts.slice(0, 5).map(async (a, index) => ({
        index,
        address: a.address,
        balanceEth: ethers.formatEther(await provider.getBalance(a.address)),
      }))
    );
    res.json(withBalances);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

app.get("/api/listings", async (req, res) => {
  try {
    const contract = await contractFor();
    const total = Number(await contract.totalListings());
    const listings = [];
    for (let id = 1; id <= total; id++) {
      const l = await contract.getListing(id);
      listings.push({
        id: Number(l.id),
        host: l.host,
        title: l.title,
        location: l.location,
        pricePerNightEth: ethers.formatEther(l.pricePerNight),
        depositEth: ethers.formatEther(l.depositAmount),
        termsURI: l.termsURI,
        termsHash: l.termsHash,
        terms: termsByHash[l.termsHash] || null,
        active: l.active,
      });
    }
    res.json(listings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/listings", async (req, res) => {
  try {
    const { title, location, pricePerNight, deposit, terms, hostIndex } = req.body;
    const termsText = terms || "Standard host terms.";
    const th = hashTerms(termsText);
    termsByHash[th] = termsText;

    const contract = await contractFor(hostIndex ?? 0);
    const tx = await contract.createListing(
      title,
      location || "",
      ethers.parseEther(String(pricePerNight)),
      ethers.parseEther(String(deposit || "0")),
      "onchain://terms",
      th
    );
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/bookings", async (req, res) => {
  try {
    const contract = await contractFor();
    const total = Number(await contract.totalBookings());
    const bookings = [];
    for (let id = 1; id <= total; id++) {
      const b = await contract.getBooking(id);
      bookings.push({
        id: Number(b.id),
        listingId: Number(b.listingId),
        guest: b.guest,
        nights: Number(b.nights),
        rentEth: ethers.formatEther(b.rentPaid),
        depositEth: ethers.formatEther(b.depositPaid),
        status: STATUS[Number(b.status)],
      });
    }
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bookings", async (req, res) => {
  try {
    const { listingId, nights, guestIndex, terms } = req.body;
    const contract = await contractFor(guestIndex ?? 1);
    const listing = await contract.getListing(listingId);

    // Guest explicitly re-hashes and accepts the host's terms.
    const th = terms ? hashTerms(terms) : listing.termsHash;
    const rent = listing.pricePerNight * BigInt(nights);
    const total = rent + listing.depositAmount;

    const tx = await contract.book(listingId, nights, th, { value: total });
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/checkout", async (req, res) => {
  try {
    const { guestIndex } = req.body;
    const contract = await contractFor(guestIndex ?? 1);
    const tx = await contract.checkOut(req.params.id);
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/complete", async (req, res) => {
  try {
    const { hostIndex } = req.body;
    const contract = await contractFor(hostIndex ?? 0);
    const tx = await contract.completeStay(req.params.id);
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/claim", async (req, res) => {
  try {
    const { hostIndex, amount, reason } = req.body;
    const contract = await contractFor(hostIndex ?? 0);
    const tx = await contract.claimDamageDeposit(
      req.params.id,
      ethers.parseEther(String(amount)),
      reason || "Damage"
    );
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/bookings/:id/cancel", async (req, res) => {
  try {
    const { hostIndex } = req.body;
    const contract = await contractFor(hostIndex ?? 0);
    const tx = await contract.cancelBooking(req.params.id);
    const receipt = await tx.wait();
    res.json({ ok: true, txHash: receipt.hash });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Lodging dApp server listening on http://127.0.0.1:${PORT}`);
  console.log(`Using contract ${deployment.address} via ${RPC_URL}`);
});
