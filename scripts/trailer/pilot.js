// Pilot — flies the ship through the game's OWN controls (scripts/trailer/).
//
// Nothing here moves the ship. It produces the inputs a person on a CONTROLLER
// produces — right stick aim (the nose lerps toward it at the game's fixed
// rate), left stick throttle (an analog vector the game projects onto the
// nose: forward, eased, or reverse at half power — never a key toggled on and
// off), left trigger boost, right trigger fire, bumper shield — toward a scene
// GOAL. The director controls the situation; the pilot executes actions
// inside it. Deterministic (seeded LCG).
//
//   pilot.set({ type: 'goto',   pts: [[x,y]..], speed, arrive: 'pass'|'stop', avoid, shootRocks, fireAt })
//   pilot.set({ type: 'cruise', heading, speed, weave, boost })
//   pilot.set({ type: 'hold',   aim: fn|[x,y], fire, back: dist })   // stop; face; (back off with S to `back` px)
//   pilot.set({ type: 'hunt',   range, rampage, bias: [x,y], pool: fn, noBoost })
//   pilot.set({ type: 'strike', target: fn, standoff, rampage, noBoost })
//   pilot.set({ type: 'mine',   rock: fn|obj, collect: true, then: goal })
//   pilot.set({ type: 'idle' })
//   pilot.forceShield = true|false      // scene-scripted shield (the death beat)
//   pilot.drive(dt)                     // once per frame, BEFORE the game update
//
// Every pilot drives a FakePad (a GamepadInputSource look-alike) that you
// assign as player.input (useMouseAim = false) — the lead and the wingmen
// alike. The lead's pad also mirrors its aim into game.input's mouse position
// so the crosshair draws where the pilot is looking.

import { GP } from '/src/engine/inputManager.js';

export class FakePad {
    constructor() {
        this.usesMouseAim = false;
        this.leftStickX = 0; this.leftStickY = 0;
        this.rightStickX = 0; this.rightStickY = 0;
        this.fire = false; this.boost = false; this.shield = false;
        this._boostPrev = false; this._boostJust = false;
    }
    frame() { this._boostJust = this.boost && !this._boostPrev; this._boostPrev = this.boost; }
    isKeyDown() { return false; }
    isKeyJustPressed() { return false; }
    isMouseDown() { return false; }
    isMouseJustPressed() { return false; }
    isGamepadDown(b) { return b === GP.LB && this.shield; }
    isGamepadJustPressed() { return false; }
    isTriggerDown(side) { return side === 'right' ? this.fire : side === 'left' ? this.boost : false; }
    isTriggerJustPressed(side) { return side === 'left' && this._boostJust; }
}

export class Pilot {
    constructor(game, seed, opts = {}) {
        this.g = game;
        this._rng = (seed >>> 0) || 1;
        this.player = opts.player || (() => game.currentState && game.currentState.player);
        this.io = opts.io || 'pad';
        this.pad = new FakePad();          // the controller this pilot holds
        this.mirror = opts.mirror !== false && !opts.player;   // the lead mirrors its aim into the mouse cursor (crosshair)
        this._thr = 0;                     // analog throttle state (0..1), eased
        this.goal = { type: 'idle' };
        this.forceShield = false;
        this.t = 0;
        // crosshair: a damped spring in world space + slow hand wander
        this.aimX = 0; this.aimY = 0; this.aimVX = 0; this.aimVY = 0; this._aimInit = false;
        this.desX = 0; this.desY = 0;
        this._wp1 = this.rand() * 6.28; this._wp2 = this.rand() * 6.28;
        this._react = 0;
        this.target = null;
        this._burst = 0; this._rest = 0;
        this._joust = 'approach'; this._breakT = 0; this._breakAng = 0;
        this._dodgeT = 0; this._dodgeAng = 0; this._shieldT = 0;
        this._boostCd = 0; this._boostFrames = 0;
        this._avoid = 0;          // smoothed steering offset (radians)
        this._wpi = 0;            // goto: waypoint index
        this._mine = 'shoot';
    }
    rand() { this._rng = (Math.imul(1664525, this._rng) + 1013904223) >>> 0; return this._rng / 4294967296; }
    randIn(a, b) { return a + (b - a) * this.rand(); }
    get S() { return this.g.currentState; }

    set(goal) {
        this.goal = goal || { type: 'idle' };
        this._wpi = 0; this._passed = false; this._joust = 'approach'; this._breakT = 0; this._mine = 'shoot'; this.target = null;
        this._react = this.randIn(0.1, 0.25);
    }

    // ── input plumbing ────────────────────────────────────────────────────────
    _emit(o) {
        // o: { sx, sy (left stick vector, |v| <= 1), fire, boost, shield }
        const p = this.player(), pad = this.pad;
        if (p && !p.dead) {
            const dx = this.aimX - p.worldX, dy = this.aimY - p.worldY, d = Math.hypot(dx, dy) || 1;
            pad.rightStickX = dx / d; pad.rightStickY = dy / d;
        } else { pad.rightStickX = 0; pad.rightStickY = 0; }
        pad.leftStickX = o.sx || 0; pad.leftStickY = o.sy || 0;
        pad.fire = !!o.fire; pad.boost = !!o.boost; pad.shield = !!o.shield;
        pad.frame();
        if (this.mirror) {   // the crosshair follows the lead's aim
            const im = this.g.input, S = this.S, cam = S && S.camera;
            if (cam) {
                im.mouseScreenX = (this.aimX - cam.x) * this.g.worldScale + this.g.width / 2;
                im.mouseScreenY = (this.aimY - cam.y) * this.g.worldScale + this.g.height / 2;
            }
        }
    }
    _release() { this._emit({}); }

    _dist(e) { const p = this.player(); return Math.hypot(e.worldX - p.worldX, e.worldY - p.worldY); }
    _lead(e) { const k = this.randIn(0.8, 0.95) * 0.3; return [e.worldX + (e.vx || 0) * k, e.worldY + (e.vy || 0) * k]; }
    _pick(list, filter, maxD) {
        const cur = this.target;
        const ok = cur && cur.alive !== false && !cur.dead && list.includes(cur) && this._dist(cur) < maxD * 1.4;
        let best = null, bd = Infinity;
        for (const e of list) {
            if (!e || e.alive === false || e.dead) continue;
            if (filter && !filter(e)) continue;
            const d = this._dist(e);
            if (d < bd && d < maxD) { bd = d; best = e; }
        }
        if (ok && (!best || this._dist(cur) < bd * 1.35)) return cur;
        if (best !== cur) this._react = this.randIn(0.12, 0.3);
        this.target = best;
        return best;
    }

    // Rocks in the way of a heading: a smoothed turn away, and a brake if one
    // is right on the nose. Returns { ang, brake }.
    _avoidRocks(dirAng, speed) {
        const S = this.S, p = this.player();
        const L = 520 + speed * 0.45;
        const cx = Math.cos(dirAng), cy = Math.sin(dirAng);
        let push = 0, brake = false;
        for (const a of S.asteroids) {
            if (!a || a.destroyed || a.dead) continue;
            const ar = a.radius || ({ big: 150, medium: 95, small: 55 }[a.size] || 70);
            const R = ar + 150;
            const rx = a.worldX - p.worldX, ry = a.worldY - p.worldY;
            const along = rx * cx + ry * cy; if (along < -40 || along > L) continue;
            const lat = -rx * cy + ry * cx;
            if (Math.abs(lat) > R) continue;
            const th = (1 - Math.max(0, along) / L) * (1 - Math.abs(lat) / R);
            push += (lat >= 0 ? -1 : 1) * th * 1.3;                    // turn away from the side it's on
            if (along < ar + 140 && Math.abs(lat) < ar + 50) brake = true;
        }
        push = Math.max(-1.2, Math.min(1.2, push));
        this._avoid += (push - this._avoid) * 0.22;
        return { ang: dirAng + this._avoid, brake };
    }

    _nearestRockAhead(range) {
        const S = this.S, p = this.player();
        const hx = Math.cos(p.angle), hy = Math.sin(p.angle);
        let b = null, bd = 1e9;
        for (const a of S.asteroids) {
            if (!a || a.destroyed || a.dead) continue;
            const dx = a.worldX - p.worldX, dy = a.worldY - p.worldY, d = Math.hypot(dx, dy);
            if (d > range || d < 40 || (dx * hx + dy * hy) / d < 0.5) continue;
            if (d < bd) { bd = d; b = a; }
        }
        return b;
    }

    // ── the brain ─────────────────────────────────────────────────────────────
    drive(dt) {
        const S = this.S, p = this.player();
        if (!S || !p || p.dead) { this._release(); return; }
        this.t += dt;
        this._boostCd = Math.max(0, this._boostCd - dt);
        this._react = Math.max(0, this._react - dt);
        if (!this._aimInit) { this.aimX = this.desX = p.worldX + Math.cos(p.angle) * 500; this.aimY = this.desY = p.worldY + Math.sin(p.angle) * 500; this._aimInit = true; }

        const speed = Math.hypot(p.vx, p.vy);
        const G = this.goal;
        // desired: travel direction + target speed, aim point, fire eagerness
        let travel = null, want = 0, fire = 0, brake = false, boostWant = false, shieldWant = false;
        const aimAhead = (ang, d = 700) => { this.desX = p.worldX + Math.cos(ang) * d; this.desY = p.worldY + Math.sin(ang) * d; };
        const aimAt = (o) => { if (!o) return; if (Array.isArray(o)) { this.desX = o[0]; this.desY = o[1]; } else { const l = this._lead(o); this.desX = l[0]; this.desY = l[1]; } };

        switch (G.type) {
            case 'idle': this._release(); return;

            case 'cruise': {
                const weave = Math.sin(this.t * 0.9 + this._wp1) * (G.weave != null ? G.weave : 0.18);
                const r = this._avoidRocks(G.heading + weave, speed);
                travel = r.ang; brake = r.brake; want = G.speed || 900;
                aimAhead(travel);
                if (G.boost && this._boostCd <= 0 && this.rand() < dt * 0.6) boostWant = true;
                break;
            }
            case 'goto': {
                const pts = G.pts; let wp = pts[Math.min(this._wpi, pts.length - 1)];
                let d = Math.hypot(wp[0] - p.worldX, wp[1] - p.worldY);
                const last = this._wpi >= pts.length - 1;
                if (!last && d < (G.reach || 150)) { this._wpi++; wp = pts[this._wpi]; d = Math.hypot(wp[0] - p.worldX, wp[1] - p.worldY); }
                let dir = Math.atan2(wp[1] - p.worldY, wp[0] - p.worldX);
                if (last && G.arrive !== 'stop') {
                    // a pass-through: once the last waypoint is reached (or is behind
                    // us) keep flying along the final leg — never turn back for it
                    const prev = pts.length > 1 ? pts[pts.length - 2] : null;
                    const legA = prev ? Math.atan2(wp[1] - prev[1], wp[0] - prev[0]) : p.angle;
                    if (d < (G.reach || 150) || (wp[0] - p.worldX) * Math.cos(legA) + (wp[1] - p.worldY) * Math.sin(legA) < 0) this._passed = true;
                    if (this._passed) dir = legA;
                }
                const r = G.avoid === false ? { ang: dir, brake: false } : this._avoidRocks(dir, speed);
                travel = r.ang; brake = r.brake;
                want = G.speed || 700;
                if (last && G.arrive === 'stop') {
                    want = Math.min(want, d * 1.4);                          // ease off into the stop
                    if (d < 120) { want = 0; if (speed > 70) brake = true; }
                }
                // shooting while flying: rocks in the lane, or enemies close by
                let aimed = false;
                if (G.shootRocks) { const rk = this._nearestRockAhead(820); if (rk) { aimAt(rk); fire = 1; aimed = true; } }
                if (!aimed && G.fireAt) { const e = this._pick(S.enemies, null, G.fireAt); if (e) { aimAt(e); fire = 1; aimed = true; } }
                if (!aimed) {
                    if (last && G.arrive === 'stop' && d < 160 && G.aim) aimAt(typeof G.aim === 'function' ? G.aim() : G.aim);
                    else aimAhead(travel);
                }
                break;
            }
            case 'hold': {
                const a = typeof G.aim === 'function' ? G.aim() : G.aim;
                if (a) aimAt(a); else aimAhead(p.angle);
                if (G.back && a) {
                    const ax = a.worldX != null ? a.worldX : a[0], ay = a.worldY != null ? a.worldY : a[1];
                    const d = Math.hypot(ax - p.worldX, ay - p.worldY);
                    if (d < G.back) { this._emitCombat = true; /* reverse thrust while facing */ brake = false; this._backOff = true; } else this._backOff = false;
                } else this._backOff = false;
                if (speed > 60 && !this._backOff) brake = true;                   // settle
                fire = G.fire ? 1 : 0;
                break;
            }
            case 'hunt': {
                const pool = G.pool ? G.pool() : S.enemies;
                const tg = this._pick(pool, G.filter, G.range || 2600);
                if (!tg) {
                    if (G.bias) { const dir = Math.atan2(G.bias[1] - p.worldY, G.bias[0] - p.worldX); const r = this._avoidRocks(dir, speed); travel = r.ang; brake = r.brake; want = 600; aimAhead(travel); }
                    else { travel = p.angle; want = 0; aimAhead(p.angle); }
                    break;
                }
                const d = this._dist(tg);
                if (this._joust === 'approach') {
                    aimAt(tg);
                    travel = Math.atan2(this.desY - p.worldY, this.desX - p.worldX);
                    want = d > 900 ? 1000 : (d > 420 ? 620 : 300);
                    if (d < this.randIn(160, 230)) {
                        this._joust = 'break'; this._breakT = this.randIn(0.35, 0.7);
                        this._breakAng = Math.atan2(p.worldY - tg.worldY, p.worldX - tg.worldX) + this.randIn(0.8, 1.5) * (this.rand() < 0.5 ? 1 : -1);
                        if (!G.noBoost && this.rand() < 0.35) boostWant = true;
                    }
                    fire = G.rampage ? 2 : 1;
                } else {
                    this._breakT -= dt;
                    const r = this._avoidRocks(this._breakAng, speed);
                    travel = r.ang; want = 900; aimAhead(travel);
                    fire = G.rampage ? 2 : 0;                             // rampage never lets go of the trigger
                    if (this._breakT <= 0) this._joust = 'approach';
                }
                break;
            }
            case 'strike': {
                const tg = typeof G.target === 'function' ? G.target() : G.target;
                if (!tg || tg.alive === false) { this.goal = { type: 'hunt', range: 2600, rampage: G.rampage, noBoost: G.noBoost }; return this.drive(dt); }
                const d = this._dist(tg), band = G.standoff || 520;
                aimAt(tg);
                travel = Math.atan2(this.desY - p.worldY, this.desX - p.worldX);
                if (this._breakT > 0) {
                    this._breakT -= dt;
                    const r = this._avoidRocks(this._breakAng, speed); travel = r.ang; want = 850; aimAhead(travel);
                    fire = 0;
                } else if (d > band * 1.4) { want = 900; fire = G.rampage ? 2 : 1; }
                else if (d < band * 0.6) {
                    this._breakT = this.randIn(0.5, 1.0);
                    this._breakAng = Math.atan2(p.worldY - tg.worldY, p.worldX - tg.worldX) + this.randIn(-0.8, 0.8);
                    if (!G.noBoost && this.rand() < 0.4) boostWant = true;
                    fire = 1;
                } else { want = 380; fire = G.rampage ? 2 : 1; }
                break;
            }
            case 'follow': {
                // fly toward a slot in the lead's frame (a moving target that
                // wanders), matching the lead's pace: a wingman, not a clone
                const L = G.lead(); if (!L) { travel = p.angle; want = 0; aimAhead(p.angle); break; }
                const ls = Math.hypot(L.vx, L.vy), lh = ls > 1 ? Math.atan2(L.vy, L.vx) : L.angle;
                const cs = Math.cos(lh), sn = Math.sin(lh);
                const ox = G.offset[0] + Math.sin(this.t * 0.31 + this._wp1) * 60 + Math.sin(this.t * 0.83 + this._wp2) * 25;
                const oy = G.offset[1] + Math.sin(this.t * 0.27 + this._wp2) * 50 + Math.sin(this.t * 0.71 + this._wp1) * 20;
                const tx = L.worldX + ox * cs - oy * sn, ty = L.worldY + ox * sn + oy * cs;
                const dx = tx - p.worldX, dy = ty - p.worldY, d = Math.hypot(dx, dy);
                const dir = d > 40 ? Math.atan2(dy, dx) : lh;
                const r = this._avoidRocks(dir, speed); travel = r.ang; brake = r.brake;
                want = Math.max(0, ls + Math.min(600, d * 1.2) - 90);   // catch up briskly, settle near the slot
                if (d < 50) want = ls * 0.97;
                aimAhead(travel, 600);
                break;
            }
            case 'mine': {
                const rk = typeof G.rock === 'function' ? G.rock() : (G.rock || this._nearestRockAhead(1600));
                if (this._mine === 'shoot') {
                    if (rk && !rk.destroyed && rk.dead !== true && rk.alive !== false) {
                        aimAt(rk);
                        const d = this._dist(rk);
                        travel = Math.atan2(this.desY - p.worldY, this.desX - p.worldX);
                        want = d > 650 ? 420 : 0;
                        if (d < 600 && speed > 90) brake = true;             // stop, then shoot
                        fire = 1;
                    } else if (G.collect) { this._mine = 'collect'; this._react = 0.2; }
                    else if (G.then) { this.set(G.then); return this.drive(dt); }
                }
                if (this._mine === 'collect') {
                    const sc = this._pick(S.scrapEntities || [], null, 1100);
                    if (sc) {
                        const dir = Math.atan2(sc.worldY - p.worldY, sc.worldX - p.worldX);
                        const r = this._avoidRocks(dir, speed); travel = r.ang; brake = r.brake; want = 420; aimAhead(travel);
                    } else if (G.then) { this.set(G.then); return this.drive(dt); }
                    else { travel = p.angle; want = 0; }
                }
                break;
            }
        }

        // dodge reflex (combat goals): incoming shot close → veer, maybe shield
        this._dodgeCd = Math.max(0, (this._dodgeCd || 0) - dt);
        if (!G.rampage && (G.type === 'hunt' || G.type === 'strike' || G.type === 'goto' && G.fireAt)) {
            if (this._dodgeT > 0) { this._dodgeT -= dt; travel = this._dodgeAng; want = Math.max(want, 800); }
            else if (this._dodgeCd <= 0) for (const pr of S.projectiles) {
                if (!pr || pr.owner === p || (pr.owner && pr.owner.shipData)) continue;
                const dx = pr.worldX - p.worldX, dy = pr.worldY - p.worldY;
                if (dx * dx + dy * dy > 230 * 230) continue;
                if ((pr.vx || 0) * dx + (pr.vy || 0) * dy < 0) {
                    this._dodgeAng = Math.atan2(pr.vy || 0, pr.vx || 0) + (this.rand() < 0.5 ? 1 : -1) * Math.PI / 2;
                    this._dodgeT = this.randIn(0.2, 0.45); this._dodgeCd = this.randIn(1.2, 2.2);
                    // a shield TAP now and then, never a habit (it hides the guns)
                    if (this.rand() < 0.12 && this.t - (this._lastShield || -9) > 4) { this._shieldT = this.randIn(0.25, 0.45); this._lastShield = this.t; }
                    break;
                }
            }
        }

        // ── crosshair: damped spring toward the desired point (+ hand wander) ──
        if (this._react <= 0) {
            const k = 26, c = 2 * Math.sqrt(k) * 0.95;
            const ax = (this.desX - this.aimX) * k - this.aimVX * c, ay = (this.desY - this.aimY) * k - this.aimVY * c;
            this.aimVX += ax * dt; this.aimVY += ay * dt;
        } else { this.aimVX *= Math.pow(0.05, dt); this.aimVY *= Math.pow(0.05, dt); }
        this.aimX += this.aimVX * dt; this.aimY += this.aimVY * dt;
        const ad = Math.hypot(this.aimX - p.worldX, this.aimY - p.worldY);
        const wA = 4 + ad * 0.015;
        this.aimX += (Math.sin(this.t * 1.7 + this._wp1) * 0.6 + Math.sin(this.t * 4.1 + this._wp2) * 0.4) * wA * dt * 3;
        this.aimY += (Math.cos(this.t * 1.3 + this._wp2) * 0.6 + Math.sin(this.t * 3.5 + this._wp1) * 0.4) * wA * dt * 3;

        // ── throttle: the left stick points where we want to go, deflected in
        //    proportion to how far under the wanted speed we are (eased, never
        //    snapped). The game projects it onto the nose: forward when the nose
        //    is on the line, fading as it turns off it, reverse (half power)
        //    when the line is behind us. A brake is the stick pulled straight
        //    back against the nose. ──
        let sx = 0, sy = 0;
        if (travel != null && want > 0) {
            const target = Math.max(0, Math.min(1, (want - speed) / Math.max(120, want * 0.35)));
            this._thr += (target - this._thr) * Math.min(1, dt * 6);
        } else this._thr *= Math.pow(0.04, dt);
        if (this._thr > 0.03 && travel != null) {
            const m = 0.14 + 0.86 * this._thr;       // stays above the game's 0.1 stick threshold
            sx = Math.cos(travel) * m; sy = Math.sin(travel) * m;
        }
        if (brake && speed > 40) { const m = Math.min(1, 0.45 + speed / 600); sx = -Math.cos(p.angle) * m; sy = -Math.sin(p.angle) * m; this._thr = 0; }
        if (this._backOff) { sx = -Math.cos(p.angle) * 0.9; sy = -Math.sin(p.angle) * 0.9; this._thr = 0; }

        // ── trigger discipline: bursts when on line; railgun = HOLD while on line ──
        let fireNow = false;
        if (fire > 0) {
            const aimAng = Math.atan2(this.desY - p.worldY, this.desX - p.worldX);
            let e2 = aimAng - p.angle; while (e2 > Math.PI) e2 -= Math.PI * 2; while (e2 < -Math.PI) e2 += Math.PI * 2;
            const onLine = Math.abs(e2) < (fire >= 2 ? 0.75 : 0.18);
            if (p.hasRailgun) fireNow = fire >= 2 || onLine || this._burst > 0 && Math.abs(e2) < 0.6;   // the railgun charges while HELD
            else if (this._burst > 0) { this._burst -= dt; fireNow = onLine; if (this._burst <= 0) this._rest = fire >= 2 ? this.randIn(0.03, 0.08) : this.randIn(0.12, 0.4); }
            else if (this._rest > 0) this._rest -= dt;
            else if (onLine) this._burst = fire >= 2 ? this.randIn(2.5, 4.0) : this.randIn(0.35, 1.0);
            if (p.hasRailgun) this._burst = fireNow ? 1 : 0;
        } else this._burst = 0;

        // ── boost taps (2 frames), shield ──
        if (boostWant && this._boostCd <= 0) { this._boostCd = this.randIn(2.5, 5); this._boostFrames = 2; }
        const boost = this._boostFrames > 0; if (this._boostFrames > 0) this._boostFrames--;
        if (this._shieldT > 0) { this._shieldT -= dt; shieldWant = true; }
        if (this.forceShield) shieldWant = true;

        this._emit({ sx, sy, fire: fireNow, boost, shield: shieldWant });
    }
}
