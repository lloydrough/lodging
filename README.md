# lodging

Peer-to-peer lodging on the blockchain — a system to replace booking.com,
expedia.com and airbnb.com.

The problem with the incumbents is that they are not peer to peer: the
accommodation provider never gets the terms and conditions they want from the
guests, guests do room damage, and the platform charges ~15% for the "service".

This repository implements that idea directly on-chain:

- **Peer to peer** — there is no platform operator in the middle.
- **Host-defined terms** — every listing pins the host's own terms and
  conditions (by hash), and a guest must accept those exact terms to book.
- **Damage deposits, not fees** — rent and a damage deposit are held in on-chain
  escrow. On a clean stay the host is paid the rent and the guest's deposit is
  refunded in full. If the guest causes damage, the host withholds part or all
  of the deposit. **No percentage service fee is ever taken.**

## Architecture

| Layer | Path | Purpose |
| --- | --- | --- |
| Smart contract | `contracts/LodgingBooking.sol` | Listings, bookings, escrow, settlement |
| Tests | `test/LodgingBooking.test.js` | Hardhat/Chai unit tests |
| Deploy | `scripts/deploy.js` | Deploys and writes `server/deployment.json` |
| API + web app | `server/index.js`, `public/` | Express API and browser dApp |

The web app talks to a small Express API, which uses [ethers](https://docs.ethers.org/)
to call the deployed contract through the local Hardhat node's unlocked accounts.
This keeps the demo wallet-free — no browser extension is required.

## Requirements

- Node.js 22+
- npm 10+

## Getting started

```bash
npm install          # install dependencies
npm run compile      # compile the contract
npm test             # run the test suite (9 tests)
```

### Run the whole stack

The simplest way to run everything (chain + deploy + web app) in one process:

```bash
npm run dev
```

Then open http://localhost:3000.

### Run it as separate services

This mirrors the Cloud Agent environment (`.cursor/environment.json`), which runs
two terminals — `chain` and `app`:

```bash
# terminal 1: local EVM chain on :8545
npm run node

# terminal 2: wait for the chain, deploy, then serve the app on :3000
npm run dev:app
```

## Using the app

1. **Host a place** — fill in the title, nightly price, damage deposit and your
   terms, then publish. The listing is written on-chain.
2. **Book** — as a guest account, choose the number of nights and book. Rent plus
   the deposit is escrowed in the contract.
3. **Settle** — the host either settles the stay (rent paid out, deposit refunded
   in full), withholds a damage amount from the deposit, or cancels (full refund).

The **Accounts** panel shows live balances so you can watch escrow move.

## Contract reference

| Function | Who | Effect |
| --- | --- | --- |
| `createListing` | host | List a property with price, deposit and terms hash |
| `book` | guest | Escrow rent + deposit; must accept the host's terms hash |
| `checkOut` | guest | Signal check-out |
| `completeStay` | host | Pay rent to host, refund full deposit to guest |
| `claimDamageDeposit` | host | Pay rent + withheld amount to host, refund remainder |
| `cancelBooking` | host | Fully refund the guest |
