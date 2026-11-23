const { app, BrowserWindow, ipcMain, session, Menu, shell, safeStorage, clipboard, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const { DiscordPresence } = require('./discord');
const { MediaSession } = require('./media-probe');
const { Updater } = require('./updater');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

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
// Film/dizi akışları bu şema üzerinden ana süreçten geçer: iz listesi ve gömülü altyazılar okunur
protocol.registerSchemesAsPrivileged([
  { scheme: 'vzmedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, bypassCSP: true, corsEnabled: true } },
]);
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

/* ---------- Kalıcı kayıt (favori listeleri, izleme geçmişi, ayarlar) ----------
   Her değişiklik hemen ve atomik olarak diske yazılır. */
const storePath = () => path.join(app.getPath('userData'), 'library.json');
let storeData = null;
let storeWriteQueued = false;

function loadStore() {
  if (storeData) return storeData;
  try { storeData = JSON.parse(fs.readFileSync(storePath(), 'utf8')) || {}; } catch { storeData = {}; }
  return storeData;
}

function writeStore() {
  storeWriteQueued = false;
  try {
    const file = storePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(storeData));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    console.error('Kayıt dosyası yazılamadı', e);
  }
}

function queueStoreWrite() {
  if (storeWriteQueued) return;
  storeWriteQueued = true;
  setImmediate(writeStore);
}

ipcMain.handle('store:all', () => loadStore());
ipcMain.on('store:set', (_e, key, json) => {
  if (typeof key !== 'string' || key.length > 200) return;
  const d = loadStore();
  if (json == null) delete d[key]; else d[key] = String(json);
  queueStoreWrite();
});
ipcMain.on('store:setMany', (_e, obj) => {
  if (!obj || typeof obj !== 'object') return;
  const d = loadStore();
  for (const [k, v] of Object.entries(obj)) if (typeof k === 'string' && v != null) d[k] = String(v);
  queueStoreWrite();
});

/* ---------- Harici oynatıcılar ---------- */
const MAC_PLAYERS = [
  { id: 'iina', name: 'IINA', app: 'IINA' },
  { id: 'vlc', name: 'VLC', app: 'VLC' },
];
const PF = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
const WIN_PLAYERS = [
  { id: 'vlc', name: 'VLC', exe: ['VideoLAN\\VLC\\vlc.exe'] },
  { id: 'potplayer', name: 'PotPlayer', exe: ['DAUM\\PotPlayer\\PotPlayerMini64.exe', 'DAUM\\PotPlayer\\PotPlayerMini.exe'] },
  { id: 'mpc', name: 'MPC-HC', exe: ['MPC-HC\\mpc-hc64.exe', 'MPC-HC\\mpc-hc.exe', 'K-Lite Codec Pack\\MPC-HC64\\mpc-hc64.exe'] },
  { id: 'mpv', name: 'mpv', exe: ['mpv\\mpv.exe'] },
];

function winPlayerPath(p) {
  for (const base of PF) for (const rel of p.exe) {
    const full = path.join(base, rel);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function installedPlayers() {
  if (IS_WIN) return WIN_PLAYERS.filter((p) => winPlayerPath(p)).map(({ id, name }) => ({ id, name }));
  if (IS_MAC) {
    const dirs = ['/Applications', path.join(app.getPath('home'), 'Applications')];
    return MAC_PLAYERS.filter((p) => dirs.some((d) => fs.existsSync(path.join(d, `${p.app}.app`)))).map(({ id, name }) => ({ id, name }));
  }
  return [];
}

function openInPlayer(playerId, url) {
  if (IS_WIN) {
    const p = WIN_PLAYERS.find((x) => x.id === playerId);
    const exe = p && winPlayerPath(p);
    if (!exe) return Promise.resolve(false);
    try {
      spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
      return Promise.resolve(true);
    } catch {
      return Promise.resolve(false);
    }
  }
  const p = MAC_PLAYERS.find((x) => x.id === playerId);
  if (!p) return Promise.resolve(false);
  return new Promise((resolve) => execFile('open', ['-a', p.app, url], (err) => resolve(!err)));
}

/* ---------- Güncellemeler ---------- */
function sendAll(ev) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('app:event', ev);
}
const updater = new Updater(sendAll);
ipcMain.on('update:check', (_e, manual) => updater.check(!!manual));
ipcMain.on('update:install', () => updater.install());
ipcMain.on('app:info', (e) => { e.returnValue = { version: app.getVersion(), platform: process.platform }; });

/* ---------- Medya vekili (vzmedia://media/<id>) ---------- */
const mediaSessions = new Map(); // id → { url, session, wc, ctrls:Set }
let mediaSeq = 0;

function closeMedia(id) {
  const m = mediaSessions.get(id);
  if (!m) return;
  mediaSessions.delete(id);
  for (const c of m.ctrls) c.abort();
  clearTimeout(m.session.flushTimer);
}

function setupMediaProtocol() {
  protocol.handle('vzmedia', async (req) => {
    const id = new URL(req.url).pathname.slice(1);
    const m = mediaSessions.get(id);
    if (!m) return new Response(null, { status: 404 });
    const headers = { 'User-Agent': PLAYER_UA };
    const range = req.headers.get('range');
    if (range) headers.Range = range;
    const ctrl = new AbortController();
    m.ctrls.add(ctrl);
    let up;
    try {
      up = await net.fetch(m.url, { headers, signal: ctrl.signal, redirect: 'follow', bypassCustomProtocolHandlers: true });
    } catch {
      m.ctrls.delete(ctrl);
      return new Response(null, { status: 502 });
    }
    const out = new Headers({ 'access-control-allow-origin': '*' });
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }
    if (!up.ok || !up.body) {
      m.ctrls.delete(ctrl);
      return new Response(up.body, { status: up.status, headers: out });
    }
    const cr = /bytes\s+(\d+)-/i.exec(up.headers.get('content-range') || '');
    const start = up.status === 206 && cr ? Number(cr[1]) : 0;
    const reader = m.session.reader(start);
    const src = up.body.getReader();
    const body = new ReadableStream({
      async pull(c) {
        try {
          const { done, value } = await src.read();
          if (done) { m.ctrls.delete(ctrl); c.close(); return; }
          reader.push(value);
          c.enqueue(value);
        } catch (e) {
          m.ctrls.delete(ctrl);
          c.error(e);
        }
      },
      cancel(reason) {
        m.ctrls.delete(ctrl);
        ctrl.abort();
        src.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, { status: up.status, headers: out });
  });
}

ipcMain.handle('media:open', (e, url) => {
  if (!/^https?:\/\//.test(String(url))) return null;
  const id = `m${++mediaSeq}`;
  const wc = e.sender;
  const send = (ev) => { if (!wc.isDestroyed()) wc.send('media:event', { id, ...ev }); };
  mediaSessions.set(id, { url: String(url), session: new MediaSession(send), ctrls: new Set() });
  wc.once('destroyed', () => closeMedia(id));
  return { id, src: `vzmedia://media/${id}` };
});
ipcMain.handle('media:close', (_e, id) => { closeMedia(id); return true; });

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#08080a',
    ...(IS_MAC
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 22 } }
      // Windows/Linux: çerçevesiz pencere, sağ üstte sistem düğmeleri
      : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#09080e', symbolColor: '#c4b5fd', height: 40 }, icon: path.join(__dirname, 'build', 'icon.png') }),
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
    ...(IS_MAC ? [{ role: 'appMenu' }] : []),
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
    ...(IS_MAC ? [{ role: 'windowMenu' }] : []),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('account:get', () => readAccount());
ipcMain.handle('account:set', (_e, account) => writeAccount(account));
ipcMain.handle('players:list', () => installedPlayers());
ipcMain.handle('players:open', (_e, { playerId, url }) => {
  if (!/^https?:\/\//.test(url)) return false;
  return openInPlayer(playerId, url);
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

if (IS_WIN) app.setAppUserModelId('com.revo667.vision');

app.whenReady().then(() => {
  setupNetwork();
  setupMediaProtocol();
  setupMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => presence.shutdown());
app.on('window-all-closed', () => app.quit());
