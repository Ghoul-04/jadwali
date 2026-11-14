// Acceptance checks (PROMPT §7). Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildWeek, nowInfo, defaultView, nextHeat, together, heatTip, dayPlan,
  zonedNow, durationAr, time12, planText, freeWindows, minToHHMM, weekStart,
  applyShared, streamFor, plannedNotifications, zonedEpoch,
} from '../core/schedule.js';

const data = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8'));

// Defaults: morning shift, carrier on morning Heat 1 track, lab group "unknown".
const DEF = { shift: 'morning', heatTrack: 'morning', labGroup: 'unknown' };

/** Mocked clock: a Baghdad wall-clock time → the matching absolute instant (UTC+3). */
const at = (iso) => new Date(`${iso}:00+03:00`);

/** Compact day signature: [[slot, 'subject:kind', ...], ...] */
function sig(week, day) {
  return week.days[day].map((e) => [e.sessions[0].slot, ...e.sessions.map((x) => `${x.subject}:${x.kind}${x.labGroup ? ':' + x.labGroup : ''}`)]);
}

test('1. Carrier, Sunday: S1 clash [reactors, heat1], S2 projects, S3 reactors', () => {
  const w = buildWeek(data, 'carrier', DEF);
  const sun = w.days.sun;
  assert.equal(sun.length, 3);
  assert.equal(sun[0].clash, true);
  assert.deepEqual(sun[0].sessions.map((x) => x.subject).sort(), ['heat1', 'reactors']);
  assert.deepEqual(sun[0].sessions.map((x) => x.kind), ['lecture', 'lecture']);
  assert.deepEqual(sig(w, 'sun').slice(1), [['S2', 'projects:project'], ['S3', 'reactors:lecture']]);
});

test('2. Carrier, Monday: S1 free, S2 equipment, S3 units', () => {
  const w = buildWeek(data, 'carrier', DEF);
  assert.deepEqual(sig(w, 'mon'), [['S2', 'equipment:lecture'], ['S3', 'units:lecture']]);
});

test('3. Carrier, Tuesday: S1 units lab, S2 units lecture, S3 free (amendment)', () => {
  const w = buildWeek(data, 'carrier', DEF);
  assert.deepEqual(sig(w, 'tue'), [['S1', 'units:lab'], ['S2', 'units:lecture']]);
  assert.equal(w.removed.tue.length, 1);
});

test('4. Carrier, Wednesday: only S3 refining', () => {
  const w = buildWeek(data, 'carrier', DEF);
  assert.deepEqual(sig(w, 'wed'), [['S3', 'refining:lecture']]);
});

test('5. Carrier, Thursday: S1 heat1 alone; S2 clash [refining lab, heat1 lab A]; S3 clash [equipment, heat1 lab B]', () => {
  const w = buildWeek(data, 'carrier', DEF);
  assert.deepEqual(sig(w, 'thu'), [
    ['S1', 'heat1:lecture'],
    ['S2', 'refining:lab', 'heat1:lab:A'],
    ['S3', 'equipment:lecture', 'heat1:lab:B'],
  ]);
  const thu = w.days.thu;
  assert.equal(thu[0].clash, false);
  assert.equal(thu[1].clash, true);
  assert.equal(thu[2].clash, true);
  assert.ok(thu[1].sessions.find((x) => x.subject === 'heat1').groupUncertain);
});

test('6. Carrier on evening Heat 1 track: zero clashes; Tuesday and Sunday', () => {
  const w = buildWeek(data, 'carrier', { ...DEF, heatTrack: 'evening' });
  assert.equal(w.clashes.length, 0);
  assert.deepEqual(sig(w, 'tue'), [
    ['S1', 'units:lab'], ['S2', 'units:lecture'],
    ['E1', 'heat1:lab'], ['E2', 'heat1:lecture'], ['E3', 'heat1:lecture'],
  ]);
  assert.deepEqual(sig(w, 'sun')[0], ['S1', 'reactors:lecture']);
});

test('7. Standard (خلود): Sunday and Thursday', () => {
  const w = buildWeek(data, 'standard', { shift: 'morning' });
  assert.deepEqual(sig(w, 'sun'), [['S1', 'reactors:lecture'], ['S2', 'projects:project'], ['S3', 'reactors:lecture']]);
  assert.deepEqual(sig(w, 'thu'), [['S1', 'control:lab'], ['S2', 'refining:lab'], ['S3', 'equipment:lecture']]);
  assert.equal(w.clashes.length, 0);
});

test('8. سوه: both free within 08:30–14:30 = Tue 12:30–14:30 and Wed 08:30–10:30 only', () => {
  const t = together(data, { profileId: 'carrier', settings: DEF }, { profileId: 'standard', settings: { shift: 'morning' } });
  assert.deepEqual([t.range.from, t.range.to].map(minToHHMM), ['08:30', '14:30']);
  const windows = t.days.flatMap((d) => d.bothFree.map((w) => `${d.dayKey} ${minToHHMM(w.start)}-${minToHHMM(w.end)}`));
  assert.deepEqual(windows, ['tue 12:30-14:30', 'wed 08:30-10:30']);
  // They share the same morning lectures (e.g. Sunday projects).
  assert.ok(t.days[0].shared.some((x) => x.subject === 'projects'));
});

test('9. Next Heat 1 for carrier at Sat 2026-11-14 16:24 → Sun 08:30 lecture, in 16h 06m', () => {
  const n = nextHeat(data, DEF, at('2026-11-14T16:24'));
  assert.equal(n.dateStr, '2026-11-15');
  assert.equal(n.dayKey, 'sun');
  assert.equal(minToHHMM(n.entry.start), '08:30');
  const heat = n.entry.sessions.find((x) => x.subject === 'heat1');
  assert.equal(heat.kind, 'lecture');
  assert.equal(n.startsInMin, 16 * 60 + 6);
});

test('10. Thursday 15:00: default view is the weekend card + Sunday preview', () => {
  const v = defaultView(data, 'carrier', DEF, at('2026-11-19T15:00'));
  assert.equal(v.view, 'weekend');
  assert.equal(v.dateStr, '2026-11-20');
  assert.equal(v.preview, '2026-11-22');
  assert.equal(v.previewDayKey, 'sun');
});

test('11. Carrier, Monday 09:00: free now, next = equipment 10:30 in 1h 30m', () => {
  const n = nowInfo(data, 'carrier', DEF, at('2026-11-16T09:00'));
  assert.equal(n.free, true);
  assert.equal(n.current, null);
  assert.equal(n.next.dateStr, '2026-11-16');
  assert.equal(n.next.entry.sessions[0].subject, 'equipment');
  assert.equal(minToHHMM(n.next.entry.start), '10:30');
  assert.equal(n.next.startsInMin, 90);
  assert.equal(durationAr(n.next.startsInMin), 'ساعة و30 دقيقة');
});

test('12. Amendments off: Tuesday S3 reactors returns, Sunday S1 reactors disappears', () => {
  const s = { ...DEF, amendments: false };
  const c = buildWeek(data, 'carrier', s);
  assert.deepEqual(sig(c, 'tue').at(-1), ['S3', 'reactors:lecture']);
  assert.deepEqual(sig(c, 'sun')[0], ['S1', 'heat1:lecture']);
  const st = buildWeek(data, 'standard', { shift: 'morning', amendments: false });
  assert.equal(st.days.sun[0].sessions[0].slot, 'S2');
});

// ───────── extra behaviour ─────────

test('time uses Baghdad regardless of device timezone', () => {
  const z = zonedNow(new Date('2026-11-14T21:30:00Z'));
  assert.equal(z.dateStr, '2026-11-15');
  assert.equal(z.dayKey, 'sun');
  assert.equal(minToHHMM(z.minutes), '00:30');
});

test('default view: before last session → today; after → tomorrow', () => {
  assert.equal(defaultView(data, 'carrier', DEF, at('2026-11-16T13:00')).view, 'today');
  const v = defaultView(data, 'carrier', DEF, at('2026-11-16T15:00'));
  assert.equal(v.view, 'tomorrow');
  assert.equal(v.dateStr, '2026-11-17');
  // Saturday evening → tomorrow is Sunday
  assert.equal(defaultView(data, 'carrier', DEF, at('2026-11-14T20:00')).view, 'tomorrow');
});

test('clash choice dims the other side and is recurring', () => {
  const w0 = buildWeek(data, 'carrier', DEF);
  const clash = w0.days.sun[0];
  const heatKey = clash.sessions.find((x) => x.subject === 'heat1').key;
  const w = buildWeek(data, 'carrier', { ...DEF, clashChoices: { [clash.id]: heatKey } });
  const e = w.days.sun[0];
  assert.equal(e.chosen, heatKey);
  assert.equal(e.sessions.find((x) => x.subject === 'reactors').dimmed, true);
  assert.equal(e.sessions.find((x) => x.subject === 'heat1').attending, true);
});

test('lab group A keeps only lab A; both keeps both without uncertainty', () => {
  const a = buildWeek(data, 'carrier', { ...DEF, labGroup: 'A' });
  assert.deepEqual(sig(a, 'thu'), [['S1', 'heat1:lecture'], ['S2', 'refining:lab', 'heat1:lab:A'], ['S3', 'equipment:lecture']]);
  const both = buildWeek(data, 'carrier', { ...DEF, labGroup: 'both' });
  assert.equal(both.days.thu[2].sessions.find((x) => x.subject === 'heat1').groupUncertain, false);
});

test('heat tip suggests evening track when morning has clashes', () => {
  const tip = heatTip(data, DEF);
  assert.equal(tip.suggest, true);
  assert.equal(tip.otherClashes, 0);
  assert.deepEqual(tip.otherWindows.map((w) => `${w.day} ${minToHHMM(w.start)}-${minToHHMM(w.end)}`), ['tue 14:30-19:30']);
  assert.equal(heatTip(data, { ...DEF, heatTrack: 'evening' }).suggest, false);
});

test('manual overrides: holiday and cancelled session on a date only', () => {
  const s = { ...DEF, overrides: { '2026-11-16': { cancelled: ['stage4_morning:mon:S2:equipment:lecture'], note: 'الدكتورة مسافرة' } } };
  const p = dayPlan(data, 'carrier', s, '2026-11-16');
  assert.equal(p.note, 'الدكتورة مسافرة');
  assert.equal(p.entries.find((e) => e.sessions[0].subject === 'equipment').active, false);
  const n = nowInfo(data, 'carrier', s, at('2026-11-16T09:00'));
  assert.equal(n.next.entry.sessions[0].subject, 'units');
  const other = dayPlan(data, 'carrier', s, '2026-11-23');
  assert.equal(other.entries.find((e) => e.sessions[0].subject === 'equipment').active, true);
  const h = dayPlan(data, 'carrier', { ...DEF, overrides: { '2026-11-16': { holiday: true } } }, '2026-11-16');
  assert.equal(h.holiday, true);
});

test('shared edits: update, remove, add and subject rename (both profiles see them)', () => {
  const shared = {
    subjects: { units: { name: 'الوحدات الصناعية 2', nick: 'وحدات' } },
    edits: [
      { id: 'a1', stream: 'stage4_morning', op: 'update', key: 'stage4_morning:mon:S2:equipment:lecture', set: { slot: 'S1', room: 'قاعة 7' } },
      { id: 'a2', stream: 'stage4_morning', op: 'remove', key: 'stage4_morning:wed:S3:refining:lecture' },
      { id: 'a3', stream: 'stage4_morning', op: 'add', session: { day: 'wed', slot: 'S1', subject: 'units', kind: 'lecture', instructor: 'د. علاء' } },
    ],
  };
  const d2 = applyShared(data, shared);
  assert.equal(data.subjects.units.name, 'الوحدات الصناعية'); // original untouched
  for (const p of ['carrier', 'standard']) {
    const w = buildWeek(d2, p, DEF);
    const eq = w.days.mon.flatMap((e) => e.sessions).find((x) => x.subject === 'equipment');
    assert.equal(eq.slot, 'S1');
    assert.equal(eq.location, 'قاعة 7');
    assert.equal(eq.key, 'stage4_morning:mon:S2:equipment:lecture'); // key kept → choices/overrides survive
    assert.ok(!w.days.wed.some((e) => e.sessions.some((x) => x.subject === 'refining')));
    assert.ok(w.days.wed.some((e) => e.sessions[0].subject === 'units' && e.sessions[0].slot === 'S1'));
  }
  assert.equal(d2.subjects.units.name, 'الوحدات الصناعية 2');
  assert.equal(streamFor({ subject: 'heat1', slot: 'S1' }, DEF), 'heat1_morning');
  assert.equal(streamFor({ subject: 'units', slot: 'E1' }, DEF), 'stage4_evening');
});

test('notifications: 8 PM summary of tomorrow + 15 min before each lecture', () => {
  const sat = plannedNotifications(data, 'carrier', DEF, { nightly: '20', lead: 15 }, at('2026-11-14T19:00'));
  assert.deepEqual(sat.map((n) => n.kind), ['summary']);
  assert.equal(sat[0].at, at('2026-11-14T20:00').getTime());
  assert.equal(sat[0].plan.dateStr, '2026-11-15');
  const mon = plannedNotifications(data, 'carrier', DEF, { nightly: '20', lead: 15 }, at('2026-11-16T07:00'));
  assert.deepEqual(mon.filter((n) => n.kind === 'lead').map((n) => n.at), [at('2026-11-16T10:15').getTime(), at('2026-11-16T12:15').getTime()]);
  const thu = plannedNotifications(data, 'carrier', DEF, { nightly: '20', lead: 0 }, at('2026-11-19T07:00'));
  assert.equal(thu.length, 0); // Friday tomorrow → no summary, lead off
  const morning = plannedNotifications(data, 'standard', DEF, { nightly: '7', lead: 0 }, at('2026-11-15T06:00'));
  assert.equal(morning[0].when, 'today');
  assert.equal(zonedEpoch('2026-11-15', 8 * 60 + 30), Date.parse('2026-11-15T05:30:00Z'));
});

test('helpers: 12h time, Arabic durations, free windows, week start, share text', () => {
  assert.deepEqual(time12(14 * 60 + 30), { text: '2:30', ampm: 'م' });
  assert.deepEqual(time12(8 * 60 + 30), { text: '8:30', ampm: 'ص' });
  assert.deepEqual(time12(12 * 60 + 30), { text: '12:30', ampm: 'م' });
  assert.equal(durationAr(80), 'ساعة و20 دقيقة');
  assert.equal(durationAr(120), 'ساعتين');
  assert.equal(durationAr(966), '16 ساعة و6 دقايق');
  assert.deepEqual(freeWindows([[600, 700]], 500, 800), [{ start: 500, end: 600 }, { start: 700, end: 800 }]);
  assert.equal(weekStart('2026-11-20'), '2026-11-22');
  assert.equal(weekStart('2026-11-18'), '2026-11-15');
  const txt = planText(data, dayPlan(data, 'carrier', DEF, '2026-11-15'));
  assert.match(txt, /تصادم/);
});
