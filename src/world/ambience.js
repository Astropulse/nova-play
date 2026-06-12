// Environmental ambience: sector weather (nebula banks, dust drift) and sky
// events (comet showers, micro-meteors). Everything here is cosmetic and
// deterministic-by-position — regions and nebula blobs derive from integer
// hashes of world coordinates, so every machine in multiplayer sees the same
// sky in the same place with zero sync. Transient events (comets) use
// Math.random() like all other visual effects.
//
// Drawn immediately after the starfield (and after the dread Eye, which stays
// the deepest thing in the game), under every entity.

// Integer-lattice hash → [0,1). Constant-seeded: the weather map is a fixed
// property of the universe.
function hash2(x, y) {
    let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ 0x9E3779B9;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise over the lattice (x, y in cell units)
function valueNoise(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hash2(x0, y0), b = hash2(x0 + 1, y0);
    const c = hash2(x0, y0 + 1), d = hash2(x0 + 1, y0 + 1);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const REGION_SCALE = 9000;   // world units per weather-noise cell
const DUST_PARALLAX = 0.5;
const MAX_DUST = 70;

// Sector tint: a barely-there additive wash whose hue slides continuously
// along teal → blue → violet via a smooth noise field. EVERYTHING about it is
// continuous in position — no cells, no thresholds — so it cannot pop.
const TINT_TEAL = [63, 158, 184];
const TINT_BLUE = [74, 120, 216];
const TINT_VIOLET = [138, 90, 216];
const TINT_COLD_GREY = [100, 105, 118]; // dread drains the color toward this

function lerp3(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export class Ambience {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.time = 0;

        this.dust = [];
        this.comets = [];
        this._cometShowerIn = 150 + Math.random() * 200;
        this._meteorIn = 10 + Math.random() * 30;

        // Sector tint state — eased continuously so transitions are gradual
        this._tintR = 0;
        this._tintG = 0;
        this._tintB = 0;
        this._tintAlpha = 0;
    }

    // ── Region queries (world position → weather) ────────────────────────────

    nebulaDensity(wx, wy) {
        // Sharpened so a good share of space is clear sky
        const n = valueNoise(wx / REGION_SCALE, wy / REGION_SCALE);
        return Math.max(0, (n - 0.45) / 0.55);
    }

    dustDensity(wx, wy) {
        const n = valueNoise(wx / REGION_SCALE + 311.7, wy / REGION_SCALE - 157.3);
        return Math.max(0, (n - 0.35) / 0.65);
    }

    _dreadLevel() {
        return (this.state.dread && this.state.dread.level) || 0;
    }

    // ── Update ───────────────────────────────────────────────────────────────

    update(dt) {
        this.time += dt;
        const cam = this.game.camera;
        const ws = this.game.worldScale;
        const halfW = this.game.width / ws / 2;
        const halfH = this.game.height / ws / 2;

        // Sector tint: hue and strength both come from smooth noise fields, so
        // the target varies continuously as the player flies — then eased on
        // top of that (~8s) so even fast travel shifts gradually.
        const tintDensity = this.nebulaDensity(cam.x, cam.y);
        const hueT = valueNoise(cam.x / REGION_SCALE - 511.3, cam.y / REGION_SCALE + 209.7);
        let target = hueT < 0.5
            ? lerp3(TINT_TEAL, TINT_BLUE, hueT * 2)
            : lerp3(TINT_BLUE, TINT_VIOLET, (hueT - 0.5) * 2);
        if (this._dreadLevel() >= 2) target = lerp3(target, TINT_COLD_GREY, 0.7);
        const k = 1 - Math.exp(-0.12 * dt);
        this._tintAlpha += (Math.min(0.035, tintDensity * 0.045) - this._tintAlpha) * k;
        this._tintR += (target[0] - this._tintR) * k;
        this._tintG += (target[1] - this._tintG) * k;
        this._tintB += (target[2] - this._tintB) * k;

        // Dust: keep a sparse cloud alive around the camera, density gated by
        // the local region. Particles live in dust-layer space.
        const density = this.dustDensity(cam.x, cam.y);
        const want = Math.round(MAX_DUST * density);
        const lx = cam.x * DUST_PARALLAX, ly = cam.y * DUST_PARALLAX;
        const margin = 80;
        for (let i = this.dust.length - 1; i >= 0; i--) {
            const p = this.dust[i];
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.life -= dt;
            if (p.life <= 0 ||
                Math.abs(p.x - lx) > halfW + margin * 2 ||
                Math.abs(p.y - ly) > halfH + margin * 2) {
                this.dust[i] = this.dust[this.dust.length - 1];
                this.dust.pop();
            }
        }
        if (this.dust.length < want) {
            // Warm ember dust in some regions, cold grey in others
            const warm = valueNoise(cam.x / REGION_SCALE - 97.3, cam.y / REGION_SCALE + 53.9) > 0.55;
            const spawn = Math.min(3, want - this.dust.length);
            for (let i = 0; i < spawn; i++) {
                const ang = Math.random() * Math.PI * 2;
                this.dust.push({
                    x: lx + (Math.random() - 0.5) * (halfW + margin) * 2,
                    y: ly + (Math.random() - 0.5) * (halfH + margin) * 2,
                    vx: Math.cos(ang) * (4 + Math.random() * 10),
                    vy: Math.sin(ang) * (4 + Math.random() * 10),
                    life: 6 + Math.random() * 10,
                    maxLife: 16,
                    warm,
                    size: Math.random() < 0.8 ? 1 : 2
                });
            }
        }

        // Comet showers — a rare event; each comet crosses the deep sky
        this._cometShowerIn -= dt;
        if (this._cometShowerIn <= 0) {
            this._cometShowerIn = 240 + Math.random() * 240;
            const count = 6 + Math.floor(Math.random() * 5);
            for (let i = 0; i < count; i++) this._spawnComet(true, i * (0.4 + Math.random() * 0.5));
        }
        // Lone micro-meteors — common, tiny, half-subliminal
        this._meteorIn -= dt;
        if (this._meteorIn <= 0) {
            this._meteorIn = 15 + Math.random() * 30;
            this._spawnComet(false, 0);
        }

        for (let i = this.comets.length - 1; i >= 0; i--) {
            const c = this.comets[i];
            c.delay -= dt;
            if (c.delay > 0) continue;
            c.t += dt;
            c.x += c.vx * dt;
            c.y += c.vy * dt;
            // World-anchored position history = a true motion trail that
            // stays coherent no matter how the camera moves.
            c.trail.push(c.x, c.y);
            if (c.trail.length > c.maxTrail * 2) c.trail.splice(0, 2);
            if (c.t >= c.dur) this.comets.splice(i, 1);
        }
    }

    _spawnComet(isShower, delay) {
        if (this.comets.length > 24) return;
        const cam = this.game.camera;
        const ws = this.game.worldScale;
        // Comets are TRUE play-layer objects (parallax 1) streaking past the
        // ship — fast self-motion at a deep parallax reads as a depth-cue
        // conflict, so they live at the same depth language as asteroids.
        const halfW = this.game.width / ws / 2 + 150;
        const halfH = this.game.height / ws / 2 + 150;
        const fromLeft = Math.random() < 0.5;
        const baseAngle = fromLeft ? 0 : Math.PI; // rightward or leftward
        const angle = baseAngle + (Math.random() - 0.5) * 0.9;
        const speed = isShower ? 650 + Math.random() * 350 : 1100 + Math.random() * 400;
        this.comets.push({
            parallax: 1,
            x: cam.x + (fromLeft ? -halfW : halfW),
            y: cam.y + (Math.random() - 0.5) * halfH * 1.8,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            t: 0,
            dur: (halfW * 2.6) / speed,
            delay,
            trail: [],
            maxTrail: isShower ? 18 : 10,
            size: isShower ? 2 : 1
        });
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    draw(ctx, camera) {
        const ws = this.game.worldScale;
        const W = this.game.width, H = this.game.height;

        // ── Sector tint: one soft additive wash, eased over seconds ──
        if (this._tintAlpha > 0.004) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = `rgba(${Math.round(this._tintR)},${Math.round(this._tintG)},${Math.round(this._tintB)},${this._tintAlpha.toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
        }

        // ── Comets: long tapering streaks through their position history ──
        if (this.comets.length > 0) {
            const dread3 = this._dreadLevel() >= 3;
            const headColor = dread3 ? '#e8d27a' : '#e8f6ff';
            const tailColor = dread3 ? '#b09a4e' : '#8fc4e8';
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.lineCap = 'round';
            for (const c of this.comets) {
                if (c.delay > 0 || c.trail.length < 4) continue;
                const sx = (c.x - camera.x) * ws + W / 2;
                const sy = (c.y - camera.y) * ws + H / 2;
                if (sx < -400 || sx > W + 400 || sy < -400 || sy > H + 400) continue;
                const fade = Math.min(1, (c.dur - c.t) / 0.3) * Math.min(1, c.t / 0.15);
                const n = c.trail.length / 2;
                ctx.strokeStyle = tailColor;
                for (let k = 0; k < n - 1; k++) {
                    // 0 = oldest (tail tip), n-1 = newest (at the head)
                    const f = k / (n - 1);
                    const x0 = (c.trail[k * 2] - camera.x) * ws + W / 2;
                    const y0 = (c.trail[k * 2 + 1] - camera.y) * ws + H / 2;
                    const x1 = (c.trail[k * 2 + 2] - camera.x) * ws + W / 2;
                    const y1 = (c.trail[k * 2 + 3] - camera.y) * ws + H / 2;
                    ctx.globalAlpha = fade * f * 0.55;
                    ctx.lineWidth = Math.max(1, c.size * ws * (0.25 + f * 0.75));
                    ctx.beginPath();
                    ctx.moveTo(x0, y0);
                    ctx.lineTo(x1, y1);
                    ctx.stroke();
                }
                // Bright head
                ctx.globalAlpha = fade;
                ctx.fillStyle = headColor;
                const hs = Math.max(1, Math.round(c.size * ws));
                ctx.fillRect(Math.round(sx - hs / 2), Math.round(sy - hs / 2), hs, hs);
            }
            ctx.restore();
        }

        // ── Dust drift ──
        if (this.dust.length > 0) {
            ctx.save();
            for (const p of this.dust) {
                const sx = (p.x - camera.x * DUST_PARALLAX) * ws + W / 2;
                const sy = (p.y - camera.y * DUST_PARALLAX) * ws + H / 2;
                if (sx < -10 || sx > W + 10 || sy < -10 || sy > H + 10) continue;
                const lifeFrac = p.life / p.maxLife;
                ctx.globalAlpha = Math.min(0.35, lifeFrac) * (p.warm ? 0.9 : 0.6);
                ctx.fillStyle = p.warm ? '#caa56a' : '#8a93a6';
                const s = Math.max(1, Math.round(p.size * ws * 0.5));
                ctx.fillRect(Math.round(sx), Math.round(sy), s, s);
            }
            ctx.restore();
        }
    }
}
