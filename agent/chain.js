"use strict";
// Jupiter quotes/swaps + the few RPC reads the agent needs.
// Everything network-facing lives here so the trading logic can be tested with a stub.

const { VersionedTransaction, PublicKey } = require("@solana/web3.js");
const { SOL_MINT, USDC_MINT } = require("./classify");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTimeout(url, opts = {}, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function createChain({ connection, keypair, base, apiKey, priorityFeeLamports = 200000 }) {
  const owner = keypair ? keypair.publicKey.toBase58() : null;
  const authHeaders = apiKey ? { "x-api-key": apiKey } : {};
  const decimalsCache = new Map();
  let solUsdCache = { v: null, t: 0 };

  async function quote(inputMint, outputMint, amountRaw, slippageBps) {
    const url = new URL(`${base}/quote`);
    url.searchParams.set("inputMint", inputMint);
    url.searchParams.set("outputMint", outputMint);
    url.searchParams.set("amount", String(amountRaw));
    url.searchParams.set("slippageBps", String(slippageBps));
    const res = await fetchTimeout(url, { headers: authHeaders }, 6000);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 200);
      const err = new Error(`Jupiter quote ${res.status}: ${body}`);
      err.status = res.status;
      err.noRoute = [400, 404].includes(res.status) && /route|tradable|liquidity|not found/i.test(body);
      throw err;
    }
    return res.json();
  }

  async function getSolUsd() {
    if (solUsdCache.v && Date.now() - solUsdCache.t < 60_000) return solUsdCache.v;
    try {
      const q = await quote(SOL_MINT, USDC_MINT, 1_000_000_000, 100);
      const v = Number(q.outAmount) / 1e6;
      if (v > 0) solUsdCache = { v, t: Date.now() };
    } catch {
      // fall through to last known price
    }
    return solUsdCache.v;
  }

  async function getDecimals(mint) {
    if (decimalsCache.has(mint)) return decimalsCache.get(mint);
    try {
      const info = await connection.getParsedAccountInfo(new PublicKey(mint));
      const d = info && info.value && info.value.data && info.value.data.parsed
        ? info.value.data.parsed.info.decimals
        : null;
      if (typeof d === "number") decimalsCache.set(mint, d);
      return typeof d === "number" ? d : null;
    } catch {
      return null;
    }
  }

  // Raw (smallest-unit) balance of `mint` held by `who` (default: our trading wallet).
  async function getTokenBalanceRaw(mint, who = owner) {
    const accts = await connection.getParsedTokenAccountsByOwner(new PublicKey(who), { mint: new PublicKey(mint) });
    return accts.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
  }

  async function getTokenBalanceUi(who, mint) {
    try {
      const accts = await connection.getParsedTokenAccountsByOwner(new PublicKey(who), { mint: new PublicKey(mint) });
      return accts.value.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
    } catch {
      return null;
    }
  }

  async function getSolBalance() {
    return (await connection.getBalance(keypair.publicKey)) / 1e9;
  }

  // Exact pre/post balances for `who` in a confirmed tx: used for (a) the fraction a tracked
  // wallet actually sold and (b) our own real fills. Retries briefly since RPC can lag.
  async function getTxBalances(signature, who, mint) {
    for (let i = 0; i < 4; i++) {
      try {
        const t = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        if (t && t.meta) {
          const keys = t.transaction.message.accountKeys.map((k) => String(k.pubkey));
          const idx = keys.indexOf(who);
          const sum = (arr) =>
            (arr || [])
              .filter((b) => b.owner === who && b.mint === mint)
              .reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
          return {
            preRaw: sum(t.meta.preTokenBalances),
            postRaw: sum(t.meta.postTokenBalances),
            solDeltaLamports: idx >= 0 ? t.meta.postBalances[idx] - t.meta.preBalances[idx] : null,
            feeLamports: t.meta.fee,
          };
        }
      } catch {
        // retry
      }
      await sleep(500);
    }
    return null;
  }

  // Build, sign, send, and CONFIRM a Jupiter swap. Throws if it fails on-chain
  // (a "confirmed" transaction can still carry an error, e.g. slippage exceeded).
  async function swap(quoteResp) {
    if (!keypair) throw new Error("No trading wallet configured");
    const res = await fetchTimeout(
      `${base}/swap`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          quoteResponse: quoteResp,
          userPublicKey: owner,
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: priorityFeeLamports,
        }),
      },
      10000
    );
    if (!res.ok) throw new Error(`Jupiter swap build ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const { swapTransaction, lastValidBlockHeight } = await res.json();

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([keypair]);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const lvbh = lastValidBlockHeight ?? (await connection.getLatestBlockhash()).lastValidBlockHeight;
    const conf = await connection.confirmTransaction(
      { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: lvbh },
      "confirmed"
    );
    if (conf.value.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(conf.value.err)}`);
    return signature;
  }

  return {
    owner,
    canTrade: !!keypair,
    quote,
    swap,
    getSolUsd,
    getDecimals,
    getTokenBalanceRaw,
    getTokenBalanceUi,
    getSolBalance,
    getTxBalances,
  };
}

module.exports = { createChain };
