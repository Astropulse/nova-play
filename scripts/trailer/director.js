// Trailer director — deterministic, frame-steppable scene timeline for the
// NOVA Steam trailer (scripts/trailer/).
//
// Borrowed philosophy from the RetroDiffusion ads pipeline: the whole trailer
// is a pure function of time. Instead of a static HTML page with SEEK(t), we
// drive the REAL game on a virtual clock: `performance.now` and
// `requestAnimationFrame` are replaced after boot, so the sim only advances
// when capture calls `window.TRAILER.step()` — exactly one 1/30s frame per
// call. Capture (capture.mjs) screenshots every recorded frame; preroll frames
// step fast with no screenshot. Re-renders replay the same take (CineBot uses
// a seeded LCG; sim randomness is already on the game's seeded RNG streams).
//
// Scene contract (SCENES below):
//   name     — id used by --scene / spot checks and timeline.json
//   preroll  — seconds simulated but not recorded (boss warm-up, cinematic lead-in)
//   record   — seconds captured to frames
//   hud/crosshair — show HUD / mouse crosshair during the scene (default on)
//   setup(cx)     — teleport/spawn/loadout; runs on the scene's first frame
//   beats: [{at, fn}] — one-shots at scene-local seconds (at counts from scene
//                        start, i.e. preroll included)
//   tick(cx, t)   — every frame (t = scene-local seconds)
//
// The ship survives every cut with its velocity and heading intact — the
// trailer's device is one continuous flight while the sky changes around it.

import { CineBot } from '/scripts/trailer/cinebot.js';
import { Pilot, FakePad } from '/scripts/trailer/pilot.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(p, t = 60000, s = 100) { const a = Date.now(); while (Date.now() - a < t) { if (p()) return true; await sleep(s); } return false; }

const FPS = 30;
const DT = 1 / FPS;

(async () => {
    // ── Boot the real game (same pattern as scripts/perf/harness.js) ──────────
    const ok = await waitFor(() => window.__novaGame && window.__novaGame.assets
        && window.__novaGame.assets.get('enemy_ship_0') && window.__novaGame.assets.get('asteroid_big_0'));
    const g = window.__novaGame;
    if (!ok || !g) { window.TRAILER = { error: 'no game/assets' }; return; }

    // Fresh profile guarantees: no low-perf latches shedding the pretty stuff.
    try { localStorage.removeItem('nova_lowperf'); localStorage.removeItem('nova_screenfx_off'); } catch (e) {}
    g.lowPerfMode = false; g.screenFxDisabled = false;

    const [ps, ships, enemyMod, astMod, prewarm, upg, seraphMod, wheelsMod, swarmMod, bonesMod, dragonMod, yoMod,
           playerMod, starcoreMod, crusherMod, horizonMod, shopMod, cacheMod, cthulhuMod, knowMod] = await Promise.all([
        import('/src/states/playingState.js'), import('/src/data/ships.js'),
        import('/src/entities/enemy.js'), import('/src/entities/asteroid.js'),
        import('/src/engine/prewarm.js'), import('/src/data/upgrades.js'),
        import('/src/entities/seraph.js'), import('/src/entities/wheels.js'),
        import('/src/entities/swarm.js'), import('/src/entities/bones.js'),
        import('/src/entities/dragon.js'), import('/src/entities/yellowOne.js'),
        import('/src/entities/player.js'), import('/src/entities/starcore.js'),
        import('/src/entities/asteroidCrusher.js'), import('/src/entities/eventHorizon.js'),
        import('/src/entities/shop.js'), import('/src/entities/spaceCache.js'),
        import('/src/entities/cthulhuEvent.js'), import('/src/entities/knowledgeEvent.js'),
    ]);
    const { PlayingState } = ps, { SHIPS } = ships, { Enemy, NaniteEnemy, BlinkEnemy, BerserkEnemy, MissileEnemy, ShieldEnemy, ScavengerEnemy } = enemyMod;
    const { Player } = playerMod, { Starcore } = starcoreMod, { AsteroidCrusher } = crusherMod, { EventHorizon } = horizonMod;
    const { Shop } = shopMod, { SpaceCache } = cacheMod, { CthulhuEvent } = cthulhuMod, { KnowledgeEvent } = knowMod;
    const { LocustEnemy, SwarmMother } = swarmMod, { BoneEnemy } = bonesMod;
    const { Asteroid, ItemPickup, Scrap } = astMod;
    const { UPGRADES, makeItem } = upg;
    const { Seraph } = seraphMod, { Wheels } = wheelsMod, { Hive } = swarmMod;
    const { Carcosa } = bonesMod, { Dragon } = dragonMod, { YellowOne } = yoMod;
    try { for (let i = 0; i < 120 && !prewarm.pumpRunPrewarm(g, 1); i++) {} } catch (e) {}

    g.setState(new PlayingState(g, SHIPS[0]));
    const S = g.currentState;
    g.devMode = false;
    try { g.sounds.setSfxVolume(0); g.sounds.setMusicVolume(0); } catch (e) {}
    // Adaptive-perf can never trip mid-render (SwiftShader is slow by design).
    setInterval(() => { g.lowPerfMode = false; g.screenFxDisabled = false; }, 250);

    // Let the state settle a few real frames before freezing the clock.
    await sleep(300);

    // ── Virtual clock: the sim advances ONLY via TRAILER.step() ───────────────
    let VNOW = performance.now();
    const _origNow = performance.now.bind(performance);
    performance.now = () => VNOW;
    let rafQ = [];
    window.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
    window.cancelAnimationFrame = () => {};
    await new Promise(r => setTimeout(r, 60)); // last real-scheduled loop lands in rafQ

    // ── Presentation wraps (HUD / crosshair / run timer) ──────────────────────
    const flags = { hud: true, crosshair: true };
    const _hudDraw = S.hud.draw.bind(S.hud);
    S.hud.draw = (...a) => {
        if (!flags.hud) return;
        // The wave countdown would read "NEXT WAVE: 166:38" (we hold waveTimer
        // huge to keep scenes quiet) — hide just that readout during the draw.
        const wt = S.waveTimer; S.waveTimer = undefined;
        // Levels earned during THIS update would flash the CLAIM banner before
        // the next tick clears them — discard at draw time.
        const q = S.player && S.player._levelUpQueue; if (q) q.length = 0;
        try { _hudDraw(...a); } finally { S.waveTimer = wt; }
    };
    const _cross = g._drawCrosshair.bind(g);
    g._drawCrosshair = (...a) => { if (flags.crosshair) _cross(...a); };
    S._drawTotalGameTimer = () => {}; // run timer would betray the cuts
    if (S.hud.drawDragonBars) {
        const _dbars = S.hud.drawDragonBars.bind(S.hud);
        S.hud.drawDragonBars = (...a) => { if (flags.hud) _dbars(...a); };
    }
    // Offscreen-entity indicators read as HUD — same switch.
    for (const m of ['_drawEnemyIndicators', '_drawShopIndicators', '_drawCacheIndicators', '_drawEventIndicators']) {
        if (typeof S[m] === 'function') {
            const orig = S[m].bind(S);
            S[m] = (...a) => { if (flags.hud) orig(...a); };
        }
    }
    // Directable shader pass: scenes can force CRT/warp on top of whatever the
    // game is doing (the coda's "massive screen distortion").
    const fxBoost = { crt: 0, warp: 0 };
    const _gfx = S.getScreenFx.bind(S);
    S.getScreenFx = () => {
        const f = _gfx() || {};
        if (fxBoost.crt > 0 || fxBoost.warp > 0) {
            return { ...f, crt: Math.max(f.crt || 0, fxBoost.crt), warp: Math.max(f.warp || 0, fxBoost.warp) };
        }
        return f;
    };
    const fxSet = (crt, warp) => { fxBoost.crt = crt; fxBoost.warp = warp; };

    // ── Overlay (black cards, white flash, end card) — styled per frame from
    // virtual time; never CSS transitions (those run on the real clock). ──────
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:50;pointer-events:none;opacity:0;background:#000;'
        + "display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:'Astro5x',Consolas,monospace;";
    document.body.appendChild(ov);
    const setOverlay = (opacity, html) => {
        ov.style.opacity = String(opacity);
        if (html != null && ov.dataset.k !== html) { ov.innerHTML = html; ov.dataset.k = html; }
    };
    // Closing-iris vignette for the horror coda (under the card overlay).
    const vg = document.createElement('div');
    vg.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;opacity:0;';
    document.body.appendChild(vg);
    // amt 0..1: how far the dark has closed in. hole: % radius still clear.
    const setVignette = (amt, hole = 34) => {
        if (amt <= 0) { vg.style.opacity = '0'; return; }
        vg.style.opacity = String(Math.min(1, amt));
        vg.style.background = 'radial-gradient(circle at 50% 50%, rgba(0,0,0,0) ' + Math.max(2, hole) + '%, rgba(0,0,0,0.97) ' + Math.max(8, hole + 26) + '%)';
    };

    // ── Trailer AV: recorded-time clock, SFX log, subtitles, flashes ─────────
    const AV = { recT: 0, recording: false };

    // Game SFX: the sim is muted; we LOG every play() with its recorded-time
    // stamp and mix the real audio files offline (capture writes sfxlog.json).
    const sfxLog = [];
    g.sounds.play = (key, options = 0.5) => {
        if (!AV.recording) return;
        let volume = 0.5, x = null, y = null, minD = 1200, maxD = 2500, pitch = 1;
        if (typeof options === 'number') volume = options;
        else if (typeof options === 'object') {
            volume = options.volume !== undefined ? options.volume : 0.5;
            x = options.x; y = options.y;
            if (options.minDistance !== undefined) minD = options.minDistance;
            if (options.maxDistance !== undefined) maxD = options.maxDistance;
            pitch = options.pitch || 1;
        }
        if (x !== null && y !== null && S.player) {
            const d = Math.hypot(x - S.player.worldX, y - S.player.worldY);
            if (d >= maxD) return;
            if (d > minD) volume *= 1 - ((d - minD) / (maxD - minD));
        }
        if (volume <= 0.01) return;
        sfxLog.push([Math.round(AV.recT * 1000), key, Math.round(volume * 1000) / 1000, Math.round(pitch * 100) / 100]);
    };

    // Comms panel: a fixed DISPATCH window. Text appends LEFT-ALIGNED and
    // never moves once placed. Corruption = in-place char swaps + color
    // flicker, no transforms. A signal meter visualizes the descent, so the
    // trailer reads without audio. The shout is the one full-screen card.
    const sub = document.createElement('div');
    sub.style.cssText = 'position:fixed;left:3.2vw;bottom:4.5vh;z-index:46;pointer-events:none;' +
        'width:34vw;min-height:9.5vh;background:rgba(8,13,22,0.88);border:2px solid #566074;' +
        "padding:1.1vh 1.2vw;font-family:'Astro5x',Consolas,monospace;display:none;";
    document.body.appendChild(sub);
    const subHead = document.createElement('div');
    subHead.style.cssText = 'display:flex;justify-content:space-between;align-items:center;' +
        'font-size:1.7vh;letter-spacing:0.12em;color:#7fd4ff;margin-bottom:0.9vh;';
    sub.appendChild(subHead);
    const subBody = document.createElement('div');
    subBody.style.cssText = 'font-size:2.5vh;line-height:1.5;color:#cfe2ff;text-align:left;' +
        'letter-spacing:0.04em;min-height:5vh;';
    sub.appendChild(subBody);
    const slam = document.createElement('div');
    slam.style.cssText = 'position:fixed;inset:0;z-index:46;pointer-events:none;display:none;' +
        "align-items:center;justify-content:center;font-family:'Astro5x',Consolas,monospace;";
    document.body.appendChild(slam);

    // Breath envelope of the placed dragon breathing (breath.json, 30 fps on
    // the trailer clock) — drives the dragon head's light and its glitches.
    let BREATH = null;
    fetch('/scripts/trailer/breath.json').then(r => r.json()).then(b => { BREATH = b; }).catch(() => {});
    const breathAt = (T) => {
        if (!BREATH) return 0;
        const i = Math.floor((T - BREATH.t0) * BREATH.fps);
        return (i >= 0 && i < BREATH.env.length) ? BREATH.env[i] : 0;
    };
    let SUBS = [], PHRASES = [];
    fetch('/scripts/trailer/subtitles.json').then(r => r.json()).then(ws => {
        SUBS = ws;
        let cur = null;
        for (const w of ws) {
            if (!cur || w.clip !== cur.clip || w.t - cur.end > 1.2) {
                cur = { clip: w.clip, stage: w.stage, words: [], t: w.t, end: w.end };
                PHRASES.push(cur);
            }
            cur.words.push(w);
            cur.end = Math.max(cur.end, w.end);
        }
        console.log('TRAILER subtitles: ' + ws.length + ' words, ' + PHRASES.length + ' phrases');
    }).catch(e => console.log('TRAILER subtitles load failed ' + e));

    const SIGNAL = { radio: 9, omen: 6, liturgy: 4, quiet: 2, shout: 1, whisper: 0 };
    const GLITCH = '\u2588\u2593\u2592\u258c\u2590';
    function glitchWord(txt, fx) {
        if (fx < 0.15 || txt.length < 3 || Math.random() > fx * 0.35) return txt;
        const i = 1 + Math.floor(Math.random() * (txt.length - 1));
        return txt.slice(0, i) + GLITCH[Math.floor(Math.random() * GLITCH.length)] + txt.slice(i + 1);
    }
    function drawSubs(t) {
        // never put text over an opaque card — picture first, then the voice
        if (!flags.subsOverCard && parseFloat(ov.style.opacity || '0') > 0.55) { sub.style.display = 'none'; slam.style.display = 'none'; return; }
        let ph = null;
        for (const q of PHRASES) { if (t >= q.t - 0.05 && t <= q.end + 0.7) { ph = q; break; } }
        if (!ph) { sub.style.display = 'none'; slam.style.display = 'none'; return; }
        if (ph.stage === 'shout') {
            sub.style.display = 'none';
            slam.style.display = 'flex';
            const w0 = ph.words[0];
            const age = t - w0.t;
            const sc = age < 0.1 ? (0.8 + 2 * age) : 1.0;
            let txt = '';
            for (const w of ph.words) { if (w.t <= t) txt += (txt ? ' ' : '') + w.w.toUpperCase(); }
            slam.innerHTML = '<div style="font-size:12vh;color:#ff4938;letter-spacing:0.05em;' +
                'transform:scale(' + sc.toFixed(2) + ');' +
                'text-shadow:5px 0 0 rgba(255,60,50,0.5),-5px 0 0 rgba(90,180,255,0.45),0 4px 0 rgba(0,0,0,0.9);">' +
                txt + '</div>';
            return;
        }
        slam.style.display = 'none';
        sub.style.display = 'block';
        const st = ph.stage;
        // header + signal meter (the descent, visible)
        let head, cells = SIGNAL[st] != null ? SIGNAL[st] : 9;
        if (st === 'whisper') {
            head = Math.random() < 0.12 ? '\u2590 D\u2592SP\u2588TCH' : '\u2590 DISPATCH';
        } else head = '\u2590 DISPATCH';
        let meter = '';
        for (let i = 0; i < 10; i++) {
            const on = i < cells;
            meter += '<span style="display:inline-block;width:0.55vw;height:1.35vh;margin-left:0.18vw;' +
                'background:' + (on ? (cells <= 2 ? '#ff5a4a' : cells <= 6 ? '#ffce6a' : '#7fd4ff') : 'rgba(120,140,170,0.18)') + ';"></span>';
        }
        const lost = st === 'whisper'
            ? '<span style="color:#ff5a4a;font-size:1.6vh;letter-spacing:0.1em;">SIGNAL LOST</span>'
            : '<span>' + meter + '</span>';
        subHead.innerHTML = '<span>' + head + '</span>' + lost;
        // body: words append, never move
        const parts = [];
        for (const w of ph.words) {
            if (w.t > t) break;
            const fx = w.fx || 0;
            let color = st === 'whisper' ? 'rgba(190,198,214,0.9)' : '#cfe2ff';
            if (w.hl) color = '#ffd24a';
            if (fx > 0.2 && Math.random() < fx * 0.5) color = '#ffce6a';
            const age = t - w.t;
            const op = age < 0.1 ? (0.3 + 7 * age) : 1;
            parts.push('<span style="color:' + color + ';opacity:' + Math.min(1, op).toFixed(2) + ';">' +
                glitchWord(w.w, fx) + '</span>');
        }
        subBody.innerHTML = parts.join(' ');
        // heavy corruption: 1-frame panel dip, no movement
        sub.style.opacity = (ph.words.some(w => (w.fx || 0) > 0.5) && Math.random() < 0.1) ? '0.75' : '1';
    }

    // Single-frame flashes on the hardest hits (times on the recorded clock).
    const fl = document.createElement('div');
    fl.style.cssText = 'position:fixed;inset:0;z-index:47;pointer-events:none;opacity:0;';
    document.body.appendChild(fl);
    const FLASHES = [
        { t: 35.00, c: 'rgba(255,64,40,0.55)', d: 0.14 },  // the tear
        { t: 75.29, c: 'rgba(255,255,255,0.7)', d: 0.10 }, // the shout lands
    ];
    function drawFlashes(t) {
        let a = 0, c = '#fff';
        for (const F of FLASHES) {
            if (t >= F.t && t < F.t + F.d) { a = 1 - (t - F.t) / F.d; c = F.c; }
        }
        fl.style.background = c;
        fl.style.opacity = String(a * a);
    }

    // ── Shared helpers ────────────────────────────────────────────────────────
    const bot = new CineBot(g, 20260826);
    // THE PILOT: flies the ship through the game's own inputs toward scene goals.
    const pilot = new Pilot(g, 20260903);
    let wingPilots = [];   // co-op wingmen (each a Pilot on a FakePad)
    const P = () => S.player;
    const heal = () => {
        const p = P();
        if (p && !p.dead) { p.health = p.maxHealth; if (p.maxShieldEnergy) p.shieldEnergy = p.maxShieldEnergy; }
        // Combat keeps leveling the pilot; unclaimed levels put a flashing
        // "CLAIM LEVELS" banner over every shot. Quietly discard the queue
        // (the one on-camera level-up in `mine` is opened by hand).
        if (p && p._levelUpQueue) p._levelUpQueue.length = 0;
        // no mid-fight level-ups (the LEVEL UP! ring/text): keep XP just under the bar
        if (p && p.expNeeded) p.exp = Math.min(p.exp, p.expNeeded * 0.6);
    };
    const quiet = () => {
        S.waveTimer = 9999; S._earlyHookIndex = 99;
        const am = g.achievements;   // no "achievement unlocked" toasts over the shots
        if (am) { if (am.toastQueue) am.toastQueue.length = 0; am.currentToast = null; }
    };
    const give = (id, tier = 0) => {
        const data = UPGRADES.find(u => u.id === id);
        if (!data) return;
        const item = tier > 0 ? (makeItem(id, tier) || data) : data;
        if (P().inventory.autoAdd) P().inventory.autoAdd(item);
    };
    // The trailer's "long run" build is written STRAIGHT onto the ship's stats
    // (not derived from inventory) and re-applied every frame so a pickup or
    // level-up recompute can't undo it. Railgun is never part of it: in the
    // game it OVERRIDES the standard guns, which is what was hiding the energy
    // blaster before. fireRate > 1 = slower (blaster cooldown = 0.2 * rate * 1.5).
    const loadout = (spec) => {
        const p = P(); if (!p) return;
        // (never touch isRailgunTargeting/railgunTargetTimer here: loadout runs every
        // frame and resetting them restarted the charge each tick — the gun never fired)
        if (p.hasRailgun !== !!spec.railgun) { p.hasRailgun = !!spec.railgun; p.isRailgunTargeting = false; p.railgunTargetTimer = 0; }
        p.hasRepeater = false;
        p.hasEnergyBlaster = spec.blasters > 0;
        p.energyBlasterCount = spec.blasters;
        p.hasMultishotGuns = !!spec.multishot;
        p.multishotDamageMult = 1.0;
        p.lvlExtraProjectiles = spec.extra || 0;
        p.fireRateMult = spec.fireRate || 1.0;
        p.laserCartridgeMult = spec.damage || 1.0;
        p.hasLaserOverride = !!spec.bigShots;
        p.laserOverrideMult = spec.bigShots ? 1.6 : 1.0;
        p.lvlProjectileSpeedMult = spec.speed || 1.0;
        p.hasAutoTurret = !!spec.turret;
        p.hasRockets = !!spec.rockets;
        p.rocketInterval = spec.rockets ? spec.rockets : 3.0;
    };
    // stock guns, hot enough to crack rocks on the salvage run
    const BUILD_STOCK = { blasters: 0, multishot: false, extra: 0, fireRate: 0.8, damage: 4.5 };
    const BUILD_SKIRMISH = { blasters: 0, multishot: false, extra: 0, fireRate: 0.55, damage: 11 };   // stock guns, but they KILL in the window
    // "past reason": the blaster build with the RAILGUN on top (beams override the guns)
    const BUILD_PAST_RAIL = { blasters: 3, multishot: true, extra: 3, fireRate: 0.7, damage: 4.0, speed: 1.2, turret: true, rockets: 1.5, railgun: true, bigShots: true };
    // twin guns, one spread pair: a sane early build (4 shots / 0.2s)
    const BUILD_REGULATION = { blasters: 0, multishot: true, extra: 1, fireRate: 1.0, damage: 1.6, turret: true };
    // "past regulation": triple blaster shotgun on twin mounts — 20-24 pellets
    // per blast, slower cadence (0.35s) so each volley reads as a volley
    const BUILD_PAST = { blasters: 3, multishot: true, extra: 3, fireRate: 1.15, damage: 3.0, speed: 1.15,
        turret: true, rockets: 2.0 };
    // the apocalypse build: quad blaster, big shots, 30-34 pellets per blast
    const BUILD_MONSTER = { blasters: 4, multishot: true, extra: 6, fireRate: 1.0, damage: 5.0, speed: 1.25,
        bigShots: true, turret: true, rockets: 1.5 };
    // Swap the hull under the pilot (the montage shows different runs). The
    // inventory rides along; stats are re-written by loadout() every frame.
    const swapShip = (id) => {
        const old = P(); const data = SHIPS.find(sd => sd.id === id);
        if (!data || (old && old.shipData === data)) return old;
        const np = new Player(g, data);
        np.worldX = old.worldX; np.worldY = old.worldY; np.angle = old.angle;
        np.inventory = old.inventory; np.killStreak = S.killStreak; if (S.killStreak) S.killStreak.pilot = np;
        S.player = np; S.shipData = data;
        if (S.localPlayers && S.localPlayers[0]) S.localPlayers[0].player = np;
        if (S.hud) S.hud.player = np;
        try { S._onInventoryChanged(np); } catch (e) {}
        g.camera.snapTo(np);
        return np;
    };
    const clearCombat = () => {
        for (const k of ['enemies', 'projectiles', 'events', 'explosions', 'sparks', 'rubble',
            'floatingTexts', 'expOrbs', 'scrapEntities', 'encounters', 'itemPickups',
            'caches', 'shops']) {
            if (Array.isArray(S[k])) S[k].length = 0;
        }
        S.dragonEvent = null;
        const ks = S.killStreak;   // confetti/gore/rings live on the streak, not the arrays above
        if (ks) { ks.streak = 0; ks.timer = 0; for (const k of ['particles', 'screenParts', 'rings']) if (Array.isArray(ks[k])) ks[k].length = 0; }
    };
    // Undo a staged death (the trailer's roguelike beat): back to flying.
    const revive = () => {
        const p = P();
        S.isDead = false; S.deathTimer = 0; S.showDeathScreen = false;
        p.alive = true; p.dead = false; p.health = p.maxHealth;
        if (S.killStreak) { S.killStreak.streak = 0; S.killStreak.timer = 0; }
        heal();
    };
    // Move the stage, keep the flight: velocity + heading survive the cut.
    const teleport = (x, y) => {
        const p = P();
        p.worldX = x; p.worldY = y;
        g.camera.snapTo(p);
        bot.aimX = x + Math.cos(p.angle) * 400; bot.aimY = y + Math.sin(p.angle) * 400;
        bot.aimVX = 0; bot.aimVY = 0;
        bot.desX = bot.aimX; bot.desY = bot.aimY;
    };
    const fov = (mult) => { S._dragonFovMult = mult; }; // >1 pulls the view wide; 0 releases
    // Hold back the dread scheduler's own sporadic moments (we direct them by hand).
    const dreadHold = () => {
        if (S.dread && S.dread._next) for (const k in S.dread._next) S.dread._next[k] = 999;
    };
    // World radius that is just outside the frame at the scene's TARGET fov
    // (the camera is still easing when setup runs, so read the target, not the
    // current scale). Everything spawns beyond it and flies in.
    const offR = () => {
        const base = g.worldScale * (S.currentFovMult || 1);            // px per world unit at fov 1
        const p = P();
        const f = Math.max(1, S._dragonFovMult > 1 ? S._dragonFovMult : 0, p ? (p.itemFovMult || 1) : 1);
        return Math.hypot(g.width / 2, g.height / 2) / base * f * 1.12;
    };
    const ringOfEnemies = (n, rMin, rMax, diff = 3) => {
        const R = offR(); if (rMin < R) { rMax = Math.max(rMax, R + 350) + (rMax - rMin) * 0; rMin = R; }
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + bot.rand() * 0.5;
            const d = rMin + bot.rand() * (rMax - rMin);
            const en = new Enemy(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, diff);
            Enemy.rollUpgrade(en, P());
            S.enemies.push(en);
        }
    };
    const asteroidField = (n, rMin, rMax) => {
        const sizes = ['big', 'medium', 'medium', 'small', 'tiny'];
        for (let i = 0; i < n; i++) {
            const a = bot.rand() * Math.PI * 2, d = rMin + bot.rand() * (rMax - rMin);
            S.asteroids.push(new Asteroid(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d,
                sizes[i % sizes.length], (bot.rand() - 0.5) * 30, (bot.rand() - 0.5) * 30));
        }
    };
    const densestNebula = () => {
        let bx = 0, by = 0, bd = -1;
        for (let i = -20; i <= 20; i++) for (let j = -20; j <= 20; j++) {
            const d = S.ambience.nebulaDensity(i * 4000, j * 4000);
            if (d > bd) { bd = d; bx = i * 4000; by = j * 4000; }
        }
        return { x: bx, y: by, d: bd };
    };

    // ── Kinematic pre-vis rig: authored motion, not gameplay ─────────────────
    // Drives player position directly along smooth paths/orbits; aim goes to
    // the mouse so the game's own nose-lerp keeps rotation organic; fire is
    // scripted. The CineBot is switched 'off' while a rig move is active.
    function catmull(pts, u) {
        const n = pts.length - 1;
        const f = Math.min(0.9999, Math.max(0, u)) * n;
        const i = Math.min(n - 1, Math.floor(f)), lu = f - i;
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
        const c = (a, b, cc, d, t) => 0.5 * ((2 * b) + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t * t + (-a + 3 * b - 3 * cc + d) * t * t * t);
        return [c(p0[0], p1[0], p2[0], p3[0], lu), c(p0[1], p1[1], p2[1], p3[1], lu)];
    }
    // The rock in front of the ship within reach (for the salvage run: shoot
    // them, don't ram them).
    const rockAhead = (range = 1150) => {
        const p = P(); if (!p) return null;
        const sp = Math.hypot(p.vx, p.vy); const hx = sp > 1 ? p.vx / sp : Math.cos(p.angle), hy = sp > 1 ? p.vy / sp : Math.sin(p.angle);
        let b = null, bd = 1e18;
        for (const a of S.asteroids) {
            if (!a || a.destroyed || a.dead) continue;
            const dx = a.worldX - p.worldX, dy = a.worldY - p.worldY, d = Math.hypot(dx, dy);
            if (d > range || d < 40) continue;
            if ((dx * hx + dy * hy) / d < 0.55) continue;
            if (d < bd) { bd = d; b = a; }
        }
        return b;
    };
    const nearestEnemy = () => {
        let b = null, d = 1e18;
        for (const e of S.enemies) {
            if (!e || e.alive === false) continue;
            const dd = (e.worldX - P().worldX) ** 2 + (e.worldY - P().worldY) ** 2;
            if (dd < d) { d = dd; b = e; }
        }
        return b;
    };
    const rig = {
        m: null, t: 0, _pos: null, _av: [0, 0],
        start(cfg) { this.m = cfg; this.t = 0; this._pos = null; this._av = [0, 0]; bot.setMode('off'); },
        stop() { this.m = null; this._pos = null; },
        _sample(tt) {
            const m = this.m;
            if (m.type === 'path') {
                const u = Math.min(1, tt / m.dur);
                return catmull(m.pts, u);
            }
            if (m.type === 'orbit') {
                const c = (typeof m.center === 'function') ? m.center() : m.center;
                if (!c) return null;
                const cxw = c.worldX != null ? c.worldX : c.x, cyw = c.worldY != null ? c.worldY : c.y;
                const a = (m.a0 || 0) + (m.angVel || 0.5) * tt;
                return [cxw + Math.cos(a) * m.radius, cyw + Math.sin(a) * m.radius];
            }
            if (m.type === 'strafe') {
                // a fight, not an orbit: polar keyframes [r, angle] swung through
                // smoothly — dives in, pulls out, comes round again
                const c = (typeof m.center === 'function') ? m.center() : m.center;
                if (!c) return null;
                const cxw = c.worldX != null ? c.worldX : c.x, cyw = c.worldY != null ? c.worldY : c.y;
                const u = Math.min(1, tt / m.dur);
                const q = catmull(m.polar, u);
                return [cxw + Math.cos(q[1]) * q[0], cyw + Math.sin(q[1]) * q[0]];
            }
            if (m.type === 'route') {
                const q = this._leg(tt);
                if (!q) return null;
                const { L, u, prev } = q;
                if (L.to) { const e = u * u * (3 - 2 * u); return [prev[0] + (L.to[0] - prev[0]) * e, prev[1] + (L.to[1] - prev[1]) * e]; }
                if (L.path) return catmull([prev].concat(L.path), u);
                return [prev[0], prev[1]];
            }
            return [m.x + Math.sin(tt * 0.5) * (m.sway != null ? m.sway : 8),
                    m.y + Math.cos(tt * 0.37) * (m.sway != null ? m.sway : 8)];
        },
        // route legs: {to:[x,y], dur} eased stop-to-stop | {hold:dur, aim, fire:[a,b]} | {path:[pts], dur}
        _leg(tt) {
            const m = this.m; if (!m || m.type !== 'route') return null;
            let t0 = 0, prev = m.from;
            for (let i = 0; i < m.legs.length; i++) {
                const L = m.legs[i];
                const d = L.dur != null ? L.dur : L.hold;
                if (tt < t0 + d || i === m.legs.length - 1) {
                    return { L, u: Math.min(1, Math.max(0, (tt - t0) / d)), tLeg: tt - t0, prev };
                }
                t0 += d;
                if (L.to) prev = L.to; else if (L.path) prev = L.path[L.path.length - 1];
            }
            return null;
        },
        // PRE-update: advance time, drive aim/throttle/fire inputs only.
        tick(dt) {
            const m = this.m; if (!m) return;
            this.t += dt;
            const p = P(); if (!p) return;
            let now = this._sample(this.t);
            let ahead = this._sample(this.t + dt);
            if (!now || !ahead) return;
            if (m.avoid) {
                // steer around rocks: a smoothed lateral push away from anything
                // close to the authored line (the same offset on now+ahead keeps
                // the analytic velocity honest)
                let px = 0, py = 0;
                for (const a of S.asteroids) {
                    if (!a || a.destroyed || a.dead) continue;
                    const R = (a.radius || 60) + 260;
                    const dx = now[0] - a.worldX, dy = now[1] - a.worldY, d = Math.hypot(dx, dy);
                    if (d > R || d < 1) continue;
                    const k = (1 - d / R); px += dx / d * k * 320; py += dy / d * k * 320;
                }
                this._av[0] += (px - this._av[0]) * 0.12; this._av[1] += (py - this._av[1]) * 0.12;
                now = [now[0] + this._av[0], now[1] + this._av[1]];
                ahead = [ahead[0] + this._av[0], ahead[1] + this._av[1]];
            }
            const vx = (ahead[0] - now[0]) / dt, vy = (ahead[1] - now[1]) / dt;
            this._pos = { x: now[0], y: now[1], vx, vy };
            let tx, ty;
            let legFire = false;
            if (m.type === 'route') {
                const q = this._leg(this.t);
                const sp = Math.hypot(vx, vy);
                if (q && q.L.hold) {
                    // stopped: turn to the thing and shoot it (guns fire along the nose)
                    const a = typeof q.L.aim === 'function' ? q.L.aim() : q.L.aim;
                    if (a) { tx = a.worldX != null ? a.worldX : a[0]; ty = a.worldY != null ? a.worldY : a[1]; }
                    else { tx = now[0] + Math.cos(m.heading || 0) * 500; ty = now[1] + Math.sin(m.heading || 0) * 500; }
                    if (q.L.fire && q.tLeg >= q.L.fire[0] && q.tLeg <= q.L.fire[1]) legFire = true;
                } else if (sp > 20) { tx = now[0] + vx; ty = now[1] + vy; }
                else if (q && q.L.to) { tx = q.L.to[0]; ty = q.L.to[1]; }
                else { tx = now[0] + Math.cos(m.heading || 0) * 500; ty = now[1] + Math.sin(m.heading || 0) * 500; }
            } else if (m.type === 'orbit' || m.type === 'strafe') {
                const c = (typeof m.center === 'function') ? m.center() : m.center;
                tx = c ? (c.worldX != null ? c.worldX : c.x) : now[0] + vx;
                ty = c ? (c.worldY != null ? c.worldY : c.y) : now[1] + vy;
            } else {
                const sp = Math.hypot(vx, vy);
                if (sp > 20) { tx = now[0] + vx; ty = now[1] + vy; }
                else { tx = now[0] + Math.cos(m.heading || 0) * 500; ty = now[1] + Math.sin(m.heading || 0) * 500; }
            }
            if (m.aimAt && m.type !== 'route') {
                const t2 = (typeof m.aimAt === 'function') ? m.aimAt() : m.aimAt;
                if (t2) {
                    tx = t2.worldX != null ? t2.worldX : (t2.x != null ? t2.x : tx);
                    ty = t2.worldY != null ? t2.worldY : (t2.y != null ? t2.y : ty);
                }
            }
            const cam = S.camera;
            g.input.mouseScreenX = (tx - cam.x) * g.worldScale + g.width / 2;
            g.input.mouseScreenY = (ty - cam.y) * g.worldScale + g.height / 2;
            if (Math.hypot(vx, vy) > 140) g.input.keysDown.add('KeyW');
            else g.input.keysDown.delete('KeyW');
            let firing = !!m.fireAll || legFire;
            if (m.fire) for (const w of m.fire) if (this.t >= w[0] && this.t <= w[1]) firing = true;
            if (m.fireIf) { try { if (m.fireIf()) firing = true; } catch (e) {} }
            if (firing) g.input.mouseButtons.add(0); else g.input.mouseButtons.delete(0);
            if (m.shield) {   // the shield (ShiftLeft) inside its windows
                let sh = false; for (const w of m.shield) if (this.t >= w[0] && this.t <= w[1]) sh = true;
                if (sh) g.input.keysDown.add('ShiftLeft'); else g.input.keysDown.delete('ShiftLeft');
            }
        },
        // POST-update: snap the ship onto the path with its analytic velocity.
        // (Writing before the update feeds back through the integrator and
        // makes the ship step-and-stall — this is why it must come after.)
        apply() {
            const p = P(); if (!p || !this._pos) return;
            const q = this._pos;
            if (Math.hypot(q.vx, q.vy) < 4000) { p.vx = q.vx; p.vy = q.vy; }
            else { p.vx = 0; p.vy = 0; }
            p.worldX = q.x; p.worldY = q.y;
        },
    };
    {
        const _sUpd = S.update.bind(S);
        S.update = function (dt2) {
            _sUpd(dt2);
            try { rig.apply(); } catch (e) { console.log('TRAILER rig apply error ' + (e.stack || e)); }
            try { if (scene && scene.post) scene.post.call(scene, cx); } catch (e) { console.log('TRAILER post error ' + (e.stack || e)); }
        };
    }

    const cx = { g, S, bot, rig, pilot, nearestEnemy, P, heal, quiet, give, clearCombat, teleport, fov, swapShip,
        ringOfEnemies, asteroidField, densestNebula, setOverlay, setVignette, fxSet, revive, flags, rockAhead,
        Enemy, Asteroid, ItemPickup, UPGRADES, makeItem, Seraph, Wheels, Hive, Carcosa, Dragon };

    // End card markup (uses the real title logo, pixel-scaled).
    const END_CARD = `
      <img src="/Assets/UI/title.png" style="width:840px;image-rendering:pixelated;opacity:0" id="ovLogo">
      <div id="ovTag" style="margin-top:52px;font-size:34px;letter-spacing:6px;color:#cfe2ff;opacity:0">EVERY STAR MUST DIE</div>
      <div id="ovTag2" style="margin-top:14px;font-size:34px;letter-spacing:6px;color:#fff;opacity:0">MAKE YOURS A WEAPON</div>
      <div id="ovWish" style="margin-top:64px;font-size:40px;letter-spacing:8px;color:#7fd4ff;opacity:0">WISHLIST ON STEAM</div>
      <div id="ovFine" style="margin-top:26px;font-size:20px;letter-spacing:4px;color:#8b96a8;opacity:0">1&ndash;8 PLAYERS &middot; ROGUELIKE BULLET-HELL &middot; FIGHT GODS</div>`;

    // ── Card art: sprite frames stepped on the VIRTUAL clock (gifs would run on
    // the real clock and tear between screenshots). Everything is preloaded
    // before TRAILER.ready so a src swap never screenshots a blank image.
    const ART = '/scripts/trailer/cardart/';
    const ANIM = { dragon: 12, yellowone: 12, fighter: 4, cruiser: 4, bruiser: 4, looper: 4,
        wheelsfire: 16, wheelsfront: 16, wheelsback: 16, seraph: 16, explode: 5, bone: 7, mother: 5 };
    const UPG_ICONS = ['energy_blaster_3x1', 'railgun_4x1', 'repeater_4x1', 'multishot_guns_2x1', 'rockets_2x1',
        'auto_turret_3x2', 'laser_override_2x2', 'firing_coordinator_1x1', 'laser_cartridge_1x1', 'blink_engine_3x2',
        'mechanical_engines_2x2', 'pulse_boosters_2x2', 'shield_booster_1x1', 'nanite_tank_2x2', 'targeting_module_2x2',
        'control_module_1x2', 'explosives_unit_3x2', 'field_array_2x2', 'momentum_module_1x1', 'high_density_capacitor_1x2',
        'energy_cell_1x2', 'scrap_drone_1x1', 'cargo_expansion_3x1', 'boost_drive_2x1', 'cosmos_engine_1x1',
        'asteroid_drill_3x2', 'sensor_accelerator_1x1', 'warning_system_1x1', 'shield_capacitor_1x2', 'small_boosters_1x2'];
    const PRELOAD = [];
    for (const k in ANIM) for (let f = 0; f < ANIM[k]; f++) PRELOAD.push(ART + k + '_' + String(f).padStart(2, '0') + '.png');
    for (const u of UPG_ICONS) PRELOAD.push('/Assets/Upgrades/' + u + '.png');
    PRELOAD.push('/Assets/Events/hive.png', '/Assets/UI/fly_again_on.png', '/Assets/UI/title.png');
    const keep = [];   // hold decoded images alive for the whole render
    let artReady = false;
    Promise.all(PRELOAD.map(src => new Promise(res => { const im = new Image(); im.onload = im.onerror = () => res(); im.src = src; keep.push(im); })))
        .then(() => { artReady = true; console.log('TRAILER card art preloaded: ' + PRELOAD.length); });
    const frameSrc = (name, f) => ART + name + '_' + String(((f % ANIM[name]) + ANIM[name]) % ANIM[name]).padStart(2, '0') + '.png';
    // <img> that tick() animates: data-anim=name data-fps=n data-t0=start
    const spr = (name, px, extra = '', t0 = 0, fps = 10) =>
        '<img data-anim="' + name + '" data-fps="' + fps + '" data-t0="' + t0 + '" src="' + frameSrc(name, 0) +
        '" style="image-rendering:pixelated;width:' + px + 'px;height:auto;' + extra + '">';
    function animSprites(t) {
        for (const el of ov.querySelectorAll('img[data-anim]')) {
            const name = el.dataset.anim, fps = +el.dataset.fps, t0 = +el.dataset.t0;
            const f = Math.max(0, Math.floor((t - t0) * fps));
            const src = frameSrc(name, f);
            if (el.getAttribute('src') !== src) el.setAttribute('src', src);
        }
    }
    const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.visibility = on ? 'visible' : 'hidden'; };
    const H1 = (txt, extra = '') => '<div style="font-size:11vh;color:#fff;letter-spacing:0.08em;line-height:1.1;text-align:center;' + extra + '">' + txt + '</div>';
    const H2 = (id, txt, c) => '<div id="' + id + '" style="font-size:5vh;color:' + c + ';letter-spacing:0.2em;margin-top:3vh;text-align:center;visibility:hidden">' + txt + '</div>';
    const card = (l1, l2, c2) => H1(l1) + H2('cardL2', l2, c2);
    const cardBase = (name, len, html, tick) => ({
        name, preroll: 0, record: len, hud: false, crosshair: false, _src: html + (tick ? tick.toString() : ''),
        setup(cx) { setVignette(0); fxSet(0, 0); ov.style.background = '#000'; setOverlay(1, html); cx.rig.stop(); this._s = 0; },
        tick(cx, t) {
            if (this._s === 0) { this._s = 1; g.sounds.play('select', { volume: 0.8 }); }
            animSprites(t);
            tick.call(this, cx, t);
        },
    });
    const click2 = function (t, at) { if (t >= at) { show('cardL2', true); if (this._s === 1) { this._s = 2; g.sounds.play('click', { volume: 0.7 }); } } };

    // 48 UPGRADES — eight upgrades slammed full-frame one after another with
    // flash frames between (a machine gun of hardware), then the number.
    const SLAM_ICONS = ['railgun_4x1', 'energy_blaster_3x1', 'repeater_4x1', 'rockets_2x1', 'laser_override_2x2',
        'auto_turret_3x2', 'blink_engine_3x2', 'multishot_guns_2x1'];
    // 48 UPGRADES — a ring of the real upgrade art spinning in perspective:
    // the front item huge and bright, the back ones small and dim behind it.
    // Fast at first, easing down; a click each time an icon crosses the front.
    const CAROUSEL = ['laser_override_2x2', 'auto_turret_3x2', 'nanite_tank_2x2', 'railgun_4x1', 'blink_engine_3x2',
        'mechanical_engines_2x2', 'explosives_unit_3x2', 'pulse_boosters_2x2', 'targeting_module_2x2', 'asteroid_drill_3x2',
        'field_array_2x2', 'energy_canisters_2x2'];
    const rowsOf = (u) => +u.slice(-1);                     // '..._3x2' -> 2 rows
    const CARD_UPGRADES = (() => {
        let h = '<div style="position:relative;width:100vw;height:100vh;overflow:hidden">';
        h += '<div style="position:absolute;left:50%;top:11%;transform:translate(-50%,-50%);font-size:10vh;color:#fff;letter-spacing:0.12em;white-space:nowrap;z-index:200">48 UPGRADES</div>';
        CAROUSEL.forEach((u, i) => {
            h += '<img id="car' + i + '" src="/Assets/Upgrades/' + u + '.png" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);image-rendering:pixelated">';
        });
        return h + '</div>';
    })();
    const cardUpgrades = cardBase('card_upgrades', 2.0, CARD_UPGRADES, function (cx, t) {
        const N = CAROUSEL.length;
        // one slot per click: a short eased move, then a dwell on the selected item
        const STEP = 0.25, MOVE = 0.13;
        const n = Math.floor(t / STEP), f = Math.min(1, (t - n * STEP) / MOVE), e = 1 - Math.pow(1 - f, 3);
        const phi = (n + e) * (Math.PI * 2 / N);
        if (this._n !== n) { this._n = n; if (n > 0) g.sounds.play('select', { volume: 0.8 }); }
        const RX = 900, RY = 110;                           // the ring on screen
        const SLOT = Math.PI * 2 / N;
        CAROUSEL.forEach((u, i) => {
            const el = document.getElementById('car' + i); if (!el) return;
            let th = phi - (i / N) * Math.PI * 2;            // icon i comes to the front on step i
            th = Math.atan2(Math.sin(th), Math.cos(th));      // wrap to [-pi, pi]; 0 = front
            const depth = Math.cos(th);
            // ONLY the selected item is big: growth exists within one slot of the
            // front, so at every dwell exactly one item is large and the rest small
            const w = Math.max(0, 1 - Math.abs(th) / SLOT), ww = w * w;
            const cell = 40 + 130 * ww;                      // px per 32-px art cell: 40 small, 170 selected
            el.style.height = (rowsOf(u) * cell) + 'px';
            el.style.left = 'calc(50% + ' + Math.round(Math.sin(th) * RX) + 'px)';
            el.style.top = 'calc(50% + ' + Math.round(depth * RY) + 'px)';
            el.style.opacity = (0.4 + 0.6 * ww).toFixed(2);
            el.style.zIndex = String(100 + Math.round(depth * 50));
            el.style.filter = 'brightness(' + (0.55 + 0.45 * ww).toFixed(2) + ')';
        });
    });

    // FIGHT GODS. — glimpses. Each god is torn out of the black by a flash,
    // held a few frames under a spotlight, and gone; the king stays.
    const GODS = [
        { id: 'godW', x: 30, y: 46, t0: 0.02, t1: 0.34, fl: '#fff',
          html: '<div style="position:relative;width:520px;height:520px">' + spr('wheelsback', 520, 'position:absolute;left:0;top:0') + spr('wheelsfire', 520, 'position:absolute;left:0;top:0') + spr('wheelsfront', 520, 'position:absolute;left:0;top:0') + '</div>' },
        { id: 'godS', x: 68, y: 42, t0: 0.38, t1: 0.68, fl: '#ff4938', html: spr('seraph', 560) },
        { id: 'godH', x: 42, y: 58, t0: 0.72, t1: 1.00, fl: '#fff', html: '<img src="/Assets/Events/hive.png" style="image-rendering:pixelated;width:560px">' },
        { id: 'godY', x: 60, y: 50, t0: 1.04, t1: 9.0, fl: '#ff4938', html: spr('yellowone', 420) },
    ];
    const CARD_GODS = (() => {
        let h = '<div style="position:relative;width:100vw;height:100vh">';
        for (const gd of GODS) h += '<div id="' + gd.id + '" style="position:absolute;left:' + gd.x + '%;top:' + gd.y + '%;transform:translate(-50%,-50%);visibility:hidden">' + gd.html + '</div>';
        h += '<div id="godSpot" style="position:absolute;inset:0;background:#000"></div>';
        h += '<div id="godFlash" style="position:absolute;inset:0;background:#fff;opacity:0"></div>';
        h += '<div id="godT1" style="position:absolute;left:50%;top:11%;transform:translate(-50%,-50%);font-size:10vh;color:#fff;letter-spacing:0.12em;white-space:nowrap;z-index:200">FIGHT GODS</div>';
        h += '<div id="cardL2" style="position:absolute;left:50%;top:86%;transform:translate(-50%,-50%);font-size:5vh;color:#ffff44;letter-spacing:0.2em;visibility:hidden">THEN THE KING.</div>';
        return h + '</div>';
    })();
    const cardGods = cardBase('card_gods', 1.5, CARD_GODS, function (cx, t) {
        const spot = document.getElementById('godSpot'), fl = document.getElementById('godFlash');
        let cur = null;
        for (const gd of GODS) { const on = t >= gd.t0 && t < gd.t1; show(gd.id, on); if (on) cur = gd; }
        if (cur) {
            const hole = cur.id === 'godY' ? 16 : 13;
            if (spot) spot.style.background = 'radial-gradient(circle at ' + cur.x + '% ' + cur.y + '%, rgba(0,0,0,0) ' + hole + '%, rgba(0,0,0,0.85) ' + (hole + 14) + '%, #000 ' + (hole + 26) + '%)';
            const age = t - cur.t0;
            if (fl) { fl.style.background = cur.fl; fl.style.opacity = age < 0.034 ? '0.22' : '0'; }   // a glint, not a strobe
            const gEl = document.getElementById(cur.id);
            if (gEl) { const win = Math.min(1, age / Math.min(1.2, cur.t1 - cur.t0)); gEl.style.transform = 'translate(-50%,-50%) scale(' + (1 + 0.14 * win).toFixed(3) + ')'; }
            if (this._cur !== cur.id) { this._cur = cur.id; g.sounds.play(cur.id === 'godY' ? 'shield_break' : 'hit', { volume: 0.8 }); }
        } else {
            if (spot) spot.style.background = '#000';
            if (fl) fl.style.opacity = '0';
        }
        show('godT1', true);   // the title reads over the whole card
    });

    // 1–8 PLAYERS — eight ships fall in
    const SHIPS8 = ['fighter', 'cruiser', 'bruiser', 'looper', 'fighter', 'cruiser', 'bruiser', 'looper'];
    const CARD_PLAYERS = H1('1&ndash;8 PLAYERS') +
        '<div style="display:flex;justify-content:center;gap:10px;margin-top:2vh">' +
        SHIPS8.map((n, i) => '<div id="pl' + i + '" style="visibility:hidden">' + spr(n, 200, '', 0, 10) + '</div>').join('') +
        '</div>' + H2('cardL2', 'ONLINE CO-OP', '#7fd4ff');
    const cardScene = null; // (replaced by the art cards above)

    // ── Montage shots ────────────────────────────────────────────────────────
    const BEAT = 0.56616;                       // the eruption at 106 bpm
    const far = (i) => { const p = P(); teleport(p.worldX + 25000 + i * 13000, p.worldY - 30000 - i * 9000); };
    const shot = (name, beats, preroll, setup, tick) => ({
        name, preroll, record: beats * BEAT, _src: setup.toString() + (tick ? tick.toString() : ''),
        setup(cx) {
            clearCombat(); quiet(); setOverlay(0, ''); setVignette(0); fxSet(0.12, 0.08);
            if (S.dread) S.dread.forceLevel = 0;
            setup.call(this, cx);
        },
        tick(cx, t) { heal(); quiet(); dreadHold(); if (tick) tick.call(this, cx, t); },
    });
    const ringOf = (Cls, n, rMin, rMax, diff, extra) => {
        const R = offR(); if (rMin < R) { rMax = Math.max(rMax, R + 350); rMin = R; }
        for (let i = 0; i < n; i++) {
            const a = (i / n) * Math.PI * 2 + bot.rand() * 0.5, d = rMin + bot.rand() * (rMax - rMin);
            const en = extra ? new Cls(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, diff, extra)
                             : new Cls(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, diff);
            S.enemies.push(en);
        }
    };
    const BUILD_RAIL = { blasters: 0, multishot: false, extra: 0, fireRate: 0.6, damage: 6.0, railgun: true, turret: true };
    const BUILD_ROCKETS = { blasters: 0, multishot: false, extra: 0, fireRate: 1.5, damage: 9.0, bigShots: true, rockets: 0.6, turret: true, speed: 1.3 };  // slow cannon + a rocket every 0.6 s
    const BUILD_SPRAY = { blasters: 3, multishot: true, extra: 6, fireRate: 0.9, damage: 1.6, speed: 0.9 };            // a wall of pellets
    const BUILD_FAST = { blasters: 0, multishot: true, extra: 1, fireRate: 0.3, damage: 1.1, speed: 1.4 };            // machine gun
    const BUILD_HEAVY = { blasters: 0, multishot: false, extra: 0, fireRate: 1.8, damage: 16.0, bigShots: true, speed: 1.6 };  // one shot, one kill
    // Montage fights: half the enemies are already on us (we cut into a fight
    // under way), the other half pour in from off-screen. Every shot fires.
    const nearRing = (Cls, n, rMin, rMax, diff) => {
        for (let k = 0; k < n; k++) {
            const a = bot.rand() * Math.PI * 2, d = rMin + bot.rand() * (rMax - rMin);
            const en = new Cls(g, P().worldX + Math.cos(a) * d, P().worldY + Math.sin(a) * d, diff);
            if (Cls === Enemy) Enemy.rollUpgrade(en, P());
            S.enemies.push(en);
        }
    };
    const brawl = (nNear, nFar, diff, specials) => {
        nearRing(Enemy, nNear, 380, 820, diff);
        ringOfEnemies(nFar, 1400, 1900, diff);
        for (const [Cls, n] of (specials || [])) { nearRing(Cls, Math.ceil(n / 2), 450, 850, diff); ringOf(Cls, Math.floor(n / 2), 1400, 1800, diff); }
    };
    const fight = (range = 2800) => pilot.set({ type: 'hunt', range, rampage: true, noBoost: true });
    const bossFight = (getT, standoff) => pilot.set({ type: 'hunt', range: 2800, rampage: true, noBoost: true,
        pool: () => { const t = getT(); const arr = S.enemies.slice(); if (t && !arr.includes(t)) arr.push(t); return arr; } });
    function MONTAGE_SHOTS() { return [
        // 1 (2 beats) the cruiser: railgun volleys through a swarm and its rocks
        shot('m_rail', 2, 3.4, function (cx) {
            far(1); swapShip('cruiser'); this._b = BUILD_PAST_RAIL; loadout(this._b); fov(1.3);
            asteroidField(16, 500, 1400); brawl(18, 14, 6); fight();
        }, function () { loadout(this._b); }),
        // 2 (2) the vanisher: a wall of pellets into the nanite swarm
        shot('m_nanite', 2, 3.4, function (cx) {
            far(2); swapShip('vanisher'); this._b = BUILD_SPRAY; loadout(this._b); fov(1.3);
            brawl(16, 12, 6, [[NaniteEnemy, 8]]); fight();
        }, function () { loadout(this._b); }),
        // 3 (2) the bruiser: cannon + rockets into a cruiser pack
        shot('m_rockets', 2, 3.4, function (cx) {
            far(3); swapShip('bruiser'); this._b = BUILD_ROCKETS; loadout(this._b); fov(1.35);
            brawl(20, 16, 7); fight();
        }, function () { loadout(this._b); }),
        // 4 (2) the looper: machine gun vs blink ships
        shot('m_blink', 2, 3.4, function (cx) {
            far(4); swapShip('looper'); this._b = BUILD_FAST; loadout(this._b); fov(1.3);
            brawl(16, 12, 6, [[BlinkEnemy, 8]]); fight();
        }, function () { loadout(this._b); }),
        // 5 (2) a shop: the station, the ship pulling in, loot in the lane
        shot('m_shop', 2, 2.0, function (cx) {
            far(5); swapShip('fighter'); this._b = BUILD_REGULATION; loadout(this._b); fov(1.1);
            const p = P(), x = p.worldX, y = p.worldY;
            try { const sh = new Shop(g, x + 520, y - 40); S.shops.push(sh); } catch (e) { console.log('TRAILER shop ' + e); }
            try { for (let i = 0; i < 4; i++) S.itemPickups.push(new ItemPickup(g, x + 140 + i * 90, y + 120 - i * 40, UPGRADES[(i * 7) % UPGRADES.length])); } catch (e) {}
            pilot.set({ type: 'goto', pts: [[x + 260, y + 10]], speed: 520, arrive: 'stop', avoid: true, aim: [x + 520, y - 40] });
        }, function () { loadout(this._b); }),
        // 6 (2) the risen: bone ships everywhere, the blaster hull's heavy guns
        shot('m_bones', 2, 3.4, function (cx) {
            far(6); swapShip('blaster'); this._b = BUILD_HEAVY; loadout(this._b); fov(1.35);
            brawl(12, 10, 6, [[BoneEnemy, 14]]); fight();
        }, function () { loadout(this._b); }),
        // 7 (1) the Event Horizon and its escort
        shot('m_horizon', 1, 3.8, function (cx) {
            far(7); swapShip('bruiser'); this._b = BUILD_MONSTER; loadout(this._b); fov(1.45);
            const p = P(); const b = new EventHorizon(g, p.worldX + 640, p.worldY, 6); S.enemies.push(b); this._boss = b;
            brawl(16, 10, 6); bossFight(() => this._boss);
        }, function () { loadout(this._b); }),
        // 8 (1) the Asteroid Crusher in its rock field
        shot('m_crusher', 1, 3.8, function (cx) {
            far(8); swapShip('cruiser'); this._b = BUILD_PAST_RAIL; loadout(this._b); fov(1.45);
            asteroidField(16, 500, 1300);
            const p = P(); const b = new AsteroidCrusher(g, p.worldX + 600, p.worldY + 60, 6); S.enemies.push(b); this._boss = b;
            brawl(14, 10, 6); bossFight(() => this._boss);
        }, function () { loadout(this._b); }),
        // 9 (1) missiles and shields: the vanisher's machine gun
        shot('m_missile', 1, 3.4, function (cx) {
            far(9); swapShip('vanisher'); this._b = BUILD_FAST; loadout(this._b); fov(1.3);
            brawl(8, 10, 7, [[MissileEnemy, 8], [ShieldEnemy, 6]]); fight();
        }, function () { loadout(this._b); }),
        // 10 (1) the wake — Cthulhu opens
        shot('m_cthulhu', 1, 2.0, function (cx) {
            far(10); swapShip('fighter'); this._b = BUILD_PAST; loadout(this._b); fov(1.5);
            const p = P(); try { const c = new CthulhuEvent(g, p.worldX + 560, p.worldY); c.revealed = true; if (c.wake) c.wake(); S.events.push(c); this._c = c; } catch (e) { console.log('TRAILER cthulhu ' + e); }
            pilot.set({ type: 'hold', aim: () => this._c || null });
        }, function () { loadout(this._b); fxSet(0.3, 0.2); }),
        // 11 (2) the locusts and their mother
        shot('m_locust', 2, 3.6, function (cx) {
            far(11); swapShip('blaster'); this._b = BUILD_SPRAY; loadout(this._b); fov(1.4);
            const p = P(); try { const m = new SwarmMother(g, p.worldX + 760, p.worldY - 80, 5); S.enemies.push(m); } catch (e) {}
            nearRing(LocustEnemy, 18, 420, 900, 4); ringOf(LocustEnemy, 16, 1400, 1800, 4); fight();
        }, function () { loadout(this._b); }),
        // 12 (2) the angel and its escort
        shot('m_seraph', 2, 4.0, function (cx) {
            far(12); swapShip('bruiser'); this._b = BUILD_MONSTER; loadout(this._b); fov(1.45);
            const p = P(); const se = new Seraph(g, p.worldX + 520, p.worldY); se.revealed = true; S.events.push(se); this._se = se;
            brawl(14, 10, 6); pilot.set({ type: 'hunt', range: 2800, rampage: true, noBoost: true, pool: () => (S.enemies.length ? S.enemies : [this._se]) });
        }, function () { loadout(this._b); }),
        // 13 (1) the eye
        shot('m_eye', 1, 1.5, function (cx) {
            far(13); swapShip('fighter'); this._b = BUILD_PAST; loadout(this._b); fov(1.2);
            const p = P(); try { const k = new KnowledgeEvent(g, p.worldX + 420, p.worldY - 40); k.revealed = true; S.events.push(k); this._k = k; } catch (e) { console.log('TRAILER eye ' + e); }
            if (S.dread) { S.dread.forceLevel = 3; S.dread.eye = null; S.dread._trigger('eye'); }
            pilot.set({ type: 'hold', aim: () => this._k || null });
        }, function () { loadout(this._b); fxSet(0.4, 0.3); }),
        // 14 (1) the wheels' spin, and everyone around it
        shot('m_wheels', 1, 4.6, function (cx) {
            far(14); swapShip('cruiser'); this._b = BUILD_ROCKETS; loadout(this._b); fov(1.45);
            const p = P(); const w = new Wheels(g, p.worldX + 480, p.worldY); w.revealed = true; S.events.push(w); this._w = w;
            brawl(14, 10, 6); pilot.set({ type: 'hunt', range: 2800, rampage: true, noBoost: true, pool: () => (S.enemies.length ? S.enemies : [this._w]) });
            this._spun = false;
        }, function (cx, t) { loadout(this._b); if (!this._spun && t >= 4.2) { this._spun = true; const w = this._w; if (w && w.state === 'fight') { w.attack = null; w._startSpin(P()); } } }),
        // 15 (1) one head of the beast, its pack, our heavy guns
        shot('m_head', 1, 3.4, function (cx) {
            far(15); swapShip('vanisher'); this._b = BUILD_HEAVY; loadout(this._b); fov(1.4);
            const p = P(); try { this._head = Dragon.spawnSolo(g, S, 'blasphemy', p.worldX + 600, p.worldY - 40); } catch (e) { console.log('TRAILER head ' + e); }
            brawl(8, 10, 6); bossFight(() => (this._head && this._head.heads && this._head.heads[0]) || null);
        }, function () { loadout(this._b); }),
        // 16 (1) everything at once — the monster build in a wall of ships
        shot('m_wall', 1, 3.4, function (cx) {
            far(16); swapShip('fighter'); this._b = BUILD_MONSTER; loadout(this._b); fov(1.4);
            brawl(28, 20, 8, [[BerserkEnemy, 6], [MissileEnemy, 6]]); fight();
        }, function () { loadout(this._b); }),
    ]; }

    // ── THE SCENES ────────────────────────────────────────────────────────────
    // PRE-VIS TIMELINE — cut to narration-fx-demo.wav (93.5 s, v14 audio).
    // v4d: records sum to 135.82 (retime.py) — air + info cards + the 13.59 s montage after the scream.
    // PRE-VIS v2 — kinematic rig staging (authored paths/orbits, no bot
    // piloting), cut to narration-fx-demo.wav. Every cut LEADS its narration
    // beat by ~0.4s. Records sum to 93.5.
    const SCENES = [

        { // black + click (cut to picture at 1.15, speech 1.55)
            name: 'black', preroll: 0, record: 0.35, hud: false, crosshair: false,
            setup(cx) { quiet(); clearCombat(); setOverlay(1, ''); cx.rig.stop(); bot.setMode('off'); flags.subsOverCard = false; sub.style.zIndex = '46'; },
        },

        { // briefing: slow authored glide through the nebula
            name: 'drift', preroll: 6, record: 6.54, hud: false, crosshair: false,
            setup(cx) {
                quiet(); clearCombat();
                const n = densestNebula();
                // A slow glide THROUGH the nebula's heart; camera starts on the
                // path so the ship is centered from the first visible frame.
                teleport(n.x - 900, n.y + 60);
                S.ambience._cometShowerIn = 6.6;
                fov(1.5);
                this._clearRocks = () => {
                    const p = P();
                    S.asteroids = S.asteroids.filter(a => Math.hypot(a.worldX - p.worldX, a.worldY - p.worldY) > 2600);
                };
                this._clearRocks();
                pilot.set({ type: 'goto', speed: 250, avoid: true, pts: [[n.x - 250, n.y - 40], [n.x + 400, n.y + 30], [n.x + 1000, n.y - 50], [n.x + 1700, n.y - 20]] });
            },
            beats: [
                { at: 5.85, fn() { this._clearRocks(); } },   // the sky stays quiet
            ],
            tick(cx, t) {
                quiet(); heal();
                S.enemies.length = 0; S.encounters.length = 0;   // nothing but the sky in the opening
                // fade in from the black card over the first visible 0.55s
                const r = t - 6;
                if (r >= 0 && r < 0.6) setOverlay(1 - Math.min(1, r / 0.55), '');
                else if (r >= 0.6) setOverlay(0, '');
            },
        },

        { // "Salvage. Survey." — early game: guns fire along the nose only.
          // Fly, stop, turn onto a rock and crack it, scoop the scrap it
          // sheds, then run the lane between the big ones, shooting what's ahead.
            name: 'salvage', preroll: 2.5, record: 4.51,
            setup(cx) {
                quiet(); fov(0);
                const p = P(), x = p.worldX, y = p.worldY;
                const stop = [x + 700, y + 20];
                const rockA = [x + 1260, y - 220];
                const weave = [[x + 1750, y - 420], [x + 2250, y - 120], [x + 2750, y - 360], [x + 3300, y - 200]];
                asteroidField(14, 900, 1900);
                const line = [[x, y], stop, rockA].concat(weave);
                S.asteroids = S.asteroids.filter(a => !line.some(q => Math.hypot(a.worldX - q[0], a.worldY - q[1]) < 300));
                this._rock = new Asteroid(g, rockA[0], rockA[1], 'medium', 0, 0);
                S.asteroids.push(this._rock);
                for (const [ax, ay, sz] of [[x + 1750, y - 100, 'big'], [x + 2250, y - 420, 'big'], [x + 2750, y - 40, 'big'], [x + 3000, y - 520, 'medium']])
                    S.asteroids.push(new Asteroid(g, ax, ay, sz, 0, 0));
                loadout(BUILD_STOCK);
                this._weave = { type: 'goto', pts: weave, speed: 720, avoid: true, shootRocks: true };
                pilot.set({ type: 'goto', pts: [stop], speed: 560, arrive: 'stop', avoid: true, aim: () => this._rock });
            },
            beats: [
                { at: 2.4, fn() { pilot.set({ type: 'mine', rock: () => this._rock, collect: true, then: this._weave }); } },
                { at: 5.0, fn() { if (pilot.goal.type === 'mine') pilot.set(this._weave); } },
            ],
            tick() { quiet(); heal(); loadout(BUILD_STOCK); },
        },

        { // "...self defense." (12.09) — they come in from off-screen; shield up
          // as their fire lands, then we hunt them down, every one. "The dead
          // worlds are generous, take everything." (13.35→16.0) — a field of
          // scrap ahead; we fly through it and the hull drinks it in.
            name: 'skirmish', preroll: 2.5, record: 6.16,
            setup(cx) {
                quiet(); loadout(BUILD_SKIRMISH);
                ringOfEnemies(7, 1400, 1800, 1.2);
                pilot.set({ type: 'hunt', range: 3400, rampage: true, noBoost: true });
            },
            beats: [
                { at: 2.3, fn() { pilot.forceShield = true; } },
                { at: 3.4, fn() { pilot.forceShield = false; } },
                { at: 4.3, fn() {   // 13.2: the scrap field ahead
                    const p = P(), hd = p.angle, cs = Math.cos(hd), sn = Math.sin(hd);
                    for (let k = 0; k < 46; k++) {
                        const fwd = 380 + bot.rand() * 1300, lat = (bot.rand() - 0.5) * 520;
                        S.scrapEntities.push(new Scrap(g, p.worldX + fwd * cs - lat * sn, p.worldY + fwd * sn + lat * cs, bot.rand() < 0.3 ? 'big' : 'small'));
                    }
                    const x = p.worldX, y = p.worldY;
                    this._scrapRun = { type: 'goto', speed: 520, avoid: true, fireAt: 700, pts: [
                        [x + 600 * cs, y + 600 * sn], [x + 1250 * cs - 90 * sn, y + 1250 * sn + 90 * cs], [x + 1900 * cs + 60 * sn, y + 1900 * sn - 60 * cs]] };
                } },
                { at: 5.0, fn() { pilot.set(this._scrapRun); } },   // 13.9: through the scrap (still shooting what's near)
            ],
            tick() { quiet(); heal(); loadout(BUILD_SKIRMISH); const p = P(); if (p) p.scrapRangeMult = 3.2; },
        },

        cardUpgrades,

        { // "Learn." (20.44) — the level-up card
            name: 'learn', preroll: 1.0, record: 1.54,
            setup(cx) {
                quiet(); clearCombat(); setOverlay(0, '');
                const p = P();
                pilot.set({ type: 'hold' });
                p.addExp(Math.max(1, (p.expNeeded || 100) - p.exp + 1));
            },
            beats: [
                { at: 1.0, fn() { if (!S.activeLevelUpDialog) S._openLevelUpDialog(1); } },
                { at: 2.2, fn() { if (S.activeLevelUpDialog) S.activeLevelUpDialog._selectChoice(0); } },
            ],
            tick() { quiet(); },
        },

        { // "Bargain." (21.40) — the stranger's hail
            name: 'bargain', preroll: 2, record: 1.0,
            setup(cx) {
                quiet(); clearCombat();
                teleport(P().worldX + 60000, P().worldY + 8000);
                S._spawnEncounter();
                const enc = S.encounters[S.encounters.length - 1];
                const p = P();
                if (enc) { enc.worldX = p.worldX + 420; enc.worldY = p.worldY - 60; this._enc = enc; }
                pilot.set({ type: 'hold', aim: () => this._enc });
            },
            beats: [
                { at: 2.02, fn() { const e = this._enc; if (e && e.alive) S._openEncounterDialog(e); } },
                { at: 2.85, fn() { if (S.activeEncounterDialog) S.activeEncounterDialog.closed = true; } },
            ],
            tick() { quiet(); heal(); },
        },

        { // "Arm yourself." (22.44) → "past regulation" (23.66): the blaster
          // build → "past reason" (25.4): the RAILGUN, and the view pulls wide
          // → the swarm closes from off-screen → the shield holds through "If
          // you die out there—" (33.94) → it breaks; the ship dies at the tear
          // (35.06) → the game's own GAME OVER sits under "come back" (39.8).
            name: 'arm', preroll: 2, record: 18.4,
            setup(cx) {
                quiet(); clearCombat();
                teleport(P().worldX + 40000, P().worldY - 20000);
                ['cargo_expansion', 'cargo_expansion', 'multishot_guns', 'auto_turret'].forEach(id => give(id));
                try { S._onInventoryChanged(); } catch (e) {}
                this._build = BUILD_REGULATION; loadout(this._build);
                this._doomed = false;
                fov(1.15);
                ringOfEnemies(10, 1300, 1700, 3);
                const p = P(), x = p.worldX, y = p.worldY;
                pilot.set({ type: 'hunt', range: 3400, rampage: true, bias: [x + 3000, y] });
            },
            beats: [
                // "past regulation" — the build stops being reasonable
                { at: 3.45, fn() {
                    ['cargo_expansion', 'cargo_expansion', 'cargo_expansion',
                     'energy_blaster', 'energy_blaster', 'energy_blaster', 'rockets'].forEach(id => give(id));
                    try { S._onInventoryChanged(); } catch (e) {}
                    this._build = BUILD_PAST; loadout(this._build);
                    fov(1.3);
                    ringOfEnemies(14, 1500, 1900, 5);
                } },
                // "past reason" — the railgun: big beams, and the view goes wider still
                { at: 5.2, fn() {
                    give('railgun'); try { S._onInventoryChanged(); } catch (e) {}
                    this._build = BUILD_PAST_RAIL; loadout(this._build);
                    fov(1.6);
                    ringOfEnemies(10, 1700, 2100, 5);
                } },
                // the fight turns: too many, from every side, no more healing
                { at: 11.4, fn() { this._doomed = true; ringOfEnemies(24, 1500, 1900, 8); } },
                { at: 12.9, fn() { pilot.forceShield = true; } },   // the shield holds the line through "if you die out there"
                { at: 13.4, fn() { const p = P(); p.health = p.maxHealth * 0.3; } },
                // the shield has held through the line; now it breaks (the tear lands at 35.06)
                { at: 14.9, fn() { pilot.forceShield = false; pilot.set({ type: 'idle' }); if (!S.isDead) S._triggerDeath(); S.deathTimer = 1.4; } },
            ],
            tick() {
                quiet(); loadout(this._build);
                const p = P();
                if (!this._doomed) heal();
                else if (p && p._levelUpQueue) p._levelUpQueue.length = 0;
            },
        },

        { // "—come back." landed over the GAME OVER; now the new ship drops in —
          // tight on the hull, the view breathing out as it comes alive.
            name: 'return', preroll: 1.2, record: 2.9,
            setup(cx) {
                revive(); clearCombat(); quiet();
                teleport(P().worldX + 30000, P().worldY - 15000);
                fov(0); P().itemFovMult = 0.72;
                const p = P(), x = p.worldX, y = p.worldY;
                pilot.set({ type: 'cruise', heading: 0, speed: 1100, weave: 0.08, boost: true });
            },
            tick(cx, t) {
                quiet(); heal();
                const r = Math.max(0, t - 1.2);                       // record-local
                const k = Math.min(1, r / 1.3), e = 1 - Math.pow(1 - k, 2);
                P().itemFovMult = 0.72 + 0.33 * e;                    // the respawn zoom-out
                S.enemies.length = 0; loadout(BUILD_STOCK);
            },
        },

        { // "You hear it pilot? The deep is praying." (43.0) — a run through the
          // dark with the dread rising; the Christus Victor constellation sweeps
          // past on the words, there for a moment and gone. No enemies.
            name: 'omen', preroll: 2, record: 4.33,
            setup(cx) {
                quiet(); clearCombat(); revive();
                teleport(P().worldX + 45000, P().worldY + 30000);
                if (S.dread) { S.dread.forceLevel = 3; S.dread.eye = null; S.dread._trigger('yellowCreep'); }
                fov(1.25);
                const p = P(), x = p.worldX, y = p.worldY;
                p.angle = 0; p.vx = 520; p.vy = 0;
                try {
                    const yo = new YellowOne(g, x + 20000, y + 20000);     // far away, never seen — it only carries the constellation
                    yo.state = 'finished'; yo.constellationVisible = true; yo.alive = true;
                    // placed so it crosses the frame under "the deep is praying" (45.4-46.9)
                    yo.christusX = x + 2250; yo.christusY = y - 230;
                    S.events.push(yo); this._con = yo;
                } catch (e) { console.log('TRAILER constellation ' + e); }
                pilot.set({ type: 'goto', pts: [[x + 1400, y - 80], [x + 2600, y + 40], [x + 3800, y - 60], [x + 5000, y + 20]], speed: 760, avoid: true });
            },
            beats: [
                { at: 3.4, fn() { if (S.dread) S.dread._trigger('shadow'); } },
                { at: 5.0, fn() { if (S.dread) S.dread._trigger('patches'); } },
            ],
            tick(cx, t) {
                quiet(); heal(); dreadHold(); if (S.dread) S.dread.eye = null; S.enemies.length = 0;
                loadout(BUILD_STOCK); g.input.mouseButtons.delete(0);
                const k = Math.min(1, Math.max(0, (t - 2) / 4.3));
                fxSet(0.1 + 0.3 * k, 0.05 + 0.25 * k);                     // the dread climbs through the line
            },
        },

        cardGods,

        { // "They'll send wheels of fire." (50.59) — a strafing run at the god
            name: 'wheels', preroll: 4, record: 2.27,
            setup(cx) {
                clearCombat(); quiet(); setOverlay(0, '');
                if (S.dread) S.dread.forceLevel = 0;
                teleport(P().worldX + 50000, P().worldY - 40000);
                const w = new Wheels(g, P().worldX + 500, P().worldY);
                w.revealed = true;
                S.events.push(w);
                this._w = w;
                fov(1.45); this._b = BUILD_PAST_RAIL; loadout(this._b);        // the wheels: the big beams
                pilot.set({ type: 'strike', target: () => this._w, standoff: 480, rampage: true, noBoost: true });
            },
            beats: [
                { at: 4.7, fn() { const w = this._w; if (w && w.state === 'fight') { w.attack = null; w._startSpin(P()); } } },
            ],
            tick() { quiet(); heal(); loadout(this._b); fxSet(0.12, 0.08); },
        },

        { // "They'll send an angel." (52.37)
            name: 'seraph', preroll: 4, record: 1.25,
            setup(cx) {
                clearCombat(); quiet();
                teleport(P().worldX + 50000, P().worldY + 50000);
                const se = new Seraph(g, P().worldX + 470, P().worldY);
                se.revealed = true;
                S.events.push(se);
                this._se = se;
                fov(1.45); this._b = BUILD_MONSTER; loadout(this._b);           // the angel: the monster blaster
                pilot.set({ type: 'strike', target: () => this._se, standoff: 440, rampage: true, noBoost: true });
            },
            tick() { quiet(); heal(); loadout(this._b); fxSet(0.28, 0.18); },
        },

        { // "They'll send the swarm." (53.67)
            name: 'hive', preroll: 5, record: 1.25,
            setup(cx) {
                clearCombat(); quiet();
                teleport(P().worldX - 60000, P().worldY + 45000);
                const h = new Hive(g, P().worldX + 680, P().worldY);
                h.revealed = true;
                S.events.push(h);
                this._h = h;
                fov(1.5); this._b = BUILD_SPRAY; loadout(this._b);              // the swarm: a wall of pellets
                pilot.set({ type: 'strike', target: () => this._h, standoff: 620, rampage: true, noBoost: true });
            },
            tick() { quiet(); heal(); loadout(this._b); fxSet(0.42, 0.28); },
        },

        { // "They'll raise the dead" (54.47) — corruption peaks on the word;
          // "and when nothing comes home" (55.4) — everything dies, the ship
          // stops, the game goes still; then the King in Yellow drifts into
          // frame (59.0) and comes to us for "they'll send the king in yellow".
            name: 'bones', preroll: 7, record: 11.0,
            setup(cx) {
                clearCombat(); quiet();
                teleport(P().worldX + 70000, P().worldY + 70000);
                const c = new Carcosa(g, P().worldX + 7000, P().worldY);
                c.revealed = true;
                S.events.push(c);
                this._c = c;
                P().hasYellowGlow = true;
                fov(1.3);
                teleport(c.worldX - 900, c.worldY);
                this._still = false; this._yo = null;
                this._b = BUILD_ROCKETS; loadout(this._b);                     // the dead: the cannon and the rockets
                pilot.set({ type: 'hunt', range: 3000, rampage: true, noBoost: true, bias: [c.worldX - 300, c.worldY] });
            },
            beats: [
                { at: 7.3, fn() { if (S.dread) { S.dread.forceLevel = 3; S.dread._trigger('hudGlitch'); } } },
                { at: 7.45, fn() { if (S.dread) S.dread._trigger('shadow'); } },
                { at: 8.4, fn() {   // "when nothing comes home" — kill everything, stop the ship
                    this._still = true;
                    S.enemies.length = 0; S.projectiles.length = 0; S.sparks && (S.sparks.length = 0);
                    this._b = BUILD_HEAVY;                            // no rockets under the king — nothing auto-fires
                    pilot.set({ type: 'idle' });                     // hands off the stick; the ship coasts to a stop
                    fov(1.15);
                    if (S.dread) { S.dread.forceLevel = 1; S.dread.shadow = null; }
                } },
                { at: 12.0, fn() {  // the king enters the frame and comes to us
                    const p = P();
                    const yo = new YellowOne(g, p.worldX + 980, p.worldY - 120);   // just inside his follow trigger: he comes straight in
                    yo.revealed = true;
                    S.events.push(yo);
                    this._yo = yo;
                    if (S.dread) S.dread.forceLevel = 2;
                    // face him and back off on the reverse thruster, so he stays beside us, never under us
                    pilot.set({ type: 'hold', aim: () => this._yo });   // hold; face him; he comes to us
                } },
            ],
            tick(cx, t) {
                quiet(); heal(); dreadHold(); loadout(this._b);
                if (!this._still) {
                    const k = Math.min(1, Math.max(0, (t - 7.0) / 0.5));   // ramps INTO "raise the dead"
                    fxSet(0.5 + 0.35 * k, 0.35 + 0.25 * k);
                } else {
                    const k = Math.min(1, (t - 8.4) / 0.35);               // ...and drops dead still
                    fxSet(0.85 * (1 - k) + 0.05, 0.6 * (1 - k) + 0.03);
                    if (S.dread) S.dread.eye = null;                   // no eye mirage under the king
                }
            },
        },

        { // "—to ask the little spark its name." — face to face
            name: 'kingface', preroll: 1.5, record: 4.4,
            setup(cx) {
                quiet();
                const p = P();
                const yo = this._yo || S.events.find(ev => ev && ev.constructor && ev.constructor.name === 'YellowOne');
                this._yo2 = yo;
                pilot.set({ type: 'hold', aim: () => this._yo2 });
                if (S.dread) S.dread.forceLevel = 3;
            },
            tick(cx, t) {
                quiet(); heal(); dreadHold(); if (S.dread) S.dread.eye = null; loadout(BUILD_HEAVY);
                const k = Math.min(1, t / 5.9);
                setVignette(k * 0.4, 44);
                fxSet(0.12 + 0.2 * k, 0.08 + 0.15 * k);
            },
        },

        { // "Answer it." (71.83) / "ANSWER IT!" (75.29) — the King in Yellow,
          // enraged: his last phase. Teleports, crushes, the armada — and us,
          // at the full build, strafing him.
            name: 'answer', preroll: 5, record: 7.18,
            setup(cx) {
                setOverlay(0, ''); setVignette(0);
                clearCombat(); quiet();
                if (S.dread) S.dread.forceLevel = 1;
                fov(1.3);
                const p = P();
                teleport(p.worldX + 90000, p.worldY + 20000);
                ['multishot_guns', 'energy_blaster', 'energy_blaster', 'energy_blaster',
                 'energy_blaster', 'rockets', 'auto_turret', 'laser_override',
                 'energy_cell', 'mechanical_engines'].forEach(id => give(id));
                try { S._onInventoryChanged(); } catch (e) {}
                loadout(BUILD_MONSTER);
                const yo = new YellowOne(g, p.worldX + 320, p.worldY - 80);
                yo.revealed = true; yo.musicPlaying = true; yo.musicStartTime = performance.now() / 1000 - 60;
                yo.phase1Triggered = true; yo.invulnerable = false;
                yo.health = 2400; yo.maxHealth = 2400;
                yo.summonTimer = 1.0; yo.crushTimer = 1.5; yo.dashTimer = 1.0; yo.teleportTimer = 1.2;
                S.events.push(yo);
                try { yo._startEnraged(p); } catch (e) { console.log('TRAILER enrage failed ' + e); }
                this._yo = yo;
                S.waveTimer = 9999;
                // no strafing around a teleporting king: a slow, readable drift; the
                // guns pick the nearest threat (his armada, or him), the shield
                // comes up for his crush beams
                pilot.set({ type: 'hunt', range: 1600, rampage: true, noBoost: true,
                    pool: () => (S.enemies.length ? S.enemies : (this._yo ? [this._yo] : [])) });
            },
            beats: [
                { at: 6.2, fn() { pilot.forceShield = true; } }, { at: 7.4, fn() { pilot.forceShield = false; } },
                { at: 11.0, fn() { pilot.forceShield = true; } }, { at: 12.1, fn() { pilot.forceShield = false; } },
            ],
            tick(cx, t) {
                heal(); S.waveTimer = 9999; loadout(BUILD_MONSTER); dreadHold();
                const yo = this._yo;
                if (yo) {
                    yo.enragedTimer = Math.min(yo.enragedTimer, 4.9);   // just under his 5 s kill switch
                    yo.health = Math.max(yo.health, 1);
                    // relentless: crush beams, teleports and summons on short fuses
                    if (yo.crushTimer > 0.45) yo.crushTimer = 0.45;
                    if (yo.teleportTimer > 0.6) yo.teleportTimer = 0.6;
                    if (yo.summonTimer > 1.4) yo.summonTimer = 1.4;
                }
                fxSet(0.3, 0.2);
            },
        },

        // ── THE MONTAGE (76.58 → 90.17): the eruption's drop, 24 beats of it.
        // Other runs, other hulls, other things in the dark. Every cut is on
        // the beat (0.56616 s); the script returns on the bar at 90.17.
        ...MONTAGE_SHOTS(),

        { // "Do you see him? He sees you." — the red glow points at nothing yet;
          // we fly toward it. At 86.3 the dragon's own arrival cinematic
          // begins (its 11.0 s mark — the heads launching to carve the
          // pentagram — lands exactly on the cut to the head at 97.28):
          // "this is where the others went" over the seven ships sweeping
          // in, "don't give it your name" over the stillness and the pulse.
            name: 'dragoncomes', preroll: 3, record: 17.53, hud: false, crosshair: false,
            setup(cx) {
                clearCombat(); quiet(); setOverlay(0, ''); setVignette(0);
                fov(1.25);
                swapShip('fighter'); loadout(BUILD_MONSTER);
                const p = P();
                teleport(p.worldX + 70000, p.worldY - 50000);
                p.hasYellowGlow = true; p.glowRed = true;
                const x = P().worldX, y = P().worldY;
                const D = new Dragon(g, x + 9000, y - 600);
                D.revealed = true;
                S.events.push(D); S.dragonEvent = D;
                p.yellowGlowTarget = { x: D.worldX, y: D.worldY };
                this._D = D; this._cine = false;
                if (S.dread) { S.dread.forceLevel = 3; S.dread._trigger('yellowCreep'); }
                pilot.set({ type: 'goto', pts: [[x + 900, y - 60], [x + 1800, y - 140], [x + 2600, y - 200], [x + 3400, y - 260]], speed: 540, avoid: true });
            },
            beats: [
                { at: 6.0, fn() { if (S.dread) S.dread._trigger('shadow'); } },
                { at: 9.55, fn() {   // 86.3: the site is here; the arrival begins
                    const p = P(), D = this._D;
                    D.worldX = D.siteX = p.worldX + 400; D.worldY = D.siteY = p.worldY;
                    pilot.set({ type: 'idle' });                     // the arrival owns the ship now
                    if (S.dread) { S.dread.forceLevel = 0; S.dread.shadow = null; }
                    try { D._startCinematic(p); this._cine = true; } catch (e) { console.log('TRAILER dragon cinematic failed ' + (e.stack || e)); }
                } },
            ],
            tick(cx, t) {
                quiet(); heal(); dreadHold();
                if (S.encounters && S.encounters.length) S.encounters.length = 0;   // no stray encounter ship in the ring
                { const q = P(); S.asteroids = S.asteroids.filter(a => Math.hypot(a.worldX - q.worldX, a.worldY - q.worldY) > 4500); }   // and no rocks
                if (!this._cine) { const k = Math.min(1, t / 9.5); fxSet(0.15 + 0.3 * k, 0.1 + 0.2 * k); }
                else fxSet(0.1, 0.06);
            },
        },

        { // the dragon breathes — the head in the dark, lit by each breath,
          // tearing with it; the eyes open on the last big breath; then black.
            name: 'dragoneyes', preroll: 2.5, record: 12.52, hud: false, crosshair: false,
            setup(cx) {
                clearCombat(); quiet(); cx.rig.stop();
                // the arrival's hard input lock + letterbox end here (we cut before it releases them)
                S.dragonCinematic = false; if (S.cinematics) S.cinematics.letterboxTarget = 0;
                for (const lp of (S.localPlayers || [])) if (lp.player) lp.player.controlsEnabled = true;
                setVignette(0); fxSet(0, 0);
                ov.style.background = '#000';
                let html = '<div id="drg" style="position:relative;width:768px;height:768px;opacity:0">';
                html += '<img id="drgGhost" src="' + frameSrc('dragon', 0) + '" style="position:absolute;left:0;top:0;width:768px;image-rendering:pixelated;filter:hue-rotate(160deg) brightness(1.3);opacity:0;mix-blend-mode:screen">';
                for (let i = 0; i < 12; i++) {
                    html += '<div class="drgSl" style="position:absolute;left:0;top:' + (i * 64) + 'px;width:768px;height:64px;' +
                        'background-image:url(' + frameSrc('dragon', 0) + ');background-size:768px 768px;background-position:0 ' + (-i * 64) + 'px;image-rendering:pixelated"></div>';
                }
                html += '<div style="position:absolute;inset:-2px;background:radial-gradient(circle at 50% 46%, rgba(0,0,0,0) 22%, rgba(0,0,0,0.55) 40%, #000 60%)"></div>';
                html += '</div>';
                setOverlay(1, html);
                this._eyes = false; this._f = 0; this._lit = 0;
            },
            tick(cx, t) {
                quiet(); dreadHold();
                const T = AV.recT;
                const e = breathAt(T);
                // light: each breath brings the face up out of the dark; it never fully leaves
                const r = Math.max(0, t - 2.5);
                this._lit = Math.max(this._lit * 0.94, e);
                const floor = Math.min(0.10, r * 0.03);
                const drg = document.getElementById('drg');
                if (T >= 119.97) { if (drg) drg.style.opacity = '0'; return; }   // gone before the black
                if (drg) drg.style.opacity = String(Math.min(1, floor + 0.9 * this._lit));
                // eyes: shut (frames 0/1 breathe) until the last big breath, then open and stay open
                if (!this._eyes && T >= 118.87) { this._eyes = true; this._f = 2; this._eyeT = T; }
                let f;
                if (this._eyes) f = 2 + Math.floor((T - this._eyeT) * 5) % 10;
                else f = (Math.floor(T * 0.6) % 2);
                const src = frameSrc('dragon', f);
                // glitch: slices tear sideways with the breath (quadratic, so only the peaks tear)
                const gl = e * e;
                const sl = ov.querySelectorAll('.drgSl');
                sl.forEach((d, i) => {
                    const off = gl > 0.12 && bot.rand() < 0.75 ? Math.round((bot.rand() - 0.5) * 2 * 56 * gl) : 0;
                    d.style.backgroundImage = 'url(' + src + ')';
                    d.style.backgroundPosition = off + 'px ' + (-i * 64) + 'px';
                    d.style.filter = 'brightness(' + (0.75 + 0.5 * e + (gl > 0.3 && bot.rand() < 0.15 ? 0.6 : 0)).toFixed(2) + ')';
                });
                const gh = document.getElementById('drgGhost');
                if (gh) {
                    gh.setAttribute('src', src);
                    gh.style.opacity = String(0.55 * gl);
                    gh.style.transform = 'translateX(' + Math.round((bot.rand() < 0.5 ? -1 : 1) * 18 * gl) + 'px)';
                }
                setVignette(0.35 + 0.4 * (1 - e), 30);
            },
        },

        { // black — the dragon is gone
            name: 'black2', preroll: 0, record: 1.99, hud: false, crosshair: false,
            setup(cx) { setOverlay(1, ''); setVignette(0); fxSet(0, 0); P().itemFovMult = 1; ov.style.background = '#000'; },
        },

        { // the button: "A word of advice —" over black; on "bring friends" the
          // picture returns as gameplay: eight pilots cruising through the
          // nebula. The lead flies a lazy weave; each wingman is FLOWN by his
          // own pilot (a fake pad on a real co-op body) toward a wandering slot
          // in the lead's frame — they turn, catch up, fall back, overshoot.
          // No combat, no rocks. Just the fleet.
            name: 'button', preroll: 0, record: 4.01, hud: true, crosshair: false,
            setup(cx) {
                fxSet(0, 0); setVignette(0);
                ov.style.background = '#000';
                setOverlay(1, '');
                flags.subsOverCard = true;   // the panel types over the black
                this._c = 0;
                clearCombat(); quiet();
                S.dragonCinematic = false; if (S.cinematics) S.cinematics.letterboxTarget = 0;
                swapShip('fighter'); loadout(BUILD_REGULATION);
                const p = P(); p.controlsEnabled = true;
                const n = densestNebula();
                teleport(n.x - 1200, n.y + 200);
                p.angle = 0; p.vx = 400; p.vy = 0;
                fov(1.7);
                this._mates = [];
                const HOME = [[-170, -95], [-190, 110], [-320, -170], [-350, 190], [-460, -55], [-500, 230], [-600, 40]];
                try {
                    ['cruiser', 'bruiser', 'looper', 'vanisher', 'blaster', 'looper', 'vanisher'].forEach((h, i) => {
                        const slot = S._addLocalPilot(null, SHIPS.find(sd => sd.id === h) || S.shipData);
                        const q = slot.player; this._mates.push(q);
                        const [hx, hy] = HOME[i];
                        q.worldX = p.worldX + hx + (bot.rand() - 0.5) * 200; q.worldY = p.worldY + hy + (bot.rand() - 0.5) * 160;
                        q.angle = 0; q.vx = 380; q.vy = 0;
                        const wp = new Pilot(g, 777 + i * 131, { io: 'pad', player: () => q });
                        q.input = wp.pad; q.useMouseAim = false; q.controlsEnabled = true; q.health = q.maxHealth;
                        wp.set({ type: 'follow', lead: () => P(), offset: [hx, hy] });
                        wingPilots.push(wp);
                    });
                    P().input = null; P().useMouseAim = true;
                    S.splitScreen.setCount(1);                       // ONE screen
                    S.localPlayers[0].killStreak = S.killStreak; S.killStreak.pilot = null;
                } catch (e) { console.log('TRAILER coop failed ' + (e.stack || e)); }
                this._clearSky = () => {
                    const q = P();
                    S.asteroids = S.asteroids.filter(a => Math.hypot(a.worldX - q.worldX, a.worldY - q.worldY) > 3200);
                    S.enemies.length = 0;
                };
                this._clearSky();
                pilot.set({ type: 'cruise', heading: 0, speed: 520, weave: 0.14 });
            },
            tick(cx, t) {
                quiet(); S.waveTimer = 87; heal(); this._clearSky();
                for (const q of this._mates) { if (q && !q.dead) { q.health = q.maxHealth; if (q.maxShieldEnergy) q.shieldEnergy = q.maxShieldEnergy; if (q._levelUpQueue) q._levelUpQueue.length = 0; } }
                g.input.mouseButtons.delete(0);                      // nobody fires
                if (t >= 1.48 && this._c === 0) { this._c = 1; setOverlay(0, ''); g.sounds.play('select', { volume: 0.8 }); }
                if (this._c >= 1) {
                    let b = document.getElementById('coopBanner');
                    if (!b) {
                        b = document.createElement('div'); b.id = 'coopBanner';
                        b.style.cssText = "position:fixed;left:50%;top:3vh;transform:translateX(-50%);z-index:47;pointer-events:none;font-family:'Astro5x',Consolas,monospace;font-size:7vh;color:#fff;letter-spacing:0.14em;text-shadow:0 3px 0 rgba(0,0,0,0.9);white-space:nowrap;text-align:center";
                        b.innerHTML = '1&ndash;8 PLAYERS<div id="coopL2" style="color:#7fd4ff;font-size:3.8vh;letter-spacing:0.24em;margin-top:0.6vh;visibility:hidden">ONLINE CO-OP</div>';
                        document.body.appendChild(b);
                    }
                    if (t >= 2.25) { const l2 = document.getElementById('coopL2'); if (l2) l2.style.visibility = 'visible'; if (this._c === 1) { this._c = 2; g.sounds.play('click', { volume: 0.7 }); } }
                }
            },
        },

        { // the end card
            name: 'title', preroll: 0, record: 9.6, hud: false, crosshair: false,
            setup(cx) {
                const b = document.getElementById('coopBanner'); if (b) b.remove();
                try { S.setCoopCount(1); } catch (e) {}
                clearCombat();
                fxSet(0, 0);
                setVignette(0);
                ov.style.background = '#000';
                setOverlay(1, END_CARD);
            },
            tick(cx, t) {
                const e = (id, at, dur = 0.8) => {
                    const el = document.getElementById(id);
                    if (el) el.style.opacity = String(Math.max(0, Math.min(1, (t - at) / dur)));
                };
                e('ovLogo', 0.4, 1.4);
                e('ovTag', 2.4); e('ovTag2', 3.2); e('ovWish', 5.4); e('ovFine', 6.2);
            },
        },
    ];



    // ── Timeline driver ───────────────────────────────────────────────────────
    let sceneIdx = -1;
    let scene = null;
    let tLocal = 0;
    let done = false;
    let frame = 0;
    let recFrames = 0;
    const CUM_END = []; { let a = 0; for (const sc of SCENES) { a += sc.record; CUM_END.push(a); } }

    function enterScene(i) {
        sceneIdx = i;
        scene = SCENES[i];
        tLocal = 0; nLocal = 0;
        flags.hud = scene.hud !== false;
        flags.crosshair = scene.crosshair !== false;
        if (scene.name !== 'black' && scene.name !== 'blackbeat' && scene.name !== 'title'
            && scene.name !== 'nova') { ov.style.background = '#000'; setOverlay(0, ''); }
        scene._fired = new Set();
        pilot.set({ type: 'idle' }); pilot.forceShield = false; wingPilots = []; rig.stop();
        // No modal survives a cut: force-close dialogs and unpause.
        try {
            if (S.activeLevelUpDialog) { try { S.activeLevelUpDialog._selectChoice(0); } catch (e2) {} }
            S.activeLevelUpDialog = null; S.isLevelUpOpen = false;
            if (S.activeEncounterDialog) S.activeEncounterDialog.closed = true;
            S.paused = false;
        } catch (e) {}
        try { if (scene.setup) scene.setup(cx); } catch (e) { console.log('TRAILER setup error [' + scene.name + '] ' + (e.stack || e)); }
    }

    let nLocal = 0;          // frames into the scene (exact clock — no float drift)
    let pendingAdvance = false;
    function step() {
        if (done) return { done: true };
        if (sceneIdx < 0) enterScene(0);
        // The cut happens HERE, at the top of the next step — never after a
        // frame was composed. (Advancing at the bottom ran the next scene's
        // setup before capture screenshotted the frame: every scene's last
        // frame showed the next one's teleport with the overlay already gone.)
        if (pendingAdvance) {
            pendingAdvance = false;
            if (sceneIdx + 1 < SCENES.length) enterScene(sceneIdx + 1);
            else { done = true; return { done: true }; }
        }
        tLocal = nLocal / FPS;

        // Scene beats + per-frame tick, then the bot, then one game frame.
        if (scene.beats) {
            for (let i = 0; i < scene.beats.length; i++) {
                const b = scene.beats[i];
                if (tLocal >= b.at - 1e-6 && !scene._fired.has(i)) {
                    scene._fired.add(i);
                    try { b.fn.call(scene, cx); } catch (e) { console.log('TRAILER beat error [' + scene.name + '@' + b.at + '] ' + (e.stack || e)); }
                }
            }
        }
        const recording = nLocal >= Math.round(scene.preroll * FPS);
        AV.recording = recording;
        if (recording) { AV.recT = recFrames / FPS; recFrames++; }
        try { if (scene.tick) scene.tick.call(scene, cx, tLocal); } catch (e) { console.log('TRAILER tick error [' + scene.name + '] ' + (e.stack || e)); }
        try { pilot.drive(DT); for (const m of wingPilots) m.drive(DT); } catch (e) { console.log('TRAILER pilot error ' + (e.stack || e)); }
        try { rig.tick(DT); } catch (e) { console.log('TRAILER rig error ' + (e.stack || e)); }

        VNOW += 1000 * DT;
        const q = rafQ; rafQ = [];
        for (const cb of q) { try { cb(VNOW); } catch (e) { console.log('TRAILER frame error ' + (e.stack || e)); } }

        try { drawSubs(AV.recT); drawFlashes(AV.recT); } catch (e) {}
        const out = { frame, scene: scene.name, sceneIdx, t: tLocal, recording, done: false };
        frame++;
        nLocal++;
        // Cut on the PLANNED cumulative record time, not per-scene rounding.
        if (recording && recFrames / FPS >= CUM_END[sceneIdx] - 1e-6) pendingAdvance = true;
        return out;
    }

    // ── Render cache support ─────────────────────────────────────────────────
    // capture.mjs caches each scene's frames under a key of the scene's own
    // definition (+ its index, since sim state flows forward). For a cached
    // scene it only SIMULATES (draw + screenshot skipped) and copies the frames.
    // Bump RENDER_CORE when shared helpers (rig, loadout, cards, subs) change
    // in a way that alters pictures without touching scene source.
    const RENDER_CORE = 'core-v4q';
    const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); };
    const sceneKey = (sc, i) => fnv(RENDER_CORE + '|' + i + '|' + sc.name + '|' + sc.preroll + '|' + sc.record + '|' +
        (sc.setup ? sc.setup.toString() : '') + (sc.tick ? sc.tick.toString() : '') +
        (sc.beats ? sc.beats.map(b => b.at + ':' + b.fn.toString()).join(';') : '') + (sc._src || ''));
    let drawOn = true;
    {
        const _sDraw = S.draw.bind(S);
        S.draw = (...a) => { if (drawOn) _sDraw(...a); };
        // the post-FX pass uploads the whole canvas to the GPU every frame —
        // gate it with the draw (it is created lazily by the game loop)
        let _fx = null, _fxOrig = null;
        const gateFx = () => {
            if (g.screenFx && g.screenFx !== _fx) { _fx = g.screenFx; _fxOrig = { render: _fx.render.bind(_fx), renderPanes: _fx.renderPanes ? _fx.renderPanes.bind(_fx) : null }; }
            if (!_fx) return;
            _fx.render = drawOn ? _fxOrig.render : () => {};
            if (_fxOrig.renderPanes) _fx.renderPanes = drawOn ? _fxOrig.renderPanes : () => {};
        };
        setInterval(gateFx, 200); gateFx();
    }

    window.TRAILER = {
        setDraw(on) { drawOn = !!on; return drawOn; },
        sceneKeys: SCENES.map((sc, i) => sceneKey(sc, i)),
        get ready() { return artReady; },
        fps: FPS,
        get sfxLog() { return sfxLog; },
        scenes: SCENES.map(s => ({ name: s.name, preroll: s.preroll, record: s.record })),
        step,
        // Step without recording intent (capture uses this for fast preroll).
        stepN(n) { let last = null; for (let i = 0; i < n && !done; i++) last = step(); return last; },
        state() { return { sceneIdx, scene: scene && scene.name, t: tLocal, done }; },
    };
    console.log('TRAILER READY scenes=' + SCENES.length);
})();
