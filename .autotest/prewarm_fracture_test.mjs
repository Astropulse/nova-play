// Deterministic, headless test of the resumable fracture/shatter builds
// (asteroid.js FractureModel._buildSteps / prewarmSteps, VoronoiSlicer
// .sliceSteps / prewarmShatterSteps) against the synchronous paths.
//
// With Math.random replaced by a seeded PRNG, a build spread over many
// generator steps must produce EXACTLY the same cells / fragments as a
// one-shot build, and a synchronous FractureModel.get / getCachedShatter that
// lands mid-prewarm must finish that in-flight build (same seeds) rather than
// start a second layout.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/prewarm_fracture_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ── Minimal canvas stand-in (RGBA buffer, nearest-neighbour drawImage) ──────
class FakeCtx {
  constructor(c) { this.c = c; this.imageSmoothingEnabled = true; }
  drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (sw === undefined) { sx = 0; sy = 0; sw = src.width; sh = src.height; dx = 0; dy = 0; dw = sw; dh = sh; }
    const d = this.c.data, s = src.data;
    for (let y = 0; y < dh; y++) {
      const syy = sy + Math.floor(y * sh / dh);
      for (let x = 0; x < dw; x++) {
        const sxx = sx + Math.floor(x * sw / dw);
        const si = (syy * src.width + sxx) * 4, di = ((dy + y) * this.c.width + (dx + x)) * 4;
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

// Seeded Math.random so both build paths draw identical seeds.
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const seedRandom = (s) => { Math.random = mulberry(s); };

// A prescaled (4x) blob sprite with a ragged silhouette, like an asteroid.
const makeAsset = (lw, lh, seed) => {
  const rnd = mulberry(seed);
  const c = new FakeCanvas(); c.width = lw * 4; c.height = lh * 4;
  for (let y = 0; y < lh; y++) for (let x = 0; x < lw; x++) {
    const dx = x - lw / 2, dy = y - lh / 2;
    const r = Math.hypot(dx, dy) / (lw / 2);
    const inside = r < 0.75 + 0.2 * Math.sin(Math.atan2(dy, dx) * 5) + (rnd() - 0.5) * 0.08;
    if (!inside) continue;
    for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
      const i = ((y * 4 + py) * c.width + (x * 4 + px)) * 4;
      c.data[i] = 90 + x; c.data[i + 1] = 80 + y; c.data[i + 2] = 70; c.data[i + 3] = 255;
    }
  }
  return { canvas: c, width: lw, height: lh, prescale: 4 };
};

const { FractureModel, VoronoiSlicer, getCachedShatter, prewarmShatterSteps } = await import('../src/entities/asteroid.js');

const cellsKey = (m) => m.cells.map(c => `${c.w},${c.h},${c.lx},${c.ly},${c.ox},${c.oy},${c.edge ? 1 : 0},${Array.from(c.pixels).join('.')}`).join('|')
  + `#${m.maxDist}#${m.maxRemovable}#${m.lw}x${m.lh}/${m.pw}x${m.ph}@${m.prescale}`;
const fragsKey = (fr) => fr.map(f => `${f.lx},${f.ly},${f.canvas.width}x${f.canvas.height}:${Array.from(f.canvas.data).join('.')}`).join('|');
const drain = (it) => { let n = 0; for (;;) { const r = it.next(); if (r.done) return { value: r.value, steps: n }; n++; } };

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. FractureModel: stepped build == synchronous build');
{
  const asset = makeAsset(48, 40, 7);
  seedRandom(1234); const sync = new FractureModel(asset);
  seedRandom(1234); const shell = new FractureModel(null);
  const { steps } = drain(FractureModel._buildSteps(asset, shell));
  ok('build yielded per pixel row', steps === 40, `${steps} steps`);
  ok('cells identical', cellsKey(sync) === cellsKey(shell), `${sync.cells.length} cells`);
  ok('has removable shell cells', sync.maxRemovable > 0 && sync.cells.length >= 12);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. FractureModel.prewarmSteps publishes once; sync get drains a mid-flight build');
{
  const asset = makeAsset(40, 40, 8);
  seedRandom(99); const expected = new FractureModel(asset);

  // Partial prewarm (10 steps), then a synchronous get — must complete the
  // SAME build (seeds already drawn at step 0), not start a new one.
  seedRandom(99);
  const it = FractureModel.prewarmSteps(asset, 'k_partial');
  for (let i = 0; i < 10; i++) it.next();
  Math.random = () => { throw new Error('no new seeds may be drawn'); };
  const got = FractureModel.get(asset, 'k_partial');
  ok('sync get after partial prewarm == one-shot build', got && cellsKey(got) === cellsKey(expected));
  ok('prewarm generator then exits without rebuilding', it.next().done === true);
  ok('cache hit is the same object', FractureModel.get(asset, 'k_partial') === got);

  // Full prewarm path alone.
  seedRandom(99);
  const it2 = FractureModel.prewarmSteps(asset, 'k_full');
  const { steps } = drain(it2);
  ok('full prewarm builds in steps', steps > 5, `${steps}`);
  ok('prewarmed model == one-shot build', cellsKey(FractureModel.get(asset, 'k_full')) === cellsKey(expected));
  ok('prewarm on a cached key is a no-op', drain(FractureModel.prewarmSteps(asset, 'k_full')).steps === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. VoronoiSlicer: stepped slice == synchronous slice');
{
  const asset = makeAsset(36, 30, 3);
  seedRandom(555); const a = VoronoiSlicer.slice(asset, 22);
  seedRandom(555); const { value: b, steps } = drain(VoronoiSlicer.sliceSteps(asset, 22));
  ok('fragments identical', fragsKey(a) === fragsKey(b), `${a.length} fragments`);
  ok('slice yielded per row and per fragment', steps === 30 + a.length, `${steps}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. getCachedShatter drains a mid-flight prewarmShatterSteps build');
{
  const asset = makeAsset(30, 30, 4);
  seedRandom(42); const expected = VoronoiSlicer.slice(asset, 14);
  seedRandom(42);
  const it = prewarmShatterSteps(asset, 'sh_partial', 14);
  for (let i = 0; i < 7; i++) it.next();
  Math.random = () => { throw new Error('no new seeds may be drawn'); };
  const got = getCachedShatter(asset, 'sh_partial', 14);
  ok('sync shatter after partial prewarm == one-shot slice', fragsKey(got) === fragsKey(expected));
  ok('prewarm generator then exits', it.next().done === true);
  ok('cache hit is the same array', getCachedShatter(asset, 'sh_partial', 14) === got);
  seedRandom(42);
  drain(prewarmShatterSteps(asset, 'sh_full', 14));
  ok('fully prewarmed shatter == one-shot slice', fragsKey(getCachedShatter(asset, 'sh_full', 14)) === fragsKey(expected));
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
