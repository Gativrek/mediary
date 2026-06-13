// Mediary — main process.
// This file owns ALL data access (the "storage layer"). The UI never touches
// the disk directly; it asks for things over IPC (see preload.js). When we
// later migrate JSON -> SQLite -> a real server, only this file changes.

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// Custom scheme so the UI can show stored images without file:// access.
protocol.registerSchemesAsPrivileged([
  { scheme: 'media-img', privileges: { standard: true, secure: true } },
]);

// By default the data folder is derived from the app name, so renaming the
// app would orphan the library. Pin it to a fixed location instead.
app.setPath('userData', path.join(app.getPath('appData'), 'Mediary'));

let dataDir;   // %APPDATA%/medialog/library
let imagesDir; // %APPDATA%/medialog/library/images
let dbFile;    // %APPDATA%/medialog/library/library.json
let library;   // in-memory copy of the database
let settingsFile;
let settings;  // { tmdbKey, igdbClientId, igdbClientSecret, igdbToken }

// ---------- storage ----------

function loadLibrary() {
  try {
    return JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  } catch {
    // First run (or unreadable file): start with an empty library.
    return { version: 1, media: [], logs: [] };
  }
}

function saveLibrary() {
  // Write to a temp file first, then rename. A crash mid-write can't
  // destroy the existing library this way.
  const tmp = dbFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(library, null, 2));
  fs.renameSync(tmp, dbFile);
}

// ---------- window ----------

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    autoHideMenuBar: true,
    backgroundColor: '#14151a',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Links with target="_blank" open in the system browser, not a new app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  dataDir = path.join(app.getPath('userData'), 'library');
  imagesDir = path.join(dataDir, 'images');

  // One-time migration from the old app name. The old folder is left in
  // place as a backup.
  const oldDataDir = path.join(app.getPath('appData'), 'medialog', 'library');
  if (!fs.existsSync(dataDir) && fs.existsSync(oldDataDir)) {
    fs.cpSync(oldDataDir, dataDir, { recursive: true });
  }

  fs.mkdirSync(imagesDir, { recursive: true });
  dbFile = path.join(dataDir, 'library.json');
  library = loadLibrary();

  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    settings = {};
  }

  // Serve stored cover images at media-img://img/<filename>
  protocol.handle('media-img', (request) => {
    const name = path.basename(decodeURIComponent(new URL(request.url).pathname));
    return net.fetch(pathToFileURL(path.join(imagesDir, name)).toString());
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC API (what the UI is allowed to do) ----------

ipcMain.handle('library:get', () => library);

// Insert or update a media item. New items get a UUID here.
ipcMain.handle('media:save', (event, media) => {
  if (media.id) {
    const i = library.media.findIndex((m) => m.id === media.id);
    if (i === -1) throw new Error('media not found: ' + media.id);
    library.media[i] = media;
  } else {
    media.id = crypto.randomUUID();
    library.media.push(media);
  }
  saveLibrary();
  return media;
});

// Insert or update a log (one play/watch/read of a media item).
ipcMain.handle('log:save', (event, log) => {
  const now = new Date().toISOString();
  log.updatedAt = now;
  if (log.id) {
    const i = library.logs.findIndex((l) => l.id === log.id);
    if (i === -1) throw new Error('log not found: ' + log.id);
    log.createdAt = library.logs[i].createdAt;
    library.logs[i] = log;
  } else {
    log.id = crypto.randomUUID();
    log.createdAt = now;
    library.logs.push(log);
  }
  saveLibrary();
  return log;
});

// Deleting a media item also deletes its logs and its cover image file.
ipcMain.handle('media:delete', (event, id) => {
  const media = library.media.find((m) => m.id === id);
  if (media && media.coverImage) {
    fs.rm(path.join(imagesDir, path.basename(media.coverImage)), { force: true }, () => {});
  }
  library.media = library.media.filter((m) => m.id !== id);
  library.logs = library.logs.filter((l) => l.mediaId !== id);
  saveLibrary();
});

ipcMain.handle('log:delete', (event, id) => {
  library.logs = library.logs.filter((l) => l.id !== id);
  saveLibrary();
});

// Open a file picker, copy the chosen image into our images folder under a
// UUID name, and return that name for storing on the media item.
ipcMain.handle('image:pick', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Choose a cover image',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const src = result.filePaths[0];
  const name = crypto.randomUUID() + path.extname(src).toLowerCase();
  fs.copyFileSync(src, path.join(imagesDir, name));
  return name;
});

ipcMain.handle('data:export', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Export library',
    defaultPath: 'medialog-export.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return false;
  fs.writeFileSync(result.filePath, JSON.stringify(library, null, 2));
  return true;
});

ipcMain.handle('data:openFolder', () => shell.openPath(dataDir));

// ---------- settings (API keys for autofill) ----------

function saveSettings() {
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

ipcMain.handle('settings:get', () => ({
  tmdbKey: settings.tmdbKey || '',
  igdbClientId: settings.igdbClientId || '',
  igdbClientSecret: settings.igdbClientSecret || '',
}));

ipcMain.handle('settings:save', (event, s) => {
  // New Twitch credentials invalidate any cached IGDB token.
  if (s.igdbClientId !== settings.igdbClientId || s.igdbClientSecret !== settings.igdbClientSecret) {
    delete settings.igdbToken;
  }
  settings.tmdbKey = s.tmdbKey;
  settings.igdbClientId = s.igdbClientId;
  settings.igdbClientSecret = s.igdbClientSecret;
  saveSettings();
});

// ---------- metadata autofill ----------
// Each provider returns [{ title, year, imageUrl, subtitle, source }].
// Books (Open Library) and music (iTunes) need no key; movies/TV/anime need a
// TMDB key and games need Twitch (IGDB) credentials — both free.

// TMDB accepts either a v3 api key (query param) or a v4 read token (Bearer).
async function tmdbFetch(pathAndQuery) {
  const key = (settings.tmdbKey || '').trim();
  if (!key) throw new Error('Movies/TV need a free TMDB API key — add it in Settings (gear icon).');
  const isV4 = key.startsWith('eyJ');
  const url = 'https://api.themoviedb.org/3' + pathAndQuery +
    (isV4 ? '' : '&api_key=' + encodeURIComponent(key));
  const res = await net.fetch(url, isV4 ? { headers: { Authorization: 'Bearer ' + key } } : undefined);
  if (!res.ok) throw new Error('TMDB error ' + res.status + ' — check your API key in Settings.');
  return res.json();
}

// TMDB returns genres as numeric ids; resolve them via the genre list
// endpoints, fetched once per session.
let tmdbGenreMap = null;
async function tmdbGenres() {
  if (tmdbGenreMap) return tmdbGenreMap;
  const [movies, tv] = await Promise.all([
    tmdbFetch('/genre/movie/list?language=en'),
    tmdbFetch('/genre/tv/list?language=en'),
  ]);
  tmdbGenreMap = {};
  [...movies.genres, ...tv.genres].forEach((g) => { tmdbGenreMap[g.id] = g.name; });
  return tmdbGenreMap;
}

async function searchTMDB(query) {
  const data = await tmdbFetch(`/search/multi?include_adult=false&query=${encodeURIComponent(query)}`);
  let genres = {};
  try { genres = await tmdbGenres(); } catch { /* search still works without genre names */ }
  return data.results
    .filter((r) => r.media_type === 'movie' || r.media_type === 'tv')
    .slice(0, 8)
    .map((r) => ({
      title: r.title || r.name,
      year: parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10) || null,
      imageUrl: r.poster_path ? 'https://image.tmdb.org/t/p/w342' + r.poster_path : null,
      subtitle: r.media_type === 'tv' ? 'TV' : 'Movie',
      tags: (r.genre_ids || []).map((id) => genres[id]).filter(Boolean).slice(0, 4),
      source: 'TMDB',
    }));
}

async function igdbToken() {
  if (!settings.igdbClientId || !settings.igdbClientSecret) {
    throw new Error('Games need free Twitch/IGDB credentials — add them in Settings (gear icon).');
  }
  const cached = settings.igdbToken;
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const res = await net.fetch(
    'https://id.twitch.tv/oauth2/token' +
    `?client_id=${encodeURIComponent(settings.igdbClientId)}` +
    `&client_secret=${encodeURIComponent(settings.igdbClientSecret)}` +
    '&grant_type=client_credentials',
    { method: 'POST' });
  if (!res.ok) throw new Error('Twitch auth failed (' + res.status + ') — check your IGDB credentials in Settings.');
  const data = await res.json();
  settings.igdbToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  saveSettings();
  return settings.igdbToken.token;
}

async function searchIGDB(query) {
  const token = await igdbToken();
  const res = await net.fetch('https://api.igdb.com/v4/games', {
    method: 'POST',
    headers: {
      'Client-ID': settings.igdbClientId,
      Authorization: 'Bearer ' + token,
      'Content-Type': 'text/plain',
    },
    body: `search "${query.replace(/["\\]/g, '')}"; fields name, first_release_date, cover.image_id, genres.name; limit 8;`,
  });
  if (!res.ok) throw new Error('IGDB error ' + res.status);
  const data = await res.json();
  return data.map((g) => ({
    title: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    imageUrl: g.cover ? `https://images.igdb.com/igdb/image/upload/t_cover_big/${g.cover.image_id}.jpg` : null,
    subtitle: null,
    tags: (g.genres || []).map((x) => x.name).slice(0, 4),
    source: 'IGDB',
  }));
}

async function searchOpenLibrary(query) {
  const res = await net.fetch(
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8&fields=title,author_name,first_publish_year,cover_i`);
  if (!res.ok) throw new Error('Open Library error ' + res.status);
  const data = await res.json();
  return data.docs.map((d) => ({
    title: d.title,
    year: d.first_publish_year || null,
    imageUrl: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : null,
    subtitle: d.author_name ? d.author_name[0] : null,
    tags: [],
    source: 'Open Library',
  }));
}

async function searchITunes(query) {
  const res = await net.fetch(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=album&limit=8`);
  if (!res.ok) throw new Error('iTunes error ' + res.status);
  const data = await res.json();
  return data.results.map((r) => ({
    title: r.collectionName,
    year: r.releaseDate ? new Date(r.releaseDate).getUTCFullYear() : null,
    imageUrl: r.artworkUrl100 ? r.artworkUrl100.replace('100x100', '600x600') : null,
    subtitle: r.artistName || null,
    tags: r.primaryGenreName ? [r.primaryGenreName] : [],
    source: 'iTunes',
  }));
}

ipcMain.handle('meta:search', async (event, { query, type }) => {
  try {
    let results = [];
    if (type === 'game') results = await searchIGDB(query);
    else if (type === 'movie' || type === 'tv' || type === 'anime') results = await searchTMDB(query);
    else if (type === 'book') results = await searchOpenLibrary(query);
    else if (type === 'music') results = await searchITunes(query);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Download a cover from a search result into the images folder, same as a
// manually picked file.
ipcMain.handle('image:fromUrl', async (event, url) => {
  if (!/^https:\/\//.test(url)) return null;
  const res = await net.fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  const ext = (res.headers.get('content-type') || '').includes('png') ? '.png' : '.jpg';
  const name = crypto.randomUUID() + ext;
  fs.writeFileSync(path.join(imagesDir, name), buf);
  return name;
});
