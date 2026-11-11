/* Sayfalar: Ana sayfa, Filmler, Diziler, Kategori, Listem, Arama */

const TYPE_LABEL = { movie: 'Film', series: 'Dizi', live: 'Canlı' };

const Views = {
  async home(view) {
    view.innerHTML = `<section class="hero skeleton" id="hero"><div class="hero-media"></div></section><div class="rows" id="rows"></div>`;
    const rows = $('#rows', view);

    const libRows = () => [
      { title: 'İzlemeye Devam Et', kind: 'continue', load: async () => Library.continueList() },
      { title: 'Listem', load: async () => Library.favList().filter((x) => x.type !== 'live').map(reg), more: () => App.go('mylist') },
    ];
    const libAnchor = h('<div class="lib-rows"></div>');
    rows.appendChild(libAnchor);
    libRows().forEach((o) => createRow(libAnchor, o));
    Views.refreshLibraryRows = () => {
      if (!libAnchor.isConnected) return;
      libAnchor.innerHTML = '';
      libRows().forEach((o) => createRow(libAnchor, o));
    };

    const [vc, sc, lc] = await Promise.all([
      Catalog.visibleCategories('movie'),
      Catalog.visibleCategories('series'),
      Catalog.visibleCategories('live'),
    ]);
    if (!view.isConnected) return;

    // Hero: ilk film ve dizi kategorilerinden seç
    (async () => {
      const pools = await Promise.all([
        vc[0] ? Catalog.items('movie', vc[0].id).catch(() => []) : [],
        sc[0] ? Catalog.items('series', sc[0].id).catch(() => []) : [],
      ]);
      const hero = $('#hero', view);
      if (hero) renderHero(hero, [...pools[1].filter((x) => x.backdrop), ...pools[0]]);
    })();

    const max = Math.max(vc.length, sc.length);
    let liveIdx = 0;
    for (let i = 0; i < max; i++) {
      if (vc[i]) createRow(rows, rowForCategory('movie', vc[i]));
      if (sc[i]) createRow(rows, rowForCategory('series', sc[i]));
      if (i % 3 === 1 && lc[liveIdx]) createRow(rows, rowForCategory('live', lc[liveIdx++]));
    }
    if (!max && !lc.length) rows.insertAdjacentHTML('beforeend', emptyHtml('film', 'İçerik bulunamadı', 'Hesabında görüntülenecek film veya dizi yok.'));
  },

  async catalogPage(view, type) {
    const title = type === 'movie' ? 'Filmler' : 'Diziler';
    view.innerHTML = `
      <section class="hero skeleton" id="hero"><div class="hero-media"></div></section>
      <div class="rows" id="rows">
        <div class="page-head floating">
          <h1 class="page-title">${title}</h1>
          <label class="select">${icon('chevDown')}<select id="cat-select"><option value="">Tüm kategoriler</option></select></label>
        </div>
      </div>`;
    const cats = await Catalog.pageCategories(type);
    if (!view.isConnected) return;
    const sel = $('#cat-select', view);
    sel.insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${esc(c.type)}:${esc(c.id)}">${esc(c.name)}</option>`).join(''));
    sel.onchange = () => {
      const c = cats.find((x) => `${x.type}:${x.id}` === sel.value);
      if (c) App.go('category', { type: c.type, id: c.id, name: c.name, from: type });
    };
    const rows = $('#rows', view);
    if (!cats.length) {
      rows.insertAdjacentHTML('beforeend', emptyHtml('film', 'Kategori bulunamadı', 'Bu bölümde içerik yok.'));
      $('#hero', view).remove();
      return;
    }
    Catalog.items(cats[0].type, cats[0].id).then((items) => {
      const hero = $('#hero', view);
      if (hero) renderHero(hero, type === 'series' ? [...items.filter((x) => x.backdrop), ...items] : items);
    }).catch(() => $('#hero', view)?.remove());
    for (const c of cats) createRow(rows, rowForCategory(c.type, c, { tag: false, page: type }));
  },

  movies(view) { return Views.catalogPage(view, 'movie'); },
  series(view) { return Views.catalogPage(view, 'series'); },

  async category(view, { type, id, name, from }) {
    const back = from || type;
    view.innerHTML = `
      <div class="page-top">
        <div class="page-head">
          <a class="back-link" id="back">${icon('chevLeft')}${back === 'movie' ? 'Filmler' : back === 'series' ? 'Diziler' : 'Canlı TV'}</a>
        </div>
        <div class="page-head">
          <h1 class="page-title">${esc(name)}</h1>
          <span class="page-sub" id="count"></span>
          <div class="spacer"></div>
          <input class="filter-input" id="filter" placeholder="Bu kategoride ara" spellcheck="false">
          <label class="select">${icon('chevDown')}<select id="sort">
            <option value="default">Varsayılan sıra</option>
            <option value="new">En yeni eklenen</option>
            <option value="az">A → Z</option>
            <option value="rating">En yüksek puan</option>
          </select></label>
        </div>
        <div id="grid-wrap"><div class="center-load"><div class="spinner"></div></div></div>
      </div>`;
    $('#back', view).onclick = () => App.go(back === 'movie' ? 'movies' : back === 'series' ? 'series' : 'live');
    let items;
    try {
      items = await Catalog.items(type, id);
    } catch (e) {
      $('#grid-wrap', view).innerHTML = emptyHtml('alert', 'Yüklenemedi', e.message);
      return;
    }
    if (!view.isConnected) return;
    const render = () => {
      const q = normText($('#filter', view).value);
      let list = q ? items.filter((x) => normText(x.name).includes(q)) : items.slice();
      const s = $('#sort', view).value;
      if (s === 'new') list.sort((a, b) => b.added - a.added);
      if (s === 'az') list.sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      if (s === 'rating') list.sort((a, b) => (b.rating || 0) - (a.rating || 0));
      $('#count', view).textContent = `${list.length} içerik`;
      renderGrid($('#grid-wrap', view), list, type === 'live' ? 'channel' : 'poster');
    };
    $('#filter', view).addEventListener('input', debounce(render, 200));
    $('#sort', view).onchange = render;
    render();
  },

  mylist(view) {
    const movies = Library.favList('movie').map(reg);
    const series = Library.favList('series').map(reg);
    const live = Library.favList('live').map(reg);
    view.innerHTML = `<div class="page-top"><div class="page-head"><h1 class="page-title">Listem</h1></div><div id="ml"></div></div>`;
    const ml = $('#ml', view);
    if (!movies.length && !series.length && !live.length) {
      ml.innerHTML = emptyHtml('heart', 'Listen henüz boş', 'Beğendiğin film ve dizilerde + simgesine, kanallarda ★ simgesine tıklayarak listene ekleyebilirsin.');
      return;
    }
    const section = (title, list, kind) => {
      if (!list.length) return;
      ml.insertAdjacentHTML('beforeend', `<h2 class="section-title">${title} <small>${list.length}</small></h2>`);
      const w = document.createElement('div');
      ml.appendChild(w);
      renderGrid(w, list, kind);
    };
    section('Filmler', movies, 'poster');
    section('Diziler', series, 'poster');
    section('Kanallar', live, 'channel');
  },

  async search(view, { q }) {
    view.innerHTML = `<div class="page-top"><div class="page-head"><h1 class="page-title">“${esc(q)}” için sonuçlar</h1></div><div id="sr"><div class="center-load"><div class="spinner"></div><div>Katalog taranıyor… İlk aramada biraz sürebilir.</div></div></div></div>`;
    const nq = normText(q);
    const [movies, series, live] = await Promise.all([
      Catalog.all('movie').catch(() => []),
      Catalog.all('series').catch(() => []),
      Catalog.all('live').catch(() => []),
    ]);
    if (!view.isConnected || App.route?.params?.q !== q) return;
    const match = (list) => {
      const starts = [], contains = [];
      for (const x of list) {
        const n = normText(x.name);
        if (n.startsWith(nq)) starts.push(x);
        else if (n.includes(nq)) contains.push(x);
      }
      return [...starts, ...contains].slice(0, 120);
    };
    const r = { movie: match(movies.filter((x) => !x.asSeries)), series: match([...series, ...movies.filter((x) => x.asSeries)]), live: match(live) };
    const sr = $('#sr', view);
    sr.innerHTML = '';
    if (!r.movie.length && !r.series.length && !r.live.length) {
      sr.innerHTML = emptyHtml('search', 'Sonuç bulunamadı', `“${q}” ile eşleşen film, dizi veya kanal yok. Farklı bir yazım dene.`);
      return;
    }
    const section = (title, list, kind) => {
      if (!list.length) return;
      sr.insertAdjacentHTML('beforeend', `<h2 class="section-title">${title} <small>${list.length}</small></h2>`);
      const w = document.createElement('div');
      sr.appendChild(w);
      renderGrid(w, list, kind);
    };
    section('Kanallar', r.live, 'channel');
    section('Filmler', r.movie, 'poster');
    section('Diziler', r.series, 'poster');
  },
};

function rowForCategory(type, cat, { tag = true, page } = {}) {
  const kind = Catalog.kindOf(type, cat.id);
  return {
    title: cat.name,
    tag: tag ? TYPE_LABEL[kind === 'series' ? 'series' : type] : '',
    kind: type === 'live' ? 'channel' : 'poster',
    load: async () => {
      const items = await Catalog.items(type, cat.id);
      // İçerik incelenince kategori başka bölüme ait çıktıysa bu sayfada gösterme
      if (page && Catalog.kindOf(type, cat.id) !== page) return [];
      return items;
    },
    more: type === 'live'
      ? () => App.go('live', { cat: cat.id })
      : () => App.go('category', { type, id: cat.id, name: cat.name, from: Catalog.kindOf(type, cat.id) === 'series' ? 'series' : type }),
    actions: categoryActions(type, cat),
  };
}

// Satırdaki ⋯ menüsü: kategoriyi Filmler/Diziler arasında taşı veya gizle
function categoryActions(type, cat) {
  const acts = [];
  const moveTo = (row, kind) => {
    Catalog.setOverride('movie', cat.id, kind);
    Items.forEach((it) => { if (it.type === 'movie' && String(it.cat) === cat.id) it.asSeries = kind === 'series'; });
    toast(`“${cat.name}” ${kind === 'series' ? 'Diziler' : 'Filmler'} bölümüne taşındı`);
    const r = App.route?.name;
    if (r === 'movies' || r === 'series') {
      row.style.display = 'none';
      return;
    }
    // Ana sayfada etiketi ve menüyü güncelle
    const tagEl = $('.row-tag', row);
    if (tagEl) tagEl.textContent = TYPE_LABEL[kind];
    const fresh = categoryActions(type, cat);
    const holder = h(rowMenuHtml(fresh));
    $('.row-menu', row).replaceWith(holder);
    bindRowMenu(row, fresh);
  };
  if (type === 'movie') {
    if (Catalog.kindOf('movie', cat.id) === 'series') acts.push({ icon: 'film', label: 'Filmler bölümüne taşı', run: (row) => moveTo(row, 'movie') });
    else acts.push({ icon: 'tv', label: 'Diziler bölümüne taşı', run: (row) => moveTo(row, 'series') });
  }
  acts.push({
    icon: 'eyeOff',
    label: 'Bu kategoriyi gizle',
    run: (row) => {
      Catalog.setOverride(type, cat.id, 'hidden');
      row.style.display = 'none';
      toast(`“${cat.name}” gizlendi — profil menüsünden geri getirebilirsin`);
    },
  });
  return acts;
}

// Büyük listeleri parça parça çiz
function renderGrid(container, items, kind) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = emptyHtml('search', 'Sonuç yok', 'Filtreyi değiştirmeyi dene.');
    return;
  }
  const grid = h(`<div class="grid ${kind === 'channel' ? 'channels' : ''}"></div>`);
  const sentinel = h('<div class="grid-sentinel"></div>');
  container.append(grid, sentinel);
  let i = 0;
  const CHUNK = 90;
  const more = () => {
    const slice = items.slice(i, i + CHUNK);
    i += slice.length;
    grid.insertAdjacentHTML('beforeend', slice.map((x) => (kind === 'channel' ? Card.channel(x) : Card.poster(x))).join(''));
    if (i >= items.length) io.disconnect();
  };
  const io = new IntersectionObserver((en) => { if (en[0].isIntersecting) more(); }, { rootMargin: '800px 0px' });
  more();
  io.observe(sentinel);
}

function emptyHtml(ic, title, text) {
  return `<div class="empty">${icon(ic)}<h3>${esc(title)}</h3><p>${esc(text || '')}</p></div>`;
}
