// Bridge between the UI and the main process. The UI can only call what is
// listed here — it has no direct access to the filesystem or Node APIs.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getLibrary: () => ipcRenderer.invoke('library:get'),
  saveMedia: (media) => ipcRenderer.invoke('media:save', media),
  saveLog: (log) => ipcRenderer.invoke('log:save', log),
  deleteMedia: (id) => ipcRenderer.invoke('media:delete', id),
  deleteLog: (id) => ipcRenderer.invoke('log:delete', id),
  pickImage: () => ipcRenderer.invoke('image:pick'),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  metaSearch: (query, type) => ipcRenderer.invoke('meta:search', { query, type }),
  imageFromUrl: (url) => ipcRenderer.invoke('image:fromUrl', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
});
