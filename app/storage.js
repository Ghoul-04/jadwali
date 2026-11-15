// app/storage.js — Telegram CloudStorage with a localStorage mirror/fallback.
// Values are JSON. Each CloudStorage value must stay under 4096 chars, so state
// is split across a few keys and old overrides are pruned.

import { tg } from './telegram.js';

const PREFIX = 'jadwali.';
const CLOUD_TIMEOUT = 2500;

function lsGet(key) {
  try { const v = localStorage.getItem(PREFIX + key); return v == null ? null : JSON.parse(v); } catch { return null; }
}
function lsSet(key, value) {
  try {
    if (value === undefined || value === null) localStorage.removeItem(PREFIX + key);
    else localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {}
}

function withTimeout(promise) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CLOUD_TIMEOUT))]);
}

function cloudGetMany(keys) {
  return withTimeout(new Promise((resolve, reject) => {
    tg.cloud.getItems(keys, (err, values) => (err ? reject(err) : resolve(values || {})));
  }));
}
function cloudSet(key, str) {
  return withTimeout(new Promise((resolve, reject) => {
    tg.cloud.setItem(key, str, (err, ok) => (err ? reject(err) : resolve(ok)));
  }));
}
function cloudRemove(key) {
  return withTimeout(new Promise((resolve, reject) => {
    tg.cloud.removeItem(key, (err, ok) => (err ? reject(err) : resolve(ok)));
  }));
}

export const KEYS = ['profile', 'settings', 'clash', 'overrides', 'partner', 'theme', 'outbox', 'examLog', 'midDone', 'seen', 'dirty'];

export const storage = {
  /** Fast synchronous read from the local mirror. */
  loadLocal() {
    const out = {};
    for (const k of KEYS) out[k] = lsGet(k);
    return out;
  },

  /** Authoritative read from CloudStorage (null when unavailable). Updates the local mirror. */
  async loadCloud() {
    if (!tg.hasCloud()) return null;
    try {
      const vals = await cloudGetMany(KEYS);
      const out = {};
      for (const k of KEYS) {
        const raw = vals[k];
        out[k] = raw ? safeParse(raw) : null;
        if (out[k] !== null) lsSet(k, out[k]);
      }
      return out;
    } catch {
      return null;
    }
  },

  async set(key, value) {
    lsSet(key, value);
    if (!tg.hasCloud()) return;
    try {
      if (value === null || value === undefined) await cloudRemove(key);
      else {
        const str = JSON.stringify(value);
        if (str.length <= 4096) await cloudSet(key, str);
      }
    } catch {}
  },

  backend() { return tg.hasCloud() ? 'cloud' : 'local'; },
};

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

/** Drop overrides older than `days` before `todayStr` so the value stays small. */
export function pruneOverrides(overrides, todayStr, days = 21) {
  const cutoff = new Date(Date.parse(todayStr + 'T00:00:00Z') - days * 86400000).toISOString().slice(0, 10);
  const out = {};
  for (const [d, v] of Object.entries(overrides || {})) {
    const empty = !v || (!v.holiday && !(v.cancelled || []).length && !v.note);
    if (d >= cutoff && !empty) out[d] = v;
  }
  return out;
}
