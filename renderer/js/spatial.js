/* Kumanda (D-pad) ile gezinme: ok tuşları ekrandaki konuma göre en yakın öğeye geçer.
   Android'de (TV ve klavye/kumanda bağlı telefon/tablet) etkindir. */

const Spatial = {
  enabled: false,
  SEL: [
    'button:not([disabled])', 'a[data-route]', 'a.back-link', 'input:not([type=hidden]):not([type=file])', 'select', 'textarea',
    '[data-card]', '.ep', '[tabindex]:not([tabindex="-1"])',
  ].join(','),
  // Gezinmede atlanan öğeler (fareyle kullanılan oklar, satır başlığı düğmeleri)
  SKIP: '.row-arrow, .row-menu-btn, .row-more, .search-clear, .skeleton, .p-volume input',
  NATIVE: 'button, input, select, textarea, a[href], [tabindex]',

  init() {
    this.enabled = document.documentElement.classList.contains('android');
    if (!this.enabled) return;
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  },

  // Şu an açık olan katman: diyalog > hesap menüsü > satır menüsü > detay > giriş > sayfa
  scope() {
    if (!$('#dialog').hidden) return $('#dialog-box');
    if (!$('#account-menu').hidden) return $('#account');
    const rm = $$('.row-menu-list').find((l) => !l.hidden);
    if (rm) return rm;
    if (!$('#modal').hidden) return $('#modal-dialog');
    if (!$('#login').hidden) return $('#login');
    return $('#shell');
  },

  candidates(scope) {
    return $$(this.SEL, scope).filter((el) => {
      if (el.matches(this.SKIP) || el.closest('[hidden]')) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    });
  },

  focus(el, { center } = {}) {
    if (!el.matches(this.NATIVE)) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
    const inRow = el.matches('[data-card]') && el.closest('.row-track');
    el.scrollIntoView({ block: center || inRow ? 'center' : 'nearest', inline: 'nearest' });
  },

  focusFirst(scope = this.scope()) {
    const list = this.candidates(scope);
    if (!list.length) return false;
    const vw = innerWidth, vh = innerHeight;
    const inView = list.filter((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    });
    const pool = inView.length ? inView : list;
    const pick = pool.find((el) => el.matches('.hero .btn-primary, .md-actions .btn-primary, [data-dlg="ok"], .fp-item'))
      || pool.find((el) => el.matches('.ch-item.active, .cat-item.active'))
      || pool.find((el) => el.matches('#view [data-card], #view .ch-item'))
      || pool.find((el) => el.closest('#view, #modal-dialog, #login, #dialog-box, #account'))
      || pool[0];
    this.focus(pick);
    return true;
  },

  // İçerik asenkron geldiği için: hazır olunca odağı ver (kullanıcı bu arada başka yere gitmediyse)
  autoFocus(container) {
    if (!this.enabled) return;
    const started = Date.now();
    clearTimeout(this.autoTimer);
    const tryNow = () => {
      if (!container.isConnected) return;
      const ae = document.activeElement;
      // Kullanıcı zaten açık katmanda bir öğedeyse (ör. üst menüde) odağı çalma
      if (ae && ae !== document.body && ae.isConnected && this.scope().contains(ae)) return;
      if (this.candidates(container).length && this.focusFirst(container)) return;
      if (Date.now() - started < 4000) this.autoTimer = setTimeout(tryNow, 150);
    };
    this.autoTimer = setTimeout(tryNow, 60);
  },

  onKey(e) {
    const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.key];
    const ae = document.activeElement;
    const scope = this.scope();
    if (!dir && e.key !== 'Enter') return;
    if (typeof Player !== 'undefined' && Player.isOpen) return; // masaüstü oynatıcısı kendi tuşlarını yönetir

    // Odak katman dışındaysa önce katmanın ilk öğesine geç
    if (!ae || ae === document.body || !scope.contains(ae) || !ae.isConnected) {
      if (dir || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.focusFirst(scope);
      }
      return;
    }

    if (e.key === 'Enter') {
      // TV: kilitli metin kutusunda OK → düzenlemeye başla ve klavyeyi aç
      if (window.native?.editText && window.native.isText(ae) && ae.readOnly) {
        e.preventDefault();
        e.stopPropagation();
        window.native.editText(ae);
        return;
      }
      // Düğme olmayan öğeleri (kart, bölüm, sayfa bağlantısı) tıkla
      if (!ae.matches('button, input, select, textarea, a[href]')) {
        e.preventDefault();
        e.stopPropagation();
        ae.click();
      }
      return;
    }

    // Metin kutusunda sağ/sol imleci taşır; uçtaysa kutudan çık (kilitliyken doğrudan gezin)
    if (ae.matches('input, textarea') && !ae.readOnly && (dir === 'left' || dir === 'right')) {
      const v = ae.value || '';
      const atStart = ae.selectionStart === 0 && ae.selectionEnd === 0;
      const atEnd = ae.selectionStart === v.length;
      if (!((dir === 'left' && atStart) || (dir === 'right' && atEnd))) return;
    }

    e.preventDefault();
    e.stopPropagation();
    const list = this.candidates(scope);
    let next = this.best(ae, list, dir);
    // Satırın sonundaysa "Tümünü gör"e geç
    if (!next && dir === 'right' && ae.closest('.row-track')) {
      const more = ae.closest('.row')?.querySelector('.row-more');
      if (more) next = more;
    }
    if (!next && dir === 'left' && ae.matches('.row-more')) next = ae.closest('.row').querySelector('.row-track [data-card]:last-child');
    if (next) this.focus(next);
  },

  best(cur, list, dir) {
    const a = cur.getBoundingClientRect();
    const acx = a.left + a.width / 2;
    const acy = a.top + a.height / 2;
    const gap = (a1, a2, b1, b2) => (b2 < a1 ? a1 - b2 : b1 > a2 ? b1 - a2 : 0);
    let best = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const b = el.getBoundingClientRect();
      const bcx = b.left + b.width / 2;
      const bcy = b.top + b.height / 2;
      let primary, orth, drift;
      if (dir === 'right') {
        if (bcx <= acx + 1 || b.right <= a.right - 1) continue;
        primary = Math.max(0, b.left - a.right); orth = gap(a.top, a.bottom, b.top, b.bottom); drift = Math.abs(bcy - acy);
      } else if (dir === 'left') {
        if (bcx >= acx - 1 || b.left >= a.left + 1) continue;
        primary = Math.max(0, a.left - b.right); orth = gap(a.top, a.bottom, b.top, b.bottom); drift = Math.abs(bcy - acy);
      } else if (dir === 'down') {
        if (bcy <= acy + 1 || b.bottom <= a.bottom - 1) continue;
        primary = Math.max(0, b.top - a.bottom); orth = gap(a.left, a.right, b.left, b.right); drift = Math.abs(bcx - acx);
      } else {
        if (bcy >= acy - 1 || b.top >= a.top + 1) continue;
        primary = Math.max(0, a.top - b.bottom); orth = gap(a.left, a.right, b.left, b.right); drift = Math.abs(bcx - acx);
      }
      // Yatayda aynı satırda kal; dikeyde önce en yakın satıra git (yatay kayma daha az önemli)
      const vertical = dir === 'up' || dir === 'down';
      const score = vertical ? primary + orth * 0.6 + drift * 0.02 : primary + orth * 3 + drift * 0.05;
      if (score < bestScore) { bestScore = score; best = el; }
    }
    return best;
  },
};

document.addEventListener('DOMContentLoaded', () => Spatial.init());
