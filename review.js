/*
 * Review Mode: walk through unreviewed "not following back" accounts one at a time.
 *
 * Tags are stored by the tag store (tags.js). This module only keeps the
 * review position and the accounts skipped in this pass, saved in
 * localStorage by username so "Resume review" works after closing the
 * browser or uploading a newer export.
 * Works as a browser <script> (window.IGReview) and as a Node module (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGReview = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'followcheck.review.v1';

  function readSaved(storage) {
    if (!storage) return null;
    try {
      const data = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
      if (!data || typeof data !== 'object') return null;
      return {
        current: typeof data.current === 'string' ? data.current : null,
        skipped: Array.isArray(data.skipped) ? data.skipped.filter((u) => typeof u === 'string') : [],
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {object} opts
   * @param {string[]} opts.order    usernames of the "not following back" list, in review order
   * @param {object}   opts.tags     tag store from tags.js
   * @param {Storage|null} opts.storage
   */
  function createReviewSession({ order, tags, storage }) {
    const index = new Map(order.map((u, i) => [u, i]));
    const saved = readSaved(storage);
    let current = saved && index.has(saved.current) ? saved.current : null;
    const skipped = new Set(saved ? saved.skipped.filter((u) => index.has(u)) : []);
    const history = []; // undo stack: { type: 'tag' | 'skip', username, prevTag, prevSkipped }

    const isOpen = (u) => !tags.get(u) && !skipped.has(u);

    function save() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, current, skipped: [...skipped] }));
      } catch {
        // Storage unavailable: review still works for this session.
      }
    }

    /** Next unreviewed, unskipped account after `from` (wrapping round), or null. */
    function nextOpen(from) {
      const start = from !== null && index.has(from) ? index.get(from) + 1 : 0;
      for (let k = 0; k < order.length; k++) {
        const u = order[(start + k) % order.length];
        if (isOpen(u)) return u;
      }
      return null;
    }

    const session = {
      /** Whether a previous review pass was saved (drives the "Resume review" label). */
      hasSavedProgress: Boolean(saved && (saved.current || saved.skipped.length)),

      /** Begin or resume: stay on the saved account if it still needs review, else go to the next one. */
      start() {
        if (!(current && isOpen(current))) current = nextOpen(current);
        save();
        return current;
      },

      /** Username being shown, or null when there's nothing left to review. */
      current: () => current,

      /** 1-based position of the current account in the full list, or null. */
      position: () => (current === null ? null : index.get(current) + 1),

      /** Tag the current account and move to the next unreviewed one. */
      tag(tag) {
        if (current === null) return null;
        const username = current;
        history.push({ type: 'tag', username, prevTag: tags.get(username), prevSkipped: skipped.has(username) });
        tags.set(username, tag);
        skipped.delete(username);
        current = nextOpen(username);
        save();
        return current;
      },

      /** Leave the current account unreviewed for now and move on. */
      skip() {
        if (current === null) return null;
        const username = current;
        history.push({ type: 'skip', username, prevTag: tags.get(username), prevSkipped: skipped.has(username) });
        if (!tags.get(username)) skipped.add(username); // tagged accounts (reached via Previous) just move on
        current = nextOpen(username);
        save();
        return current;
      },

      /** Go to the account before this one in the list (tagged or not), to check or change it. */
      previous() {
        if (!order.length) return null;
        if (current === null) current = order[order.length - 1];
        else if (index.get(current) > 0) current = order[index.get(current) - 1];
        save();
        return current;
      },

      canPrevious: () => order.length > 0 && (current === null || index.get(current) > 0),

      /** Revert the last Keep / Ignore / Unavailable / Skip and go back to that account. */
      undo() {
        const action = history.pop();
        if (!action) return null;
        tags.set(action.username, action.prevTag);
        if (action.prevSkipped) skipped.add(action.username);
        else skipped.delete(action.username);
        current = action.username;
        save();
        return action;
      },

      canUndo: () => history.length > 0,

      skippedCount: () => [...skipped].filter((u) => !tags.get(u)).length,

      /** Clear the skipped list and start again from the first unreviewed account. */
      reviewSkipped() {
        skipped.clear();
        current = nextOpen(null);
        save();
        return current;
      },

      /** { total, reviewed, remaining, keep, ignore, unavailable, skipped } for the whole list. */
      progress() {
        const c = tags.counts(order.map((username) => ({ username })));
        return {
          total: c.all,
          reviewed: c.keep + c.ignore + c.unavailable,
          remaining: c.unreviewed,
          keep: c.keep,
          ignore: c.ignore,
          unavailable: c.unavailable,
          skipped: session.skippedCount(),
        };
      },
    };
    return session;
  }

  return { STORAGE_KEY, createReviewSession };
});
