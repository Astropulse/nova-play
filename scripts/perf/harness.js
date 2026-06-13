// Scenario performance suite. A command-driven bot (scripts/perf/bot.js) flies
// the real ship through a full gameplay arc while the harness measures TRUE
// per-frame compute time, fully decomposed (loop = update + draw + screenFx +
// overhead), split into update-side vs draw-side profiler sections plus every
// untracked draw sub-method (HUD, indicators, shop/cache overlays). Results are
// emitted PER PHASE so brief, spiky phases — especially the cache roll — get a
// clean summary instead of being averaged into neighbours.
//
// Phases: SETUP, STAY, FLY_OUT, ASTEROID_FIELD, CLEAR_ASTEROIDS, SHOP,
//         CACHE_ROLL, CACHE_IDLE, ENCOUNTER, WAVE, BOSS, KNOWLEDGE.

import { Bot } from '/scripts/perf/bot.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const round = (v) => Math.round(v * 100) / 100;
function post(o) { try { fetch('/perflog', { method: 'POST', body: JSON.stringify(o), keepalive: true }); } catch (e) {} }
async function waitFor(p, t = 30000, s = 100) { const a = performance.now(); while (performance.now() - a < t) { if (p()) return true; await sleep(s); } return false; }

let canvasCreated = 0;
const _origCreate = document.createElement.bind(document);
document.createElement = function (t, ...r) { if (typeof t === 'string' && t.toLowerCase() === 'canvas') canvasCreated++; return _origCreate(t, ...r); };

(async () => {
    const ok = await waitFor(() => window.__novaGame && window.__novaGame.assets
        && window.__novaGame.assets.get('enemy_ship_0') && window.__novaGame.assets.get('asteroid_big_0'));
    const g = window.__novaGame;
    if (!ok || !g) { post({ tag: 'FAIL', reason: 'no game/assets' }); return; }

    const [ps, ships, enemyMod, astMod, prewarm, kn, upg, shopMod, ftMod] = await Promise.all([
        import('/src/states/playingState.js'), import('/src/data/ships.js'),
        import('/src/entities/enemy.js'), import('/src/entities/asteroid.js'),
        import('/src/engine/prewarm.js'), import('/src/entities/knowledgeEvent.js'),
        import('/src/data/upgrades.js'), import('/src/entities/shop.js'),
        import('/src/entities/floatingText.js'),
    ]);
    const { PlayingState } = ps, { SHIPS } = ships, { Enemy } = enemyMod;
    const { Asteroid, Rubble, Scrap, ExpOrb } = astMod;
    const { KnowledgeEvent } = kn, { UPGRADES } = upg, { Shop } = shopMod, { FloatingText } = ftMod;
    try { for (let i = 0; i < 80 && !prewarm.pumpRunPrewarm(g, 1); i++) {} } catch (e) {}

    g.setState(new PlayingState(g, SHIPS[0]));
    const S = g.currentState;
    g.devMode = false;
    try { g.sounds.setSfxVolume(0); g.sounds.setMusicVolume(0); } catch (e) {}
    // Preset exp so the exp-bar bloom draws from the start (for bloom measurement).
    try { S.player.exp = (S.player.expNeeded || 100) * 0.6; } catch (e) {}
    // ?nolowperf=1 holds lowPerfMode OFF (overrides auto-detection) so we can
    // measure the FULL bloom cost on software-raster hardware as an A/B baseline.
    const NOLP = new URLSearchParams(location.search).get('nolowperf') === '1';
    if (NOLP) setInterval(() => { g.lowPerfMode = false; }, 100);

    // ── Full-accounting instrumentation, accumulated PER PHASE ──
    let phase = 'SETUP';
    const acc = newAcc();
    function newAcc() {
        const sect = {}; for (const c of S.perf.components) sect[c] = 0;
        return { frameSum: 0, frameN: 0, frameMax: 0, upd: 0, draw: 0, sfx: 0,
            updSect: { ...sect }, drawSect: { ...sect }, methods: {},
            // Pure-compute sub-breakdowns (performance.now() only — no canvas
            // readback, so these are accurate regardless of raster pipeline).
            ai: { avoid: 0, aiState: 0, target: 0, enemyN: 0 },
            // Per-particle-type draw-submission time, summed across instances.
            pdraw: { scrap: 0, rubble: 0, orb: 0, ft: 0 } };
    }
    function flushPhase() {
        const a = acc;
        if (a.frameN < 3) return; // ignore near-empty phases
        const n = a.frameN;
        const sectOut = (o) => { const r = {}; for (const k in o) { const v = o[k] / n; if (v >= 0.03) r[k] = round(v); } return r; };
        post({
            tag: 'PHASE', phase,
            frameMean: round(a.frameSum / n), frameMax: round(a.frameMax),
            potentialFps: a.frameSum > 0 ? Math.round(n / a.frameSum * 1000) : 0,
            upd: round(a.upd / n), draw: round(a.draw / n), sfx: round(a.sfx / n),
            updSect: sectOut(a.updSect), drawSect: sectOut(a.drawSect), methods: sectOut(a.methods),
            // Enemy-AI compute split (ms/frame, summed across all enemies).
            ai: { avoid: round(a.ai.avoid / n), aiState: round(a.ai.aiState / n), target: round(a.ai.target / n) },
            // Per-particle-type draw-submission split (ms/frame).
            pdraw: { scrap: round(a.pdraw.scrap / n), rubble: round(a.pdraw.rubble / n), orb: round(a.pdraw.orb / n), ft: round(a.pdraw.ft / n) },
            avoidSplit: { ast: round((Enemy._pAst || 0) / n), sep: round((Enemy._pSep || 0) / n), dodge: round((Enemy._pDodge || 0) / n) },
            en: S.enemies.length, ast: S.asteroids.length, proj: S.projectiles.length, canvases: canvasCreated,
            // Live particle-population counts — "sheer number of calculations".
            counts: { spk: S.sparks.length, rub: S.rubble.length, ft: S.floatingTexts.length, orb: S.expOrbs.length, scr: S.scrapEntities.length, exp: (S.explosions || []).length },
            lowPerf: !!g.lowPerfMode, potFps: g.potentialFps,
        });
        try { Enemy._pAst = 0; Enemy._pSep = 0; Enemy._pDodge = 0; } catch (e) {}
    }
    function setPhase(name) { flushPhase(); Object.assign(acc, newAcc()); try { Enemy._pAst = 0; Enemy._pSep = 0; Enemy._pDodge = 0; } catch (e) {} phase = name; post({ tag: 'PHASE_START', phase: name }); }

    // Wrap untracked draw sub-methods into acc.methods.
    const afterUpd = new Map();
    function wrapDraw(obj, name, label) {
        if (!obj || typeof obj[name] !== 'function') return;
        const orig = obj[name].bind(obj); acc.methods[label] = 0;
        obj[name] = function (...a) { const t0 = performance.now(); const r = orig(...a); acc.methods[label] = (acc.methods[label] || 0) + (performance.now() - t0); return r; };
    }
    wrapDraw(S.hud, 'draw', 'hud');
    for (const m of ['_drawExpBar', '_drawRadar', '_drawOverheal', '_drawTrackedAchievements'])
        wrapDraw(S.hud, m, 'hud' + m.replace('_draw', ''));
    for (const m of ['_drawEnemyIndicators', '_drawShopIndicators', '_drawCacheIndicators', '_drawEventIndicators', '_drawCacheOverlay', '_drawShopOverlay'])
        wrapDraw(S, m, m.replace('_draw', ''));
    wrapDraw(S.killStreak, 'drawOverlay', 'streakOv');
    wrapDraw(S.killStreak, 'drawWorld', 'streakWorld');
    wrapDraw(S.dread, 'drawOverlay', 'dreadOv');
    wrapDraw(S.ambience, 'draw', 'ambience');
    // Particle-draw sub-methods (these sit inside the 'particles' draw section;
    // breaking them out shows which particle kind costs the JS submission).
    wrapDraw(S, '_drawSparks', 'sparks');
    wrapDraw(S, '_drawExplosions', 'explosions');

    // Enemy-AI sub-phase timing — summed across every enemy each frame. Pure
    // performance.now() brackets (no canvas touch), so these stay accurate
    // whatever the raster pipeline is doing. Reveals whether the WAVE compute
    // cost is obstacle avoidance, the AI state machine, or target selection.
    function wrapAI(proto, name, key) {
        if (!proto || typeof proto[name] !== 'function') return;
        const orig = proto[name];
        proto[name] = function (...a) { const t0 = performance.now(); const r = orig.apply(this, a); acc.ai[key] += performance.now() - t0; return r; };
    }
    wrapAI(Enemy.prototype, '_avoidObstacles', 'avoid');
    wrapAI(Enemy.prototype, '_updateAIState', 'aiState');
    wrapAI(Enemy.prototype, '_getTargetAngle', 'target');

    // Per-particle-type draw cost (summed across all instances each frame), so
    // we can see WHICH particle kind owns the draw-call budget in a wave.
    function wrapPDraw(cls, key) {
        if (!cls || !cls.prototype || typeof cls.prototype.draw !== 'function') return;
        const orig = cls.prototype.draw;
        cls.prototype.draw = function (...a) { const t0 = performance.now(); const r = orig.apply(this, a); acc.pdraw[key] += performance.now() - t0; return r; };
    }
    wrapPDraw(Scrap, 'scrap');
    wrapPDraw(Rubble, 'rubble');
    wrapPDraw(ExpOrb, 'orb');
    wrapPDraw(FloatingText, 'ft');
    // Enable the in-method split of _avoidObstacles (asteroid / separation /
    // projectile-dodge) so we see which sub-part of avoidance costs the most.
    Enemy._PROF = true; Enemy._pAst = 0; Enemy._pSep = 0; Enemy._pDodge = 0;

    const origUpdate = S.update.bind(S);
    S.update = function (dt) { const t0 = performance.now(); origUpdate(dt); acc.upd += performance.now() - t0; afterUpd.clear(); for (const [k, v] of S.perf._current) afterUpd.set(k, v); };
    const origDraw = S.draw.bind(S);
    S.draw = function (ctx) {
        const t0 = performance.now(); origDraw(ctx); acc.draw += performance.now() - t0;
        for (const [k, v] of S.perf._current) { const u = afterUpd.get(k) || 0; if (acc.drawSect[k] !== undefined) acc.drawSect[k] += (v - u); }
        for (const [k, v] of afterUpd) { if (acc.updSect[k] !== undefined) acc.updSect[k] += v; }
    };
    let sfxWrapped = false;
    const origLoop = g.loop.bind(g);
    g.loop = function () {
        if (!sfxWrapped && g.screenFx && g.screenFx.render) { const o = g.screenFx.render.bind(g.screenFx); g.screenFx.render = function (...a) { const t0 = performance.now(); const r = o(...a); acc.sfx += performance.now() - t0; return r; }; sfxWrapped = true; }
        const t0 = performance.now(); origLoop(); const d = performance.now() - t0;
        acc.frameSum += d; acc.frameN++; if (d > acc.frameMax) acc.frameMax = d;
        if (S.perf && S.perf.commitFrame) { try { S.perf.commitFrame(); } catch (e) {} }
    };
    // Fallback flush for long phases so they don't accumulate unbounded.
    setInterval(() => { if (acc.frameN > 220) { flushPhase(); Object.assign(acc, newAcc()); } }, 3000);

    const bot = new Bot(g);
    const P = () => S.player;
    const give = (id) => { const u = UPGRADES.find(x => x.id === id); if (u && S.player.inventory.autoAdd) S.player.inventory.autoAdd(u); };

    // ── The scenario ──
    try {
        bot.log('suite start');
        // Loadout so kills + travel are fast (real upgrades).
        ['repeater', 'laser_override', 'laser_cartridge', 'mechanical_engines', 'rockets', 'auto_turret'].forEach(give);
        try { S._onInventoryChanged(); } catch (e) {}
        S.player.invulnTimer = 1e9; // bot survives the whole arc
        // 3x damage so the bot clears combat quickly (test pacing only).
        const buffDamage = () => { S.player.laserCartridgeMult = (S.player.laserCartridgeMult || 1) * 3; };
        buffDamage();

        setPhase('STAY');
        await bot.stayPut(5000, false);

        setPhase('FLY_OUT');           // push into open space → natural asteroid spawns
        await bot.flyOut(3500, 0, 18000);

        setPhase('ASTEROID_FIELD');    // dense field via the game's own entities
        for (let i = 0; i < 60; i++) {
            const a = Math.random() * Math.PI * 2, d = 250 + Math.random() * 1500;
            const sz = ['big', 'medium', 'medium', 'small', 'tiny'][i % 5];
            S.asteroids.push(new Asteroid(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, sz, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30));
        }
        await bot.stayPut(2500, false);

        setPhase('CLEAR_ASTEROIDS');   // destroy them with the ship
        await bot.destroy('asteroids', 4, 30000);

        setPhase('SHOP');              // spawn a shop, fly to it, open, buy, close
        { const sh = new Shop(g, P().worldX + 700, P().worldY + 200); S.shops.push(sh);
          await bot.flyTo(sh.worldX, sh.worldY, 200, 15000);
          S._openShop(sh); await waitFor(() => S.isShopOpen, 2000);
          await sleep(1500); // shop overlay drawing
          ['shield_booster', 'small_battery'].forEach(give); try { S._onInventoryChanged(); } catch (e) {}
          buffDamage(); // _onInventoryChanged recomputes the mult — re-assert 3x
          await sleep(1000);
          S.isShopOpen = false; S.paused = false; S.activeShop = null; }

        setPhase('CACHE_ROLL');        // THE reported lag: rolling animation
        let cache = null;
        { cache = S.cacheSpawner.spawnNear(P().worldX, P().worldY, 250, 450); S.caches.push(cache);
          await bot.flyTo(cache.worldX, cache.worldY, 170, 12000);
          S._openCacheUI(cache); await waitFor(() => S.isCacheOpen, 2000);
          // measure through the rolling/reveal animation specifically
          await waitFor(() => S.activeCacheUI && S.activeCacheUI.uiState === 'idle', 7000); }

        setPhase('CACHE_IDLE');
        await sleep(1500);
        { if (S.activeCacheUI) S.activeCacheUI.close(); await waitFor(() => !S.isCacheOpen, 3000); }

        setPhase('FLY_AWAY');
        await bot.flyOut(1200, Math.PI, 8000);

        setPhase('ENCOUNTER');         // spawn, talk, aggro, kill
        { S._spawnEncounter(); await sleep(200);
          const enc = S.encounters[S.encounters.length - 1];
          if (enc) {
            enc.worldX = P().worldX + 500; enc.worldY = P().worldY; // bring it close for the test
            await bot.flyTo(enc.worldX, enc.worldY, 220, 10000);
            S._openEncounterDialog(enc); await waitFor(() => S.isEncounterOpen, 2000);
            await sleep(1200); // dialog drawing
            enc.shouldConvertHostile = true;
            if (S.activeEncounterDialog) S.activeEncounterDialog.closed = true;
            await waitFor(() => !S.isEncounterOpen, 2000);
            await bot.destroy('enemies', 0, 15000);
          } }

        setPhase('WAVE');              // high-difficulty wave, fight to the end
        { try { S.enemySpawner.spawnWave(P().worldX, P().worldY, 8, 1.5); } catch (e) {}
          for (let i = 0; i < 28; i++) { const a = Math.random() * Math.PI * 2, d = 500 + Math.random() * 700;
            const en = new Enemy(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, 8); Enemy.rollUpgrade(en, S.player); S.enemies.push(en); }
          await bot.destroy('enemies', 0, 45000); }

        setPhase('BOSS');              // spawn boss, drive to phase 2, then kill
        { const arr = S.enemySpawner.forceBoss(P().worldX, P().worldY, 6); S.enemies.push(...arr);
          const boss = arr.find(e => e.isBoss);
          if (boss) { boss.worldX = P().worldX + 650; boss.worldY = P().worldY;
            // fire until phase 2 (health < 40% or phase flag), then keep firing to kill
            await bot._until(() => !boss.alive || boss.phase === 'attack2' || boss.health < boss.maxHealth * 0.4, 30000,
              () => { bot._aimWorld(boss.worldX, boss.worldY); bot._fire(true); bot._thrust(bot._dist(boss.worldX, boss.worldY) > 500); });
            bot.log('boss phase2 reached');
            await bot._until(() => !boss.alive, 30000, () => { bot._aimWorld(boss.worldX, boss.worldY); bot._fire(true); bot._thrust(bot._dist(boss.worldX, boss.worldY) > 500); });
            bot._idle(); } }

        setPhase('KNOWLEDGE');         // fly to the knowledge event and fight it
        { const ke = new KnowledgeEvent(g, P().worldX + 900, P().worldY); S.events.push(ke);
          await bot.flyTo(ke.worldX, ke.worldY, 250, 12000);
          await bot._until(() => ke.state === 3 /* DEFEATED */ || !ke.alive, 35000,
            () => { bot._aimWorld(ke.worldX, ke.worldY); bot._fire(true); bot._thrust(bot._dist(ke.worldX, ke.worldY) > 350); });
          bot._idle(); }

        setPhase('DONE');
        flushPhase();
        post({ tag: 'DONE' });
        bot.log('suite complete');
    } catch (err) {
        post({ tag: 'SUITE_ERR', err: String(err && err.stack || err) });
    }
})();
