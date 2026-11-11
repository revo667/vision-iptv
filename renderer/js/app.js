/* Uygulama: giriş, yönlendirme, üst menü, klavye */

const App = {
  api: null,
  route: null,
  prevRoute: null,

  async init() {
    Player.init();
    Presence.init();
    this.bindLogin();
    this.bindNav();
    this.bindKeys();

    document.addEventListener('player-closed', (e) => {
      Live.onPlayerClosed(e.detail);
      if (this.route?.name === 'home') Views.refreshLibraryRows?.();
    });
    document.addEventListener('library-change', debounce(() => {
      if (this.route?.name === 'home' && !Player.isOpen) Views.refreshLibraryRows?.();
    }, 400));
    $('#modal').addEventListener('click', (e) => {
      if (e.target.closest('[data-act="close-modal"]')) Detail.close();
    });

    const saved = await AccountStore.load();
    if (saved) {
      this.fillLogin(saved);
      this.showLogin(true);
      await this.login(saved, { silent: true });
    } else {
      this.showLogin();
    }
  },

  /* ---------- Giriş ---------- */
  showLogin(busy = false) {
    $('#shell').hidden = true;
    $('#login').hidden = false;
    $('#login-submit').classList.toggle('loading', busy);
  },

  fillLogin(acc) {
    const f = $('#login-form');
    f.server.value = acc.server || '';
    f.username.value = acc.username || '';
    f.password.value = acc.password || '';
  },

  bindLogin() {
    const f = $('#login-form');
    const eye = $('[data-act="toggle-pass"]', f);
    eye.innerHTML = icon('eye');
    eye.onclick = () => {
      const show = f.password.type === 'password';
      f.password.type = show ? 'text' : 'password';
      eye.innerHTML = icon(show ? 'eyeOff' : 'eye');
    };
    f.server.addEventListener('input', () => {
      const parsed = parseM3uLink(f.server.value);
      if (parsed) {
        this.fillLogin(parsed);
        toast('M3U bağlantısından bilgiler dolduruldu');
      }
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      this.login({ server: normalizeServer(f.server.value), username: f.username.value.trim(), password: f.password.value.trim() });
    });
  },

  async login(acc, { silent = false } = {}) {
    const btn = $('#login-submit');
    const err = $('#login-error');
    err.hidden = true;
    btn.classList.add('loading');
    const api = new Xtream(acc);
    try {
      const info = await api.authenticate();
      await AccountStore.save({ server: api.server, username: api.username, password: api.password });
      this.api = api;
      Library.setScope(api.id);
      Catalog.reset();
      this.enterApp(info);
    } catch (e) {
      err.textContent = e.message || 'Giriş yapılamadı.';
      err.hidden = false;
      if (!silent) $('#login-form')?.animate?.([{ transform: 'translateX(0)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(8px)' }, { transform: 'translateX(0)' }], 300);
    } finally {
      btn.classList.remove('loading');
    }
  },

  enterApp(info) {
    $('#login').hidden = true;
    $('#shell').hidden = false;
    const u = info.user_info || {};
    $('#avatar').textContent = (u.username || '?').slice(0, 1).toUpperCase();
    this.renderAccountMenu();
    const exp = +u.exp_date;
    if (exp) {
      const days = Math.ceil((exp * 1000 - Date.now()) / 86400000);
      if (days <= 7 && days >= 0) setTimeout(() => toast(`Aboneliğin ${days} gün içinde sona eriyor`, 5000), 1500);
    }
    this.go('home');
  },

  async logout() {
    Player.close();
    Presence.clear();
    if (this.route?.name === 'live') Live.leave();
    await AccountStore.save(null);
    this.api = null;
    this.route = null;
    $('#view').innerHTML = '';
    $('#login-form').password.value = '';
    $('#account-menu').hidden = true;
    this.showLogin();
  },

  /* ---------- Hesap menüsü ---------- */
  renderAccountMenu() {
    const info = this.api?.info || {};
    const u = info.user_info || {};
    const s = info.server_info || {};
    const active = String(u.status || '').toLowerCase() === 'active';
    $('#account-menu').innerHTML = `
      <div class="acc-head">
        <div class="acc-user">
          <div class="avatar big">${esc((u.username || '?').slice(0, 1).toUpperCase())}</div>
          <div><div class="acc-name">${esc(u.username || '')}</div>
          <div class="acc-status ${active ? '' : 'bad'}">${active ? 'Aktif abonelik' : esc(u.status || 'Bilinmiyor')}</div></div>
        </div>
        <div class="acc-rows">
          <div>Bitiş tarihi <b>${fmtDate(+u.exp_date)}</b></div>
          <div>Bağlantı <b>${esc(u.active_cons ?? 0)} / ${esc(u.max_connections ?? '?')}</b></div>
          <div>Sunucu <b>${esc(this.api?.server.replace(/^https?:\/\//, '') || '')}</b></div>
          ${s.timezone ? `<div>Saat dilimi <b>${esc(s.timezone)}</b></div>` : ''}
        </div>
      </div>
      <button class="menu-item" data-act="toggle-adult">${icon('shield')}Yetişkin içerikleri gizle<span class="switch ${Settings.hideAdult ? 'on' : ''}"></span></button>
      <button class="menu-item" data-act="toggle-discord">${icon('discord')}Discord'da ne izlediğimi göster<span class="switch ${Settings.discord ? 'on' : ''}"></span></button>
      <button class="menu-item" data-act="refresh">${icon('refresh')}Kataloğu yenile</button>
      <button class="menu-item" data-act="logout">${icon('logout')}Çıkış yap</button>`;
  },

  /* ---------- Gezinme ---------- */
  bindNav() {
    $('[data-act="open-search"]').innerHTML = icon('search');
    $('[data-act="clear-search"]').innerHTML = icon('close');

    document.addEventListener('click', (e) => {
      const r = e.target.closest('[data-route]');
      if (r) { e.preventDefault(); this.go(r.dataset.route); }

      const act = e.target.closest('[data-act]')?.dataset.act;
      const menu = $('#account-menu');
      if (act === 'toggle-account') {
        this.renderAccountMenu();
        menu.hidden = !menu.hidden;
        return;
      }
      if (!e.target.closest('#account')) menu.hidden = true;
      if (act === 'logout') this.logout();
      if (act === 'refresh') {
        this.api?.clearCache();
        Catalog.reset();
        Items.clear();
        menu.hidden = true;
        toast('Katalog yenilendi');
        this.go(this.route?.name || 'home', this.route?.params);
      }
      if (act === 'toggle-adult') {
        Settings.hideAdult = !Settings.hideAdult;
        this.renderAccountMenu();
        this.go(this.route?.name || 'home', this.route?.params);
      }
      if (act === 'toggle-discord') {
        Presence.setEnabled(!Settings.discord);
        this.renderAccountMenu();
        toast(Settings.discord ? 'Discord durumu açıldı — yalnızca izlediğin içerik görünür' : 'Discord durumu kapatıldı');
      }
      if (act === 'open-search') this.openSearch();
      if (act === 'clear-search') {
        $('#search-input').value = '';
        $('#search').classList.remove('has-text');
        this.leaveSearch();
      }
    });

    const input = $('#search-input');
    const run = debounce(() => {
      const q = input.value.trim();
      $('#search').classList.toggle('has-text', !!q);
      if (q.length >= 2) {
        if (this.route?.name === 'search') {
          this.route.params.q = q;
          this.go('search', { q }, { replace: true });
        } else this.go('search', { q });
      } else if (!q) this.leaveSearch();
    }, 450);
    input.addEventListener('input', run);
    input.addEventListener('blur', () => {
      if (!input.value) $('#search').classList.remove('open');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        input.blur();
        $('#search').classList.remove('open', 'has-text');
        this.leaveSearch();
      }
    });
  },

  openSearch() {
    $('#search').classList.add('open');
    $('#search-input').focus();
  },

  leaveSearch() {
    if (this.route?.name === 'search') {
      const p = this.prevRoute && this.prevRoute.name !== 'search' ? this.prevRoute : { name: 'home', params: {} };
      this.go(p.name, p.params);
    }
  },

  go(name, params = {}, { replace = false } = {}) {
    if (!this.api) return;
    if (this.route?.name === 'live') Live.leave();
    Detail.close();
    if (!replace && this.route && this.route.name !== 'search') this.prevRoute = this.route;
    this.route = { name, params };

    if (name !== 'search') {
      const input = $('#search-input');
      input.value = '';
      $('#search').classList.remove('open', 'has-text');
    }
    $$('.nav-links a').forEach((a) => a.classList.toggle('active', a.dataset.route === name || (name === 'category' && a.dataset.route === (params.type === 'movie' ? 'movies' : params.type === 'series' ? 'series' : 'live'))));

    // Görünümü yenile (eski asenkron işler kopuk düğüme yazsın)
    const old = $('#view');
    const view = old.cloneNode(false);
    view.className = 'view';
    old.replaceWith(view);
    const nav = $('#nav');
    nav.classList.toggle('solid', name === 'live');
    view.addEventListener('scroll', () => {
      if (name !== 'live') nav.classList.toggle('solid', view.scrollTop > 40);
    }, { passive: true });

    const render = {
      home: () => Views.home(view),
      movies: () => Views.movies(view),
      series: () => Views.series(view),
      category: () => Views.category(view, params),
      mylist: () => Views.mylist(view),
      search: () => Views.search(view, params),
      live: () => Live.render(view, params),
    }[name];
    Promise.resolve(render?.()).catch((e) => {
      if (!view.isConnected) return;
      view.innerHTML = `<div class="page-top">${emptyHtml('alert', 'Bir sorun oluştu', e.message || 'İçerik yüklenemedi.')}</div>`;
    });
  },

  /* ---------- Klavye ---------- */
  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (Player.onKey(e)) { e.preventDefault(); return; }
      if (Player.isOpen) return;
      if (!$('#modal').hidden) {
        if (e.key === 'Escape') Detail.close();
        return;
      }
      if ((e.metaKey && e.key === 'f') || (e.key === '/' && !e.target.matches('input'))) {
        if (!$('#shell').hidden) { e.preventDefault(); this.openSearch(); }
        return;
      }
      if (this.route?.name === 'live' && Live.onKey(e)) e.preventDefault();
    });
  },
};

window.addEventListener('DOMContentLoaded', () => App.init());
