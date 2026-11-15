// Send the current update announcement to every chat the bot knows that hasn't had it yet.
// Token from .env; never prints it or chat ids. Recipients = encrypted bot state (state branch)
// + updates the Bot workflow hasn't processed yet. After sending, it records them in bot.enc
// so the workflow won't announce twice.
// Usage: node scripts/broadcast.mjs          → dry run
//        node scripts/broadcast.mjs --send   → send + record
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tg, botToken } from './env.mjs';
import { decrypt, encrypt, emptyPrivate, ANNOUNCEMENT, ANN_ID } from '../bot/run.mjs';

const APP_URL = 'https://ghoul-04.github.io/jadwali/';
const sh = (cmd) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

let priv = emptyPrivate();
let hasState = false;
try {
  sh('git fetch -q origin state');
  priv = { ...emptyPrivate(), ...decrypt(sh('git show origin/state:bot.enc'), botToken()) };
  hasState = true;
} catch { /* no state yet */ }
priv.chats ||= {};

const targets = new Map(); // id → name
for (const [id, c] of Object.entries(priv.chats)) if (c.ann !== ANN_ID) targets.set(id, c.name || '?');
for (const [id, u] of Object.entries(priv.users || {})) if (!priv.chats[id]?.ann && !targets.has(id)) targets.set(id, u.name || '?');
for (const u of await tg('getUpdates', { timeout: 0 })) { // no offset → nothing is consumed
  const m = u.message;
  const id = m?.chat?.type === 'private' ? String(m.chat.id) : null;
  if (id && priv.chats[id]?.ann !== ANN_ID && !targets.has(id)) targets.set(id, m.from?.first_name || '?');
}

const list = [...targets.entries()];
console.log(`recipients: ${list.length}${list.length ? ' → ' + list.map(([, n], i) => `#${i + 1} ${n}`).join(', ') : ''}`);
if (!process.argv.includes('--send') || !list.length) process.exit(0);

const keyboard = { keyboard: [[{ text: '📅 جدولي', web_app: { url: APP_URL } }]], resize_keyboard: true, is_persistent: true };
const sent = [];
for (const [i, [id, name]] of list.entries()) {
  try {
    const r = await tg('sendMessage', { chat_id: id, text: ANNOUNCEMENT, parse_mode: 'HTML', reply_markup: keyboard });
    console.log(`#${i + 1} ${name}: sent (message ${r.message_id})`);
    sent.push([id, name]);
  } catch (e) {
    console.log(`#${i + 1} ${name}: failed — ${e.message}`);
  }
}
if (!sent.length) process.exit(1);

// Record in the encrypted state so the Bot workflow doesn't announce again.
for (const [id, name] of sent) priv.chats[id] = { ...(priv.chats[id] || {}), name, ann: ANN_ID };
const dir = mkdtempSync(join(tmpdir(), 'jadwali-state-'));
try {
  sh(hasState ? `git worktree add -q --detach "${dir}" origin/state` : `git worktree add -q --orphan -b state-tmp "${dir}"`);
  writeFileSync(join(dir, 'bot.enc'), encrypt(priv, botToken()) + '\n');
  sh(`git -C "${dir}" add -A`);
  sh(`git -C "${dir}" -c user.name=jadwali-bot -c user.email=41898282+github-actions[bot]@users.noreply.github.com commit -q -m "state: announcement ${ANN_ID}"`);
  sh(`git -C "${dir}" push -q origin HEAD:state`);
  console.log('state: recorded');
} catch { console.log('state: could not record (the bot may announce once more)'); }
finally {
  try { sh(`git worktree remove --force "${dir}"`); } catch { rmSync(dir, { recursive: true, force: true }); }
}
