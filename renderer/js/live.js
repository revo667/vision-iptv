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
            <div class="col-title"><h2 id="cat-title">Kanallar</h2><div class="list-acts" id="list-acts"></div></div>
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

    // Android: önizleme yok; kanala odaklanınca yayın akışı görünür, seçince tam ekran oynatıcı açılır
    this.native = NativePlayer.available;
    if (this.native) $('.live', view).classList.add('native-live');
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
      if (e.target.closest('[data-act="new-list"]')) { this.newList(); return; }
      const b = e.target.closest('[data-cat]');
      if (b) this.selectCategory(b.dataset.cat);
    });
    $('#list-acts', view).addEventListener('click', (e) => {
      const a = e.target.closest('[data-la]')?.dataset.la;
      if (a) this.listAction(a);
    });
    const chList = $('#ch-list', view);
    chList.addEventListener('click', (e) => {
      const fav = e.target.closest('[data-fav]');
      const b = e.target.closest('[data-ch]');
      if (!b) return;
      const ch = this.filtered.find((c) => String(c.id) === b.dataset.ch);
      if (!ch) return;
      if (fav) {
        FavPicker.open(ch, { onChange: () => this.refreshFavs() });
        return;
      }
      if (this.native) {
        this.select(ch, { play: false });
        this.openFull();
        return;
      }
      this.select(ch);
    });
    chList.addEventListener('dblclick', (e) => {
      const b = e.target.closest('[data-ch]');
      if (b && !e.target.closest('[data-fav]')) this.openFull();
    });
    if (this.native) {
      chList.addEventListener('focusin', debounce((e) => {
        const b = e.target.closest?.('[data-ch]');
        if (!b || !this.view) return;
        const ch = this.filtered.find((c) => String(c.id) === b.dataset.ch);
        if (ch && ch !== this.current) this.select(ch, { play: false, scroll: false });
      }, 220));
    }
    $('#ch-filter', view).addEventListener('input', debounce(() => this.renderChannels(), 150));
    $('#cat-filter', view).addEventListener('input', debounce(() => this.renderCats(), 150));

    const cats = await Catalog.visibleCategories('live');
    if (!view.isConnected) return;
    this.liveCats = cats;
    this.buildCats();
    this.renderCats();

    const last = Library.lastChannel();
    const firstList = Library.chLists().find((l) => l.items.length);
    const startCat = params.cat || (last && last.cat) || (firstList ? `list:${firstList.id}` : cats[0]?.id || 'all');
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
    if (this.engine) Engines.all.delete(this.engine);
    this.engine = null;
    this.current = null;
    this.view?.classList.remove('no-scroll');
    this.view = null;
  },

  // Favori listeleri + "Tüm kanallar" + sağlayıcının kategorileri
  buildCats() {
    const lists = Library.chLists().map((l) => ({ id: `list:${l.id}`, listId: l.id, name: l.name, fav: true, count: l.items.length }));
    this.cats = [...lists, { id: 'all', name: 'Tüm kanallar' }, ...(this.liveCats || [])];
  },

  renderCats() {
    const q = normText($('#cat-filter', this.view)?.value || '');
    const item = (c) => `<button class="cat-item ${c.fav ? 'fav' : ''} ${c.id === this.catId ? 'active' : ''}" data-cat="${esc(c.id)}">
        <span>${c.fav ? icon('star') + ' ' : ''}${esc(c.name)}</span>${c.fav ? `<small>${c.count}</small>` : ''}</button>`;
    const lists = this.cats.filter((c) => c.fav);
    const rest = this.cats.filter((c) => !c.fav && (!q || c.id === 'all' || normText(c.name).includes(q)));
    // Yeniden çizimde kumanda odağı kaybolmasın
    const ae = document.activeElement;
    const keep = ae && ae.closest?.('#cat-list') ? (ae.dataset.cat ? `[data-cat="${CSS.escape(ae.dataset.cat)}"]` : ae.dataset.act ? `[data-act="${ae.dataset.act}"]` : null) : null;
    $('#cat-list', this.view).innerHTML = `
      <div class="cat-group">Favori listelerim</div>
      ${lists.map(item).join('')}
      <button class="cat-item new-list" data-act="new-list"><span>${icon('plus')} Yeni liste oluştur</span></button>
      <div class="cat-group">Kategoriler</div>
      ${rest.map(item).join('')}`;
    if (keep) $(`#cat-list ${keep}`, this.view)?.focus({ preventScroll: true });
  },

  async newList() {
    const name = await Dialog.prompt({ title: 'Yeni favori listesi', placeholder: 'Liste adı (ör. Spor, Haber, Çocuk)', ok: 'Oluştur' });
    if (!name || !this.view) return;
    const l = Library.createChList(name);
    toast(`“${l.name}” oluşturuldu — kanallardaki ★ ile ekleyebilirsin`);
    this.buildCats();
    this.selectCategory(`list:${l.id}`);
    $(`#cat-list [data-cat="list:${CSS.escape(l.id)}"]`, this.view)?.focus({ preventScroll: true });
  },

  async listAction(a) {
    const cat = this.cats.find((c) => c.id === this.catId);
    if (!cat?.listId) return;
    if (a === 'rename') {
      const name = await Dialog.prompt({ title: 'Listeyi yeniden adlandır', value: cat.name });
      if (name && Library.renameChList(cat.listId, name)) toast('Liste adı güncellendi');
    } else if (a === 'delete') {
      const ok = await Dialog.confirm({ title: `“${cat.name}” silinsin mi?`, text: 'Kanallar silinmez, yalnızca bu favori listesi kaldırılır.', ok: 'Sil', danger: true });
      if (!ok) return;
      Library.deleteChList(cat.listId);
      toast('Liste silindi');
      if (!this.view) return;
      this.buildCats();
      const first = this.cats.find((c) => c.fav);
      return this.selectCategory(first ? first.id : 'all');
    } else if (a === 'up' || a === 'down') {
      Library.moveChList(cat.listId, a === 'up' ? -1 : 1);
    }
    if (!this.view) return;
    this.buildCats();
    this.selectCategory(this.catId, true);
    $(`#list-acts [data-la="${a}"]`, this.view)?.focus({ preventScroll: true });
  },

  renderListActs() {
    const cat = this.cats.find((c) => c.id === this.catId);
    const el = $('#list-acts', this.view);
    if (!el) return;
    if (!cat?.listId) { el.innerHTML = ''; return; }
    const lists = this.cats.filter((c) => c.fav);
    const i = lists.indexOf(cat);
    el.innerHTML = `
      ${i > 0 ? `<button class="icon-btn" data-la="up" title="Yukarı taşı">${icon('chevUp')}</button>` : ''}
      ${i < lists.length - 1 ? `<button class="icon-btn" data-la="down" title="Aşağı taşı">${icon('chevDown')}</button>` : ''}
      <button class="icon-btn" data-la="rename" title="Yeniden adlandır">${icon('pencil')}</button>
      <button class="icon-btn danger" data-la="delete" title="Listeyi sil">${icon('close')}</button>`;
  },

  // Favoriler değişince yıldızları ve açık listeyi yenile
  refreshFavs() {
    if (!this.view) return;
    this.buildCats();
    this.renderCats();
    this.updateFavBtn();
    if (this.cats.find((c) => c.id === this.catId)?.fav) {
      this.selectCategory(this.catId, true);
    } else {
      const ids = Library.chFavIds();
      for (const el of this.view.querySelectorAll('#ch-list [data-ch]')) el.querySelector('[data-fav]')?.classList.toggle('on', ids.has(el.dataset.ch));
    }
  },

  async selectCategory(id, keepScroll) {
    if (id === 'fav') { // eski tek favori listesi
      const first = this.cats.find((c) => c.fav);
      id = first ? first.id : 'all';
    }
    this.catId = id;
    this.renderCats();
    this.renderListActs();
    const cat = this.cats.find((c) => c.id === id) || { name: 'Kanallar' };
    $('#cat-title', this.view).textContent = cat.name;
    const list = $('#ch-list', this.view);
    if (!keepScroll) list.innerHTML = '<div class="center-load" style="padding:40px 0"><div class="spinner"></div></div>';
    try {
      if (id.startsWith('list:')) this.channels = (Library.chList(id.slice(5))?.items || []).map(reg);
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
      const isList = this.catId.startsWith('list:');
      list.innerHTML = `<div class="empty" style="padding:40px 10px">${icon(isList ? 'star' : 'tv')}<p>${isList ? 'Bu liste boş. Bir kategoriden kanal seçip yanındaki ★ simgesiyle bu listeye ekleyebilirsin.' : 'Kanal bulunamadı.'}</p></div>`;
      return;
    }
    const scroll = list.scrollTop;
    const favIds = Library.chFavIds();
    const ae = document.activeElement;
    const rowsBefore = Array.from(list.querySelectorAll('.ch-row'));
    const keep = ae && ae.closest?.('#ch-list') && ae.dataset.ch
      ? { cls: ae.classList.contains('ch-fav') ? 'ch-fav' : 'ch-item', id: ae.dataset.ch, idx: rowsBefore.indexOf(ae.closest('.ch-row')) }
      : null;
    // Kanal ve ★ ayrı düğmeler: kumandayla yıldıza da gidilebilsin (sağ ok)
    const row = (c) => `
      <div class="ch-row" data-ch="${esc(c.id)}">
        <button class="ch-item ${this.current && c.id === this.current.id ? 'active' : ''}" data-ch="${esc(c.id)}">
          <span class="ch-num">${esc(c.num ?? '')}</span>
          <span class="ch-logo">${imgTag(c.icon, '', 'data-hide-broken')}<b>${esc(initials(c.name))}</b></span>
          <span class="ch-text"><div>${esc(c.name)}</div></span>
        </button>
        <button class="ch-fav ${favIds.has(String(c.id)) ? 'on' : ''}" data-fav data-ch="${esc(c.id)}" title="Favori listelerine ekle" aria-label="Favori listelerine ekle">${icon('star')}</button>
      </div>`;
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
    if (keep) {
      // Aynı kanal listede kaldıysa ona, çıkarıldıysa aynı sıradaki kanala dön
      const rows = Array.from(list.querySelectorAll('.ch-row'));
      const row = rows.find((r) => r.dataset.ch === keep.id) || rows[Math.min(Math.max(keep.idx, 0), rows.length - 1)];
      (row?.querySelector(`.${keep.cls}`) || row?.querySelector('.ch-item'))?.focus({ preventScroll: true });
    }
  },

  markActive(id, scroll) {
    $$('#ch-list .ch-item', this.view).forEach((el) => el.classList.toggle('active', el.dataset.ch === String(id)));
    if (scroll) $(`#ch-list [data-ch="${CSS.escape(String(id))}"]`, this.view)?.scrollIntoView({ block: 'nearest' });
  },

  select(ch, { play = true, scroll = true } = {}) {
    if (!this.view) return;
    this.current = ch;
    this.markActive(ch.id, scroll);
    Library.setLastChannel({ ...ch, cat: this.catId.startsWith('list:') || this.catId === 'all' ? this.catId : ch.cat });
    if (this.native) this.paintNativeStage(ch);
    else $('#ls-ph', this.view).hidden = true;
    $('#ls-error', this.view).hidden = true;
    $('#ls-name', this.view).textContent = ch.name;
    this.updateFavBtn();
    this.renderNow(true);
    if (play && !this.native) this.playDebounced(ch);
  },

  // Android: önizleme alanında kanal kartı
  paintNativeStage(ch) {
    const ph = $('#ls-ph', this.view);
    ph.hidden = false;
    ph.innerHTML = `<div class="ls-native">
        <div class="now-logo big">${imgTag(ch.icon, '', 'data-hide-broken')}<b>${esc(initials(ch.name))}</b></div>
        <h3>${esc(ch.name)}</h3>
        <p class="muted">${window.native?.isTv ? 'İzlemek için OK · favorilere eklemek için sağdaki ★' : 'İzlemek için kanala dokun'}</p>
        <div class="ls-native-acts">
          <button class="btn btn-primary btn-sm" data-ls="full">${icon('play')}<span class="btn-label">Tam ekran izle</span></button>
          <button class="btn btn-glass btn-sm ls-fav-btn ${Library.isChFav(ch) ? 'on' : ''}" data-ls="fav">${icon('star')}<span class="btn-label">${Library.isChFav(ch) ? 'Favori listeleri' : 'Favorilere ekle'}</span></button>
        </div>
      </div>`;
  },

  playDebounced: debounce(function (ch) {
    if (!Live.engine || Live.current !== ch) return;
    const api = App.api;
    const urls = { hls: api.outputFormat === 'm3u8' ? api.liveUrl(ch.id, 'm3u8') : null, ts: api.liveUrl(ch.id, 'ts') };
    Live.engine.load({ live: true, urls });
  }, 250),

  updateFavBtn() {
    if (this.native && this.current && !$('#ls-ph', this.view).hidden) this.paintNativeStage(this.current);
    const b = $('#ls-fav', this.view);
    if (!b || !this.current) return;
    const on = Library.isChFav(this.current);
    b.classList.toggle('on', on);
    b.title = on ? 'Favori listelerini düzenle' : 'Favori listesine ekle';
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
        if (this.current) FavPicker.open(this.current, { onChange: () => this.refreshFavs() });
        break;
      case 'full': this.openFull(); break;
      case 'retry': if (this.current) this.select(this.current); break;
      case 'resume-last': {
        const last = Library.lastChannel();
        if (last) {
          this.select(this.channels.find((c) => c.id === last.id) || reg(last), { play: !this.native });
          if (this.native) this.openFull();
        }
        break;
      }
      case 'external':
        if (this.current) {
          Player.getExternalPlayers().then(async (players) => {
            const url = App.api.liveUrl(this.current.id, 'ts');
            if (!players.length) {
              if (window.native) await window.native.copy(url);
              toast('Harici oynatıcı bulunamadı — yayın bağlantısı panoya kopyalandı');
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

  // Masaüstü klavye kısayolları (odak bir düğme / alandayken devreye girmez; TV'de kumanda gezinmesi yönetir)
  onKey(e) {
    if (!this.view || Spatial.enabled || e.target.matches('input, select, textarea')) return false;
    // Enter, odaktaki düğmenin kendi işini yapsın (★, yeni liste…); yalnızca kanal satırında tam ekran açar
    if (e.key === 'Enter' && e.target.matches('button, a, [tabindex]') && !e.target.matches('.ch-item')) return false;
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
