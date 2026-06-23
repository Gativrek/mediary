// MediaLog UI logic. All data lives in the main process; everything here goes
// through window.api (see preload.js). Ratings are stored as integers 0–10
// (half-stars) and displayed as 0–5 stars.

const TYPES = {
  game: 'Game', movie: 'Movie', tv: 'TV Show', anime: 'Anime',
  book: 'Book', music: 'Music', other: 'Other',
};
const STATUSES = {
  completed: 'Completed', 'in-progress': 'In progress', dropped: 'Dropped',
  backlog: 'Backlog', wishlist: 'Wishlist',
};

let lib = { media: [], logs: [] };
let currentMediaId = null;  // media shown in the detail dialog
let editingMediaId = null;  // media being edited in the entry dialog (null = creating new)
let editingLogId = null;    // log being edited in the log dialog (null = adding new)
let entryCover = null;      // image filename chosen in the entry dialog
let autofillResults = [];   // last search results shown in the entry dialog
let entryTags = [];         // tags being edited in the entry dialog
let favOnly = false;        // header heart toggle: show favorites only
let currentListId = null;   // when set, the grid shows this list in its order
let dragMediaId = null;     // media id being dragged to reorder within a list
let animateGrid = false;    // animate cards in on the next render (set by refresh)

const $ = (sel) => document.querySelector(sel);

// Transient bottom-left notification. type: 'info' | 'success' | 'error'.
// The container is a popover so it renders in the top layer — visible even
// above an open modal dialog (otherwise the dialog's backdrop blurs it out).
function toast(message, type = 'info') {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  box.appendChild(el);
  // Promote to the top layer if not already shown (above any open dialog).
  try { if (!box.matches(':popover-open')) box.showPopover(); } catch { /* unsupported */ }
  // force reflow so the entrance transition runs, then show
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    el.addEventListener('transitionend', () => {
      el.remove();
      if (!box.children.length && box.matches(':popover-open')) {
        try { box.hidePopover(); } catch { /* noop */ }
      }
    }, { once: true });
  }, 3200);
}

// Escape user text before putting it into innerHTML.
const esc = (s) => (s ?? '').toString().replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Lightweight, XSS-safe inline Markdown for reviews. We escape FIRST, then
// apply formatting to the escaped text — the markers (* _ ` ~ | [ ]) survive
// escaping, and no raw user HTML can ever reach the DOM. Line breaks are kept
// by the .review element's white-space: pre-wrap, so this is inline-only.
function renderReview(text) {
  let s = esc(text);
  // links: only http(s) and mailto, so no javascript: URLs can sneak through
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_, label, url) => `<a href="${url}" target="_blank" rel="noopener">${label}</a>`);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\|\|([^|]+)\|\|/g, '<span class="spoiler">$1</span>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

// ---------- stars ----------

// Read-only star display: gray stars with a gold overlay clipped to the rating.
function starsHTML(r10) {
  if (r10 == null) return '<span class="muted small">unrated</span>';
  return `<span class="stars"><span class="stars-bg">★★★★★</span>` +
         `<span class="stars-fill" style="width:${r10 * 10}%">★★★★★</span></span>`;
}

// Clickable star input. Click position picks the value in half-star steps;
// hovering previews it. Returns { get, set } for reading/writing the value.
function makeStarInput(root) {
  root.classList.add('star-input-wrap');
  root.innerHTML =
    `<span class="stars stars-lg"><span class="stars-bg">★★★★★</span>` +
    `<span class="stars-fill">★★★★★</span></span>` +
    `<span class="star-value"></span>` +
    `<button type="button" class="link-btn">clear</button>`;

  const stars = root.querySelector('.stars');
  const fill = root.querySelector('.stars-fill');
  const valueEl = root.querySelector('.star-value');
  let value = null;

  function show(v) {
    fill.style.width = v == null ? '0%' : (v * 10) + '%';
    valueEl.textContent = v == null ? '—' : (v / 2).toFixed(1) + ' / 5';
  }
  function valueFromEvent(e) {
    const rect = stars.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    return Math.max(1, Math.ceil(frac * 10));
  }

  stars.addEventListener('mousemove', (e) => show(valueFromEvent(e)));
  stars.addEventListener('mouseleave', () => show(value));
  stars.addEventListener('click', (e) => { value = valueFromEvent(e); show(value); });
  root.querySelector('button').addEventListener('click', () => { value = null; show(null); });

  show(null);
  return { get: () => value, set: (v) => { value = v; show(v); } };
}

// ---------- helpers ----------

function logsFor(mediaId) {
  return lib.logs
    .filter((l) => l.mediaId === mediaId)
    .sort((a, b) =>
      (b.dateConsumed || '').localeCompare(a.dateConsumed || '') ||
      (b.createdAt || '').localeCompare(a.createdAt || ''));
}
const latestLog = (mediaId) => logsFor(mediaId)[0] || null;

// Extract the 11-char YouTube video id from any common URL form.
function youtubeId(url) {
  const m = (url || '').match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

const formatDate = (iso) => (iso ? new Date(iso + 'T00:00:00').toLocaleDateString() : '');

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Deterministic hue per title, so cover-less entries get varied placeholder
// colors instead of all sharing one gradient.
function hueFor(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function coverHTML(m) {
  if (m.coverImage) {
    return `<img class="cover" src="media-img://img/${esc(m.coverImage)}" alt="">`;
  }
  const hue = hueFor(m.title || '?');
  return `<div class="cover-placeholder" style="background:linear-gradient(160deg, hsl(${hue} 38% 30%), #16181e)">` +
         `<span class="ph-initial">${esc((m.title[0] || '?').toUpperCase())}</span>` +
         `<span class="ph-title">${esc(m.title)}</span></div>`;
}

async function refresh() {
  lib = await window.api.getLibrary();
  populateTagFilter();
  renderAmbient();
  animateGrid = true;   // animate the cards in on data load, not on every filter
  render();
}

// Blur the most recently logged covers into the page background, so the
// library tints its own walls (rebuilt only when data changes, not per filter).
function renderAmbient() {
  const covers = lib.media
    .filter((m) => m.coverImage)
    .map((m) => ({ cover: m.coverImage, log: latestLog(m.id) }))
    .sort((a, b) => ((b.log && b.log.createdAt) || '').localeCompare((a.log && a.log.createdAt) || ''))
    .slice(0, 4);
  $('#ambient').innerHTML = covers
    .map((x, i) => `<img class="amb amb-${i}" src="media-img://img/${esc(x.cover)}" alt="">`)
    .join('');
}

// Rebuild the header tag dropdown from every tag in the library, keeping the
// current selection if it still exists.
function populateTagFilter() {
  const sel = $('#filter-tag');
  const current = sel.value;
  const tags = [...new Set(lib.media.flatMap((m) => m.tags || []))]
    .sort((a, b) => a.localeCompare(b));
  sel.innerHTML = '<option value="">All</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = tags.includes(current) ? current : '';
}

// ---------- main grid ----------

function render() {
  // Animate cards in only on data loads (set by refresh), not on every filter
  // keystroke — toggling the class off keeps filtered re-renders snappy.
  $('#grid').classList.toggle('animate-in', animateGrid);
  animateGrid = false;

  // List view is a distinct mode: items shown in the list's own order,
  // reorderable by drag, with the normal filters/shelves bypassed.
  const list = currentListId && lib.lists.find((l) => l.id === currentListId);
  if (currentListId && !list) currentListId = null;       // list was deleted
  $('#list-banner').style.display = list ? 'block' : 'none';
  document.querySelector('.filters').style.visibility = list ? 'hidden' : 'visible';
  if (list) { renderListView(list); return; }

  const q = $('#search').value.trim().toLowerCase();
  const type = $('#filter-type').value;
  const status = $('#filter-status').value;
  const tag = $('#filter-tag').value;
  const sort = $('#sort-by').value;

  let items = lib.media.map((m) => ({ m, log: latestLog(m.id) }));
  if (q) items = items.filter((x) =>
    x.m.title.toLowerCase().includes(q) ||
    (x.m.tags || []).some((t) => t.toLowerCase().includes(q)));
  if (type) items = items.filter((x) => x.m.type === type);
  if (status) items = items.filter((x) => x.log && x.log.status === status);
  if (tag) items = items.filter((x) => (x.m.tags || []).includes(tag));
  if (favOnly) items = items.filter((x) => x.m.favorite);

  const compare = {
    recent: (a, b) => ((b.log && b.log.createdAt) || '').localeCompare((a.log && a.log.createdAt) || ''),
    title: (a, b) => a.m.title.localeCompare(b.m.title),
    rating: (a, b) => (((b.log && b.log.rating) ?? -1) - ((a.log && a.log.rating) ?? -1)),
    year: (a, b) => (b.m.releaseYear || 0) - (a.m.releaseYear || 0),
  }[sort];
  items.sort(compare);

  // Steam-style: recency shelves when sorted by "Recently added",
  // one flat shelf otherwise.
  if (sort === 'recent') {
    const groups = [];
    for (const it of items) {
      const label = shelfLabel(it.log);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(it);
      else groups.push({ label, items: [it] });
    }
    $('#grid').innerHTML = groups.map((g) => `
      <div class="shelf">
        <h2 class="shelf-label">${g.label}</h2>
        <div class="shelf-grid">${g.items.map(({ m, log }) => cardHTML(m, log)).join('')}</div>
      </div>`).join('');
  } else {
    $('#grid').innerHTML = `
      <div class="shelf">
        <div class="shelf-grid">${items.map(({ m, log }) => cardHTML(m, log)).join('')}</div>
      </div>`;
  }

  $('#empty').style.display = items.length ? 'none' : 'flex';
}

// Pure-art card; the details live in an overlay revealed on hover.
function cardHTML(m, log) {
  return `
    <article class="card" data-id="${m.id}">
      ${m.favorite ? '<span class="card-fav" title="Favorite"></span>' : ''}
      ${coverHTML(m)}
      <div class="card-overlay">
        <h3>${esc(m.title)}</h3>
        <div class="card-meta">
          ${starsHTML(log ? log.rating : null)}
          ${log ? `<span class="badge badge-${log.status}">${STATUSES[log.status] || ''}</span>` : ''}
        </div>
        <div class="card-meta">
          <span class="badge badge-type">${TYPES[m.type] || esc(m.type)}</span>
          ${m.releaseYear ? `<span class="muted small">${m.releaseYear}</span>` : ''}
        </div>
      </div>
    </article>`;
}

// List view: the list's media in its stored order, each card draggable to
// reorder and carrying a remove-from-list button.
function renderListView(list) {
  $('#list-banner-name').textContent = list.name;
  $('#list-banner-desc').textContent = list.description || '';
  $('#list-banner-desc').style.display = list.description ? 'block' : 'none';

  const byId = new Map(lib.media.map((m) => [m.id, m]));
  const items = list.items.map((id) => byId.get(id)).filter(Boolean);

  $('#grid').innerHTML = `
    <div class="shelf">
      <div class="shelf-grid">
        ${items.map((m, i) => `
          <article class="card list-card" data-id="${m.id}" draggable="true">
            <span class="card-rank">${i + 1}</span>
            <button class="card-remove" title="Remove from list" data-id="${m.id}">✕</button>
            ${coverHTML(m)}
            <div class="card-overlay"><h3>${esc(m.title)}</h3></div>
          </article>`).join('')}
      </div>
    </div>`;

  $('#empty').style.display = 'none';
  if (items.length === 0) {
    $('#grid').innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>
        </svg>
        <h2>This list is empty</h2>
        <p class="muted">Open any entry and use <strong>Add to list</strong> to drop it in here.</p>
      </div>`;
  }
}

// Bucket by when the latest log was created (matches "Recently added" order).
function shelfLabel(log) {
  const d = log && (log.createdAt || '').slice(0, 10);
  if (!d) return 'Undated';
  const days = Math.floor((new Date(todayStr()) - new Date(d)) / 86400000);
  if (days <= 0) return 'Today';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  if (days < 365) return 'This year';
  return 'Older';
}

// ---------- detail dialog ----------

function renderDetail() {
  const m = lib.media.find((x) => x.id === currentMediaId);
  if (!m) return;
  const logs = logsFor(m.id);

  $('#detail-content').innerHTML = `
    <div class="detail-head">
      ${coverHTML(m)}
      <div>
        <h2>${esc(m.title)}</h2>
        <div class="card-meta">
          <span class="badge badge-type">${TYPES[m.type] || esc(m.type)}</span>
          ${m.releaseYear ? `<span class="muted">${m.releaseYear}</span>` : ''}
        </div>
        ${(m.tags && m.tags.length)
          ? `<div class="card-meta">${m.tags.map((t) => `<span class="badge">${esc(t)}</span>`).join('')}</div>`
          : ''}
        <div class="row">
          <button id="btn-add-log">+ Add log</button>
          <button id="btn-fav-media" class="ghost ${m.favorite ? 'is-fav' : ''}">
            ${m.favorite ? '♥ Favorited' : '♡ Favorite'}
          </button>
          <button id="btn-edit-media" class="ghost">Edit</button>
          <button id="btn-delete-media" class="danger">Delete</button>
        </div>
        ${listsSectionHTML(m.id)}
      </div>
    </div>
    <div class="log-list">
      ${logs.map(logHTML).join('') || '<p class="muted">No logs yet.</p>'}
    </div>`;
}

// Toggleable chips for each list, showing which contain this media item.
function listsSectionHTML(mediaId) {
  if (lib.lists.length === 0) {
    return '<p class="muted small lists-section">No lists yet — <button class="link-btn" id="detail-create-list">create a list</button></p>';
  }
  const chips = lib.lists.map((l) => {
    const inList = l.items.includes(mediaId);
    return `<button class="list-chip ${inList ? 'in' : ''}" data-list-id="${l.id}">
      ${inList ? '✓ ' : '+ '}${esc(l.name)}</button>`;
  }).join('');
  return `<div class="lists-section"><span class="lbl">Add to list</span><div class="list-chips">${chips}</div></div>`;
}

function logHTML(log) {
  const ytId = log.videoUrl ? youtubeId(log.videoUrl) : null;
  let videoHTML = '';
  if (ytId) {
    // YouTube blocks inline embedding under file://, so link out instead:
    // a clickable poster thumbnail that opens the video in the browser.
    videoHTML = `
      <a class="video-thumb" href="${esc(log.videoUrl)}" target="_blank" rel="noopener" title="Watch on YouTube">
        <img src="https://i.ytimg.com/vi/${ytId}/hqdefault.jpg" alt="" loading="lazy">
        <span class="video-play" aria-hidden="true"></span>
        <span class="video-tag">Watch on YouTube</span>
      </a>`;
  } else if (log.videoUrl) {
    videoHTML = `<p><a href="${esc(log.videoUrl)}" target="_blank" rel="noopener">${esc(log.videoUrl)}</a></p>`;
  }
  return `
    <div class="log" data-log-id="${log.id}">
      <div class="log-head">
        <span class="muted small">${log.dateConsumed ? formatDate(log.dateConsumed) : 'no date'}</span>
        <span class="badge badge-${log.status}">${STATUSES[log.status] || ''}</span>
        ${starsHTML(log.rating)}
        <span class="spacer"></span>
        <button class="link-btn log-edit">edit</button>
        <button class="link-btn log-delete">delete</button>
      </div>
      ${log.review ? `<p class="review">${renderReview(log.review)}</p>` : ''}
      ${videoHTML}
    </div>`;
}

function openDetail(id) {
  currentMediaId = id;
  renderDetail();
  const dlg = $('#detail-dialog');
  if (!dlg.open) dlg.showModal();
}

// ---------- entry dialog (new entry, or edit media info) ----------

function openEntryDialog(mediaId) {
  editingMediaId = mediaId || null;
  const m = mediaId ? lib.media.find((x) => x.id === mediaId) : null;

  $('#entry-title-h').textContent = m ? 'Edit media' : 'Add entry';
  $('#f-title').value = m ? m.title : '';
  $('#f-type').value = m ? m.type : 'game';
  $('#f-year').value = m && m.releaseYear ? m.releaseYear : '';
  entryCover = m ? m.coverImage || null : null;
  updateCoverPreview();
  entryTags = m ? [...(m.tags || [])] : [];
  renderEntryTags();
  $('#f-tag-input').value = '';

  $('#autofill-results').style.display = 'none';
  autofillResults = [];

  // When editing, only media info is shown — logs are edited individually.
  $('#entry-log-section').style.display = m ? 'none' : 'block';
  if (!m) {
    $('#f-date').value = todayStr();
    $('#f-status').value = 'completed';
    entryRating.set(null);
    $('#f-review').value = '';
    $('#f-video').value = '';
  }

  $('#entry-dialog').showModal();
}

function updateCoverPreview() {
  const img = $('#f-cover-preview');
  if (entryCover) {
    img.src = 'media-img://img/' + entryCover;
    img.style.display = 'block';
  } else {
    img.style.display = 'none';
    img.removeAttribute('src');
  }
}

async function saveEntry() {
  const title = $('#f-title').value.trim();
  if (!title) { toast('Title is required.', 'error'); return; }

  const media = await window.api.saveMedia({
    id: editingMediaId || null,
    title,
    type: $('#f-type').value,
    releaseYear: parseInt($('#f-year').value, 10) || null,
    coverImage: entryCover,
    tags: entryTags,
  });

  if (!editingMediaId) {
    await window.api.saveLog({
      mediaId: media.id,
      dateConsumed: $('#f-date').value || null,
      status: $('#f-status').value,
      rating: entryRating.get(),
      review: $('#f-review').value.trim(),
      videoUrl: $('#f-video').value.trim() || null,
    });
  }

  $('#entry-dialog').close();
  await refresh();
  if ($('#detail-dialog').open) renderDetail();
}

// ---------- metadata autofill ----------

async function runAutofill() {
  const query = $('#f-title').value.trim();
  const box = $('#autofill-results');
  if (!query) return;

  box.style.display = 'block';
  box.innerHTML = '<p class="muted small">Searching…</p>';

  const resp = await window.api.metaSearch(query, $('#f-type').value);
  if (!resp.ok) {
    box.innerHTML = `<p class="muted small">${esc(resp.error)}</p>`;
    return;
  }
  if (resp.results.length === 0) {
    box.innerHTML = '<p class="muted small">No results found.</p>';
    return;
  }

  autofillResults = resp.results;
  box.innerHTML = resp.results.map((r, i) => `
    <button type="button" class="autofill-item" data-i="${i}">
      ${r.imageUrl ? `<img src="${esc(r.imageUrl)}" alt="">` : '<span class="autofill-noimg"></span>'}
      <span class="autofill-text">
        <strong>${esc(r.title)}</strong>
        <span class="muted small">${[r.year, r.subtitle, r.source].filter(Boolean).map(esc).join(' · ')}</span>
      </span>
    </button>`).join('');
}

async function applyAutofill(result) {
  $('#f-title').value = result.title;
  if (result.year) $('#f-year').value = result.year;
  (result.tags || []).forEach(addEntryTag);
  $('#autofill-results').style.display = 'none';
  if (result.imageUrl) {
    const name = await window.api.imageFromUrl(result.imageUrl);
    if (name) { entryCover = name; updateCoverPreview(); }
  }
}

// ---------- tag chips ----------

function renderEntryTags() {
  const box = $('#f-tags');
  box.querySelectorAll('.tag-chip').forEach((el) => el.remove());
  const input = $('#f-tag-input');
  entryTags.forEach((t) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.textContent = t;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'tag-x';
    x.textContent = '×';
    x.dataset.tag = t;
    chip.appendChild(x);
    box.insertBefore(chip, input);
  });
}

function addEntryTag(raw) {
  const t = (raw || '').trim();
  if (!t) return;
  if (entryTags.some((x) => x.toLowerCase() === t.toLowerCase())) return;
  entryTags.push(t);
  renderEntryTags();
}

// ---------- log dialog (add/edit one log) ----------

function openLogDialog(logId) {
  editingLogId = logId || null;
  const log = logId ? lib.logs.find((l) => l.id === logId) : null;

  $('#log-title-h').textContent = log ? 'Edit log' : 'Add log';
  $('#l-date').value = log ? (log.dateConsumed || '') : todayStr();
  $('#l-status').value = log ? log.status : 'completed';
  logRating.set(log ? log.rating : null);
  $('#l-review').value = log ? (log.review || '') : '';
  $('#l-video').value = log ? (log.videoUrl || '') : '';

  $('#log-dialog').showModal();
}

async function saveLogFromDialog() {
  const existing = editingLogId ? lib.logs.find((l) => l.id === editingLogId) : null;
  await window.api.saveLog({
    ...(existing || {}),
    id: editingLogId || null,
    mediaId: existing ? existing.mediaId : currentMediaId,
    dateConsumed: $('#l-date').value || null,
    status: $('#l-status').value,
    rating: logRating.get(),
    review: $('#l-review').value.trim(),
    videoUrl: $('#l-video').value.trim() || null,
  });

  $('#log-dialog').close();
  await refresh();
  renderDetail();
}

// ---------- statistics ----------

// Build a YYYY-MM key, and a short "Mon 'YY" label, from a date string.
function monthKey(iso) { return (iso || '').slice(0, 7); }
function monthLabel(key) {
  const [y, m] = key.split('-');
  return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1] +
    " '" + y.slice(2);
}

function computeStats() {
  const media = lib.media;
  const logs = lib.logs;
  const rated = logs.filter((l) => l.rating != null);
  const avg = rated.length ? rated.reduce((s, l) => s + l.rating, 0) / rated.length : null;

  // counts by media type and by latest-log status
  const byType = {};
  const byStatus = {};
  const ratingByType = {};   // type -> { sum, n }
  for (const m of media) {
    byType[m.type] = (byType[m.type] || 0) + 1;
    const log = latestLog(m.id);
    if (log) {
      byStatus[log.status] = (byStatus[log.status] || 0) + 1;
      if (log.rating != null) {
        const r = ratingByType[m.type] || (ratingByType[m.type] = { sum: 0, n: 0 });
        r.sum += log.rating; r.n += 1;
      }
    }
  }

  // activity: logs per month over the trailing 12 months
  const now = new Date(todayStr());
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const monthCounts = Object.fromEntries(months.map((k) => [k, 0]));
  for (const l of logs) {
    const k = monthKey(l.dateConsumed || (l.createdAt || '').slice(0, 10));
    if (k in monthCounts) monthCounts[k] += 1;
  }

  // rating histogram in half-star buckets (1..10 -> 0.5..5)
  const hist = Array(10).fill(0);
  for (const l of rated) hist[l.rating - 1] += 1;

  // top tags
  const tagCounts = {};
  for (const m of media) for (const t of (m.tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
  const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);

  const thisYear = String(now.getFullYear());
  const thisYearCount = logs.filter((l) =>
    (l.dateConsumed || l.createdAt || '').startsWith(thisYear)).length;

  return { media, logs, rated, avg, byType, byStatus, ratingByType,
    months, monthCounts, hist, topTags, thisYear, thisYearCount };
}

// horizontal bar row: label, value, proportional fill
function barRow(label, value, max, extra = '') {
  const pct = max ? Math.round((value / max) * 100) : 0;
  return `<div class="stat-bar">
    <span class="stat-bar-label">${esc(label)}</span>
    <span class="stat-bar-track"><span class="stat-bar-fill" style="width:${pct}%"></span></span>
    <span class="stat-bar-val">${esc(extra || value)}</span>
  </div>`;
}

function renderStats() {
  const s = computeStats();

  if (s.media.length === 0) {
    $('#stats-content').innerHTML = '<p class="muted">Log a few things first — your stats will appear here.</p>';
    return;
  }

  // headline cards
  const cards = [
    ['Titles', s.media.length],
    ['Logs', s.logs.length],
    ['Avg rating', s.avg == null ? '—' : (s.avg / 2).toFixed(1) + '★'],
    [`Logged in ${s.thisYear}`, s.thisYearCount],
  ].map(([k, v]) => `<div class="stat-card"><div class="stat-num">${esc(v)}</div><div class="stat-key">${esc(k)}</div></div>`).join('');

  // by type / by status
  const typeMax = Math.max(...Object.values(s.byType), 1);
  const typeRows = Object.entries(s.byType).sort((a, b) => b[1] - a[1])
    .map(([t, n]) => barRow(TYPES[t] || t, n, typeMax)).join('');

  const statusOrder = ['completed', 'in-progress', 'dropped', 'backlog', 'wishlist'];
  const statusMax = Math.max(...Object.values(s.byStatus), 1);
  const statusRows = statusOrder.filter((k) => s.byStatus[k])
    .map((k) => barRow(STATUSES[k], s.byStatus[k], statusMax)).join('');

  // activity chart (vertical bars)
  const actMax = Math.max(...Object.values(s.monthCounts), 1);
  const actBars = s.months.map((k) => {
    const n = s.monthCounts[k];
    const h = Math.round((n / actMax) * 100);
    return `<div class="act-col" title="${esc(monthLabel(k))}: ${n}">
      <span class="act-bar" style="height:${h}%"></span>
      <span class="act-x">${monthLabel(k).split(" '")[0]}</span>
    </div>`;
  }).join('');

  // average rating by type
  const ratingRows = Object.entries(s.ratingByType)
    .map(([t, r]) => [t, r.sum / r.n]).sort((a, b) => b[1] - a[1])
    .map(([t, a]) => barRow(TYPES[t] || t, a, 10, (a / 2).toFixed(1) + '★')).join('')
    || '<p class="muted small">No ratings yet.</p>';

  // rating histogram
  const histMax = Math.max(...s.hist, 1);
  const histBars = s.hist.map((n, i) => {
    const h = Math.round((n / histMax) * 100);
    const stars = (i + 1) / 2;
    return `<div class="act-col" title="${stars}★: ${n}">
      <span class="act-bar act-bar-gold" style="height:${h}%"></span>
      <span class="act-x">${stars}</span>
    </div>`;
  }).join('');

  const tagChips = s.topTags.length
    ? s.topTags.map(([t, n]) => `<span class="tag-chip">${esc(t)} <span class="muted">${n}</span></span>`).join('')
    : '<p class="muted small">No tags yet.</p>';

  $('#stats-content').innerHTML = `
    <div class="stat-cards">${cards}</div>

    <div class="stat-grid">
      <section class="stat-panel">
        <h3>By type</h3>
        ${typeRows}
      </section>
      <section class="stat-panel">
        <h3>By status</h3>
        ${statusRows}
      </section>
    </div>

    <section class="stat-panel">
      <h3>Activity — last 12 months</h3>
      <div class="act-chart">${actBars}</div>
    </section>

    <div class="stat-grid">
      <section class="stat-panel">
        <h3>Average rating by type</h3>
        ${ratingRows}
      </section>
      <section class="stat-panel">
        <h3>Rating distribution</h3>
        <div class="act-chart">${histBars}</div>
      </section>
    </div>

    <section class="stat-panel">
      <h3>Top tags</h3>
      <div class="tag-cloud">${tagChips}</div>
    </section>`;
}

function openStats() {
  renderStats();
  $('#stats-dialog').showModal();
}

// ---------- lists ----------

function openLists() {
  renderListsManager();
  $('#lists-dialog').showModal();
  $('#list-new-name').focus();
}

function renderListsManager() {
  const box = $('#lists-list');
  if (lib.lists.length === 0) {
    box.innerHTML = '<p class="muted small">No lists yet. Create one above.</p>';
    return;
  }
  box.innerHTML = lib.lists.map((l) => `
    <div class="list-row" data-list-id="${l.id}">
      <div class="list-row-main">
        <span><strong>${esc(l.name)}</strong>
          <span class="muted small">${l.items.length} item${l.items.length === 1 ? '' : 's'}</span></span>
        ${l.description ? `<span class="muted small list-row-desc">${esc(l.description)}</span>` : ''}
      </div>
      <button class="link-btn list-view-btn">view</button>
      <button class="link-btn list-edit-btn">edit</button>
      <button class="link-btn list-delete-btn">delete</button>
    </div>`).join('');
}

async function createListFromInput() {
  const name = $('#list-new-name').value.trim();
  if (!name) return;
  await window.api.saveList({ name, description: $('#list-new-desc').value.trim() });
  $('#list-new-name').value = '';
  $('#list-new-desc').value = '';
  await refresh();
  renderListsManager();
}

// Swap a manager row into an inline name + description editor.
function startListEdit(row, list) {
  row.innerHTML = `
    <div class="list-edit-form">
      <input class="le-name" type="text" value="${esc(list.name)}" placeholder="List name">
      <input class="le-desc" type="text" value="${esc(list.description || '')}" placeholder="Description (optional)">
      <div class="list-edit-actions">
        <button class="le-cancel link-btn">cancel</button>
        <button class="le-save primary">Save</button>
      </div>
    </div>`;
  const nameInput = row.querySelector('.le-name');
  nameInput.focus();
  nameInput.select();
}

async function commitListEdit(row, list) {
  const name = row.querySelector('.le-name').value.trim();
  const description = row.querySelector('.le-desc').value.trim();
  if (name) {
    await window.api.saveList({ ...list, name, description });
    await refresh();
  }
  renderListsManager();
}

// Add or remove a media item from a list (append on add, preserve order).
async function toggleListMembership(listId, mediaId) {
  const list = lib.lists.find((l) => l.id === listId);
  if (!list) return;
  const items = list.items.includes(mediaId)
    ? list.items.filter((id) => id !== mediaId)
    : [...list.items, mediaId];
  await window.api.saveList({ ...list, items });
  await refresh();
}

function enterList(listId) {
  currentListId = listId;
  $('#lists-dialog').close();
  render();
}

function exitList() {
  currentListId = null;
  render();
}

// ---------- wiring ----------

const entryRating = makeStarInput($('#f-rating'));
const logRating = makeStarInput($('#l-rating'));

['#search', '#filter-type', '#filter-status', '#filter-tag', '#sort-by']
  .forEach((sel) => $(sel).addEventListener('input', render));

$('#filter-fav').addEventListener('click', () => {
  favOnly = !favOnly;
  $('#filter-fav').classList.toggle('active', favOnly);
  $('#filter-fav').setAttribute('aria-pressed', String(favOnly));
  render();
});

$('#f-tag-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') {
    e.preventDefault();
    addEntryTag(e.target.value);
    e.target.value = '';
  } else if (e.key === 'Backspace' && !e.target.value) {
    entryTags.pop();
    renderEntryTags();
  }
});
$('#f-tags').addEventListener('click', (e) => {
  if (e.target.classList.contains('tag-x')) {
    entryTags = entryTags.filter((t) => t !== e.target.dataset.tag);
    renderEntryTags();
  } else {
    $('#f-tag-input').focus();
  }
});

$('#btn-add').addEventListener('click', () => openEntryDialog(null));
$('#btn-export').addEventListener('click', async () => {
  if (await window.api.exportData()) toast('Library exported.', 'success');
});
$('#btn-import').addEventListener('click', async () => {
  const r = await window.api.importData();
  if (r.canceled) return;
  if (r.error) { toast(r.error, 'error'); return; }
  await refresh();
  const parts = [`${r.addedMedia} title${r.addedMedia === 1 ? '' : 's'}`,
    `${r.addedLogs} log${r.addedLogs === 1 ? '' : 's'}`];
  toast(`Imported ${parts.join(' and ')}.` +
    (r.skipped ? ` ${r.skipped} already present (skipped).` : ''), 'success');
});
$('#btn-folder').addEventListener('click', () => window.api.openDataFolder());
$('#btn-stats').addEventListener('click', openStats);
$('#stats-close').addEventListener('click', () => $('#stats-dialog').close());

$('#btn-lists').addEventListener('click', openLists);
$('#lists-close').addEventListener('click', () => $('#lists-dialog').close());
// Keep an open detail view in sync with lists created/changed in the manager.
$('#lists-dialog').addEventListener('close', () => {
  if ($('#detail-dialog').open) renderDetail();
});
$('#list-new-add').addEventListener('click', createListFromInput);
['#list-new-name', '#list-new-desc'].forEach((sel) => $(sel).addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); createListFromInput(); }
}));
$('#list-exit').addEventListener('click', exitList);

$('#lists-list').addEventListener('click', async (e) => {
  const row = e.target.closest('.list-row');
  if (!row) return;
  const list = lib.lists.find((l) => l.id === row.dataset.listId);
  if (!list) return;
  if (e.target.classList.contains('list-view-btn')) enterList(list.id);
  else if (e.target.classList.contains('list-edit-btn')) startListEdit(row, list);
  else if (e.target.classList.contains('le-save')) commitListEdit(row, list);
  else if (e.target.classList.contains('le-cancel')) renderListsManager();
  else if (e.target.classList.contains('list-delete-btn')) {
    if (confirm(`Delete the list “${list.name}”? (Your entries are not deleted.)`)) {
      if (currentListId === list.id) currentListId = null;
      await window.api.deleteList(list.id);
      await refresh();
      renderListsManager();
    }
  }
});

// Enter saves / Escape cancels while editing a list row.
$('#lists-list').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('le-name') && !e.target.classList.contains('le-desc')) return;
  const row = e.target.closest('.list-row');
  const list = lib.lists.find((l) => l.id === row.dataset.listId);
  if (e.key === 'Enter') { e.preventDefault(); commitListEdit(row, list); }
  else if (e.key === 'Escape') renderListsManager();
});

$('#grid').addEventListener('click', async (e) => {
  // Remove-from-list button (list view only) — don't open the detail.
  const rm = e.target.closest('.card-remove');
  if (rm) {
    e.stopPropagation();
    await toggleListMembership(currentListId, rm.dataset.id);
    return;
  }
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id);
});

// Drag-and-drop reordering within a list.
$('#grid').addEventListener('dragstart', (e) => {
  const card = e.target.closest('.list-card');
  if (!card) return;
  dragMediaId = card.dataset.id;
  e.dataTransfer.effectAllowed = 'move';
  card.classList.add('dragging');
});
$('#grid').addEventListener('dragend', (e) => {
  const card = e.target.closest('.list-card');
  if (card) card.classList.remove('dragging');
});
$('#grid').addEventListener('dragover', (e) => {
  if (!dragMediaId) return;
  e.preventDefault();   // allow drop
});
$('#grid').addEventListener('drop', async (e) => {
  if (!dragMediaId) return;
  e.preventDefault();
  const target = e.target.closest('.list-card');
  const list = lib.lists.find((l) => l.id === currentListId);
  if (!list || !target || target.dataset.id === dragMediaId) { dragMediaId = null; return; }

  const items = list.items.filter((id) => id !== dragMediaId);
  const at = items.indexOf(target.dataset.id);
  items.splice(at, 0, dragMediaId);   // insert before the drop target
  dragMediaId = null;
  await window.api.saveList({ ...list, items });
  await refresh();
});

// One listener handles every button inside the (re-rendered) detail content.
$('#detail-content').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.classList.contains('spoiler')) { t.classList.toggle('revealed'); return; }
  if (t.id === 'detail-create-list') { openLists(); return; }
  const chip = t.closest('.list-chip');
  if (chip) {
    await toggleListMembership(chip.dataset.listId, currentMediaId);
    renderDetail();
    return;
  }
  if (t.id === 'btn-add-log') openLogDialog(null);
  if (t.closest('#btn-fav-media')) {
    const m = lib.media.find((x) => x.id === currentMediaId);
    await window.api.saveMedia({ ...m, favorite: !m.favorite });
    await refresh();
    renderDetail();
    return;
  }
  if (t.id === 'btn-edit-media') openEntryDialog(currentMediaId);
  if (t.id === 'btn-delete-media') {
    if (confirm('Delete this entry and all of its logs?')) {
      await window.api.deleteMedia(currentMediaId);
      $('#detail-dialog').close();
      await refresh();
    }
  }
  const logEl = t.closest('.log');
  if (logEl && t.classList.contains('log-edit')) openLogDialog(logEl.dataset.logId);
  if (logEl && t.classList.contains('log-delete')) {
    if (confirm('Delete this log?')) {
      await window.api.deleteLog(logEl.dataset.logId);
      await refresh();
      renderDetail();
    }
  }
});

$('#btn-detail-close').addEventListener('click', () => $('#detail-dialog').close());
$('#entry-cancel').addEventListener('click', () => $('#entry-dialog').close());
$('#entry-save').addEventListener('click', saveEntry);
$('#log-cancel').addEventListener('click', () => $('#log-dialog').close());
$('#log-save').addEventListener('click', saveLogFromDialog);

$('#f-autofill').addEventListener('click', runAutofill);
$('#f-title').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runAutofill(); }
});
$('#autofill-results').addEventListener('click', (e) => {
  const item = e.target.closest('.autofill-item');
  if (item) applyAutofill(autofillResults[Number(item.dataset.i)]);
});

$('#btn-settings').addEventListener('click', async () => {
  const s = await window.api.getSettings();
  $('#s-tmdb').value = s.tmdbKey;
  $('#s-igdb-id').value = s.igdbClientId;
  $('#s-igdb-secret').value = s.igdbClientSecret;
  const mark = (ok) => ok
    ? '<span class="key-ok">✓ saved</span>'
    : '<span class="key-no">not set</span>';
  $('#s-tmdb-status').innerHTML = mark(s.hasTmdb);
  $('#s-igdb-status').innerHTML = mark(s.hasIgdb);
  $('#settings-dialog').showModal();
});
$('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());
$('#settings-save').addEventListener('click', async () => {
  await window.api.saveSettings({
    tmdbKey: $('#s-tmdb').value.trim(),
    igdbClientId: $('#s-igdb-id').value.trim(),
    igdbClientSecret: $('#s-igdb-secret').value.trim(),
  });
  $('#settings-dialog').close();
});

$('#f-pick-image').addEventListener('click', async () => {
  const name = await window.api.pickImage();
  if (name) { entryCover = name; updateCoverPreview(); }
});
$('#f-clear-image').addEventListener('click', () => {
  entryCover = null;
  updateCoverPreview();
});

refresh();

// Startup intro: dismiss the splash (auto, or on click/key) and replay the
// card stagger as the app is revealed.
(function initSplash() {
  const splash = $('#splash');
  if (!splash) return;
  let done = false;
  function hide() {
    if (done) return;
    done = true;
    splash.classList.add('hidden');
    animateGrid = true;
    render();
  }
  splash.addEventListener('animationend', hide);
  splash.addEventListener('click', hide);
  window.addEventListener('keydown', hide, { once: true });
  setTimeout(hide, 2000);   // safety net if animationend doesn't fire
})();
