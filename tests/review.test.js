// Run with: npm test  (or: node --test tests/*.test.js)
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tags.js');
const R = require('../review.js');

function memoryStorage() {
  const data = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = String(v); } };
}
const ORDER = ['amy', 'ben', 'cat', 'dan', 'eve'];

function setup(storage = memoryStorage()) {
  const tags = T.createTagStore(storage);
  const review = R.createReviewSession({ order: ORDER, tags, storage });
  return { storage, tags, review };
}

test('starts at the first unreviewed account and skips already-tagged ones', () => {
  const { tags, review } = setup();
  tags.set('amy', 'keep');
  assert.equal(review.hasSavedProgress, false);
  assert.equal(review.start(), 'ben');
  assert.equal(review.position(), 2);
});

test('tagging moves to the next unreviewed account', () => {
  const { tags, review } = setup();
  tags.set('ben', 'ignore'); // tagged earlier in the list view
  review.start();
  assert.equal(review.tag('keep'), 'cat'); // amy -> cat, skipping tagged ben
  assert.equal(tags.get('amy'), 'keep');
  assert.equal(review.tag('ignore'), 'dan');
  assert.equal(review.tag('unavailable'), 'eve');
  assert.equal(review.tag('keep'), null); // all done
  assert.deepEqual(review.progress(), { total: 5, reviewed: 5, remaining: 0, keep: 2, ignore: 2, unavailable: 1, skipped: 0 });
});

test('skip leaves the account unreviewed and moves on; skipped accounts can be reviewed at the end', () => {
  const { tags, review } = setup();
  review.start();
  assert.equal(review.skip(), 'ben');
  assert.equal(tags.get('amy'), null);
  review.tag('keep'); // ben
  review.tag('keep'); // cat
  review.tag('keep'); // dan
  assert.equal(review.tag('keep'), null); // eve; amy is skipped, so nothing left
  assert.equal(review.skippedCount(), 1);
  assert.equal(review.progress().remaining, 1);
  assert.equal(review.reviewSkipped(), 'amy');
  assert.equal(review.skippedCount(), 0);
});

test('previous goes back through the list, including tagged accounts, and can change a tag', () => {
  const { tags, review } = setup();
  review.start();
  review.tag('keep'); // amy
  review.tag('ignore'); // ben -> cat
  assert.equal(review.previous(), 'ben');
  assert.equal(review.previous(), 'amy');
  assert.equal(review.canPrevious(), false);
  assert.equal(review.previous(), 'amy'); // stays at the start
  assert.equal(review.tag('unavailable'), 'cat'); // change amy's tag, continue to next unreviewed
  assert.equal(tags.get('amy'), 'unavailable');
  assert.equal(tags.get('ben'), 'ignore');
});

test('previous from the "done" state goes to the last account', () => {
  const { review } = setup();
  review.start();
  for (let i = 0; i < 5; i++) review.tag('keep');
  assert.equal(review.current(), null);
  assert.equal(review.previous(), 'eve');
});

test('skip on an already-tagged account (reached via Previous) just moves on', () => {
  const { tags, review } = setup();
  review.start();
  review.tag('keep'); // amy -> ben
  review.previous(); // amy
  assert.equal(review.skip(), 'ben');
  assert.equal(tags.get('amy'), 'keep');
  assert.equal(review.skippedCount(), 0);
});

test('undo reverts tags and skips, one step at a time, and returns to that account', () => {
  const { tags, review } = setup();
  review.start();
  review.tag('keep'); // amy
  review.skip(); // ben
  review.tag('ignore'); // cat -> dan
  assert.equal(review.canUndo(), true);

  assert.equal(review.undo().username, 'cat');
  assert.equal(tags.get('cat'), null);
  assert.equal(review.current(), 'cat');

  assert.equal(review.undo().type, 'skip');
  assert.equal(review.current(), 'ben');
  assert.equal(review.skippedCount(), 0);

  assert.equal(review.undo().username, 'amy');
  assert.equal(tags.get('amy'), null);
  assert.equal(review.canUndo(), false);
  assert.equal(review.undo(), null);
});

test('undo of a changed tag restores the previous tag', () => {
  const { tags, review } = setup();
  tags.set('amy', 'keep');
  review.start();
  review.previous(); // ben -> amy
  review.tag('ignore');
  review.undo();
  assert.equal(tags.get('amy'), 'keep');
});

test('resume: a new session on the same storage continues where the last one stopped', () => {
  const storage = memoryStorage();
  const first = setup(storage).review;
  first.start();
  first.tag('keep'); // amy
  first.skip(); // ben
  assert.equal(first.current(), 'cat');

  // Close the browser, reopen, upload again.
  const { review, tags } = setup(storage);
  assert.equal(review.hasSavedProgress, true);
  assert.equal(review.start(), 'cat');
  assert.equal(tags.get('amy'), 'keep');
  assert.equal(review.skippedCount(), 1); // ben is still skipped
});

test('resume when the saved account was tagged elsewhere moves on to the next one', () => {
  const storage = memoryStorage();
  const first = setup(storage).review;
  first.start(); // amy
  const { tags, review } = setup(storage);
  tags.set('amy', 'ignore'); // tagged in the list view meanwhile
  assert.equal(review.start(), 'ben');
});

test('resume with a newer export: unknown saved usernames are dropped', () => {
  const storage = memoryStorage();
  storage.setItem(R.STORAGE_KEY, JSON.stringify({ version: 1, current: 'gone_user', skipped: ['gone_too', 'dan'] }));
  const { review } = setup(storage);
  assert.equal(review.start(), 'amy');
  assert.equal(review.skippedCount(), 1);
});

test('corrupt saved progress is ignored', () => {
  const storage = memoryStorage();
  storage.setItem(R.STORAGE_KEY, '{oops');
  const { review } = setup(storage);
  assert.equal(review.hasSavedProgress, false);
  assert.equal(review.start(), 'amy');
});

test('works without storage and with an empty list', () => {
  const tags = T.createTagStore(null);
  const review = R.createReviewSession({ order: ORDER, tags, storage: null });
  assert.equal(review.start(), 'amy');
  assert.equal(review.tag('keep'), 'ben');
  const empty = R.createReviewSession({ order: [], tags, storage: null });
  assert.equal(empty.start(), null);
  assert.equal(empty.previous(), null);
  assert.equal(empty.canPrevious(), false);
  assert.equal(empty.tag('keep'), null);
});
