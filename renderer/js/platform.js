/* Platform köprüsü — <head> içinde, her şeyden önce yüklenir.
   Masaüstünde window.native'i preload.js tanımlar; Android'de WebView'e eklenen
   window.VisionAndroid nesnesinden aynı arayüz kurulur. */
(() => {
  const root = document.documentElement;
  const A = window.VisionAndroid;
  if (!A) {
    if (window.native?.isElectron) root.classList.add('desktop', `os-${window.native.os || 'darwin'}`);
    return;
  }

  let info = {};
  try { info = JSON.parse(A.info()); } catch {}
  root.classList.add('android', info.tv ? 'tv' : 'touch');
  // TV: arayüzü 1600×900 mantıksal piksele ölçekle (masaüstü düzeniyle birebir aynı oran)
  if (info.tv) document.querySelector('meta[name=viewport]')?.setAttribute('content', 'width=1600');

  const listeners = new Set();
  window.__vzEmit = (ev) => {
    for (const cb of listeners) {
      try { cb(ev); } catch (e) { console.error(e); }
    }
  };
  const parse = (s, def) => { try { return s ? JSON.parse(s) : def; } catch { return def; } };

  window.native = {
    platform: 'android',
    isTv: !!info.tv,
    version: info.version || '',
    getAccount: async () => parse(A.getAccount(), null),
    setAccount: async (acc) => A.setAccount(acc ? JSON.stringify(acc) : null),
    storeAll: async () => parse(A.storeAll(), {}),
    storeSet: (k, json) => A.storeSet(k, json == null ? null : String(json)),
    storeSetMany: (obj) => A.storeSetMany(JSON.stringify(obj)),
    listPlayers: async () => [{ id: 'android', name: 'Başka uygulama' }],
    openInPlayer: async (_id, url, title) => A.openExternal(url, title || ''),
    copy: async (text) => A.copy(String(text)),
    openUrl: (url) => A.openUrl(url),
    play: (opts) => A.play(JSON.stringify(opts)),
    updatePlayer: (o) => A.updatePlayer(JSON.stringify(o)),
    showKeyboard: () => A.showKeyboard(),
    exit: () => A.exit(),
    checkUpdate: (manual) => A.checkUpdate(!!manual),
    installUpdate: () => A.installUpdate(),
    on: (cb) => listeners.add(cb),
    // Xtream API istekleri uygulamanın yerel vekilinden geçer (CORS / http engeli yok)
    proxy: (url) => `${location.origin}/__proxy?u=${encodeURIComponent(url)}`,
  };

  /* TV: metin kutuları OK tuşuna basılana kadar salt okunur kalır. Böylece gizli ekran klavyesi
     kumanda tuşlarını yakalayıp yazmaz; OK → düzenle + klavyeyi aç, klavye kapanınca tekrar kilitle. */
  const isText = (el) => el && el.matches?.('input:not([type=checkbox]):not([type=range]):not([type=file]):not([type=hidden]), textarea');
  window.native.isText = isText;
  if (info.tv) {
    document.addEventListener('focusin', (e) => {
      if (isText(e.target) && !e.target.vzEditing) e.target.readOnly = true;
    }, true);
    document.addEventListener('focusout', (e) => {
      const el = e.target;
      if (!isText(el)) return;
      // Klavye açılırken WebView odağı geçici olarak gidip gelir: yalnızca odak gerçekten başka yere geçtiyse kilitle
      setTimeout(() => {
        if (document.activeElement !== el) { el.vzEditing = false; el.readOnly = true; }
      }, 50);
    }, true);
    window.native.editText = (el) => {
      el.vzEditing = true;
      el.readOnly = false;
      if (document.activeElement !== el) el.focus();
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      // Chromium düzenlenebilirliği bir sonraki karede bildirir; klavyeyi ondan sonra iste
      setTimeout(() => A.showKeyboard(), 120);
    };
    listeners.add((ev) => {
      if (ev.type !== 'ime' || ev.visible) return;
      const el = document.activeElement;
      if (isText(el)) { el.vzEditing = false; el.readOnly = true; }
    });
  }
})();
