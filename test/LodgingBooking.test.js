const { expect } = require("chai");
const { ethers } = require("hardhat");

const TERMS_URI = "ipfs://example-terms";
const termsHash = ethers.keccak256(ethers.toUtf8Bytes("No parties. Check-out by 11am. Pets allowed."));

async function deploy() {
  const [host, guest, other] = await ethers.getSigners();
  const Factory = await ethers.getContractFactory("LodgingBooking");
  const contract = await Factory.deploy();
  await contract.waitForDeployment();
  return { contract, host, guest, other };
}

async function createDefaultListing(contract, host) {
  const pricePerNight = ethers.parseEther("1");
  const deposit = ethers.parseEther("0.5");
  await contract
    .connect(host)
    .createListing("Cosy Cabin", "Aspen, CO", pricePerNight, deposit, TERMS_URI, termsHash);
  return { pricePerNight, deposit };
}

describe("LodgingBooking", function () {
  it("lets a host create a listing on their own terms", async function () {
    const { contract, host } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);

    const listing = await contract.getListing(1);
    expect(listing.host).to.equal(host.address);
    expect(listing.title).to.equal("Cosy Cabin");
    expect(listing.pricePerNight).to.equal(pricePerNight);
    expect(listing.depositAmount).to.equal(deposit);
    expect(listing.termsHash).to.equal(termsHash);
    expect(listing.active).to.equal(true);
    expect(await contract.totalListings()).to.equal(1);
  });

  it("requires the guest to accept the host's exact terms to book", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    const wrongTerms = ethers.keccak256(ethers.toUtf8Bytes("different terms"));

    await expect(
      contract.connect(guest).book(1, 2, wrongTerms, { value: pricePerNight * 2n + deposit })
    ).to.be.revertedWith("Terms not accepted");
  });

  it("escrows rent + deposit on booking and rejects incorrect payment", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);

    await expect(
      contract.connect(guest).book(1, 2, termsHash, { value: pricePerNight })
    ).to.be.revertedWith("Incorrect payment");

    const total = pricePerNight * 2n + deposit;
    await contract.connect(guest).book(1, 2, termsHash, { value: total });

    // Contract holds the full escrow.
    expect(await ethers.provider.getBalance(await contract.getAddress())).to.equal(total);
    const booking = await contract.getBooking(1);
    expect(booking.guest).to.equal(guest.address);
    expect(booking.rentPaid).to.equal(pricePerNight * 2n);
    expect(booking.depositPaid).to.equal(deposit);
    expect(booking.status).to.equal(1); // Booked
  });

  it("pays the host rent and refunds the full deposit on a clean stay (no 15% fee)", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    const rent = pricePerNight * 3n;
    await contract.connect(guest).book(1, 3, termsHash, { value: rent + deposit });

    await contract.connect(guest).checkOut(1);

    const hostBefore = await ethers.provider.getBalance(host.address);
    const guestBefore = await ethers.provider.getBalance(guest.address);

    await contract.connect(host).completeStay(1);

    const hostAfter = await ethers.provider.getBalance(host.address);
    const guestAfter = await ethers.provider.getBalance(guest.address);

    // Host receives the full rent (minus its own gas), guest gets the full deposit back.
    expect(guestAfter - guestBefore).to.equal(deposit);
    expect(hostAfter).to.be.greaterThan(hostBefore);
    const booking = await contract.getBooking(1);
    expect(booking.status).to.equal(3); // Completed
  });

  it("lets the host withhold a damage deposit and refund the remainder", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    const rent = pricePerNight * 1n;
    await contract.connect(guest).book(1, 1, termsHash, { value: rent + deposit });

    const withheld = ethers.parseEther("0.2");
    const guestBefore = await ethers.provider.getBalance(guest.address);

    await expect(contract.connect(host).claimDamageDeposit(1, withheld, "Broken window"))
      .to.emit(contract, "DepositClaimed")
      .withArgs(1, withheld, deposit - withheld, "Broken window");

    const guestAfter = await ethers.provider.getBalance(guest.address);
    expect(guestAfter - guestBefore).to.equal(deposit - withheld);
    const booking = await contract.getBooking(1);
    expect(booking.status).to.equal(4); // DepositClaimed
  });

  it("cannot withhold more than the deposit", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    await contract.connect(guest).book(1, 1, termsHash, { value: pricePerNight + deposit });

    await expect(
      contract.connect(host).claimDamageDeposit(1, deposit + 1n, "over")
    ).to.be.revertedWith("Exceeds deposit");
  });

  it("fully refunds the guest when the host cancels", async function () {
    const { contract, host, guest } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    const total = pricePerNight * 2n + deposit;
    await contract.connect(guest).book(1, 2, termsHash, { value: total });

    const guestBefore = await ethers.provider.getBalance(guest.address);
    await contract.connect(host).cancelBooking(1);
    const guestAfter = await ethers.provider.getBalance(guest.address);

    expect(guestAfter - guestBefore).to.equal(total);
    const booking = await contract.getBooking(1);
    expect(booking.status).to.equal(5); // Cancelled
  });

  it("prevents a host from booking their own listing", async function () {
    const { contract, host } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    await expect(
      contract.connect(host).book(1, 1, termsHash, { value: pricePerNight + deposit })
    ).to.be.revertedWith("Host cannot book own listing");
  });

  it("only the guest can check out and only the host can settle", async function () {
    const { contract, host, guest, other } = await deploy();
    const { pricePerNight, deposit } = await createDefaultListing(contract, host);
    await contract.connect(guest).book(1, 1, termsHash, { value: pricePerNight + deposit });

    await expect(contract.connect(other).checkOut(1)).to.be.revertedWith("Not the guest");
    await expect(contract.connect(other).completeStay(1)).to.be.revertedWith("Not the host");
  });
});
