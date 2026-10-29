// WorldMoments — rare cosmetic moments that make space feel lived-in:
//   • a nebula lightning storm far behind the action (parallax 0.3), with
//     strike / re-strike / blank / echo timing and distant thunder;
//   • a derelict's SOS beacon blinking · · · — — — · · · in the deep sky;
//   • a "grazer" comet aimed to skim a visible asteroid, throwing sparks
//     (any ambience comet that brushes a rock sparks too);
//   • battle scars: after a boss or event dies, a cooling field of hull
//     specks and embers stays where the fight was, fading over minutes.
//
// Cosmetic only (Math.random), local to each machine, never touches the sim.
// Everything draws on the world pixel grid (round(worldScale)).

import { RAMP } from './impactFx.js';
import { RectBins } from './rectBins.js';

const TAU = Math.PI * 2;
const P = 0.3;              // background parallax (matches the skirmishes)
const MAX_SCARS = 20;

// Morse SOS: [on, off] seconds.
const SOS = [];
for (const L of [0, 1, 0]) {
    for (let i = 0; i < 3; i++) SOS.push([L ? 0.45 : 0.15, i < 2 ? 0.15 : 0.45]);
}
SOS[SOS.length - 1][1] = 1.4;

function boltPath(x0, y0, x1, y1, disp, depth, out) {
    if (depth === 0) { out.push(x1, y1); return; }
    const mx = (x0 + x1) / 2 + (Math.random() - 0.5) * disp, my = (y0 + y1) / 2 + (Math.random() - 0.5) * disp;
    boltPath(x0, y0, mx, my, disp / 2, depth - 1, out);
    boltPath(mx, my, x1, y1, disp / 2, depth - 1, out);
}

export class WorldMoments {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.storm = null;
        this.beacon = null;
        this.scars = [];
        this._stormIn = 180 + Math.random() * 240;
        this._beaconIn = 240 + Math.random() * 300;
        this._grazerIn = 90 + Math.random() * 150;
        this._timers = [];
    }

    get fx() { return this.state.impactFx; }

    // ── battle scars ───────────────────────────────────────────────────────
    scar(x, y, r) {
        if (this.game.lowPerfMode) return;
        const R = Math.max(60, Math.min(220, r * 1.6));
        const specks = [];
        const n = Math.round(40 + R * 0.35);
        for (let i = 0; i < n; i++) {
            const a = Math.random() * TAU, d = Math.sqrt(Math.random()) * R;
            const ember = Math.random() < 0.22;
            specks.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, vx: Math.cos(a) * (2 + Math.random() * 6), vy: Math.sin(a) * (2 + Math.random() * 6),
                ember, ph: Math.random() * TAU, s: Math.random() < 0.15 ? 2 : 1,
                col: ember ? 0 : ['#2a2e38', '#3a3f4a', '#4e5462', '#232630'][(Math.random() * 4) | 0] });
        }
        this.scars.push({ x, y, R, specks, t: 0, dur: 150 + Math.random() * 60 });
        if (this.scars.length > MAX_SCARS) this.scars.shift();
    }

    // ── tick ───────────────────────────────────────────────────────────────
    tick(dt) {
        const cam = this.state.camera;
        if (!cam) return;
        // Expired entries are removed by one stable in-place compaction
        // pass (no splice shifting). Timers fire newest-first as before; a
        // callback that queues a timer appends it (not visited this tick).
        const timers = this._timers;
        let fired = false;
        for (let i = timers.length - 1; i >= 0; i--) {
            const tm = timers[i];
            if (!tm._dead && (tm.t -= dt) <= 0) { tm._dead = true; fired = true; tm.fn(); }
        }
        if (fired) {
            let j = 0;
            for (let i = 0; i < timers.length; i++) if (!timers[i]._dead) timers[j++] = timers[i];
            timers.length = j;
        }
        {
            const scars = this.scars;
            let j = 0;
            for (let i = 0; i < scars.length; i++) {
                const s = scars[i];
                s.t += dt;
                if (s.t >= s.dur) continue;
                // Drift slows to nothing over the first minute.
                const k = Math.max(0, 1 - s.t / 60) * dt;
                const sp = s.specks;
                for (let q = 0; q < sp.length; q++) { const p = sp[q]; p.x += p.vx * k; p.y += p.vy * k; }
                scars[j++] = s;
            }
            scars.length = j;
        }

        const amb = this.state.ambience;
        // Nebula storm: only where the nebula is thick; otherwise try again soon.
        if (!this.storm && (this._stormIn -= dt) <= 0) {
            const dense = amb ? amb.nebulaDensity(cam.x, cam.y) : 0.5;
            if (dense > 0.15 || Math.random() < 0.25) this.startStorm();
            else this._stormIn = 30;
        }
        if (this.storm) this._tickStorm(dt);

        if (!this.beacon && (this._beaconIn -= dt) <= 0) this.startBeacon();
        if (this.beacon) {
            const b = this.beacon;
            b.t += dt;
            if (b.t >= b.dur) this.beacon = null;
            else {
                b.ph -= dt;
                if (b.ph <= 0) {
                    b.on = !b.on;
                    const step = SOS[b.i];
                    if (b.on) { b.ph = step[0]; b.rings.push(0); }
                    else { b.ph = step[1]; b.i = (b.i + 1) % SOS.length; }
                }
                const rings = b.rings;
                let j = 0;
                for (let k = 0; k < rings.length; k++) { const v = rings[k] + dt; if (v <= 1.6) rings[j++] = v; }
                rings.length = j;
            }
        }

        if ((this._grazerIn -= dt) <= 0) { this._grazerIn = 150 + Math.random() * 200; this.grazer(); }
        this._tickGrazes(dt);
    }

    // ── nebula storm ───────────────────────────────────────────────────────
    startStorm() {
        const cam = this.state.camera, S = cam.wtsScale || 1;
        const halfW = this.game.width / (2 * S), halfH = this.game.height / (2 * S);
        this.storm = { x: cam.x * P + (Math.random() - 0.5) * halfW, y: cam.y * P + (Math.random() - 0.5) * halfH * 0.8,
            t: 0, dur: 14 + Math.random() * 10, next: 0.4, bolts: [], flash: 0, col: Math.random() < 0.5 ? 'violet' : 'blue' };
        this._stormIn = 360 + Math.random() * 360;
    }

    _tickStorm(dt) {
        const st = this.storm;
        st.t += dt;
        st.flash = Math.max(0, st.flash - dt * 4);
        if (st.t < st.dur - 1.5 && (st.next -= dt) <= 0) {
            // Strikes come in clusters: sometimes a quick double.
            st.next = Math.random() < 0.3 ? 0.18 : 0.6 + Math.random() * 2.0;
            const a = Math.random() * TAU, d = Math.random() * 120;
            const x0 = st.x + Math.cos(a) * d, y0 = st.y + Math.sin(a) * d * 0.6;
            const ang = Math.random() * TAU, len = 40 + Math.random() * 90;
            const pts = [x0, y0];
            boltPath(x0, y0, x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len, len * 0.45, 4, pts);
            const fork = [];
            if (Math.random() < 0.6) {
                const j = 2 * (2 + ((Math.random() * 10) | 0)), fa = ang + (Math.random() < 0.5 ? 0.7 : -0.7);
                fork.push(pts[j], pts[j + 1]);
                boltPath(pts[j], pts[j + 1], pts[j] + Math.cos(fa) * len * 0.5, pts[j + 1] + Math.sin(fa) * len * 0.5, len * 0.25, 3, fork);
            }
            st.bolts.push({ pts, fork, t: 0 });
            st.flash = 1;
            // Distant thunder arrives late and low.
            const sfx = this.state.sfx;
            if (sfx) this._timers.push({ t: 0.4 + Math.random() * 1.2, fn: () => sfx.thump(0.7, null, null, 0.1) });
        }
        const bolts = st.bolts;
        let j = 0;
        for (let i = 0; i < bolts.length; i++) { const bo = bolts[i]; if ((bo.t += dt) <= 0.45) bolts[j++] = bo; }
        bolts.length = j;
        if (st.t >= st.dur) this.storm = null;
    }

    // ── SOS beacon ─────────────────────────────────────────────────────────
    startBeacon() {
        const cam = this.state.camera, S = cam.wtsScale || 1;
        const halfW = this.game.width / (2 * S), halfH = this.game.height / (2 * S);
        const side = Math.random() < 0.5 ? -1 : 1;
        this.beacon = { x: cam.x * P + side * halfW * (0.45 + Math.random() * 0.3), y: cam.y * P + (Math.random() - 0.5) * halfH * 1.2,
            ang: Math.random() * TAU, t: 0, dur: 40 + Math.random() * 20, on: false, ph: 1, i: 0, rings: [] };
        this._beaconIn = 300 + Math.random() * 360;
    }

    // ── comets that brush asteroids ────────────────────────────────────────
    grazer() {
        const amb = this.state.ambience, cam = this.state.camera;
        if (!amb || !cam) return;
        const ws = this.game.worldScale || 1;
        const halfW = this.game.width / ws / 2, halfH = this.game.height / ws / 2;
        let target = null;
        for (const a of this.state.asteroids) {
            if (!a.alive && a.alive !== undefined) continue;
            if (Math.abs(a.worldX - cam.x) < halfW * 0.7 && Math.abs(a.worldY - cam.y) < halfH * 0.7 && (a.radius || 0) > 14) { target = a; break; }
        }
        if (!target) return;
        const fromLeft = Math.random() < 0.5, ang = (fromLeft ? 0 : Math.PI) + (Math.random() - 0.5) * 0.6, sp = 700 + Math.random() * 250;
        const off = (target.radius || 20) * 0.95 * (Math.random() < 0.5 ? 1 : -1);
        const nx = -Math.sin(ang), ny = Math.cos(ang);
        const back = halfW + 200;
        // Aim through a point just off the rock's limb; start far back along the line.
        const ax = target.worldX + nx * off - Math.cos(ang) * back, ay = target.worldY + ny * off - Math.sin(ang) * back;
        amb.comets.push({ parallax: 1, x: ax, y: ay, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, t: 0, dur: (back * 2) / sp, delay: 0, trail: [], maxTrail: 22, size: 2 });
    }

    _tickGrazes(dt) {
        const amb = this.state.ambience, fx = this.fx;
        if (!amb || !fx || !amb.comets.length) return;
        for (const c of amb.comets) {
            if (c.delay > 0 || c.parallax !== 1) continue;
            c._gcd = (c._gcd || 0) - dt;
            if (c._gcd > 0) continue;
            for (const a of this.state.asteroids) {
                const dx = a.worldX - c.x, dy = a.worldY - c.y, r = (a.radius || 16) + 10;
                if (dx * dx + dy * dy > r * r) continue;
                const sp = Math.hypot(c.vx, c.vy) || 1, dir = Math.atan2(c.vy, c.vx);
                // Contact point on the limb facing the comet.
                const d = Math.sqrt(dx * dx + dy * dy) || 1, ex = a.worldX - dx / d * (r - 10), ey = a.worldY - dy / d * (r - 10);
                fx.hitSpark(ex, ey, RAMP.spark);
                fx.burst(ex, ey, RAMP.spark, 10, 250, 650, dir, 0.7, 0.3);
                fx.burst(ex, ey, RAMP.white, 4, 150, 400, dir, 0.4, 0.2);
                fx.puff(ex, ey, c.vx / sp * 40, c.vy / sp * 40, 2, 5, 9, 0.9, RAMP.dust, { drag: 2 });
                fx.light(ex, ey, 40, 0.6, 0.15, '#cfe8ff');
                c._gcd = 0.07;
                break;
            }
        }
    }

    // ── drawing ────────────────────────────────────────────────────────────
    // Deep sky: storm + beacon (parallax 0.3). Called right after the
    // skirmishes, under every entity.
    drawBackground(ctx, camera) {
        if (!this.storm && !this.beacon && !this.scars.length) return;
        const S = camera.wtsScale, pix = Math.max(1, Math.round(this.game.worldScale));
        const W = this.game.width, H = this.game.height;
        const snap = (v) => Math.round(v / pix) * pix;
        ctx.save();
        if (this.storm || this.beacon) {
            const cx = camera.wtsOffX + camera.x * S, cy = camera.wtsOffY + camera.y * S;
            const ox = camera.x * P, oy = camera.y * P;
            const st = this.storm;
            if (st) {
                const fade = Math.min(1, st.t / 1.5, (st.dur - st.t) / 1.5);
                const pal = st.col === 'violet' ? ['#5a2a8a', '#b070ff', '#f0d8ff'] : ['#2a4a8a', '#70a8ff', '#e0f0ff'];
                // The cloud lights up: a flat, faint wash on each strike.
                if (st.flash > 0) {
                    ctx.globalCompositeOperation = 'lighter';
                    ctx.globalAlpha = 0.05 * st.flash * fade;
                    ctx.fillStyle = pal[1];
                    ctx.fillRect(0, 0, W, H);
                    ctx.globalCompositeOperation = 'source-over';
                }
                for (const b of st.bolts) {
                    // strike → blank → re-strike → echo
                    const t = b.t;
                    const lvl = t < 0.05 ? 2 : t < 0.09 ? -1 : t < 0.16 ? 2 : t < 0.3 ? 1 : 0;
                    if (lvl < 0) continue;
                    ctx.globalAlpha = (lvl === 2 ? 0.75 : lvl === 1 ? 0.45 : 0.25) * fade;
                    ctx.fillStyle = pal[lvl];
                    this._polyPix(ctx, b.pts, cx, cy, ox, oy, S, pix, snap);
                    if (b.fork.length) { ctx.fillStyle = pal[Math.max(0, lvl - 1)]; this._polyPix(ctx, b.fork, cx, cy, ox, oy, S, pix, snap); }
                }
            }
            const b = this.beacon;
            if (b) {
                const fade = Math.min(1, b.t / 2, (b.dur - b.t) / 2);
                const sx = snap(cx + (b.x - ox) * S), sy = snap(cy + (b.y - oy) * S);
                // A dead hull: a dark, broken wedge of a few pixels.
                const c = Math.cos(b.ang), sn = Math.sin(b.ang);
                ctx.globalAlpha = 0.55 * fade;
                ctx.fillStyle = '#4a4e5a';
                for (let i = -4; i <= 4; i++) for (let j = -1; j <= 1; j++) {
                    if ((i === 4 && j !== 0) || (i === -2 && j === 1)) continue;
                    ctx.fillRect(snap(sx + (i * c - j * sn) * pix), snap(sy + (i * sn + j * c) * pix), pix, pix);
                }
                if (b.on) {
                    ctx.globalAlpha = fade;
                    ctx.fillStyle = '#ff3a3a';
                    ctx.fillRect(sx - pix, sy - pix, pix * 2, pix * 2);
                    ctx.globalAlpha = 0.5 * fade;
                    ctx.fillStyle = '#ff9a8a';
                    ctx.fillRect(sx - pix, sy - 2 * pix, pix * 2, pix);
                }
                // Each blink sends a thin red ring out.
                ctx.fillStyle = '#c02020';
                for (const rt of b.rings) {
                    const R = (4 + rt * 22) * pix, a = 0.45 * (1 - rt / 1.6) * fade;
                    if (a <= 0) continue;
                    ctx.globalAlpha = a;
                    const n = Math.max(12, Math.round(TAU * R / pix));
                    this._ringPix(ctx, sx, sy, R, n, pix);
                }
            }
        }
        if (this.scars.length) this._drawScars(ctx, camera, pix, snap, W, H);
        ctx.restore();
    }

    _polyPix(ctx, pts, cx, cy, ox, oy, S, pix, snap) {
        for (let i = 0; i + 3 < pts.length; i += 2) {
            const x0 = cx + (pts[i] - ox) * S, y0 = cy + (pts[i + 1] - oy) * S;
            const x1 = cx + (pts[i + 2] - ox) * S, y1 = cy + (pts[i + 3] - oy) * S;
            const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / pix));
            for (let k = 0; k <= n; k++) ctx.fillRect(snap(x0 + (x1 - x0) * k / n), snap(y0 + (y1 - y0) * k / n), pix, pix);
        }
    }

    // Beacon ring: n snapped samples round a circle, all one colour at one
    // alpha. Neighbouring samples can snap onto the SAME pixel, which the
    // old per-rect loop composited twice (darker). To batch exactly, each
    // sample is tagged with its occurrence count at that pixel and the
    // samples are filled as one path per occurrence layer (layer 1 = every
    // covered pixel once, layer 2 = the second hits, ...): every pixel still
    // receives exactly as many alpha-blends of the same colour as before.
    _ringPix(ctx, sx, sy, R, n, pix) {
        const cells = this._cells || (this._cells = new Map());
        const xs = this._rxs || (this._rxs = []);
        const ys = this._rys || (this._rys = []);
        const ms = this._rms || (this._rms = []);
        cells.clear();
        let maxM = 1;
        for (let k = 0; k < n; k++) {
            const q = k / n * TAU;
            const x = Math.round((sx + Math.cos(q) * R) / pix) * pix;
            const y = Math.round((sy + Math.sin(q) * R) / pix) * pix;
            const key = x * 131072 + y;
            const m = (cells.get(key) || 0) + 1;
            cells.set(key, m);
            if (m > maxM) maxM = m;
            xs[k] = x; ys[k] = y; ms[k] = m;
        }
        for (let layer = 1; layer <= maxM; layer++) {
            ctx.beginPath();
            for (let k = 0; k < n; k++) if (ms[k] === layer) ctx.rect(xs[k], ys[k], pix, pix);
            ctx.fill();
        }
    }

    // Battle scars live in the play layer (parallax 1), under every entity.
    // Batched per (colour, alpha) — but only when no two specks of the scar
    // touch the same pixel this frame (alpha < 1 overlaps would composite
    // once instead of twice / in a different order). With no overlap the
    // order is irrelevant and one path per group is exact; otherwise the
    // scar draws speck-by-speck exactly as before. Still-hot embers (each
    // its own flicker alpha) always draw individually.
    _drawScars(ctx, camera, pix, snap, W, H) {
        const S = camera.wtsScale, ox = camera.wtsOffX, oy = camera.wtsOffY;
        const now = performance.now() / 1000;
        const cells = this._cells || (this._cells = new Map());
        const binA = this._scarBinA || (this._scarBinA = new RectBins(16)); // cold hull specks
        const binB = this._scarBinB || (this._scarBinB = new RectBins(4));  // cooled embers
        for (const s of this.scars) {
            const sx = s.x * S + ox, sy = s.y * S + oy, R = s.R * S;
            if (sx < -R || sy < -R || sx > W + R || sy > H + R) continue;
            const life = Math.min(1, s.t / 0.6, (s.dur - s.t) / 20);
            const heat = Math.max(0, 1 - s.t / 45); // embers cool over ~45 s
            const specks = s.specks;
            // Overlap test on the pixel grid (a 2-px speck covers 4 cells).
            cells.clear();
            let overlap = false;
            for (let i = 0; i < specks.length && !overlap; i++) {
                const p = specks[i];
                const cx = Math.round((sx + p.x * S) / pix), cy = Math.round((sy + p.y * S) / pix);
                for (let a = 0; a < p.s && !overlap; a++) for (let b = 0; b < p.s; b++) {
                    const key = (cx + a) * 131072 + (cy + b);
                    if (cells.has(key)) { overlap = true; break; }
                    cells.set(key, 1);
                }
            }
            for (let i = 0; i < specks.length; i++) {
                const p = specks[i];
                const x = snap(sx + p.x * S), y = snap(sy + p.y * S), sz = p.s * pix;
                if (p.ember) {
                    // Glowing embers flicker and step down the fire ramp as they cool.
                    const f = heat * (0.6 + 0.4 * Math.sin(now * 5 + p.ph));
                    if (f <= 0.05) {
                        if (!overlap) { binB.add('#3a2a24', x, y, sz, sz); continue; }
                        ctx.globalAlpha = 0.35 * life; ctx.fillStyle = '#3a2a24';
                    }
                    else { ctx.globalAlpha = Math.min(1, 0.4 + f) * life; ctx.fillStyle = f > 0.7 ? '#ffd865' : f > 0.4 ? '#ff7a2a' : '#a8341c'; }
                } else {
                    if (!overlap) { binA.add(p.col, x, y, sz, sz); continue; }
                    ctx.globalAlpha = 0.5 * life;
                    ctx.fillStyle = p.col;
                }
                ctx.fillRect(x, y, sz, sz);
            }
            if (!overlap) {
                ctx.globalAlpha = 0.5 * life; binA.flush(ctx);
                ctx.globalAlpha = 0.35 * life; binB.flush(ctx);
            }
        }
    }
}
