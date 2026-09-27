# Follow Check (Instagram export analyzer)

A private, local-only tool that compares your Instagram followers and following
lists from Instagram's own data export. No Instagram login, no server: all
processing happens in your browser.

## Getting your export
Instagram → Accounts Center → Your information and permissions →
Download your information → choose **Followers and following**, format **JSON**.

The export contains `connections/followers_and_following/followers_1.json`
(plus `followers_2.json`, ... for large accounts) and `following.json`.

## Status
- [x] Step 1: parser (`parser.js`) + tests
- [ ] Step 2: upload page, totals, list, search
- [ ] Step 3: Keep/Ignore tags saved locally

## Tests
    node --test instagram/tests/*.test.js
