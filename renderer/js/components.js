/* Kartlar, satırlar, hero ve detay penceresi */

const Items = new Map(); // "type:id" → öğe
function reg(item) { Items.set(`${item.type}:${item.id}`, item); return item; }
function getItem(type, id) { return Items.get(`${type}:${id}`); }

/* ---------- Katalog yardımcıları ---------- */
const Catalog = {
  cats: {},
  async categories(type) {
    if (this.cats[type]) return this.cats[type];
    const api = App.api;
    const fn = { movie: 'vodCategories', series: 'seriesCategories', live: 'liveCategories' }[type];
    const list = await api[fn]().catch(() => []);
    this.cats[type] = list.map((c) => ({ id: String(c.category_id), name: String(c.category_name || '').trim(), adult: ADULT_RE.test(c.category_name || '') }));
    return this.cats[type];
  },
  async visibleCategories(type) {
    const cats = await this.categories(type);
    return Settings.hideAdult ? cats.filter((c) => !c.adult) : cats;
  },
  async items(type, catId) {
    const api = App.api;
    const list = type === 'movie' ? await api.vodStreams(catId) : type === 'series' ? await api.seriesList(catId) : await api.liveStreams(catId);
    list.forEach(reg);
    return list;
  },
  async all(type) {
    const list = await this.items(type);
    if (!Settings.hideAdult) return list;
    const cats = await this.categories(type);
    const adult = new Set(cats.filter((c) => c.adult).map((c) => c.id));
    return list.filter((x) => !adult.has(String(x.cat)));
  },
  reset() { this.cats = {}; },
};

function buildEpisodes(info) {
  const eps = [];
  let obj = info?.episodes || {};
  if (Array.isArray(obj)) {
    const o = {};
    obj.forEach((arr, i) => {
      if (Array.isArray(arr) && arr.length) o[arr[0]?.season ?? i + 1] = arr;
    });
    obj = o;
  }
  const seasons = Object.keys(obj).sort((a, b) => +a - +b);
  for (const s of seasons) {
    const list = (obj[s] || []).slice().sort((a, b) => (+a.episode_num || 0) - (+b.episode_num || 0));
    for (const e of list) {
      const num = +e.episode_num || 0;
      let title = String(e.title || '').replace(/^.*?S\d+\s*E\d+\s*[-–:|]?\s*/i, '').trim();
      if (!title || /^(episode|bölüm)\s*\d+$/i.test(title)) title = '';
      eps.push({
        id: e.id,
        season: +(e.season ?? s) || +s || 1,
        num,
        title,
        ext: e.container_extension || 'mp4',
        plot: e.info?.plot || e.info?.overview || '',
        img: e.info?.movie_image || e.info?.cover_big || '',
        dur: parseDuration(e.info),
      });
    }
  }
  return eps;
}

async function playSeriesEntry(entry) {
  try {
    const info = await App.api.seriesInfo(entry.id);
    const eps = buildEpisodes(info);
    let idx = eps.findIndex((e) => String(e.id) === String(entry.epId));
    if (idx < 0) idx = 0;
    const series = getItem('series', entry.id) || reg({ type: 'series', id: entry.id, name: entry.name, icon: entry.icon });
    Player.playEpisode(series, eps, idx, { resume: true });
  } catch (e) {
    toast(e.message || 'Dizi açılamadı');
  }
}

/* ---------- Kartlar ---------- */
const Card = {
  poster(item, { progress } = {}) {
    reg(item);
    const meta = [];
    if (item.rating) meta.push(`<span class="rating">${icon('star')}${(+item.rating).toFixed(1)}</span>`);
    if (item.year) meta.push(`<span>${esc(item.year)}</span>`);
    meta.push(`<span>${item.type === 'series' ? 'Dizi' : 'Film'}</span>`);
    return `
      <div class="card" tabindex="0" data-card="${item.type}" data-id="${esc(item.id)}">
        ${imgTag(item.icon)}
        <div class="card-fallback" style="${fallbackStyle(item.name)}">${esc(item.name)}</div>
        ${progress ? `<div class="card-progress"><i style="width:${progress}%"></i></div>` : ''}
        <div class="card-play" data-quick-play>${icon('play')}</div>
        <div class="card-info">
          <div class="card-name">${esc(item.name)}</div>
          <div class="card-meta">${meta.join('')}</div>
        </div>
      </div>`;
  },

  channel(ch) {
    reg(ch);
    return `
      <div class="card channel" tabindex="0" data-card="live" data-id="${esc(ch.id)}">
        ${imgTag(ch.icon)}
        <div class="card-fallback">${esc(initials(ch.name))}</div>
        <span class="live-dot">CANLI</span>
        <div class="ch-name">${esc(ch.name)}</div>
      </div>`;
  },

  continueCard(entry) {
    const pct = entry.dur ? Math.min(100, (entry.pos / entry.dur) * 100) : 0;
    const sub = entry.type === 'series'
      ? `${entry.next ? 'Sıradaki: ' : ''}S${entry.season}:B${entry.epNum}${entry.epTitle ? ' · ' + esc(entry.epTitle) : ''}`
      : entry.dur ? `${fmtDuration(entry.dur - entry.pos)} kaldı` : '';
    return `
      <div class="card" tabindex="0" data-card="continue" data-key="${entry.type}:${esc(entry.id)}">
        ${imgTag(entry.icon)}
        <div class="card-fallback" style="${fallbackStyle(entry.name)}">${esc(entry.name)}</div>
        <div class="card-progress"><i style="width:${pct}%"></i></div>
        <div class="card-play">${icon('play')}</div>
        <div class="card-info">
          <div class="card-name">${esc(entry.name)}</div>
          <div class="card-meta"><span>${sub}</span></div>
        </div>
      </div>`;
  },

  skeletons(n = 8, cls = '') {
    return Array.from({ length: n }, () => `<div class="card skeleton ${cls}"></div>`).join('');
  },
};

// Tüm kart tıklamaları tek yerden
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-card]');
  if (!card || card.classList.contains('skeleton')) return;
  const type = card.dataset.card;
  if (type === 'continue') {
    const [t, id] = card.dataset.key.split(':');
    const entry = Library.getProgress(`${t}:${id}`);
    if (!entry) return;
    if (t === 'movie') Player.playMovie(getItem('movie', id) || reg({ type: 'movie', id, name: entry.name, icon: entry.icon, ext: entry.ext, year: entry.year }));
    else playSeriesEntry(entry);
    return;
  }
  const item = getItem(type, card.dataset.id);
  if (!item) return;
  if (type === 'live') {
    const siblings = $$('[data-card="live"]', card.parentElement).map((c) => getItem('live', c.dataset.id)).filter(Boolean);
    Player.playLive(item, siblings);
    return;
  }
  if (e.target.closest('[data-quick-play]') && type === 'movie') {
    Player.playMovie(item);
    return;
  }
  Detail.open(item);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('[data-card]')) e.target.click();
});

/* ---------- Satırlar ---------- */
const rowObserver = new IntersectionObserver((entries) => {
  for (const en of entries) {
    if (en.isIntersecting) {
      rowObserver.unobserve(en.target);
      en.target._load?.();
    }
  }
}, { rootMargin: '400px 0px' });

const loadLimit = limiter(4);

/**
 * opts: { title, tag, kind: 'poster'|'channel'|'continue', load: async () => items, more: () => void, limit }
 */
function createRow(container, opts) {
  const row = h(`
    <section class="row">
      <div class="row-head">
        <h2 class="row-title">${esc(opts.title)}</h2>
        ${opts.tag ? `<span class="row-tag">${esc(opts.tag)}</span>` : ''}
        ${opts.more ? `<a class="row-more">Tümünü gör ${icon('chevRight')}</a>` : ''}
      </div>
      <div class="row-track-wrap">
        <button class="row-arrow left disabled" aria-label="Sola kaydır">${icon('chevLeft')}</button>
        <div class="row-track">${Card.skeletons(9, opts.kind === 'channel' ? 'channel' : '')}</div>
        <button class="row-arrow right" aria-label="Sağa kaydır">${icon('chevRight')}</button>
      </div>
    </section>`);
  container.appendChild(row);
  const track = $('.row-track', row);
  const left = $('.row-arrow.left', row);
  const right = $('.row-arrow.right', row);
  const updateArrows = () => {
    left.classList.toggle('disabled', track.scrollLeft < 10);
    right.classList.toggle('disabled', track.scrollLeft + track.clientWidth >= track.scrollWidth - 10);
  };
  left.onclick = () => track.scrollBy({ left: -track.clientWidth * 0.85 });
  right.onclick = () => track.scrollBy({ left: track.clientWidth * 0.85 });
  track.addEventListener('scroll', debounce(updateArrows, 60));
  if (opts.more) $('.row-more', row).onclick = opts.more;

  row._load = () => loadLimit(async () => {
    try {
      let items = await opts.load();
      if (!row.isConnected) return;
      if (!items || !items.length) { row.remove(); return; }
      items = items.slice(0, opts.limit || 40);
      const html = items.map((it) =>
        opts.kind === 'continue' ? Card.continueCard(it) : opts.kind === 'channel' ? Card.channel(it) : Card.poster(it)
      ).join('');
      track.innerHTML = html;
      updateArrows();
    } catch {
      row.remove();
    }
  });
  rowObserver.observe(row);
  return row;
}

/* ---------- Hero ---------- */
async function renderHero(el, candidates) {
  const pool = candidates.filter((x) => x.icon || x.backdrop).slice(0, 40);
  if (!pool.length) { el.remove(); return; }
  // Rastgele, tercihen arka planı olan
  const withBd = pool.filter((x) => x.backdrop);
  const pick = (withBd.length ? withBd : pool)[Math.floor(Math.random() * (withBd.length || pool.length))];
  let bd = pick.backdrop, plot = pick.plot || '', genre = pick.genre || '', dur = 0;
  if (pick.type === 'movie') {
    try {
      const info = (await App.api.vodInfo(pick.id))?.info || {};
      bd = (Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path) || bd;
      plot = info.plot || info.description || plot;
      genre = info.genre || genre;
      dur = parseDuration(info);
    } catch {}
  }
  if (!el.isConnected) return;
  el.classList.remove('skeleton');
  const meta = [];
  if (pick.rating) meta.push(`<span class="rating">${icon('star')}${(+pick.rating).toFixed(1)}</span>`);
  if (pick.year) meta.push(`<span>${esc(pick.year)}</span>`);
  if (dur) meta.push(`<span>${fmtDuration(dur)}</span>`);
  if (genre) meta.push(`<span>${esc(genre.split(/[,/]/).slice(0, 3).join(' · '))}</span>`);
  el.innerHTML = `
    <div class="hero-media ${bd ? '' : 'poster-only'}">
      ${bd ? imgTag(bd, '', 'loading="eager"') : imgTag(pick.icon, 'bg', 'loading="eager"') + imgTag(pick.icon, 'poster', 'loading="eager"')}
    </div>
    <div class="hero-content">
      <div class="hero-kicker"><b>V</b>${pick.type === 'series' ? 'Dizi' : 'Film'}</div>
      <h1 class="hero-title">${esc(pick.name)}</h1>
      <div class="hero-meta">${meta.join('')}</div>
      ${plot ? `<p class="hero-plot">${esc(plot)}</p>` : ''}
      <div class="hero-actions">
        <button class="btn btn-primary" data-hero="play">${icon('play')}<span class="btn-label">Oynat</span></button>
        <button class="btn btn-glass" data-hero="info">${icon('info')}<span class="btn-label">Daha Fazla Bilgi</span></button>
      </div>
    </div>`;
  $('[data-hero=play]', el).onclick = () => (pick.type === 'movie' ? Player.playMovie(pick) : Detail.open(pick, { autoplay: true }));
  $('[data-hero=info]', el).onclick = () => Detail.open(pick);
}

/* ---------- Detay penceresi ---------- */
const Detail = {
  item: null,

  async open(item, { autoplay = false } = {}) {
    this.item = item;
    const modal = $('#modal');
    const dlg = $('#modal-dialog');
    modal.classList.remove('closing');
    modal.hidden = false;
    modal.scrollTop = 0;
    dlg.innerHTML = `<button class="md-close" data-act="close-modal">${icon('close')}</button><div class="md-loading"><div class="spinner"></div></div>`;
    try {
      if (item.type === 'movie') await this.renderMovie(item);
      else await this.renderSeries(item, autoplay);
    } catch (e) {
      if (this.item !== item) return;
      dlg.innerHTML = `<button class="md-close" data-act="close-modal">${icon('close')}</button>
        <div class="empty">${icon('alert')}<h3>Bilgiler alınamadı</h3><p>${esc(e.message || '')}</p>
        ${item.type === 'movie' ? `<button class="btn btn-primary" id="md-play-anyway">${icon('play')}<span class="btn-label">Yine de oynat</span></button>` : ''}</div>`;
      $('#md-play-anyway')?.addEventListener('click', () => { this.close(); Player.playMovie(item); });
    }
  },

  close() {
    const modal = $('#modal');
    if (modal.hidden) return;
    modal.classList.add('closing');
    setTimeout(() => { modal.hidden = true; modal.classList.remove('closing'); $('#modal-dialog').innerHTML = ''; }, 190);
    this.item = null;
  },

  heroHtml(title, bd, poster, actionsHtml) {
    return `
      <button class="md-close" data-act="close-modal">${icon('close')}</button>
      <div class="md-hero ${bd ? '' : 'poster-only'}">
        ${bd ? imgTag(bd, 'bg', 'loading="eager"') : imgTag(poster, 'bg', 'loading="eager"') + imgTag(poster, 'poster', 'loading="eager"')}
        <div class="md-hero-content">
          <h2 class="md-title">${esc(title)}</h2>
          <div class="md-actions">${actionsHtml}</div>
        </div>
      </div>`;
  },

  favBtn(item) {
    const on = Library.isFav(item);
    return `<button class="round-btn ${on ? 'on' : ''}" data-md="fav" title="${on ? 'Listemden çıkar' : 'Listeme ekle'}">${icon(on ? 'check' : 'plus')}</button>`;
  },

  sideHtml(info) {
    const rows = [];
    const cast = info.cast || info.actors;
    if (cast) rows.push(`<div><b>Oyuncular: </b><span>${esc(String(cast).split(',').slice(0, 6).join(', '))}</span></div>`);
    if (info.director) rows.push(`<div><b>Yönetmen: </b><span>${esc(info.director)}</span></div>`);
    if (info.genre) rows.push(`<div><b>Türler: </b><span>${esc(info.genre)}</span></div>`);
    if (info.country) rows.push(`<div><b>Ülke: </b><span>${esc(info.country)}</span></div>`);
    return rows.join('');
  },

  metaHtml(item, info, dur) {
    const m = [];
    const rating = parseFloat(info.rating) || item.rating;
    if (rating) m.push(`<span class="rating">${icon('star')}${(+rating).toFixed(1)}</span>`);
    const year = extractYear(info.releasedate, info.release_date, info.releaseDate, info.year) || item.year;
    if (year) m.push(`<span>${esc(year)}</span>`);
    if (dur) m.push(`<span>${fmtDuration(dur)}</span>`);
    if (info.age || info.mpaa_rating) m.push(`<span class="badge">${esc(info.age || info.mpaa_rating)}</span>`);
    m.push('<span class="badge">HD</span>');
    return m.join('');
  },

  bindCommon(item) {
    const dlg = $('#modal-dialog');
    $('[data-md=fav]', dlg)?.addEventListener('click', (e) => {
      const on = Library.toggleFav(item);
      const b = e.currentTarget;
      b.classList.toggle('on', on);
      b.innerHTML = icon(on ? 'check' : 'plus');
      b.title = on ? 'Listemden çıkar' : 'Listeme ekle';
      toast(on ? 'Listene eklendi' : 'Listenden çıkarıldı');
    });
    $('[data-md=trailer]', dlg)?.addEventListener('click', (e) => {
      window.open(`https://www.youtube.com/watch?v=${encodeURIComponent(e.currentTarget.dataset.yt)}`, '_blank');
    });
  },

  async similarHtml(item) {
    if (!item.cat) return '';
    const list = (await Catalog.items(item.type, item.cat).catch(() => [])).filter((x) => x.id !== item.id);
    if (!list.length) return '';
    const pick = list.sort(() => Math.random() - 0.5).slice(0, 12);
    return `<div class="md-similar"><h3>Benzer içerikler</h3><div class="md-similar-grid">${pick.map((x) => Card.poster(x)).join('')}</div></div>`;
  },

  async renderMovie(item) {
    const data = await App.api.vodInfo(item.id);
    if (this.item !== item) return;
    const info = data?.info || {};
    if (data?.movie_data?.container_extension) item.ext = data.movie_data.container_extension;
    const bd = (Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path) || '';
    const poster = info.movie_image || info.cover_big || item.icon;
    const dur = parseDuration(info);
    const prog = Library.getProgress(`movie:${item.id}`);
    const canResume = prog && !prog.done && prog.pos > 20;
    item.genre = info.genre || item.genre;

    const actions = `
      <button class="btn btn-primary" data-md="play">${icon('play')}<span class="btn-label">${canResume ? 'Devam Et' : 'Oynat'}</span></button>
      ${canResume ? `<button class="btn btn-glass" data-md="restart">${icon('restart')}<span class="btn-label">Baştan başla</span></button>` : ''}
      ${this.favBtn(item)}
      ${info.youtube_trailer ? `<button class="round-btn" data-md="trailer" data-yt="${esc(info.youtube_trailer)}" title="Fragman">${icon('youtube')}</button>` : ''}`;

    const dlg = $('#modal-dialog');
    dlg.innerHTML = `
      ${this.heroHtml(item.name, bd, poster, actions)}
      <div class="md-body">
        <div>
          <div class="md-meta">${this.metaHtml(item, info, dur)}</div>
          <p class="md-plot">${esc(info.plot || info.description || 'Bu içerik için açıklama bulunmuyor.')}</p>
          ${canResume ? `<div class="md-resume"><div class="bar"><i style="width:${(prog.pos / prog.dur) * 100}%"></i></div>${fmtDuration(prog.dur - prog.pos)} kaldı</div>` : ''}
        </div>
        <div class="md-side">${this.sideHtml(info)}</div>
      </div>
      <div id="md-similar"></div>`;
    $('[data-md=play]', dlg).onclick = () => { this.close(); Player.playMovie(item, { resume: true }); };
    $('[data-md=restart]', dlg)?.addEventListener('click', () => { this.close(); Player.playMovie(item, { resume: false }); });
    this.bindCommon(item);
    this.similarHtml(item).then((html) => { if (this.item === item) $('#md-similar').innerHTML = html; });
  },

  async renderSeries(item, autoplay) {
    const data = await App.api.seriesInfo(item.id);
    if (this.item !== item) return;
    const info = data?.info || {};
    const eps = buildEpisodes(data);
    const bd = (Array.isArray(info.backdrop_path) ? info.backdrop_path[0] : info.backdrop_path) || item.backdrop || '';
    const poster = info.cover || item.icon;
    const seasons = [...new Set(eps.map((e) => e.season))];
    const entry = Library.getProgress(`series:${item.id}`);
    let curIdx = entry ? eps.findIndex((e) => String(e.id) === String(entry.epId)) : -1;
    const resume = curIdx >= 0;
    if (curIdx < 0) curIdx = 0;
    const cur = eps[curIdx];

    if (autoplay && cur) { this.close(); Player.playEpisode(item, eps, curIdx); return; }

    const playLabel = !cur ? 'Bölüm yok' : resume ? `Devam Et · S${cur.season}:B${cur.num}` : `Oynat · S${cur.season}:B${cur.num}`;
    const actions = `
      <button class="btn btn-primary" data-md="play" ${cur ? '' : 'disabled'}>${icon('play')}<span class="btn-label">${playLabel}</span></button>
      ${this.favBtn(item)}
      ${info.youtube_trailer ? `<button class="round-btn" data-md="trailer" data-yt="${esc(info.youtube_trailer)}" title="Fragman">${icon('youtube')}</button>` : ''}`;

    const dlg = $('#modal-dialog');
    dlg.innerHTML = `
      ${this.heroHtml(item.name, bd, poster, actions)}
      <div class="md-body">
        <div>
          <div class="md-meta">${this.metaHtml(item, info, 0)}<span>${seasons.length} Sezon</span><span>${eps.length} Bölüm</span></div>
          <p class="md-plot">${esc(info.plot || item.plot || 'Bu dizi için açıklama bulunmuyor.')}</p>
        </div>
        <div class="md-side">${this.sideHtml(info)}</div>
      </div>
      <div class="episodes">
        <div class="ep-head">
          <h3>Bölümler</h3>
          <div class="pills" id="season-pills">${seasons.map((s) => `<button class="pill ${s === (cur?.season ?? seasons[0]) ? 'active' : ''}" data-season="${s}">${s}. Sezon</button>`).join('')}</div>
        </div>
        <div id="ep-list"></div>
      </div>
      <div id="md-similar"></div>`;

    const renderEps = (season) => {
      const list = eps.map((e, i) => ({ e, i })).filter(({ e }) => e.season === season);
      $('#ep-list').innerHTML = list.map(({ e, i }) => {
        const p = Library.getProgress(`ep:${e.id}`);
        const pct = p ? (p.done ? 100 : p.dur ? (p.pos / p.dur) * 100 : 0) : 0;
        return `
          <div class="ep ${i === curIdx && resume ? 'current' : ''}" data-ep="${i}">
            <div class="ep-num">${e.num}</div>
            <div class="ep-thumb">
              ${imgTag(e.img || bd || poster)}
              <div class="ep-play"><span>${icon('play')}</span></div>
              ${pct ? `<div class="card-progress"><i style="width:${pct}%"></i></div>` : ''}
            </div>
            <div>
              <div class="ep-title"><span>${esc(e.title || `${e.num}. Bölüm`)}</span><small>${e.dur ? fmtDuration(e.dur) : ''}</small></div>
              <div class="ep-plot">${esc(e.plot)}</div>
            </div>
          </div>`;
      }).join('') || '<div class="empty"><p>Bu sezonda bölüm bulunamadı.</p></div>';
    };
    renderEps(cur?.season ?? seasons[0]);

    $('#season-pills').onclick = (e) => {
      const b = e.target.closest('[data-season]');
      if (!b) return;
      $$('#season-pills .pill').forEach((x) => x.classList.toggle('active', x === b));
      renderEps(+b.dataset.season);
    };
    $('#ep-list').onclick = (e) => {
      const r = e.target.closest('[data-ep]');
      if (!r) return;
      this.close();
      Player.playEpisode(item, eps, +r.dataset.ep);
    };
    $('[data-md=play]', dlg).onclick = () => { if (cur) { this.close(); Player.playEpisode(item, eps, curIdx); } };
    this.bindCommon(item);
    this.similarHtml(item).then((html) => { if (this.item === item) $('#md-similar').innerHTML = html; });
  },
};
