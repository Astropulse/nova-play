import { Scrap, ItemPickup, ExpOrb, ProceduralDebris, Rubble, Asteroid } from './asteroid.js';
import { Enemy, AI_STATE } from './enemy.js';
import { Projectile } from './projectile.js';
import { UPGRADES } from '../data/upgrades.js';
import { MUSIC_STATE } from '../engine/soundManager.js';
import { CACHE_CONFIG } from './spaceCache.js';

export const CARCOSA_STATE = {
    DORMANT: 'carcosa_dormant', // Belt + sleeping ships (never 'dormant' — that
    FIGHT: 'fight',             // string trips the Cthulhu ram-wake loop)
    REBUILDING: 'rebuilding',   // The last light flying home
    REBUILT: 'rebuilt',         // Waiting for the player to return for tribute
    FINISHED: 'finished'
};

// Everything Carcosa does is the King's yellow; the ships themselves are pale
// dead bone.
const CARCOSA_YELLOW = '#ffdd44';
const CARCOSA_GOLD = '#d9a520';
const BONE_PALE = '#e8e4d8';
const BONE_GREY = '#9aa4ae';

// The belt: a dense, lumpy ellipse of rock and dormant bone ships — tight
// enough to read as a structure, but still past the view from Carcosa itself.
const BELT_RADIUS = 4200;
const BELT_HALF_BAND = 500;
const BELT_ROCK_SLOTS = 260;
const NEAR_ROCK_SLOTS = 16;
const BELT_SHIPS = 46;
const NEAR_SHIPS = 16;

// Rocks materialize in an annulus around approaching pilots (never on-screen),
// each slot ONCE ever — a mined rock never comes back (no belt farming). The
// spawned rocks are cull-proof so the ring stands as a permanent structure.
const ROCK_SPAWN_MAX = 3800;
const ROCK_SPAWN_MIN = 2000;

const WAKE_RADIUS = 850;         // reaching Carcosa itself springs the trap
const MUSIC_RADIUS = 2600;       // the event song takes over inside this
const MUSIC_EXIT_RADIUS = 4000;  // retreating pre-fight hands music back
const CACHE_DROP_RADIUS = 1000;  // tribute range at the rebuilt city
const WAVE_SPEED = 2400;         // the yellow light wave, world units/s

const MAX_ACTIVE_BONES = 20;     // one wave of the risen at a time
const REFILL_AT = 8;             // thin the flock to this → next wave rises
const BATCH_WINDOW = 4.0;        // late wave-front arrivals may join this long
const BONE_LOOT_BUDGET = 70;     // paying kills across the whole starfield

// Weeping angels: dormant ships near a pilot creep toward them — allowed to
// intrude a LITTLE way into the view, but visible motion must stay a barely-
// perceptible drift; anything faster reads as open pursuit.
const CREEP_SPEED = 110;         // off-screen stalking speed
const VIEW_DRIFT_SPEED = 26;     // max speed while any part of the view sees it
const VIEW_ENTER_DEPTH = 180;    // how far inside the screen edge they'll come
const HUSK_ARM_RADIUS = 2600;    // near enough to sense the player passing
const HUSK_SEPARATION = 240;
const HUSK_TURN_RATE = 0.35;     // rad/s — dead ships come about sllooowwly

const REANIMATE_FRAME_MS = 110;  // 7 frames ≈ 0.77s of rising
const REWAKE_FRAME_MS = 70;      // re-rising from a self-calcify is quicker

// Self-calcify: a risen ship may turn back to stone mid-fight — statue-still,
// invulnerable — then shake itself awake again.
const CALCIFY_COOLDOWN_MIN = 12;
const CALCIFY_COOLDOWN_VAR = 10;
const CALCIFY_DUR_MIN = 2.5;
const CALCIFY_DUR_VAR = 2.5;
const CALCIFY_ANIM = 0.35;       // reanimate gif played backward into stone

// ─────────────────────────────────────────────────────────────────────────────
// BoneEnemy — a risen bone ship. Regular enemy bones (heh) with a short
// invulnerable reanimation ritual on arrival, then flock steering layered onto
// the base AI so the risen hunt as one wheeling swarm. All shots are the
// King's yellow. Loot dries up after the shared budget is spent.
// ─────────────────────────────────────────────────────────────────────────────
export class BoneEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0, carcosa = null, variant = null) {
        super(game, worldX, worldY, difficultyScale);

        this.variant = (variant === null || variant === undefined)
            ? Math.floor(Math.random() * 4) : variant;
        this.spriteKey = `bone_${this.variant}`;
        this.img = game.assets.get(this.spriteKey);
        if (this.img) {
            this.radius = (this.img.width || 40) * 0.34;
        }

        // A touch quicker than chaff — the flock closes like a tide.
        const speedScale = 1 + (difficultyScale - 1) * 0.08;
        this.baseSpeed = Math.min(950, (325 + Math.random() * 80) * speedScale * 1.12);
        this.turnSpeed = Math.min(14.5, this.turnSpeed * 1.15);

        // Sturdier than chaff — dead bone doesn't mind being shot much.
        this.health = Math.ceil(this.health * 1.7);
        this.maxHealth = this.health;

        this.carcosa = carcosa;        // shared loot budget + flock roster
        this.isBone = true;
        this.noDespawn = true;         // anchored to Carcosa, not the player
        this.yellowArmada = true;      // the King's yellow glow (never the red)

        // Reanimation ritual: invulnerable, motionless, the gif playing once
        // while unholy light knits the hull together. Replicated clients get
        // the same arrival (default true).
        this.reanimating = true;
        this.dormant = true;           // no contact damage while rising
        this.reanimFrame = 0;
        this.reanimTimer = 0;
        this._reanimFrameMs = REANIMATE_FRAME_MS;
        this._animClock = Math.random() * 10;
        this._lastClink = -1;

        // Self-calcify: mid-fight it may turn back to stone (invulnerable
        // statue) and later shake awake. Host-simulated only.
        this.calcified = false;
        this._calcifyTimer = 0;
        this._calcifyAnim = 0;         // reanimate gif backward, into stone
        this._calcifyCooldown = CALCIFY_COOLDOWN_MIN + Math.random() * CALCIFY_COOLDOWN_VAR;

        // Flock steering (recomputed on a slow clock, applied every frame).
        this._flockVX = 0;
        this._flockVY = 0;
        this._flockTimer = Math.random() * 0.12;
    }

    // ─── REANIMATION ───────────────────────────────────────────────────

    _updateReanimate(dt) {
        this._animClock += dt;
        this.reanimTimer += dt * 1000;
        const gif = this.game.assets.get(`bone_${this.variant}_reanimate`);
        const frames = (gif && gif.length) || 7;
        if (this.reanimTimer >= this._reanimFrameMs) {
            this.reanimTimer -= this._reanimFrameMs;
            this.reanimFrame++;
            // Bone dust shakes loose as the hull knits.
            const state = this.game.currentState;
            if (state && state._spawnSparks) {
                state._spawnSparks(this.worldX, this.worldY, 2, {
                    color: Math.random() < 0.6 ? BONE_PALE : CARCOSA_YELLOW,
                    speedMin: 30, speedMax: 140
                });
            }
        }
        if (this.reanimFrame >= frames) {
            this.reanimating = false;
            this.dormant = false;
            this.invulnTimer = 0.2;
            this.game.sounds.play('boost', { volume: 0.35, x: this.worldX, y: this.worldY });
        }
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.reanimating) {
            this._updateReanimate(dt);
            return;
        }
        if (this.calcified) {
            this._updateCalcified(dt);
            return;
        }
        this._flockTimer -= dt;
        if (this._flockTimer <= 0) {
            this._flockTimer = 0.12;
            this._recomputeFlock();
        }

        // Now and then a risen ship simply... stops. Turns back to stone,
        // shrugs off everything, then shakes awake and rejoins the hunt.
        if (this.carcosa && !this.netRemote) {
            this._calcifyCooldown -= dt;
            if (this._calcifyCooldown <= 0) {
                this._calcifyCooldown = CALCIFY_COOLDOWN_MIN + Math.random() * CALCIFY_COOLDOWN_VAR;
                if (Math.random() < 0.65 && this._flockCalcifyAllowed()) {
                    this._startCalcify();
                }
            }
        }

        super.update(dt, player, asteroids, projectiles, enemies);
    }

    // At most a quarter of the flock may be stone at once — the swarm never
    // just switches itself off.
    _flockCalcifyAllowed() {
        const flock = this.carcosa.bones;
        let live = 0, stone = 0;
        for (const b of flock) {
            if (!b.alive) continue;
            live++;
            if (b.calcified) stone++;
        }
        return stone < Math.max(1, Math.floor(live / 4));
    }

    _startCalcify() {
        this.calcified = true;
        this.dormant = true;           // no contact damage from a statue
        this._calcifyTimer = CALCIFY_DUR_MIN + Math.random() * CALCIFY_DUR_VAR;
        this._calcifyAnim = CALCIFY_ANIM;
        const state = this.game.currentState;
        if (state && state.cinematics) {
            state.cinematics.spawnRing(this.worldX, this.worldY, { color: BONE_PALE, maxR: 60, dur: 0.35, width: 2 });
        }
        this.game.sounds.play('shield_break', { volume: 0.15, x: this.worldX, y: this.worldY });
    }

    _updateCalcified(dt) {
        this._animClock += dt;
        this._calcifyAnim = Math.max(0, this._calcifyAnim - dt);
        // Dead stone doesn't fly: brake hard and drift.
        const brake = Math.pow(0.9, dt * 60);
        this.vx *= brake;
        this.vy *= brake;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this._calcifyTimer -= dt;
        if (this._calcifyTimer <= 0) {
            // Shake awake: a quick second reanimation (still invulnerable).
            this.calcified = false;
            this.reanimating = true;
            this.reanimFrame = 0;
            this.reanimTimer = 0;
            this._reanimFrameMs = REWAKE_FRAME_MS;
            const state = this.game.currentState;
            if (state && state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: CARCOSA_YELLOW, maxR: 70, dur: 0.4, width: 2 });
            }
        }
    }

    // Boids on a budget: separation from packed neighbours, gentle alignment
    // and cohesion with the wheeling flock. Cached between slow ticks.
    _recomputeFlock() {
        let flock = null;
        if (this.carcosa) {
            flock = this.carcosa.bones;
        } else {
            const state = this.game.currentState;
            flock = state ? state.enemies : null; // replicated client: scan peers
        }
        let sepX = 0, sepY = 0, cohX = 0, cohY = 0, alignX = 0, alignY = 0, n = 0;
        if (flock) {
            for (const other of flock) {
                if (other === this || !other.alive || !other.isBone ||
                    other.reanimating || other.calcified) continue;
                const dx = other.worldX - this.worldX;
                const dy = other.worldY - this.worldY;
                const d2 = dx * dx + dy * dy;
                if (d2 > 700 * 700) continue;
                const d = Math.sqrt(d2) || 1;
                if (d < HUSK_SEPARATION) {
                    const push = (HUSK_SEPARATION - d) / HUSK_SEPARATION;
                    sepX -= (dx / d) * push;
                    sepY -= (dy / d) * push;
                }
                cohX += dx; cohY += dy;
                alignX += Math.cos(other.angle);
                alignY += Math.sin(other.angle);
                n++;
            }
        }
        if (n > 0) {
            this._flockVX = sepX * 1.3 + (cohX / n) * 0.0006 + (alignX / n) * 0.4;
            this._flockVY = sepY * 1.3 + (cohY / n) * 0.0006 + (alignY / n) * 0.4;
        } else {
            this._flockVX = 0;
            this._flockVY = 0;
        }
    }

    // Blend the flock vector into the cruise heading; attack runs stay pure so
    // individual gunnery is unaffected.
    _getTargetAngle(angleToPlayer, dist) {
        const base = super._getTargetAngle(angleToPlayer, dist);
        if ((this._flockVX !== 0 || this._flockVY !== 0) &&
            (this.state === AI_STATE.PURSUIT || this.state === AI_STATE.REPOSITION ||
                this.state === AI_STATE.BREAK)) {
            const bx = Math.cos(base) + this._flockVX;
            const by = Math.sin(base) + this._flockVY;
            if (bx !== 0 || by !== 0) return Math.atan2(by, bx);
        }
        return base;
    }

    // ─── DAMAGE ────────────────────────────────────────────────────────

    hit(damage) {
        // Dormant, mid-ritual, or self-calcified: shots ping off — grey zeroes.
        if (this.reanimating || this.dormant || this.calcified) {
            this._immuneFeedback();
            return false;
        }
        const died = super.hit(damage);
        if (died && this.carcosa) {
            this.carcosa.lastBoneDeath = { x: this.worldX, y: this.worldY };
        }
        return died;
    }

    _immuneFeedback() {
        if (this._animClock - this._lastClink <= 0.09) return;
        this._lastClink = this._animClock;
        this.game.sounds.play('hit', { volume: 0.12, x: this.worldX, y: this.worldY });
        const st = this.game.currentState;
        if (st && st.spawnFloatingText) {
            st.spawnFloatingText(
                this.worldX + (Math.random() - 0.5) * 50,
                this.worldY + (Math.random() - 0.5) * 60, '0', BONE_GREY);
        }
    }

    // All bone shots are the King's yellow (mirrors the locust loadouts).
    shoot() {
        if (this.upgradeType === 'kamikaze') return;

        const laserSpeed = 950;
        const noseOffset = 30;
        const px = this.worldX + Math.cos(this.angle) * noseOffset;
        const py = this.worldY + Math.sin(this.angle) * noseOffset;
        const damage = (10 + 2.5 * this.difficultyScale) * this.damageMult;

        if (this.upgradeType === 'bigBall') {
            const proj = new Projectile(this.game, px, py, this.angle, laserSpeed * 0.8, 'yellow_laser_ball_big', this, damage * 1.5);
            this.pendingProjectiles.push(proj);
            this.game.sounds.play('laser', { volume: 0.4, x: px, y: py });
        } else if (this.upgradeType === 'multishot') {
            const count = 3;
            const spread = 0.3;
            for (let i = 0; i < count; i++) {
                const angleOffset = (i - (count - 1) / 2) * (spread / (count - 1));
                const proj = new Projectile(this.game, px, py, this.angle + angleOffset, laserSpeed, 'yellow_laser_ball', this, damage * 0.7);
                this.pendingProjectiles.push(proj);
            }
            this.game.sounds.play('laser', { volume: 0.3, x: px, y: py });
        } else {
            const spreadAngle = this.angle + (Math.random() - 0.5) * 0.08;
            const proj = new Projectile(this.game, px, py, spreadAngle, laserSpeed, 'yellow_laser_ball', this, damage);
            this.pendingProjectiles.push(proj);
            this.game.sounds.play('laser', { volume: 0.2, x: px, y: py });
        }
    }

    getSpawnOnDeath() {
        // Shared budget across the whole starfield: dry kills drop only bones.
        if (this.carcosa && this.carcosa.lootBudget <= 0) {
            const spawns = this._generateProceduralDebris();
            for (let i = 0; i < 3; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));
            return spawns;
        }
        if (this.carcosa) this.carcosa.lootBudget--;
        return super.getSpawnOnDeath();
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        if (this.calcified) {
            // Turned back to stone: the dormant hull, statue-still. The brief
            // calcify-in plays the reanimate gif BACKWARD into the stone frame.
            let img = this.game.assets.get(`bone_${this.variant}_dormant`);
            let frame = null;
            if (this._calcifyAnim > 0) {
                const gif = this.game.assets.get(`bone_${this.variant}_reanimate`);
                if (gif && gif.length) {
                    const idx = Math.round((this._calcifyAnim / CALCIFY_ANIM) * (gif.length - 1));
                    frame = gif[Math.max(0, Math.min(gif.length - 1, idx))];
                    img = frame.canvas || frame;
                }
            }
            if (!img) return;
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const ws = this.game.worldScale;
            const w = ((frame && frame.width) || img.width) * ws;
            const h = ((frame && frame.height) || img.height) * ws;
            if (screen.x < -w || screen.x > this.game.width + w ||
                screen.y < -h || screen.y > this.game.height + h) return;
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
            ctx.restore();
            return;
        }
        if (this.reanimating) {
            const gif = this.game.assets.get(`bone_${this.variant}_reanimate`);
            const frame = (gif && gif.length)
                ? gif[Math.min(this.reanimFrame, gif.length - 1)] : null;
            const img = frame ? (frame.canvas || frame) : null;
            if (!img) return;
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const ws = this.game.worldScale;
            const w = (frame.width || img.width) * ws;
            const h = (frame.height || img.height) * ws;
            if (screen.x < -w || screen.x > this.game.width + w ||
                screen.y < -h || screen.y > this.game.height + h) return;
            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            // Unholy light knits the hull: a pulsing yellow glow under the gif.
            const glowSrc = this.img;
            if (glowSrc) {
                const glow = Enemy.getGlowSprite(glowSrc, this.spriteKey, CARCOSA_GOLD);
                const pxScale = w / glow.srcW;
                const gw = glow.canvas.width * pxScale;
                const gh = glow.canvas.height * pxScale;
                ctx.globalAlpha = 0.4 + 0.35 * Math.abs(Math.sin(this._animClock * 18));
                ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
                ctx.globalAlpha = 1;
            }
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.restore();
            return;
        }
        super.draw(ctx, camera);
    }
}

// The waking ritual, shared by every risen ship: yellow rings + bone dust.
export function spawnRisenBone(game, x, y, angle, variant, difficultyScale, carcosa) {
    const bone = new BoneEnemy(game, x, y, difficultyScale, carcosa, variant);
    bone.angle = angle;
    const state = game.currentState;
    // The risen roll the standard seeded upgrade path; beam picks are remapped
    // so everything they fire stays yellow.
    if (state && state.player) {
        Enemy.rollUpgrade(bone, state.player);
        if (bone.upgradeType === 'beam') {
            bone.upgradeType = 'multishot';
            bone.selectedUpgrades = bone.selectedUpgrades.map(u => u === 'beam' ? 'multishot' : u);
        }
    }
    if (state) {
        if (state.cinematics) {
            state.cinematics.spawnRing(x, y, { color: CARCOSA_YELLOW, maxR: 90, dur: 0.45, width: 3 });
        }
        if (state._spawnSparks) {
            state._spawnSparks(x, y, 8, { color: CARCOSA_YELLOW, speedMin: 60, speedMax: 240 });
            state._spawnSparks(x, y, 5, { color: BONE_PALE, speedMin: 40, speedMax: 160 });
        }
    }
    game.sounds.play('shield_break', { volume: 0.25, x, y });
    return bone;
}

// ─────────────────────────────────────────────────────────────────────────────
// Carcosa — the fifth post-Yellow One boss: the starfield of bones. A dead
// city ringed by a wide, lumpy asteroid belt strewn with dormant bone ships
// that behave like weeping angels — once seen, they stalk the player from just
// beyond the edge of the screen, freezing whenever they're watched. Reaching
// the city detonates a wave of yellow light that reanimates the fleet in
// flocking waves of up to 20. When the last risen ship falls, its light flies
// home and rebuilds the city; returning to it drops the tribute.
// ─────────────────────────────────────────────────────────────────────────────
export class Carcosa {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.alive = true;
        this.state = CARCOSA_STATE.DORMANT;
        this.radius = 128;             // discovery/indicator pad only —
        this.blocksProjectiles = false; // shots pass over the dead city
        this.rotation = 0;

        this.spriteKey = 'carcosa';
        this.assetKey = 'carcosa';
        this.displayName = 'Carcosa';
        this.isBoss = false;           // encounter wrap-up is handled manually
        this.revealed = false;
        this.discovered = false;
        this.isFinished = false;
        this.rebuilt = false;

        // Generic-serializer food; Carcosa itself is untouchable.
        this.health = 50;
        this.maxHealth = 50;
        this.invulnerable = true;
        this.fightStarted = false;
        this.musicStarted = false;
        this.cachesDropped = false;

        if (game.rng) {
            const d = game.rng.deriveEntity('enemies');
            this.contentRng = d.rng;
        } else {
            this.contentRng = null;
        }

        // The fleet's shared books.
        this.bones = [];               // live risen ships (pruned each frame)
        this.lootBudget = BONE_LOOT_BUDGET;
        this._queue = [];              // drained by popEnemies (host/SP adds)
        this._spawnQueue = [];         // drained by popSpawns (belt rocks)
        this.lastBoneDeath = null;     // where the last light lifts off from

        // The wave of yellow light (fight start) and the homebound pulse.
        this.waveT = -1;               // <0 = not fired; else seconds since burst
        this._batchWindow = 0;         // late arrivals may join the rising wave
        this._waking = 0;              // husks currently mid-ritual (they count)
        this.pulse = null;             // { x, y, tx, ty, speed }

        // Dread coupling: 0 far → 1 at the city, until it is rebuilt.
        this.dreadFactor = 0;

        // Post-tribute beat of silence: the trumpets ring alone, then music.
        this._musicRestoreDelay = 0;

        // Cosmetics
        this._animClock = Math.random() * 10;
        this._rockTimer = 0;

        this._buildField();
    }

    // ─── FIELD GENERATION ──────────────────────────────────────────────

    _rand() {
        return this.contentRng ? this.contentRng.next() : Math.random();
    }

    // The belt is a lumpy ellipse: two low-frequency harmonics wobble the ring
    // radius so no two runs get the same shape.
    _buildField() {
        const r = () => this._rand();
        this._beltAspect = 1.0 + r() * 0.3;          // x stretched vs y
        this._beltRot = r() * Math.PI * 2;
        this._lump1 = { k: 3, amp: 0.10 + r() * 0.06, phase: r() * Math.PI * 2 };
        this._lump2 = { k: 5, amp: 0.05 + r() * 0.05, phase: r() * Math.PI * 2 };

        this.rockSlots = [];
        for (let i = 0; i < BELT_ROCK_SLOTS; i++) {
            const theta = r() * Math.PI * 2;
            const p = this._beltPoint(theta, (r() * 2 - 1) * BELT_HALF_BAND);
            const roll = r();
            let size = 'medium';
            if (roll < 0.12) size = 'big';
            else if (roll < 0.57) size = 'medium';
            else if (roll < 0.87) size = 'small';
            else size = 'tiny';
            this.rockSlots.push({ x: p.x, y: p.y, size, spawned: false });
        }
        // A looser scatter of rock near the city itself.
        for (let i = 0; i < NEAR_ROCK_SLOTS; i++) {
            const ang = r() * Math.PI * 2;
            const dist = 600 + r() * 2000;
            const roll = r();
            const size = roll < 0.4 ? 'medium' : (roll < 0.8 ? 'small' : 'tiny');
            this.rockSlots.push({
                x: this.worldX + Math.cos(ang) * dist,
                y: this.worldY + Math.sin(ang) * dist,
                size, spawned: false
            });
        }

        // The dormant fleet: most sleep in the belt, a picket drifts near the
        // city. Each husk is event-side scenery until the wave wakes it.
        this.husks = [];
        for (let i = 0; i < BELT_SHIPS; i++) {
            const theta = r() * Math.PI * 2;
            const p = this._beltPoint(theta, (r() * 2 - 1) * BELT_HALF_BAND * 0.85);
            this._addHusk(p.x, p.y, r);
        }
        for (let i = 0; i < NEAR_SHIPS; i++) {
            const ang = r() * Math.PI * 2;
            const dist = 700 + r() * 1900;
            this._addHusk(
                this.worldX + Math.cos(ang) * dist,
                this.worldY + Math.sin(ang) * dist, r);
        }
    }

    _addHusk(x, y, r) {
        this.husks.push({
            x, y,
            variant: Math.floor(r() * 4) % 4,
            angle: r() * Math.PI * 2,
            seen: false,
            wakeReadyAt: Infinity,  // set when the wave fires
            waking: false,          // claimed by the current rising wave
            wakeAt: 0
        });
    }

    // Ring point for a given polar angle + radial jitter, lumps and all.
    _beltPoint(theta, jitter) {
        const lump = 1
            + this._lump1.amp * Math.sin(this._lump1.k * theta + this._lump1.phase)
            + this._lump2.amp * Math.sin(this._lump2.k * theta + this._lump2.phase);
        const rr = BELT_RADIUS * lump + jitter;
        const ex = Math.cos(theta) * rr * this._beltAspect;
        const ey = Math.sin(theta) * rr;
        const cosR = Math.cos(this._beltRot), sinR = Math.sin(this._beltRot);
        return {
            x: this.worldX + ex * cosR - ey * sinR,
            y: this.worldY + ex * sinR + ey * cosR
        };
    }

    // ─── SMALL HELPERS ─────────────────────────────────────────────────

    get isActive() {
        return this.state === CARCOSA_STATE.FIGHT || this.state === CARCOSA_STATE.REBUILDING;
    }

    get isAttackable() {
        return false; // the city itself can never be hurt
    }

    // The pre-song hush (music duck) applies while the field sleeps.
    get hushActive() {
        return this.state === CARCOSA_STATE.DORMANT && !this.musicStarted;
    }

    // After the fight, the music dies entirely until the player returns to
    // the rebuilt city for the trumpet and the tribute (dread ducks to full).
    // The silence holds a beat past the tribute so the fanfare rings alone.
    get awaitingTribute() {
        return this.state === CARCOSA_STATE.REBUILDING || this.state === CARCOSA_STATE.REBUILT ||
            this._musicRestoreDelay > 0;
    }

    _bodies() {
        const state = this.game.currentState;
        if (!state) return [];
        if (!state.netSync && state.localPlayers && state.localPlayers.length > 1) {
            return state.localPlayers.map(s => s.player).filter(p => p && !p.dead);
        }
        return state.player && !state.player.dead ? [state.player] : [];
    }

    _diff() {
        return (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
    }

    _isAuthority() {
        const state = this.game.currentState;
        return !state || !state.netSync || state.netSync.isHost;
    }

    // Live risen ships everywhere (host roster or replicated peers) + queued
    // + mid-ritual husks — the wave cap counts everything already claimed.
    _countActive() {
        let n = this._queue.length + this._waking;
        const state = this.game.currentState;
        if (this.bones.length || !state) {
            n += this.bones.length;
        } else {
            for (const en of state.enemies) if (en.alive && en.isBone) n++;
        }
        return n;
    }

    popEnemies() {
        if (this._queue.length === 0) return this._queue;
        const out = this._queue;
        this._queue = [];
        return out;
    }

    popSpawns() {
        if (this._spawnQueue.length === 0) return this._spawnQueue;
        const out = this._spawnQueue;
        this._spawnQueue = [];
        return out;
    }

    // ─── UPDATE ────────────────────────────────────────────────────────

    update(dt, player) {
        if (!this.alive || this.state === CARCOSA_STATE.FINISHED) {
            this.dreadFactor = 0;
            this._tickMusicRestore(dt);
            this._updateBeltRocks(dt, player); // the belt outlives the fight
            return;
        }
        this._animClock += dt;

        for (let i = this.bones.length - 1; i >= 0; i--) {
            if (!this.bones[i].alive) this.bones.splice(i, 1);
        }

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (!this.revealed && dist < 3500) this.revealed = true;

        // Reality frays on approach and stays frayed until the city is rebuilt.
        if (this.state === CARCOSA_STATE.REBUILT) {
            this.dreadFactor = 0;
        } else {
            this.dreadFactor = Math.max(0, Math.min(1, (6500 - dist) / (6500 - 600)));
        }

        this._updateBeltRocks(dt, player);

        switch (this.state) {
            case CARCOSA_STATE.DORMANT:
                this._updateHusks(dt);
                this._updateApproachMusic(dist);
                if (dist < WAKE_RADIUS) this._startFight();
                break;

            case CARCOSA_STATE.FIGHT:
                this._updateHusks(dt);
                this._updateWave(dt, player);
                // Victory = every husk risen and every risen ship broken.
                if (this.husks.length === 0 && this._countActive() === 0) {
                    this._startRebuild();
                }
                break;

            case CARCOSA_STATE.REBUILDING:
                this._updatePulse(dt);
                break;

            case CARCOSA_STATE.REBUILT:
                if (!this.cachesDropped && dist < CACHE_DROP_RADIUS) {
                    this._dropTribute();
                }
                break;
        }
    }

    // Belt rocks materialize in a ring around approaching pilots (outside
    // their view) — each slot fires ONCE ever. The rocks are exempt from the
    // distance cull so the ring stands as a permanent structure, and a mined
    // rock is gone for good; nothing here regenerates. (Splits/rubble from
    // breaking one are ordinary asteroids and behave like any other.)
    _updateBeltRocks(dt, player) {
        if (!this._isAuthority()) return;
        this._rockTimer -= dt;
        if (this._rockTimer > 0) return;
        this._rockTimer = 0.35;

        const bodies = this._bodies();
        if (!bodies.length && player) bodies.push(player);
        for (const slot of this.rockSlots) {
            if (slot.spawned) continue;
            let inBand = false;
            for (const b of bodies) {
                const rdx = slot.x - b.worldX;
                const rdy = slot.y - b.worldY;
                const d2 = rdx * rdx + rdy * rdy;
                if (d2 < ROCK_SPAWN_MIN * ROCK_SPAWN_MIN) { inBand = false; break; }
                if (d2 < ROCK_SPAWN_MAX * ROCK_SPAWN_MAX) inBand = true;
            }
            if (inBand) {
                slot.spawned = true;
                const rock = new Asteroid(this.game, slot.x, slot.y, slot.size);
                rock.despawnDist = 1e9; // belt rock: stands until mined
                this._spawnQueue.push(rock);
            }
        }
    }

    // ─── WEEPING ANGELS ────────────────────────────────────────────────

    // How deep inside a view rect a point sits: positive = on screen (distance
    // in from the nearest edge), negative = that far off screen.
    static _viewDepth(px, py, bx, by, halfW, halfH) {
        return Math.min(halfW - Math.abs(px - bx), halfH - Math.abs(py - by));
    }

    // Dormant ships near a pilot creep toward them — allowed a LITTLE way into
    // the view, so at game pace they're actually caught drifting at the edge
    // of the screen, but they freeze before it reads as open pursuit. Deep in
    // view: statue-still. Silent, collisionless, spaced apart.
    _updateHusks(dt) {
        const bodies = this._bodies();
        if (!bodies.length) return;
        const halfViewW = (this.game.width / 2) / this.game.worldScale;
        const halfViewH = (this.game.height / 2) / this.game.worldScale;

        for (let i = 0; i < this.husks.length; i++) {
            const husk = this.husks[i];
            if (husk.waking) continue;

            // Deepest intrusion into any pilot's view + the nearest pilot.
            let maxDepth = -Infinity;
            let nearest = null, nearestD = Infinity;
            for (const b of bodies) {
                const depth = Carcosa._viewDepth(husk.x, husk.y, b.worldX, b.worldY, halfViewW, halfViewH);
                if (depth > maxDepth) maxDepth = depth;
                const dx = husk.x - b.worldX, dy = husk.y - b.worldY;
                const d = dx * dx + dy * dy;
                if (d < nearestD) { nearestD = d; nearest = b; }
            }
            if (maxDepth > 0) husk.seen = true;
            if (maxDepth >= VIEW_ENTER_DEPTH) continue; // clearly watched: frozen
            if (!nearest) continue;
            // Arm on proximity (they sense the player passing) or on having
            // been seen once — either way, the stalking starts.
            if (!husk.seen && nearestD > HUSK_ARM_RADIUS * HUSK_ARM_RADIUS) continue;
            husk.seen = true;

            // Creep toward the nearest pilot — the moment any part of the view
            // catches it, the motion collapses to a near-imperceptible drift
            // that bleeds off the deeper it intrudes.
            const speed = maxDepth > 0
                ? VIEW_DRIFT_SPEED * (1 - 0.7 * (maxDepth / VIEW_ENTER_DEPTH))
                : CREEP_SPEED;
            const tdx = nearest.worldX - husk.x;
            const tdy = nearest.worldY - husk.y;
            const td = Math.sqrt(tdx * tdx + tdy * tdy) || 1;
            let mx = (tdx / td) * speed;
            let my = (tdy / td) * speed;

            // Give the others room (they drift as a scatter, not a clump).
            for (let j = 0; j < this.husks.length; j++) {
                if (j === i) continue;
                const o = this.husks[j];
                const sdx = husk.x - o.x;
                const sdy = husk.y - o.y;
                const sd2 = sdx * sdx + sdy * sdy;
                if (sd2 > HUSK_SEPARATION * HUSK_SEPARATION || sd2 === 0) continue;
                const sd = Math.sqrt(sd2);
                const push = (HUSK_SEPARATION - sd) / HUSK_SEPARATION * speed;
                mx += (sdx / sd) * push;
                my += (sdy / sd) * push;
            }

            const nx = husk.x + mx * dt;
            const ny = husk.y + my * dt;

            // Never step DEEPER than the allowed intrusion into any view.
            let blocked = false;
            for (const b of bodies) {
                if (Carcosa._viewDepth(nx, ny, b.worldX, b.worldY, halfViewW, halfViewH) >= VIEW_ENTER_DEPTH) {
                    blocked = true;
                    break;
                }
            }
            if (blocked) continue;
            husk.x = nx;
            husk.y = ny;
            // Never snap to face the heading — a dead ship comes about at a
            // glacial creep, so being looked at mid-turn just reads as
            // "...was it always pointed like that?"
            const want = Math.atan2(my, mx);
            let diff = want - husk.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            husk.angle += Math.sign(diff) * Math.min(Math.abs(diff), HUSK_TURN_RATE * dt);
        }
    }

    // ─── THE FIGHT ─────────────────────────────────────────────────────

    _updateApproachMusic(dist) {
        if (!this.musicStarted && dist < MUSIC_RADIUS) {
            this.musicStarted = true;
            this.game.sounds.playSpecificMusic('Starfield of Bones');
        } else if (this.musicStarted && !this.fightStarted && dist > MUSIC_EXIT_RADIUS) {
            // Backed out before springing the trap: hand the music back.
            this.musicStarted = false;
            const state = this.game.currentState;
            if (state && state.musicCombatTriggered) {
                this.game.sounds.setTargetState(MUSIC_STATE.COMBAT, true);
            } else {
                this.game.sounds.restoreMusic();
            }
        }
    }

    _startFight() {
        if (this.fightStarted) return;
        this.state = CARCOSA_STATE.FIGHT;
        this.fightStarted = true;
        this.waveT = 0;
        this._batchWindow = BATCH_WINDOW;

        if (!this.musicStarted) {
            this.musicStarted = true;
            this.game.sounds.playSpecificMusic('Starfield of Bones');
        }

        // Every husk learns when the light will reach it (+ drama).
        for (const husk of this.husks) {
            const hdx = husk.x - this.worldX;
            const hdy = husk.y - this.worldY;
            const hd = Math.sqrt(hdx * hdx + hdy * hdy);
            husk.wakeReadyAt = hd / WAVE_SPEED + 0.3 + Math.random() * 1.6;
        }

        // The burst: a wave of yellow light out of the dead city.
        this.game.sounds.play('shield_break', { volume: 1.0, x: this.worldX, y: this.worldY });
        this.game.sounds.play('ship_explode', { volume: 0.7, x: this.worldX, y: this.worldY });
        this.game.camera.shake(2.5);
        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash(CARCOSA_YELLOW, 1.0, 0.4);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffffff', maxR: 600, dur: 0.9, width: 6 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: CARCOSA_YELLOW, maxR: 420, dur: 0.7, width: 5 });
            }
        }
    }

    // The light sweeps outward; husks it has passed rise in waves of up to 20,
    // nearest the player first, the deep belt held in reserve.
    _updateWave(dt, player) {
        this.waveT += dt;
        this._batchWindow = Math.max(0, this._batchWindow - dt);

        // Track ritual completions: a husk stops counting as _waking once its
        // ship has been born (the queue/bones/enemy scan covers it from there).
        // _waking is recomputed each pass below instead of decremented.
        let waking = 0;

        const active = this._countActive() - this._waking; // ships already real
        let capacity = MAX_ACTIVE_BONES - active - this._waking; // waking claim slots too

        // A new wave only rises when the flock has thinned (or is rising now).
        const waveOpen = this._batchWindow > 0 || active <= REFILL_AT;

        for (let i = this.husks.length - 1; i >= 0; i--) {
            const husk = this.husks[i];

            if (husk.waking) {
                // Ritual due: replace the husk with a rising ship.
                if (this._animClock >= husk.wakeAt) {
                    if (this._isAuthority()) {
                        const bone = spawnRisenBone(this.game, husk.x, husk.y,
                            husk.angle, husk.variant, this._diff(), this);
                        this.bones.push(bone);
                        this._queue.push(bone);
                    } else {
                        // Client: the real ship arrives from the host; play the
                        // arrival dressing and clear the local statue.
                        spawnRisenBone(this.game, husk.x, husk.y,
                            husk.angle, husk.variant, this._diff(), null).alive = false;
                    }
                    this.husks.splice(i, 1);
                } else {
                    waking++;
                }
                continue;
            }

            // The wave-front reaches it, there is room, and a wave is rising.
            if (this.waveT >= husk.wakeReadyAt && capacity > 0 && waveOpen) {
                husk.waking = true;
                husk.wakeAt = this._animClock + Math.random() * 1.2;
                capacity--;
                waking++;
                if (this._batchWindow <= 0) this._batchWindow = BATCH_WINDOW;
            }
        }
        this._waking = waking;
    }

    // ─── REBUILD / TRIBUTE ─────────────────────────────────────────────

    _startRebuild() {
        this.state = CARCOSA_STATE.REBUILDING;
        const from = this.lastBoneDeath || { x: this.worldX, y: this.worldY - 400 };
        this.pulse = { x: from.x, y: from.y, speed: 2200 };
        this.game.sounds.play('shield_break', { volume: 0.6, x: from.x, y: from.y });
        const state = this.game.currentState;
        if (state && state.cinematics) {
            state.cinematics.spawnRing(from.x, from.y, { color: CARCOSA_YELLOW, maxR: 220, dur: 0.6, width: 4 });
        }
    }

    // The last light flies home, gathering speed, and remakes the city.
    _updatePulse(dt) {
        const p = this.pulse;
        if (!p) { this._finishRebuild(); return; }
        p.speed += 2600 * dt;
        const dx = this.worldX - p.x;
        const dy = this.worldY - p.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        const step = p.speed * dt;
        if (d <= step + 40) {
            this.pulse = null;
            this._finishRebuild();
            return;
        }
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
        const state = this.game.currentState;
        if (state && state._spawnSparks && Math.random() < 0.7) {
            state._spawnSparks(p.x, p.y, 2, {
                color: Math.random() < 0.7 ? CARCOSA_YELLOW : '#ffffff',
                speedMin: 20, speedMax: 120
            });
        }
    }

    _finishRebuild() {
        this.state = CARCOSA_STATE.REBUILT;
        this.rebuilt = true;
        this.dreadFactor = 0;
        this.game.camera.shake(3.0);
        this.game.sounds.play('ship_explode', { volume: 0.8, x: this.worldX, y: this.worldY });
        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#ffffff', 1.0, 0.45);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffffff', maxR: 520, dur: 1.0, width: 7 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: CARCOSA_YELLOW, maxR: 380, dur: 0.8, width: 5 });
            }
            // No music yet — the boss song fades to silence (dread ducks it to
            // full while awaitingTribute) and stays gone until the player
            // returns to the rebuilt city for the trumpet and the tribute.
        }
        if (this.game.achievements) {
            this.game.achievements.notify('boss_defeated', { bossId: 'Carcosa' });
        }
    }

    // Three caches streak in and crash-land around the rebuilt city, heralded
    // by the trumpets, and the music returns. Placement/flight ride the seeded
    // caches stream, so every machine lands them in the same spots (same
    // determinism as the Hive's victory cache).
    _dropTribute() {
        this.cachesDropped = true;
        const state = this.game.currentState;
        if (state) {
            if (state.cinematics && state.cinematics.trumpetFanfare) {
                state.cinematics.trumpetFanfare(this.worldX, this.worldY);
            }
            if (state.caches && state.cacheSpawner) {
                const rand = () => this.game.rng ? this.game.rng.caches.next() : Math.random();
                for (let i = 0; i < 3; i++) {
                    if (state.caches.length >= CACHE_CONFIG.maxActiveCaches + 3) break;
                    // Land targets fanned around the city; each cache flies in
                    // from off-screen like a wave resupply drop.
                    const ang = (i / 3) * Math.PI * 2 + rand() * 1.5;
                    const dist = 300 + rand() * 240;
                    const cache = state.cacheSpawner.spawnCrash(
                        this.worldX + Math.cos(ang) * dist,
                        this.worldY + Math.sin(ang) * dist);
                    cache.startCrashLanding(0, 0, {
                        angle: rand() * Math.PI * 2,
                        tx: this.worldX + Math.cos(ang) * dist,
                        ty: this.worldY + Math.sin(ang) * dist
                    });
                    state.caches.push(cache);
                    if (state.netSync && state.netSync.isHost) state.netSync.registerCache(cache);
                }
            }
            // Hold the silence a beat longer so the trumpets ring alone —
            // _tickMusicRestore hands the music back when this runs out.
            this._musicRestoreDelay = 2.5;
            // The bones were not the end. The glow turns RED and swings onto
            // the dragon's summoning ground — the final hunt.
            if (state._spawnDragonAfterCarcosa) state._spawnDragonAfterCarcosa();
        }
        this.state = CARCOSA_STATE.FINISHED;
        this.isFinished = true;
        // alive stays true forever — the rebuilt city is the persistent
        // "bones beaten" marker (and a monument worth flying past).
    }

    // The trumpets get their moment of silence, then the music returns —
    // immediately (skipping the 4s transition window), so the un-ducking
    // never resurfaces the bone song.
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

    // ─── DAMAGE ────────────────────────────────────────────────────────

    hit(damage) {
        return false; // a dead city cannot be hurt (shots don't even land —
                      // blocksProjectiles is false)
    }

    freeze(duration) { }

    getSpawnOnDeath() {
        return []; // never destroyed
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    draw(ctx, camera) {
        if (!this.alive) return;
        const ws = this.game.worldScale;

        // The dormant fleet (statues in the dark).
        if (this.husks.length) {
            for (const husk of this.husks) {
                const img = this.game.assets.get(`bone_${husk.variant}_dormant`);
                if (!img) continue;
                const sx = husk.x * camera.wtsScale + camera.wtsOffX;
                const sy = husk.y * camera.wtsScale + camera.wtsOffY;
                const w = img.width * ws;
                const h = img.height * ws;
                if (sx + w < -100 || sx - w > this.game.width + 100 ||
                    sy + h < -100 || sy - h > this.game.height + 100) continue;
                ctx.save();
                ctx.translate(sx, sy);
                ctx.rotate(husk.angle + Math.PI / 2);
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
        }

        // The city itself.
        const key = this.rebuilt ? 'carcosa_rebuilt' : 'carcosa';
        const img = this.game.assets.get(key);
        if (img) {
            const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
            const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
            const w = img.width * ws;
            const h = img.height * ws;
            if (!(sx + w < -150 || sx - w > this.game.width + 150 ||
                sy + h < -150 || sy - h > this.game.height + 150)) {
                ctx.save();
                ctx.translate(sx, sy);
                if (this.rebuilt) {
                    // The remade city breathes golden light.
                    ctx.shadowBlur = (14 + Math.sin(this._animClock * 1.6) * 6) * ws;
                    ctx.shadowColor = CARCOSA_YELLOW;
                }
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
        }

        // The homebound light.
        if (this.pulse) {
            const sx = this.pulse.x * camera.wtsScale + camera.wtsOffX;
            const sy = this.pulse.y * camera.wtsScale + camera.wtsOffY;
            if (sx > -60 && sx < this.game.width + 60 && sy > -60 && sy < this.game.height + 60) {
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                const r = (7 + Math.sin(this._animClock * 22) * 2) * ws;
                ctx.fillStyle = CARCOSA_YELLOW;
                ctx.beginPath();
                ctx.arc(sx, sy, r, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(sx, sy, r * 0.45, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }
        }

        // The wave of yellow light, sweeping the whole field.
        if (this.state === CARCOSA_STATE.FIGHT && this.waveT >= 0) {
            const waveR = this.waveT * WAVE_SPEED;
            if (waveR < BELT_RADIUS * 1.6 + 2500) {
                const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
                const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
                const sr = waveR * camera.wtsScale;
                const fade = Math.max(0, 1 - waveR / (BELT_RADIUS * 1.6 + 2500));
                ctx.save();
                ctx.globalCompositeOperation = 'lighter';
                ctx.strokeStyle = CARCOSA_YELLOW;
                ctx.globalAlpha = 0.55 * fade;
                ctx.lineWidth = 26 * ws;
                ctx.beginPath();
                ctx.arc(sx, sy, sr, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 0.8 * fade;
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 6 * ws;
                ctx.beginPath();
                ctx.arc(sx, sy, sr, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
        }
    }
}
