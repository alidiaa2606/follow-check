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

  const state = {
    lists: null, // { notFollowingBack, fans, mutual, following, followers }
    tab: 'notFollowingBack',
    query: '',
    sort: 'az',
    limit: PAGE_SIZE,
  };

  // ---------- Reading files ----------

  const isZip = (file) => /\.zip$/i.test(file.name) || file.type === 'application/zip';
  const relPath = (file) => file.webkitRelativePath || file.relativePath || file.name;

  /** Turn picked/dropped files (ZIPs and/or JSON) into [{name, text}] for the parser. */
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
        for (const entry of entries) out.push({ name: entry.name, text: await entry.async('string') });
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
      showResults(result);
    } catch (e) {
      setStatus('');
      showMessages([e.message || String(e)], 'error');
    }
  }

  // ---------- Results ----------

  function showResults(result) {
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
    $('sources').textContent = 'Read ' + result.files
      .map((f) => `${f.name} (${fmt(f.entries)})`).join(', ') + '.';

    $('upload').hidden = true;
    $('results').hidden = false;
    $('reset').hidden = false;
    state.query = '';
    $('search').value = '';
    setTab('notFollowingBack');
  }

  function setTab(tab) {
    state.tab = tab;
    state.limit = PAGE_SIZE;
    for (const el of document.querySelectorAll('#tabs [role=tab]')) {
      el.setAttribute('aria-selected', String(el.dataset.tab === tab));
    }
    for (const el of document.querySelectorAll('.stat')) {
      el.classList.toggle('active', el.dataset.tab === tab);
    }
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
      default: return list; // lists are already A→Z
    }
  }

  function render() {
    if (!state.lists) return;
    const all = state.lists[state.tab];
    const q = normalizeQuery(state.query);
    const matches = sorted(q ? all.filter((e) => e.username.includes(q)) : all);
    const shown = matches.slice(0, state.limit);

    const list = $('list');
    list.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const entry of shown) frag.appendChild(row(entry, q));
    list.appendChild(frag);

    if (!all.length) {
      list.appendChild(emptyRow(TABS[state.tab].empty));
    } else if (!matches.length) {
      list.appendChild(emptyRow(`No usernames match “${state.query.trim()}”.`));
    }

    $('list-summary').textContent = q
      ? `${fmt(matches.length)} of ${fmt(all.length)} match “${state.query.trim()}”`
      : `${fmt(all.length)} account${all.length === 1 ? '' : 's'}`;

    const remaining = matches.length - shown.length;
    $('more').hidden = remaining <= 0;
    $('more').textContent = `Show ${fmt(Math.min(remaining, PAGE_SIZE))} more (${fmt(remaining)} left)`;
  }

  function row(entry, q) {
    const li = document.createElement('li');
    li.className = 'row';
    li.dataset.username = entry.username;

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
    return li;
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
    $('list').replaceChildren();
    $('results').hidden = true;
    $('reset').hidden = true;
    $('upload').hidden = false;
    $('file-input').value = '';
    $('folder-input').value = '';
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
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value;
    state.limit = PAGE_SIZE;
    render();
  });
  $('search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.target.value = ''; state.query = ''; render(); }
  });
  document.addEventListener('keydown', (e) => {
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
})();
