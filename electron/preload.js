// Bridge between the desktop shell and the web app (runs in the sandboxed preload).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('strandDesktop', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openUpdateLog: () => ipcRenderer.invoke('update:log'),
  itunes: {
    findLibrary: () => ipcRenderer.invoke('itunes:find'),
    pickLibrary: () => ipcRenderer.invoke('itunes:pick'),
    allow: files => ipcRenderer.invoke('itunes:allow', files),
  },
  onUpdateStatus: cb => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('update-status', h);
    return () => ipcRenderer.removeListener('update-status', h);
  },
});
