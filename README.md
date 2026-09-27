# Follow Check (Instagram export analyzer)

A private, local-only tool that compares your Instagram followers and following
lists from Instagram's own data export. No Instagram login, no server: all
processing happens in your browser.

## Getting your export
Instagram → Accounts Center → Your information and permissions →
Download your information → choose **Followers and following**, format **JSON**.

The export contains `connections/followers_and_following/followers_1.json`
(plus `followers_2.json`, ... for large accounts) and `following.json`.

## Opening the app
Easiest: download the repo and **double-click `instagram/index.html`**. It opens
in your browser and works straight from the file, with no install or server.

Or serve the folder locally:

    cd instagram && python3 -m http.server 8000
    # then open http://localhost:8000

Then drop in the ZIP Instagram gave you (or the unzipped folder, or the JSON files).

## Tags and privacy
In **Not following back**, tag each account **Keep**, **Ignore** or **Unavailable**
(click the active tag again to remove it, or use Undo). Filter by All / Unreviewed /
Keep / Ignore / Unavailable; search and sort work inside each filter.

Tags are saved in this browser's `localStorage`, keyed by username, so they
survive reloads, restarts and newer exports. The export itself is never saved.
Tags belong to the browser *and* to how you open the app: `file://` and
`http://localhost:8000` keep separate tags, so pick one way and stick to it.
Clearing site data for the page deletes the tags.

## Bulk actions
In **Not following back**, tick the checkbox beside accounts, or use **Select all
visible** (only the rows currently on screen after search, filter and paging;
never hidden ones). Then **Mark Keep / Mark Ignore / Mark Unavailable / Clear
tags**. Every bulk action asks first ("Mark 47 accounts as Ignore?") and changes
nothing until you confirm; Cancel is the default button. If some selected accounts
are hidden by the current search or filter, the selection bar and the confirmation
say so. After applying, Undo in the toast restores the previous tags.

Sort options: Username A–Z / Z–A, Followed newest / oldest first, Unreviewed first,
Reviewed first. They combine with search and the tag filters.

## Review Mode
Press **Start review** (or **Resume review**) above the list to go through the
unreviewed "Not following back" accounts one at a time, A to Z. Each choice moves
straight to the next unreviewed account. Accounts that already have a tag are left
out; change those in the list, or reach them with Previous.

| Key | Action |
|---|---|
| `K` / `I` / `U` | Keep / Ignore / Unavailable |
| `S` | Skip (stays unreviewed; you're offered the skipped ones at the end) |
| `←` | Previous account (tagged or not) |
| `Z` or `Ctrl/Cmd+Z` | Undo the last action |
| `Enter` / `O` | Open the Instagram profile in a new tab |
| `Esc` | Exit Review Mode |

"Open Instagram profile" is a normal link to `https://www.instagram.com/USERNAME/`.
The app never checks profiles itself. Your place in the review and the skipped list
are saved in `localStorage` next to the tags, so after closing the browser you
upload the ZIP again and press **Resume review**.

## Unfollow Queue
Follow Check is an organisation tool: it **never** unfollows, follows, clicks, logs in,
scrapes or checks anything on Instagram.

1. In **Not following back**, tick accounts and choose **Add to Unfollow Queue**
   (confirmed with the exact count; accounts already queued are never added twice).
2. Open the queue from the dashboard's **Cleanup** panel. **One at a time** shows each
   account with its follow date and tag, an **Open Instagram profile** link
   (`https://www.instagram.com/USERNAME/`, new tab), and:
   **Mark done** (you unfollowed it yourself; Follow Check only records what you tell it),
   **Skip**, **Keep instead** (removes it from the queue and tags it Keep), Previous, Undo.
3. **Manage list** has search, sorting, Remaining / Completed / Skipped filters, checkboxes
   and confirmed bulk actions (Mark done, Mark skipped, Remove from queue, Keep instead).
   Hidden or filtered-out accounts only change if you explicitly selected them.

| Key (One at a time) | Action |
|---|---|
| `D` / `S` / `K` | Mark done / Skip / Keep instead |
| `←` | Previous |
| `Z` or `Ctrl/Cmd+Z` | Undo |
| `Enter` / `O` | Open the Instagram profile |
| `Esc` | Exit the queue |

**Session tracking** (optional): counts the accounts you mark done and lets you set
your own target ("12 / 20 handled this session"). Instagram doesn't publish a safe
limit, so Follow Check doesn't suggest one, and it never stops or continues anything.

## Backup & data
**Backup & data** (top bar, available any time):
- **Export Follow Check Backup** downloads a local JSON file (`format: follow-check-backup`,
  `version: 1`) with tags, Review Mode progress, the Unfollow Queue and session settings.
  It includes the usernames you tagged or queued, but none of your Instagram export.
- **Import Follow Check Backup** validates the file (rejects malformed, damaged or
  newer-format files without changing anything), shows what it contains, and replaces
  your saved data only after you confirm.
- Clear review progress / Clear Unfollow Queue progress / Clear Unfollow Queue, and
  **Clear all Follow Check saved data** (requires typing DELETE). Each explains exactly
  what will be deleted. None of them touch your Instagram ZIP or any file.

Saved keys in `localStorage`: `followcheck.tags.v1`, `followcheck.review.v1`,
`followcheck.queue.v1`, `followcheck.session.v1`. Nothing else is stored.

## Counts vs. your live profile
Results come from the export, so they can differ slightly from the numbers on
your Instagram profile (deactivated/suspended/deleted accounts, or activity after
the export). The app shows the export date (from the ZIP) and the newest activity
in the data.

## Files
- `index.html`: the page (a strict Content-Security-Policy blocks all network requests)
- `styles.css`: styling (light and dark mode, mobile friendly)
- `app.js`: reading files/ZIPs, totals, tabs, search, sort
- `parser.js`: parsing and comparing the export (no DOM, unit tested). Supports the
  classic `string_list_data` layout and the newer `label_values` layout.
- `tags.js`: Keep / Ignore / Unavailable tags saved in `localStorage` (unit tested)
- `review.js`: Review Mode queue, skip, previous, undo and resume position (unit tested)
- `queue.js`: Unfollow Queue entries, statuses, workflow, undo (unit tested)
- `session.js`: optional session counter and target (unit tested)
- `backup.js`: backup file format v1, validation, restore (unit tested)
- `vendor/jszip.min.js`: JSZip 3.10.2 for reading the ZIP in the browser (MIT or GPLv3)

## Status
- [x] Step 1: parser (`parser.js`) + tests
- [x] Step 2: upload page, totals, list, search
- [x] Step 3: Keep / Ignore / Unavailable tags saved locally, with filters
- [x] Step 4: Review Mode, checkboxes, bulk tag actions, sorting
- [x] Steps 5–8: Unfollow Queue, workflow, queue management, session tracking
- [x] Steps 9–12: dashboard, backup / restore, data management, polish

## Tests
    node --test instagram/tests/*.test.js

The unit tests (`parser`, `tags`, `review`, `queue`, `session`, `backup`) always run.
`ui.test.js` drives the real page in Chromium, including 1,500- and 5,000-account
performance runs, and is skipped unless Playwright is installed
(`npm i --no-save playwright`). All test data is made up.
