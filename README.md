# Bločky – PWA (bez napojenia na portál)

Statická aplikácia, žiadny build krok. Kamera a inštalácia na plochu fungujú
len cez **HTTPS** (alebo `localhost`).

## Spustenie lokálne
    python3 -m http.server 8000      # potom otvor http://localhost:8000

## Nasadenie na test do telefónu
Nahraj celý priečinok na ľubovoľný statický hosting s HTTPS
(Netlify, Cloudflare Pages, GitHub Pages, Supabase Storage...).
- iPhone (Safari): Zdieľať → Pridať na plochu
- Android (Chrome): menu → Inštalovať aplikáciu

## Štruktúra
- `app.js`   obrazovky (zoznam, skener, orezanie, formulár, odoslanie)
- `image.js` orezanie a zmenšenie fotiek
- `share.js` príprava emailu s prílohami (.jpg, .json, .csv)
- `db.js`    lokálne úložisko (IndexedDB)
- `api.js`   JEDINÉ miesto pre napojenie na server (eKasa lookup, odoslanie do portálu)
- `sw.js`    offline režim; pri zmene súborov zvýš `VERSION`
- `vendor/jsQR.js`  QR skener (jsQR 1.4.0), lokálna kópia, žiadne CDN

## Bezpečnosť
CSP v `index.html` povoľuje len vlastný pôvod a doménu eKasa.
Žiadne kľúče ani prihlasovacie údaje v aplikácii.

## Načítanie údajov zo slovenského bločku (eKasa)
Prehliadač v telefóne zvyčajne nesmie volať finančnú správu priamo (CORS).
Riešenie: malý prostredník `server/ekasa-proxy.js` (Cloudflare Worker, bezplatný plán).
1. dash.cloudflare.com → Workers & Pages → Create → Hello World → vlož kód zo `server/ekasa-proxy.js` → Deploy.
2. Settings → Variables: `ALLOWED_ORIGIN` = adresa appky, napr. `https://visnor-design.github.io`.
3. V appke: Nastavenia → Adresa servera pre eKasa = adresa workera (https://...workers.dev).
Ak použiješ inú doménu než *.workers.dev alebo *.supabase.co, pridaj ju do `connect-src` v `index.html`.
