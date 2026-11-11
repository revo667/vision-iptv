/* Canlı TV sayfası: kategori → kanal listesi → önizleme + yayın akışı (EPG) */

const Live = {
  view: null,
  engine: null,
  cats: [],
  catId: null,
  channels: [],
  filtered: [],
  current: null,
  epgTimer: null,

  async render(view, params = {}) {
    this.view = view;
    view.classList.add('no-scroll');
    view.innerHTML = `
      <div class="live">
        <div class="live-col glass-col">
          <div class="live-col-head">
            <h2>Canlı TV</h2>
            <input class="filter-input" id="cat-filter" placeholder="Kategori ara" spellcheck="false">
          </div>
          <div class="live-scroll" id="cat-list"><div class="center-load" style="padding:40px 0"><div class="spinner"></div></div></div>
        </div>
        <div class="live-col glass-col">
          <div class="live-col-head">
            <h2 id="cat-title">Kanallar</h2>
            <input class="filter-input" id="ch-filter" placeholder="Kanal ara" spellcheck="false">
          </div>
          <div class="live-scroll" id="ch-list"></div>
        </div>
        <div class="live-stage">
          <div class="live-screen idle" id="ls">
            <video id="ls-video" playsinline></video>
            <div class="ls-placeholder" id="ls-ph">
              <div>${icon('tv')}<h3>Bir kanal seç</h3><p class="muted">Soldan kategori, ortadan kanal seçerek izlemeye başla.</p><div id="ls-last"></div></div>
            </div>
            <div class="ls-loading" id="ls-loading" hidden><div class="spinner"></div></div>
            <div class="ls-error" id="ls-error" hidden></div>
            <div class="ls-overlay">
              <div class="ls-top"><span class="live-dot">CANLI</span><span id="ls-name" class="ls-name"></span></div>
              <div class="ls-bottom">
                <div class="group">
                  <button class="ls-btn" data-ls="mute" id="ls-mute" title="Sessiz">${icon('volume')}</button>
                </div>
                <div class="group">
                  <button class="ls-btn" data-ls="fav" id="ls-fav" title="Favorilere ekle">${icon('star')}</button>
                  <button class="ls-btn" data-ls="external" title="Harici oynatıcıda aç">${icon('external')}</button>
                  <button class="ls-btn" data-ls="full" title="Tam ekran (Enter)">${icon('maximize')}</button>
                </div>
              </div>
            </div>
          </div>
          <div id="now"></div>
          <div class="epg-list" id="epg"></div>
        </div>
      </div>`;

    const video = $('#ls-video', view);
    video.volume = Settings.volume;
    video.muted = Settings.muted;
    this.engine = new StreamEngine(video);
    this.engine.onStatus = (s) => {
      $('#ls-loading', view).hidden = s !== 'loading';
      if (s === 'ready') { $('#ls', view).classList.remove('idle'); this.updatePresence(); }
    };
    this.engine.onError = (msg) => {
      $('#ls-loading', view).hidden = true;
      const err = $('#ls-error', view);
      err.innerHTML = `<div>${icon('alert')}<h3>Kanal açılamadı</h3><p>${esc(msg)}</p><button class="btn btn-glass btn-sm" data-ls="retry">${icon('refresh')}<span class="btn-label">Tekrar dene</span></button></div>`;
      err.hidden = false;
    };
    video.addEventListener('dblclick', () => this.openFull());
    video.addEventListener('volumechange', () => { $('#ls-mute', view).innerHTML = icon(video.muted ? 'mute' : 'volume'); });
    $('#ls-mute', view).innerHTML = icon(video.muted ? 'mute' : 'volume');

    view.querySelector('.live-stage').addEventListener('click', (e) => this.onStageClick(e));
    $('#cat-list', view).addEventListener('click', (e) => {
      const b = e.target.closest('[data-cat]');
      if (b) this.selectCategory(b.dataset.cat);
    });
    const chList = $('#ch-list', view);
    chList.addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      const ch = this.filtered.find((c) => String(c.id) === b.dataset.ch);
      if (!ch) return;
      if (fav) {
        const on = Library.toggleFav(ch);
        fav.classList.toggle('on', on);
        this.updateFavBtn();
        toast(on ? 'Favori kanallara eklendi' : 'Favorilerden çıkarıldı');
        if (this.catId === 'fav') this.selectCategory('fav', true);
        return;
      }
      this.select(ch);
    });
    chList.addEventListener('dblclick', (e) => {
      const b = e.target.closest('[data-ch]');
      if (b && !e.target.closest('[data-fav]')) this.openFull();
    });
    $('#ch-filter', view).addEventListener('input', debounce(() => this.renderChannels(), 150));
    $('#cat-filter', view).addEventListener('input', debounce(() => this.renderCats(), 150));

    const cats = await Catalog.visibleCategories('live');
    if (!view.isConnected) return;
    this.cats = [{ id: 'fav', name: 'Favoriler', fav: true }, { id: 'all', name: 'Tüm kanallar' }, ...cats];
    this.renderCats();

    const last = Library.lastChannel();
    const startCat = params.cat || (last && last.cat) || (Library.favList('live').length ? 'fav' : cats[0]?.id || 'all');
    await this.selectCategory(String(startCat));
    if (last) {
      $('#ls-last', view).innerHTML = `<button class="btn btn-primary btn-sm" data-ls="resume-last">${icon('play')}<span class="btn-label">${esc(last.name)} izlemeye devam et</span></button>`;
      this.markActive(last.id, true);
    }

    this.epgTimer = setInterval(() => this.renderNow(), 30000);
  },

  updatePresence() {
    const ch = this.current;
    if (!ch || !this.engine || Player.isOpen) return;
    if (!this.watchSince || this.watchSince.id !== ch.id) this.watchSince = { id: ch.id, t: Date.now() };
    const now = Date.now() / 1000;
    const cur = (this.epg?.ch === ch.id ? this.epg.list : []).find((e) => e.start <= now && e.end > now);
    Presence.set({ title: ch.name, state: cur ? cur.title : 'Canlı TV', image: ch.icon, start: this.watchSince.t });
  },

  leave() {
    if (!Player.isOpen) Presence.clear();
    clearInterval(this.epgTimer);
    this.engine?.stop();
    this.engine = null;
    this.current = null;
    this.view?.classList.remove('no-scroll');
    this.view = null;
  },

  renderCats() {
    const q = normText($('#cat-filter', this.view)?.value || '');
    $('#cat-list', this.view).innerHTML = this.cats
      .filter((c) => !q || c.fav || c.id === 'all' || normText(c.name).includes(q))
      .map((c) => `<button class="cat-item ${c.id === this.catId ? 'active' : ''}" data-cat="${esc(c.id)}">
          <span>${c.fav ? icon('star') + ' ' : ''}${esc(c.name)}</span></button>`)
      .join('');
  },

  async selectCategory(id, keepScroll) {
    this.catId = id;
    this.renderCats();
    const cat = this.cats.find((c) => c.id === id) || { name: 'Kanallar' };
    $('#cat-title', this.view).textContent = cat.name;
    const list = $('#ch-list', this.view);
    if (!keepScroll) list.innerHTML = '<div class="center-load" style="padding:40px 0"><div class="spinner"></div></div>';
    try {
      if (id === 'fav') this.channels = Library.favList('live').map(reg);
      else if (id === 'all') this.channels = await Catalog.all('live');
      else this.channels = await Catalog.items('live', id);
    } catch (e) {
      list.innerHTML = `<div class="empty" style="padding:40px 10px">${icon('alert')}<p>${esc(e.message)}</p></div>`;
      return;
    }
    if (this.catId !== id || !this.view) return;
    this.renderChannels(keepScroll);
  },

  renderChannels(keepScroll) {
    const list = $('#ch-list', this.view);
    const q = normText($('#ch-filter', this.view).value);
    this.filtered = q ? this.channels.filter((c) => normText(c.name).includes(q)) : this.channels;
    if (!this.filtered.length) {
      list.innerHTML = `<div class="empty" style="padding:40px 10px">${icon(this.catId === 'fav' ? 'star' : 'tv')}<p>${this.catId === 'fav' ? 'Henüz favori kanalın yok. Kanalların yanındaki ★ simgesine tıkla.' : 'Kanal bulunamadı.'}</p></div>`;
      return;
    }
    const scroll = list.scrollTop;
    const favs = Library.favs();
    const row = (c) => `
      <button class="ch-item ${this.current && c.id === this.current.id ? 'active' : ''}" data-ch="${esc(c.id)}">
        <span class="ch-num">${esc(c.num ?? '')}</span>
        <span class="ch-logo">${imgTag(c.icon, '', 'data-hide-broken')}<b>${esc(initials(c.name))}</b></span>
        <span class="ch-text"><div>${esc(c.name)}</div></span>
        <span class="ch-fav ${favs['live:' + c.id] ? 'on' : ''}" data-fav title="Favori">${icon('star')}</span>
      </button>`;
    list.innerHTML = '';
    let i = 0;
    const CHUNK = 200;
    const sentinel = h('<div class="grid-sentinel"></div>');
    const more = () => {
      sentinel.insertAdjacentHTML('beforebegin', this.filtered.slice(i, i + CHUNK).map(row).join(''));
      i += CHUNK;
      if (i >= this.filtered.length) io.disconnect();
    };
    list.appendChild(sentinel);
    const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) more(); }, { root: list, rootMargin: '600px 0px' });
    more();
    io.observe(sentinel);
    if (keepScroll) list.scrollTop = scroll;
  },

  markActive(id, scroll) {
    $$('#ch-list .ch-item', this.view).forEach((el) => el.classList.toggle('active', el.dataset.ch === String(id)));
    if (scroll) $(`#ch-list [data-ch="${CSS.escape(String(id))}"]`, this.view)?.scrollIntoView({ block: 'nearest' });
  },

  select(ch, { play = true } = {}) {
    if (!this.view) return;
    this.current = ch;
    this.markActive(ch.id, true);
    Library.setLastChannel({ ...ch, cat: this.catId === 'fav' || this.catId === 'all' ? this.catId : ch.cat });
    $('#ls-ph', this.view).hidden = true;
    $('#ls-error', this.view).hidden = true;
    $('#ls-name', this.view).textContent = ch.name;
    this.updateFavBtn();
    this.renderNow(true);
    if (play) this.playDebounced(ch);
  },

  playDebounced: debounce(function (ch) {
    if (!Live.engine || Live.current !== ch) return;
    const api = App.api;
    const urls = { hls: api.outputFormat === 'm3u8' ? api.liveUrl(ch.id, 'm3u8') : null, ts: api.liveUrl(ch.id, 'ts') };
    Live.engine.load({ live: true, urls });
  }, 250),

  updateFavBtn() {
    const b = $('#ls-fav', this.view);
    if (!b || !this.current) return;
    const on = Library.isFav(this.current);
    b.classList.toggle('on', on);
    b.title = on ? 'Favorilerden çıkar' : 'Favorilere ekle';
  },

  async renderNow(fetchNew) {
    const ch = this.current;
    if (!ch || !this.view) return;
    if (fetchNew || !this.epg || this.epg.ch !== ch.id) {
      this.epg = { ch: ch.id, list: [] };
      this.paintNow(ch);
      const list = await App.api.shortEpg(ch.id, 12);
      if (this.current !== ch) return;
      this.epg = { ch: ch.id, list };
      if (this.engine?.mode) this.updatePresence();
    }
    this.paintNow(ch);
  },

  paintNow(ch) {
    const now = Date.now() / 1000;
    const list = this.epg?.list || [];
    const cur = list.find((e) => e.start <= now && e.end > now);
    const pct = cur ? ((now - cur.start) / (cur.end - cur.start)) * 100 : 0;
    $('#now', this.view).innerHTML = `
      <div class="now-card glass">
        <div class="now-logo">${imgTag(ch.icon, '', 'data-hide-broken')}<b>${esc(initials(ch.name))}</b></div>
        <div>
          <div class="now-ch">${esc(ch.name)}</div>
          ${cur ? `
            <div class="now-prog">${esc(cur.title)}</div>
            <div class="now-time">${hhmm(cur.start)} – ${hhmm(cur.end)} · ${Math.max(0, Math.round((cur.end - now) / 60))} dk kaldı</div>
            <div class="now-bar"><i style="width:${pct}%"></i></div>
            ${cur.desc ? `<div class="now-desc">${esc(cur.desc)}</div>` : ''}`
          : `<div class="now-time">${list.length ? '' : 'Bu kanal için yayın akışı bilgisi yok.'}</div>`}
        </div>
      </div>`;
    const upcoming = list.filter((e) => e.end > now).slice(0, 10);
    $('#epg', this.view).innerHTML = upcoming.length ? `
      <h4>Yayın akışı</h4>
      ${upcoming.map((e) => `<div class="epg-item ${e === cur ? 'now' : ''}"><time>${hhmm(e.start)} – ${hhmm(e.end)}</time><span>${esc(e.title)}</span></div>`).join('')}` : '';
  },

  onStageClick(e) {
    const b = e.target.closest('[data-ls]');
    if (!b) return;
    const video = $('#ls-video', this.view);
    switch (b.dataset.ls) {
      case 'mute': video.muted = !video.muted; Settings.muted = video.muted; break;
      case 'fav':
        if (this.current) {
          const on = Library.toggleFav(this.current);
          this.updateFavBtn();
          const star = $(`#ch-list [data-ch="${CSS.escape(String(this.current.id))}"] [data-fav]`, this.view);
          star?.classList.toggle('on', on);
          toast(on ? 'Favori kanallara eklendi' : 'Favorilerden çıkarıldı');
        }
        break;
      case 'full': this.openFull(); break;
      case 'retry': if (this.current) this.select(this.current); break;
      case 'resume-last': {
        const last = Library.lastChannel();
        if (last) this.select(this.channels.find((c) => c.id === last.id) || reg(last));
        break;
      }
      case 'external':
        if (this.current) {
          Player.getExternalPlayers().then(async (players) => {
            const url = App.api.liveUrl(this.current.id, 'ts');
            if (!players.length) {
              if (window.native) await window.native.copy(url);
              toast('IINA/VLC bulunamadı — yayın bağlantısı panoya kopyalandı');
              return;
            }
            this.engine.stop();
            await window.native.openInPlayer(players[0].id, url);
            toast(`${players[0].name} ile açıldı`);
          });
        }
        break;
    }
  },

  openFull() {
    if (!this.current) return;
    this.engine?.stop();
    Player.playLive(this.current, this.filtered.length ? this.filtered : this.channels);
  },

  // Oynatıcı kapanınca önizlemeye geri dön
  onPlayerClosed(session) {
    if (!this.view || !session || session.kind !== 'live') return;
    const ch = session.item;
    this.select(this.channels.find((c) => c.id === ch.id) || ch);
  },

  onKey(e) {
    if (!this.view || e.target.matches('input, select, textarea')) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!this.filtered.length) return true;
      const idx = this.current ? this.filtered.findIndex((c) => c.id === this.current.id) : -1;
      const n = this.filtered[Math.max(0, Math.min(this.filtered.length - 1, idx + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (n && n !== this.current) this.select(n);
      return true;
    }
    if (e.key === 'Enter' && this.current) { this.openFull(); return true; }
    return false;
  },
};
