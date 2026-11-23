const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('app:info') || {};

contextBridge.exposeInMainWorld('native', {
  isElectron: true,
  os: info.platform,
  version: info.version,
  on: (cb) => ipcRenderer.on('app:event', (_e, ev) => cb(ev)),
  checkUpdate: (manual) => ipcRenderer.send('update:check', !!manual),
  installUpdate: () => ipcRenderer.send('update:install'),
  getAccount: () => ipcRenderer.invoke('account:get'),
  setAccount: (account) => ipcRenderer.invoke('account:set', account),
  listPlayers: () => ipcRenderer.invoke('players:list'),
  openInPlayer: (playerId, url) => ipcRenderer.invoke('players:open', { playerId, url }),
  copy: (text) => ipcRenderer.invoke('clipboard:write', text),
  presenceConfig: (enabled) => ipcRenderer.invoke('presence:config', enabled),
  setPresence: (activity) => ipcRenderer.invoke('presence:set', activity),
  presenceStatus: () => ipcRenderer.invoke('presence:status'),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, v) => cb(v)),
  storeAll: () => ipcRenderer.invoke('store:all'),
  storeSet: (key, json) => ipcRenderer.send('store:set', key, json),
  storeSetMany: (obj) => ipcRenderer.send('store:setMany', obj),
  mediaOpen: (url) => ipcRenderer.invoke('media:open', url),
  mediaClose: (id) => ipcRenderer.invoke('media:close', id),
  onMediaEvent: (cb) => ipcRenderer.on('media:event', (_e, ev) => cb(ev)),
});
