// Práca s fotkou bločku: automatický návrh orezania, ručné doladenie rohov, zmenšenie.

export async function loadBitmap(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch { return await createImageBitmap(file); }
}

function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, max = 0, t = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sB += i * hist[i];
    const mB = sB / wB, mF = (sum - sB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > max) { max = v; t = i; }
  }
  return t;
}

// Nájde svetlú plochu (papier) a vráti obdĺžnik {x,y,w,h} v pixeloch fotky.
export function autoDetect(bmp) {
  const fallback = () => {
    const mx = Math.round(bmp.width * 0.05), my = Math.round(bmp.height * 0.05);
    return { x: mx, y: my, w: bmp.width - 2 * mx, h: bmp.height - 2 * my };
  };
  try {
    const S = 240, sc = S / Math.max(bmp.width, bmp.height);
    const w = Math.max(8, Math.round(bmp.width * sc)), hh = Math.max(8, Math.round(bmp.height * sc));
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, hh);
    const d = ctx.getImageData(0, 0, w, hh).data;
    const lum = new Uint8Array(w * hh), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      const v = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
      lum[i] = v; hist[v]++;
    }
    const t = otsu(hist, lum.length);
    const rowF = new Float32Array(hh), colF = new Float32Array(w);
    let brightTotal = 0;
    for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
      if (lum[y * w + x] > t) { rowF[y]++; colF[x]++; brightTotal++; }
    }
    const share = brightTotal / lum.length;
    if (share < 0.12 || share > 0.92) return fallback();
    const TH = 0.22;
    let top = 0, bottom = hh - 1, left = 0, right = w - 1;
    while (top < hh && rowF[top] / w < TH) top++;
    while (bottom > top && rowF[bottom] / w < TH) bottom--;
    while (left < w && colF[left] / hh < TH) left++;
    while (right > left && colF[right] / hh < TH) right--;
    if (right - left < w * 0.2 || bottom - top < hh * 0.2) return fallback();
    const pad = 0.015;
    const x1 = Math.max(0, left / w - pad), x2 = Math.min(1, (right + 1) / w + pad);
    const y1 = Math.max(0, top / hh - pad), y2 = Math.min(1, (bottom + 1) / hh + pad);
    return {
      x: Math.round(x1 * bmp.width), y: Math.round(y1 * bmp.height),
      w: Math.round((x2 - x1) * bmp.width), h: Math.round((y2 - y1) * bmp.height),
    };
  } catch { return fallback(); }
}

// Vyreže, zmenší a (voliteľne) zvýrazní text. Výsledok je malé JPEG.
export function renderCrop(bmp, crop, { enhance = true, maxSide = 2400, quality = 0.75 } = {}) {
  const sc = Math.min(1, maxSide / Math.max(crop.w, crop.h));
  const cw = Math.max(1, Math.round(crop.w * sc)), ch = Math.max(1, Math.round(crop.h * sc));
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, crop.x, crop.y, crop.w, crop.h, 0, 0, cw, ch);
  if (enhance) {
    const img = ctx.getImageData(0, 0, cw, ch), d = img.data;
    const g = new Uint8Array(cw * ch), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const v = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000 | 0;
      g[i] = v; hist[v]++;
    }
    const pick = (q) => { let acc = 0; const target = g.length * q; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; } return 255; };
    const lo = pick(0.01), hi = Math.max(lo + 40, pick(0.85));
    for (let i = 0, p = 0; i < g.length; i++, p += 4) {
      const v = Math.max(0, Math.min(255, ((g[i] - lo) / (hi - lo)) * 255));
      d[p] = d[p + 1] = d[p + 2] = v;
    }
    ctx.putImageData(img, 0, 0);
  }
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', quality));
}

// Ručné doladenie: potiahnutím rohov. Vráti { getCrop, destroy }.
export function mountCropper(stage, bmp, init) {
  const canvas = document.createElement('canvas');
  stage.append(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  let s = 1;
  const r = { x1: init.x, y1: init.y, x2: init.x + init.w, y2: init.y + init.h };
  const MIN = Math.max(40, Math.min(bmp.width, bmp.height) * 0.08);
  let drag = null;

  function layout() {
    const W = stage.clientWidth, H = stage.clientHeight;
    if (!W || !H) return;
    s = Math.min(W / bmp.width, H / bmp.height);
    const cw = Math.round(bmp.width * s), ch = Math.round(bmp.height * s);
    canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    draw();
  }
  function draw() {
    const cw = canvas.width, ch = canvas.height, k = s * dpr;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(bmp, 0, 0, cw, ch);
    const x1 = r.x1 * k, y1 = r.y1 * k, x2 = r.x2 * k, y2 = r.y2 * k;
    ctx.fillStyle = 'rgba(0,0,0,0.58)';
    ctx.beginPath(); ctx.rect(0, 0, cw, ch); ctx.rect(x1, y1, x2 - x1, y2 - y1); ctx.fill('evenodd');
    ctx.strokeStyle = '#FFE14D'; ctx.lineWidth = 3 * dpr;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    for (const [cx, cy] of [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]) {
      ctx.beginPath(); ctx.arc(cx, cy, 13 * dpr, 0, Math.PI * 2);
      ctx.fillStyle = '#FFE14D'; ctx.fill();
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#0B1020'; ctx.stroke();
    }
  }
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: (e.clientX - b.left) / s, y: (e.clientY - b.top) / s }; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  canvas.addEventListener('pointerdown', (e) => {
    const p = pos(e);
    let best = null, bd = 56 / s;
    for (const fx of ['x1', 'x2']) for (const fy of ['y1', 'y2']) {
      const dist = Math.hypot(p.x - r[fx], p.y - r[fy]);
      if (dist < bd) { bd = dist; best = { fx, fy }; }
    }
    if (best) { drag = best; canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = pos(e);
    if (drag.fx === 'x1') r.x1 = clamp(p.x, 0, r.x2 - MIN); else r.x2 = clamp(p.x, r.x1 + MIN, bmp.width);
    if (drag.fy === 'y1') r.y1 = clamp(p.y, 0, r.y2 - MIN); else r.y2 = clamp(p.y, r.y1 + MIN, bmp.height);
    draw();
  });
  const end = () => { drag = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const ro = new ResizeObserver(layout);
  ro.observe(stage);
  layout();

  return {
    getCrop: () => ({ x: Math.round(r.x1), y: Math.round(r.y1), w: Math.round(r.x2 - r.x1), h: Math.round(r.y2 - r.y1) }),
    destroy: () => ro.disconnect(),
  };
}
