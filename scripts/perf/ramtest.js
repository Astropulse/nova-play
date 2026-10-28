// Repro for "crashing into an asteroid while holding shield lags" (Firefox).
// Boots a solo run, holds the shield, and flies asteroids of each size into
// the ship repeatedly. Times whole frames plus each suspect system, and POSTs
// the per-crash worst frames + section maxima to /perflog.
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function post(o) { try { fetch('/perflog', { method: 'POST', body: JSON.stringify(o), keepalive: true }); } catch (e) {} }
async function waitFor(p, t = 30000) { const a = performance.now(); while (performance.now() - a < t) { if (p()) return true; await sleep(100); } return false; }

(async () => {
    await waitFor(() => window.__novaGame && window.__novaGame.assets && window.__novaGame.assets.get('asteroid_big_0'));
    const g = window.__novaGame;
    const [ps, ships, astMod] = await Promise.all([
        import('/src/states/playingState.js'), import('/src/data/ships.js'), import('/src/entities/asteroid.js')]);
    g.setState(new ps.PlayingState(g, ships.SHIPS[0]));
    await waitFor(() => g.currentState && g.currentState.player && g.currentState.impactFx, 10000);
    const S = g.currentState, p = S.player;
    post({ tag: 'ramtest', ua: navigator.userAgent, w: g.width, h: g.height, lowPerf: g.lowPerfMode });

    // Section timers (wrap methods; record max per window).
    const sec = {};
    const wrap = (obj, name, label) => {
        const f = obj[name]; if (!f) return;
        obj[name] = function (...a) { const t0 = performance.now(); const r = f.apply(this, a); const d = performance.now() - t0; sec[label] = Math.max(sec[label] || 0, d); return r; };
    };
    wrap(S.impactFx, 'draw', 'fx.draw');
    wrap(S.impactFx, 'drawUnder', 'fx.drawUnder');
    wrap(S.impactFx, 'update', 'fx.update');
    wrap(S.impactFx, 'shatter', 'fx.shatter');
    wrap(S.impactFx, 'shieldBreak', 'fx.shieldBreak');
    wrap(S.stateFx, 'tick', 'stateFx.tick');
    wrap(S.uiFx, 'frame', 'uiFx.frame');
    wrap(S, '_damagePlayer', 'damagePlayer');
    wrap(S, '_onEntityDestroyed', 'onEntityDestroyed');
    wrap(S, '_drawWorld', 'drawWorld');
    wrap(S, '_drawScreenUI', 'drawScreenUI');

    // Frame timer.
    let last = performance.now(), worst = 0, frames = [];
    const loop = () => { const n = performance.now(); const d = n - last; last = n; worst = Math.max(worst, d); frames.push(d); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);

    await sleep(4000); // let prewarm / cloud warm-up settle
    // Prewarm ScreenFX like the title screen does (context + shader compile),
    // then log EVERY post-fx call so one-off init can't masquerade as cost.
    let calls = [];
    {
        const sf = g.screenFx;
        if (sf && !sf.gl && sf._init) { const t0 = performance.now(); sf._init(); post({ tag: 'screenfx-init', ms: +(performance.now() - t0).toFixed(1) }); }
        if (sf) {
            const f = sf.render;
            sf.render = function (...a) { const t0 = performance.now(); const r = f.apply(this, a); const d = performance.now() - t0; if (this._active) calls.push(+d.toFixed(1)); return r; };
        } else post({ tag: 'no-screenfx', disabled: g.screenFxDisabled });
    }
    const sizes = ['small', 'medium', 'big', 'medium', 'big', 'small', 'big'];
    for (let i = 0; i < sizes.length; i++) {
        // Hold the shield, top up energy, park the ship.
        p._forceShield = true; p.shieldEnergy = p.maxShieldEnergy; p.shieldBroken = false; p.health = p.maxHealth; p.invulnTimer = 0;
        p.vx = 0; p.vy = 0;
        const ast = new astMod.Asteroid(g, p.worldX + 260, p.worldY, sizes[i], -900, 0);
        S.asteroids.push(ast);
        for (const k in sec) delete sec[k];
        worst = 0; frames = [];
        await sleep(1500);
        frames.sort((a, b) => b - a);
        post({ tag: 'crash', i, size: sizes[i], shielded: !!p.shielding, worst: +worst.toFixed(1), nframes: frames.length, fxCalls: calls.splice(0), top5: frames.slice(0, 5).map(v => +v.toFixed(1)),
            sec: Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, +v.toFixed(1)])) });
        await sleep(800);
    }
    // Same crash WITHOUT shield, for comparison.
    p._forceShield = false;
    for (let i = 0; i < 2; i++) {
        p.health = p.maxHealth; p.invulnTimer = 0;
        S.asteroids.push(new astMod.Asteroid(g, p.worldX + 260, p.worldY, 'big', -900, 0));
        for (const k in sec) delete sec[k];
        worst = 0; frames = [];
        await sleep(1500);
        frames.sort((a, b) => b - a);
        post({ tag: 'crash-noshield', i, worst: +worst.toFixed(1), nframes: frames.length, fxCalls: calls.splice(0), top5: frames.slice(0, 5).map(v => +v.toFixed(1)),
            sec: Object.fromEntries(Object.entries(sec).map(([k, v]) => [k, +v.toFixed(1)])) });
        await sleep(800);
    }
    post({ tag: 'done' });
})();
