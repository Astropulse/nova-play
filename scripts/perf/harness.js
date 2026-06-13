// Full-accounting in-page perf harness. Decomposes EVERY millisecond of the
// real (uncapped) frame so nothing is attributed without a measured number.
//
// Top level (must sum to the frame): loop = update + draw + screenFx + overhead.
// draw is further split into update-side vs draw-side profiler sections (by
// diffing perf._current around update/draw) PLUS every untracked draw method
// (hud, indicators, overlays, ambience). A raw main-canvas drawImage probe runs
// each window to catch GPU-acceleration demotion. devMode is OFF (no dev overlay
// inflation); the profiler is committed manually from the loop hook.
//
// Scenario isolates the "drop after first kill": EMPTY -> PREKILL (enemies
// present, no asteroids, player holds fire => ZERO kills) -> KILL (player fires).
//
// URL: ?en=40 &diff=4

const Q = new URLSearchParams(location.search);
const N_EN = parseInt(Q.get('en') || '40', 10);
const DIFF = parseFloat(Q.get('diff') || '4');

let canvasCreated = 0;
const _origCreate = document.createElement.bind(document);
document.createElement = function (t, ...r) { if (typeof t === 'string' && t.toLowerCase() === 'canvas') canvasCreated++; return _origCreate(t, ...r); };

function post(o) { try { fetch('/perflog', { method: 'POST', body: JSON.stringify(o), keepalive: true }); } catch (e) {} }
const log = (tag, o) => post(Object.assign({ tag }, o));
async function waitFor(p, t = 30000, s = 100) { const a = performance.now(); while (performance.now() - a < t) { if (p()) return true; await new Promise(r => setTimeout(r, s)); } return false; }
const round = (v) => Math.round(v * 100) / 100;

(async () => {
    const ok = await waitFor(() => window.__novaGame && window.__novaGame.assets
        && window.__novaGame.assets.get('enemy_ship_0') && window.__novaGame.assets.get('asteroid_big_0'));
    const g = window.__novaGame;
    if (!ok || !g) { log('FAIL', { reason: 'no game/assets' }); return; }

    const [{ PlayingState }, { SHIPS }, { Enemy }, astMod, prewarm] = await Promise.all([
        import('/src/states/playingState.js'), import('/src/data/ships.js'),
        import('/src/entities/enemy.js'), import('/src/entities/asteroid.js'), import('/src/engine/prewarm.js'),
    ]);
    const Asteroid = astMod.Asteroid;
    try { for (let i = 0; i < 80 && !prewarm.pumpRunPrewarm(g, 1); i++) {} } catch (e) {}

    g.setState(new PlayingState(g, SHIPS[0]));
    const S = g.currentState;
    g.devMode = false;
    try { g.sounds.setSfxVolume(0); g.sounds.setMusicVolume(0); } catch (e) {}

    // ── Per-window accumulators ──
    let frameSum = 0, frameCount = 0, frameMax = 0, updSum = 0, drawSum = 0, sfxSum = 0;
    const drawMethods = {};               // wrapped untracked draw sub-methods
    const updSect = {}, drawSect = {};    // profiler section split (update vs draw side)
    for (const c of S.perf.components) { updSect[c] = 0; drawSect[c] = 0; }
    const afterUpd = new Map();

    // Wrap an object's method to accumulate ms into drawMethods[label].
    function wrapDraw(obj, name, label) {
        if (!obj || typeof obj[name] !== 'function') return;
        const orig = obj[name].bind(obj); drawMethods[label] = 0;
        obj[name] = function (...a) { const t0 = performance.now(); const r = orig(...a); drawMethods[label] += performance.now() - t0; return r; };
    }
    wrapDraw(S.hud, 'draw', 'hud');
    wrapDraw(S.hud, 'drawToast', 'hudToast');
    for (const m of ['_drawEnemyIndicators', '_drawAsteroidWarnings', '_drawShopIndicators', '_drawCacheIndicators',
        '_drawEventIndicators', '_drawBossWreckIndicators', '_drawEncounterIndicators', '_drawHealthIndicators', '_drawTotalGameTimer'])
        wrapDraw(S, m, m.replace('_draw', 'ix:'));
    wrapDraw(S.dread, 'drawOverlay', 'dreadOv');
    wrapDraw(S.killStreak, 'drawOverlay', 'streakOv');
    wrapDraw(S.killStreak, 'drawWorld', 'streakWorld');
    wrapDraw(S.cinematics, 'drawWorld', 'cineWorld');
    wrapDraw(S.cinematics, 'drawOverlay', 'cineOv');
    wrapDraw(S.ambience, 'draw', 'ambience');

    // Split profiler sections into update-side vs draw-side by snapshotting
    // perf._current after update() and diffing after draw().
    const origUpdate = S.update.bind(S);
    S.update = function (dt) {
        const t0 = performance.now(); origUpdate(dt); updSum += performance.now() - t0;
        afterUpd.clear(); for (const [k, v] of S.perf._current) afterUpd.set(k, v);
    };
    const origDraw = S.draw.bind(S);
    S.draw = function (ctx) {
        const t0 = performance.now(); origDraw(ctx); drawSum += performance.now() - t0;
        for (const [k, v] of S.perf._current) {
            const u = afterUpd.get(k) || 0;
            if (drawSect[k] !== undefined) { drawSect[k] += (v - u); }
            else { drawSect[k] = (v - u); }
        }
        for (const [k, v] of afterUpd) { if (updSect[k] !== undefined) updSect[k] += v; else updSect[k] = v; }
    };

    // Loop hook: true frame time, lazy screenFx wrap, manual commit.
    let sfxWrapped = false;
    const origLoop = g.loop.bind(g);
    g.loop = function () {
        if (!sfxWrapped && g.screenFx && typeof g.screenFx.render === 'function') {
            const o = g.screenFx.render.bind(g.screenFx);
            g.screenFx.render = function (...a) { const t0 = performance.now(); const r = o(...a); sfxSum += performance.now() - t0; return r; };
            sfxWrapped = true;
        }
        const t0 = performance.now(); origLoop(); const d = performance.now() - t0;
        frameSum += d; frameCount++; if (d > frameMax) frameMax = d;
        if (S.perf && S.perf.commitFrame) { try { S.perf.commitFrame(); } catch (e) {} }
    };

    // Raw main-canvas drawImage probe — jumps + stays high if the 2D canvas is
    // demoted off the GPU (e.g. by a burst of offscreen canvases on first kill).
    const benchCtx = g.canvas.getContext('2d');
    const benchImg = (() => { const a = g.assets.get('enemy_ship_0'); return a && (a.canvas || a); })();
    function bench() {
        if (!benchImg) return -1;
        const runs = [];
        for (let k = 0; k < 5; k++) {
            const t0 = performance.now();
            for (let i = 0; i < 300; i++) { benchCtx.setTransform(1, 0, 0, 1, (i * 7) % 300, (i * 11) % 300); benchCtx.drawImage(benchImg, 0, 0); }
            runs.push(performance.now() - t0);
        }
        benchCtx.setTransform(1, 0, 0, 1, 0, 0);
        runs.sort((a, b) => a - b); return round(runs[2]);
    }

    // ── Scenario control ──
    let stage = 'EMPTY', firstKillT = 0, lastKills = -1;
    let px = 0, py = 0, heading = 0;
    setInterval(() => {
        if (!S || g.currentState !== S || S.isDead) return;
        S.player.invulnTimer = 99999;
        const speed = stage === 'EMPTY' ? 300 : 90; // slow once combat starts
        heading += 0.22 * 0.016;
        px += Math.cos(heading) * speed * 0.016; py += Math.sin(heading) * speed * 0.016;
        S.player.worldX = px; S.player.worldY = py;
        S.player.vx = Math.cos(heading) * speed; S.player.vy = Math.sin(heading) * speed; S.player.angle = heading;
        if (stage === 'KILL') {
            g.input.mouseButtons.add(0);
            g.input.mouseScreenX = g.width / 2 + Math.cos(performance.now() / 600) * g.width * 0.4;
            g.input.mouseScreenY = g.height / 2 + Math.sin(performance.now() / 600) * g.height * 0.4;
        } else { g.input.mouseButtons.delete(0); }
    }, 16);

    setInterval(() => {
        if (!S || g.currentState !== S || S.isDead) return;
        if (stage === 'EMPTY') { S.asteroids.length = 0; S.enemies.length = 0; S.scrapEntities.length = 0; S.expOrbs.length = 0; S.rubble.length = 0; S.itemPickups.length = 0; return; }
        // PREKILL + KILL: keep 40 enemies, NO asteroids (so ram-deaths can't
        // happen in PREKILL). PREKILL never fires => zero kills.
        S.asteroids.length = 0;
        let live = 0; for (const e of S.enemies) if (!e.isBoss) live++;
        for (let i = live; i < N_EN; i++) {
            const a = Math.random() * Math.PI * 2, d = 500 + Math.random() * 700;
            S.enemies.push(new Enemy(g, S.player.worldX + Math.cos(a) * d, S.player.worldY + Math.sin(a) * d, DIFF));
        }
    }, 300);

    function counts() {
        const L = (a) => (a && a.length) || 0;
        return { en: L(S.enemies), proj: L(S.projectiles), scrap: L(S.scrapEntities), exp: L(S.expOrbs), rubble: L(S.rubble), spark: L(S.sparks), ftxt: L(S.floatingTexts), canvases: canvasCreated };
    }

    function readout() {
        if (!S.perf || g.currentState !== S) return;
        const f = frameCount || 1;
        const frameMean = round(frameSum / f);
        const upd = round(updSum / f), draw = round(drawSum / f), sfx = round(sfxSum / f);
        const overhead = round(frameMean - upd - draw - sfx);
        const kills = S.stats ? (S.stats.enemiesDefeated + S.stats.asteroidsDestroyed) : 0;
        if (lastKills < 0) lastKills = kills;
        if (!firstKillT && kills > lastKills) { firstKillT = Math.round(performance.now()); log('FIRSTKILL', { t: firstKillT }); }
        const newKills = kills - lastKills; lastKills = kills;

        const dm = {}; for (const k in drawMethods) { const v = drawMethods[k] / f; if (v >= 0.02) dm[k] = round(v); drawMethods[k] = 0; }
        const ds = {}; for (const k in drawSect) { const v = drawSect[k] / f; if (v >= 0.02) ds[k] = round(v); drawSect[k] = 0; }
        const us = {}; for (const k in updSect) { const v = updSect[k] / f; if (v >= 0.02) us[k] = round(v); updSect[k] = 0; }
        const b = bench();
        frameSum = 0; frameCount = 0; frameMax = 0; updSum = 0; drawSum = 0; sfxSum = 0;
        log('FRAME', { stage, frameMean, upd, draw, sfx, overhead, bench: b, newKills, updSect: us, drawSect: ds, drawMethods: dm, counts: counts() });
    }
    setInterval(readout, 3000);

    log('START', { ua: navigator.userAgent, dpr: window.devicePixelRatio, cw: g.canvas.width, chh: g.canvas.height });
    for (const [ms, st] of [[0, 'EMPTY'], [12000, 'PREKILL'], [30000, 'KILL']])
        setTimeout(() => { stage = st; log('STAGE', { stage: st }); }, ms);
    setTimeout(() => log('DONE', {}), 70000);
})();
