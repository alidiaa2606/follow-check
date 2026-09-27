// Run with: node --test instagram/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tags.js');

/** Minimal in-memory stand-in for window.localStorage. */
function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
  };
}
const entries = (...usernames) => usernames.map((username) => ({ username }));

test('set, get, change and remove a tag', () => {
  const store = T.createTagStore(memoryStorage());
  assert.equal(store.get('alice'), null);
  assert.equal(store.set('alice', 'keep'), true);
  assert.equal(store.get('alice'), 'keep');
  store.set('alice', 'ignore');
  assert.equal(store.get('alice'), 'ignore');
  store.set('alice', 'unavailable');
  assert.equal(store.get('alice'), 'unavailable');
  store.set('alice', null);
  assert.equal(store.get('alice'), null);
  assert.equal(store.size(), 0);
});

test('rejects unknown tags', () => {
  const store = T.createTagStore(memoryStorage());
  assert.throws(() => store.set('alice', 'delete'), /Unknown tag/);
});

test('tags persist: a new store on the same storage sees them (simulates reopening the app)', () => {
  const storage = memoryStorage();
  const first = T.createTagStore(storage);
  first.set('alice', 'keep');
  first.set('bob', 'ignore');
  first.set('carol', 'unavailable');
  first.set('bob', null);

  const reopened = T.createTagStore(storage);
  assert.equal(reopened.get('alice'), 'keep');
  assert.equal(reopened.get('bob'), null);
  assert.equal(reopened.get('carol'), 'unavailable');
  const saved = JSON.parse(storage.data[T.STORAGE_KEY]);
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.tags).sort(), ['alice', 'carol']);
});

test('counts and filters a list', () => {
  const store = T.createTagStore(memoryStorage());
  const list = entries('a', 'b', 'c', 'd', 'e');
  store.set('a', 'keep');
  store.set('b', 'keep');
  store.set('c', 'ignore');
  store.set('d', 'unavailable');
  store.set('zzz', 'keep'); // not in the list: must not be counted
  assert.deepEqual(store.counts(list), { all: 5, unreviewed: 1, keep: 2, ignore: 1, unavailable: 1 });
  const names = (l) => l.map((e) => e.username);
  assert.deepEqual(names(store.filter(list, 'all')), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(names(store.filter(list, 'unreviewed')), ['e']);
  assert.deepEqual(names(store.filter(list, 'keep')), ['a', 'b']);
  assert.deepEqual(names(store.filter(list, 'ignore')), ['c']);
  assert.deepEqual(names(store.filter(list, 'unavailable')), ['d']);
});

test('tags for usernames missing from a newer export are kept, and counted', () => {
  const storage = memoryStorage();
  const store = T.createTagStore(storage);
  store.set('still_here', 'keep');
  store.set('gone', 'unavailable');
  assert.equal(store.countMissing(new Set(['still_here', 'new_one'])), 1);
  assert.equal(T.createTagStore(storage).get('gone'), 'unavailable');
});

test('corrupt or unexpected saved data is ignored instead of crashing', () => {
  assert.equal(T.createTagStore(memoryStorage({ [T.STORAGE_KEY]: '{not json' })).size(), 0);
  const odd = JSON.stringify({ version: 1, tags: { ok: { tag: 'keep' }, bad: { tag: 'nope' }, worse: null } });
  const store = T.createTagStore(memoryStorage({ [T.STORAGE_KEY]: odd }));
  assert.equal(store.size(), 1);
  assert.equal(store.get('ok'), 'keep');
});

test('works (in memory) when storage is missing or throws, and reports it', () => {
  const none = T.createTagStore(null);
  assert.equal(none.set('a', 'keep'), false);
  assert.equal(none.get('a'), 'keep');
  assert.equal(none.isPersistent(), false);

  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const store = T.createTagStore(broken);
  assert.equal(store.set('a', 'ignore'), false);
  assert.equal(store.get('a'), 'ignore');
  assert.equal(store.isPersistent(), false);
});

test('reload picks up changes made elsewhere (e.g. another tab)', () => {
  const storage = memoryStorage();
  const tab1 = T.createTagStore(storage);
  const tab2 = T.createTagStore(storage);
  tab2.set('alice', 'keep');
  assert.equal(tab1.get('alice'), null);
  tab1.reload();
  assert.equal(tab1.get('alice'), 'keep');
});

test('setMany sets and clears several tags with a single save', () => {
  const storage = memoryStorage();
  let writes = 0;
  const counting = { getItem: storage.getItem, setItem: (k, v) => { writes++; storage.setItem(k, v); } };
  const store = T.createTagStore(counting);
  store.set('a', 'keep');
  writes = 0;
  assert.equal(store.setMany([['a', null], ['b', 'ignore'], ['c', 'unavailable']]), true);
  assert.equal(writes, 1);
  assert.equal(store.get('a'), null);
  assert.equal(store.get('b'), 'ignore');
  assert.equal(T.createTagStore(storage).get('c'), 'unavailable');
});

test('setMany is all-or-nothing when a tag is invalid', () => {
  const store = T.createTagStore(memoryStorage());
  assert.throws(() => store.setMany([['a', 'keep'], ['b', 'bogus']]), /Unknown tag/);
  assert.equal(store.get('a'), null);
});
