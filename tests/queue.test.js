// Run with: node --test instagram/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../queue.js');
const T = require('../tags.js');

function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); }, removeItem: (k) => { delete data[k]; } };
}
const setup = (storage = memoryStorage()) => ({ storage, queue: Q.createQueue({ storage }), tags: T.createTagStore(storage) });

test('add prevents duplicates and reports what was already queued', () => {
  const { queue } = setup();
  assert.deepEqual(queue.add(['cat', 'amy', 'amy']), { added: ['cat', 'amy'], already: [] });
  assert.deepEqual(queue.add(['amy', 'ben']), { added: ['ben'], already: ['amy'] });
  assert.equal(queue.size(), 3);
  assert.deepEqual(queue.list(), ['amy', 'ben', 'cat']);
  assert.equal(queue.status('amy'), 'pending');
  assert.equal(queue.status('zed'), null);
});

test('remove, setStatus and restore (used for undo of bulk actions)', () => {
  const { queue } = setup();
  queue.add(['amy', 'ben', 'cat']);
  const prevStatus = queue.setStatus(['amy', 'ben', 'not_queued'], 'done');
  assert.equal(prevStatus.length, 2); // not_queued is ignored
  assert.deepEqual(queue.counts(), { total: 3, done: 2, pending: 1, skipped: 0 });
  assert.ok(queue.entry('amy').doneAt > 0);
  const prevRemove = queue.remove(['cat', 'zzz']);
  assert.deepEqual(prevRemove.map(([u]) => u), ['cat']);
  queue.restore(prevRemove);
  queue.restore(prevStatus);
  assert.deepEqual(queue.counts(), { total: 3, done: 0, pending: 3, skipped: 0 });
  assert.throws(() => queue.setStatus(['amy'], 'unfollowed'), /Unknown status/);
});

test('counts for a subset of usernames', () => {
  const { queue } = setup();
  queue.add(['amy', 'ben', 'cat']);
  queue.setStatus(['ben'], 'skipped');
  assert.deepEqual(queue.counts(['amy', 'ben', 'nobody']), { total: 2, done: 0, pending: 1, skipped: 1 });
});

test('persists across instances (reload / browser restart)', () => {
  const storage = memoryStorage();
  const first = setup(storage).queue;
  first.add(['amy', 'ben']);
  first.setStatus(['ben'], 'done');
  const again = setup(storage).queue;
  assert.deepEqual(again.list(), ['amy', 'ben']);
  assert.equal(again.status('ben'), 'done');
});

test('workflow: done, skip, keep instead move to the next pending account', () => {
  const { queue, tags } = setup();
  queue.add(['dan', 'amy', 'cat', 'ben']);
  assert.equal(queue.start(), 'amy');
  assert.equal(queue.position(), 1);
  assert.equal(queue.markDone(), 'ben');
  assert.equal(queue.skip(), 'cat');
  assert.equal(queue.keepInstead(tags), 'dan');
  assert.equal(queue.has('cat'), false);
  assert.equal(tags.get('cat'), 'keep');
  assert.equal(queue.markDone(), null); // ben is skipped, so nothing pending is left
  assert.deepEqual(queue.counts(), { total: 3, done: 2, pending: 0, skipped: 1 });
  assert.equal(queue.retrySkipped(), 'ben');
});

test('workflow: previous reaches done accounts; undo reverts step by step', () => {
  const { queue, tags } = setup();
  tags.set('cat', 'ignore');
  queue.add(['amy', 'ben', 'cat']);
  queue.start();
  queue.markDone(); // amy
  queue.skip(); // ben
  queue.keepInstead(tags); // cat (was Ignore)
  assert.equal(queue.current(), null);
  assert.equal(queue.previous(), 'ben');
  assert.equal(queue.previous(), 'amy');
  assert.equal(queue.canPrevious(), false);

  assert.equal(queue.undo(tags).type, 'keep');
  assert.equal(queue.current(), 'cat');
  assert.equal(queue.status('cat'), 'pending');
  assert.equal(tags.get('cat'), 'ignore'); // previous tag restored
  assert.equal(queue.undo(tags).type, 'skip');
  assert.equal(queue.status('ben'), 'pending');
  assert.equal(queue.undo(tags).type, 'done');
  assert.equal(queue.status('amy'), 'pending');
  assert.equal(queue.canUndo(), false);
  assert.equal(queue.undo(tags), null);
});

test('workflow: resume from the saved position after reopening', () => {
  const storage = memoryStorage();
  const first = setup(storage).queue;
  first.add(['amy', 'ben', 'cat']);
  first.start();
  first.markDone();
  assert.equal(first.current(), 'ben');
  const again = setup(storage).queue;
  assert.equal(again.hasSavedPosition(), true);
  assert.equal(again.start(), 'ben');
});

test('workflow: removing the current account moves the position on', () => {
  const { queue } = setup();
  queue.add(['amy', 'ben', 'cat']);
  queue.start(); // amy
  queue.remove(['amy']);
  assert.equal(queue.current(), 'ben');
});

test('resetProgress puts everything back to pending; clear empties the queue', () => {
  const { queue } = setup();
  queue.add(['amy', 'ben', 'cat']);
  queue.start();
  queue.markDone();
  queue.skip();
  queue.resetProgress();
  assert.deepEqual(queue.counts(), { total: 3, done: 0, pending: 3, skipped: 0 });
  assert.equal(queue.hasSavedPosition(), false);
  assert.equal(queue.canUndo(), false);
  queue.clear();
  assert.equal(queue.size(), 0);
  assert.equal(queue.start(), null);
});

test('normalize rejects malformed data; corrupt storage starts empty', () => {
  assert.throws(() => Q.normalize(null), /not an object/);
  assert.throws(() => Q.normalize({ entries: { 'Bad Name': { status: 'pending' } } }), /invalid username/);
  assert.throws(() => Q.normalize({ entries: { amy: { status: 'unfollowed' } } }), /invalid queue status/);
  assert.equal(Q.normalize({ entries: { amy: { status: 'pending' } }, current: 'ghost' }).current, null);
  const storage = memoryStorage();
  storage.setItem(Q.STORAGE_KEY, '{nope');
  assert.equal(setup(storage).queue.size(), 0);
});

test('works without storage', () => {
  const queue = Q.createQueue({ storage: null });
  queue.add(['amy']);
  assert.equal(queue.start(), 'amy');
});

test('5,000 queued accounts: adding and working through stays fast', () => {
  const { queue, tags } = setup();
  const names = Array.from({ length: 5000 }, (_, i) => `user_${String(i).padStart(4, '0')}`);
  const t = Date.now();
  queue.add(names);
  queue.start();
  for (let i = 0; i < 300; i++) [() => queue.markDone(), () => queue.skip(), () => queue.keepInstead(tags)][i % 3]();
  assert.deepEqual(queue.counts(), { total: 4900, done: 100, pending: 4700, skipped: 100 });
  assert.ok(Date.now() - t < 3000, `took ${Date.now() - t}ms`);
});

test('regression: Keep instead / remove on the last account (cached order must not go stale)', () => {
  const { queue, tags } = setup();
  queue.add(['amy', 'ben', 'cat']);
  queue.start();
  queue.markDone(); // amy
  queue.skip(); // ben
  assert.equal(queue.current(), 'cat');
  assert.equal(queue.keepInstead(tags), null); // used to throw: cat was still in the cached order
  assert.deepEqual(queue.list(), ['amy', 'ben']);
  queue.undo(tags);
  assert.equal(queue.current(), 'cat');
  queue.remove(['cat']); // removing the current, last account
  assert.equal(queue.current(), null);
  queue.add(['zed']);
  assert.equal(queue.start(), 'zed'); // newly added account is found (order refreshed)
});
