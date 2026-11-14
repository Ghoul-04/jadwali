import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processUpdates, dueNotifications, emptyShared, emptyPrivate, encrypt, decrypt } from '../bot/run.mjs';

const msg = (id, chat, extra) => ({ update_id: id, message: { chat: { id: chat, type: 'private' }, from: { first_name: 'x' }, ...extra } });
const sync = (id, chat, payload) => msg(id, chat, { web_app_data: { data: JSON.stringify(payload) } });

test('sync: claims profile, stores prefs, shares edits and tells the partner', () => {
  const priv = emptyPrivate(), shared = emptyShared();
  processUpdates([sync(1, 111, { v: 1, profile: 'standard', prefs: { shift: 'morning', nightly: '20', lead: 15 } })], priv, shared, 'https://x/');
  const out = processUpdates([sync(2, 222, {
    v: 1, profile: 'carrier', prefs: { shift: 'morning', heatTrack: 'morning', labGroup: 'A', nightly: '21', lead: 10 },
    edits: [{ id: 'abcd1', stream: 'stage4_morning', op: 'update', key: 'stage4_morning:mon:S2:equipment:lecture', set: { room: 'قاعة 7' } },
      { id: 'bad', stream: 'nope', op: 'add' }],
  })], priv, shared, 'https://x/');
  assert.equal(priv.offset, 3);
  assert.deepEqual(priv.claims, { standard: '111', carrier: '222' });
  assert.equal(shared.edits.length, 1);
  assert.equal(shared.people.carrier.labGroup, 'A');
  assert.equal(priv.users['222'].prefs.lead, 10);
  assert.equal(out.length, 2); // confirmation + partner notice
  assert.equal(out[1].chat_id, '111');
  assert.match(out[1].text, /عدّل الجدول/);
  // stranger can't take a claimed profile
  const s = processUpdates([sync(3, 999, { v: 1, profile: 'carrier', edits: [{ id: 'zzzz1', stream: 'stage4_morning', op: 'remove', key: 'k' }] })], priv, shared);
  assert.match(s[0].text, /مربوط/);
  assert.equal(shared.edits.length, 1);
  // revert
  processUpdates([sync(4, 222, { v: 1, profile: 'carrier', prefs: {}, edits: [{ id: 'abcd1', op: 'revert' }] })], priv, shared);
  assert.equal(shared.edits.length, 0);
});

test('notifications due: 15 min before Monday 10:30 equipment, once', () => {
  const priv = emptyPrivate(), shared = emptyShared();
  processUpdates([sync(1, 222, { v: 1, profile: 'carrier', prefs: { nightly: '20', lead: 15 } })], priv, shared);
  const now = new Date('2026-11-16T10:13:00+03:00');
  const due = dueNotifications(priv, shared, now);
  assert.equal(due.length, 1);
  assert.equal(due[0].at, Date.parse('2026-11-16T10:15:00+03:00'));
  assert.match(due[0].text, /تصميم معدات/);
  priv.sent[due[0].id] = 1;
  assert.equal(dueNotifications(priv, shared, now).length, 0);
  const night = dueNotifications(priv, shared, new Date('2026-11-16T20:02:00+03:00'));
  assert.match(night[0].text, /شنو عندك باجر/);
});

test('private state round-trips through encryption', () => {
  const p = { offset: 5, users: { 1: { profile: 'carrier' } }, claims: {}, sent: {} };
  const enc = encrypt(p, 'tok');
  assert.ok(!enc.includes('carrier'));
  assert.deepEqual(decrypt(enc, 'tok'), p);
  assert.throws(() => decrypt(enc, 'other'));
});
