/*
 * Unfollow Queue: accounts you have decided to unfollow yourself, on Instagram.
 *
 * Follow Check never unfollows anyone and never checks Instagram. "Done" only
 * records that you told Follow Check you handled the account.
 *
 * Entries are keyed by username and saved in localStorage, so the queue
 * survives reloads, browser restarts and newer exports. The one-at-a-time
 * workflow (position, previous, undo) works like Review Mode (review.js).
 * Works as a browser <script> (window.IGQueue) and as a Node module (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'followcheck.queue.v1';
  const STATUSES = ['pending', 'done', 'skipped'];
  const USERNAME_RE = /^[a-z0-9._]{1,30}$/;

  /** Validate saved/backup queue data. Returns { entries: Map, current } or throws. */
  function normalize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('queue data is not an object');
    const raw = data.entries || {};
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('queue entries are not an object');
    const entries = new Map();
    for (const [username, e] of Object.entries(raw)) {
      if (!USERNAME_RE.test(username)) throw new Error(`invalid username in queue: ${JSON.stringify(username).slice(0, 40)}`);
      if (!e || typeof e !== 'object' || !STATUSES.includes(e.status)) throw new Error(`invalid queue status for ${username}`);
      const entry = { status: e.status, addedAt: Number(e.addedAt) || 0 };
      if (e.status === 'done') entry.doneAt = Number(e.doneAt) || 0;
      entries.set(username, entry);
    }
    let current = data.current ?? null;
    if (current !== null && (typeof current !== 'string' || !entries.has(current))) current = null;
    return { entries, current };
  }

  function createQueue({ storage }) {
    let entries = new Map(); // username -> { status, addedAt, doneAt? }
    let current = null; // workflow position
    let savedPosition = false;
    let history = []; // workflow undo stack
    let order = null; // cached A→Z usernames

    function load() {
      entries = new Map();
      current = null;
      history = [];
      order = null;
      if (!storage) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (!raw) return;
        ({ entries, current } = normalize(JSON.parse(raw)));
      } catch {
        entries = new Map(); // corrupt data: start empty rather than break the app
        current = null;
      }
      savedPosition = current !== null;
    }

    function save() {
      order = null;
      if (!storage) return false;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(snapshot()));
        return true;
      } catch {
        return false;
      }
    }

    function snapshot() {
      return { version: 1, entries: Object.fromEntries(entries), current };
    }

    const sortedOrder = () => (order = order || [...entries.keys()].sort());
    const copy = (u) => (entries.has(u) ? { ...entries.get(u) } : null);

    /** Next pending account after `from` in A→Z order, wrapping round; null if none. */
    function nextPending(from) {
      const list = sortedOrder();
      if (!list.length) return null;
      let start = 0;
      if (from !== null) {
        // First index strictly after `from` (works even if `from` was just removed).
        let lo = 0;
        let hi = list.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (list[mid] <= from) lo = mid + 1;
          else hi = mid;
        }
        start = lo;
      }
      for (let k = 0; k < list.length; k++) {
        const u = list[(start + k) % list.length];
        if (entries.get(u).status === 'pending') return u;
      }
      return null;
    }

    load();

    const queue = {
      STORAGE_KEY,
      has: (u) => entries.has(u),
      status: (u) => (entries.has(u) ? entries.get(u).status : null),
      entry: copy,
      size: () => entries.size,
      /** A→Z usernames of every queued account. */
      list: () => sortedOrder().slice(),

      /** Add accounts (duplicates are ignored). Returns { added, already }. */
      add(usernames) {
        const added = [];
        const already = [];
        const now = Date.now();
        for (const u of new Set(usernames)) {
          if (entries.has(u)) already.push(u);
          else {
            entries.set(u, { status: 'pending', addedAt: now });
            order = null;
            added.push(u);
          }
        }
        if (added.length) save();
        return { added, already };
      },

      /** Remove accounts. Returns [username, previousEntry] pairs for undo. */
      remove(usernames) {
        const previous = [];
        for (const u of new Set(usernames)) {
          if (entries.has(u)) {
            previous.push([u, copy(u)]);
            entries.delete(u);
            order = null;
          }
        }
        if (current !== null && !entries.has(current)) current = nextPending(current);
        if (previous.length) save();
        return previous;
      },

      /** Set a status on several queued accounts. Returns [username, previousEntry] pairs. */
      setStatus(usernames, status) {
        if (!STATUSES.includes(status)) throw new Error(`Unknown status: ${status}`);
        const previous = [];
        const now = Date.now();
        for (const u of new Set(usernames)) {
          if (!entries.has(u)) continue;
          previous.push([u, copy(u)]);
          const e = entries.get(u);
          const next = { status, addedAt: e.addedAt };
          if (status === 'done') next.doneAt = e.status === 'done' ? e.doneAt : now;
          entries.set(u, next);
        }
        if (previous.length) save();
        return previous;
      },

      /** Put entries back exactly as they were ([username, entry|null] pairs). */
      restore(pairs) {
        for (const [u, e] of pairs) {
          if (e) entries.set(u, { ...e });
          else entries.delete(u);
        }
        order = null;
        save();
      },

      /** { total, done, pending, skipped } for the whole queue, or for the given usernames. */
      counts(usernames) {
        const c = { total: 0, done: 0, pending: 0, skipped: 0 };
        const list = usernames || entries.keys();
        for (const u of list) {
          const e = entries.get(u);
          if (!e) continue;
          c.total++;
          c[e.status]++;
        }
        return c;
      },

      // ---------- One-at-a-time workflow ----------

      /** Whether a workflow position was saved earlier (drives the "Resume" label). */
      hasSavedPosition: () => savedPosition,

      /** Begin or resume: stay on the saved account if still pending, else go to the next pending one. */
      start() {
        if (!(current !== null && entries.has(current) && entries.get(current).status === 'pending')) {
          current = nextPending(current);
        }
        savedPosition = true;
        save();
        return current;
      },
      current: () => current,
      /** 1-based position of the current account in the A→Z queue, or null. */
      position: () => (current === null ? null : sortedOrder().indexOf(current) + 1),

      markDone() {
        return step('done');
      },
      skip() {
        return step('skipped');
      },
      /** Remove the current account from the queue and tag it Keep (tags from tags.js). */
      keepInstead(tags) {
        if (current === null) return null;
        const u = current;
        history.push({ type: 'keep', username: u, prevEntry: copy(u), prevTag: tags.get(u), prevCurrent: u });
        entries.delete(u);
        order = null;
        tags.set(u, 'keep');
        current = nextPending(u);
        save();
        return current;
      },

      previous() {
        const list = sortedOrder();
        if (!list.length) return null;
        if (current === null) current = list[list.length - 1];
        else {
          const i = list.indexOf(current);
          if (i > 0) current = list[i - 1];
        }
        save();
        return current;
      },
      canPrevious() {
        const list = sortedOrder();
        return list.length > 0 && (current === null || list.indexOf(current) > 0);
      },

      /** Revert the last Done / Skip / Keep instead and go back to that account. Returns the action. */
      undo(tags) {
        const action = history.pop();
        if (!action) return null;
        if (action.prevEntry) entries.set(action.username, { ...action.prevEntry });
        else entries.delete(action.username);
        order = null;
        if (action.type === 'keep' && tags) tags.set(action.username, action.prevTag);
        current = action.username;
        save();
        return action;
      },
      canUndo: () => history.length > 0,

      /** Put skipped accounts back to pending and start from the first pending one. */
      retrySkipped() {
        for (const [u, e] of entries) if (e.status === 'skipped') entries.set(u, { status: 'pending', addedAt: e.addedAt });
        current = nextPending(null);
        history = [];
        save();
        return current;
      },

      /** Clear Done/Skipped states (everything back to pending) and the workflow position. */
      resetProgress() {
        for (const [u, e] of entries) entries.set(u, { status: 'pending', addedAt: e.addedAt });
        current = null;
        savedPosition = false;
        history = [];
        save();
      },

      /** Remove every queued account. */
      clear() {
        entries = new Map();
        current = null;
        savedPosition = false;
        history = [];
        save();
      },

      snapshot,
      reload: load,
    };

    function step(status) {
      if (current === null) return null;
      const u = current;
      history.push({ type: status === 'done' ? 'done' : 'skip', username: u, prevEntry: copy(u), prevCurrent: u });
      const e = entries.get(u);
      const next = { status, addedAt: e.addedAt };
      if (status === 'done') next.doneAt = Date.now();
      entries.set(u, next);
      current = nextPending(u);
      save();
      return current;
    }

    return queue;
  }

  return { STORAGE_KEY, STATUSES, normalize, createQueue };
});
