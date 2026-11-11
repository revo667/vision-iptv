/* Xtream Codes API istemcisi */

function normalizeServer(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

// M3U / get.php linki yapıştırılırsa bilgileri ayıkla
function parseM3uLink(input) {
  try {
    const u = new URL(String(input).trim());
    const username = u.searchParams.get('username');
    const password = u.searchParams.get('password');
    if (username && password) return { server: u.origin, username, password };
  } catch {}
  return null;
}

class XtreamError extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

class Xtream {
  constructor({ server, username, password }) {
    this.server = normalizeServer(server);
    this.username = username;
    this.password = password;
    this.cache = new Map();
    this.info = null;
  }

  get id() {
    return `${this.username}@${this.server.replace(/^https?:\/\//, '')}`;
  }

  url(params = {}) {
    const u = new URL(this.server + '/player_api.php');
    u.searchParams.set('username', this.username);
    u.searchParams.set('password', this.password);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
    }
    return u.toString();
  }

  async fetchJson(params, timeout = 30000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(this.url(params), { signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
      throw new XtreamError(e.name === 'AbortError'
        ? 'Sunucu yanıt vermedi (zaman aşımı).'
        : 'Sunucuya bağlanılamadı. Adresi ve internet bağlantını kontrol et.', 'network');
    } finally {
      clearTimeout(t);
    }
    if (res.status === 401 || res.status === 403) throw new XtreamError('Kullanıcı adı veya şifre hatalı ya da hesap engellenmiş.', 'auth');
    if (!res.ok) throw new XtreamError(`Sunucu hatası (${res.status}).`, 'http');
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new XtreamError('Sunucudan geçersiz yanıt geldi. Adres doğru mu?', 'parse');
    }
  }

  call(action, params = {}, { cache = true } = {}) {
    const p = { action, ...params };
    const key = JSON.stringify(p);
    if (cache && this.cache.has(key)) return this.cache.get(key);
    const prom = this.fetchJson(p).catch((e) => { this.cache.delete(key); throw e; });
    if (cache) this.cache.set(key, prom);
    return prom;
  }

  clearCache() { this.cache.clear(); }

  async authenticate() {
    const data = await this.fetchJson({}, 20000);
    if (!data || !data.user_info) throw new XtreamError('Bu adres bir Xtream Codes sunucusu gibi görünmüyor.', 'parse');
    if (Number(data.user_info.auth) !== 1) throw new XtreamError('Kullanıcı adı veya şifre hatalı.', 'auth');
    const st = String(data.user_info.status || '').toLowerCase();
    if (st && st !== 'active') {
      throw new XtreamError(st === 'expired' ? 'Hesabının süresi dolmuş.' : `Hesap durumu: ${data.user_info.status}`, 'auth');
    }
    this.info = data;
    return data;
  }

  get outputFormat() {
    const f = this.info?.user_info?.allowed_output_formats || [];
    if (!f.length || f.includes('m3u8')) return 'm3u8';
    return f.includes('ts') ? 'ts' : f[0];
  }

  async list(action, params) {
    const r = await this.call(action, params);
    return Array.isArray(r) ? r : r && typeof r === 'object' ? Object.values(r) : [];
  }

  liveCategories() { return this.list('get_live_categories'); }
  vodCategories() { return this.list('get_vod_categories'); }
  seriesCategories() { return this.list('get_series_categories'); }

  async liveStreams(catId) { return (await this.list('get_live_streams', { category_id: catId })).map(normLive); }
  async vodStreams(catId) { return (await this.list('get_vod_streams', { category_id: catId })).map(normVod); }
  async seriesList(catId) { return (await this.list('get_series', { category_id: catId })).map(normSeries); }

  vodInfo(id) { return this.call('get_vod_info', { vod_id: id }); }
  seriesInfo(id) { return this.call('get_series_info', { series_id: id }); }

  async shortEpg(streamId, limit = 12) {
    const r = await this.call('get_short_epg', { stream_id: streamId, limit }, { cache: false }).catch(() => null);
    const list = r?.epg_listings || [];
    return list.map((e) => ({
      title: b64(e.title),
      desc: b64(e.description),
      start: +e.start_timestamp || Date.parse(e.start) / 1000,
      end: +e.stop_timestamp || Date.parse(e.end || e.stop) / 1000,
    })).filter((e) => e.start && e.end).sort((a, b) => a.start - b.start);
  }

  path(kind, id, ext) {
    return `${this.server}/${kind}/${encodeURIComponent(this.username)}/${encodeURIComponent(this.password)}/${id}.${ext}`;
  }
  liveUrl(id, ext = this.outputFormat) { return this.path('live', id, ext); }
  movieUrl(id, ext) { return this.path('movie', id, ext || 'mp4'); }
  episodeUrl(id, ext) { return this.path('series', id, ext || 'mp4'); }
}

function normVod(s) {
  return {
    type: 'movie',
    id: s.stream_id,
    name: cleanName(s.name),
    raw: s.name || '',
    icon: s.stream_icon || '',
    rating: parseFloat(s.rating) || (parseFloat(s.rating_5based) || 0) * 2,
    year: s.year || extractYear(s.name, s.releaseDate),
    ext: s.container_extension || 'mp4',
    added: +s.added || 0,
    cat: s.category_id,
  };
}

function normSeries(s) {
  const bd = Array.isArray(s.backdrop_path) ? s.backdrop_path[0] : s.backdrop_path;
  return {
    type: 'series',
    id: s.series_id,
    name: cleanName(s.name),
    raw: s.name || '',
    icon: s.cover || '',
    backdrop: bd || '',
    plot: s.plot || '',
    genre: s.genre || '',
    rating: parseFloat(s.rating) || (parseFloat(s.rating_5based) || 0) * 2,
    year: extractYear(s.releaseDate, s.release_date, s.name),
    added: +s.last_modified || 0,
    cat: s.category_id,
  };
}

function normLive(s) {
  return {
    type: 'live',
    id: s.stream_id,
    name: String(s.name || '').trim(),
    icon: s.stream_icon || '',
    num: s.num,
    cat: s.category_id,
    archive: +s.tv_archive === 1,
  };
}
