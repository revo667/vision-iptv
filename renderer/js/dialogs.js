/* Küçük pencereler: ad girme, onay ve "Favori listesine ekle" seçici.
   (Electron'da window.prompt yok; TV kumandasıyla da gezilebilir olmalı.) */

const Dialog = {
  onClose: null,

  get isOpen() { return !$('#dialog').hidden; },

  open(html, { onClose, cls = '' } = {}) {
    if (this.isOpen) this.close(true);
    const root = $('#dialog');
    const box = $('#dialog-box');
    box.className = `dialog-box ${cls}`;
    box.innerHTML = html;
    root.hidden = false;
    this.onClose = onClose || null;
    this.prevFocus = document.activeElement;
    return box;
  },

  close(silent) {
    if (!this.isOpen) return;
    $('#dialog').hidden = true;
    $('#dialog-box').innerHTML = '';
    const cb = this.onClose;
    this.onClose = null;
    if (!silent && cb) cb();
    if (this.prevFocus?.isConnected) this.prevFocus.focus?.({ preventScroll: true });
  },

  // Metin iste → Promise<string|null>
  prompt({ title, value = '', placeholder = '', ok = 'Kaydet' }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const box = this.open(`
        <h3>${esc(title)}</h3>
        <input class="dialog-input" id="dlg-input" maxlength="40" spellcheck="false" value="${esc(value)}" placeholder="${esc(placeholder)}">
        <div class="dialog-acts">
          <button class="btn btn-ghost btn-sm" data-dlg="cancel">Vazgeç</button>
          <button class="btn btn-primary btn-sm" data-dlg="ok">${esc(ok)}</button>
        </div>`, { onClose: () => finish(null) });
      const input = $('#dlg-input', box);
      const submit = () => {
        const v = input.value.trim();
        if (!v) { input.focus(); return; }
        finish(v);
        this.close(true);
      };
      box.onclick = (e) => {
        const a = e.target.closest('[data-dlg]')?.dataset.dlg;
        if (a === 'ok') submit();
        if (a === 'cancel') this.close();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
      setTimeout(() => { input.focus(); input.select(); }, 30);
    });
  },

  // Onay → Promise<boolean>
  confirm({ title, text = '', ok = 'Tamam', danger = false }) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); };
      const box = this.open(`
        <h3>${esc(title)}</h3>
        ${text ? `<p class="muted">${esc(text)}</p>` : ''}
        <div class="dialog-acts">
          <button class="btn btn-ghost btn-sm" data-dlg="cancel">Vazgeç</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} btn-sm" data-dlg="ok">${esc(ok)}</button>
        </div>`, { onClose: () => finish(false) });
      box.onclick = (e) => {
        const a = e.target.closest('[data-dlg]')?.dataset.dlg;
        if (a === 'ok') { finish(true); this.close(true); }
        if (a === 'cancel') this.close();
      };
      setTimeout(() => $('[data-dlg="ok"]', box)?.focus(), 30);
    });
  },
};

/* Kanalı bir veya birden çok favori listesine ekle / çıkar */
const FavPicker = {
  open(ch, { onChange } = {}) {
    if (!ch) return;
    const render = () => {
      const lists = Library.chLists();
      return `
        <div class="fp-head">${icon('star')}<div><h3>Favori listelerine ekle</h3><p class="muted">${esc(ch.name)}</p></div></div>
        <div class="fp-lists">
          ${lists.length ? lists.map((l) => {
            const on = l.items.some((x) => String(x.id) === String(ch.id));
            return `<button class="fp-item ${on ? 'on' : ''}" data-dlg="toggle" data-id="${esc(l.id)}">
                <span class="fp-check">${on ? icon('check') : ''}</span>
                <span class="fp-name">${esc(l.name)}</span>
                <small>${l.items.length} kanal</small>
              </button>`;
          }).join('') : '<div class="fp-empty">Henüz bir favori listen yok. Aşağıdan ilk listeni oluştur.</div>'}
        </div>
        <div class="fp-new">
          <input class="dialog-input" id="fp-name" maxlength="40" spellcheck="false" placeholder="Yeni liste adı (ör. Spor, Haber)" value="${lists.length ? '' : 'Favorilerim'}">
          <button class="btn btn-glass btn-sm" data-dlg="create">${icon('plus')}<span class="btn-label">Liste oluştur</span></button>
        </div>
        <div class="dialog-acts"><button class="btn btn-primary btn-sm" data-dlg="close">Tamam</button></div>`;
    };
    let changed = false;
    const box = Dialog.open(render(), { cls: 'fav-picker', onClose: () => changed && onChange?.() });
    const create = () => {
      const input = $('#fp-name', box);
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const l = Library.createChList(name);
      Library.toggleInChList(l.id, ch);
      changed = true;
      box.innerHTML = render();
      toast(`“${l.name}” oluşturuldu ve kanal eklendi`);
      $(`[data-id="${CSS.escape(l.id)}"]`, box)?.focus();
    };
    box.onclick = (e) => {
      const b = e.target.closest('[data-dlg]');
      if (!b) return;
      if (b.dataset.dlg === 'toggle') {
        const on = Library.toggleInChList(b.dataset.id, ch);
        changed = true;
        b.classList.toggle('on', on);
        $('.fp-check', b).innerHTML = on ? icon('check') : '';
        const l = Library.chList(b.dataset.id);
        $('small', b).textContent = `${l ? l.items.length : 0} kanal`;
      }
      if (b.dataset.dlg === 'create') create();
      if (b.dataset.dlg === 'close') Dialog.close();
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'fp-name') { e.preventDefault(); create(); }
    });
    setTimeout(() => $('.fp-item, #fp-name', box)?.focus(), 30);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  $('#dialog').addEventListener('click', (e) => {
    if (e.target.closest('[data-dlg="backdrop"]')) Dialog.close();
  });
});
