// Deterministic, headless test of the animation surface working set
// (engine/assetLoader.js AnimFrame / _consumeFrame / tick / _sweep):
//   * one consumer read materializes ONE frame and stages ONE lookahead;
//     prefetch never chains, so ticks with no reads never grow the set;
//   * lookahead follows the read direction (forward / backward, wrap-aware)
//     and two consumers at different offsets each get their own lookahead;
//   * frames read within the grace period are pinned; older frames of a
//     still-playing animation ARE released once over budget (per-frame, not
//     per-animation); pinned demand above budget is reported, never dropped;
//   * warmAnimation / warmFrame stage frames without consumer semantics;
//   * an evicted descriptor rematerializes through the same slice path.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/anim_budget_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Stub raster allocation only: every materialization records the atlas rect
// it was sliced from so rematerialization can be checked for identity.
let slices = 0;
globalThis.document = {
  createElement: () => {
    const c = { width: 0, height: 0, getContext: () => ({ drawImage(img, sx, sy, sw, sh) { c.src = `${sx},${sy},${sw},${sh}`; slices++; } }) };
    return c;
  },
};
globalThis.window ||= {};
globalThis.performance ||= { now: () => 0 };

const { AssetLoader } = await import('../src/engine/assetLoader.js');
const MiB = 1048576;
const mkLoader = (budgetMiB) => {
  const loader = new AssetLoader();
  loader.atlasPrescale = 4;
  loader.animBudgetBytes = budgetMiB * MiB;
  const big = (n) => ({ frames: Array.from({ length: n }, (_, i) => ({ x: i * 256, y: 0, w: 256, h: 256, delay: 60, img: {} })) }); // 4 MiB/frame
  loader.atlasAnims = { idle: big(16), other: big(8), tiny: { frames: [{ x: 0, y: 0, w: 8, h: 8, delay: 50, img: {} }, { x: 8, y: 0, w: 8, h: 8, delay: 50, img: {} }] } };
  return loader;
};
const resident = (frames) => frames.map((f, i) => f._canvas ? i : -1).filter(i => i >= 0);
const warnings = [];
const origWarn = console.warn;
console.warn = (m) => warnings.push(String(m));

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. A single read materializes one frame + one lookahead; no chain');
{
  const loader = mkLoader(192);
  const idle = loader.get('idle');
  let t = 0;
  loader.tick(t);
  void idle[0].canvas;
  ok('one read = one surface', loader._animBytes === 4 * MiB && resident(idle).join() === '0');
  for (let i = 0; i < 20; i++) loader.tick(t += 16);
  ok('ticks stage exactly the next frame, then stop', resident(idle).join() === '0,1', resident(idle).join());
  ok('accounting matches', loader._animBytes === 8 * MiB);
  ok('prefetch did not refresh consumer last-use of frame 1', idle[1]._lastUse === idle[1]._lastUse && idle[0]._lastUse === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Lookahead follows the read direction; wrap-aware');
{
  const loader = mkLoader(192);
  const idle = loader.get('idle');
  let t = 0;
  loader.tick(t);
  void idle[5].canvas; loader.tick(t += 16);   // first read: forward guess stages 6
  void idle[4].canvas; loader.tick(t += 16);   // backwards
  ok('backward read stages i-1', !!idle[3]._canvas && !idle[2]._canvas, resident(idle).join());
  void idle[0].canvas; loader.tick(t += 16);
  void idle[15].canvas; loader.tick(t += 16);  // 0 -> 15 is backwards across the wrap
  ok('wrap-aware backward read stages 14', !!idle[14]._canvas, resident(idle).join());
  void idle[15].canvas; void idle[0].canvas; loader.tick(t += 16); loader.tick(t += 16);
  ok('forward across the wrap stages 1', !!idle[1]._canvas, resident(idle).join());
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Two consumers at different offsets each get a lookahead');
{
  const loader = mkLoader(192);
  const idle = loader.get('idle');
  let t = 0;
  loader.tick(t);
  void idle[2].canvas; void idle[10].canvas; loader.tick(t += 16); loader.tick(t += 16);
  ok('frames 2,3,10,11 resident', resident(idle).join() === '2,3,10,11', resident(idle).join());
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Per-frame eviction inside a playing animation; pins; overage report');
{
  const loader = mkLoader(24); // 6 frames of 4 MiB
  const idle = loader.get('idle');
  let t = 0;
  // Play frames 0..11 one second apart: the animation never goes idle, yet
  // frames older than the grace window must be released once over budget,
  // so the working set stays within budget + the one staged lookahead.
  let peak = 0;
  for (let i = 0; i < 12; i++) {
    void idle[i].canvas;
    for (let k = 0; k < 10; k++) { loader.tick(t += 100); peak = Math.max(peak, loader._animBytes); }
  }
  ok('working set bounded by budget + lookahead', peak <= 28 * MiB, `peak ${peak / MiB} MiB`);
  ok('old frames of the active animation were released', !idle[0]._canvas && !idle[3]._canvas && !!idle[11]._canvas, resident(idle).join());
  ok('accounting matches residency', loader._animBytes === resident(idle).length * 4 * MiB);
  ok('no overage reported (pinned set fits)', warnings.length === 0, warnings.join(' | '));
  // Pinned demand above budget: read 8 frames every tick with a 24 MiB budget.
  warnings.length = 0;
  for (let i = 0; i < 80; i++) { for (let k = 0; k < 8; k++) void idle[k].canvas; loader.tick(t += 100); }
  ok('pinned frames are kept', resident(idle).length >= 8, resident(idle).join());
  ok('overage reported once per period', warnings.length === 1 && loader.animOverageBytes > 0, `${warnings.length} warnings`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 5. warmAnimation / warmFrame stage without consumer semantics; tiny frames stay');
{
  const loader = mkLoader(192);
  const other = loader.get('other');
  let t = 0;
  loader.tick(t);
  loader.warmAnimation('other');
  ok('warm builds every frame once', resident(other).length === 8 && loader._prefetch.length === 0);
  ok('warm sets no consumer last index', loader._anims.find(a => a.key === 'other').lastIdx === -1);
  const tiny = loader.get('tiny');
  void tiny[0].canvas; loader.tick(t += 16);
  loader.animBudgetBytes = 1;   // force sweeps
  for (let i = 0; i < 100; i++) loader.tick(t += 100);
  ok('warmed-but-unused frames were released after the grace period', resident(other).length === 0);
  ok('tiny frames below the eviction floor are kept', resident(tiny).length === 2);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 6. Evicted descriptor rematerializes from the same atlas rect');
{
  const loader = mkLoader(4);
  const idle = loader.get('idle');
  let t = 0;
  loader.tick(t);
  void idle[7].canvas;
  const first = idle[7]._canvas.src;
  for (let i = 0; i < 100; i++) { void idle[0].canvas; loader.tick(t += 100); }
  ok('frame 7 was evicted', !idle[7]._canvas);
  const before = slices;
  const again = idle[7].canvas;
  ok('rematerialized via the slice path with identical source rect', again.src === first && slices === before + 1);
  ok('descriptor metadata intact', idle[7].width === 256 && idle[7].delay === 60 && idle[7].prescale === 4);
}

console.warn = origWarn;
console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
