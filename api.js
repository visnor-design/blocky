// Vrstva pre komunikáciu so serverom. Napojenie na portál sa doplní SEM.

// Oficiálna adresa eKasa (overené z verejných príkladov: POST + {"receiptId": "O-..."}).
// Z prehliadača ju zvyčajne zablokuje CORS, preto sa dá v Nastaveniach zadať adresa
// vlastného prostredníka (pozri server/ekasa-proxy.js), ktorý vracia rovnakú odpoveď.
const EKASA_URL = 'https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find';

export function parseEkasaQr(text) {
  const m = String(text || '').trim().match(/[A-Z]-[0-9A-F]{32}/i);
  return m ? m[0].toUpperCase() : null;
}

const round = (n) => Math.round(n * 100) / 100;

function skDateTime(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}:\d{2}(?::\d{2})?))?/);
  return m ? { date: `${m[3]}-${m[2]}-${m[1]}`, time: m[4] || '' } : { date: '', time: '' };
}

// Zloží adresu z bežných názvov polí (presné názvy treba overiť na reálnych dátach).
function addr(o) {
  if (!o) return '';
  const a = o.address && typeof o.address === 'object' ? o.address : o;
  if (typeof o.address === 'string') return o.address;
  const street = [a.streetName || a.street, a.buildingNumber || a.propertyRegistrationNumber].filter(Boolean).join(' ');
  const city = [a.postalCode || a.zip, a.municipality || a.city].filter(Boolean).join(' ');
  return [street, city].filter(Boolean).join(', ');
}

export function mapReceipt(rc) {
  const org = rc.organization || {};
  const unit = rc.unit || {};
  const total = Number(rc.totalPrice ?? 0);
  const raw = (rc.items || []).map((i) => ({
    name: String(i.name ?? ''),
    qty: Number(i.quantity ?? 1) || 1,
    price: Number(i.price ?? 0),
    unitPrice: i.unitPrice != null ? Number(i.unitPrice) : null,
    vatRate: Number(i.vatRate ?? 0),
  }));
  // Neistota: je `price` cena riadku alebo jednotková cena? Vyberie sa variant, ktorý sedí na celkovú sumu.
  const asLine = raw.reduce((s, i) => s + i.price, 0);
  const asUnit = raw.reduce((s, i) => s + (i.unitPrice ?? i.price) * i.qty, 0);
  const useLine = Math.abs(asLine - total) <= Math.abs(asUnit - total);
  const items = raw.map((i) => {
    const line = useLine ? i.price : (i.unitPrice ?? i.price) * i.qty;
    return { name: i.name, qty: i.qty, unit: round(line / i.qty), total: round(line), vatRate: i.vatRate };
  });
  const itemsSum = items.reduce((s, i) => s + i.total, 0);

  // Rozpis DPH podľa sadzieb: DPH sa počíta zo súčtu cien skupiny a zaokrúhľuje raz (ako na bločku).
  const groups = {};
  for (const i of items) (groups[i.vatRate] ||= { rate: i.vatRate, gross: 0 }).gross += i.total;
  const vatBreakdown = Object.values(groups)
    .sort((a, b) => b.rate - a.rate)
    .map((g) => {
      const vat = round((g.gross * g.rate) / (100 + g.rate));
      return { rate: g.rate, base: round(g.gross - vat), vat };
    });
  const t = skDateTime(rc.issueDate || rc.createDate);
  const g = (k) => String(rc[k] || org[k] || '');
  return {
    vendor: org.name || unit.name || '',
    address: addr(org),
    unitAddress: addr(unit),
    ico: g('ico'), dic: g('dic'), icDph: g('icDph'),
    date: t.date, time: t.time,
    total, vat: round(vatBreakdown.reduce((s, b) => s + b.vat, 0)),
    currency: 'EUR',
    items, vatBreakdown,
    vatCheck: Math.abs(itemsSum - total) <= 0.02,
    cashRegisterCode: String(rc.cashRegisterCode || ''),
    receiptNumber: rc.receiptNumber ?? null,
    okp: String(rc.okp || ''),
    ekasaRaw: rc,
  };
}

export async function lookupEkasa(receiptId, { signal, url } = {}) {
  try {
    const res = await fetch(url || EKASA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId }),
      signal,
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const body = await res.json();
    if (!body.receipt || (body.returnValue != null && body.returnValue !== 0)) return { ok: false, reason: 'not_found' };
    return { ok: true, data: mapReceipt(body.receipt) };
  } catch (e) {
    // Zablokovanie CORS sa v prehliadači prejaví ako všeobecná sieťová chyba.
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

// Odoslanie do portálu: zatiaľ nie je zapojené.
export async function sendReceipt() {
  const err = new Error('NOT_CONNECTED');
  err.code = 'NOT_CONNECTED';
  throw err;
}
