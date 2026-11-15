import { test } from 'node:test';
import assert from 'node:assert/strict';
import { processUpdates, emptyShared, emptyPrivate, encrypt, decrypt } from '../bot/run.mjs';

const msg = (id, chat, extra) => ({ update_id: id, message: { chat: { id: chat, type: 'private' }, from: { first_name: 'x' }, ...extra } });
const sync = (id, chat, payload) => msg(id, chat, { web_app_data: { data: JSON.stringify(payload) } });

test('sync: claims profile, shares edits and tells the partner (with their fruit)', () => {
  const priv = emptyPrivate(), shared = emptyShared();
  processUpdates([sync(1, 111, { v: 1, profile: 'standard', prefs: { shift: 'morning' } })], priv, shared, 'https://x/');
  const out = processUpdates([sync(2, 222, {
    v: 1, profile: 'carrier', prefs: { shift: 'morning', heatTrack: 'morning', labGroup: 'A' },
    edits: [{ id: 'abcd1', stream: 'stage4_morning', op: 'update', key: 'stage4_morning:mon:S2:equipment:lecture', set: { room: 'قاعة 7' } },
      { id: 'bad', stream: 'nope', op: 'add' }],
  })], priv, shared, 'https://x/');
  assert.equal(priv.offset, 3);
  assert.deepEqual(Object.keys(priv.chats).sort(), ['111', '222']); // remembered for announcements
  assert.deepEqual(priv.claims, { standard: '111', carrier: '222' });
  assert.equal(shared.edits.length, 1);
  assert.equal(shared.people.carrier.labGroup, 'A');
  assert.equal(out.length, 2); // confirmation + partner notice
  assert.match(out[0].text, /🐉/);
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

test('update announcement goes out once per chat on its next message', () => {
  const priv = emptyPrivate(), shared = emptyShared();
  const a = processUpdates([msg(1, 5, { text: 'هلا' })], priv, shared, 'https://x/');
  assert.match(a[0].text, /تحدّث وتطوّر/);
  assert.ok(a[0].reply_markup.keyboard);
  const b = processUpdates([msg(2, 5, { text: 'هلا ثاني' })], priv, shared, 'https://x/');
  assert.doesNotMatch(b[0].text, /تحدّث وتطوّر/);
  priv.chats['6'] = { name: 'y', ann: 'u01-midterms' }; // already got it from the broadcast script
  const c = processUpdates([msg(3, 6, { text: '/start' })], priv, shared, 'https://x/');
  assert.doesNotMatch(c[0].text, /تحدّث وتطوّر/);
});

test('private state round-trips through encryption', () => {
  const p = { offset: 5, users: { 1: { profile: 'carrier' } }, claims: {} };
  const enc = encrypt(p, 'tok');
  assert.ok(!enc.includes('carrier'));
  assert.deepEqual(decrypt(enc, 'tok'), p);
  assert.throws(() => decrypt(enc, 'other'));
});
