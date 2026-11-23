/* Masaüstü güncellemeleri (GitHub Releases)
   Windows: electron-updater (NSIS) — arka planda indirir, yeniden başlatınca kurar.
   macOS:  uygulama ad-hoc imzalı olduğu için Squirrel.Mac kullanılamaz; yeni sürümün zip'i
           indirilir, uygulama paketi kapanıştan sonra yerinde değiştirilir ve yeniden açılır. */
const { app, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

const REPO = 'revo667/vision-iptv';

function compare(a, b) {
  const x = String(a).replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  const y = String(b).replace(/^v/, '').split(/[.+-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

class Updater {
  constructor(send) {
    this.send = send;
    this.latest = null;
    this.ready = false;
    this.busy = false;
    this.au = null;
  }

  get current() { return app.getVersion(); }

  async check(manual) {
    if (!app.isPackaged) {
      if (manual) this.send({ type: 'update', manual, available: false, current: this.current, error: 'geliştirme sürümünde güncelleme kapalı' });
      return;
    }
    if (process.platform === 'win32') return this.checkWindows(manual);
    return this.checkGithub(manual);
  }

  /* ---------- Windows ---------- */
  winUpdater() {
    if (this.au) return this.au;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('download-progress', (p) => this.send({ type: 'update-progress', pct: Math.round(p.percent || 0) }));
    autoUpdater.on('update-downloaded', () => {
      this.ready = true;
      this.busy = false;
      this.send({ type: 'update-ready' });
    });
    autoUpdater.on('error', (e) => {
      if (!this.busy) return;
      this.busy = false;
      this.send({ type: 'update-error', message: `Güncelleme indirilemedi: ${e?.message || e}` });
    });
    this.au = autoUpdater;
    return autoUpdater;
  }

  async checkWindows(manual) {
    try {
      const r = await this.winUpdater().checkForUpdates();
      const v = r?.updateInfo?.version;
      const available = !!v && compare(v, this.current) > 0;
      if (available) this.latest = { version: v };
      const notes = typeof r?.updateInfo?.releaseNotes === 'string' ? r.updateInfo.releaseNotes : '';
      this.send({ type: 'update', manual, available, version: v, current: this.current, notes });
    } catch (e) {
      this.send({ type: 'update', manual, available: false, current: this.current, error: e?.message || 'bağlantı hatası' });
    }
  }

  /* ---------- macOS (ve diğerleri): GitHub API ---------- */
  async checkGithub(manual) {
    try {
      const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { 'User-Agent': `Vision-Desktop/${this.current}`, Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name || '').replace(/^v/, '');
      const assets = rel.assets || [];
      const zip = assets.find((a) => a.name.endsWith(`-mac-${process.arch}.zip`));
      const available = !!version && compare(version, this.current) > 0 && !!zip;
      if (available) this.latest = { version, url: zip.browser_download_url, size: zip.size, page: rel.html_url };
      this.send({ type: 'update', manual, available, version, current: this.current, notes: rel.body || '' });
    } catch (e) {
      this.send({ type: 'update', manual, available: false, current: this.current, error: e?.message || 'bağlantı hatası' });
    }
  }

  async install() {
    if (process.platform === 'win32') {
      const au = this.winUpdater();
      if (this.ready) {
        setImmediate(() => au.quitAndInstall(true, true));
        return;
      }
      if (this.busy) return;
      this.busy = true;
      try {
        await au.downloadUpdate();
      } catch (e) {
        this.busy = false;
        this.send({ type: 'update-error', message: `Güncelleme indirilemedi: ${e?.message || e}` });
      }
      return;
    }
    if (process.platform === 'darwin') return this.installMac();
  }

  async installMac() {
    const l = this.latest;
    if (!l || this.busy) return;
    const bundle = path.resolve(app.getPath('exe'), '../../..');
    const fail = (message) => {
      this.busy = false;
      this.send({ type: 'update-error', message });
    };
    if (!bundle.endsWith('.app')) return fail('Uygulama paketi bulunamadı.');
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    } catch {
      shell.openExternal(l.page);
      return fail('Uygulama klasörüne yazılamıyor; yeni sürüm tarayıcıda açıldı.');
    }
    this.busy = true;
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-update-'));
      const zip = path.join(dir, 'update.zip');
      const res = await net.fetch(l.url, { headers: { 'User-Agent': `Vision-Desktop/${this.current}` } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || l.size || 0;
      const out = fs.createWriteStream(zip);
      const reader = res.body.getReader();
      let done = 0;
      let last = -1;
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        out.write(Buffer.from(value));
        done += value.length;
        const pct = total ? Math.floor((done / total) * 100) : -1;
        if (pct !== last && pct % 5 === 0) { last = pct; this.send({ type: 'update-progress', pct }); }
      }
      await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      const ext = path.join(dir, 'app');
      await new Promise((r, j) => execFile('ditto', ['-x', '-k', zip, ext], (e) => (e ? j(e) : r())));
      const name = fs.readdirSync(ext).find((n) => n.endsWith('.app'));
      if (!name) throw new Error('Arşivde uygulama yok');
      const fresh = path.join(ext, name);

      // Uygulama kapandıktan sonra paketi değiştir, sorun olursa eskisini geri koy, yeniden aç
      const script = path.join(dir, 'swap.sh');
      fs.writeFileSync(script, `#!/bin/bash
while kill -0 ${process.pid} 2>/dev/null; do sleep 0.3; done
OLD="${bundle}.old-$$"
if mv "${bundle}" "$OLD" && ditto "${fresh}" "${bundle}"; then
  rm -rf "$OLD"
else
  rm -rf "${bundle}"; mv "$OLD" "${bundle}"
fi
xattr -dr com.apple.quarantine "${bundle}" 2>/dev/null
open "${bundle}"
rm -rf "${dir}"
`);
      this.send({ type: 'update-installing', message: 'Yeniden başlatılıyor…' });
      spawn('/bin/bash', [script], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.quit(), 400);
    } catch (e) {
      fail(`Güncelleme kurulamadı: ${e?.message || e}`);
    }
  }
}

module.exports = { Updater, compare };
