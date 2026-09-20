// Wallet Copy-Alert Bot
// Receives Helius webhook events for tracked Solana wallets and posts
// formatted trade alerts to a Discord channel via a Discord webhook URL.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Connection, Keypair, VersionedTransaction, PublicKey } = require("@solana/web3.js");
const bs58 = require("bs58");

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const HELIUS_WEBHOOK_SECRET = process.env.HELIUS_WEBHOOK_SECRET || "";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

if (!DISCORD_WEBHOOK_URL) {
  console.error("Missing DISCORD_WEBHOOK_URL environment variable. Exiting.");
  process.exit(1);
}

// ===== Trading configuration =====
// TRADING_ENABLED is a kill switch: set to "false" in Railway to instantly
// stop all execution without touching code or redeploying.
const TRADING_ENABLED = (process.env.TRADING_ENABLED || "false").toLowerCase() === "true";
const TRADING_WALLET_PRIVATE_KEY = process.env.TRADING_WALLET_PRIVATE_KEY || "";
const TRADE_AMOUNT_SOL = parseFloat(process.env.TRADE_AMOUNT_SOL || "0.05");
// Hard daily cap enforced in code, independent of what any single trade requests.
// This is the real backstop on the "$50 total" budget — resets at midnight UTC.
const MAX_DAILY_SOL = parseFloat(process.env.MAX_DAILY_SOL || "0.3");
const HELIUS_API_KEY_FOR_RPC = process.env.HELIUS_API_KEY || "";
const RPC_URL = HELIUS_API_KEY_FOR_RPC
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY_FOR_RPC}`
  : "https://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_URL, "confirmed");
let tradingKeypair = null;
if (TRADING_WALLET_PRIVATE_KEY) {
  try {
    tradingKeypair = Keypair.fromSecretKey(bs58.decode(TRADING_WALLET_PRIVATE_KEY));
  } catch (err) {
    console.error("TRADING_WALLET_PRIVATE_KEY is set but invalid — trading disabled.", err.message);
  }
}

// ===== Jupiter endpoint (configurable) =====
// Default keeps the original endpoint. If quotes start failing, set JUP_BASE in Railway
// (e.g. https://lite-api.jup.ag/swap/v1) and, if Jupiter requires one, JUP_API_KEY.
const JUP_BASE = (process.env.JUP_BASE || "https://quote-api.jup.ag/v6").replace(/\/+$/, "");
const JUP_API_KEY = process.env.JUP_API_KEY || "";
const jupAuthHeaders = () => (JUP_API_KEY ? { "x-api-key": JUP_API_KEY } : {});

// A "confirmed" transaction can still have FAILED on-chain (e.g. slippage exceeded).
// confirmTransaction returns the error instead of throwing, so check it explicitly.
async function confirmOrThrow(signature) {
  const conf = await connection.confirmTransaction(signature, "confirmed");
  if (conf && conf.value && conf.value.err) {
    throw new Error("Transaction failed on-chain: " + JSON.stringify(conf.value.err));
  }
}

// ===== Copy-trade agent (paper by default — see AGENT.md) =====
const AGENT_ENABLED = (process.env.AGENT_ENABLED || "false").toLowerCase() === "true";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const { makeAdminCheck } = require("./agent/admin");
const isAdmin = makeAdminCheck(ADMIN_TOKEN);
let agent = null;
let agentStartupNote = null;
if (AGENT_ENABLED) {
  if (!HELIUS_WEBHOOK_SECRET || ADMIN_TOKEN.length < 24) {
    // With auto-execution, an unauthenticated webhook lets anyone forge a "trader bought X" event.
    agentStartupNote = "Agent NOT started: set HELIUS_WEBHOOK_SECRET and an ADMIN_TOKEN of at least 24 random characters in Railway (and the same secret as the Auth Header on the Helius webhook).";
    console.error(agentStartupNote);
  } else {
    try {
      const { createAgent } = require("./agent");
      const { createChain } = require("./agent/chain");
      const { createState } = require("./agent/state");
      const { loadAgentConfig } = require("./agent/config");
      const { fetchRugCheck } = require("./agent/rugcheck");
      const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
      const agentCfg = loadAgentConfig(path.join(__dirname, "agent-config.json"));
      const agentEnv = {
        agentLive: (process.env.AGENT_LIVE || "false").toLowerCase() === "true",
        tradingEnabled: TRADING_ENABLED,
        budgetSol: num(process.env.AGENT_BUDGET_SOL, 0.27), // total SOL the agent may have open
        maxPositions: Math.floor(num(process.env.AGENT_MAX_POSITIONS, 3)),
        dailyLossSol: num(process.env.AGENT_DAILY_LOSS_SOL, 0.09), // pauses new live buys
        solReserve: num(process.env.AGENT_SOL_RESERVE, 0.03), // SOL always left for fees/rent
        slippageBps: num(process.env.AGENT_SLIPPAGE_BPS, 500),
        paperFeeSol: num(process.env.AGENT_PAPER_FEE_SOL, 0.0003), // fee assumed per paper trade side
      };
      const agentChain = createChain({
        connection,
        keypair: tradingKeypair,
        base: JUP_BASE,
        apiKey: JUP_API_KEY,
        priorityFeeLamports: Math.floor(num(process.env.AGENT_PRIORITY_FEE_LAMPORTS, 200000)),
      });
      const agentState = createState({ dir: process.env.DATA_DIR || path.join(__dirname, "data") });
      agent = createAgent({
        cfg: agentCfg,
        env: agentEnv,
        chain: agentChain,
        rugcheck: fetchRugCheck,
        post: (p) => postToDiscord(p).catch((e) => console.error("Discord post error:", e.message)),
        state: agentState,
      });
      agent.registerRoutes(app, isAdmin);
      process.on("SIGTERM", () => { agentState.flush(); process.exit(0); });
    } catch (err) {
      agentStartupNote = `Agent NOT started: ${err.message}`;
      console.error(agentStartupNote);
    }
  }
}

// Pending trades awaiting your confirmation click. In-memory only — if the
// server restarts, unconfirmed links go dead (safer than surviving a restart
// with stale state).
const pendingTrades = new Map(); // id -> { mint, label, expiresAt, used }
const PENDING_TRADE_TTL_MS = 15 * 60 * 1000; // 15 min — memecoin prices move fast

// Tracks SOL spent today toward MAX_DAILY_SOL. Resets when the date rolls over.
// In-memory, so a restart also resets it — acceptable for a $50-scale v1, but
// know this isn't a durable ledger.
let dailySpentSol = 0;
let dailySpentDate = new Date().toISOString().slice(0, 10);
function checkAndResetDaily() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== dailySpentDate) {
    dailySpentDate = today;
    dailySpentSol = 0;
  }
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
  if (ADMIN_TOKEN && !isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
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

  // Agent gets its own concurrent path so slow alert enrichment (RugCheck etc.) never delays it.
  if (agent) {
    Promise.allSettled(events.map((tx) => agent.handleWebhookTx(tx))).catch(() => {});
  }

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

  // Create a semi-auto trade confirmation link for BUYs and SELLs — clicking
  // it takes you to a page where YOU tap confirm; nothing executes here.
  let confirmUrl = null;
  if ((action === "BUY" || action === "SELL") && tokenMint) {
    const id = crypto.randomUUID();
    pendingTrades.set(id, {
      id,
      type: action, // "BUY" or "SELL" — determines execution path and page copy
      mint: tokenMint,
      label,
      used: false,
      expiresAt: Date.now() + PENDING_TRADE_TTL_MS,
    });
    const base = process.env.PUBLIC_BASE_URL || "";
    confirmUrl = base ? `${base}/confirm/${id}` : `/confirm/${id}`;
  }

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
      confirmUrl
        ? action === "BUY"
          ? `[**Confirm Buy (${TRADE_AMOUNT_SOL} SOL)**](${confirmUrl})`
          : `[**Confirm Sell (entire position)**](${confirmUrl})`
        : null,
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

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Get a live swap quote from Jupiter's public aggregator API. No API key needed.
async function getJupiterQuote(outputMint, amountLamports) {
  const url = `${JUP_BASE}/quote?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=500`;
  const res = await fetch(url, { headers: jupAuthHeaders() });
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return res.json();
}

// Build, sign, and send the actual swap transaction.
async function executeJupiterSwap(outputMint, amountSol) {
  if (!tradingKeypair) throw new Error("No valid trading wallet configured");

  const amountLamports = Math.round(amountSol * 1_000_000_000);
  const quote = await getJupiterQuote(outputMint, amountLamports);

  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jupAuthHeaders() },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: tradingKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
  const { swapTransaction } = await swapRes.json();

  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([tradingKeypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmOrThrow(signature);
  return signature;
}

// Check how much of a token the trading wallet actually holds right now.
// Used for sells, since (unlike buys) the amount to sell isn't a fixed
// setting — it's whatever position the wallet currently has.
async function getTokenBalance(mint) {
  if (!tradingKeypair) return null;
  try {
    const accounts = await connection.getParsedTokenAccountsByOwner(tradingKeypair.publicKey, {
      mint: new PublicKey(mint),
    });
    if (accounts.value.length === 0) return { rawAmount: 0, uiAmount: 0, decimals: 0 };
    const info = accounts.value[0].account.data.parsed.info.tokenAmount;
    return {
      rawAmount: info.amount, // string, smallest units — what Jupiter wants
      uiAmount: info.uiAmount || 0,
      decimals: info.decimals,
    };
  } catch (err) {
    return null;
  }
}

// Sell the trading wallet's entire balance of a token back to SOL.
async function executeJupiterSell(mint) {
  if (!tradingKeypair) throw new Error("No valid trading wallet configured");

  const balance = await getTokenBalance(mint);
  if (!balance || balance.rawAmount === "0" || balance.rawAmount === 0) {
    throw new Error("No position found — trading wallet holds none of this token");
  }

  const quoteUrl = `${JUP_BASE}/quote?inputMint=${mint}&outputMint=${SOL_MINT}&amount=${balance.rawAmount}&slippageBps=500`;
  const quoteRes = await fetch(quoteUrl, { headers: jupAuthHeaders() });
  if (!quoteRes.ok) throw new Error(`Jupiter quote failed: ${quoteRes.status}`);
  const quote = await quoteRes.json();

  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...jupAuthHeaders() },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: tradingKeypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) throw new Error(`Jupiter swap build failed: ${swapRes.status}`);
  const { swapTransaction } = await swapRes.json();

  const txBuf = Buffer.from(swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([tradingKeypair]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await confirmOrThrow(signature);
  return { signature, uiAmount: balance.uiAmount };
}

// Simple HTML confirmation page — no framework needed for one button.
function renderConfirmPage(trade, opts = {}) {
  const { error, disabled, disabledReason, sellBalance } = opts;
  const isSell = trade.type === "SELL";
  const heading = isSell ? `Confirm Sell: ${trade.label}` : `Confirm Buy: ${trade.label}`;
  const amountLine = isSell
    ? sellBalance
      ? `Amount: <strong>${sellBalance.uiAmount} tokens (your entire tracked position)</strong>`
      : `Amount: <strong>checking live balance...</strong>`
    : `Amount: <strong>${TRADE_AMOUNT_SOL} SOL</strong>`;
  const buttonLabel = isSell ? "Confirm Sell" : "Confirm Buy";

  return `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Confirm Trade</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #1a1a1a; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
  .card { background: #2a2a2a; border-radius: 12px; padding: 24px; max-width: 420px; width: 100%; }
  h2 { margin-top: 0; }
  .mint { font-family: monospace; font-size: 12px; word-break: break-all; background: #1a1a1a; padding: 8px; border-radius: 6px; }
  button { width: 100%; padding: 14px; font-size: 16px; border-radius: 8px; border: none; margin-top: 16px; cursor: pointer; }
  .confirm { background: ${isSell ? "#e74c3c" : "#2ecc71"}; color: #000; font-weight: bold; }
  .confirm:disabled { background: #555; color: #999; cursor: not-allowed; }
  .error { color: #e74c3c; margin-top: 12px; }
  .info { color: #999; font-size: 13px; margin-top: 12px; }
</style></head>
<body>
  <div class="card">
    <h2>${heading}</h2>
    <p>${amountLine}</p>
    <p class="mint">${trade.mint}</p>
    ${error ? `<p class="error">${error}</p>` : ""}
    ${disabled ? `<p class="error">${disabledReason}</p>` : ""}
    <form method="POST" action="/confirm/${trade.id}/execute">
      <button class="confirm" type="submit" ${disabled ? "disabled" : ""}>${buttonLabel}</button>
    </form>
    <p class="info">This link expires 15 minutes from when the alert fired. ${isSell ? "The exact amount is checked live from your trading wallet's actual balance when you load this page." : "Price is quoted live at the moment you click confirm, not when the alert was sent."}</p>
  </div>
</body></html>`;
}

app.get("/confirm/:id", async (req, res) => {
  const trade = pendingTrades.get(req.params.id);
  if (!trade) return res.status(404).send(renderConfirmPage(
    { id: req.params.id, label: "Unknown", mint: "" },
    { disabled: true, disabledReason: "This trade link is invalid or has already been used." }
  ));

  if (trade.used) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Already executed." }));
  }
  if (Date.now() > trade.expiresAt) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "This link has expired." }));
  }
  if (!TRADING_ENABLED) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Trading is currently disabled (TRADING_ENABLED=false)." }));
  }
  if (!tradingKeypair) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "No valid trading wallet configured." }));
  }

  if (trade.type === "SELL") {
    const balance = await getTokenBalance(trade.mint);
    if (!balance || balance.uiAmount === 0) {
      return res.send(renderConfirmPage(trade, {
        disabled: true,
        disabledReason: "Trading wallet holds none of this token — nothing to sell.",
      }));
    }
    return res.send(renderConfirmPage(trade, { sellBalance: balance }));
  }

  // BUY-only: daily spend cap check
  checkAndResetDaily();
  if (dailySpentSol + TRADE_AMOUNT_SOL > MAX_DAILY_SOL) {
    return res.send(renderConfirmPage(trade, {
      disabled: true,
      disabledReason: `Daily spend cap reached (${dailySpentSol.toFixed(3)}/${MAX_DAILY_SOL} SOL). Resets at midnight UTC.`,
    }));
  }

  res.send(renderConfirmPage(trade));
});

app.post("/confirm/:id/execute", async (req, res) => {
  const trade = pendingTrades.get(req.params.id);
  if (!trade) return res.status(404).send("Trade not found or expired.");
  if (trade.used) return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Already executed." }));
  if (Date.now() > trade.expiresAt) return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Link expired." }));
  if (!TRADING_ENABLED || !tradingKeypair) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Trading is disabled or misconfigured." }));
  }

  if (trade.type === "SELL") {
    trade.used = true;
    try {
      const { signature, uiAmount } = await executeJupiterSell(trade.mint);
      await postToDiscord({
        embeds: [{
          title: `✅ Sold: ${trade.label}`,
          color: 0xe74c3c,
          description: `[View Transaction](https://solscan.io/tx/${signature})`,
          fields: [{ name: "Amount Sold", value: `${uiAmount} tokens`, inline: true }],
          timestamp: new Date().toISOString(),
        }],
      });
      return res.send(`<html><body style="font-family:sans-serif;background:#1a1a1a;color:#eee;padding:40px;text-align:center;">
        <h2>✅ Position sold</h2>
        <p><a href="https://solscan.io/tx/${signature}" style="color:#e74c3c;">View on Solscan</a></p>
      </body></html>`);
    } catch (err) {
      console.error("Sell execution failed:", err.message);
      trade.used = false;
      return res.send(renderConfirmPage(trade, { error: `Execution failed: ${err.message}. You can try again.` }));
    }
  }

  // BUY path
  checkAndResetDaily();
  if (dailySpentSol + TRADE_AMOUNT_SOL > MAX_DAILY_SOL) {
    return res.send(renderConfirmPage(trade, { disabled: true, disabledReason: "Daily spend cap reached." }));
  }

  trade.used = true; // mark used before executing so a double-click can't fire twice

  try {
    const signature = await executeJupiterSwap(trade.mint, TRADE_AMOUNT_SOL);
    dailySpentSol += TRADE_AMOUNT_SOL;

    await postToDiscord({
      embeds: [{
        title: `✅ Executed: ${trade.label}`,
        color: 0x2ecc71,
        description: `[View Transaction](https://solscan.io/tx/${signature})`,
        fields: [{ name: "Amount", value: `${TRADE_AMOUNT_SOL} SOL`, inline: true }],
        timestamp: new Date().toISOString(),
      }],
    });

    res.send(`<html><body style="font-family:sans-serif;background:#1a1a1a;color:#eee;padding:40px;text-align:center;">
      <h2>✅ Trade executed</h2>
      <p><a href="https://solscan.io/tx/${signature}" style="color:#2ecc71;">View on Solscan</a></p>
    </body></html>`);
  } catch (err) {
    console.error("Trade execution failed:", err.message);
    trade.used = false; // allow retry since it didn't actually go through
    res.send(renderConfirmPage(trade, { error: `Execution failed: ${err.message}. You can try again.` }));
  }
});

app.listen(PORT, () => {
  console.log(`Wallet alert bot listening on port ${PORT}`);
  console.log(`Tracking ${trackedWallets.size} wallet(s).`);
  if (agent) {
    agent.startTimers();
    agent.startupReport().catch((e) => console.error("Agent startup report failed:", e.message));
  } else if (agentStartupNote) {
    postToDiscord({ content: `⚠️ ${agentStartupNote}` }).catch(() => {});
  }
});
