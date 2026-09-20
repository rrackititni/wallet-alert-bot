"use strict";
// One RugCheck call gives us both the risk score and the token creator.
// Only successful lookups are cached; unknowns are retried next time.
const cache = new Map();
const TTL_MS = 10 * 60 * 1000;

async function fetchRugCheck(mint) {
  const hit = cache.get(mint);
  if (hit && hit.exp > Date.now()) return hit.v;
  const v = { score: null, creator: null, topRisks: [] };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      v.score = data.score_normalised ?? data.score ?? null;
      v.creator = data.creator || data.creatorAddress || null;
      v.topRisks = (Array.isArray(data.risks) ? data.risks : []).slice(0, 3).map((r) => r.name).filter(Boolean);
    }
  } catch {
    // timeout / network / bad JSON -> unknown
  }
  if (v.score != null) cache.set(mint, { v, exp: Date.now() + TTL_MS });
  return v;
}

module.exports = { fetchRugCheck };
