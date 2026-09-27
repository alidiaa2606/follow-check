/*
 * Instagram export parser.
 *
 * Reads the JSON files from Instagram's "Download your information" export
 * (followers_1.json, followers_2.json, ..., following.json) and compares them.
 * Pure functions only: no DOM, no network. Works as a browser <script>
 * (exposes window.IGParser) and as a Node module (for tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGParser = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FOLLOWERS_RE = /^followers(?:_\d+)?\.json$/i;
  const FOLLOWING_RE = /^following\.json$/i;
  const HTML_RE = /^(?:followers(?:_\d+)?|following)\.html$/i;

  // Usernames: letters, digits, periods, underscores (max 30 chars).
  const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

  function basename(path) {
    return String(path).split(/[\\/]/).pop();
  }

  /** 'followers' | 'following' | 'html' | null, based on the file name. */
  function classifyFile(path) {
    const name = basename(path);
    if (FOLLOWERS_RE.test(name)) return 'followers';
    if (FOLLOWING_RE.test(name)) return 'following';
    if (HTML_RE.test(name)) return 'html';
    return null;
  }

  function normalizeUsername(raw) {
    if (typeof raw !== 'string') return null;
    const name = raw.trim().replace(/^@/, '').toLowerCase();
    return USERNAME_RE.test(name) ? name : null;
  }

  /** Pull the username out of an instagram.com profile link. */
  function usernameFromHref(href) {
    if (typeof href !== 'string') return null;
    const m = href.match(/instagram\.com\/(?:_u\/)?([^/?#]+)/i);
    return m ? normalizeUsername(decodeURIComponent(m[1])) : null;
  }

  /**
   * One relationship entry -> { username, href, timestamp } or null.
   * Instagram has used several layouts over time:
   *   { string_list_data: [{ value: "user", href, timestamp }] }    (followers, older following)
   *   { title: "user", string_list_data: [{ href, timestamp }] }    (newer following)
   *   { string_list_data: [{ href: ".../_u/user", timestamp }] }    (href only)
   *   { timestamp, label_values: [{ label: "Username", value: "user" }, ...] }
   *     (newer layout, already used for pending requests, close friends, etc.)
   */
  function parseEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const data = Array.isArray(entry.string_list_data) ? entry.string_list_data[0] || {} : {};
    const username =
      normalizeUsername(data.value) ||
      normalizeUsername(entry.title) ||
      usernameFromHref(data.href) ||
      normalizeUsername(labelValue(entry.label_values, 'username'));
    if (!username) return null;
    const ts = Number(data.timestamp ?? entry.timestamp);
    return {
      username,
      href: `https://www.instagram.com/${username}/`,
      timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
    };
  }

  /**
   * Find a label's value in a label_values array, looking inside nested
   * { dict: [...] } groups too. Only the "Username" label is used for usernames:
   * in this layout "URL" is the website from the account's bio, not its profile.
   */
  function labelValue(labelValues, label) {
    if (!Array.isArray(labelValues)) return null;
    for (const item of labelValues) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.label === 'string' && item.label.toLowerCase() === label && typeof item.value === 'string') {
        return item.value;
      }
      const nested = labelValue(item.dict, label);
      if (nested) return nested;
    }
    return null;
  }

  /** Find the list of entries in a parsed file, whatever it's wrapped in. */
  function entryList(json) {
    if (Array.isArray(json)) return json;
    if (json && typeof json === 'object') {
      for (const key of ['relationships_followers', 'relationships_following']) {
        if (Array.isArray(json[key])) return json[key];
      }
      // Fall back to the first array-valued property.
      for (const value of Object.values(json)) {
        if (Array.isArray(value)) return value;
      }
    }
    return null;
  }

  /** Add entries to a Map keyed by username; the first occurrence wins. */
  function addEntries(map, entries) {
    let added = 0;
    let skipped = 0;
    for (const raw of entries) {
      const entry = parseEntry(raw);
      if (!entry) { skipped++; continue; }
      if (!map.has(entry.username)) { map.set(entry.username, entry); added++; }
    }
    return { added, skipped };
  }

  /**
   * Parse an export.
   * @param {Array<{name: string, text: string}>} files  file path/name + contents
   * @returns {{followers: Map, following: Map, files: Array, warnings: string[], errors: string[]}}
   */
  function parseExport(files) {
    const followers = new Map();
    const following = new Map();
    const report = [];
    const warnings = [];
    const errors = [];
    const seen = new Set();

    for (const file of files) {
      const kind = classifyFile(file.name);
      const name = basename(file.name);
      if (!kind) continue;
      if (kind === 'html') {
        warnings.push(`${name} is in HTML format. Please request your export in JSON format.`);
        continue;
      }
      if (seen.has(name.toLowerCase())) {
        warnings.push(`${name} was provided more than once; only the first copy was used.`);
        continue;
      }
      seen.add(name.toLowerCase());

      let json;
      try {
        json = JSON.parse(file.text);
      } catch (e) {
        errors.push(`${name} isn't valid JSON (${e.message}).`);
        continue;
      }
      const list = entryList(json);
      if (!list) {
        errors.push(`${name} doesn't contain a list of accounts.`);
        continue;
      }
      const { added, skipped } = addEntries(kind === 'followers' ? followers : following, list);
      report.push({ name, kind, entries: list.length, added });
      if (skipped) warnings.push(`${name}: ${skipped} entr${skipped === 1 ? 'y' : 'ies'} had no readable username and were skipped.`);
    }

    const hasFollowers = report.some((f) => f.kind === 'followers');
    const hasFollowing = report.some((f) => f.kind === 'following');
    if (!hasFollowers) errors.push('No followers file found (followers_1.json).');
    if (!hasFollowing) errors.push('No following file found (following.json).');

    report.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return { followers, following, files: report, warnings, errors, latestTimestamp: latestTimestamp(followers, following) };
  }

  /** Newest follow timestamp (seconds) in the data, or null: "data as of" when no export date is known. */
  function latestTimestamp(...maps) {
    let max = null;
    for (const map of maps) {
      for (const { timestamp } of map.values()) {
        if (timestamp && (max === null || timestamp > max)) max = timestamp;
      }
    }
    return max;
  }

  /**
   * Compare the two sets.
   * @returns {{notFollowingBack: Array, fans: Array, mutual: Array}} entries sorted by username
   */
  function compare(followers, following) {
    const byName = (a, b) => a.username.localeCompare(b.username);
    const notFollowingBack = [];
    const mutual = [];
    for (const entry of following.values()) {
      (followers.has(entry.username) ? mutual : notFollowingBack).push(entry);
    }
    const fans = [...followers.values()].filter((e) => !following.has(e.username));
    return {
      notFollowingBack: notFollowingBack.sort(byName),
      fans: fans.sort(byName),
      mutual: mutual.sort(byName),
    };
  }

  return {
    classifyFile,
    normalizeUsername,
    usernameFromHref,
    parseEntry,
    parseExport,
    compare,
  };
});
