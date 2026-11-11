/* Discord Rich Presence — bağımlılıksız, Discord'un yerel IPC soketi üzerinden.
   Yalnızca o an izlenen içerik gösterilir; gezinirken durum temizlenir. */
const net = require('net');
const path = require('path');
const os = require('os');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function socketPaths() {
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp', os.tmpdir()].filter(Boolean);
  const out = [];
  for (const d of [...new Set(dirs)]) for (let i = 0; i < 10; i++) out.push(path.join(d, `discord-ipc-${i}`));
  return out;
}

function encode(op, data) {
  const json = Buffer.from(JSON.stringify(data), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(json.length, 4);
  return Buffer.concat([head, json]);
}

class DiscordPresence {
  constructor() {
    this.clientId = '';
    this.enabled = false;
    this.sock = null;
    this.ready = false;
    this.connecting = false;
    this.activity = null; // istenen durum
    this.sent = undefined; // en son gönderilen
    this.lastSend = 0;
    this.timer = null;
    this.retryTimer = null;
    this.buf = Buffer.alloc(0);
    this.status = 'kapalı';
  }

  configure({ enabled, clientId }) {
    const id = String(clientId || '').trim();
    const changed = id !== this.clientId;
    this.enabled = !!enabled && /^\d{15,25}$/.test(id);
    this.clientId = id;
    if (!this.enabled || changed) this.disconnect();
    if (this.enabled) this.schedule();
    else this.status = enabled ? 'geçersiz uygulama kimliği' : 'kapalı';
  }

  setActivity(activity) {
    this.activity = activity || null;
    this.schedule();
  }

  // Discord sınırı: ~5 güncelleme / 20 sn. Son durumu en geç 4 sn'de bir gönder.
  schedule() {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    const wait = Math.max(0, 4000 - (Date.now() - this.lastSend));
    this.timer = setTimeout(() => this.flush(), wait);
  }

  async flush() {
    if (!this.enabled) return;
    if (!this.ready) {
      if (this.activity) this.connect();
      return; // bağlanınca tekrar flush edilir
    }
    const key = JSON.stringify(this.activity);
    if (key === JSON.stringify(this.sent)) return;
    this.lastSend = Date.now();
    this.sent = this.activity;
    let act = this.activity || null;
    if (act && this.compat) {
      // Eski Discord sürümleri bu alanları tanımayabilir
      act = { ...act };
      delete act.status_display_type;
      if (this.compat > 1) delete act.type;
    }
    this.send(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: act },
      nonce: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    });
  }

  connect() {
    if (this.connecting || this.ready || !this.enabled) return;
    this.connecting = true;
    const paths = socketPaths();
    const tryNext = (i) => {
      if (i >= paths.length) {
        this.connecting = false;
        this.status = 'Discord açık değil';
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.activity && this.connect(), 15000);
        return;
      }
      const s = net.createConnection(paths[i]);
      const onErr = () => { s.destroy(); tryNext(i + 1); };
      s.once('error', onErr);
      s.once('connect', () => {
        s.removeListener('error', onErr);
        this.attach(s);
      });
    };
    tryNext(0);
  }

  attach(s) {
    this.sock = s;
    this.buf = Buffer.alloc(0);
    s.on('data', (d) => this.onData(d));
    s.on('error', () => this.disconnect(true));
    s.on('close', () => this.disconnect(true));
    this.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
  }

  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) return;
      let msg = {};
      try { msg = JSON.parse(this.buf.subarray(8, 8 + len).toString('utf8')); } catch {}
      this.buf = this.buf.subarray(8 + len);
      if (op === OP.PING) this.send(OP.PONG, msg);
      else if (op === OP.CLOSE) { this.status = msg.message || 'Discord bağlantıyı kapattı'; this.disconnect(true); }
      else if (op === OP.FRAME) {
        if (msg.evt === 'READY') {
          this.ready = true;
          this.connecting = false;
          this.status = 'bağlı';
          this.sent = undefined;
          this.flush();
        } else if (msg.evt === 'ERROR') {
          this.status = msg.data?.message || 'hata';
          if (msg.cmd === 'SET_ACTIVITY' && (this.compat || 0) < 2 && this.activity) {
            this.compat = (this.compat || 0) + 1;
            this.sent = undefined;
            this.schedule();
          }
        }
      }
    }
  }

  send(op, data) {
    try { this.sock?.write(encode(op, data)); } catch {}
  }

  disconnect(retry = false) {
    const wasReady = this.ready;
    this.ready = false;
    this.connecting = false;
    this.sent = undefined;
    if (this.sock) {
      try { this.sock.removeAllListeners(); this.sock.destroy(); } catch {}
      this.sock = null;
    }
    if (retry && this.enabled && this.activity) {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this.connect(), wasReady ? 3000 : 15000);
    }
  }

  async shutdown() {
    if (this.ready) {
      this.send(OP.FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: 'bye' });
    }
    this.disconnect(false);
  }
}

module.exports = { DiscordPresence };
