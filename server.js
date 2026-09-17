// Wallet Copy-Alert Bot
// Receives Helius webhook events for tracked Solana wallets and posts
// formatted trade alerts to a Discord channel via a Discord webhook URL.

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL environment variable. Exiting.");
  process.exit(1);
}

// Load tracked wallets from wallets.json: [{ "address": "...", "label": "Friend A" }, ...]
const walletsPath = path.join(__dirname, "wallets.json");
function loadWallets() {
  try {
    const raw = fs.readFileSync(walletsPath, "utf8");
    const list = JSON.parse(raw);
    const map = new Map();
    for (const w of list) {
      map.set(w.address, w.label || w.address.slice(0, 4) + "..." + w.address.slice(-4));
    }
    return map;
  } catch (err) {
    console.error("Could not read wallets.json:", err.message);
    return new Map();
  }
}
let trackedWallets = loadWallets();

// Reload wallets.json without restarting the server (handy since you'll edit this file often)
app.post("/reload-wallets", (req, res) => {
  trackedWallets = loadWallets();
  res.json({ ok: true, count: trackedWallets.size });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, trackedWallets: trackedWallets.size });
});

// Simple in-memory de-dupe so retried webhook deliveries don't double-post
const seenSignatures = new Set();
function alreadySeen(sig) {
  if (!sig) return false;
  if (seenSignatures.has(sig)) return true;
  seenSignatures.add(sig);
  if (seenSignatures.size > 2000) {
    seenSignatures.clear(); // cheap cap, avoids unbounded memory growth
  }
  return false;
}

app.post("/helius-webhook", async (req, res) => {
  // Optional shared-secret check. Helius sends this back as the Authorization
  // header if you set it when creating the webhook.
  if (HELIUS_WEBHOOK_SECRET) {
    const auth = req.headers["authorization"];
    if (auth !== HELIUS_WEBHOOK_SECRET) {
      return res.status(401).json({ error: "unauthorized" });
    }
  }

  const events = Array.isArray(req.body) ? req.body : [req.body];
  res.status(200).json({ received: true }); // ack immediately, process after

  for (const tx of events) {
    try {
      await handleTransaction(tx);
    } catch (err) {
      console.error("Error handling transaction:", err.message);
    }
  }
});

async function handleTransaction(tx) {
  const signature = tx.signature;
  if (alreadySeen(signature)) return;

  const feePayer = tx.feePayer;
  const label = trackedWallets.get(feePayer);
  if (!label) return; // not one of ours, or Helius sent us a wallet we didn't ask for

  // Helius "enhanced" webhook payloads include a human-readable `type` and
  // `description`, plus structured tokenTransfers/nativeTransfers arrays.
  const type = tx.type || "UNKNOWN";
  const tokenTransfers = tx.tokenTransfers || [];

  // Figure out what was bought/sold by this wallet in this transaction.
  const outgoing = tokenTransfers.filter((t) => t.fromUserAccount === feePayer);
  const incoming = tokenTransfers.filter((t) => t.toUserAccount === feePayer);

  let action = "TRADE";
  let tokenMint = null;
  let tokenAmount = null;

  if (incoming.length && !outgoing.some((o) => o.mint !== "So11111111111111111111111111111111111111112")) {
    action = "BUY";
    tokenMint = incoming[0].mint;
    tokenAmount = incoming[0].tokenAmount;
  } else if (outgoing.length) {
    action = "SELL";
    tokenMint = outgoing[0].mint;
    tokenAmount = outgoing[0].tokenAmount;
  }

  const shortWallet = feePayer.slice(0, 4) + "..." + feePayer.slice(-4);
  const solscanTx = `https://solscan.io/tx/${signature}`;
  const solscanToken = tokenMint ? `https://solscan.io/token/${tokenMint}` : null;
  const axiomLink = tokenMint ? `https://axiom.trade/meme/${tokenMint}` : null;

  const color = action === "BUY" ? 0x2ecc71 : action === "SELL" ? 0xe74c3c : 0x95a5a6;

  const embed = {
    title: `${action}: ${label}`,
    color,
    fields: [
      { name: "Wallet", value: `[${shortWallet}](https://solscan.io/account/${feePayer})`, inline: true },
      { name: "Type", value: type, inline: true },
      ...(tokenMint ? [{ name: "Token (mint)", value: `\`${tokenMint}\``, inline: false }] : []),
      ...(tokenAmount ? [{ name: "Amount", value: String(tokenAmount), inline: true }] : []),
    ],
    description: [
      `[View Transaction](${solscanTx})`,
      solscanToken ? `[Solscan Token](${solscanToken})` : null,
      axiomLink ? `[Open on Axiom](${axiomLink})` : null,
    ]
      .filter(Boolean)
      .join(" • "),
    timestamp: new Date().toISOString(),
  };

  await postToDiscord({ embeds: [embed] });
}

async function postToDiscord(payload) {
  const res = await fetch(DISCORD_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error("Discord post failed:", res.status, text);
  }
}

app.listen(PORT, () => {
  console.log(`Wallet alert bot listening on port ${PORT}`);
  console.log(`Tracking ${trackedWallets.size} wallet(s).`);
});
