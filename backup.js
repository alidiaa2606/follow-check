/*
 * Follow Check backup files: a local JSON download with only Follow Check's own
 * organisation data (tags, Review Mode progress, Unfollow Queue, session
 * settings). No Instagram export data is included. Nothing is uploaded.
 *
 * parse() validates strictly and throws a readable Error for anything
 * malformed, damaged or from a newer format, before any saved data changes.
 * Works as a browser <script> (window.IGBackup) and as a Node module (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./tags.js'), require('./review.js'), require('./queue.js'), require('./session.js'));
  } else {
    root.IGBackup = factory(root.IGTags, root.IGReview, root.IGQueue, root.IGSession);
  }
})(typeof self !== 'undefined' ? self : this, function (IGTags, IGReview, IGQueue, IGSession) {
  'use strict';

  const FORMAT = 'follow-check-backup';
  const VERSION = 1;
  const MAX_BYTES = 20 * 1024 * 1024;
  const USERNAME_RE = /^[a-z0-9._]{1,30}$/;
  const KEYS = {
    tags: IGTags.STORAGE_KEY,
    review: IGReview.STORAGE_KEY,
    queue: IGQueue.STORAGE_KEY,
    session: IGSession.STORAGE_KEY,
  };
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const checkUser = (u, where) => {
    if (typeof u !== 'string' || !USERNAME_RE.test(u)) throw new Error(`invalid username in ${where}`);
  };

  function normalizeTags(data) {
    const raw = data && data.tags !== undefined ? data.tags : data;
    if (!isObject(raw)) throw new Error('tags are not an object');
    const out = {};
    for (const [u, v] of Object.entries(raw)) {
      checkUser(u, 'tags');
      if (!isObject(v) || !IGTags.TAGS.includes(v.tag)) throw new Error(`invalid tag for ${u}`);
      out[u] = { tag: v.tag, at: Number(v.at) || 0 };
    }
    return out;
  }

  function normalizeReview(data) {
    if (!isObject(data)) throw new Error('review progress is not an object');
    const current = data.current ?? null;
    if (current !== null) checkUser(current, 'review progress');
    const skipped = data.skipped ?? [];
    if (!Array.isArray(skipped)) throw new Error('review skipped list is not a list');
    skipped.forEach((u) => checkUser(u, 'review progress'));
    return { current, skipped: [...new Set(skipped)] };
  }

  function normalizeQueue(data) {
    const { entries, current } = IGQueue.normalize(data);
    return { entries: Object.fromEntries(entries), current };
  }

  /** Validate the four data sections. Missing sections become empty. */
  function normalizeData(data) {
    if (!isObject(data)) throw new Error('the data section is missing');
    return {
      tags: data.tags === undefined ? {} : normalizeTags(data.tags),
      review: data.review === undefined || data.review === null ? { current: null, skipped: [] } : normalizeReview(data.review),
      queue: data.queue === undefined ? { entries: {}, current: null } : normalizeQueue(data.queue),
      session: data.session === undefined ? { count: 0, target: null, startedAt: 0 } : IGSession.normalize(data.session),
    };
  }

  function summarize(data, createdAt) {
    const tagValues = Object.values(data.tags);
    const count = (tag) => tagValues.filter((v) => v.tag === tag).length;
    const q = Object.values(data.queue.entries);
    const qCount = (status) => q.filter((e) => e.status === status).length;
    return {
      createdAt: createdAt || null,
      tags: { total: tagValues.length, keep: count('keep'), ignore: count('ignore'), unavailable: count('unavailable') },
      queue: { total: q.length, done: qCount('done'), pending: qCount('pending'), skipped: qCount('skipped') },
      reviewSaved: Boolean(data.review.current || data.review.skipped.length),
      session: { count: data.session.count, target: data.session.target },
    };
  }

  /** Read the current saved state (lenient: unreadable sections count as empty). */
  function readCurrent(storage) {
    const read = (key, fn, empty) => {
      try {
        const raw = storage && storage.getItem(key);
        return raw ? fn(JSON.parse(raw)) : empty;
      } catch {
        return empty;
      }
    };
    return {
      tags: read(KEYS.tags, normalizeTags, {}),
      review: read(KEYS.review, normalizeReview, { current: null, skipped: [] }),
      queue: read(KEYS.queue, normalizeQueue, { entries: {}, current: null }),
      session: read(KEYS.session, IGSession.normalize, { count: 0, target: null, startedAt: 0 }),
    };
  }

  /** Build a backup object from what is saved in `storage`. */
  function create(storage, now = new Date()) {
    return {
      format: FORMAT,
      version: VERSION,
      app: 'Follow Check',
      createdAt: now.toISOString(),
      contents: 'Follow Check organisation data only: tags, Review Mode progress, Unfollow Queue and session settings. No Instagram export data.',
      data: readCurrent(storage),
    };
  }

  /**
   * Validate backup file text. Returns { data, summary }; throws an Error with a
   * message suitable for showing to the user.
   */
  function parse(text) {
    if (typeof text !== 'string') throw new Error("This file couldn't be read.");
    if (text.length > MAX_BYTES) throw new Error('This file is too large to be a Follow Check backup.');
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      throw new Error("This file isn't valid JSON, so it isn't a Follow Check backup.");
    }
    if (!isObject(obj) || obj.format !== FORMAT) throw new Error("This isn't a Follow Check backup file.");
    if (!Number.isInteger(obj.version) || obj.version < 1) throw new Error('This backup has an invalid format version.');
    if (obj.version > VERSION) {
      throw new Error(`This backup was made by a newer version of Follow Check (format ${obj.version}); this version can only read format ${VERSION}.`);
    }
    let data;
    try {
      data = normalizeData(obj.data);
    } catch (e) {
      throw new Error(`This backup is damaged or incomplete (${e.message}), so nothing was restored.`);
    }
    const createdAt = typeof obj.createdAt === 'string' && !isNaN(Date.parse(obj.createdAt)) ? obj.createdAt : null;
    return { data, summary: summarize(data, createdAt) };
  }

  /** Replace all saved Follow Check data with validated backup data (all or nothing). */
  function restore(storage, data) {
    if (!storage) throw new Error("This browser isn't allowing the app to save data.");
    const values = {
      [KEYS.tags]: JSON.stringify({ version: 1, tags: data.tags }),
      [KEYS.review]: JSON.stringify({ version: 1, current: data.review.current, skipped: data.review.skipped }),
      [KEYS.queue]: JSON.stringify({ version: 1, entries: data.queue.entries, current: data.queue.current }),
      [KEYS.session]: JSON.stringify({ version: 1, ...data.session }),
    };
    const before = {};
    for (const key of Object.keys(values)) before[key] = storage.getItem(key);
    try {
      for (const [key, value] of Object.entries(values)) storage.setItem(key, value);
    } catch (e) {
      for (const [key, value] of Object.entries(before)) {
        try {
          if (value === null) storage.removeItem(key);
          else storage.setItem(key, value);
        } catch {
          // best effort
        }
      }
      throw new Error("The backup couldn't be saved in this browser (storage full or blocked). Nothing was changed.");
    }
  }

  return { FORMAT, VERSION, MAX_BYTES, KEYS, create, parse, restore, summarize, readCurrent };
});
