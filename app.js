import * as db from './db.js';
import * as api from './api.js';
import { loadBitmap, autoDetect, renderCrop, mountCropper } from './image.js';
import { buildBatch, shareBatch } from './share.js';

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
function toast(msg, ms = 3400) {
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
const fmtDateTime = (ts) => new Date(ts).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const parseNum = (s) => { const n = parseFloat(String(s).replace(/\s/g, '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const numToStr = (n) => (n == null ? '' : String(n).replace('.', ','));
const today = () => new Date().toLocaleDateString('sv-SE');
const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' kB');
const sumBy = (rs) => {
  const t = {};
  for (const r of rs) if (r.total) t[r.currency] = (t[r.currency] || 0) + r.total;
  return Object.entries(t).map(([c, v]) => money(v, c)).join(' + ');
};

const plural = (n) => (n === 1 ? 'bloček' : n >= 2 && n <= 4 ? 'bločky' : 'bločkov');
const SOURCE = { 'sk-qr': 'eKasa QR', photo: 'Fotka', manual: 'Ručne' };
const STATUS = { draft: 'Rozpracovaný', ready: 'Pripravený', sent: 'Odoslaný' };

const SKEY = 'blocky-settings';
const getSettings = () => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } };
const setSettings = (s) => { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* ignoruj */ } };

function newReceipt(source, extra = {}) {
  return {
    id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
    source, status: 'draft',
    vendor: '', ico: '', dic: '', icDph: '', date: today(), total: null, vat: null, currency: 'EUR', note: '',
    receiptId: null, items: [], vatBreakdown: [], ekasaRaw: null, photo: null,
    batchId: null, sentAt: null, sentBy: null, ...extra,
  };
}

/* dialógy */
function openDialog(content) {
  const d = h('dialog', { class: 'dlg' }, content);
  document.body.append(d);
  d.addEventListener('close', () => d.remove());
  d.showModal();
  return d;
}
function confirmDialog({ title, text, yes, no }) {
  return new Promise((resolve) => {
    let answer = false;
    const d = openDialog(h('div', { class: 'dlg-body' },
      h('h2', null, title), h('p', null, text),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => { answer = true; d.close(); } }, yes),
        h('button', { class: 'btn', onclick: () => d.close() }, no))));
    d.addEventListener('close', () => resolve(answer));
  });
}

/* ---------- navigácia ---------- */
let cleanup = null;
let pending = null;            // fotka čakajúca na orezanie { bmp, target }
let listTab = 'todo';
const selected = new Set();    // vybrané bločky na odoslanie

function go(view, params = {}, { replace = false } = {}) {
  const st = { view, params };
  replace ? history.replaceState(st, '') : history.pushState(st, '');
  render(st);
}
function render(st) {
  if (cleanup) { cleanup(); cleanup = null; }
  $app.replaceChildren();
  window.scrollTo(0, 0);
  const { view, params } = st || { view: 'list', params: {} };
  if (view === 'scan') return viewScan();
  if (view === 'crop') return viewCrop();
  if (view === 'form') return viewForm(params.id);
  return viewList();
}
window.addEventListener('popstate', (e) => render(e.state));

/* ---------- inštalácia ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
function installBanner(rerender) {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone || localStorage.getItem('hideInstall')) return null;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!ios && !deferredPrompt) return null;
  return h('div', { class: 'install' },
    h('div', null,
      ios ? 'Na plochu iPhonu pridáš aplikáciu cez Zdieľať → Pridať na plochu.' : 'Aplikáciu môžeš nainštalovať na plochu.',
      !ios && h('div', null, h('button', { onclick: async () => { deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; rerender(); } }, 'Inštalovať'))),
    h('button', { 'aria-label': 'Skryť', onclick: () => { localStorage.setItem('hideInstall', '1'); rerender(); } }, '✕'));
}

/* ---------- zoznam ---------- */
async function viewList() {
  const items = await db.all();
  const todo = items.filter((r) => r.status !== 'sent');
  const sent = items.filter((r) => r.status === 'sent');
  const ready = todo.filter((r) => r.status === 'ready');
  const drafts = todo.filter((r) => r.status === 'draft');
  for (const id of [...selected]) if (!ready.some((r) => r.id === id)) selected.delete(id);
  const rerender = () => render({ view: 'list' });

  const tab = (key, label, count) => h('button', {
    class: 'tab' + (listTab === key ? ' on' : ''), role: 'tab', 'aria-selected': String(listTab === key),
    onclick: () => { listTab = key; rerender(); },
  }, label, h('span', { class: 'count num' }, String(count)));

  const hero = h('header', { class: 'hero' }, h('div', { class: 'wrap' },
    h('div', { class: 'hero-top' },
      h('h1', null, 'Bločky'),
      h('button', { class: 'ghost', onclick: openSettings }, 'Nastavenia')),
    listTab === 'todo'
      ? h('div', { class: 'big' },
          h('span', { class: 'big-n num' }, String(ready.length)),
          h('span', { class: 'big-l' }, ready.length === 1 ? 'pripravený na odoslanie' : 'pripravených na odoslanie'),
          h('span', { class: 'big-s num' }, `${drafts.length} rozpracovaných${ready.length ? ' · ' + sumBy(ready) : ''}`))
      : h('div', { class: 'big' },
          h('span', { class: 'big-n num' }, String(sent.length)),
          h('span', { class: 'big-l' }, sent.length === 1 ? 'odoslaný bloček' : 'odoslaných bločkov')),
    h('div', { class: 'tabs', role: 'tablist' }, tab('todo', 'K odoslaniu', todo.length), tab('sent', 'Odoslané', sent.length))));

  const content = h('main', { class: 'wrap content' }, installBanner(rerender));

  if (listTab === 'todo') {
    if (todo.length === 0) {
      content.append(h('div', { class: 'paper' }, h('div', { class: 'empty' },
        h('strong', null, 'Zatiaľ tu nie sú žiadne bločky'),
        h('p', null, 'Naskenuj QR kód zo slovenského bločku alebo odfoť zahraničný doklad.'))));
    } else {
      if (ready.length > 1) {
        const all = selected.size === ready.length;
        content.append(h('div', { class: 'selbar' },
          h('span', { class: 'num' }, `Vybrané: ${selected.size} z ${ready.length}`),
          h('button', { class: 'linkbtn', onclick: () => { all ? selected.clear() : ready.forEach((r) => selected.add(r.id)); rerender(); } }, all ? 'Zrušiť výber' : 'Vybrať všetky')));
      }
      content.append(h('div', { class: 'paper' }, todo.map((r) => rowEl(r, true, rerender))));
    }
  } else if (sent.length === 0) {
    content.append(h('div', { class: 'paper' }, h('div', { class: 'empty' },
      h('strong', null, 'Zatiaľ nič nebolo odoslané'),
      h('p', null, 'Po odoslaní emailom sa tu zobrazí história po dávkach.'))));
  } else {
    const batches = new Map();
    for (const r of sent) { const k = r.batchId || 'bez-davky'; (batches.get(k) || batches.set(k, []).get(k)).push(r); }
    [...batches.values()].sort((a, b) => b[0].sentAt - a[0].sentAt).forEach((rs) => {
      content.append(h('section', { class: 'batch' },
        h('h2', null, fmtDateTime(rs[0].sentAt)),
        h('p', { class: 'meta num' }, `${rs.length} ${plural(rs.length)} · ${sumBy(rs)}${rs[0].sentBy ? ' · ' + rs[0].sentBy : ''}`),
        h('div', { class: 'paper' }, rs.map((r) => rowEl(r, false, rerender))),
        h('div', { class: 'foot' },
          h('button', { class: 'btn small', onclick: () => openSendSheet(rs.map((r) => r.id), true) }, 'Odoslať znova'),
          h('button', { class: 'btn small', onclick: async () => {
            for (const r of rs) { r.status = 'ready'; r.batchId = null; r.sentAt = null; r.sentBy = null; await db.put(r); selected.add(r.id); }
            listTab = 'todo'; rerender();
          } }, 'Vrátiť medzi pripravené'))));
    });
  }

  const dock = h('div', { class: 'dock' }, h('div', { class: 'wrap dock-in' },
    h('button', { class: 'btn' + (selected.size ? '' : ' primary grow'), onclick: () => go('scan') }, '+ Skenovať'),
    selected.size > 0 && h('button', { class: 'btn primary grow', onclick: () => openSendSheet([...selected]) }, `Odoslať (${selected.size})`)));

  $app.append(hero, content, dock);
}

function rowEl(r, selectable, rerender) {
  const check = selectable && r.status === 'ready'
    ? h('label', { class: 'pick', 'aria-label': 'Vybrať na odoslanie' },
        (() => {
          const i = h('input', { type: 'checkbox' });
          i.checked = selected.has(r.id);
          i.addEventListener('change', () => { i.checked ? selected.add(r.id) : selected.delete(r.id); rerender(); });
          return i;
        })())
    : h('span', { class: 'pick none' });
  return h('div', { class: 'row' }, check,
    h('button', { class: 'main', onclick: () => go('form', { id: r.id }) },
      h('span', { class: 'vendor' }, r.vendor || 'Bez názvu'),
      h('span', { class: 'amount num' }, money(r.total, r.currency)),
      h('span', { class: 'meta' }, `${fmtDate(r.date)} · ${SOURCE[r.source] || ''}`),
      h('span', { class: `chip ${r.status}` }, STATUS[r.status])));
}

/* ---------- nastavenia ---------- */
function openSettings() {
  const st = getSettings();
  const name = h('input', { id: 's-name', autocomplete: 'name', placeholder: 'Meno a priezvisko' }); name.value = st.name || '';
  const to = h('input', { id: 's-to', type: 'email', autocomplete: 'off', placeholder: 'blocky@firma.sk' }); to.value = st.to || '';
  const enh = h('input', { id: 's-enh', type: 'checkbox' }); enh.checked = st.enhance !== false;
  const d = openDialog(h('div', { class: 'dlg-body' },
    h('h2', null, 'Nastavenia'),
    h('div', { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 's-name' }, 'Tvoje meno'), name),
      h('div', { class: 'field' }, h('label', { for: 's-to' }, 'Email účtovníčky'), to),
      h('label', { class: 'check' }, enh, h('span', null, 'Zvýrazniť text na fotke (menší súbor, lepšie čitateľný)'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => { setSettings({ ...st, name: name.value.trim(), to: to.value.trim(), enhance: enh.checked }); d.close(); toast('Nastavenia uložené.'); } }, 'Uložiť'),
      h('button', { class: 'btn', onclick: () => d.close() }, 'Zrušiť'))));
}

/* ---------- odoslanie emailom ---------- */
async function openSendSheet(ids, resend = false) {
  const all = await db.all();
  const rs = all.filter((r) => ids.includes(r.id) && (resend ? r.status === 'sent' : r.status === 'ready'));
  if (!rs.length) return toast('Nie je čo odoslať.');
  const st = getSettings();
  const batch = buildBatch(rs, st);
  const tooBig = batch.totalBytes > 20 * 1048576;

  const d = openDialog(h('div', { class: 'dlg-body' },
    h('h2', null, `Odoslať ${rs.length} ${plural(rs.length)}`),
    h('p', { class: 'num' }, `${batch.sum} · ${batch.files.length} príloh · ${kb(batch.totalBytes)}`),
    tooBig && h('p', { class: 'banner' }, 'Prílohy majú viac ako 20 MB. Niektoré pošty ich neodošlú. Rozdeľ odosielanie na menej bločkov.'),
    h('div', { class: 'addr' },
      h('div', null, h('div', { class: 'meta' }, 'Adresát'), h('strong', null, st.to || 'nie je nastavený (Nastavenia)')),
      st.to && h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(st.to); toast('Adresa skopírovaná.'); } catch { toast('Adresu sa nepodarilo skopírovať.'); } } }, 'Kopírovať')),
    h('p', { class: 'note' }, 'Pošta sa otvorí so všetkými prílohami. Adresu vyber alebo vlož skopírovanú a email odošli zo svojho účtu.'),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: async () => {
        const res = await shareBatch({ ...batch, to: st.to });   // volá sa hneď po kliknutí
        d.close();
        if (res.status === 'cancelled') return;
        if (res.status === 'error') return toast('Odoslanie zlyhalo. Skús to znova.');
        if (res.droppedJson) toast('Tento telefón nepovolil prílohy .json, odišli len fotky a súhrn.', 5000);
        const ok = await confirmDialog({
          title: 'Odoslal si email?',
          text: res.status === 'fallback' ? 'Súbory sa stiahli. Pripoj ich k emailu a odošli ho. Potom bločky označím ako odoslané.' : 'Ak si email odoslal, označím tieto bločky ako odoslané.',
          yes: 'Áno, odoslané', no: 'Nie, ešte nie',
        });
        if (!ok) return;
        const batchId = crypto.randomUUID(), sentAt = Date.now();
        for (const r of rs) { r.status = 'sent'; r.batchId = batchId; r.sentAt = sentAt; r.sentBy = st.name || ''; selected.delete(r.id); await db.put(r); }
        toast('Označené ako odoslané.');
        render({ view: 'list' });
      } }, 'Otvoriť poštu'),
      h('button', { class: 'btn', onclick: () => d.close() }, 'Zrušiť'))));
}

/* ---------- skener ---------- */
function viewScan() {
  let active = true, stream = null, raf = 0, busy = false;
  const video = h('video', { playsinline: true, autoplay: true });
  video.muted = true;
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const hint = h('div', { class: 'hint' }, 'Namier kameru na QR kód na bločku');
  const overlay = h('div', { class: 'scan' });
  const stop = () => { active = false; cancelAnimationFrame(raf); if (stream) stream.getTracks().forEach((t) => t.stop()); };
  cleanup = stop;

  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    busy = true; hint.textContent = 'Načítavam fotku…';
    try { pending = { bmp: await loadBitmap(f), target: null }; stop(); go('crop', {}, { replace: true }); }
    catch { busy = false; hint.textContent = 'Fotku sa nepodarilo načítať. Skús znova.'; }
  });

  const manual = async () => { const r = newReceipt('manual'); await db.put(r); stop(); go('form', { id: r.id }, { replace: true }); };

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
    if (res.ok) Object.assign(r, res.data, { lookup: 'ok' }); else r.lookup = res.reason;
    await db.put(r); stop(); go('form', { id: r.id }, { replace: true });
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

  const bar = h('div', { class: 'bar' },
    h('button', { class: 'btn signal', onclick: () => fileInput.click() }, 'Odfotiť zahraničný bloček'),
    h('button', { class: 'btn', onclick: manual }, 'Zadať ručne'));
  const close = h('button', { class: 'btn small close', onclick: () => history.back() }, 'Zavrieť');
  overlay.append(video, h('div', { class: 'frame' }), hint, close, bar, fileInput);
  $app.append(overlay);

  const cameraError = (text) => {
    hint.textContent = '';
    overlay.append(h('div', { class: 'msg' }, h('strong', null, 'Kamera nie je dostupná'), h('span', null, text),
      h('button', { class: 'btn signal', onclick: () => fileInput.click() }, 'Odfotiť bloček'),
      h('button', { class: 'btn', onclick: manual }, 'Zadať ručne'),
      h('button', { class: 'btn', onclick: () => history.back() }, 'Späť')));
  };
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
}

/* ---------- orezanie fotky ---------- */
function viewCrop() {
  if (!pending) return go('list', {}, { replace: true });
  const { bmp, target } = pending;
  let enhance = getSettings().enhance !== false;
  const stage = h('div', { class: 'stage' });
  const cropper = mountCropper(stage, bmp, autoDetect(bmp));
  cleanup = () => cropper.destroy();

  const enh = h('input', { type: 'checkbox' }); enh.checked = enhance;
  enh.addEventListener('change', () => { enhance = enh.checked; });
  const useBtn = h('button', { class: 'btn signal' }, 'Použiť fotku');
  useBtn.addEventListener('click', async () => {
    useBtn.disabled = true; useBtn.textContent = 'Spracúvam…';
    try {
      const blob = await renderCrop(bmp, cropper.getCrop(), { enhance });
      pending = null; bmp.close?.();
      if (target) {
        const r = await db.get(target);
        if (r) { r.photo = blob; r.updatedAt = Date.now(); await db.put(r); }
        toast(`Fotka uložená (${kb(blob.size)}).`);
        history.back();
      } else {
        const r = newReceipt('photo', { photo: blob });
        await db.put(r);
        toast(`Fotka uložená (${kb(blob.size)}).`);
        go('form', { id: r.id }, { replace: true });
      }
    } catch { useBtn.disabled = false; useBtn.textContent = 'Použiť fotku'; toast('Fotku sa nepodarilo spracovať.'); }
  });

  $app.append(h('div', { class: 'cropview' },
    h('div', { class: 'crop-head' }, h('strong', null, 'Orež bloček'), h('span', null, 'Potiahni rohy tak, aby bolo vidieť len bloček.')),
    stage,
    h('div', { class: 'bar' },
      h('label', { class: 'check light' }, enh, h('span', null, 'Zvýrazniť text')),
      useBtn,
      h('button', { class: 'btn', onclick: () => { pending = null; history.back(); } }, 'Zrušiť'))));
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

  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const photoBox = h('div', { class: 'photo' });
  const dlg = h('dialog', { class: 'lightbox' });
  const drawPhoto = () => {
    photoBox.replaceChildren();
    if (photoUrl) {
      photoBox.append(h('button', { class: 'thumbbtn', 'aria-label': 'Zobraziť fotku', onclick: () => {
        dlg.replaceChildren(h('img', { src: photoUrl, alt: 'Fotka bločku', onclick: () => dlg.close() })); dlg.showModal();
      } }, h('img', { class: 'thumb', src: photoUrl, alt: '' })),
      h('span', { class: 'meta num' }, kb(r.photo.size)));
    }
    if (!locked) photoBox.append(h('button', { class: 'btn small', onclick: () => fileInput.click() }, photoUrl ? 'Zmeniť fotku' : 'Pridať fotku'));
  };
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    try { await persist(); pending = { bmp: await loadBitmap(f), target: r.id }; go('crop'); }
    catch { toast('Fotku sa nepodarilo načítať.'); }
  });
  drawPhoto();

  const lookupBanner = r.source === 'sk-qr'
    ? (r.lookup === 'ok'
      ? h('div', { class: 'banner ok' }, 'Údaje boli načítané z finančnej správy. Skontroluj ich.')
      : h('div', { class: 'banner' }, 'Údaje z eKasa sa zatiaľ nepodarilo načítať. ID bločku je uložené a doplnia sa po napojení na server. Zatiaľ ich môžeš vyplniť ručne.'))
    : null;

  const taxOpen = r.source === 'sk-qr' || r.ico || r.dic || r.icDph;
  const tax = h('details', { class: 'items', open: taxOpen ? true : null },
    h('summary', null, 'Daňové údaje predajcu'),
    h('div', { class: 'form inner' },
      field('IČO', 'ico', { inputmode: 'numeric', autocomplete: 'off' }),
      h('div', { class: 'grid2' },
        field('DIČ', 'dic', { inputmode: 'numeric', autocomplete: 'off' }),
        field('IČ DPH', 'icDph', { autocomplete: 'off' })),
      r.vatBreakdown?.length > 0 && h('ul', { class: 'vatlist' }, r.vatBreakdown.map((b) =>
        h('li', null, h('span', null, `DPH ${b.rate} %`), h('span', { class: 'num' }, `základ ${money(b.base, r.currency)} · DPH ${money(b.vat, r.currency)}`))))));

  const itemsBox = r.items?.length
    ? h('details', { class: 'items' }, h('summary', null, `Položky (${r.items.length})`),
        h('ul', null, r.items.map((i) => h('li', null, h('span', null, `${i.qty}× ${i.name}${i.vatRate ? ` (${i.vatRate} %)` : ''}`), h('span', { class: 'num' }, money(i.price, r.currency))))))
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
  const setReady = async () => { if (!validate()) return; r.status = 'ready'; await persist(); selected.add(r.id); toast('Bloček je pripravený na odoslanie.'); history.back(); };
  const setDraft = async () => { r.status = 'draft'; selected.delete(r.id); await persist(); history.back(); };
  const reopen = async () => { r.status = 'ready'; r.batchId = null; r.sentAt = null; r.sentBy = null; await persist(); selected.add(r.id); go('list', {}, { replace: true }); };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Zmazať bloček?', text: 'Tento krok sa nedá vrátiť späť.', yes: 'Zmazať', no: 'Ponechať' }))) return;
    clearTimeout(saveTimer); cleanup = () => { if (photoUrl) URL.revokeObjectURL(photoUrl); };
    selected.delete(r.id); await db.del(r.id); history.back();
  };

  $app.append(
    h('header', { class: 'hero compact' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-top' },
        h('button', { class: 'ghost', onclick: () => history.back() }, '‹ Späť'),
        h('span', { class: `chip ${r.status} onhero` }, STATUS[r.status])),
      h('h1', { class: 'ttl' }, r.vendor || 'Nový bloček'))),
    h('main', { class: 'wrap content' },
      locked && h('div', { class: 'banner ok' }, `Odoslaný ${fmtDateTime(r.sentAt)}. Údaje sú zamknuté.`),
      h('div', { class: 'form' },
        lookupBanner,
        field('Predajca', 'vendor', { autocomplete: 'off' }),
        h('div', { class: 'grid2' }, field('Dátum', 'date', { type: 'date' }),
          h('div', { class: 'field' }, h('label', { for: 'f-currency' }, 'Mena'), currency)),
        h('div', { class: 'grid2' },
          field('Suma celkom', 'total', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr),
          field('z toho DPH', 'vat', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr)),
        tax, itemsBox,
        h('div', { class: 'field' }, h('label', null, 'Fotka bločku'), photoBox, errEl('photo')),
        h('div', { class: 'field' }, h('label', { for: 'f-note' }, 'Poznámka pre účtovníčku'), note),
        r.receiptId && h('p', { class: 'note' }, `ID dokladu: ${r.receiptId}`),
        !locked && h('button', { class: 'btn danger', onclick: remove }, 'Zmazať bloček'))),
    h('div', { class: 'dock' }, h('div', { class: 'wrap dock-in' },
      locked
        ? h('button', { class: 'btn primary grow', onclick: reopen }, 'Znovu otvoriť')
        : r.status === 'ready'
          ? h('button', { class: 'btn grow', onclick: setDraft }, 'Vrátiť medzi rozpracované')
          : h('button', { class: 'btn primary grow', onclick: setReady }, 'Pripravený na odoslanie'))),
    fileInput, dlg);
}

/* ---------- štart ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
history.replaceState({ view: 'list', params: {} }, '');
render({ view: 'list', params: {} });
