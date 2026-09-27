// Run with: node --test instagram/tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../parser.js');

const EXPORT_DIR = path.join(__dirname, 'fixtures', 'sample-export');

// Read every file in the sample export, with paths like a ZIP would give.
function loadSampleExport() {
  const out = [];
  (function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else out.push({ name: path.relative(EXPORT_DIR, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') });
    }
  })(EXPORT_DIR);
  return out;
}

const names = (entries) => entries.map((e) => e.username);
const file = (name, data) => ({ name, text: typeof data === 'string' ? data : JSON.stringify(data) });

test('classifyFile recognises followers/following files and ignores the rest', () => {
  assert.equal(P.classifyFile('followers_1.json'), 'followers');
  assert.equal(P.classifyFile('connections/followers_and_following/followers_12.json'), 'followers');
  assert.equal(P.classifyFile('followers.json'), 'followers');
  assert.equal(P.classifyFile('following.json'), 'following');
  assert.equal(P.classifyFile('C:\\export\\following.json'), 'following');
  assert.equal(P.classifyFile('following.html'), 'html');
  assert.equal(P.classifyFile('following_hashtags.json'), null);
  assert.equal(P.classifyFile('pending_follow_requests.json'), null);
  assert.equal(P.classifyFile('close_friends.json'), null);
  assert.equal(P.classifyFile('recently_unfollowed_profiles.json'), null);
});

test('normalizeUsername lowercases, strips @ and rejects invalid names', () => {
  assert.equal(P.normalizeUsername('  @Bob.Smith '), 'bob.smith');
  assert.equal(P.normalizeUsername(''), null);
  assert.equal(P.normalizeUsername('has space'), null);
  assert.equal(P.normalizeUsername(undefined), null);
});

test('usernameFromHref handles plain and /_u/ profile links', () => {
  assert.equal(P.usernameFromHref('https://www.instagram.com/alice'), 'alice');
  assert.equal(P.usernameFromHref('https://www.instagram.com/_u/alice'), 'alice');
  assert.equal(P.usernameFromHref('https://instagram.com/alice/?hl=en'), 'alice');
  assert.equal(P.usernameFromHref('https://example.com/alice'), null);
});

test('parseEntry supports value, title and href-only layouts', () => {
  const byValue = P.parseEntry({ title: '', string_list_data: [{ value: 'alice', href: 'x', timestamp: 5 }] });
  assert.deepEqual(byValue, { username: 'alice', href: 'https://www.instagram.com/alice/', timestamp: 5 });
  assert.equal(P.parseEntry({ title: 'bob', string_list_data: [{ href: 'x' }] }).username, 'bob');
  assert.equal(P.parseEntry({ title: '', string_list_data: [{ href: 'https://www.instagram.com/_u/carol' }] }).username, 'carol');
  assert.equal(P.parseEntry({ title: 'dave', string_list_data: [] }).timestamp, null);
  assert.equal(P.parseEntry({ title: '', string_list_data: [] }), null);
  assert.equal(P.parseEntry(null), null);
});

test('sample export: combines followers_1 + followers_2 and reads following.json', () => {
  const result = P.parseExport(loadSampleExport());
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual([...result.followers.keys()].sort(), ['alice', 'bob.smith', 'carol_', 'dave', 'fan_only']);
  assert.deepEqual([...result.following.keys()].sort(), ['alice', 'bob.smith', 'dave', 'href.only', 'natgeo', 'old_friend']);
  // Only the three relevant files are used; hashtags and pending requests are ignored.
  assert.deepEqual(result.files.map((f) => f.name), ['followers_1.json', 'followers_2.json', 'following.json']);
  // alice appears in both followers files but is only counted once.
  assert.equal(result.files.find((f) => f.name === 'followers_2.json').added, 2);
});

test('sample export: compare finds who does not follow back', () => {
  const { followers, following } = P.parseExport(loadSampleExport());
  const { notFollowingBack, fans, mutual } = P.compare(followers, following);
  assert.deepEqual(names(notFollowingBack), ['href.only', 'natgeo', 'old_friend']);
  assert.deepEqual(names(fans), ['carol_', 'fan_only']);
  assert.deepEqual(names(mutual), ['alice', 'bob.smith', 'dave']);
  // Totals add up.
  assert.equal(notFollowingBack.length + mutual.length, following.size);
  assert.equal(fans.length + mutual.length, followers.size);
});

test('supports many followers files (followers_1..followers_12)', () => {
  const files = [file('following.json', { relationships_following: [{ title: 'user11', string_list_data: [{}] }] })];
  for (let i = 1; i <= 12; i++) {
    files.push(file(`followers_${i}.json`, [{ string_list_data: [{ value: `user${i}` }] }]));
  }
  const result = P.parseExport(files);
  assert.equal(result.followers.size, 12);
  assert.deepEqual(result.files.map((f) => f.name).slice(0, 3), ['followers_1.json', 'followers_2.json', 'followers_3.json']);
  assert.equal(result.files.at(-2).name, 'followers_12.json');
});

test('supports the older following.json layout (username in value)', () => {
  const result = P.parseExport([
    file('followers_1.json', []),
    file('following.json', { relationships_following: [{ title: '', string_list_data: [{ href: 'https://www.instagram.com/zed', value: 'zed', timestamp: 1 }] }] }),
  ]);
  assert.deepEqual([...result.following.keys()], ['zed']);
});

test('supports followers wrapped in relationships_followers', () => {
  const result = P.parseExport([
    file('followers_1.json', { relationships_followers: [{ string_list_data: [{ value: 'amy' }] }] }),
    file('following.json', { relationships_following: [] }),
  ]);
  assert.deepEqual([...result.followers.keys()], ['amy']);
  assert.deepEqual(result.errors, []);
});

test('reports missing files', () => {
  assert.deepEqual(P.parseExport([file('following.json', { relationships_following: [] })]).errors,
    ['No followers file found (followers_1.json).']);
  assert.deepEqual(P.parseExport([file('followers_1.json', [])]).errors,
    ['No following file found (following.json).']);
  assert.equal(P.parseExport([]).errors.length, 2);
});

test('reports invalid JSON and unexpected shapes without crashing', () => {
  const result = P.parseExport([
    file('followers_1.json', '{not json'),
    file('followers_2.json', { hello: 'world' }),
    file('following.json', { relationships_following: [] }),
  ]);
  assert.match(result.errors[0], /followers_1\.json isn't valid JSON/);
  assert.match(result.errors[1], /followers_2\.json doesn't contain a list/);
  assert.match(result.errors[2], /No followers file found/);
});

test('warns about unreadable entries, duplicate files and HTML exports', () => {
  const result = P.parseExport([
    file('a/followers_1.json', [{ string_list_data: [{ value: 'ok' }] }, { string_list_data: [] }]),
    file('b/followers_1.json', [{ string_list_data: [{ value: 'dup' }] }]),
    file('following.html', '<html></html>'),
    file('following.json', { relationships_following: [] }),
  ]);
  assert.deepEqual([...result.followers.keys()], ['ok']);
  assert.equal(result.warnings.length, 3);
  assert.match(result.warnings.join('\n'), /1 entry had no readable username/);
  assert.match(result.warnings.join('\n'), /provided more than once/);
  assert.match(result.warnings.join('\n'), /HTML format/);
});

test('handles a large export quickly', () => {
  const N = 50000;
  const followers = Array.from({ length: N }, (_, i) => ({ string_list_data: [{ value: `f${i}` }] }));
  const following = Array.from({ length: N }, (_, i) => ({ title: `f${i * 2}`, string_list_data: [{}] }));
  const start = Date.now();
  const r = P.parseExport([file('followers_1.json', followers), file('following.json', { relationships_following: following })]);
  const { notFollowingBack } = P.compare(r.followers, r.following);
  assert.equal(notFollowingBack.length, N / 2);
  assert.ok(Date.now() - start < 2000, 'should parse 100k entries in under 2s');
});

// ---------- Newer label_values layout (fake data) ----------

test('parseEntry reads the label_values layout (Username label + entry timestamp)', () => {
  const entry = { fbid: '1', timestamp: 1700000000, media: [], label_values: [
    { label: 'URL', value: 'https://linktr.ee/somebody_else' },
    { label: 'Name', value: 'Jane Doe' },
    { label: 'Username', value: 'Jane.Doe' },
  ] };
  assert.deepEqual(P.parseEntry(entry), { username: 'jane.doe', href: 'https://www.instagram.com/jane.doe/', timestamp: 1700000000 });
});

test('label_values: finds Username inside nested dict groups', () => {
  const entry = { timestamp: 5, label_values: [{ title: '', dict: [{ label: 'Name', value: 'X' }, { label: 'Username', value: 'nested_user' }] }] };
  assert.equal(P.parseEntry(entry).username, 'nested_user');
});

test('label_values: the bio URL is never used as the username', () => {
  const entry = { timestamp: 5, label_values: [{ label: 'URL', value: 'https://www.instagram.com/wrong_person' }, { label: 'Name', value: 'No Username' }] };
  assert.equal(P.parseEntry(entry), null);
});

test('label_values: missing timestamp becomes null', () => {
  assert.equal(P.parseEntry({ label_values: [{ label: 'Username', value: 'abc' }] }).timestamp, null);
});

test('second sample export (following.json in label_values layout) parses and compares', () => {
  const dir = path.join(__dirname, 'fixtures', 'sample-export-2', 'connections', 'followers_and_following');
  const files = fs.readdirSync(dir).map((n) => ({ name: n, text: fs.readFileSync(path.join(dir, n), 'utf8') }));
  const r = P.parseExport(files);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.followers.size, 7);
  assert.equal(r.following.size, 6);
  assert.equal(r.following.get('brand_new').timestamp, 1715000000);
  const c = P.compare(r.followers, r.following);
  assert.deepEqual(names(c.notFollowingBack), ['brand_new', 'href.only']);
  assert.deepEqual(names(c.fans), ['carol_', 'fan_only', 'new_fan']);
});

test('a label_values file mixed with the classic layout in one export', () => {
  const r = P.parseExport([
    file('followers_1.json', [{ string_list_data: [{ value: 'classic', timestamp: 10 }] }]),
    file('followers_2.json', [{ timestamp: 20, label_values: [{ label: 'Username', value: 'modern' }] }]),
    file('following.json', { relationships_following: [{ timestamp: 30, label_values: [{ label: 'Username', value: 'classic' }] }] }),
  ]);
  assert.deepEqual([...r.followers.keys()], ['classic', 'modern']);
  assert.deepEqual([...r.following.keys()], ['classic']);
});

// ---------- Data date ----------

test('latestTimestamp is the newest follow date in followers or following', () => {
  const r = P.parseExport(loadSampleExport());
  assert.equal(r.latestTimestamp, 1700000005);
  const empty = P.parseExport([file('followers_1.json', []), file('following.json', { relationships_following: [] })]);
  assert.equal(empty.latestTimestamp, null);
});
