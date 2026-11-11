/* Video motoru: HLS (hls.js), MPEG-TS (mpegts.js) ve doğrudan dosya oynatma.
   Aynı anda yalnızca tek akış açık kalır (çoğu IPTV hesabı tek bağlantıya izin verir). */

const LANG_NAMES = {
  tr: 'Türkçe', tur: 'Türkçe', turkish: 'Türkçe', en: 'İngilizce', eng: 'İngilizce', english: 'İngilizce',
  de: 'Almanca', ger: 'Almanca', deu: 'Almanca', fr: 'Fransızca', fre: 'Fransızca', fra: 'Fransızca',
  es: 'İspanyolca', spa: 'İspanyolca', it: 'İtalyanca', ita: 'İtalyanca', ar: 'Arapça', ara: 'Arapça',
  ru: 'Rusça', rus: 'Rusça', ja: 'Japonca', jpn: 'Japonca', ko: 'Korece', kor: 'Korece', nl: 'Felemenkçe', dut: 'Felemenkçe', nld: 'Felemenkçe',
  pt: 'Portekizce', por: 'Portekizce', pl: 'Lehçe', pol: 'Lehçe', fa: 'Farsça', per: 'Farsça', und: 'Belirsiz',
};

// SRT → WebVTT dönüştürücü
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + String(srt)
    .replace(/^\uFEFF/, '')
    .replace(/\r+/g, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/^\d+\n(?=\d{2}:\d{2})/gm, '')
    .trim() + '\n';
}

const Engines = {
  active: new Set(),
  stopAll(except) {
    for (const e of [...this.active]) if (e !== except) e.stop();
  },
};

class StreamEngine {
  constructor(video) {
    this.video = video;
    this.hls = null;
    this.ts = null;
    this.onError = () => {};
    this.onStatus = () => {};
    this.token = 0;
    this._stall = null;
    video.addEventListener('error', () => {
      if (this.mode === 'direct' && video.src) this.fail(this.describeMediaError(video.error));
    });
    for (const ev of ['waiting', 'stalled']) video.addEventListener(ev, () => this.onStatus('loading'));
    for (const ev of ['playing', 'canplay']) video.addEventListener(ev, () => this.onStatus('ready'));
  }

  describeMediaError(err) {
    if (!err) return 'Bilinmeyen oynatma hatası.';
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
      this.playDirect(opts.urls.direct, opts.startAt || 0);
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

  playDirect(url, startAt) {
    this.mode = 'direct';
    this.video.src = url;
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

  /* ---------- İzler: video / ses / altyazı ----------
     Her liste { id, label, on } döndürür. id = -2 → "Kapalı", id = -1 → "Otomatik" (HLS kalite). */

  trackLabel(name, lang, fallback) {
    let n = String(name || '').trim();
    // "SoundHandler", "Track 1" gibi anlamsız adları at
    if (/handler$/i.test(n) || /^(track|sound|audio|video|subtitle)?\s*\d*$/i.test(n)) n = '';
    const l = String(lang || '').trim();
    const langName = l ? (LANG_NAMES[l.toLowerCase()] || l) : '';
    if (n && langName && normText(n) !== normText(langName)) return `${n} - [${langName}]`;
    if (!n && langName) return `${fallback} - [${langName}]`;
    return n || fallback;
  }

  videoTracks() {
    const off = !!this.videoHidden;
    let list = [];
    if (this.hls && this.hls.levels?.length) {
      const lv = this.hls.levels;
      if (lv.length > 1) list.push({ id: -1, label: 'Otomatik kalite', on: !off && this.hls.autoLevelEnabled });
      list.push(...lv.map((l, i) => ({
        id: i,
        label: [l.height ? `${l.height}p` : l.name || `Video ${i + 1}`, l.bitrate ? `${(l.bitrate / 1e6).toFixed(1)} Mbps` : '', l.videoCodec || ''].filter(Boolean).join(' · '),
        on: !off && (lv.length === 1 || (!this.hls.autoLevelEnabled && this.hls.currentLevel === i)),
      })));
    } else if (this.video.videoTracks && this.video.videoTracks.length) {
      list = Array.from(this.video.videoTracks).map((t, i) => ({ id: i, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`), on: !off && t.selected }));
    } else {
      const v = this.video;
      list = [{ id: 0, label: v.videoWidth ? `${v.videoHeight}p (${v.videoWidth}×${v.videoHeight})` : 'Varsayılan video', on: !off }];
    }
    return [{ id: -2, label: 'Kapalı (yalnızca ses)', on: off }, ...list];
  }

  setVideoTrack(id) {
    this.videoHidden = id === -2;
    this.video.style.visibility = this.videoHidden ? 'hidden' : '';
    if (id === -2) return;
    if (this.hls && this.hls.levels?.length) {
      this.hls.currentLevel = id; // -1 = otomatik
    } else if (this.video.videoTracks && this.video.videoTracks.length) {
      const vt = this.video.videoTracks;
      if (vt[id]) vt[id].selected = true;
    }
  }

  audioTracks() {
    const off = this.video.muted && this.audioOff;
    let list = [];
    if (this.hls && this.hls.audioTracks?.length) {
      list = this.hls.audioTracks.map((t, i) => ({ id: i, label: this.trackLabel(t.name, t.lang, `İz ${i + 1}`), on: !off && i === this.hls.audioTrack }));
    } else if (this.video.audioTracks && this.video.audioTracks.length) {
      list = Array.from(this.video.audioTracks).map((t, i) => ({ id: i, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`), on: !off && t.enabled }));
    } else {
      list = [{ id: 0, label: 'Varsayılan ses', on: !off }];
    }
    return [{ id: -2, label: 'Kapalı', on: !!off }, ...list];
  }

  setAudioTrack(id) {
    if (id === -2) { this.audioOff = true; this.video.muted = true; return; }
    if (this.audioOff) { this.audioOff = false; this.video.muted = false; }
    if (this.hls && this.hls.audioTracks?.length) { this.hls.audioTrack = id; return; }
    const at = this.video.audioTracks;
    if (at && at.length) Array.from(at).forEach((t, i) => (t.enabled = i === id));
  }

  textTracks() {
    const list = [];
    if (this.hls && this.hls.subtitleTracks?.length) {
      this.hls.subtitleTracks.forEach((t, i) => list.push({ id: `h${i}`, label: this.trackLabel(t.name, t.lang, `İz ${i + 1}`), on: this.hls.subtitleDisplay && i === this.hls.subtitleTrack }));
    }
    const tt = this.video.textTracks;
    if (tt && tt.length) {
      Array.from(tt).forEach((t, i) => {
        if (t.kind !== 'subtitles' && t.kind !== 'captions') return;
        // hls.js'in kendi oluşturduğu izleri tekrar listeleme
        if (this.hls && this.hls.subtitleTracks?.length && !t.vzExternal) return;
        list.push({ id: `t${i}`, label: this.trackLabel(t.label, t.language, `İz ${i + 1}`) + (t.vzExternal ? ' (dosya)' : ''), on: t.mode === 'showing' });
      });
    }
    return [{ id: 'off', label: 'Kapalı', on: !list.some((x) => x.on) }, ...list];
  }

  setTextTrack(id) {
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
        if (String(id).startsWith('h') && !t.vzExternal) return; // hls.js yönetir
        t.mode = id === `t${i}` ? 'showing' : 'disabled';
      });
    }
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
    const idx = this.video.textTracks.length - 1;
    const t = this.video.textTracks[idx];
    t.vzExternal = true;
    if (this.hls) this.hls.subtitleDisplay = false;
    Array.from(this.video.textTracks).forEach((x, i) => (x.mode = i === idx ? 'showing' : 'disabled'));
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
    this.destroyLibs();
    const v = this.video;
    try { v.pause(); } catch {}
    v.removeAttribute('src');
    try { v.load(); } catch {}
    this.mode = null;
    this.clearExternalTracks();
    this.videoHidden = false;
    v.style.visibility = '';
    if (this.audioOff) { this.audioOff = false; v.muted = Settings.muted; }
    Engines.active.delete(this);
  }
}
