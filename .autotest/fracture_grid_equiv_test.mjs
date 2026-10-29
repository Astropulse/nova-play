// Headless equivalence test: FractureModel._buildSteps (asteroid.js) now finds
// each pixel's nearest Voronoi seed through a bucket grid searched in rings.
// This file keeps the ORIGINAL brute-force build as the reference and checks
// the two produce byte-identical cell layouts (pixels, bounds, edge flags,
// maxDist, maxRemovable) for many random seed sets and sprite sizes,
// including tiny sprites (dense duplicate seeds -> lots of distance ties).
// Also: HullFracture.composite (now logical-res) NN-blitted == the old
// prescaled composite, and shadowGlow.js cache keying / LRU bounds.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/fracture_grid_equiv_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── Minimal canvas stand-in (same as prewarm_fracture_test.mjs) ─────────────
class FakeCtx {
  constructor(c) { this.c = c; this.imageSmoothingEnabled = true; this.globalCompositeOperation = 'source-over'; }
  clearRect(x, y, w, h) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.c.data.fill(0, (yy * this.c.width + xx) * 4, (yy * this.c.width + xx) * 4 + 4);
  }
  // Nearest-neighbour; 'copy'-style source-over (test sprites are opaque or
  // empty) and 'destination-out' (dest alpha *= 1 - src alpha).
  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (sw === undefined) {
      if (sx !== undefined) { dx = sx; dy = sy; } else { dx = 0; dy = 0; }
      sx = 0; sy = 0; sw = src.width; sh = src.height; dw = sw; dh = sh;
    }
    const d = this.c.data, s = src.data;
    const out = this.globalCompositeOperation === 'destination-out';
    for (let y = 0; y < dh; y++) {
      const syy = sy + Math.floor(y * sh / dh);
      for (let x = 0; x < dw; x++) {
        const sxx = sx + Math.floor(x * sw / dw);
        const si = (syy * src.width + sxx) * 4, di = ((dy + y) * this.c.width + (dx + x)) * 4;
        if (out) { d[di + 3] = Math.round(d[di + 3] * (1 - s[si + 3] / 255)); if (!d[di + 3]) d[di] = d[di + 1] = d[di + 2] = 0; continue; } // premultiplied: alpha 0 => rgb 0
        if (s[si + 3] === 0) continue;
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3];
      }
    }
  }
  getImageData(x, y, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const si = ((y + yy) * this.c.width + (x + xx)) * 4, di = (yy * w + xx) * 4;
      out.set(this.c.data.subarray(si, si + 4), di);
    }
    return { data: out, width: w, height: h };
  }
  createImageData(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; }
  putImageData(img, x, y) {
    for (let yy = 0; yy < img.height; yy++) for (let xx = 0; xx < img.width; xx++) {
      const di = ((y + yy) * this.c.width + (x + xx)) * 4, si = (yy * img.width + xx) * 4;
      this.c.data.set(img.data.subarray(si, si + 4), di);
    }
  }
}
class FakeCanvas {
  constructor() { this._w = 0; this._h = 0; this.data = new Uint8ClampedArray(0); }
  get width() { return this._w; } set width(v) { this._w = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  get height() { return this._h; } set height(v) { this._h = v; this.data = new Uint8ClampedArray(this._w * this._h * 4); }
  getContext() { return new FakeCtx(this); }
}
globalThis.window ||= {};
globalThis.document = { createElement: () => new FakeCanvas() };
globalThis.navigator ||= { getGamepads: () => [] };
globalThis.localStorage ||= { getItem: () => null, setItem() {}, removeItem() {} };

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const seedRandom = (s) => { Math.random = mulberry(s); };

// Ragged blob (or a fully opaque rectangle when full=true), prescaled 4x.
const makeAsset = (lw, lh, seed, full = false) => {
  const rnd = mulberry(seed);
  const c = new FakeCanvas(); c.width = lw * 4; c.height = lh * 4;
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const dx = x - lw / 2, dy = y - lh / 2;
    const r = Math.hypot(dx, dy) / (Math.max(1, lw) / 2);
    const inside = full || r < 0.75 + 0.2 * Math.sin(Math.atan2(dy, dx) * 5) + (rnd() - 0.5) * 0.08;
    if (!inside) continue;
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const i = ((y * 4 + py) * c.width + (x * 4 + px)) * 4;
      c.data[i] = 90 + x; c.data[i + 1] = 80 + y; c.data[i + 2] = 70; c.data[i + 3] = 255;
    }
  }
  return { canvas: c, width: lw, height: lh, prescale: 4 };
};

// ── REFERENCE: the original brute-force FractureModel._buildSteps ───────────
const CHUNK_PX = 3.0;
function* refBuildSteps(asset, model) {
  const img = asset.canvas || asset;
  model.lw = asset.width || img.width;
  model.lh = asset.height || img.height;
  model.pw = img.width;
  model.ph = img.height;
  model.prescale = asset.prescale || (model.lw ? img.width / model.lw : 1);
  const lw = model.lw, lh = model.lh;
  const numPieces = Math.max(12, Math.min(320, Math.round((lw * lh) / (CHUNK_PX * CHUNK_PX))));
  const canvas = document.createElement('canvas');
  canvas.width = lw;
  canvas.height = lh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, lw, lh);
  const data = ctx.getImageData(0, 0, lw, lh).data;
  const map = new Uint8Array(lw * lh);
  for (let i = 0; i < map.length; i++) map[i] = data[i * 4 + 3] > 30 ? 1 : 0;
  const seeds = [];
  for (let i = 0; i < numPieces; i++) {
    seeds.push({
      x: Math.floor(lw * (0.1 + Math.random() * 0.8)),
      y: Math.floor(lh * (0.1 + Math.random() * 0.8)),
    });
  }
  const shards = Array.from({ length: numPieces }, () => ({
    minX: lw, minY: lh, maxX: 0, maxY: 0, count: 0, edge: false, pixels: [],
  }));
  for (let y = 0; y < lh; y++) {
    for (let x = 0; x < lw; x++) {
      if (!map[y * lw + x]) continue;
      let minD = Infinity, nearest = 0;
      for (let i = 0; i < numPieces; i++) {
        const dx = x - seeds[i].x, dy = y - seeds[i].y;
        const d = dx * dx + dy * dy;
        if (d < minD) { minD = d; nearest = i; }
      }
      const s = shards[nearest];
      if (x < s.minX) s.minX = x;
      if (y < s.minY) s.minY = y;
      if (x > s.maxX) s.maxX = x;
      if (y > s.maxY) s.maxY = y;
      s.count++;
      s.pixels.push(x, y);
      if (!s.edge) {
        if (x === 0 || y === 0 || x === lw - 1 || y === lh - 1 ||
            !map[(y - 1) * lw + x] || !map[(y + 1) * lw + x] ||
            !map[y * lw + (x - 1)] || !map[y * lw + (x + 1)]) {
          s.edge = true;
        }
      }
    }
    yield;
  }
  model._spriteData = data;
  const cells = [];
  let maxDist = 1;
  let edgeCount = 0;
  for (const s of shards) {
    if (s.count < 2) continue;
    const cw = (s.maxX - s.minX) + 1;
    const ch = (s.maxY - s.minY) + 1;
    const cell = {
      canvas: null, w: cw, h: ch,
      pixels: Uint16Array.from(s.pixels),
      lx: (s.minX + cw / 2 - lw / 2),
      ly: (s.minY + ch / 2 - lh / 2),
      ox: s.minX, oy: s.minY, edge: s.edge,
    };
    cell.dist = Math.hypot(cell.lx, cell.ly);
    if (cell.edge) edgeCount++;
    if (cell.dist > maxDist) maxDist = cell.dist;
    cells.push(cell);
  }
  model.cells = cells;
  model.maxDist = maxDist;
  model.maxRemovable = edgeCount;
}

const { FractureModel } = await import('../src/entities/asteroid.js');

const cellsKey = (m) => m.cells.map(c => `${c.w},${c.h},${c.lx},${c.ly},${c.ox},${c.oy},${c.edge ? 1 : 0},${c.dist},${Array.from(c.pixels).join('.')}`).join('|')
  + `#${m.maxDist}#${m.maxRemovable}#${m.lw}x${m.lh}/${m.pw}x${m.ph}@${m.prescale}`;
const drain = (it) => { let n = 0; for (;;) { const r = it.next(); if (r.done) return n; n++; } };

const sizes = [[1, 1], [2, 3], [3, 3], [5, 4], [7, 11], [12, 12], [16, 9], [24, 24], [33, 17],
  [40, 40], [48, 40], [64, 64], [80, 52], [96, 96], [128, 72], [150, 150]];
let cases = 0, mism = 0, tRef = 0, tNew = 0;
for (const [lw, lh] of sizes) {
  for (let rep = 0; rep < 6; rep++) {
    const asset = makeAsset(lw, lh, 1000 + lw * 7 + lh + rep, rep % 3 === 2);
    const seed = 0x5eed + lw * 131 + lh * 17 + rep * 7919;
    const refM = { cells: [] }, newM = new FractureModel(null);
    seedRandom(seed); let t0 = performance.now(); const refSteps = drain(refBuildSteps(asset, refM)); tRef += performance.now() - t0;
    seedRandom(seed); t0 = performance.now(); const newSteps = drain(FractureModel._buildSteps(asset, newM)); tNew += performance.now() - t0;
    cases++;
    const same = cellsKey(refM) === cellsKey(newM) && refSteps === newSteps
      && Array.from(refM._spriteData).join() === Array.from(newM._spriteData).join();
    if (!same) { mism++; ok(`layout ${lw}x${lh} rep ${rep}`, false); }
  }
}
ok(`grid build == brute-force build on ${cases} random seed sets / sizes`, mism === 0, `${mism} mismatches`);
console.log(`  timing: brute-force ${tRef.toFixed(1)}ms, grid ${tNew.toFixed(1)}ms`);

// ── HullFracture.composite: logical-res composite, NN-blitted, must equal the
// old prescaled composite pixel for pixel. ────────────────────────────────
const { HullFracture } = await import('../src/entities/asteroid.js');
function refComposite(m, removed, srcImg) {
  const s = m.prescale;
  const cv = document.createElement('canvas'); cv.width = m.pw; cv.height = m.ph;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, m.pw, m.ph);
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(srcImg, 0, 0, srcImg.width, srcImg.height, 0, 0, m.pw, m.ph);
  ctx.globalCompositeOperation = 'destination-out';
  for (const idx of removed) {
    const c = m.cells[idx];
    const cellCanvas = m.ensureCanvas(c);
    ctx.drawImage(cellCanvas, 0, 0, cellCanvas.width, cellCanvas.height, c.ox * s, c.oy * s, cellCanvas.width * s, cellCanvas.height * s);
  }
  return cv;
}
let compCases = 0, compMism = 0;
for (const [lw, lh] of [[24, 24], [40, 32], [64, 64]]) {
  for (let rep = 0; rep < 3; rep++) {
    const asset = makeAsset(lw, lh, 77 + lw + rep);
    seedRandom(31337 + rep);
    const model = new FractureModel(null);
    drain(FractureModel._buildSteps(asset, model));
    const hf = new HullFracture(model);
    for (let k = 0; k < 4; k++) {
      hf.chipNear((k - 1.5) * lw * 0.3, (rep - 1) * lh * 0.3, 2 + k);
      if (k === 2) hf.restoreOne();
      const got = hf.composite(asset);
      // Blit the logical composite at the prescaled size, nearest-neighbour —
      // what the game's smoothing-off drawImage does on screen.
      const up = document.createElement('canvas'); up.width = model.pw; up.height = model.ph;
      up.getContext('2d').drawImage(got, 0, 0, got.width, got.height, 0, 0, model.pw, model.ph);
      const ref = refComposite(model, hf.removed, asset.canvas);
      compCases++;
      if (Array.from(up.data).join() !== Array.from(ref.data).join()) { compMism++; if (compMism === 1) { let n = 0, first = -1; for (let i = 0; i < up.data.length; i++) if (up.data[i] !== ref.data[i]) { n++; if (first < 0) first = i; } console.log("  diff", n, "first", first, up.data.slice(first - first % 4, first - first % 4 + 4), ref.data.slice(first - first % 4, first - first % 4 + 4), got.width, got.height, model.pw); } }
    }
  }
}
ok(`logical composite (NN-blitted) == prescaled composite on ${compCases} chip states`, compMism === 0, `${compMism} mismatches`);

// ── shadowGlow cache bookkeeping (pixels need a real canvas; this checks
// keying, LRU bounds and that the blit lines up with the sprite rect). ─────
{
  const { drawShadowGlow, _shadowGlowStats } = await import('../src/entities/shadowGlow.js');
  const asset = makeAsset(32, 24, 5);
  const calls = [];
  const main = { imageSmoothingEnabled: false, drawImage: (c, x, y, w, h) => calls.push({ c, x, y, w, h, smooth: main.imageSmoothingEnabled }) };
  const ws = 3, w = 32 * ws, h = 24 * ws;
  drawShadowGlow(main, asset.canvas, 32, 24, -w / 2, -h / 2, w, h, 15 * ws, '#ff4444');
  drawShadowGlow(main, asset.canvas, 32, 24, -w / 2, -h / 2, w, h, 15 * ws, '#ff4444');
  ok('constant blur hits one cache entry', _shadowGlowStats().entries === 1);
  const c0 = calls[0];
  const pad = (c0.c.width - 32) / 2;
  ok('glow blit is centred on the sprite rect, padded symmetrically',
    Math.abs(c0.x - (-w / 2 - pad * ws)) < 1e-9 && Math.abs(c0.w - c0.c.width * ws) < 1e-9 && c0.smooth === true && main.imageSmoothingEnabled === false);
  for (let i = 0; i < 2000; i++) drawShadowGlow(main, asset.canvas, 32, 24, 0, 0, w, h, (1 + i * 0.37) % 120 * ws, '#ffdd44');
  const st = _shadowGlowStats();
  ok('animated blur stays inside the LRU bounds', st.entries <= 256 && st.bytes <= 64 * 1024 * 1024, `${st.entries} entries, ${(st.bytes / 1048576).toFixed(1)}MB`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
