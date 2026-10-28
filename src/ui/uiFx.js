// UIFX — the screen-space spectacle layer: interaction payoffs (cache
// reveals, shop buys/sells/fails, level-up picks, encounter choices,
// consumables) and the cinematic overlays (title cards, orbiting halos,
// banded glows, god rays, screen flashes, the Yellow One crack of light, the Dragon's falling
// stars). Drawn LAST (above dialogs and the death screen) and SELF-CLOCKED
// from performance.now(), so it keeps playing while single-player dialogs
// pause the sim. Particles may be anchored in world space (`w`) and are then
// projected through the live camera every frame (cinematic FOV pulls).
//
// Flat pixel art: everything snaps to the HUD pixel (round(hudScale)); no
// gradients, no text scale-throb (brightness only). Cosmetic only.

import { RARITY_COLORS } from '../data/upgrades.js';

const TAU = Math.PI * 2;
const MAX_PARTS = 700;

function shade(hex, k) {
    const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
    const f = (c) => Math.max(0, Math.min(255, Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k)));
    return '#' + [f(r), f(g), f(b)].map(v => v.toString(16).padStart(2, '0')).join('');
}
// 5-step ramp (dark → white) from any hex colour.
export function rampOf(hex) {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) hex = '#ffd24a';
    return [shade(hex, -0.6), shade(hex, -0.3), hex, shade(hex, 0.5), '#ffffff'];
}
const GOLD = ['#7a4a10', '#c98a1c', '#ffd24a', '#fff3b0', '#ffffff'];
const RED = ['#3a0808', '#801818', '#e03030', '#ff9a8a', '#ffffff'];
const WHITE = ['#5a6a8a', '#a8b8d8', '#e8f0ff', '#ffffff', '#ffffff'];

export class UIFX {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.parts = [];
        this.rings = [];
        this.rays = [];
        this.flashes = [];   // rect flashes
        this.cards = [];     // title cards
        this.screen = [];    // full-screen colour flashes
        this.timers = [];    // delayed callbacks on the UI clock
        this.crack = null;   // KV light crack
        this.glows = [];     // banded world glows
        this.sprites = [];   // world-anchored art (e.g. the descending crown)
        this._last = 0;
        this.time = 0;
    }

    get px() { return Math.max(1, Math.round(this.game.hudScale || 2)); }
    // The world layer's pixel (shrinks when a cinematic pulls the FOV out).
    get wpx() { return Math.max(1, Math.round(this.game.worldScale || 2)); }

    rarityRamp(r) { return rampOf(RARITY_COLORS[r] || '#ffffff'); }

    after(sec, fn) { this.timers.push({ t: this.time + sec, fn }); }

    // ── primitives ──────────────────────────────────────────────────────────
    spark(x, y, vx, vy, life, ramp, o = {}) {
        if (this.parts.length >= MAX_PARTS) return;
        this.parts.push({ x, y, vx, vy, t: -(o.delay || 0), life, ramp, g: o.g || 0, drag: o.drag != null ? o.drag : 2,
            kind: o.kind || 0, w: !!o.world, wp: !!o.worldPixel, tx: o.tx, ty: o.ty, home: o.home || 0, ph: Math.random() * 6.28 });
    }

    burst(x, y, ramp, n, smin, smax, o = {}) {
        const dir = o.dir, spread = o.spread != null ? o.spread : TAU;
        for (let k = 0; k < n; k++) {
            const a = dir == null ? Math.random() * TAU : dir + (Math.random() - 0.5) * spread;
            const sp = (smin + Math.random() * (smax - smin)) * this.px;
            this.spark(x, y, Math.cos(a) * sp, Math.sin(a) * sp, (o.life || 0.6) * (0.6 + Math.random() * 0.6), ramp,
                { g: (o.g || 0) * this.px, drag: o.drag, kind: o.kind != null ? o.kind : (Math.random() < 0.3 ? 2 : 1), delay: o.delay ? Math.random() * o.delay : 0, world: o.world });
        }
    }

    // Sparks that fly from (x0,y0) and home into (x1,y1) — payments, power.
    stream(x0, y0, x1, y1, ramp, n, dur = 0.6, o = {}) {
        for (let k = 0; k < n; k++) {
            const a = Math.random() * TAU, sp = (60 + Math.random() * 140) * this.px;
            this.spark(x0, y0, Math.cos(a) * sp, Math.sin(a) * sp, dur + Math.random() * 0.25, ramp,
                { home: 1, tx: x1, ty: y1, kind: o.kind != null ? o.kind : 2, delay: k * (o.stagger || 0.02), world: o.world, drag: 3 });
        }
    }

    ring(x, y, r0, r1, dur, width, ramp, o = {}) { this.rings.push({ x, y, r0, r1, dur, width, ramp, t: -(o.delay || 0), w: !!o.world }); }
    raysAt(x, y, r, dur, cols, o = {}) { this.rays.push({ x, y, r, dur, cols, t: -(o.delay || 0), w: !!o.world, n: o.n || 12, spin: o.spin || 0.4, alpha: o.alpha || 0.5 }); }
    // A mote that orbits a world point on a tilted ellipse (halos, seals).
    orbiter(cx, cy, r, ang, spd, life, ramp, o = {}) {
        if (this.parts.length >= MAX_PARTS) return;
        this.parts.push({ x: cx, y: cy, vx: 0, vy: 0, t: -(o.delay || 0), life, ramp, g: 0, drag: 0, kind: o.kind != null ? o.kind : 2,
            w: true, wp: false, home: 0, ph: Math.random() * 6.28, bl: o.blend || null, orb: { cx, cy, r, ang, spd, tilt: o.tilt != null ? o.tilt : 0.4, rise: o.rise || 0 } });
    }
    // Soft banded glow (3 hard rings of light) on the world pixel grid.
    glow(x, y, r, col, dur, o = {}) { this.glows.push({ x, y, r, col, dur, t: -(o.delay || 0), peak: o.peak || 0.4, pulse: o.pulse || 0 }); }
    // World-anchored sprite that descends from (wx, wy0) to (wx, wy), then
    // hovers with a slow bob. Drawn at its native pixel size (×worldScale).
    sprite(key, wx, wy0, wy, dur, o = {}) {
        const a = this.game.assets && this.game.assets.get(key);
        const img = Array.isArray(a) ? a[0] : a;
        if (img) this.sprites.push({ img, wx, wy0, wy, dur, t: -(o.delay || 0), fall: o.fall || 1.4, blend: o.blend || 'source-over' });
    }
    flashRect(x, y, w, h, col, dur = 0.35) { this.flashes.push({ x, y, w, h, col, dur, t: 0 }); }
    flashScreen(col, dur = 0.4, peak = 0.6) { this.screen.push({ col, dur, peak, t: 0 }); }
    titleCard(title, sub, col, dur = 2.6, o = {}) { this.cards.push({ title, sub, col, dur, t: -(o.delay || 0), y: o.y != null ? o.y : 0.72, kicker: o.kicker || '' }); }

    _toScreen(x, y) {
        const cam = this.state.camera;
        return [x * cam.wtsScale + cam.wtsOffX, y * cam.wtsScale + cam.wtsOffY];
    }

    // ── recipes: interactions ──────────────────────────────────────────────
    // An item lands in a cache slot: rarity rays behind it, the slot flashes,
    // sparks fountain under gravity; epic+ rains confetti and rings out.
    cacheReveal(x, y, w, h, rarity) {
        const ramp = this.rarityRamp(rarity);
        const tier = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, unique: 4 }[rarity] || 0;
        const cx = x + w / 2, cy = y + h / 2, px = this.px;
        this.flashRect(x, y, w, h, ramp[3], 0.3 + tier * 0.08);
        this.raysAt(cx, cy, Math.max(w, h) * (0.9 + tier * 0.35), 0.9 + tier * 0.3, [ramp[1], ramp[2], ramp[3]], { n: 10 + tier * 2, alpha: 0.35 + tier * 0.08 });
        this.burst(cx, cy, ramp, 10 + tier * 10, 80, 220 + tier * 40, { g: 260, life: 0.9, dir: -Math.PI / 2, spread: 2.6, drag: 1.2 });
        if (tier >= 2) this.ring(cx, cy, 4 * px, (40 + tier * 14) * px, 0.5, 2, ramp);
        if (tier >= 3) {
            this.ring(cx, cy, 4 * px, (70 + tier * 10) * px, 0.7, 2, ramp, { delay: 0.12 });
            for (let k = 0; k < 18 + (tier - 3) * 18; k++) {
                const x0 = cx + (Math.random() - 0.5) * this.game.width * 0.6;
                this.spark(x0, -10, (Math.random() - 0.5) * 40 * px, (40 + Math.random() * 80) * px, 1.6, ramp, { g: 120 * px, drag: 1, kind: 3, delay: Math.random() * 0.6 });
            }
            this.flashScreen(ramp[3], 0.35, tier >= 4 ? 0.35 : 0.18);
        }
        const sx = this.state.sfx;
        if (sx) { sx.chime(0.12 + tier * 0.04); if (tier >= 3) sx.thump(0.6 + tier * 0.2, null, null, 0.3); }
    }

    // Paying for an item: gold spills from the SCRAP label into it, then it
    // flashes as it's yours.
    shopBuy(x, y, w, h, rarity, fromX, fromY) {
        const cx = x + w / 2, cy = y + h / 2;
        this.stream(fromX, fromY, cx, cy, GOLD, 14, 0.45, { stagger: 0.015 });
        this.after(0.45, () => {
            const ramp = this.rarityRamp(rarity);
            this.flashRect(x, y, w, h, ramp[3], 0.35);
            this.burst(cx, cy, ramp, 16, 80, 240, { g: 240, life: 0.7, dir: -Math.PI / 2, spread: 2.4 });
            this.raysAt(cx, cy, Math.max(w, h) * 0.9, 0.6, [ramp[1], ramp[2], ramp[3]], { n: 10, alpha: 0.3 });
            if (this.state.sfx) this.state.sfx.cash();
        });
    }

    shopSell(x, y, w, h, toX, toY) {
        const cx = x + w / 2, cy = y + h / 2;
        this.flashRect(x, y, w, h, '#fff3b0', 0.25);
        this.stream(cx, cy, toX, toY, GOLD, 12, 0.45, { stagger: 0.015 });
        this.after(0.45, () => { this.burst(toX, toY, GOLD, 10, 40, 140, { life: 0.4 }); if (this.state.sfx) this.state.sfx.cash(); });
    }

    // Can't afford: a red flash and a sputter of sparks that fall flat.
    shopFail(x, y, w, h) {
        this.flashRect(x, y, w, h, '#e03030', 0.3);
        this.burst(x + w / 2, y + h / 2, RED, 10, 40, 120, { g: 300, life: 0.5 });
        if (this.state.sfx) this.state.sfx.denied();
    }

    // Permanent upgrade bought: the button blazes, a ring, sparks rise.
    permBuy(x, y, w, h) {
        this.flashRect(x, y, w, h, '#ffffff', 0.35);
        this.ring(x + w / 2, y + h / 2, 4 * this.px, 60 * this.px, 0.5, 2, GOLD);
        this.burst(x + w / 2, y + h / 2, GOLD, 22, 80, 260, { g: -60, life: 0.8, dir: -Math.PI / 2, spread: 2 });
        if (this.state.sfx) { this.state.sfx.cash(); this.state.sfx.chime(0.14); }
    }

    // Level-up pick: the card blazes in its bonus colour, then its power
    // streams out of the dialog and into your ship.
    levelPick(rect, color, cursed, shipX, shipY) {
        const ramp = cursed ? ['#120a1e', '#2e1a4a', '#7a3ab8', '#c8a0ff', '#ffffff'] : rampOf(color || '#ffff44');
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        this.flashRect(rect.x, rect.y, rect.w, rect.h, ramp[3], 0.4);
        this.raysAt(cx, cy, rect.w * 0.7, 0.8, [ramp[1], ramp[2], ramp[3]], { n: 14, alpha: 0.35 });
        this.burst(cx, cy, ramp, 22, 80, 260, { life: 0.6 });
        for (let k = 0; k < 4; k++) {
            this.spark(rect.x + Math.random() * rect.w, rect.y + (k % 2 ? rect.h : 0), 0, 0, 0.1, ramp, { kind: 2 });
        }
        if (shipX != null) {
            this.stream(cx, cy, shipX, shipY, ramp, 26, 0.7, { stagger: 0.012 });
            this.after(0.75, () => {
                this.ring(shipX, shipY, 6 * this.px, 50 * this.px, 0.45, 2, ramp);
                this.burst(shipX, shipY, ramp, 18, 60, 200, { life: 0.5 });
                if (this.state.sfx) this.state.sfx.chime(0.18);
            });
        }
    }

    levelSkip(rect) {
        const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
        this.flashRect(rect.x, rect.y, rect.w, rect.h, '#ffd866', 0.35);
        this.burst(cx, cy, GOLD, 18, 60, 200, { g: 200, life: 0.7 });
        if (this.state.sfx) this.state.sfx.coin(4);
    }

    encounterPick(rect) {
        this.flashRect(rect.x, rect.y, rect.w, rect.h, '#9fd0ff', 0.3);
        this.burst(rect.x + 6 * this.px, rect.y + rect.h / 2, WHITE, 12, 60, 200, { dir: 0, spread: 1.2, life: 0.45 });
    }

    consumable(x, y, color) {
        const ramp = rampOf(color || '#c9a6ec');
        this.ring(x, y, 4 * this.px, 50 * this.px, 0.45, 2, ramp);
        this.burst(x, y, ramp, 24, 60, 220, { life: 0.6 });
        this.raysAt(x, y, 50 * this.px, 0.7, [ramp[1], ramp[2], ramp[3]], { n: 12, alpha: 0.35 });
    }

    // ── frame: update + draw ───────────────────────────────────────────────
    frame(ctx) {
        const now = performance.now();
        const dt = this._last ? Math.min(0.05, (now - this._last) / 1000) : 0.016;
        this._last = now;
        this.time += dt;
        for (let i = this.timers.length - 1; i >= 0; i--) {
            if (this.time >= this.timers[i].t) { const f = this.timers[i].fn; this.timers.splice(i, 1); f(); }
        }
        if (this.onFrame) this.onFrame(dt);
        if (!this.parts.length && !this.rings.length && !this.rays.length && !this.flashes.length && !this.cards.length && !this.screen.length && !this.crack && !this.glows.length && !this.sprites.length) return;
        const px = this.px, W = this.game.width, H = this.game.height;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        // Full-screen flashes first (under everything else this layer draws).
        for (let i = this.screen.length - 1; i >= 0; i--) {
            const f = this.screen[i]; f.t += dt;
            if (f.t >= f.dur) { this.screen.splice(i, 1); continue; }
            ctx.globalAlpha = f.peak * (1 - f.t / f.dur);
            ctx.fillStyle = f.col; ctx.fillRect(0, 0, W, H);
        }
        this._drawGlows(ctx, dt);
        this._drawSprites(ctx, dt);
        this._drawRays(ctx, dt, px);
        if (this.crack) this._drawCrack(ctx, dt, px, W, H);
        ctx.globalCompositeOperation = 'source-over';
        // Rect flashes: flat fill fading + a bright 1px frame.
        for (let i = this.flashes.length - 1; i >= 0; i--) {
            const f = this.flashes[i]; f.t += dt;
            if (f.t >= f.dur) { this.flashes.splice(i, 1); continue; }
            const u = f.t / f.dur;
            ctx.globalAlpha = 0.45 * (1 - u);
            ctx.fillStyle = f.col; ctx.fillRect(f.x, f.y, f.w, f.h);
            ctx.globalAlpha = 1 - u;
            ctx.fillRect(f.x, f.y, f.w, px); ctx.fillRect(f.x, f.y + f.h - px, f.w, px);
            ctx.fillRect(f.x, f.y, px, f.h); ctx.fillRect(f.x + f.w - px, f.y, px, f.h);
        }
        this._drawRings(ctx, dt, px);
        this._drawParts(ctx, dt, px, W, H);
        this._drawCards(ctx, dt, px, W, H);
        ctx.restore();
    }

    _drawParts(ctx, dt, px, W, H) {
        ctx.globalAlpha = 1;
        let blend = 'source-over';
        ctx.globalCompositeOperation = blend;
        for (let i = this.parts.length - 1; i >= 0; i--) {
            const p = this.parts[i];
            p.t += dt;
            if (p.t < 0) continue;
            if (p.t >= p.life) { this.parts[i] = this.parts[this.parts.length - 1]; this.parts.pop(); continue; }
            const u = p.t / p.life;
            if (p.orb) {
                // Orbit (world space): position from angle each frame.
                const o = p.orb, a = o.ang + o.spd * p.t;
                p.x = o.cx + Math.cos(a) * o.r;
                p.y = o.cy + Math.sin(a) * o.r * o.tilt - o.rise * p.t;
                p.vx = 0; p.vy = 0;
            } else if (p.home) {
                // Steer into the target, harder as time runs out.
                let tx = p.tx, ty = p.ty;
                const k = 6 + u * 30;
                p.vx += ((tx - p.x) * k - p.vx * 3) * dt;
                p.vy += ((ty - p.y) * k - p.vy * 3) * dt;
                if (u > 0.85) { p.x += (tx - p.x) * 0.3; p.y += (ty - p.y) * 0.3; }
            } else {
                p.vy += p.g * dt;
                const d = Math.exp(-p.drag * dt);
                p.vx *= d; p.vy *= d;
            }
            if (p.kind === 3) p.x += Math.sin(p.t * 8 + p.ph) * 20 * px * dt;
            if (!p.orb) { p.x += p.vx * dt; p.y += p.vy * dt; }
            let sx = p.x, sy = p.y;
            if (p.w) [sx, sy] = this._toScreen(p.x, p.y);
            if (sx < -20 || sy < -20 || sx > W + 20 || sy > H + 20) continue;
            const ci = Math.max(0, Math.min(p.ramp.length - 1, Math.round((1 - u * u) * (p.ramp.length - 1))));
            const c = p.ramp[ci];
            const want = p.bl || 'source-over';
            if (want !== blend) { blend = want; ctx.globalCompositeOperation = blend; }
            // One pixel of the layer the particle belongs to (world-anchored /
            // world-pixel particles use the world pixel, UI ones the HUD pixel).
            const s = (p.w || p.wp) ? this.wpx : px;
            const X = Math.round(sx / s) * s, Y = Math.round(sy / s) * s;
            ctx.fillStyle = c;
            if (p.kind === 1) {
                // Streak: 3 pixels back along velocity, dimmer tail.
                const sp = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
                const dx = -p.vx / sp * px, dy = -p.vy / sp * px;
                ctx.fillRect(X, Y, s, s);
                const ddx = dx / px * s, ddy = dy / px * s;
                ctx.fillStyle = p.ramp[Math.max(0, ci - 1)];
                ctx.fillRect(Math.round((sx + ddx) / s) * s, Math.round((sy + ddy) / s) * s, s, s);
                ctx.fillStyle = p.ramp[Math.max(0, ci - 2)];
                ctx.fillRect(Math.round((sx + ddx * 2) / s) * s, Math.round((sy + ddy * 2) / s) * s, s, s);
            } else if (p.kind === 2) {
                // 4-ray twinkle star.
                const L = u < 0.5 ? 2 : 1;
                ctx.fillRect(X, Y, s, s);
                ctx.fillStyle = p.ramp[Math.max(0, ci - 1)];
                for (let k = 1; k <= L; k++) {
                    ctx.fillRect(X + k * s, Y, s, s); ctx.fillRect(X - k * s, Y, s, s);
                    ctx.fillRect(X, Y + k * s, s, s); ctx.fillRect(X, Y - k * s, s, s);
                }
            } else if (p.kind === 3) {
                // Confetti: tumbles between tall and wide.
                const tall = ((p.t * 7 + p.ph) | 0) % 2 === 0;
                ctx.fillStyle = p.ramp[2 + (((p.ph * 10) | 0) % 2)];
                ctx.fillRect(X, Y, tall ? s : s * 2, tall ? s * 2 : s);
            } else {
                ctx.fillRect(X, Y, s, s);
            }
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    _drawRings(ctx, dt, px) {
        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.t += dt;
            if (r.t < 0) continue;
            if (r.t >= r.dur) { this.rings.splice(i, 1); continue; }
            const u = r.t / r.dur, e = 1 - Math.pow(1 - u, 3);
            let x = r.x, y = r.y, scale = 1;
            if (r.w) { [x, y] = this._toScreen(r.x, r.y); scale = this.state.camera.wtsScale; }
            const R = (r.r0 + (r.r1 - r.r0) * e) * scale;
            const w = Math.max(1, Math.round(r.width * (1 - u) + u));
            const ci = Math.max(0, Math.round((1 - u) * (r.ramp.length - 1)));
            ctx.globalAlpha = 1;
            ctx.fillStyle = r.ramp[ci];
            // Solid scanline annulus on its layer's pixel grid.
            px = r.w ? this.wpx : this.px;
            const cxc = Math.round(x / px), cyc = Math.round(y / px);
            const ro = R / px, ri = Math.max(0, ro - w);
            const ro2 = (ro + 0.5) * (ro + 0.5), ri2 = (ri + 0.5) * (ri + 0.5);
            const J = Math.floor(ro + 0.5);
            ctx.beginPath();
            for (let j = -J; j <= J; j++) {
                const jj = j * j, xo = Math.floor(Math.sqrt(Math.max(0, ro2 - jj)));
                if (jj < ri2) {
                    const xi = Math.floor(Math.sqrt(ri2 - jj)) + 1;
                    if (xi > xo) continue;
                    ctx.rect((cxc - xo) * px, (cyc + j) * px, (xo - xi + 1) * px, px);
                    ctx.rect((cxc + xi) * px, (cyc + j) * px, (xo - xi + 1) * px, px);
                } else ctx.rect((cxc - xo) * px, (cyc + j) * px, (xo * 2 + 1) * px, px);
            }
            ctx.fill();
        }
    }

    // Rotating hard rays (3 colour bands), additive. Rasterised into a
    // low-res buffer at the layer's pixel size (HUD pixel for UI bursts,
    // world pixel for world-anchored ones) and blown up with nearest-
    // neighbour, so they're real pixel art — never smooth vector edges.
    _drawRays(ctx, dt, px) {
        if (!this.rays.length) return;
        const W = this.game.width, H = this.game.height;
        for (const layer of [0, 1]) {
            const lp = layer ? this.wpx : this.px;
            const bw = Math.ceil(W / lp), bh = Math.ceil(H / lp);
            let any = false;
            for (const r of this.rays) if (!!r.w === !!layer && r.t >= 0) { any = true; break; }
            if (!any) continue;
            const buf = this._rayBuf || (this._rayBuf = document.createElement('canvas'));
            if (buf.width !== bw || buf.height !== bh) { buf.width = bw; buf.height = bh; }
            const g = buf.getContext('2d');
            g.clearRect(0, 0, bw, bh);
            g.globalCompositeOperation = 'lighter';
            for (const r of this.rays) {
                if (!!r.w !== !!layer || r.t < 0) continue;
                const u = r.t / r.dur;
                const env = u < 0.15 ? u / 0.15 : u > 0.6 ? 1 - (u - 0.6) / 0.4 : 1;
                let x = r.x, y = r.y, scale = 1;
                if (r.w) { [x, y] = this._toScreen(r.x, r.y); scale = this.state.camera.wtsScale; }
                x /= lp; y /= lp;
                const R = r.r * scale * (0.6 + 0.4 * env) / lp;
                const rot = r.t * r.spin;
                const bandR = [1, 0.66, 0.36];
                for (let b2 = 0; b2 < 3; b2++) {
                    g.globalAlpha = r.alpha * env;
                    g.fillStyle = r.cols[b2];
                    g.beginPath();
                    const rr = R * bandR[b2];
                    for (let k = 0; k < r.n; k++) {
                        const a = rot + (k / r.n) * TAU, hw = (TAU / r.n) * 0.22;
                        g.moveTo(x + Math.cos(a - hw), y + Math.sin(a - hw));
                        g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
                        g.lineTo(x + Math.cos(a + hw), y + Math.sin(a + hw));
                        g.closePath();
                    }
                    g.fill();
                }
            }
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 1;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(buf, 0, 0, bw * lp, bh * lp);
        }
        for (let i = this.rays.length - 1; i >= 0; i--) {
            const r = this.rays[i];
            r.t += dt;
            if (r.t >= r.dur) this.rays.splice(i, 1);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    _drawSprites(ctx, dt) {
        for (let i = this.sprites.length - 1; i >= 0; i--) {
            const s = this.sprites[i];
            s.t += dt;
            if (s.t < 0) continue;
            if (s.t >= s.dur) { this.sprites.splice(i, 1); continue; }
            const f = Math.min(1, s.t / s.fall), e = 1 - Math.pow(1 - f, 3);
            const wy = s.wy0 + (s.wy - s.wy0) * e + (f >= 1 ? Math.sin((s.t - s.fall) * 2) * 3 : 0);
            const [x, y] = this._toScreen(s.wx, wy);
            const ws = this.game.worldScale, wp = this.wpx;
            const cv = s.img.canvas || s.img;
            const w = (s.img.width || cv.width) * ws, h = (s.img.height || cv.height) * ws;
            ctx.globalAlpha = Math.min(1, s.t / 0.4, (s.dur - s.t) / 0.6);
            ctx.globalCompositeOperation = s.blend;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(cv, Math.round((x - w / 2) / wp) * wp, Math.round((y - h / 2) / wp) * wp, w, h);
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    _drawGlows(ctx, dt) {
        if (!this.glows.length) return;
        const wp = this.wpx;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = this.glows.length - 1; i >= 0; i--) {
            const g = this.glows[i];
            g.t += dt;
            if (g.t < 0) continue;
            if (g.t >= g.dur) { this.glows.splice(i, 1); continue; }
            const u = g.t / g.dur;
            const env = (u < 0.25 ? u / 0.25 : u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1) * (1 + g.pulse * Math.sin(this.time * 3));
            const [x, y] = this._toScreen(g.x, g.y);
            const R0 = g.r * this.state.camera.wtsScale;
            ctx.fillStyle = g.col;
            // Steep falloff: faint wide bands, a small bright core.
            for (const [k, al] of [[1, 0.035], [0.7, 0.06], [0.42, 0.12], [0.2, 0.28]]) {
                ctx.globalAlpha = al * env * g.peak * 2.5;
                ctx.beginPath();
                const R = R0 * k, J = Math.floor(R / wp);
                for (let j = -J; j <= J; j++) {
                    const yy = j * wp, hw = Math.sqrt(Math.max(0, R * R - yy * yy));
                    const x0 = Math.round((x - hw) / wp) * wp, x1 = Math.round((x + hw) / wp) * wp;
                    if (x1 > x0) ctx.rect(x0, Math.round((y + yy) / wp) * wp, x1 - x0, wp);
                }
                ctx.fill();
            }
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }

    // Title card: letter-spaced name in its colour, small kicker above, a
    // sub-line below, a hard rule; fades in/out, flashes white on entry.
    _drawCards(ctx, dt, px, W, H) {
        for (let i = this.cards.length - 1; i >= 0; i--) {
            const c = this.cards[i];
            c.t += dt;
            if (c.t < 0) continue;
            if (c.t >= c.dur) { this.cards.splice(i, 1); continue; }
            const u = c.t;
            const a = Math.min(1, u / 0.18, (c.dur - u) / 0.5);
            const hs = this.game.hudScale || 2;
            const y = Math.round(H * c.y);
            ctx.globalAlpha = a;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            // Rule that draws outward from the centre.
            const ruleW = Math.min(1, u / 0.4) * W * 0.32;
            ctx.fillStyle = c.col;
            ctx.fillRect(Math.round(W / 2 - ruleW / 2), y + 5 * hs, Math.round(ruleW), px);
            if (c.kicker) {
                ctx.font = `${5 * hs}px Astro4x`;
                ctx.fillStyle = '#9fb4cc';
                ctx.fillText(c.kicker, W / 2, y - 11 * hs);
            }
            ctx.font = `${12 * hs}px Astro4x`;
            ctx.fillStyle = '#000000';
            ctx.fillText(c.title, W / 2 + hs, y + hs);
            ctx.fillStyle = u < 0.12 ? '#ffffff' : c.col;
            ctx.fillText(c.title, W / 2, y);
            if (c.sub) {
                ctx.font = `${5 * hs}px Astro4x`;
                ctx.fillStyle = '#d8e4f0';
                ctx.fillText(c.sub, W / 2, y + 13 * hs);
            }
        }
        ctx.globalAlpha = 1;
    }

    // ── Yellow One: a crack of light through the game-over screen ──────────
    startCrack(dur = 2.6) { this.crack = { t: 0, dur, pts: null, gen: -1 }; }
    stopCrack() { this.crack = null; }
    _drawCrack(ctx, dt, px, W, H) {
        const c = this.crack;
        c.t += dt;
        const u = Math.min(1, c.t / c.dur);
        // Regenerate the jagged line a few times a second (it "crawls").
        const g = Math.floor(c.t * 6);
        if (g !== c.gen) {
            c.gen = g;
            const n = 24, pts = [];
            for (let k = 0; k <= n; k++) pts.push((Math.random() - 0.5) * 10 * px * (1 - Math.abs(k / n - 0.5) * 1.2));
            c.pts = pts;
        }
        const len = H * Math.min(1, u * 1.4);
        const y0 = H / 2 - len / 2, cx = W / 2;
        const width = (1 + u * u * 18) * px;
        ctx.globalCompositeOperation = 'lighter';
        const bands = [[width * 6, 0.12, '#fff3b0'], [width * 2.5, 0.35, '#ffe9a0'], [width, 0.9, '#ffffff']];
        for (const [w, al, col] of bands) {
            ctx.globalAlpha = al * Math.min(1, u * 3);
            ctx.fillStyle = col;
            const n = c.pts.length - 1;
            for (let k = 0; k < n; k++) {
                const yy = y0 + (k / n) * len, hh = len / n + 1;
                ctx.fillRect(Math.round((cx + c.pts[k] - w / 2) / px) * px, Math.round(yy / px) * px, Math.max(px, Math.round(w / px) * px), Math.ceil(hh / px) * px);
            }
        }
        // Motes of light drift up out of the crack.
        if (Math.random() < 0.6) {
            const yy = y0 + Math.random() * len;
            this.spark(cx + (Math.random() - 0.5) * width * 2, yy, (Math.random() - 0.5) * 30 * px, -(20 + Math.random() * 50) * px, 1.4, GOLD, { kind: 2, drag: 0.5 });
        }
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
    }
}
