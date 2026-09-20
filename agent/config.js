"use strict";
const fs = require("fs");
const bs58 = require("bs58");

const DEFAULTS = {
  mode: "paper", // "paper" | "live" (live also needs AGENT_LIVE=true + TRADING_ENABLED=true)
  sizeSol: 0.05, // SOL per mirrored buy
  minBuyUsd: 100, // ignore their buys smaller than this (filters scalp churn/dust)
  maxPriceImpactPct: 3, // skip if OUR size would move the price more than this
  maxRugScore: 60, // RugCheck normalised score at/above this = skip
  skipOwnTokens: true, // skip tokens this wallet created
  mirrorAddOns: false, // only mirror the first buy of a token, not every add
  mirrorSells: true,
  minSellFraction: 0.1, // batch their small trims; act once combined sells reach this share (>=90% = full exit, always immediate)
  maxLagSec: 30, // skip signals we detect later than this after the block time
  slippageBps: 500,
};

function isAddress(a) {
  try {
    return typeof a === "string" && bs58.decode(a).length === 32;
  } catch {
    return false;
  }
}

function loadAgentConfig(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const defaults = { ...DEFAULTS, ...(raw.defaults || {}) };
  const labels = new Set();
  const addrs = new Set();
  const wallets = (raw.wallets || []).map((w, i) => {
    const merged = { ...defaults, ...w };
    if (!isAddress(merged.address)) throw new Error(`agent-config wallet #${i + 1}: invalid address`);
    if (!merged.label) throw new Error(`agent-config wallet #${i + 1}: missing label`);
    if (labels.has(merged.label)) throw new Error(`agent-config: duplicate label ${merged.label}`);
    if (addrs.has(merged.address)) throw new Error(`agent-config: duplicate address for ${merged.label}`);
    labels.add(merged.label);
    addrs.add(merged.address);
    if (!["paper", "live"].includes(merged.mode)) throw new Error(`${merged.label}: mode must be "paper" or "live"`);
    for (const k of ["sizeSol", "minBuyUsd", "maxPriceImpactPct", "maxRugScore", "maxLagSec", "slippageBps", "minSellFraction"]) {
      if (!Number.isFinite(merged[k]) || merged[k] <= 0) throw new Error(`${merged.label}: ${k} must be a positive number`);
    }
    if (merged.minSellFraction > 1) throw new Error(`${merged.label}: minSellFraction must be between 0 and 1`);
    return merged;
  });
  if (wallets.length === 0) throw new Error("agent-config: no wallets listed");
  return { wallets };
}

module.exports = { loadAgentConfig, DEFAULTS };
