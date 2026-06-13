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

const $ = (sel) => document.querySelector(sel);

// Escape user text before putting it into innerHTML.
const esc = (s) => (s ?? '').toString().replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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

function youtubeEmbed(url) {
  const m = (url || '').match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : null;
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
  sel.innerHTML = '<option value="">All tags</option>' +
    tags.map((t) => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
  sel.value = tags.includes(current) ? current : '';
}

// ---------- main grid ----------

function render() {
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

  $('#empty').style.display = items.length ? 'none' : 'block';
}

// Pure-art card; the details live in an overlay revealed on hover.
function cardHTML(m, log) {
  return `
    <article class="card" data-id="${m.id}">
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
          <button id="btn-edit-media" class="ghost">Edit</button>
          <button id="btn-delete-media" class="danger">Delete</button>
        </div>
      </div>
    </div>
    <div class="log-list">
      ${logs.map(logHTML).join('') || '<p class="muted">No logs yet.</p>'}
    </div>`;
}

function logHTML(log) {
  const embed = log.videoUrl ? youtubeEmbed(log.videoUrl) : null;
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
      ${log.review ? `<p class="review">${esc(log.review)}</p>` : ''}
      ${embed
        ? `<iframe class="video" src="${embed}" allow="encrypted-media; picture-in-picture" allowfullscreen></iframe>`
        : log.videoUrl
          ? `<p><a href="${esc(log.videoUrl)}" target="_blank">${esc(log.videoUrl)}</a></p>`
          : ''}
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
  if (!title) { alert('Title is required.'); return; }

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

// ---------- wiring ----------

const entryRating = makeStarInput($('#f-rating'));
const logRating = makeStarInput($('#l-rating'));

['#search', '#filter-type', '#filter-status', '#filter-tag', '#sort-by']
  .forEach((sel) => $(sel).addEventListener('input', render));

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
$('#btn-export').addEventListener('click', () => window.api.exportData());
$('#btn-folder').addEventListener('click', () => window.api.openDataFolder());

$('#grid').addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) openDetail(card.dataset.id);
});

// One listener handles every button inside the (re-rendered) detail content.
$('#detail-content').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.id === 'btn-add-log') openLogDialog(null);
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
