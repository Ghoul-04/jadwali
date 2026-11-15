// core/schedule.js — pure, dependency-free schedule logic.
// Runs unchanged in the browser and in Node (ES module). No DOM, no I/O.
//
// Vocabulary
//   data      : parsed data/schedule.json
//   settings  : per-user settings (see defaultSettings)
//   session   : one class meeting, normalised (start/end in minutes since 00:00 Baghdad)
//   entry     : one row in a day — a single session, or a clash of overlapping sessions
//   dateStr   : civil date in Baghdad, 'YYYY-MM-DD'

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const DAY_NAMES = {
  sun: 'الأحد', mon: 'الاثنين', tue: 'الثلاثاء', wed: 'الأربعاء',
  thu: 'الخميس', fri: 'الجمعة', sat: 'السبت',
};
export const KIND_NAMES = { lecture: 'محاضرة', lab: 'مختبر', project: 'مشروع' };
export const LAB_LOCATION = 'مختبر';

export function defaultSettings() {
  return {
    shift: 'morning',        // 'morning' | 'evening'
    heatTrack: 'morning',    // carrier only: 'morning' | 'evening'
    labGroup: 'unknown',     // carrier, morning track: 'A' | 'B' | 'both' | 'unknown'
    amendments: true,        // apply department amendments
    clashChoices: {},        // { [clashId]: sessionKey } — recurring weekly
    overrides: {},           // { [dateStr]: { holiday?: bool, cancelled?: [sessionKey], note?: string } }
  };
}

export function withDefaults(settings) {
  const d = defaultSettings();
  const s = { ...d, ...(settings || {}) };
  s.clashChoices = { ...(settings?.clashChoices || {}) };
  s.overrides = { ...(settings?.overrides || {}) };
  return s;
}

// ───────────────────────── time helpers ─────────────────────────

export function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function minToHHMM(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 12-hour display like the printed timetable: { text: '2:30', ampm: 'م' }. */
export function time12(min) {
  const h = Math.floor(min / 60) % 24, m = min % 60;
  const h12 = h % 12 || 12;
  return { text: `${h12}:${String(m).padStart(2, '0')}`, ampm: h < 12 ? 'ص' : 'م' };
}

export function time12Str(min) {
  const t = time12(min);
  return `${t.text} ${t.ampm}`;
}

const fmtCache = new Map();
function zonedFormatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }));
  }
  return fmtCache.get(tz);
}

/** Wall-clock parts of `now` in `tz` (default Asia/Baghdad), independent of device timezone. */
export function zonedNow(now = new Date(), tz = 'Asia/Baghdad') {
  const parts = {};
  for (const p of zonedFormatter(tz).formatToParts(now)) parts[p.type] = p.value;
  const y = +parts.year, mo = +parts.month, d = +parts.day;
  const h = +parts.hour % 24, mi = +parts.minute, s = +parts.second;
  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;
  return { dateStr, y, mo, d, minutes: h * 60 + mi, seconds: s, dayKey: dayKeyOf(dateStr) };
}

export function dayKeyOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return DAY_KEYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Sunday of the working week that `dateStr` belongs to (Fri/Sat roll forward to the coming week). */
export function weekStart(dateStr) {
  const idx = DAY_KEYS.indexOf(dayKeyOf(dateStr));
  return idx >= 5 ? addDays(dateStr, 7 - idx) : addDays(dateStr, -idx);
}

export function isWorkday(data, dayKey) {
  return data.workdays.includes(dayKey);
}

/** Iraqi Arabic duration: "ساعة و20 دقيقة", "ساعتين", "5 دقايق", "يومين و3 ساعات". */
export function durationAr(totalMin) {
  totalMin = Math.max(0, Math.round(totalMin));
  if (totalMin < 1) return 'هسه';
  const days = Math.floor(totalMin / 1440);
  const hours = Math.floor((totalMin % 1440) / 60);
  const mins = totalMin % 60;
  const unit = (n, one, two, few, many) =>
    n === 1 ? one : n === 2 ? two : n <= 10 ? `${n} ${few}` : `${n} ${many}`;
  const parts = [];
  if (days) parts.push(unit(days, 'يوم', 'يومين', 'أيام', 'يوم'));
  if (hours) parts.push(unit(hours, 'ساعة', 'ساعتين', 'ساعات', 'ساعة'));
  if (mins && !days) parts.push(unit(mins, 'دقيقة', 'دقيقتين', 'دقايق', 'دقيقة'));
  return parts.join(' و');
}

// ───────────────────────── building a week ─────────────────────────

function normalise(data, raw, streamId, extra = {}) {
  const stream = data.streams[streamId];
  const [a, b] = data.slots[raw.slot];
  const start = toMin(a), end = toMin(b);
  const key = raw.id || `${streamId}:${raw.day}:${raw.slot}:${raw.subject}:${raw.kind}${raw.labGroup ? ':' + raw.labGroup : ''}`;
  return {
    key,
    stream: streamId,
    day: raw.day,
    slot: raw.slot,
    start, end,
    subject: raw.subject,
    kind: raw.kind,
    instructor: raw.instructor ?? null,
    location: raw.room || (raw.kind === 'lab' ? LAB_LOCATION : stream.room),
    room: raw.room || stream.room,
    roomOverride: raw.room || null,
    fromStage: stream.fromStage || null,
    labGroup: raw.labGroup || null,
    ...extra,
  };
}

/** Sessions of one stream after (optionally) applying its department amendments. */
export function streamSessions(data, streamId, { amendments = true } = {}) {
  const stream = data.streams[streamId];
  if (!stream) throw new Error(`Unknown stream ${streamId}`);
  let list = stream.sessions.map((s) => normalise(data, s, streamId));
  const removed = [];
  if (amendments) {
    for (const a of stream.amendments || []) {
      if (a.op === 'remove') {
        const hit = list.find((s) => s.key === a.id);
        if (hit) removed.push({ ...hit, note: a.note || null });
        list = list.filter((s) => s.key !== a.id);
      } else if (a.op === 'add') {
        const s = a.session;
        list.push(normalise(data, { ...s, id: s.id || `amend:${streamId}:${s.day}:${s.slot}:${s.subject}` }, streamId, {
          amended: true, note: a.note || null,
        }));
      }
    }
  }
  // Edits made by the users from the app (synced through the bot). Always applied.
  for (const e of stream.userEdits || []) {
    if (e.op === 'remove') {
      const hit = list.find((s) => s.key === e.key);
      if (hit) removed.push({ ...hit, note: e.note || 'تعديلكم' });
      list = list.filter((s) => s.key !== e.key);
    } else if (e.op === 'add' && e.session && data.slots[e.session.slot] && data.subjects[e.session.subject]) {
      list.push(normalise(data, { ...e.session, id: `edit:${e.id}` }, streamId, { edited: true, editId: e.id }));
    } else if (e.op === 'update') {
      const i = list.findIndex((s) => s.key === e.key);
      if (i < 0) continue;
      const x = list[i];
      const raw = {
        day: x.day, slot: x.slot, subject: x.subject, kind: x.kind, instructor: x.instructor,
        room: x.roomOverride, labGroup: x.labGroup, ...pickDefined(e.set), id: x.key,
      };
      if (!data.slots[raw.slot] || !data.subjects[raw.subject]) continue;
      list[i] = normalise(data, raw, streamId, { edited: true, editId: e.id, amended: x.amended, note: x.note });
    }
  }
  return { sessions: list, removed };
}

function pickDefined(o = {}) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v === '' ? null : v;
  return r;
}

/**
 * Merge the shared (synced) state into a copy of the data:
 *   shared = { subjects: { id: { name?, nick? } }, edits: [{ id, stream, op: 'add'|'remove'|'update', key?, session?, set? }] }
 */
export function applyShared(data, shared) {
  const d = JSON.parse(JSON.stringify(data));
  if (!shared) return d;
  for (const [id, s] of Object.entries(shared.subjects || {})) {
    if (!d.subjects[id] || !s) continue;
    if (typeof s.name === 'string' && s.name.trim()) d.subjects[id].name = s.name.trim().slice(0, 40);
    if (typeof s.nick === 'string' && s.nick.trim()) d.subjects[id].nick = s.nick.trim().slice(0, 16);
  }
  for (const e of shared.edits || []) {
    const st = d.streams[e?.stream];
    if (st) (st.userEdits ||= []).push(e);
  }
  return d;
}

/** Which stream an added/edited session belongs to. */
export function streamFor(session, settings) {
  if (session.subject === 'heat1') return withDefaults(settings).heatTrack === 'evening' ? 'heat1_evening' : 'heat1_morning';
  return String(session.slot).startsWith('E') ? 'stage4_evening' : 'stage4_morning';
}

function profileOf(data, profileId) {
  const p = data.profiles?.[profileId];
  if (!p) throw new Error(`Unknown profile ${profileId}`);
  return p;
}

/** All recurring sessions for a profile with given settings (no date-specific overrides). */
export function profileSessions(data, profileId, settings) {
  const s = withDefaults(settings);
  const p = profileOf(data, profileId);
  const baseId = s.shift === 'evening' ? 'stage4_evening' : 'stage4_morning';
  const base = streamSessions(data, baseId, { amendments: s.amendments });
  let sessions = base.sessions.filter((x) => !p.dropSubjects.includes(x.subject));
  const removed = base.removed.filter((x) => !p.dropSubjects.includes(x.subject));

  if (p.addHeat1) {
    const heatId = s.heatTrack === 'evening' ? 'heat1_evening' : 'heat1_morning';
    let heat = streamSessions(data, heatId, { amendments: s.amendments }).sessions;
    const g = s.labGroup;
    if (g === 'A' || g === 'B') {
      heat = heat.filter((x) => !x.labGroup || x.labGroup === g);
    } else {
      const uncertain = g !== 'both';
      heat = heat.map((x) => (x.labGroup ? { ...x, groupUncertain: uncertain } : x));
    }
    sessions = sessions.concat(heat);
  }
  sessions.sort((a, b) => DAY_KEYS.indexOf(a.day) - DAY_KEYS.indexOf(b.day) || a.start - b.start);
  return { sessions, removed };
}

/** Group a day's sessions into entries; overlapping sessions become one clash entry. */
export function groupEntries(daySessions, clashChoices = {}) {
  const sorted = [...daySessions].sort((a, b) => a.start - b.start || a.end - b.end);
  const groups = [];
  for (const s of sorted) {
    const g = groups[groups.length - 1];
    if (g && s.start < g.end) {
      g.sessions.push(s);
      g.end = Math.max(g.end, s.end);
    } else {
      groups.push({ start: s.start, end: s.end, sessions: [s] });
    }
  }
  return groups.map((g) => {
    const clash = g.sessions.length > 1;
    const id = clash ? clashId(g.sessions[0].day, g.start) : null;
    let chosen = clash ? clashChoices[id] || null : null;
    if (chosen && !g.sessions.some((x) => x.key === chosen)) chosen = null;
    const sessions = g.sessions.map((x) => ({
      ...x,
      attending: !clash || !chosen || x.key === chosen,
      dimmed: clash && !!chosen && x.key !== chosen,
    }));
    return { id: id || sessions[0].key, clash, chosen, start: g.start, end: g.end, sessions };
  });
}

export function clashId(dayKey, startMin) {
  return `${dayKey}@${minToHHMM(startMin)}`;
}

/** Recurring week for a profile: { days: {sun:[entries]...}, clashes: [entries], removed: {day:[sessions]} } */
export function buildWeek(data, profileId, settings) {
  const s = withDefaults(settings);
  const { sessions, removed } = profileSessions(data, profileId, s);
  const days = {}, removedByDay = {};
  const clashes = [];
  for (const d of DAY_KEYS) {
    days[d] = groupEntries(sessions.filter((x) => x.day === d), s.clashChoices);
    removedByDay[d] = removed.filter((x) => x.day === d);
    clashes.push(...days[d].filter((e) => e.clash));
  }
  return { profileId, days, clashes, removed: removedByDay };
}

/** Entries for a concrete date, with that date's manual overrides applied. */
export function dayPlan(data, profileId, settings, dateStr, week) {
  const s = withDefaults(settings);
  const w = week || buildWeek(data, profileId, s);
  const dayKey = dayKeyOf(dateStr);
  const ov = s.overrides[dateStr] || {};
  const cancelled = new Set(ov.cancelled || []);
  const holiday = !!ov.holiday;
  const entries = (w.days[dayKey] || []).map((e) => {
    const sessions = e.sessions.map((x) => ({
      ...x,
      cancelled: holiday || cancelled.has(x.key),
    }));
    const live = sessions.filter((x) => !x.cancelled && x.attending);
    return { ...e, sessions, active: live.length > 0 };
  });
  return {
    dateStr, dayKey,
    workday: isWorkday(data, dayKey),
    holiday,
    note: ov.note || '',
    entries,
    removed: w.removed[dayKey] || [],
  };
}

/** Active (attended, not cancelled) entries of a plan. */
export function activeEntries(plan) {
  return plan.holiday ? [] : plan.entries.filter((e) => e.active);
}

export function daySummary(plan) {
  const act = activeEntries(plan);
  if (!act.length) return null;
  return {
    first: act[0].start,
    last: act[act.length - 1].end,
    count: act.length, // a clash counts once (one time block)
    clashes: act.filter((e) => e.clash && !e.chosen).length,
  };
}

// ───────────────────────── now / next ─────────────────────────

/** Find the next active entry starting after `now` (looks ahead up to 21 days). */
export function nextEntry(data, profileId, settings, now = new Date(), filter = () => true) {
  const z = zonedNow(now, data.timezone);
  const week = buildWeek(data, profileId, settings);
  const nowSec = z.minutes * 60 + z.seconds;
  for (let i = 0; i < 21; i++) {
    const dateStr = addDays(z.dateStr, i);
    const plan = dayPlan(data, profileId, settings, dateStr, week);
    for (const e of activeEntries(plan)) {
      if (!filter(e)) continue;
      const startSec = i * 86400 + e.start * 60;
      if (startSec > nowSec) {
        return { entry: e, dateStr, dayKey: plan.dayKey, dayOffset: i, startsInSec: startSec - nowSec, startsInMin: Math.round((startSec - nowSec) / 60) };
      }
    }
  }
  return null;
}

/** Snapshot of "now": current entry (if any), countdown, next entry, rest of today. */
export function nowInfo(data, profileId, settings, now = new Date()) {
  const z = zonedNow(now, data.timezone);
  const plan = dayPlan(data, profileId, settings, z.dateStr);
  const act = activeEntries(plan);
  const nowSec = z.minutes * 60 + z.seconds;
  const current = act.find((e) => e.start * 60 <= nowSec && nowSec < e.end * 60) || null;
  const next = nextEntry(data, profileId, settings, now);
  const rest = act.filter((e) => e.start * 60 > nowSec);
  const out = { zoned: z, plan, current, next, rest, free: !current };
  if (current) {
    out.elapsedSec = nowSec - current.start * 60;
    out.remainingSec = current.end * 60 - nowSec;
    out.progress = out.elapsedSec / ((current.end - current.start) * 60);
  }
  return out;
}

/**
 * Smart default view.
 *  - before the last active entry of today ends → 'today'
 *  - otherwise → 'tomorrow', unless tomorrow is not a workday (or a holiday) → 'weekend'
 *    with `preview` = next working date.
 */
export function defaultView(data, profileId, settings, now = new Date()) {
  const z = zonedNow(now, data.timezone);
  const today = dayPlan(data, profileId, settings, z.dateStr);
  const act = activeEntries(today);
  const lastEnd = act.length ? act[act.length - 1].end : null;
  if (today.workday && lastEnd !== null && z.minutes < lastEnd) {
    return { view: 'today', dateStr: z.dateStr };
  }
  const tomorrow = addDays(z.dateStr, 1);
  const tPlan = dayPlan(data, profileId, settings, tomorrow);
  if (tPlan.workday && !tPlan.holiday) return { view: 'tomorrow', dateStr: tomorrow };
  let d = tomorrow;
  for (let i = 0; i < 14; i++) {
    d = addDays(d, 1);
    const p = dayPlan(data, profileId, settings, d);
    if (p.workday && !p.holiday) break;
  }
  return { view: 'weekend', dateStr: tomorrow, preview: d, previewDayKey: dayKeyOf(d) };
}

// ───────────────────────── Heat 1 ─────────────────────────

export function nextHeat(data, settings, now = new Date(), profileId = 'carrier') {
  return nextEntry(data, profileId, settings, now, (e) => e.sessions.some((x) => x.subject === 'heat1' && x.attending));
}

/** Clash counts for both Heat 1 tracks + whether to suggest switching. */
export function heatTip(data, settings, profileId = 'carrier') {
  const s = withDefaults(settings);
  const count = (track) => buildWeek(data, profileId, { ...s, heatTrack: track, clashChoices: {} }).clashes.length;
  const current = s.heatTrack;
  const other = current === 'morning' ? 'evening' : 'morning';
  const cur = count(current), oth = count(other);
  const otherSessions = streamSessions(data, other === 'evening' ? 'heat1_evening' : 'heat1_morning').sessions;
  const byDay = {};
  for (const x of otherSessions) {
    (byDay[x.day] ||= { start: x.start, end: x.end });
    byDay[x.day].start = Math.min(byDay[x.day].start, x.start);
    byDay[x.day].end = Math.max(byDay[x.day].end, x.end);
  }
  return {
    current, other,
    currentClashes: cur, otherClashes: oth,
    suggest: cur > 0 && oth === 0,
    otherWindows: Object.entries(byDay).map(([day, w]) => ({ day, ...w })),
  };
}

// ───────────────────────── together ─────────────────────────

/** Subtract busy intervals from [from, to). Intervals in minutes. */
export function freeWindows(busy, from, to) {
  const sorted = busy.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out = [];
  let cur = from;
  for (const [a, b] of sorted) {
    if (a > cur) out.push({ start: cur, end: a });
    cur = Math.max(cur, b);
  }
  if (cur < to) out.push({ start: cur, end: to });
  return out;
}

function busyIntervals(plan) {
  const out = [];
  for (const e of activeEntries(plan)) {
    for (const x of e.sessions) if (x.attending && !x.cancelled) out.push([x.start, x.end]);
  }
  return out;
}

/** Campus window for comparing two users: spans the slots of the shifts in use. */
export function campusRange(data, shiftA, shiftB) {
  const shifts = new Set([shiftA || 'morning', shiftB || 'morning']);
  const slotIds = Object.keys(data.slots).filter((id) => (id.startsWith('S') && shifts.has('morning')) || (id.startsWith('E') && shifts.has('evening')));
  const starts = slotIds.map((id) => toMin(data.slots[id][0]));
  const ends = slotIds.map((id) => toMin(data.slots[id][1]));
  return { from: Math.min(...starts), to: Math.max(...ends) };
}

/**
 * Compare two users day by day.
 * a, b: { profileId, settings }. Optional dateStrs to apply per-date overrides.
 * Returns { range, days: [{ dayKey, dateStr, bothFree:[{start,end}], shared:[session], aBusy, bBusy }] }
 */
export function together(data, a, b, { dates } = {}) {
  const sa = withDefaults(a.settings), sb = withDefaults(b.settings);
  const range = campusRange(data, sa.shift, sb.shift);
  const wa = buildWeek(data, a.profileId, sa), wb = buildWeek(data, b.profileId, sb);
  const days = data.workdays.map((dayKey, i) => {
    const dateStr = dates?.[i] ?? null;
    const pa = dateStr ? dayPlan(data, a.profileId, sa, dateStr, wa) : dayPlan(data, a.profileId, { ...sa, overrides: {} }, fakeDate(dayKey), wa);
    const pb = dateStr ? dayPlan(data, b.profileId, sb, dateStr, wb) : dayPlan(data, b.profileId, { ...sb, overrides: {} }, fakeDate(dayKey), wb);
    const aBusy = busyIntervals(pa), bBusy = busyIntervals(pb);
    const bothFree = freeWindows([...aBusy, ...bBusy], range.from, range.to);
    const attended = (p) => activeEntries(p).flatMap((e) => e.sessions.filter((x) => x.attending && !x.cancelled));
    const bKeys = new Set(attended(pb).map((x) => sharedKey(x)));
    const shared = attended(pa).filter((x) => bKeys.has(sharedKey(x)));
    return { dayKey, dateStr, bothFree, shared, a: pa, b: pb, aBusy, bBusy };
  });
  return { range, days };
}

function sharedKey(x) {
  return `${x.stream}|${x.day}|${x.start}|${x.subject}|${x.kind}`;
}

// A reference week (2026-11-15 is a Sunday) for date-less recurring computations.
function fakeDate(dayKey) {
  return addDays('2026-11-15', DAY_KEYS.indexOf(dayKey));
}

// ───────────────────────── epochs ─────────────────────────

/** Wall-clock time in `tz` → epoch ms (offset derived from Intl, so it works on any machine). */
export function zonedEpoch(dateStr, minutes, tz = 'Asia/Baghdad') {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, minutes);
  const z = zonedNow(new Date(guess), tz);
  const asUTC = Date.UTC(z.y, z.mo - 1, z.d, 0, z.minutes, z.seconds);
  return guess - (asUTC - guess);
}

// ───────────────────────── sharing / text ─────────────────────────

export function sessionLabel(data, x) {
  const sub = data.subjects[x.subject];
  return `${sub.nick} · ${KIND_NAMES[x.kind] || x.kind}`;
}

/** Plain-text day summary (used by the share button). */
export function planText(data, plan, { title } = {}) {
  const lines = [];
  lines.push(title || `جدول ${DAY_NAMES[plan.dayKey]} ${plan.dateStr}`);
  if (plan.holiday) { lines.push('🎉 عطلة'); return lines.join('\n'); }
  const act = activeEntries(plan);
  if (!act.length) { lines.push('ماكو دوام 😌'); return lines.join('\n'); }
  for (const e of act) {
    const t = `${time12Str(e.start)} – ${time12Str(e.end)}`;
    const live = e.sessions.filter((x) => x.attending && !x.cancelled);
    if (live.length > 1) {
      lines.push(`⚠️ ${t} تصادم: ${live.map((x) => sessionLabel(data, x)).join(' ✕ ')}`);
    } else {
      const x = live[0];
      lines.push(`• ${t} — ${data.subjects[x.subject].name} (${KIND_NAMES[x.kind]})${x.location ? ' · ' + x.location : ''}`);
    }
  }
  if (plan.note) lines.push(`📝 ${plan.note}`);
  return lines.join('\n');
}
