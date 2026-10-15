// Vrstva pre komunikáciu so svetom. Zatiaľ bez napojenia na portál.
// Napojenie na Supabase/portál sa doplní SEM, zvyšok aplikácie sa nemení.

const EKASA_URL = 'https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find';

// Z textu QR kódu vytiahne ID dokladu eKasa (tvar napr. "O-" + 32 znakov).
export function parseEkasaQr(text) {
  const t = String(text || '').trim();
  const m = t.match(/[A-Z]-[0-9A-F]{32}/i);
  return m ? m[0].toUpperCase() : null;
}

function skDateToIso(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

// POZOR: priame volanie z prehliadača môže zablokovať CORS. Preto je to len pokus.
// V ostrej verzii ho presunieme do serverovej funkcie. Polia odpovede je potrebné
// overiť na reálnom bloku.
export async function lookupEkasa(receiptId, { signal } = {}) {
  try {
    const res = await fetch(EKASA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptId }),
      signal,
    });
    if (!res.ok) return { ok: false, reason: 'http_' + res.status };
    const rc = (await res.json()).receipt;
    if (!rc) return { ok: false, reason: 'not_found' };
    const items = (rc.items || []).map((i) => ({
      name: String(i.name ?? ''),
      qty: Number(i.quantity ?? 1),
      price: Number(i.price ?? 0),
      vatRate: Number(i.vatRate ?? 0),
    }));
    // Rozpis DPH podľa sadzieb (dopočítaný z položiek, ceny sú s DPH).
    const byRate = {};
    for (const i of items) {
      const vat = (i.price * i.vatRate) / (100 + i.vatRate);
      const b = (byRate[i.vatRate] ||= { rate: i.vatRate, base: 0, vat: 0 });
      b.vat += vat; b.base += i.price - vat;
    }
    const round = (n) => Math.round(n * 100) / 100;
    const vatBreakdown = Object.values(byRate).map((b) => ({ rate: b.rate, base: round(b.base), vat: round(b.vat) }));
    return {
      ok: true,
      data: {
        vendor: rc.organization?.name || rc.unit?.name || '',
        ico: String(rc.ico || rc.organization?.ico || ''),
        dic: String(rc.dic || rc.organization?.dic || ''),
        icDph: String(rc.icDph || rc.organization?.icDph || ''),
        date: skDateToIso(rc.issueDate || rc.createDate),
        total: Number(rc.totalPrice ?? 0),
        vat: round(vatBreakdown.reduce((s, b) => s + b.vat, 0)),
        currency: 'EUR',
        items,
        vatBreakdown,
        ekasaRaw: rc, // celá odpoveď štátu, aby sa nestratilo žiadne pole
      },
    };
  } catch (e) {
    return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : 'network' };
  }
}

// Odoslanie do portálu: zatiaľ nie je zapojené.
export async function sendReceipt(/* receipt */) {
  const err = new Error('NOT_CONNECTED');
  err.code = 'NOT_CONNECTED';
  throw err;
}
