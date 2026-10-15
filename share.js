// Príprava emailu s prílohami a odoslanie cez systémové zdieľanie (Mail/Outlook/Gmail).

export const slug = (s, max = 24) =>
  String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'bez-nazvu';

const csvText = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // ochrana pred vložením vzorca do Excelu
  return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csvNum = (n) => (n == null ? '' : String(n).replace('.', ','));
const skDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${+m[3]}. ${+m[2]}. ${m[1]}` : ''; };
const money = (v, c) => { try { return new Intl.NumberFormat('sk-SK', { style: 'currency', currency: c }).format(v); } catch { return `${v} ${c}`; } };

// Záruka sa počíta od dátumu vystavenia bločku.
export function warrantyDate(r) {
  if (!r.warrantyYears || !r.date) return null;
  const [y, m, d] = r.date.split('-').map(Number);
  const dt = new Date(y + r.warrantyYears, m - 1, d);
  if (dt.getMonth() !== m - 1) dt.setDate(0); // 29. 2. + rok => 28. 2.
  return dt;
}
export const isoDate = (dt) => dt.toLocaleDateString('sv-SE');
const warrantyIso = (r) => { const d = warrantyDate(r); return d ? isoDate(d) : ''; };

// Súbor .ics: po otvorení na iPhone/Androide ponúkne pridanie do kalendára s upozornením 30 dní vopred.
export function buildIcs(r) {
  const end = warrantyDate(r);
  if (!end) return null;
  const ymd = (d) => isoDate(d).replace(/-/g, '');
  const next = new Date(end); next.setDate(next.getDate() + 1);
  const esc = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Blocky//SK', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    `UID:${r.id}-warranty@blocky`, `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${ymd(end)}`, `DTEND;VALUE=DATE:${ymd(next)}`,
    `SUMMARY:${esc('Koniec záruky: ' + (r.vendor || 'bloček'))}`,
    `DESCRIPTION:${esc(`Bloček z ${r.date}, záruka ${r.warrantyYears} r.${r.note ? ' ' + r.note : ''}`)}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Koniec záruky sa blíži', 'TRIGGER:-P29DT15H', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return new File([lines.join('\r\n')], `zaruka-${slug(r.vendor)}.ics`, { type: 'text/calendar' });
}

export function buildBatch(receipts, settings = {}) {
  const files = [];
  const rows = [['subor', 'datum', 'predajca', 'ico', 'dic', 'ic_dph', 'suma', 'dph', 'mena', 'rozpis_dph', 'zaruka_do', 'zdroj', 'ekasa_id', 'poznamka'].join(';')];
  const lines = [];
  const totals = {};
  const iso = new Date().toISOString();

  receipts.forEach((r, i) => {
    const base = `${String(i + 1).padStart(2, '0')}_${r.date || 'bez-datumu'}_${slug(r.vendor)}_${String(r.total ?? 0).replace('.', '-')}${r.currency}`;
    const photoName = r.photo ? base + '.jpg' : null;
    if (r.photo) files.push(new File([r.photo], photoName, { type: 'image/jpeg' }));
    const json = {
      schema: 'blocek/1',
      id: r.id,
      sender: { name: settings.name || '' },
      sentAt: iso,
      createdAt: new Date(r.createdAt).toISOString(),
      source: r.source,
      ekasaReceiptId: r.receiptId || null,
      vendor: r.vendor, address: r.address || '', unitAddress: r.unitAddress || '',
      ico: r.ico || '', dic: r.dic || '', icDph: r.icDph || '',
      cashRegisterCode: r.cashRegisterCode || '', receiptNumber: r.receiptNumber ?? null, okp: r.okp || '',
      date: r.date, time: r.time || '', currency: r.currency, total: r.total, vat: r.vat,
      warrantyYears: r.warrantyYears || null, warrantyUntil: warrantyIso(r),
      vatBreakdown: r.vatBreakdown || [],
      items: r.items || [],
      note: r.note || '',
      photoFile: photoName,
      ekasaRaw: r.ekasaRaw || null,
    };
    files.push(new File([JSON.stringify(json, null, 2)], base + '.json', { type: 'application/json' }));
    rows.push([photoName || base + '.json', r.date, csvText(r.vendor), csvText(r.ico), csvText(r.dic), csvText(r.icDph),
      csvNum(r.total), csvNum(r.vat), r.currency,
      csvText((r.vatBreakdown || []).map((b) => `${b.rate}%: základ ${csvNum(b.base)} DPH ${csvNum(b.vat)}`).join(' | ')),
      warrantyIso(r), r.source, csvText(r.receiptId), csvText(r.note)].join(';'));
    lines.push(`${i + 1}) ${r.vendor || 'Bez názvu'} | ${skDate(r.date)} | ${money(r.total ?? 0, r.currency)}${r.vat ? ` (DPH ${money(r.vat, r.currency)})` : ''}`);
    totals[r.currency] = (totals[r.currency] || 0) + (r.total || 0);
  });

  files.push(new File(['\uFEFF' + rows.join('\r\n')], 'suhrn.csv', { type: 'text/csv' }));

  const sum = Object.entries(totals).map(([c, v]) => money(v, c)).join(' + ');
  const when = skDate(new Date().toLocaleDateString('sv-SE'));
  const subject = `Bločky ${settings.name ? settings.name + ' – ' : ''}${when} (${receipts.length})`;
  const text = [
    `Bločky od: ${settings.name || '(meno nevyplnené)'}`,
    `Počet: ${receipts.length}`,
    `Spolu: ${sum}`,
    '',
    ...lines,
    '',
    'Prílohy: fotky (.jpg), údaje (.json) a súhrn (.csv).',
  ].join('\n');

  return { files, subject, text, sum, totalBytes: files.reduce((s, f) => s + f.size, 0) };
}

const retypeJson = (f) => (f.name.endsWith('.json') ? new File([f], f.name, { type: 'text/plain' }) : f);

// Musí sa volať priamo z kliknutia (bez čakania pred volaním), inak ho iOS zamietne.
export async function shareBatch({ files, subject, text, to, mode }) {
  if (mode !== 'mailto' && navigator.share && navigator.canShare) {
    const variants = [
      { list: files, droppedJson: false },
      { list: files.map(retypeJson), droppedJson: false },
      { list: files.filter((f) => !f.name.endsWith('.json')), droppedJson: true },
    ];
    for (const v of variants) {
      if (!navigator.canShare({ files: v.list })) continue;
      try {
        await navigator.share({ files: v.list, title: subject, text });
        return { status: 'shared', droppedJson: v.droppedJson };
      } catch (e) {
        return e.name === 'AbortError' ? { status: 'cancelled' } : { status: 'error', error: e };
      }
    }
  }
  // Záloha (napr. počítač): stiahnuť súbory a otvoriť prázdny email.
  for (const f of files) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(f); a.download = f.name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    await new Promise((r) => setTimeout(r, 250));
  }
  location.href = `mailto:${encodeURIComponent(to || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  return { status: 'fallback' };
}
