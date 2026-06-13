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
