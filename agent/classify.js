"use strict";
// Turns a Helius enhanced transaction into a normalized BUY/SELL signal for ONE wallet.
//
// It works from the wallet's NET balance changes rather than feePayer/first-transfer,
// so it correctly handles:
//   - USDC/USDT-denominated swaps (the old alert heuristic read these as SELLs)
//   - pump.fun bonding-curve trades, where the SOL leg is a native balance change
//   - transactions relayed by someone else (wallet isn't the fee payer)
//   - multi-hop routes (intermediate tokens net to zero and drop out)

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const STABLES = [USDC_MINT, USDT_MINT];
const BASES = new Set([SOL_MINT, ...STABLES]);
const EPS = 1e-9;
const MIN_BASE_SOL = 0.005; // below this, SOL movement is fee/rent noise, not a trade leg
const MIN_BASE_STABLE = 1; // $1

function involves(tx, wallet) {
  if (tx.feePayer === wallet) return true;
  if ((tx.accountData || []).some((a) => a.account === wallet)) return true;
  return (tx.tokenTransfers || []).some(
    (t) => t.fromUserAccount === wallet || t.toUserAccount === wallet
  );
}

// Returns { skip: "reason" } or { signal: {...} }
function classify(tx, wallet) {
  const nets = new Map(); // mint -> net UI amount for this wallet
  const add = (m, v) => nets.set(m, (nets.get(m) || 0) + v);

  for (const t of tx.tokenTransfers || []) {
    const amt = Number(t.tokenAmount) || 0;
    if (!t.mint || !amt) continue;
    if (t.toUserAccount === wallet) add(t.mint, amt);
    if (t.fromUserAccount === wallet) add(t.mint, -amt);
  }

  // SOL leg: native balance change and WSOL transfers can double-describe the same
  // movement (wrap/unwrap), so take whichever is larger instead of summing.
  const ad = (tx.accountData || []).find((a) => a.account === wallet);
  const nativeNet = ad ? (Number(ad.nativeBalanceChange) || 0) / 1e9 : 0;
  const wsolNet = nets.get(SOL_MINT) || 0;
  const solNet = Math.abs(wsolNet) > Math.abs(nativeNet) ? wsolNet : nativeNet;

  const tokens = [...nets.entries()].filter(([m, v]) => !BASES.has(m) && Math.abs(v) > EPS);
  if (tokens.length === 0) return { skip: "no-token-leg" };
  if (tokens.length > 1) return { skip: "multi-token" };

  const [mint, tokenNet] = tokens[0];
  const side = tokenNet > 0 ? "BUY" : "SELL";
  const wantSign = side === "BUY" ? -1 : 1; // base asset must move the opposite way

  const stable = STABLES.map((m) => [m, nets.get(m) || 0])
    .filter(([, v]) => Math.sign(v) === wantSign && Math.abs(v) >= MIN_BASE_STABLE)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];

  let base = null;
  if (stable) base = { mint: stable[0], kind: "STABLE", amount: Math.abs(stable[1]) };
  else if (Math.sign(solNet) === wantSign && Math.abs(solNet) >= MIN_BASE_SOL)
    base = { mint: SOL_MINT, kind: "SOL", amount: Math.abs(solNet) };

  if (!base) {
    // A BUY must show money going out. A SELL only needs to look like a swap
    // (a tiny dust sale can fall under the noise floor, and we only need its fraction).
    const swapLike = tx.type === "SWAP" || !!(tx.events && tx.events.swap);
    if (side === "SELL" && swapLike) base = { mint: SOL_MINT, kind: "SOL", amount: 0 };
    else return { skip: "no-base-leg" };
  }

  return {
    signal: {
      side,
      mint,
      tokenAmount: Math.abs(tokenNet),
      base,
      signature: tx.signature,
      timestamp: tx.timestamp || null,
      wallet,
    },
  };
}

module.exports = { classify, involves, SOL_MINT, USDC_MINT, USDT_MINT };
