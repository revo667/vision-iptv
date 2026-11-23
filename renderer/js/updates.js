/* Uygulama güncellemeleri (GitHub Releases): yeni sürüm kartı, indirme durumu, kurulum.
   Asıl iş platformda yapılır: Android'de APK indirilip paket yükleyiciyle kurulur,
   Windows'ta electron-updater, macOS'ta uygulama paketi yerinde değiştirilir. */

const Updates = {
  info: null, // { version, notes, ready }
  status: '',
  busy: false,

  get supported() { return !!(window.native?.checkUpdate && window.native?.on); },
  get version() { return window.native?.version || ''; },

  init() {
    if (!this.supported) return;
    window.native.on((ev) => this.onEvent(ev));
    setTimeout(() => window.native.checkUpdate(false), 5000);
    setInterval(() => window.native.checkUpdate(false), 4 * 3600 * 1000);
  },

  check() {
    if (!this.supported) return;
    toast('Güncellemeler denetleniyor…');
    window.native.checkUpdate(true);
  },

  onEvent(ev) {
    switch (ev.type) {
      case 'update':
        if (ev.available) {
          this.info = { version: ev.version, notes: ev.notes || '', ready: false };
          this.status = '';
          this.render();
        } else if (ev.manual) {
          toast(ev.error ? `Güncelleme denetlenemedi: ${ev.error}` : `Vision güncel (v${ev.current || this.version})`, 3800);
        }
        break;
      case 'update-progress':
        this.busy = true;
        this.status = ev.pct >= 0 ? `İndiriliyor… %${ev.pct}` : 'İndiriliyor…';
        this.render();
        break;
      case 'update-installing':
        this.status = ev.message || 'Kuruluyor…';
        this.render();
        break;
      case 'update-ready':
        this.busy = false;
        if (this.info) this.info.ready = true;
        this.status = 'İndirildi — yeniden başlatınca kurulacak';
        this.render();
        break;
      case 'update-permission':
      case 'update-error':
        this.busy = false;
        this.status = '';
        toast(ev.message || 'Güncelleme başarısız oldu', 6500);
        this.render();
        break;
    }
  },

  el() {
    let el = $('#update-card');
    if (!el) {
      el = h('<div id="update-card" class="update-card" hidden></div>');
      el.addEventListener('click', (e) => {
        const a = e.target.closest('[data-upd]')?.dataset.upd;
        if (a === 'install') this.install();
        if (a === 'later') { el.hidden = true; this.dismissed = this.info?.version; }
      });
    }
    // Giriş ekranında da görünsün (kumandayla ulaşılabilsin diye açık olan katmanın içine)
    const parent = $('#login') && !$('#login').hidden ? $('#login') : $('#shell') || document.body;
    if (el.parentElement !== parent) parent.appendChild(el);
    return el;
  },

  render() {
    const i = this.info;
    const el = this.el();
    if (!i || this.dismissed === i.version) { el.hidden = !i || this.dismissed === i.version; return; }
    el.innerHTML = `
      <div class="update-text">${icon('refresh')}<div><b>Yeni sürüm: v${esc(i.version)}</b><span>${esc(this.status || 'Güncellemeyi şimdi kurabilirsin.')}</span></div></div>
      <div class="acts">
        <button class="btn btn-primary btn-sm" data-upd="install" ${this.busy ? 'disabled' : ''}>${i.ready ? 'Yeniden başlat' : 'Güncelle'}</button>
        <button class="btn btn-ghost btn-sm" data-upd="later">Sonra</button>
      </div>`;
    el.hidden = false;
  },

  install() {
    if (!this.info || this.busy) return;
    this.busy = !this.info.ready;
    this.status = this.info.ready ? 'Yeniden başlatılıyor…' : 'Hazırlanıyor…';
    this.render();
    window.native.installUpdate();
  },
};
