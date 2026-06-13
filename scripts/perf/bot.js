// Command-driven player bot for the performance suite. Drives the ship with
// REAL input (game.input keys + mouse, exactly what a human produces) for all
// movement and combat; menu/dialog interactions call the same handlers a click
// would. Every command is async and polls game state each ~frame until its goal
// (arrived / target dead / dialog open / wave cleared) or a timeout.
//
// Used by scripts/perf/harness.js to run a realistic gameplay scenario.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export class Bot {
    constructor(game) {
        this.game = game;
        this.log = (msg) => { try { fetch('/perflog', { method: 'POST', body: JSON.stringify({ tag: 'BOT', msg }), keepalive: true }); } catch (e) {} };
    }
    get s() { return this.game.currentState; }
    get p() { return this.s && this.s.player; }
    _alive() { return this.s && this.s.constructor.name === 'PlayingState' && !this.s.isDead; }

    // ── Low-level input (held until changed) ──────────────────────────────────
    _aimWorld(wx, wy) {
        const cam = this.s.camera;
        const sx = (wx - cam.x) * this.game.worldScale + this.game.width / 2 + (cam.shakeX || 0) + (cam.punchX || 0);
        const sy = (wy - cam.y) * this.game.worldScale + this.game.height / 2 + (cam.shakeY || 0) + (cam.punchY || 0);
        this.game.input.mouseScreenX = sx;
        this.game.input.mouseScreenY = sy;
    }
    _thrust(on) { const k = this.game.input.keysDown; on ? k.add('KeyW') : k.delete('KeyW'); }
    _fire(on) { const b = this.game.input.mouseButtons; on ? b.add(0) : b.delete(0); }
    _boostTap() { this.game.input.keysDown.add('Space'); setTimeout(() => this.game.input.keysDown.delete('Space'), 60); }
    _idle() { this._thrust(false); this._fire(false); }

    // Poll loop: run `each` (sets input) every frame until `cond` true or timeout.
    async _until(cond, timeoutMs, each) {
        const start = performance.now();
        while (performance.now() - start < timeoutMs) {
            if (!this._alive()) { this._idle(); return false; }
            if (each) each();
            if (cond && cond()) return true;
            await sleep(16);
        }
        return false;
    }

    _dist(wx, wy) { const p = this.p; return Math.hypot(wx - p.worldX, wy - p.worldY); }

    // Nearest live entity of a kind, or null.
    _nearest(list, filter) {
        let best = null, bd = Infinity;
        for (const e of list) {
            if (e.alive === false) continue;
            if (filter && !filter(e)) continue;
            const d = this._dist(e.worldX, e.worldY);
            if (d < bd) { bd = d; best = e; }
        }
        return best;
    }

    // ── High-level commands ───────────────────────────────────────────────────

    // Hold position for `ms`, optionally firing at anything near.
    async stayPut(ms, fire = false) {
        const anchorX = this.p.worldX, anchorY = this.p.worldY;
        await this._until(null, ms, () => {
            this._thrust(false);
            if (fire) {
                const t = this._nearest(this.s.enemies) || this._nearest(this.s.asteroids);
                if (t) { this._aimWorld(t.worldX, t.worldY); this._fire(true); } else this._fire(false);
            }
        });
        this._idle();
    }

    // Fly to a world point using thrust + boost, arriving within `arrive` px.
    async flyTo(wx, wy, arrive = 140, timeout = 20000) {
        let lastBoost = 0;
        const ok = await this._until(() => this._dist(wx, wy) < arrive, timeout, () => {
            this._aimWorld(wx, wy);
            this._thrust(true);
            const d = this._dist(wx, wy);
            const now = performance.now();
            if (d > 900 && now - lastBoost > 2100) { this._boostTap(); lastBoost = now; }
        });
        this._idle();
        return ok;
    }

    // Fly a given distance along a heading (to push into open space → natural spawns).
    async flyOut(dist, angle = null, timeout = 20000) {
        const a = angle == null ? Math.random() * Math.PI * 2 : angle;
        const tx = this.p.worldX + Math.cos(a) * dist;
        const ty = this.p.worldY + Math.sin(a) * dist;
        return this.flyTo(tx, ty, 200, timeout);
    }

    // Aim+fire at the nearest of `list` until `targetCount` remain (or timeout).
    async destroy(listName, targetRemaining = 0, timeout = 30000, opts = {}) {
        const ok = await this._until(
            () => this.s[listName].filter(e => e.alive !== false && (!opts.filter || opts.filter(e))).length <= targetRemaining,
            timeout,
            () => {
                const t = this._nearest(this.s[listName], opts.filter);
                if (!t) { this._fire(false); return; }
                this._aimWorld(t.worldX, t.worldY);
                this._fire(true);
                // Drift toward distant targets so they stay in weapon range.
                const d = this._dist(t.worldX, t.worldY);
                this._thrust(d > 700);
            }
        );
        this._idle();
        return ok;
    }

    // Fly to an entity then invoke an open handler on the playing state.
    async approachAndOpen(entity, openFn, isOpenFn, timeout = 15000) {
        if (!entity) return false;
        await this.flyTo(entity.worldX, entity.worldY, 160, timeout);
        this._idle();
        openFn();
        return this._until(isOpenFn, 3000, null);
    }
}
