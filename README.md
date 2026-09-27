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
- `vendor/jszip.min.js`: JSZip 3.10.2 for reading the ZIP in the browser (MIT or GPLv3)

## Status
- [x] Step 1: parser (`parser.js`) + tests
- [x] Step 2: upload page, totals, list, search
- [x] Step 3: Keep / Ignore / Unavailable tags saved locally, with filters
- [x] Step 4: Review Mode (one account at a time, shortcuts, progress, resume)

## Tests
    node --test instagram/tests/*.test.js

`parser.test.js` always runs. `ui.test.js` drives the real page in Chromium and
is skipped unless Playwright is installed (`npm i --no-save playwright`).
