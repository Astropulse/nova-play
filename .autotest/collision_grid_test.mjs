// Deterministic, headless differential test of the collision broad phase
// (engine/spatialHash.js insertBox/queryBoxInto + collision.js hullBoundRadius)
// against the plain array scans PlayingState used to run.
//
// The candidate-selection logic below mirrors PlayingState._firstAsteroidHit /
// _firstEnemyHit / the host enemy-vs-asteroid loop exactly (grid candidates
// for indices < N, lowest passing index wins, live tail scan for entities
// appended after the build). For thousands of seeded populations and shots —
// long low-fps sweeps across many cells, giant hulls, rotated ellipses, mid-
// loop appends and kills — the chosen target must be the same object the
// brute-force scan picks, and the pair-visit count must be far smaller.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/collision_grid_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

const { SpatialHash } = await import('../src/engine/spatialHash.js');
const { ellipseSweep, hullBoundRadius } = await import('../src/engine/collision.js');

const mulberry = (a) => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// Copy of playingState.js _projSweepHit (module-private there).
function projSweepHit(proj, cx, cy, cr) {
  const p0x = proj._prevX !== undefined ? proj._prevX : proj.worldX;
  const p0y = proj._prevY !== undefined ? proj._prevY : proj.worldY;
  const dx = proj.worldX - p0x, dy = proj.worldY - p0y;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((cx - p0x) * dx + (cy - p0y) * dy) / len2 : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const ex = p0x + dx * t - cx, ey = p0y + dy * t - cy;
  return ex * ex + ey * ey < cr * cr;
}

// Fake atlas hitboxes so enemies resolve real ellipses through collision.js.
const HITBOXES = { ship_a: { rx: 14, ry: 9 }, ship_b: { rx: 30, ry: 12 }, boss: { rx: 160, ry: 95 } };
const game = { assets: { getHitbox: (k) => HITBOXES[k] || null } };

// ── The PlayingState logic under test (kept in step with playingState.js) ──
let pairVisitsGrid = 0, pairVisitsBrute = 0;
function buildGrids(asts, ens, astGrid, enGrid) {
  astGrid.clear(); enGrid.clear();
  for (let i = 0; i < asts.length; i++) {
    const a = asts[i]; a._collIdx = i;
    if (!a.alive || !a._nearPlayer) continue;
    const r = a.radius;
    astGrid.insertBox(a, a.worldX - r, a.worldY - r, a.worldX + r, a.worldY + r);
  }
  for (let i = 0; i < ens.length; i++) {
    const e = ens[i]; e._collIdx = i;
    if (!e.alive || !e._nearPlayer) continue;
    const r = hullBoundRadius(e);
    enGrid.insertBox(e, e.worldX - r, e.worldY - r, e.worldX + r, e.worldY + r);
  }
  return { astN: asts.length, enN: ens.length };
}
function queryBox(proj, pad) {
  const p1x = proj.worldX, p1y = proj.worldY;
  const p0x = proj._prevX !== undefined ? proj._prevX : p1x;
  const p0y = proj._prevY !== undefined ? proj._prevY : p1y;
  return { minX: Math.min(p0x, p1x) - pad, maxX: Math.max(p0x, p1x) + pad, minY: Math.min(p0y, p1y) - pad, maxY: Math.max(p0y, p1y) + pad };
}
const scratch = [];
function firstHitGrid(proj, grid, arr, N, test) {
  const b = queryBox(proj, proj.radius + 1);
  const cand = grid.queryBoxInto(b.minX, b.minY, b.maxX, b.maxY, scratch);
  let best = null, bestIdx = N;
  for (let i = 0; i < cand.length; i++) {
    const e = cand[i];
    if (e._collIdx >= bestIdx || !e.alive || !e._nearPlayer) continue;
    pairVisitsGrid++;
    if (test(e, proj)) { best = e; bestIdx = e._collIdx; }
  }
  if (best) return best;
  for (let i = N; i < arr.length; i++) {
    const e = arr[i];
    if (!e.alive || !e._nearPlayer) continue;
    pairVisitsGrid++;
    if (test(e, proj)) return e;
  }
  return null;
}
function firstHitBrute(proj, arr, test) {
  for (const e of arr) {
    if (!e.alive || !e._nearPlayer) continue;
    pairVisitsBrute++;
    if (test(e, proj)) return e;
  }
  return null;
}
const astTest = (a, p) => projSweepHit(p, a.worldX, a.worldY, p.radius + a.radius);
const enTest = (e, p) => ellipseSweep(e, p, p.radius);

// ── Populations ────────────────────────────────────────────────────────────
function population(rng, nAst, nEn, spread) {
  const asts = [], ens = [];
  for (let i = 0; i < nAst; i++) {
    asts.push({ worldX: (rng() - 0.5) * spread, worldY: (rng() - 0.5) * spread,
      radius: rng() < 0.05 ? 90 + rng() * 60 : 8 + rng() * 40, alive: rng() > 0.03, _nearPlayer: rng() > 0.1 });
  }
  const keys = ['ship_a', 'ship_b', 'boss', null];
  for (let i = 0; i < nEn; i++) {
    const key = keys[Math.floor(rng() * keys.length)];
    ens.push({ game, spriteKey: key, worldX: (rng() - 0.5) * spread, worldY: (rng() - 0.5) * spread,
      radius: key === 'boss' ? 120 : (rng() < 0.02 ? 0 : 10 + rng() * 25), angle: rng() * Math.PI * 2,
      hitScale: key === 'boss' && rng() < 0.5 ? 1.5 : undefined,
      hitRotAbs: rng() < 0.1 ? 0 : undefined,
      alive: rng() > 0.03, _nearPlayer: rng() > 0.1 });
  }
  return { asts, ens };
}
function shot(rng, spread) {
  const x = (rng() - 0.5) * spread, y = (rng() - 0.5) * spread;
  const kind = rng();
  const p = { worldX: x, worldY: y, radius: rng() < 0.1 ? 40 : 2 + rng() * 6 };
  if (kind < 0.7) { const a = rng() * Math.PI * 2, len = rng() * 60; p._prevX = x - Math.cos(a) * len; p._prevY = y - Math.sin(a) * len; }
  else if (kind < 0.9) { const a = rng() * Math.PI * 2, len = 300 + rng() * 1500; p._prevX = x - Math.cos(a) * len; p._prevY = y - Math.sin(a) * len; } // low-fps sweep
  else if (kind < 0.95) { p._prevX = x; p._prevY = y; } // stationary
  // else: no _prevX (point test)
  return p;
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. insertBox / queryBoxInto vs brute-force box overlap');
{
  const rng = mulberry(11);
  let bad = 0, dup = 0, cases = 0;
  for (let round = 0; round < 200; round++) {
    const g = new SpatialHash(64 + Math.floor(rng() * 300));
    g.clear();
    const items = [];
    for (let i = 0; i < 80; i++) {
      const x = (rng() - 0.5) * 6000, y = (rng() - 0.5) * 6000, r = rng() * (rng() < 0.1 ? 900 : 60);
      const it = { i, minX: x - r, maxX: x + r, minY: y - r, maxY: y + r };
      items.push(it); g.insertBox(it, it.minX, it.minY, it.maxX, it.maxY);
    }
    for (let q = 0; q < 30; q++) {
      const x = (rng() - 0.5) * 6000, y = (rng() - 0.5) * 6000, w = rng() * 800, h = rng() * 800;
      const out = g.queryBoxInto(x, y, x + w, y + h, []);
      cases++;
      if (new Set(out).size !== out.length) dup++;
      const got = new Set(out);
      for (const it of items) {
        const overlaps = !(it.maxX < x || it.minX > x + w || it.maxY < y || it.minY > y + h);
        if (overlaps && !got.has(it)) bad++;
      }
    }
  }
  ok('every overlapping box is a candidate', bad === 0, `${bad} misses over ${cases} queries`);
  ok('candidates are deduplicated', dup === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Projectile target selection == plain array scan (asteroids + enemy hulls)');
{
  const rng = mulberry(2026);
  const astGrid = new SpatialHash(256), enGrid = new SpatialHash(256);
  let mismatch = 0, hits = 0, shots = 0;
  for (let round = 0; round < 150; round++) {
    const spread = 1500 + rng() * 6000;
    const { asts, ens } = population(rng, 40 + Math.floor(rng() * 400), 10 + Math.floor(rng() * 80), spread);
    const { astN, enN } = buildGrids(asts, ens, astGrid, enGrid);
    for (let s = 0; s < 120; s++) {
      const p = shot(rng, spread);
      shots++;
      const a1 = firstHitGrid(p, astGrid, asts, astN, astTest), a2 = firstHitBrute(p, asts, astTest);
      const e1 = firstHitGrid(p, enGrid, ens, enN, enTest), e2 = firstHitBrute(p, ens, enTest);
      if (a1 !== a2 || e1 !== e2) mismatch++;
      if (a2 || e2) hits++;
      // Mid-loop mutations the callbacks perform: kill the hit target and
      // append debris / drones (carrying _nearPlayer) — later shots must see them.
      if (a2 && rng() < 0.5) { a2.alive = false; asts.push({ worldX: a2.worldX + (rng() - 0.5) * 30, worldY: a2.worldY + (rng() - 0.5) * 30, radius: a2.radius * 0.5, alive: true, _nearPlayer: true }); }
      if (e2 && rng() < 0.5) { e2.alive = false; ens.push({ game, spriteKey: 'ship_a', worldX: e2.worldX, worldY: e2.worldY, radius: 12, angle: rng() * 6, alive: true, _nearPlayer: true }); }
    }
  }
  ok('same target object for every shot', mismatch === 0, `${mismatch} mismatches over ${shots} shots (${hits} hits)`);
  ok('broad phase visits far fewer pairs', pairVisitsGrid * 5 < pairVisitsBrute, `${pairVisitsGrid} vs ${pairVisitsBrute}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Host enemy-vs-asteroid loop: visit sequence == plain scan (with mid-loop kills/spawns)');
{
  const rng = mulberry(77);
  const astGrid = new SpatialHash(256), enGrid = new SpatialHash(256);
  let mismatch = 0, rounds = 0, events = 0;
  const byIdx = (a, b) => a._collIdx - b._collIdx;
  const runLoop = (ens, asts, useGrid, astN, log) => {
    for (const en of ens) {
      if (!en.alive || !en._nearPlayer) continue;
      let cands = null;
      if (useGrid) {
        const er = en.radius + 1;
        cands = astGrid.queryBoxInto(en.worldX - er, en.worldY - er, en.worldX + er, en.worldY + er, []);
        if (cands.length > 1) cands.sort(byIdx);
      }
      const nCand = useGrid ? cands.length : 0;
      for (let ci = 0; ; ci++) {
        let ast;
        if (useGrid) {
          if (ci < nCand) ast = cands[ci];
          else { const ti = astN + (ci - nCand); if (ti >= asts.length) break; ast = asts[ti]; }
        } else { if (ci >= asts.length) break; ast = asts[ci]; }
        if (!ast.alive || !ast._nearPlayer) continue;
        const dx = en.worldX - ast.worldX, dy = en.worldY - ast.worldY, cr = en.radius + ast.radius;
        if (dx * dx + dy * dy < cr * cr) {
          log.push(`${en.id}:${ast.id}`);
          en.hp -= 1;
          if (ast.tractoredBy === en) continue;
          if (--ast.hp <= 0) {
            ast.alive = false;
            // death debris appended mid-loop
            asts.push({ id: `${ast.id}+`, worldX: ast.worldX + 5, worldY: ast.worldY - 5, radius: ast.radius * 0.6, alive: true, _nearPlayer: true, hp: 1 });
          }
          if (en.hp <= 0) en.alive = false;
        }
      }
    }
  };
  for (let round = 0; round < 200; round++) {
    const spread = 600 + rng() * 2500;
    const base = population(rng, 30 + Math.floor(rng() * 200), 10 + Math.floor(rng() * 60), spread);
    base.asts.forEach((a, i) => { a.id = `a${i}`; a.hp = 1 + Math.floor(rng() * 2); });
    base.ens.forEach((e, i) => { e.id = `e${i}`; e.hp = 1 + Math.floor(rng() * 3); if (rng() < 0.1) base.asts[Math.floor(rng() * base.asts.length)].tractoredBy = e; });
    const clone = (o) => ({ ...o });
    const A = { asts: base.asts.map(clone), ens: base.ens.map(clone) };
    const B = { asts: base.asts.map(clone), ens: base.ens.map(clone) };
    // tractoredBy must point at the cloned enemy in each copy
    for (const set of [A, B]) for (const a of set.asts) if (a.tractoredBy) a.tractoredBy = set.ens[base.ens.indexOf(a.tractoredBy)];
    const logA = [], logB = [];
    const { astN } = buildGrids(B.asts, B.ens, astGrid, enGrid);
    runLoop(A.ens, A.asts, false, 0, logA);
    runLoop(B.ens, B.asts, true, astN, logB);
    rounds++; events += logA.length;
    if (logA.join('|') !== logB.join('|')) mismatch++;
    const stateA = A.asts.map(a => `${a.id}${a.alive ? 1 : 0}`).join() + A.ens.map(e => `${e.id}${e.alive ? 1 : 0}${e.hp}`).join();
    const stateB = B.asts.map(a => `${a.id}${a.alive ? 1 : 0}`).join() + B.ens.map(e => `${e.id}${e.alive ? 1 : 0}${e.hp}`).join();
    if (stateA !== stateB) mismatch++;
  }
  ok('identical contact sequence + resulting arrays', mismatch === 0, `${mismatch} mismatches over ${rounds} rounds (${events} contacts)`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
