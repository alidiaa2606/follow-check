// Run with: npm test  (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../session.js');

function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}

test('counts, target, reached and reset', () => {
  const s = S.createSessionTracker({ storage: memoryStorage() });
  assert.equal(s.count(), 0);
  assert.equal(s.target(), null);
  assert.equal(s.reached(), false); // no target: never "reached"
  s.setTarget(3);
  s.add(2);
  assert.equal(s.reached(), false);
  s.add(1);
  assert.equal(s.reached(), true);
  s.add(-5);
  assert.equal(s.count(), 0); // never below zero
  s.add(4);
  s.reset();
  assert.equal(s.count(), 0);
  assert.equal(s.target(), 3); // target kept
  s.setTarget(null);
  assert.equal(s.target(), null);
});

test('persists across instances (reload)', () => {
  const storage = memoryStorage();
  const a = S.createSessionTracker({ storage });
  a.setTarget(20);
  a.add(12);
  const b = S.createSessionTracker({ storage });
  assert.equal(b.count(), 12);
  assert.equal(b.target(), 20);
});

test('parseTarget accepts 1-10000 or empty, rejects anything else', () => {
  assert.equal(S.parseTarget(''), null);
  assert.equal(S.parseTarget(' 20 '), 20);
  for (const bad of ['0', '-3', '2.5', 'abc', '10001', '1e9']) assert.throws(() => S.parseTarget(bad), /whole number/);
});

test('normalize rejects malformed data; corrupt storage starts fresh', () => {
  assert.throws(() => S.normalize({ count: -1 }), /invalid session count/);
  assert.throws(() => S.normalize({ count: 1, target: 0 }), /invalid session target/);
  assert.throws(() => S.normalize([]), /not an object/);
  const storage = memoryStorage();
  storage.setItem(S.STORAGE_KEY, '{bad');
  assert.equal(S.createSessionTracker({ storage }).count(), 0);
});
