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
let zip2Path;
const EXPORT_2_DIR = path.join(__dirname, 'fixtures', 'sample-export-2');
const ZIP_DATE = new Date(2026, 8, 27, 9, 8); // shown in the app as the export date

/** Build a ZIP shaped like Instagram's download from a sample export folder. */
async function buildZip(exportDir, fileName) {
  const dir = path.join(exportDir, 'connections', 'followers_and_following');
  const zip = new JSZip();
  for (const name of fs.readdirSync(dir)) {
    zip.file(`connections/followers_and_following/${name}`, fs.readFileSync(path.join(dir, name)), { date: ZIP_DATE });
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-')), fileName);
  fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer' }));
  return out;
}

test.before(async () => {
  browser = await chromium.launch({ executablePath: EXECUTABLE });
  zipPath = await buildZip(EXPORT_DIR, 'instagram-export.zip');
  zip2Path = await buildZip(EXPORT_2_DIR, 'instagram-export-newer.zip');
});
test.after(() => browser && browser.close());

/** Open the app and record console errors and any non-file:// requests. */
async function openApp(context) {
  const page = await (context || browser).newPage(context ? undefined : { locale: 'en-US', timezoneId: 'UTC' });
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
  assert.equal(await page.textContent('#list-summary'), '1 of 3 accounts match “nat”');

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

// ---------- Step 3: Keep / Ignore / Unavailable ----------

const tagOf = (page, u) => page.getAttribute(`#list .row[data-username="${u}"]`, 'data-tag');
const clickTag = (page, u, tag) => page.click(`#list .row[data-username="${u}"] [data-set-tag=${tag}]`);
const filterCounts = (page) => page.$$eval('[data-filter-count]', (els) =>
  Object.fromEntries(els.map((e) => [e.dataset.filterCount, Number(e.textContent)])));
async function upload(page, file) {
  await page.setInputFiles('#file-input', file);
  await page.waitForSelector('#results:not([hidden])');
}

test('tag accounts Keep / Ignore / Unavailable, change a tag, remove it, undo', async () => {
  const { page, problems } = await openApp();
  await upload(page, zipPath);
  assert.equal(await page.isVisible('#filters'), true);
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 3, keep: 0, ignore: 0, unavailable: 0 });
  assert.equal(await page.textContent('#stat-reviewed'), '0');

  await clickTag(page, 'natgeo', 'keep');
  assert.equal(await tagOf(page, 'natgeo'), 'keep');
  assert.equal(await page.getAttribute('.row[data-username=natgeo] [data-set-tag=keep]', 'aria-pressed'), 'true');
  assert.equal(await page.textContent('#toast-text'), '@natgeo tagged Keep');

  await clickTag(page, 'old_friend', 'unavailable');
  await clickTag(page, 'href.only', 'ignore');
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 0, keep: 1, ignore: 1, unavailable: 1 });
  assert.equal(await page.textContent('#stat-reviewed'), '3');
  assert.equal(await page.textContent('#stat-breakdown'), '1 keep · 1 ignore · 1 unavailable');

  // Change a tag.
  await clickTag(page, 'natgeo', 'ignore');
  assert.equal(await tagOf(page, 'natgeo'), 'ignore');
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 0, keep: 0, ignore: 2, unavailable: 1 });

  // Clicking the active tag removes it.
  await clickTag(page, 'natgeo', 'ignore');
  assert.equal(await tagOf(page, 'natgeo'), null);
  assert.equal(await page.textContent('#toast-text'), 'Removed tag from @natgeo');
  assert.equal(await page.textContent('#stat-reviewed'), '2');

  // Undo brings it back.
  await page.click('#toast-undo');
  assert.equal(await tagOf(page, 'natgeo'), 'ignore');
  assert.equal(await page.isHidden('#toast'), true);
  assert.equal(await page.isHidden('#storage-warning'), true);
  assert.deepEqual(problems, []);
  await page.close();
});

test('tag filters combine with search and sorting', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  await clickTag(page, 'old_friend', 'keep');
  await clickTag(page, 'href.only', 'ignore');

  await page.click('#filters [data-filter=keep]');
  assert.equal(await page.getAttribute('#filters [data-filter=keep]', 'aria-pressed'), 'true');
  assert.deepEqual(await listed(page), ['natgeo', 'old_friend']);
  assert.equal(await page.textContent('#list-summary'), '2 accounts · Keep');

  await page.fill('#search', 'old');
  assert.deepEqual(await listed(page), ['old_friend']);
  assert.equal(await page.textContent('#list-summary'), '1 of 2 accounts match “old” · Keep');
  await page.fill('#search', '');

  await page.selectOption('#sort', 'za');
  assert.deepEqual(await listed(page), ['old_friend', 'natgeo']);
  await page.selectOption('#sort', 'az');

  await page.click('#filters [data-filter=unreviewed]');
  assert.deepEqual(await listed(page), []);
  assert.match(await page.textContent('#list .empty'), /Nothing left to review/);

  await page.click('#filters [data-filter=all]');
  assert.deepEqual(await listed(page), ['href.only', 'natgeo', 'old_friend']);

  // Retagging inside a filtered view moves the account out of it.
  await page.click('#filters [data-filter=ignore]');
  assert.deepEqual(await listed(page), ['href.only']);
  await clickTag(page, 'href.only', 'unavailable');
  assert.deepEqual(await listed(page), []);
  assert.match(await page.textContent('#list .empty'), /No accounts tagged Ignore yet/);
  await page.click('#filters [data-filter=unavailable]');
  assert.deepEqual(await listed(page), ['href.only']);

  // Other tabs: no filters or buttons, but tags show as badges.
  await page.click('#tabs [data-tab=following]');
  assert.equal(await page.isHidden('#filters'), true);
  assert.equal(await page.$('#list [data-set-tag]'), null);
  assert.equal(await page.textContent('.row[data-username=natgeo] .badge'), 'Keep');
  assert.equal((await listed(page)).length, 6); // tag filter doesn't apply here
  await page.close();
});

test('tags persist after reloading and after closing and reopening the tab', async () => {
  const context = await browser.newContext();
  let { page } = await openApp(context);
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  await clickTag(page, 'old_friend', 'unavailable');
  await clickTag(page, 'href.only', 'ignore');

  await page.reload();
  await upload(page, zipPath);
  assert.equal(await tagOf(page, 'natgeo'), 'keep');
  assert.equal(await tagOf(page, 'old_friend'), 'unavailable');
  assert.equal(await tagOf(page, 'href.only'), 'ignore');

  await page.close();
  ({ page } = await openApp(context));
  await upload(page, zipPath);
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 0, keep: 1, ignore: 1, unavailable: 1 });
  await context.close();
});

test('tags persist after fully quitting and restarting the browser', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-profile-'));
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE });

  let context = await launch();
  let page = await context.newPage();
  await page.goto(APP_URL);
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  await clickTag(page, 'old_friend', 'unavailable');
  await context.close();

  context = await launch();
  page = await context.newPage();
  await page.goto(APP_URL);
  await upload(page, zipPath);
  assert.equal(await tagOf(page, 'natgeo'), 'keep');
  assert.equal(await tagOf(page, 'old_friend'), 'unavailable');
  assert.equal(await tagOf(page, 'href.only'), null);
  await context.close();
});

test('uploading a newer export keeps existing tags', async () => {
  const { page, problems } = await openApp();
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  await clickTag(page, 'old_friend', 'unavailable');
  await clickTag(page, 'href.only', 'ignore');

  // Newer export: old_friend unfollowed, natgeo now follows back, brand_new followed.
  await page.click('#reset');
  await upload(page, zip2Path);
  assert.deepEqual(await stats(page), { followers: '7', following: '6', nfb: '2', mutual: '4', fans: '3' });
  assert.deepEqual(await listed(page), ['brand_new', 'href.only']);
  assert.equal(await tagOf(page, 'href.only'), 'ignore');
  assert.equal(await tagOf(page, 'brand_new'), null);
  assert.deepEqual(await filterCounts(page), { all: 2, unreviewed: 1, keep: 0, ignore: 1, unavailable: 0 });
  assert.match(await page.textContent('#sources'), /2 saved tags are for accounts not in this “Not following back” list/);
  await page.click('#tabs [data-tab=mutual]');
  assert.equal(await page.textContent('.row[data-username=natgeo] .badge'), 'Keep');

  // Going back to the older export: the tags for missing accounts were kept.
  await page.reload();
  await upload(page, zipPath);
  assert.equal(await tagOf(page, 'natgeo'), 'keep');
  assert.equal(await tagOf(page, 'old_friend'), 'unavailable');
  assert.equal(await tagOf(page, 'href.only'), 'ignore');
  assert.deepEqual(problems, []);
  await page.close();
});

test('data note explains export vs live counts and shows the data date', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  const note = await page.textContent('#data-note');
  assert.match(note, /come from your Instagram export, not your live profile/);
  assert.match(note, /deactivated/);
  assert.equal(await page.textContent('#data-date'),
    'Export created Sep 27, 2026. Newest activity in the data: Nov 14, 2023.');

  // Loose JSON files carry no export date: only the newest activity is shown.
  await page.click('#reset');
  await upload(page, ['followers_1.json', 'followers_2.json', 'following.json'].map((f) => path.join(FF_DIR, f)));
  assert.equal(await page.textContent('#data-date'), 'Newest activity in the data: Nov 14, 2023.');
  await page.close();
});
