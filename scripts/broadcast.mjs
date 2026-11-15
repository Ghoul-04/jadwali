// One-off announcement to everyone who has talked to the bot. Token from .env; never prints it or chat ids.
// Chats come from the encrypted bot state (state branch) + any updates not yet processed by the Bot workflow.
// Usage: node scripts/broadcast.mjs            → dry run (lists recipients by index + first name)
//        node scripts/broadcast.mjs --send     → sends
import { execSync } from 'node:child_process';
import { tg, botToken } from './env.mjs';
import { decrypt } from '../bot/run.mjs';

const APP_URL = 'https://ghoul-04.github.io/jadwali/';
const TEXT = [
  '🎉 <b>«شنو باجر» تحدّث وتطوّر!</b>',
  '',
  '📝 <b>امتحانات المد</b>: عدّاد للامتحان الجاي، كارت خاص بيوم الامتحان، وأيام الدراسة بين كل امتحانين',
  '🔔 <b>تذكيراتك كلها داخل التطبيق</b>: الجرس فوق',
  '🐉🍑 <b>فواكه بدل الصور</b>: فاكهة التنين لمحمد والخوخة لخلود',
  '👀 <b>تشوف امتحانات الثاني</b>، حتى لو ما عندك نفس المادة',
  '💬 بعد كل امتحان يسألك: شلون كان؟',
  '',
  'دوس /start حتى يتحدث الزر، وبعدين افتح <b>«📅 جدولي»</b> اللي تحت 👇',
].join('\n');

const chats = new Map(); // id → first name
try {
  execSync('git fetch -q origin state', { stdio: 'ignore' });
  const enc = execSync('git show origin/state:bot.enc', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const priv = decrypt(enc, botToken());
  for (const [id, u] of Object.entries(priv.users || {})) chats.set(id, u.name || '?');
  for (const [id, c] of Object.entries(priv.chats || {})) if (!chats.has(id)) chats.set(id, c.name || '?');
} catch { console.log('state: no readable bot.enc'); }

const updates = await tg('getUpdates', { timeout: 0 }); // no offset → nothing gets confirmed/consumed
for (const u of updates) {
  const m = u.message;
  if (m?.chat?.type === 'private' && !chats.has(String(m.chat.id))) chats.set(String(m.chat.id), m.from?.first_name || '?');
}

const list = [...chats.entries()];
console.log(`recipients: ${list.length}${list.length ? ' → ' + list.map(([, n], i) => `#${i + 1} ${n}`).join(', ') : ''}`);
if (!process.argv.includes('--send')) { console.log('(dry run — add --send to send)'); process.exit(0); }

const keyboard = { keyboard: [[{ text: '📅 جدولي', web_app: { url: APP_URL } }]], resize_keyboard: true, is_persistent: true };
for (const [i, [id, name]] of list.entries()) {
  try {
    const r = await tg('sendMessage', { chat_id: id, text: TEXT, parse_mode: 'HTML', reply_markup: keyboard });
    console.log(`#${i + 1} ${name}: sent (message ${r.message_id})`);
  } catch (e) {
    console.log(`#${i + 1} ${name}: failed — ${e.message}`);
  }
}
