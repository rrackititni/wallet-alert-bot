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

// Query RugCheck's free public API for a token's risk profile.
// No API key required. Returns null on any failure so a BUY alert still
// posts even if RugCheck is slow, down, or hasn't indexed a brand-new token.
async function getRugCheckSummary(mint) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // don't hang the alert on a slow API
    const res = await fetch(
      `https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();

    const score = data.score_normalised ?? data.score ?? null;
    if (score === null) return null;

    let verdict = "✅ Low risk";
    if (score >= 60) verdict = "🚨 High risk";
    else if (score >= 30) verdict = "⚠️ Medium risk";

    // Take the top 2 highest-severity risk flags, if any, to keep the alert short
    const risks = Array.isArray(data.risks) ? data.risks : [];
    const topRisks = risks
      .slice(0, 2)
      .map((r) => r.name || r.description)
      .filter(Boolean);

    return { score, verdict, topRisks };
  } catch (err) {
    return null; // timeout, network error, or bad JSON — fail silently, alert still posts
  }
}

// Simple in-memory cache so we don't re-query a deployer's full history on
// every single buy — same deployer often launches multiple tokens you'll see.
const deployerCache = new Map(); // wallet -> { data, expiresAt }
const DEPLOYER_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

// Full RugCheck report includes the creator wallet, which the lighter
// /summary endpoint used above omits.
async function getTokenCreator(mint) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return data.creator || data.creatorAddress || null;
  } catch (err) {
    return null;
  }
}

// Look up how many tokens a deployer wallet has launched, and how many of
// those RugCheck flags as rugged. This is a best-effort v1: Helius's exact
// transaction shape for pump.fun launches can vary, so treat "tokensFound: 0"
// as "couldn't confirm" rather than "this deployer has never launched anything."
async function getDeployerReputation(creatorWallet) {
  if (!HELIUS_API_KEY || !creatorWallet) return null;

  const cached = deployerCache.get(creatorWallet);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${creatorWallet}/transactions?api-key=${HELIUS_API_KEY}&type=CREATE&limit=20`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (!res.ok) return null;

    const txs = await res.json();
    if (!Array.isArray(txs)) return null;

    // Pull out mint addresses this wallet appears to have created.
    // Helius's CREATE-type payloads vary by program; we check the common
    // places a new mint address shows up.
    const mints = new Set();
    for (const tx of txs) {
      const transfers = tx.tokenTransfers || [];
      for (const t of transfers) {
        if (t.mint) mints.add(t.mint);
      }
    }

    const mintList = Array.from(mints).slice(0, 8); // cap RugCheck calls per lookup
    let ruggedCount = 0;
    let checkedCount = 0;

    for (const mint of mintList) {
      const summary = await getRugCheckSummary(mint);
      if (summary) {
        checkedCount++;
        if (summary.score >= 60) ruggedCount++;
      }
    }

    const data = {
      tokensFound: mintList.length,
      checkedCount,
      ruggedCount,
    };

    deployerCache.set(creatorWallet, { data, expiresAt: Date.now() + DEPLOYER_CACHE_TTL_MS });
    return data;
  } catch (err) {
    return null;
  }
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

  // Only risk-check on BUYs — that's the moment you'd actually consider following in
  const rugCheck = action === "BUY" && tokenMint ? await getRugCheckSummary(tokenMint) : null;

  // Deployer reputation: who made this token, and have their other launches been rugs?
  let deployerRep = null;
  if (action === "BUY" && tokenMint && HELIUS_API_KEY) {
    const creator = await getTokenCreator(tokenMint);
    if (creator) {
      deployerRep = await getDeployerReputation(creator);
    }
  }

  const embed = {
    title: `${action}: ${label}`,
    color,
    fields: [
      { name: "Wallet", value: `[${shortWallet}](https://solscan.io/account/${feePayer})`, inline: true },
      { name: "Type", value: type, inline: true },
      ...(tokenMint ? [{ name: "Token (mint)", value: `\`${tokenMint}\``, inline: false }] : []),
      ...(tokenAmount ? [{ name: "Amount", value: String(tokenAmount), inline: true }] : []),
      ...(rugCheck
        ? [
            {
              name: "Risk Check (RugCheck)",
              value: [
                `${rugCheck.verdict} (score: ${rugCheck.score})`,
                ...(rugCheck.topRisks.length ? rugCheck.topRisks.map((r) => `• ${r}`) : []),
              ].join("\n"),
              inline: false,
            },
          ]
        : action === "BUY"
        ? [{ name: "Risk Check (RugCheck)", value: "Unavailable (token too new or API error)", inline: false }]
        : []),
      ...(deployerRep
        ? [
            {
              name: "Deployer History",
              value:
                deployerRep.tokensFound === 0
                  ? "No prior launches found (or couldn't confirm)"
                  : `${deployerRep.tokensFound} token(s) found, ${deployerRep.ruggedCount} flagged high-risk by RugCheck`,
              inline: false,
            },
          ]
        : []),
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
