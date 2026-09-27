/* Follow Check: page logic. Reads the export in the browser; nothing is sent anywhere. */
(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const $ = (id) => document.getElementById(id);

  const TABS = {
    notFollowingBack: { empty: 'Everyone you follow follows you back.', dateLabel: 'You followed' },
    fans: { empty: 'You follow back everyone who follows you.', dateLabel: 'Followed you' },
    mutual: { empty: 'No mutual follows.', dateLabel: 'You followed' },
    following: { empty: "You don't follow anyone.", dateLabel: 'You followed' },
    followers: { empty: 'No followers.', dateLabel: 'Followed you' },
  };

  const TAG_LABELS = { keep: 'Keep', ignore: 'Ignore', unavailable: 'Unavailable' };
  const TAG_HINTS = {
    keep: 'Keep: you want to keep following this account',
    ignore: 'Ignore: leave this account out when reviewing who to unfollow',
    unavailable: 'Unavailable: the account looks deleted, deactivated or suspended',
  };
  const FILTER_EMPTY = {
    unreviewed: 'Nothing left to review. Every account here has a tag.',
    keep: 'No accounts tagged Keep yet.',
    ignore: 'No accounts tagged Ignore yet.',
    unavailable: 'No accounts tagged Unavailable yet.',
  };

  let storage = null;
  try {
    storage = window.localStorage;
  } catch {
    // Storage blocked (e.g. some privacy modes): tags work for this session only.
  }
  const tags = IGTags.createTagStore(storage);
  let review = null; // Review Mode session for the current export (review.js)
  let reviewedThisVisit = false; // switches the button label to "Resume review"

  const state = {
    lists: null, // { notFollowingBack, fans, mutual, following, followers }
    tab: 'notFollowingBack',
    filter: 'all', // tag filter, used on the "not following back" tab
    query: '',
    sort: 'az',
    limit: PAGE_SIZE,
    selected: new Set(), // usernames ticked in "not following back" (kept across search/filter changes)
    shown: [], // usernames of the rows currently on screen
    matchCount: 0, // rows matching the current search/filter (may exceed shown when paged)
  };

  // ---------- Reading files ----------

  const isZip = (file) => /\.zip$/i.test(file.name) || file.type === 'application/zip';
  const relPath = (file) => file.webkitRelativePath || file.relativePath || file.name;

  /**
   * Turn picked/dropped files (ZIPs and/or JSON) into [{name, text, date}] for the parser.
   * `date` is only set for files from a ZIP, where it's when Instagram created the export.
   */
  async function readFiles(files) {
    const out = [];
    for (const file of files) {
      if (isZip(file)) {
        let zip;
        try {
          zip = await JSZip.loadAsync(file);
        } catch (e) {
          throw new Error(`${file.name} couldn't be opened as a ZIP file.`);
        }
        const entries = [];
        zip.forEach((path, entry) => {
          if (!entry.dir && IGParser.classifyFile(path)) entries.push(entry);
        });
        for (const entry of entries) {
          out.push({ name: entry.name, text: await entry.async('string'), date: entry.date });
        }
      } else if (IGParser.classifyFile(relPath(file))) {
        out.push({ name: relPath(file), text: await file.text() });
      }
    }
    return out;
  }

  /** Collect files from a drop, including files inside dropped folders. */
  async function filesFromDrop(dataTransfer) {
    const items = [...(dataTransfer.items || [])];
    const entries = items.map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files];

    const files = [];
    const readAll = (reader) => new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
      next();
    });
    async function walk(entry) {
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        file.relativePath = entry.fullPath.replace(/^\//, '');
        files.push(file);
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child);
      }
    }
    for (const entry of entries) await walk(entry);
    return files;
  }

  async function handleFiles(files) {
    files = [...files];
    if (!files.length) return;
    clearMessages();
    setStatus('Reading your export…');
    try {
      const inputs = await readFiles(files);
      if (!inputs.length) {
        setStatus('');
        showMessages([
          "Couldn't find followers_1.json or following.json in what you selected.",
          'Make sure you picked the Instagram export (JSON format), or the files from its connections/followers_and_following folder.',
        ], 'error');
        return;
      }
      const result = IGParser.parseExport(inputs);
      setStatus('');
      if (result.errors.length) {
        showMessages(result.errors.concat(result.warnings), 'error');
        return;
      }
      if (result.warnings.length) showMessages(result.warnings, 'warning');
      const zipDates = inputs.map((f) => f.date).filter((d) => d instanceof Date && !isNaN(d));
      const exportDate = zipDates.length ? new Date(Math.max(...zipDates)) : null;
      showResults(result, exportDate);
    } catch (e) {
      setStatus('');
      showMessages([e.message || String(e)], 'error');
    }
  }

  // ---------- Results ----------

  function showResults(result, exportDate) {
    const { followers, following } = result;
    const { notFollowingBack, fans, mutual } = IGParser.compare(followers, following);
    const byName = (a, b) => a.username.localeCompare(b.username);
    state.lists = {
      notFollowingBack,
      fans,
      mutual,
      following: [...following.values()].sort(byName),
      followers: [...followers.values()].sort(byName),
    };

    $('stat-followers').textContent = fmt(followers.size);
    $('stat-following').textContent = fmt(following.size);
    $('stat-nfb').textContent = fmt(notFollowingBack.length);
    $('stat-mutual').textContent = fmt(mutual.length);
    $('stat-fans').textContent = fmt(fans.length);
    for (const el of document.querySelectorAll('[data-count]')) {
      el.textContent = fmt(state.lists[el.dataset.count].length);
    }

    const dates = [];
    if (exportDate) dates.push(`Export created ${dateFormat.format(exportDate)}.`);
    if (result.latestTimestamp) dates.push(`Newest activity in the data: ${formatDate(result.latestTimestamp)}.`);
    $('data-date').textContent = dates.join(' ');

    const sources = ['Read ' + result.files.map((f) => `${f.name} (${fmt(f.entries)})`).join(', ') + '.'];
    const missing = tags.countMissing(new Set(notFollowingBack.map((e) => e.username)));
    if (missing) {
      sources.push(`${fmt(missing)} saved tag${missing === 1 ? ' is' : 's are'} for accounts not in this “Not following back” list. They're kept in case those accounts show up again.`);
    }
    $('sources').textContent = sources.join(' ');

    $('upload').hidden = true;
    $('results').hidden = false;
    $('reset').hidden = false;
    state.query = '';
    $('search').value = '';
    state.selected.clear();
    review = IGReview.createReviewSession({
      order: notFollowingBack.map((e) => e.username),
      tags,
      storage,
    });
    updateTagCounts();
    setTab('notFollowingBack');
  }

  function updateTagCounts() {
    if (!state.lists) return;
    const c = tags.counts(state.lists.notFollowingBack);
    $('stat-reviewed').textContent = fmt(c.keep + c.ignore + c.unavailable);
    $('stat-breakdown').textContent = `${fmt(c.keep)} keep · ${fmt(c.ignore)} ignore · ${fmt(c.unavailable)} unavailable`;
    for (const el of document.querySelectorAll('[data-filter-count]')) {
      el.textContent = fmt(c[el.dataset.filterCount]);
    }
    $('storage-warning').hidden = tags.isPersistent();
    updateReviewLaunch();
  }

  function setTab(tab) {
    state.tab = tab;
    state.limit = PAGE_SIZE;
    for (const el of document.querySelectorAll('#tabs [role=tab]')) {
      el.setAttribute('aria-selected', String(el.dataset.tab === tab));
    }
    for (const el of document.querySelectorAll('.stat[data-tab]')) {
      el.classList.toggle('active', el.dataset.tab === tab);
    }
    render();
  }

  function setFilter(filter) {
    state.filter = filter;
    state.limit = PAGE_SIZE;
    render();
  }

  function normalizeQuery(q) {
    return q.trim().replace(/^@/, '').toLowerCase();
  }

  function sorted(list) {
    const ts = (e) => e.timestamp;
    switch (state.sort) {
      case 'za': return [...list].reverse();
      case 'newest': return [...list].sort((a, b) => (ts(b) ?? -Infinity) - (ts(a) ?? -Infinity));
      case 'oldest': return [...list].sort((a, b) => (ts(a) ?? Infinity) - (ts(b) ?? Infinity));
      // Lists are A→Z and sort() is stable, so each group stays A→Z.
      case 'unreviewed': return [...list].sort((a, b) => Boolean(tags.get(a.username)) - Boolean(tags.get(b.username)));
      case 'reviewed': return [...list].sort((a, b) => Boolean(tags.get(b.username)) - Boolean(tags.get(a.username)));
      default: return list; // lists are already A→Z
    }
  }

  const taggable = () => state.tab === 'notFollowingBack';

  function render() {
    if (!state.lists) return;
    const all = state.lists[state.tab];
    const filtering = taggable() && state.filter !== 'all';
    const base = filtering ? tags.filter(all, state.filter) : all;
    const q = normalizeQuery(state.query);
    const matches = sorted(q ? base.filter((e) => e.username.includes(q)) : base);
    const shown = matches.slice(0, state.limit);
    state.shown = shown.map((e) => e.username);
    state.matchCount = matches.length;

    $('filters').hidden = !taggable();
    for (const el of document.querySelectorAll('#filters [data-filter]')) {
      el.setAttribute('aria-pressed', String(el.dataset.filter === state.filter));
    }

    const list = $('list');
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const entry of shown) frag.appendChild(row(entry, q));
    list.appendChild(frag);

    if (!all.length) {
      list.appendChild(emptyRow(TABS[state.tab].empty));
    } else if (!base.length) {
      list.appendChild(emptyRow(FILTER_EMPTY[state.filter]));
    } else if (!matches.length) {
      list.appendChild(emptyRow(`No usernames match “${state.query.trim()}”.`));
    }

    const noun = (n) => `${fmt(n)} account${n === 1 ? '' : 's'}`;
    const filterLabel = filtering ? ` · ${state.filter === 'unreviewed' ? 'Unreviewed' : TAG_LABELS[state.filter]}` : '';
    $('list-summary').textContent = q
      ? `${fmt(matches.length)} of ${noun(base.length)} match “${state.query.trim()}”${filterLabel}`
      : `${noun(base.length)}${filterLabel}`;

    updateSelectionUI();

    const remaining = matches.length - shown.length;
    $('more').hidden = remaining <= 0;
    $('more').textContent = `Show ${fmt(Math.min(remaining, PAGE_SIZE))} more (${fmt(remaining)} left)`;
  }

  function row(entry, q) {
    const tag = tags.get(entry.username);
    const li = document.createElement('li');
    li.className = 'row' + (tag ? ` tagged-${tag}` : '');
    li.dataset.username = entry.username;
    if (tag) li.dataset.tag = tag;
    if (taggable()) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.className = 'select';
      box.checked = state.selected.has(entry.username);
      box.setAttribute('aria-label', `Select @${entry.username}`);
      li.classList.toggle('selected', box.checked);
      li.appendChild(box);
    }

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = entry.username.replace(/[^a-z0-9]/g, '').charAt(0).toUpperCase() || '@';
    avatar.style.setProperty('--hue', hue(entry.username));

    const info = document.createElement('div');
    info.className = 'info';
    const link = document.createElement('a');
    link.className = 'username';
    link.href = entry.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append('@', ...highlight(entry.username, q));
    info.appendChild(link);
    if (entry.timestamp) {
      const date = document.createElement('span');
      date.className = 'date';
      date.textContent = `${TABS[state.tab].dateLabel} ${formatDate(entry.timestamp)}`;
      info.appendChild(date);
    }
    li.append(avatar, info);

    if (taggable()) {
      li.appendChild(tagButtons(entry.username, tag));
    } else if (tag) {
      const badge = document.createElement('span');
      badge.className = `badge ${tag}`;
      badge.textContent = TAG_LABELS[tag];
      li.appendChild(badge);
    }
    return li;
  }

  function tagButtons(username, current) {
    const group = document.createElement('div');
    group.className = 'tag-buttons';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', `Tag @${username}`);
    for (const tag of IGTags.TAGS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `tag-btn ${tag}`;
      b.dataset.setTag = tag;
      b.textContent = TAG_LABELS[tag];
      const on = current === tag;
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? `${TAG_LABELS[tag]} (click again to remove the tag)` : TAG_HINTS[tag];
      group.appendChild(b);
    }
    return group;
  }

  function applyTag(username, tag, { toast = true } = {}) {
    const previous = tags.get(username);
    tags.set(username, tag);
    updateTagCounts();
    render();
    // Keep keyboard focus on the row if it's still visible.
    const btn = $('list').querySelector(`.row[data-username="${username}"] [data-set-tag="${tag || previous}"]`);
    if (btn) btn.focus();
    if (toast) {
      showToast(tag ? `@${username} tagged ${TAG_LABELS[tag]}` : `Removed tag from @${username}`,
        () => applyTag(username, previous, { toast: false }));
    }
  }

  function emptyRow(text) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = text;
    return li;
  }

  /** Split a username into text nodes with the search match wrapped in <mark>. */
  function highlight(name, q) {
    const i = q ? name.indexOf(q) : -1;
    if (i < 0) return [name];
    const mark = document.createElement('mark');
    mark.textContent = name.slice(i, i + q.length);
    return [name.slice(0, i), mark, name.slice(i + q.length)];
  }

  // ---------- Selection and bulk actions ----------

  const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;

  function updateSelectionUI() {
    $('bulk-bar').hidden = !taggable();
    if (!taggable()) return;
    const count = state.selected.size;
    const onScreen = new Set(state.shown);
    const hidden = [...state.selected].filter((u) => !onScreen.has(u)).length;
    const allShownSelected = state.shown.length > 0 && state.shown.every((u) => state.selected.has(u));

    $('selected-count').textContent = `${fmt(count)} selected` + (hidden ? ` · ${fmt(hidden)} not visible` : '');
    $('select-visible').textContent = `Select all visible (${fmt(state.shown.length)})`;
    $('select-visible').disabled = !state.shown.length || allShownSelected;
    $('select-none').disabled = count === 0;
    for (const b of document.querySelectorAll('[data-bulk]')) b.disabled = count === 0;

    const notes = [];
    if (hidden) {
      notes.push(`${plural(hidden, 'selected account')} ${hidden === 1 ? "isn't" : "aren't"} visible with the current search or filter. ` +
        `${hidden === 1 ? 'It is' : 'They are'} still selected and will be included in a bulk action.`);
    }
    if (state.matchCount > state.shown.length) {
      notes.push(`“Select all visible” only selects the ${fmt(state.shown.length)} accounts on screen. Use “Show more” to include more.`);
    }
    $('bulk-note').textContent = notes.join(' ');
    $('bulk-note').hidden = !notes.length;
  }

  function toggleSelected(username, on) {
    if (on) state.selected.add(username);
    else state.selected.delete(username);
    const row = $('list').querySelector(`.row[data-username="${username}"]`);
    if (row) row.classList.toggle('selected', on);
    updateSelectionUI();
  }

  /** Ask before changing anything. Resolves true only if the user presses the confirm button. */
  function confirmDialog({ title, detail, hiddenNote, okLabel }) {
    const dialog = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-detail').textContent = detail;
    $('confirm-hidden').textContent = hiddenNote || '';
    $('confirm-hidden').hidden = !hiddenNote;
    $('confirm-ok').textContent = okLabel;
    dialog.returnValue = '';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }

  async function bulkApply(action) {
    const usernames = [...state.selected];
    if (!usernames.length) return;
    const tag = action === 'clear' ? null : action;
    const noun = plural(usernames.length, 'account');
    const c = tags.counts(usernames.map((username) => ({ username })));
    const current = [
      c.unreviewed && `${fmt(c.unreviewed)} unreviewed`,
      c.keep && `${fmt(c.keep)} Keep`,
      c.ignore && `${fmt(c.ignore)} Ignore`,
      c.unavailable && `${fmt(c.unavailable)} Unavailable`,
    ].filter(Boolean).join(', ');
    const onScreen = new Set(state.shown);
    const hidden = usernames.filter((u) => !onScreen.has(u)).length;

    const ok = await confirmDialog({
      title: tag ? `Mark ${noun} as ${TAG_LABELS[tag]}?` : `Clear tags from ${noun}?`,
      detail: `Right now: ${current}. Nothing changes until you confirm.`,
      hiddenNote: hidden ? `${fmt(hidden)} of these accounts ${hidden === 1 ? 'is' : 'are'} selected but not visible with the current search or filter.` : '',
      okLabel: tag ? `Mark ${noun} as ${TAG_LABELS[tag]}` : `Clear tags from ${noun}`,
    });
    if (!ok) return;

    const previous = usernames.map((u) => [u, tags.get(u)]);
    tags.setMany(usernames.map((u) => [u, tag]));
    state.selected.clear();
    updateTagCounts();
    render();
    showToast(tag ? `Marked ${noun} as ${TAG_LABELS[tag]}` : `Cleared tags from ${noun}`, () => {
      tags.setMany(previous);
      updateTagCounts();
      render();
    });
  }

  // ---------- Review Mode ----------

  const inReview = () => !$('review').hidden;
  const entryByName = (username) => state.lists.notFollowingBack.find((e) => e.username === username);

  function updateReviewLaunch() {
    if (!review) return;
    const p = review.progress();
    $('review-launch').hidden = p.total === 0;
    const resumable = p.remaining > 0 && (review.hasSavedProgress || reviewedThisVisit);
    $('review-start').textContent = p.remaining === 0 ? 'Open review' : resumable ? 'Resume review' : 'Start review';
    $('review-launch-status').textContent = p.remaining === 0
      ? `All ${fmt(p.total)} accounts reviewed.`
      : `Go through the ${fmt(p.remaining)} unreviewed account${p.remaining === 1 ? '' : 's'} one at a time. ${fmt(p.reviewed)} / ${fmt(p.total)} reviewed so far.`;
  }

  function enterReview() {
    if (!review) return;
    reviewedThisVisit = true;
    review.start();
    hideToast();
    $('results').hidden = true;
    $('review').hidden = false;
    window.scrollTo(0, 0);
    renderReview();
  }

  function exitReview() {
    $('review').hidden = true;
    $('results').hidden = false;
    updateTagCounts();
    render();
  }

  function renderReview() {
    const p = review.progress();
    const pct = (n) => (p.total ? (n / p.total) * 100 : 0);
    $('rv-progress-text').textContent = `${fmt(p.reviewed)} / ${fmt(p.total)} reviewed`;
    $('rv-percent').textContent = `${Math.floor(pct(p.reviewed))}%`;
    $('rv-bar').setAttribute('aria-valuemax', String(p.total));
    $('rv-bar').setAttribute('aria-valuenow', String(p.reviewed));
    for (const t of IGTags.TAGS) {
      $(`rv-seg-${t}`).style.width = `${pct(p[t])}%`;
      $(`rv-${t}`).textContent = fmt(p[t]);
    }
    $('rv-total').textContent = fmt(p.total);
    $('rv-reviewed').textContent = fmt(p.reviewed);
    $('rv-remaining').textContent = fmt(p.remaining);

    const username = review.current();
    $('rv-account').hidden = username === null;
    $('rv-done').hidden = username !== null;
    $('rv-skip').disabled = username === null;
    $('rv-prev').disabled = !review.canPrevious();
    $('rv-undo').disabled = !review.canUndo();

    if (username === null) {
      const skipped = review.skippedCount();
      $('rv-done-text').textContent = skipped
        ? `You've been through every account except the ${fmt(skipped)} you skipped.`
        : `Every account in “Not following back” has a tag. You can still change tags in the list.`;
      $('rv-review-skipped').hidden = !skipped;
      $('rv-review-skipped').textContent = `Review ${fmt(skipped)} skipped account${skipped === 1 ? '' : 's'}`;
      return;
    }

    const entry = entryByName(username);
    const tag = tags.get(username);
    $('rv-position').textContent = `Account ${fmt(review.position())} of ${fmt(p.total)}`;
    $('rv-avatar').textContent = username.replace(/[^a-z0-9]/g, '').charAt(0).toUpperCase() || '@';
    $('rv-avatar').style.setProperty('--hue', hue(username));
    $('rv-username').textContent = `@${username}`;
    $('rv-date').textContent = entry && entry.timestamp ? `You followed on ${formatDate(entry.timestamp)}` : 'Follow date not in the export';
    $('rv-current-tag').hidden = !tag;
    $('rv-current-tag').textContent = tag ? `Currently tagged ${TAG_LABELS[tag]}. Pick a tag to change it, or Skip to leave it.` : '';
    $('rv-open').href = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    for (const b of document.querySelectorAll('[data-review-tag]')) {
      b.setAttribute('aria-pressed', String(b.dataset.reviewTag === tag));
    }
  }

  /** Run a review step, then redraw and put focus on the card so shortcuts (incl. Enter) keep working. */
  function reviewStep(fn) {
    fn();
    renderReview();
    $('rv-card').focus({ preventScroll: true });
  }

  function onReviewKey(e) {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
    const key = e.key.toLowerCase();
    if (e.altKey || ((e.ctrlKey || e.metaKey) && key !== 'z')) return;
    const onControl = el && (el.tagName === 'BUTTON' || el.tagName === 'A');
    const hasAccount = review.current() !== null;
    const actions = {
      k: () => hasAccount && reviewStep(() => review.tag('keep')),
      i: () => hasAccount && reviewStep(() => review.tag('ignore')),
      u: () => hasAccount && reviewStep(() => review.tag('unavailable')),
      s: () => hasAccount && reviewStep(() => review.skip()),
      arrowleft: () => reviewStep(() => review.previous()),
      z: () => reviewStep(() => review.undo()),
      o: () => hasAccount && $('rv-open').click(),
      enter: () => hasAccount && $('rv-open').click(),
      escape: () => exitReview(),
    };
    if (!actions[key] || (key === 'enter' && onControl)) return; // Enter on a button presses that button
    e.preventDefault();
    actions[key]();
  }

  // ---------- Toast with undo ----------

  let toastTimer = null;
  let toastUndo = null;
  function showToast(text, undo) {
    $('toast-text').textContent = text;
    toastUndo = undo;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }
  function hideToast() {
    $('toast').hidden = true;
    toastUndo = null;
  }

  // ---------- Helpers ----------

  const numberFormat = new Intl.NumberFormat();
  const fmt = (n) => numberFormat.format(n);
  const dateFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const formatDate = (seconds) => dateFormat.format(new Date(seconds * 1000));

  function hue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
    return String(h);
  }

  function setStatus(text) {
    $('status').textContent = text;
  }

  function clearMessages() {
    $('messages').replaceChildren();
  }

  function showMessages(lines, kind) {
    const box = document.createElement('div');
    box.className = `message ${kind}`;
    const ul = document.createElement('ul');
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      ul.appendChild(li);
    }
    box.appendChild(ul);
    $('messages').appendChild(box);
  }

  function reset() {
    state.lists = null;
    state.selected.clear();
    $('list').replaceChildren();
    $('results').hidden = true;
    $('review').hidden = true;
    review = null;
    $('reset').hidden = true;
    $('upload').hidden = false;
    $('file-input').value = '';
    $('folder-input').value = '';
    hideToast();
    clearMessages();
    setStatus('');
  }

  // ---------- Wiring ----------

  const dropzone = $('dropzone');
  $('file-input').addEventListener('change', (e) => handleFiles(e.target.files));
  $('folder-input').addEventListener('change', (e) => handleFiles(e.target.files));
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
  });
  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach((type) => dropzone.addEventListener(type, () => dropzone.classList.remove('dragging')));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragging');
    handleFiles(await filesFromDrop(e.dataTransfer));
  });
  // Stop the browser from opening a file dropped outside the drop zone.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  for (const el of document.querySelectorAll('[data-tab]')) {
    el.addEventListener('click', () => setTab(el.dataset.tab));
  }
  $('stat-reviewed-card').addEventListener('click', () => {
    state.filter = 'all';
    setTab('notFollowingBack');
  });
  for (const el of document.querySelectorAll('#filters [data-filter]')) {
    el.addEventListener('click', () => setFilter(el.dataset.filter));
  }
  $('list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('select')) return;
    toggleSelected(e.target.closest('.row').dataset.username, e.target.checked);
  });
  $('select-visible').addEventListener('click', () => {
    for (const u of state.shown) state.selected.add(u);
    render();
  });
  $('select-none').addEventListener('click', () => {
    state.selected.clear();
    render();
  });
  for (const b of document.querySelectorAll('[data-bulk]')) {
    b.addEventListener('click', () => bulkApply(b.dataset.bulk));
  }
  $('list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-set-tag]');
    if (!btn) return;
    const username = btn.closest('.row').dataset.username;
    const tag = btn.dataset.setTag;
    applyTag(username, tags.get(username) === tag ? null : tag); // clicking the active tag removes it
  });
  $('toast-undo').addEventListener('click', () => {
    const undo = toastUndo;
    hideToast();
    if (undo) undo();
  });
  // Another tab changed the tags: pick up the change.
  window.addEventListener('storage', (e) => {
    if (e.key !== IGTags.STORAGE_KEY) return;
    tags.reload();
    updateTagCounts();
    render();
    if (inReview()) renderReview();
  });

  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    state.limit = PAGE_SIZE;
    render();
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.query = ''; render(); }
  });
  document.addEventListener('keydown', (e) => {
    if ($('confirm').open) return; // the dialog handles its own keys (Esc cancels)
    if (inReview()) return onReviewKey(e);
    if (e.key === '/' && state.lists && document.activeElement !== $('search')) {
      e.preventDefault();
      $('search').focus();
    }
  });
  $('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    state.limit = PAGE_SIZE;
    render();
  });
  $('more').addEventListener('click', () => {
    state.limit += PAGE_SIZE;
    render();
  });
  $('reset').addEventListener('click', reset);

  $('review-start').addEventListener('click', enterReview);
  $('rv-exit').addEventListener('click', exitReview);
  $('rv-done-exit').addEventListener('click', exitReview);
  for (const b of document.querySelectorAll('[data-review-tag]')) {
    b.addEventListener('click', () => reviewStep(() => review.tag(b.dataset.reviewTag)));
  }
  $('rv-skip').addEventListener('click', () => reviewStep(() => review.skip()));
  $('rv-prev').addEventListener('click', () => reviewStep(() => review.previous()));
  $('rv-undo').addEventListener('click', () => reviewStep(() => review.undo()));
  $('rv-review-skipped').addEventListener('click', () => reviewStep(() => review.reviewSkipped()));
})();
