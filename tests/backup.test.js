// Run with: npm test  (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../backup.js');
const T = require('../tags.js');
const Q = require('../queue.js');
const S = require('../session.js');
const R = require('../review.js');

function memoryStorage() {
  const data = {};
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}
function populated() {
  const storage = memoryStorage();
  const tags = T.createTagStore(storage);
  tags.setMany([['amy', 'keep'], ['ben', 'ignore'], ['cat', 'unavailable'], ['dan', 'keep']]);
  const queue = Q.createQueue({ storage });
  queue.add(['eve', 'fay', 'gus']);
  queue.setStatus(['eve'], 'done');
  queue.setStatus(['fay'], 'skipped');
  const session = S.createSessionTracker({ storage });
  session.setTarget(20);
  session.add(3);
  const review = R.createReviewSession({ order: ['amy', 'hal', 'ivy'], tags, storage });
  review.start(); // saves position hal
  return storage;
}

test('create + parse round trip, with an accurate summary and no export data', () => {
  const storage = populated();
  const backup = B.create(storage, new Date('2026-09-27T10:00:00Z'));
  assert.equal(backup.format, 'follow-check-backup');
  assert.equal(backup.version, 1);
  assert.deepEqual(Object.keys(backup.data).sort(), ['queue', 'review', 'session', 'tags']);
  const { summary } = B.parse(JSON.stringify(backup));
  assert.deepEqual(summary, {
    createdAt: '2026-09-27T10:00:00.000Z',
    tags: { total: 4, keep: 2, ignore: 1, unavailable: 1 },
    queue: { total: 3, done: 1, pending: 1, skipped: 1 },
    reviewSaved: true,
    session: { count: 3, target: 20 },
  });
});

test('restore into a fresh browser brings everything back', () => {
  const text = JSON.stringify(B.create(populated()));
  const fresh = memoryStorage();
  B.restore(fresh, B.parse(text).data);
  const tags = T.createTagStore(fresh);
  assert.equal(tags.get('amy'), 'keep');
  assert.equal(tags.get('cat'), 'unavailable');
  const queue = Q.createQueue({ storage: fresh });
  assert.deepEqual(queue.counts(), { total: 3, done: 1, pending: 1, skipped: 1 });
  const session = S.createSessionTracker({ storage: fresh });
  assert.equal(session.count(), 3);
  assert.equal(session.target(), 20);
  const review = R.createReviewSession({ order: ['amy', 'hal', 'ivy'], tags, storage: fresh });
  assert.equal(review.hasSavedProgress, true);
  assert.equal(review.start(), 'hal');
});

test('restore replaces existing data (not a merge)', () => {
  const target = populated();
  const emptyBackup = JSON.stringify(B.create(memoryStorage()));
  B.restore(target, B.parse(emptyBackup).data);
  assert.equal(T.createTagStore(target).size(), 0);
  assert.equal(Q.createQueue({ storage: target }).size(), 0);
});

test('rejects files that are not valid backups, with clear messages', () => {
  const good = B.create(populated());
  const bad = (mutate) => { const b = JSON.parse(JSON.stringify(good)); mutate(b); return JSON.stringify(b); };
  const cases = [
    ['{not json', /isn't valid JSON/],
    ['[]', /isn't a Follow Check backup file/],
    [JSON.stringify({ format: 'something-else', version: 1, data: {} }), /isn't a Follow Check backup file/],
    [bad((b) => { b.version = 2; }), /newer version of Follow Check \(format 2\)/],
    [bad((b) => { b.version = '1'; }), /invalid format version/],
    [bad((b) => { b.version = 0; }), /invalid format version/],
    [bad((b) => { delete b.data; }), /damaged or incomplete \(the data section is missing\)/],
    [bad((b) => { b.data.tags.amy.tag = 'delete'; }), /damaged or incomplete \(invalid tag for amy\)/],
    [bad((b) => { b.data.tags['Not A User'] = { tag: 'keep' }; }), /invalid username in tags/],
    [bad((b) => { b.data.queue.entries.eve.status = 'unfollowed'; }), /invalid queue status/],
    [bad((b) => { b.data.session.count = -4; }), /invalid session count/],
    [bad((b) => { b.data.review.skipped = 'amy'; }), /review skipped list is not a list/],
    ['x'.repeat(B.MAX_BYTES + 1), /too large/],
  ];
  for (const [text, message] of cases) assert.throws(() => B.parse(text), message, text.slice(0, 60));
  assert.throws(() => B.parse(undefined), /couldn't be read/);
});

test('missing sections are treated as empty', () => {
  const { data, summary } = B.parse(JSON.stringify({ format: 'follow-check-backup', version: 1, data: { tags: { amy: { tag: 'keep' } } } }));
  assert.deepEqual(data.queue, { entries: {}, current: null });
  assert.equal(summary.tags.total, 1);
  assert.equal(summary.reviewSaved, false);
});

test('restore is all-or-nothing when storage fails part-way', () => {
  const storage = populated();
  const before = { ...storage.data };
  let writes = 0;
  const flaky = { ...storage, setItem: (k, v) => { if (++writes === 3) throw new Error('quota'); storage.setItem(k, v); } };
  const data = B.parse(JSON.stringify(B.create(memoryStorage()))).data;
  assert.throws(() => B.restore(flaky, data), /Nothing was changed/);
  assert.deepEqual(storage.data, before);
});

test('create is lenient about unreadable saved data (backs up the rest)', () => {
  const storage = populated();
  storage.setItem(R.STORAGE_KEY, '{broken');
  const backup = B.create(storage);
  assert.deepEqual(backup.data.review, { current: null, skipped: [] });
  assert.equal(Object.keys(backup.data.tags).length, 4);
  assert.doesNotThrow(() => B.parse(JSON.stringify(backup)));
});
