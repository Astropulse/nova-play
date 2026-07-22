import { Scrap, ExpOrb, ItemPickup, ProceduralDebris, Asteroid, getCachedShatter } from './asteroid.js';
import { Seraph } from './seraph.js';
import { Wheels } from './wheels.js';
import { UPGRADES } from '../data/upgrades.js';
import { Projectile } from './projectile.js';
import { ENCOUNTER_ASSETS } from '../data/encounters.js';
import { MUSIC_STATE } from '../engine/soundManager.js';
import { pickFireExplosion, fireExplosionFrame, drawBeamStrip } from '../engine/vfx.js';

// ─────────────────────────────────────────────────────────────────────────────
// THE DRAGON — the final boss. Seven massive ships, the seven heads of the
// dragon of Revelation, found by following the RED glow after the starfield of
// bones falls. The heads fight as one coordinated mind; each can only be
// "shattered" (voronoi burst), and while any other head still stands a
// shattered head reverses its own wreckage and reforms at half its previous
// max after REFORM_TIME. Victory = all seven shattered at once. The Burning
// Seraph, the Wheels (up to 3) and the herald trumpets fight FOR the player.
//
// Structure: `Dragon` is the controller event (chain link, cinematic script,
// coordinator, allies, sigil, victory). Each head is its own event entity in
// state.events (so projectile/ellipse collision + auto-weapon targeting work
// per head) but is owned and orchestrated by the controller. The whole
// encounter is in LOCAL_SCRIPTED_EVENTS (per-machine, like Seraph/Wheels);
// mid-fight saves restart it fresh from the DORMANT shell.
// ─────────────────────────────────────────────────────────────────────────────

export const DRAGON_STATE = {
    DORMANT: 'dragon_dormant',   // never plain 'dormant' — Cthulhu ram-wake guard
    CINEMATIC: 'dragon_cinematic',
    FIGHT: 'fight',
    VICTORY: 'dragon_victory',
    FINISHED: 'finished'
};

// Encounter/fight geometry
const TRIGGER_RADIUS = 1300;     // arrival → cinematic
const CIRCLE_R = 800;            // the ring the heads form around the player —
                                 // tight enough that seven ships FILL the frame
const CINE_FOV = 3.2;            // wide cinematic zoom-out during the arrival
                                 // (ships must stay readable, not become specks)
const STAR_CULL = 1 / 3;         // a third of the stars, swept from the sky

// Shatter / reform
const SHATTER_PIECES = 48;       // per head — keep in sync with prewarm.js
const REFORM_TIME = 15.0;        // total downtime before a head lives again
const REFORM_REVERSE_AT = 11.0;  // when the wreckage starts flying back inward
                                 // (4s of visible reassembly — the reversal IS the show)

const RED = '#ff3030';
const RED_DEEP = '#8f1616';
const GOLD = '#ffd050';

// ── shared tint/glow caches (cosmetic, module-level like the fracture cache) ──
const _tintCache = new Map();
function tintedSprite(asset, key, color, blurPx = 6) {
    const cacheKey = key + '|' + color + '|' + blurPx;
    let out = _tintCache.get(cacheKey);
    if (out) return out;
    const img = asset.canvas || asset;
    const w = asset.width || img.width, h = asset.height || img.height;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const tc = c.getContext('2d');
    tc.imageSmoothingEnabled = false;
    if (blurPx > 0) tc.filter = `blur(${blurPx}px)`;
    tc.drawImage(img, 0, 0, w, h);
    tc.globalCompositeOperation = 'source-atop';
    tc.fillStyle = color;
    tc.fillRect(0, 0, w, h);
    out = { canvas: c, width: w, height: h };
    _tintCache.set(cacheKey, out);
    return out;
}

function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
function easeIn(t) { return t * t * t; }

// Distance from point to segment — Murder's fire wakes + the verdict cross.
function segDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = x1 + dx * t, cy = y1 + dy * t;
    return Math.hypot(px - cx, py - cy);
}

// ═════════════════════════════════════════════════════════════════════════════
// DRAGON HEAD — shared body: movement kit (Seraph bones), shatter/reform,
// contact damage, draw with red aura. Subclasses implement _updateAI + attacks.
// ═════════════════════════════════════════════════════════════════════════════
export class DragonHead {
    constructor(game, dragon, def, worldX, worldY) {
        this.game = game;
        this.dragon = dragon;
        this.def = def;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0; this.vy = 0;
        this.angle = Math.random() * Math.PI * 2;
        this.alive = true;
        this.isDragonHead = true;      // playingState: skip in serialize()
        this.state = 'scripted';       // 'scripted' | 'fight' | 'shattered'
        this.radius = 105;
        this.spriteKey = def.sprite;
        this.displayName = def.name;
        this.accent = def.accent;
        this.revealed = true;          // spawns on-screen mid-cinematic
        this.discovered = true;
        this.isFinished = false;

        // Health is rolled by the controller at fight start; each reform
        // halves the previous max — the fight is winnable by attrition.
        this.health = 50;
        this.maxHealth = 50;
        this.invulnerable = true;      // scripted arrival — nothing lands
        this._hpFlash = 0;             // HUD bar damage blink
        this.reformCount = 0;

        // Combat flight — the traditional boss-ship mover (boss.js): the hull
        // ALWAYS cruises at baseSpeed along a heading that turns at turnSpeed;
        // the AI picks targetAngle + a move state on committed timers. Real
        // boss numbers (Starcore 600/6.0, Event Horizon 900/8.0, Crusher
        // 400/7.0) — constant-speed mass is what "big ship" feels like.
        this.role = 'lurk';            // 'engage' | 'flank' | 'lurk' | 'duel'
        this.baseSpeed = def.baseSpeed || 550;
        this.turnSpeed = def.turnSpeed || 6.0;   // rad/s
        this.attackRange = def.attackRange || 1000;
        this.avoidDist = def.avoidDist || 340;   // wheel-away bubble — never overrun the player
        this.combatStyle = def.style || 'striker';
        this.moveState = 'idle';       // 'idle' | 'reposition' | 'strafe' | (specials own movement)
        this.moveTimer = 0.5 + Math.random();
        this.targetAngle = this.angle;
        this._speedMult = 1;
        this.strafeSide = Math.random() > 0.5 ? 1 : -1;
        this.strafeTarget = { x: 0, y: 0 };
        this.strafeRepositionTimer = 0;
        this.formationBearing = Math.random() * Math.PI * 2; // assigned by the coordinator

        // Shared weapon plumbing (Starcore-style): facing-gated forward-gun
        // bursts from hull offsets, and tracked hitscan beams.
        this.gunBurstQueue = 0;
        this.gunBurstTimer = 0;
        this.activeBeams = [];         // [{x, y, angle, timer}]

        // Cinematic flight constants (scriptFly steering only).
        this.maxSpeed = 2500;
        this.accel = 900;
        this.turnRate = 2.6;

        this._weavePhase = Math.random() * Math.PI * 2;
        this._animClock = Math.random() * 10;   // sim clock — never wall time

        // Scripted-motion channel (cinematic): {x0,y0,x1,y1,t,dur,ease,trail}
        this.script = null;

        // Combat
        this.attack = null;            // {type, phase, timer, ownsMove?, ...}
        this.stunTimer = 0;
        this.dashHitSet = null;        // per-dash contact bookkeeping
        this._touchCd = new Map();     // per-body contact i-frames
        this._lastClink = 0;

        // Shatter state
        this.shards = null;            // [{canvas,lx,ly,wx,wy,vx,vy,rot,spin,fx,fy}]
        this.shatterTimer = 0;
        this._shatterX = 0; this._shatterY = 0; this._shatterAngle = 0;

        // Seeded loot RNG (AI stays on Math.random, like every boss)
        this.contentRng = game.rng ? game.rng.deriveEntity('enemies').rng : null;
    }

    // ── event-contract helpers ──────────────────────────────────────────
    get isActive() { return false; }   // the controller owns spawn-freezing
    get blocksProjectiles() {
        // Wreckage clouds don't stop shots.
        return this.state !== 'shattered';
    }
    get isAttackable() {
        // Auto-weapons: never feed the disguise minigame or shoot wreckage.
        return this.state === 'fight' && !this.invulnerable && !this.disguised;
    }
    getSpawnOnDeath() { return []; }
    popSpawns() { const s = this.pendingSpawns || []; this.pendingSpawns = []; return s; }
    freeze(duration) { /* bosses shrug off cryo */ }

    _diff() { return (this.game.currentState && this.game.currentState.difficultyScale) || 1.0; }
    _viewHalf() {
        const ws = this.game.worldScale || 1;
        return { w: (this.game.width / 2) / ws, h: (this.game.height / 2) / ws };
    }
    _bodies() {
        const state = this.game.currentState;
        if (!state) return [];
        if (!state.netSync && state.localPlayers && state.localPlayers.length > 1) {
            return state.localPlayers.map(s => s.player).filter(p => p && !p.dead);
        }
        return state.player && !state.player.dead ? [state.player] : [];
    }
    _hurt(body, dmg, x, y) {
        const state = this.game.currentState;
        if (!state) return;
        if (!state.netSync && state.damagePlayerBody) state.damagePlayerBody(body, dmg, x, y);
        else state._damagePlayer(dmg, x, y);
    }
    _sfx(key, vol) { this.game.sounds.play(key, { volume: vol, x: this.worldX, y: this.worldY }); }
    _ring(opts) {
        const state = this.game.currentState;
        if (state && state.cinematics) state.cinematics.spawnRing(this.worldX, this.worldY, opts);
    }
    _sparks(x, y, n, opts) {
        const state = this.game.currentState;
        if (state && state._spawnSparks) state._spawnSparks(x, y, n, opts);
    }

    // Fire one bolt into the live world (local-scripted event: direct push).
    _bolt(x, y, angle, speed, dmg, sprite = 'red_laser_ball', life = 3.2) {
        const state = this.game.currentState;
        if (!state || !state.projectiles) return null;
        const proj = new Projectile(this.game, x, y, angle, speed, sprite, this, dmg, life);
        // The Accuser's mark: while it stands, the dragon's shots bend
        // toward the condemned.
        if (this.dragon.markActive && this.dragon.markBody && !this.dragon.markBody.dead) {
            proj.target = this.dragon.markBody;
            proj.turnRate = 0.35;
        }
        state.projectiles.push(proj);
        return proj;
    }

    // ── damage ──────────────────────────────────────────────────────────
    hit(damage) {
        if (this.state === 'shattered' || this.state === 'dying' || this.state === 'dead') return false;
        if (this.invulnerable || this.state === 'scripted') { this._immuneFeedback(); return false; }

        if (this.disguised) { this._onDisguiseHit(damage); }
        // Pre-damage hook: interactions that OPEN windows (e.g. finding the
        // true hull among doppelgangers) must run before immunity is judged.
        if (this._preHit) this._preHit();

        const mult = this._damageMult();
        // A zero mult is TRUE immunity (the Seraph's sealed-eye language):
        // grey 0s, no damage — find the window.
        if (mult <= 0) { this._immuneFeedback(); return false; }
        damage *= mult;
        this.health -= damage;
        this._hpFlash = 0.25;
        this._hitFlash = 0.08;
        // Boss-style damage numbers (boss.js hit()) — grey when the hull's
        // defensive identity is soaking the hit, bright on a punish window.
        const stateFt = this.game.currentState;
        if (stateFt && stateFt.spawnFloatingText) {
            const col = mult <= 0.75 ? '#9a9aa0' : (mult >= 1.4 ? '#ffee66' : '#ff4444');
            stateFt.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, col);
        }
        if (this._onDamaged) this._onDamaged(damage);
        // Every hit lands visibly — hull embers + clank (events get none of
        // the enemy-loop feedback for free; the boss rule is spectacle at
        // every beat).
        const ja = Math.random() * Math.PI * 2, jd = Math.random() * this.radius * 0.6;
        this._sparks(this.worldX + Math.cos(ja) * jd, this.worldY + Math.sin(ja) * jd,
            4 + Math.floor(Math.random() * 4),
            { spread: Math.PI * 2, color: Math.random() < 0.5 ? '#fff2b0' : '#ff8860', speedMin: 90, speedMax: 340 });
        this._sfx('hit', 0.3);
        this.dragon.onHeadDamaged(this, damage);
        if (this.health <= 0) {
            this.health = 0;
            this._startDying();
        }
        return false; // never "destroyed" — shatter/reform is our death
    }

    _onDisguiseHit(damage) { /* Deception overrides */ }

    _immuneFeedback() {
        const state = this.game.currentState;
        if (!state) return;
        const now = this._animClock;
        if (now - this._lastClink < 0.12) return;
        this._lastClink = now;
        if (state.spawnFloatingText) {
            state.spawnFloatingText(this.worldX + (Math.random() - 0.5) * 60,
                this.worldY + (Math.random() - 0.5) * 60, '0', '#9a9a9a');
        }
        this._sfx('hit', 0.2);
    }

    stun(dur) {
        this.stunTimer = Math.max(this.stunTimer, dur);
        this.attack = null;
    }

    // ── shatter / reform ────────────────────────────────────────────────
    // Boss-style death: a short DYING beat first — staggered fire blasts
    // marching across the hull while it strobes — then the voronoi burst.
    _startDying() {
        this.state = 'dying';
        this.attack = null;
        this.stunTimer = 0;
        this._endDisguise && this._endDisguise(false);
        this.dyingT = 0;
        this.dyingBlasts = [];
        const n = 6;
        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = Math.random() * this.radius * 0.75;
            const fx = pickFireExplosion(this.game.assets);
            this.dyingBlasts.push({
                dx: Math.cos(a) * d, dy: Math.sin(a) * d,
                at: 0.08 + (i / n) * 0.62, fireKey: fx.key, t: -1
            });
        }
        this._sfx('ship_explode', 0.5);
    }

    _updateDying(dt) {
        this.dyingT += dt;
        this.vx *= Math.pow(0.95, dt * 60);
        this.vy *= Math.pow(0.95, dt * 60);
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        for (const b of this.dyingBlasts) {
            if (b.t < 0 && this.dyingT >= b.at) {
                b.t = 0;
                this._sfx('ship_explode', 0.35);
                this._sparks(this.worldX + b.dx, this.worldY + b.dy, 8,
                    { spread: Math.PI * 2, color: '#ff8860', speedMin: 100, speedMax: 380 });
                this.game.camera.shake(0.7);
            }
            if (b.t >= 0) b.t += dt * 1000; // fire gif clocks run in ms
        }
        if (this.dyingT >= 0.85) this._shatter();
    }

    _shatter() {
        this.state = 'shattered';
        this.attack = null;
        this.stunTimer = 0;
        this.shatterTimer = 0;
        this._shatterX = this.worldX;
        this._shatterY = this.worldY;
        this._shatterAngle = this.angle + Math.PI / 2;
        this.vx = 0; this.vy = 0;
        this._endDisguise && this._endDisguise(false);

        const asset = this.game.assets.get(this.spriteKey);
        this.shards = [];
        if (asset) {
            const frags = getCachedShatter(asset, this.spriteKey, SHATTER_PIECES);
            const cosA = Math.cos(this._shatterAngle), sinA = Math.sin(this._shatterAngle);
            for (const frag of frags) {
                const wx = this._shatterX + (frag.lx * cosA - frag.ly * sinA);
                const wy = this._shatterY + (frag.lx * sinA + frag.ly * cosA);
                const outAngle = Math.atan2(frag.ly, frag.lx) + this._shatterAngle;
                // SPLINTER — a violent radial burst. The pieces never fade;
                // they tumble out, drift dead, and later fly home to rebuild.
                const spread = 260 + Math.random() * 430;
                this.shards.push({
                    canvas: frag.canvas, lx: frag.lx, ly: frag.ly,
                    wx, wy,
                    vx: Math.cos(outAngle) * spread + this.vx * 0.25,
                    vy: Math.sin(outAngle) * spread + this.vy * 0.25,
                    rot: this._shatterAngle, spin: (Math.random() - 0.5) * 4.4,
                    fx: 0, fy: 0 // frozen drift pos, captured when the reverse begins
                });
            }
        }

        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#ffffff', 0.5, 0.34);
            this._ring({ color: '#ffffff', maxR: 480, dur: 0.8, width: 7 });
            this._ring({ color: this.accent, maxR: 340, dur: 0.6, width: 5 });
            this._sparks(this.worldX, this.worldY, 34, { color: this.accent, speedMin: 160, speedMax: 620 });
            this._sparks(this.worldX, this.worldY, 16, { color: '#ffffff', speedMin: 220, speedMax: 700 });
            if (state.cinematics) state.cinematics.deathPop(this);
        }
        this.game.camera.shake(2.8);
        this._sfx('ship_explode', 1.0);
        this._sfx('shield_break', 0.6);

        // A taste of loot on the FIRST shatter only — reform cycles can't be
        // farmed. The real haul comes at victory.
        if (this.reformCount === 0 && this.contentRng) {
            this.pendingSpawns = this.pendingSpawns || [];
            for (let i = 0; i < 8; i++) {
                const a = this.contentRng.next() * Math.PI * 2;
                const s = new Scrap(this.game,
                    this.worldX + Math.cos(a) * 40, this.worldY + Math.sin(a) * 40,
                    this.contentRng.next() < 0.3 ? 'big' : 'small');
                s.vx = Math.cos(a) * (80 + this.contentRng.next() * 120);
                s.vy = Math.sin(a) * (80 + this.contentRng.next() * 120);
                this.pendingSpawns.push(s);
            }
        }
        this.dragon.onHeadShattered(this);
    }

    _updateShattered(dt) {
        this.shatterTimer += dt;
        const t = this.shatterTimer;

        if (t < REFORM_REVERSE_AT) {
            // Drift out and tumble, no fade — this wreck is coming back.
            const fr = Math.pow(0.985, dt * 60);
            for (const s of this.shards) {
                s.wx += s.vx * dt; s.wy += s.vy * dt;
                s.vx *= fr; s.vy *= fr;
                s.rot += s.spin * dt;
            }
        } else if (t < REFORM_TIME) {
            // THE REVERSAL — every piece flies home along a shrinking lerp.
            const p = easeIn((t - REFORM_REVERSE_AT) / (REFORM_TIME - REFORM_REVERSE_AT));
            const cosA = Math.cos(this._shatterAngle), sinA = Math.sin(this._shatterAngle);
            for (const s of this.shards) {
                if (s.fx === 0 && s.fy === 0) { s.fx = s.wx; s.fy = s.wy; } // capture once
                const hx = this._shatterX + (s.lx * cosA - s.ly * sinA);
                const hy = this._shatterY + (s.lx * sinA + s.ly * cosA);
                s.wx = s.fx + (hx - s.fx) * p;
                s.wy = s.fy + (hy - s.fy) * p;
                // Unwind the tumble back to the ship's frozen pose.
                const dr = ((this._shatterAngle - s.rot + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                s.rot += dr * Math.min(1, p * 2.2);
            }
            // Ember stream converging — the dragon knitting itself together.
            if (Math.random() < dt * 22) {
                const a = Math.random() * Math.PI * 2, d = 130 + Math.random() * 160;
                this._sparks(this._shatterX + Math.cos(a) * d, this._shatterY + Math.sin(a) * d, 2,
                    { dir: a + Math.PI, spread: 0.3, color: this.accent, speedMin: 180, speedMax: 320 });
            }
        } else {
            this._reform();
        }
    }

    _reform() {
        this.reformCount++;
        this.maxHealth = Math.max(80, this.maxHealth * 0.5);
        this.health = this.maxHealth;
        this.state = 'fight';
        this.shards = null;
        this.worldX = this._shatterX;
        this.worldY = this._shatterY;
        this.vx = 0; this.vy = 0;
        this.moveState = 'idle';
        this.moveTimer = 0.8;
        const state = this.game.currentState;
        if (state && state.triggerFlash) state.triggerFlash(RED, 0.4, 0.22);
        this._ring({ color: this.accent, maxR: 360, dur: 0.7, width: 5 });
        this._ring({ color: '#ffffff', maxR: 220, dur: 0.5, width: 3 });
        this._sfx('ship_explode', 0.6);
        this._sfx('boost', 0.6);
        this.game.camera.shake(1.6);
        this.dragon.onHeadReformed(this);
    }

    // ── ship flight ─────────────────────────────────────────────────────
    // The primitive every maneuver is built from: turn the nose toward a
    // desired heading at the hull's turn rate, thrust along the nose, cap
    // speed, bleed a little velocity that isn't aligned with the nose (so
    // turns carve arcs instead of orbit-drifting). Same physics language as
    // the regular enemy pilots — just flown better.
    _shipSteer(dt, desiredAngle, throttle, speedCap) {
        let da = ((desiredAngle - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        const maxTurn = this.turnRate * dt;
        this.angle += Math.max(-maxTurn, Math.min(maxTurn, da));

        this.vx += Math.cos(this.angle) * this.accel * throttle * dt;
        this.vy += Math.sin(this.angle) * this.accel * throttle * dt;

        // Sideways bleed: skilled pilots don't drift like asteroids.
        const fwdX = Math.cos(this.angle), fwdY = Math.sin(this.angle);
        const fwd = this.vx * fwdX + this.vy * fwdY;
        const latX = this.vx - fwdX * fwd, latY = this.vy - fwdY * fwd;
        const grip = Math.pow(0.9, dt * 60);
        this.vx = fwdX * fwd + latX * grip;
        this.vy = fwdY * fwd + latY * grip;

        const cap = speedCap || this.maxSpeed;
        const v = Math.hypot(this.vx, this.vy);
        if (v > cap) { this.vx = this.vx / v * cap; this.vy = this.vy / v * cap; }

        this.vx *= Math.pow(0.995, dt * 60);
        this.vy *= Math.pow(0.995, dt * 60);
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Engine glow: burning hard sheds embers off the tail. Cheap, rate-
        // limited — reads as thrust without a dedicated jet sprite.
        if (throttle > 0.5 && v > 340 && Math.random() < dt * 11) {
            const back = this.angle + Math.PI;
            this._sparks(this.worldX + Math.cos(back) * 58, this.worldY + Math.sin(back) * 58, 1,
                { dir: back, spread: 0.4, color: '#ff8860', speedMin: 60, speedMax: 200, lifeMin: 0.2, lifeMax: 0.45 });
        }
    }

    // Brake and hold the nose on a point (aim/gather/cast phases).
    _shipDrift(dt, faceX, faceY) {
        if (faceX !== undefined) {
            const desired = Math.atan2(faceY - this.worldY, faceX - this.worldX);
            let da = ((desired - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            const maxTurn = this.turnRate * dt;
            this.angle += Math.max(-maxTurn, Math.min(maxTurn, da));
        }
        this.vx *= Math.pow(0.93, dt * 60);
        this.vy *= Math.pow(0.93, dt * 60);
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
    }

    _duelAnchor(player) {
        return (this.role === 'duel' && this.duelAlly) ? this.duelAlly : player;
    }

    // ── COMBAT FLIGHT — the traditional boss-ship mover, taken from the
    // real bosses (boss.js update / starcore._updateAI / eventHorizon) ────
    // The hull always cruises at baseSpeed along `angle`, which turns toward
    // `targetAngle` at turnSpeed. States are committed with stateTimers:
    // IDLE (predictive aim, like Starcore idle), REPOSITION (perpendicular
    // wheel-off, Starcore :196-200), STRAFE (fly alongside the target,
    // EventHorizon _updateStrafe with its 0.3s re-target), plus the
    // proximity avoidance (Starcore :129-135 / EH :124-133) and the
    // dist>1800 super-boost (boss.js :115-122). On top: fleet separation, so
    // seven capital ships never stack.
    _updateFlight(dt, player, dist, angleToPlayer) {
        this.moveTimer -= dt;
        let speed = this.baseSpeed * this._speedMult;

        // Super boost — ONLY the strike team burns in (boss.js catch-up).
        // This is what makes a fresh sortie sweep in from deep space.
        if (dist > 1800 && (this.role === 'engage' || this.role === 'duel')) {
            speed = this.baseSpeed * 4;
            this.targetAngle = angleToPlayer;
        } else if (this.role === 'engage' && this._offScreen(player)) {
            // THE SERAPH RULE: an attacker on sortie lives INSIDE the player's
            // screen. Slip out of view and it immediately burns back in.
            speed = this.baseSpeed * 1.8;
            const rx = player.worldX + (player.vx || 0) * 0.3;
            const ry = player.worldY + (player.vy || 0) * 0.3;
            this.targetAngle = Math.atan2(ry - this.worldY, rx - this.worldX);
        } else if (dist < this.avoidDist && this.moveState !== 'reposition') {
            // Avoidance: force a perpendicular reposition instead of ramming.
            this.moveState = 'reposition';
            this.moveTimer = 0.8;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + Math.PI * 0.5 * side;
            this._speedMult = 1.0;
        } else if (this.moveState === 'idle') {
            // Predictive aim while idling between actions (Starcore) — the
            // strike team only; withdrawn heads pick a heading immediately.
            if (this.role === 'engage' || this.role === 'duel') {
                this.targetAngle = this._getPredictedAngle(this._duelAnchor(player), 1200);
            }
            if (this.moveTimer <= 0 || this.role === 'withdrawn') this._selectNextMove(player, dist, angleToPlayer);
        } else if (this.moveState === 'reposition') {
            if (this.moveTimer <= 0) { this.moveState = 'idle'; this.moveTimer = 0.6; }
        } else if (this.moveState === 'strafe') {
            // EH strafe: chase a point alongside the target, re-picked at 0.3s.
            this.strafeRepositionTimer -= dt;
            if (this.strafeRepositionTimer <= 0) {
                this._updateStrafeTarget(this._duelAnchor(player));
                this.strafeRepositionTimer = 0.3;
            }
            const sdx = this.strafeTarget.x - this.worldX;
            const sdy = this.strafeTarget.y - this.worldY;
            this.targetAngle = Math.atan2(sdy, sdx);
            speed = (Math.hypot(sdx, sdy) > 220 ? this.baseSpeed * 1.3 : this.baseSpeed * 0.9);
            if (this.moveTimer <= 0) this._selectNextMove(player, dist, angleToPlayer);
        }

        // Fleet separation: the nearest brother inside the bubble takes the
        // wheel — blended at first, absolute when hulls are about to touch.
        let sepA = null, sepD = Infinity;
        for (const other of this.dragon.heads) {
            if (other === this || other.state !== 'fight') continue;
            const od = Math.hypot(other.worldX - this.worldX, other.worldY - this.worldY);
            if (od < sepD) {
                sepD = od;
                sepA = Math.atan2(this.worldY - other.worldY, this.worldX - other.worldX);
            }
        }
        if (sepA !== null && sepD < 500) {
            if (sepD < 300) {
                this.targetAngle = sepA;
            } else {
                const w = Math.min(0.85, (500 - sepD) / 200 * 0.7);
                let sa = ((sepA - this.targetAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                this.targetAngle += sa * w;
            }
        }

        // The classic boss mover verbatim: bounded turn, cruise along the nose.
        let diff = this.targetAngle - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);
        this.vx = Math.cos(this.angle) * speed;
        this.vy = Math.sin(this.angle) * speed;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Engine embers on a hard burn.
        if (speed > this.baseSpeed * 1.25 && Math.random() < dt * 9) {
            const back = this.angle + Math.PI;
            this._sparks(this.worldX + Math.cos(back) * 58, this.worldY + Math.sin(back) * 58, 1,
                { dir: back, spread: 0.4, color: '#ff8860', speedMin: 60, speedMax: 200, lifeMin: 0.2, lifeMax: 0.45 });
        }
    }

    // Attacker on-screen presence test (view half-extents, Seraph-style).
    _offScreen(player) {
        const ws = this.game.worldScale || 1;
        const hw = (this.game.width / 2) / ws, hh = (this.game.height / 2) / ws;
        return Math.abs(this.worldX - player.worldX) > hw * 0.9 + this.radius
            || Math.abs(this.worldY - player.worldY) > hh * 0.85 + this.radius;
    }

    // EH's strafe-point picker: alongside the target, slightly ahead of
    // their travel — CLOSE, carving across the visible screen — and biased
    // into this head's assigned sortie hemisphere so the strike pair
    // brackets the player instead of stacking on one side.
    _updateStrafeTarget(tgt) {
        const heading = Math.atan2(tgt.vy || 0, tgt.vx || 0);
        const tSpeed = Math.hypot(tgt.vx || 0, tgt.vy || 0);
        let sideAngle = heading + (Math.PI / 2) * this.strafeSide;
        if (this.sortieBearing !== undefined) {
            // Pull the run into this head's half of the pincer.
            let da = ((this.sortieBearing - sideAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            sideAngle += da * 0.55;
        }
        const desiredDist = 420 + Math.random() * 160;
        const leadDist = Math.min(tSpeed * 0.3, 200);
        this.strafeTarget.x = tgt.worldX + Math.cos(sideAngle) * desiredDist + Math.cos(heading) * leadDist;
        this.strafeTarget.y = tgt.worldY + Math.sin(sideAngle) * desiredDist + Math.sin(heading) * leadDist;
    }

    // Movement action table (the Starcore/EH _selectNextAction shape).
    // Station roles patrol their assigned sector; pressure roles alternate
    // strafing runs, perpendicular repositions and brief aiming holds.
    _selectNextMove(player, dist, angleToPlayer) {
        if (this.role === 'withdrawn') {
            // OFF-DUTY = GONE. Break away from the player and go wander deep
            // space until the coordinator calls this head's sortie. If the
            // player comes hunting, actively avoid them.
            this._speedMult = 0.55;
            if (dist < 2100) {
                // Leave (or dodge a pursuing player): burn directly away.
                this.moveState = 'reposition';
                this.moveTimer = 0.8 + Math.random() * 0.4;
                this.targetAngle = angleToPlayer + Math.PI + (Math.random() - 0.5) * 0.5;
                this._speedMult = 1.15;
            } else {
                // Deep-space prowl: slow drifting waypoints far out.
                if (!this._wander || Math.hypot(this._wander.x - this.worldX, this._wander.y - this.worldY) < 420) {
                    const wa = Math.random() * Math.PI * 2;
                    const wd = 2600 + Math.random() * 1400;
                    this._wander = { x: player.worldX + Math.cos(wa) * wd, y: player.worldY + Math.sin(wa) * wd };
                }
                this.moveState = 'reposition';
                this.moveTimer = 1.2 + Math.random() * 0.8;
                this.targetAngle = Math.atan2(this._wander.y - this.worldY, this._wander.x - this.worldX);
            }
            return;
        }

        this._speedMult = 1.0;
        const roll = Math.random();
        if (roll < 0.5) {
            // Gun run alongside the target — the workhorse (EH's tempo).
            this.moveState = 'strafe';
            this.moveTimer = 1.2 + Math.random() * 0.6;
            this.strafeSide = -this.strafeSide;
            this.strafeRepositionTimer = 0;
            this._updateStrafeTarget(this._duelAnchor(player));
        } else if (roll < 0.7 || dist < this.avoidDist * 1.6) {
            this.moveState = 'reposition';
            this.moveTimer = 0.6 + Math.random() * 0.4;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + (Math.PI * 0.4) * side;
        } else {
            // Aim-and-close: cruise straight down the predicted lead.
            this.moveState = 'idle';
            this.moveTimer = 0.4 + Math.random() * 0.4;
        }
    }

    // Starcore's predictive-lead helper, verbatim.
    _getPredictedAngle(tgt, projSpeed) {
        const dx = tgt.worldX - this.worldX;
        const dy = tgt.worldY - this.worldY;
        const distSq = dx * dx + dy * dy;
        const pVx = tgt.vx || 0;
        const pVy = tgt.vy || 0;
        const a = pVx * pVx + pVy * pVy - projSpeed * projSpeed;
        const b = 2 * (dx * pVx + dy * pVy);
        const c = distSq;
        const disc = b * b - 4 * a * c;
        if (disc < 0) return Math.atan2(dy, dx);
        const t1 = (-b + Math.sqrt(disc)) / (2 * a);
        const t2 = (-b - Math.sqrt(disc)) / (2 * a);
        let t = Math.max(t1, t2);
        if (t < 0) t = Math.min(t1, t2);
        if (t < 0) return Math.atan2(dy, dx);
        return Math.atan2(tgt.worldY + pVy * t - this.worldY, tgt.worldX + pVx * t - this.worldX);
    }

    // Starcore's forward-gun burst, adapted: twin hull-mounted guns that only
    // fire while the NOSE is roughly on the predicted target — pointing the
    // ship matters, exactly like the real bosses.
    _updateGunBurst(dt, tgt, opts = {}) {
        if (this.gunBurstQueue <= 0) return;
        const pred = this._getPredictedAngle(tgt, opts.speed || 1100);
        let angleDiff = pred - this.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        if (Math.abs(angleDiff) >= 0.4) return;
        this.gunBurstTimer -= dt;
        if (this.gunBurstTimer > 0) return;
        this.gunBurstQueue--;
        this.gunBurstTimer = 0.09;
        const offsets = [{ x: 40, y: 55 }, { x: 40, y: -55 }];
        for (const off of offsets) {
            const px = this.worldX + off.x * Math.cos(this.angle) - off.y * Math.sin(this.angle);
            const py = this.worldY + off.x * Math.sin(this.angle) + off.y * Math.cos(this.angle);
            this._bolt(px, py, this.angle + (Math.random() - 0.5) * 0.05,
                opts.speed || 1100, opts.dmg || 5, opts.sprite || 'red_laser_ball', 2.6);
        }
        this._sfx('laser', 0.3);
    }

    // Starcore's side-launched homing rockets, adapted (lower damage — seven
    // ships share one player).
    _fireSideMissiles(tgt, count, dmg) {
        for (let i = 0; i < count; i++) {
            const side = i % 2 === 0 ? 1 : -1;
            const ang = this.angle + Math.PI * 0.7 * side;
            const px = this.worldX + Math.cos(ang) * 55;
            const py = this.worldY + Math.sin(ang) * 55;
            const proj = this._bolt(px, py, ang, 600, dmg, 'red_laser_ball_big', 9.0);
            if (proj) { proj.isRocket = true; proj.target = tgt; proj.turnRate = 2.4; }
        }
        this._sfx('railgun_shoot', 0.5);
    }

    // Starcore mega-beam plumbing: tracked hitscan beams fired from the nose,
    // drawn with the boss beam strips.
    _updateActiveBeams(dt, player) {
        const diff = this._diff();
        for (let i = this.activeBeams.length - 1; i >= 0; i--) {
            const b = this.activeBeams[i];
            b.timer -= dt;
            if (b.timer <= 0) { this.activeBeams.splice(i, 1); continue; }
            // Track the player while firing (Starcore :58-68), pinned to the nose.
            const anchor = this._duelAnchor(player);
            const want = Math.atan2(anchor.worldY - b.y, anchor.worldX - b.x);
            let bd = want - b.angle;
            while (bd > Math.PI) bd -= Math.PI * 2;
            while (bd < -Math.PI) bd += Math.PI * 2;
            b.angle += bd * Math.min(1, 2.0 * dt);
            b.x = this.worldX + Math.cos(this.angle) * 80;
            b.y = this.worldY + Math.sin(this.angle) * 80;
            // Cone hitscan (Starcore :70-91), damage kept modest.
            for (const body of this._bodies()) {
                const dx = body.worldX - b.x, dy = body.worldY - b.y;
                const distSq = dx * dx + dy * dy;
                if (distSq >= 36000000) continue;
                const d = Math.sqrt(distSq) || 1;
                const dirX = Math.cos(b.angle), dirY = Math.sin(b.angle);
                if ((dx * dirX + dy * dirY) / d > 0.99 &&
                    Math.abs(dx * dirY - dy * dirX) < body.radius + 30) {
                    // Starcore weight — standing in a mega-beam MELTS.
                    this._hurt(body, (52 + 6 * diff) * dt, b.x, b.y);
                }
            }
        }
    }

    // Contact damage — only meaningful while dashing (dashHitSet armed) or for
    // heavy hulls; per-body i-frames like the Wheels.
    _updateContact(dt, heavy = false) {
        // Touch i-frames decay ALWAYS — wake burns share this store, and a
        // cooldown that only ticks while dashing never expires (found as the
        // "wakes deal no damage" bug).
        for (const [body, cd] of this._touchCd) {
            if (cd > 0) this._touchCd.set(body, cd - dt);
        }
        const dashing = !!this.dashHitSet;
        if (!dashing && !heavy) return;
        const diff = this._diff();
        for (const body of this._bodies()) {
            if ((this._touchCd.get(body) || 0) > 0) continue;
            const dx = body.worldX - this.worldX, dy = body.worldY - this.worldY;
            const cr = body.radius + this.radius * 0.8;
            if (dx * dx + dy * dy < cr * cr) {
                if (dashing && this.dashHitSet.has(body)) continue;
                // Seraph-charge weight: a landed dash is a PUNISH, and the
                // shield doesn't trivialize a capital hull to the face.
                // (_dashBonus: execution-tier moves hit even harder.)
                const dmg = Math.min(110, (dashing ? 38 + 5 * diff + (this._dashBonus || 0) : 18 + 3 * diff));
                this._hurt(body, dmg, this.worldX, this.worldY);
                if (dashing) this.dashHitSet.add(body);
                this._touchCd.set(body, 0.9);
                const state = this.game.currentState;
                if (state && state._applyKnockback) {
                    const dist = Math.hypot(dx, dy) || 1;
                    state._applyKnockback(dx, dy, dist, 420, body);
                }
                // The crunch: a ram should FEEL like one — and the knife's
                // rams draw BLOOD.
                this._sparks(body.worldX, body.worldY, 12,
                    { spread: Math.PI * 2, color: this.goreOnContact ? '#c01818' : '#ff9a5a', speedMin: 140, speedMax: 460 });
                if (this.goreOnContact && this._blood) {
                    this._blood(body.worldX, body.worldY, 10, true);
                    this._blood(body.worldX, body.worldY, 6);
                    if (this._goreBurst) this._goreBurst(body.worldX, body.worldY, 6);
                }
                this._ring({ color: this.accent, maxR: 120, dur: 0.3, width: 3 });
                this._sfx('ship_explode', 0.4);
                this.game.camera.shake(1.4);
            }
        }
    }

    // The Seraph telegraph law: heavy tells that COMPRESS with difficulty.
    _teleMult() {
        return Math.max(0.5, 1 - (this._diff() - 1) * 0.1);
    }

    // Windup tell: tension shiver + embers shaking off the hull (the Seraph
    // rule — charges must be heavily telegraphed with weight).
    _telegraphTick(dt) {
        this._shiverAmt = 3;
        if (Math.random() < dt * 22) {
            const a = Math.random() * Math.PI * 2, d = Math.random() * this.radius * 0.7;
            this._sparks(this.worldX + Math.cos(a) * d, this.worldY + Math.sin(a) * d, 1,
                { color: this.accent, speedMin: 40, speedMax: 140, lifeMin: 0.3, lifeMax: 0.6 });
        }
    }

    // Dash wake: fire sheds from the WHOLE silhouette, not a center point.
    _dashWake(dt) {
        if (Math.random() < dt * 50) {
            const a = Math.random() * Math.PI * 2, r = Math.random() * this.radius * 0.85;
            this._sparks(this.worldX + Math.cos(a) * r, this.worldY + Math.sin(a) * r, 2, {
                dir: this.angle + Math.PI, spread: 0.9,
                color: Math.random() < 0.5 ? '#ff8860' : this.accent,
                speedMin: 80, speedMax: 320, lifeMin: 0.25, lifeMax: 0.6
            });
        }
    }

    // ── update ──────────────────────────────────────────────────────────
    update(dt, player) {
        if (!this.alive) return;
        this._animClock += dt;
        if (this._hpFlash > 0) this._hpFlash -= dt;

        if (this.state === 'dead') return; // victory — the controller owns the shards
        if (this.state === 'dying') { this._updateDying(dt); return; }
        if (this.state === 'shattered') { this._updateShattered(dt); return; }
        if (this._hitFlash > 0) this._hitFlash -= dt;
        if (this._shiverAmt > 0) this._shiverAmt *= Math.pow(0.82, dt * 60);

        if (this.script) { this._updateScript(dt); return; }
        if (this.state === 'scripted') { this._parkedIdle(dt); return; } // seated in the ring

        // FIGHT
        if (this.stunTimer > 0) {
            this.stunTimer -= dt;
            // Staggered: drift + sparks, no attacks, no steering.
            this.vx *= Math.pow(0.94, dt * 60);
            this.vy *= Math.pow(0.94, dt * 60);
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;
            if (Math.random() < dt * 18) {
                this._sparks(this.worldX + (Math.random() - 0.5) * 90,
                    this.worldY + (Math.random() - 0.5) * 90, 2,
                    { color: '#ffffff', speedMin: 60, speedMax: 200 });
            }
            return;
        }

        // Anchor: the player — or, in a duel, the angel this head is locked
        // against (its guns turn on the angel; stray bolts stay live).
        const anchor = this._duelAnchor(player);
        const adx = anchor.worldX - this.worldX, ady = anchor.worldY - this.worldY;
        const dist = Math.hypot(adx, ady) || 1;
        const angleToTarget = Math.atan2(ady, adx);

        this._updateActiveBeams(dt, player);

        // Specials that OWN movement (dashes, blinks, committed holds) run
        // exclusively — like BOSS_STATE.DASH.
        if (this.attack && this.attack.ownsMove) {
            this._updateAttack(dt, player);
            this._updateContact(dt, this.heavyHull);
            return;
        }
        // Overlay specials tick while the ship keeps flying.
        if (this.attack) this._updateAttack(dt, player);

        this._updateFlight(dt, player, dist, angleToTarget);
        // Weapons run on their own clocks WHILE the ship flies — the
        // Starcore/Event Horizon combat loop. Range-gated per head.
        this._updateWeapons(dt, anchor, dist, angleToTarget);
        this._updateContact(dt, this.heavyHull);
    }

    // Weapon cadence by role: ONLY the strike team fires — and on duty a
    // head acts near-CONSTANTLY (the Seraph rule: it punishes, it never
    // idles; something happens roughly every second of a sortie).
    _weaponRate() {
        if (this.role === 'engage' || this.role === 'duel') return this.dragon.cadenceMult * 2.2;
        return 0;
    }

    // Per-head defensive identity — the "different tactics" hook. Reduced
    // hits print grey so the armor teaches itself; amplified windows are the
    // punish openings.
    _damageMult() { return 1; }

    // An attacker visible on the player's screen is NEVER silenced by a
    // range gate — its whole job is to be firing.
    _inWeaponRange(dist) {
        return dist < Math.max(this.attackRange, 1350);
    }

    _updateWeapons(dt, tgt, dist, angleToTarget) { /* subclass */ }
    _updateAttack(dt, player) { /* subclass specials */ }

    // ── drawing ─────────────────────────────────────────────────────────
    draw(ctx, camera) {
        if (!this.alive) return;
        if (this.state === 'shattered' || this.state === 'dead') {
            this._drawUnder(ctx, camera);
            this._drawShards(ctx, camera);
            // World-anchored leftovers (burning wakes etc) outlive the hull.
            this._drawExtras(ctx, camera, null, this.game.worldScale);
            return;
        }

        const asset = this.game.assets.get(this.disguised ? this.disguiseSprite : this.spriteKey);
        if (!asset) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const ws = this.game.worldScale;
        const img = asset.canvas || asset;
        const w = (asset.width || img.width) * ws;
        const h = (asset.height || img.height) * ws;

        // The cull only skips the HULL — world-anchored extras (wakes,
        // beams, telegraphs) must draw even while the ship itself is off
        // past the margin, or they flicker every time it dashes across the
        // screen edge (user-reported).
        const cw = ctx.canvas.width, ch = ctx.canvas.height;
        const hullVisible = !(screen.x < -w * 1.5 || screen.x > cw + w * 1.5 ||
            screen.y < -h * 1.5 || screen.y > ch + h * 1.5);
        if (!hullVisible) {
            this._drawUnder(ctx, camera);
            this._drawWorldFx(ctx, camera);
            this._drawExtras(ctx, camera, screen, ws);
            return;
        }

        // Under-layer FX (trails/wakes) draw BENEATH the hull.
        this._drawUnder(ctx, camera);

        // Deception's tell: the true silhouette haunting under the mask —
        // flaring sharply whenever the mask commits a covert act.
        if (this.disguised) {
            if (this._maskFlicker > 0) this._maskFlicker -= 0.016;
            const trueAsset = this.game.assets.get(this.spriteKeyTrue || this.spriteKey);
            if (trueAsset) {
                const tKey = this.spriteKeyTrue || this.spriteKey;
                const ghost = tintedSprite(trueAsset, tKey, 'rgba(255,40,40,1)', 8);
                const gw = ghost.width * ws * 1.12, gh = ghost.height * ws * 1.12;
                ctx.save();
                ctx.translate(screen.x, screen.y);
                ctx.rotate(this.angle + Math.PI / 2);
                ctx.globalAlpha = 0.16 + 0.06 * Math.sin(this._animClock * 2.2)
                    + Math.max(0, this._maskFlicker || 0);
                ctx.globalCompositeOperation = 'screen';
                ctx.drawImage(ghost.canvas, -gw / 2, -gh / 2, gw, gh);
                ctx.restore();
            }
        } else if (!this.cloaked) {
            // A tight red rim under the hull — subtle, hugging the silhouette
            // (the old wide halo read as a weird blob). The cinematic
            // charge-up is the one moment it's allowed to swell and whiten.
            const glow = tintedSprite(asset, this.spriteKey, 'rgba(255,40,32,1)', 3);
            const charge = this._chargeGlow || 0;
            const pulse = 0.16 + 0.06 * Math.sin(this._animClock * 2.6 + this.def.idx);
            const gs = 1.05 + charge * 0.22;
            const gw = glow.width * ws * gs, gh = glow.height * ws * gs;
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.globalAlpha = Math.min(1, (pulse + charge * 0.7)) * (this.stunTimer > 0 ? 0.4 : 1);
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
            if (charge > 0.01) {
                const white = tintedSprite(asset, this.spriteKey, 'rgba(255,240,230,1)', 5);
                ctx.globalAlpha = charge * 0.55;
                ctx.drawImage(white.canvas, -gw / 2, -gh / 2, gw, gh);
            }
            ctx.restore();
        }

        // Tension shiver during windups — the hull physically trembles.
        const jx = this._shiverAmt > 0.2 ? (Math.random() - 0.5) * this._shiverAmt * ws : 0;
        const jy = this._shiverAmt > 0.2 ? (Math.random() - 0.5) * this._shiverAmt * ws : 0;

        ctx.save();
        ctx.translate(screen.x + jx, screen.y + jy);
        ctx.rotate(this.angle + Math.PI / 2);
        // Stun strobe (like rage-invuln feedback, inverted meaning); the
        // dying hull strobes harder as the blasts march across it. A cloaked
        // hull is a shimmer-thin ghost slipping between the stars.
        if (this.stunTimer > 0 && Math.floor(this._animClock * 14) % 2 === 0) ctx.globalAlpha = 0.6;
        if (this.state === 'dying' && Math.floor(this._animClock * 22) % 2 === 0) ctx.globalAlpha = 0.75;
        if (this.cloaked) ctx.globalAlpha = 0.18 + 0.07 * Math.sin(this._animClock * 5);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        // Impact flash: one bright frame per hit.
        if (this._hitFlash > 0) {
            const white = tintedSprite(asset, this.spriteKey + '|hitw', 'rgba(255,255,255,1)', 0);
            ctx.globalAlpha = (this._hitFlash / 0.08) * 0.55;
            ctx.globalCompositeOperation = 'lighter';
            ctx.drawImage(white.canvas, -w / 2, -h / 2, w, h);
        }
        ctx.restore();

        // Dying: staggered fire blasts marching across the silhouette.
        if (this.state === 'dying' && this.dyingBlasts) {
            for (const b of this.dyingBlasts) {
                if (b.t < 0) continue;
                const frames = this.game.assets.get(b.fireKey);
                const f = fireExplosionFrame(frames, b.t);
                if (!f) continue;
                const fw = f.width * ws * 1.4, fh = f.height * ws * 1.4;
                ctx.save();
                ctx.translate(screen.x + b.dx * ws, screen.y + b.dy * ws);
                ctx.drawImage(f.canvas || f, -fw / 2, -fh / 2, fw, fh);
                ctx.restore();
            }
        }

        this._drawWorldFx(ctx, camera);
        this._drawExtras(ctx, camera, screen, ws);
    }

    // Boss-style beams (shared): the charge-up targeting line pinned to the
    // nose, then the fired beam strips — drawn exactly like Starcore. Kept
    // OUTSIDE the hull cull: a beam fired from off-screen still crosses it.
    _drawWorldFx(ctx, camera) {
        if (this.isChargingBeam) {
            const targetImg = this.game.assets.get('red_laser_beam_targeting');
            if (targetImg) {
                const px = this.worldX + Math.cos(this.angle) * 80;
                const py = this.worldY + Math.sin(this.angle) * 80;
                const alpha = 0.4 + 0.6 * (Math.sin(this._animClock * 33) * 0.5 + 0.5);
                this._drawBeamStripAt(ctx, camera, px, py, this.angle, targetImg, alpha, 6000);
            }
        }
        if (this.activeBeams.length) {
            const beamImg = this.game.assets.get('red_laser_beam_big');
            if (beamImg) {
                for (const b of this.activeBeams) {
                    this._drawBeamStripAt(ctx, camera, b.x, b.y, b.angle, beamImg, Math.min(1, b.timer / 0.3), 6000);
                }
            }
        }
    }

    _drawBeamStripAt(ctx, camera, x, y, angle, img, alpha, range) {
        const sx = x * camera.wtsScale + camera.wtsOffX;
        const sy = y * camera.wtsScale + camera.wtsOffY;
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        const canvas = img.canvas || img;
        const tileW = (img.width || canvas.width) * this.game.worldScale;
        const tileH = (img.height || canvas.height) * this.game.worldScale;
        drawBeamStrip(ctx, img, tileW, tileH, range * this.game.worldScale);
        ctx.restore();
    }

    _drawUnder(ctx, camera) { /* subclass: FX that belong BENEATH the hull */ }
    _drawExtras(ctx, camera, screen, ws) { /* subclass hooks (telegraphs etc.) */ }

    _drawShards(ctx, camera) {
        if (!this.shards) return;
        const ws = this.game.worldScale;
        const t = this.shatterTimer;
        const reforming = this.state === 'shattered' && t >= REFORM_REVERSE_AT;
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (const s of this.shards) {
            const sx = s.wx * camera.wtsScale + camera.wtsOffX;
            const sy = s.wy * camera.wtsScale + camera.wtsOffY;
            // Shard canvases are LOGICAL resolution (VoronoiSlicer scans the
            // logical size) — same sizing as ProceduralDebris.draw.
            const w = s.canvas.width * ws;
            const h = s.canvas.height * ws;
            if (sx < -120 || sx > ctx.canvas.width + 120 || sy < -120 || sy > ctx.canvas.height + 120) continue;
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(s.rot);
            ctx.drawImage(s.canvas, -w / 2, -h / 2, w, h);
            ctx.restore();
        }
        ctx.restore();
        // Reassembly glow at the home point.
        if (reforming) {
            const p = (t - REFORM_REVERSE_AT) / (REFORM_TIME - REFORM_REVERSE_AT);
            const hx = this._shatterX * camera.wtsScale + camera.wtsOffX;
            const hy = this._shatterY * camera.wtsScale + camera.wtsOffY;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.25 + 0.45 * p;
            ctx.fillStyle = this.accent;
            ctx.beginPath();
            ctx.arc(hx, hy, (18 + 46 * p) * ws, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }

    // ── cinematic scripting ─────────────────────────────────────────────
    // Two script modes. `scriptFly` = REAL flight: the ship steers, burns and
    // brakes toward a point with its own physics — curves, banking and settle
    // fall out of the kinematics instead of a tween (nothing robotic to see).
    // `scriptTo` = geometric tween, kept ONLY for the circle arcs (a constant-
    // rate carve around a perfect circle is precision formation flying).
    scriptFly(tx, ty, opts = {}) {
        this.script = {
            mode: 'fly', tx, ty, t: 0,
            delay: opts.delay || 0,
            speed: opts.speed || 2300,
            brake: opts.brake !== false,   // decelerate into the point vs blast through
            trail: opts.trail || null,
            embers: opts.embers !== false,
            carve: opts.carve || false,
            done: opts.done || null,
            launchSfx: opts.launchSfx || false,
            maxT: opts.maxT || 7
        };
    }

    scriptTo(x1, y1, dur, opts = {}) {
        this.script = {
            mode: 'tween',
            x0: this.worldX, y0: this.worldY, x1, y1, t: 0, dur,
            delay: opts.delay || 0,
            ease: opts.ease || easeInOut,
            trail: opts.trail || null,
            arc: opts.arc || null,         // {cx, cy, r, a0, a1} — circle sweeps
            embers: opts.embers || false,
            carve: opts.carve || false,
            done: opts.done || null,
            launchSfx: opts.launchSfx || false
        };
    }

    _updateScript(dt) {
        const s = this.script;
        if (s.delay > 0) {
            s.delay -= dt;
            if (s.delay > 0) { this._parkedIdle(dt); return; }
            if (s.mode === 'tween') { s.x0 = this.worldX; s.y0 = this.worldY; }
            if (s.launchSfx) this._sfx('boost', 0.6);
        }
        s.t += dt;

        let finished = false;
        const px = this.worldX, py = this.worldY;

        if (s.mode === 'fly') {
            const dx = s.tx - this.worldX, dy = s.ty - this.worldY;
            const dist = Math.hypot(dx, dy);
            // Cinematic precision: same steering physics, sharper reflexes.
            const savedTurn = this.turnRate, savedAccel = this.accel;
            this.turnRate = savedTurn * 2.4;
            this.accel = savedAccel * 4.5;
            let cap = s.speed;
            if (s.brake && dist < 620) cap = Math.max(190, s.speed * (dist / 620));
            this._shipSteer(dt, Math.atan2(dy, dx), 1.0, cap);
            this.turnRate = savedTurn; this.accel = savedAccel;
            finished = dist < (s.brake ? 85 : 140) || s.t > s.maxT;
        } else {
            const p = Math.min(1, s.t / s.dur);
            const e = s.ease(p);
            let nx, ny;
            if (s.arc) {
                const a = s.arc.a0 + (s.arc.a1 - s.arc.a0) * e;
                nx = s.arc.cx + Math.cos(a) * s.arc.r;
                ny = s.arc.cy + Math.sin(a) * s.arc.r;
            } else {
                nx = s.x0 + (s.x1 - s.x0) * e;
                ny = s.y0 + (s.y1 - s.y0) * e;
            }
            const mvx = nx - this.worldX, mvy = ny - this.worldY;
            if (mvx * mvx + mvy * mvy > 0.01) {
                const want = Math.atan2(mvy, mvx);
                let da = ((want - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                this.angle += da * Math.min(1, dt * 10);
            }
            // Track velocity so the leg hands real momentum to the next state.
            this.vx = mvx / Math.max(dt, 1e-4);
            this.vy = mvy / Math.max(dt, 1e-4);
            this.worldX = nx; this.worldY = ny;
            finished = p >= 1;
        }

        // Engine wake / sigil spray — the flight should look ALIVE.
        const speed = Math.hypot(this.worldX - px, this.worldY - py) / Math.max(dt, 1e-4);
        if (s.embers && speed > 300 && Math.random() < dt * 34) {
            const back = this.angle + Math.PI;
            this._sparks(this.worldX + Math.cos(back) * 55, this.worldY + Math.sin(back) * 55,
                1 + (Math.random() < 0.4 ? 1 : 0), {
                    dir: back, spread: 0.5, color: Math.random() < 0.6 ? this.accent : '#ff8860',
                    speedMin: 60, speedMax: 220, lifeMin: 0.3, lifeMax: 0.7
                });
        }
        if (s.carve && Math.random() < dt * 44) {
            this._sparks(this.worldX, this.worldY, 2, {
                spread: Math.PI * 2, color: Math.random() < 0.5 ? '#ffffff' : RED,
                speedMin: 40, speedMax: 200, lifeMin: 0.4, lifeMax: 0.9
            });
        }
        if (s.trail) {
            const last = s.trail[s.trail.length - 1];
            if (!last || Math.hypot(this.worldX - last.x, this.worldY - last.y) > 26) {
                s.trail.push({ x: this.worldX, y: this.worldY });
            }
        }
        if (finished) {
            const done = s.done;
            this.script = null;
            this.parkX = this.worldX; this.parkY = this.worldY;
            if (done) done(this);
        }
    }

    // Seated in the ring: no ship sits statue-still. Residual momentum bleeds
    // off into the seat (a pilot killing the last of their speed), then a slow
    // menacing breath, the nose tracking the prey, embers dripping off the hull.
    _parkedIdle(dt) {
        if (this.parkX === undefined) { this.parkX = this.worldX; this.parkY = this.worldY; }
        // Settle: leftover velocity carries the anchor a little further and dies.
        this.parkX += this.vx * dt;
        this.parkY += this.vy * dt;
        this.vx *= Math.pow(0.87, dt * 60);
        this.vy *= Math.pow(0.87, dt * 60);
        const t = this._animClock;
        this.worldX = this.parkX + Math.cos(t * 0.8 + this._weavePhase) * 9;
        this.worldY = this.parkY + Math.sin(t * 0.63 + this._weavePhase * 1.7) * 11;
        const c = this.dragon.cin;
        if (c) {
            const want = Math.atan2(c.center.y - this.worldY, c.center.x - this.worldX);
            let da = ((want - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            this.angle += da * Math.min(1, dt * 1.6);
        }
        if (Math.random() < dt * 2.5) {
            this._sparks(this.worldX + (Math.random() - 0.5) * 70, this.worldY + (Math.random() - 0.5) * 70,
                1, { color: this.accent, speedMin: 20, speedMax: 90, lifeMin: 0.4, lifeMax: 1.0 });
        }
    }
}

// ═════════════════════════════════════════════════════════════════════════════
// THE SEVEN HEADS
// ═════════════════════════════════════════════════════════════════════════════

// ── DECEPTION — the father of lies ───────────────────────────────────────────
// THE HALL OF MIRRORS. It never stops attacking — and neither do its clones:
// identical combat copies flying their own patterns and firing real shots.
// Only the true hull bleeds (full damage, no armor tricks) — the defense is
// that you must KNOW which one it is: pop a clone and the real answers with a
// counter-volley; every few seconds the mirrors flicker and the shell game
// re-deals (the real swaps places with a lie); hurt it for a quarter of its
// pool and it shatters the whole hall and re-mirrors fresh. The one honest
// tell: only the REAL hull sheds engine embers. Fakeouts everywhere — feint
// dashes that swerve, vanish-strikes from your blind side, bait lanes of
// mines with a hairpin. Pressure is constant; certainty never is.
export class HeadDeception extends DragonHead {
    constructor(...a) {
        super(...a);
        this.clones = [];            // [{x,y,vx,vy,angle,bearing,fireT,flicker}]
        this.cloaked = false;
        this._cycleTimer = 0.8;      // the real one's trick clock
        this._mirrorT = 5.0;         // shell-game re-deal clock
        this._cloneRespawnT = 0;
        this._dodgeReadyAt = 0;
        this._chunkDamage = 0;
        this.disguised = false;      // legacy flag (base draw checks it)
    }

    _cloneMax() {
        return this.health < this.maxHealth * 0.4 ? 3 : 2;
    }

    // ── the hall ────────────────────────────────────────────────────────
    _spawnClone(nearX, nearY) {
        const a = Math.random() * Math.PI * 2;
        this.clones.push({
            x: (nearX ?? this.worldX) + Math.cos(a) * 260,
            y: (nearY ?? this.worldY) + Math.sin(a) * 260,
            vx: 0, vy: 0, angle: a,
            bearing: Math.random() * Math.PI * 2,
            fireT: 0.8 + Math.random() * 1.2,
            flicker: 0.35
        });
        this._sparks(this.clones[this.clones.length - 1].x, this.clones[this.clones.length - 1].y,
            10, { color: '#8888ff', speedMin: 80, speedMax: 260 });
        this._sfx('click', 0.4);
    }

    // The re-deal: every mirror flickers, and the truth changes places with
    // one of the lies.
    _shuffle(player) {
        if (!this.clones.length) return;
        const state = this.game.currentState;
        if (state && state.cinematics) state.cinematics.deathPop(this);
        for (const c of this.clones) c.flicker = 0.35;
        const pick = this.clones[Math.floor(Math.random() * this.clones.length)];
        const sx = this.worldX, sy = this.worldY;
        const svx = this.vx, svy = this.vy;
        this.worldX = pick.x; this.worldY = pick.y;
        this.vx = pick.vx; this.vy = pick.vy;
        pick.x = sx; pick.y = sy;
        pick.vx = svx; pick.vy = svy;
        this._sfx('teleport', 0.4);
    }

    // ── identity: full damage on the REAL hull; the lies soak nothing ───
    // Avoidance is informational — the chunk gate below is the only brake.
    _onDamaged(dmg) {
        this._chunkDamage += dmg;
        if (this._chunkDamage >= this.maxHealth * 0.25 && this.state === 'fight') {
            this._chunkDamage = 0;
            const state = this.game.currentState;
            if (state && state.spawnFloatingText) {
                state.spawnFloatingText(this.worldX, this.worldY - 60, 'THE HALL SHATTERS', '#8888ff');
            }
            // Shatter the hall: clones burst, it vanishes, and the whole
            // mirror set re-deals around the player a breath later.
            for (const c of this.clones) {
                this._sparks(c.x, c.y, 14, { color: '#8888ff', speedMin: 120, speedMax: 380 });
            }
            this.clones.length = 0;
            this.stunTimer = 0;
            this.attack = { type: 'remirror', timer: 0, dur: 0.9, ownsMove: true };
            this.cloaked = true;
            this.invulnerable = true;
            if (state && state.cinematics) state.cinematics.deathPop(this);
            this._ring({ color: '#8888ff', maxR: 260, dur: 0.5, width: 4 });
            this._sfx('shield_break', 0.7);
            this._sfx('teleport', 0.6);
        }
    }

    // ── the real one's trick clock — it NEVER idles ─────────────────────
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0) return;

        // Keep the hall populated (re-mirrors fade in one by one).
        this._cloneRespawnT -= dt;
        if (this.clones.length < this._cloneMax() && this._cloneRespawnT <= 0) {
            this._cloneRespawnT = 2.2 + Math.random() * 1.2;
            this._spawnClone(tgt.worldX, tgt.worldY);
        }

        // The shell game re-deals on its own clock.
        this._mirrorT -= dt * rate;
        if (this._mirrorT <= 0 && !this.attack) {
            this._mirrorT = 5.5 + Math.random() * 2.5;
            this._shuffle(tgt);
        }

        if (this.attack) return;
        this._cycleTimer -= dt * rate;
        if (this._cycleTimer > 0) return;
        this._cycleTimer = 1.0 + Math.random() * 0.8;
        const diff = this._diff();

        // Never the same lie twice in a row.
        const moves = [
            ['volley', 0.16], ['crossfire', 0.15], ['shardfan', 0.14],
            ['rockets', 0.11], ['ghosts', 0.12], ['vanish', 0.12],
            ['feint', 0.1], ['bait', 0.1]
        ].filter(m => m[0] !== this._lastMove);
        let roll = Math.random() * moves.reduce((s, m) => s + m[1], 0);
        let pick = moves[0][0];
        for (const [k, w] of moves) { roll -= w; if (roll <= 0) { pick = k; break; } }
        this._lastMove = pick;

        if (pick === 'volley') {
            // Backstab volley: hard strafe, homing snapshots the whole way.
            this.attack = { type: 'volley', timer: 0, dur: 1.3, fired: 0, ownsMove: true };
            const side = Math.random() < 0.5 ? 1 : -1;
            const va = angleToTarget + Math.PI / 2 * side;
            this.vx = Math.cos(va) * this.baseSpeed;
            this.vy = Math.sin(va) * this.baseSpeed;
            this._sfx('boost', 0.5);
        } else if (pick === 'crossfire') {
            // MIRROR CROSSFIRE: the whole hall flickers — then every image,
            // true and false, fires a converging fan as one mind.
            this.attack = { type: 'crossfire', timer: 0, dur: 0.45 * this._teleMult(), ownsMove: true };
            for (const c of this.clones) c.flicker = 0.3;
            this._telegraphTick(dt);
            this._sfx('click', 0.7);
        } else if (pick === 'shardfan') {
            // Shard fan: a shotgun spray of fast glass.
            const base = angleToTarget;
            for (let i = 0; i < 9; i++) {
                this._bolt(this.worldX, this.worldY, base + (i / 8 - 0.5) * 1.1,
                    860 + Math.random() * 120, 9 + 2 * diff, 'red_laser_ball', 2.2);
            }
            this._sfx('railgun_shoot', 0.5);
        } else if (pick === 'rockets') {
            // Twin seekers off the wing pods.
            this._fireSideMissiles(tgt, 2, 14 + 3 * diff);
        } else if (pick === 'ghosts') {
            // GHOST TRAP: a dash that sheds three frozen afterimages — and
            // every image you saw detonates a breath later.
            this.attack = { type: 'ghosts', timer: 0, dur: 0.5, shed: 0, ownsMove: true };
            const ga = angleToTarget + (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random() * 0.5);
            this.vx = Math.cos(ga) * 2100; this.vy = Math.sin(ga) * 2100;
            this.angle = ga;
            this._sfx('boost', 0.6);
        } else if (pick === 'vanish') {
            this._startVanishStrike();
        } else if (pick === 'feint') {
            // Feint dash: telegraph one line, cut another.
            this.attack = { type: 'feint', phase: 'windup', timer: 0, dur: 0.5 * this._teleMult(), ownsMove: true };
            this.vx -= Math.cos(this.angle) * 160;
            this.vy -= Math.sin(this.angle) * 160;
        } else {
            // Bait lane: mines behind, hairpin for the eager.
            this.attack = { type: 'bait', timer: 0, dur: 1.5, mines: 0, ownsMove: true };
            this._sfx('boost', 0.5);
        }
    }

    _startVanishStrike() {
        this.cloaked = true;
        this.invulnerable = true;
        this.attack = { type: 'vanish', timer: 0, dur: 0.55, ownsMove: true };
        const state = this.game.currentState;
        if (state && state.cinematics) state.cinematics.deathPop(this);
        this._sfx('teleport', 0.4);
    }

    _endCloak() {
        this.cloaked = false;
        this.invulnerable = false;
        this._sparks(this.worldX, this.worldY, 10, { color: '#8888ff', speedMin: 80, speedMax: 260 });
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();

        if (a.type === 'crossfire') {
            // Hold, shimmering — then the whole hall fires as one.
            this._telegraphTick(dt);
            this.vx *= Math.pow(0.92, dt * 60); this.vy *= Math.pow(0.92, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            if (a.timer >= a.dur) {
                const sources = [{ x: this.worldX, y: this.worldY }, ...this.clones.map(c => ({ x: c.x, y: c.y }))];
                for (const s of sources) {
                    const fa = Math.atan2(player.worldY - s.y, player.worldX - s.x);
                    for (let i = -1; i <= 1; i++) {
                        this._boltFromXY(s.x, s.y, fa + i * 0.14, 760, 11 + 2 * diff);
                    }
                }
                this._ring({ color: '#8888ff', maxR: 200, dur: 0.4, width: 4 });
                this._sfx('railgun_shoot', 0.7);
                this.game.camera.shake(1.2);
                this.attack = null;
            }
            return;
        }

        if (a.type === 'ghosts') {
            // Dash shedding frozen afterimages — each one a delayed bomb.
            this._dashWake(dt);
            this.vx *= Math.pow(0.985, dt * 60); this.vy *= Math.pow(0.985, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer > a.shed * 0.16) {
                a.shed++;
                this.ghostBombs = this.ghostBombs || [];
                if (this.ghostBombs.length < 6) {
                    this.ghostBombs.push({ x: this.worldX, y: this.worldY, t: 0, ang: this.angle });
                    this._sfx('click', 0.3);
                }
            }
            if (a.timer >= a.dur) this.attack = null;
            return;
        }

        if (a.type === 'remirror') {
            // The hall lies broken for a breath — then re-deals around them.
            if (a.timer >= a.dur) {
                const ba = Math.random() * Math.PI * 2;
                this.worldX = player.worldX + Math.cos(ba) * (620 + Math.random() * 220);
                this.worldY = player.worldY + Math.sin(ba) * (620 + Math.random() * 220);
                this.vx = 0; this.vy = 0;
                this._endCloak();
                this.invulnerable = false;
                while (this.clones.length < this._cloneMax()) this._spawnClone(player.worldX, player.worldY);
                this._shuffle(player);   // and you STILL don't know which
                this.attack = null;
            }
            return;
        }

        if (a.type === 'volley') {
            this.vx *= Math.pow(0.99, dt * 60); this.vy *= Math.pow(0.99, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            if (a.timer > a.fired * 0.26) {
                a.fired++;
                const p = this._bolt(this.worldX, this.worldY, this.angle + (Math.random() - 0.5) * 0.1,
                    720, 10 + 2 * diff, 'red_laser_ball', 3.4);
                if (p) { p.target = player; p.turnRate = 1.1; p.homeTimer = 0.4; p.dashSpeed = 1000; }
                this._sfx('laser', 0.3);
            }
            if (a.timer >= a.dur) this.attack = null;
            return;
        }

        if (a.type === 'vanish') {
            const toP = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            let da = ((toP - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            this.angle += Math.max(-this.turnSpeed * 1.5 * dt, Math.min(this.turnSpeed * 1.5 * dt, da));
            this.vx = Math.cos(this.angle) * this.baseSpeed * 1.5;
            this.vy = Math.sin(this.angle) * this.baseSpeed * 1.5;
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer >= a.dur) {
                const behind = Math.atan2(player.vy || 0, player.vx || 0) + Math.PI;
                const bd = Math.hypot(player.vx || 0, player.vy || 0) > 60 ? behind : Math.random() * Math.PI * 2;
                this.worldX = player.worldX + Math.cos(bd) * 400;
                this.worldY = player.worldY + Math.sin(bd) * 400;
                this._endCloak();
                const rake = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                this.angle = rake;
                for (let i = -2; i <= 2; i++) {
                    this._bolt(this.worldX, this.worldY, rake + i * 0.11, 780, 12 + 2 * diff, 'red_laser_ball', 2.6);
                }
                this._ring({ color: this.accent, maxR: 160, dur: 0.35, width: 4 });
                this._sfx('railgun_shoot', 0.6);
                this.vx = Math.cos(rake) * 2600; this.vy = Math.sin(rake) * 2600;
                this.dashHitSet = new Set();
                this.attack = { type: 'exitDash', timer: 0, dur: 0.45, ownsMove: true };
            }
            return;
        }

        if (a.type === 'exitDash') {
            this._dashWake(dt);
            this.vx *= Math.pow(0.982, dt * 60); this.vy *= Math.pow(0.982, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer >= a.dur) {
                this.dashHitSet = null;
                this.attack = null;
            }
            return;
        }

        if (a.type === 'bait') {
            const away = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
            let da = ((away - this.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            this.angle += Math.max(-this.turnSpeed * dt, Math.min(this.turnSpeed * dt, da));
            this.vx = Math.cos(this.angle) * this.baseSpeed * 1.15;
            this.vy = Math.sin(this.angle) * this.baseSpeed * 1.15;
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer > a.mines * 0.35) {
                a.mines++;
                const m = this._bolt(this.worldX, this.worldY, away + (Math.random() - 0.5) * 0.6,
                    60 + Math.random() * 50, 24 + 4 * diff, 'red_laser_ball_big', 9.0);
                if (m) m.isMine = true;
            }
            if (a.timer >= a.dur) {
                const dist = Math.hypot(player.worldX - this.worldX, player.worldY - this.worldY);
                if (dist < 900) {
                    const back = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                    this.angle = back;
                    this.vx = Math.cos(back) * 2800; this.vy = Math.sin(back) * 2800;
                    this.dashHitSet = new Set();
                    this.attack = { type: 'exitDash', timer: 0, dur: 0.6, ownsMove: true };
                    this._ring({ color: this.accent, maxR: 140, dur: 0.3, width: 3 });
                    this._sfx('boost', 0.8);
                } else {
                    this.attack = null;
                }
            }
            return;
        }

        if (a.type === 'feint') {
            if (a.phase === 'windup') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.9, dt * 60); this.vy *= Math.pow(0.9, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                if (a.timer >= a.dur) {
                    a.phase = 'dash'; a.timer = 0; a.dur = 0.9;
                    a.swerved = false;
                    const launch = this.angle + 0.5;
                    this.vx = Math.cos(launch) * 2300;
                    this.vy = Math.sin(launch) * 2300;
                    this.dashHitSet = new Set();
                    this._sfx('boost', 0.6);
                }
            } else {
                if (!a.swerved && a.timer > 0.3) {
                    a.swerved = true;
                    const ang = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                    const v = Math.hypot(this.vx, this.vy);
                    this.vx = Math.cos(ang) * v; this.vy = Math.sin(ang) * v;
                    this._ring({ color: this.accent, maxR: 120, dur: 0.3, width: 3 });
                }
                this._dashWake(dt);
                this.vx *= Math.pow(0.985, dt * 60); this.vy *= Math.pow(0.985, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(this.vy, this.vx);
                if (a.timer >= a.dur) { this.attack = null; this.dashHitSet = null; }
            }
        }
    }

    update(dt, player) {
        super.update(dt, player);
        if (this.state !== 'fight') { this.clones.length = 0; return; }
        const state = this.game.currentState;
        if (!state) return;

        // The sidestep: shots about to land get dodged behind an afterimage.
        if (!this.cloaked && this.stunTimer <= 0 && this._animClock >= this._dodgeReadyAt) {
            for (const proj of state.projectiles) {
                if (!proj.alive || !proj.friendly) continue;
                const dx = proj.worldX - this.worldX, dy = proj.worldY - this.worldY;
                if (dx * dx + dy * dy > 160 * 160) continue;
                const va = Math.atan2(proj.vy || 0, proj.vx || 0);
                const heading = Math.atan2(-dy, -dx);
                let dd = ((va - heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                if (Math.abs(dd) > 0.9 || Math.random() > 0.45) continue;
                this._dodgeReadyAt = this._animClock + 1.0;
                if (state.cinematics) state.cinematics.deathPop(this);
                const side = va + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2;
                this.worldX += Math.cos(side) * 220;
                this.worldY += Math.sin(side) * 220;
                this._sparks(this.worldX, this.worldY, 8, { color: '#8888ff', speedMin: 80, speedMax: 260 });
                this._sfx('click', 0.4);
                break;
            }
        }

        // ── the clones: full combat mirrors ─────────────────────────────
        let write = 0;
        for (const c of this.clones) {
            if (c.flicker > 0) c.flicker -= dt;
            // Compact ship-flight: hold a drifting bearing slot around the
            // player at gun range, nose on target.
            c.bearing += dt * 0.25;
            const sx = player.worldX + Math.cos(c.bearing) * 640;
            const sy = player.worldY + Math.sin(c.bearing) * 640;
            const dx = sx - c.x, dy = sy - c.y;
            const d = Math.hypot(dx, dy) || 1;
            const want = Math.atan2(dy, dx);
            let da = ((want - c.angle + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
            c.angle += Math.max(-this.turnSpeed * dt, Math.min(this.turnSpeed * dt, da));
            const speed = Math.min(this.baseSpeed, d * 1.4);
            c.vx = Math.cos(c.angle) * speed;
            c.vy = Math.sin(c.angle) * speed;
            c.x += c.vx * dt; c.y += c.vy * dt;

            // Clone guns are REAL guns — and they mix their fire too.
            c.fireT -= dt;
            if (c.fireT <= 0 && Math.hypot(player.worldX - c.x, player.worldY - c.y) < 1300) {
                c.fireT = 1.5 + Math.random() * 0.9;
                const fa = Math.atan2(player.worldY - c.y, player.worldX - c.x);
                if (Math.random() < 0.4) {
                    // Snap fan.
                    for (let i = -1; i <= 1; i++) {
                        this._boltFromXY(c.x, c.y, fa + i * 0.16, 780, 8 + 1.5 * this._diff());
                    }
                } else {
                    // Homing snapshot.
                    const p = this._boltFromXY(c.x, c.y, fa + (Math.random() - 0.5) * 0.08, 700, 10 + 2 * this._diff());
                    if (p) { p.target = player; p.turnRate = 0.8; p.homeTimer = 0.35; p.dashSpeed = 950; }
                }
                this.game.sounds.play('laser', { volume: 0.3, x: c.x, y: c.y });
            }

            // Pop on any hit — it was a lie, and the real one answers.
            let popped = false;
            for (const proj of state.projectiles) {
                if (!proj.alive || !proj.friendly) continue;
                if (Math.hypot(proj.worldX - c.x, proj.worldY - c.y) < 95) {
                    proj.alive = false;
                    popped = true;
                    this._sparks(c.x, c.y, 16, { color: '#8888ff', speedMin: 120, speedMax: 380 });
                    this.game.sounds.play('shield_break', { volume: 0.4, x: c.x, y: c.y });
                    const shooter = proj.owner && proj.owner.worldX !== undefined ? proj.owner : player;
                    const ra = Math.atan2(shooter.worldY - this.worldY, shooter.worldX - this.worldX);
                    for (let i = -1; i <= 1; i++) {
                        this._bolt(this.worldX, this.worldY, ra + i * 0.08, 800, 12 + 2 * this._diff());
                    }
                    this._sfx('laser', 0.5);
                    break;
                }
            }
            if (!popped) this.clones[write++] = c;
        }
        this.clones.length = write;

        // Ghost bombs: the afterimages you watched it shed each detonate.
        if (this.ghostBombs && this.ghostBombs.length) {
            const diff = this._diff();
            let gw = 0;
            for (const g of this.ghostBombs) {
                g.t += dt;
                if (g.t >= 0.8) {
                    for (let i = 0; i < 6; i++) {
                        this._boltFromXY(g.x, g.y, (i / 6) * Math.PI * 2 + g.ang, 420, 8 + 2 * diff);
                    }
                    this._sparks(g.x, g.y, 12, { color: '#8888ff', speedMin: 100, speedMax: 320 });
                    this.game.sounds.play('ship_explode', { volume: 0.3, x: g.x, y: g.y });
                    continue;
                }
                this.ghostBombs[gw++] = g;
            }
            this.ghostBombs.length = gw;
        }
    }

    _boltFromXY(x, y, ang, speed, dmg) {
        const state = this.game.currentState;
        if (!state || !state.projectiles) return null;
        const p = new Projectile(this.game, x, y, ang, speed, 'red_laser_ball', this, dmg, 3.2);
        state.projectiles.push(p);
        return p;
    }

    _drawExtras(ctx, camera, screen, ws) {
        // Ghost bombs: frozen afterimages, swelling to detonation.
        if (this.ghostBombs && this.ghostBombs.length) {
            const asset = this.game.assets.get(this.spriteKey);
            if (asset) {
                const img = asset.canvas || asset;
                const scale = ws || this.game.worldScale;
                const w = (asset.width || img.width) * scale;
                const h = (asset.height || img.height) * scale;
                for (const g of this.ghostBombs) {
                    const sx = g.x * camera.wtsScale + camera.wtsOffX;
                    const sy = g.y * camera.wtsScale + camera.wtsOffY;
                    const p = g.t / 0.8;
                    ctx.save();
                    ctx.translate(sx, sy);
                    ctx.rotate(g.ang + Math.PI / 2);
                    ctx.globalCompositeOperation = 'screen';
                    ctx.globalAlpha = 0.25 + 0.45 * p;
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    ctx.restore();
                }
            }
        }
        // The mirrors: pixel-identical, fighting, indistinguishable — except
        // the real hull is the only one shedding engine embers.
        if (this.clones.length) {
            const asset = this.game.assets.get(this.spriteKey);
            if (asset) {
                const img = asset.canvas || asset;
                const scale = ws || this.game.worldScale;
                const w = (asset.width || img.width) * scale;
                const h = (asset.height || img.height) * scale;
                for (const c of this.clones) {
                    const sx = c.x * camera.wtsScale + camera.wtsOffX;
                    const sy = c.y * camera.wtsScale + camera.wtsOffY;
                    ctx.save();
                    ctx.translate(sx, sy);
                    ctx.rotate(c.angle + Math.PI / 2);
                    ctx.globalAlpha = c.flicker > 0 ? 0.4 + 0.5 * Math.random() : 1;
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    ctx.restore();
                }
            }
        }
    }
}

// ── ACCUSATION — the accuser of the brethren ─────────────────────────────────
// THE HUMILIATOR. Not justice — DEGRADATION. It brands you with the MARK so
// the whole dragon can see where to hurt you (5s of dragon-wide homing,
// ending in the DENUNCIATION blast — out-damage it mid-gloat to cut the
// shaming short). It drags you out for display with tethers, hurls your
// failures at you one by one, mocks you with jeering strafe runs, dives on
// you with contemptuous slams, and points the finger — a charged scorn beam,
// by strong preference at whoever is already marked. No immunity gates: it
// hides behind a STONE CURTAIN of gathered rocks (destructible, and spent as
// the stoning's ammunition — throwing them leaves it naked), catches mindless
// sustained fire with the RIPOSTE and returns it, and while you carry its
// mark your shame weakens your shots against it (×0.6 — appeal to shake it).
// Below half health the contempt turns frantic: everything faster, the
// denunciation wider.
export class HeadAccusation extends DragonHead {
    constructor(...a) {
        super(...a);
        this.markCooldown = 5;
        this.verdict = null;    // {x, y, t, telegraphDur, rays} — the denunciation
        this.exhibits = null;   // [{ang, launched}] — your failures, orbiting
        this.stones = [];       // [{ang, hp, spriteKey}] — the curtain
        this._stoneRegatherT = 0.5;
        this._riposte = 0;      // >0 = deflect stance active (seconds left)
        this._recentDmg = 0;
    }

    _stonePos(s) {
        const r = 175;
        const a = s.ang + this._animClock * 1.1;
        return { x: this.worldX + Math.cos(a) * r, y: this.worldY + Math.sin(a) * r };
    }

    _frantic() { return this.health < this.maxHealth * 0.5; }

    static JEERS = ['WEAK', 'PATHETIC', 'UNWORTHY', 'KNEEL'];
    _jeer(x, y) {
        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(x, y - 40,
                HeadAccusation.JEERS[Math.floor(Math.random() * HeadAccusation.JEERS.length)], this.accent);
        }
    }

    // No immunity gates — its defenses are PHYSICAL and in-character:
    //  · the STONE CURTAIN: orbiting gathered rocks that block your shots
    //    (destructible; and the stoning throws its own cover at you, leaving
    //    it naked until it regathers — offense and defense, one resource);
    //  · the RIPOSTE: sustained mindless fire gets caught and thrown back;
    //  · the MARK degrades YOU: the shamed strike weakly (×0.6 while
    //    branded) — its signature is also its armor.
    _damageMult() {
        const d = this.dragon;
        return d.markActive && d.markOwner === this ? 0.6 : 1;
    }

    // Riposte trigger: concentrated fire raises the deflector.
    _onDamaged(dmg) {
        this._recentDmg = (this._recentDmg || 0) + dmg;
        if (this._recentDmg > 90 && this._animClock >= (this._riposteReadyAt || 0)
            && this.state === 'fight' && !this._riposte) {
            this._recentDmg = 0;
            this._riposteReadyAt = this._animClock + 6.0;
            this._riposte = 1.6;    // seconds of "your barrage, returned"
            const state = this.game.currentState;
            if (state && state.spawnFloatingText) {
                state.spawnFloatingText(this.worldX, this.worldY - 60, 'RETURNED TO SENDER', this.accent);
            }
            this._ring({ color: '#ffffff', maxR: 180, dur: 0.4, width: 4 });
            this.game.sounds.play('shield', { volume: 0.6, x: this.worldX, y: this.worldY });
        }
    }

    // ── the repertoire of contempt — never the same insult twice ────────
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0) return;
        const diff = this._diff();
        const inRange = this._inWeaponRange(dist);

        // The pointing finger (Starcore beam plumbing in the base class).
        if (this.isChargingBeam) {
            this.chargeTimer -= dt;
            this.targetAngle = angleToTarget;
            if (this.chargeTimer <= 0) {
                this.isChargingBeam = false;
                this.activeBeams.push({
                    x: this.worldX + Math.cos(this.angle) * 80,
                    y: this.worldY + Math.sin(this.angle) * 80,
                    angle: this.angle, timer: 0.8
                });
                this._sfx('railgun_shoot', 1.0);
                this.game.camera.shake(1.6);
            }
            return;
        }
        if (this.attack) return;

        // The mark is the spine — the brand of shame recharges on its own
        // clock, frantic when it's bleeding.
        this.markCooldown -= dt * rate * (this._frantic() ? 1.7 : 1);
        if (inRange && this.markCooldown <= 0 && !this.dragon.markActive) {
            this.markCooldown = 10 + Math.random() * 4;
            this.attack = { type: 'mark', timer: 0, dur: 0.6 * this._teleMult(), ownsMove: true };
            return;
        }

        this._cycleTimer = (this._cycleTimer ?? 1.0) - dt * rate * (this._frantic() ? 1.3 : 1);
        if (this._cycleTimer > 0) return;
        this._cycleTimer = 1.3 + Math.random() * 0.9;

        const moves = [
            ['scorn', 0.18], ['mockery', 0.18], ['failures', 0.15],
            ['pillory', 0.15], ['stoning', 0.18],
            ['finger', this.dragon.markActive ? 0.34 : 0.14]
        ].filter(m => m[0] !== this._lastMove);
        let roll = Math.random() * moves.reduce((s, m) => s + m[1], 0);
        let pick = moves[0][0];
        for (const [k, w] of moves) { roll -= w; if (roll <= 0) { pick = k; break; } }
        this._lastMove = pick;

        if (pick === 'scorn') {
            // SCORN SLAM: it rears back in disdain — then drives you into the
            // dirt, shockwave and jeering shrapnel.
            this.attack = { type: 'scorn', phase: 'rear', timer: 0, dur: 0.5 * this._teleMult(), ownsMove: true };
            this.vx -= Math.cos(this.angle) * 260;
            this.vy -= Math.sin(this.angle) * 260;
            this._sfx('click', 0.7);
        } else if (pick === 'mockery') {
            // MOCKERY: taunting zigzags — it won't even fly straight at you —
            // with a contemptuous burst on every swerve.
            this.attack = { type: 'mockery', timer: 0, swerves: 3 + (this._frantic() ? 1 : 0), swerveT: 0, side: Math.random() < 0.5 ? 1 : -1, ownsMove: true };
            this._sfx('boost', 0.5);
        } else if (pick === 'failures') {
            // YOUR FAILURES: it dredges them up and hurls them at you one by
            // one — shoot them down before they're thrown.
            this.exhibits = [];
            const n = 5 + (this._frantic() ? 2 : 0);
            for (let i = 0; i < n; i++) this.exhibits.push({ ang: (i / n) * Math.PI * 2, launched: false });
            this.attack = { type: 'failures', timer: 0, dur: 1.2 + n * 0.35, presented: 0, ownsMove: true };
            this._ring({ color: this.accent, maxR: 220, dur: 0.5, width: 4 });
            this._sfx('click', 0.6);
        } else if (pick === 'stoning') {
            // THE STONING: gather in contempt — then every rock in reach is
            // hurled at the accused (and the void supplies more if the field
            // is bare).
            this.attack = { type: 'stoning', timer: 0, dur: 0.6 * this._teleMult(), ownsMove: true };
            this._sfx('click', 0.6);
        } else if (pick === 'pillory') {
            // THE PILLORY: three slow tethers — any that land DRAG you toward
            // it, hauled out for display.
            const base = angleToTarget;
            for (let i = -1; i <= 1; i++) {
                const p = this._bolt(this.worldX, this.worldY, base + i * 0.16,
                    520, 12 + 3 * diff, 'red_laser_ball_big', 3.4);
                if (p) {
                    const head = this;
                    p.onPlayerHit = (state, body) => {
                        const dx = head.worldX - body.worldX, dy = head.worldY - body.worldY;
                        const d = Math.hypot(dx, dy) || 1;
                        if (state._applyKnockback) state._applyKnockback(dx, dy, d, 520, body);
                        if (state.spawnFloatingText) {
                            state.spawnFloatingText(body.worldX, body.worldY - 30, 'EXPOSED', head.accent);
                        }
                    };
                }
            }
            this._sfx('railgun_shoot', 0.5);
        } else {
            // THE POINTING FINGER: a charged scorn beam — aimed, by strong
            // preference, at whoever already wears the mark.
            this.isChargingBeam = true;
            this.chargeTimer = 1.2 * this._teleMult();
            this.game.sounds.play('railgun_target', { volume: 0.8, x: this.worldX, y: this.worldY });
        }
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();

        if (a.type === 'mark') {
            // The brand of shame charges — a deliberate stop, savoring it.
            this._telegraphTick(dt);
            this._shipDrift(dt, player.worldX, player.worldY);
            if (a.timer >= a.dur) {
                this.dragon.applyMark(player, this);
                this.attack = null;
            }
            return;
        }

        if (a.type === 'scorn') {
            if (a.phase === 'rear') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.88, dt * 60); this.vy *= Math.pow(0.88, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                if (a.timer >= a.dur) {
                    a.phase = 'fall'; a.timer = 0; a.dur = 0.5;
                    const lead = 0.15;
                    const ang = Math.atan2(
                        player.worldY + (player.vy || 0) * lead - this.worldY,
                        player.worldX + (player.vx || 0) * lead - this.worldX);
                    this.angle = ang;
                    this.vx = Math.cos(ang) * 2700; this.vy = Math.sin(ang) * 2700;
                    this.dashHitSet = new Set();
                    this._sfx('boost', 0.8);
                }
            } else {
                this._dashWake(dt);
                this.vx *= Math.pow(0.975, dt * 60); this.vy *= Math.pow(0.975, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                if (a.timer >= a.dur) {
                    // Driven into the dirt: shockwave, shrapnel, and a jeer.
                    this.dashHitSet = null;
                    this.vx *= 0.2; this.vy *= 0.2;
                    for (let i = 0; i < 8; i++) {
                        this._bolt(this.worldX, this.worldY, (i / 8) * Math.PI * 2, 460, 10 + 2 * diff, 'red_laser_ball', 2.4);
                    }
                    this._ring({ color: '#ffffff', maxR: 300, dur: 0.5, width: 5 });
                    this._ring({ color: this.accent, maxR: 200, dur: 0.4, width: 4 });
                    this._sfx('ship_explode', 0.7);
                    this.game.camera.shake(2.0);
                    this._jeer(player.worldX, player.worldY);
                    this.attack = null;
                }
            }
            return;
        }

        if (a.type === 'stoning') {
            // Gather trembling with contempt — then it throws ITS OWN CURTAIN
            // at you (plus conjured extras), leaving itself uncovered until
            // the stones regather. Offense IS the defense, spent.
            this._telegraphTick(dt);
            this._shipDrift(dt, player.worldX, player.worldY);
            if (a.timer >= a.dur) {
                const state = this.game.currentState;
                if (state && state.asteroids) {
                    let count = 0;
                    // The curtain flies first.
                    for (const s of this.stones) {
                        const p = this._stonePos(s);
                        const ast = new Asteroid(this.game, p.x, p.y,
                            Math.random() < 0.3 ? 'medium' : 'small', 0, 0);
                        const toP = Math.atan2(player.worldY - p.y, player.worldX - p.x);
                        const speed = 460 + Math.random() * 340;
                        ast.vx = Math.cos(toP) * speed;
                        ast.vy = Math.sin(toP) * speed;
                        ast.highlightRed = true;
                        ast._nearPlayer = true;
                        state.asteroids.push(ast);
                        count++;
                    }
                    this.stones.length = 0;
                    this._stoneRegatherT = 1.8;   // naked until the stones return
                    // A thin curtain is no mercy: conjure extras to a volley of 5.
                    for (let i = count; i < 5; i++) {
                        const ca = Math.random() * Math.PI * 2;
                        const d = 350 + Math.random() * 350;
                        const ax = this.worldX + Math.cos(ca) * d;
                        const ay = this.worldY + Math.sin(ca) * d;
                        const ast = new Asteroid(this.game, ax, ay,
                            Math.random() < 0.35 ? 'medium' : 'small', 0, 0);
                        const toP = Math.atan2(player.worldY - ay, player.worldX - ax);
                        const speed = 440 + Math.random() * 340;
                        ast.vx = Math.cos(toP) * speed;
                        ast.vy = Math.sin(toP) * speed;
                        ast.highlightRed = true;
                        ast._nearPlayer = true;
                        state.asteroids.push(ast);
                    }
                }
                this._ring({ color: this.accent, maxR: 240, dur: 0.5, width: 4 });
                this._sfx('railgun_shoot', 0.6);
                this._sfx('boost', 0.6);
                this.game.camera.shake(1.3);
                this.attack = null;
            }
            return;
        }

        if (a.type === 'mockery') {
            // Zigzag taunting: hard lateral swerves, a burst on each.
            a.swerveT -= dt;
            if (a.swerveT <= 0) {
                if (a.swerves <= 0) { this.attack = null; return; }
                a.swerves--;
                a.swerveT = 0.42;
                a.side = -a.side;
                const toP = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                const va = toP + Math.PI / 2 * a.side;
                this.vx = Math.cos(va) * 1500 + Math.cos(toP) * 350;
                this.vy = Math.sin(va) * 1500 + Math.sin(toP) * 350;
                for (let i = 0; i < 3; i++) {
                    this._bolt(this.worldX, this.worldY, toP + (Math.random() - 0.5) * 0.1,
                        900, 9 + 2 * diff, 'red_laser_ball', 2.4);
                }
                this._sfx('laser', 0.4);
            }
            this.vx *= Math.pow(0.96, dt * 60); this.vy *= Math.pow(0.96, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            return;
        }

        if (a.type === 'failures') {
            // It holds still, gloating, hurling your failures one by one.
            this._shipDrift(dt, player.worldX, player.worldY);
            if (!this.exhibits || !this.exhibits.length) { this.attack = null; return; }
            const remaining = this.exhibits.filter(e => !e.launched);
            if (a.timer > 1.2 + a.presented * 0.35 && remaining.length) {
                a.presented++;
                const ex = remaining[Math.floor(Math.random() * remaining.length)];
                ex.launched = true;
                const px = this.worldX + Math.cos(ex.ang + this._animClock * 1.4) * 150;
                const py = this.worldY + Math.sin(ex.ang + this._animClock * 1.4) * 150;
                const fa = Math.atan2(player.worldY - py, player.worldX - px);
                const p = this._bolt(px, py, fa, 820, 14 + 3 * diff);
                if (p) { p.target = player; p.turnRate = 1.6; p.homeTimer = 0.5; p.dashSpeed = 1100; }
                this._sfx('laser', 0.4);
            }
            if (a.timer >= a.dur) { this.exhibits = null; this.attack = null; }
        }
    }

    // The dragon calls this when a mark it owns expires un-appealed:
    // the DENUNCIATION — public, radial, unmissable.
    deliverVerdict(body) {
        this.verdict = {
            x: body.worldX, y: body.worldY, t: 0, telegraphDur: 0.55 * this._teleMult(),
            rays: this._frantic() ? 6 : 4
        };
        this.game.sounds.play('railgun_shoot', { volume: 0.6, x: body.worldX, y: body.worldY });
    }

    update(dt, player) {
        super.update(dt, player);
        if (this.state === 'shattered' || this.state === 'dead') {
            this.verdict = null; this.exhibits = null;
            this.stones.length = 0; this._riposte = 0; this._recentDmg = 0;
            return;
        }
        const state = this.game.currentState;

        // ── THE STONE CURTAIN — gathered cover that eats your shots ──────
        if (this.state === 'fight') {
            if (this.stones.length < 5) {
                this._stoneRegatherT -= dt;
                if (this._stoneRegatherT <= 0) {
                    this._stoneRegatherT = 1.6;
                    this.stones.push({
                        ang: Math.random() * Math.PI * 2,
                        hp: 24 + 6 * this._diff(),
                        spriteKey: Math.random() < 0.5 ? 'asteroid_small_0' : 'asteroid_small_1',
                        rot: Math.random() * Math.PI * 2,
                        rotSpd: (Math.random() - 0.5) * 3,
                        born: 0
                    });
                }
            }
            if (state && this.stones.length) {
                for (const proj of state.projectiles) {
                    if (!proj.alive || !proj.friendly) continue;
                    for (let i = 0; i < this.stones.length; i++) {
                        const s = this.stones[i];
                        if (s.born < 0.5) continue;   // still materializing
                        const p = this._stonePos(s);
                        if (Math.hypot(proj.worldX - p.x, proj.worldY - p.y) < 34) {
                            proj.alive = false;
                            s.hp -= proj.damage || 10;
                            this._sparks(p.x, p.y, 5, { color: '#aaa49a', speedMin: 60, speedMax: 220 });
                            if (s.hp <= 0) {
                                this.stones.splice(i, 1);
                                this._sparks(p.x, p.y, 14, { color: '#7d786f', spread: Math.PI * 2, speedMin: 80, speedMax: 300 });
                                this.game.sounds.play('asteroid_break', { volume: 0.4, x: p.x, y: p.y });
                            } else {
                                this.game.sounds.play('hit', { volume: 0.3, x: p.x, y: p.y });
                            }
                            break;
                        }
                    }
                }
            }
        }
        for (const s of this.stones) {
            s.born = Math.min(1, s.born + dt * 2.5);
            s.rot += s.rotSpd * dt;
        }

        // ── THE RIPOSTE — your barrage, caught and returned ──────────────
        this._recentDmg = Math.max(0, this._recentDmg - dt * 45);   // trigger needs SUSTAINED fire
        if (this._riposte > 0) {
            this._riposte -= dt;
            if (state) {
                for (const proj of state.projectiles) {
                    if (!proj.alive || !proj.friendly) continue;
                    const d = Math.hypot(proj.worldX - this.worldX, proj.worldY - this.worldY);
                    if (d < 240 && (this._riposteCount || 0) < 12) {
                        proj.alive = false;
                        this._riposteCount = (this._riposteCount || 0) + 1;
                        const back = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                        this._bolt(proj.worldX, proj.worldY, back + (Math.random() - 0.5) * 0.12,
                            760, Math.max(6, Math.round((proj.damage || 10) * 0.6)), 'red_laser_ball', 2.4);
                        this._sparks(proj.worldX, proj.worldY, 4, { color: '#ffffff', speedMin: 60, speedMax: 200 });
                    }
                }
            }
            if (this._riposte <= 0) {
                this._riposteCount = 0;
                if (this.game.sounds) this.game.sounds.play('shield_break', { volume: 0.35, x: this.worldX, y: this.worldY });
            }
        }

        // Your failures can be shot down before they're thrown.
        if (this.exhibits && this.exhibits.length) {
            const state = this.game.currentState;
            if (state) {
                for (const ex of this.exhibits) {
                    if (ex.launched) continue;
                    const px = this.worldX + Math.cos(ex.ang + this._animClock * 1.4) * 150;
                    const py = this.worldY + Math.sin(ex.ang + this._animClock * 1.4) * 150;
                    for (const proj of state.projectiles) {
                        if (!proj.alive || !proj.friendly) continue;
                        if (Math.hypot(proj.worldX - px, proj.worldY - py) < 55) {
                            proj.alive = false;
                            ex.launched = true;   // denied
                            this._sparks(px, py, 10, { color: this.accent, speedMin: 100, speedMax: 300 });
                            this.game.sounds.play('shield_break', { volume: 0.35, x: px, y: py });
                            break;
                        }
                    }
                }
            }
        }

        if (!this.verdict) return;
        const v = this.verdict;
        v.t += dt;
        if (v.t >= v.telegraphDur && !v.fired) {
            v.fired = true;
            const diff = this._diff();
            const L = 900;
            const state = this.game.currentState;
            let landed = false;
            for (const body of this._bodies()) {
                for (let k = 0; k < v.rays; k++) {
                    const ang = k * Math.PI * 2 / v.rays + Math.PI / 4;
                    const x2 = v.x + Math.cos(ang) * L, y2 = v.y + Math.sin(ang) * L;
                    if (segDist(body.worldX, body.worldY, v.x, v.y, x2, y2) < 30 + body.radius) {
                        // The DENUNCIATION lands — dodge the telegraph or pay.
                        this._hurt(body, 42 + 6 * diff, v.x, v.y);
                        landed = true;
                        break;
                    }
                }
            }
            if (landed) this._jeer(v.x, v.y);
            if (state && state.cinematics) {
                state.cinematics.spawnRing(v.x, v.y, { color: RED, maxR: 380, dur: 0.6, width: 6 });
            }
            this.game.camera.shake(2.0);
            this.game.sounds.play('ship_explode', { volume: 0.7, x: v.x, y: v.y });
        }
        if (v.t >= v.telegraphDur + 0.35) this.verdict = null;
    }

    _drawExtras(ctx, camera, screen, ws) {
        const scale = ws || this.game.worldScale;

        // The stone curtain — real rocks, real cover.
        if (this.stones.length) {
            ctx.save();
            for (const s of this.stones) {
                const p = this._stonePos(s);
                const sx = p.x * camera.wtsScale + camera.wtsOffX;
                const sy = p.y * camera.wtsScale + camera.wtsOffY;
                const asset = this.game.assets.get(s.spriteKey);
                ctx.globalAlpha = 0.35 + 0.65 * s.born;
                if (asset) {
                    const img = asset.canvas || asset;
                    const w = (asset.width || img.width) * scale * 0.9 * s.born;
                    const h = (asset.height || img.height) * scale * 0.9 * s.born;
                    ctx.translate(sx, sy);
                    ctx.rotate(s.rot);
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    ctx.rotate(-s.rot);
                    ctx.translate(-sx, -sy);
                } else {
                    ctx.fillStyle = '#7d786f';
                    ctx.beginPath();
                    ctx.arc(sx, sy, 12 * scale * s.born, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        // The riposte stance — a white catch-field flaring around the hull.
        if (this._riposte > 0) {
            const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
            const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = '#ffffff';
            ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this._animClock * 30);
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(sx, sy, 240 * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Your orbiting failures — bright, ugly little trophies.
        if (this.exhibits && this.exhibits.length) {
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            for (const ex of this.exhibits) {
                if (ex.launched) continue;
                const px = this.worldX + Math.cos(ex.ang + this._animClock * 1.4) * 150;
                const py = this.worldY + Math.sin(ex.ang + this._animClock * 1.4) * 150;
                const sx = px * camera.wtsScale + camera.wtsOffX;
                const sy = py * camera.wtsScale + camera.wtsOffY;
                ctx.fillStyle = this.accent;
                ctx.globalAlpha = 0.85;
                ctx.beginPath();
                ctx.arc(sx, sy, 7 * scale, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.globalAlpha = 0.9;
                ctx.beginPath();
                ctx.arc(sx, sy, 3 * scale, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        }

        if (!this.verdict) return;
        const v = this.verdict;
        const cx = v.x * camera.wtsScale + camera.wtsOffX;
        const cy = v.y * camera.wtsScale + camera.wtsOffY;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        if (v.t < v.telegraphDur) {
            // Converging telegraph rings — the crowd is gathering.
            const p = v.t / v.telegraphDur;
            ctx.strokeStyle = RED;
            ctx.globalAlpha = 0.5 + 0.4 * p;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, (1 - p) * 260 * scale + 24 * scale, 0, Math.PI * 2);
            ctx.stroke();
        } else {
            // The rays of denunciation.
            const p = Math.min(1, (v.t - v.telegraphDur) / 0.3);
            ctx.strokeStyle = '#ffffff';
            ctx.globalAlpha = 1 - p;
            ctx.lineWidth = 8 * (1 - p) + 2;
            const L = 900 * scale;
            for (let k = 0; k < v.rays; k++) {
                const ang = k * Math.PI * 2 / v.rays + Math.PI / 4;
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(cx + Math.cos(ang) * L, cy + Math.sin(ang) * L);
                ctx.stroke();
            }
        }
        ctx.restore();
    }
}

// ── MURDER — it was a murderer from the beginning ────────────────────────────
// The executioner. Blink-flanks behind the player, chains slash-dashes that
// leave burning wakes, and frenzies at the smell of blood (pilot below 40%).
export class HeadMurder extends DragonHead {
    constructor(...a) {
        super(...a);
        this.wakes = [];    // [{x1,y1,x2,y2,life}]
        this.frenzy = false;
        this.goreOnContact = true;   // its rams SPRAY (base contact gore branch)
    }

    // Blood palette for every gory beat.
    _blood(x, y, n, fast = false) {
        this._sparks(x, y, n, {
            spread: Math.PI * 2, round: true,
            color: Math.random() < 0.5 ? '#8f1010' : (Math.random() < 0.5 ? '#c01818' : '#5a0606'),
            speedMin: fast ? 120 : 20, speedMax: fast ? 420 : 130,
            lifeMin: 0.6, lifeMax: 1.6
        });
    }

    // Real gore chunks (the kill-streak horror sprites), tumbling with drag —
    // spawned at wound moments: rams, wake burns, the stagger.
    _goreAssets() {
        if (!this._goreList) {
            const list = [];
            for (let i = 0; i < 28; i++) {
                const a = this.game.assets.get(`gore_${String(i).padStart(2, '0')}`);
                if (a) list.push(a);
            }
            this._goreList = list;
        }
        return this._goreList;
    }

    _goreBurst(x, y, n) {
        const assets = this._goreAssets();
        if (!assets || !assets.length) return;
        this.gore = this.gore || [];
        const room = 40 - this.gore.length;
        for (let i = 0; i < Math.min(n, room); i++) {
            const ang = Math.random() * Math.PI * 2;
            const speed = 120 + Math.random() * 260;
            this.gore.push({
                asset: assets[Math.floor(Math.random() * assets.length)],
                x, y,
                vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
                rot: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * 6,
                life: 0, maxLife: 0.9 + Math.random() * 0.7
            });
        }
    }

    // The blink-enemy's space-collapse morph, on every teleport.
    _warpOut(dur) {
        const st = this.game.currentState;
        if (st) st._blinkWarp = { x: this.worldX, y: this.worldY, t: dur, dur, depart: true };
        this.game.sounds.play('teleport', { volume: 0.35, x: this.worldX, y: this.worldY });
        this._blood(this.worldX, this.worldY, 6);
    }

    _warpIn() {
        const st = this.game.currentState;
        if (st) st._blinkWarp = { x: this.worldX, y: this.worldY, t: 0.4, dur: 0.4, depart: false };
        this.game.sounds.play('teleport', { volume: 0.5, x: this.worldX, y: this.worldY });
        this._blood(this.worldX, this.worldY, 8, true);
    }

    // Identity: THE KNIFE IS SLIPPERY — ×0.7 while it hunts, ×1.6 in the
    // stagger after a slash chain lands or misses. Punish the overcommit.
    _damageMult() {
        return this._animClock < (this._staggerUntil || 0) ? 1.6 : 0.7;
    }

    // The knife has no guns — its clock decides WHICH kill comes next, and
    // it never repeats itself. A MONSTER: fast, brutal, nearly unpredictable.
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0 || this.attack) return;
        // Frenzy from YOUR blood or ITS OWN wounds; a dying Murder is a whirlwind.
        const bleeding = this._bodies().some(b => b.health < b.maxHealth * 0.4);
        this.frenzy = bleeding || this.health < this.maxHealth * 0.5;
        this.fullFrenzy = this.health < this.maxHealth * 0.25;
        const speedUp = this.fullFrenzy ? 2.2 : (this.frenzy ? 1.6 : 1);
        this.killTimer = (this.killTimer ?? 1.2) - dt * rate * speedUp;
        if (this.killTimer > 0 || !this._inWeaponRange(dist)) return;
        this.killTimer = 1.1 + Math.random() * 0.6;

        // Weighted pick, never the same kill twice in a row.
        const moves = [
            ['slash', 0.28], ['flurry', 0.2], ['cross', 0.18],
            ['lunge', 0.18], ['cage', 0.16]
        ].filter(m => m[0] !== this._lastMove);
        let roll = Math.random() * moves.reduce((s, m) => s + m[1], 0);
        let pick = moves[0][0];
        for (const [k, w] of moves) { roll -= w; if (roll <= 0) { pick = k; break; } }
        this._lastMove = pick;

        if (pick === 'slash') {
            this._startSlash(tgt, (this.frenzy ? 3 : 2) + (this.fullFrenzy ? 1 : 0));
        } else if (pick === 'flurry') {
            this._startBlink(tgt, (this.frenzy ? 3 : 2) + (this.fullFrenzy ? 1 : 0));
        } else if (pick === 'cross') {
            this.attack = { type: 'cross', phase: 'windup', timer: 0, dur: 0.35 * this._teleMult(), leg: 1, ownsMove: true };
            this.vx -= Math.cos(this.angle) * 200; this.vy -= Math.sin(this.angle) * 200;
        } else if (pick === 'lunge') {
            this.attack = { type: 'lunge', phase: 'aim', timer: 0, dur: 0.32 * this._teleMult(), ownsMove: true };
            this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
        } else {
            this.attack = {
                type: 'cage', phase: 'carve', timer: 0, dur: 1.05, swept: 0, ownsMove: true,
                cageAng: Math.atan2(this.worldY - tgt.worldY, this.worldX - tgt.worldX)
            };
            this._sfx('boost', 0.6);
        }
    }

    _startBlink(tgt, blinks) {
        const behind = Math.atan2(tgt.worldY - this.worldY, tgt.worldX - this.worldX);
        const ba = behind + (Math.random() - 0.5) * 2.4; // any bearing — untrackable
        const d = 480;
        this.attack = {
            type: 'flurry', phase: 'tele', timer: 0, blinks,
            dur: (this.frenzy ? 0.28 : 0.45) * this._teleMult(), ownsMove: true,
            tx: tgt.worldX + Math.cos(ba) * d + (tgt.vx || 0) * 0.3,
            ty: tgt.worldY + Math.sin(ba) * d + (tgt.vy || 0) * 0.3
        };
        this._sfx('click', 0.6);
    }

    _startSlash(player, chain) {
        this.attack = {
            type: 'slash', phase: 'windup', timer: 0,
            dur: (this.frenzy ? 0.26 : 0.4) * this._teleMult(), chain, ownsMove: true
        };
        this.vx -= Math.cos(this.angle) * 220;
        this.vy -= Math.sin(this.angle) * 220;
    }

    _launchDash(player, speed, dur) {
        const a = this.attack;
        const lead = 0.14;
        const ang = Math.atan2(
            player.worldY + (player.vy || 0) * lead - this.worldY,
            player.worldX + (player.vx || 0) * lead - this.worldX);
        this.angle = ang;
        this.vx = Math.cos(ang) * speed; this.vy = Math.sin(ang) * speed;
        this.dashHitSet = new Set();
        a.phase = 'dash'; a.timer = 0; a.dur = dur;
        a.lastWakeX = this.worldX; a.lastWakeY = this.worldY;
        this._sfx('boost', 0.8);
    }

    _dashStep(dt, a, friction = 0.982) {
        this._dashWake(dt);
        // Blood sheds off the blades mid-cut.
        if (Math.random() < dt * 26) {
            this._blood(this.worldX + (Math.random() - 0.5) * 60,
                this.worldY + (Math.random() - 0.5) * 60, 1);
        }
        this.vx *= Math.pow(friction, dt * 60); this.vy *= Math.pow(friction, dt * 60);
        this.worldX += this.vx * dt; this.worldY += this.vy * dt;
        if (!a.lastWakeX || Math.hypot(this.worldX - a.lastWakeX, this.worldY - a.lastWakeY) > 90) {
            this.wakes.push({
                x1: a.lastWakeX || this.worldX, y1: a.lastWakeY || this.worldY,
                x2: this.worldX, y2: this.worldY, life: 2.2
            });
            a.lastWakeX = this.worldX; a.lastWakeY = this.worldY;
        }
    }

    _stagger(t = 0.8) {
        this.attack = null;
        this.dashHitSet = null;
        this._dashBonus = 0;
        this._staggerUntil = this._animClock + t;
        this._shiverAmt = 3;
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;

        if (a.type === 'flurry') {
            // Teleporting kill-storm: blink → micro-slash → blink again.
            if (a.phase === 'tele') {
                if (!a.warped) { a.warped = true; this._warpOut(a.dur); }
                this.vx *= Math.pow(0.9, dt * 60); this.vy *= Math.pow(0.9, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                if (a.timer >= a.dur) {
                    this._ring({ color: RED, maxR: 180, dur: 0.35, width: 4 });
                    const state = this.game.currentState;
                    if (state && state.cinematics) state.cinematics.deathPop(this);
                    this.worldX = a.tx; this.worldY = a.ty;
                    this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                    this._warpIn();
                    this._sparks(this.worldX, this.worldY, 16, { color: RED, speedMin: 120, speedMax: 380 });
                    this._sfx('boost', 0.7);
                    this._launchDash(player, 3000 + (this.frenzy ? 400 : 0), 0.32);
                }
            } else {
                this._dashStep(dt, a);
                if (a.timer >= a.dur) {
                    a.blinks--;
                    this.dashHitSet = null;
                    if (a.blinks > 0) {
                        const ba = Math.random() * Math.PI * 2;
                        a.tx = player.worldX + Math.cos(ba) * 480 + (player.vx || 0) * 0.3;
                        a.ty = player.worldY + Math.sin(ba) * 480 + (player.vy || 0) * 0.3;
                        a.phase = 'tele'; a.timer = 0; a.warped = false;
                        a.dur = 0.22 * this._teleMult();
                        this._sfx('click', 0.5);
                    } else this._stagger();
                }
            }
            return;
        }

        if (a.type === 'slash') {
            if (a.phase === 'windup') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.88, dt * 60); this.vy *= Math.pow(0.88, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                if (a.timer >= a.dur) {
                    // THE FEINT-REVERSAL: sometimes the telegraph is a lie —
                    // it blinks to your far side and the cut comes from behind.
                    if (Math.random() < (this.frenzy ? 0.55 : 0.35)) {
                        const state = this.game.currentState;
                        if (state && state.cinematics) state.cinematics.deathPop(this);
                        this._ring({ color: RED, maxR: 160, dur: 0.3, width: 3 });
                        this._warpOut(0.25);
                        this.worldX = player.worldX * 2 - this.worldX;
                        this.worldY = player.worldY * 2 - this.worldY;
                        this._warpIn();
                        this._sfx('click', 0.8);
                    }
                    this._launchDash(player, 2900 + (this.frenzy ? 500 : 0), 0.55);
                }
            } else {
                this._dashStep(dt, a);
                if (a.timer >= a.dur) {
                    this.dashHitSet = null;
                    if (a.chain > 1) this._startSlash(player, a.chain - 1);
                    else this._stagger(1.0);
                }
            }
            return;
        }

        if (a.type === 'cross') {
            // Two perpendicular cuts in instant succession — an X of fire
            // burned through where you were standing.
            if (a.phase === 'windup') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.88, dt * 60); this.vy *= Math.pow(0.88, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                if (a.timer >= a.dur) this._launchDash(player, 3100, 0.4);
            } else {
                this._dashStep(dt, a);
                if (a.timer >= a.dur) {
                    this.dashHitSet = null;
                    if (a.leg === 1) {
                        a.leg = 2;
                        // Instant 90° re-vector through the player's flank.
                        const back = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                        const ang = back + (Math.random() < 0.5 ? 1 : -1) * Math.PI / 2 + (Math.random() - 0.5) * 0.3;
                        this.angle = ang;
                        this.vx = Math.cos(ang) * 3100; this.vy = Math.sin(ang) * 3100;
                        this.dashHitSet = new Set();
                        a.timer = 0; a.dur = 0.4;
                        a.lastWakeX = this.worldX; a.lastWakeY = this.worldY;
                        this._ring({ color: this.accent, maxR: 130, dur: 0.3, width: 3 });
                        this._sfx('boost', 0.9);
                    } else this._stagger();
                }
            }
            return;
        }

        if (a.type === 'lunge') {
            // The guillotine: a locked targeting line, then a screen-length
            // execution dash that hits like a verdict.
            if (a.phase === 'aim') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.86, dt * 60); this.vy *= Math.pow(0.86, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                const lead = 0.2;
                a.angle = Math.atan2(
                    player.worldY + (player.vy || 0) * lead - this.worldY,
                    player.worldX + (player.vx || 0) * lead - this.worldX);
                this.angle = a.angle;
                if (a.timer >= a.dur) {
                    this._dashBonus = 18;   // the execution hits harder
                    this.angle = a.angle;
                    this.vx = Math.cos(a.angle) * 3400; this.vy = Math.sin(a.angle) * 3400;
                    this.dashHitSet = new Set();
                    a.phase = 'dash'; a.timer = 0; a.dur = 0.75;
                    a.lastWakeX = this.worldX; a.lastWakeY = this.worldY;
                    this._sfx('railgun_shoot', 0.7);
                    this.game.camera.shake(1.2);
                }
            } else {
                this._dashStep(dt, a, 0.988);
                if (a.timer >= a.dur) this._stagger(1.0);
            }
            return;
        }

        if (a.type === 'cage') {
            // Carve a burning circle AROUND the prey — the wakes are the walls.
            // The entry radius BLENDS in from wherever the dash began (no snap).
            if (a.r0 === undefined) {
                a.r0 = Math.max(120, Math.hypot(this.worldX - player.worldX, this.worldY - player.worldY));
            }
            const r = a.r0 + (330 - a.r0) * Math.min(1, a.timer / 0.25);
            a.swept += dt * (Math.PI * 2 / a.dur);
            const ang = a.cageAng + a.swept;
            const nx = player.worldX + Math.cos(ang) * r;
            const ny = player.worldY + Math.sin(ang) * r;
            const mvx = nx - this.worldX, mvy = ny - this.worldY;
            this.angle = Math.atan2(mvy, mvx);
            this.worldX = nx; this.worldY = ny;
            this._dashWake(dt);
            if (!a.lastWakeX || Math.hypot(nx - a.lastWakeX, ny - a.lastWakeY) > 90) {
                this.wakes.push({ x1: a.lastWakeX || nx, y1: a.lastWakeY || ny, x2: nx, y2: ny, life: 2.6 });
                a.lastWakeX = nx; a.lastWakeY = ny;
            }
            if (a.timer >= a.dur) {
                // Exit tangentially at a sane speed — never with the raw
                // orbital velocity (it launched the ship across the map).
                const tang = ang + Math.PI / 2;
                this.vx = Math.cos(tang) * 500;
                this.vy = Math.sin(tang) * 500;
                this._stagger(0.7);
            }
        }
    }

    _drawExtrasMurderAim(ctx, camera) {
        const a = this.attack;
        if (!a || a.type !== 'lunge' || a.phase !== 'aim' || a.angle === undefined) return;
        const x1 = this.worldX * camera.wtsScale + camera.wtsOffX;
        const y1 = this.worldY * camera.wtsScale + camera.wtsOffY;
        const L = 2600 * this.game.worldScale;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = RED;
        ctx.globalAlpha = 0.3 + 0.5 * (a.timer / a.dur);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 + Math.cos(a.angle) * L, y1 + Math.sin(a.angle) * L);
        ctx.stroke();
        ctx.restore();
    }

    update(dt, player) {
        super.update(dt, player);
        // Staggered and bleeding — the wound drips while it's punishable.
        if (this._animClock < (this._staggerUntil || 0) && Math.random() < dt * 14) {
            this._blood(this.worldX + (Math.random() - 0.5) * 80,
                this.worldY + (Math.random() - 0.5) * 80, 1);
        }
        // Gore chunks tumble and settle (kill-streak physics: drag + fade).
        if (this.gore && this.gore.length) {
            let gw = 0;
            for (const p of this.gore) {
                p.life += dt;
                if (p.life >= p.maxLife) continue;
                p.x += p.vx * dt; p.y += p.vy * dt;
                p.vx *= Math.pow(0.93, dt * 60); p.vy *= Math.pow(0.93, dt * 60);
                p.rot += p.rotSpeed * dt;
                this.gore[gw++] = p;
            }
            this.gore.length = gw;
        }
        // Burning wakes: tick, damage crossers (light, with per-body i-frames).
        if (!this.wakes.length) return;
        const diff = this._diff();
        let write = 0;
        for (const w of this.wakes) {
            w.life -= dt;
            if (w.life <= 0) continue;
            this.wakes[write++] = w;
            for (const body of this._bodies()) {
                const cd = this._touchCd.get(body) || 0;
                if (cd > 0) continue;
                if (segDist(body.worldX, body.worldY, w.x1, w.y1, w.x2, w.y2) < 26 + body.radius * 0.5) {
                    this._hurt(body, 14 + 3 * diff, body.worldX, body.worldY);
                    this._touchCd.set(body, 0.8);
                    this._blood(body.worldX, body.worldY, 7, true);
                    this._goreBurst(body.worldX, body.worldY, 3);
                }
            }
        }
        this.wakes.length = write;
    }

    _drawExtras(ctx, camera) {
        this._drawExtrasMurderAim(ctx, camera);
        // Gore chunks ride over the action.
        if (this.gore && this.gore.length) {
            const ws = this.game.worldScale;
            ctx.save();
            for (const p of this.gore) {
                const asset = p.asset;
                const img = asset.canvas || asset;
                const w = (asset.width || img.width) * ws * 0.85;
                const h = (asset.height || img.height) * ws * 0.85;
                const sx = p.x * camera.wtsScale + camera.wtsOffX;
                const sy = p.y * camera.wtsScale + camera.wtsOffY;
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(p.rot);
                ctx.globalAlpha = Math.min(1, (1 - p.life / p.maxLife) * 2.2);
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
            ctx.restore();
        }
    }

    // The burning, bloodied wakes — BENEATH the hull.
    _drawUnder(ctx, camera) {
        if (!this.wakes.length) return;
        // All segments of an age bucket go into ONE path per pass — a single
        // stroke rasterizes once, so shared joints never double-blend into
        // bright additive hotspots (the tiled-beam lesson).
        const buckets = [[], []]; // fresh, fading
        for (const w of this.wakes) buckets[w.life > 1.1 ? 0 : 1].push(w);
        ctx.save();
        ctx.lineCap = 'butt';
        const strokeBucket = (list, color, alpha, width) => {
            if (!list.length) return;
            ctx.strokeStyle = color;
            ctx.globalAlpha = alpha;
            ctx.lineWidth = width;
            ctx.beginPath();
            for (const w of list) {
                ctx.moveTo(w.x1 * camera.wtsScale + camera.wtsOffX, w.y1 * camera.wtsScale + camera.wtsOffY);
                ctx.lineTo(w.x2 * camera.wtsScale + camera.wtsOffX, w.y2 * camera.wtsScale + camera.wtsOffY);
            }
            ctx.stroke();
        };
        const ws = this.game.worldScale;
        // Blood soaks under the fire — a dark arterial base (source-over, so
        // it stays DARK), then the additive burn on top.
        ctx.globalCompositeOperation = 'source-over';
        strokeBucket(buckets[0], '#4a0707', 0.55, 15 * ws);
        strokeBucket(buckets[1], '#320505', 0.4, 11 * ws);
        ctx.globalCompositeOperation = 'lighter';
        strokeBucket(buckets[0], '#ff5a20', 0.5, 10 * ws);
        strokeBucket(buckets[0], '#ffd9a0', 0.65, 3 * ws);
        strokeBucket(buckets[1], '#ff5a20', 0.22, 7 * ws);
        strokeBucket(buckets[1], '#ffd9a0', 0.3, 2.5 * ws);
        ctx.restore();
    }
}

// ── BLASPHEMY — a mouth speaking great things ────────────────────────────────
// Counterfeits the holy: false trumpet blasts of dark gold, fake exp-orb
// clusters that detonate, and a stolen imitation of the Seraph's fire beam.
export class HeadBlasphemy extends DragonHead {
    constructor(...a) {
        super(...a);
        this.fakeOrbs = [];   // [{x,y,t,vx,vy}]
        this.beam = null;     // {angle, t, aimDur, fired}
    }

    // Identity: THE FALSE PROPHET IS ARMORED — ×0.4 while its mouth is shut,
    // ×1.6 while the core is lit (casting or charging the beam). You hit it
    // mid-blasphemy or you barely hit it at all.
    _damageMult() {
        return (this.isChargingBeam || this.attack) ? 1.6 : 0.4;
    }

    // The counterfeiter's clocks, all running while it holds its broadside
    // (the Starcore combat loop): the charged NOSE BEAM (charge 1.4s with a
    // live targeting line, then a tracked mega-beam — the ship must point at
    // you), the false trumpet (a committed stop-and-blast), and counterfeit
    // gifts scattered on the move.
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0) return;
        const diff = this._diff();
        const inRange = this._inWeaponRange(dist);

        // Beam charge (Starcore _startBeamCharge/_updateBeamCharge shape).
        if (this.isChargingBeam) {
            this.chargeTimer -= dt;
            this.targetAngle = angleToTarget;   // track hard while charging
            if (this.chargeTimer <= 0) {
                this.isChargingBeam = false;
                this.activeBeams.push({
                    x: this.worldX + Math.cos(this.angle) * 80,
                    y: this.worldY + Math.sin(this.angle) * 80,
                    angle: this.angle, timer: 0.9
                });
                this._sfx('railgun_shoot', 1.0);
                this.game.camera.shake(1.8);
            }
            return; // one thing at a time while the core is lit
        }
        if (this.attack) return;

        this.beamTimer = (this.beamTimer ?? 4.5) - dt * rate;
        if (inRange && this.beamTimer <= 0) {
            this.beamTimer = 6.5;
            this.isChargingBeam = true;
            this.chargeTimer = 1.4 * this._teleMult();
            this.game.sounds.play('railgun_target', { volume: 0.8, x: this.worldX, y: this.worldY });
            return;
        }

        this.trumpetTimer = (this.trumpetTimer ?? 6.0) - dt * rate;
        if (inRange && this.trumpetTimer <= 0) {
            this.trumpetTimer = 12 + Math.random() * 5;   // a rare, marked event — not a jingle
            this.attack = { type: 'falseTrumpet', timer: 0, dur: 0.7, ownsMove: true };
            return;
        }

        this.giftsTimer = (this.giftsTimer ?? 5.0) - dt * rate;
        if (this.giftsTimer <= 0 && this.fakeOrbs.length < 6) {
            this.giftsTimer = 7.0 + Math.random() * 2.5;
            // Scattered on the move — no stop needed to seed a lie.
            const n = 5;
            for (let i = 0; i < n; i++) {
                const ang = Math.random() * Math.PI * 2;
                const d = 200 + Math.random() * 380;
                this.fakeOrbs.push({
                    x: tgt.worldX + (tgt.vx || 0) * 0.8 + Math.cos(ang) * d,
                    y: tgt.worldY + (tgt.vy || 0) * 0.8 + Math.sin(ang) * d,
                    t: 0
                });
            }
            this._sfx('click', 0.4);
        }
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();
        if (a.type === 'falseTrumpet') {
            // A committed stop: the horned hulk brakes, swells, and blasts.
            this._telegraphTick(dt);
            this.vx *= Math.pow(0.92, dt * 60); this.vy *= Math.pow(0.92, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer >= a.dur) {
                const n = 14 + Math.floor(diff * 2);
                for (let i = 0; i < n; i++) {
                    const ang = (i / n) * Math.PI * 2;
                    this._bolt(this.worldX, this.worldY, ang, 300 + Math.random() * 120,
                        13 + 3 * diff, 'yellow_laser_ball_big', 3.4);
                }
                // A horn gone WRONG: two detuned layers of the same blast,
                // pitched flat against each other — corrupted brass.
                const key = 'trumpet_' + (2 + Math.floor(Math.random() * 2)); // single blasts only
                this.game.sounds.play(key, { volume: 0.45, pitch: 0.78, x: this.worldX, y: this.worldY });
                this.game.sounds.play(key, { volume: 0.3, pitch: 0.73, x: this.worldX, y: this.worldY });
                this._ring({ color: '#a8842a', maxR: 320, dur: 0.7, width: 6 });
                this._ring({ color: '#2a1a08', maxR: 220, dur: 0.5, width: 8 });
                this.game.camera.shake(1.4);
                this.attack = null;
            }
        }
    }

    update(dt, player) {
        super.update(dt, player);
        // Counterfeit gifts: pulse wrong, then detonate (or pop early if touched).
        if (!this.fakeOrbs.length) return;
        const diff = this._diff();
        let write = 0;
        for (const o of this.fakeOrbs) {
            o.t += dt;
            let boom = o.t > 2.6;
            for (const body of this._bodies()) {
                if (Math.hypot(body.worldX - o.x, body.worldY - o.y) < 70) { boom = true; break; }
            }
            if (boom) {
                for (let i = 0; i < 8; i++) {
                    this._bolt(o.x, o.y, (i / 8) * Math.PI * 2, 260, 11 + 2 * diff, 'yellow_laser_ball_big', 1.6);
                }
                const state = this.game.currentState;
                if (state && state.cinematics) state.cinematics.spawnRing(o.x, o.y, { color: '#c9a032', maxR: 130, dur: 0.4, width: 4 });
                this.game.sounds.play('ship_explode', { volume: 0.35, x: o.x, y: o.y });
                continue;
            }
            this.fakeOrbs[write++] = o;
        }
        this.fakeOrbs.length = write;
    }

    _drawExtras(ctx, camera) {
        // (The stolen beam's targeting line + fired strip draw in the base —
        // the same red_laser_beam art the Starcore uses.)
        // Fake orbs — gold, but the pulse flickers dark. That's the tell.
        for (const o of this.fakeOrbs) {
            const sx = o.x * camera.wtsScale + camera.wtsOffX;
            const sy = o.y * camera.wtsScale + camera.wtsOffY;
            const ws = this.game.worldScale;
            const wrong = Math.sin(o.t * 9) < -0.55;   // the dark flicker
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = wrong ? 0.25 : 0.85;
            ctx.fillStyle = wrong ? '#5a3a10' : GOLD;
            ctx.beginPath();
            ctx.arc(sx, sy, (6 + Math.sin(o.t * 5) * 1.5) * ws, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
    }
}

// ── ECONOMIC CONTROL — no one may buy or sell ────────────────────────────────
// The horned hulk. Vacuums loose loot into its holds (released +30% when it
// shatters), crashes the market back out as shrapnel storms, and its shots
// levy a toll — knocking recoverable scrap off the player's hull.
export class HeadEconomicControl extends DragonHead {
    constructor(...a) {
        super(...a);
        this.heavyHull = true;    // its bulk hurts on contact even off-dash
        this.radius = 120;
        this.scrapHeld = 0;
        this.tollTaken = 0;       // fight-lifetime cap so it can't bankrupt
        this.tractorT = 0;
    }

    // Identity: THE VAULT — plated ×0.5 sealed, ×2.0 while the market crash
    // holds its vault doors open. Bait the crash, then burn it down.
    _damageMult() {
        return this._animClock < (this._vaultOpenUntil || 0) ? 2.0 : 0.5;
    }

    // The tank's loop (Asteroid Crusher's tempo): ponderous cruise, heavy
    // facing-gated toll shots on a slow clock, and the market crash as a
    // committed stop — it drops anchor, gathers, and detonates its holdings.
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0 || this.attack) return;
        const diff = this._diff();
        const inRange = this._inWeaponRange(dist);

        this.crashTimer = (this.crashTimer ?? 5.0) - dt * rate;
        if (inRange && this.crashTimer <= 0 && this.scrapHeld >= 12) {
            this.crashTimer = 7.0 + Math.random() * 2.5;
            this.attack = { type: 'crash', phase: 'gather', timer: 0, dur: 0.8, wave: 0, ownsMove: true };
            this._vaultOpenUntil = this._animClock + 4.0;  // doors open — punish window
            return;
        }

        // Toll cannon: one heavy facing-gated slug at a time.
        this.tollTimer = (this.tollTimer ?? 1.4) - dt * rate;
        if (inRange && this.tollTimer <= 0) {
            let angleDiff = angleToTarget - this.angle;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
            if (Math.abs(angleDiff) > 0.45) return; // hold fire until the bow bears
            this.tollTimer = 1.1 + Math.random() * 0.6;
            const p = this._bolt(
                this.worldX + Math.cos(this.angle) * 90, this.worldY + Math.sin(this.angle) * 90,
                this.angle + (Math.random() - 0.5) * 0.06,
                460, 22 + 4 * diff, 'red_laser_ball_big', 3.6);
            this._sfx('railgun_shoot', 0.4);
            if (p) this._armTollShot(p);
        }
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();

        if (a.type === 'crash') {
            if (a.phase === 'gather') this._telegraphTick(dt);
            this.vx *= Math.pow(0.92, dt * 60); this.vy *= Math.pow(0.92, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.phase === 'gather' && a.timer >= a.dur) {
                a.phase = 'storm'; a.timer = 0; a.dur = 1.5; a.wave = 0;
            } else if (a.phase === 'storm') {
                const wavesDue = Math.floor(a.timer / 0.5) + 1;
                while (a.wave < Math.min(3, wavesDue)) {
                    a.wave++;
                    const n = 12 + Math.floor(diff * 2);
                    const off = a.wave * 0.13;
                    for (let i = 0; i < n; i++) {
                        this._bolt(this.worldX, this.worldY, (i / n) * Math.PI * 2 + off,
                            210 + a.wave * 45, 14 + 3 * diff, 'red_laser_ball_big', 4.2);
                    }
                    this.scrapHeld = Math.max(0, this.scrapHeld - 6);
                    this._sfx('railgun_shoot', 0.5);
                    this._ring({ color: this.accent, maxR: 220, dur: 0.5, width: 5 });
                }
                if (a.timer >= a.dur) this.attack = null;
            }
        }
    }

    _armTollShot(p) {
        const head = this;
        p.onPlayerHit = (state, body) => {
            if (head.tollTaken >= 80) return;
            const take = Math.min(8, Math.floor(body.scrap || 0));
            if (take <= 0) return;
            body.scrap -= take;
            head.tollTaken += take;
            // The toll scatters — it can be clawed back.
            for (let i = 0; i < Math.min(4, take); i++) {
                const sa = Math.random() * Math.PI * 2;
                const s = new Scrap(state.game, body.worldX, body.worldY, 'small');
                s.vx = Math.cos(sa) * (220 + Math.random() * 180);
                s.vy = Math.sin(sa) * (220 + Math.random() * 180);
                if (state.scrapEntities.length < 200) state.scrapEntities.push(s);
            }
            if (state.spawnFloatingText) {
                state.spawnFloatingText(body.worldX, body.worldY - 30, `-${take} SCRAP`, '#ffcc44');
            }
        };
    }

    update(dt, player) {
        super.update(dt, player);
        if (this.state !== 'fight' || this.stunTimer > 0) return;
        // The tariff: a slow, wide vacuum on the world's loose wealth.
        const state = this.game.currentState;
        if (!state) return;
        this.tractorT += dt;
        const pullLists = [state.scrapEntities, state.expOrbs];
        for (const list of pullLists) {
            if (!list) continue;
            for (const it of list) {
                if (!it.alive) continue;
                const dx = this.worldX - it.worldX, dy = this.worldY - it.worldY;
                const d2 = dx * dx + dy * dy;
                if (d2 > 900 * 900) continue;
                const d = Math.sqrt(d2) || 1;
                const pull = 320 * (1 - d / 900);
                it.vx = (it.vx || 0) + (dx / d) * pull * dt;
                it.vy = (it.vy || 0) + (dy / d) * pull * dt;
                if (d < this.radius) {
                    it.alive = false;
                    this.scrapHeld += (it.value || 1);
                    this._sparks(this.worldX, this.worldY, 2, { color: '#ffcc44', speedMin: 40, speedMax: 120 });
                }
            }
        }
    }

    _shatter() {
        // The vaults burst open: everything it swallowed, plus interest.
        const payout = Math.floor(this.scrapHeld * 1.3) + this.tollTaken;
        if (payout > 0) {
            this.pendingSpawns = this.pendingSpawns || [];
            const n = Math.min(40, Math.max(6, Math.floor(payout / 3)));
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2;
                const s = new Scrap(this.game, this.worldX, this.worldY, Math.random() < 0.3 ? 'big' : 'small');
                s.vx = Math.cos(a) * (120 + Math.random() * 260);
                s.vy = Math.sin(a) * (120 + Math.random() * 260);
                this.pendingSpawns.push(s);
            }
            this.scrapHeld = 0;
        }
        super._shatter();
    }
}

// ── FALSE WORSHIP — the image that demands adoration ─────────────────────────
// Projects a radiant golden idol near the player: SHOOTING IT HEALS THE HEAD.
// Ignored, it shatters harmlessly. Splits into a mirror procession — two
// counterfeit selves that pop when shot while the true head flinches.
export class HeadFalseWorship extends DragonHead {
    constructor(...a) {
        super(...a);
        this.idol = null;      // {x,y,t,healed}
        this.mirrors = null;   // [{ang, popped}] — offsets around the true body
        this.idolCooldown = 10;
    }

    // Identity: THE SHELL GAME — the true body is harder to wound while its
    // procession stands; pop the counterfeits first.
    _damageMult() {
        return this.mirrors ? 0.6 : 1;
    }

    // The idol's clocks, run from a stately broadside cruise: the golden
    // idol and the mirror procession cast on the move; the halo is a
    // committed stop — the ship becomes the still center of its own shrine.
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0 || this.attack) return;
        const inRange = this._inWeaponRange(dist);

        this.idolCooldown -= dt * rate;
        if (inRange && this.idolCooldown <= 0 && !this.idol && this.role !== 'flank') {
            this.idolCooldown = 13 + Math.random() * 5;
            const ang = Math.random() * Math.PI * 2;
            this.idol = {
                x: tgt.worldX + Math.cos(ang) * 320,
                y: tgt.worldY + Math.sin(ang) * 320,
                t: 0, healed: 0
            };
            this._ring({ color: GOLD, maxR: 200, dur: 0.6, width: 4 });
            this._sfx('click', 0.6);
        }

        this.processionTimer = (this.processionTimer ?? 7.0) - dt * rate;
        if (inRange && this.processionTimer <= 0 && !this.mirrors) {
            this.processionTimer = 12 + Math.random() * 4;
            this.mirrors = [{ ang: Math.PI * 2 / 3, popped: false }, { ang: -Math.PI * 2 / 3, popped: false }];
            this.mirrorsLife = 7.0;
            this.mirrorsVolleyed = false;
            this._ring({ color: GOLD, maxR: 260, dur: 0.5, width: 4 });
            this._sfx('shield', 0.6);
        }

        this.haloTimer = (this.haloTimer ?? 2.5) - dt * rate;
        if (inRange && this.haloTimer <= 0) {
            this.haloTimer = 3.0 + Math.random() * 1.4;
            this.attack = { type: 'halo', timer: 0, dur: 1.2, pulses: 0, ownsMove: true };
        }
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();
        if (a.type !== 'halo') { this.attack = null; return; }
        // Committed stop: brake, radiate two gapped rings, resume the cruise.
        if (a.pulses === 0) this._telegraphTick(dt);
        this.vx *= Math.pow(0.92, dt * 60); this.vy *= Math.pow(0.92, dt * 60);
        this.worldX += this.vx * dt; this.worldY += this.vy * dt;
        const pulsesDue = Math.floor(a.timer / 0.55) + 1;
        while (a.pulses < Math.min(2, pulsesDue)) {
            a.pulses++;
            const n = 18 + Math.floor(diff * 2);
            const gap1 = Math.floor(Math.random() * n);
            const gap2 = (gap1 + Math.floor(n / 2)) % n;
            for (let i = 0; i < n; i++) {
                if (Math.abs(i - gap1) < 2 || Math.abs(i - gap2) < 2) continue; // the way through
                this._bolt(this.worldX, this.worldY, (i / n) * Math.PI * 2 + a.pulses * 0.1,
                    260 + a.pulses * 40, 12 + 2.5 * diff, 'red_laser_ball', 3.6);
            }
            this._ring({ color: this.accent, maxR: 180, dur: 0.4, width: 4 });
            this._sfx('laser', 0.4);
        }
        if (a.timer >= a.dur) this.attack = null;
    }

    _boltFrom(x, y, ang, speed, dmg) {
        const state = this.game.currentState;
        if (!state || !state.projectiles) return;
        state.projectiles.push(new Projectile(this.game, x, y, ang, speed, 'red_laser_ball', this, dmg, 3.4));
    }

    _mirrorPositions() {
        const out = [{ x: this.worldX, y: this.worldY, ang: 0 }];
        if (!this.mirrors) return out;
        for (const m of this.mirrors) {
            if (m.popped) continue;
            const a = this._animClock * 0.9 + m.ang;
            out.push({ x: this.worldX + Math.cos(a) * 240, y: this.worldY + Math.sin(a) * 240, ang: m.ang, m });
        }
        return out;
    }

    update(dt, player) {
        super.update(dt, player);
        if (this.state !== 'fight') { this.idol = null; return; }
        const state = this.game.currentState;
        if (!state) return;

        // The idol: intercepts worship (bullets). Every shot heals the head.
        if (this.idol) {
            const idol = this.idol;
            idol.t += dt;
            for (const proj of state.projectiles) {
                if (!proj.alive || !proj.friendly) continue;
                if (Math.hypot(proj.worldX - idol.x, proj.worldY - idol.y) < 60) {
                    proj.alive = false;
                    const heal = Math.min(this.maxHealth - this.health, proj.damage * 2);
                    this.health += heal;
                    idol.healed += heal;
                    if (state.spawnFloatingText && heal > 0) {
                        state.spawnFloatingText(this.worldX, this.worldY - 40, `+${Math.ceil(heal)}`, '#9a9a9a');
                    }
                    this._sparks(idol.x, idol.y, 6, { color: GOLD, speedMin: 80, speedMax: 260 });
                    this.game.sounds.play('shield', { volume: 0.3, x: idol.x, y: idol.y });
                }
            }
            if (idol.t > 6) {
                // Ignored — the idol crumbles, powerless.
                this._sparks(idol.x, idol.y, 20, { color: GOLD, speedMin: 60, speedMax: 220 });
                if (state.cinematics) state.cinematics.spawnRing(idol.x, idol.y, { color: GOLD, maxR: 140, dur: 0.5, width: 3 });
                this.idol = null;
            }
        }

        // Mirrors: local shots pop the counterfeits harmlessly.
        if (this.mirrors) {
            for (const pos of this._mirrorPositions()) {
                if (!pos.m) continue;
                for (const proj of state.projectiles) {
                    if (!proj.alive || !proj.friendly) continue;
                    if (Math.hypot(proj.worldX - pos.x, proj.worldY - pos.y) < 80) {
                        proj.alive = false;
                        pos.m.popped = true;
                        this._sparks(pos.x, pos.y, 14, { color: GOLD, speedMin: 100, speedMax: 320 });
                        this.game.sounds.play('shield_break', { volume: 0.4, x: pos.x, y: pos.y });
                        break;
                    }
                }
            }
            // Procession lifecycle: one volley from every surviving image
            // mid-parade, then the counterfeits dissolve.
            this.mirrorsLife -= dt;
            if (!this.mirrorsVolleyed && this.mirrorsLife < 4.8) {
                this.mirrorsVolleyed = true;
                const diff = this._diff();
                for (const pos of this._mirrorPositions()) {
                    const n = 10;
                    for (let i = 0; i < n; i++) {
                        this._boltFrom(pos.x, pos.y, (i / n) * Math.PI * 2 + pos.ang, 270, 11 + 2 * diff);
                    }
                }
                this._sfx('railgun_shoot', 0.5);
            }
            if (this.mirrorsLife <= 0 || this.mirrors.every(m => m.popped)) this.mirrors = null;
        }
    }

    _drawExtras(ctx, camera, screen, ws) {
        // The idol — a golden mirror of the head, pulsing a siren glow.
        if (this.idol) {
            const asset = this.game.assets.get(this.spriteKey);
            if (asset) {
                const gold = tintedSprite(asset, this.spriteKey, 'rgba(255,208,80,1)', 4);
                const sx = this.idol.x * camera.wtsScale + camera.wtsOffX;
                const sy = this.idol.y * camera.wtsScale + camera.wtsOffY;
                const s = 0.55 + 0.04 * Math.sin(this.idol.t * 3);
                const w = gold.width * ws * s, h = gold.height * ws * s;
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(Math.sin(this.idol.t * 0.8) * 0.15);
                ctx.globalCompositeOperation = 'lighter';
                ctx.globalAlpha = 0.5 + 0.25 * Math.sin(this.idol.t * 4);
                ctx.drawImage(gold.canvas, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
        }
        // Mirror images — same hull, hollow shimmer.
        if (this.mirrors) {
            const asset = this.game.assets.get(this.spriteKey);
            if (asset) {
                const img = asset.canvas || asset;
                const w = (asset.width || img.width) * ws, h = (asset.height || img.height) * ws;
                for (const pos of this._mirrorPositions()) {
                    if (!pos.m) continue;
                    const sx = pos.x * camera.wtsScale + camera.wtsOffX;
                    const sy = pos.y * camera.wtsScale + camera.wtsOffY;
                    ctx.save();
                    ctx.translate(sx, sy);
                    ctx.rotate(this.angle + Math.PI / 2);
                    ctx.globalAlpha = 0.55 + 0.15 * Math.sin(this._animClock * 6 + pos.ang);
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    ctx.restore();
                }
            }
        }
    }
}

// ── PERSECUTION — it pursued the woman into the wilderness ───────────────────
// Never disengages. Chained wing-blade charges and dragnet fans that press the
// player back toward the pack; its hunter's cry spurs the other heads on.
export class HeadPersecution extends DragonHead {
    constructor(...a) {
        super(...a);
        this.cryCooldown = 14;
    }

    // Identity: SPEED IS ARMOR — ×0.7 at full burn, ×1.6 in the overextension
    // stall at the end of a charge chain. Make it miss, then make it pay.
    _damageMult() {
        if (this.attack && this.attack.type === 'stall') return 1.6;
        return Math.hypot(this.vx, this.vy) > 500 ? 0.7 : 1;
    }

    // The interceptor's loop (Event Horizon's tempo): dragnet fans fired ON
    // THE MOVE from its strafing runs, the chained charge as a committed
    // dash, the hunter's cry as a brief stop-and-howl.
    _updateWeapons(dt, tgt, dist, angleToTarget) {
        const rate = this._weaponRate();
        if (rate <= 0 || this.attack) return;
        const diff = this._diff();
        const inRange = this._inWeaponRange(dist);

        // Dragnet: no stop — the fan sprays mid-flight, denser on the escape
        // side. Herding fire from a ship that never slows down.
        this.dragnetTimer = (this.dragnetTimer ?? 1.6) - dt * rate;
        if (inRange && this.dragnetTimer <= 0) {
            this.dragnetTimer = 1.9 + Math.random() * 1.0;
            const c = this.dragon.packCentroid();
            const escapeA = Math.atan2(tgt.worldY - c.y, tgt.worldX - c.x);
            const toTgt = angleToTarget;
            const n = 11 + Math.floor(diff);
            for (let i = 0; i < n; i++) {
                let off = (i / (n - 1) - 0.5) * 1.7;
                const escRel = ((escapeA - toTgt + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
                off += Math.sign(escRel) * Math.abs(off) * 0.35;
                this._bolt(this.worldX, this.worldY, toTgt + off, 520, 11 + 2.5 * diff, 'red_laser_ball', 3.8);
            }
            this._sfx('railgun_shoot', 0.45);
        }

        this.chargeTimer2 = (this.chargeTimer2 ?? 2.8) - dt * rate;
        if (inRange && this.chargeTimer2 <= 0) {
            this.chargeTimer2 = 3.2 + Math.random() * 1.6;
            this.attack = { type: 'charge', phase: 'windup', timer: 0, dur: 0.45 * this._teleMult(), chain: 1 + Math.floor(Math.random() * 3), ownsMove: true };
            this.vx -= Math.cos(this.angle) * 200;
            this.vy -= Math.sin(this.angle) * 200;
            return;
        }

        this.cryCooldown -= dt * rate;
        if (this.cryCooldown <= 0) {
            this.cryCooldown = 16 + Math.random() * 6;
            this.attack = { type: 'cry', timer: 0, dur: 0.6, ownsMove: true };
        }
    }

    _updateAttack(dt, player) {
        const a = this.attack;
        a.timer += dt;
        const diff = this._diff();

        if (a.type === 'cry') {
            this._telegraphTick(dt);
            this.vx *= Math.pow(0.9, dt * 60); this.vy *= Math.pow(0.9, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer >= a.dur) {
                this.dragon.hunterCry(4.0);
                this._ring({ color: RED, maxR: 520, dur: 0.9, width: 7 });
                this._ring({ color: this.accent, maxR: 320, dur: 0.6, width: 4 });
                this.game.sounds.playKlaxon && this.game.sounds.playKlaxon(0.25);
                this.game.camera.shake(1.2);
                this.attack = null;
            }
            return;
        }

        if (a.type === 'charge') {
            if (a.phase === 'windup') {
                this._telegraphTick(dt);
                this.vx *= Math.pow(0.88, dt * 60); this.vy *= Math.pow(0.88, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                this.angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                if (a.timer >= a.dur) {
                    a.phase = 'dash'; a.timer = 0; a.dur = 0.6;
                    const lead = 0.16;
                    const ang = Math.atan2(
                        player.worldY + (player.vy || 0) * lead - this.worldY,
                        player.worldX + (player.vx || 0) * lead - this.worldX);
                    this.angle = ang;
                    this.vx = Math.cos(ang) * 2900; this.vy = Math.sin(ang) * 2900;
                    this.dashHitSet = new Set();
                    this._sfx('boost', 0.7);
                }
            } else {
                this._dashWake(dt);
                this.vx *= Math.pow(0.983, dt * 60); this.vy *= Math.pow(0.983, dt * 60);
                this.worldX += this.vx * dt; this.worldY += this.vy * dt;
                if (a.timer >= a.dur) {
                    this.dashHitSet = null;
                    if (a.chain > 1) {
                        this.attack = { type: 'charge', phase: 'windup', timer: 0, dur: 0.25 * this._teleMult(), chain: a.chain - 1, ownsMove: true };
                    } else {
                        // Overextended off the last dash: engines sputter,
                        // and for a moment the hunter is the target.
                        this.attack = { type: 'stall', timer: 0, dur: 1.2, ownsMove: true };
                    }
                }
            }
            return;
        }

        if (a.type === 'stall') {
            this._telegraphTick(dt);
            this.vx *= Math.pow(0.9, dt * 60); this.vy *= Math.pow(0.9, dt * 60);
            this.worldX += this.vx * dt; this.worldY += this.vy * dt;
            if (a.timer >= a.dur) this.attack = null;
        }
    }
}

// Murder gets called in when the prey is bleeding; the coordinator uses this.
// (Declared after all heads so the defs table can reference the classes.)
// Per-hull flight envelopes, calibrated against the real bosses (Starcore
// 600/6.0, Event Horizon 900/8.0, Asteroid Crusher 400/7.0): constant-cruise
// speed + turn rate + engagement range + avoidance bubble.
// Capital-ship SPACING: big avoidance bubbles — only the strikers ever come
// truly close, and only on a declared pass. The rest fight from range.
const HEAD_DEFS = [
    // Deception carries an OVERSIZED pool (no armor tricks — the real hull
    // always takes full damage; the mirrors and the chunk gate are its only
    // defense, so the raw pool is where its endurance lives).
    { key: 'deception', cls: HeadDeception, sprite: 'dragon_deception', name: 'DECEPTION', accent: '#ff5a4a', idx: 0, baseSpeed: 700, turnSpeed: 7.0, attackRange: 1100, avoidDist: 340, style: 'striker', hpMult: 1.3 },
    { key: 'accusation', cls: HeadAccusation, sprite: 'dragon_accusation', name: 'ACCUSATION', accent: '#e03838', idx: 1, baseSpeed: 500, turnSpeed: 5.5, attackRange: 1250, avoidDist: 480, style: 'caster' },
    { key: 'murder', cls: HeadMurder, sprite: 'dragon_murder', name: 'MURDER', accent: '#ff2a10', idx: 2, baseSpeed: 800, turnSpeed: 8.0, attackRange: 1000, avoidDist: 300, style: 'striker' },
    { key: 'blasphemy', cls: HeadBlasphemy, sprite: 'dragon_blasphemy', name: 'BLASPHEMY', accent: '#e0a030', idx: 3, baseSpeed: 550, turnSpeed: 6.0, attackRange: 1300, avoidDist: 500, style: 'caster' },
    { key: 'economic_control', cls: HeadEconomicControl, sprite: 'dragon_economic_control', name: 'ECONOMIC CONTROL', accent: '#c04828', idx: 4, baseSpeed: 380, turnSpeed: 6.5, attackRange: 1000, avoidDist: 520, style: 'caster' },
    { key: 'false_worship', cls: HeadFalseWorship, sprite: 'dragon_false_worship', name: 'FALSE WORSHIP', accent: '#e06060', idx: 5, baseSpeed: 520, turnSpeed: 5.5, attackRange: 1200, avoidDist: 470, style: 'caster' },
    { key: 'persecution', cls: HeadPersecution, sprite: 'dragon_persecution', name: 'PERSECUTION', accent: '#d02020', idx: 6, baseSpeed: 780, turnSpeed: 8.0, attackRange: 1050, avoidDist: 320, style: 'striker' },
];

// The five that cut the star, the two that draw the circle.
const STAR_HEADS = [0, 1, 2, 3, 4];
const CIRCLE_HEADS = [5, 6];

export { HEAD_DEFS };

// ═════════════════════════════════════════════════════════════════════════════
// DRAGON — the controller event
// ═════════════════════════════════════════════════════════════════════════════
export class Dragon {
    // SOLO MODE — the per-head development/playtest harness. Summons ONE
    // head as a standalone boss fight (always on duty, no cinematic, no
    // allies/heralds, no reform: its shatter IS the kill). Used by the
    // `boss <head>` dev commands and NOVA_AUTOTEST_HEAD. Each head must be
    // strong alone before the coordinator makes them a dragon.
    static spawnSolo(game, state, key, x, y) {
        const def = HEAD_DEFS.find(d => d.key === key || d.key.startsWith(key));
        if (!def) return null;
        const dragon = new Dragon(game, x, y);
        dragon.soloMode = true;
        dragon.state = DRAGON_STATE.FIGHT;
        dragon.revealed = true;
        dragon.discovered = true;
        const head = new def.cls(game, dragon, def, x, y);
        head.state = 'fight';
        head.invulnerable = false;
        head.role = 'engage';
        const diff = (state && state.difficultyScale) || 1.0;
        head.maxHealth = Math.round((4200 + 1000 * diff) * (def.hpMult || 1));
        head.health = head.maxHealth;
        dragon.heads.push(head);
        state.events.push(dragon);
        state.events.push(head);
        state.dragonEvent = dragon;
        game.sounds.playSpecificMusic('Consuming Dragon');
        return dragon;
    }

    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.siteX = worldX;      // the summoning ground (worldX tracks the pack later)
        this.siteY = worldY;
        this.alive = true;
        this.state = DRAGON_STATE.DORMANT;
        this.radius = 120;        // discovery only
        this.blocksProjectiles = false;
        this.displayName = 'The Dragon';
        this.revealed = false;
        this.discovered = false;
        this.isFinished = false;
        this.isDragon = true;

        this.heads = [];
        this.cin = null;          // cinematic script state
        this.sigil = null;        // {paths:[[{x,y}..]..], alpha, pulse}
        this.barsAlpha = 0;       // HUD head-bars fade

        // Coordinator (sortie system)
        this.roleTimer = 0;
        this.cadenceMult = 1.0;
        this._team = [];           // the current strike pair
        this._retiring = null;     // outgoing pair covering the handoff
        this._retireTimer = 0;
        this._sortieAxis = 0;      // pincer axis for this sortie
        this.cryTimer = 0;
        this.totalReforms = 0;
        this.markActive = false;
        this.markTimer = 0;
        this.markBody = null;
        this.markOwner = null;
        this.markAppeal = 0;

        // Allies
        this.allies = [];         // [{kind:'seraph'|'wheel', ...}]
        this.alliesGranted = 0;   // milestone counter (1=seraph, 2..4=wheels)
        this.heraldTimer = 26;    // first trumpet strike
        this.heraldStrike = null; // {head, t}
        this.fightClock = 0;

        this._victoryT = 0;
        this._starRestoreT = -1;
        this._musicRestoreDelay = 0;
        this._animClock = Math.random() * 10;

        this.pendingSpawns = [];
        this.contentRng = game.rng ? game.rng.deriveEntity('enemies').rng : null;
    }

    // ── event contract ──────────────────────────────────────────────────
    get isActive() {
        return this.state === DRAGON_STATE.CINEMATIC || this.state === DRAGON_STATE.FIGHT;
    }
    hit(damage) { return false; }             // the site itself can't be shot
    freeze() { }
    getSpawnOnDeath() { return []; }
    popSpawns() { const s = this.pendingSpawns; this.pendingSpawns = []; return s; }

    aliveHeads() { return this.heads.filter(h => h.state !== 'shattered'); }
    shatteredHeads() { return this.heads.filter(h => h.state === 'shattered'); }
    packCentroid() {
        let x = 0, y = 0, n = 0;
        for (const h of this.heads) { x += h.worldX; y += h.worldY; n++; }
        return n ? { x: x / n, y: y / n } : { x: this.worldX, y: this.worldY };
    }

    // ── update ──────────────────────────────────────────────────────────
    update(dt, player) {
        this._animClock += dt;
        const state = this.game.currentState;
        if (state && state.dragonEvent !== this) state.dragonEvent = this;

        if (this.state === DRAGON_STATE.FINISHED) {
            this._tickMusicRestore(dt);
            this._tickStarRestore(dt);
            if (this.sigil && this.sigil.alpha > 0.1) this.sigil.alpha = Math.max(0.1, this.sigil.alpha - dt * 0.05);
            return;
        }

        if (this.state === DRAGON_STATE.DORMANT) {
            if (!this.revealed && player &&
                Math.hypot(player.worldX - this.worldX, player.worldY - this.worldY) < 3500) {
                this.revealed = true;
            }
            if (player && Math.hypot(player.worldX - this.worldX, player.worldY - this.worldY) < TRIGGER_RADIUS) {
                this._startCinematic(player);
            }
            return;
        }

        if (this.state === DRAGON_STATE.CINEMATIC) {
            // (The heads update themselves through the events loop.)
            this._updateCinematic(dt, player);
            return;
        }

        if (this.state === DRAGON_STATE.VICTORY) {
            this._updateVictory(dt);
            return;
        }

        // ── FIGHT ──
        this.fightClock += dt;
        this.worldX = this.packCentroid().x;   // keeps spawn-freeze + indicators honest
        this.worldY = this.packCentroid().y;
        this.barsAlpha = Math.min(1, this.barsAlpha + dt * 2);
        if (this.sigil && this.sigil.alpha > 0) this.sigil.alpha = Math.max(0, this.sigil.alpha - dt / 16);
        if (this.sigil && this.sigil.flash > 0) this.sigil.flash = Math.max(0, this.sigil.flash - dt * 1.3);

        if (this.soloMode) {
            // Per-head harness: the lone head is always on duty; no allies,
            // no heralds, no sortie rotation. Its shatter ends the fight.
            this.cadenceMult = 1;
            for (const h of this.heads) if (!h.duelAlly && h.state === 'fight') h.role = 'engage';
            this._updateMark(dt);
            this._tickMusicRestore(dt);
            if (this.heads.length && this.aliveHeads().length === 0) this._startVictory();
            return;
        }

        this._updateCoordinator(dt, player);
        this._updateMark(dt);
        this._updateAllies(dt);
        this._updateHeralds(dt);
        this._tickMusicRestore(dt);

        // Victory: all seven down at once.
        if (this.heads.length === 7 && this.aliveHeads().length === 0) {
            this._startVictory();
        }
    }

    // ── cinematic ───────────────────────────────────────────────────────
    // ~15.6s. The beats: drift to rest under widening sky → seven ships sweep
    // in on banking curves, crisscrossing as they seat the ring → a breath of
    // total stillness → charge-up → the PULSE (music hits HERE, a third of
    // the stars die) → the pentagram is carved through the player's position
    // → the sigil ignites, the fleet scatters through the flash → the name.
    _startCinematic(player) {
        this.state = DRAGON_STATE.CINEMATIC;
        const state = this.game.currentState;
        this.cin = {
            t: 0,
            center: { x: player.worldX, y: player.worldY }, // refined once drifted
            centered: false,
            arrivals: 0, stillness: false, charging: false, pulsed: false,
            culled: false, crossPrepped: false, crossed: false, ignited: false,
            scattered: false, announced: false, released: false,
            // Crisscrossing arrival order + slightly irregular gaps — a fleet,
            // not a metronome.
            schedule: [0, 3, 6, 2, 5, 1, 4].map((slot, i) => ({
                slot, at: 1.8 + i * 0.62 + (i % 2) * 0.09
            }))
        };

        if (state) {
            state.dragonCinematic = true;
            state._dragonFovMult = 1.0; // eased toward CINE_FOV each tick below
            const pilots = state.localPlayers && state.localPlayers.length > 1
                ? state.localPlayers.map(s => s.player).filter(Boolean) : [state.player];
            for (const p of pilots) if (p) p.controlsEnabled = false;
            // Letterbox for the whole arrival — the spectacle owns the frame.
            if (state.cinematics) state.cinematics.letterboxTarget = 1;
        }
        this.game.sounds.stopMusic();
        this.game.camera.rumble && this.game.camera.rumble(0.5);
        if (state && state.triggerFlash) state.triggerFlash(RED, 0.35, 0.1);

        // Lesser creatures know what is coming: every live enemy turns tail
        // and burns away from this place (driven each cinematic frame below).
        // Their shots die with their courage.
        if (state) {
            for (const en of state.enemies) {
                if (!en.alive) continue;
                const fa = Math.atan2(en.worldY - this.cin.center.y, en.worldX - this.cin.center.x)
                    + (Math.random() - 0.5) * 0.5;
                en._dragonFleeAngle = fa;
                en.angle = fa;
            }
            for (const proj of state.projectiles) {
                if (!proj.friendly) proj.alive = false;
            }
        }

        // The heads stage far beyond the ring, one per slot bearing. The
        // seats ARE the sigil's geometry — the five strikers arrive on the
        // pentagon's vertices, the two sweepers on opposite gate points of
        // the same circle — so the carving later launches straight from
        // where everyone already sits. No rearranging.
        this.heads = [];
        for (let i = 0; i < 7; i++) {
            const def = HEAD_DEFS[i];
            const slotA = i < 5
                ? -Math.PI / 2 + (i / 5) * Math.PI * 2          // pentagon vertex
                : Math.PI / 5 + (i - 5) * Math.PI;              // arc gates (36°/216°, clear of vertices)
            const hx = this.cin.center.x + Math.cos(slotA + 0.5) * 3600;
            const hy = this.cin.center.y + Math.sin(slotA + 0.5) * 3600;
            const head = new def.cls(this.game, this, def, hx, hy);
            head.slotAngle = slotA;
            this.heads.push(head);
            if (state) state.events.push(head);
        }
    }

    _updateCinematic(dt, player) {
        const c = this.cin;
        c.t += dt;
        const state = this.game.currentState;

        // The exodus: frozen (no AI, no guns), shoved away at full burn, and
        // silently gone once they're far enough that nobody sees it.
        if (state) {
            for (const en of state.enemies) {
                if (!en.alive || en._dragonFleeAngle === undefined) continue;
                en.freeze(0.3);
                en.worldX += Math.cos(en._dragonFleeAngle) * 1100 * dt;
                en.worldY += Math.sin(en._dragonFleeAngle) * 1100 * dt;
                en.angle = en._dragonFleeAngle;
                const dx = en.worldX - c.center.x, dy = en.worldY - c.center.y;
                if (dx * dx + dy * dy > 4500 * 4500) en.alive = false;
            }
        }

        // FOV: ease out to ~400%. If the player's own FOV is somehow wider,
        // the max() in the state's FOV block leaves it alone.
        if (!c.released) {
            const target = c.t > 0.4 ? CINE_FOV : 1.0;
            state._dragonFovMult = (state._dragonFovMult || 1.0)
                + (target - (state._dragonFovMult || 1.0)) * (1 - Math.exp(-1.6 * dt));
        }

        // 1.6s: the ship has drifted to rest — freeze the circle's center.
        if (!c.centered && c.t >= 1.6) {
            c.centered = true;
            c.center = { x: player.worldX, y: player.worldY };
        }

        // Arrivals: real flight — each ship burns in from deep space, banks
        // onto its bearing and kills its speed into the seat. Crisscross
        // order, a whoosh at entry, a seat-boom on arrival.
        while (c.centered && c.arrivals < 7 && c.t >= c.schedule[c.arrivals].at) {
            const head = this.heads[c.schedule[c.arrivals].slot];
            const sx = c.center.x + Math.cos(head.slotAngle) * CIRCLE_R;
            const sy = c.center.y + Math.sin(head.slotAngle) * CIRCLE_R;
            // Kick sideways momentum in first — the correction toward the seat
            // becomes a visible banking curve, ship by ship a different arc.
            const inA = Math.atan2(sy - head.worldY, sx - head.worldX);
            const side = (c.arrivals % 2 === 0 ? 1 : -1);
            head.vx = Math.cos(inA + 0.9 * side) * 1900;
            head.vy = Math.sin(inA + 0.9 * side) * 1900;
            head.angle = Math.atan2(head.vy, head.vx);
            head.scriptFly(sx, sy, {
                speed: 2500, maxT: 4.2,
                done: (h) => {
                    this.game.camera.shake(0.6);
                    h._sfx('ship_explode', 0.22);
                    h._ring({ color: h.accent, maxR: 150, dur: 0.4, width: 3 });
                }
            });
            head._sfx('boost', 0.85);
            c.arrivals++;
        }

        // ~7.6s: all seated. A breath of absolute stillness — the calm
        // before everything.
        if (!c.stillness && c.arrivals === 7 && c.t >= 7.6) {
            c.stillness = true;
        }

        // 8.4s: the charge — seven hulls swell with light, embers streaming in.
        if (c.stillness && !c.pulsed && c.t >= 8.4) {
            const p = Math.min(1, (c.t - 8.4) / 0.7);
            for (const h of this.heads) {
                h._chargeGlow = p;
                if (Math.random() < dt * 12) {
                    const a = Math.random() * Math.PI * 2, d = 150 + Math.random() * 130;
                    h._sparks(h.worldX + Math.cos(a) * d, h.worldY + Math.sin(a) * d, 2,
                        { dir: a + Math.PI, spread: 0.25, color: RED, speedMin: 260, speedMax: 420, lifeMin: 0.3, lifeMax: 0.55 });
                }
            }
            c.charging = true;
        }

        // 9.1s: THE PULSE — one voice from seven throats. The music lands on
        // this exact beat and scores everything after it.
        if (!c.pulsed && c.t >= 9.1) {
            c.pulsed = true;
            for (const h of this.heads) {
                h._chargeGlow = 0;
                h._ring({ color: '#ffffff', maxR: 260, dur: 0.5, width: 4 });
                h._ring({ color: RED, maxR: 420, dur: 0.9, width: 6 });
                h._sparks(h.worldX, h.worldY, 14, { color: '#ffb0a0', speedMin: 160, speedMax: 520 });
            }
            if (state) {
                if (state.triggerFlash) state.triggerFlash('#ffffff', 0.45, 0.4);
                if (state.cinematics) state.cinematics.spawnRing(c.center.x, c.center.y,
                    { color: RED_DEEP, maxR: CIRCLE_R * 1.35, dur: 1.3, width: 9 });
            }
            this.game.camera.shake(3.0);
            this.game.sounds.play('ship_explode', { volume: 1.0 });
            this.game.sounds.play('shield_break', { volume: 0.7 });
            this.game.sounds.playSpecificMusic('Consuming Dragon');
        }

        // 9.2s → 10.8s: a third of the stars go out — and anything else living
        // in this sector goes out with them.
        if (c.pulsed && c.t >= 9.2) {
            if (!c.culled) {
                c.culled = true;
                this._wipeFieldEnemies();
            }
            const world = state && state.world;
            if (world) {
                const p = Math.min(1, (c.t - 9.2) / 1.6);
                world.starCull = STAR_CULL * easeInOut(p);
            }
        }

        // 11.0s: THE CROSSING — straight off their seats, no repositioning:
        // the five vertex ships burn the star's chords through where the
        // player sits (staggered launches, sparks carving), while the two
        // gate ships carve complementary half-circles around the outside.
        if (!c.crossed && c.t >= 11.0) {
            c.crossed = true;
            this.sigil = { paths: [], alpha: 1, flash: 0, born: this._animClock };
            STAR_HEADS.forEach((hi, k) => {
                const h = this.heads[hi];
                // Pentagram chord: this vertex to the second-next one.
                const toA = -Math.PI / 2 + (((k + 2) % 5) / 5) * Math.PI * 2;
                const path = [];
                this.sigil.paths.push(path);
                h.scriptFly(c.center.x + Math.cos(toA) * CIRCLE_R,
                    c.center.y + Math.sin(toA) * CIRCLE_R,
                    { speed: 2450, brake: false, maxT: 3, trail: path, delay: k * 0.14, launchSfx: true, carve: true });
            });
            CIRCLE_HEADS.forEach((hi, k) => {
                const h = this.heads[hi];
                const path = [];
                this.sigil.paths.push(path);
                // Complementary half-circles: both sweep +π from opposite
                // gates — together they close the full ring.
                const a0 = h.slotAngle;
                h.scriptTo(0, 0, 1.35, {
                    ease: (t) => t, trail: path, embers: true, carve: true,
                    arc: { cx: c.center.x, cy: c.center.y, r: CIRCLE_R, a0, a1: a0 + Math.PI }
                });
                h._sfx('boost', 0.6);
            });
            this.game.camera.shake(1.2);
        }

        // 12.9s: SIGIL IGNITION — the finished pentagram flashes white-hot,
        // and the fleet scatters outward through the blast.
        if (!c.ignited && c.t >= 12.9) {
            c.ignited = true;
            c.scattered = true;
            if (this.sigil) this.sigil.flash = 1;
            if (state) {
                if (state.triggerFlash) state.triggerFlash('#ffffff', 0.5, 0.45);
                if (state.cinematics) {
                    state.cinematics.spawnRing(c.center.x, c.center.y,
                        { color: '#ffffff', maxR: CIRCLE_R * 1.1, dur: 0.9, width: 8 });
                    state.cinematics.spawnRing(c.center.x, c.center.y,
                        { color: RED, maxR: CIRCLE_R * 1.6, dur: 1.4, width: 6 });
                }
            }
            this.game.camera.shake(2.8);
            this.game.sounds.play('ship_explode', { volume: 0.9 });
            for (const h of this.heads) {
                const a = Math.atan2(h.worldY - c.center.y, h.worldX - c.center.x)
                    + (Math.random() - 0.5) * 1.2;
                const d = 950 + Math.random() * 550;
                // Punched outward by the blast, then flown to a loose spread.
                h.vx = Math.cos(a) * (1400 + Math.random() * 600);
                h.vy = Math.sin(a) * (1400 + Math.random() * 600);
                h.scriptFly(c.center.x + Math.cos(a) * d, c.center.y + Math.sin(a) * d,
                    { speed: 2100, maxT: 2.5 });
                h._sfx('boost', 0.45);
            }
        }

        // 13.4s: the name.
        if (!c.announced && c.t >= 13.4) {
            c.announced = true;
            if (state && state.cinematics) {
                state.cinematics.announce('THE DRAGON', 'SEVEN HEADS · ONE MIND', RED);
            }
            this.game.sounds.playKlaxon && this.game.sounds.playKlaxon(0.35);
        }

        // 14.4s: hand it all back — controls, FOV, the fight.
        if (!c.released && c.t >= 14.4) {
            c.released = true;
            this._endCinematic(player);
        }
    }

    // Shader envelope for the arrival (state.getScreenFx during the lock):
    // silence → a rising warp as the charge builds → a spike on the pulse
    // breathing out through the star-death → one last kick at ignition.
    getCinematicFx() {
        const c = this.cin;
        if (!c) return 0;
        const t = c.t;
        if (t < 8.4) return 0;
        if (t < 9.1) return 0.3 * (t - 8.4) / 0.7;
        if (t < 10.9) {
            const s = t - 9.1;
            return 0.5 * Math.exp(-s * 1.7) + 0.14 * (0.5 + 0.5 * Math.sin(s * 5.2));
        }
        if (t < 12.9) return 0.09;
        if (t < 13.8) return 0.35 * (1 - (t - 12.9) / 0.9);
        return 0;
    }

    _endCinematic(player) {
        const state = this.game.currentState;
        if (state) {
            state.dragonCinematic = false;
            state._dragonFovMult = 0;
            const pilots = state.localPlayers && state.localPlayers.length > 1
                ? state.localPlayers.map(s => s.player).filter(Boolean) : [state.player];
            for (const p of pilots) if (p) p.controlsEnabled = true;
            if (state.cinematics) state.cinematics.letterboxTarget = 0;
        }
        this.state = DRAGON_STATE.FIGHT;
        const diff = (state && state.difficultyScale) || 1.0;
        for (const h of this.heads) {
            h.script = null;
            h.state = 'fight';
            h.invulnerable = false;
            // Wheels-class pools (4200 + 1000×diff, linear): each head is a
            // FULL chain boss — the reform halving + the angels are what keep
            // seven of them winnable. (hpMult: heads that spend most of the
            // fight uncatchable — Deception — carry smaller pools.)
            h.maxHealth = Math.round((4200 + 1000 * diff) * (h.def.hpMult || 1));
            h.health = h.maxHealth;
        }
        this._assignRoles(true);
        this.cin = null;
    }

    // Backstop at the pulse: anything that hasn't finished fleeing is gone —
    // silently (they ran; nothing died on screen).
    _wipeFieldEnemies() {
        const state = this.game.currentState;
        if (!state) return;
        for (const en of state.enemies) {
            if (en.alive) en.alive = false;
        }
        for (const proj of state.projectiles) {
            if (!proj.friendly) proj.alive = false;
        }
    }

    // ── coordinator: one organism, seven bodies — the SORTIE system ─────
    // The dragon never bum-rushes. It plans: a strike team of 1-2 heads is
    // dispatched with a purpose (a scripted pairing whose weapon timers are
    // primed to interlock), prosecutes the player while EVERY other head
    // withdraws into deep space, and when the sortie's clock runs out the
    // team breaks off as the next team is already burning in (the super-
    // boost makes the handoff read as a coordinated attack run).
    _updateCoordinator(dt, player) {
        this.cadenceMult = (1 + Math.min(0.6, this.totalReforms * 0.1)) * (this.cryTimer > 0 ? 1.25 : 1);
        if (this.cryTimer > 0) this.cryTimer -= dt;

        this.roleTimer -= dt;
        if (this.roleTimer <= 0) this._planSortie();

        // Relief-in-place: the outgoing pair keeps fighting until the fresh
        // team has burned in, then peels off into the dark.
        if (this._retiring && this._retiring.length) {
            this._retireTimer -= dt;
            if (this._retireTimer <= 0) {
                for (const h of this._retiring) {
                    if (h.role === 'engage' && !h.duelAlly && !this._team.includes(h)) h.role = 'withdrawn';
                }
                this._retiring = null;
            }
        }
    }

    _assignRoles(initial) { this._planSortie(); }

    _planSortie() {
        // Short rotations: attack, back off, swap — keep the player guessing.
        this.roleTimer = 7 + Math.random() * 3;

        // Who's fighting right now — they'll cover the handoff.
        const prevTeam = this.aliveHeads().filter(h => h.role === 'engage' && !h.duelAlly);

        // Dueling heads belong to their angels (already out in space).
        for (const h of this.aliveHeads()) {
            h.role = h.duelAlly ? 'duel' : 'withdrawn';
        }
        this._team = [];
        // Pincer geometry: leader takes the hemisphere ahead of the player's
        // travel, the wing takes the one behind — they bracket, never stack.
        const st = this.game.currentState;
        const pv = st && st.player;
        this._sortieAxis = (pv && Math.hypot(pv.vx || 0, pv.vy || 0) > 60)
            ? Math.atan2(pv.vy, pv.vx)
            : Math.random() * Math.PI * 2;

        const avail = this.aliveHeads().filter(h => !h.duelAlly && h.state === 'fight');
        if (!avail.length) { this._retiring = null; return; }

        // When the pack is thin, everyone left fights.
        if (avail.length <= 2) {
            for (const h of avail) this._dispatch(h);
            return;
        }

        const has = (cls) => avail.find(h => h instanceof cls);
        const state = this.game.currentState;
        const bleeding = state && state.player &&
            state.player.health < state.player.maxHealth * 0.4;

        // The playbook — scripted two-head sorties with interlocking intent.
        const plays = [];
        const pers = has(HeadPersecution), murd = has(HeadMurder),
            blas = has(HeadBlasphemy), dec = has(HeadDeception),
            econ = has(HeadEconomicControl), acc = has(HeadAccusation),
            fw = has(HeadFalseWorship);

        if (pers && murd) plays.push(() => {
            // THE HUNT: Persecution herds with dragnets; Murder takes the kill.
            this._dispatch(pers, () => { pers.dragnetTimer = 0.5; });
            this._dispatch(murd, () => { murd.killTimer = 1.2; });
        });
        if (blas && dec) plays.push(() => {
            // FALSE FANFARE: the liar arrives DISGUISED (it starts far away —
            // the whole approach is the infiltration) under a corrupted horn.
            this._dispatch(dec, () => { dec._cycleTimer = 0; });
            this._dispatch(blas, () => { blas.trumpetTimer = 1.0; });
        });
        if (acc && econ) plays.push(() => {
            // MARKET JUDGMENT: the mark lands as the market crashes.
            this._dispatch(acc, () => { acc.markCooldown = 0.5; });
            this._dispatch(econ, () => {
                econ.scrapHeld = Math.max(econ.scrapHeld, 18);
                econ.crashTimer = 1.5;
            });
        });
        if (fw && blas) plays.push(() => {
            // GOLDEN HOUR: the idol rises under counterfeit gifts.
            this._dispatch(fw, () => { fw.idolCooldown = 0.5; });
            this._dispatch(blas, () => { blas.giftsTimer = 1.0; });
        });
        if (acc && pers) plays.push(() => {
            // SENTENCING: marked, then run down by the interceptor.
            this._dispatch(acc, () => { acc.markCooldown = 0.5; });
            this._dispatch(pers, () => { pers.chargeTimer2 = 1.5; });
        });

        // The finisher doctrine: when the prey bleeds, Murder leads — with
        // whoever herds best.
        if (bleeding && murd) {
            this._dispatch(murd, () => { murd.killTimer = 0.5; });
            const wing = pers || dec || avail.find(h => h !== murd);
            if (wing) this._dispatch(wing);
            return;
        }

        if (plays.length && Math.random() < 0.8) {
            plays[Math.floor(Math.random() * plays.length)]();
        } else {
            // Unscripted sortie: two random heads, still a team.
            const shuffled = avail.slice().sort(() => Math.random() - 0.5);
            this._dispatch(shuffled[0]);
            if (shuffled[1]) this._dispatch(shuffled[1]);
        }

        // Relief-in-place: outgoing attackers not on the new team hold the
        // line for the handoff window.
        this._retiring = prevTeam.filter(h => h.state === 'fight' && !this._team.includes(h));
        for (const h of this._retiring) h.role = 'engage';
        this._retireTimer = 1.5;
    }

    // Send a head on its attack run: role flips to engage (the super-boost
    // burns it in from wherever it withdrew to), it takes its side of the
    // pincer, and its playbook timers are primed.
    _dispatch(head, prime) {
        head.role = 'engage';
        head.moveState = 'idle';
        head.moveTimer = 0;
        head.sortieBearing = this._sortieAxis + (this._team.length === 0 ? 0 : Math.PI);
        this._team.push(head);
        if (prime) prime();
    }

    hunterCry(dur) { this.cryTimer = Math.max(this.cryTimer, dur); }

    // ── the mark (Accusation) ───────────────────────────────────────────
    applyMark(body, owner) {
        this.markActive = true;
        this.markTimer = 5.0;
        this.markBody = body;
        this.markOwner = owner;
        this.markAppeal = 0;
        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(body.worldX, body.worldY - 40, 'MARKED', RED);
        }
        this.game.sounds.playKlaxon && this.game.sounds.playKlaxon(0.3);
    }

    onHeadDamaged(head, damage) {
        if (this.markActive && head === this.markOwner) {
            this.markAppeal += damage;
            // Marked shots land at ×0.6 vs the accuser, so the bar sits lower.
            const need = 95 + 26 * ((this.game.currentState && this.game.currentState.difficultyScale) || 1);
            if (this.markAppeal >= need) {
                // Appeal granted — the verdict dies in the accuser's throat.
                this.markActive = false; this.markTimer = 0;
                head.stun(1.0);
                const state = this.game.currentState;
                if (state && state.spawnFloatingText) {
                    state.spawnFloatingText(head.worldX, head.worldY - 60, 'OVERRULED', '#ffffff');
                }
                this.game.sounds.play('shield_break', { volume: 0.7, x: head.worldX, y: head.worldY });
            }
        }
    }

    _updateMark(dt) {
        if (!this.markActive) return;
        this.markTimer -= dt;
        if (this.markBody && this.markBody.dead) { this.markActive = false; return; }
        if (this.markTimer <= 0) {
            this.markActive = false;
            if (this.markOwner && this.markOwner.state === 'fight' && this.markBody) {
                this.markOwner.deliverVerdict(this.markBody);
            }
        }
    }

    // ── shatter/reform bookkeeping ──────────────────────────────────────
    onHeadShattered(head) {
        // Heaven keeps count: the first falls → the Seraph; more → the Wheels.
        // No reinforcements once the last head is down — that shatter is the
        // victory, not a summons.
        this._shatterEvents = (this._shatterEvents || 0) + 1;
        const anyStanding = this.heads.some(h => h.state === 'fight');
        while (anyStanding && this.alliesGranted < Math.min(4, this._shatterEvents)) {
            this.alliesGranted++;
            if (this.alliesGranted === 1) this._summonAlly('seraph');
            else this._summonAlly('wheel');
        }
        if (head.duelAlly) { head.duelAlly.target = null; head.duelAlly = null; }
    }

    onHeadReformed(head) {
        this.totalReforms++;
        this._assignRoles(false);
    }

    // ── allies: the angels take the field — THE REAL ONES ───────────────
    // Not effigies: actual `Seraph` / `Wheels` instances in ally mode. Their
    // full AI, animations and attacks run unchanged — the head they duel is
    // simply handed to them as the "player" and their damage lands on it
    // (`_bodies`/`_hurt` ally branches in seraph.js/wheels.js).
    _summonAlly(kind) {
        const c = this.packCentroid();
        const a = Math.random() * Math.PI * 2;
        const x = c.x + Math.cos(a) * 3200, y = c.y + Math.sin(a) * 3200;
        const ally = kind === 'seraph' ? new Seraph(this.game, x, y) : new Wheels(this.game, x, y);
        ally.allyMode = true;
        ally.allyTarget = null;
        ally.revealed = true;
        ally.discovered = true;
        ally._startFight();     // straight to FIGHT — the summons IS the arrival
        this.allies.push(ally);
        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#fff6d8', 0.5, 0.25);
            if (state.cinematics) state.cinematics.spawnRing(x, y, { color: GOLD, maxR: 420, dur: 1.0, width: 6 });
            if (state.spawnFloatingText) {
                state.spawnFloatingText(x, y, kind === 'seraph' ? 'THE SERAPH ANSWERS' : 'THE WHEELS TURN', GOLD);
            }
        }
        const burst = 1 + Math.floor(Math.random() * 4);
        this.game.sounds.play('trumpet_' + burst, { volume: 0.6, x, y });
    }

    _updateAllies(dt) {
        const state = this.game.currentState;
        for (const ally of this.allies) {
            // Re-target: the healthiest head not already dueled.
            if (!ally.allyTarget || !ally.allyTarget.alive || ally.allyTarget.state !== 'fight'
                || ally.allyTarget.duelAlly !== ally) {
                if (ally.allyTarget && ally.allyTarget.duelAlly === ally) ally.allyTarget.duelAlly = null;
                ally.allyTarget = null;
                const free = this.aliveHeads().filter(h => !h.duelAlly && h.state === 'fight');
                if (free.length) {
                    free.sort((a, b) => b.health - a.health);
                    ally.allyTarget = free[0];
                    free[0].duelAlly = ally;
                    free[0].role = 'duel';
                }
            }
            // The duel head IS this angel's "player" — the whole boss AI
            // (orbits, screen-springs, charges, beams, storms) chases it.
            const cen = this.packCentroid();
            const tgt = ally.allyTarget
                || { worldX: cen.x, worldY: cen.y, vx: 0, vy: 0, radius: 100 };
            ally.update(dt, tgt);
            // The Seraph conjures/flings asteroids in its crush — those are
            // real world spawns, routed through the controller.
            if (ally.popSpawns) {
                for (const s of ally.popSpawns()) this.pendingSpawns.push(s);
            }
        }

        // Angelic fire never burns the faithful — ally projectiles are marked
        // friendly and collided against the dragon's hulls by hand (the
        // engine's loops only pair enemy shots with players).
        if (state && this.allies.length) {
            for (const proj of state.projectiles) {
                if (!proj.alive || !proj.owner || !proj.owner.allyMode) continue;
                proj.friendly = true;
                for (const h of this.heads) {
                    if (h.state !== 'fight' || h.invulnerable) continue;
                    const dx = proj.worldX - h.worldX, dy = proj.worldY - h.worldY;
                    const cr = h.radius + (proj.radius || 8);
                    if (dx * dx + dy * dy < cr * cr) {
                        proj.alive = false;
                        h.hit(proj.damage);
                        break;
                    }
                }
            }
        }
    }

    // ── heralds: golden light on the healthiest heads ───────────────────
    _updateHeralds(dt) {
        if (this.fightClock < 24) return;
        this.heraldTimer -= dt;
        if (this.heraldTimer <= 0 && !this.heraldStrike) {
            const targets = this.aliveHeads().filter(h => h.state === 'fight');
            if (!targets.length) { this.heraldTimer = 6; return; }
            targets.sort((a, b) => b.health - a.health);
            const head = targets[0];
            this.heraldTimer = 32 + Math.random() * 8;   // the true horns stay rare
            this.heraldStrike = { head, t: 0 };
            head.stun(0.9); // hold still for the judgment of heaven
            const state = this.game.currentState;
            if (state && state.cinematics && state.cinematics.trumpetFanfare) {
                state.cinematics.trumpetFanfare(head.worldX, head.worldY);
            }
        }
        if (this.heraldStrike) {
            const hs = this.heraldStrike;
            hs.t += dt;
            if (hs.t >= 0.85 && !hs.fired) {
                hs.fired = true;
                const head = hs.head;
                if (head.state === 'fight') {
                    const dmg = Math.min(260, head.maxHealth * 0.10);
                    head.hit(dmg);
                    const state = this.game.currentState;
                    if (state) {
                        if (state.triggerFlash) state.triggerFlash('#fff6d8', 0.3, 0.18);
                        if (state.cinematics) {
                            state.cinematics.spawnRing(head.worldX, head.worldY, { color: GOLD, maxR: 320, dur: 0.7, width: 6 });
                        }
                        if (state._spawnSparks) {
                            state._spawnSparks(head.worldX, head.worldY, 22, { color: '#ffee99', speedMin: 140, speedMax: 520 });
                        }
                    }
                    this.game.camera.shake(1.4);
                }
            }
            if (hs.t >= 2.2) this.heraldStrike = null;
        }
    }

    // ── victory ─────────────────────────────────────────────────────────
    _startVictory() {
        this.state = DRAGON_STATE.VICTORY;
        this._victoryT = 0;
        this._trumpets = 0;
        const state = this.game.currentState;
        this.game.sounds.stopMusic();
        if (state && state.triggerFlash) state.triggerFlash('#ffffff', 1.2, 0.55);
        this.game.camera.shake(4.0);
        this.game.sounds.play('ship_explode', { volume: 1.0 });

        // Every wreck detonates outward for good — no reforming from this.
        for (const h of this.heads) {
            h.state = 'dead';           // the controller owns the shards now
            if (!h.shards) continue;
            for (const s of h.shards) {
                const a = Math.atan2(s.wy - h._shatterY, s.wx - h._shatterX);
                s.vx = Math.cos(a) * (300 + Math.random() * 400);
                s.vy = Math.sin(a) * (300 + Math.random() * 400);
                s.dying = true;
            }
            // The hoard: each head pays out Seraph-tier loot at its grave.
            this._headLoot(h);
        }

        // Stars: what the dragon devoured, the sky gets back. (A solo
        // harness head never culled them — nothing to restore.)
        this._starRestoreT = this.soloMode ? -1 : 0;
    }

    _headLoot(h) {
        const rng = h.contentRng || this.contentRng;
        if (!rng) return;
        this.pendingSpawns = this.pendingSpawns || [];
        for (let i = 0; i < 14; i++) {
            const a = rng.next() * Math.PI * 2;
            const s = new Scrap(this.game, h._shatterX + Math.cos(a) * 60, h._shatterY + Math.sin(a) * 60,
                rng.next() < 0.4 ? 'big' : 'small');
            s.vx = Math.cos(a) * (100 + rng.next() * 240);
            s.vy = Math.sin(a) * (100 + rng.next() * 240);
            this.pendingSpawns.push(s);
        }
        for (let i = 0; i < 6; i++) {
            const a = rng.next() * Math.PI * 2;
            this.pendingSpawns.push(new ExpOrb(this.game,
                h._shatterX + Math.cos(a) * 90, h._shatterY + Math.sin(a) * 90, 1));
        }
        // One good upgrade per head, seeded.
        const pool = UPGRADES.filter(u => !u.consumable && (u.rarity === 'rare' || u.rarity === 'uncommon'));
        if (pool.length) {
            const up = pool[Math.floor(rng.next() * pool.length)];
            this.pendingSpawns.push(new ItemPickup(this.game, h._shatterX, h._shatterY, up));
        }
    }

    _updateVictory(dt) {
        this._victoryT += dt;
        this._tickStarRestore(dt);
        this._updateAllies(dt);   // the angels stay alive over the wreckage

        // Shards fly out and fade.
        for (const h of this.heads) {
            if (!h.shards) continue;
            for (const s of h.shards) {
                s.wx += s.vx * dt; s.wy += s.vy * dt;
                s.vx *= Math.pow(0.98, dt * 60); s.vy *= Math.pow(0.98, dt * 60);
                s.rot += s.spin * dt;
            }
        }

        // One trumpet per fallen head, in slow procession (seven in the full
        // fight; one in a solo harness kill).
        const due = Math.min(this.heads.length, Math.floor(this._victoryT / 0.5));
        const state = this.game.currentState;
        while (this._trumpets < due) {
            const h = this.heads[this._trumpets];
            this._trumpets++;
            if (h && state && state.cinematics && state.cinematics.trumpetFanfare) {
                state.cinematics.trumpetFanfare(h._shatterX, h._shatterY);
            }
        }

        if (this._victoryT >= 6.0 && !this._wrapped) {
            this._wrapped = true;
            this._finish();
        }
    }

    _finish() {
        const state = this.game.currentState;
        this.state = DRAGON_STATE.FINISHED;
        this.isFinished = true;
        // alive stays true forever — the sigil scar is the "dragon beaten"
        // marker (and the save-inference flag, like the Hive and Carcosa).
        this.worldX = this.siteX;
        this.worldY = this.siteY;

        // The wrecks REMAIN: every head's splinters become long-lived, never-
        // fading debris — a field of broken crowns around the site.
        for (const h of this.heads) {
            if (h.shards) {
                let kept = 0;
                for (const s of h.shards) {
                    if (kept >= 30) break; // rubble cap headroom (7 heads share ~250)
                    kept++;
                    this.pendingSpawns.push(new ProceduralDebris(
                        this.game, s.wx, s.wy, { canvas: s.canvas },
                        s.vx * 0.2, s.vy * 0.2, s.rot, s.spin * 0.3,
                        90 + Math.random() * 60, true /* noFade */));
                }
            }
            h.alive = false;   // compacted out of events
        }
        // The angels ascend — a flash of gold each, and they are gone.
        for (const ally of this.allies) {
            if (ally.allyTarget) ally.allyTarget.duelAlly = null;
            if (state && state.cinematics) {
                state.cinematics.spawnRing(ally.worldX, ally.worldY, { color: GOLD, maxR: 300, dur: 0.8, width: 5 });
            }
            if (state && state._spawnSparks) {
                state._spawnSparks(ally.worldX, ally.worldY, 20, { color: '#ffee99', speedMin: 120, speedMax: 480 });
            }
        }
        this.allies = [];
        this.barsAlpha = 0;
        this.heraldStrike = null;
        this.markActive = false;

        if (state) {
            // The glow has nothing left to point at. It burns yellow again,
            // aimed home — the run is complete. (Solo harness kills leave the
            // real chain's glow alone.)
            if (!this.soloMode) {
                const pilots = state.localPlayers && state.localPlayers.length > 1
                    ? state.localPlayers.map(s => s.player).filter(Boolean) : [state.player];
                for (const p of pilots) {
                    if (p && p.hasYellowGlow) {
                        p.glowRed = false;
                        p.yellowGlowTarget = { x: 0, y: 0 };
                    }
                }
            }
            // Caches crash-land at the site (Carcosa's tribute pattern) —
            // three for the true fight, one for a solo harness kill.
            if (state.caches && state.cacheSpawner) {
                const rand = () => this.game.rng ? this.game.rng.caches.next() : Math.random();
                for (let i = 0; i < (this.soloMode ? 1 : 3); i++) {
                    const ang = (i / 3) * Math.PI * 2 + rand() * 1.5;
                    const dist = 320 + rand() * 260;
                    const cache = state.cacheSpawner.spawnCrash(
                        this.siteX + Math.cos(ang) * dist, this.siteY + Math.sin(ang) * dist);
                    cache.startCrashLanding(0, 0, {
                        angle: rand() * Math.PI * 2,
                        tx: this.siteX + Math.cos(ang) * dist,
                        ty: this.siteY + Math.sin(ang) * dist
                    });
                    state.caches.push(cache);
                    if (state.netSync && state.netSync.isHost) state.netSync.registerCache(cache);
                }
            }
        }
        if (this.game.achievements) {
            this.game.achievements.notify('boss_defeated', { bossId: 'Dragon' });
        }
        // Let the trumpets ring alone, then the music comes home.
        this._musicRestoreDelay = 2.5;
    }

    _tickMusicRestore(dt) {
        if (this._musicRestoreDelay <= 0) return;
        this._musicRestoreDelay -= dt;
        if (this._musicRestoreDelay > 0) return;
        const state = this.game.currentState;
        if (state && state.musicCombatTriggered) {
            this.game.sounds.setTargetState(MUSIC_STATE.COMBAT, true, true);
        } else {
            this.game.sounds.restoreMusic(true);
        }
    }

    _tickStarRestore(dt) {
        if (this._starRestoreT < 0) return;
        this._starRestoreT += dt;
        const state = this.game.currentState;
        const world = state && state.world;
        if (world) {
            const p = Math.min(1, this._starRestoreT / 4.5);
            world.starCull = STAR_CULL * (1 - easeInOut(p));
            if (p >= 1) this._starRestoreT = -1;
        }
    }

    // ── drawing ─────────────────────────────────────────────────────────
    draw(ctx, camera) {
        // The sigil — the pentagram the heads burned into space.
        if (this.sigil && this.sigil.alpha > 0.01) this._drawSigil(ctx, camera);

        if (this.state === DRAGON_STATE.DORMANT) { this._drawSite(ctx, camera); return; }

        // Mark brand over the condemned pilot.
        if (this.markActive && this.markBody && !this.markBody.dead) {
            const b = this.markBody;
            const sx = b.worldX * camera.wtsScale + camera.wtsOffX;
            const sy = b.worldY * camera.wtsScale + camera.wtsOffY;
            const ws = this.game.worldScale;
            const p = this.markTimer / 5.0;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = RED;
            ctx.globalAlpha = 0.5 + 0.3 * Math.sin(this._animClock * 10);
            ctx.lineWidth = 2;
            const r = (34 + 8 * Math.sin(this._animClock * 6)) * ws;
            ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
            for (let k = 0; k < 4; k++) {
                const a = k * Math.PI / 2 + this._animClock * 1.5;
                ctx.beginPath();
                ctx.moveTo(sx + Math.cos(a) * r * 0.7, sy + Math.sin(a) * r * 0.7);
                ctx.lineTo(sx + Math.cos(a) * r * 1.3, sy + Math.sin(a) * r * 1.3);
                ctx.stroke();
            }
            // The clock runs out visibly.
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.arc(sx, sy, r * 1.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - p));
            ctx.stroke();
            ctx.restore();
        }

        // The angels draw themselves — full Seraph/Wheels rendering.
        for (const ally of this.allies) ally.draw(ctx, camera);

        // Herald column of light.
        if (this.heraldStrike && this.heraldStrike.fired && this.heraldStrike.t < 1.6) {
            const hs = this.heraldStrike;
            const p = 1 - (hs.t - 0.85) / 0.75;
            const sx = hs.head._shatterX !== undefined && hs.head.state === 'shattered'
                ? hs.head._shatterX : hs.head.worldX;
            const sy = hs.head.state === 'shattered' ? hs.head._shatterY : hs.head.worldY;
            const x = sx * camera.wtsScale + camera.wtsOffX;
            const y = sy * camera.wtsScale + camera.wtsOffY;
            const ws = this.game.worldScale;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = Math.max(0, p) * 0.7;
            const grad = ctx.createLinearGradient(x, y - 900 * ws, x, y);
            grad.addColorStop(0, 'rgba(255,238,153,0)');
            grad.addColorStop(1, '#ffee99');
            ctx.fillStyle = grad;
            const w = 46 * ws * Math.max(0.2, p);
            ctx.fillRect(x - w / 2, y - 900 * ws, w, 900 * ws);
            ctx.restore();
        }
    }

    _drawSite(ctx, camera) {
        // A wound in space — slow red breathing where the dragon will rise.
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const cw = ctx.canvas.width, ch = ctx.canvas.height;
        if (sx < -300 || sx > cw + 300 || sy < -300 || sy > ch + 300) return;
        const ws = this.game.worldScale;
        const breathe = 0.5 + 0.5 * Math.sin(this._animClock * 0.9);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.12 + 0.1 * breathe;
        ctx.fillStyle = RED;
        ctx.beginPath();
        ctx.arc(sx, sy, (60 + 26 * breathe) * ws, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.5 + 0.3 * breathe;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(sx, sy, 3.5 * ws, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    _drawSigil(ctx, camera) {
        const s = this.sigil;
        // Cheap reject: is the site anywhere near the view?
        const cx = (this.cin ? this.cin.center.x : this.siteX);
        const cy = (this.cin ? this.cin.center.y : this.siteY);
        const scx = cx * camera.wtsScale + camera.wtsOffX;
        const scy = cy * camera.wtsScale + camera.wtsOffY;
        const reach = (CIRCLE_R + 400) * this.game.worldScale;
        if (scx < -reach || scx > ctx.canvas.width + reach ||
            scy < -reach || scy > ctx.canvas.height + reach) return;

        const pulse = 0.75 + 0.25 * Math.sin(this._animClock * 2.2);
        const flash = s.flash || 0;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const pass of [
            { color: RED_DEEP, width: 16 + flash * 14, alpha: 0.35 + flash * 0.3 },
            { color: RED, width: 6 + flash * 8, alpha: 0.8 },
            { color: flash > 0.05 ? '#ffffff' : '#ffb0a0', width: 2 + flash * 5, alpha: 0.9 }
        ]) {
            ctx.strokeStyle = pass.color;
            ctx.globalAlpha = pass.alpha * s.alpha * pulse;
            ctx.lineWidth = pass.width * this.game.worldScale;
            for (const path of s.paths) {
                if (path.length < 2) continue;
                ctx.beginPath();
                for (let i = 0; i < path.length; i++) {
                    const px = path[i].x * camera.wtsScale + camera.wtsOffX;
                    const py = path[i].y * camera.wtsScale + camera.wtsOffY;
                    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
                }
                ctx.stroke();
            }
        }
        ctx.restore();
    }

}

