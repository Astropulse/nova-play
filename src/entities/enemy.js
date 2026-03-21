// Scaling is now dynamic via game properties
import { Projectile } from './projectile.js';
import { Scrap, Rubble, ItemPickup, ProceduralDebris, VoronoiSlicer } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';

const AI_STATE = {
    PURSUIT: 'pursuit',   // Move toward player
    ATTACK: 'attack',     // Point and fire
    BREAK: 'break',       // Short turn to reposition
    REVERSAL: 'reversal', // Hard loop back when chased
    RECOVERY: 'recovery'  // Boost away after collision
};

const RADIUS_CACHE = {};

class CollisionScanner {
    static getRadius(img, game) {
        if (!img) return 20 * (game ? game.worldScale : 1);
        const src = img.src;
        if (RADIUS_CACHE[src]) return RADIUS_CACHE[src];

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);

        const data = ctx.getImageData(0, 0, img.width, img.height).data;
        const cx = img.width / 2;
        const cy = img.height / 2;
        let maxDistSq = 0;

        for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
                if (data[(y * img.width + x) * 4 + 3] > 25) {
                    const dx = x - cx;
                    const dy = y - cy;
                    const dSq = dx * dx + dy * dy;
                    if (dSq > maxDistSq) maxDistSq = dSq;
                }
            }
        }
        const radius = Math.sqrt(maxDistSq); // Native pixels
        RADIUS_CACHE[src] = radius;
        return radius;
    }
}

export class Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = 0;
        this.vy = 0;
        this.angle = Math.random() * Math.PI * 2;
        this.alive = true;
        this.difficultyScale = difficultyScale;

        const variant = Math.floor(Math.random() * 5);
        this.spriteKey = `enemy_ship_${variant}`;
        this.img = game.assets.get(this.spriteKey);

        this.isUpgraded = false;
        this.upgradeType = null;
        this.selectedUpgrades = [];
        this.isTargeting = false;
        this.beamTimer = 0;
        this.beamChargeTime = 1.0;
        this.activeBeams = [];

        // Stats - Scale with difficulty
        const speedScale = 1 + (difficultyScale - 1) * 0.15;
        const turnScale = 1 + (difficultyScale - 1) * 0.1;
        this.baseSpeed = (500 + Math.random() * 80) * speedScale;
        this.turnSpeed = (6.5 + Math.random() * 1.0) * turnScale;
        this.health = Math.ceil(2 + 1.5 * difficultyScale);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.game);
        this.radius = this._nativeRadius * this.game.worldScale * 0.95;

        // AI - Tactical State Machine
        this.state = AI_STATE.PURSUIT;
        this.stateTimer = 0;
        this.targetAngleOverride = 0;
        this.invulnTimer = 0;
        this.freezeTimer = 0;

        // Ranges
        this.attackRange = 500 * game.worldScale;
        this.breakRange = 450 * game.worldScale; // Veer off distance — needs to be large enough to turn in time
        this.reversalTriggerDist = 350 * game.worldScale;

        // Attack pass: fire a burst during charge, then veer off
        this.attackPassCount = 0;     // 0 = first approach (normal), 1+ = dive attacks
        this.burstShotsLeft = 0;
        this.burstShotsMax = 2 + Math.floor(Math.random() * 2); // 2-3 shots per pass

        // Shooting
        this.shootTimer = 0.5 + Math.random() * 0.5;

        this.fireRateMult = 1.0;
        this.speedMult = 1.0;
        this.damageMult = 1.0;

        this.pendingProjectiles = [];
        this.externalVx = 0;
        this.externalVy = 0;
    }

    _applyUpgrades() {
        if (this.isUpgraded) return;
        this.isUpgraded = true;
        const roll = Math.random();

        if (roll < 0.4) {
            // Stats Path (40%)
            const options = ['health', 'speed', 'firerate'];
            const count = Math.random() < 0.5 ? 1 : 2;
            for (let i = 0; i < count; i++) {
                const choice = options.splice(Math.floor(Math.random() * options.length), 1)[0];
                this.selectedUpgrades.push(choice);
                if (choice === 'health') this.health = Math.ceil(this.health * 1.5);
                if (choice === 'speed') this.speedMult = 1.4;
                if (choice === 'firerate') this.fireRateMult = 1.4;
            }
            this.upgradeType = 'stats';
        } else if (roll < 0.8) {
            // Weapon Path (40%)
            const weaponOptions = ['bigBall', 'beam', 'multishot'];
            this.upgradeType = weaponOptions[Math.floor(Math.random() * weaponOptions.length)];
            this.selectedUpgrades.push(this.upgradeType);
        } else {
            // Kamikaze Path (20%)
            this.upgradeType = 'kamikaze';
            this.selectedUpgrades.push('kamikaze');
            this.speedMult = 2.0;
            this.attackRange = -1;
        }
    }

    update(dt, player, asteroids, projectiles, enemies) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angleToPlayer = Math.atan2(dy, dx);

        // 1. Tactical State Updates
        this.invulnTimer = Math.max(0, this.invulnTimer - dt);
        this.freezeTimer = Math.max(0, this.freezeTimer - dt);

        if (this.freezeTimer > 0) {
            this.vx = 0;
            this.vy = 0;
            return; // Skip movement/rotation when frozen
        }

        this._updateAIState(dt, dist, angleToPlayer, player, enemies);

        // 2. Determine Target Angle
        let targetAngle = this._getTargetAngle(angleToPlayer, dist);

        // 3. Environmental Avoidance Override
        targetAngle = this._avoidObstacles(targetAngle, asteroids, projectiles, enemies);

        // 4. Coupled Steering
        let angleDiff = targetAngle - this.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        this.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), this.turnSpeed * dt);

        // 5. COUPLED PHYSICS: Movement is strictly forward
        let currentMaxSpeed = this.baseSpeed;
        if (this.state === AI_STATE.RECOVERY) {
            currentMaxSpeed = this.baseSpeed * 2.5; // Emergency boost
        } else if (this.state === AI_STATE.BREAK) {
            currentMaxSpeed = this.baseSpeed * 1.3; // Retreat fast
        } else if (this.state === AI_STATE.ATTACK && this.attackPassCount === 0) {
            // First engagement: slow down to shoot normally
            const closeFactor = Math.max(0.3, Math.min(0.6, dist / this.attackRange));
            currentMaxSpeed = this.baseSpeed * closeFactor;
        } else if (dist > 1500 * this.game.worldScale) {
            const boostFactor = Math.min(3.0, 1.0 + (dist - 1500 * this.game.worldScale) / (2000 * this.game.worldScale));
            currentMaxSpeed *= boostFactor;
        }
        // ATTACK pass 1+: full base speed dive

        this.vx = Math.cos(this.angle) * currentMaxSpeed * this.speedMult + this.externalVx;
        this.vy = Math.sin(this.angle) * currentMaxSpeed * this.speedMult + this.externalVy;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Dampen external forces
        this.externalVx *= 0.99;
        this.externalVy *= 0.99;

        // 6. Combat — shoot only during attack runs
        if (this.state === AI_STATE.ATTACK) {
            this.shootTimer -= dt;
            if (this.shootTimer <= 0 && dist < this.attackRange) {
                const shootDiff = angleToPlayer - this.angle;
                const absDiff = Math.abs(Math.atan2(Math.sin(shootDiff), Math.cos(shootDiff)));
                if (absDiff < 0.5) {
                    if (this.upgradeType === 'beam') {
                        if (!this.isTargeting) {
                            this.isTargeting = true;
                            this.beamTimer = this.beamChargeTime;
                            this.game.sounds.play('railgun_target', { volume: 0.4, x: this.worldX, y: this.worldY });
                        }
                    } else {
                        this.shoot();
                        this.burstShotsLeft--;
                        const cooldownScale = Math.max(0.3, 1.0 / (1 + (this.difficultyScale - 1) * 0.25)) / this.fireRateMult;
                        this.shootTimer = (0.25 + Math.random() * 0.35) * cooldownScale;
                    }
                }
            }

            if (this.isTargeting) {
                this.beamTimer -= dt;
                if (this.beamTimer <= 0) {
                    this.isTargeting = false;
                    this.shoot();
                    const cooldownScale = Math.max(0.3, 1.0 / (1 + (this.difficultyScale - 1) * 0.25)) / this.fireRateMult;
                    this.shootTimer = (1.0 + Math.random() * 0.5) * cooldownScale;
                }
            }
        } else {
            this.shootTimer = Math.max(this.shootTimer, 0.15);
            this.isTargeting = false;
        }

        // Update active beams visuals
        if (this.activeBeams) {
            for (let i = this.activeBeams.length - 1; i >= 0; i--) {
                this.activeBeams[i].timer -= dt;
                if (this.activeBeams[i].timer <= 0) this.activeBeams.splice(i, 1);
            }
        }
    }

    _updateAIState(dt, dist, angleToPlayer, player, enemies) {
        this.stateTimer -= dt;

        // Detection: Is the player tailing/chasing me?
        // (Player is close AND player is behind me AND player is looking at me)
        const angleDiffToPlayer = angleToPlayer - this.angle;
        const absDiff = Math.abs(Math.atan2(Math.sin(angleDiffToPlayer), Math.cos(angleDiffToPlayer)));
        const playerIsBehind = absDiff > 2.2; // roughly 120-130 degrees behind

        if (playerIsBehind && dist < this.reversalTriggerDist && this.state !== AI_STATE.REVERSAL && this.state !== AI_STATE.RECOVERY) {
            // Check if player is actually pointing at us
            const playerToEnemyAngle = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
            const playerFacingDiff = playerToEnemyAngle - player.angle;
            const playerLookingAtMe = Math.abs(Math.atan2(Math.sin(playerFacingDiff), Math.cos(playerFacingDiff))) < 0.5;

            if (playerLookingAtMe) {
                this.state = AI_STATE.REVERSAL;
                this.stateTimer = 0.8 + Math.random() * 0.4;
                return;
            }
        }

        switch (this.state) {
            case AI_STATE.PURSUIT:
                // Charge at the player — transition to ATTACK when in range
                if (dist < this.attackRange) {
                    this.state = AI_STATE.ATTACK;
                    this.burstShotsLeft = this.burstShotsMax;
                    this.shootTimer = 0.1;
                }
                break;

            case AI_STATE.ATTACK:
                // First pass: use smaller break range (they're moving slower)
                // Subsequent passes: use full breakRange (they're diving fast)
                const effectiveBreakRange = this.attackPassCount === 0 ? 200 * this.game.worldScale : this.breakRange;
                if (dist < effectiveBreakRange) {
                    this._startVeerOff(angleToPlayer);
                } else if (dist > this.attackRange + 200 * this.game.worldScale) {
                    // Overshot or player moved — go back to pursuit
                    this.state = AI_STATE.PURSUIT;
                }
                break;

            case AI_STATE.BREAK:
                // Retreating — when timer expires, turn back for another charge
                if (this.stateTimer <= 0) {
                    this.state = AI_STATE.PURSUIT;
                }
                break;

            case AI_STATE.REVERSAL:
                if (this.stateTimer <= 0) {
                    this.state = AI_STATE.PURSUIT;
                }
                break;

            case AI_STATE.RECOVERY:
                if (this.stateTimer <= 0) {
                    this.state = AI_STATE.PURSUIT;
                }
                break;
        }

        if (this.upgradeType === 'kamikaze') {
            this.state = AI_STATE.PURSUIT;
        }
    }

    _startVeerOff(angleToPlayer) {
        this.attackPassCount++;
        this.state = AI_STATE.BREAK;
        this.stateTimer = 1.2 + Math.random() * 0.8; // Retreat duration before charging again
        // Veer sharply to the side (perpendicular) to avoid hitting the player
        const side = Math.random() > 0.5 ? 1 : -1;
        const veerAngle = angleToPlayer + (Math.PI / 2) * side + (Math.random() - 0.5) * 0.4;
        this.targetAngleOverride = veerAngle;
    }

    _getTargetAngle(angleToPlayer, dist) {
        switch (this.state) {
            case AI_STATE.PURSUIT:
            case AI_STATE.ATTACK:
            case AI_STATE.REVERSAL:
                return angleToPlayer; // Always charge straight at the player
            case AI_STATE.BREAK:
            case AI_STATE.RECOVERY:
                return this.targetAngleOverride;
            default:
                return angleToPlayer;
        }
    }

    _avoidObstacles(baseTarget, asteroids, projectiles, enemies) {
        let finalTarget = baseTarget;
        const scanDist = 160 * this.game.worldScale;

        // Avoid Asteroids
        for (const ast of asteroids) {
            const adx = ast.worldX - this.worldX;
            const ady = ast.worldY - this.worldY;
            const adist = Math.sqrt(adx * adx + ady * ady);

            if (adist < scanDist + ast.radius) {
                const angleToAst = Math.atan2(ady, adx);
                let diff = angleToAst - this.angle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;

                if (Math.abs(diff) < 1.2) { // Slightly wider check for asteroids
                    const steerSide = diff > 0 ? -1 : 1;
                    const steerIntensity = (1 - adist / (scanDist + ast.radius)) * 2.0;
                    finalTarget += steerSide * (Math.PI / 3) * steerIntensity;
                }
            }
        }

        // Avoid Other Enemies
        const enemyAvoidDist = 120 * this.game.worldScale;
        for (const other of enemies) {
            if (other === this || !other.alive) continue;
            const edx = other.worldX - this.worldX;
            const edy = other.worldY - this.worldY;
            const edist = Math.sqrt(edx * edx + edy * edy);

            if (edist < enemyAvoidDist) {
                const angleToOther = Math.atan2(edy, edx);
                let diff = angleToOther - this.angle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;

                const steerSide = diff > 0 ? -1 : 1;
                const steerIntensity = (1 - edist / enemyAvoidDist) * 1.5;
                finalTarget += steerSide * (Math.PI / 4) * steerIntensity;
            }
        }

        for (const p of projectiles) {
            if (p.owner !== this && p.alive) {
                const pdx = p.worldX - this.worldX;
                const pdy = p.worldY - this.worldY;
                const pdist = Math.sqrt(pdx * pdx + pdy * pdy);

                // Only dodge lasers if there is enough space (don't freak out when player is close)
                const playerDist = this.game.currentState.player ?
                    Math.sqrt(Math.pow(this.game.currentState.player.worldX - this.worldX, 2) + Math.pow(this.game.currentState.player.worldY - this.worldY, 2)) :
                    Infinity;

                if (pdist < 400 * this.game.worldScale && playerDist > 450 * this.game.worldScale) {
                    const pvx = p.vx;
                    const pvy = p.vy;
                    const pSpeed = Math.sqrt(pvx * pvx + pvy * pvy);
                    const dot = (pvx * -pdx + pvy * -pdy) / ((pSpeed * pdist) || 1);
                    if (dot > 0.94) { // Slightly tighter dodge requirement
                        const perpX = -pvy;
                        const perpY = pvx;
                        const side = Math.sign(pdx * perpX + pdy * perpY) || 1;
                        finalTarget = Math.atan2(perpY * side, perpX * side);
                        break;
                    }
                }
            }
        }
        return finalTarget;
    }

    shoot() {
        if (this.upgradeType === 'kamikaze') return;

        const laserSpeed = 1900;
        const noseOffset = 30 * this.game.worldScale;
        const px = this.worldX + Math.cos(this.angle) * noseOffset;
        const py = this.worldY + Math.sin(this.angle) * noseOffset;
        let damage = (1 + (this.difficultyScale - 1) * 0.5) * this.damageMult;

        if (this.upgradeType === 'bigBall') {
            const proj = new Projectile(this.game, px, py, this.angle, laserSpeed * 0.8, 'red_laser_ball_big', this, damage * 1.5);
            this.pendingProjectiles.push(proj);
            this.game.sounds.play('laser', { volume: 0.4, x: px, y: py });
        } else if (this.upgradeType === 'multishot') {
            const count = 3;
            const spread = 0.3; // ~17 degrees total
            for (let i = 0; i < count; i++) {
                const angleOffset = (i - (count - 1) / 2) * (spread / (count - 1));
                const proj = new Projectile(this.game, px, py, this.angle + angleOffset, laserSpeed, 'red_laser_ball', this, damage * 0.7);
                this.pendingProjectiles.push(proj);
            }
            this.game.sounds.play('laser', { volume: 0.3, x: px, y: py });
        } else if (this.upgradeType === 'beam') {
            this._fireBeam(px, py, damage * 2.5);
        } else {
            // Default shot
            const spread = 0.08;
            const spreadAngle = this.angle + (Math.random() - 0.5) * spread;
            const proj = new Projectile(this.game, px, py, spreadAngle, laserSpeed, 'red_laser_ball', this, damage);
            this.pendingProjectiles.push(proj);
            this.game.sounds.play('laser', { volume: 0.2, x: px, y: py });
        }
    }

    _fireBeam(startX, startY, damage) {
        const dirX = Math.cos(this.angle);
        const dirY = Math.sin(this.angle);
        const length = 2000 * this.game.worldScale;

        // Visual
        this.activeBeams.push({
            x: startX,
            y: startY,
            angle: this.angle,
            timer: 0.2
        });

        // Hitscan logic vs Player
        const player = this.game.currentState.player;
        if (player) {
            // Simplified hitscan check for enemy beams
            const dx = player.worldX - startX;
            const dy = player.worldY - startY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < length) {
                const dot = (dx * dirX + dy * dirY) / dist;
                if (dot > 0.99) { // Very narrow beam
                    const cross = Math.abs(dx * dirY - dy * dirX);
                    if (cross < player.radius) {
                        this.game.currentState._damagePlayer(damage);
                        this.game.sounds.play('hit', { volume: 0.5, x: player.worldX, y: player.worldY });
                    }
                }
            }
        }
        this.game.sounds.play('railgun_shoot', { volume: 0.6, x: startX, y: startY });
    }

    hit(damage) {
        if (this.invulnTimer > 0) return false;
        this.health -= damage;
        if (this.health <= 0) {
            this.alive = false;
            return true;
        }
        return false;
    }

    freeze(duration) {
        this.freezeTimer = Math.max(this.freezeTimer, duration);
        this.vx = 0;
        this.vy = 0;
    }

    onCollision(playerX, playerY) {
        this.hit(1);
        if (!this.alive) return;

        this.state = AI_STATE.RECOVERY;
        this.stateTimer = 1.0;
        this.invulnTimer = 1.0;

        // Steer away from player
        const angleAway = Math.atan2(this.worldY - playerY, this.worldX - playerX);
        this.targetAngleOverride = angleAway + (Math.random() - 0.5) * 0.5;
        this.game.sounds.play('boost', { volume: 0.3, x: this.worldX, y: this.worldY });
    }

    _generateProceduralDebris() {
        if (!this.img || !this.img.width) return [];

        // 10-15 organic shards for enemies
        const numPieces = 10 + Math.floor(Math.random() * 6);
        const shards = VoronoiSlicer.slice(this.img, numPieces);
        const debris = [];

        for (const shard of shards) {
            const cosA = Math.cos(this.angle + Math.PI / 2);
            const sinA = Math.sin(this.angle + Math.PI / 2);

            // Transform local fragment offset to world space
            const worldOffX = (shard.offsetX * cosA - shard.offsetY * sinA) * this.game.worldScale;
            const worldOffY = (shard.offsetX * sinA + shard.offsetY * cosA) * this.game.worldScale;

            const outAngle = Math.atan2(worldOffY, worldOffX);
            const spread = 60 + Math.random() * 80;
            const vx = this.vx * 0.4 + Math.cos(outAngle) * spread;
            const vy = this.vy * 0.4 + Math.sin(outAngle) * spread;

            debris.push(new ProceduralDebris(
                this.game,
                this.worldX + worldOffX,
                this.worldY + worldOffY,
                shard.canvas,
                vx, vy,
                this.angle + Math.PI / 2,
                (Math.random() - 0.5) * 8
            ));
        }
        return debris;
    }

    getSpawnOnDeath() {
        const spawns = this._generateProceduralDebris();
        const count = 3 + Math.floor(Math.random() * 3);
        for (let i = 0; i < count; i++) spawns.push(new Scrap(this.game, this.worldX, this.worldY));
        for (let i = 0; i < 4; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));

        // 20% chance to drop a small battery
        if (Math.random() < 0.20) {
            const battery = UPGRADES.find(u => u.id === 'small_battery');
            if (battery) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, battery));
            }
        }

        if (Math.random() < 0.01) {
            const locator = UPGRADES.find(u => u.id === 'advanced_locator');
            if (locator) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, locator));
            }
        }

        return spawns;
    }

    draw(ctx, camera) {
        if (!this.img || !this.alive) return;

        // Flicker if invulnerable
        if (this.invulnTimer > 0 && Math.floor(Date.now() / 50) % 2 === 0) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));

        // Visual distinction for upgraded enemies: Subtle red glow
        if (this.isUpgraded) {
            ctx.shadowBlur = 15 * this.game.worldScale;
            ctx.shadowColor = '#ff4444';
        }

        ctx.rotate(this.angle + Math.PI / 2);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);

        ctx.restore();

        // Draw targeting line for beam
        if (this.isTargeting) {
            const targetImg = this.game.assets.get('red_laser_beam_targeting');
            if (targetImg) {
                ctx.save();
                ctx.globalAlpha = 0.5;
                ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
                ctx.rotate(this.angle);
                const tileW = targetImg.width * this.game.worldScale;
                const tileH = targetImg.height * this.game.worldScale;
                for (let i = 0; i < 30; i++) {
                    ctx.drawImage(targetImg, i * tileW, -tileH / 2, tileW, tileH);
                }
                ctx.restore();
            }
        }

        // Draw active beams visuals
        if (this.activeBeams.length > 0) {
            const beamImg = this.game.assets.get('red_laser_beam');
            if (beamImg) {
                for (const beam of this.activeBeams) {
                    ctx.save();
                    ctx.globalAlpha = beam.timer / 0.2;
                    ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
                    ctx.rotate(beam.angle);
                    const tileW = beamImg.width * this.game.worldScale;
                    const tileH = beamImg.height * this.game.worldScale;
                    for (let i = 0; i < 40; i++) {
                        ctx.drawImage(beamImg, i * tileW, -tileH / 2, tileW, tileH);
                    }
                    ctx.restore();
                }
            }
        }
    }

    static rollUpgrade(enemy, player) {
        if (!player || !player.inventory) return;
        const chance = player.inventory.items.length * 0.03;
        if (Math.random() < chance) {
            enemy._applyUpgrades();
        }
    }
}

export class EnemySpawner {
    constructor(game) {
        this.game = game;

        // Burst spawning state machine
        this.phase = 'peace';       // 'peace' or 'burst'
        this.phaseTimer = 8;        // Initial short peace before first encounter
        this.burstQueue = 0;        // How many enemies left to spawn in this burst
        this.burstSpawnTimer = 0;   // Timer between individual spawns within a burst

        // Wave stagger queue
        this.waveQueue = 0;         // Enemies remaining to spawn from a wave
        this.waveSpawnTimer = 0;    // Timer between staggered wave spawns
        this.waveDelay = 0;         // Delay before the FIRST enemy of a wave spawns
        this.waveSpawnScale = 1.0;  // Difficulty at time wave was triggered
        this.waveNumber = 0;        // Tracks which wave we're on
    }

    update(dt, playerX, playerY, difficultyScale = 1.0) {
        const spawned = [];
        const player = this.game.currentState.player;

        // --- Drain wave stagger queue first ---
        if (this.waveQueue > 0) {
            // Initial delay before first spawn to separate from wave-start effects
            if (this.waveDelay > 0) {
                this.waveDelay -= dt;
                return [];
            }

            this.waveSpawnTimer -= dt;
            if (this.waveSpawnTimer <= 0) {
                this.waveQueue--;
                // Stagger spawns 1.5-3s apart
                this.waveSpawnTimer = 1.5 + Math.random() * 1.5;

                const angle = Math.random() * Math.PI * 2;
                // Spawn further out so they arrive staggered (1800-2400)
                const dist = 1800 + Math.random() * 600;
                const en = new Enemy(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, this.waveSpawnScale);
                Enemy.rollUpgrade(en, player);
                spawned.push(en);
            }
            return spawned;  // Don't run ambient burst spawns during a wave
        }

        // --- Ambient burst spawning ---
        this.phaseTimer -= dt;

        if (this.phase === 'peace') {
            if (this.phaseTimer <= 0) {
                // Peace is over — start a burst
                this.phase = 'burst';
                // 1-3 enemies per burst, scaling with difficulty
                this.burstQueue = Math.floor(1 + Math.random() * Math.min(3, 1 + difficultyScale * 0.5));
                this.burstSpawnTimer = 0; // First enemy spawns immediately
                this.phaseTimer = 12 + Math.random() * 6; // Burst window ~12-18s
            }
            return [];
        }

        // Burst phase: spawn enemies at staggered intervals
        if (this.burstQueue > 0) {
            this.burstSpawnTimer -= dt;
            if (this.burstSpawnTimer <= 0) {
                this.burstQueue--;
                // Stagger spawns 3-6s apart within the burst
                this.burstSpawnTimer = 3 + Math.random() * 3;

                const angle = Math.random() * Math.PI * 2;
                const dist = 1400 + Math.random() * 600;
                const en = new Enemy(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale);
                Enemy.rollUpgrade(en, player);
                spawned.push(en);
            }
        }

        // Burst window expired or all enemies spawned
        if (this.phaseTimer <= 0 || this.burstQueue <= 0) {
            this.phase = 'peace';
            // Peace lasts 30-50s, shortens slightly with difficulty (floor 20s)
            const basePeace = 30 + Math.random() * 20;
            this.phaseTimer = Math.max(20, basePeace / (1 + (difficultyScale - 1) * 0.15));
        }

        return spawned;
    }

    spawnWave(playerX, playerY, difficultyScale = 1.0) {
        this.waveNumber++;
        // First wave: max 3 enemies. Later waves grow with difficulty.
        let count;
        if (this.waveNumber === 1) {
            count = 3;
        } else {
            count = Math.floor(2 + difficultyScale);
        }
        // Queue them for staggered spawning
        this.waveQueue = count;
        this.waveSpawnTimer = 0; // First enemy spawns after initial delay
        this.waveDelay = 0.5;    // Give the flash/hud half a second to breathe
        this.waveSpawnScale = difficultyScale;
        // Return empty — enemies will be spawned via update() over time
        return [];
    }
}

export class KamikazeEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        // Custom stats for kamikaze
        const speedScale = 1 + (difficultyScale - 1) * 0.15;
        this.baseSpeed = (1000 + Math.random() * 100) * speedScale;
        this.turnSpeed = 7.0 + Math.random() * 1.0;
        // Moderate health, slightly tougher than standard enemies but not sponges
        this.health = Math.ceil(3 + 1.5 * difficultyScale);

        // Disable shooting
        this.attackRange = -1; // Never enter ATTACK state based on distance
    }

    shoot() {
        // Do nothing, they don't shoot
    }

    _updateAIState(dt, dist, angleToPlayer, player) {
        this.state = AI_STATE.PURSUIT; // Always chase
    }

    getSpawnOnDeath() {
        // Use inherited procedural debris
        const spawns = this._generateProceduralDebris();
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) spawns.push(new Scrap(this.game, this.worldX, this.worldY));
        for (let i = 0; i < 4; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));

        if (Math.random() < 0.01) {
            const locator = UPGRADES.find(u => u.id === 'advanced_locator');
            if (locator) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, locator));
            }
        }

        return spawns;
    }

    draw(ctx, camera) {
        if (!this.img || !this.alive) return;

        // Flicker if invulnerable
        if (this.invulnTimer > 0 && Math.floor(Date.now() / 50) % 2 === 0) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle + Math.PI / 2);
        // Kamikaze are standard sprites
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}

export class CthulhuEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        // Selection of Cthulhu-specific sprites
        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `cthulhu_ship_${variant}`;
        this.img = game.assets.get(this.spriteKey);

        // Custom stats for cthulhu enemies (similar to kamikaze)
        const speedScale = 1 + (difficultyScale - 1) * 0.15;
        this.baseSpeed = (1000 + Math.random() * 100) * speedScale;
        this.turnSpeed = 7.0 + Math.random() * 1.0;
        this.health = Math.ceil(3 + 1.5 * difficultyScale);

        // Disable shooting
        this.attackRange = -1;
    }

    shoot() {
        // Do nothing, they don't shoot
    }

    _updateAIState(dt, dist, angleToPlayer, player) {
        this.state = AI_STATE.PURSUIT; // Always chase
    }

    getSpawnOnDeath() {
        const spawns = this._generateProceduralDebris();
        const count = 1 + Math.floor(Math.random() * 2);
        for (let i = 0; i < count; i++) spawns.push(new Scrap(this.game, this.worldX, this.worldY));
        for (let i = 0; i < 4; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));

        if (Math.random() < 0.01) {
            const locator = UPGRADES.find(u => u.id === 'advanced_locator');
            if (locator) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, locator));
            }
        }

        return spawns;
    }

    draw(ctx, camera) {
        if (!this.img || !this.alive) return;

        if (this.invulnTimer > 0 && Math.floor(Date.now() / 50) % 2 === 0) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle + Math.PI / 2);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}
