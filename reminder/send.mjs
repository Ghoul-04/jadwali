// reminder/send.mjs — nightly "شنو باجر؟" message (Node 20+, no dependencies).
// Env (from GitHub Actions secrets):
//   BOT_TOKEN   — the bot token
//   RECIPIENTS  — JSON array: [{ "chat_id", "profile", "shift", "heatTrack", "labGroup" }]
//   APP_URL     — optional, Mini App URL (defaults to the GitHub Pages URL derived from GITHUB_REPOSITORY)
//   DRY_RUN=1   — print the messages instead of sending (chat ids are never printed)
// Never logs the token or chat ids.

import { readFileSync } from 'node:fs';
import {
  zonedNow, addDays, dayPlan, activeEntries, daySummary, DAY_NAMES, KIND_NAMES, time12Str,
} from '../core/schedule.js';

const data = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8'));
const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];

const token = process.env.BOT_TOKEN?.trim();
const dry = process.env.DRY_RUN === '1';
let recipients;
try { recipients = JSON.parse(process.env.RECIPIENTS || 'null'); } catch { recipients = null; }

if ((!token && !dry) || !Array.isArray(recipients) || recipients.length === 0) {
  console.log('Reminder skipped: BOT_TOKEN or RECIPIENTS secret is not set (this is fine).');
  process.exit(0);
}

const appUrl = process.env.APP_URL || pagesUrl();
function pagesUrl() {
  const repo = process.env.GITHUB_REPOSITORY; // owner/name
  if (!repo) return null;
  const [owner, name] = repo.split('/');
  return name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${name}/` : `https://${owner}.github.io/${name}/`;
}

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const dateLabel = (ds) => { const [, m, d] = ds.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };

function message(rec, tomorrow) {
  const profile = data.profiles[rec.profile] ? rec.profile : 'standard';
  const g = data.profiles[profile].gender;
  const settings = {
    shift: rec.shift === 'evening' ? 'evening' : 'morning',
    heatTrack: rec.heatTrack === 'evening' ? 'evening' : 'morning',
    labGroup: ['A', 'B', 'both', 'unknown'].includes(rec.labGroup) ? rec.labGroup : 'unknown',
  };
  const plan = dayPlan(data, profile, settings, tomorrow);
  const head = `🌙 <b>${g === 'f' ? 'شنو عندچ باجر؟' : 'شنو عندك باجر؟'}</b>\n${DAY_NAMES[plan.dayKey]} ${dateLabel(tomorrow)}`;
  if (!plan.workday) return null;
  const act = activeEntries(plan);
  if (!act.length) return `${head}\n\nماكو دوام باجر 😌`;
  const lines = [head, ''];
  for (const e of act) {
    const t = `${time12Str(e.start)} – ${time12Str(e.end)}`;
    const live = e.sessions.filter((x) => x.attending && !x.cancelled);
    if (live.length > 1) {
      lines.push(`⚠️ <b>${t}</b> — تصادم:`);
      for (const x of live) lines.push(`   • ${esc(data.subjects[x.subject].nick)} (${KIND_NAMES[x.kind]})${x.labGroup ? ` كروب ${x.labGroup}` : ''} · ${esc(x.location)}`);
    } else {
      const x = live[0];
      const icon = x.subject === 'heat1' ? '🔥' : x.kind === 'lab' ? '🧪' : '📘';
      lines.push(`${icon} <b>${t}</b>\n   ${esc(data.subjects[x.subject].name)} · ${KIND_NAMES[x.kind]} · ${esc(x.location)}${x.labGroup ? ` · كروب ${x.labGroup}${x.groupUncertain ? ' (حسب كروبك)' : ''}` : ''}`);
    }
  }
  const sm = daySummary(plan);
  lines.push('', `⏰ أول محاضرة ${time12Str(sm.first)} · تخلص ${time12Str(sm.last)}`);
  if (sm.clashes) {
    const n = sm.clashes === 1 ? 'تصادم واحد' : `${sm.clashes} تصادمات`;
    lines.push(g === 'f' ? `⚠️ عندچ ${n}، افتحي التطبيق واختاري وين رايحة.` : `⚠️ عندك ${n}، افتح التطبيق واختار وين رايح.`);
  }
  return lines.join('\n');
}

async function send(chatId, text) {
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
  };
  if (appUrl) body.reply_markup = { inline_keyboard: [[{ text: '📅 افتح جدولي', web_app: { url: appUrl } }]] };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(json.description || `HTTP ${res.status}`);
}

const today = zonedNow(new Date(), data.timezone).dateStr;
const tomorrow = addDays(today, 1);
let sent = 0, skipped = 0, failed = 0;
for (const [i, rec] of recipients.entries()) {
  const text = message(rec, tomorrow);
  if (!text) { skipped++; continue; }
  if (dry) { console.log(`--- recipient #${i + 1} (${rec.profile}) ---\n${text}\n`); sent++; continue; }
  try { await send(rec.chat_id, text); sent++; }
  catch (err) { failed++; console.log(`recipient #${i + 1}: send failed (${err.message})`); }
}
console.log(`Reminder for ${tomorrow}: sent ${sent}, skipped ${skipped}, failed ${failed}.`);
if (failed && !sent) process.exit(1);
