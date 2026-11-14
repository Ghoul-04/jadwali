// bot/run.mjs — the whole "server", run every ~5 minutes by GitHub Actions (Node 20, no dependencies).
//  1. Reads new bot updates (getUpdates): /start → welcome + keyboard button; web_app_data → sync
//     (who is who, notification prefs, shared timetable edits).
//  2. Sends due notifications (schedule summary + N minutes before each session).
//  3. Persists state in STATE_DIR (a checkout of the repo's `state` branch):
//       shared.json — public: timetable edits + non-personal prefs, read by the Mini App
//       bot.enc     — private: chat ids, prefs, update offset, sent log (AES-256-GCM, key derived from BOT_TOKEN)
// Never logs the token or chat ids.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyShared, plannedNotifications, activeEntries, daySummary, DAY_NAMES, KIND_NAMES, time12Str, withDefaults,
} from '../core/schedule.js';

const BASE = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8'));
const MONTHS = ['كانون الثاني', 'شباط', 'آذار', 'نيسان', 'أيار', 'حزيران', 'تموز', 'آب', 'أيلول', 'تشرين الأول', 'تشرين الثاني', 'كانون الأول'];
const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : null);

// ───────── state ─────────
export function emptyShared() { return { version: 1, updatedAt: null, subjects: {}, edits: [], people: {} }; }
export function emptyPrivate() { return { offset: 0, users: {}, claims: {}, sent: {} }; }

const keyFrom = (token) => createHash('sha256').update(`jadwali-state|${token}`).digest();
export function encrypt(obj, token) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(token), iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64');
}
export function decrypt(b64, token) {
  const buf = Buffer.from(b64, 'base64');
  const d = createDecipheriv('aes-256-gcm', keyFrom(token), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}

// ───────── messages ─────────
const dateLabel = (ds) => { const [, m, d] = ds.split('-').map(Number); return `${d} ${MONTHS[m - 1]}`; };
const leadText = (n) => (n === 15 ? 'ربع ساعة' : n === 30 ? 'نص ساعة' : `${n} دقايق`);

export function summaryText(data, plan, g, when) {
  const you = g === 'f' ? 'عندچ' : 'عندك';
  const lines = [`${when === 'today' ? '☀️' : '🌙'} <b>شنو ${you} ${when === 'today' ? 'اليوم' : 'باجر'}؟</b>`, `${DAY_NAMES[plan.dayKey]} ${dateLabel(plan.dateStr)}`, ''];
  for (const e of activeEntries(plan)) {
    const t = `${time12Str(e.start)} – ${time12Str(e.end)}`;
    const live = e.sessions.filter((x) => x.attending && !x.cancelled);
    if (live.length > 1) {
      lines.push(`⚠️ <b>${t}</b> — تصادم:`);
      for (const x of live) lines.push(`   • ${esc(data.subjects[x.subject].nick)} (${KIND_NAMES[x.kind]})${x.labGroup ? ` كروب ${x.labGroup}` : ''} · ${esc(x.location)}`);
    } else {
      const x = live[0];
      const icon = x.subject === 'heat1' ? '🔥' : x.kind === 'lab' ? '🧪' : '📘';
      lines.push(`${icon} <b>${t}</b>\n   ${esc(data.subjects[x.subject].name)} · ${KIND_NAMES[x.kind]} · ${esc(x.location)}${x.instructor ? ` · ${esc(x.instructor)}` : ''}`);
    }
  }
  const sm = daySummary(plan);
  if (sm) lines.push('', `⏰ أول محاضرة ${time12Str(sm.first)} · تخلص ${time12Str(sm.last)}`);
  if (sm?.clashes) lines.push(g === 'f' ? '⚠️ عندچ تصادم، افتحي التطبيق واختاري وين رايحة.' : '⚠️ عندك تصادم، افتح التطبيق واختار وين رايح.');
  return lines.join('\n');
}

export function leadMessage(data, entry, lead) {
  const live = entry.sessions.filter((x) => x.attending && !x.cancelled);
  const t = time12Str(entry.start);
  if (live.length > 1) return `⏰ <b>بعد ${leadText(lead)}</b> (${t}) — ⚠️ تصادم: ${live.map((x) => esc(data.subjects[x.subject].nick)).join(' ✕ ')}`;
  const x = live[0];
  return `⏰ <b>بعد ${leadText(lead)}</b>: ${esc(data.subjects[x.subject].name)}\n${KIND_NAMES[x.kind]} · ${esc(x.location)} · ${t}${x.instructor ? ` · ${esc(x.instructor)}` : ''}`;
}

// ───────── sync (pure: easy to test) ─────────
const OPS = new Set(['add', 'remove', 'update', 'revert']);
function cleanSession(data, s) {
  if (!s || !data.slots[s.slot] || !data.subjects[s.subject] || !BASE.workdays.includes(s.day) || !KIND_NAMES[s.kind]) return null;
  return { day: s.day, slot: s.slot, subject: s.subject, kind: s.kind, instructor: str(s.instructor, 30) || null, room: str(s.room, 20) || null };
}
function cleanEdit(data, e) {
  if (!e || !OPS.has(e.op) || typeof e.id !== 'string' || !/^[a-z0-9]{4,24}$/.test(e.id)) return null;
  if (e.op === 'revert') return { id: e.id, op: 'revert' };
  if (!data.streams[e.stream]) return null;
  if (e.op === 'add') { const s = cleanSession(data, e.session); return s && { id: e.id, stream: e.stream, op: 'add', session: s }; }
  if (typeof e.key !== 'string' || e.key.length > 80) return null;
  if (e.op === 'remove') return { id: e.id, stream: e.stream, op: 'remove', key: e.key };
  const set = {};
  const x = e.set || {};
  if (BASE.workdays.includes(x.day)) set.day = x.day;
  if (data.slots[x.slot]) set.slot = x.slot;
  if (KIND_NAMES[x.kind]) set.kind = x.kind;
  if (typeof x.instructor === 'string') set.instructor = str(x.instructor, 30);
  if (typeof x.room === 'string') set.room = str(x.room, 20);
  return Object.keys(set).length ? { id: e.id, stream: e.stream, op: 'update', key: e.key, set } : null;
}

export function describe(data, e) {
  const d = (day, slot) => `${DAY_NAMES[day] || ''} ${slot && data.slots[slot] ? time12Str(Number(data.slots[slot][0].slice(0, 2)) * 60 + Number(data.slots[slot][0].slice(3))) : ''}`.trim();
  const fromKey = (k) => { const p = k.split(':'); return p.length >= 5 && data.subjects[p[3]] ? `${data.subjects[p[3]].nick} ${d(p[1], p[2])}` : 'محاضرة'; };
  if (e.op === 'add') return `➕ ${data.subjects[e.session.subject].nick} · ${d(e.session.day, e.session.slot)}`;
  if (e.op === 'remove') return `✖ حذف ${fromKey(e.key)}`;
  if (e.op === 'revert') return '↩️ تراجع عن تعديل';
  const s = e.set;
  return `✏️ ${fromKey(e.key)} ← ${[s.day || s.slot ? d(s.day, s.slot) : '', s.room, s.instructor, s.kind && KIND_NAMES[s.kind]].filter(Boolean).join(' · ')}`;
}

/** Apply a batch of Telegram updates. Returns outgoing messages; mutates priv/shared. */
export function processUpdates(updates, priv, shared, appUrl) {
  const out = [];
  const keyboard = appUrl ? { keyboard: [[{ text: '📅 جدولي', web_app: { url: appUrl } }]], resize_keyboard: true, is_persistent: true } : undefined;
  for (const u of updates) {
    priv.offset = Math.max(priv.offset, u.update_id + 1);
    const m = u.message;
    if (!m || m.chat?.type !== 'private') continue;
    const chat = String(m.chat.id);
    const data = applyShared(BASE, shared);

    if (m.web_app_data?.data) {
      let p;
      try { p = JSON.parse(m.web_app_data.data); } catch { continue; }
      const profile = BASE.profiles[p?.profile] ? p.profile : null;
      if (!profile) continue;
      const holder = priv.claims[profile];
      if (holder && holder !== chat) {
        out.push({ chat_id: chat, text: `هذا الحساب (${BASE.profiles[profile].name}) مربوط بحساب تيليگرام ثاني. اختار حسابك الصحيح من الإعدادات.` });
        continue;
      }
      for (const [prof, id] of Object.entries(priv.claims)) if (id === chat && prof !== profile) delete priv.claims[prof];
      priv.claims[profile] = chat;
      const g = BASE.profiles[profile].gender;
      const pr = p.prefs || {};
      const prefs = {
        shift: pr.shift === 'evening' ? 'evening' : 'morning',
        heatTrack: pr.heatTrack === 'evening' ? 'evening' : 'morning',
        labGroup: ['A', 'B', 'both', 'unknown'].includes(pr.labGroup) ? pr.labGroup : 'unknown',
        nightly: ['off', '7', '19', '20', '21', '22'].includes(String(pr.nightly)) ? String(pr.nightly) : '20',
        lead: [0, 10, 15, 30].includes(Number(pr.lead)) ? Number(pr.lead) : 15,
        clash: Object.fromEntries(Object.entries(pr.clash || {}).filter(([k, v]) => /^[a-z]{3}@\d\d:\d\d$/.test(k) && typeof v === 'string' && v.length < 80).slice(0, 20)),
      };
      priv.users[chat] = { profile, prefs, name: str(m.from?.first_name, 30) || '' };
      shared.people[profile] = { shift: prefs.shift, heatTrack: prefs.heatTrack, labGroup: prefs.labGroup, clash: prefs.clash };

      const applied = [];
      for (const raw of (Array.isArray(p.edits) ? p.edits : []).slice(0, 40)) {
        const e = cleanEdit(data, raw);
        if (!e) continue;
        if (e.op === 'revert') {
          const i = shared.edits.findIndex((x) => x.id === e.id);
          if (i >= 0) { applied.push(`↩️ تراجع: ${describe(data, shared.edits[i]).slice(2)}`); shared.edits.splice(i, 1); }
        } else if (!shared.edits.some((x) => x.id === e.id)) {
          shared.edits.push({ ...e, by: profile });
          applied.push(describe(data, e));
        }
      }
      for (const [id, s] of Object.entries(p.subjects || {})) {
        const name = str(s?.name, 40);
        if (data.subjects[id] && name && name !== data.subjects[id].name) {
          shared.subjects[id] = { name, nick: str(s.nick, 16) || data.subjects[id].nick };
          applied.push(`🔤 ${data.subjects[id].nick} ← ${name}`);
        }
      }
      shared.edits = shared.edits.slice(-300);

      const n = prefs.nightly === 'off' ? 'رسالة الجدول مطفية' : prefs.nightly === '7' ? 'جدول اليوم الساعة 7 الصبح' : `جدول باجر الساعة ${Number(prefs.nightly) - 12} بالليل`;
      const l = prefs.lead ? `وقبل كل محاضرة بـ${leadText(prefs.lead)}` : 'وبدون تنبيه قبل المحاضرات';
      out.push({
        chat_id: chat,
        text: `✅ <b>${g === 'f' ? 'انحفظ يا ' : 'انحفظ يا '}${esc(BASE.profiles[profile].name)}</b>\n🔔 ${n}، ${l}.${applied.length ? `\n\n${applied.map(esc).join('\n')}` : ''}`,
        reply_markup: keyboard,
      });
      const partner = priv.claims[profile === 'carrier' ? 'standard' : 'carrier'];
      if (applied.length && partner) {
        out.push({ chat_id: partner, text: `✏️ <b>${esc(BASE.profiles[profile].name)} ${g === 'f' ? 'عدّلت' : 'عدّل'} الجدول</b> (وصل عندك هم):\n${applied.slice(0, 8).map(esc).join('\n')}` });
      }
      shared.updatedAt = new Date().toISOString();
      continue;
    }

    if (typeof m.text === 'string') {
      const known = priv.users[chat];
      out.push({
        chat_id: chat,
        text: known
          ? 'دوس زر «📅 جدولي» اللي تحت 👇'
          : 'هلا 👋 هذا «شنو باجر» — جدولكم بالكلية.\n\n1) دوس زر <b>«📅 جدولي»</b> اللي تحت 👇\n2) اختار صورتك\n3) من ⚙️ الإعدادات دوس <b>«احفظ ودزها للبوت»</b> حتى توصلك التنبيهات وتتزامن التعديلات.',
        reply_markup: keyboard,
      });
    }
  }
  return out;
}

/** Notifications due now for every registered user. */
export function dueNotifications(priv, shared, now = new Date()) {
  const data = applyShared(BASE, shared);
  const t = now.getTime();
  const due = [];
  for (const [chat, u] of Object.entries(priv.users)) {
    if (!BASE.profiles[u.profile] || priv.claims[u.profile] !== chat) continue;
    const settings = withDefaults({ ...u.prefs, clashChoices: u.prefs.clash || {} });
    for (const n of plannedNotifications(data, u.profile, settings, u.prefs, now)) {
      const id = `${chat}|${n.id}`;
      if (priv.sent[id]) continue;
      const late = n.kind === 'lead' ? t >= n.startAt : t - n.at > 45 * 60e3;
      if (n.at > t + 4 * 60e3 || late) continue;
      const g = BASE.profiles[u.profile].gender;
      due.push({
        id, at: n.at, chat_id: chat,
        text: n.kind === 'summary' ? summaryText(data, n.plan, g, n.when) : leadMessage(data, n.entry, u.prefs.lead),
      });
    }
  }
  return due.sort((a, b) => a.at - b.at);
}

// ───────── I/O ─────────
async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`${method}: ${json.description || res.status}`);
  return json.result;
}

async function main() {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) { console.log('BOT_TOKEN not set — nothing to do.'); return; }
  const dir = process.env.STATE_DIR || '.state';
  const appUrl = process.env.APP_URL || null;
  mkdirSync(dir, { recursive: true });
  const sharedPath = join(dir, 'shared.json'), privPath = join(dir, 'bot.enc');

  let shared = emptyShared(), priv = emptyPrivate();
  try { if (existsSync(sharedPath)) shared = { ...emptyShared(), ...JSON.parse(readFileSync(sharedPath, 'utf8')) }; } catch { console.log('shared.json unreadable, starting fresh'); }
  try { if (existsSync(privPath)) priv = { ...emptyPrivate(), ...decrypt(readFileSync(privPath, 'utf8').trim(), token) }; } catch { console.log('bot.enc unreadable (token changed?), starting fresh'); }
  const before = JSON.stringify([shared, priv]);

  // 1) updates
  const updates = await tg(token, 'getUpdates', { offset: priv.offset, timeout: 0, allowed_updates: ['message'] });
  const outgoing = processUpdates(updates, priv, shared, appUrl);
  let sent = 0;
  for (const m of outgoing) {
    try { await tg(token, 'sendMessage', { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...m }); sent++; } catch (e) { console.log(`reply failed: ${e.message}`); }
  }
  console.log(`updates: ${updates.length}, replies: ${sent}`);

  // 2) notifications (sleep briefly for ones due within the next few minutes)
  const inline = appUrl ? { inline_keyboard: [[{ text: '📅 افتح جدولي', web_app: { url: appUrl } }]] } : undefined;
  let notified = 0;
  for (const n of dueNotifications(priv, shared)) {
    const wait = n.at - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      await tg(token, 'sendMessage', { chat_id: n.chat_id, text: n.text, parse_mode: 'HTML', reply_markup: inline });
      priv.sent[n.id] = Date.now(); notified++;
    } catch (e) { console.log(`notify failed: ${e.message}`); }
  }
  const cutoff = Date.now() - 3 * 86400e3;
  for (const [k, v] of Object.entries(priv.sent)) if (v < cutoff) delete priv.sent[k];
  console.log(`notifications sent: ${notified}`);

  // 3) persist only when something changed
  if (JSON.stringify([shared, priv]) !== before) {
    writeFileSync(sharedPath, JSON.stringify(shared, null, 1) + '\n');
    writeFileSync(privPath, encrypt(priv, token) + '\n');
    console.log('state changed');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.log(`bot error: ${String(e.message).replace(/bot\d+:[\w-]+/g, 'bot***')}`); process.exit(1); });
}
