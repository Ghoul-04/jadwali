// Minimal .env reader (no dependencies). Never logs values.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadEnv() {
  const file = join(root, '.env');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export function botToken() {
  const t = process.env.BOT_TOKEN || loadEnv().BOT_TOKEN;
  if (!t) throw new Error('BOT_TOKEN missing (.env or environment).');
  return t;
}

/** Call a Bot API method. Errors never include the token. */
export async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${botToken()}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  });
  const json = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(`${method} failed: ${json.description || res.status}`);
  return json.result;
}
