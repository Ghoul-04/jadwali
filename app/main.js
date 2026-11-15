// app/main.js — bootstrap, state, rendering of all screens.
import * as S from '../core/schedule.js';
import * as X from '../core/exams.js';
import { fruitSVG } from './fruits.js';
import { tg, inTelegram, atLeast, canSendData } from './telegram.js';
import { storage, pruneOverrides } from './storage.js';
import { voice, dateLabel, greetingFor, countSessions, countClashes } from './i18n.js';
import { icons } from './icons.js';
import * as U from './ui.js';

const { esc, t12, range12, tile } = U;
const BOT_LINK = 'https://t.me/ShnoBajer_bot';
// Shared state (synced through the bot) lives on the repo's `state` branch.
const SHARED_URL = 'https://raw.githubusercontent.com/Ghoul-04/jadwali/state/shared.json';

// ───────── clock (supports ?now=YYYY-MM-DDTHH:MM for testing; ticks from there) ─────────
const params = new URLSearchParams(location.search);
const mockParam = params.get('now');
const mockStart = mockParam ? Date.parse(mockParam.length <= 16 ? `${mockParam}:00+03:00` : mockParam) : null;
const bootReal = Date.now();
const now = () => new Date(mockStart ? mockStart + (Date.now() - bootReal) : Date.now());

// ───────── state ─────────
const state = {
  base: null,                   // data/schedule.json as shipped
  shared: null,                 // synced edits + people (from the state branch)
  outbox: { edits: [], subjects: {} }, // local edits not yet confirmed by the bot
  examLog: {},                  // { [examId]: { r: reaction, g: grade } }
  midDone: false,               // end-of-midterms celebration shown
  seen: [],                     // in-app reminder ids already seen
  inbox: false,                 // reminders sheet open
  react: null,                  // exam id for "شلون كان الامتحان؟"
  asked: false,                 // asked about an exam this session
  dirty: false,                 // something to sync
  editing: null,                // edit-sheet draft
  editDay: null,
  data: null,
  profile: null,                // 'carrier' | 'standard'
  settings: S.defaultSettings(),
  partner: { shift: 'morning', heatTrack: 'morning', labGroup: 'unknown' },
  themePref: 'auto',            // 'auto' | 'light' | 'dark'
  peek: false,
  tab: null,
  sub: null,                    // 'settings' | null
  sheet: null,                  // { key, dateStr }
  togetherDay: null,
  ovDate: null,
  lastMinute: -1,
};

const $ = (sel, root = document) => root.querySelector(sel);
const other = (id) => (id === 'carrier' ? 'standard' : 'carrier');
const prof = (id) => state.data.profiles[id];
const viewId = () => (state.peek ? other(state.profile) : state.profile);
function partnerSettings() {
  const synced = state.shared?.people?.[other(state.profile)] || {};
  return { ...S.defaultSettings(), ...state.partner, ...pick(synced, ['shift', 'heatTrack', 'labGroup']), amendments: state.settings.amendments, clashChoices: synced.clash || {}, overrides: {} };
}

/** shared (confirmed) + outbox (pending) → the edits the app shows. */
function mergedShared() {
  const sh = state.shared || {};
  const reverts = new Set(state.outbox.edits.filter((e) => e.op === 'revert').map((e) => e.id));
  const have = new Set((sh.edits || []).map((e) => e.id));
  return {
    subjects: { ...(sh.subjects || {}), ...state.outbox.subjects },
    edits: (sh.edits || []).filter((e) => !reverts.has(e.id)).concat(state.outbox.edits.filter((e) => e.op !== 'revert' && !have.has(e.id))),
  };
}
function recompute() { state.data = S.applyShared(state.base, mergedShared()); }

/** Drop outbox items the bot has already applied. */
function reconcileOutbox() {
  const sh = state.shared;
  if (!sh) return;
  const have = new Set((sh.edits || []).map((e) => e.id));
  const before = JSON.stringify(state.outbox);
  state.outbox.edits = state.outbox.edits.filter((e) => (e.op === 'revert' ? have.has(e.id) : !have.has(e.id)));
  for (const [k, v] of Object.entries(state.outbox.subjects)) {
    const s = sh.subjects?.[k];
    if (s && s.name === v.name && s.nick === v.nick) delete state.outbox.subjects[k];
  }
  if (JSON.stringify(state.outbox) !== before) storage.set('outbox', state.outbox);
}

async function loadShared() {
  try {
    const res = await fetch(`${SHARED_URL}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const sh = await res.json();
    const changed = JSON.stringify(sh) !== JSON.stringify(state.shared);
    state.shared = sh;
    try { localStorage.setItem('jadwali.sharedCache', JSON.stringify(sh)); } catch {}
    reconcileOutbox();
    recompute();
    return changed;
  } catch { return false; }
}
const viewSettings = () => (state.peek ? partnerSettings() : state.settings);
const V = () => voice({ g: prof(viewId()).gender, p: state.peek ? 3 : 2, name: prof(viewId()).name });
const Z = () => S.zonedNow(now(), state.data.timezone);
const readOnly = () => state.peek;

/** Baghdad wall time → epoch ms (offset derived from Intl, not the device). */
function epochAt(dateStr, min) {
  const n = now();
  const z = S.zonedNow(n, state.data.timezone);
  const offset = Date.UTC(z.y, z.mo - 1, z.d, 0, z.minutes, z.seconds) - Math.floor(n.getTime() / 1000) * 1000;
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, 0, min) - offset;
}

// ───────── persistence ─────────
function applyStored(st) {
  if (!st) return;
  if (st.profile === 'carrier' || st.profile === 'standard') state.profile = st.profile;
  if (st.settings) Object.assign(state.settings, pick(st.settings, ['shift', 'heatTrack', 'labGroup', 'amendments']));
  if (st.clash) state.settings.clashChoices = st.clash;
  if (st.overrides) state.settings.overrides = st.overrides;
  if (st.partner) Object.assign(state.partner, st.partner);
  if (st.theme) state.themePref = st.theme;
  if (st.outbox?.edits) state.outbox = { edits: st.outbox.edits, subjects: st.outbox.subjects || {} };
  if (st.examLog && typeof st.examLog === 'object') state.examLog = st.examLog;
  if (typeof st.midDone === 'boolean') state.midDone = st.midDone;
  if (Array.isArray(st.seen)) state.seen = st.seen;
  if (typeof st.dirty === 'boolean') state.dirty = st.dirty;
}
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

function save(what) {
  const s = state.settings;
  if (what === 'profile') storage.set('profile', state.profile);
  if (what === 'settings') storage.set('settings', pick(s, ['shift', 'heatTrack', 'labGroup', 'amendments']));
  if (what === 'clash') storage.set('clash', s.clashChoices);
  if (what === 'overrides') {
    s.overrides = pruneOverrides(s.overrides, Z().dateStr);
    storage.set('overrides', s.overrides);
  }
  if (what === 'partner') storage.set('partner', state.partner);
  if (what === 'theme') storage.set('theme', state.themePref);
  if (what === 'outbox') storage.set('outbox', state.outbox);
  if (what === 'examLog') storage.set('examLog', state.examLog);
  if (what === 'midDone') storage.set('midDone', state.midDone);
  if (what === 'seen') storage.set('seen', state.seen.slice(-60));
  // Anything the other person needs to know makes the app "dirty" until synced.
  if (['profile', 'settings', 'clash', 'outbox'].includes(what) && !state.dirty) { state.dirty = true; storage.set('dirty', true); }
}

// ───────── theme ─────────
function applyTheme() {
  let mode = state.themePref;
  if (mode === 'auto') mode = tg.colorScheme() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const forced = params.get('theme');
  if (forced === 'dark' || forced === 'light') mode = forced;
  document.documentElement.dataset.theme = mode;
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--bg').trim() || (mode === 'dark' ? '#0f0c1d' : '#f7f4ff');
  const bar = cs.getPropertyValue('--surface').trim() || bg;
  tg.setColors(bg, bg, bar);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = bg;
}

function applyInsets() {
  const { safe, content } = tg.insets();
  const r = document.documentElement.style;
  r.setProperty('--sa-top', `${safe.top + content.top}px`);
  r.setProperty('--sa-bottom', `${safe.bottom + content.bottom}px`);
}

// ───────── rendering ─────────
const TABS = [
  { id: 'now', label: 'هسه', icon: 'now' },
  { id: 'tomorrow', label: 'باجر', icon: 'tomorrow' },
  { id: 'week', label: 'الأسبوع', icon: 'week' },
  { id: 'heat', label: 'هيت 1', icon: 'flame', carrierOnly: true },
  { id: 'together', label: 'سوه', icon: 'together' },
];
const visibleTabs = () => TABS.filter((t) => !t.carrierOnly || prof(viewId()).addHeat1);

function render({ anim = true } = {}) {
  if (!state.profile) return renderPicker();
  $('#picker-root').innerHTML = '';
  if (!visibleTabs().some((t) => t.id === state.tab)) state.tab = 'now';
  renderTop();
  renderTabs();
  const view = $('#view');
  view.classList.toggle('no-anim', !anim);
  view.dataset.tab = state.sub || state.tab;
  view.innerHTML = state.sub === 'settings' ? viewSettingsPage() : state.sub === 'exams' ? viewExamsPage() : VIEWS[state.tab]();
  view.querySelectorAll('.rise').forEach((el, k) => el.style.setProperty('--i', k));
  if (anim) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  syncBack();
  renderSheet();
  tick(true);
}

function renderTop() {
  const z = Z();
  const me = state.profile, you = other(me);
  const meName = prof(me).name;
  const otherName = prof(you).name;
  const g = prof(me).gender;
  const unseen = inboxItems().filter((i) => !state.seen.includes(i.id)).length;
  $('#top').innerHTML = `
    <div class="top-row">
      <div class="hello">
        <button class="ava-btn" data-act="wobble" aria-label="${esc(meName)}">${avatar(me, 'sm')}</button>
        <div class="hello-txt">
          <span class="hello-k">${greetingFor(z.minutes, g)}</span>
          <h1 class="hello-n">${esc(meName)}</h1>
          <span class="hello-d">${dateLabel(z.dateStr)}</span>
        </div>
      </div>
      <div class="top-actions">
        ${state.sub ? '' : `
        <button class="icon-btn bell ${unseen ? 'has' : ''}" data-act="openInbox" aria-label="التذكيرات${unseen ? ` (${unseen} جديدة)` : ''}">${icons.bell()}${unseen ? `<i class="badge">${unseen}</i>` : ''}</button>
        <button class="icon-btn fruit-btn ${state.peek ? 'on' : ''}" data-act="peek" aria-pressed="${state.peek}" aria-label="${state.peek ? 'جدولي' : `جدول ${esc(otherName)}`}">${fruitSVG(fruitOf(state.peek ? me : you), 34)}</button>`}
        <button class="icon-btn" data-act="${state.sub ? 'closeSub' : 'openSettings'}" aria-label="${state.sub ? 'رجوع' : 'الإعدادات'}">${state.sub ? icons.close() : icons.gear()}</button>
      </div>
    </div>
    ${state.peek && !state.sub ? `<div class="peek-bar">${fruitSVG(fruitOf(you), 22)}<span>جدول <b>${esc(otherName)}</b> · ما يتغير اختيارك</span><button class="link" data-act="peek">رجوع لجدولي</button></div>` : ''}`;
}

function renderTabs() {
  const nav = $('#tabs');
  if (state.sub) { nav.hidden = true; return; }
  nav.hidden = false;
  const tabs = visibleTabs();
  nav.style.setProperty('--n', tabs.length);
  nav.style.setProperty('--x', tabs.findIndex((t) => t.id === state.tab));
  nav.innerHTML = `<span class="tab-ind" aria-hidden="true"></span>` + tabs.map((t) => `
    <button class="tab ${t.id === state.tab ? 'on' : ''} ${t.id === 'heat' ? 'tab-heat' : ''}" role="tab" aria-selected="${t.id === state.tab}" data-act="tab" data-tab="${t.id}">
      ${icons[t.icon]()}<span>${t.label}</span>
    </button>`).join('');
}

function syncBack() {
  if (state.editing) tg.back.show(() => act.editClose());
  else if (state.react) tg.back.show(() => act.closeReact());
  else if (state.inbox) tg.back.show(() => act.closeInbox());
  else if (state.sheet) tg.back.show(() => closeSheet());
  else if (state.sub) tg.back.show(() => act.closeSub());
  else if (state.peek) tg.back.show(() => act.peek());
  else tg.back.hide();
}

const fruitOf = (id) => prof(id).fruit || (id === 'carrier' ? 'dragon' : 'peach');
const AVA_PX = { xs: 22, sm: 46, md: 56, xl: 116 };

/** Profile avatar = their fruit, on a soft glowing halo. */
function avatar(id, size = 'md') {
  return `<span class="ava ava--${size} ava-${fruitOf(id)}" aria-hidden="true"><span class="ava-halo"></span>${fruitSVG(fruitOf(id), AVA_PX[size] || 56)}</span>`;
}

/** Small hexagon photo (benzene ring), used as a badge on the picker. */
function photoBadge(id) {
  const p = prof(id);
  return p.photo ? `<span class="ava-photo" aria-hidden="true"><span class="ava-ring"></span><span class="ava-img"><img src="${esc(p.photo)}" alt="" decoding="async" onerror="this.parentNode.parentNode.remove()"></span></span>` : '';
}

// ───────── entries ─────────
function entryHTML(e, i) {
  const v = V();
  if (e.clash) return U.clashCard(state.data, e, { i, readOnly: readOnly(), goingLabel: v.going });
  return U.sessionCard(state.data, e.sessions[0], { i });
}

function timeline(plan, { from = 0 } = {}) {
  const items = plan.entries.filter((e) => e.end * 60 > from);
  if (!items.length) return '';
  const out = [];
  items.forEach((e, k) => {
    const prev = items[k - 1];
    if (prev && e.start > prev.end) {
      out.push(`<div class="gap rise" style="--i:${k}">${icons.coffee()}<span>استراحة ${S.durationAr(e.start - prev.end)}</span></div>`);
    }
    out.push(`<div class="tl-row rise ${e.active ? '' : 'is-off'}" style="--i:${k}">
      <div class="tl-time">${t12(e.start)}<span class="tl-end">${t12(e.end)}</span></div>
      <div class="tl-node s-${e.sessions.find((x) => x.attending)?.subject || e.sessions[0].subject} ${e.clash ? 'is-clash' : ''}" aria-hidden="true"></div>
      <div class="tl-card">${entryHTML(e, k)}</div>
    </div>`);
  });
  return `<div class="timeline">${out.join('')}</div>`;
}

function planExtras(plan) {
  const out = [];
  if (plan.note) out.push(`<div class="note rise">${icons.note()}<span>${esc(plan.note)}</span></div>`);
  if (plan.removed.length) {
    out.push(`<div class="amend-note rise">${plan.removed.map((x) => `<span>${esc(x.note || 'تعديل القسم')} — <s>${esc(state.data.subjects[x.subject].nick)} ${t12(x.start)}</s></span>`).join('')}</div>`);
  }
  return out.join('');
}

function summaryLine(plan) {
  const sm = S.daySummary(plan);
  if (!sm) return '';
  const parts = [countSessions(sm.count), `من ${t12(sm.first)} لـ ${t12(sm.last)}`];
  if (sm.clashes) parts.push(`<b class="warn">${countClashes(sm.clashes)}</b>`);
  return `<p class="summary rise">${parts.join('<span class="dot">•</span>')}</p>`;
}

// ───────── exams ─────────
const REACTIONS = [['easy', '😎', 'سهل'], ['good', '🙂', 'زين'], ['hard', '😬', 'صعب شوية'], ['rip', '🫠', 'ذبحني']];
const reactionOf = (id) => REACTIONS.find((r) => r[0] === state.examLog[id]?.r);
const shortDate = (ds) => `${Number(ds.slice(8))}/${Number(ds.slice(5, 7))}`;
function daysCount(n) { return n === 1 ? 'يوم واحد' : n === 2 ? 'يومين' : n <= 10 ? `${n} أيام` : `${n} يوم`; }

/** Calm, focused exam card: night-ink sky, a slowly breathing orb around the element tile. */
function examCard(e, { when, luck = '' } = {}) {
  const d = state.data, sub = d.subjects[e.subject];
  const startEpoch = e.start != null ? epochAt(e.date, e.start) : null;
  const left = startEpoch ? (startEpoch - now().getTime()) / 1000 : null;
  return `<section class="exam-card s-${e.subject} rise" data-act="openExams" role="button" tabindex="0" aria-label="امتحان ${esc(sub.name)} ${esc(when)}">
    <div class="exam-sky" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="exam-orb" aria-hidden="true"><span class="orb-ring"></span><span class="orb-ring r2"></span>${tile(d, e.subject, { size: 'lg' })}</div>
    <div class="exam-body">
      <span class="exam-k">${icons.pencil()}<span>امتحان المد · ${esc(when)}</span></span>
      <h2>${esc(sub.name)}</h2>
      <p class="exam-time">${e.start != null ? t12(e.start) : '<span class="muted">الوقت ما متبلغ بعد</span>'}</p>
      ${left != null && left > 0 && left < 2 * 86400 ? `<p class="exam-count"><b data-until="${startEpoch}">${U.clock(left)}</b><small>للبداية</small></p>` : ''}
      ${luck ? `<p class="exam-luck">${esc(luck)}</p>` : ''}
    </div>
    <p class="breathe" aria-hidden="true"><span>شهيق…</span><span>زفير…</span></p>
  </section>`;
}

/** Exam-season countdown banner (hidden once the last exam is over). */
function examBanner({ skipDate = null } = {}) {
  const d = state.data;
  const tl = X.examTimeline(d, viewId(), now());
  if (!tl.season) return '';
  const e = tl.list.find((x) => !x.done && x.date !== skipDate);
  if (!e) return '';
  const focus = state.peek ? null : X.focusSuggestion(d, viewId(), now());
  const done = tl.list.filter((x) => x.done).length;
  const big = e.dayDiff <= 0 ? 'اليوم' : e.dayDiff === 1 ? 'باجر' : e.dayDiff === 2 ? 'يومين' : String(e.dayDiff);
  return `<button class="exam-banner s-${e.subject} rise" data-act="openExams" aria-label="امتحانات المد">
    ${tile(d, e.subject, { size: 'sm' })}
    <span class="eb-txt"><b>امتحان ${esc(X.examNick(d, e.subject))}</b>
      <small>${X.dayWord(e.dayDiff, e.dayKey)}${e.dayDiff >= 2 ? ` ${shortDate(e.date)}` : ''} · ${esc(X.examTimeText(e))}</small>
      ${focus ? `<small class="eb-focus">${icons.sparkle()}ركّز اليوم على ${esc(X.examNick(d, focus.exam.subject))}</small>` : ''}</span>
    <span class="eb-count ${big.length > 2 ? 'word' : ''}"><b>${big}</b>${e.dayDiff >= 3 ? `<small>${e.dayDiff <= 10 ? 'أيام' : 'يوم'}</small>` : ''}</span>
    <span class="eb-progress" style="--p:${(done / tl.list.length).toFixed(3)}" aria-hidden="true"></span>
  </button>`;
}

/** The other person's exams today/tomorrow, with their fruit. */
function partnerBrief() {
  const b = X.examBrief(state.data, viewId(), now());
  return b.lines.filter((l) => l.kind === 'partner').map((l) => `<div class="brief rise">${fruitSVG(fruitOf(other(viewId())), 26)}<span>${esc(noEmoji(l.text))}</span></div>`).join('');
}

/** Drop the trailing fruit emoji when the drawn fruit is already shown next to the text. */
const noEmoji = (s) => String(s).replace(/\s*(🍑|🐉)$/u, '');

function luckFor(e) {
  return state.peek ? '' : X.luckLine(prof(viewId()).gender, `${e.date}|${e.id}`);
}

// ───────── views ─────────
const VIEWS = {
  now() {
    const d = state.data, v = V();
    const n = S.nowInfo(d, viewId(), viewSettings(), now());
    const z = n.zoned;
    let hero;
    if (n.current) {
      const e = n.current;
      const live = e.sessions.filter((x) => x.attending && !x.cancelled);
      const main = live[0];
      const sub = d.subjects[main.subject];
      const from = epochAt(z.dateStr, e.start), to = epochAt(z.dateStr, e.end);
      hero = `<section class="hero s-${main.subject} rise" style="--i:0">
        <div class="hero-glow" aria-hidden="true"></div>
        ${U.ring(n.progress, { inner: `<span class="ring-k">باقي</span><b class="ring-v" data-until="${to}">${U.clock(n.remainingSec)}</b>` }).replace('class="ring"', `class="ring" data-ring-from="${from}" data-ring-to="${to}"`)}
        <div class="hero-body">
          <span class="eyebrow"><i class="live-dot"></i>${v.nowHave}</span>
          ${live.length > 1
            ? `<h2 class="hero-title">تصادم</h2><p class="hero-sub">${live.map((x) => esc(d.subjects[x.subject].nick)).join(' ✕ ')}</p>`
            : `<h2 class="hero-title">${esc(sub.name)}</h2><p class="hero-sub">${U.kindPill(main.kind)} ${esc(main.location)}${main.instructor ? ' · ' + esc(main.instructor) : ''}</p>`}
          <p class="hero-time">${range12(e.start, e.end)}</p>
        </div>
      </section>`;
    } else {
      const nx = n.next;
      let inner = `<span class="ring-k">${v.free}</span>`;
      let body = `<span class="eyebrow">${icons.sparkle()}<span>${v.youFree}</span></span><h2 class="hero-title">${v.free}</h2>`;
      let progress = 0, ringAttr = '';
      if (nx) {
        const e = nx.entry;
        const live = e.sessions.filter((x) => x.attending && !x.cancelled);
        const startEpoch = epochAt(nx.dateStr, e.start);
        const act = S.activeEntries(n.plan).filter((x) => x.end <= z.minutes);
        const prevEnd = act.length ? epochAt(z.dateStr, act[act.length - 1].end) : Math.min(now().getTime(), startEpoch - 3600e3);
        progress = (now() - prevEnd) / Math.max(1, startEpoch - prevEnd);
        ringAttr = `data-ring-from="${prevEnd}" data-ring-to="${startEpoch}"`;
        const when = nx.dayOffset === 0 ? '' : nx.dayOffset === 1 ? 'باجر ' : `${S.DAY_NAMES[nx.dayKey]} `;
        inner = `<span class="ring-k">تبدي بعد</span><b class="ring-v" data-until="${startEpoch}">${U.clock(nx.startsInSec)}</b>`;
        body += `<div class="next-card">
          ${tile(d, live[0].subject, { size: 'sm' })}
          <div><span class="next-k">${v.nextLabel}${live.length > 1 ? ' · تصادم' : ''}</span>
          <b class="next-n">${live.map((x) => esc(d.subjects[x.subject].nick)).join(' ✕ ')} <small>${U.kindPill(live[0].kind)}</small></b>
          <span class="next-w">${when}${t12(e.start)} · <span data-dur-until="${startEpoch}">بعد ${S.durationAr(nx.startsInMin)}</span></span></div>
        </div>`;
      }
      const s0 = nx ? nx.entry.sessions.find((x) => x.attending)?.subject : 'projects';
      hero = `<section class="hero hero-free s-${s0} rise" style="--i:0">
        <div class="hero-glow" aria-hidden="true"></div>
        ${U.ring(progress, { inner }).replace('class="ring"', `class="ring" ${ringAttr}`)}
        <div class="hero-body">${body}</div>
      </section>`;
    }

    let rest = '';
    if (n.plan.holiday) {
      rest = `<div class="empty rise">${icons.party()}<b>اليوم عطلة</b><span>${v.rest}</span></div>`;
    } else if (n.plan.workday) {
      const later = { ...n.plan, entries: n.plan.entries.filter((e) => e.start * 60 > z.minutes * 60 + z.seconds) };
      rest = later.entries.length
        ? `<h3 class="sec-h rise">باقي اليوم</h3>${timeline(later)}`
        : `<div class="empty rise">${icons.check()}<b>${S.activeEntries(n.plan).length ? v.doneToday : v.noClass + ' اليوم'}</b><button class="btn ghost" data-act="tab" data-tab="tomorrow">${v.whatTomorrow}</button></div>`;
    } else {
      rest = `<div class="empty rise">${icons.coffee()}<b>اليوم ${S.DAY_NAMES[z.dayKey]}، عطلة</b><span>${v.rest}</span></div>`;
    }
    // Exam day: the exam is the top card. Otherwise the season banner.
    const todays = X.examTimeline(d, viewId(), now()).list.filter((e) => e.date === z.dateStr && !e.done);
    const g = prof(viewId()).gender;
    const examTop = todays.map((e) => examCard(e, { when: 'اليوم', luck: state.peek ? '' : `بالتوفيق، ${g === 'f' ? 'أنتِ' : 'أنت'} قدها 💪` })).join('');
    return `${examTop}${examBanner({ skipDate: todays.length ? z.dateStr : null })}${partnerBrief()}${hero}${planExtras(n.plan)}${rest}`;
  },

  tomorrow() {
    const d = state.data, v = V();
    const z = Z();
    const tdate = S.addDays(z.dateStr, 1);
    const tPlan = S.dayPlan(d, viewId(), viewSettings(), tdate);
    let html = `<header class="page-h rise"><h2>${v.whatTomorrow}</h2><span>${dateLabel(tdate)}</span></header>`;
    let plan = tPlan, title = 'باجر';
    if (!tPlan.workday || tPlan.holiday) {
      const dv = S.defaultView(d, viewId(), viewSettings(), new Date(epochAt(z.dateStr, 23 * 60 + 59)));
      const preview = dv.preview || S.addDays(tdate, 1);
      html += `<section class="weekend rise" style="--i:1">
        <div class="weekend-art" aria-hidden="true">${['Fr', 'Sa'].map((s, k) => `<div class="el el--md el-weekend" style="--k:${k}"><span class="el-n">${k + 6}</span><span class="el-sym">${s}</span><span class="el-nick">${k ? 'سبت' : 'جمعة'}</span></div>`).join('')}</div>
        <h3>${tPlan.holiday ? 'باجر عطلة 🎉' : v.weekendTitle}</h3>
        <p>${v.weekendSub} ${S.DAY_NAMES[S.dayKeyOf(preview)]} ${dateLabel(preview, { withDay: false })}</p>
      </section>
      <h3 class="sec-h rise">${S.dayKeyOf(preview) === 'sun' ? 'الأحد الجاي' : S.DAY_NAMES[S.dayKeyOf(preview)] + ' الجاي'}</h3>`;
      plan = S.dayPlan(d, viewId(), viewSettings(), preview);
      title = `${S.DAY_NAMES[plan.dayKey]} الجاي`;
    }
    // The exam of that day goes on top; otherwise the season banner.
    const exams = X.examsOn(d, viewId(), plan.dateStr);
    const when = plan.dateStr === tdate ? 'باجر' : S.DAY_NAMES[plan.dayKey];
    const top = exams.map((e) => examCard({ ...e, dayDiff: X.daysBetween(z.dateStr, e.date) }, { when, luck: luckFor(e) })).join('');
    if (plan === tPlan) html = html.replace('</header>', `</header>${top}`);
    else html += top;
    html += exams.length ? partnerBrief() : examBanner() + partnerBrief();
    html += summaryLine(plan);
    html += planExtras(plan);
    html += plan.entries.length ? timeline(plan) : `<div class="empty rise">${icons.coffee()}<b>${v.noClass}</b></div>`;
    html += `<button class="btn primary share rise" data-act="share" data-date="${plan.dateStr}" data-title="${esc(title)}">${icons.share()}<span>شارك جدول ${esc(title)}</span></button>`;
    return html;
  },

  week() {
    const d = state.data, s = viewSettings();
    const z = Z();
    const start = S.weekStart(z.dateStr);
    const week = S.buildWeek(d, viewId(), s);
    const days = d.workdays;
    const dates = days.map((_, k) => S.addDays(start, k));
    const plans = dates.map((ds) => S.dayPlan(d, viewId(), s, ds, week));
    const used = new Set(Object.values(week.days).flat().flatMap((e) => e.sessions.map((x) => x.slot)));
    const shiftPrefix = s.shift === 'evening' ? 'E' : 'S';
    const slots = Object.keys(d.slots).filter((id) => used.has(id) || id.startsWith(shiftPrefix));
    const head = `<div class="wg-corner"></div>` + days.map((dk, k) => `
      <div class="wg-day ${dates[k] === z.dateStr ? 'today' : ''}"><b>${S.DAY_NAMES[dk].replace('ال', '')}</b><span>${Number(dates[k].slice(8))}</span></div>`).join('');
    let cells = '';
    let k = 0;
    for (const slot of slots) {
      const [a] = d.slots[slot];
      cells += `<div class="wg-time">${t12(S.toMin(a))}</div>`;
      days.forEach((dk, di) => {
        const plan = plans[di];
        const entry = plan.entries.find((e) => e.sessions.some((x) => x.slot === slot));
        const xs = entry ? entry.sessions.filter((x) => x.slot === slot) : [];
        const isToday = dates[di] === z.dateStr;
        if (plan.holiday) { cells += `<div class="wg-cell holiday ${isToday ? 'today' : ''}"><span>عطلة</span></div>`; return; }
        if (!xs.length) { cells += `<div class="wg-cell empty ${isToday ? 'today' : ''}"></div>`; return; }
        const label = xs.map((x) => d.subjects[x.subject].name).join(' و ');
        const attrs = `data-act="detail" data-key="${esc(xs[0].key)}" data-date="${dates[di]}" style="--i:${k++}" aria-label="${esc(label)}"`;
        if (xs.length > 1 || (entry.clash && entry.sessions.length > 1)) {
          const pair = entry.sessions.slice(0, 2);
          cells += `<button class="wg-cell split ${isToday ? 'today' : ''}" ${attrs}>
            ${pair.map((x, pi) => `<span class="half h${pi} s-${x.subject} ${x.dimmed ? 'is-dim' : ''} ${x.cancelled ? 'is-cancel' : ''}"><b>${esc(d.subjects[x.subject].symbol)}</b></span>`).join('')}
            ${entry.chosen ? '' : `<i class="clash-pip" aria-hidden="true">!</i>`}
          </button>`;
        } else {
          const x = xs[0];
          cells += `<button class="wg-cell full s-${x.subject} ${x.cancelled ? 'is-cancel' : ''} ${x.kind === 'lab' ? 'is-lab' : ''} ${isToday ? 'today' : ''}" ${attrs}>
            <b>${esc(d.subjects[x.subject].symbol)}</b><small>${esc(d.subjects[x.subject].nick)}</small>${x.kind === 'lab' ? '<i class="lab-mark" aria-hidden="true"></i>' : ''}
          </button>`;
        }
      });
    }
    const subjectsUsed = [...new Set(Object.values(week.days).flat().flatMap((e) => e.sessions.map((x) => x.subject)))];
    const total = Object.values(week.days).flat().reduce((n, e) => n + e.sessions.length, 0);
    const legend = subjectsUsed.map((sid) => `<div class="legend-item">${tile(d, sid, { size: 'sm' })}<span>${esc(d.subjects[sid].name)}</span></div>`).join('');
    return `<header class="page-h rise"><h2>الجدول الدوري لأسبوع${state.peek ? (prof(viewId()).gender === 'f' ? 'ها' : 'ه') : (prof(viewId()).gender === 'f' ? 'چ' : 'ك')}</h2>
        <span>${dateLabel(dates[0], { withDay: false })} – ${dateLabel(dates[4], { withDay: false })}</span></header>
      <p class="summary rise">${countSessions(total)} بالأسبوع${week.clashes.length ? `<span class="dot">•</span><b class="warn">${countClashes(week.clashes.length)}</b>` : ''}</p>
      <div class="wgrid rise" style="--cols:${days.length};--rows:${slots.length}">${head}${cells}</div>
      <p class="hint rise"><i class="lab-mark inline"></i> مختبر · <span class="split-demo"></span> تصادم — دوس على أي خانة للتفاصيل</p>
      <h3 class="sec-h rise">مفتاح الجدول</h3>
      <div class="legend rise">${legend}</div>`;
  },

  heat() {
    const d = state.data;
    const id = viewId();
    const s = viewSettings();
    const z = Z();
    const nx = S.nextHeat(d, s, now(), id);
    const week = S.buildWeek(d, id, s);
    const start = S.weekStart(z.dateStr);
    const list = d.workdays.flatMap((dk, k) => {
      const ds = S.addDays(start, k);
      const plan = S.dayPlan(d, id, s, ds, week);
      return plan.entries.flatMap((e) => e.sessions.filter((x) => x.subject === 'heat1').map((x) => ({ x, e, ds, dk, plan })));
    });
    const nowE = now().getTime();
    let hero;
    if (nx) {
      const x = nx.entry.sessions.find((y) => y.subject === 'heat1');
      const startEpoch = epochAt(nx.dateStr, nx.entry.start);
      const when = nx.dayOffset === 0 ? 'اليوم' : nx.dayOffset === 1 ? 'باجر' : S.DAY_NAMES[nx.dayKey];
      hero = `<section class="heat-hero rise">
        <div class="heat-flames" aria-hidden="true"><i></i><i></i><i></i></div>
        ${tile(d, 'heat1', { size: 'xl' })}
        <div class="heat-body">
          <span class="eyebrow">الهيت الجاي</span>
          <h2>${when} ${t12(nx.entry.start)}</h2>
          <p>${U.kindPill(x.kind)} ${esc(x.location)} · ${esc(x.instructor || '')}</p>
          <div class="heat-count"><b data-until="${startEpoch}">${U.clock(nx.startsInSec)}</b><span data-dur-until="${startEpoch}">بعد ${S.durationAr(nx.startsInMin)}</span></div>
        </div>
      </section>`;
    } else hero = `<div class="empty">ماكو هيت قريب</div>`;

    const rows = list.map(({ x, e, ds, dk }, k) => {
      const past = epochAt(ds, x.end) < nowE;
      return `<button class="heat-row rise ${past ? 'is-past' : ''} ${x.dimmed ? 'is-dim' : ''} ${x.cancelled ? 'is-cancel' : ''}" style="--i:${k + 2}" data-act="detail" data-key="${esc(x.key)}" data-date="${ds}">
        <span class="heat-day"><b>${S.DAY_NAMES[dk]}</b><small>${dateLabel(ds, { withDay: false })}</small></span>
        <span class="heat-mid">${range12(x.start, x.end)}<span>${U.kindPill(x.kind)}${x.labGroup ? `<span class="tag">كروب ${x.labGroup}${x.groupUncertain ? ' · حسب كروبك' : ''}</span>` : ''}${e.clash ? `<span class="tag tag-warn">تصادم ويه ${esc(e.sessions.filter((y) => y.subject !== 'heat1').map((y) => d.subjects[y.subject].nick).join('، '))}</span>` : ''}</span></span>
        <span class="heat-state">${past ? 'خلصت' : x.cancelled ? 'ملغية' : ''}</span>
      </button>`;
    }).join('');

    const tipCard = '';
    const controls = readOnly() || s.heatTrack !== 'morning' ? '' : `<section class="card controls rise">
      ${s.heatTrack === 'morning' ? `<h4>كروب المختبر (الخميس)</h4>
      ${U.segmented('labGroup', s.labGroup, [['A', 'A · 10:30'], ['B', 'B · 12:30'], ['both', 'الاثنين'], ['unknown', 'ما أعرف']])}
      <p class="hint">${s.labGroup === 'unknown' ? 'دنعرضلك المختبرين لحد ما تعرف كروبك.' : s.labGroup === 'both' ? 'مختبر 4 ساعات (10:30 – 2:30).' : ''}</p>` : ''}
    </section>`;

    return `${hero}${tipCard}<h3 class="sec-h rise">هيت 1 هالأسبوع</h3><div class="heat-list">${rows || '<div class="empty">ماكو</div>'}</div>${controls}`;
  },

  together() {
    const d = state.data;
    const me = state.profile, you = other(me);
    const z = Z();
    const start = S.weekStart(z.dateStr);
    const dates = d.workdays.map((_, k) => S.addDays(start, k));
    const t = S.together(d, { profileId: me, settings: state.settings }, { profileId: you, settings: partnerSettings() }, { dates });
    if (!state.togetherDay || !d.workdays.includes(state.togetherDay)) {
      state.togetherDay = d.workdays.includes(z.dayKey) ? z.dayKey : 'sun';
    }
    const day = t.days.find((x) => x.dayKey === state.togetherDay);
    const nA = prof(me).name, nB = prof(you).name;
    const allWin = t.days.flatMap((x) => x.bothFree.map((w) => ({ ...w, dayKey: x.dayKey })));

    const chips = t.days.map((x) => `<button class="day-chip ${x.dayKey === state.togetherDay ? 'on' : ''}" data-act="tday" data-day="${x.dayKey}">
      <b>${S.DAY_NAMES[x.dayKey].replace('ال', '')}</b>${x.bothFree.length ? `<i class="glow-dot" aria-label="بيه وكت فاضي سوه"></i>` : '<i class="glow-dot off"></i>'}</button>`).join('');

    const span = t.range.to - t.range.from;
    const ppm = span > 400 ? 0.82 : 1.05;
    const H = Math.round(span * ppm);
    const y = (m) => Math.round((m - t.range.from) * ppm);
    const hours = [];
    for (let m = t.range.from; m <= t.range.to; m += 60) hours.push(m);
    const sharedKeys = new Set(day.shared.map((x) => `${x.start}|${x.subject}|${x.kind}`));
    const lane = (plan, side) => S.activeEntries(plan).flatMap((e) => e.sessions.filter((x) => x.attending && !x.cancelled))
      .filter((x) => !sharedKeys.has(`${x.start}|${x.subject}|${x.kind}`) && x.end > t.range.from && x.start < t.range.to)
      .map((x) => `<div class="tg-blk ${side} s-${x.subject}" style="top:${y(Math.max(x.start, t.range.from))}px;height:${y(Math.min(x.end, t.range.to)) - y(Math.max(x.start, t.range.from))}px">
        <b>${esc(d.subjects[x.subject].symbol)}</b><span>${esc(d.subjects[x.subject].nick)}</span></div>`).join('');
    const shared = day.shared.filter((x) => x.end > t.range.from && x.start < t.range.to).map((x) => `<div class="tg-blk both s-${x.subject}" style="top:${y(x.start)}px;height:${y(x.end) - y(x.start)}px">
      <b>${esc(d.subjects[x.subject].symbol)}</b><span>${esc(d.subjects[x.subject].nick)} · سوه</span></div>`).join('');
    const free = day.bothFree.map((w) => `<div class="tg-free" style="top:${y(w.start)}px;height:${y(w.end) - y(w.start)}px">
      ${icons.sparkle()}<b>فاضين سوه</b><span>${range12(w.start, w.end)}</span></div>`).join('');
    const axis = hours.map((m) => `<span style="top:${y(m)}px">${t12(m)}</span>`).join('');

    return `<header class="page-h rise"><h2>سوه</h2><span>${esc(nA)} و ${esc(nB)} · هالأسبوع</span></header>
      <section class="card win-sum rise">
        <h4>${icons.sparkle()} وكت فاضي إلكم الاثنين</h4>
        ${allWin.length ? `<div class="win-list">${allWin.map((w) => `<button class="win" data-act="tday" data-day="${w.dayKey}"><b>${S.DAY_NAMES[w.dayKey]}</b>${range12(w.start, w.end)}</button>`).join('')}</div>`
          : '<p class="hint">ماكو وكت فاضي مشترك هالأسبوع ضمن الدوام 😅</p>'}
        <p class="hint">ضمن الدوام (${t12(t.range.from)} – ${t12(t.range.to)}).${state.partner.shift !== 'morning' || (prof(you).addHeat1 && state.partner.heatTrack !== 'morning') ? '' : ` إعدادات ${esc(nB)} تتعدل من الإعدادات.`}</p>
      </section>
      ${(() => {
        const up = X.examTimeline(d, you, now()).list.filter((e) => !e.done).slice(0, 3);
        return up.length ? `<section class="card partner-ex rise"><h4>${fruitSVG(fruitOf(you), 26)} امتحانات ${esc(nB)} الجاية</h4>
          ${up.map((e) => `<div class="row-line"><span>${esc(noEmoji(X.partnerExamLine(d, you, e, e.dayDiff)))}</span><em class="tag ${X.takesSubject(d, me, e.subject) ? 'tag-amend' : ''}">${X.takesSubject(d, me, e.subject) ? 'سوه' : 'بس إل' + (prof(you).gender === 'f' ? 'ها' : 'ه')}</em></div>`).join('')}</section>` : '';
      })()}
      <div class="day-chips rise">${chips}</div>
      <div class="tg-head rise"><span></span><b class="who-a">${avatar(me, 'xs')}${esc(nA)}</b><b class="who-b">${avatar(you, 'xs')}${esc(nB)}</b></div>
      <div class="tg rise" style="height:${H}px">
        <div class="tg-axis">${axis}</div>
        <div class="tg-lanes">
          <div class="tg-lane-bg a"></div><div class="tg-lane-bg b"></div>
          ${hours.map((m) => `<i class="tg-hr" style="top:${y(m)}px"></i>`).join('')}
          ${free}${shared}${lane(day.a, 'a')}${lane(day.b, 'b')}
        </div>
      </div>
      <p class="hint rise">المحاضرات اللي تحضرونها سوه تندمج بالنص، والوكت الفاضي إلكم الاثنين يضوي.</p>`;
  },
};

// ───────── settings page ─────────
function viewSettingsPage() {
  const d = state.data, s = state.settings;
  const me = state.profile, you = other(me);
  const z = Z();
  if (!state.ovDate) state.ovDate = nextWorkday(z.dateStr);
  const ovPlan = S.dayPlan(d, me, s, state.ovDate);
  const ov = s.overrides[state.ovDate] || {};
  const choices = Object.entries(s.clashChoices);
  const week = S.buildWeek(d, me, s);
  const findKey = (k) => Object.values(week.days).flat().flatMap((e) => e.sessions).find((x) => x.key === k);
  const upcoming = Object.entries(s.overrides).filter(([ds]) => ds >= z.dateStr).sort();
  const youName = esc(prof(you).name);
  const f = prof(me).gender === 'f';
  const pending = state.outbox.edits.length + Object.keys(state.outbox.subjects).length;

  return `<header class="page-h rise"><h2>الإعدادات</h2><span>تنحفظ ب${storage.backend() === 'cloud' ? 'تيليگرام (CloudStorage)' : 'هالمتصفح'}</span></header>

  <section class="card set sync ${state.dirty ? 'dirty' : 'clean'} rise">
    <h4>${icons.swap()} المزامنة ويه ${youName} والبوت</h4>
    <p class="sync-state">${state.dirty ? `<b>${f ? 'عندچ' : 'عندك'} تغييرات ما وصلت بعد</b>${pending ? ` · ${pending} تعديل بالجدول` : ''}` : `${icons.check()}<span>كلشي واصل</span>`}</p>
    <button class="btn primary" data-act="sync">${icons.swap()}<span>احفظ ودزها للبوت</span></button>
    <p class="hint">${canSendData
      ? `التطبيق يتسكر، والتعديل يوصل لـ${youName} أول ما يشتغل البوت على GitHub. هذا ممكن ياخذ من دقائق لساعات، لأن GitHub ما يشغّله بانتظام.`
      : `المزامنة تشتغل بس من زر «📅 جدولي» اللي <b>تحت مربع الكتابة</b> بالبوت (مو زر القائمة). إذا ما موجود، دز /start للبوت.`}</p>
  </section>

  ${editScheduleCard()}

  <section class="card set rise" style="--i:1">
    <h4>${icons.user()} منو أنت؟</h4>
    ${U.segmented('profile', me, [['carrier', esc(prof('carrier').name)], ['standard', esc(prof('standard').name)]], { act: 'setProfile' })}
  </section>

  <section class="card set rise" style="--i:2">
    <h4>الدوام</h4>
    ${U.segmented('shift', s.shift, [['morning', 'صباحي'], ['evening', 'مسائي']])}
    ${prof(me).addHeat1 ? `<h4>هيت 1</h4>
      ${U.segmented('heatTrack', s.heatTrack, [['morning', 'ويه الصباحي'], ['evening', 'ويه المسائي']])}
      ${s.heatTrack === 'morning' ? U.segmented('labGroup', s.labGroup, [['A', 'كروب A'], ['B', 'كروب B'], ['both', 'الاثنين'], ['unknown', 'ما أعرف بعد']]) : ''}` : ''}
    ${U.toggle('amendments', s.amendments, 'طبّق تعديلات القسم')}
    <p class="hint">${(d.streams.stage4_morning.amendments || []).map((a) => esc(a.note)).join(' · ')}</p>
  </section>

  <section class="card set rise" style="--i:3">
    <h4>${icons.clash()} اختياراتك بالتصادمات</h4>
    ${choices.length ? choices.map(([cid, key]) => {
      const x = findKey(key);
      const [dk, hm] = cid.split('@');
      return `<div class="row-line"><span>${S.DAY_NAMES[dk]} ${t12(S.toMin(hm))} ← <b>${x ? esc(d.subjects[x.subject].nick) : '؟'}</b></span><button class="link" data-act="unchoose" data-clash="${esc(cid)}">مسح</button></div>`;
    }).join('') + `<button class="btn ghost sm" data-act="clearChoices">صفّر كل الاختيارات</button>` : '<p class="hint">بعد ما مختار شي. من تشوف تصادم دوس "رايح لهاي".</p>'}
  </section>

  <section class="card set rise" style="--i:4">
    <h4>${icons.note()} تغيير ليوم معيّن</h4>
    <label class="field"><span>اليوم</span><input type="date" value="${state.ovDate}" data-input="ovDate" min="${z.dateStr}"></label>
    <p class="hint">${dateLabel(state.ovDate)}</p>
    ${U.toggle('holiday', !!ov.holiday, 'هاليوم عطلة', { act: 'ovHoliday' })}
    ${ovPlan.entries.length && !ov.holiday ? `<div class="cancel-list">${ovPlan.entries.flatMap((e) => e.sessions).map((x) => `
      <button class="cancel-item ${x.cancelled ? 'on' : ''}" data-act="ovCancel" data-key="${esc(x.key)}" aria-pressed="${!!x.cancelled}">
        ${tile(d, x.subject, { size: 'xs' })}<span>${esc(d.subjects[x.subject].nick)} ${t12(x.start)}</span><em>${x.cancelled ? 'ملغية' : 'إلغاء'}</em></button>`).join('')}</div>` : ''}
    <label class="field"><span>ملاحظة</span><input type="text" maxlength="120" placeholder="مثلاً: امتحان قصير بالمعدات" value="${esc(ov.note || '')}" data-input="ovNote"></label>
    ${upcoming.length ? `<div class="ov-list">${upcoming.map(([ds, o]) => `<div class="row-line"><span><b>${dateLabel(ds)}</b> ${o.holiday ? '· عطلة' : ''}${(o.cancelled || []).length ? ` · ${(o.cancelled || []).length} ملغية` : ''}${o.note ? ` · ${esc(o.note)}` : ''}</span><button class="link" data-act="ovDelete" data-date="${ds}">مسح</button></div>`).join('')}</div>` : ''}
  </section>

  ${state.shared?.people?.[you] ? '' : `<section class="card set rise" style="--i:5">
    <h4>${icons.together()} جدول ${youName}</h4>
    <p class="hint">من ${youName} ${prof(you).gender === 'f' ? 'تسوي' : 'يسوي'} مزامنة، هاي تتحدث وحدها. لحد ذاك، عدّلها هنا حتى تطلع "سوه" صح.</p>
    ${U.segmented('shift', state.partner.shift, [['morning', 'صباحي'], ['evening', 'مسائي']], { act: 'setPartner' })}
    ${prof(you).addHeat1 ? U.segmented('heatTrack', state.partner.heatTrack, [['morning', 'هيت ويه الصباحي'], ['evening', 'هيت ويه المسائي']], { act: 'setPartner' }) : ''}
  </section>`}

  <section class="card set rise" style="--i:6">
    <h4>المظهر</h4>
    ${U.segmented('theme', state.themePref, [['auto', inTelegram ? 'مثل تيليگرام' : 'تلقائي'], ['light', 'فاتح'], ['dark', 'غامق']], { act: 'setTheme' })}
  </section>

  <p class="foot rise">${esc(d.department)} · ${esc(d.semester)}<br>شنو باجر · جدولي</p>`;
}

// ───────── exams page ─────────
function viewExamsPage() {
  const d = state.data, id = viewId(), you = other(id);
  const tl = X.examTimeline(d, id, now());
  const total = tl.list.length, done = tl.list.filter((e) => e.done).length;
  const chain = tl.list.map((e, i) => `${i ? `<i class="bond ${e.done ? 'done' : ''}"></i>` : ''}<span class="chain-el ${e.done ? 'done' : ''} ${tl.next?.id === e.id ? 'next' : ''}" title="${esc(d.subjects[e.subject].name)}">${tile(d, e.subject, { size: 'xs' })}${e.done ? `<b class="chk">${icons.check()}</b>` : ''}</span>`).join('');
  const rows = [];
  tl.list.forEach((e, i) => {
    const gap = tl.gaps[i - 1];
    if (gap && gap.days && !e.done) {
      const nick = esc(X.examNick(d, e.subject));
      const txt = gap.left === gap.days ? `عندك ${daysCount(gap.days)} قبل ${nick}` : gap.left ? `باقي ${daysCount(gap.left)} قبل ${nick}` : `آخر يوم قبل ${nick}`;
      rows.push(`<div class="ex-gap rise"><span class="gap-dots" aria-hidden="true">${gap.dates.map((ds) => `<i class="${ds < tl.today ? 'past' : ds === tl.today ? 'now' : ''}"></i>`).join('')}</span><span>${txt}</span></div>`);
    }
    const isNext = tl.next?.id === e.id;
    const r = reactionOf(e.id);
    const log = state.examLog[e.id] || {};
    rows.push(`<div class="ex-row rise ${e.done ? 'done' : ''} ${isNext ? 'next' : ''}">
      <div class="ex-date"><b>${S.DAY_NAMES[e.dayKey]}</b><small>${dateLabel(e.date, { withDay: false })}</small></div>
      <div class="ex-node s-${e.subject}" aria-hidden="true">${e.done ? icons.check() : ''}</div>
      <div class="ex-card s-${e.subject}">
        <div class="ex-main">${tile(d, e.subject, { size: 'sm' })}
          <span><b>${esc(d.subjects[e.subject].name)}</b><small>${esc(X.examTimeText(e))}${!e.done ? ` · ${X.daysLeftText(e.dayDiff)}` : ''}</small></span>
          ${isNext ? '<em class="tag tag-next">الجاي</em>' : ''}</div>
        ${e.done && !state.peek ? `<div class="ex-after">
          ${r ? `<span class="ex-r">${r[1]} ${r[2]}</span>` : `<span class="ex-ask">شلون كان؟</span>${REACTIONS.map(([k, emo, label]) => `<button class="react-mini" data-act="react" data-id="${e.id}" data-r="${k}" aria-label="${label}">${emo}</button>`).join('')}`}
          <input class="grade" data-input="grade" data-id="${e.id}" inputmode="decimal" maxlength="7" placeholder="الدرجة" value="${esc(log.g || '')}" aria-label="درجة ${esc(d.subjects[e.subject].nick)}">
        </div>` : ''}
      </div>
    </div>`);
  });
  const pUp = X.examTimeline(d, you, now()).list.filter((e) => !e.done);
  return `<header class="page-h rise"><h2>امتحانات المد</h2><span>${total ? `${done} من ${total} خلصت` : 'ماكو امتحانات'}</span></header>
    <div class="chain rise" aria-label="${done} من ${total}">${chain}</div>
    ${tl.next ? examCard(tl.next, { when: `${X.dayWord(tl.next.dayDiff, tl.next.dayKey)}${tl.next.dayDiff >= 2 ? ` · ${X.daysLeftText(tl.next.dayDiff)}` : ''}`, luck: luckFor(tl.next) }) : `<div class="empty rise">${icons.party()}<b>خلصت المد!</b><span>ولا امتحان باقي 🎉</span></div>`}
    <div class="ex-tl">${rows.join('')}</div>
    ${pUp.length ? `<section class="card partner-ex rise"><h4>${fruitSVG(fruitOf(you), 26)} امتحانات ${esc(prof(you).name)}</h4>
      ${pUp.map((e) => `<div class="row-line"><span>${esc(noEmoji(X.partnerExamLine(d, you, e, e.dayDiff)))}</span>${X.takesSubject(d, id, e.subject) ? '' : `<em class="tag">بس إل${prof(you).gender === 'f' ? 'ها' : 'ه'}</em>`}</div>`).join('')}</section>` : ''}
    <p class="hint rise">المواعيد من جدول القسم. الامتحان اللي وقته ما متبلغ يبقى بدون وكت لحد ما ينعلن.</p>`;
}

// ───────── in-app reminders (the only reminders: nothing is sent to Telegram) ─────────
let inboxCache = [];
function inboxItems() {
  if (!state.profile || !state.data) return [];
  const d = state.data, me = state.profile, you = other(me), z = Z();
  const items = [];
  for (const l of X.examBrief(d, me, now()).lines) {
    items.push({
      id: `ex|${l.kind}|${l.exam.id}|${z.dateStr}`, tone: l.kind === 'partner' ? 'partner' : 'exam', act: 'openExams',
      icon: l.kind === 'partner' ? fruitSVG(fruitOf(you), 28) : tile(d, l.exam.subject, { size: 'xs' }),
      text: l.kind === 'partner' ? noEmoji(l.text) : l.text, sub: l.luck || '',
    });
  }
  const f = X.focusSuggestion(d, me, now());
  if (f && f.days >= 2 && f.days <= 7) items.push({ id: `focus|${z.dateStr}`, icon: icons.sparkle(), act: 'openExams', text: `ركّز اليوم على ${X.examNick(d, f.exam.subject)}`, sub: `امتحانها ${X.daysLeftText(f.days)}` });
  const n = S.nowInfo(d, me, state.settings, now());
  if (n.next && n.next.dayOffset === 0 && n.next.startsInMin <= 60) {
    const x = n.next.entry.sessions.find((s) => s.attending) || n.next.entry.sessions[0];
    items.push({ id: `lec|${z.dateStr}|${n.next.entry.start}`, icon: tile(d, x.subject, { size: 'xs' }), act: 'tab', tab: 'now', text: `بعد ${S.durationAr(n.next.startsInMin)}: ${d.subjects[x.subject].nick}`, sub: `${x.location} · ${S.time12Str(n.next.entry.start)}` });
  }
  for (const ds of [z.dateStr, S.addDays(z.dateStr, 1)]) {
    for (const e of S.activeEntries(S.dayPlan(d, me, state.settings, ds))) {
      if (!e.clash || e.chosen || (ds === z.dateStr && e.end <= z.minutes)) continue;
      items.push({ id: `clash|${ds}|${e.start}`, icon: icons.clash(), act: 'tab', tab: ds === z.dateStr ? 'now' : 'tomorrow', text: `${ds === z.dateStr ? 'اليوم' : 'باجر'} عندك تصادم ${S.time12Str(e.start)}`, sub: e.sessions.map((x) => d.subjects[x.subject].nick).join(' ✕ ') });
    }
  }
  for (const e of (state.shared?.edits || []).filter((x) => x.by === you).slice(-4)) {
    items.push({ id: `edit|${e.id}`, icon: fruitSVG(fruitOf(you), 28), act: 'openSettings', tone: 'partner', text: `${prof(you).name} ${prof(you).gender === 'f' ? 'عدّلت' : 'عدّل'} الجدول`, sub: describeEdit(e) });
  }
  for (const e of X.examTimeline(d, me, now()).list.filter((x) => x.done && !state.examLog[x.id])) {
    items.push({ id: `react|${e.id}`, icon: tile(d, e.subject, { size: 'xs' }), act: 'askReact', exam: e.id, text: `شلون كان امتحان ${X.examNick(d, e.subject)}؟`, sub: 'سجّل شعورك والدرجة' });
  }
  if (state.dirty) items.push({ id: `dirty|${z.dateStr}`, icon: icons.swap(), act: 'openSettings', text: `عندك تغييرات ما وصلت لـ${prof(you).name}`, sub: 'من الإعدادات دوس «احفظ ودزها للبوت»' });
  return items;
}

function inboxHTML() {
  inboxCache = inboxItems();
  const g = prof(state.profile).gender;
  return `<div class="scrim" data-act="closeInbox"></div>
    <div class="sheet inbox" role="dialog" aria-modal="true" aria-label="التذكيرات">
      <div class="sheet-grab"></div>
      <h3 class="inbox-h">${icons.bell()}<span>تذكيراتك</span><small>كلها هنا، ما ندز شي لتيليگرام</small></h3>
      ${inboxCache.length ? inboxCache.map((it, i) => `<button class="inbox-item tone-${it.tone || 'base'} ${state.seen.includes(it.id) ? '' : 'new'}" data-act="inboxGo" data-i="${i}">
        <span class="ii-ico">${it.icon}</span><span class="ii-txt"><b>${esc(it.text)}</b>${it.sub ? `<small>${esc(it.sub)}</small>` : ''}</span></button>`).join('')
      : `<div class="empty">${fruitSVG(fruitOf(state.profile), 72)}<b>ماكو شي جديد</b><span>${g === 'f' ? 'استانسي' : 'استانس'}، كلشي تحت السيطرة</span></div>`}
    </div>`;
}

function reactHTML() {
  const d = state.data, e = X.examsFor(d, state.profile).find((x) => x.id === state.react);
  if (!e) { state.react = null; return ''; }
  const g = prof(state.profile).gender;
  return `<div class="scrim" data-act="closeReact"></div>
    <div class="sheet react-sheet" role="dialog" aria-modal="true" aria-label="شلون كان الامتحان">
      <div class="sheet-grab"></div>
      <div class="react-top">${tile(d, e.subject, { size: 'lg' })}${fruitSVG(fruitOf(state.profile), 64)}</div>
      <h3>شلون كان امتحان ${esc(X.examNick(d, e.subject))}؟</h3>
      <p class="hint">${g === 'f' ? 'اختاري' : 'اختار'} اللي يوصف شعورك. محد يشوفه غيرك.</p>
      <div class="react-grid">${REACTIONS.map(([k, emo, label]) => `<button class="react-btn ${state.examLog[e.id]?.r === k ? 'on' : ''}" data-act="react" data-id="${e.id}" data-r="${k}"><span class="emo">${emo}</span><span>${label}</span></button>`).join('')}</div>
      <label class="field"><span>الدرجة (اختياري، تگدر تضيفها بعدين)</span><input data-input="grade" data-id="${e.id}" inputmode="decimal" maxlength="7" placeholder="مثلاً 17/20" value="${esc(state.examLog[e.id]?.g || '')}"></label>
      <button class="btn ghost" data-act="closeReact">بعدين</button>
    </div>`;
}

/** After the app opens: ask about the latest finished exam, or celebrate the end of midterms (once). */
function afterOpen() {
  if (!state.profile || state.peek || state.asked) return;
  state.asked = true;
  const tl = X.examTimeline(state.data, state.profile, now());
  const pending = tl.list.filter((e) => e.done && !state.examLog[e.id] && X.daysBetween(e.date, tl.today) <= 7).pop();
  if (pending) { state.react = pending.id; renderSheet(); syncBack(); return; }
  celebrate();
}

function celebrate() {
  const tl = X.examTimeline(state.data, state.profile, now());
  if (!X.celebrationDue(tl, state.midDone)) return;
  state.midDone = true; save('midDone');
  const g = prof(state.profile).gender;
  const el = document.createElement('div');
  el.className = 'celebrate';
  el.innerHTML = `<canvas aria-hidden="true"></canvas>
    <div class="cel-card" role="dialog" aria-modal="true" aria-label="خلصت المد">
      <div class="cel-fruits">${fruitSVG('dragon', 92)}${fruitSVG('peach', 92)}</div>
      <h2>خلصت المد! 🎉</h2>
      <p>${tl.list.length} امتحانات وخلصت. ${g === 'f' ? 'تستاهلين' : 'تستاهل'} راحة حلوة.</p>
      <button class="btn primary" data-act="closeCelebrate">يلا نرتاح</button>
    </div>`;
  document.body.appendChild(el);
  tg.haptic('success');
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) confetti(el.querySelector('canvas'));
}

/** Short, tasteful confetti in the subject colours (~2.6 s), then it stops. */
function confetti(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = (canvas.width = innerWidth * dpr), H = (canvas.height = innerHeight * dpr);
  const colors = ['#8b5cf6', '#0d9488', '#3b82f6', '#ec4899', '#d97706', '#f97316', '#fbbf24', '#b7ea6e'];
  const parts = Array.from({ length: 130 }, () => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3, y: H * 0.42, vx: (Math.random() - 0.5) * 14 * dpr, vy: (-6 - Math.random() * 12) * dpr,
    s: (4 + Math.random() * 6) * dpr, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, c: colors[(Math.random() * colors.length) | 0], round: Math.random() < 0.3,
  }));
  const t0 = performance.now();
  (function frame(t) {
    const k = (t - t0) / 2600;
    ctx.clearRect(0, 0, W, H);
    for (const p of parts) {
      p.vy += 0.35 * dpr; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      ctx.save(); ctx.globalAlpha = Math.max(0, 1 - k * k); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.s / 2, 0, 6.28); ctx.fill(); } else ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
      ctx.restore();
    }
    if (k < 1) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// ───────── schedule editor (shared with the other person through the bot) ─────────
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function describeKey(key) {
  const d = state.data;
  if (key.startsWith('edit:')) return 'محاضرة مضافة';
  if (key.startsWith('amend:')) { const [, , day, slot, sub] = key.split(':'); return `${d.subjects[sub]?.nick || sub} ${S.DAY_NAMES[day] || ''} ${S.time12Str(S.toMin(d.slots[slot]?.[0] || '00:00'))}`; }
  const id = key.split(':');
  const [, day, slot, sub] = id.length >= 5 ? id : [null, ...id];
  if (!d.subjects[sub] || !d.slots[slot]) return key;
  return `${d.subjects[sub].nick} ${S.DAY_NAMES[day]} ${S.time12Str(S.toMin(d.slots[slot][0]))}`;
}

function describeEdit(e) {
  const d = state.data;
  if (e.op === 'add') { const s = e.session; return `➕ ${d.subjects[s.subject]?.nick} · ${S.DAY_NAMES[s.day]} ${S.time12Str(S.toMin(d.slots[s.slot][0]))}`; }
  if (e.op === 'remove') return `✖ حذف ${describeKey(e.key)}`;
  const set = e.set || {};
  const bits = [];
  if (set.day || set.slot) bits.push(`${set.day ? S.DAY_NAMES[set.day] : ''} ${set.slot ? S.time12Str(S.toMin(d.slots[set.slot][0])) : ''}`.trim());
  if (set.room) bits.push(set.room);
  if (set.instructor) bits.push(set.instructor);
  if (set.kind) bits.push(S.KIND_NAMES[set.kind]);
  return `✏️ ${describeKey(e.key)} ← ${bits.join(' · ') || 'تعديل'}`;
}

function editScheduleCard() {
  const d = state.data, me = state.profile, s = state.settings;
  if (!state.editDay) state.editDay = d.workdays.includes(Z().dayKey) ? Z().dayKey : 'sun';
  const week = S.buildWeek(d, me, s);
  const list = week.days[state.editDay].flatMap((e) => e.sessions);
  const ms = mergedShared();
  const pendingIds = new Set(state.outbox.edits.map((e) => e.id));
  const reverting = new Set(state.outbox.edits.filter((e) => e.op === 'revert').map((e) => e.id));
  const shownEdits = [...(state.shared?.edits || []), ...state.outbox.edits.filter((e) => e.op !== 'revert' && !(state.shared?.edits || []).some((x) => x.id === e.id))];
  return `<section class="card set rise">
    <h4>${icons.edit()} تعديل المواد والمحاضرات</h4>
    <p class="hint">أي تعديل هنا يتطبق على ${esc(prof(other(me)).name)} هم (نفس المرحلة) بعد المزامنة.</p>
    <div class="day-chips mini">${d.workdays.map((dk) => `<button class="day-chip ${dk === state.editDay ? 'on' : ''}" data-act="editDay" data-day="${dk}"><b>${S.DAY_NAMES[dk].replace('ال', '')}</b></button>`).join('')}</div>
    <div class="ed-list">${list.length ? list.map((x) => `
      <div class="ed-row ${x.edited ? 'is-edited' : ''}">
        ${tile(d, x.subject, { size: 'xs' })}
        <span class="ed-txt"><b>${esc(d.subjects[x.subject].nick)}</b><small>${t12(x.start)} · ${S.KIND_NAMES[x.kind]} · ${esc(x.location)}</small></span>
        <button class="icon-btn sm" data-act="editOpen" data-key="${esc(x.key)}" aria-label="تعديل">${icons.edit()}</button>
        <button class="icon-btn sm danger" data-act="editRemove" data-key="${esc(x.key)}" data-stream="${x.stream}" aria-label="حذف">${icons.close()}</button>
      </div>`).join('') : '<p class="hint">ماكو محاضرات بهاليوم.</p>'}</div>
    <button class="btn ghost sm" data-act="editAdd">+ إضافة محاضرة ليوم ${S.DAY_NAMES[state.editDay]}</button>
    ${shownEdits.length ? `<h4 class="sub-h">تعديلاتكم</h4><div class="ov-list">${shownEdits.map((e) => `
      <div class="row-line ${reverting.has(e.id) ? 'is-cancel' : ''}"><span>${esc(describeEdit(e))}${pendingIds.has(e.id) ? ' <em class="tag">ينتظر مزامنة</em>' : ''}${reverting.has(e.id) ? ' <em class="tag tag-cancel">راح يرجع</em>' : ''}</span>
      ${reverting.has(e.id) ? '' : `<button class="link" data-act="editRevert" data-id="${esc(e.id)}">تراجع</button>`}</div>`).join('')}</div>` : ''}
    <details class="names"><summary>أسماء المواد</summary>
      ${Object.entries(state.data.subjects).map(([id, sub]) => `<label class="field row">${tile(d, id, { size: 'xs' })}<input type="text" maxlength="40" value="${esc(sub.name)}" data-input="subj" data-id="${id}" aria-label="اسم ${esc(sub.nick)}"></label>`).join('')}
    </details>
  </section>`;
  void ms;
}

function editSheetHTML() {
  const d = state.data, ed = state.editing, x = ed.draft;
  const opt = (pairs, v) => pairs.map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${l}</option>`).join('');
  const subjects = Object.entries(d.subjects).map(([k, s]) => [k, `${s.symbol} · ${s.name}`]);
  const slots = Object.keys(d.slots).map((k) => [k, `${S.time12Str(S.toMin(d.slots[k][0]))} – ${S.time12Str(S.toMin(d.slots[k][1]))}`]);
  return `<div class="scrim" data-act="editClose"></div>
    <div class="sheet edit-sheet" role="dialog" aria-modal="true">
      <div class="sheet-grab"></div>
      <h3 class="ed-title">${tile(d, x.subject, { size: 'sm' })}<span>${ed.mode === 'add' ? 'محاضرة جديدة' : 'تعديل المحاضرة'}</span></h3>
      <label class="field"><span>المادة</span><select data-input="ed.subject" ${ed.mode === 'update' ? 'disabled' : ''}>${opt(subjects, x.subject)}</select></label>
      <div class="grid2">
        <label class="field"><span>اليوم</span><select data-input="ed.day">${opt(d.workdays.map((k) => [k, S.DAY_NAMES[k]]), x.day)}</select></label>
        <label class="field"><span>الوكت</span><select data-input="ed.slot">${opt(slots, x.slot)}</select></label>
      </div>
      <span class="field-k">النوع</span>
      ${U.segmented('kind', x.kind, [['lecture', 'محاضرة'], ['lab', 'مختبر'], ['project', 'مشروع']], { act: 'edKind' })}
      <div class="grid2">
        <label class="field"><span>التدريسي</span><input type="text" maxlength="30" value="${esc(x.instructor || '')}" data-input="ed.instructor" placeholder="مثلاً: د. علاء"></label>
        <label class="field"><span>القاعة</span><input type="text" maxlength="20" value="${esc(x.room || '')}" data-input="ed.room" placeholder="${x.kind === 'lab' ? 'مختبر' : 'قاعة 1'}"></label>
      </div>
      <div class="ed-actions">
        <button class="btn primary" data-act="editSave">${icons.check()}<span>${ed.mode === 'add' ? 'أضف' : 'احفظ التعديل'}</span></button>
        <button class="btn ghost" data-act="editClose">إلغاء</button>
      </div>
      <p class="hint">بعدها دوس «احفظ ودزها للبوت» حتى يوصل لـ${esc(prof(other(state.profile)).name)}.</p>
    </div>`;
}

function findSession(key) {
  return Object.values(S.buildWeek(state.data, state.profile, state.settings).days).flat().flatMap((e) => e.sessions).find((x) => x.key === key);
}

function pushEdit(e) {
  state.outbox.edits.push(e);
  save('outbox'); recompute(); tg.haptic('success');
}

function nextWorkday(dateStr) {
  let ds = S.addDays(dateStr, 1);
  for (let i = 0; i < 7 && !state.data.workdays.includes(S.dayKeyOf(ds)); i++) ds = S.addDays(ds, 1);
  return ds;
}

// ───────── detail sheet ─────────
function renderSheet() {
  const root = $('#sheet-root');
  if (state.editing) { root.innerHTML = editSheetHTML(); return; }
  if (state.react) { root.innerHTML = reactHTML(); return; }
  if (state.inbox) { root.innerHTML = inboxHTML(); return; }
  if (!state.sheet) { root.innerHTML = ''; return; }
  const d = state.data;
  const s = viewSettings();
  const ds = state.sheet.dateStr || null;
  const week = S.buildWeek(d, viewId(), s);
  const plan = ds ? S.dayPlan(d, viewId(), s, ds, week) : null;
  const entries = plan ? plan.entries : Object.values(week.days).flat();
  const entry = entries.find((e) => e.sessions.some((x) => x.key === state.sheet.key));
  if (!entry) { state.sheet = null; root.innerHTML = ''; return; }
  const v = V();
  const body = entry.sessions.map((x) => {
    const sub = d.subjects[x.subject];
    return `<div class="sheet-item s-${x.subject} ${x.dimmed ? 'is-dim' : ''}">
      ${tile(d, x.subject, { size: 'lg' })}
      <div class="sheet-info">
        <h3>${esc(sub.name)}</h3>
        <p class="nick">"${esc(sub.nick)}"</p>
        <dl>
          <dt>النوع</dt><dd>${U.kindPill(x.kind)}</dd>
          <dt>الوكت</dt><dd>${S.DAY_NAMES[x.day]} ${range12(x.start, x.end)}</dd>
          <dt>المكان</dt><dd>${esc(x.location)}${x.kind === 'lab' ? '' : ''}</dd>
          ${x.instructor ? `<dt>التدريسي</dt><dd>${esc(x.instructor)}</dd>` : ''}
          ${x.fromStage ? `<dt>ويه</dt><dd>${esc(x.fromStage)} (${esc(x.room)})</dd>` : ''}
          ${x.labGroup ? `<dt>الكروب</dt><dd>${x.labGroup}${x.groupUncertain ? ' · حسب كروبك' : ''}</dd>` : ''}
          ${x.amended ? `<dt>ملاحظة</dt><dd>${esc(x.note || 'تعديل القسم')}</dd>` : ''}
        </dl>
        ${entry.clash && !readOnly() ? `<button class="btn-go ${entry.chosen === x.key ? 'on' : ''}" data-act="choose" data-clash="${esc(entry.id)}" data-key="${esc(x.key)}">${entry.chosen === x.key ? icons.check() + '<span>رايح لهاي</span>' : v.going}</button>` : ''}
        ${ds && !readOnly() ? `<button class="btn ghost sm" data-act="ovCancel" data-key="${esc(x.key)}" data-date="${ds}">${x.cancelled ? 'رجّعها لهذا اليوم' : `ألغيها يوم ${dateLabel(ds, { withDay: false })} بس`}</button>` : ''}
      </div>
    </div>`;
  }).join(entry.clash ? '<div class="sheet-vs">تصادم</div>' : '');
  root.innerHTML = `<div class="scrim" data-act="closeSheet"></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="sheet-grab"></div>
      <button class="icon-btn sheet-x" data-act="closeSheet" aria-label="سد">${icons.close()}</button>
      ${body}
    </div>`;
}
function closeSheet() { state.sheet = null; renderSheet(); syncBack(); }

// ───────── picker ─────────
function renderPicker() {
  $('#top').innerHTML = '';
  $('#tabs').hidden = true;
  $('#view').innerHTML = '';
  const d = state.data;
  const card = (id, line) => `<button class="pick s-${id === 'carrier' ? 'equipment' : 'refining'} pick-${fruitOf(id)}" data-act="pick" data-id="${id}" aria-label="${esc(prof(id).name)}">
      ${avatar(id, 'xl')}
      ${photoBadge(id)}
      <b>${esc(prof(id).name)} ${prof(id).emoji || ''}</b><span>${line}</span></button>`;
  $('#picker-root').innerHTML = `<div class="picker">
    <div class="picker-hex" aria-hidden="true"></div>
    <p class="picker-k">شنو باجر · جدولي</p>
    <h1>منو أنت؟</h1>
    <p class="picker-sub">دوس على فاكهتك، والتطبيق كله يصير إلك.</p>
    <div class="pick-row">
      ${card('carrier', 'فاكهة التنين · الرابع + هيت 1')}
      ${card('standard', 'الخوخة · الرابع، جدول كامل')}
    </div>
    <p class="foot">${esc(d.department)}</p>
  </div>`;
}

// ───────── actions ─────────
const act = {
  pick(el) {
    wobble(el.querySelector('.ava'));
    tg.haptic('success');
    setTimeout(() => {
      state.profile = el.dataset.id; save('profile');
      state.tab = smartTab();
      render();
      setTimeout(afterOpen, 700);
    }, 380);
  },
  tab(el) {
    state.tab = el.dataset.tab; state.sub = null;
    tg.haptic('select');
    render();
    window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  },
  peek() {
    state.peek = !state.peek;
    tg.haptic('select');
    render();
    wobble($('.fruit-btn'));
  },
  wobble(el) { wobble(el); tg.haptic('light'); },
  openExams() { state.sub = 'exams'; state.inbox = false; tg.haptic('light'); render(); window.scrollTo(0, 0); },
  openInbox() {
    state.inbox = true; tg.haptic('light');
    renderSheet(); syncBack();
    state.seen = [...new Set([...state.seen, ...inboxCache.map((i) => i.id)])].slice(-60);
    save('seen');
    renderTop();
  },
  closeInbox() { state.inbox = false; renderSheet(); syncBack(); },
  inboxGo(el) {
    const it = inboxCache[+el.dataset.i];
    state.inbox = false;
    if (!it) return renderSheet();
    if (it.act === 'askReact') { state.react = it.exam; renderSheet(); syncBack(); return; }
    if (it.act === 'tab') { state.sub = null; state.tab = it.tab; renderSheet(); render(); return; }
    renderSheet();
    act[it.act]?.();
  },
  askReact(el) { state.react = el.dataset.id; renderSheet(); syncBack(); },
  react(el) {
    const { id, r } = el.dataset;
    state.examLog[id] = { ...(state.examLog[id] || {}), r };
    save('examLog'); tg.haptic('success');
    if (state.react) { state.react = null; renderSheet(); syncBack(); celebrate(); }
    render({ anim: false });
  },
  closeReact() { state.react = null; renderSheet(); syncBack(); celebrate(); },
  closeCelebrate() { document.querySelector('.celebrate')?.remove(); },
  openSettings() { state.sub = 'settings'; render(); window.scrollTo(0, 0); },
  closeSub() { state.sub = null; render(); window.scrollTo(0, 0); },
  set(el) {
    const { name, value } = el.dataset;
    state.settings[name] = value;
    save('settings');
    tg.haptic('select');
    render({ anim: false });
  },
  setProfile(el) {
    if (state.profile === el.dataset.value) return;
    state.profile = el.dataset.value; state.peek = false; save('profile');
    tg.haptic('select');
    render({ anim: false });
  },
  setPartner(el) {
    state.partner[el.dataset.name] = el.dataset.value; save('partner');
    tg.haptic('select');
    render({ anim: false });
  },
  setTheme(el) {
    state.themePref = el.dataset.value; save('theme');
    applyTheme(); render({ anim: false });
  },
  toggle(el) {
    const n = el.dataset.name;
    state.settings[n] = !state.settings[n];
    save('settings'); tg.haptic('select'); render({ anim: false });
  },
  choose(el) {
    const { clash, key } = el.dataset;
    if (state.settings.clashChoices[clash] === key) delete state.settings.clashChoices[clash];
    else state.settings.clashChoices[clash] = key;
    save('clash'); tg.haptic('success');
    render({ anim: false });
  },
  unchoose(el) {
    delete state.settings.clashChoices[el.dataset.clash];
    save('clash'); tg.haptic('light'); render({ anim: false });
  },
  clearChoices() { state.settings.clashChoices = {}; save('clash'); render({ anim: false }); },
  detail(el) {
    state.sheet = { key: el.dataset.key, dateStr: el.dataset.date || contextDate() };
    tg.haptic('light');
    renderSheet(); syncBack();
  },
  closeSheet() { closeSheet(); },
  ovHoliday() {
    const ds = state.ovDate;
    const o = { ...(state.settings.overrides[ds] || {}) };
    o.holiday = !o.holiday;
    state.settings.overrides[ds] = o; save('overrides'); render({ anim: false });
  },
  ovCancel(el) {
    const ds = el.dataset.date || state.ovDate;
    const o = { ...(state.settings.overrides[ds] || {}) };
    const set = new Set(o.cancelled || []);
    set.has(el.dataset.key) ? set.delete(el.dataset.key) : set.add(el.dataset.key);
    o.cancelled = [...set];
    state.settings.overrides[ds] = o; save('overrides'); tg.haptic('light');
    render({ anim: false });
  },
  ovDelete(el) { delete state.settings.overrides[el.dataset.date]; save('overrides'); render({ anim: false }); },
  tday(el) { state.togetherDay = el.dataset.day; tg.haptic('select'); render({ anim: false }); },
  share(el) {
    const plan = S.dayPlan(state.data, viewId(), viewSettings(), el.dataset.date);
    const p = prof(viewId());
    const exams = X.examsOn(state.data, viewId(), plan.dateStr).map((e) => `📝 امتحان ${state.data.subjects[e.subject].name} · ${X.examTimeText(e)}`);
    let text = S.planText(state.data, plan, { title: `📅 ${p.emoji || ''} جدول ${p.name} · ${el.dataset.title} (${dateLabel(plan.dateStr)})` });
    if (exams.length) text = text.replace('\n', `\n${exams.join('\n')}\n`);
    tg.openLink(`https://t.me/share/url?url=${encodeURIComponent(BOT_LINK)}&text=${encodeURIComponent(text)}`);
  },
  editDay(el) { state.editDay = el.dataset.day; tg.haptic('select'); render({ anim: false }); },
  editAdd() {
    const slot = state.settings.shift === 'evening' ? 'E1' : 'S1';
    state.editing = { mode: 'add', draft: { day: state.editDay, slot, subject: 'units', kind: 'lecture', instructor: '', room: '' } };
    renderSheet(); syncBack();
  },
  editOpen(el) {
    const x = findSession(el.dataset.key);
    if (!x) return;
    state.editing = { mode: 'update', key: x.key, stream: x.stream, orig: x, draft: { day: x.day, slot: x.slot, subject: x.subject, kind: x.kind, instructor: x.instructor || '', room: x.roomOverride || '' } };
    renderSheet(); syncBack();
  },
  edKind(el) { state.editing.draft.kind = el.dataset.value; renderSheet(); },
  editClose() { state.editing = null; renderSheet(); syncBack(); },
  editSave() {
    const ed = state.editing, x = ed.draft;
    const clean = { day: x.day, slot: x.slot, subject: x.subject, kind: x.kind, instructor: x.instructor.trim() || null, room: x.room.trim() || null };
    if (ed.mode === 'add') {
      pushEdit({ id: newId(), stream: S.streamFor(clean, state.settings), op: 'add', session: clean });
    } else {
      const o = ed.orig, set = {};
      for (const k of ['day', 'slot', 'kind']) if (clean[k] !== o[k]) set[k] = clean[k];
      if ((clean.instructor || null) !== (o.instructor || null)) set.instructor = clean.instructor || '';
      if ((clean.room || null) !== (o.roomOverride || null)) set.room = clean.room || '';
      if (Object.keys(set).length) pushEdit({ id: newId(), stream: ed.stream, op: 'update', key: ed.key, set });
    }
    state.editing = null; render({ anim: false });
  },
  editRemove(el) {
    pushEdit({ id: newId(), stream: el.dataset.stream, op: 'remove', key: el.dataset.key });
    render({ anim: false });
  },
  editRevert(el) {
    const id = el.dataset.id;
    const local = state.outbox.edits.findIndex((e) => e.id === id && e.op !== 'revert');
    if (local >= 0) state.outbox.edits.splice(local, 1);
    else state.outbox.edits.push({ id, op: 'revert' });
    save('outbox'); recompute(); render({ anim: false });
  },
  sync() {
    const payload = {
      v: 1, profile: state.profile,
      prefs: { ...pick(state.settings, ['shift', 'heatTrack', 'labGroup']), clash: state.settings.clashChoices },
      edits: state.outbox.edits, subjects: state.outbox.subjects,
    };
    const str = JSON.stringify(payload);
    if (new TextEncoder().encode(str).length > 4096) { toast('التعديلات هواية مرة وحدة، دز قسم منها وبعدين الباقي.'); return; }
    if (!canSendData) {
      toast('افتح التطبيق من زر «📅 جدولي» اللي تحت مربع الكتابة بالبوت، وبعدين دوس مزامنة.');
      return;
    }
    state.dirty = false;
    storage.set('dirty', false);
    tg.haptic('success');
    setTimeout(() => tg.sendData(str), 120);
  },
};

function wobble(el) {
  if (!el) return;
  el.classList.remove('wobble'); void el.offsetWidth; el.classList.add('wobble');
  el.addEventListener('animationend', () => el.classList.remove('wobble'), { once: true });
}

/** The date a tapped tile refers to, by current tab. */
function contextDate() {
  const z = Z();
  if (state.tab === 'tomorrow') return S.addDays(z.dateStr, 1);
  if (state.tab === 'now') return z.dateStr;
  return null;
}

function smartTab() {
  const dv = S.defaultView(state.data, state.profile, state.settings, now());
  return dv.view === 'today' ? 'now' : 'tomorrow';
}

// ───────── live tick ─────────
function tick(force = false) {
  const n = now().getTime();
  let crossed = false;
  document.querySelectorAll('[data-until]').forEach((el) => {
    const left = (+el.dataset.until - n) / 1000;
    if (left <= 0) crossed = true;
    el.textContent = U.clock(left);
  });
  document.querySelectorAll('[data-dur-until]').forEach((el) => {
    el.textContent = `بعد ${S.durationAr(Math.ceil((+el.dataset.durUntil - n) / 60000))}`;
  });
  document.querySelectorAll('[data-ring-from]').forEach((el) => {
    const from = +el.dataset.ringFrom, to = +el.dataset.ringTo;
    const p = Math.max(0, Math.min(1, (n - from) / Math.max(1, to - from)));
    const bar = el.querySelector('.ring-bar');
    if (bar) bar.style.strokeDashoffset = (+bar.dataset.ringC * (1 - p)).toFixed(1);
    el.querySelectorAll('.tick').forEach((t, k, all) => t.classList.toggle('lit', k / all.length <= p));
  });
  const z = Z();
  if (!force && state.profile && !state.sheet && (crossed || z.minutes !== state.lastMinute && z.minutes % 15 === 0)) {
    state.lastMinute = z.minutes;
    render({ anim: false });
    return;
  }
  state.lastMinute = z.minutes;
}

// ───────── boot ─────────
async function boot() {
  tg.init();
  applyInsets();
  const res = await fetch('data/schedule.json', { cache: 'no-cache' });
  state.base = await res.json();
  try { state.shared = JSON.parse(localStorage.getItem('jadwali.sharedCache') || 'null'); } catch {}

  applyStored(storage.loadLocal());
  recompute();
  loadShared().then((changed) => { if (changed && state.profile) render({ anim: false }); });
  const forcedProfile = params.get('profile');
  if (forcedProfile === 'carrier' || forcedProfile === 'standard') state.profile = forcedProfile;
  applyTheme();
  state.tab = state.profile ? smartTab() : 'now';
  render();
  document.documentElement.classList.add('ready');

  // CloudStorage is the source of truth inside Telegram; re-render if it differs.
  const cloud = await storage.loadCloud();
  if (cloud && Object.values(cloud).some((v) => v !== null)) {
    const before = JSON.stringify([state.profile, state.settings, state.partner, state.themePref]);
    applyStored(cloud);
    recompute();
    if (JSON.stringify([state.profile, state.settings, state.partner, state.themePref]) !== before) {
      applyTheme();
      if (!state.tab || !before.includes(state.profile)) state.tab = smartTab();
      render({ anim: false });
    }
  } else if (cloud && state.profile) {
    // First run inside Telegram with local data only → push it up.
    ['profile', 'settings', 'clash', 'overrides', 'partner', 'theme', 'outbox', 'examLog', 'midDone'].forEach(save);
  }
  setTimeout(afterOpen, 700);

  tg.on('themeChanged', () => { applyTheme(); render({ anim: false }); });
  tg.on('safeAreaChanged', applyInsets);
  tg.on('contentSafeAreaChanged', applyInsets);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.themePref === 'auto') { applyTheme(); render({ anim: false }); } });

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || !state.profile) return;
    loadShared().finally(() => render({ anim: false }));
  });
  setInterval(() => loadShared().then((c) => { if (c && state.profile && !state.editing) render({ anim: false }); }), 120000);
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = act[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el); }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (state.react) act.closeReact(); else if (state.inbox) act.closeInbox(); else if (state.sheet) closeSheet();
  }
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('[role="button"][data-act]:not(button)')) { ev.preventDefault(); ev.target.click(); }
});
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3600);
  setTimeout(() => t.remove(), 4000);
}

document.addEventListener('input', (ev) => {
  const el = ev.target, k = el.dataset.input || '';
  if (k.startsWith('ed.') && state.editing && el.tagName === 'INPUT') state.editing.draft[k.slice(3)] = el.value;
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
  const k = el.dataset.input || '';
  if (k.startsWith('ed.') && state.editing) {
    state.editing.draft[k.slice(3)] = el.value;
    if (el.tagName === 'SELECT') renderSheet();
    return;
  }
  if (k === 'grade') {
    const id = el.dataset.id;
    state.examLog[id] = { ...(state.examLog[id] || {}), g: el.value.trim().slice(0, 7) };
    save('examLog'); tg.haptic('light');
    return;
  }
  if (k === 'subj') {
    const id = el.dataset.id, name = el.value.trim();
    if (name && name !== state.data.subjects[id].name) {
      state.outbox.subjects[id] = { name, nick: state.data.subjects[id].nick };
      save('outbox'); recompute(); render({ anim: false });
    }
    return;
  }
  if (el.dataset.input === 'ovDate' && el.value) { state.ovDate = el.value; render({ anim: false }); }
  if (el.dataset.input === 'ovNote') {
    const o = { ...(state.settings.overrides[state.ovDate] || {}) };
    o.note = el.value.trim().slice(0, 120);
    state.settings.overrides[state.ovDate] = o; save('overrides'); render({ anim: false });
  }
});

boot().catch((err) => {
  console.error(err);
  document.getElementById('view').innerHTML = `<div class="empty"><b>صار خطأ بالتحميل</b><span>${esc(err.message)}</span></div>`;
});

// Exposed for debugging in the browser console only.
window.__jadwali = { state, now };
void atLeast;
