// Browser test for the upload page. Needs Playwright + Chromium; skipped otherwise.
//   npm install && npx playwright install chromium   (or point NODE_PATH at an install)
//   npm test  (or: node --test tests/*.test.js)
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
  // (Step 9: the old "1 keep · 1 ignore · 1 unavailable" line became separate dashboard tiles.)
  assert.deepEqual([await page.textContent('#stat-keep'), await page.textContent('#stat-ignore'), await page.textContent('#stat-unavailable')], ['1', '1', '1']);

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
      buttons: [...document.querySelectorAll('#review .rv-choice')].map((b) => b.getBoundingClientRect()).every((r) => r.right <= innerWidth && r.height >= 44),
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

// ---------- Step 5: Unfollow Queue (adding / removing) ----------

const savedQueue = (page) => page.evaluate(() => {
  const data = JSON.parse(localStorage.getItem('followcheck.queue.v1') || '{"entries":{}}');
  return Object.fromEntries(Object.entries(data.entries).map(([u, e]) => [u, e.status]));
});
async function queueBulk(page, action) {
  await page.click(`[data-queue-bulk=${action}]`);
  await page.waitForSelector('#confirm[open]');
}

test('queue: add one account (individual), confirmation, badge, duplicates prevented', async () => {
  const { page, problems } = await openApp();
  await uploadBulkExport(page);
  await check(page, 'cal');
  await queueBulk(page, 'add');
  assert.equal(await page.textContent('#confirm-title'), 'Add 1 account to your Unfollow Queue?');
  assert.match(await page.textContent('#confirm-detail'), /Follow Check never unfollows anyone/);
  assert.deepEqual(await savedQueue(page), {}); // nothing before confirming
  await confirmOk(page);
  assert.deepEqual(await savedQueue(page), { cal: 'pending' });
  assert.equal(await page.textContent('.row[data-username=cal] .qbadge'), 'In Unfollow Queue');
  assert.equal(await page.textContent('#toast-text'), 'Added 1 account to your Unfollow Queue');

  // Adding again: no dialog, nothing duplicated.
  await check(page, 'cal');
  await page.click('[data-queue-bulk=add]');
  await page.waitForTimeout(150);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.equal(await page.textContent('#toast-text'), 'The selected account is already in your Unfollow Queue.');
  assert.equal(await page.isHidden('#toast-undo'), true);

  // Mixed selection: only the new one is counted and added.
  await check(page, 'ann');
  await queueBulk(page, 'add');
  assert.equal(await page.textContent('#confirm-title'), 'Add 1 account to your Unfollow Queue?');
  assert.match(await page.textContent('#confirm-detail'), /1 other selected account is already queued and won't be added twice/);
  await confirmOk(page);
  assert.deepEqual(await savedQueue(page), { ann: 'pending', cal: 'pending' });
  assert.deepEqual(problems, []);
  await page.close();
});

test('queue: bulk add warns about Keep/Ignore tags; cancel changes nothing; undo', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await clickTag(page, 'bea', 'keep');
  await page.click('#select-visible');
  await queueBulk(page, 'add');
  assert.equal(await page.textContent('#confirm-title'), 'Add 8 accounts to your Unfollow Queue?');
  assert.match(await page.textContent('#confirm-detail'), /Heads up: 1 tagged Keep\./);
  await page.click('#confirm-cancel');
  await settle(page);
  assert.deepEqual(await savedQueue(page), {});
  await page.keyboard.press('Escape'); // no dialog open: harmless
  await queueBulk(page, 'add');
  await page.keyboard.press('Escape');
  await settle(page);
  assert.deepEqual(await savedQueue(page), {});

  await queueBulk(page, 'add');
  await confirmOk(page);
  assert.equal(Object.keys(await savedQueue(page)).length, 8);
  await page.click('#toast-undo');
  assert.deepEqual(await savedQueue(page), {});
  await page.close();
});

test('queue: remove selected, with confirmation; hidden accounts only if explicitly selected', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await page.click('#select-visible');
  await queueBulk(page, 'add');
  await confirmOk(page);

  await check(page, 'ann'); // explicitly selected, then hidden by search
  await page.fill('#search', 'e'); // bea, dee, eli
  await page.click('#select-visible');
  assert.equal(await page.textContent('#selected-count'), '4 selected · 1 not visible');
  await queueBulk(page, 'remove');
  assert.equal(await page.textContent('#confirm-title'), 'Remove 4 accounts from your Unfollow Queue?');
  assert.equal(await page.textContent('#confirm-hidden'), '1 of these accounts is selected but not visible with the current search or filter.');
  await confirmOk(page);
  assert.deepEqual(Object.keys(await savedQueue(page)).sort(), ['cal', 'fay', 'gus', 'hal']);

  // Removing accounts that aren't queued: no dialog, no change.
  await check(page, 'bea');
  await page.click('[data-queue-bulk=remove]');
  await page.waitForTimeout(150);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.equal(await page.textContent('#toast-text'), 'None of the selected accounts are in your Unfollow Queue.');
  await page.close();
});

test('queue: persists after reload, browser restart and uploading the export again', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-queue-'));
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE, locale: 'en-US', timezoneId: 'UTC' });
  let context = await launch();
  let page = await context.newPage();
  await page.goto(APP_URL);
  await uploadBulkExport(page);
  await check(page, 'ann');
  await check(page, 'dee');
  await queueBulk(page, 'add');
  await confirmOk(page);

  await page.reload();
  await uploadBulkExport(page);
  assert.equal(await page.textContent('.row[data-username=dee] .qbadge'), 'In Unfollow Queue');
  await page.click('#reset');
  await uploadBulkExport(page);
  assert.deepEqual(await savedQueue(page), { ann: 'pending', dee: 'pending' });
  await context.close();

  context = await launch();
  page = await context.newPage();
  await page.goto(APP_URL);
  await uploadBulkExport(page);
  assert.deepEqual(await savedQueue(page), { ann: 'pending', dee: 'pending' });
  assert.equal(await page.textContent('.row[data-username=ann] .qbadge'), 'In Unfollow Queue');
  await context.close();
});

// ---------- Step 6: Unfollow Queue workflow ----------

const qUser = (page) => page.textContent('#q-username');
const qCounts = (page) => page.evaluate(() => Object.fromEntries(
  [['total', 'q-total'], ['done', 'q-done-count'], ['remaining', 'q-remaining'], ['skipped', 'q-skipped-count']]
    .map(([k, id]) => [k, Number(document.getElementById(id).textContent)])));
/** Queue these accounts through the real UI (select + confirm). */
async function queueAccounts(page, usernames) {
  for (const u of usernames) await check(page, u);
  await queueBulk(page, 'add');
  await confirmOk(page);
}

test('queue workflow: empty queue message', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  assert.match(await page.textContent('#queue-launch-status'), /^Empty\./);
  await page.click('#queue-open');
  assert.equal(await page.isVisible('#queue'), true);
  assert.equal(await page.textContent('#q-finished-title'), 'Your Unfollow Queue is empty');
  assert.equal(await page.isDisabled('#q-prev'), true);
  await page.click('#q-finished-exit');
  assert.equal(await page.isVisible('#results'), true);
  await page.close();
});

test('queue workflow: open profile, Done, Skip, Keep instead, Previous, Undo, Exit', async () => {
  const { page, problems } = await openApp();
  await stubInstagram(page.context());
  await uploadBulkExport(page);
  await clickTag(page, 'cal', 'ignore');
  await queueAccounts(page, ['ann', 'bea', 'cal', 'dee']);
  assert.match(await page.textContent('#queue-launch-status'), /4 queued · 0 done · 4 remaining · 0 skipped/);

  await page.click('#queue-open');
  assert.equal(await qUser(page), '@ann');
  assert.equal(await page.textContent('#q-position'), 'Account 1 of 4 queued');
  assert.equal(await page.textContent('#q-date'), 'You followed on Nov 19, 2023');
  assert.match(await page.textContent('.q-disclaimer'), /never unfollows anyone/);
  assert.deepEqual(await qCounts(page), { total: 4, done: 0, remaining: 4, skipped: 0 });
  assert.equal(await page.getAttribute('#q-open', 'href'), 'https://www.instagram.com/ann/');
  assert.equal(await openedUrl(page, () => page.click('#q-open')), 'https://www.instagram.com/ann/');
  assert.equal(await qUser(page), '@ann'); // opening a profile changes nothing

  await page.click('#q-done');
  assert.equal(await qUser(page), '@bea');
  assert.equal(await page.textContent('#q-progress-text'), '1 / 4 done');
  assert.equal(await page.textContent('#q-percent'), '25%');
  await page.click('#q-skip');
  assert.equal(await qUser(page), '@cal');
  assert.equal(await page.textContent('#q-tag-note'), 'Tagged Ignore');
  await page.click('#q-keep');
  assert.equal(await qUser(page), '@dee');
  assert.deepEqual(await qCounts(page), { total: 3, done: 1, remaining: 1, skipped: 1 });
  assert.deepEqual(await savedQueue(page), { ann: 'done', bea: 'skipped', dee: 'pending' });
  assert.equal((await savedTags(page)).cal, 'keep');

  await page.click('#q-prev');
  assert.equal(await qUser(page), '@bea');
  assert.equal(await page.textContent('#q-status-note'), 'Skipped earlier');
  await page.click('#q-prev');
  assert.equal(await qUser(page), '@ann');
  assert.match(await page.textContent('#q-status-note'), /^You marked this done on /);
  assert.equal(await page.isDisabled('#q-prev'), true);

  await page.click('#q-undo'); // undo Keep instead
  assert.equal(await qUser(page), '@cal');
  assert.equal((await savedTags(page)).cal, 'ignore');
  assert.equal((await savedQueue(page)).cal, 'pending');
  await page.click('#q-undo'); // undo Skip
  assert.equal((await savedQueue(page)).bea, 'pending');
  await page.click('#q-undo'); // undo Done
  assert.deepEqual(await savedQueue(page), { ann: 'pending', bea: 'pending', cal: 'pending', dee: 'pending' });
  assert.equal(await page.isDisabled('#q-undo'), true);

  await page.click('#q-exit');
  assert.equal(await page.isVisible('#results'), true);
  assert.equal(await page.textContent('.row[data-username=ann] .qbadge'), 'In Unfollow Queue');
  assert.deepEqual(problems, []);
  await page.close();
});

test('queue workflow: finishing, skipped accounts, and keyboard shortcuts', async () => {
  const { page } = await openApp();
  await stubInstagram(page.context());
  await uploadBulkExport(page);
  await queueAccounts(page, ['ann', 'bea', 'cal']);
  await page.click('#queue-open');
  assert.equal(await page.isVisible('#q-shortcuts'), true);
  assert.match(await page.textContent('#q-shortcuts'), /D\s*Mark done.*S\s*Skip.*K\s*Keep instead.*Previous.*Z\s*Undo.*Open profile.*Esc\s*Exit/s);

  await page.keyboard.press('d');
  assert.equal(await qUser(page), '@bea');
  await page.keyboard.press('s');
  assert.equal(await qUser(page), '@cal');
  assert.equal(await openedUrl(page, () => page.keyboard.press('o')), 'https://www.instagram.com/cal/');
  assert.equal(await openedUrl(page, () => page.keyboard.press('Enter')), 'https://www.instagram.com/cal/');
  await page.keyboard.press('k');
  assert.equal(await page.textContent('#q-finished-title'), 'Nothing left to do right now');
  assert.equal(await page.textContent('#q-retry-skipped'), 'Go through 1 skipped account');
  await page.keyboard.press('z'); // undo keep instead
  assert.equal(await qUser(page), '@cal');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await qUser(page), '@bea');
  await page.keyboard.press('d'); // done on a skipped account reached via Previous
  assert.equal(await qUser(page), '@cal');
  await page.keyboard.press('d');
  assert.equal(await page.textContent('#q-finished-title'), 'Queue complete');
  assert.deepEqual(await savedQueue(page), { ann: 'done', bea: 'done', cal: 'done' });
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#results'), true);
  // Queue shortcuts are off outside the queue screen.
  await page.click('#search');
  await page.keyboard.type('d');
  assert.equal(await page.inputValue('#search'), 'd');

  // Skipped accounts can be gone through again.
  await page.fill('#search', '');
  await queueAccounts(page, ['dee']);
  await page.click('#queue-open');
  await page.keyboard.press('s');
  await page.click('#q-retry-skipped');
  assert.equal(await qUser(page), '@dee');
  await page.close();
});

test('queue workflow: resume after exit, reload and full browser restart', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-qflow-'));
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: EXECUTABLE, locale: 'en-US', timezoneId: 'UTC' });
  const open = async (context) => {
    const page = await context.newPage();
    await page.goto(APP_URL);
    await uploadBulkExport(page);
    return page;
  };
  let context = await launch();
  let page = await open(context);
  await queueAccounts(page, ['ann', 'bea', 'cal']);
  await page.click('#queue-open');
  await page.keyboard.press('d'); // ann done -> bea
  await page.click('#q-exit');
  assert.equal(await page.textContent('#queue-open'), 'Resume Unfollow Queue');
  await page.click('#queue-open');
  assert.equal(await qUser(page), '@bea');

  await page.reload();
  await uploadBulkExport(page);
  assert.equal(await page.textContent('#queue-open'), 'Resume Unfollow Queue');
  await page.click('#queue-open');
  assert.equal(await qUser(page), '@bea');
  await context.close();

  context = await launch();
  page = await open(context);
  await page.click('#queue-open');
  assert.equal(await qUser(page), '@bea');
  assert.deepEqual(await qCounts(page), { total: 3, done: 1, remaining: 2, skipped: 0 });
  await context.close();
});

test('queue workflow: accounts missing from a newer export are flagged, not dropped', async () => {
  const { page } = await openApp();
  await upload(page, zipPath); // NFB: href.only, natgeo, old_friend
  await page.click('#select-visible');
  await queueBulk(page, 'add');
  await confirmOk(page);
  await page.click('#reset');
  await upload(page, zip2Path); // NFB: brand_new, href.only (natgeo follows back; old_friend unfollowed)
  await page.click('#queue-open');
  assert.equal(await page.textContent('#q-stale'),
    "2 queued accounts aren't in the loaded export's “Not following back” list (for example accounts you've already unfollowed, or that follow you now). They stay in the queue until you remove them.");
  assert.equal(await qUser(page), '@href.only');
  await page.keyboard.press('d');
  assert.equal(await qUser(page), '@natgeo');
  assert.equal(await page.textContent('#q-date'), 'You followed on Jul 22, 2023'); // still followed (mutual now)
  await page.keyboard.press('d');
  assert.equal(await page.textContent('#q-date'), "Not in the loaded export's following list");
  await page.close();
});

// ---------- Step 7: Unfollow Queue management ----------

const qListed = (page) => page.$$eval('#q-list .row', (rows) => rows.map((r) => r.dataset.username));
const qCheck = (page, u) => page.check(`#q-list .row[data-username="${u}"] input.select`);
const qFilterCounts = (page) => page.$$eval('[data-qfilter-count]', (els) =>
  Object.fromEntries(els.map((e) => [e.dataset.qfilterCount, Number(e.textContent)])));
async function qBulk(page, action) {
  await page.click(`[data-qbulk=${action}]`);
  await page.waitForSelector('#confirm[open]');
}
/** Queue all 8 fake accounts, mark ann done and bea skipped, then open "Manage list". */
async function openManagedQueue(page) {
  await uploadBulkExport(page);
  await page.click('#select-visible');
  await queueBulk(page, 'add');
  await confirmOk(page);
  await page.click('#queue-open');
  await page.keyboard.press('d'); // ann done
  await page.keyboard.press('s'); // bea skipped
  await page.click('#q-views [data-qview=manage]');
}

test('queue manage: search, filters, sorting and counts', async () => {
  const { page, problems } = await openApp();
  await openManagedQueue(page);
  assert.equal(await page.isVisible('#q-manage'), true);
  assert.equal(await page.isHidden('#q-card'), true);
  assert.deepEqual(await qFilterCounts(page), { total: 8, pending: 6, done: 1, skipped: 1 });
  assert.deepEqual(await qListed(page), BULK_NFB);
  assert.equal(await page.textContent('#q-list .row[data-username=ann] .qbadge'), 'Done');
  assert.equal(await page.textContent('#q-list .row[data-username=bea] .qbadge'), 'Skipped');

  await page.click('#q-filters [data-qfilter=done]');
  assert.deepEqual(await qListed(page), ['ann']);
  await page.click('#q-filters [data-qfilter=skipped]');
  assert.deepEqual(await qListed(page), ['bea']);
  await page.click('#q-filters [data-qfilter=pending]');
  assert.deepEqual(await qListed(page), ['cal', 'dee', 'eli', 'fay', 'gus', 'hal']);
  assert.equal(await page.textContent('#q-list-summary'), '6 accounts · Remaining');

  await page.fill('#q-search', '@A'); // cal, fay, hal among remaining
  assert.deepEqual(await qListed(page), ['cal', 'fay', 'hal']);
  assert.equal(await page.textContent('#q-list-summary'), '3 of 6 accounts match “@A” · Remaining');
  await page.selectOption('#q-sort', 'za');
  assert.deepEqual(await qListed(page), ['hal', 'fay', 'cal']);
  await page.selectOption('#q-sort', 'newest'); // cal 8d, hal 4d, fay 3d
  assert.deepEqual(await qListed(page), ['cal', 'hal', 'fay']);
  await page.selectOption('#q-sort', 'oldest');
  assert.deepEqual(await qListed(page), ['fay', 'hal', 'cal']);
  await page.fill('#q-search', 'zzz');
  assert.match(await page.textContent('#q-list .empty'), /No queued usernames match “zzz”/);
  await page.fill('#q-search', '');
  await page.click('#q-filters [data-qfilter=all]');
  await page.selectOption('#q-sort', 'az');
  assert.equal((await qListed(page)).length, 8);
  assert.deepEqual(problems, []);
  await page.close();
});

test('queue manage: selection and bulk Done / Skipped / Remove / Keep instead, each confirmed', async () => {
  const { page } = await openApp();
  await openManagedQueue(page);
  assert.equal(await page.isDisabled('[data-qbulk=done]'), true);
  await qCheck(page, 'cal');
  await qCheck(page, 'dee');
  assert.equal(await page.textContent('#q-selected-count'), '2 selected');

  await qBulk(page, 'done');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 2 accounts as done?');
  assert.match(await page.textContent('#confirm-detail'), /only records that you handled them yourself on Instagram/);
  assert.equal((await savedQueue(page)).cal, 'pending'); // nothing yet
  await confirmOk(page);
  assert.equal((await savedQueue(page)).cal, 'done');
  assert.deepEqual(await qFilterCounts(page), { total: 8, pending: 4, done: 3, skipped: 1 });
  assert.equal(await page.textContent('#q-selected-count'), '0 selected');

  // Already done: no dialog.
  await qCheck(page, 'cal');
  await page.click('[data-qbulk=done]');
  await page.waitForTimeout(150);
  assert.equal(await page.isVisible('#confirm'), false);
  assert.equal(await page.textContent('#toast-text'), 'The selected account is already marked done.');

  await qCheck(page, 'eli');
  await qBulk(page, 'skipped');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 2 accounts as skipped?'); // cal (done) + eli
  await confirmOk(page);
  assert.equal((await savedQueue(page)).cal, 'skipped');

  await qCheck(page, 'fay');
  await qCheck(page, 'gus');
  await qBulk(page, 'remove');
  assert.equal(await page.textContent('#confirm-title'), 'Remove 2 accounts from your Unfollow Queue?');
  await confirmOk(page);
  assert.equal('fay' in (await savedQueue(page)), false);
  await page.click('#toast-undo');
  assert.equal((await savedQueue(page)).fay, 'pending');

  await qCheck(page, 'hal');
  await qBulk(page, 'keep');
  assert.equal(await page.textContent('#confirm-title'), 'Keep 1 account instead?');
  await confirmOk(page);
  assert.equal('hal' in (await savedQueue(page)), false);
  assert.equal((await savedTags(page)).hal, 'keep');
  await page.click('#toast-undo');
  assert.equal((await savedQueue(page)).hal, 'pending');
  assert.equal((await savedTags(page)).hal, undefined);
  await page.close();
});

test('queue manage: cancelling changes nothing; hidden accounts change only if explicitly selected', async () => {
  const { page } = await openApp();
  await openManagedQueue(page);
  const before = await savedQueue(page);
  await page.click('#q-select-visible');
  for (const action of ['done', 'skipped', 'remove', 'keep']) {
    await qBulk(page, action);
    await page.click('#confirm-cancel');
    await settle(page);
  }
  await qBulk(page, 'remove');
  await page.keyboard.press('Escape');
  await settle(page);
  assert.deepEqual(await savedQueue(page), before);
  assert.deepEqual(await savedTags(page), {});
  await page.click('#q-select-none');

  await qCheck(page, 'hal'); // explicitly selected, then hidden
  await page.fill('#q-search', 'e'); // bea, dee, eli
  assert.equal(await page.textContent('#q-selected-count'), '1 selected · 1 not visible');
  await page.click('#q-select-visible');
  await qBulk(page, 'done');
  assert.equal(await page.textContent('#confirm-title'), 'Mark 4 accounts as done?');
  assert.equal(await page.textContent('#confirm-hidden'), '1 of these accounts is selected but not visible with the current search or filter.');
  await confirmOk(page);
  assert.deepEqual(await savedQueue(page), {
    ann: 'done', bea: 'done', cal: 'pending', dee: 'done', eli: 'done', fay: 'pending', gus: 'pending', hal: 'done',
  });
  await page.close();
});

// ---------- Step 8: session tracking ----------

async function setTarget(page, value) {
  await page.fill('#session-target', String(value));
  await page.press('#session-target', 'Enter');
}

test('session: custom target, progress, reaching the target, undo, bulk done', async () => {
  const { page, problems } = await openApp();
  await uploadBulkExport(page);
  await page.click('#select-visible');
  await queueBulk(page, 'add');
  await confirmOk(page);
  await page.click('#queue-open');
  assert.equal(await page.textContent('#session-text'), '0 handled this session');
  assert.match(await page.textContent('.session-note'), /doesn't publish a safe number/);
  assert.equal(await page.isDisabled('#session-reset'), true);

  await setTarget(page, 3);
  assert.equal(await page.textContent('#session-text'), '0 / 3 handled this session');
  await page.click('#q-card');
  await page.keyboard.press('d');
  await page.keyboard.press('s'); // skip doesn't count
  await page.keyboard.press('d');
  assert.equal(await page.textContent('#session-text'), '2 / 3 handled this session');
  assert.equal(await page.isHidden('#session-reached'), true);
  await page.keyboard.press('d');
  assert.equal(await page.textContent('#session-text'), '3 / 3 handled this session');
  assert.equal(await page.textContent('#session-reached'), "You've reached your session target.");
  assert.equal(await qUser(page), '@eli'); // nothing is stopped: the next account is still there
  await page.keyboard.press('z'); // undo the last Done
  assert.equal(await page.textContent('#session-text'), '2 / 3 handled this session');
  assert.equal(await page.isHidden('#session-reached'), true);

  // Bulk "Mark done" counts too.
  await page.click('#q-views [data-qview=manage]');
  await page.click('#q-filters [data-qfilter=pending]');
  await qCheck(page, 'gus');
  await qCheck(page, 'hal');
  await qBulk(page, 'done');
  await confirmOk(page);
  assert.equal(await page.textContent('#session-text'), '4 / 3 handled this session');
  assert.equal(await page.isVisible('#session-reached'), true);
  await page.click('#toast-undo');
  assert.equal(await page.textContent('#session-text'), '2 / 3 handled this session');
  assert.deepEqual(problems, []);
  await page.close();
});

test('session: invalid target, clearing the target, reset with confirmation, persistence', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await queueAccounts(page, ['ann', 'bea']);
  await page.click('#queue-open');
  await setTarget(page, 'abc');
  assert.match(await page.textContent('#session-error'), /whole number from 1 to 10,000/);
  await setTarget(page, '0');
  assert.equal(await page.isVisible('#session-error'), true);
  await setTarget(page, 20);
  assert.equal(await page.isHidden('#session-error'), true);
  await page.click('#q-card');
  await page.keyboard.press('d');
  assert.equal(await page.textContent('#session-text'), '1 / 20 handled this session');

  await page.reload();
  await uploadBulkExport(page);
  await page.click('#queue-open');
  assert.equal(await page.textContent('#session-text'), '1 / 20 handled this session');
  assert.equal(await page.inputValue('#session-target'), '20');

  await page.click('#session-reset');
  await page.waitForSelector('#confirm[open]');
  assert.equal(await page.textContent('#confirm-title'), 'Reset the session counter?');
  await page.click('#confirm-cancel');
  await settle(page);
  assert.equal(await page.textContent('#session-text'), '1 / 20 handled this session');
  await page.click('#session-reset');
  await page.waitForSelector('#confirm[open]');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => document.getElementById('session-text').textContent.startsWith('0 /'));
  assert.equal((await savedQueue(page)).ann, 'done'); // queue not touched by a session reset

  await setTarget(page, '');
  assert.equal(await page.textContent('#session-text'), '0 handled this session');
  assert.equal(await page.isHidden('#session-bar'), true);
  await page.close();
});

// ---------- Step 9: dashboard ----------

const dashboard = (page) => page.evaluate(() => Object.fromEntries(
  ['followers', 'following', 'nfb', 'mutual', 'fans', 'reviewed', 'unreviewed', 'keep', 'ignore', 'unavailable',
    'queue', 'queue-done', 'queue-remaining', 'queue-skipped'].map((k) => [k, document.getElementById(`stat-${k}`).textContent])));

test('dashboard: every count, and counts update after actions', async () => {
  const { page, problems } = await openApp();
  await uploadBulkExport(page);
  assert.deepEqual(await dashboard(page), {
    followers: '1', following: '9', nfb: '8', mutual: '1', fans: '0',
    reviewed: '0', unreviewed: '8', keep: '0', ignore: '0', unavailable: '0',
    queue: '0', 'queue-done': '0', 'queue-remaining': '0', 'queue-skipped': '0',
  });
  await clickTag(page, 'ann', 'keep');
  await clickTag(page, 'bea', 'ignore');
  await clickTag(page, 'cal', 'unavailable');
  await queueAccounts(page, ['dee', 'eli', 'fay', 'gus']);
  await page.click('#queue-open');
  await page.keyboard.press('d'); // dee done
  await page.keyboard.press('s'); // eli skipped
  await page.keyboard.press('Escape');
  assert.deepEqual(await dashboard(page), {
    followers: '1', following: '9', nfb: '8', mutual: '1', fans: '0',
    reviewed: '3', unreviewed: '5', keep: '1', ignore: '1', unavailable: '1',
    queue: '4', 'queue-done': '1', 'queue-remaining': '2', 'queue-skipped': '1',
  });
  assert.match(await page.textContent('#queue-launch-status'), /4 queued · 1 done · 2 remaining · 1 skipped/);
  // Keep instead in the queue updates both groups.
  await page.click('#queue-open');
  await page.keyboard.press('k'); // fay -> Keep, out of the queue
  await page.keyboard.press('Escape');
  const d = await dashboard(page);
  assert.deepEqual([d.keep, d.reviewed, d.queue, d['queue-remaining']], ['2', '4', '3', '1']);
  assert.deepEqual(problems, []);
  await page.close();
});

test('dashboard: numbers open the matching list or filter', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await clickTag(page, 'ann', 'keep');
  await clickTag(page, 'bea', 'ignore');
  await queueAccounts(page, ['cal', 'dee']);
  await page.click('#queue-open');
  await page.keyboard.press('d'); // cal done
  await page.keyboard.press('Escape');

  for (const [tab, count] of [['followers', 1], ['following', 9], ['mutual', 1]]) {
    await page.click(`.stat[data-tab=${tab}]`);
    assert.equal(await page.getAttribute(`#tabs [data-tab=${tab}]`, 'aria-selected'), 'true');
    assert.equal((await listed(page)).length, count);
  }
  await page.click('.stat[data-tab=fans]');
  assert.match(await page.textContent('#list .empty'), /You follow back everyone/);

  await page.click('[data-nav-filter=keep]');
  assert.equal(await page.getAttribute('#tabs [data-tab=notFollowingBack]', 'aria-selected'), 'true');
  assert.deepEqual(await listed(page), ['ann']);
  await page.click('[data-nav-filter=ignore]');
  assert.deepEqual(await listed(page), ['bea']);
  await page.click('[data-nav-filter=unavailable]');
  assert.match(await page.textContent('#list .empty'), /No accounts tagged Unavailable yet/);
  await page.click('[data-nav-filter=unreviewed]');
  assert.equal((await listed(page)).length, 6);
  await page.click('#stat-reviewed-card');
  assert.equal(await page.inputValue('#sort'), 'reviewed');
  assert.deepEqual((await listed(page)).slice(0, 2), ['ann', 'bea']);

  await page.click('[data-qnav=done]');
  assert.equal(await page.isVisible('#q-manage'), true);
  assert.deepEqual(await qListed(page), ['cal']);
  await page.keyboard.press('Escape');
  await page.click('[data-qnav=pending]');
  assert.deepEqual(await qListed(page), ['dee']);
  await page.keyboard.press('Escape');
  await page.click('[data-qnav=skipped]');
  assert.match(await page.textContent('#q-list .empty'), /Nothing skipped/);
  await page.keyboard.press('Escape');
  await page.click('[data-qnav=all]');
  assert.deepEqual(await qListed(page), ['cal', 'dee']);
  await page.close();
});

// ---------- Step 10: backup / restore ----------

/** Seed a known state through the real UI: tags, queue with progress, session target. */
async function seedState(page) {
  await uploadBulkExport(page);
  await clickTag(page, 'ann', 'keep');
  await clickTag(page, 'bea', 'ignore');
  await clickTag(page, 'cal', 'unavailable');
  await queueAccounts(page, ['dee', 'eli', 'fay']);
  await page.click('#queue-open');
  await setTarget(page, 10);
  await page.click('#q-card');
  await page.keyboard.press('d'); // dee done
  await page.keyboard.press('s'); // eli skipped
  await page.keyboard.press('Escape');
}
async function exportBackupFile(page) {
  await page.click('#open-settings');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#backup-export')]);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-backup-')), download.suggestedFilename());
  await download.saveAs(file);
  return file;
}
async function importFile(page, fileOrPayload) {
  await page.setInputFiles('#backup-import', fileOrPayload);
}
const allSaved = (page) => page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) out[localStorage.key(i)] = localStorage.getItem(localStorage.key(i));
  return out;
});

test('backup: export downloads only Follow Check data (no export data), locally', async () => {
  const { page, problems } = await openApp();
  await seedState(page);
  const file = await exportBackupFile(page);
  assert.match(path.basename(file), /^follow-check-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(backup.format, 'follow-check-backup');
  assert.equal(backup.version, 1);
  assert.deepEqual(Object.keys(backup.data).sort(), ['queue', 'review', 'session', 'tags']);
  assert.deepEqual(backup.data.tags && Object.keys(backup.data.tags).sort(), ['ann', 'bea', 'cal']);
  assert.deepEqual(Object.fromEntries(Object.entries(backup.data.queue.entries).map(([u, e]) => [u, e.status])), { dee: 'done', eli: 'skipped', fay: 'pending' });
  assert.equal(backup.data.session.target, 10);
  assert.equal(backup.data.session.count, 1);
  // No Instagram export contents: nothing about followers, following lists, hrefs or accounts never tagged/queued.
  const text = fs.readFileSync(file, 'utf8');
  for (const absent of ['followers', 'relationships', 'instagram.com', 'string_list_data', '"mia"', '"gus"', '"hal"']) {
    assert.equal(text.includes(absent), false, absent);
  }
  assert.match(await page.textContent('#settings-status'), /Backup saved as follow-check-backup-.*\(3 tags, 3 queued accounts\)/);
  assert.deepEqual(problems, []); // the download is a local blob, not a network request
  await page.close();
});

test('backup: import into a fresh browser, with a summary and confirmation', async () => {
  const source = await openApp();
  await seedState(source.page);
  const file = await exportBackupFile(source.page);
  await source.page.close();

  const { page, problems } = await openApp(); // fresh context: nothing saved
  await page.click('#open-settings'); // works before loading an export
  assert.match(await page.textContent('#saved-summary'), /Saved now: 0 tags/);
  await importFile(page, file);
  await page.waitForSelector('#confirm[open]');
  assert.equal(await page.textContent('#confirm-title'), 'Restore this backup?');
  const lines = await page.$$eval('#confirm-list li', (els) => els.map((e) => e.textContent));
  assert.deepEqual(lines, [
    '3 tags (1 Keep, 1 Ignore, 1 Unavailable)',
    '3 accounts in the Unfollow Queue (1 done, 1 remaining, 1 skipped)',
    'no saved Review Mode position',
    'session: 1 handled, target 10',
  ]);
  assert.equal(await page.textContent('#confirm-hidden'), 'This replaces the Follow Check data saved in this browser now (0 tags and 0 queued accounts). Nothing changes until you confirm.');
  assert.deepEqual(await allSaved(page), {}); // nothing before confirming
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /Backup restored/.test(document.getElementById('settings-status').textContent));
  assert.equal(await page.textContent('#settings-status'), 'Backup restored: 3 tags and 3 queued accounts.');
  await page.click('#settings-back');
  await uploadBulkExport(page);
  assert.equal(await tagOf(page, 'ann'), 'keep');
  assert.equal(await tagOf(page, 'cal'), 'unavailable');
  assert.deepEqual(await dashboard(page).then((d) => [d.queue, d['queue-done'], d['queue-skipped']]), ['3', '1', '1']);
  await page.click('#queue-open');
  assert.equal(await page.textContent('#session-text'), '1 / 10 handled this session');
  assert.deepEqual(problems, []);
  await page.close();
});

test('backup: corrupt, wrong or newer-version files are rejected; cancel changes nothing', async () => {
  const { page } = await openApp();
  await seedState(page);
  await page.click('#open-settings');
  const before = await allSaved(page);
  const bad = [
    ['not-json.json', '{oops', /isn't valid JSON/],
    ['other.json', JSON.stringify({ hello: 'world' }), /isn't a Follow Check backup file/],
    ['newer.json', JSON.stringify({ format: 'follow-check-backup', version: 3, data: {} }), /newer version of Follow Check \(format 3\)/],
    ['damaged.json', JSON.stringify({ format: 'follow-check-backup', version: 1, data: { tags: { ann: { tag: 'delete-me' } } } }), /damaged or incomplete \(invalid tag for ann\)/],
    ['bad-user.json', JSON.stringify({ format: 'follow-check-backup', version: 1, data: { queue: { entries: { '<script>': { status: 'pending' } } } } }), /invalid username in queue/],
  ];
  for (const [name, text, message] of bad) {
    await importFile(page, { name, mimeType: 'application/json', buffer: Buffer.from(text) });
    await page.waitForSelector('#backup-error:not([hidden])');
    assert.match(await page.textContent('#backup-error'), message, name);
    assert.match(await page.textContent('#backup-error'), /Your saved data was not changed/);
    assert.equal(await page.isVisible('#confirm'), false);
  }
  assert.deepEqual(await allSaved(page), before);

  // A valid backup, but cancelled.
  const empty = JSON.stringify({ format: 'follow-check-backup', version: 1, data: {} });
  await importFile(page, { name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from(empty) });
  await page.waitForSelector('#confirm[open]');
  await page.click('#confirm-cancel');
  await page.waitForFunction(() => /Import cancelled/.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await allSaved(page), before);
  // ...and confirmed: replaces (not merges).
  await importFile(page, { name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from(empty) });
  await page.waitForSelector('#confirm[open]');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /Backup restored/.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await savedTags(page), {});
  assert.deepEqual(await savedQueue(page), {});
  await page.click('#settings-back');
  assert.equal(await page.textContent('#stat-keep'), '0'); // dashboard redrawn after restore
  await page.close();
});

// ---------- Step 11: data management ----------

async function reset(page, kind) {
  await page.click(`[data-reset=${kind}]`);
  await page.waitForSelector('#confirm[open]');
}

test('data: each reset explains what it deletes, needs confirmation, and cancel deletes nothing', async () => {
  const { page } = await openApp();
  await seedState(page);
  await page.click('#open-settings');
  assert.match(await page.textContent('#saved-summary'), /3 tags \(1 Keep, 1 Ignore, 1 Unavailable\) · 3 accounts in the Unfollow Queue/);
  const before = await allSaved(page);
  for (const kind of ['review', 'queue-progress', 'queue', 'all']) {
    await reset(page, kind);
    assert.ok((await page.$$eval('#confirm-list li', (els) => els.length)) >= 2, kind);
    assert.equal(await page.getAttribute('#confirm-ok', 'class'), 'btn danger');
    await page.click('#confirm-cancel');
    await page.waitForFunction(() => /Cancelled\. Nothing was deleted\./.test(document.getElementById('settings-status').textContent));
  }
  await reset(page, 'queue');
  await page.keyboard.press('Escape');
  await settle(page);
  assert.deepEqual(await allSaved(page), before);
  await page.close();
});

test('data: clear review progress, queue progress, and the queue, individually', async () => {
  const { page } = await openApp();
  await seedState(page);
  await page.click('#results .dash-panel #review-start'); // save a Review Mode position too
  await page.keyboard.press('Escape');
  await page.click('#open-settings');

  await reset(page, 'queue-progress');
  assert.deepEqual(await page.$$eval('#confirm-list li', (els) => els.map((e) => e.textContent)), [
    '1 done and 1 skipped accounts go back to Remaining', 'All 3 accounts stay in the queue', 'Your place in the queue is forgotten',
  ]);
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /queue progress cleared/i.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await savedQueue(page), { dee: 'pending', eli: 'pending', fay: 'pending' });
  assert.equal(Object.keys(await savedTags(page)).length, 3); // tags untouched
  assert.equal(await page.isDisabled('[data-reset=queue-progress]'), true); // nothing left to clear

  await reset(page, 'review');
  assert.match(await page.textContent('#confirm-list'), /3 tags will be deleted \(1 Keep, 1 Ignore, 1 Unavailable\)/);
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /Review progress cleared/.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await savedTags(page), {});
  assert.equal((await allSaved(page))['followcheck.review.v1'], undefined);
  assert.equal(Object.keys(await savedQueue(page)).length, 3); // queue untouched

  await reset(page, 'queue');
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /Unfollow Queue cleared/.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await savedQueue(page), {});
  assert.ok((await allSaved(page))['followcheck.session.v1']); // session kept

  await page.click('#settings-back');
  assert.deepEqual(await dashboard(page).then((d) => [d.reviewed, d.queue]), ['0', '0']);
  await page.close();
});

test('data: "clear all" is the most destructive: danger styling and typing DELETE', async () => {
  const { page } = await openApp();
  await seedState(page);
  await page.click('#open-settings');
  assert.match(await page.getAttribute('[data-reset=all]', 'class'), /\bdanger\b/);
  await reset(page, 'all');
  assert.equal(await page.textContent('#confirm-title'), 'Clear all Follow Check saved data?');
  assert.match(await page.textContent('#confirm-list'), /Your Instagram ZIP is not touched/);
  assert.equal(await page.isDisabled('#confirm-ok'), true);
  await page.fill('#confirm-type', 'delete'); // wrong case
  assert.equal(await page.isDisabled('#confirm-ok'), true);
  await page.press('#confirm-type', 'Enter'); // Enter submits Cancel (the default), never the delete
  await settle(page);
  assert.ok(Object.keys(await allSaved(page)).length >= 3);

  await reset(page, 'all');
  await page.fill('#confirm-type', 'DELETE');
  assert.equal(await page.isEnabled('#confirm-ok'), true);
  await page.click('#confirm-ok');
  await page.waitForFunction(() => /All Follow Check saved data was deleted/.test(document.getElementById('settings-status').textContent));
  assert.deepEqual(await allSaved(page), {});
  assert.equal(await page.isDisabled('[data-reset=all]'), true);
  await page.click('#settings-back');
  // The loaded export is still on screen (the ZIP itself is never touched); tags are gone.
  assert.equal(await page.textContent('#stat-nfb'), '8');
  assert.equal(await page.textContent('#stat-reviewed'), '0');
  await page.close();
});

// ---------- Step 12: robustness, accessibility, layout, performance ----------

test('malformed ZIPs and ZIPs without the right files show a clear error', async () => {
  const { page } = await openApp();
  await page.setInputFiles('#file-input', { name: 'broken.zip', mimeType: 'application/zip', buffer: Buffer.from('this is not a zip file at all') });
  await page.waitForSelector('.message.error');
  assert.match(await page.textContent('.message.error'), /broken\.zip couldn't be opened as a ZIP file/);
  assert.equal(await page.isVisible('#upload'), true);

  const zip = new JSZip();
  zip.file('your_instagram_activity/likes/liked_posts.json', '[]');
  await page.setInputFiles('#file-input', { name: 'other.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await page.waitForFunction(() => /Couldn't find followers_1\.json or following\.json/.test(document.querySelector('.message.error')?.textContent));

  const halfZip = new JSZip();
  halfZip.file('connections/followers_and_following/followers_1.json', '{"truncated":');
  halfZip.file('connections/followers_and_following/following.json', '{"relationships_following": []}');
  await page.setInputFiles('#file-input', { name: 'damaged.zip', mimeType: 'application/zip', buffer: await halfZip.generateAsync({ type: 'nodebuffer' }) });
  await page.waitForFunction(() => /followers_1\.json isn't valid JSON/.test(document.querySelector('.message.error')?.textContent));
  assert.equal(await page.isHidden('#results'), true);
  await page.close();
});

test('empty lists: everyone follows back', async () => {
  const { page, problems } = await openApp();
  await page.setInputFiles('#file-input', [
    { name: 'followers_1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify([{ string_list_data: [{ value: 'pal' }] }])) },
    { name: 'following.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relationships_following: [{ title: 'pal', string_list_data: [{}] }] })) },
  ]);
  await page.waitForSelector('#results:not([hidden])');
  assert.equal(await page.textContent('#stat-nfb'), '0');
  assert.match(await page.textContent('#list .empty'), /Everyone you follow follows you back/);
  assert.equal(await page.textContent('#review-launch-status'), 'Nothing to review.');
  assert.equal(await page.isHidden('#review-start'), true);
  assert.equal(await page.isDisabled('#select-visible'), true);
  assert.equal(await page.isDisabled('[data-queue-bulk=add]'), true);
  await page.click('#queue-open');
  assert.equal(await page.textContent('#q-finished-title'), 'Your Unfollow Queue is empty');
  await page.click('#q-views [data-qview=manage]');
  assert.match(await page.textContent('#q-list .empty'), /Your Unfollow Queue is empty/);
  assert.equal(await page.isDisabled('#q-select-visible'), true);
  assert.deepEqual(problems, []);
  await page.close();
});

test('keyboard: dashboard, queue and settings are usable without a mouse', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await clickTag(page, 'ann', 'keep');
  // Dashboard tiles are real buttons: focus + Enter.
  await page.focus('[data-nav-filter=keep]');
  await page.keyboard.press('Enter');
  assert.deepEqual(await listed(page), ['ann']);
  // Row checkbox with Space, then the bulk button with Enter, then the dialog with Tab/Enter.
  await page.click('#filters [data-filter=all]');
  await page.focus('#list .row[data-username=bea] input.select');
  await page.keyboard.press('Space');
  assert.equal(await page.textContent('#selected-count'), '1 selected');
  await page.focus('[data-queue-bulk=add]');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#confirm[open]');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-cancel'); // safe default
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'confirm-ok');
  await page.evaluate(() => { document.getElementById('toast').hidden = true; });
  await page.keyboard.press('Enter');
  await page.waitForSelector('#toast:not([hidden])');
  assert.deepEqual(await savedQueue(page), { bea: 'pending' });
  // Settings: open with the keyboard, leave with Esc.
  await page.focus('#open-settings');
  await page.keyboard.press('Enter');
  assert.equal(await page.isVisible('#settings'), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-title');
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#results'), true);
  // Visible focus ring on buttons.
  await page.focus('#queue-open');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  assert.notEqual(outline, 'none');
  await page.close();
});

test('layout: no horizontal overflow on any screen (desktop/mobile, light/dark)', async () => {
  const setups = [
    ['desktop light', { viewport: { width: 1280, height: 900 } }],
    ['desktop dark', { viewport: { width: 1280, height: 900 }, colorScheme: 'dark' }],
    ['mobile light', { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }],
    ['mobile dark', { viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, colorScheme: 'dark' }],
  ];
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  for (const [label, opts] of setups) {
    const context = await browser.newContext({ locale: 'en-US', timezoneId: 'UTC', ...opts });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(APP_URL);
    assert.equal(await overflow(page), false, `${label}: upload`);
    await page.click('#open-settings');
    assert.equal(await overflow(page), false, `${label}: settings (no export)`);
    await page.click('#settings-back');
    await seedState(page);
    const screens = [
      ['results', async () => {}],
      ['review', async () => { await page.click('#review-start'); }],
      ['queue work', async () => { await page.click('#queue-open'); }],
      ['queue manage', async () => { await page.click('[data-qnav=all]'); await qCheck(page, 'dee'); }],
      ['queue dialog', async () => { await page.click('[data-qnav=all]'); await qCheck(page, 'fay'); await qBulk(page, 'done'); }], // fay is pending
      ['settings', async () => { await page.click('#open-settings'); }],
      ['clear-all dialog', async () => { await page.click('#open-settings'); await reset(page, 'all'); }],
    ];
    for (const [name, open] of screens) {
      await open();
      assert.equal(await overflow(page), false, `${label}: ${name}`);
      if (await page.isVisible('#confirm')) {
        const fits = await page.evaluate(() => { const r = document.getElementById('confirm').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
        assert.ok(fits, `${label}: ${name} dialog fits`);
        await page.click('#confirm-cancel');
        await settle(page);
      }
      await page.keyboard.press('Escape'); // back to results
      if (await page.isVisible('#settings')) await page.click('#settings-back');
      if (!(await page.isVisible('#results'))) await page.keyboard.press('Escape');
    }
    assert.deepEqual(errors, [], label);
    await context.close();
  }
});

/** A fake export with `n` accounts you follow, of which about 80% don't follow back. */
function bigExport(n) {
  const following = [];
  const followers = [];
  for (let i = 0; i < n; i++) {
    const u = `fake_user_${String(i).padStart(5, '0')}`;
    following.push({ title: u, string_list_data: [{ href: `https://www.instagram.com/_u/${u}`, timestamp: 1500000000 + i * 3600 }] });
    if (i % 5 === 0) followers.push({ title: '', string_list_data: [{ value: u, timestamp: 1500000000 + i }] });
  }
  return [
    { name: 'followers_1.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(followers)) },
    { name: 'following.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ relationships_following: following })) },
  ];
}

for (const N of [1500, 5000]) {
  test(`performance: ${N.toLocaleString('en-US')} accounts stay responsive`, async () => {
    const { page, problems } = await openApp();
    const timings = {};
    const time = async (label, fn) => { const t = Date.now(); await fn(); timings[label] = Date.now() - t; };
    await time('upload + parse + first render', async () => {
      await page.setInputFiles('#file-input', bigExport(N));
      await page.waitForSelector('#results:not([hidden])');
    });
    const nfb = N - Math.ceil(N / 5);
    assert.equal(await page.textContent('#stat-nfb'), nfb.toLocaleString('en-US'));
    await time('search', async () => { await page.fill('#search', '_0012'); await page.waitForFunction(() => document.querySelectorAll('#list .row').length > 0); });
    await page.fill('#search', '');
    await time('sort newest', () => page.selectOption('#sort', 'newest'));
    await page.selectOption('#sort', 'az');
    await time('select 200 + bulk Keep', async () => {
      await page.click('#select-visible');
      await bulk(page, 'keep');
      await confirmOk(page);
    });
    await time('filter Unreviewed', () => page.click('#filters [data-filter=unreviewed]'));
    await time('select 200 + add to queue', async () => {
      await page.click('#select-visible');
      await queueBulk(page, 'add');
      await confirmOk(page);
    });
    await time('100 review-mode actions', async () => {
      await page.click('#review-start');
      for (let i = 0; i < 100; i++) await page.keyboard.press(['k', 'i', 'u', 's'][i % 4]);
      await page.keyboard.press('Escape');
    });
    await time('100 queue actions', async () => {
      await page.click('#queue-open');
      for (let i = 0; i < 100; i++) await page.keyboard.press(['d', 's'][i % 2]);
    });
    await time('queue manage list', async () => {
      await page.click('#q-views [data-qview=manage]');
      await page.click('#q-select-visible');
      await qBulk(page, 'done');
      await confirmOk(page);
    });
    await time('open settings summary', async () => {
      await page.click('#open-settings');
      await page.waitForSelector('#saved-summary');
    });
    console.log(`PERF ${N}: ${JSON.stringify(timings)}`);
    // Generous ceilings for a headless CI container; typical numbers are far lower.
    assert.ok(timings['upload + parse + first render'] < 5000, JSON.stringify(timings));
    for (const [label, ms] of Object.entries(timings)) {
      if (label.startsWith('100 ')) assert.ok(ms < 6000, `${label}: ${ms}ms`);
      else assert.ok(ms < 3000, `${label}: ${ms}ms`);
    }
    assert.deepEqual(problems, []);
    await page.close();
  });
}

test('keyboard: Esc leaves the queue even when a checkbox has focus, but not while typing', async () => {
  const { page } = await openApp();
  await uploadBulkExport(page);
  await queueAccounts(page, ['ann', 'bea']);
  await page.click('[data-qnav=all]');
  await qCheck(page, 'ann'); // focus is on the checkbox
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#results'), true);
  await page.click('[data-qnav=all]');
  await page.fill('#q-search', 'an');
  await page.keyboard.press('Escape'); // first Esc clears the search box, stays in the queue
  assert.equal(await page.inputValue('#q-search'), '');
  assert.equal(await page.isVisible('#queue'), true);
  await page.close();
});

// ---------- Drag and drop (real native drags) ----------
// Input.dispatchDragEvent sends an OS-style file drag through Chromium's real drag-and-drop
// code, so the page gets genuine DataTransfer items with FileSystem entries, exactly like
// dragging a file from Finder / Explorer. (A DataTransfer built in page JS has no entries
// and would not have caught the original bug.)

async function nativeDrag(page, filePath, { selector = '#dropzone', dy = 40, drop = true } = {}) {
  const box = await page.locator(selector).boundingBox();
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files: [filePath], dragOperationsMask: 1 };
  const at = { x: box.x + 30, y: box.y + dy, data };
  await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', ...at });
  await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', ...at });
  if (drop) await cdp.send('Input.dispatchDragEvent', { type: 'drop', ...at });
  return cdp;
}
const loadedOrMessage = (page) => page.waitForFunction(
  () => !document.getElementById('results').hidden || document.querySelector('#messages .message'), null, { timeout: 10000 });
/** Everything the app derived from an upload, to compare two ways of loading. */
const loadedSummary = (page) => page.evaluate(() => ({
  stats: ['followers', 'following', 'nfb', 'mutual', 'fans'].map((k) => document.getElementById(`stat-${k}`).textContent),
  nfb: [...document.querySelectorAll('#list .row')].map((r) => r.dataset.username),
  sources: document.getElementById('sources').textContent,
  dataDate: document.getElementById('data-date').textContent,
}));
function tmpFile(name, contents) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ig-drop-')), name);
  fs.writeFileSync(file, contents);
  return file;
}

test('drag and drop: dropping a valid ZIP loads it, identical to the file picker', async () => {
  const picked = await openApp();
  await upload(picked.page, zipPath);
  const viaPicker = await loadedSummary(picked.page);
  await picked.page.close();

  const { page, problems } = await openApp();
  const startUrl = page.url();
  const cdp = await nativeDrag(page, zipPath, { drop: false });
  assert.equal(await page.getAttribute('#dropzone', 'class'), 'dropzone dragging'); // visual feedback while over the page
  const box = await page.locator('#dropzone').boundingBox();
  await cdp.send('Input.dispatchDragEvent', { type: 'drop', x: box.x + 30, y: box.y + 40, data: { items: [], files: [zipPath], dragOperationsMask: 1 } });
  await loadedOrMessage(page);
  assert.equal(await page.isVisible('#results'), true);
  assert.deepEqual(await loadedSummary(page), viaPicker);
  assert.deepEqual(viaPicker.stats, ['5', '6', '3', '3', '2']);
  assert.equal(await page.getAttribute('#dropzone', 'class'), 'dropzone'); // highlight cleared
  assert.equal(page.url(), startUrl); // the browser didn't open/navigate to the ZIP
  assert.deepEqual(problems, []); // no errors, no network requests
  await page.close();
});

test('drag and drop: a drop just outside the dashed box still loads the export', async () => {
  const { page, problems } = await openApp();
  await nativeDrag(page, zipPath, { selector: '.guide-cta-note', dy: 6 });
  await loadedOrMessage(page);
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  assert.deepEqual(problems, []);
  await page.close();
});

test('drag and drop: invalid dropped files get the same errors as the file picker', async () => {
  const halfZip = new JSZip();
  halfZip.file('connections/followers_and_following/followers_1.json', '[]');
  const cases = [
    ['notes.txt', 'hello', /Couldn't find followers_1\.json or following\.json/],
    ['broken.zip', 'not really a zip', /broken\.zip couldn't be opened as a ZIP file/],
    ['half.zip', await halfZip.generateAsync({ type: 'nodebuffer' }), /No following file found/],
  ];
  for (const [name, contents, expected] of cases) {
    const file = tmpFile(name, contents);
    const viaPicker = await openApp();
    await viaPicker.page.setInputFiles('#file-input', file);
    await loadedOrMessage(viaPicker.page);
    const pickerMessage = await viaPicker.page.textContent('#messages');
    await viaPicker.page.close();

    const { page, problems } = await openApp();
    await nativeDrag(page, file);
    await loadedOrMessage(page);
    assert.equal(await page.isHidden('#results'), true, name);
    assert.equal(await page.isVisible('#upload'), true, name);
    const dropMessage = await page.textContent('#messages');
    assert.match(dropMessage, expected, name);
    assert.equal(dropMessage, pickerMessage, name);
    assert.deepEqual(problems, [], name);
    await page.close();
  }
});

test('drag and drop: a dropped folder on a file:// page gives a clear message instead of silence', async () => {
  // Chromium can't read dropped folders on file:// pages (it can over http/https).
  const { page, problems } = await openApp();
  await nativeDrag(page, EXPORT_DIR);
  await loadedOrMessage(page);
  assert.match(await page.textContent('#messages'), /couldn't read the dropped folder.*Choose unzipped folder/s);
  assert.deepEqual(problems, []);
  await page.close();
});

test('drag and drop: DataTransfer without FileSystem entries (other browsers) still loads', async () => {
  const { page } = await openApp();
  const bytes = [...fs.readFileSync(zipPath)];
  await page.evaluate((arr) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(arr)], 'export.zip', { type: 'application/zip' }));
    document.getElementById('dropzone').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, bytes);
  await loadedOrMessage(page);
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  await page.close();
});

test('drag and drop: on other screens a dropped file is ignored and never opened by the browser', async () => {
  const { page } = await openApp();
  await upload(page, zipPath);
  await clickTag(page, 'natgeo', 'keep');
  const before = await loadedSummary(page);
  const url = page.url();
  await nativeDrag(page, zip2Path, { selector: '#list-card' });
  await page.waitForTimeout(300);
  assert.equal(page.url(), url);
  assert.deepEqual(await loadedSummary(page), before); // the newer export was not loaded over the current one
  assert.equal(await tagOf(page, 'natgeo'), 'keep');
  await page.close();
});

test('click-to-upload still works (real file chooser), including after a rejected drop', async () => {
  const { page, problems } = await openApp();
  await nativeDrag(page, tmpFile('notes.txt', 'hello'));
  await loadedOrMessage(page);
  assert.match(await page.textContent('#messages'), /Couldn't find followers_1\.json/);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#upload label.btn.primary')]);
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(zipPath);
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  assert.equal(await page.textContent('#messages'), ''); // old error cleared
  assert.deepEqual(problems, []);
  await page.close();
});

// ---------- "How do I get my Instagram export?" guide ----------

const guideText = (page) => page.evaluate(() => document.getElementById('guide').textContent.replace(/\s+/g, ' '));

test('guide: button is on the first screen, next to the drop zone, and opens the guide', async () => {
  const { page, problems } = await openApp();
  assert.equal(await page.isVisible('#guide-open'), true);
  assert.equal((await page.textContent('#guide-open')).trim(), 'How do I get my Instagram export?');
  // Close to "Drop your Instagram export here", but outside the drop zone (so it can't trigger the picker).
  const [dz, btn] = await Promise.all([page.locator('#dropzone').boundingBox(), page.locator('#guide-open').boundingBox()]);
  assert.ok(btn.y > dz.y + dz.height && btn.y - (dz.y + dz.height) < 80, 'button sits just below the drop zone');
  assert.equal(await page.$('#dropzone #guide-open'), null);
  assert.equal(await page.isVisible('#guide'), false); // not cluttering the screen until asked

  await page.click('#guide-open');
  await page.waitForSelector('#guide[open]');
  assert.equal(await page.textContent('#guide-title'), 'How to get your Instagram export');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'guide-title');
  assert.equal(await page.isHidden('#file-input') && await page.evaluate(() => document.getElementById('upload').hidden), false); // upload screen unchanged underneath
  assert.deepEqual(problems, []); // no errors, no network requests
  await page.close();
});

test('guide: contains every required step, the JSON warning and the privacy note', async () => {
  const { page } = await openApp();
  await page.click('#guide-open');
  const text = await guideText(page);
  for (const phrase of [
    'Open Instagram',
    'Open Settings',
    'Meta Account', 'Accounts Center',
    'Your information and permissions',
    'Export your information', 'Download your information', 'Create export',
    'Instagram profile',
    'Export to device',
    'Customize information', 'Followers and following',
    'Date range', 'All time',
    'Format', 'JSON', 'Not HTML',
    'Start export',
    'How long this takes varies', 'notify you',
    'Available downloads', 'Download',
    'drag the ZIP onto the upload area', 'click the upload area',
    'reads it right here, in your browser',
  ]) assert.ok(text.includes(phrase), `missing: ${phrase}`);
  // Steps are numbered 1-15 across the four sections.
  const numbers = await page.$$eval('#guide .guide-steps', (lists) => lists.map((ol) => [ol.start || 1, ol.children.length]));
  assert.deepEqual(numbers, [[1, 11], [12, 1], [13, 1], [14, 2]]);
  assert.deepEqual(await page.$$eval('#guide .guide-section', (h) => h.map((e) => e.textContent.trim())),
    ['1 Ask Instagram for your export', '2 Wait for Instagram', '3 Download the ZIP', '4 Open it in Follow Check']);
  // Key warnings.
  assert.equal(await page.textContent('#guide-json strong'), 'Choose JSON, not HTML.');
  assert.match(await page.getAttribute('#guide-json', 'class'), /\bwarn\b/);
  assert.ok(text.includes('You only need Followers and following.'));
  assert.ok(text.includes("Upload the ZIP you receive from Instagram. You don't need to unzip it first."));
  assert.equal((await page.textContent('#guide-privacy')).trim(),
    'Your Instagram export stays on your device. Follow Check processes it locally in your browser and does not upload your export to a server.');
  // No promised preparation time.
  assert.equal(/\b\d+\s*(minutes?|hours?|days?)\b.*ready|ready in/i.test(text.replace('keeps it there for 4 days', '')), false);
  // Guide is plain text: no links, images, iframes or scripts that could load anything.
  assert.equal(await page.$$eval('#guide a, #guide img, #guide iframe, #guide script, #guide video', (els) => els.length), 0);
  await page.close();
});

test('guide: closes with Got it, the × button, Esc and a backdrop click', async () => {
  const { page } = await openApp();
  const open = async () => { await page.click('#guide-open'); await page.waitForSelector('#guide[open]'); };
  const isOpen = () => page.evaluate(() => document.getElementById('guide').open);

  await open();
  await page.click('#guide-close');
  assert.equal(await isOpen(), false);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'guide-open'); // focus returns to the button

  await open();
  await page.click('.guide-x');
  assert.equal(await isOpen(), false);

  await open();
  await page.keyboard.press('Escape');
  assert.equal(await isOpen(), false);

  await open();
  await page.mouse.click(5, 5); // outside the dialog
  assert.equal(await isOpen(), false);

  // Keyboard only: Tab to the button and press Enter.
  await page.focus('#guide-open');
  await page.keyboard.press('Enter');
  assert.equal(await isOpen(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.isVisible('#upload'), true);
  await page.close();
});

test('guide: mobile layout (light and dark) fits the screen and scrolls', async () => {
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, colorScheme });
    const page = await context.newPage();
    await page.goto(APP_URL);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert.equal(await overflow(), false);
    await page.tap('#guide-open');
    await page.waitForSelector('#guide[open]');
    const layout = await page.evaluate(() => {
      const g = document.getElementById('guide').getBoundingClientRect();
      const body = document.querySelector('.guide-body');
      const close = document.getElementById('guide-close').getBoundingClientRect();
      return {
        fits: g.left >= 0 && g.right <= innerWidth && g.top >= 0 && g.bottom <= innerHeight + 1,
        scrolls: body.scrollHeight > body.clientHeight,
        closeVisible: close.bottom <= innerHeight && close.height >= 40,
        noWideContent: [...document.querySelectorAll('#guide *')].every((el) => el.getBoundingClientRect().right <= innerWidth + 1),
      };
    });
    assert.deepEqual(layout, { fits: true, scrolls: true, closeVisible: true, noWideContent: true }, colorScheme);
    assert.equal(await overflow(), false);
    await page.tap('#guide-close');
    assert.equal(await page.evaluate(() => document.getElementById('guide').open), false);
    await context.close();
  }
});

test('guide: click upload and drag-and-drop upload still work (also with the guide open)', async () => {
  // Click the upload area → real file chooser.
  let { page } = await openApp();
  await page.click('#guide-open');
  await page.click('#guide-close');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('#upload label.btn.primary')]);
  await chooser.setFiles(zipPath);
  await page.waitForSelector('#results:not([hidden])');
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  await page.close();

  // Real native drag and drop.
  ({ page } = await openApp());
  await nativeDrag(page, zipPath);
  await loadedOrMessage(page);
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  await page.close();

  // Dropping the ZIP while the guide is open closes the guide and loads it.
  ({ page } = await openApp());
  await page.click('#guide-open');
  await page.waitForSelector('#guide[open]');
  await nativeDrag(page, zipPath, { selector: '#guide-title', dy: 5 });
  await loadedOrMessage(page);
  assert.equal(await page.evaluate(() => document.getElementById('guide').open), false);
  assert.deepEqual((await loadedSummary(page)).stats, ['5', '6', '3', '3', '2']);
  await page.close();
});
