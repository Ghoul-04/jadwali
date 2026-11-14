// app/main.js — bootstrap, state, rendering of all screens.
import * as S from '../core/schedule.js';
import { tg, inTelegram, atLeast } from './telegram.js';
import { storage, pruneOverrides } from './storage.js';
import { voice, dateLabel, greetingFor, countSessions, countClashes } from './i18n.js';
import { icons } from './icons.js';
import * as U from './ui.js';

const { esc, t12, range12, tile } = U;
const BOT_LINK = 'https://t.me/ShnoBajer_bot';

// ───────── clock (supports ?now=YYYY-MM-DDTHH:MM for testing; ticks from there) ─────────
const params = new URLSearchParams(location.search);
const mockParam = params.get('now');
const mockStart = mockParam ? Date.parse(mockParam.length <= 16 ? `${mockParam}:00+03:00` : mockParam) : null;
const bootReal = Date.now();
const now = () => new Date(mockStart ? mockStart + (Date.now() - bootReal) : Date.now());

// ───────── state ─────────
const state = {
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
  return { ...S.defaultSettings(), ...state.partner, amendments: state.settings.amendments, clashChoices: {}, overrides: {} };
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
  view.innerHTML = state.sub === 'settings' ? viewSettingsPage() : VIEWS[state.tab]();
  view.querySelectorAll('.rise').forEach((el, k) => el.style.setProperty('--i', k));
  if (anim) { view.classList.remove('enter'); void view.offsetWidth; view.classList.add('enter'); }
  syncBack();
  renderSheet();
  tick(true);
}

function renderTop() {
  const z = Z();
  const meName = prof(state.profile).name;
  const tgName = tg.user?.first_name;
  const otherName = prof(other(state.profile)).name;
  const g = prof(state.profile).gender;
  $('#top').innerHTML = `
    <div class="top-row">
      <div class="hello">
        <span class="hello-k">${greetingFor(z.minutes, g)}${state.sub ? '' : ''}</span>
        <h1 class="hello-n">${esc(tgName || meName)}</h1>
        <span class="hello-d">${dateLabel(z.dateStr)}</span>
      </div>
      <div class="top-actions">
        ${state.sub ? '' : `<button class="chip-btn ${state.peek ? 'on' : ''}" data-act="peek" aria-pressed="${state.peek}">${icons.eye()}<span>${state.peek ? 'جدولي' : `جدول ${esc(otherName)}`}</span></button>`}
        <button class="icon-btn" data-act="${state.sub ? 'closeSub' : 'openSettings'}" aria-label="${state.sub ? 'رجوع' : 'الإعدادات'}">${state.sub ? icons.close() : icons.gear()}</button>
      </div>
    </div>
    ${state.peek && !state.sub ? `<div class="peek-bar">${icons.eye()}<span>دتشوف جدول <b>${esc(otherName)}</b> · ما يتغير اختيارك</span><button class="link" data-act="peek">رجوع لجدولي</button></div>` : ''}`;
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
  if (state.sheet) tg.back.show(() => closeSheet());
  else if (state.sub) tg.back.show(() => act.closeSub());
  else if (state.peek) tg.back.show(() => act.peek());
  else tg.back.hide();
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
    return `${hero}${planExtras(n.plan)}${rest}`;
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

    const tip = S.heatTip(d, s, id);
    const ow = tip.otherWindows.map((w) => `${S.DAY_NAMES[w.day]} ${t12(w.start)}–${t12(w.end)}`).join('، ');
    const tipCard = tip.suggest ? `<section class="tip rise">
        <div class="tip-ico">${icons.sparkle()}</div>
        <div><b>فكرة تخلص من ${countClashes(tip.currentClashes)}</b>
        <p>إذا تحضر هيت 1 ويه ${tip.other === 'evening' ? 'المسائي' : 'الصباحي'} (${ow}) تنحل كل التصادمات، <u>إذا القسم يسمح</u>.</p>
        ${readOnly() ? '' : `<button class="btn ghost sm" data-act="set" data-name="heatTrack" data-value="${tip.other}">جرّب ويه ${tip.other === 'evening' ? 'المسائي' : 'الصباحي'}</button>`}</div>
      </section>` : tip.currentClashes === 0 ? `<p class="ok-line rise">${icons.check()}<span>ماكو ولا تصادم ويه هالاختيار</span></p>` : '';

    const controls = readOnly() ? '' : `<section class="card controls rise">
      <h4>هيت 1 وياهم منو؟</h4>
      ${U.segmented('heatTrack', s.heatTrack, [['morning', 'ويه الصباحي'], ['evening', 'ويه المسائي']])}
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
      <div class="day-chips rise">${chips}</div>
      <div class="tg-head rise"><span></span><b class="who-a">${esc(nA)}</b><b class="who-b">${esc(nB)}</b></div>
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
  const uid = tg.user?.id;

  return `<header class="page-h rise"><h2>الإعدادات</h2><span>تنحفظ ب${storage.backend() === 'cloud' ? 'تيليگرام (CloudStorage)' : 'هالمتصفح'}</span></header>

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

  <section class="card set rise" style="--i:5">
    <h4>${icons.together()} جدول ${esc(prof(you).name)}</h4>
    <p class="hint">حتى تطلع "سوه" و"شوف جدول ${esc(prof(you).name)}" صح.</p>
    ${U.segmented('shift', state.partner.shift, [['morning', 'صباحي'], ['evening', 'مسائي']], { act: 'setPartner' })}
    ${prof(you).addHeat1 ? U.segmented('heatTrack', state.partner.heatTrack, [['morning', 'هيت ويه الصباحي'], ['evening', 'هيت ويه المسائي']], { act: 'setPartner' }) : ''}
  </section>

  <section class="card set rise" style="--i:6">
    <h4>المظهر</h4>
    ${U.segmented('theme', state.themePref, [['auto', inTelegram ? 'مثل تيليگرام' : 'تلقائي'], ['light', 'فاتح'], ['dark', 'غامق']], { act: 'setTheme' })}
  </section>

  <section class="card set rise" style="--i:7">
    <h4>رقمك بتيليگرام (للتذكير الليلي)</h4>
    ${uid ? `<div class="id-row"><code dir="ltr">${uid}</code><button class="btn ghost sm" data-act="copyId" data-id="${uid}">${icons.copy()}<span>نسخ</span></button></div>`
      : '<p class="hint">افتح التطبيق من داخل تيليگرام حتى يطلع رقمك هنا.</p>'}
  </section>

  <p class="foot rise">${esc(d.department)} · ${esc(d.semester)}<br>شنو باجر · جدولي</p>`;
}

function nextWorkday(dateStr) {
  let ds = S.addDays(dateStr, 1);
  for (let i = 0; i < 7 && !state.data.workdays.includes(S.dayKeyOf(ds)); i++) ds = S.addDays(ds, 1);
  return ds;
}

// ───────── detail sheet ─────────
function renderSheet() {
  const root = $('#sheet-root');
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
  const card = (id, sym, line) => `<button class="pick s-${id === 'carrier' ? 'heat1' : 'reactors'}" data-act="pick" data-id="${id}">
      <div class="el el--xl ${id === 'carrier' ? 's-heat1' : 's-reactors'}"><span class="el-n">${id === 'carrier' ? 4 : 4}</span><span class="el-sym">${sym}</span><span class="el-nick">${esc(prof(id).name)}</span></div>
      <b>${esc(prof(id).name)}</b><span>${line}</span></button>`;
  $('#picker-root').innerHTML = `<div class="picker">
    <div class="picker-hex" aria-hidden="true"></div>
    <p class="picker-k">شنو باجر · جدولي</p>
    <h1>منو أنت؟</h1>
    <p class="picker-sub">${tg.user?.first_name ? `هلا ${esc(tg.user.first_name)}! ` : ''}اختار مرة وحدة، وتگدر تغيرها من الإعدادات.</p>
    <div class="pick-row">
      ${card('carrier', 'Mo', 'الرابع + هيت 1 محمول')}
      ${card('standard', 'Kh', 'الرابع · جدول كامل')}
    </div>
    <p class="foot">${esc(d.department)}</p>
  </div>`;
}

// ───────── actions ─────────
const act = {
  pick(el) {
    state.profile = el.dataset.id; save('profile');
    state.tab = smartTab();
    tg.haptic('success');
    render();
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
  },
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
    const who = state.peek ? prof(viewId()).name : (tg.user?.first_name || prof(state.profile).name);
    const text = S.planText(state.data, plan, { title: `📅 جدول ${who} · ${el.dataset.title} (${dateLabel(plan.dateStr)})` });
    tg.openLink(`https://t.me/share/url?url=${encodeURIComponent(BOT_LINK)}&text=${encodeURIComponent(text)}`);
  },
  async copyId(el) {
    const id = el.dataset.id;
    try { await navigator.clipboard.writeText(id); } catch {
      const ta = document.createElement('textarea'); ta.value = id; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {} ta.remove();
    }
    tg.haptic('success');
    el.querySelector('span').textContent = 'انسخ ✓';
  },
};

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
  state.data = await res.json();

  applyStored(storage.loadLocal());
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
    if (JSON.stringify([state.profile, state.settings, state.partner, state.themePref]) !== before) {
      applyTheme();
      if (!state.tab || !before.includes(state.profile)) state.tab = smartTab();
      render({ anim: false });
    }
  } else if (cloud && state.profile) {
    // First run inside Telegram with local data only → push it up.
    ['profile', 'settings', 'clash', 'overrides', 'partner', 'theme'].forEach(save);
  }

  tg.on('themeChanged', () => { applyTheme(); render({ anim: false }); });
  tg.on('safeAreaChanged', applyInsets);
  tg.on('contentSafeAreaChanged', applyInsets);
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (state.themePref === 'auto') { applyTheme(); render({ anim: false }); } });

  setInterval(tick, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && state.profile) render({ anim: false }); });
}

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const fn = act[el.dataset.act];
  if (fn) { ev.preventDefault(); fn(el); }
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.sheet) closeSheet();
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('article[data-act]')) { ev.preventDefault(); ev.target.click(); }
});
document.addEventListener('change', (ev) => {
  const el = ev.target;
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
