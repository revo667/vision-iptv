/* Video motoru: HLS (hls.js), MPEG-TS (mpegts.js) ve doğrudan dosya oynatma.
   Aynı anda yalnızca tek akış açık kalır (çoğu IPTV hesabı tek bağlantıya izin verir).
   Masaüstünde film/dizi akışı ana süreçteki vekilden geçer: böylece dosyadaki tüm izler
   (Chromium'un çalamadığı AC3/DTS dahil) listelenir ve gömülü yazı altyazıları okunur. */

const LANG_NAMES = {
  tr: 'Türkçe', tur: 'Türkçe', turkish: 'Türkçe', en: 'İngilizce', eng: 'İngilizce', english: 'İngilizce',
  de: 'Almanca', ger: 'Almanca', deu: 'Almanca', fr: 'Fransızca', fre: 'Fransızca', fra: 'Fransızca',
  es: 'İspanyolca', spa: 'İspanyolca', it: 'İtalyanca', ita: 'İtalyanca', ar: 'Arapça', ara: 'Arapça',
  ru: 'Rusça', rus: 'Rusça', ja: 'Japonca', jpn: 'Japonca', ko: 'Korece', kor: 'Korece', nl: 'Felemenkçe', dut: 'Felemenkçe', nld: 'Felemenkçe',
  pt: 'Portekizce', por: 'Portekizce', pl: 'Lehçe', pol: 'Lehçe', fa: 'Farsça', per: 'Farsça', und: 'Belirsiz',
};

// Dil kodlarını karşılaştırmak için ortak biçim: "tur" / "tr-TR" → "tr"
const LANG_2 = { tur: 'tr', eng: 'en', ger: 'de', deu: 'de', fre: 'fr', fra: 'fr', spa: 'es', ita: 'it', ara: 'ar', rus: 'ru', jpn: 'ja', kor: 'ko', dut: 'nl', nld: 'nl', por: 'pt', pol: 'pl', per: 'fa', fas: 'fa' };
function normLang(code) {
  const c = String(code || '').toLowerCase().split(/[-_]/)[0];
  return LANG_2[c] || c;
}

function channelLabel(n) {
  return { 1: 'Mono', 2: '2.0', 3: '2.1', 6: '5.1', 7: '6.1', 8: '7.1' }[n] || (n ? `${n} kanal` : '');
}

// SRT → WebVTT dönüştürücü
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt)
    .replace(/^﻿/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n(?=\d{2}:\d{2})/gm, '')
    .trim() + '\n';
}

const Engines = {
  active: new Set(),
  all: new Set(),
  listening: false,
  stopAll(except) {
    for (const e of [...this.active]) if (e !== except) e.stop();
  },
  // Ana süreçten gelen iz / altyazı olayları
  listen() {
    if (this.listening || !window.native?.onMediaEvent) return;
    this.listening = true;
    window.native.onMediaEvent((ev) => {
      for (const e of this.all) if (e.media && e.media.id === ev.id) e.onMediaEvent(ev);
    });
  },
};

class StreamEngine {
  constructor(video) {
    this.video = video;
    this.hls = null;
    this.ts = null;
    this.media = null; // { id, tracks, subs: Map(izIndex → TextTrack) }
    this.onError = () => {};
    this.onStatus = () => {};
    this.token = 0;
    this._stall = null;
    Engines.all.add(this);
    Engines.listen();
    video.addEventListener('error', () => {
      if (this.mode !== 'direct' || !video.src) return;
      // Vekil hiç veri alamadıysa doğrudan bağlantıyla bir kez daha dene
      if (this.media && !this.media.tracks && !this.retriedDirect) {
        this.retriedDirect = true;
        this.closeMedia();
        this.setSrc(this.directUrl, this.opts?.startAt || 0);
        return;
      }
      this.fail(this.describeMediaError(video.error));
    });
    video.addEventListener('loadedmetadata', () => this.applyPrefs());
    for (const ev of ['waiting', 'stalled']) video.addEventListener(ev, () => this.onStatus('loading'));
    for (const ev of ['playing', 'canplay']) video.addEventListener(ev, () => this.onStatus('ready'));
  }

  describeMediaError(err) {
    if (!err) return 'Bilinmeyen oynatma hatası.';
    const vid = this.probe('video').find((t) => !t.supported);
    if (err.code === 4 && vid) return `Bu dosyanın video kodeki (${vid.codec}) uygulama içinde desteklenmiyor.`;
    if (err.code === 4) return 'Bu dosya formatı veya video kodeki uygulama içinde desteklenmiyor (ör. MKV/HEVC/AC3).';
    if (err.code === 2) return 'Ağ hatası: akış sunucudan alınamadı.';
    if (err.code === 3) return 'Video çözümlenirken hata oluştu.';
    return 'Oynatma hatası.';
  }

  /**
   * opts: { live: bool, urls: { hls, ts, direct }, startAt }
   */
  async load(opts) {
    Engines.stopAll(this);
    this.stop();
    Engines.active.add(this);
    const token = ++this.token;
    this.opts = opts;
    this.onStatus('loading');
    if (opts.live) {
      const order = [];
      if (opts.urls.hls) order.push(['hls', opts.urls.hls]);
      if (opts.urls.ts) order.push(['ts', opts.urls.ts]);
      this.tryChain(order, token);
    } else {
      this.playDirect(opts.urls.direct, opts.startAt || 0, token);
    }
  }

  tryChain(order, token, lastErr) {
    if (token !== this.token) return;
    const step = order.shift();
    if (!step) return this.fail(lastErr || 'Kanal yayını açılamadı. Kanal şu an kapalı olabilir.');
    const [kind, url] = step;
    const fallback = (err) => {
      if (token !== this.token) return;
      this.destroyLibs();
      this.tryChain(order, token, err);
    };
    if (kind === 'hls') this.playHls(url, fallback);
    else this.playTs(url, fallback);
  }

  playHls(url, fallback) {
    this.mode = 'hls';
    if (window.Hls && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 30,
        liveSyncDurationCount: 3,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
        fragLoadingMaxRetry: 4,
      });
      this.hls = hls;
      let mediaRecovered = false;
      let started = false;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (!started) return fallback('HLS akışı açılamadı.');
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
          mediaRecovered = true;
          hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          setTimeout(() => this.hls === hls && hls.startLoad(), 1500);
        } else {
          fallback('Yayın akışı kesildi.');
        }
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        started = true;
        this.video.play().catch(() => {});
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => this.onStatus('tracks'));
      hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, () => this.onStatus('tracks'));
      hls.loadSource(url);
      hls.attachMedia(this.video);
    } else if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.mode = 'direct-hls';
      this.video.src = url;
      const onErr = () => { this.video.removeEventListener('error', onErr); fallback('HLS desteklenmiyor.'); };
      this.video.addEventListener('error', onErr, { once: true });
      this.video.play().catch(() => {});
    } else {
      fallback('HLS desteklenmiyor.');
    }
  }

  playTs(url, fallback) {
    this.mode = 'ts';
    if (!window.mpegts || !mpegts.getFeatureList().mseLivePlayback) return fallback('MPEG-TS desteklenmiyor.');
    const p = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url },
      {
        enableWorker: true,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 6,
        liveBufferLatencyMinRemain: 1.5,
        autoCleanupSourceBuffer: true,
      }
    );
    this.ts = p;
    let started = false;
    p.on(mpegts.Events.ERROR, (type, detail) => {
      if (!started) return fallback(`Yayın açılamadı (${detail || type}).`);
      // Canlı yayında kopma olursa yeniden bağlan
      this.retryTimer = setTimeout(() => {
        if (this.ts === p) this.load(this.opts);
      }, 2000);
    });
    p.on(mpegts.Events.MEDIA_INFO, () => { started = true; });
    p.attachMediaElement(this.video);
    p.load();
    const pr = p.play();
    if (pr && pr.catch) pr.catch(() => {});
    this.video.addEventListener('playing', () => { started = true; }, { once: true });
  }

  async playDirect(url, startAt, token) {
    this.mode = 'direct';
    this.directUrl = url;
    let src = url;
    if (window.native?.mediaOpen) {
      try {
        const r = await window.native.mediaOpen(url);
        if (token !== this.token) { if (r) window.native.mediaClose(r.id); return; }
        if (r) {
          this.media = { id: r.id, tracks: null, subs: new Map() };
          src = r.src;
        }
      } catch {}
    }
    if (token !== this.token) return;
    this.setSrc(src, startAt);
  }

  setSrc(src, startAt) {
    this.video.src = src;
    if (startAt > 0) {
      const seek = () => {
        try { this.video.currentTime = startAt; } catch {}
      };
      this.video.addEventListener('loadedmetadata', seek, { once: true });
    }
    this.video.play().catch(() => {});
  }

  fail(msg) {
    this.onStatus('error');
    this.onError(msg);
  }

  /* ---------- Vekilden gelen bilgiler ---------- */
  onMediaEvent(ev) {
    const m = this.media;
    if (ev.type === 'tracks') {
      m.tracks = ev.tracks;
      this.setupEmbeddedSubs();
      this.applyPrefs();
      this.onStatus('tracks');
      this.onStatus('probe');
    } else if (ev.type === 'cues') {
      for (const [index, start, end, text] of ev.cues) {
        const t = m.subs.get(index);
        if (!t) continue;
        try { t.addCue(new VTTCue(start, end, text)); } catch {}
      }
    }
  }

  // Dosyadaki izler (vekil bilgisi varsa); yoksa boş liste
  probe(type) {
    const list = this.media?.tracks;
    return list ? list.filter((t) => t.type === type) : [];
  }

  // Yalnızca çalınamayan ses izleri mi var? (ör. tek AC3 izi → sessiz oynatma)
  get audioUnplayable() {
    const a = this.probe('audio');
    return a.length > 0 && a.every((t) => !t.supported) ? a : null;
  }

  // addTextTrack ile oluşturulan izler silinemez; aynı video öğesinde tekrar kullanmak için havuz
  subPool(n) {
    const pool = this.video.vzPool || (this.video.vzPool = []);
    while (pool.length <= n) {
      const t = this.video.addTextTrack('subtitles', '', '');
      t.mode = 'disabled';
      t.vzPooled = true;
      pool.push(t);
    }
    return pool[n];
  }

  resetPool() {
    for (const t of this.video.vzPool || []) {
      t.mode = 'hidden';
      for (const c of Array.from(t.cues || [])) t.removeCue(c);
      t.mode = 'disabled';
      t.vzEmbedded = null;
    }
  }

  setupEmbeddedSubs() {
    const m = this.media;
    let k = 0;
    this.probe('sub').forEach((t, i) => {
      if (!t.text) return;
      const tt = this.subPool(k++);
      tt.vzEmbedded = { index: t.index, lang: t.lang, label: this.describe(t, i) };
      m.subs.set(t.index, tt);
    });
  }

  closeMedia() {
    if (this.media) {
      window.native?.mediaClose?.(this.media.id);
      this.media = null;
    }
    this.resetPool();
  }

  // Son seçilen ses / altyazı dilini otomatik uygula (dizide sonraki bölüm aynı dille açılır)
  applyPrefs() {
    if (this.prefsApplied || this.mode !== 'direct' || !this.media?.tracks || this.video.readyState < 1) return;
    this.prefsApplied = true;
    const al = Settings.audioLang;
    if (al) {
      const opts = this.audioTracks().filter((t) => typeof t.id === 'number' && t.id >= 0);
      const cur = opts.find((t) => t.on);
      const want = opts.find((t) => t.lang && normLang(t.lang) === al);
      if (want && cur && want.id !== cur.id) this.setAudioTrack(want.id);
    }
    const sl = Settings.subLang;
    if (sl && sl !== 'off') {
      const want = this.textTracks().find((t) => t.embedded && normLang(t.lang) === sl);
      if (want) this.setTextTrack(want.id);
    }
  }

  /* ---------- İzler: video / ses / altyazı ----------
     Her liste { id, label, on, unsupported?, lang? } döndürür.
     id = -2 → "Kapalı", id = -1 → "Otomatik" (HLS kalite), id = "x<n>" → uygulamada çalınamayan iz. */

  trackLabel(name, lang, fallback) {
    let n = String(name || '').trim();
    // "SoundHandler", "Track 1" gibi anlamsız adları at
    if (/handler$/i.test(n) || /^(track|sound|audio|video|subtitle)?\s*\d*$/i.test(n)) n = '';
    const l = String(lang || '').trim();
    const langName = l ? (LANG_NAMES[l.toLowerCase()] || LANG_NAMES[normLang(l)] || l) : '';
    if (n && langName && normText(n) !== normText(langName)) return `${n} - [${langName}]`;
    if (!n && langName) return `${fallback} - [${langName}]`;
    return n || fallback;
  }

  // Dosyadan okunan iz bilgisiyle zengin etiket: "Türkçe · AC3 5.1"
  describe(t, i) {
    const lang = t.lang && t.lang !== 'und' ? t.lang : '';
    const langName = lang ? LANG_NAMES[lang.toLowerCase()] || LANG_NAMES[normLang(lang)] || lang : '';
    const base = t.name ? this.trackLabel(t.name, lang, `İz ${i + 1}`) : langName || `İz ${i + 1}`;
    const extra = [
      t.codec,
      t.type === 'audio' ? channelLabel(t.channels) : '',
      t.type === 'video' && t.height ? `${t.height}p` : '',
      t.forced ? 'zorunlu' : '',
    ].filter(Boolean).join(' ');
    return extra ? `${base} · ${extra}` : base;
  }

  // Dosyadaki izleri Chromium'un çalabildiği izlerle eşle.
  // Chromium yalnızca desteklediği izleri, dosyadaki sırayla listeler.
  mapTracks(probe, native, isOn, off) {
    const playable = probe.filter((t) => t.supported);
    const unsupported = (t) => ({ id: `x${t.index}`, label: this.describe(t, probe.indexOf(t)), lang: t.lang, on: false, unsupported: true, codec: t.codec });
    if (native.length && playable.length !== native.length) {
      return [
        ...native.map((n, i) => ({ id: i, label: this.trackLabel(n.label, n.language, `İz ${i + 1}`), lang: n.language, on: !off && isOn(n) })),
        ...probe.filter((t) => !t.supported).map(unsupported),
      ];
    }
    return probe.map((t, i) => {
      const ni = playable.indexOf(t);
      if (ni < 0) return unsupported(t);
      const n = native[ni];
      return { id: ni, label: this.describe(t, i), lang: t.lang, on: !off && (n ? isOn(n) : ni === 0) };
    });
  }

  videoTracks() {
    const off = !!this.videoHidden;
    let list = [];
    const native = Array.from(this.video.videoTracks || []);
    const probe = this.probe('video');
    if (this.hls && this.hls.levels?.length) {
      const lv = this.hls.levels;
      if (lv.length > 1) list.push({ id: -1, label: 'Otomatik kalite', on: !off && this.hls.autoLevelEnabled });
      list.push(...lv.map((l, i) => ({
        id: i,
        label: [l.height ? `${l.height}p` : l.name || `Video ${i + 1}`, l.bitrate ? `${(l.bitrate / 1e6).toFixed(1)} Mbps` : '', l.videoCodec || ''].filter(Boolean).join(' · '),
        on: !off && (lv.length === 1 || (!this.hls.autoLevelEnabled && this.hls.currentLevel === i)),
      })));
    } else if (probe.length) {
      list = this.mapTracks(probe, native, (n) => n.selected, off);
    } else if (native.length) {
      list = native.map((t, i) => ({ id: i, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`), on: !off && t.selected }));
    } else {
      const v = this.video;
      list = [{ id: 0, label: v.videoWidth ? `${v.videoHeight}p (${v.videoWidth}×${v.videoHeight})` : 'Varsayılan video', on: !off }];
    }
    return [{ id: -2, label: 'Kapalı (yalnızca ses)', on: off }, ...list];
  }

  setVideoTrack(id) {
    if (String(id).startsWith('x')) return false;
    this.videoHidden = id === -2;
    this.video.style.visibility = this.videoHidden ? 'hidden' : '';
    if (id === -2) return true;
    if (this.hls && this.hls.levels?.length) {
      this.hls.currentLevel = id; // -1 = otomatik
    } else {
      const vt = this.video.videoTracks;
      if (vt && vt[id] && !vt[id].selected) {
        const playing = !this.video.paused;
        vt[id].selected = true;
        this.kick(playing);
      }
    }
    return true;
  }

  audioTracks() {
    const off = this.video.muted && this.audioOff;
    let list = [];
    const native = Array.from(this.video.audioTracks || []);
    const probe = this.probe('audio');
    if (this.hls && this.hls.audioTracks?.length) {
      list = this.hls.audioTracks.map((t, i) => ({ id: i, label: this.trackLabel(t.name, t.lang, `İz ${i + 1}`), lang: t.lang, on: !off && i === this.hls.audioTrack }));
    } else if (probe.length) {
      list = this.mapTracks(probe, native, (n) => n.enabled, off);
    } else if (native.length) {
      list = native.map((t, i) => ({ id: i, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`), lang: t.language, on: !off && t.enabled }));
    } else {
      list = [{ id: 0, label: 'Varsayılan ses', on: !off }];
    }
    return [{ id: -2, label: 'Kapalı', on: !!off }, ...list];
  }

  setAudioTrack(id) {
    if (String(id).startsWith('x')) return false;
    if (id === -2) { this.audioOff = true; this.video.muted = true; return true; }
    if (this.audioOff) { this.audioOff = false; this.video.muted = false; }
    if (this.hls && this.hls.audioTracks?.length) { this.hls.audioTrack = id; return true; }
    const at = Array.from(this.video.audioTracks || []);
    if (!at[id] || at[id].enabled) return true;
    const playing = !this.video.paused;
    // Önce yeni izi aç, sonra diğerlerini kapat: hiç iz açık kalmayan an MKV'de sesi kilitliyor
    at[id].enabled = true;
    setTimeout(() => {
      at.forEach((t, i) => { if (i !== id) t.enabled = false; });
      this.kick(playing);
    }, 60);
    return true;
  }

  // İz değişince Chromium çözücüyü yeniden başlatmıyor ve oynatmayı durdurabiliyor:
  // aynı konuma küçük bir arama yapıp kaldığı yerden devam ettir.
  kick(playing) {
    clearTimeout(this.kickTimer);
    this.kickTimer = setTimeout(() => {
      const v = this.video;
      if (this.mode !== 'direct' || !v.src) return;
      try { v.currentTime = v.currentTime; } catch {}
      if (playing) v.play().catch(() => {});
    }, 250);
  }

  textTracks() {
    const embedded = [];
    const files = [];
    if (this.hls && this.hls.subtitleTracks?.length) {
      this.hls.subtitleTracks.forEach((t, i) => embedded.push({ id: `h${i}`, label: this.trackLabel(t.name, t.lang, `İz ${i + 1}`), lang: t.lang, on: this.hls.subtitleDisplay && i === this.hls.subtitleTrack }));
    }
    const tt = this.video.textTracks;
    if (tt && tt.length) {
      Array.from(tt).forEach((t, i) => {
        if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
        if (t.vzPooled) {
          if (t.vzEmbedded) embedded.push({ id: `t${i}`, label: t.vzEmbedded.label, lang: t.vzEmbedded.lang, embedded: true, on: t.mode === 'showing' });
          return;
        }
        // hls.js'in kendi oluşturduğu izleri tekrar listeleme
        if (this.hls && this.hls.subtitleTracks?.length && !t.vzExternal) return;
        files.push({ id: `t${i}`, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`) + (t.vzExternal ? ' (dosya)' : ''), on: t.mode === 'showing' });
      });
    }
    // Görüntü tabanlı altyazılar (PGS / VobSub) uygulama içinde gösterilemez
    const image = this.probe('sub').filter((t) => !t.text).map((t) => ({ id: `x${t.index}`, label: this.describe(t, this.probe('sub').indexOf(t)), on: false, unsupported: true, codec: t.codec }));
    const list = [...embedded, ...files, ...image];
    return [{ id: 'off', label: 'Kapalı', on: !list.some((x) => x.on) }, ...list];
  }

  setTextTrack(id) {
    if (String(id).startsWith('x')) return false;
    const tt = this.video.textTracks;
    if (this.hls && this.hls.subtitleTracks?.length) {
      if (String(id).startsWith('h')) {
        this.hls.subtitleTrack = +id.slice(1);
        this.hls.subtitleDisplay = true;
      } else {
        this.hls.subtitleDisplay = false;
      }
    }
    if (tt) {
      Array.from(tt).forEach((t, i) => {
        if (String(id).startsWith('h') && !t.vzExternal && !t.vzPooled) return; // hls.js yönetir
        t.mode = id === `t${i}` ? 'showing' : 'disabled';
      });
    }
    return true;
  }

  // Kullanıcının seçtiği dili hatırla
  rememberAudio(id) {
    const t = this.audioTracks().find((x) => x.id === id);
    if (t && t.lang && t.lang !== 'und') Settings.audioLang = normLang(t.lang);
  }

  rememberSub(id) {
    if (id === 'off') { Settings.subLang = 'off'; return; }
    const t = this.textTracks().find((x) => x.id === id);
    if (t && t.embedded && t.lang && t.lang !== 'und') Settings.subLang = normLang(t.lang);
  }

  // Bilgisayardan .srt / .vtt altyazı dosyası ekle
  addSubtitleFile(text, name) {
    const vtt = /^\s*WEBVTT/.test(text) ? text : srtToVtt(text);
    const url = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
    const tr = document.createElement('track');
    tr.kind = 'subtitles';
    tr.label = name.replace(/\.(srt|vtt|txt)$/i, '');
    tr.srclang = 'tr';
    tr.src = url;
    tr.dataset.external = '1';
    this.video.appendChild(tr);
    const t = tr.track;
    t.vzExternal = true;
    if (this.hls) this.hls.subtitleDisplay = false;
    Array.from(this.video.textTracks).forEach((x) => (x.mode = x === t ? 'showing' : 'disabled'));
    return tr.label;
  }

  clearExternalTracks() {
    this.video.querySelectorAll('track[data-external]').forEach((t) => {
      URL.revokeObjectURL(t.src);
      t.remove();
    });
  }

  destroyLibs() {
    clearTimeout(this.retryTimer);
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
    if (this.ts) {
      try { this.ts.pause(); this.ts.unload(); this.ts.detachMediaElement(); this.ts.destroy(); } catch {}
      this.ts = null;
    }
  }

  stop() {
    this.token++;
    clearTimeout(this.kickTimer);
    this.destroyLibs();
    const v = this.video;
    try { v.pause(); } catch {}
    v.removeAttribute('src');
    try { v.load(); } catch {}
    this.closeMedia();
    this.mode = null;
    this.prefsApplied = false;
    this.retriedDirect = false;
    this.clearExternalTracks();
    this.videoHidden = false;
    v.style.visibility = '';
    if (this.audioOff) { this.audioOff = false; v.muted = Settings.muted; }
    Engines.active.delete(this);
  }
}
