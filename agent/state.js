"use strict";
// Small JSON-file ledger. Point DATA_DIR at a Railway volume so it survives redeploys;
// without one it still works but is wiped on every deploy (createState reports which).
const fs = require("fs");
const path = require("path");

const today = () => new Date().toISOString().slice(0, 10);

function fresh() {
  return {
    version: 1,
    paused: false,
    daily: { date: today(), realizedSol: 0, lossAlerted: false },
    paper: { positions: {}, closed: [] },
    live: { positions: {}, closed: [] },
    stats: {},
    sellAccum: {},
    skipLog: [],
    lastSummaryDate: today(),
  };
}

function createState({ dir, log = console } = {}) {
  const file = dir ? path.join(dir, "agent-state.json") : null;
  let persistent = false;
  const data = fresh();

  if (file) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      if (fs.existsSync(file)) {
        try {
          Object.assign(data, JSON.parse(fs.readFileSync(file, "utf8")));
        } catch (e) {
          const bad = `${file}.corrupt-${Date.now()}`;
          fs.renameSync(file, bad);
          log.error(`agent state unreadable, moved to ${bad}; starting fresh`);
        }
      }
      persistent = true;
    } catch (e) {
      log.error("agent state directory not writable; running in memory only:", e.message);
    }
  }

  let timer = null;
  function flush() {
    if (!persistent) return;
    try {
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, file);
    } catch (e) {
      log.error("agent state save failed:", e.message);
    }
  }
  function save() {
    if (!persistent || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 300);
    if (timer.unref) timer.unref();
  }

  const stat = (label) => (data.stats[label] = data.stats[label] || { skipped: {} });
  function bump(label, key, n = 1) {
    const s = stat(label);
    s[key] = (s[key] || 0) + n;
    save();
  }
  function skip(label, reason, info = {}) {
    const s = stat(label);
    s.skipped[reason] = (s.skipped[reason] || 0) + 1;
    data.skipLog.push({ t: Date.now(), wallet: label, reason, ...info });
    if (data.skipLog.length > 300) data.skipLog.splice(0, data.skipLog.length - 300);
    save();
  }

  return { data, persistent, file, save, flush, bump, skip, stat };
}

module.exports = { createState, today };
