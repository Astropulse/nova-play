// ImpactFX — the world-space juice layer: physical hits, directional kill
// blasts, burning/arcing damaged ships, shield deflections with lightning
// crawling over the bubble, level-up sunbursts and dynamic light.
//
// Built on the pixel-VFX rules from Retro Diffusion's Spark forge:
//   • Indexed colour. Every pixel is a step on a short dark→bright ramp;
//     things cool/fade by stepping DOWN the ramp, never by alpha blending.
//   • Energy front-loaded: peak in the first ~15% of life, long decay.
//   • Purpose-built shapes: hand-designed 3-frame hit sparks (white star →
//     hollow star → fragments), shaded pixel fireball/smoke puffs (body + an
//     upper-left highlight one ramp step brighter), midpoint-displaced
//     lightning with a 1px halo that re-strikes and echoes ("01.a." timing),
//     solid scanline pixel rings (big moments only), hard-banded light.
//   • Native pixel scale: everything lands on the round(worldScale) grid.
//
// Physics: shrapnel splits into a reflected back-spray (off the hull normal)
// and a pass-through spray (along the bullet); kill fireballs, sparks and
// debris inherit the killing shot's momentum; ricochets reflect the shot
// about the shield normal; smoke inherits a fraction of the ship's velocity
// so moving wrecks leave trails; level-up stars arc under gravity.
//
// Strictly cosmetic: Math.random() only, never touches the sim, never
// pauses. Perf: typed-array pools with hard caps, pixel binning (one path
// fill per colour per frame), sprite caches for puffs/hit frames/lights,
// spawn LOD under SETTINGS.reducedParticles / game.lowPerfMode / pool load.

import { SETTINGS } from '../engine/settings.js';
import { RARITY_COLORS } from '../data/upgrades.js';

// ── Palette ramps (dark → bright) ───────────────────────────────────────────
const RAMP_DEFS = {
    spark:    ['#b34a12', '#ff9a2e', '#ffe070', '#fffbe8'],
    fire:     ['#3b1117', '#8c2a1c', '#d6531e', '#f59b2c', '#ffd865', '#fff6d8'],
    electric: ['#2b3a8f', '#4f7cff', '#9fd0ff', '#f5fbff'],
    dust:     ['#3a3530', '#5e574e', '#8a8277', '#b8b0a2', '#e2dccf'],
    gold:     ['#7a4a10', '#c98a1c', '#ffd24a', '#fff3b0'],
    level:    ['#6a5a00', '#c8c020', '#ffff44', '#ffffc8', '#ffffff'],
    hull:     ['#5a1010', '#c0301c', '#ff7a3a', '#ffd0a0', '#fff6e8'],
    white:    ['#5a6a8a', '#a8b8d8', '#e8f0ff', '#ffffff'],
    smoke:    ['#16151b', '#25232b', '#36333d', '#4a4652', '#615c69'],
    heal:     ['#0f3a1a', '#1f8a3a', '#44ff66', '#c8ffd0', '#ffffff'],
    spore:    ['#1e2a0c', '#3e5a16', '#7a9a2a', '#b8d050', '#eaffa0'],
    abyss:    ['#120a1e', '#2e1a4a', '#5a3a8a', '#8a6ac8', '#d0c0ff'],
    blood:    ['#2a0606', '#5a0c0c', '#a01818', '#e04030', '#ffb0a0'],
};
const PALETTE = [];
const RAMP_BASE = [];
const RAMP_N = [];
export const RAMP = {};
for (const name in RAMP_DEFS) {
    RAMP[name] = RAMP_BASE.length;
    RAMP_BASE.push(PALETTE.length);
    RAMP_N.push(RAMP_DEFS[name].length);
    for (const c of RAMP_DEFS[name]) PALETTE.push(c);
}

// Rarity ramps (item pickups): built from RARITY_COLORS — shadow, mid,
// the rarity colour itself, a pale tint, white.
function _shade(hex, k) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
    return '#' + [f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
export const RARITY_RAMP = {};
for (const name in RARITY_COLORS) {
    const c = RARITY_COLORS[name];
    if (typeof c !== 'string' || c[0] !== '#' || c.length !== 7) continue;
    RARITY_RAMP[name] = RAMP_BASE.length;
    RAMP_BASE.push(PALETTE.length);
    RAMP_N.push(5);
    PALETTE.push(_shade(c, -0.6), _shade(c, -0.3), c, _shade(c, 0.5), '#ffffff');
}

// Boss signature themes (by class name): hit-spark ramp + light tint.
const BOSS_THEME = {
    Starcore: 'fire', AsteroidCrusher: 'dust', EventHorizon: 'hull', Seraph: 'fire',
    Wheels: 'gold', Hive: 'spore', SwarmMother: 'spore', Dragon: 'fire', Carcosa: 'white',
    CthulhuEvent: 'abyss', YellowOne: 'level',
    HeadDeception: 'abyss', HeadAccusation: 'hull', HeadMurder: 'blood', HeadBlasphemy: 'fire',
    HeadEconomicControl: 'gold', HeadFalseWorship: 'level', HeadPersecution: 'blood',
};

// Additive light tints.
const LIGHT_RGB = [[255, 200, 120], [140, 190, 255], [255, 255, 255], [255, 255, 110], [255, 140, 90], [255, 214, 90], [255, 150, 60], [255, 60, 50], [90, 255, 120]];
export const LIGHT = { fire: 0, electric: 1, white: 2, level: 3, hull: 4, gold: 5, ember: 6, red: 7, heal: 8 };

// Pool caps — the absolute worst case.
const MAX_STREAKS = 600;
const MAX_PUFFS = 380;
const MAX_STARS = 96;
const MAX_HITS = 48;
const MAX_RINGS = 12;
const MAX_LIGHTS = 56;
const MAX_BOLTS = 40;
const MAX_PENDING = 32;
const BOLT_PTS = 40;  // max polyline points per bolt

const TAU = Math.PI * 2;
const HIT_FRAME = 0.04; // s per hit-spark frame

// Smoke/dust clouds: discrete sprite radii (logical px), shape variants and
// erosion (dissolve) steps — sprites are built lazily per combination.
const CLOUD_SIZES = [3, 4, 5, 7, 9, 12];
const CLOUD_VARIANTS = 6;
const CLOUD_EROSION = 6;

export const SUN_LEVEL = ['#c8c020', '#ffff44', '#ffffc8'];
export const SUN_STAR = ['#d6531e', '#ffd865', '#fff6d8'];
export const SUN_GOLD = ['#c98a1c', '#ffd24a', '#fff3b0'];
export const SUN_BONE = ['#8a8277', '#e2dccf', '#ffffff'];
export const SUN_ABYSS = ['#2e1a4a', '#5a3a8a', '#c8b0ff'];
export const SUN_SPORE = ['#3e5a16', '#7a9a2a', '#eaffa0'];

function energy(u) { return u < 0.15 ? 1 : 1 - (u - 0.15) / 0.85; }
function easeOut3(u) { const v = 1 - u; return 1 - v * v * v; }

export class ImpactFX {
    constructor(game) {
        this.game = game;
        this.time = 0;
        this.synth = null; // SfxSynth, attached by PlayingState

        // Streak sparks
        this.sN = 0;
        this.sX = new Float32Array(MAX_STREAKS); this.sY = new Float32Array(MAX_STREAKS);
        this.sVX = new Float32Array(MAX_STREAKS); this.sVY = new Float32Array(MAX_STREAKS);
        this.sLife = new Float32Array(MAX_STREAKS); this.sMax = new Float32Array(MAX_STREAKS);
        this.sDrag = new Float32Array(MAX_STREAKS); this.sLen = new Float32Array(MAX_STREAKS);
        this.sRamp = new Uint8Array(MAX_STREAKS);
        this.sUnder = new Uint8Array(MAX_STREAKS); // 1 = drawn behind ships/rocks

        // Puffs (fireball / smoke / dust)
        this.pN = 0;
        this.pX = new Float32Array(MAX_PUFFS); this.pY = new Float32Array(MAX_PUFFS);
        this.pVX = new Float32Array(MAX_PUFFS); this.pVY = new Float32Array(MAX_PUFFS);
        this.pT = new Float32Array(MAX_PUFFS);   // < 0 = delayed
        this.pDur = new Float32Array(MAX_PUFFS);
        this.pR0 = new Float32Array(MAX_PUFFS);  // start radius (logical px)
        this.pR1 = new Float32Array(MAX_PUFFS);  // peak radius
        this.pR2 = new Float32Array(MAX_PUFFS);  // end radius
        this.pDrag = new Float32Array(MAX_PUFFS);
        this.pRamp = new Uint8Array(MAX_PUFFS);
        this.pTop = new Uint8Array(MAX_PUFFS);   // starting ramp index
        this.pSmoke = new Uint8Array(MAX_PUFFS); // drawn in the under-pass
        this.pVar = new Uint8Array(MAX_PUFFS);   // cloud shape variant

        // Starflares (impact stars, glints, level-up fountain)
        this.fN = 0;
        this.fX = new Float32Array(MAX_STARS); this.fY = new Float32Array(MAX_STARS);
        this.fVX = new Float32Array(MAX_STARS); this.fVY = new Float32Array(MAX_STARS);
        this.fG = new Float32Array(MAX_STARS);   // gravity (world +y)
        this.fT = new Float32Array(MAX_STARS); this.fDur = new Float32Array(MAX_STARS);
        this.fLen = new Float32Array(MAX_STARS);
        this.fRamp = new Uint8Array(MAX_STARS); this.fDiag = new Uint8Array(MAX_STARS);

        // Hand-built 3-frame hit sparks
        this.hN = 0;
        this.hX = new Float32Array(MAX_HITS); this.hY = new Float32Array(MAX_HITS);
        this.hT = new Float32Array(MAX_HITS); this.hRamp = new Uint8Array(MAX_HITS);

        // Solid pixel rings (big moments only)
        this.rN = 0;
        this.rX = new Float32Array(MAX_RINGS); this.rY = new Float32Array(MAX_RINGS);
        this.rT = new Float32Array(MAX_RINGS); this.rDur = new Float32Array(MAX_RINGS);
        this.rR0 = new Float32Array(MAX_RINGS); this.rR1 = new Float32Array(MAX_RINGS);
        this.rW = new Float32Array(MAX_RINGS); this.rRamp = new Uint8Array(MAX_RINGS);

        // Banded additive lights
        this.lN = 0;
        this.lX = new Float32Array(MAX_LIGHTS); this.lY = new Float32Array(MAX_LIGHTS);
        this.lT = new Float32Array(MAX_LIGHTS); this.lDur = new Float32Array(MAX_LIGHTS);
        this.lR = new Float32Array(MAX_LIGHTS); this.lI = new Float32Array(MAX_LIGHTS);
        this.lC = new Uint8Array(MAX_LIGHTS); this.lFlick = new Uint8Array(MAX_LIGHTS);

        // Lightning bolts (object pool; each owns a point buffer)
        this.bolts = [];
        for (let i = 0; i < MAX_BOLTS; i++) {
            this.bolts.push({ live: false, pts: new Float32Array(BOLT_PTS * 2), n: 0, t: 0, dur: 0,
                mode: 0, ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, R: 0, a0: 0, a1: 0,
                jag: 0.25, ent: null, gen: -1, dim: 1 });
        }
        this.bN = 0;

        this.pending = [];     // staggered sub-bursts {t, x, y, size, kind}
        this.sunbursts = [];   // {player, t, dur}
        this._sunCanvas = null;
        this._sunTable = null;

        this._lastPickupT = -99;
        this._lastBlastT = -99;
        this._lastArcSoundT = -99;

        this._bin = PALETTE.map(() => new Float32Array(256));
        this._binN = new Int32Array(PALETTE.length);

        this._discCache = new Map();
        this._puffCache = new Map();
        this._cloudFields = new Map();
        this._cloudCache = new Map();
        this._warm = 0;
        this._warmDone = false;

        // Sprite pixel masks (per spriteKey) so damage fire/smoke only comes
        // off real hull pixels; built lazily, at most one per frame.
        this._masks = new Map();
        this._maskBudget = 1;
        this._hx = 0; this._hy = 0; // scratch out-params for _hullPoint

        this.smolders = [];       // burning wreck chunks {p, t, dur, acc}
        this._glintAcc = 0;
        this._muzzleBudget = 0;
        // Distant background skirmishes (parallax layer)
        this.skirmishes = [];
        this.skirmishBits = [];
        this._skirmishT = 20 + Math.random() * 25;
        this._hitFrames = new Map();
    }

    _q() {
        let q = 1;
        if (SETTINGS.reducedParticles) q *= 0.5;
        if (this.game.lowPerfMode) q *= 0.5;
        if (this.sN > MAX_STREAKS * 0.6 || this.pN > MAX_PUFFS * 0.6) q *= 0.5;
        return q;
    }

    // ══ Primitive spawners ═════════════════════════════════════════════════

    streaks(x, y, count, ramp, o) {
        const dir = o.dir != null ? o.dir : 0;
        const spread = o.spread != null ? o.spread : TAU;
        const sMin = o.speedMin, sRange = o.speedMax - o.speedMin;
        const lMin = o.lifeMin, lRange = o.lifeMax - o.lifeMin;
        const drag = o.drag != null ? o.drag : 6;
        const len = o.len != null ? o.len : 0.028;
        const jitter = o.jitter || 0;
        const ivx = o.vx || 0, ivy = o.vy || 0;
        for (let k = 0; k < count && this.sN < MAX_STREAKS; k++) {
            const i = this.sN++;
            const a = dir + (Math.random() - 0.5) * spread;
            const sp = sMin + Math.random() * sRange;
            this.sX[i] = x + (Math.random() - 0.5) * jitter;
            this.sY[i] = y + (Math.random() - 0.5) * jitter;
            this.sVX[i] = Math.cos(a) * sp + ivx;
            this.sVY[i] = Math.sin(a) * sp + ivy;
            this.sLife[i] = this.sMax[i] = lMin + Math.random() * lRange;
            this.sDrag[i] = drag;
            this.sLen[i] = len;
            this.sRamp[i] = ramp;
            this.sUnder[i] = o.under ? 1 : 0;
        }
    }

    // One shaded puff. Radii in logical px; `top` = starting ramp index
    // (defaults to the brightest). Smoke draws under fire.
    puff(x, y, vx, vy, r0, r1, r2, dur, ramp, o = null) {
        if (this.pN >= MAX_PUFFS) return;
        const i = this.pN++;
        this.pX[i] = x; this.pY[i] = y;
        this.pVX[i] = vx; this.pVY[i] = vy;
        this.pT[i] = o && o.delay ? -o.delay : 0;
        this.pDur[i] = dur;
        this.pR0[i] = r0; this.pR1[i] = r1; this.pR2[i] = r2;
        this.pDrag[i] = o && o.drag != null ? o.drag : 3;
        this.pRamp[i] = ramp;
        this.pTop[i] = o && o.top != null ? o.top : RAMP_N[ramp] - 1;
        // Smoky ramps render as eroding cloud sprites, never discs.
        this.pSmoke[i] = ramp === RAMP.smoke || ramp === RAMP.dust || ramp === RAMP.spore || ramp === RAMP.abyss ? 1 : 0;
        this.pVar[i] = (Math.random() * CLOUD_VARIANTS) | 0;
    }

    star(x, y, len, dur, ramp, diag = 1, vx = 0, vy = 0, g = 0) {
        if (this.fN >= MAX_STARS) return;
        const i = this.fN++;
        this.fX[i] = x; this.fY[i] = y;
        this.fVX[i] = vx; this.fVY[i] = vy; this.fG[i] = g;
        this.fT[i] = 0; this.fDur[i] = dur;
        this.fLen[i] = len; this.fRamp[i] = ramp; this.fDiag[i] = diag;
    }

    hitSpark(x, y, ramp) {
        if (this.hN >= MAX_HITS) return;
        const i = this.hN++;
        this.hX[i] = x; this.hY[i] = y; this.hT[i] = 0; this.hRamp[i] = ramp;
    }

    ring(x, y, r0, r1, dur, width, ramp) {
        if (this.rN >= MAX_RINGS) return;
        const i = this.rN++;
        this.rX[i] = x; this.rY[i] = y; this.rT[i] = 0; this.rDur[i] = dur;
        this.rR0[i] = r0; this.rR1[i] = r1; this.rW[i] = width; this.rRamp[i] = ramp;
    }

    light(x, y, r, intensity, dur, color, flicker = 0) {
        if (this.lN >= MAX_LIGHTS || this.game.lowPerfMode) return;
        const i = this.lN++;
        this.lX[i] = x; this.lY[i] = y; this.lT[i] = 0; this.lDur[i] = dur;
        this.lR[i] = r; this.lI[i] = intensity; this.lC[i] = color; this.lFlick[i] = flicker;
    }

    _bolt() {
        if (this.bN >= MAX_BOLTS) return null;
        for (const b of this.bolts) {
            if (!b.live) { b.live = true; b.t = 0; b.gen = -1; b.ent = null; b.dim = 1; b.ramp = RAMP.electric; b.under = false; this.bN++; return b; }
        }
        return null;
    }

    // Straight lightning from A to B (world coords, or relative to `ent`).
    bolt(ax, ay, bx, by, dur = 0.2, ent = null, jag = 0.28) {
        const b = this._bolt();
        if (!b) return null;
        b.mode = 0; b.ax = ax; b.ay = ay; b.bx = bx; b.by = by;
        b.dur = dur; b.ent = ent; b.jag = jag;
        return b;
    }

    // Lightning that crawls along a circle (shield surface), from angle a0 to a1.
    arcBolt(cx, cy, R, a0, a1, dur = 0.2, ent = null) {
        const b = this._bolt();
        if (!b) return null;
        b.mode = 1; b.cx = cx; b.cy = cy; b.R = R; b.a0 = a0; b.a1 = a1;
        b.dur = dur; b.ent = ent; b.jag = 0;
        return b;
    }

    // ══ Recipes ════════════════════════════════════════════════════════════

    // Bullet lands on a hull. (nx,ny) = surface normal (out of the target),
    // (bx,by) = bullet direction. Back-spray reflects off the hull, shrapnel
    // punches through along the shot.
    hit(x, y, nx, ny, bx, by, ramp = RAMP.spark) {
        const q = this._q();
        this.hitSpark(x, y, ramp);
        this.streaks(x, y, Math.max(2, Math.round(4 * q)), ramp, {
            dir: Math.atan2(ny, nx), spread: 1.3, speedMin: 160, speedMax: 380,
            lifeMin: 0.07, lifeMax: 0.18, drag: 9, len: 0.024
        });
        this.streaks(x, y, Math.max(1, Math.round(3 * q)), RAMP.hull, {
            dir: Math.atan2(by, bx), spread: 0.7, speedMin: 300, speedMax: 560,
            lifeMin: 0.06, lifeMax: 0.15, drag: 7, len: 0.03
        });
        this.light(x, y, 16, 0.4, 0.08, LIGHT.fire);
    }

    // A ship blows apart. (kx,ky) = unit kill direction (0,0 = none).
    explode(x, y, size, kx = 0, ky = 0) {
        const q = this._q();
        size = Math.max(8, Math.min(size, 48));
        const kd = (kx || ky) ? Math.atan2(ky, kx) : null;
        const push = kd != null ? 1 : 0;

        this.light(x, y, size * 3.6, 0.8, 0.35, LIGHT.fire);
        this.star(x, y, Math.round(6 + size * 0.2), 0.15, RAMP.white, 1);
        this.hitSpark(x, y, RAMP.white);

        // Fireball: shaded puffs bloom, get shoved along the shot, cool down
        // the fire ramp and collapse.
        const nF = Math.min(18, Math.round((7 + size * 0.25) * q));
        for (let k = 0; k < nF; k++) {
            const a = Math.random() * TAU, d = Math.random() * size * 0.45;
            const sp = 30 + Math.random() * 110, kp = push * (60 + Math.random() * 140);
            const rp = Math.min(10, 3 + Math.random() * 3 + size * 0.09);
            this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d,
                Math.cos(a) * sp + kx * kp, Math.sin(a) * sp + ky * kp,
                rp * 0.5, rp, rp * 0.25, 0.3 + Math.random() * 0.28, RAMP.fire,
                { delay: Math.random() * 0.06, drag: 4 });
        }
        // Smoke rolls out after the fire and lingers.
        const nS = Math.min(12, Math.round((4 + size * 0.16) * q));
        for (let k = 0; k < nS; k++) {
            const a = Math.random() * TAU, d = Math.random() * size * 0.5;
            const sp = 12 + Math.random() * 45;
            const rp = Math.min(11, 4 + Math.random() * 4 + size * 0.06);
            this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d,
                Math.cos(a) * sp + kx * 35 * push, Math.sin(a) * sp + ky * 35 * push,
                rp * 0.5, rp, rp * 1.15, 0.8 + Math.random() * 0.7, RAMP.smoke,
                { delay: 0.07 + Math.random() * 0.12, drag: 1.6, top: 3 + (Math.random() < 0.5 ? 1 : 0) });
        }
        // Sparks: most fly with the shot, the rest everywhere.
        const nSp = Math.round((9 + size * 0.3) * q);
        const nDir = kd != null ? Math.round(nSp * 0.6) : 0;
        if (nDir) this.streaks(x, y, nDir, RAMP.spark, {
            dir: kd, spread: 1.2, speedMin: 260, speedMax: 680, lifeMin: 0.14, lifeMax: 0.4, drag: 4.5, len: 0.03, jitter: size * 0.4
        });
        this.streaks(x, y, nSp - nDir, RAMP.spark, {
            speedMin: 160, speedMax: 520, lifeMin: 0.12, lifeMax: 0.36, drag: 5, len: 0.028, jitter: size * 0.5
        });
        // Embers drift and wink out.
        this.streaks(x, y, Math.round((4 + size * 0.14) * q), RAMP.fire, {
            speedMin: 30, speedMax: 150, lifeMin: 0.4, lifeMax: 0.9, drag: 2.2, len: 0.014, jitter: size * 0.7,
            vx: kx * 40, vy: ky * 40
        });
        // Electrical discharge: the ship's power core shorting out.
        if (!this.game.lowPerfMode) {
            const nb = 1 + (Math.random() < 0.6 ? 1 : 0);
            for (let k = 0; k < nb; k++) {
                const a = Math.random() * TAU, d = size * (1.2 + Math.random() * 1.4);
                this.bolt(x, y, x + Math.cos(a) * d, y + Math.sin(a) * d, 0.2);
            }
            if (this.synth) this.synth.zap(x, y, 0.1);
        }
        if (this.synth) this.synth.thump(size / 28, x, y);
    }

    // Boss / huge death: rolling sub-bursts across the hull, a lightning
    // storm, a smoke column and two big solid rings.
    bigExplode(x, y, radius) {
        const n = this.game.lowPerfMode ? 4 : 8;
        const spread = Math.min(radius, 170);
        for (let k = 0; k < n && this.pending.length < MAX_PENDING; k++) {
            const a = Math.random() * TAU, d = spread * (0.15 + 0.75 * Math.random());
            this.pending.push({ t: k * (0.06 + Math.random() * 0.07), x: x + Math.cos(a) * d, y: y + Math.sin(a) * d,
                size: 22 + Math.random() * 22, kind: 0 });
        }
        for (let k = 0; k < 5 && this.pending.length < MAX_PENDING; k++) {
            this.pending.push({ t: 0.05 + k * 0.12, x, y, size: spread, kind: 1 });
        }
        this.explode(x, y, 46);
        this.ring(x, y, spread * 0.2, spread * 2.2, 0.6, 3, RAMP.white);
        this.ring(x, y, spread * 0.1, spread * 1.6, 0.75, 2, RAMP.fire);
        this.light(x, y, spread * 2.4, 0.9, 0.8, LIGHT.fire);
        if (this.synth) this.synth.thump(2, x, y, 0.8);
    }

    // Asteroid breaks: rock dust billows, chips fly with the shot, a few hot
    // fracture sparks. Rocks don't glow.
    shatter(x, y, radius, kx = 0, ky = 0) {
        const q = this._q();
        const size = Math.max(8, Math.min(radius, 60));
        const nD = Math.min(14, Math.round((4 + size * 0.15) * q));
        for (let k = 0; k < nD; k++) {
            const a = Math.random() * TAU, d = Math.random() * size * 0.5;
            const sp = 15 + Math.random() * 70;
            const rp = Math.min(10, 3 + Math.random() * 3 + size * 0.06);
            this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d,
                Math.cos(a) * sp + kx * 50, Math.sin(a) * sp + ky * 50,
                rp * 0.6, rp, rp * 0.9, 0.5 + Math.random() * 0.5, RAMP.dust,
                { drag: 2.5, top: 2 + (Math.random() * 2 | 0) });
        }
        this.streaks(x, y, Math.round((6 + size * 0.22) * q), RAMP.dust, {
            speedMin: 90, speedMax: 320 + size * 3, lifeMin: 0.2, lifeMax: 0.5,
            drag: 4, len: 0.022, jitter: size * 0.6, vx: kx * 120, vy: ky * 120
        });
        this.streaks(x, y, Math.round(4 * q), RAMP.spark, {
            speedMin: 200, speedMax: 460, lifeMin: 0.08, lifeMax: 0.2, drag: 8, len: 0.025
        });
        if (this.synth) this.synth.thump(size / 60, x, y, 0.3);
    }

    // Explosives / rocket area blast (throttled — Explosives Unit spam).
    blast(x, y, radius = 64) {
        if (this.time - this._lastBlastT < 0.05) return;
        this._lastBlastT = this.time;
        const q = this._q();
        const n = Math.round(10 * q);
        for (let k = 0; k < n; k++) {
            const a = (k / n) * TAU + Math.random() * 0.4;
            const sp = radius * (2.2 + Math.random());
            const rp = 3 + Math.random() * 3;
            this.puff(x, y, Math.cos(a) * sp, Math.sin(a) * sp, rp * 0.5, rp, rp * 0.2,
                0.28 + Math.random() * 0.15, RAMP.fire, { drag: 7 });
        }
        this.hitSpark(x, y, RAMP.white);
        this.streaks(x, y, Math.round(10 * q), RAMP.spark, {
            speedMin: 200, speedMax: 560, lifeMin: 0.1, lifeMax: 0.3, drag: 5, len: 0.03
        });
        this.light(x, y, radius * 1.6, 0.7, 0.25, LIGHT.fire);
        if (this.synth) this.synth.thump(0.6, x, y, 0.4);
    }

    // Energy shield deflects a shot. (cx,cy,R) = bubble; (bx,by) = incoming
    // shot direction; `ent` lets the crawl-lightning ride a moving bubble.
    deflect(x, y, cx, cy, R, bx, by, ent = null) {
        const q = this._q();
        let nx = x - cx, ny = y - cy;
        const nl = Math.sqrt(nx * nx + ny * ny) || 1;
        nx /= nl; ny /= nl;
        // Reflect the shot about the normal: d' = d − 2(d·n)n
        const dot = bx * nx + by * ny;
        const rx = bx - 2 * dot * nx, ry = by - 2 * dot * ny;
        const ra = Math.atan2(ry, rx);
        this.streaks(x, y, 1, RAMP.electric, {
            dir: ra, spread: 0.12, speedMin: 720, speedMax: 820, lifeMin: 0.16, lifeMax: 0.2, drag: 2.5, len: 0.05
        });
        this.streaks(x, y, Math.round(5 * q), RAMP.electric, {
            dir: Math.atan2(ny, nx), spread: 1.6, speedMin: 120, speedMax: 340, lifeMin: 0.08, lifeMax: 0.2, drag: 7, len: 0.02
        });
        this.hitSpark(x, y, RAMP.electric);
        // Lightning crawls both ways along the bubble from the impact.
        const a = Math.atan2(ny, nx);
        const ox = ent ? ent.worldX : 0, oy = ent ? ent.worldY : 0;
        const span = 0.45 + Math.random() * 0.45;
        this.arcBolt(cx - ox, cy - oy, R, a, a + span, 0.2, ent);
        this.arcBolt(cx - ox, cy - oy, R, a, a - span * (0.6 + Math.random() * 0.5), 0.2, ent);
        this.light(x, y, 26, 0.6, 0.14, LIGHT.electric);
        if (this.synth) this.synth.deflect(x, y);
    }

    // Shield bubble shatters: radial lightning, electric shards, a solid ring.
    shieldBreak(x, y, radius, ent = null) {
        const q = this._q();
        this.star(x, y, 10, 0.22, RAMP.electric, 1);
        this.ring(x, y, radius * 0.7, radius * 1.8, 0.38, 2, RAMP.electric);
        this.streaks(x, y, Math.round(16 * q), RAMP.electric, {
            speedMin: 160, speedMax: 460, lifeMin: 0.15, lifeMax: 0.42, drag: 4, len: 0.03, jitter: radius
        });
        const n = this.game.lowPerfMode ? 3 : 6;
        for (let k = 0; k < n; k++) {
            const a = (k / n) * TAU + Math.random() * 0.6;
            this.bolt(Math.cos(a) * radius * 0.5, Math.sin(a) * radius * 0.5,
                Math.cos(a) * radius * 1.7, Math.sin(a) * radius * 1.7, 0.24, ent || { worldX: x, worldY: y });
        }
        this.light(x, y, radius * 2.4, 0.8, 0.35, LIGHT.electric);
        if (this.synth) { this.synth.zap(x, y, 0.4); }
    }

    // Level-up: rotating pixel sunburst on the ship, two rings, a fountain of
    // stars arcing under gravity, a chime arpeggio.
    levelUp(player) {
        const x = player.worldX, y = player.worldY;
        this.sunbursts.push({ player, t: 0, dur: 1.35, bands: SUN_LEVEL, scale: 1 });
        this.ring(x, y, 12, 90, 0.45, 2, RAMP.level);
        this.ring(x, y, 8, 140, 0.65, 1, RAMP.level);
        this.light(x, y, 90, 0.7, 0.8, LIGHT.level);
        const n = this.game.lowPerfMode ? 8 : 18;
        for (let k = 0; k < n; k++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
            const sp = 220 + Math.random() * 260;
            this.star(x, y, 2 + (Math.random() * 3 | 0), 0.8 + Math.random() * 0.5, RAMP.level,
                Math.random() < 0.35 ? 1 : 0, Math.cos(a) * sp, Math.sin(a) * sp, 620);
        }
        if (this.synth) this.synth.chime();
    }

    // Player hull takes a hit (shield hits go through deflect()).
    playerHit(x, y, nx, ny) {
        this.hitSpark(x, y, RAMP.hull);
        this.streaks(x, y, 5, RAMP.hull, {
            dir: Math.atan2(ny, nx), spread: 1.4, speedMin: 140, speedMax: 380, lifeMin: 0.1, lifeMax: 0.28, drag: 6, len: 0.026
        });
        this.light(x, y, 26, 0.6, 0.15, LIGHT.hull);
    }

    pickup(x, y) {
        if (this.time - this._lastPickupT < 0.035) return;
        this._lastPickupT = this.time;
        this.star(x, y, 3, 0.14, RAMP.gold, 0);
    }

    // ── Damaged ships: smoke → fire → arcing lightning ─────────────────────
    // Called once per frame with the enemy list + live local pilots (for
    // proximity culling). Health ratio drives the stage, so a glance at a
    // ship tells you how close it is to popping.
    emitDamage(enemies, dt, pilots, noWarp = false) {
        const q = this._q();
        if (q < 0.2) return;
        const lowPerf = this.game.lowPerfMode;
        for (let i = 0; i < enemies.length; i++) {
            const en = enemies[i];
            if (!en.alive) continue;
            // First sighting: if it popped into existence near a pilot (not
            // at run start), play the warp-in arrival.
            if (!en._fxSeen) {
                en._fxSeen = true;
                // Children born mid-fight (nanite drones, locusts, risen bone
                // ships) have their own birth visuals — skip; budget the rest.
                const cn = en.constructor && en.constructor.name;
                if (!noWarp && this.time > 3 && this._warpBudget >= 1 && cn !== 'NaniteDrone' && cn !== 'LocustEnemy' && cn !== 'BoneEnemy' && cn !== 'SwarmMother') {
                    this._warpBudget -= 1;
                    for (let p = 0; p < pilots.length; p++) {
                        const dx = pilots[p].worldX - en.worldX, dy = pilots[p].worldY - en.worldY;
                        if (dx * dx + dy * dy < 1100 * 1100) { this.warpIn(en.worldX, en.worldY, Math.min(40, en.radius || 18)); break; }
                    }
                }
            }
            // Track actual on-screen motion (AI velocity fields can disagree
            // with where the ship really goes — pinned, docked, rammed).
            if (en._fxPX !== undefined && dt > 0) {
                let mx = (en.worldX - en._fxPX) / dt, my = (en.worldY - en._fxPY) / dt;
                const mm = Math.sqrt(mx * mx + my * my);
                if (mm > 600) { mx *= 600 / mm; my *= 600 / mm; } // blinks/teleports
                const k = Math.min(1, dt * 10);
                en._fxVX += (mx - en._fxVX) * k; en._fxVY += (my - en._fxVY) * k;
            } else { en._fxVX = 0; en._fxVY = 0; }
            en._fxPX = en.worldX; en._fxPY = en.worldY;
            if (en.isBoss) this.bossAmbient(en, dt);
            if (en.health == null) continue;
            let max = en.maxHealth;
            if (!(max > 0)) { if (!(en._fxMaxHp >= en.health)) en._fxMaxHp = en.health; max = en._fxMaxHp; }
            if (!(max > 0)) continue;
            const ratio = en.health / max;
            if (ratio >= 0.7 || ratio <= 0) continue;
            let near = false;
            for (let p = 0; p < pilots.length; p++) {
                const dx = pilots[p].worldX - en.worldX, dy = pilots[p].worldY - en.worldY;
                if (dx * dx + dy * dy < 1500 * 1500) { near = true; break; }
            }
            if (!near) continue;

            const r = Math.min(en.radius || 16, 80);
            const vx = en._fxVX, vy = en._fxVY; // 0 when the ship is still
            const scale = Math.min(2.5, r / 18) * q;
            const acc = en._fxAcc || (en._fxAcc = { smoke: Math.random(), fire: Math.random(), arc: 0.3 + Math.random() * 0.6, spark: 0, light: 0, crackle: 0 });
            // Fire/smoke only come off real hull pixels: damage spots where
            // shots landed (topped up with random hull pixels as it worsens).
            const mask = this._maskFor(en);
            const spots = ratio < 0.45 ? this._ensureSpots(en, mask, ratio < 0.2 ? 5 : ratio < 0.33 ? 3 : 2) : en._fxSpots;

            // Smoke — thicker and darker the worse it gets.
            acc.smoke += dt * (ratio < 0.4 ? 10 : 5) * scale;
            while (acc.smoke >= 1) {
                acc.smoke -= 1;
                this._hullPoint(en, mask, spots, 0.6);
                const rp = 2.5 + Math.random() * 2.5 + r * 0.04;
                this.puff(this._hx, this._hy,
                    vx * 0.15 + (Math.random() - 0.5) * 24, vy * 0.15 + (Math.random() - 0.5) * 24,
                    rp * 0.5, rp, rp * 1.5, 0.7 + Math.random() * 0.6, RAMP.smoke,
                    { drag: 1.4, top: ratio < 0.4 ? 2 : 4 });
            }
            if (ratio < 0.45) {
                // Fire licks off the hull, dragged a little behind the ship.
                acc.fire += dt * 13 * scale;
                while (acc.fire >= 1) {
                    acc.fire -= 1;
                    this._hullPoint(en, mask, spots, 0.9);
                    const rp = 1.5 + Math.random() * 2 + r * 0.03;
                    this.puff(this._hx, this._hy,
                        vx * 0.55 + (Math.random() - 0.5) * 40, vy * 0.55 + (Math.random() - 0.5) * 40,
                        rp * 0.6, rp, rp * 0.2, 0.2 + Math.random() * 0.15, RAMP.fire, { drag: 3 });
                }
                acc.light -= dt;
                if (acc.light <= 0) {
                    acc.light = 0.1;
                    this.light(en.worldX, en.worldY, r * 2.6, 0.38, 0.13, LIGHT.ember, 1);
                }
                acc.crackle -= dt;
                if (acc.crackle <= 0) {
                    acc.crackle = 0.5 + Math.random() * 0.9;
                    if (this.synth) this.synth.crackle(en.worldX, en.worldY);
                }
            }
            if (ratio < 0.3) {
                acc.spark += dt * 5 * q;
                while (acc.spark >= 1) {
                    acc.spark -= 1;
                    this._hullPoint(en, mask, spots, 0.7);
                    this.streaks(this._hx, this._hy, 2, RAMP.spark, {
                        speedMin: 120, speedMax: 320, lifeMin: 0.1, lifeMax: 0.25, drag: 5, len: 0.024,
                        vx: vx * 0.5, vy: vy * 0.5
                    });
                }
                if (!lowPerf) {
                    acc.arc -= dt;
                    if (acc.arc <= 0) {
                        acc.arc = 0.35 + Math.random() * 0.8;
                        // An arc jumps across the hull between two hull pixels.
                        this._hullPoint(en, mask, spots, 0.5);
                        const ax = this._hx - en.worldX, ay = this._hy - en.worldY;
                        this._hullPoint(en, mask, null, 0);
                        this.bolt(ax, ay, this._hx - en.worldX, this._hy - en.worldY, 0.2, en, 0.35);
                        this.light(en.worldX, en.worldY, r * 2, 0.45, 0.12, LIGHT.electric);
                        if (this.synth && this.time - this._lastArcSoundT > 0.15) {
                            this._lastArcSoundT = this.time;
                            this.synth.zap(en.worldX, en.worldY, 0.1);
                        }
                    }
                }
            }
        }
    }




    // ══ Generic building blocks (used by StateFX) ══════════════════════════

    // n streaks sucked INTO (x, y) from radius R, arriving in `life` s.
    inward(x, y, ramp, n, R = 70, life = 0.22, under = false) {
        for (let k = 0; k < n && this.sN < MAX_STREAKS; k++) {
            const a = Math.random() * TAU, d = R * (0.6 + Math.random() * 0.6);
            const i = this.sN++;
            this.sX[i] = x + Math.cos(a) * d; this.sY[i] = y + Math.sin(a) * d;
            this.sVX[i] = -Math.cos(a) * d / life; this.sVY[i] = -Math.sin(a) * d / life;
            this.sLife[i] = this.sMax[i] = life; this.sDrag[i] = 0; this.sLen[i] = 0.03;
            this.sRamp[i] = ramp; this.sUnder[i] = under ? 1 : 0;
        }
    }

    // Radial (or aimed) spark burst.
    burst(x, y, ramp, n, smin = 150, smax = 450, dir = null, spread = TAU, life = 0.35) {
        this.streaks(x, y, Math.max(1, Math.round(n * this._q())), ramp, {
            dir: dir == null ? 0 : dir, spread: dir == null ? TAU : spread,
            speedMin: smin, speedMax: smax, lifeMin: life * 0.5, lifeMax: life, drag: 4, len: 0.03
        });
    }

    // n lightning bolts radiating from radius r0 to r1 around (x, y).
    storm(x, y, r0, r1, n, ramp, dur = 0.26, under = false) {
        if (this.game.lowPerfMode) n = Math.ceil(n / 2);
        const off = Math.random() * TAU;
        for (let k = 0; k < n; k++) {
            const a = off + (k / n) * TAU + (Math.random() - 0.5) * 0.5;
            const b = this.bolt(x + Math.cos(a) * r0, y + Math.sin(a) * r0, x + Math.cos(a) * r1, y + Math.sin(a) * r1, dur, null, 0.4);
            if (b) { b.ramp = ramp; b.under = under; }
        }
    }

    sunburst(x, y, bands, scale = 1, dur = 1.3) {
        if (this.sunbursts.length >= 6) return;
        this.sunbursts.push({ player: { worldX: x, worldY: y }, t: 0, dur, bands, scale });
    }

    // A beam fires: muzzle blast + light marching down the beam line.
    beamFlash(x, y, angle, len, ramp, light) {
        const c = Math.cos(angle), sn = Math.sin(angle);
        this.hitSpark(x, y, ramp);
        this.star(x, y, 10, 0.2, ramp, 1);
        this.burst(x, y, ramp, 10, 250, 650, angle, 0.5, 0.3);
        const steps = Math.min(6, Math.floor(len / 220));
        for (let k = 0; k <= steps; k++) this.light(x + c * k * 220, y + sn * k * 220, 60, 0.5, 0.25, light);
    }

    // Big moment where a boss/event wakes up.
    awaken(x, y, R, ramp, light, bands = null) {
        if (bands) this.sunburst(x, y, bands, Math.max(1, R / 70), 1.2);
        this.ring(x, y, R * 0.3, R * 2.6, 0.7, 3, ramp);
        this.star(x, y, 16, 0.35, ramp, 1);
        this.burst(x, y, ramp, 30, 200, 650, null, TAU, 0.6);
        this.storm(x, y, R * 0.5, R * 1.8, 6, ramp);
        this.light(x, y, R * 3, 0.9, 0.8, light);
        if (this.synth) { this.synth.thump(1.6, x, y, 0.6); this.synth.zap(x, y, 0.3); }
    }

    // ══ Boss signatures, events, pickups ═══════════════════════════════════

    // Signature auras for the EVENT bosses (Seraph, Wheels, Hive, Swarm
    // Mother, Yellow One, Carcosa, Cthulhu, Dragon heads) — `list` is built
    // by PlayingState each frame; proximity-culled to live pilots. Also
    // catches a Dragon head shattering (it never routes through the normal
    // kill path) and plays its finale.
    tickBosses(list, dt, pilots) {
        const q = this._q();
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            const n = e._fxName || (e.constructor && e.constructor.name);
            if (e.state === 'shattered') {
                if (!e._fxShattered) { e._fxShattered = true; this.bossDeath(e, n); }
                continue;
            }
            if (e.alive === false) continue;
            let near = false;
            for (let p = 0; p < pilots.length; p++) {
                const dx = pilots[p].worldX - e.worldX, dy = pilots[p].worldY - e.worldY;
                if (dx * dx + dy * dy < 1600 * 1600) { near = true; break; }
            }
            if (!near) continue;
            const R = Math.min(e.radius || 80, 160);
            const acc = e._fxAura || (e._fxAura = { a: Math.random(), b: Math.random(), c: Math.random() });
            const ramp = RAMP[BOSS_THEME[n]] != null ? RAMP[BOSS_THEME[n]] : RAMP.fire;
            if (n === 'Seraph' || (n && n.startsWith('Head'))) {
                // Burning: embers rising off the body, the odd lick of flame.
                acc.a += dt * 9 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, d = Math.random() * R * 0.7;
                    this.streaks(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, 1, n === 'Seraph' ? RAMP.fire : ramp, {
                        dir: a, spread: 1.2, speedMin: 30, speedMax: 110, lifeMin: 0.5, lifeMax: 1.1, drag: 1.2, len: 0.018
                    });
                }
                acc.b += dt * 2.5 * q;
                while (acc.b >= 1) {
                    acc.b -= 1;
                    const a = Math.random() * TAU, d = Math.random() * R * 0.6;
                    const rp = 2 + Math.random() * 2.5;
                    this.puff(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, Math.cos(a) * 20, Math.sin(a) * 20,
                        rp * 0.5, rp, rp * 0.3, 0.3, RAMP.fire, { drag: 2 });
                }
            } else if (n === 'Wheels') {
                // Rims throw gold sparks tangentially like a grinding wheel.
                acc.a += dt * 14 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, r = R * (0.75 + Math.random() * 0.25);
                    this.streaks(e.worldX + Math.cos(a) * r, e.worldY + Math.sin(a) * r, 1, RAMP.gold, {
                        dir: a + Math.PI / 2, spread: 0.3, speedMin: 120, speedMax: 300, lifeMin: 0.15, lifeMax: 0.35, drag: 4, len: 0.03
                    });
                }
            } else if (n === 'Hive' || n === 'SwarmMother') {
                // Spores drift off the brood and glint.
                acc.a += dt * 5 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, d = R * (0.4 + Math.random() * 0.5);
                    this.star(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, 2, 1.2 + Math.random() * 0.8, RAMP.spore, 0,
                        Math.cos(a) * 18, Math.sin(a) * 18, 0);
                }
                acc.b += dt * 1.2 * q;
                while (acc.b >= 1) {
                    acc.b -= 1;
                    const a = Math.random() * TAU, d = Math.random() * R * 0.6;
                    this.puff(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, Math.cos(a) * 10, Math.sin(a) * 10,
                        2, 4 + Math.random() * 2, 6, 1.4, RAMP.spore, { drag: 1, top: 2 });
                }
            } else if (n === 'YellowOne') {
                // Yellow motes slowly orbit it — the sign's pull.
                acc.a += dt * 4 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, d = R * (1.1 + Math.random() * 0.8);
                    this.star(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, 2, 1.6, RAMP.level, 0,
                        -Math.sin(a) * 35, Math.cos(a) * 35, 0);
                }
            } else if (n === 'Carcosa') {
                // Bone dust hangs in the air.
                acc.a += dt * 2 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, d = Math.random() * R * 2;
                    this.puff(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8,
                        2, 4 + Math.random() * 3, 7, 2, RAMP.dust, { drag: 0.8, top: 2 });
                }
            } else if (n === 'CthulhuEvent') {
                // Abyssal motes rise and dark arcs flicker across it.
                acc.a += dt * 6 * q;
                while (acc.a >= 1) {
                    acc.a -= 1;
                    const a = Math.random() * TAU, d = Math.random() * R * 0.8;
                    this.star(e.worldX + Math.cos(a) * d, e.worldY + Math.sin(a) * d, 2, 1.0 + Math.random() * 0.6, RAMP.abyss, 0,
                        (Math.random() - 0.5) * 20, -20 - Math.random() * 30, 0);
                }
                acc.b -= dt;
                if (acc.b <= 0 && !this.game.lowPerfMode) {
                    acc.b = 0.6 + Math.random() * 0.8;
                    const a = Math.random() * TAU, c2 = a + 1.4 + Math.random() * 1.5, r = R * 0.6;
                    const b = this.bolt(Math.cos(a) * r, Math.sin(a) * r, Math.cos(c2) * r, Math.sin(c2) * r, 0.24, e, 0.4);
                    if (b) b.ramp = RAMP.abyss;
                }
            }
        }
    }

    // Boss death finales (on top of bigExplode where the kill path runs it).
    // `nameOverride` lets the preview fire any finale.
    bossDeath(en, nameOverride) {
        const n = nameOverride || en._fxName || (en.constructor && en.constructor.name);
        const x = en.worldX, y = en.worldY, R = Math.min(en.radius || 100, 170);
        const q = this._q();
        if (n === 'Starcore') {
            // Supernova: a huge gold sunburst + rings of fire.
            this.sunbursts.push({ player: { worldX: x, worldY: y }, t: 0, dur: 1.6, bands: SUN_STAR, scale: 2.2 });
            this.ring(x, y, R * 0.3, R * 3, 0.9, 4, RAMP.gold);
            this.light(x, y, R * 3, 1, 1.0, LIGHT.gold);
            this.streaks(x, y, Math.round(40 * q), RAMP.fire, {
                speedMin: 200, speedMax: 700, lifeMin: 0.4, lifeMax: 1.0, drag: 2, len: 0.03, jitter: R
            });
        } else if (n === 'EventHorizon' || n === 'CthulhuEvent') {
            // Collapse: everything rushes INTO the core, then it bursts.
            const ramps = n === 'EventHorizon' ? [RAMP.hull, RAMP.blood] : [RAMP.abyss, RAMP.white];
            const k = this.game.lowPerfMode ? 20 : 48;
            for (let i = 0; i < k && this.sN < MAX_STREAKS; i++) {
                const a = Math.random() * TAU, d = R * (1.5 + Math.random() * 2), life = 0.35;
                const j = this.sN++;
                this.sX[j] = x + Math.cos(a) * d; this.sY[j] = y + Math.sin(a) * d;
                this.sVX[j] = -Math.cos(a) * d / life; this.sVY[j] = -Math.sin(a) * d / life;
                this.sLife[j] = this.sMax[j] = life; this.sDrag[j] = 0; this.sLen[j] = 0.04;
                this.sRamp[j] = ramps[Math.random() < 0.4 ? 1 : 0]; this.sUnder[j] = 0;
            }
            this.pending.push({ t: 0.36, x, y, size: R, kind: n === 'EventHorizon' ? 3 : 4 });
        } else if (n === 'AsteroidCrusher') {
            for (let i = 0; i < 18; i++) {
                const a = Math.random() * TAU, d = Math.random() * R * 0.8, sp = 40 + Math.random() * 120;
                const rp = 6 + Math.random() * 6;
                this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * sp, Math.sin(a) * sp,
                    rp * 0.5, rp, rp * 1.2, 1.2 + Math.random() * 0.8, RAMP.dust, { drag: 1.4, top: 3, delay: Math.random() * 0.3 });
            }
            this.streaks(x, y, Math.round(30 * q), RAMP.dust, {
                speedMin: 150, speedMax: 520, lifeMin: 0.4, lifeMax: 0.9, drag: 2.5, len: 0.025, jitter: R
            });
        } else if (n === 'Seraph' || (n && n.startsWith('Head'))) {
            // Immolation: a fire sunburst, a ring of flame, a fountain of embers
            // and a pall of smoke. Dragon heads burn in their own colours.
            const ramp = n === 'Seraph' ? RAMP.fire : (RAMP[BOSS_THEME[n]] != null ? RAMP[BOSS_THEME[n]] : RAMP.fire);
            this.sunbursts.push({ player: { worldX: x, worldY: y }, t: 0, dur: 1.4, bands: SUN_STAR, scale: 1.8 });
            this.ring(x, y, R * 0.3, R * 2.6, 0.8, 4, ramp);
            this.explode(x, y, 48);
            for (let i = 0; i < 26; i++) {
                const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6, sp = 200 + Math.random() * 300;
                this.star(x, y, 2 + (Math.random() < 0.4 ? 1 : 0), 0.8 + Math.random() * 0.6, ramp, 0, Math.cos(a) * sp, Math.sin(a) * sp, 420);
            }
            for (let i = 0; i < 10; i++) {
                const a = Math.random() * TAU, d = Math.random() * R * 0.7, rp = 6 + Math.random() * 5;
                this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * 30, Math.sin(a) * 30,
                    rp * 0.5, rp, rp * 1.3, 1.6, RAMP.smoke, { drag: 1, top: 3, delay: 0.2 + Math.random() * 0.4 });
            }
            this.light(x, y, R * 3, 1, 0.9, LIGHT.fire);
            if (this.synth) this.synth.thump(2, x, y, 0.8);
        } else if (n === 'Wheels') {
            // The wheels fly apart: a golden spiral of sparks, two rings, a spin-out star.
            const k = Math.round(60 * q);
            for (let i = 0; i < k; i++) {
                const a = i * 2.39996, sp = 150 + (i / k) * 450;
                this.streaks(x + Math.cos(a) * R * 0.3, y + Math.sin(a) * R * 0.3, 1, RAMP.gold, {
                    dir: a + 0.6, spread: 0.05, speedMin: sp, speedMax: sp, lifeMin: 0.5, lifeMax: 0.9, drag: 2, len: 0.035
                });
            }
            this.ring(x, y, R * 0.4, R * 2.8, 0.7, 3, RAMP.gold);
            this.ring(x, y, R * 0.2, R * 1.8, 0.9, 2, RAMP.white);
            this.star(x, y, 22, 0.45, RAMP.gold, 1);
            this.light(x, y, R * 3, 1, 0.8, LIGHT.gold);
            if (this.synth) { this.synth.chime(0.25); this.synth.thump(1.5, x, y, 0.6); }
        } else if (n === 'Hive' || n === 'SwarmMother') {
            // Brood bursts: a choking spore cloud and green gore spray.
            for (let i = 0; i < 16; i++) {
                const a = Math.random() * TAU, d = Math.random() * R * 0.6, sp = 30 + Math.random() * 110, rp = 5 + Math.random() * 6;
                this.puff(x + Math.cos(a) * d, y + Math.sin(a) * d, Math.cos(a) * sp, Math.sin(a) * sp,
                    rp * 0.5, rp, rp * 1.3, 1.4 + Math.random() * 0.8, RAMP.spore, { drag: 1.3, top: 3, delay: Math.random() * 0.25 });
            }
            this.streaks(x, y, Math.round(36 * q), RAMP.spore, {
                speedMin: 150, speedMax: 520, lifeMin: 0.3, lifeMax: 0.8, drag: 3, len: 0.03, jitter: R * 0.5
            });
            this.ring(x, y, R * 0.3, R * 2.2, 0.7, 3, RAMP.spore);
            if (this.synth) this.synth.thump(1.6, x, y, 0.6);
        }
    }

    // Encounter dialog outcomes, made physical: gains converge INTO the
    // pilot, losses stream OUT of the pilot toward the other ship.
    encounterAction(type, player, enc) {
        if (!player) return;
        const px = player.worldX, py = player.worldY;
        const ex = enc ? enc.worldX : px + 200, ey = enc ? enc.worldY : py;
        const into = (ramp, n) => {
            for (let k = 0; k < n && this.sN < MAX_STREAKS; k++) {
                const a = Math.random() * TAU, d = 50 + Math.random() * 40, life = 0.35;
                const i = this.sN++;
                this.sX[i] = px + Math.cos(a) * d; this.sY[i] = py + Math.sin(a) * d;
                this.sVX[i] = -Math.cos(a) * d / life; this.sVY[i] = -Math.sin(a) * d / life;
                this.sLife[i] = this.sMax[i] = life; this.sDrag[i] = 0; this.sLen[i] = 0.03; this.sRamp[i] = ramp; this.sUnder[i] = 0;
            }
        };
        const outTo = (ramp, n) => {
            const a0 = Math.atan2(ey - py, ex - px), dist = Math.hypot(ex - px, ey - py);
            for (let k = 0; k < n; k++) {
                const sp = Math.max(260, dist * 1.6);
                this.streaks(px, py, 1, ramp, { dir: a0, spread: 0.35, speedMin: sp * 0.8, speedMax: sp, lifeMin: 0.45, lifeMax: 0.6, drag: 0.5, len: 0.03 });
            }
        };
        switch (type) {
            case 'add_perm_health': into(RAMP.heal, 14); this.ring(px, py, 8, 70, 0.45, 2, RAMP.heal); break;
            case 'add_perm_shield': into(RAMP.electric, 14); this.ring(px, py, 8, 70, 0.45, 2, RAMP.electric); break;
            case 'add_perm_damage': into(RAMP.hull, 14); this.ring(px, py, 8, 70, 0.45, 2, RAMP.hull); break;
            case 'add_perm_capacity': into(RAMP.gold, 14); this.ring(px, py, 8, 70, 0.45, 2, RAMP.gold); break;
            case 'give_battery': into(RAMP.electric, 10); this.star(px, py, 10, 0.3, RAMP.electric, 1); break;
            case 'add_upgrade': case 'random_rare_item': case 'random_any_item': case 'random_upgrade':
                into(RAMP.white, 12); this.star(px, py, 10, 0.3, RAMP.white, 1); break;
            case 'remove_scrap': outTo(RAMP.gold, 14); this.light(px, py, 40, 0.5, 0.3, LIGHT.red); break;
            case 'remove_item': case 'remove_battery': outTo(RAMP.white, 10); this.light(px, py, 40, 0.5, 0.3, LIGHT.red); break;
            case 'increase_spawns': case 'spawn_boss': {
                for (let k = 0; k < 4; k++) {
                    const a = Math.random() * TAU;
                    const b = this.bolt(ex, ey, ex + Math.cos(a) * 160, ey + Math.sin(a) * 160, 0.3, null, 0.4);
                    if (b) b.ramp = RAMP.blood;
                }
                this.light(ex, ey, 120, 0.7, 0.6, LIGHT.red, 1);
                if (this.synth) this.synth.thump(1.2, ex, ey, 0.5);
                break;
            }
            default: return;
        }
        if (this.synth && (type.startsWith('add_') || type === 'give_battery' || type.startsWith('random_'))) this.synth.chime(0.16);
    }

    // An encounter ship punches its engines and leaves: a flash and a spray
    // of ion streaks off the stern.
    warpOut(x, y, angle) {
        const back = angle + Math.PI;
        this.streaks(x, y, Math.round(16 * this._q()), RAMP.electric, {
            dir: back, spread: 0.5, speedMin: 300, speedMax: 700, lifeMin: 0.2, lifeMax: 0.45, drag: 3, len: 0.04
        });
        this.star(x - Math.cos(angle) * 20, y - Math.sin(angle) * 20, 10, 0.25, RAMP.electric, 1);
        this.light(x, y, 80, 0.7, 0.3, LIGHT.electric);
        if (this.synth) this.synth.warp(x, y, 0.18);
    }

    themeRamp(en) {
        if (en._fxTheme !== undefined) return en._fxTheme;
        const n = en.constructor && en.constructor.name;
        const t = BOSS_THEME[n];
        en._fxTheme = t ? RAMP[t] : RAMP.spark;
        return en._fxTheme;
    }

    // Per-frame signature particles for the big wave bosses.
    bossAmbient(en, dt) {
        const n = en.constructor && en.constructor.name;
        if (n !== 'Starcore' && n !== 'EventHorizon' && n !== 'AsteroidCrusher') return;
        const q = this._q();
        const R = en.radius || 100;
        const acc = en._fxBoss || (en._fxBoss = { a: 0, b: 0, c: 0, d: 0 });
        const mask = this._maskFor(en);
        if (n === 'Starcore') {
            // Solar flares: gold lightning crawling its rim; shed embers.
            acc.a -= dt;
            if (acc.a <= 0 && !this.game.lowPerfMode) {
                acc.a = 0.25 + Math.random() * 0.35;
                const a0 = Math.random() * TAU;
                const b = this.arcBolt(0, 0, R * (0.55 + Math.random() * 0.25), a0, a0 + 0.5 + Math.random() * 0.6, 0.22, en);
                if (b) b.ramp = RAMP.fire;
                this.light(en.worldX + Math.cos(a0) * R * 0.6, en.worldY + Math.sin(a0) * R * 0.6, 40, 0.45, 0.15, LIGHT.gold);
            }
            acc.b += dt * 10 * q;
            while (acc.b >= 1) {
                acc.b -= 1;
                this._hullPoint(en, mask, null, 0);
                const a = Math.atan2(this._hy - en.worldY, this._hx - en.worldX);
                this.streaks(this._hx, this._hy, 1, RAMP.fire, {
                    dir: a, spread: 0.8, speedMin: 50, speedMax: 160, lifeMin: 0.4, lifeMax: 0.9, drag: 1.5, len: 0.02
                });
            }
            // Mega-beam charge: fire is sucked into the muzzle, light swells.
            if (en.isChargingBeam) {
                const fa = en.angle || 0;
                const mx = en.worldX + Math.cos(fa) * R * 0.85, my = en.worldY + Math.sin(fa) * R * 0.85;
                acc.c += dt * 45 * q;
                while (acc.c >= 1 && this.sN < MAX_STREAKS) {
                    acc.c -= 1;
                    const a = Math.random() * TAU, d = 40 + Math.random() * 70, life = 0.22;
                    const i = this.sN++;
                    this.sX[i] = mx + Math.cos(a) * d; this.sY[i] = my + Math.sin(a) * d;
                    this.sVX[i] = -Math.cos(a) * d / life; this.sVY[i] = -Math.sin(a) * d / life;
                    this.sLife[i] = this.sMax[i] = life; this.sDrag[i] = 0; this.sLen[i] = 0.03; this.sRamp[i] = RAMP.fire; this.sUnder[i] = 0;
                }
                acc.d -= dt;
                if (acc.d <= 0) { acc.d = 0.08; this.light(mx, my, 50, 0.5, 0.1, LIGHT.fire, 1); }
            }
        } else if (n === 'EventHorizon') {
            // Accretion: matter spirals in from far out and vanishes at the core.
            acc.a += dt * 28 * q;
            while (acc.a >= 1 && this.sN < MAX_STREAKS) {
                acc.a -= 1;
                const a = Math.random() * TAU, d = R * (1.6 + Math.random() * 1.2);
                const inward = 140 + Math.random() * 80, tang = 170 + Math.random() * 80;
                const c = Math.cos(a), sn = Math.sin(a);
                const i = this.sN++;
                this.sX[i] = en.worldX + c * d; this.sY[i] = en.worldY + sn * d;
                this.sVX[i] = -c * inward - sn * tang; this.sVY[i] = -sn * inward + c * tang;
                this.sLife[i] = this.sMax[i] = (d - R * 0.4) / (inward + 60);
                this.sDrag[i] = 0; this.sLen[i] = 0.035; this.sRamp[i] = Math.random() < 0.3 ? RAMP.blood : RAMP.hull;
                this.sUnder[i] = 1;
            }
            acc.b -= dt;
            if (acc.b <= 0 && !this.game.lowPerfMode) {
                acc.b = 0.4 + Math.random() * 0.6;
                this._hullPoint(en, mask, null, 0);
                const ax = this._hx - en.worldX, ay = this._hy - en.worldY;
                this._hullPoint(en, mask, null, 0);
                const b = this.bolt(ax, ay, this._hx - en.worldX, this._hy - en.worldY, 0.2, en, 0.4);
                if (b) { b.ramp = RAMP.hull; b.under = true; }
            }
        } else {
            // Crusher: grinding dust off the hull.
            acc.a += dt * 4 * q;
            while (acc.a >= 1) {
                acc.a -= 1;
                this._hullPoint(en, mask, null, 0);
                const rp = 3 + Math.random() * 3;
                this.puff(this._hx, this._hy, (en._fxVX || 0) * 0.2 + (Math.random() - 0.5) * 20, (en._fxVY || 0) * 0.2 + (Math.random() - 0.5) * 20,
                    rp * 0.5, rp, rp * 1.4, 0.8 + Math.random() * 0.5, RAMP.dust, { drag: 1.5, top: 2 + (Math.random() < 0.5 ? 1 : 0) });
            }
        }
    }

    // Asteroid Crusher's tractor: a flickering lightning tether to the rock
    // it's hauling, dust shaking off the rock.
    tractor(boss, ast, dt) {
        ast._fxTether = (ast._fxTether || 0) - dt;
        if (ast._fxTether > 0) return;
        ast._fxTether = 0.09;
        const tb = this.bolt(boss.worldX, boss.worldY, ast.worldX, ast.worldY, 0.1, null, 0.18);
        if (tb) { tb.ramp = RAMP.hull; tb.under = true; }
        this.light(ast.worldX, ast.worldY, (ast.radius || 30) * 1.6, 0.4, 0.1, LIGHT.red);
        if (Math.random() < 0.5) {
            const a = Math.random() * TAU, r = (ast.radius || 30) * 0.7;
            this.puff(ast.worldX + Math.cos(a) * r, ast.worldY + Math.sin(a) * r, Math.cos(a) * 30, Math.sin(a) * 30,
                2, 4, 5, 0.6, RAMP.dust, { drag: 2, top: 3 });
        }
        if (this.synth && Math.random() < 0.15) this.synth.zap(ast.worldX, ast.worldY, 0.06);
    }

    // Item collected: a burst + rising fountain in its rarity's colours,
    // bigger the rarer it is.
    itemPickup(x, y, rarity) {
        const ramp = RARITY_RAMP[rarity] != null ? RARITY_RAMP[rarity] : RAMP.white;
        const tier = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, unique: 4 }[rarity] || 0;
        this.hitSpark(x, y, ramp);
        this.star(x, y, 6 + tier * 2, 0.22, ramp, 1);
        const n = 6 + tier * 5;
        for (let k = 0; k < n; k++) {
            const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, sp = 160 + Math.random() * 200 + tier * 30;
            this.star(x, y, 2 + (Math.random() < 0.3 ? 1 : 0), 0.6 + Math.random() * 0.4, ramp, 0,
                Math.cos(a) * sp, Math.sin(a) * sp, 560);
        }
        this.light(x, y, 40 + tier * 15, 0.6, 0.35, LIGHT.white);
    }

    // Interactable beacon: a periodic 8-ray glint + soft light pulse on a
    // nearby shop / cache / encounter ship ("you can use this").
    beacon(ent, ramp, period, dt) {
        ent._fxBeacon = (ent._fxBeacon == null ? Math.random() * period : ent._fxBeacon) - dt;
        if (ent._fxBeacon > 0) return;
        ent._fxBeacon = period;
        this.star(ent.worldX, ent.worldY, 7, 0.32, ramp, 1);
        this.light(ent.worldX, ent.worldY, 60, 0.35, 0.4, ramp === RAMP.gold ? LIGHT.gold : ramp === RAMP.electric ? LIGHT.electric : LIGHT.white);
    }

    // An encounter turns on you: red lightning bursts off its hull.
    hostileTurn(x, y, r = 40) {
        for (let k = 0; k < 6; k++) {
            const a = (k / 6) * TAU + Math.random() * 0.5;
            const b = this.bolt(x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4,
                x + Math.cos(a) * r * 2.2, y + Math.sin(a) * r * 2.2, 0.3, null, 0.4);
            if (b) b.ramp = RAMP.hull;
        }
        this.star(x, y, 12, 0.3, RAMP.hull, 1);
        this.light(x, y, r * 4, 0.8, 0.5, LIGHT.red, 1);
        if (this.synth) { this.synth.zap(x, y, 0.35); this.synth.thump(0.8, x, y, 0.4); }
    }

    // The pilot's ship is destroyed.
    playerDeath(x, y, ent = null) {
        this.explode(x, y, 40);
        this.shieldBreak(x, y, 30, ent);
        for (let k = 0; k < 4 && this.pending.length < MAX_PENDING; k++) {
            const a = Math.random() * TAU, d = 15 + Math.random() * 25;
            this.pending.push({ t: 0.1 + k * 0.12, x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, size: 20 + Math.random() * 12, kind: 0 });
        }
        this.ring(x, y, 10, 160, 0.7, 3, RAMP.hull);
        this.light(x, y, 160, 1, 0.8, LIGHT.hull);
    }

    // ══ Hull-aware damage, wrecks, arrivals, ambience ══════════════════════

    // Opaque logical-pixel offsets (centered) of an entity's sprite, or null.
    // Built from a small CPU-side canvas (willReadFrequently) at the sprite's
    // LOGICAL size — one cheap readback per sprite key, ever.
    _maskFor(en) {
        const key = en.spriteKey;
        let img = en.img;
        if (key && !img && this.game.assets) {
            const a = this.game.assets.get(key);
            img = Array.isArray(a) ? (a[0] && (a[0].canvas ? a[0] : null)) : a;
        }
        if (!key || !img) return null;
        let m = this._masks.get(key);
        if (m !== undefined) return m;
        if (this._maskBudget <= 0) return null;
        this._maskBudget--;
        const src = img.canvas || img;
        const w = Math.round(img.width || src.width), h = Math.round(img.height || src.height);
        m = null;
        if (w > 0 && h > 0 && w * h < 300 * 300) {
            try {
                const cv = document.createElement('canvas');
                cv.width = w; cv.height = h;
                const g = cv.getContext('2d', { willReadFrequently: true });
                g.imageSmoothingEnabled = false;
                g.drawImage(src, 0, 0, w, h);
                const d = g.getImageData(0, 0, w, h).data;
                const pts = [];
                for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
                    if (d[(y * w + x) * 4 + 3] > 140) pts.push(x + 0.5 - w / 2, y + 0.5 - h / 2);
                }
                // Subsample big hulls to ≤ 500 points.
                const n = pts.length >> 1;
                const stride = Math.max(1, Math.ceil(n / 500));
                const out = new Float32Array(Math.ceil(n / stride) * 2);
                let o = 0;
                for (let i = 0; i < n; i += stride) { out[o++] = pts[i * 2]; out[o++] = pts[i * 2 + 1]; }
                m = o ? out.subarray(0, o) : null;
            } catch (e) { m = null; }
        }
        this._masks.set(key, m);
        return m;
    }

    // Local sprite coords → world (sprites draw rotated by angle + π/2).
    _toWorld(en, lx, ly) {
        const a = (en.angle || 0) + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
        this._hx = en.worldX + lx * c - ly * s;
        this._hy = en.worldY + lx * s + ly * c;
    }

    // Pick an emission point ON the hull: a damage spot (jittered a pixel)
    // with probability `spotBias`, else any opaque pixel. Result in _hx/_hy.
    _hullPoint(en, mask, spots, spotBias) {
        if (spots && spots.length && Math.random() < spotBias) {
            const sp = spots[(Math.random() * spots.length) | 0];
            this._toWorld(en, sp[0] + (Math.random() - 0.5) * 2.5, sp[1] + (Math.random() - 0.5) * 2.5);
            return;
        }
        if (mask) {
            const k = ((Math.random() * (mask.length >> 1)) | 0) * 2;
            this._toWorld(en, mask[k], mask[k + 1]);
            return;
        }
        const a = Math.random() * TAU, d = Math.random() * (en.radius || 16) * 0.45;
        this._hx = en.worldX + Math.cos(a) * d; this._hy = en.worldY + Math.sin(a) * d;
    }

    // Record where a shot landed (snapped to the nearest hull pixel) — fire
    // breaks out where you actually hit the ship.
    markDamage(en, x, y) {
        const mask = this._maskFor(en);
        if (!mask) return;
        const a = (en.angle || 0) + Math.PI / 2, c = Math.cos(a), s = Math.sin(a);
        const dx = x - en.worldX, dy = y - en.worldY;
        const lx = dx * c + dy * s, ly = -dx * s + dy * c;
        let best = 1e9, bx = 0, by = 0;
        for (let k = 0; k < mask.length; k += 2) {
            const ex = mask[k] - lx, ey = mask[k + 1] - ly, d = ex * ex + ey * ey;
            if (d < best) { best = d; bx = mask[k]; by = mask[k + 1]; }
        }
        const spots = en._fxSpots || (en._fxSpots = []);
        for (const sp of spots) {
            const ex = sp[0] - bx, ey = sp[1] - by;
            if (ex * ex + ey * ey < 9) return;
        }
        if (spots.length < 6) spots.push([bx, by]);
        else spots[(Math.random() * 6) | 0] = [bx, by];
    }

    // Make sure a badly damaged ship has enough burn spots (random hull
    // pixels) even if its hits came from elsewhere (MP, beams, bombs).
    _ensureSpots(en, mask, want) {
        const spots = en._fxSpots || (en._fxSpots = []);
        if (!mask) return spots;
        while (spots.length < want) {
            const k = ((Math.random() * (mask.length >> 1)) | 0) * 2;
            spots.push([mask[k], mask[k + 1]]);
        }
        return spots;
    }

    // A ship materializes: streaks get sucked into the arrival point, then a
    // flash, a star and a small solid ring snap out — "something just warped
    // in, right there".
    warpIn(x, y, size = 18, ramp = RAMP.electric) {
        const n = this.game.lowPerfMode ? 6 : 12;
        for (let k = 0; k < n && this.sN < MAX_STREAKS; k++) {
            const a = (k / n) * TAU + Math.random() * 0.3;
            const R = size * (2.5 + Math.random() * 1.5);
            const life = 0.16 + Math.random() * 0.05;
            const sp = R / life;
            const i = this.sN++;
            this.sX[i] = x + Math.cos(a) * R; this.sY[i] = y + Math.sin(a) * R;
            this.sVX[i] = -Math.cos(a) * sp; this.sVY[i] = -Math.sin(a) * sp;
            this.sLife[i] = this.sMax[i] = life;
            this.sDrag[i] = 0; this.sLen[i] = 0.035; this.sRamp[i] = ramp; this.sUnder[i] = 0;
        }
        this.pending.push({ t: 0.17, x, y, size, kind: 2 });
        if (this.synth) this.synth.warp(x, y);
    }

    _warpFlash(x, y, size) {
        this.hitSpark(x, y, RAMP.white);
        this.star(x, y, Math.round(6 + size * 0.2), 0.2, RAMP.electric, 1);
        this.ring(x, y, size * 0.3, size * 1.8, 0.3, 2, RAMP.electric);
        this.light(x, y, size * 3, 0.7, 0.25, LIGHT.electric);
    }

    // A wreck chunk keeps burning as it tumbles away.
    smolder(piece, dur = 1.6) {
        if (this.smolders.length >= 24 || !piece) return;
        this.smolders.push({ p: piece, t: 0, dur, acc: Math.random() });
    }

    // Enemy fires: a red muzzle pop + light — readable telegraph. Budgeted.
    enemyMuzzle(x, y, angle) {
        if (this._muzzleBudget <= 0) return;
        this._muzzleBudget--;
        this.star(x, y, 3, 0.08, RAMP.hull, 0);
        this.light(x, y, 18, 0.5, 0.08, LIGHT.red);
    }

    // Railgun pierce: a hit plus electric crackle across the target.
    railHit(x, y, dx, dy, en) {
        this.hit(x, y, -dx, -dy, dx, dy);
        if (!this.game.lowPerfMode) {
            const px = -dy, py = dx, r = (en.radius || 16) * 0.9;
            this.bolt(x - px * r, y - py * r, x + px * r, y + py * r, 0.16, null, 0.35);
        }
        this.light(x, y, 30, 0.6, 0.12, LIGHT.electric);
        this.markDamage(en, x, y);
    }

    // Per-frame: rocket/missile smoke trails, bomb beacons.
    tickProjectiles(projectiles, dt) {
        const q = this._q();
        for (let i = 0; i < projectiles.length; i++) {
            const p = projectiles[i];
            if (!p.alive) continue;
            if (p.isRocket) {
                p._fxAcc = (p._fxAcc || 0) + dt * 40 * q;
                const vx = p.vx || 0, vy = p.vy || 0;
                while (p._fxAcc >= 1) {
                    p._fxAcc -= 1;
                    this.puff(p.worldX - vx * 0.012, p.worldY - vy * 0.012,
                        -vx * 0.05 + (Math.random() - 0.5) * 18, -vy * 0.05 + (Math.random() - 0.5) * 18,
                        1.5, 2.5 + Math.random(), 4 + Math.random() * 2, 0.45 + Math.random() * 0.3, RAMP.smoke,
                        { drag: 2, top: 3 + (Math.random() < 0.4 ? 1 : 0) });
                    if (Math.random() < 0.5) {
                        this.puff(p.worldX - vx * 0.01, p.worldY - vy * 0.01, -vx * 0.15, -vy * 0.15,
                            1, 1.6, 0.4, 0.09, RAMP.fire, { drag: 4 });
                    }
                }
            } else if (p.isBomb) {
                p._fxBlink = (p._fxBlink || Math.random() * 0.7) - dt;
                if (p._fxBlink <= 0) {
                    p._fxBlink = 0.7;
                    this.star(p.worldX, p.worldY, 2, 0.12, RAMP.hull, 0);
                    this.light(p.worldX, p.worldY, 16, 0.45, 0.12, LIGHT.red);
                }
            }
        }
    }

    // Idle scrap twinkles — the loot field glitters and invites you over.
    tickScrap(scrap, dt) {
        const n = scrap.length;
        if (!n) return;
        this._glintAcc += dt * Math.min(7, n * 0.12);
        let guard = 4;
        while (this._glintAcc >= 1 && guard-- > 0) {
            this._glintAcc -= 1;
            const s = scrap[(Math.random() * n) | 0];
            if (!s.alive) continue;
            this.star(s.worldX + (Math.random() - 0.5) * 4, s.worldY + (Math.random() - 0.5) * 4,
                2 + (Math.random() < 0.3 ? 1 : 0), 0.24, RAMP.gold, 0);
        }
        if (this._glintAcc > 2) this._glintAcc = 0;
    }

    // Healing reads on the hull: green motes rise off the ship in proportion
    // to HP gained; a big heal (≥35% max) adds a ring, light and chime.
    tickPilots(pilots, dt) {
        for (let i = 0; i < pilots.length; i++) {
            const p = pilots[i];
            if (p._fxHp === undefined || p.dead) { p._fxHp = p.health; continue; }
            const gain = p.health - p._fxHp;
            p._fxHp = p.health;
            if (!(gain > 0)) continue;
            const max = p.maxHealth || 100;
            p._fxHeal = (p._fxHeal || 0) + (gain / max) * 40;
            let n = 0;
            while (p._fxHeal >= 1 && n++ < 8) {
                p._fxHeal -= 1;
                const a = Math.random() * TAU, d = Math.random() * (p.radius || 16) * 0.9;
                this.star(p.worldX + Math.cos(a) * d, p.worldY + Math.sin(a) * d, 2, 0.55 + Math.random() * 0.3,
                    RAMP.heal, 0, (Math.random() - 0.5) * 20, -40 - Math.random() * 40, 0);
            }
            if (gain >= max * 0.35) {
                this.ring(p.worldX, p.worldY, 8, 70, 0.45, 2, RAMP.heal);
                this.light(p.worldX, p.worldY, 60, 0.6, 0.4, LIGHT.heal);
                if (this.synth) this.synth.chime(0.18);
            }
        }
    }

    // Railgun chain lightning: jagged arcs hop between everything one beam
    // damaged, in order along the beam. `chain` = flat [dist, x, y] triples.
    // Capped per beam and by a refilling budget so late-game railgun spam
    // can't flood the bolt pool or the frame.
    chainLightning(chain) {
        const n = (chain.length / 3) | 0;
        if (n < 2) return;
        const order = this._chainOrder || (this._chainOrder = []);
        order.length = 0;
        for (let i = 0; i < n; i++) order.push(i);
        order.sort((a, b) => chain[a * 3] - chain[b * 3]);
        const maxLinks = this.game.lowPerfMode ? 3 : 8;
        let links = 0;
        for (let k = 0; k < n - 1 && links < maxLinks && this._chainBudget >= 1; k++) {
            const a = order[k] * 3, b = order[k + 1] * 3;
            const x0 = chain[a + 1], y0 = chain[a + 2], x1 = chain[b + 1], y1 = chain[b + 2];
            if (!this.bolt(x0, y0, x1, y1, 0.28, null, 0.42)) break;
            this._chainBudget -= 1;
            links++;
            this.star(x1, y1, 5, 0.16, RAMP.electric, 1);
            this.light((x0 + x1) / 2, (y0 + y1) / 2, 40, 0.5, 0.18, LIGHT.electric);
        }
        if (links) {
            const a = order[0] * 3;
            this.star(chain[a + 1], chain[a + 2], 5, 0.16, RAMP.electric, 1);
            if (this.synth) this.synth.zap(chain[a + 1], chain[a + 2], 0.25);
        }
    }

    // ── Distant skirmishes (parallax background) ───────────────────────────
    // Far behind the action, a small fleet battle plays out at parallax 0.3,
    // faded so it reads as distance. Each side: a slow capital ship firing
    // broadsides and launching smoking missiles, plus fighters flying real
    // attack runs (dive in → burst fire → overshoot → wide turn back →
    // re-engage). Damaged fighters trail smoke; killed ones tumble away
    // trailing fire before they pop; capitals die in a chain of explosions.
    tickSkirmish(dt, camera) {
        this._skirmishT -= dt;
        if (this._skirmishT <= 0 && camera && this.skirmishes.length < 1) {
            this._skirmishT = 35 + Math.random() * 35;
            this.skirmishes.push(this._newSkirmish(camera));
        }
        for (let i = this.skirmishes.length - 1; i >= 0; i--) {
            const k = this.skirmishes[i];
            k.t += dt;
            if (k.t >= k.dur) { this.skirmishes.splice(i, 1); continue; }
            for (const sh of k.ships) this._skirmishShip(k, sh, dt);
            this._skirmishShots(k, dt);
        }
        for (let i = this.skirmishBits.length - 1; i >= 0; i--) {
            const b = this.skirmishBits[i];
            b.t += dt;
            if (b.t >= b.dur) { this.skirmishBits[i] = this.skirmishBits[this.skirmishBits.length - 1]; this.skirmishBits.pop(); continue; }
            if (b.t >= 0) { b.x += b.vx * dt; b.y += b.vy * dt; }
        }
    }

    _newSkirmish(camera) {
        const S = camera.wtsScale || 1;
        const halfW = this.game.width / (2 * S), halfH = this.game.height / (2 * S);
        const cx = camera.x * 0.3 + (Math.random() - 0.5) * halfW * 1.2;
        const cy = camera.y * 0.3 + (Math.random() - 0.5) * halfH * 1.1;
        const axis = Math.random() * TAU;
        const ships = [];
        for (let team = 0; team < 2; team++) {
            const sa = axis + team * Math.PI;           // this side's home direction
            const face = sa + Math.PI;                   // facing the enemy
            const hx = cx + Math.cos(sa) * 85, hy = cy + Math.sin(sa) * 55;
            if (Math.random() < 0.8) {
                ships.push({ x: hx, y: hy, ang: face + Math.PI / 2 * (Math.random() < 0.5 ? 1 : -1) * 0.6,
                    team, cap: true, hp: 10, max: 10, spd: 5, turn: 0.15, cool: 1, mcool: 2 + Math.random() * 2,
                    flash: 0, dead: false, dying: 0, mode: 0, modeT: 0, spin: 0, trail: 0 });
            }
            const n = 3 + ((Math.random() * 3) | 0);
            for (let j = 0; j < n; j++) {
                ships.push({ x: hx + (Math.random() - 0.5) * 40, y: hy + (Math.random() - 0.5) * 40,
                    ang: face + (Math.random() - 0.5) * 0.5, team, cap: false, hp: 2 + ((Math.random() * 2) | 0), max: 3,
                    spd: 55 + Math.random() * 25, turn: 2.6 + Math.random() * 0.8, cool: Math.random() * 0.6, burst: 0,
                    flash: 0, dead: false, dying: 0, mode: 0, modeT: Math.random() * 0.5, spin: 0, trail: 0, tgt: null });
            }
        }
        return { t: 0, dur: 11 + Math.random() * 5, ships, shots: [] };
    }

    _nearestFoe(k, sh, preferCap) {
        let best = null, bd = 1e9;
        for (const o of k.ships) {
            if (o.dead || o.dying || o.team === sh.team) continue;
            let d = (o.x - sh.x) * (o.x - sh.x) + (o.y - sh.y) * (o.y - sh.y);
            if (preferCap && o.cap) d *= 0.5;
            if (d < bd) { bd = d; best = o; }
        }
        return best;
    }

    _skirmishShip(k, sh, dt) {
        if (sh.dead) return;
        sh.flash = Math.max(0, sh.flash - dt);
        const c = Math.cos(sh.ang), s = Math.sin(sh.ang);

        // Death throes: fighters tumble away streaming fire; capitals shudder
        // and burst in a chain before they go.
        if (sh.dying > 0) {
            sh.dying -= dt;
            sh.ang += sh.spin * dt;
            sh.x += c * sh.spd * 0.6 * dt; sh.y += s * sh.spd * 0.6 * dt;
            sh.trail -= dt;
            if (sh.trail <= 0 && this.skirmishBits.length < 120) {
                sh.trail = sh.cap ? 0.12 : 0.04;
                const r = sh.cap ? 6 : 1;
                this.skirmishBits.push({ x: sh.x + (Math.random() - 0.5) * r * 2, y: sh.y + (Math.random() - 0.5) * r * 2, vx: 0, vy: 0, t: 0,
                    dur: sh.cap ? 0.4 : 0.3, kind: sh.cap ? 2 : 1, ramp: RAMP.fire });
            }
            if (sh.dying <= 0) {
                sh.dead = true;
                this._skirmishPop(sh.x, sh.y, sh.cap ? 10 : 5, sh.cap);
            }
            return;
        }

        // Smoke from a damaged hull.
        if (sh.hp < sh.max * 0.5) {
            sh.trail -= dt;
            if (sh.trail <= 0 && this.skirmishBits.length < 120) {
                sh.trail = 0.07;
                this.skirmishBits.push({ x: sh.x - c * 2, y: sh.y - s * 2, vx: 0, vy: 0, t: 0, dur: 0.6, kind: 3, ramp: RAMP.smoke });
            }
        }

        if (sh.cap) {
            // Capital: lumbers on, broadsides at whatever's near, launches missiles.
            sh.x += c * sh.spd * dt; sh.y += s * sh.spd * dt;
            sh.cool -= dt;
            const foe = this._nearestFoe(k, sh, false);
            if (foe && sh.cool <= 0) {
                sh.cool = 0.25 + Math.random() * 0.3;
                const ox = (Math.random() - 0.5) * 8, oy = (Math.random() - 0.5) * 8;
                const a = Math.atan2(foe.y - sh.y - oy, foe.x - sh.x - ox) + (Math.random() - 0.5) * 0.25;
                k.shots.push({ x: sh.x + ox, y: sh.y + oy, vx: Math.cos(a) * 110, vy: Math.sin(a) * 110, t: 0, team: sh.team, msl: false, life: 1.4 });
            }
            sh.mcool -= dt;
            if (foe && sh.mcool <= 0) {
                sh.mcool = 2.2 + Math.random() * 2;
                const a = sh.ang + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
                k.shots.push({ x: sh.x, y: sh.y, vx: Math.cos(a) * 30, vy: Math.sin(a) * 30, t: 0, team: sh.team, msl: true, life: 3, tgt: foe });
            }
            return;
        }

        // Fighter: attack run → overshoot → wide turn → re-engage.
        sh.modeT -= dt;
        if (!sh.tgt || sh.tgt.dead || sh.tgt.dying) sh.tgt = this._nearestFoe(k, sh, Math.random() < 0.3);
        const tgt = sh.tgt;
        let want = sh.ang, spd = sh.spd;
        if (sh.mode === 0 && tgt) {                       // attack run
            want = Math.atan2(tgt.y - sh.y, tgt.x - sh.x);
            const d2 = (tgt.x - sh.x) * (tgt.x - sh.x) + (tgt.y - sh.y) * (tgt.y - sh.y);
            let da = want - sh.ang;
            while (da > Math.PI) da -= TAU;
            while (da < -Math.PI) da += TAU;
            sh.cool -= dt;
            if (Math.abs(da) < 0.3 && d2 < 150 * 150 && sh.cool <= 0) { sh.burst = 3; sh.cool = 1.0 + Math.random() * 0.6; }
            // Break off and blow past when close, when the target slips behind
            // (it out-turned us), or when the run drags on — never orbit.
            const close = tgt.cap ? 40 : 34;
            if (d2 < close * close || (Math.abs(da) > 1.3 && d2 < 80 * 80) || sh.modeT < -2.6) {
                sh.mode = 1; sh.modeT = 0.7 + Math.random() * 0.7;
            }
        } else if (sh.mode === 1) {                        // overshoot: straight, fast
            spd *= 1.35;
            if (sh.modeT <= 0) { sh.mode = 2; sh.modeT = 0.8 + Math.random() * 0.6; sh.bank = Math.random() < 0.5 ? 1 : -1; }
        } else {                                           // wide banking turn back in
            want = sh.ang + sh.bank * 1.2;
            if (sh.modeT <= 0) { sh.mode = 0; sh.modeT = 0; sh.tgt = null; }
        }
        let da = want - sh.ang;
        while (da > Math.PI) da -= TAU;
        while (da < -Math.PI) da += TAU;
        sh.ang += Math.max(-sh.turn * dt, Math.min(sh.turn * dt, da));
        sh.x += Math.cos(sh.ang) * spd * dt;
        sh.y += Math.sin(sh.ang) * spd * dt;

        // Burst fire from the nose.
        if (sh.burst > 0) {
            sh.bcool = (sh.bcool || 0) - dt;
            if (sh.bcool <= 0 && k.shots.length < 60) {
                sh.bcool = 0.07;
                sh.burst--;
                const cc = Math.cos(sh.ang), ss = Math.sin(sh.ang);
                k.shots.push({ x: sh.x + cc * 3, y: sh.y + ss * 3, vx: cc * 190 + cc * spd, vy: ss * 190 + ss * spd,
                    t: 0, team: sh.team, msl: false, life: 0.8 });
            }
        }
    }

    _skirmishShots(k, dt) {
        for (let j = k.shots.length - 1; j >= 0; j--) {
            const l = k.shots[j];
            l.t += dt;
            if (l.msl) {
                // Missile: drifts out, then burns hard at its target, smoking.
                const tg = l.tgt;
                if (l.t > 0.4 && tg && !tg.dead) {
                    const a = Math.atan2(tg.y - l.y, tg.x - l.x);
                    l.vx += Math.cos(a) * 220 * dt; l.vy += Math.sin(a) * 220 * dt;
                    const sp = Math.sqrt(l.vx * l.vx + l.vy * l.vy);
                    if (sp > 95) { l.vx *= 95 / sp; l.vy *= 95 / sp; }
                }
                l.trail = (l.trail || 0) - dt;
                if (l.trail <= 0 && this.skirmishBits.length < 120) {
                    l.trail = 0.05;
                    this.skirmishBits.push({ x: l.x, y: l.y, vx: 0, vy: 0, t: 0, dur: 0.7, kind: 3, ramp: RAMP.smoke });
                }
            }
            l.x += l.vx * dt; l.y += l.vy * dt;
            let hit = null;
            for (const o of k.ships) {
                if (o.dead || o.dying || o.team === l.team) continue;
                const r = o.cap ? 6 : 3;
                if ((o.x - l.x) * (o.x - l.x) + (o.y - l.y) * (o.y - l.y) < r * r) { hit = o; break; }
            }
            if (!hit && l.t < l.life) continue;
            k.shots[j] = k.shots[k.shots.length - 1]; k.shots.pop();
            if (!hit) continue;
            hit.flash = 0.08;
            if (this.skirmishBits.length < 120) {
                this.skirmishBits.push({ x: l.x, y: l.y, vx: 0, vy: 0, t: 0, dur: l.msl ? 0.35 : 0.16, kind: l.msl ? 2 : 1, ramp: RAMP.fire });
            }
            hit.hp -= l.msl ? 3 : 1;
            if (hit.hp <= 0) {
                hit.dying = hit.cap ? 1.4 : 0.5 + Math.random() * 0.4;
                hit.spin = (Math.random() < 0.5 ? -1 : 1) * (hit.cap ? 0.4 : 6 + Math.random() * 5);
                if (!hit.cap) this._skirmishPop(hit.x, hit.y, 2, false);
            }
        }
    }

    _skirmishPop(x, y, n, big) {
        for (let q = 0; q < n && this.skirmishBits.length < 120; q++) {
            const a = Math.random() * TAU, sp = (big ? 15 : 20) + Math.random() * (big ? 45 : 40);
            const d = big ? Math.random() * 6 : 0;
            this.skirmishBits.push({ x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                t: -(big ? Math.random() * 0.4 : 0), dur: big ? 0.5 : 0.35, kind: big && q % 3 === 0 ? 2 : 1, ramp: RAMP.fire });
        }
        this.skirmishBits.push({ x, y, vx: 0, vy: 0, t: 0, dur: big ? 0.6 : 0.4, kind: 2, ramp: RAMP.fire });
        if (this.synth) this.synth.thump(big ? 0.4 : 0.15, null, null, big ? 0.1 : 0.06);
    }

    drawBackground(ctx, camera) {
        if (!this.skirmishes.length && !this.skirmishBits.length) return;
        const S = camera.wtsScale, pix = Math.max(1, Math.round(this.game.worldScale));
        const cx = camera.wtsOffX + camera.x * S, cy = camera.wtsOffY + camera.y * S;
        const P = 0.3, ox = camera.x * P, oy = camera.y * P;
        const W = this.game.width, H = this.game.height;
        const snap = (v) => Math.round(v / pix) * pix;
        ctx.save();
        for (const k of this.skirmishes) {
            const fade = Math.min(1, k.t / 0.8, (k.dur - k.t) / 1.0);
            for (const l of k.shots) {
                const x0 = cx + (l.x - ox) * S, y0 = cy + (l.y - oy) * S;
                if (l.msl) {
                    ctx.globalAlpha = 0.7 * fade;
                    ctx.fillStyle = '#ffd865';
                    ctx.fillRect(snap(x0), snap(y0), pix, pix);
                    continue;
                }
                ctx.globalAlpha = 0.6 * fade;
                ctx.fillStyle = l.team ? '#7fb0ff' : '#ff7a6a';
                const sp = Math.sqrt(l.vx * l.vx + l.vy * l.vy) || 1;
                for (let q = 0; q < 3; q++) {
                    ctx.fillRect(snap(x0 - l.vx / sp * q * S), snap(y0 - l.vy / sp * q * S), pix, pix);
                }
            }
            for (const sh of k.ships) {
                if (sh.dead) continue;
                const sx = cx + (sh.x - ox) * S, sy = cy + (sh.y - oy) * S;
                if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
                ctx.globalAlpha = (sh.dying > 0 ? 0.4 : 0.5) * fade;
                const c = Math.cos(sh.ang), sn = Math.sin(sh.ang);
                // Fighters: nose 3, wings 2 back/2 out. Capitals: long wedge.
                const nose = sh.cap ? 7 : 3, back = sh.cap ? 5 : 2, half = sh.cap ? 3 : 2;
                const ax = c * nose, ay = sn * nose;
                const bx = -c * back - sn * half, by = -sn * back + c * half;
                const qx = -c * back + sn * half, qy = -sn * back - c * half;
                const body = sh.flash > 0 ? '#ffffff' : sh.team ? '#4a78d8' : '#d04848';
                const lit = sh.team ? '#a8c4ff' : '#ffa090';
                const ext = nose + 1;
                for (let j = -ext; j <= ext; j++) {
                    for (let i = -ext; i <= ext; i++) {
                        if (!inTri(i, j, ax, ay, bx, by, qx, qy)) continue;
                        const fwd = i * c + j * sn;
                        ctx.fillStyle = sh.flash > 0 ? body : fwd > nose - 2 ? lit : body;
                        ctx.fillRect(snap(sx) + i * pix, snap(sy) + j * pix, pix, pix);
                    }
                }
            }
        }
        for (const b of this.skirmishBits) {
            if (b.t < 0) continue;
            const u = b.t / b.dur;
            const base = RAMP_BASE[b.ramp];
            const sx = snap(cx + (b.x - ox) * S), sy = snap(cy + (b.y - oy) * S);
            if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
            if (b.kind === 3) {
                // Smoke puff: one dim pixel stepping darker.
                ctx.globalAlpha = 0.6;
                ctx.fillStyle = PALETTE[base + (u < 0.4 ? 3 : u < 0.75 ? 2 : 1)];
                ctx.fillRect(sx, sy, pix, pix);
            } else if (b.kind === 1) {
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = PALETTE[base + (u < 0.4 ? 3 : 1)];
                ctx.fillRect(sx, sy, pix, pix);
            } else {
                ctx.globalAlpha = 0.7;
                ctx.fillStyle = PALETTE[base + (u < 0.3 ? 4 : u < 0.6 ? 2 : 1)];
                ctx.fillRect(sx - pix, sy, pix * 3, pix);
                ctx.fillRect(sx, sy - pix, pix, pix * 3);
                if (u < 0.3) { ctx.fillRect(sx - 2 * pix, sy, pix, pix); ctx.fillRect(sx + 2 * pix, sy, pix, pix); }
            }
        }
        ctx.restore();
    }

    // ══ Update ═════════════════════════════════════════════════════════════

    // Build smoke/dust cloud sprites a few per frame in the background so
    // the first explosions of a run never pay for them (~10s to finish).
    _warmStep() {
        const per = 3;
        for (let k = 0; k < per; k++) {
            let i = this._warm++;
            const L = i % CLOUD_EROSION; i = (i / CLOUD_EROSION) | 0;
            const si = i % CLOUD_SIZES.length; i = (i / CLOUD_SIZES.length) | 0;
            const v = i % CLOUD_VARIANTS; i = (i / CLOUD_VARIANTS) | 0;
            const top = 1 + (i % 4); i = (i / 4) | 0;
            if (i >= 2) { this._warmDone = true; return; }
            this._cloudSprite(i === 0 ? RAMP.smoke : RAMP.dust, v, si, L, top);
        }
    }

    update(dt) {
        this.time += dt;
        if (!this._warmDone) this._warmStep();
        this._maskBudget = 1;
        this._muzzleBudget = Math.min(6, this._muzzleBudget + dt * 40);
        this._warpBudget = Math.min(4, (this._warpBudget || 0) + dt * 6);
        this._chainBudget = Math.min(16, (this._chainBudget || 0) + dt * 30);

        // Burning wreck chunks: smoke + embers, tapering off.
        for (let i = this.smolders.length - 1; i >= 0; i--) {
            const sm = this.smolders[i];
            sm.t += dt;
            const pc = sm.p;
            if (sm.t >= sm.dur || !pc.alive) { this.smolders[i] = this.smolders[this.smolders.length - 1]; this.smolders.pop(); continue; }
            const u = sm.t / sm.dur;
            sm.acc += dt * 16 * (1 - u) * this._q();
            while (sm.acc >= 1) {
                sm.acc -= 1;
                this.puff(pc.worldX, pc.worldY, (pc.vx || 0) * 0.2 + (Math.random() - 0.5) * 14, (pc.vy || 0) * 0.2 + (Math.random() - 0.5) * 14,
                    1.2, 2 + Math.random() * 1.5, 3.5 + Math.random() * 2, 0.5 + Math.random() * 0.4, RAMP.smoke,
                    { drag: 1.8, top: u < 0.4 ? 3 : 2 });
                if (Math.random() < 0.45 * (1 - u)) {
                    this.puff(pc.worldX, pc.worldY, (pc.vx || 0) * 0.6, (pc.vy || 0) * 0.6, 0.8, 1.6, 0.3, 0.14, RAMP.fire, { drag: 3 });
                }
            }
        }

        for (let i = this.sN - 1; i >= 0; i--) {
            const life = this.sLife[i] - dt;
            if (life <= 0) { this._killStreak(i); continue; }
            this.sLife[i] = life;
            const d = Math.exp(-this.sDrag[i] * dt);
            this.sVX[i] *= d; this.sVY[i] *= d;
            this.sX[i] += this.sVX[i] * dt;
            this.sY[i] += this.sVY[i] * dt;
        }
        for (let i = this.pN - 1; i >= 0; i--) {
            const t = this.pT[i] + dt;
            if (t >= this.pDur[i]) { this._killPuff(i); continue; }
            this.pT[i] = t;
            if (t < 0) continue;
            const d = Math.exp(-this.pDrag[i] * dt);
            this.pVX[i] *= d; this.pVY[i] *= d;
            this.pX[i] += this.pVX[i] * dt;
            this.pY[i] += this.pVY[i] * dt;
        }
        for (let i = this.fN - 1; i >= 0; i--) {
            this.fT[i] += dt;
            if (this.fT[i] >= this.fDur[i]) { this._killStar(i); continue; }
            this.fVY[i] += this.fG[i] * dt;
            if (this.fG[i]) { const d = Math.exp(-1.2 * dt); this.fVX[i] *= d; }
            this.fX[i] += this.fVX[i] * dt;
            this.fY[i] += this.fVY[i] * dt;
        }
        for (let i = this.hN - 1; i >= 0; i--) {
            this.hT[i] += dt;
            if (this.hT[i] >= HIT_FRAME * 3) this._killHit(i);
        }
        for (let i = this.rN - 1; i >= 0; i--) {
            this.rT[i] += dt;
            if (this.rT[i] >= this.rDur[i]) this._killRing(i);
        }
        for (let i = this.lN - 1; i >= 0; i--) {
            this.lT[i] += dt;
            if (this.lT[i] >= this.lDur[i]) this._killLight(i);
        }
        if (this.bN) {
            for (const b of this.bolts) {
                if (!b.live) continue;
                b.t += dt;
                if (b.t >= b.dur || (b.ent && b.ent.alive === false && b.mode === 1)) { b.live = false; this.bN--; }
            }
        }
        for (let i = this.pending.length - 1; i >= 0; i--) {
            const p = this.pending[i];
            p.t -= dt;
            if (p.t > 0) continue;
            this.pending[i] = this.pending[this.pending.length - 1];
            this.pending.pop();
            if (p.kind === 0) {
                this.explode(p.x, p.y, p.size, 0, 0);
            } else if (p.kind === 2) {
                this._warpFlash(p.x, p.y, p.size);
            } else if (p.kind === 4) {
                this.hitSpark(p.x, p.y, RAMP.abyss);
                this.star(p.x, p.y, 18, 0.35, RAMP.abyss, 1);
                this.ring(p.x, p.y, p.size * 0.2, p.size * 3, 0.7, 4, RAMP.abyss);
                this.streaks(p.x, p.y, Math.round(40 * this._q()), RAMP.abyss, {
                    speedMin: 300, speedMax: 900, lifeMin: 0.3, lifeMax: 0.7, drag: 2.5, len: 0.04
                });
                if (this.synth) this.synth.thump(2, p.x, p.y, 0.7);
            } else if (p.kind === 3) {
                this.hitSpark(p.x, p.y, RAMP.white);
                this.star(p.x, p.y, 18, 0.35, RAMP.hull, 1);
                this.ring(p.x, p.y, p.size * 0.2, p.size * 3, 0.7, 4, RAMP.blood);
                this.light(p.x, p.y, p.size * 3, 1, 0.6, LIGHT.red);
                this.streaks(p.x, p.y, Math.round(40 * this._q()), RAMP.hull, {
                    speedMin: 300, speedMax: 900, lifeMin: 0.3, lifeMax: 0.7, drag: 2.5, len: 0.04
                });
                if (this.synth) this.synth.thump(2, p.x, p.y, 0.7);
            } else {
                const a = Math.random() * TAU, d = p.size * (0.8 + Math.random() * 1.2);
                this.bolt(p.x, p.y, p.x + Math.cos(a) * d, p.y + Math.sin(a) * d, 0.24, null, 0.3);
                this.light(p.x, p.y, p.size, 0.5, 0.12, LIGHT.electric);
                if (this.synth) this.synth.zap(p.x, p.y, 0.3);
            }
        }
        for (let i = this.sunbursts.length - 1; i >= 0; i--) {
            const s = this.sunbursts[i];
            s.t += dt;
            if (s.t >= s.dur) this.sunbursts.splice(i, 1);
        }
    }

    _killStreak(i) {
        const j = --this.sN; if (i === j) return;
        this.sX[i] = this.sX[j]; this.sY[i] = this.sY[j]; this.sVX[i] = this.sVX[j]; this.sVY[i] = this.sVY[j];
        this.sLife[i] = this.sLife[j]; this.sMax[i] = this.sMax[j]; this.sDrag[i] = this.sDrag[j];
        this.sLen[i] = this.sLen[j]; this.sRamp[i] = this.sRamp[j]; this.sUnder[i] = this.sUnder[j];
    }
    _killPuff(i) {
        const j = --this.pN; if (i === j) return;
        this.pX[i] = this.pX[j]; this.pY[i] = this.pY[j]; this.pVX[i] = this.pVX[j]; this.pVY[i] = this.pVY[j];
        this.pT[i] = this.pT[j]; this.pDur[i] = this.pDur[j]; this.pR0[i] = this.pR0[j]; this.pR1[i] = this.pR1[j];
        this.pR2[i] = this.pR2[j]; this.pDrag[i] = this.pDrag[j]; this.pRamp[i] = this.pRamp[j];
        this.pTop[i] = this.pTop[j]; this.pSmoke[i] = this.pSmoke[j]; this.pVar[i] = this.pVar[j];
    }
    _killStar(i) {
        const j = --this.fN; if (i === j) return;
        this.fX[i] = this.fX[j]; this.fY[i] = this.fY[j]; this.fVX[i] = this.fVX[j]; this.fVY[i] = this.fVY[j];
        this.fG[i] = this.fG[j]; this.fT[i] = this.fT[j]; this.fDur[i] = this.fDur[j];
        this.fLen[i] = this.fLen[j]; this.fRamp[i] = this.fRamp[j]; this.fDiag[i] = this.fDiag[j];
    }
    _killHit(i) {
        const j = --this.hN; if (i === j) return;
        this.hX[i] = this.hX[j]; this.hY[i] = this.hY[j]; this.hT[i] = this.hT[j]; this.hRamp[i] = this.hRamp[j];
    }
    _killRing(i) {
        const j = --this.rN; if (i === j) return;
        this.rX[i] = this.rX[j]; this.rY[i] = this.rY[j]; this.rT[i] = this.rT[j]; this.rDur[i] = this.rDur[j];
        this.rR0[i] = this.rR0[j]; this.rR1[i] = this.rR1[j]; this.rW[i] = this.rW[j]; this.rRamp[i] = this.rRamp[j];
    }
    _killLight(i) {
        const j = --this.lN; if (i === j) return;
        this.lX[i] = this.lX[j]; this.lY[i] = this.lY[j]; this.lT[i] = this.lT[j]; this.lDur[i] = this.lDur[j];
        this.lR[i] = this.lR[j]; this.lI[i] = this.lI[j]; this.lC[i] = this.lC[j]; this.lFlick[i] = this.lFlick[j];
    }

    clear() {
        this.sN = this.pN = this.fN = this.hN = this.rN = this.lN = 0;
        for (const b of this.bolts) b.live = false;
        this.bN = 0;
        this.pending.length = 0;
        this.sunbursts.length = 0;
        this.smolders.length = 0;
        this.skirmishes.length = 0;
        this.skirmishBits.length = 0;
    }

    // ══ Draw ═══════════════════════════════════════════════════════════════

    _px(c, x, y) {
        let a = this._bin[c];
        const n = this._binN[c];
        if (n + 2 > a.length) {
            const b = new Float32Array(a.length * 2);
            b.set(a);
            this._bin[c] = a = b;
        }
        a[n] = x; a[n + 1] = y;
        this._binN[c] = n + 2;
    }

    _flush(ctx, pix) {
        for (let c = 0; c < PALETTE.length; c++) {
            const n = this._binN[c];
            if (!n) continue;
            const a = this._bin[c];
            ctx.fillStyle = PALETTE[c];
            ctx.beginPath();
            for (let k = 0; k < n; k += 2) ctx.rect(a[k], a[k + 1], pix, pix);
            ctx.fill();
            this._binN[c] = 0;
        }
    }

    // Behind-ships layer (drawn before asteroids/enemies): boss tethers,
    // accretion and other effects that should sit under the hulls.
    drawUnder(ctx, camera) {
        if (!this.sN && !this.bN) return;
        const S = camera.wtsScale, OX = camera.wtsOffX, OY = camera.wtsOffY;
        const pix = Math.max(1, Math.round(this.game.worldScale));
        const W = this.game.width, H = this.game.height;
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        if (this.sN) this._binStreaks(S, OX, OY, pix, W, H, 1);
        if (this.bN) this._binBolts(S, OX, OY, pix, true);
        this._flush(ctx, pix);
        ctx.restore();
    }

    draw(ctx, camera) {
        if (!this.sN && !this.pN && !this.fN && !this.hN && !this.rN && !this.lN && !this.bN && !this.sunbursts.length) return;
        const S = camera.wtsScale, OX = camera.wtsOffX, OY = camera.wtsOffY;
        const pix = Math.max(1, Math.round(this.game.worldScale));
        const W = this.game.width, H = this.game.height;

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';

        // 1) Smoke / dust under everything else.
        if (this.pN) this._drawPuffs(ctx, S, OX, OY, pix, W, H, 1);
        // 2) Additive light + sunbursts.
        if (this.lN) this._drawLights(ctx, S, OX, OY, pix, W, H);
        if (this.sunbursts.length) this._drawSunbursts(ctx, S, OX, OY, pix);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        // 3) Fireballs.
        if (this.pN) this._drawPuffs(ctx, S, OX, OY, pix, W, H, 0);
        // 4) Rings (solid spans, drawn directly).
        if (this.rN) this._drawRings(ctx, S, OX, OY, pix, W, H);
        // 5) Pixel-binned: streaks, stars, lightning.
        if (this.sN) this._binStreaks(S, OX, OY, pix, W, H);
        if (this.fN) this._binStars(S, OX, OY, pix, W, H);
        if (this.bN) this._binBolts(S, OX, OY, pix);
        this._flush(ctx, pix);
        // 6) Hit sparks on top.
        if (this.hN) this._drawHits(ctx, S, OX, OY, pix, W, H);
        ctx.restore();
    }

    // Shaded pixel disc: body colour + an upper-left highlight disc one ramp
    // step brighter (if the ramp has one). Native res, cached.
    _puffSprite(r, pal, hi) {
        const key = (r * 128 + pal) * 128 + (hi + 1);
        let cv = this._puffCache.get(key);
        if (cv) return cv;
        const d = r * 2 + 1;
        cv = document.createElement('canvas');
        cv.width = cv.height = d;
        const g = cv.getContext('2d');
        const img = g.createImageData(d, d);
        const body = hexRgb(PALETTE[pal]);
        const hic = hi >= 0 ? hexRgb(PALETTE[hi]) : null;
        const rr = (r + 0.35) * (r + 0.35);
        const hr = r * 0.58, hx = r - r * 0.3, hy = r - r * 0.3, hr2 = hr * hr;
        for (let y = 0; y < d; y++) {
            for (let x = 0; x < d; x++) {
                const dx = x - r, dy = y - r;
                if (dx * dx + dy * dy > rr) continue;
                const o = (y * d + x) * 4;
                const ex = x - hx, ey = y - hy;
                const c = (hic && r >= 2 && ex * ex + ey * ey <= hr2) ? hic : body;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
            }
        }
        g.putImageData(img, 0, 0);
        if (this._puffCache.size > 1500) this._puffCache.clear();
        this._puffCache.set(key, cv);
        return cv;
    }

    // Normalized cloud field for (variant, size): 3–5 overlapping lobes
    // (cumulus silhouette) roughened by value noise. Same variant = same
    // shape at every size, so a growing puff keeps its silhouette.
    _cloudField(variant, si) {
        const key = variant * 16 + si;
        let f = this._cloudFields.get(key);
        if (f) return f;
        const R = CLOUD_SIZES[si], D = R * 2 + 1;
        let seed = (variant + 1) * 2654435761 >>> 0;
        const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
        // A core plus a ring of small billows round the rim — the bumpy
        // cumulus outline that keeps it reading as smoke, not a pebble.
        const lobes = [[0, 0, 0.5]];
        const nl = 6 + (rnd() * 3 | 0);
        const a0 = rnd() * TAU;
        for (let k = 0; k < nl; k++) {
            const a = a0 + (k / nl) * TAU + (rnd() - 0.5) * 0.5, d = 0.42 + rnd() * 0.2;
            lobes.push([Math.cos(a) * d, Math.sin(a) * d, 0.22 + rnd() * 0.2]);
        }
        const dens = new Float32Array(D * D), ero = new Float32Array(D * D), shade = new Float32Array(D * D);
        for (let y = 0; y < D; y++) {
            for (let x = 0; x < D; x++) {
                const nx = (x - R) / R, ny = (y - R) / R;
                let dn = -1;
                for (const [cx, cy, cr] of lobes) {
                    const dx = nx - cx, dy = ny - cy;
                    dn = Math.max(dn, 1 - Math.sqrt(dx * dx + dy * dy) / cr);
                }
                const n1 = vnoise(nx * 2.4, ny * 2.4, variant * 7 + 1);
                const n2 = vnoise(nx * 4.8 + 5.3, ny * 4.8 + 1.7, variant * 7 + 2);
                dn += (n1 - 0.5) * 0.4;
                const k = y * D + x;
                dens[k] = dn;
                ero[k] = Math.max(0, dn) * 0.5 + n2 * 0.5;
                // Lit from the upper-left: each billow gets its own rim light.
                shade[k] = dn * 0.9 + (-nx - ny) * 0.5 + (n2 - 0.5) * 0.25;
            }
        }
        f = { R, D, dens, ero, shade };
        this._cloudFields.set(key, f);
        return f;
    }

    _cloudSprite(ramp, variant, si, L, top) {
        const key = (((ramp * 8 + variant) * 8 + si) * 8 + L) * 8 + top;
        let cv = this._cloudCache.get(key);
        if (cv) return cv;
        const f = this._cloudField(variant, si);
        const n = RAMP_N[ramp], base = RAMP_BASE[ramp];
        const cHi = hexRgb(PALETTE[base + Math.min(n - 1, top + 1)]);
        const cMid = hexRgb(PALETTE[base + top]);
        const cLo = hexRgb(PALETTE[base + Math.max(0, top - 1)]);
        const th = L * 0.11;
        cv = document.createElement('canvas');
        cv.width = cv.height = f.D;
        const g = cv.getContext('2d');
        const img = g.createImageData(f.D, f.D);
        for (let k = 0; k < f.D * f.D; k++) {
            if (f.dens[k] <= 0.05 || f.ero[k] <= th) continue;
            const sh = f.shade[k];
            const c = sh > 0.55 ? cHi : sh < 0.12 ? cLo : cMid;
            const o = k * 4;
            img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        this._cloudCache.set(key, cv);
        return cv;
    }

    _drawPuffs(ctx, S, OX, OY, pix, W, H, smokePass) {
        const inv = 1 / pix;
        for (let i = 0; i < this.pN; i++) {
            if (this.pSmoke[i] !== smokePass) continue;
            const t = this.pT[i];
            if (t < 0) continue;
            const u = t / this.pDur[i];
            const r1 = this.pR1[i];
            const rad = u < 0.22
                ? this.pR0[i] + (r1 - this.pR0[i]) * easeOut3(u / 0.22)
                : r1 + (this.pR2[i] - r1) * ((u - 0.22) / 0.78);
            const r = Math.round(rad);
            if (r < 0) continue;
            const ramp = this.pRamp[i], base = RAMP_BASE[ramp];
            const top = this.pTop[i];
            if (smokePass) {
                // Smoke/dust: a lumpy shaded pixel cloud that erodes into
                // wisps over its life (noise-threshold dissolve) and dims a
                // step or two — never a shrinking ball.
                let si = 0, best = 1e9;
                for (let k = 0; k < CLOUD_SIZES.length; k++) {
                    const d = Math.abs(CLOUD_SIZES[k] - rad);
                    if (d < best) { best = d; si = k; }
                }
                const L = Math.min(CLOUD_EROSION - 1, Math.floor(Math.pow(u, 1.1) * (CLOUD_EROSION + 0.5)));
                const topE = Math.max(1, Math.round(top * (1 - 0.45 * u)));
                const spr = this._cloudSprite(ramp, this.pVar[i], si, L, topE);
                const Rs = CLOUD_SIZES[si];
                const size = spr.width * pix;
                const sx = Math.round((this.pX[i] * S + OX) * inv) * pix - Rs * pix;
                const sy = Math.round((this.pY[i] * S + OY) * inv) * pix - Rs * pix;
                if (sx > W || sy > H || sx + size < 0 || sy + size < 0) continue;
                ctx.drawImage(spr, sx, sy, size, size);
                continue;
            }
            // Step down the ramp: fire cools white→yellow→orange→red→ember.
            const ci = smokePass
                ? Math.floor(top * (1 - u * u) + 0.5)
                : Math.floor(top * Math.pow(1 - u, 1.2) + 0.5);
            if (ci <= 0 && smokePass) continue;
            const pal = base + Math.max(0, ci);
            const hi = ci + 1 < RAMP_N[ramp] && ci + 1 <= top ? pal + 1 : -1;
            const spr = this._puffSprite(r, pal, hi);
            const size = spr.width * pix;
            const sx = Math.round((this.pX[i] * S + OX) * inv) * pix - r * pix;
            const sy = Math.round((this.pY[i] * S + OY) * inv) * pix - r * pix;
            if (sx > W || sy > H || sx + size < 0 || sy + size < 0) continue;
            ctx.drawImage(spr, sx, sy, size, size);
        }
    }

    _binStreaks(S, OX, OY, pix, W, H, under = 0) {
        const inv = 1 / pix;
        for (let i = 0; i < this.sN; i++) {
            if (this.sUnder[i] !== under) continue;
            const hx = this.sX[i] * S + OX, hy = this.sY[i] * S + OY;
            if (hx < -40 || hx > W + 40 || hy < -40 || hy > H + 40) continue;
            const u = 1 - this.sLife[i] / this.sMax[i];
            const r = this.sRamp[i], base = RAMP_BASE[r], n = RAMP_N[r];
            const head = Math.floor(energy(u) * (n - 1) + 0.5);
            const vx = this.sVX[i], vy = this.sVY[i];
            const sp = Math.sqrt(vx * vx + vy * vy);
            const steps = Math.min(14, Math.floor(sp * this.sLen[i] * S * inv));
            const dx = sp > 0 ? -vx / sp * pix : 0, dy = sp > 0 ? -vy / sp * pix : 0;
            let lx = 1e9, ly = 1e9;
            for (let k = steps; k >= 0; k--) {
                const ci = head - (steps ? Math.floor((k / steps) * 2 + 0.25) : 0);
                if (ci < 0) continue;
                const px = Math.round((hx + dx * k) * inv) * pix;
                const py = Math.round((hy + dy * k) * inv) * pix;
                if (px === lx && py === ly) continue;
                lx = px; ly = py;
                this._px(base + ci, px, py);
            }
        }
    }

    _binStars(S, OX, OY, pix, W, H) {
        const inv = 1 / pix;
        for (let i = 0; i < this.fN; i++) {
            const cx = Math.round((this.fX[i] * S + OX) * inv) * pix;
            const cy = Math.round((this.fY[i] * S + OY) * inv) * pix;
            if (cx < -80 || cx > W + 80 || cy < -80 || cy > H + 80) continue;
            const u = this.fT[i] / this.fDur[i];
            const r = this.fRamp[i], base = RAMP_BASE[r], n = RAMP_N[r];
            const env = Math.sin(Math.PI * Math.min(1, u * 1.6 + 0.12));
            const L = Math.max(1, Math.round(this.fLen[i] * (0.55 + 0.45 * easeOut3(Math.min(1, u * 2))) * Math.max(0.35, env)));
            const e = energy(u);
            const top = Math.floor(e * (n - 1) + 0.5);
            // Falling fountain stars twinkle (alternate frames lose their rays).
            const twinkle = this.fG[i] && ((this.time * 20 + i) | 0) % 3 === 0;
            if (u < 0.55 || this.fG[i]) {
                this._px(base + top, cx, cy);
                const c1 = base + Math.max(0, top - 1);
                this._px(c1, cx - pix, cy); this._px(c1, cx + pix, cy);
                this._px(c1, cx, cy - pix); this._px(c1, cx, cy + pix);
            }
            if (twinkle) continue;
            for (let k = 2; k <= L; k++) {
                const ci = Math.floor((n - 1) * (0.25 + 0.75 * (1 - k / (L + 1))) * e + 0.5);
                const c = base + Math.min(Math.max(ci, 0), n - 1);
                const o = k * pix;
                this._px(c, cx + o, cy); this._px(c, cx - o, cy);
                this._px(c, cx, cy + o); this._px(c, cx, cy - o);
            }
            if (this.fDiag[i]) {
                const Ld = Math.round(L * 0.45);
                for (let k = 1; k <= Ld; k++) {
                    const ci = Math.floor((n - 1) * (0.25 + 0.6 * (1 - k / (Ld + 1))) * e + 0.5) - 1;
                    if (ci < 0) continue;
                    const c = base + ci, o = k * pix;
                    this._px(c, cx + o, cy + o); this._px(c, cx - o, cy - o);
                    this._px(c, cx + o, cy - o); this._px(c, cx - o, cy + o);
                }
            }
        }
    }

    // Regenerate a bolt's polyline (world coords, relative to its entity).
    _genBolt(b) {
        const pts = b.pts;
        if (b.mode === 1) {
            // Crawl along the circle with radial jitter.
            const n = 9;
            for (let k = 0; k < n; k++) {
                const t = k / (n - 1);
                const a = b.a0 + (b.a1 - b.a0) * t;
                const j = (k === 0 || k === n - 1) ? 0 : (Math.random() - 0.5) * 7;
                pts[k * 2] = b.cx + Math.cos(a) * (b.R + j);
                pts[k * 2 + 1] = b.cy + Math.sin(a) * (b.R + j);
            }
            b.n = n;
            return;
        }
        // Midpoint displacement, 4 levels → 17 points.
        const levels = 4, n = (1 << levels) + 1;
        pts[0] = b.ax; pts[1] = b.ay;
        pts[(n - 1) * 2] = b.bx; pts[(n - 1) * 2 + 1] = b.by;
        const dx = b.bx - b.ax, dy = b.by - b.ay;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const px = -dy / len, py = dx / len;
        let disp = len * b.jag;
        for (let step = n - 1; step > 1; step >>= 1) {
            const half = step >> 1;
            for (let i = half; i < n; i += step) {
                const i0 = i - half, i1 = i + half;
                const off = (Math.random() - 0.5) * disp;
                pts[i * 2] = (pts[i0 * 2] + pts[i1 * 2]) * 0.5 + px * off;
                pts[i * 2 + 1] = (pts[i0 * 2 + 1] + pts[i1 * 2 + 1]) * 0.5 + py * off;
            }
            disp *= 0.55;
        }
        b.n = n;
    }

    _binBolts(S, OX, OY, pix, under = false) {
        const inv = 1 / pix;
        for (const b of this.bolts) {
            if (!b.live || b.under !== under) continue;
            const eb = RAMP_BASE[b.ramp], en = RAMP_N[b.ramp];
            const core = eb + en - 1, halo = eb + Math.max(1, en - 3), dimHalo = eb;
            // Spark's lightning timing: strike, re-strike (new shape), blank,
            // dim echo, blank.
            const phase = Math.floor(b.t / 0.04);
            if (phase === 2 || phase >= 4) continue;
            if (phase !== b.gen && phase < 2) { this._genBolt(b); b.gen = phase; }
            const echo = phase === 3;
            const ox = b.ent ? b.ent.worldX : 0, oy = b.ent ? b.ent.worldY : 0;
            const pts = b.pts;
            let x0 = Math.round(((pts[0] + ox) * S + OX) * inv);
            let y0 = Math.round(((pts[1] + oy) * S + OY) * inv);
            for (let k = 1; k < b.n; k++) {
                const x1 = Math.round(((pts[k * 2] + ox) * S + OX) * inv);
                const y1 = Math.round(((pts[k * 2 + 1] + oy) * S + OY) * inv);
                // Bresenham in pixel-cell space.
                let x = x0, y = y0;
                const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
                const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
                let err = dx + dy, guard = 0;
                while (guard++ < 400) {
                    const X = x * pix, Y = y * pix;
                    if (echo) {
                        this._px(dimHalo, X, Y);
                    } else {
                        this._px(halo, X - pix, Y); this._px(halo, X + pix, Y);
                        this._px(halo, X, Y - pix); this._px(halo, X, Y + pix);
                        this._px(core, X, Y);
                    }
                    if (x === x1 && y === y1) break;
                    const e2 = 2 * err;
                    if (e2 >= dy) { err += dy; x += sx; }
                    if (e2 <= dx) { err += dx; y += sy; }
                }
                x0 = x1; y0 = y1;
            }
        }
    }

    // Solid pixel ring via scanline spans — no sampling gaps, no jaggies.
    // Outer band in the ramp colour, a 1px brighter leading edge inside.
    _drawRings(ctx, S, OX, OY, pix, W, H) {
        const inv = 1 / pix;
        for (let i = 0; i < this.rN; i++) {
            const u = this.rT[i] / this.rDur[i];
            const Rw = this.rR0[i] + (this.rR1[i] - this.rR0[i]) * easeOut3(u);
            const Ro = Rw * S * inv;                       // cells
            const w = Math.max(1, Math.round(this.rW[i] * (1 - u) + u));
            const cxc = Math.round((this.rX[i] * S + OX) * inv);
            const cyc = Math.round((this.rY[i] * S + OY) * inv);
            if ((cxc + Ro) * pix < 0 || (cxc - Ro) * pix > W || (cyc + Ro) * pix < 0 || (cyc - Ro) * pix > H) continue;
            const ramp = this.rRamp[i], base = RAMP_BASE[ramp], n = RAMP_N[ramp];
            const top = Math.floor(energy(u) * (n - 1) + 0.5);
            this._annulus(ctx, cxc, cyc, Ro, Ro - w, pix, PALETTE[base + Math.max(0, top - 1)]);
            if (top > 0 && w > 1) this._annulus(ctx, cxc, cyc, Ro - w + 1, Ro - w, pix, PALETTE[base + top]);
        }
    }

    _annulus(ctx, cxc, cyc, Ro, Ri, pix, color) {
        const ro = Math.max(0.5, Ro), ri = Math.max(0, Ri);
        const ro2 = (ro + 0.5) * (ro + 0.5), ri2 = (ri + 0.5) * (ri + 0.5);
        const J = Math.floor(ro + 0.5);
        ctx.fillStyle = color;
        ctx.beginPath();
        for (let j = -J; j <= J; j++) {
            const jj = j * j;
            const xo = Math.floor(Math.sqrt(Math.max(0, ro2 - jj)));
            const y = (cyc + j) * pix;
            if (jj < ri2) {
                const xi = Math.floor(Math.sqrt(ri2 - jj)) + 1;
                if (xi > xo) continue;
                ctx.rect((cxc - xo) * pix, y, (xo - xi + 1) * pix, pix);
                ctx.rect((cxc + xi) * pix, y, (xo - xi + 1) * pix, pix);
            } else {
                ctx.rect((cxc - xo) * pix, y, (xo * 2 + 1) * pix, pix);
            }
        }
        ctx.fill();
    }

    _drawLights(ctx, S, OX, OY, pix, W, H) {
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < this.lN; i++) {
            const u = this.lT[i] / this.lDur[i];
            let alpha = this.lI[i] * (1 - u) * (1 - u);
            if (this.lFlick[i]) alpha *= 0.55 + Math.random() * 0.45;
            if (alpha <= 0.01) continue;
            const rPx = this.lR[i] * S / pix;
            const rq = Math.max(4, Math.min(72, Math.round(rPx / 4) * 4));
            const disc = this._disc(rq, this.lC[i]);
            const size = disc.width * pix;
            const sx = Math.round((this.lX[i] * S + OX - size / 2) / pix) * pix;
            const sy = Math.round((this.lY[i] * S + OY - size / 2) / pix) * pix;
            if (sx > W || sy > H || sx + size < 0 || sy + size < 0) continue;
            ctx.globalAlpha = Math.min(1, alpha);
            ctx.drawImage(disc, sx, sy, size, size);
        }
        ctx.globalAlpha = 1;
    }

    // Hard 3-band light disc at native res (bands at r/2.2, r/1.5, r).
    _disc(r, c) {
        const key = r * 16 + c;
        let cv = this._discCache.get(key);
        if (cv) return cv;
        const d = r * 2 + 1;
        cv = document.createElement('canvas');
        cv.width = cv.height = d;
        const g = cv.getContext('2d');
        const img = g.createImageData(d, d);
        const [R, G, B] = LIGHT_RGB[c];
        const r2 = r * r, rMid = (r / 1.5) * (r / 1.5), rIn = (r / 2.2) * (r / 2.2);
        for (let y = 0; y < d; y++) {
            for (let x = 0; x < d; x++) {
                const dx = x - r, dy = y - r, q = dx * dx + dy * dy;
                if (q > r2) continue;
                const a = q <= rIn ? 0.55 : q <= rMid ? 0.3 : 0.13;
                const o = (y * d + x) * 4;
                img.data[o] = R; img.data[o + 1] = G; img.data[o + 2] = B;
                img.data[o + 3] = Math.round(a * 255);
            }
        }
        g.putImageData(img, 0, 0);
        this._discCache.set(key, cv);
        return cv;
    }

    // ── Hand-built hit-spark frames ────────────────────────────────────────
    // f0: solid white-hot plus with short rays + diagonal glints
    // f1: bigger hollow star in the mid colours
    // f2: four flying fragments
    _hitFrameSet(ramp) {
        let set = this._hitFrames.get(ramp);
        if (set) return set;
        const n = RAMP_N[ramp], base = RAMP_BASE[ramp];
        const col = (i) => hexRgb(PALETTE[base + Math.max(0, Math.min(n - 1, i))]);
        const T = n - 1;
        const D = 17, C = 8;
        const frames = [];
        const make = (plot) => {
            const cv = document.createElement('canvas');
            cv.width = cv.height = D;
            const g = cv.getContext('2d');
            const img = g.createImageData(D, D);
            plot((x, y, c) => {
                const X = C + x, Y = C + y;
                if (X < 0 || Y < 0 || X >= D || Y >= D) return;
                const o = (Y * D + X) * 4;
                img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
            });
            g.putImageData(img, 0, 0);
            return cv;
        };
        const axes = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        const diags = [[1, 1], [-1, 1], [1, -1], [-1, -1]];
        frames.push(make((p) => {
            for (const [ax, ay] of axes) {
                p(ax, ay, col(T));
                for (let k = 2; k <= 5; k++) p(ax * k, ay * k, col(k <= 3 ? T - 1 : T - 2));
            }
            for (const [dx, dy] of diags) { p(dx, dy, col(T - 1)); p(dx * 2, dy * 2, col(T - 2)); }
            p(0, 0, col(T));
        }));
        frames.push(make((p) => {
            for (const [ax, ay] of axes) {
                for (let k = 3; k <= 7; k++) p(ax * k, ay * k, col(k <= 4 ? T - 1 : T - 2));
            }
            for (const [dx, dy] of diags) { for (let k = 2; k <= 4; k++) p(dx * k, dy * k, col(T - 2)); }
        }));
        frames.push(make((p) => {
            for (const [ax, ay] of axes) { p(ax * 7, ay * 7, col(T - 2)); p(ax * 8, ay * 8, col(T - 3)); }
            for (const [dx, dy] of diags) { p(dx * 5, dy * 5, col(T - 3)); }
        }));
        set = frames;
        this._hitFrames.set(ramp, set);
        return set;
    }

    _drawHits(ctx, S, OX, OY, pix, W, H) {
        const inv = 1 / pix;
        for (let i = 0; i < this.hN; i++) {
            const f = Math.min(2, Math.floor(this.hT[i] / HIT_FRAME));
            const frames = this._hitFrameSet(this.hRamp[i]);
            const spr = frames[f];
            const size = spr.width * pix;
            const sx = Math.round((this.hX[i] * S + OX) * inv) * pix - 8 * pix;
            const sy = Math.round((this.hY[i] * S + OY) * inv) * pix - 8 * pix;
            if (sx > W || sy > H || sx + size < 0 || sy + size < 0) continue;
            ctx.drawImage(spr, sx, sy, size, size);
        }
    }

    // ── Level-up sunburst ─────────────────────────────────────────────────
    // Rotating hard pixel rays in level yellow/white, rendered per-pixel at
    // native res (angle/distance table precomputed once) and blitted
    // additively at the pixel grid.
    _drawSunbursts(ctx, S, OX, OY, pix) {
        const bandR = [1, 0.72, 0.4];
        const cache = this._sunCanvases || (this._sunCanvases = new Map());
        ctx.globalCompositeOperation = 'lighter';
        for (const s of this.sunbursts) {
            // Native-resolution canvas sized for THIS burst (radius in logical
            // px) — a big burst gets more pixels, never bigger pixels.
            const R = Math.min(360, Math.round(64 * (s.scale || 1))), D = R * 2 + 1;
            let entry = cache.get(R);
            if (!entry) {
                const cv = document.createElement('canvas');
                cv.width = cv.height = D;
                entry = { cv, g: cv.getContext('2d') };
                cache.set(R, entry);
            }
            const g = entry.g;
            const u = s.t / s.dur;
            const env = u < 0.12 ? easeOut3(u / 0.12) : u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
            const rad = R * (0.55 + 0.45 * env);
            const bands = s.bands;
            const rot = s.t * 0.55 * TAU / 14;
            const rays = 14;
            // Tapered rays (wide at the hub, pointed tips), filled at native
            // res in three hard colour bands — outer band first, inner bands
            // clipped on top. A handful of path fills instead of per-pixel work.
            g.clearRect(0, 0, D, D);
            for (let b = 0; b < 3; b++) {
                g.save();
                if (b > 0) { g.beginPath(); g.arc(R, R, rad * bandR[b], 0, TAU); g.clip(); }
                g.fillStyle = bands[b];
                g.beginPath();
                for (let k = 0; k < rays; k++) {
                    const a = rot + (k / rays) * TAU;
                    const hw = (TAU / rays) * 0.24;
                    const hub = Math.max(5, R * 0.08);
                    g.moveTo(R + Math.cos(a - hw) * hub, R + Math.sin(a - hw) * hub);
                    g.lineTo(R + Math.cos(a) * rad, R + Math.sin(a) * rad);
                    g.lineTo(R + Math.cos(a + hw) * hub, R + Math.sin(a + hw) * hub);
                    g.closePath();
                }
                g.fill();
                g.restore();
            }
            const p = s.player;
            const size = D * pix;
            const sx = Math.round((p.worldX * S + OX) / pix) * pix - Math.round(size / 2);
            const sy = Math.round((p.worldY * S + OY) / pix) * pix - Math.round(size / 2);
            ctx.globalAlpha = 0.5 * env;
            ctx.drawImage(entry.cv, sx, sy, size, size);
        }
        ctx.globalAlpha = 1;
    }
}

// Is cell centre (x, y) inside triangle a-b-c? (sign test)
function inTri(x, y, ax, ay, bx, by, cx, cy) {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
}

// Smooth value noise in [0,1] (integer-hash lattice, smoothstep blend).
function _h(ix, iy, seed) {
    let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y, seed) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = _h(ix, iy, seed), b = _h(ix + 1, iy, seed);
    const c = _h(ix, iy + 1, seed), d = _h(ix + 1, iy + 1, seed);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
}

const _rgbCache = new Map();
function hexRgb(h) {
    let c = _rgbCache.get(h);
    if (!c) {
        c = [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
        _rgbCache.set(h, c);
    }
    return c;
}
