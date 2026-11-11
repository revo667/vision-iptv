const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  getAccount: () => ipcRenderer.invoke('account:get'),
  setAccount: (account) => ipcRenderer.invoke('account:set', account),
  listPlayers: () => ipcRenderer.invoke('players:list'),
  openInPlayer: (playerId, url) => ipcRenderer.invoke('players:open', { playerId, url }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  presenceConfig: (enabled) => ipcRenderer.invoke('presence:config', enabled),
  setPresence: (activity) => ipcRenderer.invoke('presence:set', activity),
  presenceStatus: () => ipcRenderer.invoke('presence:status'),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, v) => cb(v)),
});
