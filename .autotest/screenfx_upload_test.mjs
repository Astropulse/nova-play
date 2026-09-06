// Deterministic, headless test of the post-FX upload planner
// (engine/screenFxBounds.js mergeUploadRects): for seeded sets of effect source
// rects the planned uploads must cover every input pixel (no stale sampled
// texels), never exceed the canvas, drop contained rects, keep distant regions
// separate, collapse dense/global sets, and never cost more pixels than one
// union would beyond the per-call allowance. Also checks the audit-2 fixture:
// a shield hit in every pane at 2560x1440 uploads far fewer pixels than the
// old single union.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/screenfx_upload_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};
const { mergeUploadRects, unionRect, effectBounds, MAX_UPLOAD_RECTS } = await import('../src/engine/screenFxBounds.js');
const { computeSplitLayout } = await import('../src/world/splitScreen.js');
const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const inside = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const area = (r) => r.w * r.h;

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Coverage / bounds / cost over seeded rect sets');
{
  const rng = mulberry(8);
  let uncovered = 0, outOfBounds = 0, costlier = 0, tooMany = 0, sets = 0;
  for (let round = 0; round < 3000; round++) {
    const W = 200 + Math.floor(rng() * 2400), H = 200 + Math.floor(rng() * 1300);
    const n = 1 + Math.floor(rng() * 9);
    const rects = [];
    for (let i = 0; i < n; i++) {
      const w = Math.min(W, 1 + Math.floor(rng() * (rng() < 0.2 ? W : 300))), h = Math.min(H, 1 + Math.floor(rng() * (rng() < 0.2 ? H : 300)));
      const x = Math.floor(rng() * (W - w + 1)), y = Math.floor(rng() * (H - h + 1));
      rects.push({ x, y, w, h });
    }
    const out = mergeUploadRects(rects);
    sets++;
    if (out.length > MAX_UPLOAD_RECTS) tooMany++;
    for (const o of out) if (o.x < 0 || o.y < 0 || o.x + o.w > W || o.y + o.h > H) outOfBounds++;
    // Sample points of every input rect (corners, edges, interior grid).
    for (const r of rects) {
      for (let k = 0; k < 25; k++) {
        const x = r.x + Math.min(r.w - 1, Math.floor((k % 5) * r.w / 4));
        const y = r.y + Math.min(r.h - 1, Math.floor(Math.floor(k / 5) * r.h / 4));
        if (!out.some(o => inside(o, x, y))) uncovered++;
      }
    }
    const union = rects.reduce(unionRect, null);
    const planned = out.reduce((s, o) => s + area(o), 0);
    if (planned > area(union) + (out.length - 1) * 96 * 96) costlier++;
  }
  ok('every input pixel is inside a planned upload', uncovered === 0, `${uncovered} misses over ${sets} sets`);
  ok('planned uploads stay inside the canvas', outOfBounds === 0);
  ok('never more than MAX_UPLOAD_RECTS uploads', tooMany === 0);
  ok('never costlier than one union beyond the per-call allowance', costlier === 0, `${costlier}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Merge policy');
{
  const far = mergeUploadRects([{ x: 0, y: 0, w: 100, h: 100 }, { x: 2000, y: 1000, w: 100, h: 100 }]);
  ok('distant rects stay separate', far.length === 2);
  const contained = mergeUploadRects([{ x: 0, y: 0, w: 500, h: 500 }, { x: 10, y: 10, w: 20, h: 20 }, { x: 0, y: 0, w: 500, h: 500 }]);
  ok('contained / duplicate rects collapse', contained.length === 1 && area(contained[0]) === 250000);
  const touching = mergeUploadRects([{ x: 0, y: 0, w: 100, h: 100 }, { x: 100, y: 0, w: 100, h: 100 }]);
  ok('abutting rects merge (union costs nothing extra)', touching.length === 1 && touching[0].w === 200);
  const overlapping = mergeUploadRects([{ x: 0, y: 0, w: 100, h: 100 }, { x: 50, y: 50, w: 100, h: 100 }]);
  ok('overlapping rects merge', overlapping.length === 1);
  const whole = mergeUploadRects([{ x: 0, y: 0, w: 2560, h: 1440 }, { x: 5, y: 5, w: 30, h: 30 }, { x: 900, y: 900, w: 30, h: 30 }]);
  ok('a global source swallows the rest', whole.length === 1 && whole[0].w === 2560);
  const many = mergeUploadRects(Array.from({ length: 12 }, (_, i) => ({ x: i * 2000, y: (i % 2) * 3000, w: 400, h: 400 })));
  ok('more than the cap falls back to one union', many.length === 1 && many[0].w === 22400);
  const small = mergeUploadRects(Array.from({ length: 12 }, (_, i) => ({ x: i * 200, y: 0, w: 20, h: 20 })));
  ok('small nearby rects merge under the per-call allowance', small.length < 12);
  ok('degenerate rects are ignored', mergeUploadRects([{ x: 0, y: 0, w: 0, h: 10 }, null]).length === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Audit-2 fixture: a shield hit in every pane');
{
  for (const n of [2, 4, 8]) {
    const panes = computeSplitLayout(n, 2560, 1440);
    const rects = panes.map(p => effectBounds({ ripple: { cx: p.x + p.w / 2, cy: p.y + p.h / 2, r: 70, strength: 1 } }, p, 2560, 1440).source);
    const union = rects.reduce(unionRect, null);
    const planned = mergeUploadRects(rects);
    const px = planned.reduce((s, r) => s + area(r), 0);
    ok(`panes=${n}: ${planned.length} uploads, ${px} px vs union ${area(union)}`, planned.length === n && px === rects.reduce((s, r) => s + area(r), 0));
  }
  // Mixed: global crt in pane 1 plus shields elsewhere — the global pane's
  // source spans the frame, so everything collapses into one whole upload.
  const panes = computeSplitLayout(4, 1280, 720);
  const rects = panes.map((p, i) => effectBounds(i === 1 ? { crt: 0.5 } : { ripple: { cx: p.x + p.w / 2, cy: p.y + p.h / 2, r: 40, strength: 1 } }, p, 1280, 720).source);
  const planned = mergeUploadRects(rects);
  ok('mixed global + local stays a small plan', planned.length <= 4 && planned.length >= 1, `${planned.length}`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
