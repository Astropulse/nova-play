import { Projectile } from './projectile.js';
import { Scrap, VoronoiSlicer, ProceduralDebris, ItemPickup, Asteroid } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';

export const BOSS_PHASE = {
    INTRO: 'intro',
    ATTACK1: 'attack1',
    ATTACK2: 'attack2'
};

export const BOSS_STATE = {
    IDLE: 'idle',
    REPOSITION: 'reposition',
    DASH: 'dash',
    ATTACKING: 'attacking',
    DYING: 'dying'
};

export class BossWreck {
    constructor(worldX, worldY) {
        this.worldX = worldX;
        this.worldY = worldY;
        this.isFinished = false;
    }
}

export class Boss {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.angle = 0;
        this.alive = true;
        this.difficultyScale = difficultyScale;

        this.phase = BOSS_PHASE.INTRO;
        this.phaseTimer = 2.0; // Intro duration
        this.state = BOSS_STATE.IDLE;
        this.stateTimer = 0;
        this.musicKey = null;

        this.health = 150 * difficultyScale;
        this.maxHealth = this.health;
        this.isBoss = true;
        this.radius = 80;

        this.invulnTimer = 0;
        this.freezeTimer = 0;

        this.pendingProjectiles = [];
        this.activeBeams = [];

        this.targetAngle = 0;
        this.turnSpeed = 2.0;
        this.baseSpeed = 150;

        this.introStarted = false;
    }

    get curvedDifficultyScale() {
        return Math.pow(this.difficultyScale, 0.6);
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.freezeTimer > 0) {
            this.freezeTimer -= dt;
            return;
        }
        if (this.invulnTimer > 0) this.invulnTimer -= dt;

        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angleToPlayer = Math.atan2(dy, dx);

        if (this.phase === BOSS_PHASE.INTRO) {
            this._updateIntro(dt, dist, angleToPlayer);
            return;
        }

        if (this.state === BOSS_STATE.DYING) {
            this._updateDying(dt);
            return;
        }

        // Catch up if too far - "Super Boost"
        let effectiveSpeed = this.baseSpeed;
        if (dist > 1800) {
            // Only 4x boost in Phase 1/Intro, 8x in Phase 2
            const boostMult = (this.phase === BOSS_PHASE.ATTACK2) ? 8 : 4;
            effectiveSpeed = this.baseSpeed * boostMult;
            this.targetAngle = angleToPlayer;
        }

        this._updateAI(dt, player, dist, angleToPlayer);

        // Use effectiveSpeed for movement
        let diff = this.targetAngle - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);

        this.vx = Math.cos(this.angle) * effectiveSpeed;
        this.vy = Math.sin(this.angle) * effectiveSpeed;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        this._updateBeams(dt);

        // Check Phase Transition
        if (this.phase === BOSS_PHASE.ATTACK1 && this.health < this.maxHealth * 0.4) {
            this.phase = BOSS_PHASE.ATTACK2;
            this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });
            this.game.camera.shake(2.0);
        }
    }

    _updateDying(dt) {
        if (!this.alive) return;
        this.deathTimer -= dt;

        for (const ex of this.deathExplosions) {
            if (!ex.fired) {
                ex.delay -= dt;
                if (ex.delay <= 0) {
                    ex.fired = true;
                    this.game.sounds.play('ship_explode', {
                        volume: 0.6,
                        x: this.worldX + ex.lx * this.game.worldScale,
                        y: this.worldY + ex.ly * this.game.worldScale
                    });
                    this.game.camera.shake(3.0);
                }
            } else if (!ex.finished) {
                ex.animTimer += dt * 1000; // Work in ms for GIF delays
                if (ex.animTimer >= ex.totalDuration) {
                    ex.finished = true;
                }
            }
        }

        if (this.deathTimer <= 0) {
            this.game.camera.shake(8.0);
            this.alive = false;
            // Ensure only one death trigger
            if (this.game.currentState && this.game.currentState._onEntityDestroyed) {
                this.game.currentState._onEntityDestroyed(this);

                // Drop a wreck marker for the radar
                if (this.game.currentState.bossWrecks) {
                    this.game.currentState.bossWrecks.push(new BossWreck(this.worldX, this.worldY));
                }
            }
        }
    }


    _updateIntro(dt, dist, angleToPlayer) {
        if (!this.introStarted) {
            this.introStarted = true;
            this.game.sounds.play('boost', { volume: 1.0, x: this.worldX, y: this.worldY });
            this.game.camera.shake(1.5);
        }

        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
            this.phase = BOSS_PHASE.ATTACK1;
        }

        this.angle = angleToPlayer;
    }

    _updateBeams(dt) {
        for (let i = this.activeBeams.length - 1; i >= 0; i--) {
            this.activeBeams[i].timer -= dt;
            if (this.activeBeams[i].timer <= 0) this.activeBeams.splice(i, 1);
        }
    }

    hit(damage) {
        if (this.invulnTimer > 0 || this.phase === BOSS_PHASE.INTRO || this.state === BOSS_STATE.DASH || this.state === BOSS_STATE.DYING) return false;
        this.health -= damage;
        if (this.health <= 0) {
            this._triggerDeathSequence();
            return false; // Not dead yet, playing animation
        }
        return false;
    }

    _triggerDeathSequence() {
        this.state = BOSS_STATE.DYING;
        this.vx = 0; // Stop in place for shattering
        this.vy = 0;

        const img = this.game.assets.get(this.spriteKey);
        if (!img) {
            this.alive = false;
            return;
        }

        const fireFrames = this.game.assets.get('fire_explosion');
        const totalExplosionDuration = fireFrames ? fireFrames.reduce((sum, f) => sum + f.delay, 0) : 500;

        this.deathExplosions = [];
        const numExplosions = 4 + Math.floor(Math.random() * 4);

        // Pacing: single, then burst, then final crescendo
        const baseStaggers = [0, 0.4, 0.7, 0.8, 1.1, 1.2, 1.3, 1.4];

        // Quick scan for solid pixels (sampling)
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;

        const solidPoints = [];
        for (let i = 0; i < 300; i++) {
            const x = Math.floor(Math.random() * img.width);
            const y = Math.floor(Math.random() * img.height);
            const alpha = data[(y * img.width + x) * 4 + 3];
            if (alpha > 50) {
                solidPoints.push({
                    lx: x - img.width / 2,
                    ly: y - img.height / 2
                });
            }
        }

        if (solidPoints.length === 0) solidPoints.push({ lx: 0, ly: 0 });

        for (let i = 0; i < Math.min(numExplosions, baseStaggers.length); i++) {
            const pt = solidPoints[Math.floor(Math.random() * solidPoints.length)];
            this.deathExplosions.push({
                lx: pt.lx,
                ly: pt.ly,
                delay: baseStaggers[i],
                fired: false,
                finished: false,
                animTimer: 0,
                totalDuration: totalExplosionDuration,
                scale: 0.8 + Math.random() * 0.7
            });
        }

        this.deathTimer = baseStaggers[Math.min(numExplosions, baseStaggers.length) - 1] + 0.6;
    }

    freeze(duration) {
        this.freezeTimer = Math.max(this.freezeTimer, duration);
    }

    onCollision(playerX, playerY) {
        // Bosses are massive; they don't recoil like normal enemies, but they take minor impact damage.
        this.hit(0.1);
        this.game.camera.shake(1.0);
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        if (this.phase === BOSS_PHASE.INTRO && Math.floor(Date.now() / 100) % 2 === 0) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const img = this.game.assets.get(this.spriteKey);
        if (!img) return;

        const w = img.width * this.game.worldScale;
        const h = img.height * this.game.worldScale;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle + Math.PI / 2);

        if (this.phase === BOSS_PHASE.ATTACK2) {
            ctx.shadowBlur = 20 * this.game.worldScale;
            ctx.shadowColor = '#ff3300';
        }

        ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);

        // Draw death explosions
        if (this.state === BOSS_STATE.DYING && this.deathExplosions) {
            const fireFrames = this.game.assets.get('fire_explosion');
            if (fireFrames) {
                for (const ex of this.deathExplosions) {
                    if (ex.fired && !ex.finished) {
                        // Find current frame for this specific explosion
                        let frameImg = fireFrames[0].canvas;
                        let elapsed = ex.animTimer;
                        for (const f of fireFrames) {
                            if (elapsed < f.delay) {
                                frameImg = f.canvas;
                                break;
                            }
                            elapsed -= f.delay;
                        }

                        const ew = frameImg.width * this.game.worldScale * ex.scale;
                        const eh = frameImg.height * this.game.worldScale * ex.scale;
                        ctx.drawImage(frameImg, ex.lx * this.game.worldScale - ew / 2, ex.ly * this.game.worldScale - eh / 2, ew, eh);
                    }
                }
            }
        }

        ctx.restore();
    }

    _drawTiledBeam(ctx, x, y, angle, img, alpha, range = 3000) {
        if (!img) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(angle);

        const tileW = img.width * this.game.worldScale;
        const tileH = img.height * this.game.worldScale;
        const count = Math.ceil((range * this.game.worldScale) / tileW);

        for (let i = 0; i < count; i++) {
            ctx.drawImage(img, i * tileW, -tileH / 2, tileW, tileH);
        }
        ctx.restore();
    }

    getSpawnOnDeath() {
        const spawns = [];

        // Shatter effect: use Voronoi seeds to place scrap/rubble
        const img = this.game.assets.get(this.spriteKey);
        if (img) {
            const fragments = VoronoiSlicer.slice(img, Math.floor(80 + Math.random() * 40));
            for (const frag of fragments) {
                const rotationAngle = this.angle + Math.PI / 2;
                const cosA = Math.cos(rotationAngle);
                const sinA = Math.sin(rotationAngle);
                const wx = this.worldX + (frag.offsetX * cosA - frag.offsetY * sinA);
                const wy = this.worldY + (frag.offsetX * sinA + frag.offsetY * cosA);

                // Add the actual shard as drifting debris
                const outAngle = Math.atan2(frag.offsetY, frag.offsetX) + rotationAngle;
                const spread = 40 + Math.random() * 120;
                const vx = this.vx * 0.2 + Math.cos(outAngle) * spread;
                const vy = this.vy * 0.2 + Math.sin(outAngle) * spread;

                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag.canvas,
                    vx, vy,
                    this.angle + Math.PI / 2,
                    (Math.random() - 0.5) * 4,
                    4.0 + Math.random() * 2.0 // Floating for 4-6 seconds
                ));

                // Loot spawning along the fracture lines
                if (Math.random() < 0.5) {
                    spawns.push(new Scrap(this.game, wx, wy, Math.random() < 0.3 ? 'big' : 'small'));
                }
            }
        }

        // Add extra loot spread around (Reduced scrap as requested)
        for (let i = 0; i < 3 + Math.random() * 2; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 100;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, 'big'));
        }
        for (let i = 0; i < 4 + Math.random() * 4; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 80;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, 'small'));
        }

        // --- Special Boss Loot ---
        // 1. Small Batteries (1-2)
        const batteryCount = 1 + (Math.random() < 0.5 ? 1 : 0);
        const batteryData = UPGRADES.find(u => u.id === 'small_battery');
        if (batteryData) {
            for (let i = 0; i < batteryCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 30 + Math.random() * 40;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, batteryData));
            }
        }

        // 2. Advanced Locator (20% chance)
        if (Math.random() < 0.20) {
            const locatorData = UPGRADES.find(u => u.id === 'advanced_locator');
            if (locatorData) {
                const angle = Math.random() * Math.PI * 2;
                const dist = 40 + Math.random() * 30;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, locatorData));
            }
        }

        // 3. Common Upgrade (10% chance)
        if (Math.random() < 0.10) {
            const commonUpgrades = UPGRADES.filter(u => u.rarity === 'common' && !u.consumable);
            if (commonUpgrades.length > 0) {
                const randomUpgrade = commonUpgrades[Math.floor(Math.random() * commonUpgrades.length)];
                const angle = Math.random() * Math.PI * 2;
                const dist = 50 + Math.random() * 20;
                spawns.push(new ItemPickup(this.game, this.worldX + Math.cos(angle) * dist, this.worldY + Math.sin(angle) * dist, randomUpgrade));
            }
        }

        return spawns;
    }

    _updateAI(dt, player, dist, angleToPlayer) {
        // To be implemented by subclasses
    }
}
