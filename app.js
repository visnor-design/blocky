import * as db from './db.js';
import * as api from './api.js';
import { loadBitmap, autoDetect, renderCrop, mountCropper } from './image.js';
import { buildBatch, fitBatch, shareBatch, warrantyDate, isoDate, buildIcs, KINDS } from './share.js';

const APP_VERSION = '9';

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
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const plural = (n) => (n === 1 ? 'bloček' : n >= 2 && n <= 4 ? 'bločky' : 'bločkov');
const sumBy = (rs) => {
  const t = {};
  for (const r of rs) if (r.total) t[r.currency] = (t[r.currency] || 0) + r.total;
  return Object.entries(t).map(([c, v]) => money(v, c)).join(' + ');
};

const PAY = { cash: 'Pokladňa', card: 'Karta' };
const SOURCE = { 'sk-qr': 'eKasa QR', photo: 'Fotka', manual: 'Ručne' };
const STATUS = { draft: 'Rozpracovaný', ready: 'Pripravený', sent: 'Odoslaný' };

const SKEY = 'blocky-settings';
const getSettings = () => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } };
const setSettings = (s) => { try { localStorage.setItem(SKEY, JSON.stringify(s)); } catch { /* ignoruj */ } };

function applyTheme(st) {
  document.documentElement.dataset.accent = st.accent || 'teal';
  document.documentElement.dataset.contrast = st.contrast || 'medium';
}

function newReceipt(source, extra = {}) {
  return {
    id: crypto.randomUUID(), createdAt: Date.now(), updatedAt: Date.now(),
    source, status: 'draft',
    vendor: '', address: '', unitAddress: '', ico: '', dic: '', icDph: '',
    date: today(), time: '', total: null, vat: null, currency: 'EUR', note: '',
    receiptId: null, cashRegisterCode: '', receiptNumber: null, okp: '',
    items: [], vatBreakdown: [], vatCheck: true, ekasaRaw: null, photo: null,
    warrantyYears: null,
    payment: getSettings().lastPayment || null, cardLast4: '',
    batchId: null, sentAt: null, sentBy: null, ...extra,
  };
}

/* Logo-náhrada: farebná iniciálka (bez sťahovania, nič nezaťažuje). */
function avatar(name, big = false) {
  const words = String(name || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const ini = (words[0]?.[0] || '?') + (words[1]?.[0] || '');
  let hsh = 0;
  for (const ch of String(name || '').toLowerCase()) hsh = (hsh * 31 + ch.charCodeAt(0)) % 8;
  return h('span', { class: `avatar av${hsh}${big ? ' big' : ''}`, 'aria-hidden': 'true' }, ini.toUpperCase());
}

/* Záruka */
function remaining(dt) {
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const days = Math.round((dt - now) / 864e5);
  if (days < 0) return { txt: 'vypršala', cls: 'gone', days };
  if (days === 0) return { txt: 'dnes končí', cls: 'soon', days };
  const cls = days <= 30 ? 'soon' : 'good';
  if (days >= 365) {
    const y = Math.floor(days / 365.25), mo = Math.floor((days - y * 365.25) / 30.44);
    return { txt: `zostáva ${y} r.${mo ? ' ' + mo + ' mes.' : ''}`, cls, days };
  }
  if (days > 60) return { txt: `zostáva ${Math.round(days / 30.44)} mes.`, cls, days };
  return { txt: `zostáva ${days} dní`, cls, days };
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
let filtersOpen = false;
let payFilter = 'all';        // all | cash | card
const F = { q: '', from: '', to: '', min: '', max: '' };
const selected = new Set();

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
  if (view === 'send') return viewSend(params);
  if (view === 'diag') return viewDiag();
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
const filtersActive = () => payFilter !== 'all' || Object.values(F).some(Boolean);
function passes(r) {
  if (payFilter !== 'all' && r.payment !== payFilter) return false;
  if (F.q) {
    const hay = norm(`${r.vendor} ${r.ico} ${r.note} ${r.address}`);
    if (!hay.includes(norm(F.q))) return false;
  }
  if (F.from && r.date < F.from) return false;
  if (F.to && r.date > F.to) return false;
  const mn = parseNum(F.min), mx = parseNum(F.max);
  if (mn != null && !(r.total >= mn)) return false;
  if (mx != null && !(r.total <= mx)) return false;
  return true;
}

async function viewList() {
  const items = await db.all();
  const todo = items.filter((r) => r.status !== 'sent');
  const sent = items.filter((r) => r.status === 'sent');
  const withW = items.filter((r) => r.warrantyYears && warrantyDate(r));
  const activeW = withW.filter((r) => remaining(warrantyDate(r)).days >= 0);
  const ready = todo.filter((r) => r.status === 'ready');
  const drafts = todo.filter((r) => r.status === 'draft');
  for (const id of [...selected]) if (!ready.some((r) => r.id === id && r.payment)) selected.delete(id);
  const full = () => render({ view: 'list' });

  const tab = (key, label, count) => h('button', {
    class: 'tab' + (listTab === key ? ' on' : ''), role: 'tab', 'aria-selected': String(listTab === key),
    onclick: () => { listTab = key; full(); },
  }, label, h('span', { class: 'count num' }, String(count)));

  const cnt = (n, a1, a2, a5) => (n === 1 ? a1 : n >= 2 && n <= 4 ? a2 : a5);
  const readySplit = [...['cash', 'card'].map((k) => { const rr = ready.filter((r) => r.payment === k); return rr.length ? `${PAY[k]} ${sumBy(rr)}` : null; }),
    (() => { const rr = ready.filter((r) => !r.payment); return rr.length ? `bez úhrady ${rr.length}` : null; })()].filter(Boolean).join(' · ');
  const big = listTab === 'todo'
    ? { n: ready.length, label: cnt(ready.length, 'pripravený na odoslanie', 'pripravené na odoslanie', 'pripravených na odoslanie'), amt: sumBy(ready) || '0,00 €', sub: readySplit,
        draft: `${drafts.length} ${cnt(drafts.length, 'rozpracovaný', 'rozpracované', 'rozpracovaných')}${drafts.length && sumBy(drafts) ? ' · ' + sumBy(drafts) : ''}` }
    : listTab === 'sent'
      ? { n: sent.length, label: cnt(sent.length, 'odoslaný bloček', 'odoslané bločky', 'odoslaných bločkov'), amt: sumBy(sent), sub: '', draft: '' }
      : { n: activeW.length, label: cnt(activeW.length, 'platná záruka', 'platné záruky', 'platných záruk'), amt: '', sub: `${withW.length - activeW.length} vypršaných`, draft: '' };

  const hero = h('header', { class: 'hero' }, h('div', { class: 'wrap' },
    h('div', { class: 'hero-top' },
      h('div', { class: 'brand' }, h('img', { class: 'logo', src: 'icons/logo.png', alt: 'Pastorkalt', width: '40', height: '36' }), h('h1', null, 'Bločky')),
      h('button', { class: 'ghost', onclick: openSettings }, 'Nastavenia')),
    h('div', { class: 'big' },
      h('span', { class: 'big-n num' }, String(big.n)),
      h('div', { class: 'big-main' }, h('span', { class: 'big-l' }, big.label), big.amt && h('strong', { class: 'big-amt num' }, big.amt)),
      big.sub && h('span', { class: 'big-s num' }, big.sub)),
    big.draft && h('div', { class: 'draftline num' }, big.draft),
    h('div', { class: 'tabs', role: 'tablist' }, tab('todo', 'Aktuálne', todo.length), tab('sent', 'Odoslané', sent.length), tab('warranty', 'Záruky', withW.length))));

  /* filter */
  const listBox = h('div');
  const dockBox = h('div', { class: 'dockhost' });
  const infoBox = h('p', { class: 'filterinfo num' });
  const filterBtn = h('button', { class: 'btn small', onclick: () => { filtersOpen = !filtersOpen; full(); } }, filtersOpen ? 'Skryť filter' : 'Filter' + (filtersActive() ? ' •' : ''));
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Hľadať bloček', 'aria-label': 'Hľadať' });
  search.value = F.q;
  search.addEventListener('input', () => { F.q = search.value; drawList(); });
  const fin = (label, key, attrs) => {
    const i = h('input', { id: 'flt-' + key, ...attrs }); i.value = F[key];
    i.addEventListener('input', () => { F[key] = i.value; drawList(); });
    return h('div', { class: 'field' }, h('label', { for: 'flt-' + key }, label), i);
  };
  const chipSrc = listTab === 'todo' ? todo : listTab === 'sent' ? sent : withW;
  const chip = (key, label) => {
    const n = key === 'all' ? chipSrc.length : chipSrc.filter((r) => r.payment === key).length;
    return h('button', { class: 'pchip' + (payFilter === key ? ' on' : ''), 'aria-pressed': String(payFilter === key), onclick: () => { payFilter = key; full(); } },
      label, h('span', { class: 'num' }, String(n)));
  };
  const chips = h('div', { class: 'paychips', role: 'group', 'aria-label': 'Filter podľa úhrady' }, chip('all', 'Všetko'), chip('cash', 'Pokladňa'), chip('card', 'Karta'));
  const panel = filtersOpen ? h('div', { class: 'filterpanel' },
    h('div', { class: 'grid2' }, fin('Dátum od', 'from', { type: 'date' }), fin('Dátum do', 'to', { type: 'date' })),
    h('div', { class: 'grid2' }, fin('Suma od', 'min', { inputmode: 'decimal' }), fin('Suma do', 'max', { inputmode: 'decimal' })),
    h('button', { class: 'btn small', onclick: () => { Object.keys(F).forEach((k) => (F[k] = '')); payFilter = 'all'; full(); } }, 'Vymazať filter')) : null;

  function drawDock() {
    dockBox.replaceChildren(h('div', { class: 'dock' }, h('div', { class: 'wrap dock-in' },
      h('button', { class: 'btn' + (selected.size ? '' : ' primary grow'), onclick: () => go('scan') }, '+ Skenovať'),
      selected.size > 0 && listTab === 'todo' && h('button', { class: 'btn primary grow', onclick: () => go('send', { ids: [...selected] }) }, `Odoslať (${selected.size})`))));
  }

  function drawList() {
    listBox.replaceChildren();
    const src = listTab === 'todo' ? todo : listTab === 'sent' ? sent : withW;
    const shown = src.filter(passes);
    infoBox.textContent = filtersActive() ? `Zobrazené ${shown.length} z ${src.length} · ${sumBy(shown) || '—'}` : '';
    infoBox.hidden = !filtersActive();

    if (shown.length === 0) {
      const none = src.length === 0;
      listBox.append(h('div', { class: 'paper' }, h('div', { class: 'empty' },
        h('strong', null, none ? (listTab === 'todo' ? 'Zatiaľ tu nie sú žiadne bločky' : listTab === 'sent' ? 'Zatiaľ nič nebolo odoslané' : 'Zatiaľ nemáš žiadne záruky') : 'Filtru nezodpovedá žiadny bloček'),
        h('p', null, none ? (listTab === 'todo' ? 'Naskenuj QR kód zo slovenského bločku alebo odfoť zahraničný doklad.' : listTab === 'sent' ? 'Po odoslaní emailom sa tu zobrazí história po dávkach.' : 'Záruku pridáš v detaile bločku.') : 'Zmeň alebo vymaž filter.'))));
    } else if (listTab === 'todo') {
      const rdy = shown.filter((r) => r.status === 'ready' && r.payment);
      if (rdy.length > 1) {
        const all = rdy.every((r) => selected.has(r.id));
        listBox.append(h('div', { class: 'selbar' },
          h('span', { class: 'num' }, `Vybrané: ${selected.size}`),
          h('button', { class: 'linkbtn', onclick: () => { all ? rdy.forEach((r) => selected.delete(r.id)) : rdy.forEach((r) => selected.add(r.id)); drawList(); } }, all ? 'Zrušiť výber' : 'Vybrať všetky')));
      }
      listBox.append(h('div', { class: 'paper' }, shown.map((r) => rowEl(r, { selectable: true, redraw: drawList }))));
    } else if (listTab === 'sent') {
      const batches = new Map();
      for (const r of shown) { const k = r.batchId || 'bez-davky'; (batches.get(k) || batches.set(k, []).get(k)).push(r); }
      [...batches.values()].sort((a, b) => b[0].sentAt - a[0].sentAt).forEach((rs) => {
        listBox.append(h('section', { class: 'batch' },
          h('h2', null, `${fmtDateTime(rs[0].sentAt)}${rs[0].payment ? ' · ' + PAY[rs[0].payment] : ''}`),
          h('p', { class: 'meta num' }, `${rs.length} ${plural(rs.length)} · ${sumBy(rs)}${rs[0].sentBy ? ' · ' + rs[0].sentBy : ''}`),
          h('div', { class: 'paper' }, rs.map((r) => rowEl(r, {})))));
      });
    } else {
      const sorted = [...shown].sort((a, b) => {
        const ea = warrantyDate(a), eb = warrantyDate(b), ga = ea < new Date(), gb = eb < new Date();
        return ga !== gb ? ga - gb : ga ? eb - ea : ea - eb;
      });
      listBox.append(h('div', { class: 'paper' }, sorted.map((r) => rowEl(r, { warranty: true }))));
    }
    drawDock();
  }

  $app.append(hero,
    h('main', { class: 'wrap content' }, installBanner(full),
      h('div', { class: 'filterbar' }, search, filterBtn), chips, panel, infoBox, listBox),
    dockBox);
  drawList();
}

function rowEl(r, { selectable = false, redraw = null, warranty = false } = {}) {
  let pick = null;
  if (selectable && r.status === 'ready' && r.payment) {
    const i = h('input', { type: 'checkbox' });
    i.checked = selected.has(r.id);
    i.addEventListener('change', () => { i.checked ? selected.add(r.id) : selected.delete(r.id); redraw(); });
    pick = h('label', { class: 'pick', 'aria-label': 'Vybrať na odoslanie' }, i);
  }
  let meta = fmtDate(r.date);
  let chip = h('span', { class: `chip ${r.status}` }, STATUS[r.status]);
  if (warranty) {
    const w = warrantyDate(r), rem = remaining(w);
    meta = `Záruka do ${fmtDate(isoDate(w))}`;
    chip = h('span', { class: `chip ${rem.cls}` }, rem.txt);
  }
  return h('div', { class: 'row' }, pick, avatar(r.vendor),
    h('button', { class: 'main', onclick: () => go('form', { id: r.id }) },
      h('span', { class: 'vendor' }, r.vendor || 'Bez názvu'),
      h('span', { class: 'amount num' }, money(r.total, r.currency)),
      h('span', { class: 'meta' }, meta,
        !warranty && r.payment && [' · ', h('span', { class: `pay ${r.payment}` }, PAY[r.payment])],
        !warranty && !r.payment && r.status !== 'sent' && [' · ', h('span', { class: 'pay none' }, 'bez úhrady')]), chip));
}

/* ---------- nastavenia ---------- */
function openSettings() {
  const st = getSettings();
  const name = h('input', { id: 's-name', autocomplete: 'name', placeholder: 'Meno a priezvisko' }); name.value = st.name || '';
  const to = h('input', { id: 's-to', type: 'email', autocomplete: 'off', placeholder: 'blocky@firma.sk' }); to.value = st.to || '';
  const url = h('input', { id: 's-url', type: 'url', autocomplete: 'off', placeholder: 'https://moj-proxy.workers.dev (nepovinné)' }); url.value = st.lookupUrl || '';
  const enh = h('input', { id: 's-enh', type: 'checkbox' }); enh.checked = st.enhance !== false;
  const auto = h('input', { id: 's-auto', type: 'checkbox' }); auto.checked = st.autoPhoto !== false;
  const radio = (group, val, title, sub, cur, onpick) => {
    const i = h('input', { type: 'radio', name: group, value: val }); i.checked = cur === val;
    if (onpick) i.addEventListener('change', onpick);
    return h('label', { class: 'radio' }, i, h('span', null, title, sub && h('small', null, sub)));
  };
  let accent = st.accent || 'teal', contrast = st.contrast || 'medium';
  const preview = () => applyTheme({ accent, contrast });
  const COLORS = [['teal', 'Tyrkysová'], ['blue', 'Modrá'], ['violet', 'Fialová'], ['green', 'Zelená'], ['terracotta', 'Terakota'], ['graphite', 'Grafit']];
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Farba' }, COLORS.map(([k, label]) => {
    const i = h('input', { type: 'radio', name: 'accent', value: k, 'aria-label': label }); i.checked = accent === k;
    i.addEventListener('change', () => { accent = k; preview(); });
    return h('label', { class: `swatch sw-${k}`, title: label }, i);
  }));
  const d = openDialog(h('div', { class: 'dlg-body' },
    h('h2', null, 'Nastavenia'),
    h('div', { class: 'form' },
      h('div', { class: 'field' }, h('label', { for: 's-name' }, 'Tvoje meno'), name),
      h('div', { class: 'field' }, h('label', { for: 's-to' }, 'Email účtovníčky'), to),
      h('div', { class: 'field' }, h('label', null, 'Výraznosť vzhľadu'),
        radio('contrast', 'strong', 'Výrazná', 'Hrubé obrysy, silný kontrast', contrast, () => { contrast = 'strong'; preview(); }),
        radio('contrast', 'medium', 'Stredná', 'Tenšie obrysy', contrast, () => { contrast = 'medium'; preview(); }),
        radio('contrast', 'soft', 'Jemná', 'Tenké linky, podobné detailu dokladu', contrast, () => { contrast = 'soft'; preview(); })),
      h('div', { class: 'field' }, h('label', null, 'Farba'), swatches),
      h('div', { class: 'field' }, h('label', null, 'Spôsob odoslania'),
        radio('sendmode', 'share', 'Zdieľať s prílohami', 'Otvorí zoznam aplikácií (Mail, Outlook, Gmail). Prílohy sú pripojené automaticky.', st.sendMode || 'share'),
        radio('sendmode', 'mailto', 'Stiahnuť súbory a otvoriť predvolenú poštu', 'Otvorí sa predvolená pošta s adresátom, prílohy pridáš ručne zo stiahnutých súborov.', st.sendMode || 'share')),
      h('div', { class: 'field' }, h('label', { for: 's-url' }, 'Adresa servera pre eKasa'), url,
        h('span', { class: 'note' }, 'Potrebné, ak telefón údaje zo slovenského bločku nevie načítať priamo.')),
      h('label', { class: 'check' }, auto, h('span', null, 'Po naskenovaní QR kódu hneď odfotiť bloček')),
      h('label', { class: 'check' }, enh, h('span', null, 'Zvýrazniť text na fotke (menší súbor, lepšie čitateľný)'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', onclick: () => {
        const u = url.value.trim();
        if (u && !/^https:\/\//i.test(u)) return toast('Adresa servera musí začínať https://');
        const sm = d.querySelector('input[name=sendmode]:checked')?.value || 'share';
        const next = { ...st, name: name.value.trim(), to: to.value.trim(), lookupUrl: u, sendMode: sm, enhance: enh.checked, autoPhoto: auto.checked, accent, contrast };
        setSettings(next); applyTheme(next); d.close(); toast('Nastavenia uložené.');
      } }, 'Uložiť'),
      h('button', { class: 'btn', onclick: () => d.close() }, 'Zrušiť')),
    h('div', { class: 'verline' },
      h('span', { class: 'meta' }, `Verzia ${APP_VERSION}`),
      h('button', { class: 'linkbtn', onclick: () => { d.close(); go('diag'); } }, 'Diagnostika odosielania'),
      h('button', { class: 'linkbtn', onclick: async () => {
        try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch { /* offline */ }
        location.reload();
      } }, 'Skontrolovať aktualizáciu'))));
  d.addEventListener('close', () => applyTheme(getSettings()));   // zrušenie vráti pôvodný vzhľad
}

/* ---------- odoslanie emailom ---------- */
async function viewSend({ ids = [], resend = false } = {}) {
  const all = await db.all();
  const picked = all.filter((r) => ids.includes(r.id) && (resend ? r.status === 'sent' : r.status === 'ready'));
  if (!picked.length) { toast('Nie je čo odoslať.'); return history.back(); }
  const st = getSettings();
  const mailto = st.sendMode === 'mailto';
  const noPay = picked.filter((r) => !r.payment);

  // Pokladňa a karta idú v samostatných emailoch (jeden email = jeden cieľ v portáli).
  const groups = ['cash', 'card'].map((kind) => {
    const list = picked.filter((r) => r.payment === kind);
    if (!list.length) return null;
    let batch, rs = list, trimmed = 0, nFiles;
    if (mailto) { batch = buildBatch(list, st, kind); nFiles = batch.altFiles.length; }
    else {
      const fit = fitBatch(list, st, kind);       // Android: max 10 príloh naraz
      batch = fit.batch; nFiles = fit.count_files; trimmed = list.length - fit.count; rs = list.slice(0, fit.count);
    }
    return { kind, rs, batch, nFiles, trimmed };
  }).filter(Boolean);
  if (!groups.length) { toast('Pri vybraných bločkoch chýba spôsob úhrady. Otvor ich a vyber pokladňu alebo kartu.', 5000); return history.back(); }

  async function doSend(g) {
    let res;
    try { res = await shareBatch({ ...g.batch, to: st.to, mode: st.sendMode }); }   // hneď po kliknutí
    catch (e) { return toast(`Odoslanie zlyhalo: ${e.name || ''} ${e.message || ''}`, 8000); }
    if (res.status === 'cancelled') return;
    if (res.note) toast(res.note, 6000);
    const ok = await confirmDialog({
      title: 'Odoslal si email?',
      text: res.status === 'fallback'
        ? `${res.failure ? `Zdieľanie zlyhalo (${res.failure}). ` : ''}Súbory sa stiahli a otvorila sa pošta. Pripoj stiahnuté súbory k emailu a odošli ho. Potom bločky označím ako odoslané.`
        : `Ak si email (${KINDS[g.kind].title}) odoslal, označím tieto bločky ako odoslané.`,
      yes: 'Áno, odoslané', no: 'Nie, ešte nie',
    });
    if (!ok) return;
    const batchId = crypto.randomUUID(), sentAt = Date.now();
    for (const r of g.rs) { r.status = 'sent'; r.batchId = batchId; r.sentAt = sentAt; r.sentBy = st.name || ''; selected.delete(r.id); await db.put(r); }
    toast('Označené ako odoslané.');
    const rest = resend ? [] : picked.filter((r) => r.status === 'ready' && r.payment);
    if (rest.length) {       // ďalší email (druhý druh úhrady alebo zvyšok)
      const next = { view: 'send', params: { ids: rest.map((r) => r.id), resend: false } };
      history.replaceState(next, ''); render(next);
    } else history.back();
  }

  $app.append(
    h('header', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-top' }, h('button', { class: 'ghost', onclick: () => history.back() }, '‹ Späť'), h('h1', { class: 'sm' }, 'Odoslať emailom')))),
    h('main', { class: 'wrap content' },
      h('div', { class: 'addr' },
        h('div', null, h('div', { class: 'meta' }, 'Adresát'), h('strong', null, st.to || 'nie je nastavený (Nastavenia)')),
        st.to && h('button', { class: 'btn small', onclick: async () => { try { await navigator.clipboard.writeText(st.to); toast('Adresa skopírovaná.'); } catch { toast('Adresu sa nepodarilo skopírovať.'); } } }, 'Kopírovať')),
      noPay.length > 0 && h('p', { class: 'banner' }, `${noPay.length} ${plural(noPay.length)} nemá spôsob úhrady, preto sa neodošle. Otvor ho a vyber pokladňu alebo kartu.`),
      groups.map((g) => h('section', { class: 'sendgroup' },
        h('h3', null, `${PAY[g.kind]} · ${g.rs.length} ${plural(g.rs.length)}`),
        h('p', { class: 'num meta' }, `${g.batch.sum} · ${g.nFiles} príloh · ${kb(g.batch.totalBytes)}`),
        g.trimmed > 0 && h('p', { class: 'banner' }, `Tento telefón dovolí poslať naraz najviac ${g.rs.length} ${plural(g.rs.length)}. Ďalších ${g.trimmed} ostane na ďalší email.`),
        g.batch.totalBytes > 20 * 1048576 && h('p', { class: 'banner' }, 'Prílohy majú viac ako 20 MB. Niektoré pošty ich neodošlú. Rozdeľ odosielanie na menej bločkov.'),
        h('button', { class: 'btn primary', onclick: () => doSend(g) }, `${mailto ? 'Stiahnuť a otvoriť poštu' : 'Odoslať'}: ${PAY[g.kind]} (${g.rs.length})`))),
      h('p', { class: 'note' }, mailto
        ? 'Súbory sa stiahnu a otvorí sa predvolená pošta s adresátom. Pripoj stiahnuté súbory a email odošli.'
        : 'Otvorí sa zoznam aplikácií so všetkými prílohami. Vyber poštu, vlož adresu a odošli zo svojho účtu.')));
}

/* Diagnostika odosielania: pomôže zistiť, čo telefón povoľuje */
function viewDiag() {
  const can = (name, type) => {
    try { return navigator.canShare?.({ files: [new File(['x'], name, { type })] }) ? 'áno' : 'nie'; } catch (e) { return `chyba (${e.name})`; }
  };
  const rows = [
    ['Zdieľanie (share)', navigator.share ? 'áno' : 'nie'],
    ['Zdieľanie súborov (canShare)', navigator.canShare ? 'áno' : 'nie'],
    ['Fotka .jpg', can('a.jpg', 'image/jpeg')], ['Súhrn .csv', can('a.csv', 'text/csv')],
    ['Text .txt', can('a.txt', 'text/plain')], ['Údaje .json', can('a.json', 'application/json')],
    ['Appka na ploche', (matchMedia('(display-mode: standalone)').matches || navigator.standalone) ? 'áno' : 'nie'],
    ['Verzia appky', APP_VERSION], ['Prehliadač', navigator.userAgent.slice(0, 100)],
  ];
  $app.append(
    h('header', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-top' }, h('button', { class: 'ghost', onclick: () => history.back() }, '‹ Späť'), h('h1', { class: 'sm' }, 'Diagnostika')))),
    h('main', { class: 'wrap content' },
      h('dl', { class: 'kv' }, rows.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v)))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: async () => {
          try { await navigator.share({ files: [new File(['Skúška zdieľania z appky Bločky'], 'skuska.txt', { type: 'text/plain' })], title: 'Skúška zdieľania' }); toast('Zdieľanie funguje.'); }
          catch (e) { toast(e.name === 'AbortError' ? 'Zrušené.' : `Zdieľanie zlyhalo: ${e.name} ${e.message || ''}`, 8000); }
        } }, 'Vyskúšať zdieľanie'))));
}

/* ---------- skener ---------- */
function viewScan() {
  let active = true, stream = null, raf = 0, busy = false;
  let rcpt = null;                 // bloček uložený po QR, ku ktorému sa pridá fotka
  const video = h('video', { playsinline: true, autoplay: true });
  video.muted = true;
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const hint = h('div', { class: 'hint' });
  const frame = h('div', { class: 'frame' });
  const barBox = h('div', { class: 'bar' });
  const overlay = h('div', { class: 'scan' });
  const stopStream = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  const onVis = () => {          // po návrate z fotoaparátu telefónu sa kamera v appke znova spustí
    if (document.visibilityState === 'visible' && active && (!stream || stream.getVideoTracks()[0]?.readyState !== 'live')) startCamera();
  };
  const stop = () => { active = false; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis); stopStream(); };
  cleanup = stop;
  document.addEventListener('visibilitychange', onVis);

  const toCrop = async (bmp) => {
    pending = { bmp, target: rcpt ? rcpt.id : null, next: rcpt ? 'form' : null };
    stop(); go('crop', {}, { replace: true });
  };
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0];
    if (!f) return;
    busy = true; hint.textContent = 'Načítavam fotku…';
    try { await toCrop(await loadBitmap(f)); }
    catch { busy = false; hint.textContent = 'Fotku sa nepodarilo načítať. Skús znova.'; }
  });

  const manual = async () => { const r = newReceipt('manual'); await db.put(r); stop(); go('form', { id: r.id }, { replace: true }); };
  const openForm = (r) => { stop(); go('form', { id: r.id }, { replace: true }); };

  // Fotka z živej kamery. Na Androide v plnom rozlíšení fotoaparátu, inak snímka z videa.
  async function capture() {
    const track = stream?.getVideoTracks()[0];
    if (!track || !video.videoWidth) return toast('Kamera ešte nie je pripravená.');
    if (navigator.vibrate) navigator.vibrate(40);
    try {
      if (window.ImageCapture) {
        try { return await toCrop(await loadBitmap(await new ImageCapture(track).takePhoto())); } catch { /* skúsime snímku z videa */ }
      }
      const c = document.createElement('canvas');
      c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      await toCrop(await createImageBitmap(c));
    } catch { toast('Fotku sa nepodarilo vytvoriť.'); }
  }

  const PHOTO_HINT = 'Odfoť bloček zblízka, na celú výšku.';
  function setMode(mode, msg) {
    const photo = mode === 'photo';
    busy = photo;
    frame.className = 'frame' + (photo ? ' tall' : '');
    hint.className = 'hint' + (photo ? ' top' : '');
    hint.textContent = msg || (photo ? PHOTO_HINT : 'Namier kameru na QR kód na bločku');
    barBox.replaceChildren(...(photo
      ? [h('button', { class: 'btn signal', onclick: capture }, 'Odfotiť bloček'),
         h('div', { class: 'barrow' },
           h('button', { class: 'btn small', onclick: () => fileInput.click() }, 'Fotoaparát'),
           rcpt ? h('button', { class: 'btn small', onclick: () => openForm(rcpt) }, 'Preskočiť')
                : h('button', { class: 'btn small', onclick: () => setMode('qr') }, 'Späť na QR'))]
      : [h('button', { class: 'btn signal', onclick: () => setMode('photo') }, 'Odfotiť zahraničný bloček'),
         h('button', { class: 'btn', onclick: manual }, 'Zadať ručne')]));
  }

  async function onCode(text) {
    busy = true;
    if (navigator.vibrate) navigator.vibrate(60);
    const rid = api.parseEkasaQr(text);
    if (!rid) {
      hint.textContent = 'Toto nie je QR kód slovenského bločku. Skús iný alebo odfoť bloček.';
      setTimeout(() => { if (!rcpt && !hint.classList.contains('top')) busy = false; hint.textContent = 'Namier kameru na QR kód na bločku'; }, 2200);
      return;
    }
    const dup = await db.findByReceiptId(rid);
    if (dup) { stop(); toast('Tento bloček už máš uložený.'); return go('form', { id: dup.id }, { replace: true }); }
    hint.textContent = 'Načítavam údaje z eKasa…';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    const res = await api.lookupEkasa(rid, { signal: ctl.signal, url: getSettings().lookupUrl || undefined });
    clearTimeout(t);
    const r = newReceipt('sk-qr', { receiptId: rid });
    if (res.ok) Object.assign(r, res.data, { lookup: 'ok' }); else r.lookup = res.reason;
    await db.put(r);
    rcpt = r;
    if (getSettings().autoPhoto !== false && active) {
      setMode('photo', `${res.ok ? 'Údaje načítané.' : 'QR kód uložený.'} ${PHOTO_HINT}`);
    } else openForm(r);
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

  const close = h('button', { class: 'btn small close', onclick: () => history.back() }, 'Zavrieť');
  overlay.append(video, h('div', { class: 'scanbody' }, frame, hint), close, barBox, fileInput);
  $app.append(overlay);
  setMode('qr');

  const cameraError = (text) => {
    hint.textContent = '';
    overlay.querySelector('.msg')?.remove();
    overlay.append(h('div', { class: 'msg' }, h('strong', null, 'Kamera nie je dostupná'), h('span', null, text),
      h('button', { class: 'btn signal', onclick: () => fileInput.click() }, 'Odfotiť bloček'),
      h('button', { class: 'btn', onclick: manual }, 'Zadať ručne'),
      h('button', { class: 'btn', onclick: () => history.back() }, 'Späť')));
  };
  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) return cameraError('Tento prehliadač nepodporuje prístup ku kamere.');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false });
      if (!active) { s.getTracks().forEach((t) => t.stop()); return; }
      stopStream(); stream = s; video.srcObject = s;
      await video.play();
      overlay.querySelector('.msg')?.remove();
      cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    } catch (e) {
      cameraError(e.name === 'NotAllowedError'
        ? 'Aplikácia nemá povolenú kameru. Povoľ ju v nastaveniach prehliadača a skús znova.'
        : 'Kameru sa nepodarilo spustiť.');
    }
  }
  startCamera();
}

/* ---------- orezanie fotky ---------- */
function viewCrop() {
  if (!pending) return go('list', {}, { replace: true });
  const { bmp, target, next } = pending;
  let enhance = getSettings().enhance !== false;
  const stage = h('div', { class: 'stage' });
  const cropper = mountCropper(stage, bmp, autoDetect(bmp));
  cleanup = () => cropper.destroy();
  const backToForm = () => go('form', { id: target }, { replace: true });

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
        next === 'form' ? backToForm() : history.back();
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
      h('button', { class: 'btn', onclick: () => { pending = null; next === 'form' ? backToForm() : history.back(); } }, next === 'form' ? 'Preskočiť fotku' : 'Zrušiť'))));
}

/* ---------- detail bločku ---------- */
const RETRY_TEXT = {
  network: 'Telefón sa nevie spojiť s finančnou správou. Najčastejšie to blokuje prehliadač (CORS) alebo nie si online. Zadaj v Nastaveniach adresu servera.',
  timeout: 'Finančná správa neodpovedala včas.',
  not_found: 'Finančná správa tento doklad nenašla. Skontroluj, či je QR kód celý.',
};

async function viewForm(id) {
  const r = await db.get(id);
  if (!r) { toast('Bloček sa nenašiel.'); return go('list', {}, { replace: true }); }
  const locked = r.status === 'sent';
  const official = r.source === 'sk-qr' && r.lookup === 'ok';
  let editing = !official;       // údaje zo štátu sú predvolene len na čítanie
  let showAllItems = false;
  let saveTimer;
  const persist = () => { clearTimeout(saveTimer); r.updatedAt = Date.now(); return db.put(r); };
  const autosave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(persist, 400); };
  let photoUrl = r.photo ? URL.createObjectURL(r.photo) : null;
  cleanup = () => { persist(); if (photoUrl) URL.revokeObjectURL(photoUrl); };

  const head = h('div', { class: 'detail-head' });
  const body = h('div');
  const errs = {};
  const errEl = (k) => (errs[k] = h('div', { class: 'err' }));

  function drawHead() {
    head.replaceChildren(avatar(r.vendor, true),
      h('div', { class: 'who' }, h('h1', { class: 'ttl' }, r.vendor || 'Nový bloček'),
        h('div', { class: 'meta' }, `${fmtDate(r.date)}${r.time ? ' ' + r.time.slice(0, 5) : ''} · ${SOURCE[r.source]}`)),
      h('div', { class: 'tot' }, h('span', null, 'Celková suma'), h('strong', { class: 'num' }, money(r.total, r.currency))));
  }

  const field = (label, key, attrs = {}, parse = (v) => v, show = (v) => v ?? '') => {
    const input = h('input', { id: 'f-' + key, ...attrs, disabled: locked, value: show(r[key]) });
    input.addEventListener('input', () => { r[key] = parse(input.value); autosave(); drawHead(); });
    return h('div', { class: 'field' }, h('label', { for: 'f-' + key }, label), input, errEl(key));
  };
  const kv = (rows) => h('dl', { class: 'kv' }, rows.filter(([, v]) => v !== '' && v != null).map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, v))));

  /* fotka */
  const fileInput = h('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files[0]; if (!f) return;
    try { await persist(); pending = { bmp: await loadBitmap(f), target: r.id }; go('crop'); }
    catch { toast('Fotku sa nepodarilo načítať.'); }
  });
  /* eKasa: opakované načítanie */
  async function retry(btn) {
    btn.disabled = true; btn.textContent = 'Načítavam…';
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const res = await api.lookupEkasa(r.receiptId, { signal: ctl.signal, url: getSettings().lookupUrl || undefined });
    clearTimeout(t);
    if (res.ok) { Object.assign(r, res.data, { lookup: 'ok' }); await persist(); toast('Údaje načítané.'); return render({ view: 'form', params: { id: r.id } }); }
    r.lookup = res.reason; await persist(); btn.disabled = false; btn.textContent = 'Skúsiť znova';
    toast('Údaje sa nepodarilo načítať.');
    drawBody();
  }

  const yrs = (n) => `${n} ${n === 1 ? 'rok' : n >= 2 && n <= 4 ? 'roky' : 'rokov'}`;
  const pill = (label, value, onclick, off) => h('button', { class: 'pill', onclick, disabled: off }, h('span', { class: 'pl' }, label), h('span', { class: 'pv' }, value));
  const addTxt = () => h('span', { class: 'add' }, locked ? '—' : 'Pridať');

  /* okno: záruka */
  function openWarrantyDialog() {
    let years = r.warrantyYears || 2;                 // predvolene 2 roky
    let custom = !([1, 2, 3].includes(years));
    const segBox = h('div');
    const until = h('p', { class: 'meta' });
    const paintUntil = () => {
      const w = warrantyDate({ ...r, warrantyYears: years });
      until.textContent = w ? `Platí do ${fmtDate(isoDate(w))} (${remaining(w).txt}). Počíta sa od dátumu bločku, ${fmtDate(r.date)}.` : '';
    };
    const paintSeg = () => {
      segBox.replaceChildren(h('div', { class: 'seg' },
        [1, 2, 3].map((y) => h('button', { class: !custom && years === y ? 'on' : '', disabled: locked, onclick: () => { custom = false; years = y; paintSeg(); } }, yrs(y))),
        h('button', { class: custom ? 'on' : '', disabled: locked, onclick: () => { custom = true; paintSeg(); } }, 'Iné')));
      if (custom) {
        const yi = h('input', { type: 'number', min: '1', max: '30', step: '1', inputmode: 'numeric', 'aria-label': 'Počet rokov', disabled: locked });
        yi.value = String(years);
        yi.addEventListener('input', () => { const n = parseInt(yi.value, 10); if (n >= 1 && n <= 30) { years = n; paintUntil(); } });
        segBox.append(h('div', { class: 'seg gap' }, yi, h('span', { class: 'meta' }, 'rokov')));
      }
      paintUntil();
    };
    paintSeg();
    const d = openDialog(h('div', { class: 'dlg-body' }, h('h2', null, 'Záruka'), segBox, until,
      h('div', { class: 'actions' },
        !locked && h('button', { class: 'btn primary', onclick: async () => { r.warrantyYears = years; await persist(); d.close(); drawBody(); } }, 'Uložiť'),
        h('button', { class: 'btn small', onclick: async () => {
          const f = buildIcs({ ...r, warrantyYears: years }); if (!f) return;
          if (navigator.canShare?.({ files: [f] })) { try { await navigator.share({ files: [f], title: f.name }); } catch { /* zrušené */ } }
          else { const a = h('a', { href: URL.createObjectURL(f), download: f.name }); document.body.append(a); a.click(); a.remove(); }
        } }, 'Pripomenúť v kalendári'),
        !locked && r.warrantyYears && h('button', { class: 'btn small danger', onclick: async () => { r.warrantyYears = null; await persist(); d.close(); drawBody(); } }, 'Odstrániť záruku'),
        h('button', { class: 'btn small', onclick: () => d.close() }, 'Zavrieť'))));
  }

  /* okno: poznámka */
  function openNoteDialog() {
    const ta = h('textarea', { 'aria-label': 'Poznámka pre účtovníčku', placeholder: 'Napíš poznámku pre účtovníčku', disabled: locked }); ta.value = r.note || '';
    const d = openDialog(h('div', { class: 'dlg-body' }, h('h2', null, 'Poznámka pre účtovníčku'), ta,
      h('div', { class: 'actions' },
        !locked && h('button', { class: 'btn primary', onclick: async () => { r.note = ta.value.trim(); await persist(); d.close(); drawBody(); } }, 'Uložiť'),
        !locked && r.note && h('button', { class: 'btn small danger', onclick: async () => { r.note = ''; await persist(); d.close(); drawBody(); } }, 'Vymazať poznámku'),
        h('button', { class: 'btn small', onclick: () => d.close() }, 'Zavrieť'))));
    if (!locked) ta.focus();
  }

  /* okno: fotka */
  function openPhotoDialog() {
    const d = openDialog(h('div', { class: 'dlg-body' }, h('h2', null, 'Fotka bločku'),
      photoUrl && h('img', { class: 'bigphoto', src: photoUrl, alt: 'Fotka bločku' }),
      photoUrl && h('p', { class: 'meta num' }, kb(r.photo.size)),
      h('div', { class: 'actions' },
        !locked && h('button', { class: 'btn primary', onclick: () => { d.close(); fileInput.click(); } }, photoUrl ? 'Zmeniť fotku' : 'Pridať fotku'),
        !locked && photoUrl && h('button', { class: 'btn small danger', onclick: async () => { URL.revokeObjectURL(photoUrl); photoUrl = null; r.photo = null; await persist(); d.close(); drawBody(); } }, 'Odstrániť fotku'),
        h('button', { class: 'btn small', onclick: () => d.close() }, 'Zavrieť'))));
  }

  function pillsSec() {
    const w = warrantyDate(r);
    return h('section', { class: 'pills' },
      pill('Záruka', r.warrantyYears && w ? h('span', null, `${yrs(r.warrantyYears)} · do ${fmtDate(isoDate(w))}`) : addTxt(), openWarrantyDialog, locked && !r.warrantyYears),
      pill('Poznámka', r.note ? h('span', { class: 'clip' }, r.note) : addTxt(), openNoteDialog, locked && !r.note),
      pill('Fotka bločku', photoUrl ? [h('img', { class: 'minithumb', src: photoUrl, alt: '' }), h('span', { class: 'num' }, kb(r.photo.size))] : addTxt(),
        () => (photoUrl || locked ? openPhotoDialog() : fileInput.click()), locked && !photoUrl),
      errEl('photo'));
  }

  /* Spôsob úhrady: pokladňa (hotovosť) alebo platba kartou */
  function paySec() {
    const sec = h('section', { class: 'sec' }, h('h3', null, 'Spôsob úhrady'));
    const mk = (k, title, sub) => h('button', {
      class: r.payment === k ? 'on' : '', role: 'radio', 'aria-checked': String(r.payment === k), disabled: locked,
      onclick: async () => {
        r.payment = k; if (k !== 'card') r.cardLast4 = '';
        setSettings({ ...getSettings(), lastPayment: k });   // nabudúce sa predvolí posledná voľba
        await persist(); drawBody();
      },
    }, h('span', null, title), h('small', null, sub));
    sec.append(h('div', { class: 'paysel', role: 'radiogroup', 'aria-label': 'Spôsob úhrady' }, mk('cash', 'Pokladňa', 'hotovosť'), mk('card', 'Karta', 'platba kartou')));
    if (r.payment === 'card') {
      const i = h('input', { id: 'f-last4', inputmode: 'numeric', placeholder: 'napr. 1234', autocomplete: 'off', disabled: locked }); i.value = r.cardLast4 || '';
      i.addEventListener('input', () => { r.cardLast4 = i.value.replace(/\D/g, '').slice(0, 4); if (i.value !== r.cardLast4) i.value = r.cardLast4; autosave(); });
      sec.append(h('div', { class: 'field gap' }, h('label', { for: 'f-last4' }, 'Posledné 4 číslice karty (nepovinné)'), i));
    }
    sec.append(errEl('payment'));
    return sec;
  }

  /* Sumy a DPH: celková zaplatená suma + rozpis podľa sadzieb */
  function amountsSec() {
    const sec = h('section', { class: 'sec' }, h('h3', null, 'Sumy a DPH'));
    if (editing) {
      sec.append(h('div', { class: 'form' },
        field('Celkom zaplatené', 'total', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr),
        h('div', { class: 'grid2' },
          field('z toho DPH', 'vat', { inputmode: 'decimal', autocomplete: 'off' }, parseNum, numToStr),
          r.source === 'sk-qr'
            ? h('div', { class: 'field' }, h('label', null, 'Mena'), h('div', { class: 'fixedcur' }, 'EUR'))
            : (() => {
                const c = h('select', { id: 'f-currency', disabled: locked }, ['EUR', 'CZK', 'PLN', 'HUF', 'USD', 'GBP', 'CHF'].map((x) => h('option', { value: x }, x)));
                c.value = r.currency; c.addEventListener('change', () => { r.currency = c.value; autosave(); drawHead(); });
                return h('div', { class: 'field' }, h('label', { for: 'f-currency' }, 'Mena'), c);
              })())));
    } else {
      sec.append(h('div', { class: 'paid' }, h('span', null, 'Celkom zaplatené'), h('strong', { class: 'num' }, money(r.total, r.currency))));
      if (!r.vatBreakdown?.length && r.vat != null) sec.append(kv([['z toho DPH', money(r.vat, r.currency)]]));
    }
    if (r.vatBreakdown?.length) {
      const sb = r.vatBreakdown.reduce((x, b) => x + b.base, 0), sv = r.vatBreakdown.reduce((x, b) => x + b.vat, 0);
      sec.append(h('table', { class: 'vat num' },
        h('thead', null, h('tr', null, h('th', null, 'Sadzba'), h('th', null, 'Bez DPH'), h('th', null, 'DPH'), h('th', null, 'S DPH'))),
        h('tbody', null, r.vatBreakdown.map((b) => h('tr', null, h('td', null, `${b.rate} %`), h('td', null, money(b.base, r.currency)), h('td', null, money(b.vat, r.currency)), h('td', null, money(b.base + b.vat, r.currency))))),
        r.vatBreakdown.length > 1 && h('tfoot', null, h('tr', null, h('td', null, 'Spolu'), h('td', null, money(sb, r.currency)), h('td', null, money(sv, r.currency)), h('td', null, money(sb + sv, r.currency))))));
    }
    return sec;
  }

  function drawBody() {
    body.replaceChildren();
    const sections = [];

    if (r.source === 'sk-qr') {
      sections.push(official
        ? h('div', { class: 'banner ok' }, 'Údaje boli načítané z finančnej správy.')
        : h('div', { class: 'banner' }, RETRY_TEXT[r.lookup] || 'Údaje z eKasa sa nepodarilo načítať. Doplň ich ručne alebo skús znova.',
            !locked && h('button', { class: 'btn small', onclick: (e) => retry(e.currentTarget) }, 'Skúsiť znova')));
    }
    if (official && r.vatCheck === false) sections.push(h('div', { class: 'banner' }, 'Súčet položiek nesedí s celkovou sumou. Skontroluj rozpis DPH.'));

    sections.push(paySec());

    /* Obchodník + dátum */
    if (editing) {
      sections.push(h('section', { class: 'sec form' },
        field('Predajca', 'vendor', { autocomplete: 'off' }),
        field('Adresa predajcu', 'address', { autocomplete: 'off' }),
        field('Dátum', 'date', { type: 'date' })));
    } else {
      sections.push(h('section', { class: 'sec' }, h('h3', null, 'Obchodník'),
        h('strong', null, r.vendor), r.address && h('div', { class: 'meta' }, r.address),
        h('h3', { class: 'gap' }, 'Dátum a čas vyhotovenia'),
        h('div', null, `${fmtDate(r.date)}${r.time ? ' ' + r.time : ''}`),
        !locked && h('div', { class: 'foot' }, h('button', { class: 'linkbtn', onclick: () => { editing = true; drawBody(); } }, 'Upraviť údaje'))));
    }

    sections.push(amountsSec());

    if (r.items?.length) {
      const list = showAllItems ? r.items : r.items.slice(0, 5);
      sections.push(h('section', { class: 'sec' }, h('h3', null, `Položky (${r.items.length})`),
        h('ul', { class: 'itemlist' }, list.map((i) => h('li', { class: i.total < 0 ? 'neg' : '' },
          h('div', { class: 'nm' }, i.name),
          h('div', { class: 'ln num' }, h('span', null, `${String(i.qty).replace('.', ',')} × ${money(i.unit, r.currency)}${i.vatRate ? ` · DPH ${i.vatRate} %` : ''}`), h('span', null, money(i.total, r.currency)))))),
        r.items.length > 5 && h('div', { class: 'foot' }, h('button', { class: 'linkbtn', onclick: () => { showAllItems = !showAllItems; drawBody(); } }, showAllItems ? 'Zobraziť menej' : `Zobraziť ďalšie položky (${r.items.length - 5})`))));
    }

    /* Ostatné údaje */
    const other = h('section', { class: 'sec' }, h('h3', null, 'Ostatné údaje'));
    if (editing) {
      other.append(h('div', { class: 'form' },
        field('IČO', 'ico', { inputmode: 'numeric', autocomplete: 'off' }),
        h('div', { class: 'grid2' }, field('DIČ', 'dic', { inputmode: 'numeric', autocomplete: 'off' }), field('IČ DPH', 'icDph', { autocomplete: 'off' }))));
    } else {
      other.append(kv([['Predajné miesto', r.unitAddress], ['DIČ', r.dic], ['IČ DPH', r.icDph], ['IČO', r.ico]]));
    }
    const tech = kv([['Kód pokladnice', r.cashRegisterCode], ['Poradové číslo', r.receiptNumber], ['ID bločku', r.receiptId], ['OKP', r.okp]]);
    if (tech.children.length) { tech.classList.add('gap'); other.append(tech); }
    if (r.ekasaRaw) other.append(h('div', { class: 'foot' }, h('button', { class: 'linkbtn', onclick: async () => {
      try { await navigator.clipboard.writeText(JSON.stringify(r.ekasaRaw, null, 2)); toast('Technické dáta skopírované.'); } catch { toast('Kopírovanie sa nepodarilo.'); }
    } }, 'Kopírovať technické dáta (JSON)')));
    if (other.children.length > 1) sections.push(other);

    sections.push(pillsSec());      // záruka, poznámka a fotka úplne dole
    if (locked) sections.push(h('section', { class: 'sec' }, h('h3', null, 'Odoslaný bloček'),
      h('p', { class: 'meta' }, `Odoslaný ${fmtDateTime(r.sentAt)}${r.sentBy ? ' · ' + r.sentBy : ''}.`),
      h('div', { class: 'foot nomargin' },
        h('button', { class: 'btn small', onclick: () => go('send', { ids: [r.id], resend: true }) }, 'Odoslať znova'),
        h('button', { class: 'btn small', onclick: reopen }, 'Vrátiť medzi pripravené'))));
    body.append(...sections.filter(Boolean));
  }

  function validate() {
    const e = {};
    if (!r.vendor.trim()) e.vendor = 'Doplň názov predajcu.';
    if (!r.date) e.date = 'Doplň dátum.';
    if (!(r.total > 0)) e.total = 'Doplň sumu väčšiu ako 0.';
    if (!r.photo && !r.receiptId) e.photo = 'Pridaj fotku bločku.';
    if (!r.payment) e.payment = 'Vyber spôsob úhrady: pokladňa alebo karta.';
    for (const k of Object.keys(errs)) errs[k].textContent = e[k] || '';
    if (e.payment) errs.payment?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (e.photo) errs.photo?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (Object.keys(e).length) { toast(Object.values(e)[0]); if (!editing && (e.vendor || e.date || e.total)) { editing = true; drawBody(); } }
    return Object.keys(e).length === 0;
  }
  const setReady = async () => { if (!validate()) return; r.status = 'ready'; await persist(); selected.add(r.id); toast('Bloček je pripravený na odoslanie.'); history.back(); };
  const setDraft = async () => { r.status = 'draft'; selected.delete(r.id); await persist(); history.back(); };
  const reopen = async () => {
    if (!(await confirmDialog({ title: 'Vrátiť medzi pripravené?', text: 'Bloček sa odomkne a môže sa odoslať znova.', yes: 'Vrátiť', no: 'Ponechať odoslaný' }))) return;
    r.status = 'ready'; r.batchId = null; r.sentAt = null; r.sentBy = null; await persist(); selected.add(r.id); listTab = 'todo'; go('list', {}, { replace: true });
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Zmazať bloček?', text: 'Tento krok sa nedá vrátiť späť.', yes: 'Zmazať', no: 'Ponechať' }))) return;
    clearTimeout(saveTimer); cleanup = () => { if (photoUrl) URL.revokeObjectURL(photoUrl); };
    selected.delete(r.id); await db.del(r.id); history.back();
  };

  drawHead(); drawBody();
  $app.append(
    h('header', { class: 'hero' }, h('div', { class: 'wrap' },
      h('div', { class: 'hero-top' },
        h('button', { class: 'ghost', onclick: () => history.back() }, '‹ Späť'),
        h('div', { class: 'hero-actions' },
          h('span', { class: `chip ${r.status} onhero` }, STATUS[r.status]),
          !locked && h('button', { class: 'ghost danger', onclick: remove }, 'Zmazať'))))),
    h('main', { class: 'wrap content' },
      locked && h('div', { class: 'banner ok' }, `Odoslaný ${fmtDateTime(r.sentAt)}. Údaje sú zamknuté.`),
      head, body),
    !locked && h('div', { class: 'dock' }, h('div', { class: 'wrap dock-in' },
      r.status === 'ready'
        ? h('button', { class: 'btn grow', onclick: setDraft }, 'Vrátiť medzi rozpracované')
        : h('button', { class: 'btn primary grow', onclick: setReady }, 'Pripravený na odoslanie'))),
    fileInput);
}

/* ---------- štart ---------- */
window.addEventListener('error', (e) => { if (!/ResizeObserver/.test(e.message || '')) toast(`Chyba: ${e.message || 'neznáma'}`, 7000); });
window.addEventListener('unhandledrejection', (e) => toast(`Chyba: ${e.reason?.message || e.reason || 'neznáma'}`, 7000));

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
applyTheme(getSettings());
history.replaceState({ view: 'list', params: {} }, '');
render({ view: 'list', params: {} });
