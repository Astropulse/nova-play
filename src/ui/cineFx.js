// CineFX — directs extra spectacle over the game's two great cinematics,
// keyed to each one's OWN clock so every beat lands on its moment:
//
//   • The Yellow One's death / King's Victory (yellowOne.scriptPhase +
//     scriptTimer). Story beats: light cracks through the false game-over;
//     heaven opens; the deed (the claim held against you) is lit, then torn;
//     the Yellow One's stolen light drains out of it toward Christus and is
//     made white; Christus is crowned in a pillar of light; the stars rise
//     into the constellation.
//   • The Dragon's arrival (dragon.cin.t) and victory. Story beats: a
//     heartbeat in the silence and red light on the horizon where each head
//     comes from; each of the seven is named as it takes its seat; a held
//     breath; the charge; the pulse; its tail sweeps a third of the stars
//     from the sky; lightning carves the sigil; ignition; the name.
//
// Wordless by design (scripture captions are available behind
// SHOW_SCRIPTURE but off); the Dragon keeps its head name cards and a
// victory card.
//
// Runs from UIFX.onFrame (self-clocked — the KV death screen freezes the
// sim). Screen effects go through UIFX; world-anchored ones are projected
// through the live camera; world ImpactFX bolts/bursts are used where the
// sim is running. Cosmetic only.

import { RAMP, LIGHT, SUN_STAR, SUN_GOLD } from './impactFx.js';

const SHOW_SCRIPTURE = false; // the user prefers the cinematics wordless
const TAU = Math.PI * 2;
const GOLD = ['#7a4a10', '#c98a1c', '#ffd24a', '#fff3b0', '#ffffff'];
const YELLOW_TO_WHITE = ['#6a5a00', '#c8c020', '#ffff44', '#ffffc8', '#ffffff'];
const WHITE = ['#8a9ab8', '#c8d8f0', '#ffffff', '#ffffff', '#ffffff'];
const BLOOD = ['#2a0606', '#5a0c0c', '#a01818', '#e04030', '#ffb0a0'];
const SUN_BLOOD = ['#5a0c0c', '#e04030', '#ffb0a0'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export class CineFX {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.kv = null;      // { yo, fired:Set, phase, acc }
        this.dr = null;      // { d, fired:Set, acc, beat }
    }

    get ui() { return this.state.uiFx; }
    get fx() { return this.state.impactFx; }
    get sfx() { return this.state.sfx; }

    tick(dt) {
        const s = this.state;
        let yo = null, dragon = null;
        for (const e of s.events) {
            const n = e.constructor && e.constructor.name;
            if (n === 'YellowOne' && (e.state === 'scripted' || (this.kv && this.kv.yo === e))) yo = e;
            else if (n === 'Dragon' && (e.state === 'dragon_cinematic' || e.state === 'dragon_victory')) dragon = e;
        }
        if (yo) this._kv(yo, dt); else this.kv = null;
        if (dragon) this._dragon(dragon, dt); else this.dr = null;
    }

    // Fire `fn` once when `t` first passes `at`.
    _once(m, key, t, at, fn) {
        if (t >= at && !m.fired.has(key)) { m.fired.add(key); fn(); }
    }

    _scr(x, y) {
        const c = this.state.camera;
        return [x * c.wtsScale + c.wtsOffX, y * c.wtsScale + c.wtsOffY];
    }

    _caption(kicker, title = '', col = '#fff3b0', dur = 3.6, y = 0.82) {
        if (!SHOW_SCRIPTURE && !title) return;
        this.ui.titleCard(title, '', col, dur, { kicker: SHOW_SCRIPTURE ? kicker : '', y });
    }

    // ══ The Yellow One — King's Victory ═══════════════════════════════════
    _kv(yo, dt) {
        const ui = this.ui, W = this.game.width, H = this.game.height;
        if (!this.kv || this.kv.yo !== yo) this.kv = { yo, fired: new Set(), acc: 0, acc2: 0 };
        const m = this.kv;
        const ph = yo.scriptPhase, t = yo.scriptTimer || 0;
        const px = ui.px;

        if (yo.state === 'scripted' && ph === 0) {
            // The false ending. Then — a hairline of light.
            this._once(m, 'p0a', t, 4.0, () => {
                ui.spark(W / 2, H * 0.25, 0, 12 * px, 2.2, GOLD, { kind: 2, drag: 0 });
                if (this.sfx) this.sfx.shimmer(5, 0.1);
            });
            this._once(m, 'p0b', t, 4.5, () => ui.startCrack(1.6));
            return;
        }
        if (yo.state === 'scripted' && ph === 2) {
            this._once(m, 'enter', t, 0, () => {
                ui.stopCrack();
                // Heaven opens: a heavier fall of light through the clearing white.
                for (let k = 0; k < 60; k++) ui.spark(Math.random() * W, Math.random() * H * 0.6, 0, (15 + Math.random() * 25) * px, 3 + Math.random() * 2, GOLD, { kind: Math.random() < 0.4 ? 2 : 0, drag: 0, delay: Math.random() * 1.5 });
            });
            // Light falls like snow while the scene clears.
            if (t < 7) {
                m.acc += dt * 14;
                while (m.acc >= 1) {
                    m.acc -= 1;
                    ui.spark(Math.random() * W, -8, (Math.random() - 0.5) * 10 * px, (20 + Math.random() * 30) * px, 4, GOLD, { kind: Math.random() < 0.3 ? 2 : 0, drag: 0 });
                }
            }
            const dx = yo.deedWorldX, dy = yo.deedWorldY;
            this._once(m, 'deed', t, 7.0, () => {
                // The deed is held in a seal of slowly turning light.
                ui.glow(dx, dy, 80, '#fff3b0', 3.2, { peak: 0.4, pulse: 0.15 });
                for (let k = 0; k < 18; k++) ui.orbiter(dx, dy, 52 + (k % 3) * 6, (k / 18) * TAU, 0.9, 3.0, GOLD, { delay: k * 0.04, tilt: 0.45, kind: k % 3 ? 0 : 2 });
                ui.raysAt(dx, dy, 140, 3.0, ['#c98a1c', '#ffd24a', '#fff3b0'], { world: true, n: 16, alpha: 0.3, spin: 0.25 });
            });
            this._once(m, 'tear', t, 10.0, () => {
                ui.flashScreen('#fff3b0', 0.5, 0.55);
                ui.raysAt(dx, dy, 320, 1.6, ['#ffd24a', '#fff3b0', '#ffffff'], { world: true, n: 20, alpha: 0.55, spin: 0.6 });
                ui.burst(dx, dy, GOLD, 70, 80, 320, { world: true, life: 1.6, drag: 1.2 });
                ui.ring(dx, dy, 10, 700, 1.0, 3, GOLD, { world: true });
                if (this.sfx) this.sfx.thump(2, null, null, 0.6);
            });
            // The drain: with the deed gone, the stolen yellow pours out of
            // the Yellow One toward Christus, and turns white on the way.
            if (t >= 10.3 && t < 15.2 && !yo._yellowOneHidden) {
                // A river, not a trickle: dense, mixed-size motes.
                m.acc2 += dt * 90;
                while (m.acc2 >= 1) {
                    m.acc2 -= 1;
                    const a = Math.random() * TAU, r = 20 + Math.random() * 50;
                    ui.spark(yo.worldX + Math.cos(a) * r, yo.worldY + Math.sin(a) * r, Math.cos(a) * 80, Math.sin(a) * 80 - 60,
                        2.0 + Math.random() * 0.8, YELLOW_TO_WHITE, { world: true, home: 1, tx: yo.christusX + (Math.random() - 0.5) * 40, ty: yo.christusY + (Math.random() - 0.5) * 40,
                            kind: Math.random() < 0.35 ? 2 : 0 });
                }
                // The Yellow One visibly weakens: a pale glow pulses on him.
                if (Math.random() < dt * 6) this.fx.light(yo.worldX, yo.worldY, 90, 0.5, 0.2, LIGHT.level, 1);
                if (Math.random() < dt * 1.5) {
                    ui.burst(yo.worldX, yo.worldY, YELLOW_TO_WHITE, 14, 60, 200, { world: true, life: 0.6 });
                    if (this.sfx) this.sfx.thump(0.8, null, null, 0.25);
                }
            }
            this._once(m, 'spoil', t, 15.4, () => {
                // He comes apart: the last of the yellow implodes, then bursts.
                ui.flashScreen('#ffff88', 0.4, 0.4);
                ui.ring(yo.worldX, yo.worldY, 10, 500, 0.9, 3, YELLOW_TO_WHITE, { world: true });
                ui.burst(yo.worldX, yo.worldY, YELLOW_TO_WHITE, 60, 100, 380, { world: true, life: 1.4, g: -40 });
            });
            this._once(m, 'crown', t, 17.0, () => {
                const cx = yo.christusX, cy = yo.christusY;
                // The Lamb's head sits up-left of the sprite centre (measured
                // from christus_victor.gif: head centre ≈ (-34, -62)).
                const hx = cx - 34, hy = cy - 66;
                // Crowned: a soft banded glow rises behind him, a halo of
                // gold stars turns around his head, light descends into him.
                ui.glow(cx, cy, 110, '#fff3b0', 4.6, { peak: 0.4, pulse: 0.1 });
                // The crown comes down from above and settles on his head.
                ui.sprite('christus_victor_crown', hx, hy - 360, hy - 40, 4.3, { fall: 1.5, delay: 0.2, blend: 'screen' });
                ui.after(1.7, () => { ui.burst(hx, hy - 40, GOLD, 20, 40, 140, { world: true, life: 0.8 }); if (this.sfx) this.sfx.chime(0.18); });
                // The halo: two counter-turning rings of gold stars, screen-
                // blended so they glow over the art.
                for (let k = 0; k < 24; k++) ui.orbiter(hx, hy - 6, 50, (k / 24) * TAU, 1.1, 4.4, GOLD, { delay: 0.3 + k * 0.03, tilt: 0.3, kind: 2, blend: 'screen' });
                for (let k = 0; k < 14; k++) ui.orbiter(hx, hy - 6, 36, (k / 14) * TAU, -1.6, 4.4, ['#c98a1c', '#ffd24a', '#fff3b0', '#ffffff', '#ffffff'], { delay: 0.6 + k * 0.03, tilt: 0.3, kind: 0, blend: 'screen' });
                ui.raysAt(cx, cy, 220, 4.6, ['#c8d8f0', '#fff3b0', '#ffffff'], { world: true, n: 18, alpha: 0.3, spin: 0.2 });
                if (this.sfx) this.sfx.shimmer(4.5, 0.12);
            });
            if (t >= 17 && t < 21) {
                // Light descends into him from above.
                if (Math.random() < dt * 14) ui.spark(yo.christusX - 34 + (Math.random() - 0.5) * 120, yo.christusY - 460, 0, 0, 1.6, GOLD,
                    { world: true, home: 1, tx: yo.christusX - 34 + (Math.random() - 0.5) * 20, ty: yo.christusY - 66, kind: Math.random() < 0.5 ? 2 : 0 });
                // White motes gather to him.
                m.acc += dt * 20;
                while (m.acc >= 1) {
                    m.acc -= 1;
                    const a = Math.random() * TAU, r = 140 + Math.random() * 160;
                    ui.spark(yo.christusX + Math.cos(a) * r, yo.christusY + Math.sin(a) * r, 0, 0, 1.2, WHITE,
                        { world: true, home: 1, tx: yo.christusX, ty: yo.christusY, kind: 2 });
                }
            }
            this._once(m, 'rise', t, 20.9, () => {
                const cx = yo.christusX, cy = yo.christusY;
                ui.flashScreen('#ffffff', 0.7, 0.6);
                ui.ring(cx, cy, 10, 900, 1.2, 4, WHITE, { world: true });
                // The stars fly out and settle back into his constellation.
                for (let k = 0; k < 40; k++) {
                    const a = Math.random() * TAU, sp = 200 + Math.random() * 300;
                    ui.spark(cx, cy, Math.cos(a) * sp, Math.sin(a) * sp, 2.4, WHITE, { world: true, kind: 2, drag: 1.4 });
                }
                if (this.sfx) this.sfx.chime(0.3);
            });
            return;
        }
        // Finished: a last slow drift of light while the music plays out.
        if (yo.state === 'finished') {
            this._once(m, 'after', 0, 0, () => {
                for (let k = 0; k < 30; k++) ui.spark(Math.random() * W, -10, 0, (15 + Math.random() * 25) * px, 5, GOLD, { kind: 2, drag: 0, delay: Math.random() * 3 });
            });
        }
    }

    // ══ The Dragon — arrival + victory ════════════════════════════════════
    _dragon(d, dt) {
        const ui = this.ui, fx = this.fx, W = this.game.width, H = this.game.height;
        if (!this.dr || this.dr.d !== d) this.dr = { d, fired: new Set(), acc: 0, hb: 0.6, hbAt: 0.6, lastPos: new Map(), ar: 0 };
        const m = this.dr;
        const px = ui.px;

        if (d.state === 'dragon_victory') {
            this._once(m, 'victory', 0, 0, () => {
                ui.flashScreen('#fff3b0', 0.6, 0.5);
                for (const h of d.heads) ui.raysAt(h.worldX, h.worldY, 220, 3.5, ['#c98a1c', '#ffd24a', '#fff3b0'], { world: true, n: 14, alpha: 0.4 });
                this._caption('AND THE GREAT DRAGON WAS CAST OUT', 'THE DRAGON FALLS', '#ffd24a', 5, 0.78);
                if (this.sfx) this.sfx.shimmer(5, 0.12);
            });
            return;
        }
        const cin = d.cin;
        if (!cin) return;
        const t = cin.t || 0;
        const cx = cin.center ? cin.center.x : d.worldX, cy = cin.center ? cin.center.y : d.worldY;

        // ── 0–7.6s: the heartbeat in the silence ──
        this._once(m, 'drone', t, 0.1, () => { if (this.sfx) this.sfx.drone(9, 0.16); });
        if (t >= m.hbAt && t < 7.5) {
            if (this.sfx) this.sfx.heartbeat(0.35 + (t / 7.5) * 0.35);
            m.hb = Math.max(0.42, 1.05 - t * 0.085);
            m.hbAt = t + m.hb;
        }
        // Red light on the horizon where each unseated head is coming from.
        if (t > 0.2 && t < 7.0 && d.heads) {
            m.acc += dt * 16;
            while (m.acc >= 1) {
                m.acc -= 1;
                const h = d.heads[(Math.random() * d.heads.length) | 0];
                if (!h || (cin.arrivals != null && d.heads.indexOf(h) < cin.arrivals && h._seated)) continue;
                const [hx, hy] = this._scr(h.worldX, h.worldY);
                if (hx > 0 && hx < W && hy > 0 && hy < H) continue;
                const a = Math.atan2(hy - H / 2, hx - W / 2);
                // Project onto the screen edge.
                const k = Math.min(Math.abs((W / 2 - 6) / (Math.cos(a) || 1e-6)), Math.abs((H / 2 - 6) / (Math.sin(a) || 1e-6)));
                const ex = W / 2 + Math.cos(a) * k, ey = H / 2 + Math.sin(a) * k;
                const sp = (40 + Math.random() * 80) * px;
                ui.spark(ex + (Math.random() - 0.5) * 30 * px, ey + (Math.random() - 0.5) * 30 * px, -Math.cos(a) * sp, -Math.sin(a) * sp, 0.6, BLOOD, { kind: 1, drag: 1 });
            }
        }
        // Each head is named as it takes its seat.
        const ar = cin.arrivals || 0;
        if (ar > m.ar && d.heads) {
            const h = d.heads[ar - 1];
            if (h) {
                ui.cards.length = 0;
                ui.titleCard(h.displayName || '', '', h.accent || '#e04030', 1.5, { kicker: `HEAD ${ROMAN[ar - 1] || ar} OF VII`, y: 0.74 });
                ui.raysAt(h.worldX, h.worldY, 260, 1.4, ['#5a0c0c', h.accent || '#e04030', '#ffb0a0'], { world: true, n: 10, alpha: 0.35 });
            }
        }
        m.ar = ar;
        // ── 7.6–8.4: held breath — stars creep inward, the heads' eyes kindle ──
        if (t >= 7.6 && t < 8.4) {
            if (Math.random() < dt * 40) {
                const a = Math.random() * TAU, r = Math.max(W, H) * 0.6;
                ui.spark(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r, 0, 0, 1.2, WHITE, { home: 1, tx: W / 2, ty: H / 2, kind: 0 });
            }
            if (d.heads && Math.random() < dt * 10) {
                const h = d.heads[(Math.random() * d.heads.length) | 0];
                if (h) fx.light(h.worldX, h.worldY, 80, 0.6, 0.15, LIGHT.red, 1);
            }
        }
        // ── 8.4–9.1: the charge — lightning joins the seven, power streams in ──
        if (t >= 8.4 && t < 9.1 && d.heads && d.heads.length) {
            m.acc2 = (m.acc2 || 0) + dt * 10;
            while (m.acc2 >= 1) {
                m.acc2 -= 1;
                const n = d.heads.length;
                for (let k = 0; k < n; k++) {
                    const a = d.heads[k], b = d.heads[(k + 1) % n];
                    const bl = fx.bolt(a.worldX, a.worldY, b.worldX, b.worldY, 0.12, null, 0.25);
                    if (bl) bl.ramp = RAMP.blood;
                }
            }
            for (const h of d.heads) if (Math.random() < dt * 20) ui.spark(h.worldX, h.worldY, 0, 0, 0.6, BLOOD, { world: true, home: 1, tx: cx, ty: cy, kind: 1 });
            this._once(m, 'hb2', t, 8.5, () => { if (this.sfx) this.sfx.heartbeat(0.8); });
        }
        // ── 9.1: the pulse ──
        this._once(m, 'pulse', t, 9.1, () => {
            ui.flashScreen('#e04030', 0.6, 0.45);
            fx.sunburst(cx, cy, SUN_BLOOD, 5, 1.6);
            ui.ring(cx, cy, 40, 2200, 1.4, 5, BLOOD, { world: true });
            fx.storm(cx, cy, 200, 1100, 14, RAMP.blood, 0.5);
            if (this.sfx) this.sfx.thump(2, null, null, 0.8);
        });
        // ── 9.2–10.9: his tail draws a third of the stars from heaven ──
        this._once(m, 'stars', t, 9.25, () => this._caption('AND HIS TAIL DREW THE THIRD PART OF THE STARS OF HEAVEN', '', '#ffb0a0', 3.4, 0.86));
        if (t >= 9.2 && t < 10.9) {
            m.acc3 = (m.acc3 || 0) + dt * 55;
            while (m.acc3 >= 1) {
                m.acc3 -= 1;
                const sp = (380 + Math.random() * 400) * px;
                const a = Math.PI * 0.62 + (Math.random() - 0.5) * 0.25;
                ui.spark(Math.random() * W * 1.3, -10 - Math.random() * H * 0.3, Math.cos(a) * sp, Math.sin(a) * sp, 1.4,
                    Math.random() < 0.5 ? WHITE : ['#5a0c0c', '#a01818', '#e04030', '#ffd0c0', '#ffffff'], { kind: 1, drag: 0, worldPixel: true });
            }
        }
        // ── 11–12.9: lightning carves the sigil behind each head ──
        if (t >= 11.0 && t < 12.9 && d.heads) {
            for (const h of d.heads) {
                const lp = m.lastPos.get(h);
                if (lp) {
                    const ddx = h.worldX - lp[0], ddy = h.worldY - lp[1];
                    if (ddx * ddx + ddy * ddy > 60 * 60) {
                        const bl = fx.bolt(lp[0], lp[1], h.worldX, h.worldY, 0.35, null, 0.3);
                        if (bl) bl.ramp = RAMP.blood;
                        fx.burst(h.worldX, h.worldY, RAMP.fire, 4, 80, 220);
                        m.lastPos.set(h, [h.worldX, h.worldY]);
                    }
                } else m.lastPos.set(h, [h.worldX, h.worldY]);
            }
        }
        this._once(m, 'sigilbeat1', t, 12.3, () => { if (this.sfx) this.sfx.heartbeat(0.9); ui.raysAt(cx, cy, 600, 0.6, SUN_BLOOD, { world: true, n: 10, alpha: 0.3 }); });
        this._once(m, 'sigilbeat2', t, 12.62, () => { if (this.sfx) this.sfx.heartbeat(1); });
        // ── 12.9: ignition ──
        this._once(m, 'ignite', t, 12.9, () => {
            fx.sunburst(cx, cy, SUN_STAR, 4, 1.4);
            if (d.heads) for (const h of d.heads) { fx.burst(h.worldX, h.worldY, RAMP.fire, 30, 200, 700); fx.ring(h.worldX, h.worldY, 20, 360, 0.6, 3, RAMP.fire); }
        });
    }
}
