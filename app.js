/* Follow Check: page logic. Reads the export in the browser; nothing is sent anywhere. */
(function () {
  'use strict';

  const PAGE_SIZE = 200;
  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => document.querySelector(selector);

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
  const queue = IGQueue.createQueue({ storage }); // Unfollow Queue (queue.js)
  const QUEUE_BADGES = { pending: 'In Unfollow Queue', done: 'Queue: done', skipped: 'Queue: skipped' };
  const session = IGSession.createSessionTracker({ storage }); // optional session target (session.js)
  let review = null; // Review Mode session for the current export (review.js)
  let reviewedThisVisit = false; // switches the button label to "Resume review"

  const state = {
    lists: null, // { notFollowingBack, fans, mutual, following, followers }
    tab: 'notFollowingBack',
    filter: 'all', // tag filter, used on the "not following back" tab
    query: '',
    sort: 'az',
    limit: PAGE_SIZE,
    byName: new Map(), // username -> entry, for everyone you follow (follow dates)
    selected: new Set(), // usernames ticked in "not following back" (kept across search/filter changes)
    shown: [], // usernames of the rows currently on screen
    matchCount: 0, // rows matching the current search/filter (may exceed shown when paged)
    q: { view: 'work', filter: 'all', query: '', sort: 'az', limit: PAGE_SIZE, selected: new Set(), shown: [], matchCount: 0 },
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

  /**
   * Read a drop. This must run synchronously inside the drop event: the browser
   * empties DataTransfer items afterwards. Dropped files are taken with
   * item.getAsFile(), the same File objects the file picker gives. The
   * FileSystem entry API is used only for dropped folders, which need it to list
   * their contents (its entry.file() fails for plain files in some browsers,
   * for example Chromium on file:// pages).
   */
  function collectDrop(dataTransfer) {
    const files = [];
    const folders = [];
    const items = [...(dataTransfer.items || [])].filter((i) => i.kind === 'file');
    if (!items.length) return { files: [...(dataTransfer.files || [])], folders };
    for (const item of items) {
      const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) {
        folders.push(entry);
      } else {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    return { files, folders };
  }

  /** Dropped files and folders → the same loading flow as the file picker. */
  async function handleDrop(dataTransfer) {
    const { files, folders } = collectDrop(dataTransfer);
    if (!files.length && !folders.length) {
      clearMessages();
      showMessages(['Nothing to load: drop the ZIP file Instagram gave you (or its unzipped folder).'], 'error');
      return;
    }
    let all = files;
    if (folders.length) {
      try {
        all = files.concat(await filesFromFolders(folders));
      } catch {
        clearMessages();
        showMessages([
          "This browser couldn't read the dropped folder.",
          'Use “Choose unzipped folder” instead, or drop the ZIP file itself.',
        ], 'error');
        return;
      }
    }
    await handleFiles(all);
  }

  /** List every file inside dropped folders (with their relative paths). */
  async function filesFromFolders(folders) {
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
    for (const folder of folders) await walk(folder);
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
    state.byName = new Map(following);

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
    $('stat-unreviewed').textContent = fmt(c.unreviewed);
    $('stat-keep').textContent = fmt(c.keep);
    $('stat-ignore').textContent = fmt(c.ignore);
    $('stat-unavailable').textContent = fmt(c.unavailable);
    for (const el of document.querySelectorAll('[data-filter-count]')) {
      el.textContent = fmt(c[el.dataset.filterCount]);
    }
    $('storage-warning').hidden = tags.isPersistent();
    updateReviewLaunch();
    updateQueueLaunch();
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
    const qStatus = queue.status(entry.username);
    if (qStatus) {
      const badge = document.createElement('span');
      badge.className = `qbadge ${qStatus}`;
      badge.textContent = QUEUE_BADGES[qStatus];
      info.appendChild(badge);
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
    for (const b of document.querySelectorAll('[data-bulk], [data-queue-bulk]')) b.disabled = count === 0;

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
  function confirmDialog({ title, detail, hiddenNote, okLabel, list, danger, typeWord }) {
    const dialog = $('confirm');
    $('confirm-title').textContent = title;
    $('confirm-detail').textContent = detail;
    $('confirm-hidden').textContent = hiddenNote || '';
    $('confirm-hidden').hidden = !hiddenNote;
    const ul = $('confirm-list');
    ul.replaceChildren(...(list || []).map((line) => {
      const li = document.createElement('li');
      li.textContent = line;
      return li;
    }));
    ul.hidden = !(list && list.length);
    $('confirm-ok').textContent = okLabel;
    $('confirm-ok').classList.toggle('danger', Boolean(danger));
    $('confirm-ok').classList.toggle('primary', !danger);
    $('confirm-type-wrap').hidden = !typeWord;
    $('confirm-type-word').textContent = typeWord || '';
    $('confirm-type').value = '';
    $('confirm-ok').disabled = Boolean(typeWord);
    dialog.dataset.typeWord = typeWord || '';
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

  /** Add or remove the selected accounts to/from the Unfollow Queue, after confirmation. */
  async function queueBulk(action) {
    const selected = [...state.selected];
    if (!selected.length) return;
    const onScreen = new Set(state.shown);
    const affected = action === 'add' ? selected.filter((u) => !queue.has(u)) : selected.filter((u) => queue.has(u));
    const skippedCount = selected.length - affected.length;
    if (!affected.length) {
      showToast(action === 'add'
        ? `${skippedCount === 1 ? 'The selected account is' : `All ${fmt(skippedCount)} selected accounts are`} already in your Unfollow Queue.`
        : `None of the selected accounts are in your Unfollow Queue.`);
      return;
    }
    const noun = plural(affected.length, 'account');
    const hidden = affected.filter((u) => !onScreen.has(u)).length;
    const notes = [];
    if (action === 'add') {
      notes.push('Follow Check never unfollows anyone. The queue is a checklist for accounts you will unfollow yourself on Instagram.');
      if (skippedCount) notes.push(`${plural(skippedCount, 'other selected account')} ${skippedCount === 1 ? 'is' : 'are'} already queued and won't be added twice.`);
      const c = tags.counts(affected.map((username) => ({ username })));
      if (c.keep || c.ignore) {
        notes.push(`Heads up: ${[c.keep && `${fmt(c.keep)} tagged Keep`, c.ignore && `${fmt(c.ignore)} tagged Ignore`].filter(Boolean).join(' and ')}.`);
      }
    } else {
      const c = queue.counts(affected);
      notes.push(`Their queue progress (${fmt(c.done)} done, ${fmt(c.skipped)} skipped) is removed too. Tags are not changed.`);
      if (skippedCount) notes.push(`${plural(skippedCount, 'other selected account')} ${skippedCount === 1 ? "isn't" : "aren't"} in the queue.`);
    }
    const ok = await confirmDialog({
      title: action === 'add' ? `Add ${noun} to your Unfollow Queue?` : `Remove ${noun} from your Unfollow Queue?`,
      detail: `${notes.join(' ')} Nothing changes until you confirm.`,
      hiddenNote: hidden ? `${fmt(hidden)} of these accounts ${hidden === 1 ? 'is' : 'are'} selected but not visible with the current search or filter.` : '',
      okLabel: action === 'add' ? `Add ${noun}` : `Remove ${noun}`,
    });
    if (!ok) return;
    let undo;
    if (action === 'add') {
      const { added } = queue.add(affected);
      undo = () => queue.remove(added);
    } else {
      const previous = queue.remove(affected);
      undo = () => queue.restore(previous);
    }
    state.selected.clear();
    refreshAll();
    showToast(action === 'add' ? `Added ${noun} to your Unfollow Queue` : `Removed ${noun} from your Unfollow Queue`, () => {
      undo();
      refreshAll();
    });
  }

  /** Redraw everything that depends on tags or the queue. */
  function refreshAll() {
    updateTagCounts();
    render();
  }

  // ---------- Review Mode ----------

  const inReview = () => !$('review').hidden;
  const entryByName = (username) => state.byName.get(username);

  function updateReviewLaunch() {
    if (!review) return;
    const p = review.progress();
    $('review-start').hidden = p.total === 0;
    const resumable = p.remaining > 0 && (review.hasSavedProgress || reviewedThisVisit);
    $('review-start').textContent = p.remaining === 0 ? 'Open review' : resumable ? 'Resume review' : 'Start review';
    $('review-launch-status').textContent = p.total === 0
      ? 'Nothing to review.'
      : p.remaining === 0
        ? `All ${fmt(p.total)} accounts reviewed.`
        : `Review Mode: go through the ${fmt(p.remaining)} unreviewed account${p.remaining === 1 ? '' : 's'} one at a time. ${fmt(p.reviewed)} / ${fmt(p.total)} reviewed so far.`;
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

  /** Keys typed into text fields and menus are left alone; checkboxes and buttons still get shortcuts. */
  function isTypingTarget(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
    return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(el.type);
  }

  function onReviewKey(e) {
    const el = e.target;
    if (isTypingTarget(el)) return;
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

  // ---------- Unfollow Queue: one account at a time ----------

  const inQueue = () => !$('queue').hidden;
  const pct = (n, total) => (total ? (n / total) * 100 : 0);

  function updateQueueLaunch() {
    const c = queue.counts();
    $('stat-queue').textContent = fmt(c.total);
    $('stat-queue-done').textContent = fmt(c.done);
    $('stat-queue-remaining').textContent = fmt(c.pending);
    $('stat-queue-skipped').textContent = fmt(c.skipped);
    $('queue-launch-status').textContent = c.total === 0
      ? 'Empty. Select accounts in “Not following back” and choose “Add to Unfollow Queue”.'
      : `${fmt(c.total)} queued · ${fmt(c.done)} done · ${fmt(c.pending)} remaining · ${fmt(c.skipped)} skipped.`;
    $('queue-open').textContent = c.pending && queue.hasSavedPosition() ? 'Resume Unfollow Queue' : 'Open Unfollow Queue';
  }

  function enterQueue() {
    queue.start();
    hideToast();
    $('results').hidden = true;
    $('queue').hidden = false;
    window.scrollTo(0, 0);
    renderQueue();
    if (state.q.view === 'work') $('q-card').focus({ preventScroll: true });
  }

  function exitQueue() {
    $('queue').hidden = true;
    $('results').hidden = false;
    refreshAll();
  }

  function renderSession() {
    const count = session.count();
    const target = session.target();
    $('session-text').textContent = target
      ? `${fmt(count)} / ${fmt(target)} handled this session`
      : `${fmt(count)} handled this session`;
    $('session-bar').hidden = !target;
    if (target) {
      $('session-seg').style.width = `${Math.min(100, pct(count, target))}%`;
      $('session-bar').setAttribute('aria-valuemax', String(target));
      $('session-bar').setAttribute('aria-valuenow', String(Math.min(count, target)));
    }
    $('session-reached').hidden = !session.reached();
    $('session-reset').disabled = count === 0;
    if (document.activeElement !== $('session-target')) $('session-target').value = target ?? '';
  }

  function renderQueue() {
    renderQueueProgress();
    renderSession();
    const work = state.q.view === 'work';
    $('q-card').hidden = !work;
    $('q-shortcuts').hidden = !work;
    $('q-manage').hidden = work;
    for (const el of document.querySelectorAll('#q-views [data-qview]')) {
      el.setAttribute('aria-selected', String(el.dataset.qview === state.q.view));
    }
    if (work) renderQueueWork();
    else renderQueueManage();
  }

  function setQueueView(view) {
    state.q.view = view;
    if (view === 'work') queue.start();
    renderQueue();
    if (view === 'work') $('q-card').focus({ preventScroll: true });
  }

  // ---------- Unfollow Queue: manage list ----------

  const Q_FILTER_EMPTY = {
    all: 'Your Unfollow Queue is empty.',
    pending: 'Nothing remaining.',
    done: 'Nothing marked done yet.',
    skipped: 'Nothing skipped.',
  };
  const Q_STATUS_LABELS = { pending: 'Remaining', done: 'Done', skipped: 'Skipped' };

  function queueMatches() {
    const q = normalizeQuery(state.q.query);
    let list = queue.list(); // A→Z
    if (state.q.filter !== 'all') list = list.filter((u) => queue.status(u) === state.q.filter);
    const base = list.length;
    if (q) list = list.filter((u) => u.includes(q));
    const ts = (u) => { const e = entryByName(u); return e ? e.timestamp : null; };
    switch (state.q.sort) {
      case 'za': list.reverse(); break;
      case 'newest': list.sort((a, b) => (ts(b) ?? -Infinity) - (ts(a) ?? -Infinity)); break;
      case 'oldest': list.sort((a, b) => (ts(a) ?? Infinity) - (ts(b) ?? Infinity)); break;
      default: break;
    }
    return { list, base, q };
  }

  function renderQueueManage() {
    const c = queue.counts();
    for (const el of document.querySelectorAll('[data-qfilter-count]')) el.textContent = fmt(c[el.dataset.qfilterCount]);
    for (const el of document.querySelectorAll('#q-filters [data-qfilter]')) {
      el.setAttribute('aria-pressed', String(el.dataset.qfilter === state.q.filter));
    }
    const { list: matches, base, q } = queueMatches();
    const shown = matches.slice(0, state.q.limit);
    state.q.shown = shown;
    state.q.matchCount = matches.length;
    // Forget selections of accounts that are no longer queued.
    for (const u of state.q.selected) if (!queue.has(u)) state.q.selected.delete(u);

    const listEl = $('q-list');
    listEl.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const u of shown) frag.appendChild(queueRow(u, q));
    listEl.appendChild(frag);
    if (!base) listEl.appendChild(emptyRow(Q_FILTER_EMPTY[state.q.filter]));
    else if (!matches.length) listEl.appendChild(emptyRow(`No queued usernames match “${state.q.query.trim()}”.`));

    const filterLabel = state.q.filter === 'all' ? '' : ` · ${Q_STATUS_LABELS[state.q.filter]}`;
    $('q-list-summary').textContent = q
      ? `${fmt(matches.length)} of ${plural(base, 'account')} match “${state.q.query.trim()}”${filterLabel}`
      : `${plural(base, 'account')}${filterLabel}`;
    const remaining = matches.length - shown.length;
    $('q-more').hidden = remaining <= 0;
    $('q-more').textContent = `Show ${fmt(Math.min(remaining, PAGE_SIZE))} more (${fmt(remaining)} left)`;
    updateQueueSelectionUI();
  }

  function queueRow(username, q) {
    const status = queue.status(username);
    const tag = tags.get(username);
    const entry = entryByName(username);
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.username = username;
    li.dataset.status = status;

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'select';
    box.checked = state.q.selected.has(username);
    box.setAttribute('aria-label', `Select @${username}`);
    li.classList.toggle('selected', box.checked);

    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = username.replace(/[^a-z0-9]/g, '').charAt(0).toUpperCase() || '@';
    avatar.style.setProperty('--hue', hue(username));

    const info = document.createElement('div');
    info.className = 'info';
    const link = document.createElement('a');
    link.className = 'username';
    link.href = `https://www.instagram.com/${encodeURIComponent(username)}/`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.append('@', ...highlight(username, q));
    const date = document.createElement('span');
    date.className = 'date';
    date.textContent = entry && entry.timestamp ? `You followed ${formatDate(entry.timestamp)}`
      : entry ? 'Follow date not in the export' : 'Not in the loaded export';
    info.append(link, date);

    const badges = document.createElement('div');
    badges.className = 'row-badges';
    const sb = document.createElement('span');
    sb.className = `qbadge ${status}`;
    sb.textContent = Q_STATUS_LABELS[status];
    badges.appendChild(sb);
    if (tag) {
      const tb = document.createElement('span');
      tb.className = `badge ${tag}`;
      tb.textContent = TAG_LABELS[tag];
      badges.appendChild(tb);
    }
    li.append(box, avatar, info, badges);
    return li;
  }

  function updateQueueSelectionUI() {
    const sel = state.q.selected;
    const onScreen = new Set(state.q.shown);
    const hidden = [...sel].filter((u) => !onScreen.has(u)).length;
    const allShown = state.q.shown.length > 0 && state.q.shown.every((u) => sel.has(u));
    $('q-selected-count').textContent = `${fmt(sel.size)} selected` + (hidden ? ` · ${fmt(hidden)} not visible` : '');
    $('q-select-visible').textContent = `Select all visible (${fmt(state.q.shown.length)})`;
    $('q-select-visible').disabled = !state.q.shown.length || allShown;
    $('q-select-none').disabled = sel.size === 0;
    for (const b of document.querySelectorAll('[data-qbulk]')) b.disabled = sel.size === 0;
    const notes = [];
    if (hidden) {
      notes.push(`${plural(hidden, 'selected account')} ${hidden === 1 ? "isn't" : "aren't"} visible with the current search or filter. ` +
        `${hidden === 1 ? 'It is' : 'They are'} still selected and will be included in a bulk action.`);
    }
    if (state.q.matchCount > state.q.shown.length) {
      notes.push(`“Select all visible” only selects the ${fmt(state.q.shown.length)} accounts on screen. Use “Show more” to include more.`);
    }
    $('q-bulk-note').textContent = notes.join(' ');
    $('q-bulk-note').hidden = !notes.length;
  }

  async function queueManageBulk(action) {
    const selected = [...state.q.selected].filter((u) => queue.has(u));
    if (!selected.length) return;
    const affected = action === 'done' ? selected.filter((u) => queue.status(u) !== 'done')
      : action === 'skipped' ? selected.filter((u) => queue.status(u) !== 'skipped')
        : selected;
    const unchanged = selected.length - affected.length;
    if (!affected.length) {
      showToast(`${unchanged === 1 ? 'The selected account is' : `All ${fmt(unchanged)} selected accounts are`} already marked ${action}.`);
      return;
    }
    const noun = plural(affected.length, 'account');
    const onScreen = new Set(state.q.shown);
    const hidden = affected.filter((u) => !onScreen.has(u)).length;
    const texts = {
      done: [`Mark ${noun} as done?`, 'This only records that you handled them yourself on Instagram. Follow Check does not check or unfollow anything.', `Mark ${noun} done`],
      skipped: [`Mark ${noun} as skipped?`, 'They stay in the queue so you can come back to them.', `Mark ${noun} skipped`],
      remove: [`Remove ${noun} from your Unfollow Queue?`, 'Their queue progress is removed too. Tags are not changed.', `Remove ${noun}`],
      keep: [`Keep ${noun} instead?`, 'They are removed from the Unfollow Queue and tagged Keep.', `Keep ${noun}`],
    };
    const [title, detail, okLabel] = texts[action];
    const extra = unchanged ? ` ${plural(unchanged, 'other selected account')} ${unchanged === 1 ? 'is' : 'are'} already marked ${action} and won't change.` : '';
    const ok = await confirmDialog({
      title,
      detail: `${detail}${extra} Nothing changes until you confirm.`,
      hiddenNote: hidden ? `${fmt(hidden)} of these accounts ${hidden === 1 ? 'is' : 'are'} selected but not visible with the current search or filter.` : '',
      okLabel,
    });
    if (!ok) return;

    let undo;
    let message;
    if (action === 'done' || action === 'skipped') {
      // Session count: newly done accounts count; re-skipping a done account doesn't take one back.
      const newlyDone = action === 'done' ? affected.length : 0;
      const previous = queue.setStatus(affected, action);
      session.add(newlyDone);
      undo = () => { queue.restore(previous); session.add(-newlyDone); };
      message = `Marked ${noun} as ${action}`;
    } else if (action === 'remove') {
      const previous = queue.remove(affected);
      undo = () => queue.restore(previous);
      message = `Removed ${noun} from your Unfollow Queue`;
    } else {
      const prevTags = affected.map((u) => [u, tags.get(u)]);
      const previous = queue.remove(affected);
      tags.setMany(affected.map((u) => [u, 'keep']));
      undo = () => { queue.restore(previous); tags.setMany(prevTags); };
      message = `Kept ${noun} instead (removed from the queue, tagged Keep)`;
    }
    state.q.selected.clear();
    renderQueue();
    showToast(message, () => { undo(); renderQueue(); });
  }

  function renderQueueProgress() {
    const c = queue.counts();
    $('q-progress-text').textContent = `${fmt(c.done)} / ${fmt(c.total)} done`;
    $('q-percent').textContent = `${Math.floor(pct(c.done, c.total))}%`;
    $('q-bar').setAttribute('aria-valuemax', String(c.total));
    $('q-bar').setAttribute('aria-valuenow', String(c.done));
    $('q-seg-done').style.width = `${pct(c.done, c.total)}%`;
    $('q-seg-skipped').style.width = `${pct(c.skipped, c.total)}%`;
    $('q-total').textContent = fmt(c.total);
    $('q-done-count').textContent = fmt(c.done);
    $('q-remaining').textContent = fmt(c.pending);
    $('q-skipped-count').textContent = fmt(c.skipped);
    const nfb = new Set(state.lists ? state.lists.notFollowingBack.map((e) => e.username) : []);
    const stale = queue.list().filter((u) => !nfb.has(u)).length;
    $('q-stale').hidden = !stale;
    $('q-stale').textContent = stale
      ? `${plural(stale, 'queued account')} ${stale === 1 ? "isn't" : "aren't"} in the loaded export's “Not following back” list ` +
        `(for example accounts you've already unfollowed, or that follow you now). ${stale === 1 ? 'It stays' : 'They stay'} in the queue until you remove ${stale === 1 ? 'it' : 'them'}.`
      : '';
  }

  function renderQueueWork() {
    const username = queue.current();
    const c = queue.counts();
    $('q-account').hidden = username === null;
    $('q-finished').hidden = username !== null;
    $('q-prev').disabled = !queue.canPrevious();
    $('q-undo').disabled = !queue.canUndo();

    if (username === null) {
      $('q-retry-skipped').hidden = !c.skipped;
      $('q-retry-skipped').textContent = `Go through ${plural(c.skipped, 'skipped account')}`;
      if (c.total === 0) {
        $('q-finished-title').textContent = 'Your Unfollow Queue is empty';
        $('q-finished-text').textContent = 'In “Not following back”, tick the accounts you want to unfollow and choose “Add to Unfollow Queue”.';
      } else if (c.skipped) {
        $('q-finished-title').textContent = 'Nothing left to do right now';
        $('q-finished-text').textContent = `Every queued account is marked done except the ${plural(c.skipped, 'account')} you skipped.`;
      } else {
        $('q-finished-title').textContent = 'Queue complete';
        $('q-finished-text').textContent = 'You have marked every queued account as done.';
      }
      return;
    }

    const entry = entryByName(username);
    const qEntry = queue.entry(username);
    const tag = tags.get(username);
    $('q-position').textContent = `Account ${fmt(queue.position())} of ${fmt(c.total)} queued`;
    $('q-avatar').textContent = username.replace(/[^a-z0-9]/g, '').charAt(0).toUpperCase() || '@';
    $('q-avatar').style.setProperty('--hue', hue(username));
    $('q-username').textContent = `@${username}`;
    $('q-date').textContent = entry && entry.timestamp
      ? `You followed on ${formatDate(entry.timestamp)}`
      : entry ? 'Follow date not in the export' : "Not in the loaded export's following list";
    $('q-status-note').hidden = qEntry.status === 'pending';
    $('q-status-note').className = `qbadge ${qEntry.status}`;
    $('q-status-note').textContent = qEntry.status === 'done'
      ? `You marked this done${qEntry.doneAt ? ` on ${dateFormat.format(new Date(qEntry.doneAt))}` : ''}`
      : 'Skipped earlier';
    $('q-tag-note').hidden = !tag;
    $('q-tag-note').className = `badge ${tag || ''}`;
    $('q-tag-note').textContent = tag ? `Tagged ${TAG_LABELS[tag]}` : '';
    $('q-open').href = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  }

  /** Run a queue step, then redraw and keep focus on the card so shortcuts keep working. */
  function queueStep(fn) {
    fn();
    renderQueue();
    $('q-card').focus({ preventScroll: true });
  }
  function queueDone() {
    const u = queue.current();
    if (u === null) return;
    const wasDone = queue.status(u) === 'done';
    queue.markDone();
    if (!wasDone) session.add(1);
  }
  function queueUndo() {
    const action = queue.undo(tags);
    if (action && action.type === 'done' && action.prevEntry.status !== 'done') session.add(-1);
  }

  function onQueueKey(e) {
    const el = e.target;
    if (isTypingTarget(el)) return;
    const key = e.key.toLowerCase();
    if (state.q.view === 'manage') {
      if (key === 'escape') { e.preventDefault(); exitQueue(); }
      if (key === '/') { e.preventDefault(); $('q-search').focus(); }
      return;
    }
    if (e.altKey || ((e.ctrlKey || e.metaKey) && key !== 'z')) return;
    const onControl = el && (el.tagName === 'BUTTON' || el.tagName === 'A');
    const hasAccount = queue.current() !== null;
    const actions = {
      d: () => hasAccount && queueStep(queueDone),
      s: () => hasAccount && queueStep(() => queue.skip()),
      k: () => hasAccount && queueStep(() => queue.keepInstead(tags)),
      arrowleft: () => queueStep(() => queue.previous()),
      z: () => queueStep(queueUndo),
      o: () => hasAccount && $('q-open').click(),
      enter: () => hasAccount && $('q-open').click(),
      escape: () => exitQueue(),
    };
    if (!actions[key] || (key === 'enter' && onControl)) return;
    e.preventDefault();
    actions[key]();
  }

  // ---------- Backup & data ----------

  let settingsReturn = null; // ids of the sections that were visible before opening the settings

  const MAIN_SECTIONS = ['upload', 'messages', 'results', 'review', 'queue'];
  const inSettings = () => !$('settings').hidden;

  function openSettings() {
    if (inSettings()) return;
    settingsReturn = MAIN_SECTIONS.filter((id) => !$(id).hidden);
    for (const id of MAIN_SECTIONS) $(id).hidden = true;
    hideToast();
    $('settings-status').hidden = true;
    $('backup-error').hidden = true;
    $('settings').hidden = false;
    window.scrollTo(0, 0);
    renderSettings();
    $('settings-title').setAttribute('tabindex', '-1');
    $('settings-title').focus({ preventScroll: true });
  }

  function closeSettings() {
    $('settings').hidden = true;
    for (const id of settingsReturn || ['upload', 'messages']) $(id).hidden = false;
    settingsReturn = null;
    // Saved data may have changed: redraw whatever is showing again.
    if (inReview()) {
      if (review) { review.start(); renderReview(); } else exitReview();
    } else if (inQueue()) {
      queue.start();
      renderQueue();
    } else if (state.lists) {
      refreshAll();
    }
  }

  function describeSummary(sum) {
    const parts = [
      `${plural(sum.tags.total, 'tag')} (${fmt(sum.tags.keep)} Keep, ${fmt(sum.tags.ignore)} Ignore, ${fmt(sum.tags.unavailable)} Unavailable)`,
      `${plural(sum.queue.total, 'account')} in the Unfollow Queue (${fmt(sum.queue.done)} done, ${fmt(sum.queue.pending)} remaining, ${fmt(sum.queue.skipped)} skipped)`,
      sum.reviewSaved ? 'a saved Review Mode position' : 'no saved Review Mode position',
      `session: ${fmt(sum.session.count)} handled${sum.session.target ? `, target ${fmt(sum.session.target)}` : ', no target'}`,
    ];
    return parts;
  }

  /** Keys this app saved (all start with "followcheck."). */
  function savedKeys() {
    const keys = [];
    if (!storage) return keys;
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith('followcheck.')) keys.push(k);
    }
    return keys;
  }

  const shortSummary = (sum) => `${plural(sum.tags.total, 'tag')} and ${plural(sum.queue.total, 'queued account')}`;

  function currentSummary() {
    return IGBackup.summarize(IGBackup.readCurrent(storage));
  }

  function renderSettings() {
    const sum = currentSummary();
    $('saved-summary').textContent = storage
      ? `Saved now: ${describeSummary(sum).join(' · ')}.`
      : "This browser isn't allowing the app to save data, so nothing is saved.";
    const q = sum.queue;
    $$('[data-reset=review]').disabled = !(sum.tags.total || sum.reviewSaved);
    $$('[data-reset=queue-progress]').disabled = !(q.done || q.skipped);
    $$('[data-reset=queue]').disabled = !q.total;
    $$('[data-reset=all]').disabled = savedKeys().length === 0;
    $('backup-export').disabled = !storage;
  }

  function settingsMessage(text) {
    $('settings-status').textContent = text;
    $('settings-status').hidden = false;
  }

  /** Everything saved changed (import or reset): reload the stores and redraw. */
  function reloadSavedData() {
    tags.reload();
    queue.reload();
    session.reload();
    state.selected.clear();
    state.q.selected.clear();
    reviewedThisVisit = false;
    if (state.lists) {
      review = IGReview.createReviewSession({ order: state.lists.notFollowingBack.map((e) => e.username), tags, storage });
    }
    renderSettings();
  }

  function exportBackup() {
    const backup = IGBackup.create(storage);
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `follow-check-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    const sum = IGBackup.summarize(backup.data);
    settingsMessage(`Backup saved as ${name} (${plural(sum.tags.total, 'tag')}, ${plural(sum.queue.total, 'queued account')}). Keep it somewhere private.`);
  }

  async function importBackup(file) {
    $('backup-error').hidden = true;
    $('settings-status').hidden = true;
    if (!file) return;
    let parsed;
    try {
      if (file.size > IGBackup.MAX_BYTES) throw new Error('This file is too large to be a Follow Check backup.');
      parsed = IGBackup.parse(await file.text());
    } catch (e) {
      $('backup-error').textContent = `${e.message} Your saved data was not changed.`;
      $('backup-error').hidden = false;
      return;
    }
    const { data, summary } = parsed;
    const created = summary.createdAt ? new Date(summary.createdAt) : null;
    const ok = await confirmDialog({
      title: 'Restore this backup?',
      detail: `${created ? `Backup from ${dateFormat.format(created)}. ` : ''}It contains:`,
      list: describeSummary(summary),
      hiddenNote: `This replaces the Follow Check data saved in this browser now (${shortSummary(currentSummary())}). Nothing changes until you confirm.`,
      okLabel: 'Replace with backup',
    });
    if (!ok) {
      settingsMessage('Import cancelled. Nothing was changed.');
      return;
    }
    try {
      IGBackup.restore(storage, data);
    } catch (e) {
      $('backup-error').textContent = e.message;
      $('backup-error').hidden = false;
      return;
    }
    reloadSavedData();
    settingsMessage(`Backup restored: ${shortSummary(summary)}.`);
  }

  async function resetData(kind) {
    const sum = currentSummary();
    const q = sum.queue;
    const configs = {
      review: {
        title: 'Clear review progress?',
        list: [`${plural(sum.tags.total, 'tag')} will be deleted (${fmt(sum.tags.keep)} Keep, ${fmt(sum.tags.ignore)} Ignore, ${fmt(sum.tags.unavailable)} Unavailable)`,
          'Your Review Mode position and skipped list will be deleted', 'The Unfollow Queue is not changed'],
        okLabel: 'Clear review progress',
        run: () => { tags.clear(); storage.removeItem(IGReview.STORAGE_KEY); },
        done: 'Review progress cleared.',
      },
      'queue-progress': {
        title: 'Clear Unfollow Queue progress?',
        list: [`${fmt(q.done)} done and ${fmt(q.skipped)} skipped accounts go back to Remaining`,
          `All ${plural(q.total, 'account')} stay in the queue`, 'Your place in the queue is forgotten'],
        okLabel: 'Clear queue progress',
        run: () => queue.resetProgress(),
        done: 'Unfollow Queue progress cleared.',
      },
      queue: {
        title: 'Clear the Unfollow Queue?',
        list: [`All ${plural(q.total, 'account')} will be removed from the queue (${fmt(q.done)} done, ${fmt(q.pending)} remaining, ${fmt(q.skipped)} skipped)`,
          'Tags are not changed'],
        okLabel: 'Clear Unfollow Queue',
        run: () => queue.clear(),
        done: 'Unfollow Queue cleared.',
      },
      all: {
        title: 'Clear all Follow Check saved data?',
        list: [...describeSummary(sum).map((line) => `Delete ${line}`), 'Your Instagram ZIP is not touched'],
        okLabel: 'Delete all Follow Check data',
        typeWord: 'DELETE',
        run: () => {
          for (const key of savedKeys()) storage.removeItem(key);
        },
        done: 'All Follow Check saved data was deleted from this browser.',
      },
    };
    const c = configs[kind];
    const ok = await confirmDialog({
      title: c.title,
      detail: kind === 'all' ? "This can't be undone. Export a backup first if you might want it back." : "This can't be undone.",
      list: c.list,
      okLabel: c.okLabel,
      danger: true,
      typeWord: c.typeWord,
    });
    if (!ok) {
      settingsMessage('Cancelled. Nothing was deleted.');
      return;
    }
    c.run();
    reloadSavedData();
    settingsMessage(c.done);
  }

  // ---------- Toast with undo ----------

  let toastTimer = null;
  let toastUndo = null;
  function showToast(text, undo) {
    $('toast-text').textContent = text;
    toastUndo = undo || null;
    $('toast-undo').hidden = !undo;
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
    if (inSettings()) { $('settings').hidden = true; settingsReturn = null; }
    state.lists = null;
    state.selected.clear();
    state.q.selected.clear();
    $('list').replaceChildren();
    $('results').hidden = true;
    $('review').hidden = true;
    $('queue').hidden = true;
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
  // Drag and drop. While the upload screen is showing, the whole page accepts a
  // dropped export (so a drop just outside the dashed box isn't silently lost),
  // and the drop zone lights up. The browser is never allowed to open or navigate
  // to a dropped file, on any screen.
  const uploadShowing = () => !$('upload').hidden;
  const draggingFiles = (e) => Boolean(e.dataTransfer) && [...(e.dataTransfer.types || [])].includes('Files');
  let dragTimer = null;
  function showDragging() {
    dropzone.classList.add('dragging');
    clearTimeout(dragTimer);
    // dragover repeats while the pointer is over the page; when it stops, the drag has left.
    dragTimer = setTimeout(() => dropzone.classList.remove('dragging'), 400);
  }
  function hideDragging() {
    clearTimeout(dragTimer);
    dropzone.classList.remove('dragging');
  }
  ['dragenter', 'dragover'].forEach((type) => window.addEventListener(type, (e) => {
    e.preventDefault();
    if (!draggingFiles(e)) return;
    const accept = uploadShowing();
    e.dataTransfer.dropEffect = accept ? 'copy' : 'none';
    if (accept) showDragging();
  }));
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hideDragging();
    if (!uploadShowing()) return;
    handleDrop(e.dataTransfer);
  });

  for (const el of document.querySelectorAll('[data-tab]')) {
    el.addEventListener('click', () => setTab(el.dataset.tab));
  }
  /** Dashboard: open "Not following back" with a tag filter (and optionally a sort), and scroll to it. */
  function openList(filter, sort) {
    state.filter = filter;
    if (sort) {
      state.sort = sort;
      $('sort').value = sort;
    }
    setTab('notFollowingBack');
    $('list-card').scrollIntoView({ block: 'start' });
  }
  $('stat-reviewed-card').addEventListener('click', () => openList('all', 'reviewed'));
  for (const el of document.querySelectorAll('[data-nav-filter]')) {
    el.addEventListener('click', () => openList(el.dataset.navFilter));
  }
  for (const el of document.querySelectorAll('[data-qnav]')) {
    el.addEventListener('click', () => {
      state.q.view = 'manage';
      state.q.filter = el.dataset.qnav;
      state.q.limit = PAGE_SIZE;
      enterQueue();
    });
  }
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
  for (const b of document.querySelectorAll('[data-queue-bulk]')) {
    b.addEventListener('click', () => queueBulk(b.dataset.queueBulk));
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
  // Another tab changed Follow Check's saved data: pick up the change.
  window.addEventListener('storage', (e) => {
    if (e.key !== null && !e.key.startsWith('followcheck.')) return;
    tags.reload();
    queue.reload();
    session.reload();
    if (state.lists) refreshAll();
    if (inReview() && review) renderReview();
    if (inQueue()) renderQueue();
    if (inSettings()) renderSettings();
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
    if (inSettings()) {
      if (e.key === 'Escape' && !isTypingTarget(e.target)) { e.preventDefault(); closeSettings(); }
      return;
    }
    if (inReview()) return onReviewKey(e);
    if (inQueue()) return onQueueKey(e);
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

  $('open-settings').addEventListener('click', openSettings);
  $('settings-back').addEventListener('click', closeSettings);
  $('backup-export').addEventListener('click', exportBackup);
  $('backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    await importBackup(file);
    e.target.value = ''; // allow picking the same file again
  });
  for (const b of document.querySelectorAll('[data-reset]')) {
    b.addEventListener('click', () => resetData(b.dataset.reset));
  }
  $('confirm-type').addEventListener('input', (e) => {
    $('confirm-ok').disabled = e.target.value.trim() !== $('confirm').dataset.typeWord;
  });

  $('queue-open').addEventListener('click', enterQueue);
  $('q-exit').addEventListener('click', exitQueue);
  $('q-finished-exit').addEventListener('click', exitQueue);
  $('q-done').addEventListener('click', () => queueStep(queueDone));
  $('q-skip').addEventListener('click', () => queueStep(() => queue.skip()));
  $('q-keep').addEventListener('click', () => queueStep(() => queue.keepInstead(tags)));
  $('q-prev').addEventListener('click', () => queueStep(() => queue.previous()));
  $('q-undo').addEventListener('click', () => queueStep(queueUndo));
  $('q-retry-skipped').addEventListener('click', () => queueStep(() => queue.retrySkipped()));
  for (const el of document.querySelectorAll('#q-views [data-qview]')) {
    el.addEventListener('click', () => setQueueView(el.dataset.qview));
  }
  $('session-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      session.setTarget(IGSession.parseTarget($('session-target').value));
      $('session-error').hidden = true;
      $('session-target').blur();
      renderSession();
    } catch (err) {
      $('session-error').textContent = err.message;
      $('session-error').hidden = false;
    }
  });
  $('session-reset').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset the session counter?',
      detail: `The count (${fmt(session.count())} handled) goes back to 0. Your queue, its done states and your target are not changed.`,
      okLabel: 'Reset counter',
    });
    if (!ok) return;
    session.reset();
    renderSession();
  });
  $('q-search').addEventListener('input', (e) => {
    state.q.query = e.target.value;
    state.q.limit = PAGE_SIZE;
    renderQueueManage();
  });
  $('q-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.q.query = ''; renderQueueManage(); }
  });
  $('q-sort').addEventListener('change', (e) => {
    state.q.sort = e.target.value;
    state.q.limit = PAGE_SIZE;
    renderQueueManage();
  });
  for (const el of document.querySelectorAll('#q-filters [data-qfilter]')) {
    el.addEventListener('click', () => {
      state.q.filter = el.dataset.qfilter;
      state.q.limit = PAGE_SIZE;
      renderQueueManage();
    });
  }
  $('q-list').addEventListener('change', (e) => {
    if (!e.target.classList.contains('select')) return;
    const row = e.target.closest('.row');
    if (e.target.checked) state.q.selected.add(row.dataset.username);
    else state.q.selected.delete(row.dataset.username);
    row.classList.toggle('selected', e.target.checked);
    updateQueueSelectionUI();
  });
  $('q-select-visible').addEventListener('click', () => {
    for (const u of state.q.shown) state.q.selected.add(u);
    renderQueueManage();
  });
  $('q-select-none').addEventListener('click', () => {
    state.q.selected.clear();
    renderQueueManage();
  });
  for (const b of document.querySelectorAll('[data-qbulk]')) {
    b.addEventListener('click', () => queueManageBulk(b.dataset.qbulk));
  }
  $('q-more').addEventListener('click', () => {
    state.q.limit += PAGE_SIZE;
    renderQueueManage();
  });
})();
