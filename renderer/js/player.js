/* Tam ekran oynatıcı (film, dizi, canlı) */

const Player = {
  el: null,
  video: null,
  engine: null,
  session: null, // { kind, item, ... }
  hideTimer: null,
  saveTimer: 0,
  externalPlayers: null,

  init() {
    this.el = $('#player');
    this.video = $('#player-video');
    this.engine = new StreamEngine(this.video);
    this.engine.onError = (msg) => this.showError(msg);
    this.engine.onStatus = (s) => {
      if (s === 'tracks') this.refreshTracksMenu();
      if (s === 'probe') this.checkAudio();
      if (s === 'loading') this.el.classList.add('loading');
      if (s === 'ready' || s === 'error') this.el.classList.remove('loading');
    };

    // ikonlar
    $$('[data-p]', this.el).forEach((b) => {
      const map = { fav: 'star', close: 'back', play: 'play', back10: 'back10', fwd10: 'fwd10', 'prev-ch': 'chevUp', 'next-ch': 'chevDown', mute: 'volume', 'next-ep': 'next', channels: 'list', tracks: 'captions', speed: 'speed', external: 'external', pip: 'pip', fullscreen: 'maximize' };
      if (map[b.dataset.p]) b.innerHTML = icon(map[b.dataset.p]);
    });

    const v = this.video;
    v.volume = Settings.volume;
    v.muted = Settings.muted;
    $('#p-vol').value = v.muted ? 0 : v.volume;
    this.updateVolumeIcon();

    v.addEventListener('play', () => this.updatePlayIcon());
    v.addEventListener('pause', () => { this.updatePlayIcon(); this.showUi(); });
    v.addEventListener('timeupdate', () => this.onTime());
    v.addEventListener('progress', () => this.onTime());
    v.addEventListener('durationchange', () => this.onTime());
    v.addEventListener('ended', () => this.onEnded());
    v.addEventListener('volumechange', () => this.updateVolumeIcon());
    v.addEventListener('loadedmetadata', () => this.refreshTracksMenu());
    for (const ev of ['playing', 'pause', 'seeked', 'durationchange', 'ratechange']) {
      v.addEventListener(ev, () => this.updatePresence());
    }
    v.textTracks.addEventListener?.('addtrack', () => this.refreshTracksMenu());
    v.addEventListener('click', () => this.togglePlay());
    v.addEventListener('dblclick', () => this.toggleFullscreen());

    this.el.addEventListener('mousemove', () => this.showUi());
    this.el.addEventListener('click', (e) => this.onClick(e));

    $('#p-vol').addEventListener('input', (e) => {
      const val = +e.target.value;
      v.volume = val;
      v.muted = val === 0;
      Settings.volume = val || Settings.volume;
      Settings.muted = v.muted;
    });

    this.bindProgress();
    document.addEventListener('fullscreenchange', () => {
      $('#p-fs').innerHTML = icon(document.fullscreenElement ? 'minimize' : 'maximize');
    });
  },

  get isOpen() { return !this.el.hidden; },

  /* ---------- Açılış ---------- */
  open(session) {
    if (NativePlayer.available) return NativePlayer.open(session);
    this.closeMenus();
    $('#p-error').hidden = true;
    $('#p-next-card').hidden = true;
    $('#p-notice').hidden = true;
    clearInterval(this.nextTimer);
    this.session = session;
    this.el.hidden = false;
    this.el.classList.toggle('is-live', session.kind === 'live');
    this.el.classList.toggle('has-next', !!this.nextEpisode());
    this.el.classList.add('loading');
    $('#p-title').textContent = session.title || '';
    $('#p-sub').textContent = session.sub || '';
    $('#p-played').style.width = '0%';
    $('#p-buf').style.width = '0%';
    $('#p-time').textContent = '';
    this.showUi();
    this.engine.load(session.engineOpts);
    session.since = Date.now();
    if (session.kind === 'live') { this.loadLiveEpg(); this.updateFavIcon(); }
    this.updatePresence();
  },

  playMovie(movie, { resume = true } = {}) {
    const key = `movie:${movie.id}`;
    const prog = Library.getProgress(key);
    const startAt = resume && prog && !prog.done && prog.pos > 20 ? prog.pos - 3 : 0;
    const url = App.api.movieUrl(movie.id, movie.ext);
    this.open({
      kind: 'movie',
      item: movie,
      key,
      url,
      title: movie.name,
      sub: [movie.year, movie.genre].filter(Boolean).join(' • '),
      engineOpts: { live: false, urls: { direct: url }, startAt },
    });
  },

  // series: normalize edilmiş dizi; episodes: sıralı bölüm listesi; index: bölüm sırası
  playEpisode(series, episodes, index, { resume = true } = {}) {
    const ep = episodes[index];
    if (!ep) return;
    const key = `ep:${ep.id}`;
    const prog = Library.getProgress(key);
    const startAt = resume && prog && !prog.done && prog.pos > 20 ? prog.pos - 3 : 0;
    const url = App.api.episodeUrl(ep.id, ep.ext);
    this.open({
      kind: 'episode',
      item: series,
      episodes,
      index,
      ep,
      key,
      url,
      title: series.name,
      sub: `${ep.season}. Sezon ${ep.num}. Bölüm${ep.title ? ' — ' + ep.title : ''}`,
      engineOpts: { live: false, urls: { direct: url }, startAt },
    });
  },

  updateFavIcon() {
    const s = this.session;
    $('#p-fav').classList.toggle('on', !!(s && s.kind === 'live' && Library.isChFav(s.item)));
  },

  playLive(channel, list) {
    const api = App.api;
    const fmt = api.outputFormat;
    const urls = { hls: fmt === 'm3u8' ? api.liveUrl(channel.id, 'm3u8') : null, ts: api.liveUrl(channel.id, 'ts') };
    Library.setLastChannel(channel);
    this.open({
      kind: 'live',
      item: channel,
      list: list && list.length ? list : [channel],
      url: urls.hls || urls.ts,
      title: channel.name,
      sub: '',
      engineOpts: { live: true, urls },
    });
  },

  async loadLiveEpg() {
    const s = this.session;
    const epg = await App.api.shortEpg(s.item.id, 3);
    if (this.session !== s) return;
    const now = Date.now() / 1000;
    const cur = epg.find((e) => e.start <= now && e.end > now);
    const next = epg.find((e) => e.start > now);
    const parts = [];
    if (cur) { parts.push(`Şimdi: ${cur.title} (${hhmm(cur.start)}–${hhmm(cur.end)})`); s.epgNow = cur.title; this.updatePresence(); }
    if (next) parts.push(`Sonra: ${next.title} ${hhmm(next.start)}`);
    $('#p-sub').textContent = parts.join('   ·   ');
  },

  switchChannel(delta) {
    const s = this.session;
    if (!s || s.kind !== 'live') return;
    const idx = s.list.findIndex((c) => c.id === s.item.id);
    const n = s.list[(idx + delta + s.list.length) % s.list.length];
    if (n) {
      this.playLive(n, s.list);
      this.osd(icon(delta > 0 ? 'chevDown' : 'chevUp'), n.name);
    }
  },

  updatePresence() {
    const s = this.session;
    if (!s) return;
    let base;
    if (s.kind === 'movie') base = { title: s.item.name, state: s.item.year ? `Film · ${s.item.year}` : 'Film', image: s.item.icon };
    else if (s.kind === 'episode') base = { title: s.item.name, state: `${s.ep.season}. Sezon ${s.ep.num}. Bölüm${s.ep.title ? ' · ' + s.ep.title : ''}`, image: s.item.icon };
    else base = { title: s.item.name, state: s.epgNow ? s.epgNow : 'Canlı TV', image: s.item.icon, live: true, since: s.since };
    Presence.fromVideo(this.video, base);
  },

  /* ---------- Kapanış ---------- */
  close() {
    if (!this.isOpen) return;
    this.saveProgress(true);
    this.engine.stop();
    clearInterval(this.nextTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {});
    this.el.hidden = true;
    $('#p-notice').hidden = true;
    this.closeMenus();
    Presence.clear();
    const s = this.session;
    this.session = null;
    document.dispatchEvent(new CustomEvent('player-closed', { detail: s }));
  },

  /* ---------- İlerleme ---------- */
  onTime() {
    const v = this.video;
    const s = this.session;
    if (!s) return;
    if (s.kind === 'live') {
      $('#p-time').textContent = '';
      return;
    }
    const d = v.duration;
    if (isFinite(d) && d > 0) {
      const pct = (v.currentTime / d) * 100;
      if (!this.dragging) {
        $('#p-played').style.width = pct + '%';
        $('#p-knob').style.left = pct + '%';
      }
      let buf = 0;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime + 1) buf = Math.max(buf, v.buffered.end(i));
      }
      $('#p-buf').style.width = (buf / d) * 100 + '%';
      $('#p-time').textContent = `${fmtTime(v.currentTime)} / ${fmtTime(d)}`;
    } else {
      $('#p-time').textContent = fmtTime(v.currentTime);
    }
    const now = Date.now();
    if (now - this.saveTimer > 5000) {
      this.saveTimer = now;
      this.saveProgress(false);
    }
  },

  saveProgress(final) {
    const s = this.session;
    const v = this.video;
    if (!s || s.kind === 'live') return;
    const pos = v.currentTime || 0;
    const dur = isFinite(v.duration) ? v.duration : 0;
    if (pos < 5 || !dur) return;
    const done = dur > 0 && pos / dur > 0.94;
    if (s.kind === 'movie') {
      const m = s.item;
      Library.saveProgress(s.key, { type: 'movie', id: m.id, name: m.name, icon: m.icon, ext: m.ext, year: m.year, pos, dur, done });
    } else {
      const ser = s.item;
      Library.saveProgress(s.key, { pos, dur, done });
      const next = done ? this.nextEpisode() : null;
      const ep = next || s.ep;
      Library.saveProgress(`series:${ser.id}`, {
        type: 'series', id: ser.id, name: ser.name, icon: ser.icon,
        epId: ep.id, season: ep.season, epNum: ep.num, epTitle: ep.title, ext: ep.ext,
        pos: next ? 0 : pos, dur: next ? 0 : dur, next: !!next, done: done && !next,
      });
    }
    if (final) document.dispatchEvent(new CustomEvent('library-change'));
  },

  nextEpisode() {
    const s = this.session;
    if (!s || s.kind !== 'episode') return null;
    return s.episodes[s.index + 1] || null;
  },

  onEnded() {
    const s = this.session;
    if (!s) return;
    this.saveProgress(true);
    const next = this.nextEpisode();
    if (s.kind === 'episode' && next) {
      const card = $('#p-next-card');
      card.innerHTML = `
        <small>Sıradaki bölüm</small>
        <h4>${next.season}. Sezon ${next.num}. Bölüm${next.title ? ' — ' + esc(next.title) : ''}</h4>
        <div class="acts">
          <button class="btn btn-light btn-sm count" data-p="next-ep">${icon('play')}<span class="btn-label">Şimdi oynat</span><i></i></button>
          <button class="btn btn-ghost btn-sm" data-p="cancel-next">İptal</button>
        </div>`;
      card.hidden = false;
      this.showUi();
      clearTimeout(this.nextTimer);
      this.nextTimer = setTimeout(() => {
        if (!card.hidden && this.session === s) this.playEpisode(s.item, s.episodes, s.index + 1, { resume: false });
      }, 8000);
    } else if (s.kind === 'movie') {
      setTimeout(() => this.session === s && this.close(), 1200);
    }
  },

  /* ---------- Kontroller ---------- */
  onClick(e) {
    const b = e.target.closest('[data-p]');
    if (!b) {
      if (!e.target.closest('.p-menu, .p-drawer')) this.closeMenus();
      return;
    }
    e.stopPropagation();
    const v = this.video;
    switch (b.dataset.p) {
      case 'close': this.close(); break;
      case 'play': this.togglePlay(); break;
      case 'back10': this.seekBy(-10); break;
      case 'fwd10': this.seekBy(10); break;
      case 'prev-ch': this.switchChannel(-1); break;
      case 'next-ch': this.switchChannel(1); break;
      case 'mute': v.muted = !v.muted; Settings.muted = v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; break;
      case 'next-ep': {
        const s = this.session;
        clearTimeout(this.nextTimer);
        if (s && this.nextEpisode()) { this.saveProgress(true); this.playEpisode(s.item, s.episodes, s.index + 1, { resume: false }); }
        break;
      }
      case 'cancel-next': clearTimeout(this.nextTimer); $('#p-next-card').hidden = true; break;
      case 'channels': this.toggleDrawer(); break;
      case 'fav':
        if (this.session?.kind === 'live') {
          this.video.paused || this.showUi();
          FavPicker.open(this.session.item, { onChange: () => this.updateFavIcon() });
        }
        break;
      case 'tracks': this.toggleMenu('tracks', b); break;
      case 'speed': this.toggleMenu('speed', b); break;
      case 'external': this.toggleMenu('external', b); break;
      case 'pip': this.togglePip(); break;
      case 'fullscreen': this.toggleFullscreen(); break;
      case 'retry': $('#p-error').hidden = true; this.open(this.session); break;
      case 'copy': this.copyLink(); break;
      case 'open-ext': this.openExternal(b.dataset.player); break;
      case 'set-speed': v.playbackRate = +b.dataset.v; this.closeMenus(); this.osd(icon('speed'), `${b.dataset.v}x`); break;
      case 'set-video': {
        const id = /^x/.test(b.dataset.v) ? b.dataset.v : +b.dataset.v;
        if (!this.engine.setVideoTrack(id)) this.unsupportedTrack(b);
        this.refreshTracksMenu();
        break;
      }
      case 'set-audio': {
        const id = /^x/.test(b.dataset.v) ? b.dataset.v : +b.dataset.v;
        if (this.engine.setAudioTrack(id)) this.engine.rememberAudio(id);
        else this.unsupportedTrack(b);
        setTimeout(() => this.refreshTracksMenu(), 120);
        break;
      }
      case 'set-sub':
        if (this.engine.setTextTrack(b.dataset.v)) this.engine.rememberSub(b.dataset.v);
        else this.unsupportedTrack(b);
        this.refreshTracksMenu();
        break;
      case 'dismiss-notice': $('#p-notice').hidden = true; break;
      case 'load-sub': this.pickSubtitleFile(); break;
      case 'pick-ch': {
        const s = this.session;
        const ch = s.list.find((c) => String(c.id) === b.dataset.id);
        if (ch) this.playLive(ch, s.list);
        break;
      }
    }
  },

  togglePlay() {
    const v = this.video;
    if (this.session?.kind === 'live' && v.paused) {
      // Canlıda duraklatıp devam edince yayının gerisinde kalmasın
      this.engine.load(this.session.engineOpts);
      return;
    }
    if (v.paused) { v.play().catch(() => {}); this.osd(icon('play')); }
    else { v.pause(); this.osd(icon('pause')); }
  },

  seekBy(sec) {
    const v = this.video;
    if (!isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration - 1, v.currentTime + sec));
    this.osd(icon(sec < 0 ? 'back10' : 'fwd10'), sec < 0 ? `-${-sec} sn` : `+${sec} sn`);
    this.showUi();
  },

  changeVolume(d) {
    const v = this.video;
    v.muted = false;
    v.volume = Math.max(0, Math.min(1, +(v.volume + d).toFixed(2)));
    Settings.volume = v.volume;
    Settings.muted = false;
    $('#p-vol').value = v.volume;
    this.osd(icon(v.volume === 0 ? 'mute' : 'volume'), `%${Math.round(v.volume * 100)}`);
  },

  updatePlayIcon() { $('#p-play').innerHTML = icon(this.video.paused ? 'play' : 'pause'); },
  updateVolumeIcon() {
    const v = this.video;
    $('#p-mute').innerHTML = icon(v.muted || v.volume === 0 ? 'mute' : v.volume < 0.5 ? 'volumeLow' : 'volume');
    if (document.activeElement !== $('#p-vol')) $('#p-vol').value = v.muted ? 0 : v.volume;
    $('#p-vol').style.setProperty('--v', (v.muted ? 0 : v.volume) * 100 + '%');
  },

  toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else this.el.requestFullscreen().catch(() => {});
  },

  async togglePip() {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await this.video.requestPictureInPicture();
    } catch {
      toast('Resim içinde resim bu yayında kullanılamıyor.');
    }
  },

  bindProgress() {
    const bar = $('#p-progress');
    const tip = $('#p-hover-time');
    const pctAt = (e) => {
      const r = bar.getBoundingClientRect();
      return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    };
    bar.addEventListener('mousemove', (e) => {
      const d = this.video.duration;
      if (!isFinite(d)) return;
      const p = pctAt(e);
      tip.textContent = fmtTime(p * d);
      tip.style.left = p * 100 + '%';
    });
    bar.addEventListener('pointerdown', (e) => {
      const d = this.video.duration;
      if (!isFinite(d)) return;
      this.dragging = true;
      bar.classList.add('dragging');
      bar.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const p = pctAt(ev);
        $('#p-played').style.width = p * 100 + '%';
        $('#p-knob').style.left = p * 100 + '%';
        tip.textContent = fmtTime(p * d);
        tip.style.left = p * 100 + '%';
      };
      move(e);
      const up = (ev) => {
        this.dragging = false;
        bar.classList.remove('dragging');
        bar.removeEventListener('pointermove', move);
        bar.removeEventListener('pointerup', up);
        this.video.currentTime = pctAt(ev) * d;
      };
      bar.addEventListener('pointermove', move);
      bar.addEventListener('pointerup', up);
    });
  },

  showUi() {
    this.el.classList.remove('hide-ui');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      const menusOpen = !$('#p-menu').hidden || !$('#p-drawer').hidden || !$('#p-error').hidden;
      if (!this.video.paused && !menusOpen && !$('.p-bottom', this.el).matches(':hover')) this.el.classList.add('hide-ui');
    }, 3200);
  },

  osd(iconHtml, text = '') {
    const o = $('#p-osd');
    o.innerHTML = iconHtml + (text ? `<span>${esc(text)}</span>` : '');
    o.classList.add('show');
    clearTimeout(this.osdTimer);
    this.osdTimer = setTimeout(() => o.classList.remove('show'), 700);
  },

  /* ---------- Menüler ---------- */
  closeMenus() {
    $('#p-menu').hidden = true;
    $('#p-drawer').hidden = true;
  },

  async toggleMenu(kind, btn) {
    const m = $('#p-menu');
    if (!m.hidden && m.dataset.kind === kind) { m.hidden = true; return; }
    $('#p-drawer').hidden = true;
    m.dataset.kind = kind;
    let html = '';
    const item = (act, v, label, on) =>
      `<button class="menu-item ${on ? 'on' : ''}" data-p="${act}" data-v="${v}"><span class="chk">${on ? icon('check') : ''}</span>${esc(label)}</button>`;
    if (kind === 'speed') {
      html = '<h5>Oynatma hızı</h5>' + [0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => item('set-speed', r, r === 1 ? 'Normal' : `${r}x`, this.video.playbackRate === r)).join('');
    } else if (kind === 'tracks') {
      html = this.tracksMenuHtml();
    } else if (kind === 'external') {
      html = '<h5>Harici oynatıcı</h5>' + (await this.externalMenuHtml());
    }
    m.innerHTML = html;
    m.hidden = false;
    this.showUi();
  },

  tracksMenuHtml() {
    const radio = (act, t) => `
      <button class="track-opt ${t.on ? 'on' : ''} ${t.unsupported ? 'unsupported' : ''}" data-p="${act}" data-v="${esc(t.id)}" data-codec="${esc(t.codec || '')}">
        <span class="radio"></span><span class="track-label">${esc(t.label)}</span>${t.unsupported ? '<small class="track-tag">çalınamaz</small>' : ''}
      </button>`;
    const section = (ic, title, act, list, extra = '') => `
      <div class="track-sec">
        <div class="track-head">${icon(ic)}<span>${title}</span><small>${Math.max(0, list.length - 1)}</small></div>
        ${list.map((t) => radio(act, t)).join('')}${extra}
      </div>`;
    const subs = this.engine.textTracks();
    const video = this.engine.videoTracks();
    const audio = this.engine.audioTracks();
    const blocked = [...video, ...audio, ...subs].some((t) => t.unsupported);
    const ext = this.isAndroid ? 'başka bir oynatıcıyla' : window.native?.os === 'win32' ? 'VLC veya PotPlayer ile' : 'IINA veya VLC ile';
    return `<div class="tracks-menu">
      ${section('film', 'Video İzleri', 'set-video', video)}
      ${section('music', 'Ses İzleri', 'set-audio', audio)}
      ${section('captions', 'Altyazı İzleri', 'set-sub', subs,
        `<button class="track-opt add" data-p="load-sub">${icon('plus')}<span class="track-label">Dosyadan altyazı yükle (.srt / .vtt)</span></button>`)}
      ${blocked ? `<div class="track-note">“Çalınamaz” işaretli izler (AC3/DTS ses, PGS görüntü altyazı gibi) uygulama içinde oynatılamıyor; ${ext} açarak seçebilirsin.</div>` : ''}
    </div>`;
  },

  get isAndroid() { return window.native?.platform === 'android'; },

  // Çalınamayan bir iz seçildi: nedenini söyle ve harici oynatıcı öner
  async unsupportedTrack(btn) {
    const codec = btn.dataset.codec || 'bu format';
    const players = await this.getExternalPlayers();
    const names = players.map((p) => p.name).join(' veya ');
    toast(`${codec} uygulama içinde oynatılamıyor${names ? ` — ${names} ile açabilirsin` : ''}`, 4200);
  },

  // Dosyadaki tüm ses izleri çalınamıyorsa (ör. yalnızca AC3) video sessiz oynar: uyar
  async checkAudio() {
    const bad = this.engine.audioUnplayable;
    const box = $('#p-notice');
    if (!bad || !this.session || this.session.kind === 'live') { box.hidden = true; return; }
    const codecs = [...new Set(bad.map((t) => t.codec))].join(' / ');
    const players = await this.getExternalPlayers();
    box.innerHTML = `
      <div class="p-notice-text">${icon('mute')}<div><b>Ses çalınamıyor</b><span>Bu içeriğin sesi ${esc(codecs)} formatında; uygulama içinde oynatılamıyor.</span></div></div>
      <div class="acts">
        ${players.map((p) => `<button class="btn btn-primary btn-sm" data-p="open-ext" data-player="${p.id}">${icon('external')}<span class="btn-label">${esc(p.name)} ile aç</span></button>`).join('')}
        <button class="btn btn-ghost btn-sm" data-p="dismiss-notice">Kapat</button>
      </div>`;
    box.hidden = false;
    this.showUi();
  },

  refreshTracksMenu() {
    const m = $('#p-menu');
    if (m.hidden || m.dataset.kind !== 'tracks') return;
    const top = m.scrollTop;
    m.innerHTML = this.tracksMenuHtml();
    m.scrollTop = top;
  },

  pickSubtitleFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.srt,.vtt,.txt';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      let text = await f.text();
      // Türkçe karakterler bozuk geldiyse Windows-1254 olarak tekrar dene
      if (text.includes('\uFFFD')) {
        try { text = new TextDecoder('windows-1254').decode(await f.arrayBuffer()); } catch {}
      }
      const label = this.engine.addSubtitleFile(text, f.name);
      toast(`Altyazı yüklendi: ${label}`);
      this.refreshTracksMenu();
    };
    inp.click();
  },

  async getExternalPlayers() {
    if (!this.externalPlayers) this.externalPlayers = window.native ? await window.native.listPlayers() : [];
    return this.externalPlayers;
  },

  async externalMenuHtml() {
    const players = await this.getExternalPlayers();
    let html = players.map((p) => `<button class="menu-item" data-p="open-ext" data-player="${p.id}">${icon('external')}${esc(p.name)} ile aç</button>`).join('');
    html += `<button class="menu-item" data-p="copy">${icon('copy')}Yayın bağlantısını kopyala</button>`;
    if (!players.length) html += `<div class="menu-item" style="font-size:12.5px;color:var(--text-3)">${window.native?.os === 'win32' ? 'VLC veya PotPlayer' : 'IINA veya VLC'} kurarsan buradan tek tıkla açabilirsin.</div>`;
    return html;
  },

  async openExternal(id) {
    const url = this.session?.url;
    if (!url || !window.native) return;
    this.saveProgress(true);
    this.engine.stop(); // tek bağlantı sınırı için kendi akışımızı kapatıyoruz
    const ok = await window.native.openInPlayer(id, url);
    toast(ok ? 'Harici oynatıcıda açıldı' : 'Harici oynatıcı açılamadı');
    this.close();
  },

  async copyLink() {
    const url = this.session?.url;
    if (!url) return;
    if (window.native) await window.native.copy(url);
    else await navigator.clipboard.writeText(url).catch(() => {});
    this.closeMenus();
    toast('Bağlantı panoya kopyalandı');
  },

  toggleDrawer() {
    const d = $('#p-drawer');
    if (!d.hidden) { d.hidden = true; return; }
    $('#p-menu').hidden = true;
    const s = this.session;
    d.innerHTML = `
      <div class="p-drawer-head"><h3>Kanallar</h3><button class="icon-btn" data-p="channels">${icon('close')}</button></div>
      <div style="padding:0 16px 12px"><input class="filter-input" style="width:100%" placeholder="Kanal ara" id="p-ch-filter"></div>
      <div class="live-scroll" id="p-ch-list"></div>`;
    const render = (q = '') => {
      const nq = normText(q);
      const list = s.list.filter((c) => !nq || normText(c.name).includes(nq)).slice(0, 400);
      $('#p-ch-list').innerHTML = list.map((c) => `
        <button class="ch-item ${c.id === s.item.id ? 'active' : ''}" data-p="pick-ch" data-id="${c.id}">
          <span class="ch-num">${esc(c.num ?? '')}</span>
          <span class="ch-logo">${imgTag(c.icon, '', 'data-hide-broken')}<b>${esc(initials(c.name))}</b></span>
          <span class="ch-text"><div>${esc(c.name)}</div></span><span></span>
        </button>`).join('');
    };
    render();
    d.hidden = false;
    const f = $('#p-ch-filter');
    f.addEventListener('input', debounce(() => render(f.value), 150));
    $('#p-ch-list .active')?.scrollIntoView({ block: 'center' });
  },

  showError(msg) {
    const s = this.session;
    const box = $('#p-error');
    const isVod = s && s.kind !== 'live';
    box.innerHTML = `
      <div class="p-error-box">
        ${icon('alert')}
        <h3>${isVod ? 'Bu içerik uygulama içinde oynatılamadı' : 'Kanal açılamadı'}</h3>
        <p>${esc(msg)}</p>
        <div class="acts" id="p-error-acts">
          <button class="btn btn-light btn-sm" data-p="retry">${icon('refresh')}<span class="btn-label">Tekrar dene</span></button>
          <button class="btn btn-ghost btn-sm" data-p="close">Geri dön</button>
        </div>
        <small>${isVod ? `İpucu: MKV, HEVC (H.265) veya AC3 sesli dosyalar için ücretsiz ${window.native?.os === 'win32' ? 'VLC ya da PotPlayer' : 'IINA ya da VLC'} kullanabilirsin.` : 'Kanal sağlayıcı tarafında geçici olarak kapalı olabilir.'}</small>
      </div>`;
    box.hidden = false;
    this.el.classList.remove('loading');
    this.showUi();
    this.getExternalPlayers().then((players) => {
      const acts = $('#p-error-acts');
      if (!acts) return;
      players.forEach((p) => acts.insertAdjacentHTML('afterbegin', `<button class="btn btn-primary btn-sm" data-p="open-ext" data-player="${p.id}">${icon('external')}<span class="btn-label">${esc(p.name)} ile aç</span></button>`));
      acts.insertAdjacentHTML('beforeend', `<button class="btn btn-ghost btn-sm" data-p="copy">${icon('copy')}<span class="btn-label">Bağlantıyı kopyala</span></button>`);
    });
  },

  onKey(e) {
    if (!this.isOpen) return false;
    if (e.target.matches('input[type=text], input:not([type])')) {
      if (e.key === 'Escape') { this.closeMenus(); return true; }
      return false;
    }
    const live = this.session?.kind === 'live';
    switch (e.key) {
      case ' ': case 'k': case 'K': this.togglePlay(); break;
      case 'ArrowLeft': if (!live) this.seekBy(-10); break;
      case 'ArrowRight': if (!live) this.seekBy(10); break;
      case 'ArrowUp': live ? this.switchChannel(-1) : this.changeVolume(0.05); break;
      case 'ArrowDown': live ? this.switchChannel(1) : this.changeVolume(-0.05); break;
      case 'm': case 'M': this.video.muted = !this.video.muted; Settings.muted = this.video.muted; break;
      case 'f': case 'F': this.toggleFullscreen(); break;
      case 'Escape':
        if (!$('#p-menu').hidden || !$('#p-drawer').hidden) this.closeMenus();
        else if (!document.fullscreenElement) this.close();
        break;
      default: return false;
    }
    this.showUi();
    return true;
  },
};

/* Android: film, dizi ve canlı yayın cihazın oynatıcısında (Media3 / ExoPlayer) açılır.
   İlerleme, sıradaki bölüm, kanal değişimi ve dil tercihleri buraya olay olarak gelir. */
const NativePlayer = {
  session: null,

  get available() { return !!window.native?.play; },

  init() {
    if (!this.available) return;
    window.native.on((ev) => { if (ev.type === 'player') this.onEvent(ev); });
  },

  epLabel(ep) {
    return `${ep.season}. Sezon ${ep.num}. Bölüm${ep.title ? ' — ' + ep.title : ''}`;
  },

  open(s) {
    const api = App.api;
    const opts = { kind: s.kind, audioLang: Settings.audioLang || '', subLang: Settings.subLang || '' };
    if (s.kind === 'live') {
      const list = s.list && s.list.length ? s.list : [s.item];
      s.list = list;
      opts.channels = list.map((c) => ({ id: c.id, name: c.name, num: c.num ?? '', urls: api.liveFormats.map((f) => api.liveUrl(c.id, f)) }));
      opts.index = Math.max(0, list.findIndex((c) => String(c.id) === String(s.item.id)));
    } else if (s.kind === 'movie') {
      opts.items = [{ key: s.key, url: s.url, title: s.title, sub: s.sub, startAt: s.engineOpts.startAt || 0 }];
      opts.index = 0;
    } else {
      opts.items = s.episodes.map((ep, i) => ({
        key: `ep:${ep.id}`, url: api.episodeUrl(ep.id, ep.ext), title: s.item.name, sub: this.epLabel(ep),
        startAt: i === s.index ? s.engineOpts.startAt || 0 : 0,
      }));
      opts.index = s.index;
    }
    this.session = s;
    window.native.play(opts);
    if (s.kind === 'live') this.sendEpg(s.item);
  },

  async sendEpg(ch) {
    const epg = await App.api.shortEpg(ch.id, 3).catch(() => []);
    const now = Date.now() / 1000;
    const cur = epg.find((e) => e.start <= now && e.end > now);
    const next = epg.find((e) => e.start > now);
    const parts = [];
    if (cur) parts.push(`Şimdi: ${cur.title} (${hhmm(cur.start)}–${hhmm(cur.end)})`);
    if (next) parts.push(`Sonra: ${next.title} ${hhmm(next.start)}`);
    if (parts.length) window.native.updatePlayer({ id: ch.id, sub: parts.join('   ·   ') });
  },

  onEvent(ev) {
    const s = this.session;
    if (!s) return;
    if (ev.ev === 'progress') {
      this.saveProgress(s, ev);
    } else if (ev.ev === 'item' && s.kind === 'episode') {
      s.index = ev.index;
    } else if (ev.ev === 'channel' && s.kind === 'live') {
      const ch = s.list[ev.index];
      if (ch && ch !== s.item) {
        s.item = ch;
        Library.setLastChannel({ ...ch, cat: Library.lastChannel()?.cat ?? ch.cat });
        this.sendEpg(ch);
      }
    } else if (ev.ev === 'closed') {
      if (ev.audioLang) Settings.audioLang = normLang(ev.audioLang);
      if (ev.subLang) Settings.subLang = ev.subLang === 'off' ? 'off' : normLang(ev.subLang);
      this.session = null;
      document.dispatchEvent(new CustomEvent('library-change'));
      document.dispatchEvent(new CustomEvent('player-closed', { detail: s }));
    }
  },

  saveProgress(s, ev) {
    const pos = +ev.pos || 0;
    const dur = +ev.dur || 0;
    if (pos < 5 || !dur) return;
    const done = !!ev.done || pos / dur > 0.94;
    if (s.kind === 'movie') {
      const m = s.item;
      Library.saveProgress(s.key, { type: 'movie', id: m.id, name: m.name, icon: m.icon, ext: m.ext, year: m.year, pos, dur, done });
    } else if (s.kind === 'episode') {
      const i = typeof ev.index === 'number' ? ev.index : s.index;
      const ep = s.episodes[i];
      if (!ep) return;
      const ser = s.item;
      Library.saveProgress(`ep:${ep.id}`, { pos, dur, done });
      const next = done ? s.episodes[i + 1] : null;
      const cur = next || ep;
      Library.saveProgress(`series:${ser.id}`, {
        type: 'series', id: ser.id, name: ser.name, icon: ser.icon,
        epId: cur.id, season: cur.season, epNum: cur.num, epTitle: cur.title, ext: cur.ext,
        pos: next ? 0 : pos, dur: next ? 0 : dur, next: !!next, done: done && !next,
      });
    }
  },
};
