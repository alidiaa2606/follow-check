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

// ---------- Step 4: Review Mode ----------

const rvUser = (page) => page.textContent('#rv-username');
const rvProgress = (page) => page.evaluate(() => Object.fromEntries(
  ['total', 'reviewed', 'remaining', 'keep', 'ignore', 'unavailable'].map((k) => [k, Number(document.getElementById(`rv-${k}`).textContent)])));

/** Never hit the real Instagram in tests: answer profile URLs with a local stub page. */
async function stubInstagram(context) {
  await context.route('https://www.instagram.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>stub profile</p>' }));
}
/** Run `action` and return the URL of the tab it opens. */
async function openedUrl(page, action) {
  const [popup] = await Promise.all([page.context().waitForEvent('page'), action()]);
  const url = popup.url() === 'about:blank' ? (await popup.waitForURL(/instagram/), popup.url()) : popup.url();
  await popup.close();
  return url;
}

test('review mode: start, tag with buttons, auto-advance, progress, finish', async () => {
  const { page, problems } = await openApp();
  await upload(page, zipPath);
  assert.equal(await page.textContent('#review-start'), 'Start review');
  assert.match(await page.textContent('#review-launch-status'), /3 unreviewed accounts one at a time\. 0 \/ 3 reviewed/);

  await page.click('#review-start');
  assert.equal(await page.isVisible('#review'), true);
  assert.equal(await page.isHidden('#results'), true);
  assert.equal(await rvUser(page), '@href.only');
  assert.equal(await page.textContent('#rv-position'), 'Account 1 of 3');
  assert.equal(await page.textContent('#rv-date'), 'You followed on Jul 22, 2023');
  assert.equal(await page.textContent('#rv-progress-text'), '0 / 3 reviewed');
  assert.deepEqual(await rvProgress(page), { total: 3, reviewed: 0, remaining: 3, keep: 0, ignore: 0, unavailable: 0 });

  await page.click('[data-review-tag=keep]');
  assert.equal(await rvUser(page), '@natgeo'); // moved on automatically
  assert.equal(await page.textContent('#rv-progress-text'), '1 / 3 reviewed');
  assert.equal(await page.textContent('#rv-percent'), '33%');
  assert.match(await page.getAttribute('#rv-seg-keep', 'style'), /width: 33\.33/);
  assert.equal(await page.getAttribute('#rv-bar', 'aria-valuenow'), '1');

  await page.click('[data-review-tag=ignore]');
  assert.equal(await rvUser(page), '@old_friend');
  await page.click('[data-review-tag=unavailable]');
  assert.equal(await page.isVisible('#rv-done'), true);
  assert.match(await page.textContent('#rv-done-text'), /Every account in “Not following back” has a tag/);
  assert.equal(await page.isHidden('#rv-review-skipped'), true);
  assert.deepEqual(await rvProgress(page), { total: 3, reviewed: 3, remaining: 0, keep: 1, ignore: 1, unavailable: 1 });
  assert.equal(await page.textContent('#rv-percent'), '100%');

  // Back to the Step 3 list: same tags, same counts.
  await page.click('#rv-done-exit');
  assert.equal(await page.isVisible('#results'), true);
  assert.equal(await tagOf(page, 'href.only'), 'keep');
  assert.equal(await tagOf(page, 'natgeo'), 'ignore');
  assert.equal(await tagOf(page, 'old_friend'), 'unavailable');
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 0, keep: 1, ignore: 1, unavailable: 1 });
  assert.equal(await page.textContent('#stat-reviewed'), '3');
  assert.equal(await page.textContent('#review-start'), 'Open review');
  assert.deepEqual(problems, []);
  await page.close();
});

test('review mode: skip, previous, undo, and reviewing skipped accounts', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  await page.click('#review-start');
  assert.equal(await page.isDisabled('#rv-prev'), true);
  assert.equal(await page.isDisabled('#rv-undo'), true);

  await page.click('#rv-skip');
  assert.equal(await rvUser(page), '@natgeo');
  assert.equal((await rvProgress(page)).reviewed, 0); // skip doesn't tag

  await page.click('#rv-prev');
  assert.equal(await rvUser(page), '@href.only');
  assert.equal(await page.isDisabled('#rv-prev'), true);
  await page.click('[data-review-tag=keep]');
  assert.equal(await rvUser(page), '@natgeo');

  // Previous onto a tagged account shows its tag and allows changing it.
  await page.click('#rv-prev');
  assert.equal(await rvUser(page), '@href.only');
  assert.match(await page.textContent('#rv-current-tag'), /Currently tagged Keep/);
  assert.equal(await page.getAttribute('[data-review-tag=keep]', 'aria-pressed'), 'true');
  await page.click('[data-review-tag=ignore]');
  assert.equal(await rvUser(page), '@natgeo');
  assert.deepEqual(await rvProgress(page), { total: 3, reviewed: 1, remaining: 2, keep: 0, ignore: 1, unavailable: 0 });

  // Undo, step by step.
  await page.click('#rv-skip'); // natgeo -> old_friend
  assert.equal(await rvUser(page), '@old_friend');
  await page.click('#rv-undo'); // undo skip
  assert.equal(await rvUser(page), '@natgeo');
  await page.click('#rv-undo'); // undo keep -> ignore change
  assert.equal(await rvUser(page), '@href.only');
  assert.match(await page.textContent('#rv-current-tag'), /Currently tagged Keep/);
  await page.click('#rv-undo'); // undo the first keep
  assert.equal(await page.isHidden('#rv-current-tag'), true);
  assert.equal((await rvProgress(page)).reviewed, 0);
  assert.equal(await page.isDisabled('#rv-undo'), false); // the very first Skip is still undoable
  await page.click('#rv-undo');
  assert.equal(await rvUser(page), '@href.only');
  assert.equal(await page.isDisabled('#rv-undo'), true);

  // Skip everything, then review the skipped ones.
  await page.click('#rv-skip');
  await page.click('#rv-skip');
  await page.click('#rv-skip');
  assert.equal(await page.isVisible('#rv-done'), true);
  assert.match(await page.textContent('#rv-done-text'), /except the 3 you skipped/);
  assert.equal(await page.textContent('#rv-review-skipped'), 'Review 3 skipped accounts');
  await page.click('#rv-review-skipped');
  assert.equal(await rvUser(page), '@href.only');
  await page.close();
});

test('review mode: keyboard shortcuts', async () => {
  const { page, problems } = await openApp();
  await stubInstagram(page.context());
  await upload(page, zipPath);
  await page.click('#review-start');
  assert.equal(await page.isVisible('#rv-shortcuts'), true);
  assert.match(await page.textContent('#rv-shortcuts'), /K\s*Keep.*I\s*Ignore.*U\s*Unavailable.*S\s*Skip.*Previous.*Z\s*Undo.*Enter\s*\/\s*O\s*Open profile.*Esc\s*Exit/s);

  await page.keyboard.press('k');
  assert.equal(await rvUser(page), '@natgeo');
  await page.keyboard.press('i');
  assert.equal(await rvUser(page), '@old_friend');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await rvUser(page), '@natgeo');
  await page.keyboard.press('u'); // change natgeo: ignore -> unavailable
  assert.equal(await rvUser(page), '@old_friend');
  await page.keyboard.press('s');
  assert.equal(await page.isVisible('#rv-done'), true);
  await page.keyboard.press('z'); // undo skip
  assert.equal(await rvUser(page), '@old_friend');
  await page.keyboard.press('Control+z'); // undo natgeo change
  assert.equal(await rvUser(page), '@natgeo');
  assert.match(await page.textContent('#rv-current-tag'), /Currently tagged Ignore/);
  await page.keyboard.press('Shift+K'); // capital letters work too: natgeo ignore -> keep
  assert.equal(await rvUser(page), '@old_friend');
  assert.deepEqual(await rvProgress(page), { total: 3, reviewed: 2, remaining: 1, keep: 2, ignore: 0, unavailable: 0 });

  assert.equal(await openedUrl(page, () => page.keyboard.press('o')), 'https://www.instagram.com/old_friend/');
  assert.equal(await openedUrl(page, () => page.keyboard.press('Enter')), 'https://www.instagram.com/old_friend/');
  assert.equal(await rvUser(page), '@old_friend'); // opening doesn't tag or move

  // After a mouse click on a tag button, Enter opens the next profile (not a second tag).
  await page.click('[data-review-tag=unavailable]');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await rvUser(page), '@old_friend');
  await page.click('#rv-skip'); // focus returns to the card
  await page.keyboard.press('ArrowLeft');
  assert.equal(await openedUrl(page, () => page.keyboard.press('Enter')), 'https://www.instagram.com/old_friend/');

  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#results'), true);
  assert.deepEqual(await filterCounts(page), { all: 3, unreviewed: 0, keep: 2, ignore: 0, unavailable: 1 });
  assert.equal(await tagOf(page, 'old_friend'), 'unavailable');
  // Review shortcuts are off in the list view: typing k in search just types.
  await page.click('#search');
  await page.keyboard.type('k');
  assert.equal(await page.inputValue('#search'), 'k');
  assert.deepEqual(problems, []);
  await page.close();
});

test('review mode: "Open Instagram profile" is a plain link to the right URL in a new tab', async () => {
  const { page } = await openApp();
  await stubInstagram(page.context());
  await upload(page, zipPath);
  await page.click('#review-start');
  assert.equal(await page.getAttribute('#rv-open', 'href'), 'https://www.instagram.com/href.only/');
  assert.equal(await page.getAttribute('#rv-open', 'target'), '_blank');
  assert.match(await page.getAttribute('#rv-open', 'rel'), /noopener/);
  assert.equal(await openedUrl(page, () => page.click('#rv-open')), 'https://www.instagram.com/href.only/');
  await page.click('[data-review-tag=keep]');
  assert.equal(await page.getAttribute('#rv-open', 'href'), 'https://www.instagram.com/natgeo/');
  await page.close();
});

test('review mode: accounts tagged in the list view are not in the review queue', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@href.only');
  await page.click('[data-review-tag=ignore]');
  assert.equal(await rvUser(page), '@old_friend'); // natgeo skipped over
  assert.equal((await rvProgress(page)).reviewed, 2);
  await page.close();
});

test('review mode: resume after exiting, after reloading, and after restarting the browser', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-review-'));
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE, locale: 'en-US', timezoneId: 'UTC' });
  const open = async (context) => {
    const page = await context.newPage();
    await page.goto(APP_URL);
    await upload(page, zipPath);
    return page;
  };

  let context = await launch();
  let page = await open(context);
  await page.click('#review-start');
  await page.keyboard.press('k'); // href.only
  await page.keyboard.press('s'); // skip natgeo
  assert.equal(await rvUser(page), '@old_friend');

  // Leave and come back.
  await page.click('#rv-exit');
  assert.equal(await page.textContent('#review-start'), 'Resume review');
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@old_friend');

  // Reload the page.
  await page.reload();
  await upload(page, zipPath);
  assert.equal(await page.textContent('#review-start'), 'Resume review');
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@old_friend');
  await context.close();

  // Quit and restart the browser.
  context = await launch();
  page = await open(context);
  assert.equal(await page.textContent('#review-start'), 'Resume review');
  assert.match(await page.textContent('#review-launch-status'), /1 \/ 3 reviewed/);
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@old_friend');
  await page.keyboard.press('u');
  assert.match(await page.textContent('#rv-done-text'), /except the 1 you skipped/); // natgeo still skipped
  assert.deepEqual(await rvProgress(page), { total: 3, reviewed: 2, remaining: 1, keep: 1, ignore: 0, unavailable: 1 });
  await context.close();
});

test('review mode: newer export keeps review progress by username', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  await page.click('#review-start');
  await page.keyboard.press('i'); // href.only ignored
  await page.keyboard.press('Escape');
  await page.click('#reset');
  await upload(page, zip2Path); // NFB: brand_new, href.only
  assert.equal(await page.textContent('#review-start'), 'Resume review');
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@brand_new');
  assert.deepEqual(await rvProgress(page), { total: 2, reviewed: 1, remaining: 1, keep: 0, ignore: 1, unavailable: 0 });
  await page.close();
});

test('review mode on mobile and in dark mode', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme, locale: 'en-US', timezoneId: 'UTC' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL);
    await upload(page, zipPath);
    await page.tap('#review-start');
    assert.equal(await rvUser(page), '@href.only');
    await page.tap('[data-review-tag=keep]');
    assert.equal(await rvUser(page), '@natgeo');
    await page.tap('#rv-undo');
    assert.equal(await rvUser(page), '@href.only');
    const layout = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      shortcutsShown: getComputedStyle(document.getElementById('rv-shortcuts')).display !== 'none',
      buttons: [...document.querySelectorAll('.rv-choice')].map((b) => b.getBoundingClientRect()).every((r) => r.right <= innerWidth && r.height >= 44),
    }));
    assert.deepEqual(layout, { overflow: false, shortcutsShown: false, buttons: true }, colorScheme);
    assert.deepEqual(errors, []);
    await context.close();
  }
});

// ---------- Step 4: checkboxes, bulk actions, sorting ----------

// Fake export: 8 accounts don't follow back (follow dates not in name order), 1 mutual.
const BULK_NFB = ['ann', 'bea', 'cal', 'dee', 'eli', 'fay', 'gus', 'hal'];
const BULK_DATES = { ann: 5, bea: 2, cal: 8, dee: 1, eli: 7, fay: 3, gus: 6, hal: 4 }; // days
async function uploadBulkExport(page) {
  const following = [...BULK_NFB, 'mia'].map((u) => ({ title: u, string_list_data: [{ timestamp: 1700000000 + (BULK_DATES[u] || 0) * 86400 }] }));
  await page.setInputFiles('#file-input', [
    { name: 'followers_1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ string_list_data: [{ value: 'mia' }] }])) },
    { name: 'following.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relationships_following: following })) },
  ]);
  await page.waitForSelector('#results:not([hidden])');
}
const check = (page, u) => page.check(`#list .row[data-username="${u}"] input.select`);
const uncheck = (page, u) => page.uncheck(`#list .row[data-username="${u}"] input.select`);
const selectedRows = (page) => page.$$eval('#list .row input.select:checked', (els) => els.map((e) => e.closest('.row').dataset.username));
/** Read every tag straight from the saved data, so hidden rows are checked too. */
const savedTags = (page) => page.evaluate(() => {
  const data = JSON.parse(localStorage.getItem('followcheck.tags.v1') || '{"tags":{}}');
  return Object.fromEntries(Object.entries(data.tags).map(([u, v]) => [u, v.tag]));
});
async function bulk(page, action) {
  await page.click(`[data-bulk=${action}]`);
  await page.waitForSelector('#confirm[open]');
}
/** Press the confirm button and wait until the bulk change has been applied (its toast appears). */
async function confirmOk(page) {
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.click('#confirm-ok');
  await page.waitForSelector('#toast:not([hidden])');
}
/** After cancelling, give the page time to (wrongly) apply anything before checking nothing changed. */
const settle = (page) => page.waitForTimeout(150);

test('bulk: individual checkbox selection', async () => {
  const { page, problems } = await openApp();
  await uploadBulkExport(page);
  assert.equal(await page.textContent('#selected-count'), '0 selected');
  for (const action of ['keep', 'ignore', 'unavailable', 'clear']) assert.equal(await page.isDisabled(`[data-bulk=${action}]`), true);

  await check(page, 'ann');
  await check(page, 'cal');
  assert.equal(await page.textContent('#selected-count'), '2 selected');
  assert.deepEqual(await selectedRows(page), ['ann', 'cal']);
  assert.equal(await page.getAttribute('.row[data-username=cal]', 'class'), 'row selected');
  assert.equal(await page.isEnabled('[data-bulk=keep]'), true);
  await uncheck(page, 'cal');
  assert.equal(await page.textContent('#selected-count'), '1 selected');
  assert.equal(await page.getAttribute('.row[data-username=cal]', 'class'), 'row');
  // Checkboxes only in "Not following back".
  await page.click('#tabs [data-tab=following]');
  assert.equal(await page.$('#list input.select'), null);
  assert.equal(await page.isHidden('#bulk-bar'), true);
  await page.click('#tabs [data-tab=notFollowingBack]');
  assert.deepEqual(await selectedRows(page), ['ann']); // selection kept
  assert.deepEqual(problems, []);
  await page.close();
});

test('bulk: select all visible and deselect all', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  assert.equal(await page.textContent('#select-visible'), 'Select all visible (8)');
  assert.equal(await page.isDisabled('#select-none'), true);
  await page.click('#select-visible');
  assert.deepEqual(await selectedRows(page), BULK_NFB);
  assert.equal(await page.textContent('#selected-count'), '8 selected');
  assert.equal(await page.isDisabled('#select-visible'), true); // everything visible is already selected
  await page.click('#select-none');
  assert.deepEqual(await selectedRows(page), []);
  assert.equal(await page.textContent('#selected-count'), '0 selected');
  assert.deepEqual(await savedTags(page), {}); // selecting never tags
  await page.close();
});

test('bulk: selection + search selects only matching accounts', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await page.fill('#search', 'a'); // ann, bea, cal, fay, hal
  assert.equal(await page.textContent('#select-visible'), 'Select all visible (5)');
  await page.click('#select-visible');
  assert.equal(await page.textContent('#selected-count'), '5 selected');
  await page.fill('#search', '');
  assert.deepEqual(await selectedRows(page), ['ann', 'bea', 'cal', 'fay', 'hal']);
  await bulk(page, 'ignore');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 5 accounts as Ignore?');
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'ignore', bea: 'ignore', cal: 'ignore', fay: 'ignore', hal: 'ignore' });
  await page.close();
});

test('bulk: selection + tag filters', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await clickTag(page, 'dee', 'keep');
  await clickTag(page, 'gus', 'keep');
  await page.click('#filters [data-filter=keep]');
  assert.equal(await page.textContent('#select-visible'), 'Select all visible (2)');
  await page.click('#select-visible');
  await bulk(page, 'unavailable');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 2 accounts as Unavailable?');
  assert.match(await page.textContent('#confirm-detail'), /Right now: 2 Keep\./);
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { dee: 'unavailable', gus: 'unavailable' });
  assert.deepEqual(await listed(page), []); // they left the Keep filter
  await page.click('#filters [data-filter=unreviewed]');
  await page.click('#select-visible');
  assert.equal(await page.textContent('#selected-count'), '6 selected');
  await page.close();
});

test('bulk: sorting (all options) works with search, filters and selection', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  const options = await page.$$eval('#sort option', (os) => os.map((o) => [o.value, o.textContent]));
  assert.deepEqual(options, [
    ['az', 'Username A–Z'], ['za', 'Username Z–A'], ['newest', 'Followed: newest first'],
    ['oldest', 'Followed: oldest first'], ['unreviewed', 'Unreviewed first'], ['reviewed', 'Reviewed first'],
  ]);
  await clickTag(page, 'eli', 'keep');
  await clickTag(page, 'bea', 'ignore');

  await page.selectOption('#sort', 'za');
  assert.deepEqual(await listed(page), [...BULK_NFB].reverse());
  await page.selectOption('#sort', 'newest');
  assert.deepEqual(await listed(page), ['cal', 'eli', 'gus', 'ann', 'hal', 'fay', 'bea', 'dee']);
  await page.selectOption('#sort', 'oldest');
  assert.deepEqual(await listed(page), ['dee', 'bea', 'fay', 'hal', 'ann', 'gus', 'eli', 'cal']);
  await page.selectOption('#sort', 'unreviewed');
  assert.deepEqual(await listed(page), ['ann', 'cal', 'dee', 'fay', 'gus', 'hal', 'bea', 'eli']);
  await page.selectOption('#sort', 'reviewed');
  assert.deepEqual(await listed(page), ['bea', 'eli', 'ann', 'cal', 'dee', 'fay', 'gus', 'hal']);

  // Sort + search + filter together.
  await page.selectOption('#sort', 'newest');
  await page.click('#filters [data-filter=unreviewed]');
  await page.fill('#search', 'a'); // unreviewed containing "a": ann, cal, fay, hal
  assert.deepEqual(await listed(page), ['cal', 'ann', 'hal', 'fay']);

  // Selecting in a sorted view picks the right accounts.
  await check(page, 'hal');
  await page.click('#select-visible');
  assert.deepEqual((await selectedRows(page)).sort(), ['ann', 'cal', 'fay', 'hal']);
  await bulk(page, 'keep');
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'keep', bea: 'ignore', cal: 'keep', eli: 'keep', fay: 'keep', hal: 'keep' });
  await page.close();
});

test('bulk: Keep, Ignore, Unavailable and Clear, each confirmed, with undo', async () => {
  const { page, problems } = await openApp();
  await uploadBulkExport(page);
  for (const u of ['ann', 'bea', 'cal']) await check(page, u);

  await bulk(page, 'keep');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 3 accounts as Keep?');
  assert.equal(await page.textContent('#confirm-detail'), 'Right now: 3 unreviewed. Nothing changes until you confirm.');
  assert.equal(await page.textContent('#confirm-ok'), 'Mark 3 accounts as Keep');
  assert.deepEqual(await savedTags(page), {}); // nothing yet while the dialog is open
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'keep', bea: 'keep', cal: 'keep' });
  assert.equal(await page.textContent('#toast-text'), 'Marked 3 accounts as Keep');
  assert.equal(await page.textContent('#selected-count'), '0 selected'); // selection cleared after applying
  assert.deepEqual(await filterCounts(page), { all: 8, unreviewed: 5, keep: 3, ignore: 0, unavailable: 0 });

  for (const u of ['ann', 'bea', 'cal', 'dee']) await check(page, u);
  await bulk(page, 'ignore');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 4 accounts as Ignore?');
  assert.match(await page.textContent('#confirm-detail'), /Right now: 1 unreviewed, 3 Keep\./);
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'ignore', bea: 'ignore', cal: 'ignore', dee: 'ignore' });

  await check(page, 'ann');
  await check(page, 'eli');
  await bulk(page, 'unavailable');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 2 accounts as Unavailable?');
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'unavailable', bea: 'ignore', cal: 'ignore', dee: 'ignore', eli: 'unavailable' });

  await page.click('#select-visible');
  await bulk(page, 'clear');
  assert.equal(await page.textContent('#confirm-title'), 'Clear tags from 8 accounts?');
  assert.match(await page.textContent('#confirm-detail'), /3 unreviewed, 3 Ignore, 2 Unavailable/);
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), {});
  assert.equal(await page.textContent('#toast-text'), 'Cleared tags from 8 accounts');

  // Undo the clear: every previous tag comes back.
  await page.click('#toast-undo');
  assert.deepEqual(await savedTags(page), { ann: 'unavailable', bea: 'ignore', cal: 'ignore', dee: 'ignore', eli: 'unavailable' });

  // Bulk results survive a reload.
  await page.reload();
  await uploadBulkExport(page);
  assert.equal(await tagOf(page, 'eli'), 'unavailable');
  assert.deepEqual(problems, []);
  await page.close();
});

test('bulk: cancelling the confirmation changes nothing (button and Esc)', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await clickTag(page, 'hal', 'keep');
  for (const u of ['ann', 'bea', 'hal']) await check(page, u);

  await bulk(page, 'ignore');
  await page.click('#confirm-cancel');
  await settle(page);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.deepEqual(await savedTags(page), { hal: 'keep' });
  assert.deepEqual(await selectedRows(page), ['ann', 'bea', 'hal']); // selection kept so you can try again

  await bulk(page, 'clear');
  await page.keyboard.press('Escape');
  await settle(page);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.deepEqual(await savedTags(page), { hal: 'keep' });

  // Cancel is focused by default, so Enter cancels too.
  await bulk(page, 'unavailable');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-cancel');
  await page.keyboard.press('Enter');
  await settle(page);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.deepEqual(await savedTags(page), { hal: 'keep' });
  await page.reload();
  await uploadBulkExport(page);
  assert.deepEqual(await savedTags(page), { hal: 'keep' });
  await page.close();
});

test('bulk: hidden or filtered-out accounts are never changed unless explicitly selected', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await check(page, 'ann'); // explicitly selected, then hidden by a search
  await page.fill('#search', 'dee');
  assert.equal(await page.textContent('#selected-count'), '1 selected · 1 not visible');
  assert.match(await page.textContent('#bulk-note'), /1 selected account isn't visible with the current search or filter/);
  await page.click('#select-visible'); // adds only dee
  assert.equal(await page.textContent('#selected-count'), '2 selected · 1 not visible');
  await bulk(page, 'keep');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 2 accounts as Keep?');
  assert.equal(await page.textContent('#confirm-hidden'), '1 of these accounts is selected but not visible with the current search or filter.');
  await confirmOk(page);
  assert.deepEqual(await savedTags(page), { ann: 'keep', dee: 'keep' }); // the other 6 hidden accounts untouched
  await page.close();
});

test('bulk: "select all visible" with a long list only selects the rows on screen', async () => {
  const { page } = await openApp();
  const N = 450;
  const following = Array.from({ length: N }, (_, i) => ({ title: `acct${String(i).padStart(3, '0')}`, string_list_data: [{ timestamp: 1600000000 + i }] }));
  await page.setInputFiles('#file-input', [
    { name: 'followers_1.json', mimeType: 'application/json', buffer: Buffer.from('[]') },
    { name: 'following.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relationships_following: following })) },
  ]);
  await page.waitForSelector('#results:not([hidden])');
  assert.equal(await page.textContent('#select-visible'), 'Select all visible (200)');
  assert.match(await page.textContent('#bulk-note'), /only selects the 200 accounts on screen/);
  await page.click('#select-visible');
  await bulk(page, 'ignore');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 200 accounts as Ignore?');
  await confirmOk(page);
  const tagsNow = await savedTags(page);
  assert.equal(Object.keys(tagsNow).length, 200);
  assert.ok(Object.keys(tagsNow).every((u) => u < 'acct200'));
  assert.deepEqual(await filterCounts(page), { all: 450, unreviewed: 250, keep: 0, ignore: 200, unavailable: 0 });
  await page.close();
});

test('bulk: Review Mode still works after bulk changes', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  for (const u of ['ann', 'bea', 'cal']) await check(page, u);
  await bulk(page, 'keep');
  await confirmOk(page);
  await page.click('#review-start');
  assert.equal(await rvUser(page), '@dee'); // bulk-tagged accounts are out of the queue
  assert.deepEqual(await rvProgress(page), { total: 8, reviewed: 3, remaining: 5, keep: 3, ignore: 0, unavailable: 0 });
  await page.keyboard.press('i');
  assert.equal(await rvUser(page), '@eli');
  await page.keyboard.press('Escape');
  assert.equal(await tagOf(page, 'dee'), 'ignore');
  await page.close();
});

test('bulk: desktop, mobile and dark mode layouts', async () => {
  const setups = [
    { viewport: { width: 1100, height: 900 } },
    { viewport: { width: 1100, height: 900 }, colorScheme: 'dark' },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' },
  ];
  for (const opts of setups) {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', ...opts });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL);
    await uploadBulkExport(page);
    await check(page, 'ann');
    await check(page, 'bea');
    await bulk(page, 'ignore');
    const layout = await page.evaluate(() => {
      const r = document.getElementById('confirm').getBoundingClientRect();
      const inside = (el) => { const b = el.getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth; };
      return {
        overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        dialogFits: r.left >= 0 && r.right <= innerWidth,
        bulkButtonsFit: [...document.querySelectorAll('[data-bulk]')].every(inside),
        checkboxesFit: [...document.querySelectorAll('#list input.select')].every(inside),
      };
    });
    assert.deepEqual(layout, { overflow: false, dialogFits: true, bulkButtonsFit: true, checkboxesFit: true }, JSON.stringify(opts));
    await confirmOk(page);
    assert.deepEqual(await savedTags(page), { ann: 'ignore', bea: 'ignore' });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
