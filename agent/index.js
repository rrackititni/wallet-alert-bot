"use strict";
// Copy-trade agent.
//
// Every buy from a tracked wallet that passes the wallet's filters is ALWAYS simulated in the
// paper ledger (real Jupiter quote at detection time = realistic fill + slippage vs the trader).
// If the wallet is set to "live" AND the global live switches are on, the same signal is also
// executed for real, subject to hard risk limits. Comparing the two shows what copying costs.

const { classify, involves, SOL_MINT } = require("./classify");
const { today } = require("./state");

const LAMPORTS = 1_000_000_000;
const toLamports = (sol) => Math.round(sol * LAMPORTS);
const short = (m) => `${m.slice(0, 4)}…${m.slice(-4)}`;
const fmt = (n, d = 4) => (n >= 0 ? "+" : "") + Number(n).toFixed(d);

function createAgent({ cfg, env, chain, rugcheck, post, state, now = Date.now, log = console }) {
  const S = state.data;
  const byLabel = new Map(cfg.wallets.map((w) => [w.label, w]));
  const seen = new Set();

  // One-time migration: the daily summary used to derive realized SOL / exit count / win
  // count / "fill vs trader" / "detect lag" by filtering S.paper.closed, an array capped at
  // 3000 entries SHARED across every wallet. Once total volume crossed that cap, old entries
  // silently evicted and those numbers became a rolling window instead of true running totals.
  // This seeds unbounded per-wallet counters (data.stats[label], same place signals/buySignals
  // already live) from whatever still happens to be in the capped arrays right now, so wallets
  // with history don't show 0 after this fix deploys. It's a best-effort baseline, not a
  // recovery of data already evicted before this ran — that's gone. Guarded by `_backfilled`
  // so it only ever runs once per wallet, even across restarts.
  (function backfillClosedStats() {
    let changed = false;
    for (const w of cfg.wallets) {
      const st = state.stat(w.label);
      if (st._backfilled) continue;
      const partials = S.paper.closed.filter((c) => c.wallet === w.label && c.partial);
      st.paperRealizedSol = (st.paperRealizedSol || 0) + partials.reduce((s, c) => s + c.pnlSol, 0);
      st.paperExits = (st.paperExits || 0) + partials.length;
      st.paperWins = (st.paperWins || 0) + partials.filter((c) => c.pnlSol > 0).length;
      const open = Object.values(S.paper.positions).filter((p) => p.wallet === w.label);
      const closedFull = S.paper.closed.filter((c) => c.wallet === w.label && !c.partial);
      for (const p of [...open, ...closedFull]) {
        if (typeof p.slipVsThemPct === "number") {
          st.slipSumPct = (st.slipSumPct || 0) + p.slipVsThemPct;
          st.slipCount = (st.slipCount || 0) + 1;
        }
        if (typeof p.lagSec === "number") {
          st.lagSumSec = (st.lagSumSec || 0) + p.lagSec;
          st.lagCount = (st.lagCount || 0) + 1;
        }
      }
      st._backfilled = true;
      changed = true;
    }
    if (changed) state.save();
  })();

  // Serializes everything that spends or sells real money so concurrent webhooks
  // can't both pass the same cap check.
  let lockChain = Promise.resolve();
  const withLock = (fn) => {
    const run = lockChain.then(fn);
    lockChain = run.catch(() => {});
    return run;
  };

  // Per (wallet, token) ordering. The server runs webhook events concurrently and a buy takes
  // seconds (quote, RugCheck, swap). Without this, a sell that lands mid-buy finds "no position"
  // and is discarded, which strands the bag after the trader has already exited.
  const keyChains = new Map();
  const serial = (key, fn) => {
    const prev = keyChains.get(key) || Promise.resolve();
    const run = prev.then(fn); // prev is always a never-rejecting tail
    const tail = run.catch(() => {});
    keyChains.set(key, tail);
    tail.then(() => {
      if (keyChains.get(key) === tail) keyChains.delete(key);
    });
    return run;
  };

  const liveEnabled = () => !!(env.agentLive && env.tradingEnabled && chain.canTrade);
  const skip = (w, reason, info) => state.skip(w.label, reason, info);
  const solscan = (s) => `https://solscan.io/tx/${s}`;
  const embed = (title, color, fields = [], description) =>
    post({ embeds: [{ title, color, description, fields, timestamp: new Date(now()).toISOString() }] });

  // In-memory feed of recent executed actions (buys/sells, paper and live) for the dashboard.
  // Deliberately NOT persisted and NOT a source of truth for anything — just the last 100
  // things that happened, newest first, so a live view has something to show. Never read this
  // for cumulative stats (that's the capped-array bug from before).
  const activity = [];
  const logEvent = (ev) => {
    activity.unshift({ ts: now(), ...ev });
    if (activity.length > 100) activity.length = 100;
  };
  function openPositionsSnapshot() {
    const rows = [];
    for (const p of Object.values(S.paper.positions))
      rows.push({ mode: "paper", wallet: p.wallet, mint: p.mint, costSol: +p.costSol.toFixed(4), openedAt: p.openedAt, theirUsd: p.theirUsd || null });
    for (const p of Object.values(S.live.positions))
      rows.push({ mode: "live", wallet: p.wallet, mint: p.mint, costSol: +p.costSol.toFixed(4), openedAt: p.openedAt });
    rows.sort((a, b) => b.openedAt - a.openedAt);
    return rows.slice(0, 60);
  }

  function rollDaily() {
    if (S.daily.date !== today()) S.daily = { date: today(), realizedSol: 0, lossAlerted: false };
  }

  async function priceCtx(sig) {
    const solUsd = await chain.getSolUsd();
    if (!solUsd) return null;
    const isSol = sig.base.kind === "SOL";
    const baseSol = isSol ? sig.base.amount : sig.base.amount / solUsd;
    const baseUsd = isSol ? sig.base.amount * solUsd : sig.base.amount;
    return { solUsd, baseSol, baseUsd, theirPriceSol: baseSol / sig.tokenAmount };
  }

  // ---------- entry point ----------
  async function handleWebhookTx(tx) {
    if (!tx || tx.transactionError) return;
    for (const w of cfg.wallets) {
      if (!involves(tx, w.address)) continue;
      const k = `${tx.signature}:${w.address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      if (seen.size > 5000) seen.clear();

      const res = classify(tx, w.address);
      if (res.skip) {
        if (res.skip !== "no-token-leg") skip(w, res.skip, { sig: tx.signature });
        continue;
      }
      try {
        state.bump(w.label, "signals");
        const key = `${w.label}:${res.signal.mint}`;
        if (res.signal.side === "BUY") await serial(key, () => processBuy(w, res.signal, tx));
        else await serial(key, () => processSell(w, res.signal));
      } catch (e) {
        state.bump(w.label, "errors");
        log.error(`agent error (${w.label}):`, e.message);
      }
    }
  }

  // ---------- BUY ----------
  async function processBuy(w, sig, tx) {
    state.bump(w.label, "buySignals");
    const key = `${w.label}:${sig.mint}`;
    const lagSec = Math.max(0, now() / 1000 - (tx.timestamp || now() / 1000));
    if (lagSec > w.maxLagSec) return skip(w, "stale", { mint: sig.mint, lagSec: Math.round(lagSec) });

    const pc = await priceCtx(sig);
    if (!pc) return skip(w, "no-sol-price", { mint: sig.mint });
    if (pc.baseUsd < w.minBuyUsd) return skip(w, "below-min-size", { mint: sig.mint, usd: Math.round(pc.baseUsd) });

    if (!w.mirrorAddOns && (S.paper.positions[key] || S.live.positions[key]))
      return skip(w, "add-on", { mint: sig.mint });

    // Real quote for OUR size at detection time = the paper fill.
    let q;
    try {
      q = await chain.quote(SOL_MINT, sig.mint, toLamports(w.sizeSol), w.slippageBps);
    } catch (e) {
      return skip(w, e.noRoute ? "no-route" : "quote-error", { mint: sig.mint, msg: e.message.slice(0, 80) });
    }
    const impact = Number(q.priceImpactPct || 0) * 100;
    if (impact > w.maxPriceImpactPct) return skip(w, "price-impact", { mint: sig.mint, impact: +impact.toFixed(2) });

    const rc = await rugcheck(sig.mint);
    if (w.skipOwnTokens && rc.creator && rc.creator === w.address) return skip(w, "own-token", { mint: sig.mint });
    if (rc.score != null && rc.score >= w.maxRugScore) return skip(w, "rug-score", { mint: sig.mint, score: rc.score });

    // ----- paper fill -----
    const decimals = await chain.getDecimals(sig.mint);
    let slip = null;
    if (decimals != null) {
      const ourUi = Number(q.outAmount) / 10 ** decimals;
      if (ourUi > 0) slip = (w.sizeSol / ourUi / pc.theirPriceSol - 1) * 100;
    }
    const existing = S.paper.positions[key];
    if (existing) {
      existing.costSol += w.sizeSol;
      existing.feeSol += env.paperFeeSol;
      existing.rawHeld = (BigInt(existing.rawHeld) + BigInt(q.outAmount)).toString();
    } else {
      const lagRounded = Math.round(lagSec * 10) / 10;
      S.paper.positions[key] = {
        key, wallet: w.label, mint: sig.mint, openedAt: now(),
        costSol: w.sizeSol, feeSol: env.paperFeeSol, rawHeld: String(q.outAmount), decimals,
        theirUsd: Math.round(pc.baseUsd), slipVsThemPct: slip, lagSec: lagRounded,
        priceImpactPct: +impact.toFixed(2), rugScore: rc.score, sig: sig.signature,
      };
      // Running totals for the "fill vs trader" / "detect lag" averages in the daily summary —
      // tracked here (unbounded) instead of re-derived from the capped positions/closed arrays.
      if (slip != null) {
        state.bump(w.label, "slipSumPct", slip);
        state.bump(w.label, "slipCount");
      }
      state.bump(w.label, "lagSumSec", lagRounded);
      state.bump(w.label, "lagCount");
    }
    if (S.sellAccum) delete S.sellAccum[key];
    state.bump(w.label, "paperBuys");
    logEvent({ type: "paper-buy", wallet: w.label, mint: sig.mint, sizeSol: w.sizeSol, theirUsd: Math.round(pc.baseUsd) });
    state.save();

    // ----- live (optional) -----
    if (w.mode === "live" && liveEnabled() && !S.paused) {
      await withLock(() => liveBuy(w, sig, rc, key));
    }
  }

  async function liveBuy(w, sig, rc, key) {
    rollDaily();
    if (S.paused) return skip(w, "paused", { mint: sig.mint });
    if (S.daily.realizedSol <= -env.dailyLossSol) {
      if (!S.daily.lossAlerted) {
        S.daily.lossAlerted = true;
        state.save();
        await embed("🛑 Daily loss limit hit — live buys paused until 00:00 UTC", 0xe74c3c, [
          { name: "Realized today", value: `${fmt(S.daily.realizedSol)} SOL`, inline: true },
          { name: "Limit", value: `-${env.dailyLossSol} SOL`, inline: true },
        ]);
      }
      return skip(w, "daily-loss-limit", { mint: sig.mint });
    }
    const open = Object.values(S.live.positions);
    if (open.length >= env.maxPositions) return skip(w, "max-positions", { mint: sig.mint });
    if (open.some((p) => p.mint === sig.mint)) return skip(w, "already-holding", { mint: sig.mint });
    const committed = open.reduce((s, p) => s + p.costSol, 0);
    if (committed + w.sizeSol > env.budgetSol) return skip(w, "budget", { mint: sig.mint });
    // Live money fails closed: unknown creator/score means we can't verify the two rules that matter.
    if (rc.score == null || !rc.creator) return skip(w, "live-unknown-risk", { mint: sig.mint });

    const bal = await chain.getSolBalance();
    if (bal - w.sizeSol < env.solReserve) return skip(w, "sol-reserve", { mint: sig.mint, bal: +bal.toFixed(3) });

    let signature;
    try {
      const q = await chain.quote(SOL_MINT, sig.mint, toLamports(w.sizeSol), env.slippageBps);
      const impact = Number(q.priceImpactPct || 0) * 100;
      if (impact > w.maxPriceImpactPct) return skip(w, "price-impact-live", { mint: sig.mint, impact: +impact.toFixed(2) });
      signature = await chain.swap(q);
    } catch (e) {
      state.bump(w.label, "liveErrors");
      return void (await embed(`⚠️ Live buy failed: ${w.label}`, 0xf1c40f, [
        { name: "Token", value: `\`${sig.mint}\``, inline: false },
        { name: "Error", value: e.message.slice(0, 300), inline: false },
      ]));
    }

    const fill = await chain.getTxBalances(signature, chain.owner, sig.mint);
    let gotRaw = fill ? fill.postRaw - fill.preRaw : 0n;
    if (gotRaw <= 0n) gotRaw = await chain.getTokenBalanceRaw(sig.mint).catch(() => 0n);
    S.live.positions[key] = {
      key, wallet: w.label, mint: sig.mint, openedAt: now(), costSol: w.sizeSol,
      feeSol: fill && fill.feeLamports ? fill.feeLamports / LAMPORTS : 0,
      rawHeld: gotRaw.toString(), sig: signature,
    };
    state.bump(w.label, "liveBuys");
    logEvent({ type: "live-buy", wallet: w.label, mint: sig.mint, sizeSol: w.sizeSol });
    state.save();
    await embed(`🟢 LIVE BUY (mirroring ${w.label})`, 0x2ecc71, [
      { name: "Token", value: `\`${sig.mint}\``, inline: false },
      { name: "Size", value: `${w.sizeSol} SOL`, inline: true },
      { name: "RugCheck", value: String(rc.score), inline: true },
    ], `[Transaction](${solscan(signature)})`);
  }

  // ---------- SELL ----------
  // Fraction of their position they just sold. Exact from the tx's pre/post balances;
  // falls back to post-balance math; if both fail we assume a full exit (fail safe on rugs).
  async function theirSellFraction(w, sig) {
    const b = await chain.getTxBalances(sig.signature, w.address, sig.mint);
    if (b && b.preRaw > 0n) {
      const sold = b.preRaw - b.postRaw;
      if (sold > 0n) return Math.min(1, Number(sold) / Number(b.preRaw));
    }
    const postUi = await chain.getTokenBalanceUi(w.address, sig.mint);
    if (postUi != null) return Math.min(1, sig.tokenAmount / (sig.tokenAmount + postUi));
    return 1;
  }

  async function processSell(w, sig) {
    state.bump(w.label, "sellSignals");
    if (!w.mirrorSells) return skip(w, "sells-disabled", { mint: sig.mint });
    const key = `${w.label}:${sig.mint}`;
    const hasPaper = !!S.paper.positions[key];
    const hasLive = !!S.live.positions[key];
    if (!hasPaper && !hasLive) return state.bump(w.label, "sellNoPosition");

    const theirF = await theirSellFraction(w, sig);
    // Batch small trims: 1-4% sells would each cost a real swap fee. Track the combined fraction
    // they've sold since our last mirrored sell, and act once it crosses minSellFraction.
    // A big sell (>=90%) is a full exit and always goes through immediately.
    S.sellAccum = S.sellAccum || {};
    let f = 1 - (1 - (S.sellAccum[key] || 0)) * (1 - theirF);
    if (theirF >= 0.9) f = 1;
    if (f < w.minSellFraction) {
      S.sellAccum[key] = f;
      state.bump(w.label, "sellDeferred");
      return state.save();
    }
    delete S.sellAccum[key];
    const jobs = [];
    if (hasPaper) jobs.push(paperExit(w, key, f));
    if (hasLive && env.agentLive && env.tradingEnabled && chain.canTrade)
      jobs.push(withLock(() => liveExit(w, key, f, "mirror")));
    else if (hasLive)
      jobs.push(embed(`⚠️ ${w.label} sold but live execution is disabled`, 0xf1c40f, [
        { name: "Token", value: `\`${sig.mint}\``, inline: false },
        { name: "Action", value: "Sell manually, or set TRADING_ENABLED/AGENT_LIVE and redeploy.", inline: false },
      ]));
    await Promise.allSettled(jobs);
  }

  const partialRaw = (raw, f) => (f >= 0.9 ? raw : (raw * BigInt(Math.round(f * 10000))) / 10000n);

  async function paperExit(w, key, f) {
    const pos = S.paper.positions[key];
    const raw = BigInt(pos.rawHeld);
    const sellRaw = partialRaw(raw, f);
    if (sellRaw <= 0n) return;
    const frac = Number(sellRaw) / Number(raw);
    let solOut = 0;
    let unsellable = false;
    try {
      const q = await chain.quote(pos.mint, SOL_MINT, sellRaw, w.slippageBps);
      solOut = Number(q.outAmount) / LAMPORTS;
    } catch {
      unsellable = true; // no exit route = we'd be stuck holding it; count as a total loss
    }
    const pnl = solOut - pos.costSol * frac - pos.feeSol * frac - env.paperFeeSol;
    pos.costSol *= 1 - frac;
    pos.feeSol *= 1 - frac;
    pos.rawHeld = (raw - sellRaw).toString();
    if (frac >= 0.999 || pos.rawHeld === "0") {
      S.paper.closed.push({ ...pos, closedAt: now(), pnlSolPart: pnl, unsellable });
      delete S.paper.positions[key];
    } else {
      pos.realizedSol = (pos.realizedSol || 0) + pnl;
    }
    S.paper.closed.push({ key, wallet: w.label, mint: pos.mint, closedAt: now(), partial: true, pnlSol: pnl, unsellable });
    if (S.paper.closed.length > 3000) S.paper.closed.splice(0, S.paper.closed.length - 3000);
    // Running totals for the daily summary — this array is a capped debug log, not the source
    // of truth, so realized SOL / exit count / win count must never be re-derived from it.
    state.bump(w.label, "paperRealizedSol", pnl);
    state.bump(w.label, "paperExits");
    if (pnl > 0) state.bump(w.label, "paperWins");
    state.bump(w.label, "paperSells");
    logEvent({ type: "paper-sell", wallet: w.label, mint: pos.mint, pnlSol: +pnl.toFixed(4), pct: Math.round(frac * 100) });
    state.save();
  }

  async function liveExit(w, key, f, why) {
    const pos = S.live.positions[key];
    if (!pos) return { ok: true };
    let bal;
    try {
      bal = await chain.getTokenBalanceRaw(pos.mint);
    } catch (e) {
      return { ok: false, error: `balance read failed: ${e.message}` };
    }
    if (bal === 0n) {
      delete S.live.positions[key];
      state.save();
      await embed(`ℹ️ Live position already empty: ${pos.wallet}`, 0x95a5a6, [{ name: "Token", value: `\`${pos.mint}\`` }]);
      return { ok: true };
    }
    const sellRaw = partialRaw(bal, f);
    if (sellRaw <= 0n) return { ok: true };

    let signature, lastErr, quoteOut = 0;
    for (const bps of [env.slippageBps, Math.min(env.slippageBps * 2, 2000)]) {
      try {
        const q = await chain.quote(pos.mint, SOL_MINT, sellRaw, bps);
        quoteOut = Number(q.outAmount) / LAMPORTS;
        signature = await chain.swap(q);
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!signature) {
      state.bump(w.label, "liveErrors");
      await embed(`🚨 LIVE SELL FAILED: ${pos.wallet}`, 0xe74c3c, [
        { name: "Token", value: `\`${pos.mint}\``, inline: false },
        { name: "Error", value: String(lastErr && lastErr.message).slice(0, 300), inline: false },
        { name: "Action", value: "Position is still open. Sell manually or hit /agent/panic.", inline: false },
      ]);
      return { ok: false, error: lastErr && lastErr.message };
    }

    const fill = await chain.getTxBalances(signature, chain.owner, pos.mint);
    const solOut = fill && fill.solDeltaLamports != null ? fill.solDeltaLamports / LAMPORTS : quoteOut;
    const frac = Number(sellRaw) / Number(bal);
    const pnl = solOut - pos.costSol * frac - pos.feeSol * frac;
    pos.costSol *= 1 - frac;
    pos.feeSol *= 1 - frac;
    pos.rawHeld = (bal - sellRaw).toString();
    rollDaily();
    S.daily.realizedSol += pnl;
    if (frac >= 0.999 || pos.rawHeld === "0") {
      S.live.closed.push({ ...pos, closedAt: now(), pnlSolPart: pnl });
      delete S.live.positions[key];
    }
    if (S.live.closed.length > 1000) S.live.closed.splice(0, S.live.closed.length - 1000);
    state.bump(w.label, "liveSells");
    logEvent({ type: "live-sell", wallet: pos.wallet, mint: pos.mint, pnlSol: +pnl.toFixed(4), pct: Math.round(frac * 100) });
    state.save();
    await embed(`🔴 LIVE SELL (${why === "panic" ? "panic" : "mirroring"} ${pos.wallet})`, 0xe74c3c, [
      { name: "Token", value: `\`${pos.mint}\``, inline: false },
      { name: "Sold", value: `${Math.round(frac * 100)}% of position`, inline: true },
      { name: "PnL (approx)", value: `${fmt(pnl)} SOL`, inline: true },
      { name: "Today", value: `${fmt(S.daily.realizedSol)} SOL`, inline: true },
    ], `[Transaction](${solscan(signature)})`);
    return { ok: true };
  }

  // ---------- admin ----------
  async function pause() {
    S.paused = true;
    state.save();
    await embed("⏸️ Agent paused — no new live buys (exits still run)", 0xf1c40f);
  }
  async function resume() {
    S.paused = false;
    state.save();
    await embed("▶️ Agent resumed", 0x2ecc71);
  }
  async function panic() {
    S.paused = true;
    state.save();
    const results = [];
    for (const pos of Object.values(S.live.positions)) {
      const w = byLabel.get(pos.wallet) || { label: pos.wallet };
      const r = await withLock(() => liveExit(w, pos.key, 1, "panic"));
      results.push({ mint: pos.mint, ok: r.ok, error: r.error });
    }
    await embed("🧯 PANIC: paused and sold all live positions", 0xe74c3c, [
      { name: "Result", value: results.length ? results.map((r) => `${short(r.mint)}: ${r.ok ? "sold" : "FAILED"}`).join("\n") : "No open live positions", inline: false },
    ]);
    return results;
  }

  function status() {
    rollDaily();
    const liveOpen = Object.values(S.live.positions);
    return {
      paused: S.paused,
      liveArmed: liveEnabled(),
      persistence: state.persistent ? state.file : "memory-only (wiped on redeploy)",
      wallets: cfg.wallets.map((w) => ({ label: w.label, mode: w.mode })),
      limits: {
        budgetSol: env.budgetSol, maxPositions: env.maxPositions,
        dailyLossSol: env.dailyLossSol, solReserve: env.solReserve,
      },
      live: {
        open: liveOpen.length,
        committedSol: +liveOpen.reduce((s, p) => s + p.costSol, 0).toFixed(4),
        realizedTodaySol: +S.daily.realizedSol.toFixed(4),
      },
      paperOpen: Object.keys(S.paper.positions).length,
      stats: S.stats,
      recentSkips: S.skipLog.slice(-15),
    };
  }

  // ---------- summary ----------
  async function buildSummary() {
    const rows = [];
    let marked = 0;
    for (const w of cfg.wallets) {
      const st = S.stats[w.label] || { skipped: {} };
      // realized / exits / wins / avg slip / avg lag are running totals (see backfillClosedStats
      // and the bumps in processBuy/paperExit) — NOT derived from S.paper.closed, which is a
      // capped debug log that silently evicts old entries once total volume crosses 3000.
      const realized = st.paperRealizedSol || 0;
      const exits = st.paperExits || 0;
      const wins = st.paperWins || 0;
      const avgSlip = st.slipCount ? st.slipSumPct / st.slipCount : null;
      const avgLag = st.lagCount ? st.lagSumSec / st.lagCount : null;
      const open = Object.values(S.paper.positions).filter((p) => p.wallet === w.label);
      let unrealized = 0;
      let unmarkable = 0;
      for (const p of open) {
        if (marked >= 30) break;
        marked++;
        try {
          const q = await chain.quote(p.mint, SOL_MINT, BigInt(p.rawHeld), w.slippageBps);
          unrealized += Number(q.outAmount) / LAMPORTS - p.costSol - p.feeSol;
        } catch {
          unmarkable++;
          unrealized -= p.costSol + p.feeSol;
        }
      }
      const topSkips = Object.entries(st.skipped || {}).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, v]) => `${k} ${v}`).join(", ") || "none";
      const liveOpen = Object.values(S.live.positions).filter((p) => p.wallet === w.label).length;
      rows.push({
        name: `${w.label} (${w.mode})`,
        value: [
          `Signals ${st.signals || 0} · buys ${st.buySignals || 0} · paper entries ${st.paperBuys || 0}`,
          `Paper: ${open.length} open, ${exits} exits (${wins} wins) · realized ${fmt(realized)} SOL · unrealized ${fmt(unrealized)} SOL${unmarkable ? ` (${unmarkable} unsellable)` : ""}`,
          `Fill vs trader: ${avgSlip == null ? "n/a" : fmt(avgSlip, 1) + "%"} avg · detect lag ${avgLag == null ? "n/a" : avgLag.toFixed(1) + "s"}`,
          `Top skips: ${topSkips}`,
          w.mode === "live" ? `Live: ${liveOpen} open · ${st.liveBuys || 0} buys · ${st.liveSells || 0} sells` : null,
        ].filter(Boolean).join("\n").slice(0, 1000),
        inline: false,
      });
    }
    return rows;
  }

  async function postSummary(title = "Agent summary") {
    const fields = await buildSummary();
    await embed(`📊 ${title}`, 0x3498db, fields, `Live realized today: ${fmt(S.daily.realizedSol)} SOL`);
  }

  // ---------- startup + timers ----------
  async function startupReport() {
    let jup = "unknown";
    try {
      const p = await chain.getSolUsd();
      jup = p ? `OK (SOL ≈ $${p.toFixed(2)})` : "FAILED — no price. Check JUP_BASE / JUP_API_KEY";
    } catch (e) {
      jup = `FAILED: ${e.message}`;
    }
    await embed("🤖 Agent online", 0x3498db, [
      { name: "Mode", value: liveEnabled() ? "LIVE armed (live wallets trade real money)" : "Paper only", inline: true },
      { name: "State", value: state.persistent ? "persistent" : "memory-only ⚠️ (add a volume + DATA_DIR)", inline: true },
      { name: "Jupiter", value: jup, inline: false },
      { name: "Wallets", value: cfg.wallets.map((w) => `${w.label} (${w.mode})`).join(", "), inline: false },
    ]);
  }

  function startTimers() {
    const t = setInterval(async () => {
      try {
        rollDaily();
        if (S.lastSummaryDate !== today()) {
          S.lastSummaryDate = today();
          state.save();
          await postSummary("Daily summary");
        }
      } catch (e) {
        log.error("agent timer error:", e.message);
      }
    }, 60_000);
    if (t.unref) t.unref();
  }

  function registerRoutes(app, isAdmin) {
    const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const actions = {
      status: async () => status(),
      summary: async () => (await postSummary("Agent summary (on demand)"), { posted: true }),
      pause: async () => (await pause(), { paused: true }),
      resume: async () => (await resume(), { paused: false }),
      panic: async (req) => {
        if (String((req.body || {}).confirm) !== "yes") return { error: "Tick the confirm box to sell ALL live positions." };
        return { results: await panic() };
      },
      activity: async () => ({
        paused: S.paused,
        liveArmed: liveEnabled(),
        wallets: cfg.wallets.map((w) => ({ label: w.label, mode: w.mode })),
        events: activity.slice(0, 50),
        open: openPositionsSnapshot(),
      }),
    };

    // JSON API. Token goes in the x-admin-token header (never the URL: URLs end up in logs and history).
    // Anything that changes state is POST, so a link preview or prefetch can never trigger it.
    const guard = (fn) => async (req, res) => {
      if (!isAdmin(req)) return res.status(401).json({ error: "unauthorized" });
      try {
        res.json(await fn(req));
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    };
    app.get("/agent/status", guard(actions.status));
    for (const name of ["summary", "pause", "resume", "panic"]) app.post(`/agent/${name}`, guard(actions[name]));

    // /agent/activity is read by the Rackitini City dashboard artifact, running on a different
    // origin, so (unlike the other routes above) it needs CORS. Still token-gated — the wildcard
    // origin only matters once the request already carries a valid x-admin-token header.
    const activityCors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "x-admin-token, Content-Type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
    app.options("/agent/activity", (req, res) => res.set(activityCors).sendStatus(204));
    app.get("/agent/activity", (req, res, next) => { res.set(activityCors); next(); }, guard(actions.activity));

    // Phone-friendly page: type the token, tap a button. Token travels in the POST body only.
    const page = (body) => `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent</title><style>
body{font-family:-apple-system,sans-serif;background:#1a1a1a;color:#eee;margin:0;padding:20px;max-width:520px}
input[type=password]{width:100%;padding:12px;font-size:16px;border-radius:8px;border:none;box-sizing:border-box}
button{width:100%;padding:14px;font-size:16px;border-radius:8px;border:none;margin-top:10px}
.danger{background:#e74c3c;color:#000;font-weight:bold}pre{white-space:pre-wrap;word-break:break-word;background:#2a2a2a;padding:12px;border-radius:8px;font-size:12px}
label{display:block;margin-top:14px}</style></head><body><h2>Copy-trade agent</h2>${body}</body></html>`;
    const form = `<form method="POST" action="/agent/admin">
<input type="password" name="token" placeholder="Admin token" autocomplete="current-password" required>
<button name="action" value="status">Status</button>
<button name="action" value="summary">Post summary to Discord</button>
<button name="action" value="pause">Pause new live buys</button>
<button name="action" value="resume">Resume</button>
<label><input type="checkbox" name="confirm" value="yes"> I want to sell ALL live positions now</label>
<button class="danger" name="action" value="panic">PANIC: pause + sell everything</button></form>`;
    app.get("/agent/admin", (req, res) => {
      res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY" }).type("html").send(page(form));
    });
    app.post("/agent/admin", async (req, res) => {
      res.set({ "Cache-Control": "no-store", "X-Frame-Options": "DENY" }).type("html");
      if (!isAdmin(req)) return res.status(401).send(page(`<p>Wrong token.</p>${form}`));
      const run = actions[(req.body || {}).action];
      if (!run) return res.status(400).send(page(`<p>Unknown action.</p>${form}`));
      try {
        const out = await run(req);
        res.send(page(`<pre>${esc(JSON.stringify(out, null, 2))}</pre><p><a style="color:#3498db" href="/agent/admin">Back</a></p>`));
      } catch (e) {
        res.status(500).send(page(`<p>Error: ${esc(e.message)}</p>${form}`));
      }
    });
  }

  return { handleWebhookTx, registerRoutes, startupReport, startTimers, postSummary, status, pause, resume, panic };
}

module.exports = { createAgent };
