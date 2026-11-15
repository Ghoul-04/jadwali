// Midterm acceptance checks (Update 01, Part 2). Mocked clock in Baghdad time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultView } from '../core/schedule.js';
import {
  examsFor, examTimeline, examBrief, focusSuggestion, celebrationDue, examTimeText, luckLine, examNick,
} from '../core/exams.js';

const data = JSON.parse(readFileSync(new URL('../data/schedule.json', import.meta.url), 'utf8'));
const at = (iso) => new Date(`${iso}:00+03:00`);
const ids = (list) => list.map((e) => e.subject);

test('1. محمد has 4 exams (no control); خلود has all 5 incl. control Thu 19 Nov 9:00', () => {
  assert.deepEqual(ids(examsFor(data, 'carrier')), ['equipment', 'reactors', 'refining', 'units']);
  const kh = examsFor(data, 'standard');
  assert.deepEqual(ids(kh), ['equipment', 'control', 'reactors', 'refining', 'units']);
  const c = kh.find((e) => e.subject === 'control');
  assert.equal(c.date, '2026-11-19');
  assert.equal(c.dayKey, 'thu');
  assert.equal(c.start, 9 * 60);
});

test('2. Sun 15 Nov 21:15 → next exam for both is Mon 16 Nov equipment; باجر is the default view and has the exam', () => {
  for (const p of ['carrier', 'standard']) {
    const tl = examTimeline(data, p, at('2026-11-15T21:15'));
    assert.equal(tl.next.subject, 'equipment');
    assert.equal(tl.next.date, '2026-11-16');
    assert.equal(tl.next.dayDiff, 1);
    assert.equal(examTimeText(tl.next), 'الوقت ما متبلغ بعد'); // never invent a time
    assert.equal(defaultView(data, p, {}, at('2026-11-15T21:15')).view, 'tomorrow');
    const b = examBrief(data, p, at('2026-11-15T21:15'));
    assert.equal(b.lines[0].kind, 'tomorrow');
    assert.match(b.lines[0].text, /^باجر امتحان معدات/);
  }
});

test('3. Night of Wed 18 Nov: خلود opens with "باجر امتحان سيطرة 9:00"; محمد gets a 🍑 line about her exam', () => {
  const kh = examBrief(data, 'standard', at('2026-11-18T21:00'));
  assert.match(kh.lines[0].text, /^باجر امتحان سيطرة 9:00/);
  assert.ok(kh.lines[0].luck);
  const mo = examBrief(data, 'carrier', at('2026-11-18T21:00'));
  assert.equal(mo.mineTomorrow.length, 0);
  assert.equal(mo.lines.length, 1);
  assert.equal(mo.lines[0].kind, 'partner');
  assert.match(mo.lines[0].text, /^خلود عدها امتحان سيطرة باجر 9:00 ص 🍑$/);
});

test('4. Exam-day morning: Thu 19 only خلود; Mon 16 both', () => {
  const kThu = examBrief(data, 'standard', at('2026-11-19T07:00'));
  const mThu = examBrief(data, 'carrier', at('2026-11-19T07:00'));
  assert.equal(kThu.mineToday.length, 1);
  assert.equal(kThu.lines[0].text, 'اليوم امتحان ديناميكية العمليات. بالتوفيق، أنتِ قدها');
  assert.equal(mThu.mineToday.length, 0);
  assert.ok(mThu.lines.some((l) => l.kind === 'partner' && /🍑/.test(l.text)));
  for (const p of ['carrier', 'standard']) {
    const b = examBrief(data, p, at('2026-11-16T07:00'));
    assert.equal(b.mineToday.length, 1);
    assert.match(b.lines[0].text, /^اليوم امتحان تصميم معدات/);
  }
  assert.match(examBrief(data, 'carrier', at('2026-11-16T07:00')).lines[0].text, /أنت قدها$/);
  // Shared exam → partner line says you're in it together, not a duplicate exam line
  assert.ok(examBrief(data, 'carrier', at('2026-11-16T07:00')).lines.some((l) => l.shared && /🍑/.test(l.text)));
});

test('5. After 1 Dec the season is over and the celebration is due once', () => {
  const during = examTimeline(data, 'carrier', at('2026-12-01T10:00'));
  assert.equal(during.season, true);
  const after = examTimeline(data, 'carrier', at('2026-12-01T15:00'));
  assert.equal(after.season, false);
  assert.equal(after.next, null);
  assert.equal(after.allDone, true);
  assert.equal(celebrationDue(after, false), true);
  assert.equal(celebrationDue(after, true), false);
  assert.equal(celebrationDue(during, false), false);
});

test('study gaps, focus suggestion and done state', () => {
  const tl = examTimeline(data, 'carrier', at('2026-11-17T10:00'));
  assert.deepEqual(tl.list.map((e) => e.done), [true, false, false, false]);
  assert.deepEqual(tl.gaps.map((g) => g.days), [5, 2, 5]); // 17–21, 23–24, 26–30
  assert.equal(tl.gaps[0].left, 5);
  const f = focusSuggestion(data, 'carrier', at('2026-11-17T10:00'));
  assert.equal(f.exam.subject, 'reactors');
  assert.equal(f.days, 5);
  assert.equal(focusSuggestion(data, 'carrier', at('2026-11-16T08:00')), null); // exam day: no suggestion
  assert.equal(examNick(data, 'control'), 'سيطرة');
  assert.notEqual(luckLine('m', 'a'), undefined);
});

test('6. no "شوف جدول" text anywhere in the app; both fruit SVGs render (full + small)', async () => {
  const { readdirSync } = await import('node:fs');
  const files = ['index.html', ...readdirSync(new URL('../app/', import.meta.url)).map((f) => `app/${f}`)];
  for (const f of files) assert.ok(!readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').includes('شوف جدول'), f);
  const { fruitSVG } = await import('../app/fruits.js');
  for (const kind of ['peach', 'dragon']) {
    const big = fruitSVG(kind, 96, { label: kind });
    assert.match(big, /^<svg class="fruit fruit--/);
    assert.match(big, /role="img"/);
    assert.match(big, /fr-face/); // face at 96px
    assert.doesNotMatch(fruitSVG(kind, 20), /fr-face/); // simplified at 20px
  }
  assert.equal(data.profiles.standard.emoji, '🍑');
  assert.equal(data.profiles.carrier.emoji, '🐉');
});

test('adding an exam is a one-line JSON edit (Heat 1 only for محمد)', () => {
  const d2 = { ...data, exams: [...data.exams, { id: 'mid-heat1', kind: 'midterm', subject: 'heat1', date: '2026-11-30', time: '10:30' }] };
  assert.ok(examsFor(d2, 'carrier').some((e) => e.subject === 'heat1'));
  assert.ok(!examsFor(d2, 'standard').some((e) => e.subject === 'heat1'));
});
