const $ = (sel) => document.querySelector(sel);

let accounts = [];

function toast(msg, kind = "ok") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  setTimeout(() => (el.className = "toast"), 3200);
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function shortAddr(a) {
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "";
}

function accountLabel(index) {
  const a = accounts.find((x) => x.index === index);
  return a ? `#${index} ${shortAddr(a.address)}` : `#${index}`;
}

async function loadHealth() {
  try {
    const h = await api("GET", "/api/health");
    $("#chain-status").textContent = `chain ${h.chainId} · ${shortAddr(h.contract)}`;
    $("#chain-status").className = "chip ok";
  } catch (e) {
    $("#chain-status").textContent = "chain offline";
    $("#chain-status").className = "chip";
  }
}

async function loadAccounts() {
  accounts = await api("GET", "/api/accounts");
  const host = $("#host-select");
  host.innerHTML = accounts
    .map((a) => `<option value="${a.index}">${accountLabel(a.index)}</option>`)
    .join("");
  $("#accounts").innerHTML = accounts
    .map(
      (a) => `
      <div class="acct">
        <div class="muted">Account #${a.index}${a.index === 0 ? " (default host)" : a.index === 1 ? " (default guest)" : ""}</div>
        <div class="addr">${a.address}</div>
        <div class="bal">${Number(a.balanceEth).toFixed(3)} ETH</div>
      </div>`
    )
    .join("");
}

function guestOptions(selected = 1) {
  return accounts
    .map(
      (a) =>
        `<option value="${a.index}" ${a.index === selected ? "selected" : ""}>${accountLabel(
          a.index
        )}</option>`
    )
    .join("");
}

async function loadListings() {
  const listings = await api("GET", "/api/listings");
  const box = $("#listings");
  if (!listings.length) {
    box.innerHTML = `<p class="muted">No listings yet. Publish one on the left.</p>`;
    return;
  }
  box.innerHTML = listings
    .map(
      (l) => `
      <div class="card" data-id="${l.id}">
        <h3>#${l.id} ${l.title} ${l.active ? "" : "<span class='muted'>(inactive)</span>"}</h3>
        <div class="loc">${l.location || "—"} · host ${shortAddr(l.host)}</div>
        <div class="pricing">
          <div><b>${l.pricePerNightEth}</b> ETH / night</div>
          <div>deposit <b>${l.depositEth}</b> ETH</div>
        </div>
        <div class="terms">“${l.terms || "host terms on file"}”</div>
        <div class="book-row">
          <label>Nights <input type="number" min="1" value="2" class="nights" /></label>
          <label>Guest <select class="guest">${guestOptions()}</select></label>
          <button class="small book-btn" ${l.active ? "" : "disabled"}>Book</button>
        </div>
      </div>`
    )
    .join("");

  box.querySelectorAll(".card").forEach((card) => {
    const id = Number(card.dataset.id);
    card.querySelector(".book-btn")?.addEventListener("click", async () => {
      const nights = Number(card.querySelector(".nights").value);
      const guestIndex = Number(card.querySelector(".guest").value);
      const terms = listings.find((x) => x.id === id)?.terms;
      try {
        await api("POST", "/api/bookings", { listingId: id, nights, guestIndex, terms });
        toast(`Booked listing #${id} for ${nights} night(s) — funds escrowed`);
        await refresh();
      } catch (e) {
        toast(e.message, "err");
      }
    });
  });
}

async function loadBookings() {
  const bookings = await api("GET", "/api/bookings");
  const box = $("#bookings");
  if (!bookings.length) {
    box.innerHTML = `<p class="muted">No bookings yet.</p>`;
    return;
  }
  const rows = bookings
    .map(
      (b) => `
      <tr>
        <td>#${b.id}</td>
        <td>listing #${b.listingId}</td>
        <td>${shortAddr(b.guest)}</td>
        <td>${b.nights}</td>
        <td>${b.rentEth}</td>
        <td>${b.depositEth}</td>
        <td><span class="status ${b.status}">${b.status}</span></td>
        <td class="actions">${bookingActions(b)}</td>
      </tr>`
    )
    .join("");
  box.innerHTML = `
    <table>
      <thead><tr><th>ID</th><th>Listing</th><th>Guest</th><th>Nights</th><th>Rent</th><th>Deposit</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  box.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => onBookingAction(btn.dataset));
  });
}

function bookingActions(b) {
  if (b.status === "Booked") {
    return `
      <button class="small secondary" data-action="checkout" data-id="${b.id}">Guest check-out</button>
      <button class="small" data-action="complete" data-id="${b.id}">Settle (refund deposit)</button>
      <button class="small danger" data-action="claim" data-id="${b.id}">Claim damage</button>
      <button class="small secondary" data-action="cancel" data-id="${b.id}">Cancel</button>`;
  }
  if (b.status === "CheckedOut") {
    return `
      <button class="small" data-action="complete" data-id="${b.id}">Settle (refund deposit)</button>
      <button class="small danger" data-action="claim" data-id="${b.id}">Claim damage</button>`;
  }
  return `<span class="muted">—</span>`;
}

async function onBookingAction({ action, id }) {
  try {
    if (action === "checkout") {
      await api("POST", `/api/bookings/${id}/checkout`, { guestIndex: 1 });
      toast(`Guest checked out of booking #${id}`);
    } else if (action === "complete") {
      await api("POST", `/api/bookings/${id}/complete`, { hostIndex: 0 });
      toast(`Booking #${id} settled — rent paid, deposit refunded`);
    } else if (action === "cancel") {
      await api("POST", `/api/bookings/${id}/cancel`, { hostIndex: 0 });
      toast(`Booking #${id} cancelled — guest fully refunded`);
    } else if (action === "claim") {
      const amount = prompt("Damage amount to withhold (ETH):", "0.2");
      if (amount === null) return;
      const reason = prompt("Reason:", "Broken window") || "Damage";
      await api("POST", `/api/bookings/${id}/claim`, { hostIndex: 0, amount, reason });
      toast(`Withheld ${amount} ETH from booking #${id} deposit`);
    }
    await refresh();
  } catch (e) {
    toast(e.message, "err");
  }
}

$("#listing-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api("POST", "/api/listings", {
      title: f.get("title"),
      location: f.get("location"),
      pricePerNight: f.get("pricePerNight"),
      deposit: f.get("deposit"),
      terms: f.get("terms"),
      hostIndex: Number(f.get("hostIndex")),
    });
    toast("Listing published on-chain");
    await refresh();
  } catch (err) {
    toast(err.message, "err");
  }
});

async function refresh() {
  await Promise.all([loadHealth(), loadAccounts()]);
  await Promise.all([loadListings(), loadBookings()]);
}

refresh();
setInterval(loadHealth, 10000);
