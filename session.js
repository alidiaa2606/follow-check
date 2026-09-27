/*
 * Optional session tracking for the Unfollow Queue: how many accounts you have
 * marked Done in this session, against a target you choose yourself.
 *
 * There is no published "safe" Instagram limit; the target is only your own
 * number. Nothing here performs, stops or continues any Instagram action.
 * Saved in localStorage so a reload doesn't lose the count; reset it any time.
 * Works as a browser <script> (window.IGSession) and as a Node module (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.IGSession = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STORAGE_KEY = 'followcheck.session.v1';
  const MAX_TARGET = 10000;

  /** Validate saved/backup session data or throw. */
  function normalize(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('session data is not an object');
    const count = Number(data.count ?? 0);
    if (!Number.isInteger(count) || count < 0) throw new Error('invalid session count');
    const target = data.target ?? null;
    if (target !== null && !(Number.isInteger(target) && target >= 1 && target <= MAX_TARGET)) throw new Error('invalid session target');
    return { count, target, startedAt: Number(data.startedAt) || 0 };
  }

  /** Parse a target typed by the user: '' → null (no target); else an integer 1…10,000, or throws. */
  function parseTarget(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TARGET) throw new Error(`Enter a whole number from 1 to ${MAX_TARGET.toLocaleString('en-US')}, or leave it empty.`);
    return n;
  }

  function createSessionTracker({ storage }) {
    let state = { count: 0, target: null, startedAt: Date.now() };

    function load() {
      state = { count: 0, target: null, startedAt: Date.now() };
      if (!storage) return;
      try {
        const raw = storage.getItem(STORAGE_KEY);
        if (raw) state = normalize(JSON.parse(raw));
      } catch {
        // Corrupt data: start a fresh session.
      }
    }
    function save() {
      if (!storage) return;
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...state }));
      } catch {
        // Not saved; the count still works for this page.
      }
    }
    load();

    return {
      count: () => state.count,
      target: () => state.target,
      /** Add (or with a negative number, take back) handled accounts. Never below zero. */
      add(n) {
        state.count = Math.max(0, state.count + n);
        save();
        return state.count;
      },
      setTarget(target) {
        state.target = target === null ? null : normalize({ count: 0, target }).target;
        save();
      },
      reached: () => state.target !== null && state.count >= state.target,
      /** Start a new session: count back to 0 (the target is kept). */
      reset() {
        state = { count: 0, target: state.target, startedAt: Date.now() };
        save();
      },
      snapshot: () => ({ version: 1, ...state }),
      reload: load,
    };
  }

  return { STORAGE_KEY, MAX_TARGET, normalize, parseTarget, createSessionTracker };
});
