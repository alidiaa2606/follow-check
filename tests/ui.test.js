// Browser test for the upload page. Needs Playwright + Chromium; skipped otherwise.
//   npm i --no-save playwright jszip   (or point NODE_PATH at an install)
//   node --test instagram/tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  test('UI tests (skipped: playwright not installed)', { skip: true }, () => {});
  return;
}
const JSZip = require('../vendor/jszip.min.js');

const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;
const EXPORT_DIR = path.join(__dirname, 'fixtures', 'sample-export');
const FF_DIR = path.join(EXPORT_DIR, 'connections', 'followers_and_following');
const EXECUTABLE = fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined;

let browser;
let zipPath;

test.before(async () => {
  browser = await chromium.launch({ executablePath: EXECUTABLE });
  // Build a ZIP shaped like Instagram's download from the sample export.
  const zip = new JSZip();
  for (const name of fs.readdirSync(FF_DIR)) {
    zip.file(`connections/followers_and_following/${name}`, fs.readFileSync(path.join(FF_DIR, name)));
  }
  zipPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')), 'instagram-export.zip');
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));
});
test.after(() => browser && browser.close());

/** Open the app and record console errors and any non-file:// requests. */
async function openApp() {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('request', (r) => !r.url().startsWith('file://') && problems.push(`network: ${r.url()}`));
  await page.goto(APP_URL);
  return { page, problems };
}

const stats = (page) => page.evaluate(() => Object.fromEntries(
  ['followers', 'following', 'nfb', 'mutual', 'fans'].map((k) => [k, document.getElementById(`stat-${k}`).textContent])));
const listed = (page) => page.$$eval('#list .row', (rows) => rows.map((r) => r.dataset.username));

const EXPECTED_STATS = { followers: '5', following: '6', nfb: '3', mutual: '3', fans: '2' };

test('ZIP upload: totals and lists match the parser results', async () => {
  const { page, problems } = await openApp();
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForSelector('#results:not([hidden])');

  assert.deepEqual(await stats(page), EXPECTED_STATS);
  assert.deepEqual(await listed(page), ['href.only', 'natgeo', 'old_friend']);
  assert.equal(await page.textContent('#list-summary'), '3 accounts');
  assert.match(await page.textContent('#sources'), /followers_1\.json \(3\), followers_2\.json \(3\), following\.json \(6\)/);
  assert.equal(await page.getAttribute('#list .row[data-username=natgeo] a', 'href'), 'https://www.instagram.com/natgeo/');
  assert.equal(await page.isHidden('#upload'), true);

  await page.click('#tabs [data-tab=fans]');
  assert.deepEqual(await listed(page), ['carol_', 'fan_only']);
  await page.click('#tabs [data-tab=mutual]');
  assert.deepEqual(await listed(page), ['alice', 'bob.smith', 'dave']);
  await page.click('.stat[data-tab=following]'); // stat cards act as tabs too
  assert.equal((await listed(page)).length, 6);
  assert.equal(await page.getAttribute('#tabs [data-tab=following]', 'aria-selected'), 'true');
  await page.click('#tabs [data-tab=followers]');
  assert.equal((await listed(page)).length, 5);

  assert.deepEqual(problems, []);
  await page.close();
});

test('search filters usernames (case-insensitive, ignores leading @)', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForSelector('#results:not([hidden])');

  await page.fill('#search', 'nat');
  assert.deepEqual(await listed(page), ['natgeo']);
  assert.equal(await page.textContent('#list .row mark'), 'nat');
  assert.equal(await page.textContent('#list-summary'), '1 of 3 match “nat”');

  await page.fill('#search', '@OLD');
  assert.deepEqual(await listed(page), ['old_friend']);

  await page.fill('#search', 'zzz');
  assert.deepEqual(await listed(page), []);
  assert.match(await page.textContent('#list .empty'), /No usernames match “zzz”/);

  // Search applies across tabs.
  await page.fill('#search', 'a');
  await page.click('#tabs [data-tab=following]');
  assert.deepEqual(await listed(page), ['alice', 'dave', 'natgeo']);

  // Escape clears; "/" focuses search.
  await page.press('#search', 'Escape');
  assert.equal((await listed(page)).length, 6);
  await page.click('.sources');
  await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'search');
  await page.close();
});

test('sort by name and follow date', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForSelector('#results:not([hidden])');
  await page.click('#tabs [data-tab=following]');

  await page.selectOption('#sort', 'za');
  assert.deepEqual(await listed(page), ['old_friend', 'natgeo', 'href.only', 'dave', 'bob.smith', 'alice']);
  await page.selectOption('#sort', 'newest');
  assert.deepEqual(await listed(page), ['href.only', 'old_friend', 'natgeo', 'dave', 'bob.smith', 'alice']);
  await page.selectOption('#sort', 'oldest');
  assert.deepEqual(await listed(page), ['alice', 'bob.smith', 'dave', 'natgeo', 'old_friend', 'href.only']);
  assert.match(await page.textContent('#list .row .date'), /^You followed /);
  await page.close();
});

test('loose JSON files upload gives the same results', async () => {
  const { page, problems } = await openApp();
  await page.setInputFiles('#file-input', ['followers_1.json', 'followers_2.json', 'following.json'].map((f) => path.join(FF_DIR, f)));
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual(await stats(page), EXPECTED_STATS);
  assert.deepEqual(await listed(page), ['href.only', 'natgeo', 'old_friend']);
  assert.deepEqual(problems, []);
  await page.close();
});

test('unzipped folder upload gives the same results', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#folder-input', EXPORT_DIR);
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual(await stats(page), EXPECTED_STATS);
  await page.close();
});

test('missing following.json shows an error and stays on the upload screen', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#file-input', path.join(FF_DIR, 'followers_1.json'));
  await page.waitForSelector('.message.error');
  assert.match(await page.textContent('.message.error'), /No following file found/);
  assert.equal(await page.isHidden('#results'), true);

  // Unrelated files: friendly error.
  await page.setInputFiles('#file-input', path.join(FF_DIR, 'following_hashtags.json'));
  await page.waitForFunction(() => /Couldn't find/.test(document.querySelector('.message.error')?.textContent));
  await page.close();
});

test('start over returns to the upload screen', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForSelector('#results:not([hidden])');
  await page.click('#reset');
  assert.equal(await page.isVisible('#upload'), true);
  assert.equal(await page.isHidden('#results'), true);
  // And a second upload still works.
  await page.setInputFiles('#file-input', zipPath);
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual(await stats(page), EXPECTED_STATS);
  await page.close();
});

test('large lists are paged with "Show more"', async () => {
  const { page } = await openApp();
  const N = 450;
  const followers = [{ string_list_data: [{ value: 'someone' }] }];
  const following = Array.from({ length: N }, (_, i) => ({ title: `acct${String(i).padStart(3, '0')}`, string_list_data: [{ timestamp: 1600000000 + i }] }));
  await page.setInputFiles('#file-input', [
    { name: 'followers_1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(followers)) },
    { name: 'following.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relationships_following: following })) },
  ]);
  await page.waitForSelector('#results:not([hidden])');
  assert.equal(await page.textContent('#stat-nfb'), '450');
  assert.equal((await listed(page)).length, 200);
  assert.equal(await page.textContent('#more'), 'Show 200 more (250 left)');
  await page.click('#more');
  await page.click('#more');
  assert.equal((await listed(page)).length, 450);
  assert.equal(await page.isHidden('#more'), true);
  await page.close();
});
