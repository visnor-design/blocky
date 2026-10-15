// Cloudflare Worker: prostredník medzi appkou a eKasa (obchádza CORS).
// Nasadenie: dash.cloudflare.com → Workers & Pages → Create → Hello World → vlož tento kód.
// V Settings → Variables pridaj ALLOWED_ORIGIN, napr. https://visnor-design.github.io
// (viac domén oddeľ čiarkou). Adresu workera potom vlož v appke do Nastavení.

const UPSTREAM = 'https://ekasa.financnasprava.sk/mdu/api/v1/opd/receipt/find';
const ID_RE = /^[A-Z]-[0-9A-F]{32}$/;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': ok ? origin : 'null',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!ok) return new Response('Forbidden', { status: 403, headers: cors });
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });

    let body;
    try { body = await req.json(); } catch { return new Response('Bad request', { status: 400, headers: cors }); }
    const id = String(body?.receiptId || '').toUpperCase();
    if (!ID_RE.test(id)) return new Response('Bad receiptId', { status: 400, headers: cors });

    const up = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; blocky-proxy)' },
      body: JSON.stringify({ receiptId: id }),
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!up) return new Response('Upstream error', { status: 502, headers: cors });
    return new Response(up.body, { status: up.status, headers: { ...cors, 'Content-Type': 'application/json' } });
  },
};
