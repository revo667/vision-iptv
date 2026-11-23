/* Kalıcı veri: hesap, listem, izleme geçmişi, ayarlar */

/* localStorage hızlı okuma içindir; kalıcı kaynak uygulamanın kendi kayıt dosyasıdır
   (localStorage diske gecikmeli yazılır, uygulama aniden kapanınca son değişiklikler kaybolabilir). */
const Store = {
  get(k, def) {
    try { const v = localStorage.getItem('vz:' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    const json = JSON.stringify(v);
    try { localStorage.setItem('vz:' + k, json); } catch {}
    try { window.native?.storeSet?.(k, json); } catch {}
  },
  // Açılışta kayıt dosyasını localStorage'a geri yükle
  async hydrate() {
    if (!window.native?.storeAll) return;
    try {
      const data = (await window.native.storeAll()) || {};
      const keys = Object.keys(data);
      if (!keys.length) {
        // İlk açılış: mevcut verileri dosyaya taşı
        const all = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('vz:') && k !== 'vz:account') all[k.slice(3)] = localStorage.getItem(k);
        }
        if (Object.keys(all).length) window.native.storeSetMany?.(all);
        return;
      }
      for (const k of keys) {
        try { localStorage.setItem('vz:' + k, data[k]); } catch {}
      }
    } catch {}
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

  // ---- Favori kanal listeleri (birden çok, adlandırılabilir) ----
  chSnap(ch) {
    return { type: 'live', id: ch.id, name: ch.name, icon: ch.icon || '', num: ch.num, cat: ch.cat, t: Date.now() };
  },
  chLists() {
    let lists = Store.get(this.k('chLists'), null);
    if (!Array.isArray(lists)) {
      // Eski tek "Favoriler" listesini taşı
      const f = this.favs();
      const old = Object.values(f).filter((x) => x.type === 'live').sort((a, b) => b.t - a.t);
      lists = old.length ? [{ id: this.newListId(), name: 'Favoriler', items: old.map((c) => this.chSnap(c)), t: Date.now() }] : [];
      Store.set(this.k('chLists'), lists);
      if (old.length) {
        for (const k of Object.keys(f)) if (k.startsWith('live:')) delete f[k];
        Store.set(this.k('favs'), f);
      }
    }
    return lists;
  },
  newListId() { return 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); },
  saveChLists(lists) {
    Store.set(this.k('chLists'), lists);
    document.dispatchEvent(new CustomEvent('library-change'));
  },
  chList(id) { return this.chLists().find((l) => l.id === id) || null; },
  createChList(name) {
    const lists = this.chLists();
    const l = { id: this.newListId(), name: String(name || '').trim().slice(0, 40) || `Liste ${lists.length + 1}`, items: [], t: Date.now() };
    lists.push(l);
    this.saveChLists(lists);
    return l;
  },
  renameChList(id, name) {
    const lists = this.chLists();
    const l = lists.find((x) => x.id === id);
    const n = String(name || '').trim().slice(0, 40);
    if (!l || !n) return false;
    l.name = n;
    this.saveChLists(lists);
    return true;
  },
  deleteChList(id) {
    this.saveChLists(this.chLists().filter((l) => l.id !== id));
  },
  moveChList(id, delta) {
    const lists = this.chLists();
    const i = lists.findIndex((l) => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= lists.length) return;
    [lists[i], lists[j]] = [lists[j], lists[i]];
    this.saveChLists(lists);
  },
  inChList(listId, ch) {
    const l = this.chList(listId);
    return !!l && l.items.some((x) => String(x.id) === String(ch.id));
  },
  toggleInChList(listId, ch) {
    const lists = this.chLists();
    const l = lists.find((x) => x.id === listId);
    if (!l) return false;
    const i = l.items.findIndex((x) => String(x.id) === String(ch.id));
    if (i >= 0) l.items.splice(i, 1);
    else l.items.push(this.chSnap(ch));
    this.saveChLists(lists);
    return i < 0;
  },
  chFavIds() {
    const ids = new Set();
    for (const l of this.chLists()) for (const x of l.items) ids.add(String(x.id));
    return ids;
  },
  isChFav(ch) { return this.chFavIds().has(String(ch.id)); },

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

// Son seçilen ses / altyazı dili ("tr", "en"… ya da altyazı için "off")
Object.defineProperty(Settings, 'audioLang', {
  get() { return Store.get('audioLang', ''); },
  set(v) { Store.set('audioLang', v || ''); },
});
Object.defineProperty(Settings, 'subLang', {
  get() { return Store.get('subLang', ''); },
  set(v) { Store.set('subLang', v || ''); },
});

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
