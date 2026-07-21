import {
    Scrap, ItemPickup, ExpOrb, ProceduralDebris, Rubble,
    getCachedShatter, FractureModel, HullFracture, ejectChipDebris
} from './asteroid.js';
import { Enemy, AI_STATE } from './enemy.js';
import { Projectile } from './projectile.js';
import { UPGRADES } from '../data/upgrades.js';
import { ellipseContains } from '../engine/collision.js';
import { pickFireExplosion, fireExplosionFrame } from '../engine/vfx.js';
import { MUSIC_STATE } from '../engine/soundManager.js';
import { CACHE_CONFIG } from './spaceCache.js';

export const HIVE_STATE = {
    IDLE: 'hive_idle',     // Pre-fight slumber (never 'dormant' — that string
    FIGHT: 'fight',        // would trip the Cthulhu ram-wake loop)
    DYING: 'dying',        // Hive death sequence playing out
    BROKEN: 'broken',      // Hive shattered; mother/locust remnant still up
    FINISHED: 'finished'
};

// The swarm's palette: everything it fires or bleeds is yellow; everything it
// BIRTHS arrives through a dark corruption shimmer.
const SWARM_YELLOW = '#ffdd44';
const SWARM_AMBER = '#d9a520';
const CORRUPT_DARK = '#1a0626';
const CORRUPT_VIOLET = '#4a1a66';
const CORRUPT_GLOW = '#3a0a55';
const FAMINE_COLOR = '#b8d030';

// Anti-farming levers: the leash that pulls the player back to the hive, and
// the total number of locust kills that still pay out loot.
const FAMINE_RADIUS = 4200;
const LOCUST_LOOT_BUDGET = 60;
const MAX_ACTIVE_LOCUSTS = 16;
const BROOD_SIZE = 10;         // pre-spawned swarm circling the hive

// ─────────────────────────────────────────────────────────────────────────────
// LocustEnemy — the swarm's chaff. A regular enemy ship in every way (same
// stats, can roll upgrades) except slightly faster, yellow-firing, and born
// through a dark corruption shimmer. Loot dries up after the hive's shared
// budget (60 kills) is spent.
// ─────────────────────────────────────────────────────────────────────────────
export class LocustEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0, hive = null) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 5);
        this.spriteKey = `locust_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        if (this.img) {
            // Recompute the hull from the locust art (base measured a generic ship).
            this.radius = (this.img.width || 40) * 0.36;
        }

        // Same stats as chaff, slightly faster — a locust closes distance.
        const speedScale = 1 + (difficultyScale - 1) * 0.08;
        this.baseSpeed = Math.min(950, (320 + Math.random() * 80) * speedScale * 1.18);
        this.turnSpeed = Math.min(14.5, this.turnSpeed * 1.1);

        this.hive = hive;              // shared loot budget + aggro wiring
        this.isLocust = true;
        this.noDespawn = true;         // leashed to the hive, not the player

        // Corruption birth: the dark shimmer/flicker of something being spawned
        // evil. Purely cosmetic; ticks down in update.
        this.corruptTimer = 1.0;
        this._corruptClock = Math.random() * 10;

        // Birth scatter: freshly-birthed locusts bolt away from their spawn
        // point (fast, no fire) before wheeling around to attack.
        this.birthFleeTimer = 0;
        this.birthFleeAngle = 0;

        // Pre-fight brood: circle the hive, harmless, until the fight starts
        // (dormant also suppresses contact damage in PlayingState).
        this.swarming = false;
        this.dormant = false;
        this._swarmAngle = Math.random() * Math.PI * 2;
        this._swarmR = 190 + Math.random() * 150;
        this._swarmDir = Math.random() < 0.5 ? -1 : 1;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.corruptTimer > 0) {
            this.corruptTimer -= dt;
            this._corruptClock += dt;
            // Dark motes bleed off the hull while the corruption settles.
            const state = this.game.currentState;
            if (state && state._spawnSparks && Math.random() < 0.35) {
                state._spawnSparks(this.worldX, this.worldY, 1, {
                    color: Math.random() < 0.5 ? CORRUPT_VIOLET : CORRUPT_DARK,
                    speedMin: 20, speedMax: 90
                });
            }
        }
        super.update(dt, player, asteroids, projectiles, enemies);
    }

    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        // Brood orbit: buzz in a loose ring around the sleeping hive.
        if (this.swarming && this.hive && this.hive.alive &&
            this.hive.state === HIVE_STATE.IDLE) {
            this._swarmAngle += this._swarmDir * (0.55 + Math.sin(this._corruptClock * 1.7) * 0.15) * dt;
            const hx = this.hive.worldX + Math.cos(this._swarmAngle) * this._swarmR;
            const hy = this.hive.worldY + Math.sin(this._swarmAngle) * this._swarmR;
            this.state = AI_STATE.REPOSITION; // fast, no fire
            this.targetAngleOverride = Math.atan2(hy - this.worldY, hx - this.worldX);
            this._corruptClock += dt;
            return;
        }
        if (this.swarming) { this.swarming = false; this.dormant = false; }

        // Birth scatter: bolt away from the spawn point, wobbling, then engage.
        if (this.birthFleeTimer > 0) {
            this.birthFleeTimer -= dt;
            this.state = AI_STATE.BREAK; // fast, no fire
            this.targetAngleOverride = this.birthFleeAngle + Math.sin(this._corruptClock * 9) * 0.4;
            this._corruptClock += dt;
            return;
        }
        super._updateAIState(dt, dist, angleToPlayer, player, enemies, distMult);
    }

    // Shooting at the brood wakes the whole nest.
    hit(damage) {
        if (this.swarming && this.hive && this.hive.aggro) this.hive.aggro();
        return super.hit(damage);
    }

    // All swarm projectiles are yellow — mirror the base loadouts onto the
    // yellow laser-ball sprites (beam picks are remapped at roll time).
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
        // Shared farm cap: once 60 locusts have paid out, the rest die dry —
        // debris and dust, no scrap/exp/items.
        if (this.hive && this.hive.lootBudget <= 0) {
            const spawns = this._generateProceduralDebris();
            for (let i = 0; i < 3; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));
            return spawns;
        }
        if (this.hive) this.hive.lootBudget--;
        return super.getSpawnOnDeath();
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        if (this.corruptTimer > 0 && this.img) {
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const t = this.corruptTimer;
            // Dark aura: a violet glow ghost pulsing fast under the hull.
            const glow = Enemy.getGlowSprite(this.img, this.spriteKey, CORRUPT_GLOW);
            const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
            const pxScale = w / glow.srcW;
            const gw = glow.canvas.width * pxScale;
            const gh = glow.canvas.height * pxScale;
            ctx.save();
            ctx.globalAlpha = Math.min(1, t) * (0.45 + 0.4 * Math.abs(Math.sin(this._corruptClock * 24)));
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
            ctx.restore();

            // The hull itself flickers in — dropout frames read as the ship
            // strobing into existence.
            if (Math.random() < 0.22 * Math.min(1, t + 0.4)) return;
            const prevAlpha = ctx.globalAlpha;
            ctx.globalAlpha = 0.45 + 0.55 * (1 - Math.min(1, t)) + 0.25 * Math.abs(Math.sin(this._corruptClock * 31));
            super.draw(ctx, camera);
            ctx.globalAlpha = prevAlpha;
            return;
        }
        super.draw(ctx, camera);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SwarmMother — the queen. A huge, slow hulk whose wings beat like a bug's
// (independent, super-fast loop over a slow body animation). She avoids the
// player, vacuums up scrap like the scavengers — and every couple of pieces
// she swallows becomes a new locust. Periodically she charges, and she spits
// fans of seeking yellow bile. Everything she does routes through the hive's
// shared caps.
// ─────────────────────────────────────────────────────────────────────────────
export class SwarmMother extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0, hive = null) {
        super(game, worldX, worldY, difficultyScale);

        this.hive = hive;
        this.displayName = 'The Mother';
        this.isSwarmMother = true;
        this.noDespawn = true;         // leashed to the hive, not the player

        // Hitbox/silhouette source: the body gif's first frame (frame objects
        // share the {canvas,width,height} shape of static assets).
        const bodyGif = game.assets.get('mother_idle');
        this.img = (bodyGif && bodyGif.length) ? bodyGif[0] : this.img;
        this.spriteKey = 'mother_idle';
        // The wings span most of the 384px sheet; the hittable body is the
        // core. Fitted-ellipse lookup falls back to this circle.
        this.radius = 92;

        // Boss-tier pool, slow hulk stats. Post-Yellow One scaling is linear.
        this.health = Math.ceil(2800 + 650 * difficultyScale);
        this.maxHealth = this.health;
        this.baseSpeed = 150;
        this.turnSpeed = 1.6;

        // Scavenger identity: PlayingState vacuums loot into her via
        // captureLoot() exactly like the ScavengerEnemy.
        this.isScavenger = true;
        this.vacuumRange = 260;
        this.heldLoot = [];            // {item, scrap, life:∞} — spent on births
        this._scrapEaten = 0;          // captures since the last birth

        this.indicatorColor = SWARM_YELLOW;

        // Pre-fight: drifts in a lazy orbit around the hive.
        this.dormant = true;
        this._orbitAngle = Math.random() * Math.PI * 2;

        // Behavior
        this.mode = 'roam';            // 'roam' | 'charge'
        this.chargeTimer = 6 + Math.random() * 4;
        this.volleyTimer = 4 + Math.random() * 3;
        this.enraged = false;          // hive destroyed → the mother goes feral
        this._retaliateWindow = 0;     // hive-less fallback for damage births
        this._charge = null;           // {phase:'windup'|'dash', timer, ...}
        this._volley = null;           // {left, acc}
        this._contactHits = new Map(); // per-body touch i-frames
        this._animClock = Math.random() * 10;
        this._sparkAccum = 0;

        // Independent animation clocks: body plays at the gif's own delays,
        // wings hammer at a fixed super-fast rate — bug wings.
        this.bodyFrame = 0;
        this.bodyTimer = 0;
        this.wingFrame = 0;
        this.wingTimer = 0;
        this.wingSpeed = 1;            // multiplier (charges beat harder)

        // Wheels-style staggered death so the queen doesn't pop like chaff.
        this._dying = false;
        this.deathExplosions = null;
        this.deathTimer = 0;
        this.corruptTimer = 1.2;       // she is BORN through the shimmer too
        this._corruptClock = 0;
    }

    freeze(duration) {
        // The queen shrugs off freeze effects, like bosses.
    }

    onCollision(player) {
        // Too much mass to flinch: take the ram damage but never recoil or
        // break state (base would flip to RECOVERY and ruin a charge).
        let damage = 20;
        if (player.shielding && player.shieldCapacitorCount > 0) {
            damage = (20.0 + player.shieldCapacitorCount * 40.0) * (player.lvlShieldDamageMult || 1.0);
        }
        this.hit(damage);
    }

    hit(damage) {
        if (this._dying) return false;
        // Hurting the patrolling queen wakes the whole nest.
        if (this.dormant && this.hive && this.hive.aggro) this.hive.aggro();
        const died = super.hit(damage);
        if (died) {
            // Intercept the pop: play a boss-grade staggered death instead.
            this.alive = true;
            this.health = 0;
            this._startDeath();
            return false;
        }
        // Pain answered with numbers — reinforcements through the shared
        // 1s window (or a local one when she fights without a hive).
        if (!this.dormant) {
            if (this.hive) {
                this.hive.tryRetaliate(this.worldX, this.worldY);
            } else if (this._retaliateWindow <= 0) {
                const state = this.game.currentState;
                if (state && (!state.netSync || state.netSync.isHost) && state._addEnemies) {
                    this._retaliateWindow = 1.0;
                    state._addEnemies([spawnCorruptedLocust(this.game,
                        this.worldX + (Math.random() - 0.5) * 140,
                        this.worldY + (Math.random() - 0.5) * 140,
                        this.difficultyScale, null)]);
                }
            }
        }
        return false;
    }

    // PlayingState pulls loot into us and calls this once a piece lands.
    captureLoot(entity) {
        const state = this.game.currentState;
        if (entity.item) {
            this.heldLoot.push({ item: entity.item, scrap: 0 });
            if (state && state.spawnFloatingText) state.spawnFloatingText(this.worldX, this.worldY, 'CONSUMED', SWARM_YELLOW);
        } else {
            this.heldLoot.push({ item: null, scrap: entity.value || 1 });
            this._scrapEaten++;
        }
        entity.alive = false;
        this.game.sounds.play('type', { volume: 0.35, x: this.worldX, y: this.worldY });

        // Every third mouthful gestates a locust (respecting the shared cap).
        if (this._scrapEaten >= 3) {
            this._scrapEaten = 0;
            this._birthLocust();
        }
    }

    _birthLocust() {
        const state = this.game.currentState;
        if (!state) return;
        if (state.netSync && !state.netSync.isHost) return; // host-authoritative
        if (this.hive && this.hive.activeLocusts() >= MAX_ACTIVE_LOCUSTS) return;

        // Spend three held scrap entries — eaten metal becomes chitin.
        let spent = 0;
        for (let i = this.heldLoot.length - 1; i >= 0 && spent < 3; i--) {
            if (!this.heldLoot[i].item) { this.heldLoot.splice(i, 1); spent++; }
        }

        const ang = Math.random() * Math.PI * 2;
        const lx = this.worldX + Math.cos(ang) * 60;
        const ly = this.worldY + Math.sin(ang) * 60;
        const locust = spawnCorruptedLocust(this.game, lx, ly, this.difficultyScale, this.hive);
        if (this.hive) {
            this.hive.registerLocust(locust);
            this.hive.queueEnemy(locust);
        } else if (state._addEnemies) {
            state._addEnemies([locust]);
        }
    }

    // ─── UPDATE ────────────────────────────────────────────────────────

    update(dt, player, asteroids, projectiles, enemies) {
        if (!this.alive) return;
        this._animClock += dt;
        this._updateAnims(dt);
        this._retaliateWindow = Math.max(0, this._retaliateWindow - dt);

        if (this.corruptTimer > 0) {
            this.corruptTimer -= dt;
            this._corruptClock += dt;
        }

        if (this._dying) {
            this._updateDying(dt);
            return;
        }

        if (this.dormant) {
            // Slow patrol loop around the sleeping hive.
            if (this.hive) {
                this._orbitAngle += 0.1 * dt;
                const tx = this.hive.worldX + Math.cos(this._orbitAngle) * 520;
                const ty = this.hive.worldY + Math.sin(this._orbitAngle) * 520;
                this._steerToward(tx, ty, dt, 90, 0.5);
            }
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;
            return;
        }

        if (this._charge) {
            this._updateCharge(dt, player);
        } else {
            this._updateRoam(dt, player);

            this.chargeTimer -= dt;
            if (this.chargeTimer <= 0) this._startCharge(player);

            this.volleyTimer -= dt;
            if (this.volleyTimer <= 0 && !this._volley) this._startVolley(player);
        }
        if (this._volley) this._updateVolley(dt, player);

        this._updateContact(player);

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // External shoves (tractor effects etc.) bleed off like the base class.
        const externalFriction = Math.pow(0.99, dt * 60);
        this.externalVx *= externalFriction;
        this.externalVy *= externalFriction;
    }

    _updateAnims(dt) {
        const bodyGif = this.game.assets.get('mother_idle');
        if (bodyGif && bodyGif.length) {
            this.bodyTimer += dt * 1000;
            const frame = bodyGif[Math.min(this.bodyFrame, bodyGif.length - 1)];
            if (frame && this.bodyTimer >= (frame.delay || 100)) {
                this.bodyTimer = 0;
                this.bodyFrame = (this.bodyFrame + 1) % bodyGif.length;
            }
        }
        const wingGif = this.game.assets.get('mother_wings');
        if (wingGif && wingGif.length) {
            // Bug wings: a fixed hammering cadence, NOT the gif's stored delays.
            this.wingTimer += dt * 1000 * this.wingSpeed;
            if (this.wingTimer >= 26) {
                this.wingTimer = 0;
                this.wingFrame = (this.wingFrame + 1) % wingGif.length;
            }
        }
    }

    // Accelerate toward a point with a speed cap; also eases the facing angle.
    _steerToward(tx, ty, dt, maxV, accelMult = 1.0) {
        const dx = tx - this.worldX, dy = ty - this.worldY;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        this.vx += (dx / d) * 380 * accelMult * dt;
        this.vy += (dy / d) * 380 * accelMult * dt;
        const vel = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (vel > maxV) {
            this.vx = (this.vx / vel) * maxV;
            this.vy = (this.vy / vel) * maxV;
        }
        // Face where she's going (slow, ponderous turn).
        if (vel > 20) {
            const want = Math.atan2(this.vy, this.vx);
            let diff = want - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);
        }
    }

    // Roam: shy of the player, hungry for scrap, leashed loosely to the hive.
    _updateRoam(dt, player) {
        const pdx = this.worldX - player.worldX;
        const pdy = this.worldY - player.worldY;
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy) || 1;

        // Find the nearest scrap worth chasing.
        const state = this.game.currentState;
        let target = null, bestD = 1600 * 1600;
        if (state && state.scrapEntities) {
            for (const s of state.scrapEntities) {
                if (!s.alive) continue;
                const dx = s.worldX - this.worldX, dy = s.worldY - this.worldY;
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; target = s; }
            }
        }

        let tx, ty, maxV = 170;
        if (target) {
            tx = target.worldX; ty = target.worldY; maxV = 230; // dinner bell
        } else if (this.hive && this.hive.alive && this.hive.state !== HIVE_STATE.BROKEN) {
            // Loiter in a wide orbit around the hive.
            this._orbitAngle += 0.14 * dt;
            tx = this.hive.worldX + Math.cos(this._orbitAngle) * 640;
            ty = this.hive.worldY + Math.sin(this._orbitAngle) * 640;
        } else {
            // Hive gone: circle the player at distance, feral.
            this._orbitAngle += 0.22 * dt;
            tx = player.worldX + Math.cos(this._orbitAngle) * 820;
            ty = player.worldY + Math.sin(this._orbitAngle) * 820;
        }
        this._steerToward(tx, ty, dt, maxV, 1.0);

        // Personal space: she avoids the player unless she's charging.
        if (pDist < 480) {
            const push = (480 - pDist) * 2.2;
            this.vx += (pdx / pDist) * push * dt;
            this.vy += (pdy / pDist) * push * dt;
        }

        // Leash: never strays far from the nest while it stands.
        if (this.hive && this.hive.alive && this.hive.state !== HIVE_STATE.BROKEN) {
            const hdx = this.worldX - this.hive.worldX;
            const hdy = this.worldY - this.hive.worldY;
            const hd = Math.sqrt(hdx * hdx + hdy * hdy) || 1;
            if (hd > 2400) {
                this.vx -= (hdx / hd) * 420 * dt;
                this.vy -= (hdy / hd) * 420 * dt;
            }
        }
    }

    // ─── ATTACK: charge ────────────────────────────────────────────────

    _startCharge(player) {
        const diff = this.difficultyScale;
        const tele = Math.max(0.5, 1 - (diff - 1) * 0.1);
        this._charge = {
            phase: 'windup',
            timer: 0,
            windupDur: (this.enraged ? 0.6 : 0.85) * tele,
            dashDur: 1.05,
            dashSpeed: 1150 + diff * 70 + (this.enraged ? 180 : 0)
        };
        this.wingSpeed = 2.6;
        this.game.sounds.play('railgun_target', { volume: 0.55, x: this.worldX, y: this.worldY });
    }

    _updateCharge(dt, player) {
        const a = this._charge;
        a.timer += dt;
        const state = this.game.currentState;

        if (a.phase === 'windup') {
            // Brake hard, swing the bow onto the player, wings screaming.
            const brake = Math.pow(0.85, dt * 60);
            this.vx *= brake;
            this.vy *= brake;
            const want = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
            let diff = want - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), 5.5 * dt);

            // Corruption gathers at the mandibles — the tell is DARK, not bright.
            this._sparkAccum += dt;
            if (state && state._spawnSparks && this._sparkAccum > 0.05) {
                this._sparkAccum = 0;
                const ga = Math.random() * Math.PI * 2;
                state._spawnSparks(
                    this.worldX + Math.cos(ga) * 110, this.worldY + Math.sin(ga) * 110, 2,
                    { dir: ga + Math.PI, spread: 0.25, color: Math.random() < 0.5 ? CORRUPT_VIOLET : CORRUPT_DARK, speedMin: 200, speedMax: 380 });
            }

            if (a.timer >= a.windupDur) {
                a.phase = 'dash';
                a.timer = 0;
                const lead = 0.15;
                const ddx = player.worldX + (player.vx || 0) * lead - this.worldX;
                const ddy = player.worldY + (player.vy || 0) * lead - this.worldY;
                const dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
                this.vx = (ddx / dl) * a.dashSpeed;
                this.vy = (ddy / dl) * a.dashSpeed;
                this.angle = Math.atan2(this.vy, this.vx);
                this.game.sounds.play('boost', { volume: 0.9, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.2);
                if (state && state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 170, dur: 0.4, width: 4 });
                }
            }
            return;
        }

        // Dash: heavy mass carries — gentle bleed, ember wake off the wings.
        const drag = Math.pow(0.985, dt * 60);
        this.vx *= drag;
        this.vy *= drag;
        this._sparkAccum += dt;
        if (state && state._spawnSparks && this._sparkAccum > 0.04) {
            this._sparkAccum = 0;
            const va = Math.atan2(this.vy, this.vx);
            state._spawnSparks(
                this.worldX - Math.cos(va) * 90 + (Math.random() - 0.5) * 120,
                this.worldY - Math.sin(va) * 90 + (Math.random() - 0.5) * 120,
                2, { dir: va + Math.PI, spread: 0.7, color: Math.random() < 0.6 ? SWARM_AMBER : CORRUPT_VIOLET, speedMin: 120, speedMax: 320 });
        }

        if (a.timer >= a.dashDur) {
            this._charge = null;
            this.wingSpeed = 1;
            this.chargeTimer = (this.enraged ? 4.5 : 7) + Math.random() * 3;
        }
    }

    // ─── ATTACK: seeking volley ────────────────────────────────────────

    _startVolley(player) {
        const diff = this.difficultyScale;
        this._volley = {
            left: Math.min(7, 4 + Math.floor(diff / 2) + (this.enraged ? 1 : 0)),
            acc: 0
        };
        this.wingSpeed = 1.8;
        this.game.sounds.play('railgun_target', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    _updateVolley(dt, player) {
        const v = this._volley;
        v.acc += dt;
        const state = this.game.currentState;
        while (v.acc >= 0.09 && v.left > 0) {
            v.acc -= 0.09;
            v.left--;
            if (state) {
                const bodies = state.getPlayerBodies ? state.getPlayerBodies() : [player];
                const target = bodies.length ? bodies[Math.floor(Math.random() * bodies.length)] : player;
                const base = Math.atan2(target.worldY - this.worldY, target.worldX - this.worldX);
                const fan = base + (Math.random() - 0.5) * 1.6;
                const dmg = 12 + 3 * this.difficultyScale;
                const proj = new Projectile(this.game,
                    this.worldX + Math.cos(fan) * 70, this.worldY + Math.sin(fan) * 70,
                    fan, 470, 'yellow_laser_ball_big', this, dmg, 4.0);
                proj.target = target;
                proj.turnRate = 0.8 + Math.random() * 0.3;
                this.pendingProjectiles.push(proj);
                if (state.cinematics && v.left % 2 === 0) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 60, dur: 0.25, width: 2 });
                }
            }
            this.game.sounds.play('laser', { volume: 0.35, x: this.worldX, y: this.worldY });
        }
        if (v.left <= 0) {
            this._volley = null;
            if (!this._charge) this.wingSpeed = 1;
            this.volleyTimer = (this.enraged ? 3.2 : 4.5) + Math.random() * 2.5;
        }
    }

    // Contact: brushing the queen stings; being under a charge is a wound.
    _updateContact(player) {
        const state = this.game.currentState;
        if (!state) return;
        const dashing = this._charge && this._charge.phase === 'dash';
        const diff = this.difficultyScale;
        const dmg = dashing ? Math.min(70, 38 + 5 * diff) : Math.round((38 + 5 * diff) * 0.45);
        const bodies = (!state.netSync && state.localPlayers && state.localPlayers.length > 1)
            ? state.localPlayers.map(s => s.player).filter(p => p && !p.dead)
            : (state.player && !state.player.dead ? [state.player] : []);
        for (const body of bodies) {
            const last = this._contactHits.get(body) || -10;
            if (this._animClock - last < 0.9) continue;
            if (!ellipseContains(this, body.worldX, body.worldY, body.radius)) continue;
            this._contactHits.set(body, this._animClock);
            if (state.damagePlayerBody) state.damagePlayerBody(body, dmg, this.worldX, this.worldY);
            else state._damagePlayer(dmg, this.worldX, this.worldY);
            if (state._applyKnockback) {
                const kdx = body.worldX - this.worldX;
                const kdy = body.worldY - this.worldY;
                state._applyKnockback(kdx, kdy, Math.sqrt(kdx * kdx + kdy * kdy), dashing ? 380 : 220, body);
            }
            this.game.camera.shake(dashing ? 1.3 : 0.7);
            this.game.sounds.play('hit', { volume: 0.7, x: this.worldX, y: this.worldY });
        }
    }

    // ─── DEATH ─────────────────────────────────────────────────────────

    _startDeath() {
        this._dying = true;
        this._charge = null;
        this._volley = null;
        this.wingSpeed = 3.2;          // wings scream until they stop
        this.vx *= 0.2;
        this.vy *= 0.2;

        const staggers = [0, 0.35, 0.6, 0.85, 1.05, 1.3, 1.5];
        this.deathExplosions = [];
        for (let i = 0; i < staggers.length; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = Math.random() * 85;
            const { key, totalDuration } = pickFireExplosion(this.game.assets);
            this.deathExplosions.push({
                lx: Math.cos(ang) * r,
                ly: Math.sin(ang) * r,
                delay: staggers[i],
                fired: false, finished: false, animTimer: 0,
                fireKey: key, totalDuration,
                scale: 1.0 + Math.random() * 0.9
            });
        }
        this.deathTimer = staggers[staggers.length - 1] + 0.7;
    }

    _updateDying(dt) {
        // Falling out of the sky: drifts, shuddering, wings sputtering out.
        this.wingSpeed = Math.max(0.3, this.wingSpeed - dt * 1.3);
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.deathTimer -= dt;
        for (const ex of this.deathExplosions) {
            if (!ex.fired) {
                ex.delay -= dt;
                if (ex.delay <= 0) {
                    ex.fired = true;
                    this.game.sounds.play('ship_explode', { volume: 0.6, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(1.8);
                }
            } else if (!ex.finished) {
                ex.animTimer += dt * 1000;
                if (ex.animTimer >= ex.totalDuration) ex.finished = true;
            }
        }
        if (this.deathTimer <= 0) {
            this.alive = false;
            this.game.camera.shake(4.0);
            const state = this.game.currentState;
            if (state) {
                if (state.triggerFlash) state.triggerFlash(SWARM_YELLOW, 0.9, 0.4);
                if (state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 380, dur: 0.8, width: 6 });
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: CORRUPT_VIOLET, maxR: 250, dur: 0.6, width: 4 });
                }
                if (state._onEntityDestroyed) state._onEntityDestroyed(this);
            }
            if (this.game.achievements) {
                this.game.achievements.notify('boss_defeated', { bossId: 'SwarmMother' });
            }
        }
    }

    getSpawnOnDeath() {
        const spawns = [];
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        // Shatter the queen along fracture lines.
        if (this.img) {
            const fragments = getCachedShatter(this.img, 'mother_idle', 70);
            for (const frag of fragments) {
                const cosA = Math.cos(this.angle + Math.PI / 2);
                const sinA = Math.sin(this.angle + Math.PI / 2);
                const wx = this.worldX + (frag.lx * cosA - frag.ly * sinA);
                const wy = this.worldY + (frag.lx * sinA + frag.ly * cosA);
                const outAngle = Math.atan2(wy - this.worldY, wx - this.worldX);
                const spread = 40 + Math.random() * 120;
                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag,
                    Math.cos(outAngle) * spread, Math.sin(outAngle) * spread,
                    this.angle + Math.PI / 2, (Math.random() - 0.5) * 5,
                    3.5 + Math.random() * 2.0
                ));
            }
        }

        const state = this.game.currentState;
        const scrapMult = (state && state.netScrapMult) || 1.0;
        const diff = this.difficultyScale;

        // Give back what she swallowed (plus interest), like the scavengers.
        let swallowed = 0;
        for (const e of this.heldLoot) {
            if (e.item) spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, e.item));
            else swallowed += e.scrap;
        }
        const bigScrap = Math.round((4 + rand() * 2) * scrapMult);
        const smallScrap = Math.round((6 + rand() * 4 + swallowed * 0.4) * scrapMult);
        for (let i = 0; i < bigScrap; i++) {
            const ang = Math.random() * Math.PI * 2, d = Math.random() * 100;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'big'));
        }
        for (let i = 0; i < smallScrap; i++) {
            const ang = Math.random() * Math.PI * 2, d = Math.random() * 90;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'small'));
        }
        const expAmount = Math.floor(16 + 3 * diff);
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const batteryData = UPGRADES.find(u => u.id === 'small_battery');
        if (batteryData && rand() < 0.8) {
            spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, batteryData));
        }
        if (rand() < 0.5) {
            const pool = UPGRADES.filter(u => (u.rarity === 'rare' || u.rarity === 'uncommon') && !u.consumable);
            if (pool.length > 0) {
                const pick = pool[Math.floor(rand() * pool.length)];
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, pick));
            }
        }
        return spawns;
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    _frameOf(key, idx) {
        const gif = this.game.assets.get(key);
        if (!gif || !gif.length) return null;
        return gif[Math.min(idx, gif.length - 1)];
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const ws = this.game.worldScale;
        const cullPad = 500 * ws;
        if (screen.x < -cullPad || screen.x > this.game.width + cullPad ||
            screen.y < -cullPad || screen.y > this.game.height + cullPad) return;

        const bodyFrame = this._frameOf('mother_idle', this.bodyFrame);
        const wingFrame = this._frameOf('mother_wings', this.wingFrame);

        // Corruption arrival shimmer (same language as the locust births).
        let corruptDropout = false;
        if (this.corruptTimer > 0) {
            corruptDropout = Math.random() < 0.18;
        }

        ctx.save();
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);

        // Windup shiver: the whole hulk trembles at the top of the coil.
        if (this._charge && this._charge.phase === 'windup') {
            ctx.translate(Math.sin(this._animClock * 55) * 2.0 * ws, Math.cos(this._animClock * 47) * 1.6 * ws);
        }
        if (this.corruptTimer > 0) {
            ctx.globalAlpha = 0.5 + 0.5 * (1 - Math.min(1, this.corruptTimer)) + 0.2 * Math.abs(Math.sin(this._corruptClock * 26));
        }

        // Wings first (they beat UNDER the body), hammering independently.
        if (wingFrame && !corruptDropout) {
            const img = wingFrame.canvas || wingFrame;
            const w = (wingFrame.width || img.width) * ws;
            const h = (wingFrame.height || img.height) * ws;
            // At high wing speed, a ghost of the previous frame doubles the blur.
            if (this.wingSpeed > 1.5) {
                const prev = this._frameOf('mother_wings',
                    (this.wingFrame + 4) % 5);
                if (prev) {
                    ctx.globalAlpha *= 0.45;
                    ctx.drawImage(prev.canvas || prev, -w / 2, -h / 2, w, h);
                    ctx.globalAlpha /= 0.45;
                }
            }
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
        if (bodyFrame && !corruptDropout) {
            const img = bodyFrame.canvas || bodyFrame;
            const w = (bodyFrame.width || img.width) * ws;
            const h = (bodyFrame.height || img.height) * ws;
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
        ctx.restore();

        // Death explosions ride on top of the hulk.
        if (this._dying && this.deathExplosions) {
            ctx.save();
            ctx.translate(screen.x, screen.y);
            for (const ex of this.deathExplosions) {
                if (!ex.fired || ex.finished) continue;
                const frameImg = fireExplosionFrame(this.game.assets.get(ex.fireKey), ex.animTimer);
                if (!frameImg) continue;
                const ew = (frameImg.width || frameImg.canvas.width / 4) * ws * ex.scale;
                const eh = (frameImg.height || frameImg.canvas.height / 4) * ws * ex.scale;
                ctx.drawImage(frameImg.canvas || frameImg,
                    ex.lx * ws - ew / 2, ex.ly * ws - eh / 2, ew, eh);
            }
            ctx.restore();
        }
    }
}

// Shared birth ritual: a locust arrives through a burst of darkness. A short
// invulnerability beat covers the moment of arrival (base Enemy.hit absorbs
// shots and the contact loop skips it while invulnTimer runs), and the birth
// flee (set below) carries it clear of the spawn point before it turns to
// fight — so fresh spawns scatter instead of getting merc'd on the doorstep.
export function spawnCorruptedLocust(game, x, y, difficultyScale, hive) {
    const locust = new LocustEnemy(game, x, y, difficultyScale, hive);
    locust.invulnTimer = 0.5;
    locust.birthFleeTimer = 0.7 + Math.random() * 0.5;
    locust.birthFleeAngle = Math.random() * Math.PI * 2;
    const state = game.currentState;
    // Locusts can roll the standard seeded upgrade path; beam picks are
    // remapped so every swarm projectile stays yellow.
    if (state && state.player) {
        Enemy.rollUpgrade(locust, state.player);
        if (locust.upgradeType === 'beam') {
            locust.upgradeType = 'multishot';
            locust.selectedUpgrades = locust.selectedUpgrades.map(u => u === 'beam' ? 'multishot' : u);
        }
    }
    if (state) {
        if (state.cinematics) {
            state.cinematics.spawnRing(x, y, { color: CORRUPT_VIOLET, maxR: 90, dur: 0.45, width: 3 });
            state.cinematics.spawnRing(x, y, { color: CORRUPT_DARK, maxR: 55, dur: 0.35, width: 4 });
        }
        if (state._spawnSparks) {
            state._spawnSparks(x, y, 10, { color: CORRUPT_VIOLET, speedMin: 60, speedMax: 260 });
            state._spawnSparks(x, y, 6, { color: CORRUPT_DARK, speedMin: 40, speedMax: 180 });
        }
    }
    game.sounds.play('shield_break', { volume: 0.25, x, y });
    return locust;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hive — the fourth post-Yellow One boss: not a duelist but a BASE. A colossal
// chitin asteroid with an enormous health pool that chips and fractures like
// rock (FractureModel), continuously birthing locusts, guarded by the Mother.
// Leaving its shadow while it stands invokes FAMINE — a ramping health drain
// that herds the player back into the fight. The encounter only ends when the
// hive, the mother, and every remaining locust are destroyed.
// ─────────────────────────────────────────────────────────────────────────────
export class Hive {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.alive = true;
        this.state = HIVE_STATE.IDLE;
        this.radius = 112;
        this.rotation = Math.random() * Math.PI * 2;

        this.spriteKey = 'hive';       // no fitted ellipse → circular, like rock
        this.assetKey = 'hive';
        this.displayName = 'The Hive';
        this.isBoss = false;           // encounter wrap-up is handled manually
        this.revealed = false;
        this.discovered = false;
        this.isFinished = false;

        // Throwaway pre-fight pool; the real one is rolled at fight start.
        this.health = 50;
        this.maxHealth = 50;
        this.invulnerable = false;     // shooting the sleeping hive wakes it
        this.fightStarted = false;

        if (game.rng) {
            const d = game.rng.deriveEntity('enemies');
            this.contentRng = d.rng;
        } else {
            this.contentRng = null;
        }

        // The swarm's shared books.
        this.mother = null;
        this.locusts = [];
        this.lootBudget = LOCUST_LOOT_BUDGET;
        this._queue = [];               // drained by popEnemies (host/SP adds)
        this._broodSpawned = false;

        // Locust production line.
        this.spawnTimer = 5.0;
        this._birthTelegraph = 0;      // hive contraction before a birth
        this._retaliateWindow = 0;     // hive/mother damage → reinforcements (1/s)

        // Famine bookkeeping (per local pilot body).
        this._famine = new Map();      // body → seconds spent starving
        this._famineTick = 0;
        this._famineWarnCooldown = 0;

        // Cosmetics
        this._animClock = Math.random() * 10;
        this._moteAccum = 0;
        this._hitFlash = 0;

        // Death sequence
        this.deathExplosions = null;
        this.deathTimer = 0;
    }

    // ─── SMALL HELPERS ─────────────────────────────────────────────────

    get isActive() {
        // The swarm fight is anchored here — freeze ambient spawning nearby.
        return this.state === HIVE_STATE.FIGHT || this.state === HIVE_STATE.DYING ||
            this.state === HIVE_STATE.BROKEN;
    }

    get isAttackable() {
        return this.state === HIVE_STATE.FIGHT;
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

    activeLocusts() {
        return this.locusts.length + this._queue.length;
    }

    registerLocust(locust) {
        this.locusts.push(locust);
    }

    queueEnemy(en) {
        this._queue.push(en);
    }

    popEnemies() {
        if (this._queue.length === 0) return this._queue;
        const out = this._queue;
        this._queue = [];
        return out;
    }

    popSpawns() {
        return [];
    }

    // External aggro (a shot landing on the sleeping brood or hive).
    aggro() {
        if (this.state === HIVE_STATE.IDLE) this._startFight();
    }

    // Damage retaliation: hurting the hive OR the Mother squeezes out a fresh
    // locust (the swarm answers pain with numbers). Rate-limited to one per
    // second through the shared window so sustained fire doesn't flood the cap.
    tryRetaliate(x, y) {
        if (!this._isAuthority()) return;
        if (this._retaliateWindow > 0) return;
        if (this.state !== HIVE_STATE.FIGHT && this.state !== HIVE_STATE.BROKEN) return;
        if (this.activeLocusts() >= MAX_ACTIVE_LOCUSTS) return;
        this._retaliateWindow = 1.75;
        const ang = Math.random() * Math.PI * 2;
        const locust = spawnCorruptedLocust(this.game,
            x + Math.cos(ang) * 70, y + Math.sin(ang) * 70,
            this._diff(), this);
        this.registerLocust(locust);
        this.queueEnemy(locust);
    }

    // ─── UPDATE ────────────────────────────────────────────────────────

    update(dt, player) {
        if (!this.alive || this.state === HIVE_STATE.FINISHED) return;
        this._animClock += dt;
        this._hitFlash = Math.max(0, this._hitFlash - dt);
        this._retaliateWindow = Math.max(0, this._retaliateWindow - dt);
        this.rotation += 0.025 * dt;   // near-imperceptible drift of the rock

        // Prune the books.
        for (let i = this.locusts.length - 1; i >= 0; i--) {
            if (!this.locusts[i].alive) this.locusts.splice(i, 1);
        }
        if (this.mother && !this.mother.alive) this.mother = null;

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (!this.revealed && dist < 3500) this.revealed = true;

        switch (this.state) {
            case HIVE_STATE.IDLE:
                // The player closes in: manifest the brood + the Mother.
                if (!this._broodSpawned && dist < 3400 && this._isAuthority()) {
                    this._spawnBrood();
                }
                if (dist < 1400) this._startFight();
                break;

            case HIVE_STATE.FIGHT:
                this._updateProduction(dt);
                this._updateFamine(dt);
                this._updateAmbience(dt);
                break;

            case HIVE_STATE.DYING:
                this._updateFamine(dt);
                this._updateDying(dt);
                break;

            case HIVE_STATE.BROKEN:
                // The nest is rubble — the remnant swarm is all that's left.
                if (!this.mother && this.locusts.length === 0 && this._queue.length === 0) {
                    this._finishEncounter();
                }
                break;
        }
    }

    _spawnBrood() {
        this._broodSpawned = true;
        const diff = this._diff();

        // The Mother rises with her nest.
        const mAng = Math.random() * Math.PI * 2;
        this.mother = new SwarmMother(this.game,
            this.worldX + Math.cos(mAng) * 420,
            this.worldY + Math.sin(mAng) * 420, diff, this);
        this.queueEnemy(this.mother);

        // Ten locusts pre-spawned in a slow swarm around the hive.
        for (let i = 0; i < BROOD_SIZE; i++) {
            const ang = (i / BROOD_SIZE) * Math.PI * 2 + Math.random() * 0.5;
            const r = 190 + Math.random() * 150;
            const locust = spawnCorruptedLocust(this.game,
                this.worldX + Math.cos(ang) * r,
                this.worldY + Math.sin(ang) * r, diff, this);
            locust.swarming = true;
            locust.dormant = true;
            locust._swarmAngle = ang;
            locust._swarmR = r;
            this.registerLocust(locust);
            this.queueEnemy(locust);
        }
    }

    _startFight() {
        if (this.fightStarted) return;
        this.state = HIVE_STATE.FIGHT;
        this.fightStarted = true;

        const diff = this._diff();
        this.health = 5200 + 1200 * diff;   // an asteroid with a TON of health
        this.maxHealth = this.health;

        // Late brood (e.g. dev-spawned right on top of the player).
        if (!this._broodSpawned && this._isAuthority()) this._spawnBrood();

        // Wake the nest.
        if (this.mother) this.mother.dormant = false;
        for (const l of this.locusts) { l.swarming = false; l.dormant = false; }

        this.game.sounds.playSpecificMusic('Pit of Locusts');
        this.game.sounds.play('shield_break', { volume: 0.7, x: this.worldX, y: this.worldY });
        this.game.camera.shake(2.0);

        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash(SWARM_YELLOW, 0.9, 0.35);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 320, dur: 0.8, width: 5 });
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: CORRUPT_VIOLET, maxR: 210, dur: 0.6, width: 4 });
            }
            if (state._spawnSparks) {
                state._spawnSparks(this.worldX, this.worldY, 22, { color: SWARM_AMBER, speedMin: 160, speedMax: 520 });
                state._spawnSparks(this.worldX, this.worldY, 12, { color: CORRUPT_VIOLET, speedMin: 100, speedMax: 380 });
            }
        }
    }

    // The production line: the hive contracts, then squeezes out fresh locusts.
    _updateProduction(dt) {
        if (!this._isAuthority()) return;

        if (this._birthTelegraph > 0) {
            this._birthTelegraph -= dt;
            // Dark motes stream INTO the hive while it contracts.
            const state = this.game.currentState;
            if (state && state._spawnSparks && Math.random() < 0.6) {
                const ga = Math.random() * Math.PI * 2;
                state._spawnSparks(
                    this.worldX + Math.cos(ga) * 170, this.worldY + Math.sin(ga) * 170, 2,
                    { dir: ga + Math.PI, spread: 0.2, color: Math.random() < 0.5 ? CORRUPT_VIOLET : CORRUPT_DARK, speedMin: 220, speedMax: 400 });
            }
            if (this._birthTelegraph <= 0) this._birthLocusts();
            return;
        }

        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
            if (this.activeLocusts() < MAX_ACTIVE_LOCUSTS) {
                this._birthTelegraph = 0.6;
                this.game.sounds.play('railgun_target', { volume: 0.3, x: this.worldX, y: this.worldY });
            }
            const diff = this._diff();
            this.spawnTimer = Math.max(6.0, 10.5 - diff * 0.5) + Math.random() * 3.0;
        }
    }

    _birthLocusts() {
        const diff = this._diff();
        const n = 1 + (Math.random() < Math.min(0.5, 0.2 + diff * 0.05) ? 1 : 0);
        for (let i = 0; i < n; i++) {
            if (this.activeLocusts() >= MAX_ACTIVE_LOCUSTS) break;
            const ang = Math.random() * Math.PI * 2;
            const r = this.radius * 0.8;
            const locust = spawnCorruptedLocust(this.game,
                this.worldX + Math.cos(ang) * r,
                this.worldY + Math.sin(ang) * r, diff, this);
            this.registerLocust(locust);
            this.queueEnemy(locust);
        }
        this.game.camera.shake(0.5);
    }

    // FAMINE: stray too far from the standing hive and your ship starves — a
    // slow drain that ramps toward lethal, herding the player back in range.
    _updateFamine(dt) {
        const state = this.game.currentState;
        if (!state) return;
        this._famineWarnCooldown = Math.max(0, this._famineWarnCooldown - dt);
        this._famineTick += dt;
        const tick = this._famineTick >= 0.4;
        if (tick) this._famineTick = 0;

        for (const body of this._bodies()) {
            const dx = body.worldX - this.worldX;
            const dy = body.worldY - this.worldY;
            const outside = (dx * dx + dy * dy) > FAMINE_RADIUS * FAMINE_RADIUS;
            let t = this._famine.get(body) || 0;

            if (!outside) {
                if (t > 0) this._famine.set(body, 0);
                continue;
            }

            if (t === 0 && this._famineWarnCooldown <= 0) {
                this._famineWarnCooldown = 14;
                if (state.cinematics && state.cinematics.announce) {
                    state.cinematics.announce('FAMINE', 'THE HIVE MUST BE DESTROYED', FAMINE_COLOR);
                }
                if (this.game.sounds.playKlaxon) this.game.sounds.playKlaxon();
            }

            t += dt;
            this._famine.set(body, t);

            // Sickly shimmer builds as the starvation deepens.
            if (state._spawnSparks && Math.random() < Math.min(0.5, t * 0.04)) {
                state._spawnSparks(body.worldX, body.worldY, 1, {
                    color: FAMINE_COLOR, speedMin: 20, speedMax: 80
                });
            }

            if (tick) {
                // Gentle at first (time to turn around), inexorable after.
                const dps = 1.5 + Math.min(28, t * 1.4);
                const dmg = dps * 0.4;
                if (state.damagePlayerBody) state.damagePlayerBody(body, dmg, body.worldX, body.worldY);
                else state._damagePlayer(dmg, body.worldX, body.worldY);
                if (state.spawnFloatingText && Math.random() < 0.4) {
                    state.spawnFloatingText(body.worldX, body.worldY - 30, 'FAMINE', FAMINE_COLOR);
                }
                if (state.triggerFlash && Math.random() < 0.5) {
                    state.triggerFlash('#1a1400', 0.25, 0.2);
                }
            }
        }
    }

    // Idle menace: motes drifting off the combs, an occasional deep pulse.
    _updateAmbience(dt) {
        const state = this.game.currentState;
        if (!state || !state._spawnSparks) return;
        this._moteAccum += dt;
        if (this._moteAccum > 0.22) {
            this._moteAccum = 0;
            const ga = Math.random() * Math.PI * 2;
            const r = this.radius * (0.5 + Math.random() * 0.5);
            state._spawnSparks(
                this.worldX + Math.cos(ga) * r, this.worldY + Math.sin(ga) * r,
                1, {
                    dir: ga, spread: 0.6,
                    color: Math.random() < 0.6 ? SWARM_AMBER : CORRUPT_VIOLET,
                    speedMin: 10, speedMax: 55
                });
        }
    }

    // ─── DAMAGE / DEATH ────────────────────────────────────────────────

    hit(damage) {
        if (this.state === HIVE_STATE.DYING || this.state === HIVE_STATE.BROKEN ||
            this.state === HIVE_STATE.FINISHED) return false;
        if (this.state === HIVE_STATE.IDLE) this._startFight();

        this.health -= damage;
        this._hitFlash = 0.1;

        const state = this.game.currentState;
        if (state && state.spawnFloatingText) {
            state.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, SWARM_YELLOW);
        }
        this.game.sounds.play('hit', { volume: 0.4, x: this.worldX, y: this.worldY });

        // Pain answered with numbers: a fresh locust from the wounded rim.
        this.tryRetaliate(this.worldX, this.worldY);

        if (this.health <= 0) {
            this._triggerDeathSequence();
        }
        return false; // the death sequence reports the kill itself
    }

    freeze(duration) {
        // It's a rock full of bugs. No.
    }

    // Lazily build the hive's persistent fracture layout (asteroid mechanics:
    // chips break off the rim at every hit point).
    _ensureFracture() {
        if (this._fx !== undefined) return this._fx;
        const img = this.game.assets.get('hive');
        const model = img ? FractureModel.get(img, 'hive') : null;
        this._fx = model ? new HullFracture(model) : null;
        return this._fx;
    }

    // Called by PlayingState with the projectile impact point — same per-pixel
    // chip system asteroids use. Cosmetic; the hitbox is unaffected.
    chipHit(hitWorldX, hitWorldY) {
        const fx = this._ensureFracture();
        if (!fx) return [];
        const dx = hitWorldX - this.worldX;
        const dy = hitWorldY - this.worldY;
        const a = -this.rotation;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);
        const count = 1 + (Math.random() < 0.5 ? 1 : 0);
        const cells = fx.chipNear(lx, ly, count);
        const debris = [];
        for (const c of cells) {
            debris.push(ejectChipDebris(this.game, this.worldX, this.worldY, this.rotation, this.vx, this.vy, c));
        }
        if (!cells.length) {
            const c = fx.nearestOuterCell(lx, ly);
            if (c) debris.push(ejectChipDebris(this.game, this.worldX, this.worldY, this.rotation, this.vx, this.vy, c, true));
        }
        return debris;
    }

    _triggerDeathSequence() {
        this.state = HIVE_STATE.DYING;
        this.health = 0;

        const staggers = [0, 0.25, 0.45, 0.7, 0.9, 1.1, 1.3, 1.45, 1.6, 1.8];
        this.deathExplosions = [];
        for (let i = 0; i < staggers.length; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = Math.random() * 95;
            const { key, totalDuration } = pickFireExplosion(this.game.assets);
            this.deathExplosions.push({
                lx: Math.cos(ang) * r,
                ly: Math.sin(ang) * r,
                delay: staggers[i],
                fired: false, finished: false, animTimer: 0,
                fireKey: key, totalDuration,
                scale: 1.0 + Math.random() * 1.0
            });
        }
        this.deathTimer = staggers[staggers.length - 1] + 0.7;

        // The nest screams: the whole remaining swarm enrages.
        if (this.mother) {
            this.mother.enraged = true;
            this.mother.chargeTimer = Math.min(this.mother.chargeTimer, 2.0);
        }
    }

    _updateDying(dt) {
        this.deathTimer -= dt;
        for (const ex of this.deathExplosions) {
            if (!ex.fired) {
                ex.delay -= dt;
                if (ex.delay <= 0) {
                    ex.fired = true;
                    this.game.sounds.play('ship_explode', { volume: 0.65, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(2.2);
                }
            } else if (!ex.finished) {
                ex.animTimer += dt * 1000;
                if (ex.animTimer >= ex.totalDuration) ex.finished = true;
            }
        }

        if (this.deathTimer <= 0) {
            this.game.camera.shake(6.0);
            const state = this.game.currentState;
            if (state) {
                if (state.triggerFlash) state.triggerFlash('#ffffff', 1.2, 0.45);
                if (state.cinematics) {
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ffffff', maxR: 520, dur: 1.0, width: 7 });
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 380, dur: 0.8, width: 5 });
                    state.cinematics.spawnRing(this.worldX, this.worldY, { color: CORRUPT_VIOLET, maxR: 260, dur: 0.6, width: 4 });
                }
                // Deliver the shatter + boss-tier loot through the normal path.
                if (state._onEntityDestroyed) state._onEntityDestroyed(this);
            }
            // The rock is gone but the encounter isn't: remnant swarm cleanup.
            this.state = HIVE_STATE.BROKEN;
            this.radius = 0;           // no hitbox left to hit
            this._famine.clear();      // the anchor is gone; famine lifts
            if (this.game.achievements) {
                this.game.achievements.notify('boss_defeated', { bossId: 'Hive' });
            }
        }
    }

    getSpawnOnDeath() {
        const spawns = [];
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        const asset = this.game.assets.get('hive');
        if (asset) {
            const fragments = getCachedShatter(asset, 'hive', 110);
            for (const frag of fragments) {
                const cosA = Math.cos(this.rotation);
                const sinA = Math.sin(this.rotation);
                const wx = this.worldX + (frag.lx * cosA - frag.ly * sinA);
                const wy = this.worldY + (frag.lx * sinA + frag.ly * cosA);
                const outAngle = Math.atan2(wy - this.worldY, wx - this.worldX);
                const spread = 35 + Math.random() * 120;
                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag,
                    Math.cos(outAngle) * spread, Math.sin(outAngle) * spread,
                    this.rotation, (Math.random() - 0.5) * 4,
                    4.0 + Math.random() * 2.0
                ));
                if (Math.random() < 0.4) {
                    spawns.push(new Scrap(this.game, wx, wy, Math.random() < 0.3 ? 'big' : 'small'));
                }
            }
        }
        for (let i = 0; i < 10; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));

        const diff = this._diff();
        const state = this.game.currentState;
        const scrapMult = (state && state.netScrapMult) || 1.0;

        const expAmount = Math.floor(26 + 5 * diff);
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const bigScrap = Math.round((6 + rand() * 3) * scrapMult);
        for (let i = 0; i < bigScrap; i++) {
            const ang = Math.random() * Math.PI * 2, d = Math.random() * 120;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'big'));
        }
        const smallScrap = Math.round((9 + rand() * 5) * scrapMult);
        for (let i = 0; i < smallScrap; i++) {
            const ang = Math.random() * Math.PI * 2, d = Math.random() * 100;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, 'small'));
        }

        const batteryData = UPGRADES.find(u => u.id === 'small_battery');
        if (batteryData) {
            const batteryCount = 1 + (rand() < 0.6 ? 1 : 0);
            for (let i = 0; i < batteryCount; i++) {
                const ang = Math.random() * Math.PI * 2, d = 30 + Math.random() * 60;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, batteryData));
            }
        }
        if (rand() < 0.6) {
            const pool = UPGRADES.filter(u => (u.rarity === 'rare' || u.rarity === 'uncommon') && !u.consumable);
            if (pool.length > 0) {
                const pick = pool[Math.floor(rand() * pool.length)];
                const ang = Math.random() * Math.PI * 2, d = 40 + Math.random() * 40;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(ang) * d, this.worldY + Math.sin(ang) * d, pick));
            }
        }
        return spawns;
    }

    // The last of the swarm falls: fanfare, cache, music, and the glow points
    // home again. This replaces the automatic isBoss wrap-up because "dead"
    // here means hive AND mother AND every remaining locust.
    _finishEncounter() {
        this.state = HIVE_STATE.FINISHED;
        this.isFinished = true;
        this.alive = false;

        const state = this.game.currentState;
        if (state) {
            if (state.triggerFlash) state.triggerFlash('#ffffff', 0.8, 0.4);
            if (state.cinematics) {
                state.cinematics.spawnRing(this.worldX, this.worldY, { color: SWARM_YELLOW, maxR: 420, dur: 1.0, width: 5 });
                if (state.cinematics.trumpetFanfare) {
                    state.cinematics.trumpetFanfare(this.worldX, this.worldY);
                }
            }
            // Boss-tier cache, like the isBoss path in _onEntityDestroyed.
            if (state.caches && state.cacheSpawner &&
                state.caches.length < CACHE_CONFIG.maxActiveCaches + 2) {
                const cache = state.cacheSpawner.spawnNear(this.worldX, this.worldY, 0, 0);
                state.caches.push(cache);
                if (state.netSync && state.netSync.isHost) state.netSync.registerCache(cache);
            }
            // Restore whatever the music was doing before the pit opened.
            if (state.musicCombatTriggered) {
                this.game.sounds.setTargetState(MUSIC_STATE.COMBAT, true);
            } else {
                this.game.sounds.restoreMusic();
            }
            // End of the glow chain (for now) — point the way home again.
            for (const body of state.getPlayerBodies ? state.getPlayerBodies() : [state.player]) {
                if (body && body.hasYellowGlow) body.yellowGlowTarget = { x: 0, y: 0 };
            }
        }
        if (this.game.achievements) {
            this.game.achievements.notify('boss_defeated', { bossId: 'Swarm' });
        }
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    draw(ctx, camera) {
        if (!this.alive) return;
        if (this.state === HIVE_STATE.BROKEN || this.state === HIVE_STATE.FINISHED) return;

        const img = this.game.assets.get('hive');
        if (!img) return;
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const ws = this.game.worldScale;
        let w = img.width * ws;
        let h = img.height * ws;
        if (sx + w < -150 || sx - w > this.game.width + 150 ||
            sy + h < -150 || sy - h > this.game.height + 150) return;

        // Organic breathing; a hard contraction telegraphs each birth.
        let pulse = 1 + Math.sin(this._animClock * (this.state === HIVE_STATE.FIGHT ? 2.2 : 1.1)) * 0.012;
        if (this._birthTelegraph > 0) {
            pulse -= 0.05 * Math.sin((0.6 - this._birthTelegraph) / 0.6 * Math.PI);
        }
        if (this.state === HIVE_STATE.DYING) {
            pulse += Math.sin(this._animClock * 30) * 0.02; // convulsing
        }
        w *= pulse;
        h *= pulse;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(this.rotation);
        if (this._hitFlash > 0) {
            ctx.shadowBlur = 18 * ws;
            ctx.shadowColor = SWARM_YELLOW;
        }
        // Chipped combs: draw the composited sprite once cells have broken off.
        const src = (this._fx && this._fx.count > 0) ? this._fx.composite(img) : (img.canvas || img);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, -w / 2, -h / 2, w, h);
        ctx.restore();

        if (this.state === HIVE_STATE.DYING && this.deathExplosions) {
            ctx.save();
            ctx.translate(sx, sy);
            for (const ex of this.deathExplosions) {
                if (!ex.fired || ex.finished) continue;
                const frameImg = fireExplosionFrame(this.game.assets.get(ex.fireKey), ex.animTimer);
                if (!frameImg) continue;
                const ew = (frameImg.width || frameImg.canvas.width / 4) * ws * ex.scale;
                const eh = (frameImg.height || frameImg.canvas.height / 4) * ws * ex.scale;
                ctx.drawImage(frameImg.canvas || frameImg,
                    ex.lx * ws - ew / 2, ex.ly * ws - eh / 2, ew, eh);
            }
            ctx.restore();
        }
    }
}
