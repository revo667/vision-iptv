const { app, BrowserWindow, ipcMain, session, Menu, shell, safeStorage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { DiscordPresence } = require('./discord');

// Discord Rich Presence uygulama kimliği (Discord Developer Portal → Vision)
const DISCORD_CLIENT_ID = '1570166912535494829';
const presence = new DiscordPresence();

function clip(v, max = 128) {
  const s = String(v ?? '').trim();
  if (!s) return undefined;
  const out = s.length > max ? s.slice(0, max - 1) + '…' : s;
  return out.length < 2 ? out + ' ' : out;
}

// Yalnızca izlenen içeriği gösteren, güvenli bir "Watching" durumu üret
function buildActivity(a) {
  if (!a || !a.title) return null;
  const act = {
    type: 3, // İzliyor
    status_display_type: 2, // Profilde uygulama adı yerine izlenen içerik
    details: clip(a.title),
    state: clip(a.state),
    assets: {
      large_image: /^https?:\/\//.test(a.image || '') && a.image.length < 256 ? a.image : 'vision',
      large_text: clip(a.title),
    },
    instance: false,
  };
  if (a.start) {
    act.timestamps = { start: Math.round(a.start) };
    if (a.end && a.end > a.start) act.timestamps.end = Math.round(a.end);
  }
  if (!act.state) delete act.state;
  return act;
}

// IPTV sunucuları çoğunlukla tarayıcı User-Agent'larını reddeder; oynatıcı gibi görünelim.
const PLAYER_UA = 'VLC/3.0.21 LibVLC/3.0.21';

app.setName('Vision');
// Dosyalardaki (MKV/MP4) çoklu video ve ses izlerini seçilebilir yapar
app.commandLine.appendSwitch('enable-blink-features', 'AudioVideoTracks');

const configPath = () => path.join(app.getPath('userData'), 'account.json');

function readAccount() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (raw.enc && safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64')));
    }
    return raw.data ? JSON.parse(raw.data) : null;
  } catch {
    return null;
  }
}

function writeAccount(account) {
  if (!account) {
    try { fs.unlinkSync(configPath()); } catch {}
    return true;
  }
  const json = JSON.stringify(account);
  const payload = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(json).toString('base64') }
    : { enc: false, data: json };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(payload), { mode: 0o600 });
  return true;
}

const EXTERNAL_PLAYERS = [
  { id: 'iina', name: 'IINA', app: 'IINA' },
  { id: 'vlc', name: 'VLC', app: 'VLC' },
];

function installedPlayers() {
  const dirs = ['/Applications', path.join(app.getPath('home'), 'Applications')];
  return EXTERNAL_PLAYERS.filter((p) => dirs.some((d) => fs.existsSync(path.join(d, `${p.app}.app`))));
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#08080a',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Dış bağlantılar sistem tarayıcısında açılsın
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false));
}

function setupNetwork() {
  const ses = session.defaultSession;
  ses.setUserAgent(PLAYER_UA);

  // IPTV sunucuları CORS başlığı göndermez; hls.js / mpegts.js çalışabilsin diye ekliyoruz.
  ses.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith('file:') || details.url.startsWith('devtools:')) {
      return callback({});
    }
    const headers = details.responseHeaders || {};
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase().startsWith('access-control-')) delete headers[key];
    }
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET, HEAD, OPTIONS'];
    headers['Access-Control-Expose-Headers'] = ['*'];
    callback({ responseHeaders: headers });
  });
}

function setupMenu() {
  const template = [
    { role: 'appMenu' },
    { role: 'editMenu' },
    {
      label: 'Görünüm',
      submenu: [
        { role: 'reload', label: 'Yenile' },
        { role: 'toggleDevTools', label: 'Geliştirici Araçları' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Gerçek Boyut' },
        { role: 'zoomIn', label: 'Yakınlaştır' },
        { role: 'zoomOut', label: 'Uzaklaştır' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Tam Ekran' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('account:get', () => readAccount());
ipcMain.handle('account:set', (_e, account) => writeAccount(account));
ipcMain.handle('players:list', () => installedPlayers());
ipcMain.handle('players:open', (_e, { playerId, url }) => {
  const p = EXTERNAL_PLAYERS.find((x) => x.id === playerId);
  if (!p || !/^https?:\/\//.test(url)) return false;
  return new Promise((resolve) => {
    execFile('open', ['-a', p.app, url], (err) => resolve(!err));
  });
});
ipcMain.handle('presence:config', (_e, enabled) => {
  presence.configure({ enabled: !!enabled, clientId: DISCORD_CLIENT_ID });
  return presence.status;
});
ipcMain.handle('presence:set', (_e, a) => {
  presence.setActivity(buildActivity(a));
  return true;
});
ipcMain.handle('presence:status', () => presence.status);
ipcMain.handle('clipboard:write', (_e, text) => {
  clipboard.writeText(String(text));
  return true;
});

app.whenReady().then(() => {
  setupNetwork();
  setupMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => presence.shutdown());
app.on('window-all-closed', () => app.quit());
