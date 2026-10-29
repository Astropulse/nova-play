// StateFX — juice driven by what bosses, world events and special enemies
// are DOING. Each frame it polls their state/attack fields (from outside —
// the entities don't know it exists), detects transitions (awakening,
// telegraph start, attack release, phase change, rage, births, reforms,
// defeats) and fires purpose-built ImpactFX effects; a few states also get
// continuous effects while they last (charge-ups gathering energy, a
// spinning saw throwing sparks, suction spirals).
//
// Per-entity memory lives on `e._sfx`. Cosmetic only: Math.random(), never
// touches gameplay fields. Everything runs through ImpactFX's pools/caps,
// and continuous emitters are rate-based (scaled by ImpactFX._q()).

import { RAMP, LIGHT, SUN_STAR, SUN_LEVEL, SUN_GOLD, SUN_BONE, SUN_ABYSS, SUN_SPORE } from './impactFx.js';

const TAU = Math.PI * 2;
const WINDUP = new Set(['windup', 'tele', 'aim', 'rear', 'gather', 'mark', 'signal', 'carve']);
const ACTIVE = new Set(['dash', 'fall', 'charge', 'storm', 'sweep', 'run', 'fire', 'spin', 'cast']);

// Event classes that are bosses → their codex / achievement id.
const SIGHT_IDS = { Seraph: 'Seraph', Wheels: 'Wheels', Hive: 'Swarm', Carcosa: 'Carcosa', YellowOne: 'YellowOne', Dragon: 'Dragon' };

// Hoisted particle option objects (ImpactFX.puff/streaks only read them,
// synchronously; the two with a per-call `dir` are set right before use).
const O_DRAG0p8_TOP3 = { drag: 0.8, top: 3 };
const O_DRAG1p2_TOP3 = { drag: 1.2, top: 3 };
const O_DRAG2 = { drag: 2 };
const O_DRAG2_TOP3 = { drag: 2, top: 3 };
const O_DRAG1p5_TOP3 = { drag: 1.5, top: 3 };
const O_DRAG1p2_TOP4 = { drag: 1.2, top: 4 };
const O_DRAG1p6_TOP3 = { drag: 1.6, top: 3 };
const O_DRAG1p5_TOP4 = { drag: 1.5, top: 4 };
const O_DRAG2_TOP2 = { drag: 2, top: 2 };
const O_EMBER_DRIFT = { dir: 0, spread: 1, speedMin: 30, speedMax: 120, lifeMin: 0.3, lifeMax: 0.6, drag: 2, len: 0.016 };
const O_EMBER_JET = { dir: 0, spread: 0.2, speedMin: 200, speedMax: 380, lifeMin: 0.2, lifeMax: 0.4, drag: 2, len: 0.03 };

// Event class name → memoised per constructor (no per-frame
// constructor.name reads / startsWith in the dispatch loop).
const _evKind = new WeakMap();
function evKind(e) {
    const k = e.constructor;
    if (!k) return EV_NONE;
    let v = _evKind.get(k);
    if (!v) {
        const n = k.name;
        v = { n, sight: SIGHT_IDS[n], head: !!(n && n.startsWith('Head')) };
        _evKind.set(k, v);
    }
    return v;
}
const EV_NONE = { n: undefined, sight: undefined, head: false };

function mem(e) { return e._sfx || (e._sfx = { acc: 0, acc2: 0, t: 0 }); }

export class StateFX {
    constructor(game, state) {
        this.game = game;
        this.state = state;
    }

    get fx() { return this.state.impactFx; }

    // Accumulate a rate (per second) and return whole emissions due now.
    _due(m, key, rate, dt) {
        m[key] = (m[key] || 0) + rate * dt * this.fx._q();
        const n = Math.floor(m[key]);
        m[key] -= n;
        return Math.min(n, 6);
    }

    // left: seconds until the attack fires; total: telegraph window.
    _telegraph(m, key, x, y, ramp, left, total, dt, R) {
        if (!(left > 0) || left > total) { m[key + 'f'] = 0; return; }
        const u = 1 - left / total;
        const n = this._due(m, key, 18 + 50 * u, dt);
        if (n) this.fx.inward(x, y, ramp, n, Math.max(24, R * (1.8 - u)), 0.18);
        if (left < 0.09 && !m[key + 'f']) {
            m[key + 'f'] = 1;
            this.fx.star(x, y, 6, 0.12, RAMP.white, 1);
            this.fx.light(x, y, 40, 0.6, 0.12, LIGHT.red);
        }
    }

    // First sighting of a boss → the codex marks it SIGHTED.
    _sight(e, id) {
        const m = mem(e);
        if (m.seen || !this._near(e, 900)) return;
        m.seen = 1;
        if (this.game.achievements) this.game.achievements.notify('boss_encountered', { bossId: id });
    }

    _near(e, R = 1700) {
        const p = this.state.player;
        if (!p) return true;
        const dx = p.worldX - e.worldX, dy = p.worldY - e.worldY;
        return dx * dx + dy * dy < R * R;
    }

    tick(dt) {
        const s = this.state;
        for (let i = 0; i < s.events.length; i++) {
            const e = s.events[i];
            const kind = evKind(e), n = kind.n;
            if (kind.sight) this._sight(e, kind.sight);
            switch (n) {
                case 'Seraph': this._seraph(e, dt); break;
                case 'Wheels': this._wheels(e, dt); break;
                case 'Hive': this._hive(e, dt); break;
                case 'CthulhuEvent': this._cthulhu(e, dt); break;
                case 'Carcosa': this._carcosa(e, dt); break;
                case 'YellowOne': this._yellow(e, dt); break;
                case 'KnowledgeEvent': this._knowledge(e, dt); break;
                case 'CargoShipEvent': this._cargo(e, dt); break;
                case 'FracturedStationEvent': this._station(e, dt); break;
                case 'GravenIdol': this._idol(e, dt); break;
                case 'Dragon': this._dragon(e, dt); break;
                default:
                    if (kind.head) this._head(e, dt);
            }
        }
        for (let i = 0; i < s.enemies.length; i++) this._enemy(s.enemies[i], dt);
        // Railgun charge-up: energy pulls into the nose while it targets.
        for (const lp of s.localPlayers) {
            const p = lp.player;
            if (!p || !p.isRailgunTargeting) continue;
            const m = mem(p), a = p.angle || 0;
            this.fx.inward(p.worldX + Math.cos(a) * 22, p.worldY + Math.sin(a) * 22, RAMP.electric, this._due(m, 'rg', 45, dt), 60, 0.2);
        }
        for (let i = 0; i < s.caches.length; i++) this._cache(s.caches[i], dt);
        if (s.bossWrecks) for (let i = 0; i < s.bossWrecks.length; i++) this._wreck(s.bossWrecks[i], dt);
    }

    // A fallen boss's wreck smoulders for the rest of the run: smoke, the odd
    // spark, a flickering ember glow — the battlefield remembers.
    _wreck(w, dt) {
        if (!this._near(w, 1600)) return;
        const fx = this.fx, m = mem(w);
        const R = Math.min(w.radius || 90, 140);
        for (let k = this._due(m, 'sm', 3, dt); k > 0; k--) {
            const a = Math.random() * TAU, d = Math.random() * R * 0.6;
            fx.puff(w.worldX + Math.cos(a) * d, w.worldY + Math.sin(a) * d, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16,
                2, 5 + Math.random() * 3, 8, 1.8, RAMP.smoke, O_DRAG0p8_TOP3);
        }
        if (this._due(m, 'sp', 0.8, dt)) {
            const a = Math.random() * TAU, d = Math.random() * R * 0.5;
            fx.burst(w.worldX + Math.cos(a) * d, w.worldY + Math.sin(a) * d, RAMP.spark, 4, 80, 220, null, TAU, 0.3);
        }
        if (this._due(m, 'li', 4, dt)) fx.light(w.worldX, w.worldY, R * 1.4, 0.18, 0.3, LIGHT.ember, 1);
    }

    // ── Seraph ──────────────────────────────────────────────────────────────
    _seraph(e, dt) {
        const fx = this.fx, m = mem(e);
        // The pupil sits ~44px above centre in the art (the entity's own
        // EYE_OFF_Y of -56 reads a little high, so effects use the art).
        const x = e.worldX, y = e.worldY, eyeY = y - 44;
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 'fight') fx.awaken(x, y, 110, RAMP.fire, LIGHT.fire, SUN_STAR);
            if (st === 'dying') { fx.storm(x, y, 40, 220, 8, RAMP.fire, 0.4); fx.burst(x, y, RAMP.fire, 30, 200, 600, null, TAU, 0.7); }
        }
        if (!this._near(e)) return;
        if (st !== 'fight' && st !== 'dying' && this._due(m, 'hg', 3, dt)) {
            // Waiting: glints run round a halo above it.
            const a0 = Math.random() * TAU;
            fx.star(x + Math.cos(a0) * 46, eyeY - 30 + Math.sin(a0) * 12, 3, 0.4, RAMP.gold, 0);
        }
        const a = e.attack;
        const key = a ? a.type + ':' + a.phase : '';
        const pk = m.a; m.a = key;
        if (a && key !== pk) {
            if (a.type === 'a1' && a.phase === 'dash') {
                const back = Math.atan2(-(e.vy || 0), -(e.vx || 0));
                fx.hitSpark(x, y, RAMP.fire);
                fx.burst(x, y, RAMP.fire, 22, 250, 700, back, 1.0, 0.45);
                fx.light(x, y, 160, 0.8, 0.3, LIGHT.fire);
                if (fx.synth) fx.synth.thump(1.2, x, y, 0.5);
            }
            if (a.type === 'a3' && a.phase === 'fire') {
                fx.beamFlash(x, eyeY, a.angle || 0, 2600, RAMP.fire, LIGHT.fire);
                if (fx.synth) fx.synth.thump(1.4, x, y, 0.5);
            }
        }
        // Continuous telegraphs.
        if (a && a.type === 'a1' && a.phase === 'windup') {
            const hx = x + 58 * (e.facing || 1), hy = y + 30;
            fx.inward(hx, hy, RAMP.fire, this._due(m, 'g1', 45, dt), 60);
            if (this._due(m, 'l1', 10, dt)) fx.light(hx, hy, 50, 0.5, 0.12, LIGHT.fire, 1);
        }
        if (a && a.type === 'a2' && a.phase === 'signal' && a.nova) fx.inward(x, y, RAMP.gold, this._due(m, 'g2', 60, dt), 160, 0.3);
        if (a && a.type === 'a3' && a.phase === 'aim') {
            fx.inward(x, eyeY, RAMP.fire, this._due(m, 'g3', 70, dt), 70);
            if (this._due(m, 'l3', 12, dt)) fx.light(x, eyeY, 70, 0.6, 0.1, LIGHT.fire, 1);
        }
        // Nova / fling release.
        const fl = !!(a && a.flung), pfl = m.fl; m.fl = fl;
        if (fl && !pfl) {
            if (a.nova) { fx.ring(x, y, 30, 260, 0.5, 3, RAMP.fire); fx.star(x, y, 18, 0.3, RAMP.gold, 1); fx.burst(x, y, RAMP.gold, 24, 200, 600); }
            else { fx.storm(x, y, 40, 260, 6, RAMP.gold, 0.3); fx.star(x, y, 14, 0.3, RAMP.gold, 1); }
            if (fx.synth) fx.synth.thump(1.3, x, y, 0.5);
        }
        // The eye opens / closes.
        const form = e.form, pf = m.form; m.form = form;
        if (pf && form !== pf) {
            if (form === 'opened') { fx.sunburst(x, eyeY, SUN_GOLD, 0.9, 0.9); fx.light(x, eyeY, 90, 0.8, 0.5, LIGHT.gold); }
            else for (let k = 0; k < 6; k++) fx.puff(x + (Math.random() - 0.5) * 40, eyeY + (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 30, -20, 2, 5, 7, 1.0, RAMP.smoke, O_DRAG1p2_TOP3);
        }
        // Rage ignites / burns.
        const rg = !!e.raged, prg = m.rg; m.rg = rg;
        if (rg && !prg) {
            fx.storm(x, y, 50, 260, 8, RAMP.blood, 0.35);
            fx.ring(x, y, 40, 300, 0.6, 4, RAMP.blood);
            fx.light(x, y, 300, 1, 0.6, LIGHT.red);
            if (fx.synth) fx.synth.thump(2, x, y, 0.7);
        }
        if (rg) {
            for (let k = this._due(m, 'rg', 12, dt); k > 0; k--) {
                const ang = Math.random() * TAU, d = Math.random() * 70;
                fx.puff(x + Math.cos(ang) * d, y + Math.sin(ang) * d, Math.cos(ang) * 30, Math.sin(ang) * 30 - 20, 1.5, 3.5, 0.6, 0.35, RAMP.fire, O_DRAG2);
            }
            if (this._due(m, 'rgl', 7, dt)) fx.light(x, y, 180, 0.4, 0.15, LIGHT.red, 1);
        }
        if (st === 'dying') this._dyingSmoke(e, m, dt, 90, RAMP.fire);
    }

    // ── Wheels ──────────────────────────────────────────────────────────────
    _wheels(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY, R = e.radius || 66;
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st && st === 'fight') {
            fx.awaken(x, y, 90, RAMP.gold, LIGHT.gold, SUN_GOLD);
        }
        if (!this._near(e)) return;
        if (st !== 'fight' && st !== 'dying' && this._due(m, 'tk', 1.2, dt)) {
            // Idle: the mechanism ticks, a spark jumps off the rim.
            const ang = Math.random() * TAU;
            fx.burst(x + Math.cos(ang) * R, y + Math.sin(ang) * R, RAMP.gold, 4, 100, 260, ang + Math.PI / 2, 0.5, 0.25);
        }
        const a = e.attack;
        const key = a ? a.type + ':' + a.phase : '';
        const pk = m.a, pObj = m.obj; m.a = key; m.obj = a;
        if (a && (key !== pk || a !== pObj)) {
            if (a.type === 'charge' && a.phase === 'windup') {
                fx.star(x, y, a !== pObj && pObj && pObj.type === 'charge' ? 14 : 9, 0.25, RAMP.gold, 1);
                fx.light(x, y, 120, 0.6, 0.25, LIGHT.gold);
            }
            if (a.type === 'charge' && a.phase === 'dash') {
                const back = Math.atan2(-(e.vy || 0), -(e.vx || 0));
                fx.hitSpark(x, y, RAMP.gold);
                fx.burst(x, y, RAMP.gold, 24, 300, 800, back, 1.1, 0.4);
                if (fx.synth) fx.synth.thump(1.1, x, y, 0.45);
            }
            if (a.type === 'spin' && a.phase === 'spin') {
                fx.ring(x, y, R * 0.5, R * 3.4, 0.5, 3, RAMP.gold);
                fx.burst(x, y, RAMP.fire, 24, 200, 600);
                if (fx.synth) fx.synth.chime(0.15);
            }
        }
        if (a && a.type === 'charge' && a.phase === 'windup') fx.inward(x, y, RAMP.gold, this._due(m, 'g1', 40, dt), 110);
        if (a && a.type === 'spin' && a.phase === 'gather') fx.inward(x, y, RAMP.gold, this._due(m, 'g2', 90, dt), 140, 0.3);
        if (a && a.type === 'spin' && a.phase === 'spin') {
            // Buzz-saw: sparks shear off the rim tangentially.
            for (let k = this._due(m, 'sp', 55, dt); k > 0; k--) {
                const ang = Math.random() * TAU;
                fx.streaks(x + Math.cos(ang) * R, y + Math.sin(ang) * R, 1, Math.random() < 0.4 ? RAMP.fire : RAMP.gold, {
                    dir: ang + Math.PI / 2 * Math.sign(e._rotVel || 1), spread: 0.4, speedMin: 250, speedMax: 520, lifeMin: 0.15, lifeMax: 0.35, drag: 3, len: 0.03
                });
            }
            if (this._due(m, 'sl', 10, dt)) fx.light(x, y, 150, 0.5, 0.12, LIGHT.gold, 1);
        }
        if (st === 'dying') {
            // Runaway spin flinging ever more sparks.
            m.t += dt;
            for (let k = this._due(m, 'dy', 30 + m.t * 60, dt); k > 0; k--) {
                const ang = Math.random() * TAU;
                fx.streaks(x + Math.cos(ang) * R * 0.8, y + Math.sin(ang) * R * 0.8, 1, RAMP.gold, {
                    dir: ang + 1.2, spread: 0.5, speedMin: 300, speedMax: 800, lifeMin: 0.2, lifeMax: 0.5, drag: 2, len: 0.035
                });
            }
        }
    }

    // ── Hive (+ famine) ─────────────────────────────────────────────────────
    _hive(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY, R = Math.max(e.radius || 112, 60);
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 'fight') fx.awaken(x, y, 110, RAMP.spore, LIGHT.heal, SUN_SPORE);
            if (st === 'finished') { fx.sunburst(x, y, SUN_GOLD, 1.6, 1.4); if (fx.synth) fx.synth.chime(0.2); }
        }
        // Famine: sickly spores fall around a starving pilot.
        if (e._famine && e._famine.size) {
            for (const [body, secs] of e._famine) {
                if (!(secs > 0) || !body) continue;
                const bm = mem(body);
                for (let k = this._due(bm, 'fam', 10 + secs * 4, dt); k > 0; k--) {
                    const ang = Math.random() * TAU, d = 20 + Math.random() * 50;
                    fx.star(body.worldX + Math.cos(ang) * d, body.worldY + Math.sin(ang) * d, 1, 0.9, RAMP.spore, 0, (Math.random() - 0.5) * 10, 25, 0);
                }
            }
        }
        if (!this._near(e, 2400)) return;
        // Birth contraction: brood energy streams in.
        if (e._birthTelegraph > 0) fx.inward(x, y, RAMP.spore, this._due(m, 'bt', 70, dt), 190, 0.3);
        // New locusts: a wet spore burst where each emerges.
        const ln = e.locusts ? e.locusts.length : 0;
        if (m.ln !== undefined && ln > m.ln) {
            for (let k = m.ln; k < ln; k++) {
                const l = e.locusts[k];
                if (!l) continue;
                fx.hitSpark(l.worldX, l.worldY, RAMP.abyss);
                fx.burst(l.worldX, l.worldY, RAMP.spore, 10, 80, 260);
                fx.puff(l.worldX, l.worldY, 0, 0, 2, 5, 7, 0.8, RAMP.spore, O_DRAG2_TOP3);
            }
        }
        m.ln = ln;
        if (st === 'dying') this._dyingSmoke(e, m, dt, R, RAMP.spore, RAMP.spore);
    }

    // ── Cthulhu (event) ─────────────────────────────────────────────────────
    _cthulhu(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY, R = Math.min(e.radius || 128, 170);
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 1) { fx.awaken(x, y, R, RAMP.abyss, LIGHT.electric, SUN_ABYSS); fx.inward(x, y, RAMP.abyss, 40, R * 3, 0.5); }
            if (st === 3) fx.inward(x, y, RAMP.abyss, 50, R * 2.5, 0.6);
            if (st === 4) { fx.star(x, y, 18, 0.4, RAMP.abyss, 1); fx.ring(x, y, R * 0.5, R * 2, 0.6, 3, RAMP.abyss); }
        }
        const w = e.wave || 0;
        if (m.w !== undefined && w > m.w) {
            fx.ring(x, y, R * 0.4, R * 3, 0.8, 3, RAMP.abyss);
            fx.storm(x, y, R * 0.6, R * 2.4, 8, RAMP.abyss, 0.35);
            if (fx.synth) fx.synth.thump(1.8, x, y, 0.6);
        }
        m.w = w;
        if (st === 1 && this._near(e)) fx.inward(x, y, RAMP.abyss, this._due(m, 'wk', 40, dt), R * 2.2, 0.5);
        if (st === 0 && this._near(e, 2200)) {
            // Something sleeps here: bubbles of the abyss rise and pop.
            for (let k = this._due(m, 'bb', 4, dt); k > 0; k--) {
                const a = Math.random() * TAU, d = Math.random() * R;
                fx.star(x + Math.cos(a) * d, y + Math.sin(a) * d, 2, 1.6 + Math.random(), RAMP.abyss, 0, (Math.random() - 0.5) * 8, -18 - Math.random() * 20, 0);
            }
        }
    }

    // ── Carcosa ─────────────────────────────────────────────────────────────
    _carcosa(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY;
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 'fight') {
                fx.awaken(x, y, 140, RAMP.white, LIGHT.white, SUN_BONE);
                for (let k = 0; k < 16; k++) {
                    const a = Math.random() * TAU, d = Math.random() * 160;
                    fx.puff(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 60, Math.sin(a) * 60, 4, 8, 11, 1.6, RAMP.dust, { drag: 1, top: 4, delay: Math.random() * 0.3 });
                }
            }
            if (st === 'rebuilt') { fx.sunburst(x, y, SUN_GOLD, 2.2, 1.6); fx.ring(x, y, 40, 420, 0.9, 4, RAMP.gold); if (fx.synth) fx.synth.chime(0.25); }
        }
        // Dormant: husks in the belt twitch as you pass — dust shakes off,
        // a yellow glint where an eye might be.
        if (st === 'carcosa_dormant' && e.husks && e.husks.length) {
            const p = this.state.player;
            if (p && this._due(m, 'tw', 1.4, dt)) {
                for (let tries = 0; tries < 6; tries++) {
                    const h = e.husks[(Math.random() * e.husks.length) | 0];
                    if (!h) continue;
                    const dx = h.x - p.worldX, dy = h.y - p.worldY;
                    if (dx * dx + dy * dy > 1200 * 1200) continue;
                    for (let k = 0; k < 3; k++) fx.puff(h.x + (Math.random() - 0.5) * 30, h.y + (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, 2, 4, 6, 1.0, RAMP.dust, O_DRAG1p5_TOP3);
                    fx.star(h.x, h.y, 3, 0.35, RAMP.level, 0);
                    break;
                }
            }
        }
        // The rebuild pulse leaves a trail of gold motes.
        if (e.pulse) {
            for (let k = this._due(m, 'pl', 40, dt); k > 0; k--) {
                fx.star(e.pulse.x + (Math.random() - 0.5) * 16, e.pulse.y + (Math.random() - 0.5) * 16, 2, 0.7, RAMP.gold, 0);
            }
        }
    }

    // ── Yellow One ──────────────────────────────────────────────────────────
    _yellow(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY;
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 'following') { fx.burst(x, y, RAMP.level, 24, 80, 260, null, TAU, 0.9); fx.light(x, y, 160, 0.6, 0.6, LIGHT.level); }
            if (st === 'phase1') fx.awaken(x, y, 100, RAMP.level, LIGHT.level, SUN_LEVEL);
            if (st === 'phase2') { fx.awaken(x, y, 140, RAMP.level, LIGHT.level, SUN_LEVEL); fx.storm(x, y, 60, 420, 10, RAMP.level, 0.4); }
            if (st === 'enraged') { fx.storm(x, y, 60, 460, 12, RAMP.fire, 0.45); fx.ring(x, y, 40, 400, 0.7, 4, RAMP.fire); fx.light(x, y, 300, 1, 0.7, LIGHT.fire); }
        }
        if (!this._near(e)) return;
        if (e._summonAnimPlaying) fx.inward(x, y, RAMP.level, this._due(m, 'su', 60, dt), 150, 0.35);
        if (e._crushAnimPlaying) fx.inward(x, y, RAMP.fire, this._due(m, 'cr', 60, dt), 120, 0.3);
        const ss = e.summonedShips ? e.summonedShips.length : 0;
        if (m.ss !== undefined && ss > m.ss) {
            for (let k = m.ss; k < ss; k++) {
                const sh = e.summonedShips[k];
                if (sh) fx.warpIn(sh.worldX, sh.worldY, 22, RAMP.level);
            }
        }
        m.ss = ss;
    }

    // ── Knowledge (the lidless eye) ─────────────────────────────────────────
    _knowledge(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY;
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 1) { fx.storm(x, y, 30, 260, 6, RAMP.abyss, 0.3); fx.light(x, y, 200, 0.7, 0.5, LIGHT.electric); }
            if (st === 2) {
                fx.awaken(x, y, 140, RAMP.blood, LIGHT.red, null);
                fx.ring(x, y, 60, 900, 1.0, 5, RAMP.abyss);
            }
            if (st === 3) { fx.sunburst(x, y, SUN_ABYSS, 2, 1.5); fx.inward(x, y, RAMP.abyss, 60, 400, 0.5); }
            if (st === 4 && pst === 1) {
                // It swallowed an offering: a gulp, a flash, a chime.
                fx.inward(x, y, RAMP.abyss, 40, 200, 0.25);
                fx.star(x, y, 18, 0.35, RAMP.white, 1);
                fx.light(x, y, 180, 0.9, 0.5, LIGHT.white);
                if (fx.synth) fx.synth.chime(0.2);
            }
        }
        if (st === 0 && this._near(e, 3500)) {
            // Dormant, but watching: abyssal motes drift off it toward you.
            const p = this.state.player;
            if (p && this._due(m, 'gz', 3, dt)) {
                const dx = p.worldX - x, dy = p.worldY - y, d = Math.sqrt(dx * dx + dy * dy) || 1;
                fx.star(x + (Math.random() - 0.5) * 60, y + (Math.random() - 0.5) * 60, 2, 3.5, RAMP.abyss, 0, dx / d * 45, dy / d * 45, 0);
            }
        }
        if (!this._near(e, 2200)) return;
        if (st === 1) {
            // Suction made visible: matter spirals in toward the eye (behind ships).
            for (let k = this._due(m, 'sc', 26, dt); k > 0 && fx.sN < 590; k--) {
                const a = Math.random() * TAU, d = 300 + Math.random() * 300, inw = 160, tang = 140;
                const c = Math.cos(a), s = Math.sin(a), i = fx.sN++;
                fx.sX[i] = x + c * d; fx.sY[i] = y + s * d;
                fx.sVX[i] = -c * inw - s * tang; fx.sVY[i] = -s * inw + c * tang;
                fx.sLife[i] = fx.sMax[i] = (d - 30) / (inw + 50); fx.sDrag[i] = 0; fx.sLen[i] = 0.035;
                fx.sRamp[i] = Math.random() < 0.3 ? RAMP.white : RAMP.abyss; fx.sUnder[i] = 1;
            }
        }
        if (st === 2 && e.isTargeting) fx.inward(x, y, RAMP.blood, this._due(m, 'tg', 60, dt), 90);
        const nb = e.activeBeams ? e.activeBeams.length : 0;
        if (m.nb !== undefined && nb > m.nb) {
            const b = e.activeBeams[nb - 1];
            fx.beamFlash(b.x != null ? b.x : x, b.y != null ? b.y : y, b.angle || 0, 1600, RAMP.blood, LIGHT.red);
        }
        m.nb = nb;
    }

    // ── Cargo ship: hull breach spills scrap ───────────────────────────────
    _cargo(e, dt) {
        const fx = this.fx, m = mem(e);
        const open = !!e.spawnedInitialScrap, po = m.op; m.op = open;
        if (this._near(e, 1800)) {
            if (!open) {
                // Distress: a red beacon blinks on the derelict, its hull sparks.
                m.bt = (m.bt || 0) - dt;
                if (m.bt <= 0) {
                    m.bt = 1.1;
                    fx.star(e.worldX, e.worldY - 20, 6, 0.3, RAMP.hull, 1);
                    fx.light(e.worldX, e.worldY - 20, 90, 0.6, 0.35, LIGHT.red);
                    if (m.bc = (m.bc || 0) + 1, m.bc % 3 === 0 && fx.synth) fx.synth.zap(e.worldX, e.worldY, 0.05);
                }
                if (this._due(m, 'hs', 0.7, dt)) {
                    const a = Math.random() * TAU, d = Math.random() * (e.radius || 80) * 0.6;
                    fx.burst(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, RAMP.spark, 5, 80, 240, null, TAU, 0.3);
                }
            } else if ((m.vent = (m.vent || 0) + dt) < 4) {
                // Venting atmosphere after the breach.
                for (let k = this._due(m, 'vn', 10 * (1 - m.vent / 4), dt); k > 0; k--) {
                    const a = Math.random() * TAU;
                    fx.puff(e.worldX + Math.cos(a) * 30, e.worldY + Math.sin(a) * 30, Math.cos(a) * 80, Math.sin(a) * 80, 2, 5, 8, 1.2, RAMP.dust, O_DRAG1p2_TOP4);
                }
            }
        }
        if (open && po === false) {
            const x = e.worldX, y = e.worldY;
            fx.hitSpark(x, y, RAMP.white);
            fx.ring(x, y, 20, 220, 0.5, 3, RAMP.dust);
            fx.burst(x, y, RAMP.spark, 30, 200, 600);
            for (let k = 0; k < 12; k++) {
                const a = Math.random() * TAU, d = Math.random() * 60;
                fx.puff(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 70, Math.sin(a) * 70, 3, 6, 8, 1.2, RAMP.dust, O_DRAG1p5_TOP3);
            }
            for (let k = 0; k < 14; k++) {
                const a = Math.random() * TAU, sp = 100 + Math.random() * 200;
                fx.star(x, y, 3, 0.8, RAMP.gold, 0, Math.cos(a) * sp, Math.sin(a) * sp, 0);
            }
            fx.light(x, y, 200, 0.8, 0.4, LIGHT.gold);
            if (fx.synth) { fx.synth.thump(1.2, x, y, 0.5); fx.synth.chime(0.16); }
        }
        if (m.op === undefined) m.op = open;
    }

    // ── Fractured station: signals, waves, completion ──────────────────────
    _station(e, dt) {
        const fx = this.fx, m = mem(e);
        const st = e.state, pst = m.st; m.st = st;
        const x = e.worldX, y = e.worldY;
        if (pst !== undefined && pst !== st) {
            if (st === 1 || st === 4) {
                // Red alert as the ambush wave launches.
                fx.ring(x, y, 20, 320, 0.6, 3, RAMP.blood);
                fx.storm(x, y, 30, 200, 6, RAMP.blood, 0.3);
                fx.light(x, y, 220, 0.8, 0.5, LIGHT.red, 1);
                if (fx.synth) fx.synth.zap(x, y, 0.3);
            }
            if (st === 2 || st === 5) {
                // The next station lights up.
                fx.warpIn(x, y, 40, RAMP.electric);
                fx.star(x, y, 14, 0.4, RAMP.electric, 1);
            }
            if (st === 8) { fx.sunburst(x, y, SUN_GOLD, 1.8, 1.5); fx.ring(x, y, 20, 300, 0.8, 3, RAMP.gold); if (fx.synth) fx.synth.chime(0.22); }
        }
        // Derelict electrics short out across the revealed stations.
        if (e.positions && this._near(e, 1600)) {
            const ns = st >= 5 ? 3 : st >= 2 ? 2 : 1;
            if (this._due(m, 'sh', 1.6 * ns, dt)) {
                const p = e.positions[(Math.random() * ns) | 0];
                if (p) {
                    const ox = (Math.random() - 0.5) * 120, oy = (Math.random() - 0.5) * 120;
                    fx.burst(p.x + ox, p.y + oy, RAMP.electric, 6, 80, 260, null, TAU, 0.3);
                    fx.light(p.x + ox, p.y + oy, 50, 0.5, 0.12, LIGHT.electric, 1);
                    if (Math.random() < 0.3) {
                        const b = fx.bolt(p.x + ox, p.y + oy, p.x + ox + (Math.random() - 0.5) * 80, p.y + oy + (Math.random() - 0.5) * 80, 0.16, null, 0.4);
                        if (b) b.ramp = RAMP.electric;
                    }
                }
            }
        }
        // Waiting stations pulse a beacon so you know where to fly.
        if ((st === 0 || st === 3 || st === 6) && this._near(e, 1400)) fx.beacon(e, RAMP.electric, 1.1, dt);
    }

    // ── Dragon controller (arrival cinematic + victory) ────────────────────
    _dragon(e, dt) {
        const fx = this.fx, m = mem(e);
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st && st === 'dragon_victory' && e.heads) {
            for (const h of e.heads) fx.sunburst(h.worldX, h.worldY, SUN_GOLD, 1.4, 1.6);
            if (fx.synth) fx.synth.chime(0.3);
        }
        const cin = e.cin;
        if (!cin) return;
        const ar = cin.arrivals || 0;
        if (m.ar !== undefined && ar > m.ar && e.heads) {
            const h = e.heads[ar - 1];
            if (h) { fx.burst(h.worldX, h.worldY, fx.themeRamp(h), 30, 200, 600); fx.light(h.worldX, h.worldY, 240, 0.9, 0.5, LIGHT.fire); if (fx.synth) fx.synth.thump(1.8, h.worldX, h.worldY, 0.6); }
        }
        m.ar = ar;
        const pu = !!cin.pulsed, ppu = m.pu; m.pu = pu;
        if (pu && ppu === false) fx.ring(e.siteX || e.worldX, e.siteY || e.worldY, 50, 1100, 1.2, 5, RAMP.blood);
        const ig = !!cin.ignited, pig = m.ig; m.ig = ig;
        if (ig && pig === false && e.heads) for (const h of e.heads) fx.ring(h.worldX, h.worldY, 20, 260, 0.7, 3, RAMP.fire);
    }

    // ── Dragon heads: every windup, strike, beam, stagger, reform ──────────
    _head(e, dt) {
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY, R = Math.min(e.radius || 105, 140);
        const ramp = fx.themeRamp(e);
        const st = e.state, pst = m.st; m.st = st;
        if (pst !== undefined && pst !== st) {
            if (st === 'dying') { fx.storm(x, y, 40, 260, 8, ramp, 0.4); fx.burst(x, y, ramp, 30, 200, 600); }
            if (st === 'fight' && pst === 'shattered') {
                // Reform: the shards' power rushes back in.
                fx.inward(x, y, ramp, 60, 320, 0.5);
                fx.ring(x, y, R * 2.6, R * 0.3, 0.6, 3, ramp);
                fx.light(x, y, 260, 0.9, 0.6, LIGHT.red);
                if (fx.synth) fx.synth.thump(1.8, x, y, 0.6);
            }
        }
        if (st !== 'fight' || !this._near(e, 2200)) return;
        const a = e.attack;
        const key = a ? a.type + ':' + a.phase : '';
        const pk = m.a; m.a = key;
        if (a && key !== pk) {
            if (WINDUP.has(a.phase)) {
                fx.star(x, y, 12, 0.3, ramp, 1);
                fx.light(x, y, 160, 0.6, 0.3, LIGHT.red);
            } else if (ACTIVE.has(a.phase)) {
                const back = Math.atan2(-(e.vy || 0), -(e.vx || 0));
                fx.hitSpark(x, y, ramp);
                fx.burst(x, y, ramp, 20, 250, 700, (e.vx || e.vy) ? back : null, 1.2, 0.4);
                fx.light(x, y, 180, 0.7, 0.25, LIGHT.red);
                if (fx.synth) fx.synth.thump(1, x, y, 0.4);
            }
        }
        if (a && WINDUP.has(a.phase)) fx.inward(x, y, ramp, this._due(m, 'w', 35, dt), R * 1.1);
        // Beam charge gathers at the nose; beam fire flashes down its line.
        if (e.isChargingBeam) {
            const ang = e.angle || 0, nx = x + Math.cos(ang) * R * 0.8, ny = y + Math.sin(ang) * R * 0.8;
            fx.inward(nx, ny, ramp, this._due(m, 'b', 60, dt), 80);
            if (this._due(m, 'bl', 10, dt)) fx.light(nx, ny, 80, 0.6, 0.12, LIGHT.red, 1);
        }
        const nb = e.activeBeams ? e.activeBeams.length : 0;
        if (m.nb !== undefined && nb > m.nb) {
            const b = e.activeBeams[nb - 1];
            fx.beamFlash(b.x != null ? b.x : x, b.y != null ? b.y : y, b.angle != null ? b.angle : (e.angle || 0), 1800, ramp, LIGHT.red);
        }
        m.nb = nb;
        // A new signature move announces itself.
        const lm = e._lastMove, plm = m.lm; m.lm = lm;
        if (plm !== undefined && lm !== plm && lm) { fx.star(x, y, 14, 0.3, ramp, 1); fx.burst(x, y, ramp, 10, 100, 300); }
        // Staggered: dizzy stars circle the head.
        const stun = (e.stunTimer || 0) > 0, ps = m.stun; m.stun = stun;
        if (stun && !ps) {
            for (let k = 0; k < 6; k++) {
                const ang = (k / 6) * TAU;
                fx.star(x + Math.cos(ang) * R * 0.7, y + Math.sin(ang) * R * 0.7, 3, 0.9, RAMP.level, 0, -Math.sin(ang) * 120, Math.cos(ang) * 120, 0);
            }
        }
    }

    _idol(e, dt) {
        const fx = this.fx, m = mem(e);
        if (!m.seen) {
            m.seen = true;
            fx.warpIn(e.worldX, e.worldY, 30, RAMP.gold);
            fx.light(e.worldX, e.worldY, 120, 0.7, 0.5, LIGHT.gold);
        }
        const al = e.alive !== false, pal = m.al; m.al = al;
        if (!al && pal && e.health <= 0) {
            fx.hitSpark(e.worldX, e.worldY, RAMP.gold);
            fx.burst(e.worldX, e.worldY, RAMP.gold, 26, 200, 600);
            fx.ring(e.worldX, e.worldY, 10, 160, 0.45, 2, RAMP.gold);
            if (fx.synth) fx.synth.chime(0.14);
        }
    }

    _cache(c, dt) {
        const fx = this.fx, m = mem(c);
        const st = c.state, pst = m.st; m.st = st;
        // Supply drop burning in on re-entry, then slamming down.
        if (st === 'incoming' && this._near(c, 2200)) {
            for (let k = this._due(m, 're', 30, dt); k > 0; k--) {
                fx.puff(c.worldX + (Math.random() - 0.5) * 14, c.worldY + (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30,
                    1.5, 3 + Math.random() * 2, 0.6, 0.3, RAMP.fire, O_DRAG2);
                if (Math.random() < 0.4) fx.puff(c.worldX, c.worldY, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 2, 4, 6, 1, RAMP.smoke, O_DRAG1p5_TOP3);
            }
            if (this._due(m, 'rl', 8, dt)) fx.light(c.worldX, c.worldY, 70, 0.5, 0.15, LIGHT.fire, 1);
        }
        if (pst === 'incoming' && st !== 'incoming') {
            fx.hitSpark(c.worldX, c.worldY, RAMP.white);
            fx.ring(c.worldX, c.worldY, 10, 150, 0.5, 3, RAMP.dust);
            fx.burst(c.worldX, c.worldY, RAMP.spark, 20, 150, 420);
            for (let k = 0; k < 10; k++) {
                const a = Math.random() * TAU;
                fx.puff(c.worldX + Math.cos(a) * 20, c.worldY + Math.sin(a) * 20, Math.cos(a) * 90, Math.sin(a) * 90, 3, 6, 9, 1.2, RAMP.dust, O_DRAG1p6_TOP3);
            }
            if (fx.synth) fx.synth.thump(1, c.worldX, c.worldY, 0.45);
        }
        if (pst !== undefined && pst !== st && st === 'opening') {
            fx.sunburst(c.worldX, c.worldY, SUN_GOLD, 1, 1.1);
            fx.burst(c.worldX, c.worldY, RAMP.gold, 20, 150, 450);
            fx.light(c.worldX, c.worldY, 140, 0.8, 0.6, LIGHT.gold);
        }
    }

    // ── Special enemies + ram cycle + beam upgrade ─────────────────────────
    _enemy(e, dt) {
        if (!e.alive) return;
        const n = evKind(e).n;
        const fx = this.fx, m = mem(e);
        const x = e.worldX, y = e.worldY, R = e.radius || 18;
        if (!this._near(e, 1400)) { m.st = e.state; return; }
        if (e.isBoss) this._sight(e, e.bossId || n);

        // Ram cycle (kamikaze, cthulhu minions, drones, kamikaze upgrade).
        const st = e.state, pst = m.st; m.st = st;
        const rr = n === 'CthulhuEnemy' ? RAMP.abyss : RAMP.hull;
        if (pst !== st) {
            if (st === 'windup') { fx.star(x, y, 6, 0.2, rr, 1); fx.light(x, y, 60, 0.5, 0.3, LIGHT.red); }
            if (st === 'ram') {
                const ang = e.angle || 0;
                fx.burst(x, y, rr, 10, 200, 500, ang + Math.PI, 0.9, 0.3);
                fx.hitSpark(x, y, rr);
                if (fx.synth) fx.synth.thump(0.5, x, y, 0.3);
            }
        }
        if (st === 'windup') fx.inward(x, y, rr, this._due(m, 'wu', 30, dt), R * 2.6);

        // Beam upgrade: charge gathers at the nose, release flashes the line.
        if (e.isTargeting) {
            const ang = e.angle || 0;
            fx.inward(x + Math.cos(ang) * R, y + Math.sin(ang) * R, RAMP.hull, this._due(m, 'bt', 30, dt), 50);
        }
        const nb = e.activeBeams ? e.activeBeams.length : 0;
        if (m.nb !== undefined && nb > m.nb) fx.beamFlash(x, y, e.angle || 0, 1600, RAMP.hull, LIGHT.red);
        m.nb = nb;

        // ── Danger telegraphs: one grammar for every enemy attack ──
        // GATHER (motes pull into the weapon, faster as it nears) → FLASH (a
        // hard star the instant before) → RELEASE (the shot's own muzzle fx).
        if (!e.isBoss) {
            const ang = e.angle || 0;
            // Opening shot of an attack run (not every shot of the burst).
            if (st === 'attack' && pst !== 'attack') m.op = 1;
            if (st !== 'attack' || (m.sht !== undefined && e.shootTimer > m.sht + 0.05)) m.op = 0;
            m.sht = e.shootTimer;
            if (m.op && e.upgradeType !== 'beam' && e.shootTimer != null)
                this._telegraph(m, 'tg', x + Math.cos(ang) * R, y + Math.sin(ang) * R, RAMP.hull, e.shootTimer, 0.35, dt, R);
            if (n === 'MissileEnemy' && e.missileTimer != null) {
                for (const side of [1, -1]) {
                    const px = x - 8 * Math.cos(ang) - 50 * side * Math.sin(ang), py = y - 8 * Math.sin(ang) + 50 * side * Math.cos(ang);
                    this._telegraph(m, side > 0 ? 'tm1' : 'tm2', px, py, RAMP.fire, e.missileTimer, 0.6, dt, 20);
                }
            }
            if (n === 'BerserkEnemy' && e.enraged && e.blossomTimer > 0)
                this._telegraph(m, 'tb', x, y, RAMP.blood || RAMP.hull, e.blossomTimer, 0.8, dt, R * 1.4);
        }

        switch (n) {
            case 'NaniteDrone': {
                const dm = !!e.dormant, pd = m.dm; m.dm = dm;
                if (pd && !dm) { fx.star(x, y, 5, 0.18, RAMP.electric, 1); fx.burst(x, y, RAMP.electric, 6, 100, 260); if (fx.synth) fx.synth.zap(x, y, 0.06); }
                break;
            }
            case 'ShieldEnemy': {
                const br = !!e.shieldBroken, pb = m.br; m.br = br;
                if (pb && !br) {
                    // Shield re-forms: arcs race round the bubble, then a flash.
                    const a0 = e.angle || 0, Rr = R * 1.6;
                    fx.arcBolt(0, 0, Rr, a0 - 1.3, a0 + 1.3, 0.3, e);
                    fx.star(x + Math.cos(a0) * Rr, y + Math.sin(a0) * Rr, 8, 0.25, RAMP.electric, 1);
                    fx.light(x, y, 80, 0.6, 0.3, LIGHT.electric);
                    if (fx.synth) fx.synth.zap(x, y, 0.15);
                }
                break;
            }
            case 'BlinkEnemy': {
                const tg = !!e.telegraphing, pt = m.tg;
                if (tg) {
                    fx.inward(x, y, RAMP.abyss, this._due(m, 'bl', 60, dt), R * 3);
                    if (e.blinkDestX != null && this._due(m, 'bd', 14, dt)) fx.star(e.blinkDestX, e.blinkDestY, 4, 0.12, RAMP.abyss, 0);
                    m.ox = x; m.oy = y;
                }
                if (pt && !tg && m.ox != null) {
                    // Departure implodes; arrival bursts.
                    fx.inward(m.ox, m.oy, RAMP.abyss, 14, R * 2, 0.15);
                    fx.hitSpark(x, y, RAMP.abyss);
                    fx.star(x, y, 9, 0.25, RAMP.abyss, 1);
                    fx.burst(x, y, RAMP.abyss, 14, 150, 420);
                    fx.light(x, y, 90, 0.7, 0.3, LIGHT.electric);
                }
                m.tg = tg;
                break;
            }
            case 'BerserkEnemy': {
                const en = !!e.enraged, pe = m.en; m.en = en;
                if (en && !pe) {
                    fx.storm(x, y, R * 0.6, R * 4, 6, RAMP.blood, 0.3);
                    fx.burst(x, y, RAMP.fire, 24, 200, 600);
                    fx.light(x, y, 150, 0.9, 0.4, LIGHT.red);
                    if (fx.synth) fx.synth.thump(1, x, y, 0.4);
                }
                if (en) {
                    for (let k = this._due(m, 'em', 14, dt); k > 0; k--) {
                        const a = Math.random() * TAU, d = Math.random() * R * 0.6;
                        { O_EMBER_DRIFT.dir = a; fx.streaks(x + Math.cos(a) * d, y + Math.sin(a) * d, 1, RAMP.fire, O_EMBER_DRIFT); }
                    }
                    if (this._due(m, 'el', 6, dt)) fx.light(x, y, R * 4, 0.4, 0.17, LIGHT.red, 1);
                }
                if (e.blossoming) {
                    // Spiral bloom: two arms of sparks wheel out.
                    m.sp = (m.sp || 0) + dt * 9;
                    for (let k = this._due(m, 'bs', 50, dt); k > 0; k--) {
                        const a = m.sp + (k % 2) * Math.PI;
                        { O_EMBER_JET.dir = a; fx.streaks(x, y, 1, RAMP.fire, O_EMBER_JET); }
                    }
                }
                break;
            }
            case 'ScavengerEnemy': {
                // Tractor: loot visibly dragged toward the scavenger.
                const t = e.targetItem;
                if (e.scavState === 'collect' && t && t.alive !== false) {
                    const dx = x - t.worldX, dy = y - t.worldY, d = Math.sqrt(dx * dx + dy * dy) || 1;
                    if (d < 260) {
                        for (let k = this._due(m, 'tr', 18, dt); k > 0; k--) {
                            const f = Math.random();
                            fx.star(t.worldX + dx * f * 0.3, t.worldY + dy * f * 0.3, 1, 0.3, RAMP.gold, 0, dx / d * 260, dy / d * 260, 0);
                        }
                    }
                }
                const hl = e.heldLoot ? e.heldLoot.length : 0;
                if (m.hl !== undefined && hl > m.hl) {
                    fx.star(x, y, 8, 0.25, RAMP.gold, 1);
                    fx.burst(x, y, RAMP.gold, 8, 80, 220);
                    fx.light(x, y, 70, 0.6, 0.3, LIGHT.gold);
                }
                m.hl = hl;
                break;
            }
            case 'SwarmMother': {
                const c = e._charge, ph = c ? c.phase : '', pph = m.ch; m.ch = ph;
                if (ph === 'windup') fx.inward(x, y, RAMP.gold, this._due(m, 'mw', 40, dt), 150);
                if (ph === 'dash' && pph !== 'dash') {
                    fx.hitSpark(x, y, RAMP.spore);
                    fx.burst(x, y, RAMP.spore, 20, 250, 650, (e.angle || 0) + Math.PI, 1.0, 0.4);
                    if (fx.synth) fx.synth.thump(1.2, x, y, 0.5);
                }
                const vo = !!e._volley, pvo = m.vo; m.vo = vo;
                if (vo && !pvo) fx.star(x, y, 12, 0.3, RAMP.gold, 1);
                const en = !!e.enraged, pe = m.en; m.en = en;
                if (en && !pe) { fx.storm(x, y, 40, 280, 8, RAMP.spore, 0.35); fx.light(x, y, 200, 0.8, 0.5, LIGHT.heal); }
                if (e._dying) this._dyingSmoke(e, m, dt, R, RAMP.spore, RAMP.spore);
                break;
            }
            case 'BoneEnemy': {
                const rn = !!e.reanimating, prn = m.rn; m.rn = rn;
                if (prn && !rn) {
                    fx.burst(x, y, RAMP.level, 12, 100, 300);
                    fx.star(x, y, 9, 0.3, RAMP.level, 1);
                    for (let k = 0; k < 5; k++) fx.puff(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 50, 2, 5, 7, 1.0, RAMP.dust, O_DRAG1p5_TOP4);
                }
                const cf = !!e.calcified, pcf = m.cf; m.cf = cf;
                if (cf && pcf === false) for (let k = 0; k < 6; k++) fx.puff(x + (Math.random() - 0.5) * 30, y + (Math.random() - 0.5) * 30, 0, 0, 2, 5, 6, 1.2, RAMP.dust, O_DRAG2_TOP2);
                if (!cf && pcf) { fx.burst(x, y, RAMP.level, 14, 150, 400); fx.hitSpark(x, y, RAMP.level); }
                break;
            }
        }
    }

    // Billowing smoke + fire from a dying boss hull.
    _dyingSmoke(e, m, dt, R, smokeRamp = RAMP.smoke, fireRamp = RAMP.fire) {
        const fx = this.fx;
        for (let k = this._due(m, 'ds', 16, dt); k > 0; k--) {
            const a = Math.random() * TAU, d = Math.random() * R * 0.7;
            const x = e.worldX + Math.cos(a) * d, y = e.worldY + Math.sin(a) * d;
            if (Math.random() < 0.6) fx.puff(x, y, Math.cos(a) * 40, Math.sin(a) * 40, 3, 6 + Math.random() * 3, 9, 1.2, smokeRamp === RAMP.smoke ? RAMP.smoke : smokeRamp, O_DRAG1p2_TOP3);
            else fx.puff(x, y, Math.cos(a) * 60, Math.sin(a) * 60, 2, 4, 0.8, 0.35, fireRamp === RAMP.spore ? RAMP.fire : fireRamp, O_DRAG2);
        }
    }
}
