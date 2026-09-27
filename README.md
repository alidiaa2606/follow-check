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

## Files
- `index.html`: the page (a strict Content-Security-Policy blocks all network requests)
- `styles.css`: styling (light and dark mode, mobile friendly)
- `app.js`: reading files/ZIPs, totals, tabs, search, sort
- `parser.js`: parsing and comparing the export (no DOM, unit tested)
- `vendor/jszip.min.js`: JSZip 3.10.2 for reading the ZIP in the browser (MIT or GPLv3)

## Status
- [x] Step 1: parser (`parser.js`) + tests
- [x] Step 2: upload page, totals, list, search
- [ ] Step 3: Keep/Ignore tags saved locally

## Tests
    node --test instagram/tests/*.test.js

`parser.test.js` always runs. `ui.test.js` drives the real page in Chromium and
is skipped unless Playwright is installed (`npm i --no-save playwright`).
