/* Kalıcı veri: hesap, listem, izleme geçmişi, ayarlar */

const Store = {
  get(k, def) {
    try { const v = localStorage.getItem('vz:' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem('vz:' + k, JSON.stringify(v)); } catch {}
  },
};

const AccountStore = {
  async load() {
    if (window.native) return (await window.native.getAccount()) || null;
    return Store.get('account', null);
  },
  async save(acc) {
    if (window.native) return window.native.setAccount(acc);
    if (acc) Store.set('account', acc); else localStorage.removeItem('vz:account');
  },
};

const Library = {
  scope: 'default',
  setScope(id) { this.scope = id; },
  k(name) { return `${this.scope}:${name}`; },

  // ---- Listem (favoriler) ----
  favs() { return Store.get(this.k('favs'), {}); },
  favKey(item) { return `${item.type}:${item.id}`; },
  isFav(item) { return !!this.favs()[this.favKey(item)]; },
  toggleFav(item) {
    const f = this.favs();
    const key = this.favKey(item);
    if (f[key]) delete f[key];
    else f[key] = { type: item.type, id: item.id, name: item.name, icon: item.icon, ext: item.ext, rating: item.rating, year: item.year, num: item.num, cat: item.cat, t: Date.now() };
    Store.set(this.k('favs'), f);
    document.dispatchEvent(new CustomEvent('library-change'));
    return !!f[key];
  },
  favList(type) {
    return Object.values(this.favs()).filter((x) => !type || x.type === type).sort((a, b) => b.t - a.t);
  },

  // ---- İzleme ilerlemesi ----
  progressAll() { return Store.get(this.k('progress'), {}); },
  getProgress(key) { return this.progressAll()[key] || null; },
  saveProgress(key, data) {
    const all = this.progressAll();
    all[key] = { ...(all[key] || {}), ...data, t: Date.now() };
    // Çok büyümesin
    const keys = Object.keys(all);
    if (keys.length > 600) {
      keys.sort((a, b) => all[a].t - all[b].t).slice(0, keys.length - 600).forEach((k) => delete all[k]);
    }
    Store.set(this.k('progress'), all);
  },
  removeProgress(key) {
    const all = this.progressAll();
    delete all[key];
    Store.set(this.k('progress'), all);
    document.dispatchEvent(new CustomEvent('library-change'));
  },
  // "İzlemeye devam et" — film ve dizi kayıtları
  continueList() {
    const all = this.progressAll();
    return Object.entries(all)
      .filter(([k, v]) => (k.startsWith('movie:') || k.startsWith('series:')) && !v.done && v.pos > 20)
      .map(([, v]) => v)
      .sort((a, b) => b.t - a.t)
      .slice(0, 30);
  },

  // ---- Canlı TV ----
  lastChannel() { return Store.get(this.k('lastChannel'), null); },
  setLastChannel(ch) { Store.set(this.k('lastChannel'), ch); },
};

const Settings = {
  get hideAdult() { return Store.get('hideAdult', true); },
  set hideAdult(v) { Store.set('hideAdult', !!v); },
  get volume() { return Store.get('volume', 1); },
  set volume(v) { Store.set('volume', v); },
  get muted() { return Store.get('muted', false); },
  set muted(v) { Store.set('muted', !!v); },
};

Object.defineProperty(Settings, 'discord', {
  get() { return Store.get('discord', true); },
  set(v) { Store.set('discord', !!v); },
});

/* Discord Rich Presence — yalnızca izlenen içerik gösterilir */
const Presence = {
  current: null,
  init() {
    window.native?.presenceConfig?.(Settings.discord);
  },
  setEnabled(on) {
    Settings.discord = on;
    window.native?.presenceConfig?.(on);
    this.push();
  },
  // info: { title, state, image, start, end }
  set(info) {
    this.current = info;
    this.push();
  },
  clear() {
    this.current = null;
    this.push();
  },
  push() {
    if (!window.native?.setPresence) return;
    window.native.setPresence(Settings.discord ? this.current : null);
  },
  // <video> durumundan film/dizi bilgisi
  fromVideo(video, base) {
    if (!base) return this.clear();
    const info = { title: base.title, state: base.state, image: base.image };
    if (base.live) {
      info.start = base.since;
    } else if (!video.paused && isFinite(video.duration) && video.duration > 0) {
      const now = Date.now();
      info.start = now - (video.currentTime * 1000) / (video.playbackRate || 1);
      info.end = info.start + (video.duration * 1000) / (video.playbackRate || 1);
    } else if (video.paused && video.currentTime > 0) {
      info.state = [base.state, 'Duraklatıldı'].filter(Boolean).join(' · ');
    }
    this.set(info);
  },
};
