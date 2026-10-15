import * as db from './db.js';
import * as api from './api.js';

/* ---------- pomocné funkcie ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const $app = document.getElementById('app');
const $toast = document.getElementById('toast');
let toastTimer;
function toast(msg, ms = 3200) {
  $toast.textContent = msg;
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), ms);
}

const money = (v, c = 'EUR') => {
  if (v == null || Number.isNaN(v)) return '—';
  try { return new Intl.NumberFormat('sk-SK', { style: 'currency', currency: c }).format(v); }
  catch { return `${v} ${c}`; }
};
const fmtDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${+m[3]}. ${+m[2]}. ${m[1]}` : '—'; };
const parseNum = (s) => { const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const numToStr = (n) => (n == null ? '' : String(n).replace('.', ','));
const today = () => new Date().toLocaleDateString('sv-SE');

const SOURCE = { 'sk-qr': 'eKasa QR', photo: 'Fotka', manual: 'Ručne' };
const STATUS = { draft: 'Rozpracovaný', ready: 'Pripravený', sent: 'Odoslaný' };

function newReceipt(source, extra = {}) {
  return {
    id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
    source, status: 'draft',
    vendor: '', ico: '', date: today(), total: null, vat: null, currency: 'EUR', note: '',
    receiptId: null, items: [], photo: null, ...extra,
  };
}

async function resizeImage(file, max = 1600) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { bmp = await createImageBitmap(file); }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.82));
}

/* ---------- navigácia (funguje aj s tlačidlom Späť na Androide) ---------- */
let cleanup = null;
function go(view, params = {}, { replace = false } = {}) {
  const st = { view, params };
  replace ? history.replaceState(st, '') : history.pushState(st, '');
  render(st);
}
function render(st) {
  if (cleanup) { cleanup(); cleanup = null; }
  $app.replaceChildren();
  const { view, params } = st || { view: 'list', params: {} };
  if (view === 'scan') return viewScan();
  if (view === 'form') return viewForm(params.id);
  return viewList();
}
window.addEventListener('popstate', (e) => render(e.state));

/* ---------- banner inštalácie ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
function installBanner(rerender) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || localStorage.getItem('hideInstall')) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!ios && !deferredPrompt) return null;
  const hide = () => { localStorage.setItem('hideInstall', '1'); rerender(); };
  return h('div', { class: 'install' },
    h('div', { style: null },
      ios ? 'Na plochu iPhonu pridáš aplikáciu cez Zdieľať → Pridať na plochu.' : 'Aplikáciu môžeš nainštalovať na plochu.',
      !ios && h('div', null, h('button', { onclick: async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; rerender(); } }, 'Inštalovať'))),
    h('button', { 'aria-label': 'Skryť', onclick: hide }, '✕'));
}

/* ---------- zoznam ---------- */
async function viewList() {
  const items = await db.all();
  const open = items.filter((r) => r.status !== 'sent');
  const totals = {};
  for (const r of open) if (r.total) totals[r.currency] = (totals[r.currency] || 0) + r.total;
  const sumText = Object.entries(totals).map(([c, v]) => money(v, c)).join(' + ');

  const sheet = h('div', { class: 'sheet' },
    items.length === 0
      ? h('div', { class: 'empty' }, h('strong', null, 'Zatiaľ tu nie sú žiadne bločky'),
          h('p', null, 'Naskenuj QR kód zo slovenského bločku alebo odfoť zahraničný doklad.'))
      : items.map((r) => h('button', { class: 'row', onclick: () => go('form', { id: r.id }) },
          h('span', { class: 'vendor' }, r.vendor || 'Bez názvu'),
          h('span', { class: 'amount num' }, money(r.total, r.currency)),
          h('span', { class: 'meta' }, `${fmtDate(r.date)} · ${SOURCE[r.source] || ''}`),
          h('span', { class: `chip ${r.status}` }, STATUS[r.status]))));

  const exportBtn = h('button', { class: 'btn small', onclick: () => exportJson(items) }, 'Exportovať dáta');
  const sendBtn = h('button', { class: 'btn small', onclick: sendAll }, 'Odoslať do portálu');

  $app.append(h('main', { class: 'view' },
    h('header', { class: 'top' }, h('h1', null, 'Bločky')),
    installBanner(() => render({ view: 'list' })),
    items.length > 0 && h('p', { class: 'summary num' },
      `${open.length} na spracovanie${sumText ? ' · ' + sumText : ''}`),
    sheet,
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => go('scan') }, 'Skenovať bloček')),
    items.length > 0 && h('div', { class: 'foot' }, exportBtn, sendBtn),
    h('p', { class: 'note' }, 'Údaje sú zatiaľ uložené len v tomto telefóne. Odoslanie do portálu nie je zapojené.')));
}

function exportJson(items) {
  const out = items.map(({ photo, ...r }) => ({ ...r, hasPhoto: !!photo }));
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `blocky-${today()}.json` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function sendAll() {
  const ready = (await db.all()).filter((r) => r.status === 'ready');
  if (!ready.length) return toast('Nie je čo odoslať. Najprv označ bločky ako pripravené.');
  try { for (const r of ready) await api.sendReceipt(r); }
  catch (e) {
    if (e.code === 'NOT_CONNECTED') return toast(`Napojenie na portál ešte nie je zapojené. ${ready.length} bločkov ostáva v telefóne.`, 4500);
    toast('Odoslanie zlyhalo. Skús to znova.');
  }
}

/* ---------- skener ---------- */
function viewScan() {
  let active = true, stream = null, raf = 0, busy = false;
  const video = h('video', { playsinline: true, autoplay: true });
  video.muted = true;
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const hint = h('div', { class: 'hint' }, 'Namier kameru na QR kód na bločku');
  const overlay = h('div', { class: 'scan' });

  const stop = () => {
    active = false; cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };
  cleanup = stop;

  const createAndOpen = async (r) => { await db.put(r); stop(); go('form', { id: r.id }, { replace: true }); };

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    busy = true; hint.textContent = 'Spracúvam fotku…';
    try { await createAndOpen(newReceipt('photo', { photo: await resizeImage(f) })); }
    catch { busy = false; hint.textContent = 'Fotku sa nepodarilo spracovať. Skús znova.'; }
  });

  const manual = () => createAndOpen(newReceipt('manual'));

  async function onCode(text) {
    busy = true;
    if (navigator.vibrate) navigator.vibrate(60);
    const rid = api.parseEkasaQr(text);
    if (!rid) {
      hint.textContent = 'Toto nie je QR kód slovenského bločku. Skús iný alebo odfoť bloček.';
      setTimeout(() => { busy = false; hint.textContent = 'Namier kameru na QR kód na bločku'; }, 2200);
      return;
    }
    const dup = await db.findByReceiptId(rid);
    if (dup) { stop(); toast('Tento bloček už máš uložený.'); return go('form', { id: dup.id }, { replace: true }); }

    hint.textContent = 'Načítavam údaje z eKasa…';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await api.lookupEkasa(rid, { signal: ctl.signal });
    clearTimeout(t);
    const r = newReceipt('sk-qr', { receiptId: rid });
    if (res.ok) Object.assign(r, res.data, { lookup: 'ok' });
    else r.lookup = res.reason;
    await createAndOpen(r);
  }

  function tick() {
    if (!active) return;
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
      if (code && code.data) onCode(code.data);
    }
    raf = requestAnimationFrame(tick);
  }
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const bar = h('div', { class: 'bar' },
    h('button', { class: 'btn signal', onclick: () => fileInput.click() }, 'Odfotiť zahraničný bloček'),
    h('button', { class: 'btn', onclick: manual }, 'Zadať ručne'));
  const close = h('button', { class: 'btn small close', onclick: () => history.back() }, 'Zavrieť');

  overlay.append(video, h('div', { class: 'shade' }), h('div', { class: 'frame' }), hint, close, bar, fileInput);
  $app.append(overlay);

  if (!navigator.mediaDevices?.getUserMedia) return cameraError('Tento prehliadač nepodporuje prístup ku kamere.');
  navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
    .then((s) => {
      if (!active) { s.getTracks().forEach((t) => t.stop()); return; }
      stream = s; video.srcObject = s;
      return video.play().then(() => { raf = requestAnimationFrame(tick); });
    })
    .catch((e) => cameraError(e.name === 'NotAllowedError'
      ? 'Aplikácia nemá povolenú kameru. Povoľ ju v nastaveniach prehliadača a skús znova.'
      : 'Kameru sa nepodarilo spustiť.'));

  function cameraError(text) {
    hint.textContent = '';
    overlay.append(h('div', { class: 'msg' }, h('strong', null, 'Kamera nie je dostupná'), h('span', null, text),
      h('button', { class: 'btn signal', onclick: () => fileInput.click() }, 'Odfotiť bloček'),
      h('button', { class: 'btn', onclick: manual }, 'Zadať ručne'),
      h('button', { class: 'btn', onclick: () => history.back() }, 'Späť')));
  }
}

/* ---------- formulár bločku ---------- */
async function viewForm(id) {
  const r = await db.get(id);
  if (!r) { toast('Bloček sa nenašiel.'); return go('list', {}, { replace: true }); }
  const locked = r.status === 'sent';
  let saveTimer;
  const persist = () => { clearTimeout(saveTimer); r.updatedAt = Date.now(); return db.put(r); };
  const autosave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); };
  let photoUrl = r.photo ? URL.createObjectURL(r.photo) : null;
  cleanup = () => { persist(); if (photoUrl) URL.revokeObjectURL(photoUrl); };

  const errs = {};
  const errEl = (k) => (errs[k] = h('div', { class: 'err' }));

  const field = (label, key, attrs = {}, parse = (v) => v, show = (v) => v ?? '') => {
    const input = h('input', { id: 'f-' + key, ...attrs, disabled: locked, value: show(r[key]) });
    input.addEventListener('input', () => { r[key] = parse(input.value); autosave(); });
    return h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label), input, errEl(key));
  };

  const currency = h('select', { id: 'f-currency', disabled: locked },
    ['EUR', 'CZK', 'PLN', 'HUF', 'USD', 'GBP', 'CHF'].map((c) => h('option', { value: c }, c)));
  currency.value = r.currency;
  currency.addEventListener('change', () => { r.currency = currency.value; autosave(); });

  const note = h('textarea', { id: 'f-note', rows: '2', disabled: locked }); note.value = r.note;
  note.addEventListener('input', () => { r.note = note.value; autosave(); });

  /* fotka */
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const photoBox = h('div', { class: 'photo' });
  const dlg = h('dialog');
  const drawPhoto = () => {
    photoBox.replaceChildren();
    if (photoUrl) {
      photoBox.append(h('button', { class: 'thumb', 'aria-label': 'Zobraziť fotku', onclick: () => {
        dlg.replaceChildren(h('img', { src: photoUrl, alt: 'Fotka bločku', onclick: () => dlg.close() })); dlg.showModal();
      } }, h('img', { class: 'thumb', src: photoUrl, alt: '' })));
    }
    if (!locked) photoBox.append(h('button', { class: 'btn small', onclick: () => fileInput.click() }, photoUrl ? 'Zmeniť fotku' : 'Pridať fotku'));
  };
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    try {
      r.photo = await resizeImage(f);
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(r.photo);
      await persist(); drawPhoto();
    } catch { toast('Fotku sa nepodarilo spracovať.'); }
  });
  drawPhoto();

  /* stav načítania z eKasa */
  let lookupBanner = null;
  if (r.source === 'sk-qr') {
    lookupBanner = r.lookup === 'ok'
      ? h('div', { class: 'banner ok' }, 'Údaje boli načítané z finančnej správy. Skontroluj ich.')
      : h('div', { class: 'banner' }, 'Údaje z eKasa sa zatiaľ nepodarilo načítať. ID bločku je uložené a doplnia sa po napojení na server. Zatiaľ ich môžeš vyplniť ručne.');
  }

  const itemsBox = r.items?.length
    ? h('details', { class: 'items' }, h('summary', null, `Položky (${r.items.length})`),
        h('ul', null, r.items.map((i) => h('li', null, h('span', null, `${i.qty}× ${i.name}`), h('span', { class: 'num' }, money(i.price, r.currency))))))
    : null;

  function validate() {
    const e = {};
    if (!r.vendor.trim()) e.vendor = 'Doplň názov predajcu.';
    if (!r.date) e.date = 'Doplň dátum.';
    if (!(r.total > 0)) e.total = 'Doplň sumu väčšiu ako 0.';
    if (!r.photo && !r.receiptId) e.photo = 'Pridaj fotku bločku.';
    for (const k of Object.keys(errs)) errs[k].textContent = e[k] || '';
    if (e.photo) toast(e.photo);
    return Object.keys(e).length === 0;
  }

  const setReady = async () => { if (!validate()) return; r.status = 'ready'; await persist(); toast('Bloček je pripravený na odoslanie.'); history.back(); };
  const setDraft = async () => { r.status = 'draft'; await persist(); history.back(); };
  const remove = async () => {
    if (!confirm('Naozaj zmazať tento bloček?')) return;
    clearTimeout(saveTimer); cleanup = () => {}; await db.del(r.id); history.back();
  };

  $app.append(h('main', { class: 'view' },
    h('header', { class: 'top' },
      h('button', { class: 'back', onclick: () => history.back() }, '‹ Späť'),
      h('h1', null, r.vendor || 'Nový bloček'),
      h('span', { class: `chip ${r.status}` }, STATUS[r.status])),
    h('div', { class: 'form' },
      lookupBanner,
      field('Predajca', 'vendor', { autocomplete: 'off' }),
      h('div', { class: 'grid2' },
        field('Dátum', 'date', { type: 'date' }),
        field('IČO', 'ico', { inputmode: 'numeric', autocomplete: 'off' })),
      h('div', { class: 'grid3' },
        field('Suma celkom', 'total', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr),
        field('z toho DPH', 'vat', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr),
        h('div', { class: 'field' }, h('label', { for: 'f-currency' }, 'Mena'), currency)),
      itemsBox,
      h('div', { class: 'field' }, h('label', null, 'Fotka bločku'), photoBox, errEl('photo')),
      h('div', { class: 'field' }, h('label', { for: 'f-note' }, 'Poznámka pre účtovníčku'), note),
      r.receiptId && h('p', { class: 'note' }, `ID dokladu: ${r.receiptId}`)),
    h('div', { class: 'actions' },
      !locked && (r.status === 'ready'
        ? h('button', { class: 'btn', onclick: setDraft }, 'Vrátiť medzi rozpracované')
        : h('button', { class: 'btn primary', onclick: setReady }, 'Označiť ako pripravený')),
      !locked && h('button', { class: 'btn danger', onclick: remove }, 'Zmazať bloček')),
    fileInput, dlg));
}

/* ---------- štart ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
history.replaceState({ view: 'list', params: {} }, '');
render({ view: 'list', params: {} });
