// CineBot — a "natural" pilot for trailer capture (scripts/trailer/).
//
// The perf Bot (scripts/perf/bot.js) is command-driven and robotic: it warps the
// mouse straight onto targets and holds W. Great for load, terrible on camera.
// CineBot drives the SAME real inputs (game.input mouse + keys) but with human
// vocabulary, tuned for how NOVA actually controls (mouse rotates the nose,
// W thrusts along it — so good flying looks like jousting passes, drift turns
// and boost escapes, never strafing orbits):
//
//   • The crosshair is a physical thing: a critically-damped-ish spring chases
//     the desired aim point in WORLD space, with low-frequency hand wander on
//     top. Snapping to a new target takes a visible, eased swing.
//   • Reaction time: target switches sit on a 0.15–0.35s delay before the
//     crosshair even starts moving.
//   • Trigger discipline: fire in bursts when roughly on-line, not a held
//     trigger (a `rampage` flag loosens this for the endgame chaos scene).
//   • Joust state machine: APPROACH a target while firing, BREAK off past a
//     comfort radius (veer 50–90°, sometimes boost), REACQUIRE. Plus a dodge
//     reflex against close enemy projectiles (veer + shield tap).
//   • All bot randomness is a seeded LCG so a re-render flies the same take.
//
// Per-frame API (no async, no timers — the trailer director steps the game on
// a virtual clock and calls drive(dt) before every frame):
//   bot.setMode('drift' | 'cruise' | 'mine' | 'hunt' | 'strike' | 'flee', opts)
//   bot.drive(dt)

export class CineBot {
    constructor(game, seed = 1234567) {
        this.game = game;
        this._rngState = seed >>> 0;

        // Aim spring state (world space).
        this.aimX = 0; this.aimY = 0;       // crosshair position
        this.aimVX = 0; this.aimVY = 0;     // crosshair velocity
        this.desX = 0; this.desY = 0;       // where the pilot wants to look
        this._aimInit = false;

        // Hand-wander phases (irrational-ish freqs so it never loops visibly).
        this._wp1 = this.rand() * Math.PI * 2;
        this._wp2 = this.rand() * Math.PI * 2;
        this._t = 0;

        // Target selection / reaction.
        this.target = null;
        this._switchDelay = 0;

        // Trigger discipline.
        this._burstT = 0;        // >0: firing window remaining
        this._restT = 0;         // >0: off-trigger window remaining

        // Joust state.
        this._joust = 'approach';
        this._breakT = 0;
        this._breakAng = 0;

        // Throttle smoothing (0..1 desired forward effort).
        this._throttle = 0;
        this._thrGoal = 0;

        // Dodge reflex.
        this._dodgeT = 0;
        this._dodgeAng = 0;

        this._boostCd = 0;
        this._shieldT = 0;

        this.mode = 'drift';
        this.opts = {};
    }

    // ── Seeded LCG (Numerical Recipes) — reproducible takes ──────────────────
    rand() {
        this._rngState = (Math.imul(1664525, this._rngState) + 1013904223) >>> 0;
        return this._rngState / 4294967296;
    }
    randIn(a, b) { return a + (b - a) * this.rand(); }

    get s() { return this.game.currentState; }
    get p() { return this.s && this.s.player; }

    setMode(mode, opts = {}) {
        this.mode = mode;
        this.opts = opts;
        this._joust = 'approach';
        this._breakT = 0;
        if (opts.target !== undefined) this.target = opts.target;
    }

    // ── Input plumbing (same surface a human produces) ────────────────────────
    _key(code, on) {
        const k = this.game.input.keysDown;
        if (on) k.add(code); else k.delete(code);
    }
    _fire(on) {
        const b = this.game.input.mouseButtons;
        if (on) b.add(0); else b.delete(0);
    }
    _projectAim() {
        // World → screen through the live camera (same math as perf bot).
        const cam = this.s.camera;
        if (!cam) return;
        const sx = (this.aimX - cam.x) * this.game.worldScale + this.game.width / 2 + (cam.shakeX || 0) + (cam.punchX || 0);
        const sy = (this.aimY - cam.y) * this.game.worldScale + this.game.height / 2 + (cam.shakeY || 0) + (cam.punchY || 0);
        this.game.input.mouseScreenX = sx;
        this.game.input.mouseScreenY = sy;
    }

    _dist(e) { const p = this.p; return Math.hypot(e.worldX - p.worldX, e.worldY - p.worldY); }

    // Nearest live entity with hysteresis: keep the current target unless it's
    // dead/gone or a rival is 35% closer. New targets impose a reaction delay.
    _pickTarget(list, filter, maxD = 2600) {
        const cur = this.target;
        const curOk = cur && cur.alive !== false && list.includes(cur) && this._dist(cur) < maxD * 1.4;
        let best = null, bd = Infinity;
        for (const e of list) {
            if (e.alive === false) continue;
            if (filter && !filter(e)) continue;
            const d = this._dist(e);
            if (d < bd && d < maxD) { bd = d; best = e; }
        }
        if (curOk && (!best || this._dist(cur) < bd * 1.35)) return cur;
        if (best !== cur) this._switchDelay = this.randIn(0.15, 0.35);
        this.target = best;
        return best;
    }

    // ── The per-frame brain ───────────────────────────────────────────────────
    drive(dt) {
        if (this.mode === 'off') return;   // a kinematic rig owns the ship
        const s = this.s, p = this.p;
        if (!s || !p || p.dead) { this._fire(false); this._key('KeyW', false); return; }
        this._t += dt;
        this._boostCd = Math.max(0, this._boostCd - dt);
        this._switchDelay = Math.max(0, this._switchDelay - dt);

        if (!this._aimInit) {
            this.aimX = this.desX = p.worldX + Math.cos(p.angle) * 400;
            this.aimY = this.desY = p.worldY + Math.sin(p.angle) * 400;
            this._aimInit = true;
        }

        let wantFire = false;
        let fireHold = 0;        // how eager: 0 none, 1 bursts, 2 rampage
        this._thrGoal = 0;

        switch (this.mode) {
            case 'drift':   this._modeDrift(dt); break;
            case 'cruise':  this._modeCruise(dt); break;
            case 'mine':    fireHold = this._modeMine(dt); break;
            case 'hunt':    fireHold = this._modeHunt(dt); break;
            case 'strike':  fireHold = this._modeStrike(dt); break;
            case 'flee':    this._modeFlee(dt); break;
        }

        // Dodge reflex overrides steering briefly (any combat-ish mode).
        if (this.mode === 'hunt' || this.mode === 'strike' || this.mode === 'mine' || this.mode === 'flee') {
            this._dodge(dt);
        }

        // ── Aim spring + hand wander ──
        if (this._switchDelay <= 0) {
            const stiff = this.opts.aimStiffness || 30;
            const damp = 2 * Math.sqrt(stiff) * 0.82;   // slightly underdamped → tiny overshoot
            const ax = (this.desX - this.aimX) * stiff - this.aimVX * damp;
            const ay = (this.desY - this.aimY) * stiff - this.aimVY * damp;
            this.aimVX += ax * dt; this.aimVY += ay * dt;
        } else {
            // Reaction window: the hand hasn't started moving yet; drift on.
            this.aimVX *= Math.pow(0.05, dt); this.aimVY *= Math.pow(0.05, dt);
        }
        this.aimX += this.aimVX * dt; this.aimY += this.aimVY * dt;
        // Wander: two summed sines, amplitude grows with aim distance.
        const p2 = this.p;
        const ad = Math.hypot(this.aimX - p2.worldX, this.aimY - p2.worldY);
        const wAmp = (this.opts.wander != null ? this.opts.wander : 1) * (6 + ad * 0.02);
        const wx = Math.sin(this._t * 1.7 + this._wp1) * 0.6 + Math.sin(this._t * 4.3 + this._wp2) * 0.4;
        const wy = Math.cos(this._t * 1.3 + this._wp2) * 0.6 + Math.sin(this._t * 3.7 + this._wp1) * 0.4;
        this.aimX += wx * wAmp * dt * 3; this.aimY += wy * wAmp * dt * 3;
        this._projectAim();

        // ── Trigger discipline ──
        if (fireHold > 0) {
            // Only shoot when the nose is roughly on line with the crosshair
            // target (the ship lerps toward the mouse, so early frames of a
            // swing are off-line — exactly like a human waiting for the swing).
            const aimAng = Math.atan2(this.desY - p.worldY, this.desX - p.worldX);
            let err = aimAng - p.angle;
            while (err > Math.PI) err -= Math.PI * 2;
            while (err < -Math.PI) err += Math.PI * 2;
            const onLine = Math.abs(err) < (fireHold >= 2 ? 0.5 : 0.16);
            if (this._burstT > 0) {
                this._burstT -= dt;
                wantFire = onLine;
                if (this._burstT <= 0) this._restT = fireHold >= 2 ? this.randIn(0.05, 0.15) : this.randIn(0.12, 0.45);
            } else if (this._restT > 0) {
                this._restT -= dt;
            } else if (onLine) {
                this._burstT = fireHold >= 2 ? this.randIn(1.2, 2.6) : this.randIn(0.35, 1.1);
            }
        } else {
            this._burstT = 0;
        }
        this._fire(wantFire);

        // ── Throttle smoothing → W/S keys ──
        this._throttle += (this._thrGoal - this._throttle) * Math.min(1, 6 * dt);
        // Duty-cycle: convert the analog throttle into human key holds using a
        // slow PWM so thrust flames pulse instead of strobing.
        const duty = (this._t * 2.2) % 1;
        this._key('KeyW', this._throttle > 0.12 && duty < this._throttle * 1.15);
        this._key('KeyS', this._thrGoal < -0.1);

        // Shield tap wind-down.
        if (this._shieldT > 0) { this._shieldT -= dt; this._key('ShiftLeft', true); }
        else this._key('ShiftLeft', false);
    }

    // Aim `lead` px ahead of a moving entity (imperfect lead — 80–95%).
    _leadPoint(e) {
        const lead = this.randIn(0.8, 0.95) * 0.35;
        return { x: e.worldX + (e.vx || 0) * lead, y: e.worldY + (e.vy || 0) * lead };
    }

    _boostTap() {
        if (this._boostCd > 0) return;
        this._boostCd = this.randIn(2.5, 5);
        this._key('Space', true);
        this._boostOff = 2;              // release after 2 frames
    }
    _tickBoostRelease() {
        if (this._boostOff != null && --this._boostOff <= 0) { this._key('Space', false); this._boostOff = null; }
    }

    // ── Modes ─────────────────────────────────────────────────────────────────

    // Quiet glide: nose wanders around the travel direction, rare thrust taps.
    _modeDrift(dt) {
        const p = this.p;
        const base = this.opts.heading != null ? this.opts.heading : Math.atan2(p.vy, p.vx) || 0;
        const sway = Math.sin(this._t * 0.35 + this._wp1) * 0.35;
        const a = base + sway;
        this.desX = p.worldX + Math.cos(a) * 900;
        this.desY = p.worldY + Math.sin(a) * 900;
        this._thrGoal = 0.18 + 0.12 * Math.sin(this._t * 0.5 + this._wp2);
        this._tickBoostRelease();
    }

    // Purposeful travel along a heading, with weave and optional boosts.
    _modeCruise(dt) {
        const p = this.p;
        const base = this.opts.heading != null ? this.opts.heading : 0;
        const weave = Math.sin(this._t * 0.9 + this._wp1) * (this.opts.weave != null ? this.opts.weave : 0.22);
        const a = base + weave;
        this.desX = p.worldX + Math.cos(a) * 1100;
        this.desY = p.worldY + Math.sin(a) * 1100;
        this._thrGoal = this.opts.throttle != null ? this.opts.throttle : 0.85;
        if (this.opts.boost && this._boostCd <= 0 && this.rand() < dt * 0.5) this._boostTap();
        this._tickBoostRelease();
    }

    // Asteroids: line up a rock, chew it, drift through the scrap it sheds.
    _modeMine(dt) {
        const s = this.s, p = this.p;
        const t = this._pickTarget(s.asteroids, this.opts.filter, 1700);
        if (!t) { this._modeDrift(dt); return 0; }
        const lp = this._leadPoint(t);
        this.desX = lp.x; this.desY = lp.y;
        const d = this._dist(t);
        this._thrGoal = d > 620 ? 0.7 : (d > 300 ? 0.25 : -0.2);
        this._tickBoostRelease();
        return 1;
    }

    // General combat: joust passes against the nearest enemy.
    _modeHunt(dt) {
        const s = this.s, p = this.p;
        const pool = (s.enemies && s.enemies.length) ? s.enemies : s.asteroids;
        const t = this._pickTarget(pool, this.opts.filter, this.opts.range || 2600);
        if (!t) { this._modeCruise(dt); return 0; }
        const d = this._dist(t);

        if (this._joust === 'approach') {
            const lp = this._leadPoint(t);
            this.desX = lp.x; this.desY = lp.y;
            this._thrGoal = d > 900 ? 1.0 : (d > 420 ? 0.6 : 0.25);
            if (d < this.randIn(230, 330)) {
                // Too close — break off the pass.
                this._joust = 'break';
                this._breakT = this.randIn(0.7, 1.3);
                this._breakAng = Math.atan2(p.worldY - t.worldY, p.worldX - t.worldX)
                    + this.randIn(0.9, 1.6) * (this.rand() < 0.5 ? 1 : -1);
                if (this.rand() < 0.45) this._boostTap();
            }
        } else {
            this._breakT -= dt;
            this.desX = p.worldX + Math.cos(this._breakAng) * 800;
            this.desY = p.worldY + Math.sin(this._breakAng) * 800;
            this._thrGoal = 0.9;
            if (this._breakT <= 0) this._joust = 'approach';
        }
        this._tickBoostRelease();
        return this._joust === 'approach' ? (this.opts.rampage ? 2 : 1) : 0;
    }

    // Boss focus: hold a standoff band around one big target, always firing
    // when lined up, veering along the ring so the pass never goes stale.
    _modeStrike(dt) {
        const s = this.s, p = this.p;
        const t = typeof this.opts.getTarget === 'function' ? this.opts.getTarget() : this.opts.target;
        if (!t || t.alive === false) { this._modeHunt(dt); return this.opts.rampage ? 2 : 1; }
        this.target = t;
        const d = this._dist(t);
        const band = this.opts.standoff || 520;
        const lp = this._leadPoint(t);
        this.desX = lp.x; this.desY = lp.y;

        if (d > band * 1.35) this._thrGoal = 1.0;
        else if (d < band * 0.55) {
            // Inside the comfort ring: back-thrust a beat, then veer out.
            this._thrGoal = -0.4;
            if (this._breakT <= 0) {
                this._breakT = this.randIn(0.6, 1.1);
                this._breakAng = Math.atan2(p.worldY - t.worldY, p.worldX - t.worldX) + this.randIn(-0.7, 0.7);
                if (this.rand() < 0.5) this._boostTap();
            }
        } else this._thrGoal = 0.45;

        if (this._breakT > 0) {
            this._breakT -= dt;
            this.desX = p.worldX + Math.cos(this._breakAng) * 900;
            this.desY = p.worldY + Math.sin(this._breakAng) * 900;
            this._thrGoal = 0.95;
        }
        this._tickBoostRelease();
        return this.opts.rampage ? 2 : 1;
    }

    // Run from a point/entity, weaving, shield up under pressure.
    _modeFlee(dt) {
        const p = this.p;
        const f = typeof this.opts.from === 'function' ? this.opts.from() : this.opts.from;
        const a = f ? Math.atan2(p.worldY - f.y, p.worldX - f.x)
                    : (Math.atan2(p.vy, p.vx) || 0);
        const weave = Math.sin(this._t * 2.1 + this._wp1) * 0.4;
        this.desX = p.worldX + Math.cos(a + weave) * 1000;
        this.desY = p.worldY + Math.sin(a + weave) * 1000;
        this._thrGoal = 1.0;
        if (this._boostCd <= 0 && this.rand() < dt * 0.8) this._boostTap();
        this._tickBoostRelease();
    }

    // Projectile dodge reflex: nearest hostile shot closing within ~220px makes
    // the pilot veer perpendicular for a beat, sometimes flashing the shield.
    _dodge(dt) {
        const s = this.s, p = this.p;
        if (this._dodgeT > 0) {
            this._dodgeT -= dt;
            this.desX = p.worldX + Math.cos(this._dodgeAng) * 700;
            this.desY = p.worldY + Math.sin(this._dodgeAng) * 700;
            this._thrGoal = Math.max(this._thrGoal, 0.9);
            return;
        }
        const shots = s.projectiles;
        if (!shots) return;
        for (let i = 0; i < shots.length; i++) {
            const pr = shots[i];
            if (!pr || pr.friendly || pr.fromPlayer || pr.owner === p) continue;
            const dx = pr.worldX - p.worldX, dy = pr.worldY - p.worldY;
            const d2 = dx * dx + dy * dy;
            if (d2 > 220 * 220) continue;
            // Closing?
            if ((pr.vx || 0) * dx + (pr.vy || 0) * dy < 0) {
                const shotAng = Math.atan2(pr.vy || 0, pr.vx || 0);
                this._dodgeAng = shotAng + (this.rand() < 0.5 ? 1 : -1) * Math.PI / 2;
                this._dodgeT = this.randIn(0.25, 0.5);
                if (this.rand() < 0.3) this._shieldT = this.randIn(0.3, 0.7);
                if (this.rand() < 0.25) this._boostTap();
                break;
            }
        }
    }
}
