/*
 * Keep / Ignore / Unavailable tags, saved in the browser's localStorage.
 *
 * Tags are keyed by username only, so they carry over to any later export
 * that still contains that username. Tags for usernames missing from the
 * current export are kept, in case the account shows up again.
 * Works as a browser <script> (window.IGTags) and as a Node module (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGTags = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'followcheck.tags.v1';
  const TAGS = ['keep', 'ignore', 'unavailable'];
  const isTag = (t) => TAGS.includes(t);

  /**
   * @param {Storage|null} storage  usually window.localStorage; anything with getItem/setItem
   */
  function createTagStore(storage) {
    let tags = new Map(); // username -> { tag, at }
    let persistent = Boolean(storage);

    function load() {
      tags = new Map();
      if (!storage) return;
      let raw;
      try {
        raw = storage.getItem(STORAGE_KEY);
      } catch {
        persistent = false;
        return;
      }
      if (!raw) return;
      try {
        const data = JSON.parse(raw);
        for (const [username, value] of Object.entries((data && data.tags) || {})) {
          if (value && isTag(value.tag)) tags.set(username, { tag: value.tag, at: Number(value.at) || 0 });
        }
      } catch {
        // Corrupt data: start fresh rather than break the app.
      }
    }

    function save() {
      if (!storage) return false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tags: Object.fromEntries(tags) }));
        persistent = true;
      } catch {
        persistent = false;
      }
      return persistent;
    }

    load();

    return {
      /** 'keep' | 'ignore' | 'unavailable' | null */
      get(username) {
        const t = tags.get(username);
        return t ? t.tag : null;
      },
      /** Set a tag, or remove it with null. Returns whether it was saved. */
      set(username, tag) {
        if (tag === null || tag === undefined) tags.delete(username);
        else if (isTag(tag)) tags.set(username, { tag, at: Date.now() });
        else throw new Error(`Unknown tag: ${tag}`);
        return save();
      },
      /**
       * Set or remove several tags at once, saving once. `changes` is an iterable
       * of [username, tag | null]. Validates everything first: all or nothing.
       */
      setMany(changes) {
        const list = [...changes];
        for (const [, tag] of list) {
          if (tag !== null && tag !== undefined && !isTag(tag)) throw new Error(`Unknown tag: ${tag}`);
        }
        const now = Date.now();
        for (const [username, tag] of list) {
          if (tag === null || tag === undefined) tags.delete(username);
          else tags.set(username, { tag, at: now });
        }
        return save();
      },
      /** Counts for a list of entries: { all, unreviewed, keep, ignore, unavailable }. */
      counts(entries) {
        const c = { all: entries.length, unreviewed: 0, keep: 0, ignore: 0, unavailable: 0 };
        for (const e of entries) c[this.get(e.username) || 'unreviewed']++;
        return c;
      },
      /** Keep only entries matching a filter: 'all' | 'unreviewed' | a tag. */
      filter(entries, filter) {
        if (filter === 'all') return entries;
        if (filter === 'unreviewed') return entries.filter((e) => !tags.has(e.username));
        return entries.filter((e) => this.get(e.username) === filter);
      },
      /** Number of saved tags whose username isn't in the given set. */
      countMissing(usernames) {
        let n = 0;
        for (const u of tags.keys()) if (!usernames.has(u)) n++;
        return n;
      },
      size() {
        return tags.size;
      },
      /** false if the browser refused to save (e.g. storage disabled). */
      isPersistent() {
        return persistent;
      },
      reload: load,
    };
  }

  return { STORAGE_KEY, TAGS, createTagStore };
});
