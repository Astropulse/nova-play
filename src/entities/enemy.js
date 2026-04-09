// Scaling is now dynamic via game properties
import { Projectile } from './projectile.js';
import { Scrap, Rubble, ItemPickup, ProceduralDebris, VoronoiSlicer } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { Starcore } from './starcore.js';
import { AsteroidCrusher } from './asteroidCrusher.js';

const AI_STATE = {
    PURSUIT: 'pursuit',   // Move toward player
    ATTACK: 'attack',     // Point and fire
    BREAK: 'break',       // Short turn to reposition
    REVERSAL: 'reversal', // Hard loop back when chased
    RECOVERY: 'recovery', // Boost away after collision
    REPOSITION: 'reposition' // Back off to standoff distance
};

const RADIUS_CACHE = {};

class CollisionScanner {
    static getRadius(asset, key) {
        if (!asset) return 20;
        if (key && RADIUS_CACHE[key]) return RADIUS_CACHE[key];

        const img = asset.canvas || asset;
        const aw = asset.width || img.width;
        const ah = asset.height || img.height;

        const canvas = document.createElement('canvas');
        canvas.width = aw;
        canvas.height = ah;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, aw, ah);

        const data = ctx.getImageData(0, 0, aw, ah).data;
        const cx = aw / 2;
        const cy = ah / 2;
        let maxDistSq = 0;

        for (let y = 0; y < ah; y++) {
            for (let x = 0; x < aw; x++) {
                if (data[(y * aw + x) * 4 + 3] > 25) {
                    const dx = x - cx;
                    const dy = y - cy;
                    const dSq = dx * dx + dy * dy;
                    if (dSq > maxDistSq) maxDistSq = dSq;
                }
            }
        }
        const radius = Math.sqrt(maxDistSq); // Native pixels
        if (key) RADIUS_CACHE[key] = radius;
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
        const speedScale = 1 + (difficultyScale - 1) * 0.08;
        const turnScale = 1 + (difficultyScale - 1) * 0.08;
        this.baseSpeed = Math.min(900, (320 + Math.random() * 80) * speedScale);
        this.turnSpeed = Math.min(14.0, (6.5 + Math.random() * 1.0) * turnScale);
        this.health = Math.ceil(15 + 15 * difficultyScale);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // AI - Tactical State Machine
        this.state = AI_STATE.PURSUIT;
        this.stateTimer = 0;
        this.targetAngleOverride = 0;
        this.invulnTimer = 0;
        this.freezeTimer = 0;

        // Ranges
        this.attackRange = 500;
        this.breakRange = 450; // Veer off distance — needs to be large enough to turn in time
        this.reversalTriggerDist = 350;

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

        // Attack Pass Cap
        this.maxAttackPasses = 2 + Math.floor(Math.random() * 2); // 2-3 dive passes before backing off
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
        // Calculate speed first so avoidance can use it for look-ahead
        let currentMaxSpeed = this.baseSpeed;
        if (this.state === AI_STATE.RECOVERY) {
            currentMaxSpeed = this.baseSpeed * 1.8;
        } else if (this.state === AI_STATE.BREAK || this.state === AI_STATE.REPOSITION) {
            currentMaxSpeed = this.baseSpeed * 1.3;
        } else if (this.state === AI_STATE.ATTACK && this.attackPassCount === 0) {
            const closeFactor = Math.max(0.3, Math.min(0.6, dist / this.attackRange));
            currentMaxSpeed = this.baseSpeed * closeFactor;
        } else if (dist > 1500) {
            const boostFactor = Math.min(3.0, 1.0 + (dist - 1500) / (2000));
            currentMaxSpeed *= boostFactor;
        }
        const activeSpeed = currentMaxSpeed * this.speedMult;

        const avoidance = this._avoidObstacles(targetAngle, asteroids, projectiles, enemies, activeSpeed);
        targetAngle = avoidance.targetAngle;
        const speedOverride = avoidance.speedOverride;

        // 4. Coupled Steering
        let angleDiff = targetAngle - this.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

        this.angle += Math.sign(angleDiff) * Math.min(Math.abs(angleDiff), this.turnSpeed * dt);

        // 5. COUPLED PHYSICS: Movement is strictly forward
        if (speedOverride !== null) {
            currentMaxSpeed = speedOverride;
        }

        this.vx = Math.cos(this.angle) * currentMaxSpeed * this.speedMult + this.externalVx;
        this.vy = Math.sin(this.angle) * currentMaxSpeed * this.speedMult + this.externalVy;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Dampen external forces (dt-compensated)
        const externalFriction = Math.pow(0.99, dt * 60);
        this.externalVx *= externalFriction;
        this.externalVy *= externalFriction;

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
                // Stay in attack until burst is done OR we get very close
                // Hostile encounters are slightly more aggressive but still break for safety
                const breakMult = this.isHostileEncounter ? 1.8 : 2.5;
                const minBreakDist = this.radius * breakMult + 50;
                const burstDone = this.burstShotsLeft <= 0;
                const tooClose = dist < minBreakDist;

                const breakThreshold = burstDone ? (this.breakRange * 0.7) : minBreakDist;

                if (dist < breakThreshold || tooClose) {
                    if (this.attackPassCount >= this.maxAttackPasses) {
                        this._startReposition(angleToPlayer);
                    } else {
                        this._startVeerOff(angleToPlayer);
                    }
                } else if (dist > this.attackRange + 400) {
                    this.state = AI_STATE.PURSUIT;
                }
                break;

            case AI_STATE.REPOSITION:
                if (this.stateTimer <= 0 || dist > 600) {
                    this.attackPassCount = 0; // Reset counter after backing off
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
        this.stateTimer = 0.8 + Math.random() * 1.0;

        // Standard Veer: reposition to the side
        const side = Math.random() > 0.5 ? 1 : -1;
        const veerAngle = angleToPlayer + (Math.PI / 1.8) * side + (Math.random() - 0.5) * 0.5;
        this.targetAngleOverride = veerAngle;
    }

    _startReposition(angleToPlayer) {
        this.state = AI_STATE.REPOSITION;
        this.stateTimer = 2.5 + Math.random() * 1.5; // Longer standoff period

        // Face away from player to move to standoff distance
        const awayAngle = angleToPlayer + Math.PI + (Math.random() - 0.5) * 1.0;
        this.targetAngleOverride = awayAngle;
    }

    _getTargetAngle(angleToPlayer, dist) {
        switch (this.state) {
            case AI_STATE.PURSUIT:
            case AI_STATE.ATTACK:
            case AI_STATE.REVERSAL:
                return angleToPlayer;
            case AI_STATE.BREAK:
            case AI_STATE.RECOVERY:
            case AI_STATE.REPOSITION:
                return this.targetAngleOverride;
            default:
                return angleToPlayer;
        }
    }

    _avoidObstacles(baseTarget, asteroids, projectiles, enemies, activeSpeed) {
        let finalTarget = baseTarget;
        let speedOverride = null;

        // 1. DYNAMIC DETECTION RANGE
        // Using relative velocity would be ideal, but activeSpeed is a good proxy 
        // for most cases. Let's increase the floor and the multiplier slightly more.
        const baseLookAhead = Math.max(180, activeSpeed * 1.5);

        // 2. AVOID ASTEROIDS
        let maxUrgency = 0;

        for (const ast of asteroids) {
            // Predict collision based on relative movement
            const relVx = this.vx - (ast.vx || 0);
            const relVy = this.vy - (ast.vy || 0);
            const relSpeed = Math.sqrt(relVx * relVx + relVy * relVy);

            const adx = ast.worldX - this.worldX;
            const ady = ast.worldY - this.worldY;
            const adist = Math.sqrt(adx * adx + ady * ady);

            const safetyRadius = this.radius + ast.radius + 35;
            // Scan distance scales with RELATIVE speed to catch fast-moving asteroids
            const scanDist = Math.max(baseLookAhead, relSpeed * 1.2) + safetyRadius;

            if (adist < scanDist) {
                const angleToAst = Math.atan2(ady, adx);
                let currentHeadingDiff = angleToAst - this.angle;
                while (currentHeadingDiff > Math.PI) currentHeadingDiff -= Math.PI * 2;
                while (currentHeadingDiff < -Math.PI) currentHeadingDiff += Math.PI * 2;

                // 1. Is it in front of our current heading? (cone of ~110 degrees)
                if (Math.abs(currentHeadingDiff) < 1.9) {
                    // 2. Is it actually BLOCKING our target path?
                    let targetDiff = baseTarget - angleToAst;
                    while (targetDiff > Math.PI) targetDiff -= Math.PI * 2;
                    while (targetDiff < -Math.PI) targetDiff += Math.PI * 2;

                    // Calculate required clearance
                    const d = Math.max(safetyRadius * 0.5, adist); // prevent division by zero
                    const clearanceAngle = Math.asin(Math.min(0.999, safetyRadius / d));

                    // IF our target is already clear of this asteroid, don't veer away!
                    if (Math.abs(targetDiff) > clearanceAngle + 0.35) continue;

                    const urgency = Math.pow(1 - (adist - safetyRadius) / baseLookAhead, 0.9);
                    if (urgency > maxUrgency) {
                        maxUrgency = urgency;

                        // Pick the side that's closer to our current baseTarget
                        const side = targetDiff > 0 ? 1 : -1;
                        let escapeAngle = angleToAst + (clearanceAngle + 0.2) * side;

                        // RADIAL EJECTION: if we're actually inside or on the very edge, 
                        // prioritize moving directly AWAY from center.
                        if (adist < safetyRadius) {
                            escapeAngle = Math.atan2(this.worldY - ast.worldY, this.worldX - ast.worldX);
                        }

                        // Blend the escape angle based on urgency
                        const isUTurnNeeded = Math.abs(targetDiff) > Math.PI * 0.6;
                        let lerpFactor = Math.min(1.0, urgency * (isUTurnNeeded ? 4.0 : 3.0));

                        // EMERGENCY OVERRIDE: If a crash is imminent, stop blending and SNAP to escape.
                        if (urgency > 0.85) lerpFactor = 1.0;

                        let diff = escapeAngle - finalTarget;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        finalTarget += diff * lerpFactor;

                        // STALL/BRAKE: We brake harder if we're actually on a collision path
                        if (urgency > 0.4 || (isUTurnNeeded && urgency > 0.2)) {
                            const speedReduc = isUTurnNeeded ? 0.45 : 0.65;
                            speedOverride = this.baseSpeed * speedReduc;
                        }
                    }
                }
            }
        }

        // 3. AVOID OTHER ENEMIES (Simpler, closer range)
        const enemyAvoidDist = 120;
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

        // 4. Dodge Projectiles
        for (const p of projectiles) {
            if (p.owner !== this && p.alive) {
                const pdx = p.worldX - this.worldX;
                const pdy = p.worldY - this.worldY;
                const pdist = Math.sqrt(pdx * pdx + pdy * pdy);

                const playerDist = this.game.currentState.player ?
                    Math.sqrt(Math.pow(this.game.currentState.player.worldX - this.worldX, 2) + Math.pow(this.game.currentState.player.worldY - this.worldY, 2)) :
                    Infinity;

                if (pdist < 400 && playerDist > 450) {
                    const pvx = p.vx;
                    const pvy = p.vy;
                    const pSpeed = Math.sqrt(pvx * pvx + pvy * pvy);
                    const dot = (pvx * -pdx + pvy * -pdy) / ((pSpeed * pdist) || 1);
                    if (dot > 0.94) {
                        const perpX = -pvy;
                        const perpY = pvx;
                        const side = Math.sign(pdx * perpX + pdy * perpY) || 1;
                        finalTarget = Math.atan2(perpY * side, perpX * side);
                        break;
                    }
                }
            }
        }

        return { targetAngle: finalTarget, speedOverride: speedOverride };
    }

    shoot() {
        if (this.upgradeType === 'kamikaze') return;

        const laserSpeed = 950;
        const noseOffset = 30;
        const px = this.worldX + Math.cos(this.angle) * noseOffset;
        const py = this.worldY + Math.sin(this.angle) * noseOffset;
        let damage = (10 + 2.5 * this.difficultyScale) * this.damageMult;

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
        const length = 2000;

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

        if (this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ff4444');
        }

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

    onCollision(player) {
        let damage = 20;

        // --- Shield Capacitor Impact Damage ---
        if (player.shielding && player.shieldCapacitorCount > 0) {
            damage = 20.0 + (player.shieldCapacitorCount * 40.0); // 60.0 for one, 100.0 for two, etc.
        }

        this.hit(damage);
        if (!this.alive) return;

        this.state = AI_STATE.RECOVERY;
        this.stateTimer = 0.6;
        this.invulnTimer = 0.6;

        // Steer away from player
        const angleAway = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
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
            const worldOffX = (shard.lx * cosA - shard.ly * sinA);
            const worldOffY = (shard.lx * sinA + shard.ly * cosA);

            const outAngle = Math.atan2(worldOffY, worldOffX);
            const spread = 60 + Math.random() * 80;
            const vx = this.vx * 0.4 + Math.cos(outAngle) * spread;
            const vy = this.vy * 0.4 + Math.sin(outAngle) * spread;

            debris.push(new ProceduralDebris(
                this.game,
                this.worldX + worldOffX,
                this.worldY + worldOffY,
                shard,
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
        ctx.translate(screen.x, screen.y);

        // Visual distinction for upgraded enemies: Subtle red glow
        if (this.isUpgraded) {
            ctx.shadowBlur = 15 * this.game.worldScale;
            ctx.shadowColor = '#ff4444';
        }

        ctx.rotate(this.angle + Math.PI / 2);
        const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
        const h = (this.img.height || this.img.canvas.height) * this.game.worldScale;
        ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);

        ctx.restore();

        // Draw targeting line for beam
        if (this.isTargeting) {
            const targetImg = this.game.assets.get('red_laser_beam_targeting');
            if (targetImg) {
                ctx.save();
                ctx.globalAlpha = 0.5;
                ctx.translate(screen.x, screen.y);
                ctx.rotate(this.angle);
                const tileW = (targetImg.width || targetImg.canvas.width) * this.game.worldScale;
                const tileH = (targetImg.height || targetImg.canvas.height) * this.game.worldScale;
                for (let i = 0; i < 180; i++) {
                    ctx.drawImage(targetImg.canvas || targetImg, i * tileW, -tileH / 2, tileW, tileH);
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
                    ctx.translate(screen.x, screen.y);
                    ctx.rotate(beam.angle);
                    const tileW = (beamImg.width || beamImg.canvas.width) * this.game.worldScale;
                    const tileH = (beamImg.height || beamImg.canvas.height) * this.game.worldScale;
                    for (let i = 0; i < 240; i++) {
                        ctx.drawImage(beamImg.canvas || beamImg, i * tileW, -tileH / 2, tileW, tileH);
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
        this.lastBossType = null;

        this.spawnRateMult = 1.0;
        this.spawnRateTimer = 0;
    }

    applySpawnMultiplier(mult, duration) {
        this.spawnRateMult = mult;
        this.spawnRateTimer = duration;
    }

    forceBoss(playerX, playerY, difficultyScale) {
        const bosses = [Starcore, AsteroidCrusher];
        const BossClass = bosses[Math.floor(Math.random() * bosses.length)];
        this.lastBossType = BossClass.name;

        const angle = Math.random() * Math.PI * 2;
        const dist = 1600;
        return [new BossClass(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale)];
    }

    update(rawDt, playerX, playerY, difficultyScale = 1.0) {
        let dt = rawDt;
        if (this.spawnRateTimer > 0) {
            this.spawnRateTimer -= rawDt;
            dt = rawDt * this.spawnRateMult;
            if (this.spawnRateTimer <= 0) this.spawnRateMult = 1.0;
        }

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

        // Boss wave every 4 waves
        if (this.waveNumber % 4 === 0) {
            this.waveQueue = 0;
            this.waveSpawnTimer = 0;
            this.waveDelay = 0.5;
            this.waveSpawnScale = difficultyScale;

            // Spawn boss at a distance
            const angle = Math.random() * Math.PI * 2;
            const dist = 1600;

            // Randomly choose between available bosses, excluding the last one
            const bosses = [Starcore, AsteroidCrusher];
            const availableBosses = bosses.filter(b => b.name !== this.lastBossType);

            // Final fallback if all filtered (shouldn't happen with 2+ bosses)
            const pool = availableBosses.length > 0 ? availableBosses : bosses;
            const BossClass = pool[Math.floor(Math.random() * pool.length)];

            this.lastBossType = BossClass.name;
            const boss = new BossClass(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale);

            return [boss];
        }

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

    serialize() {
        return {
            phase: this.phase,
            phaseTimer: this.phaseTimer,
            burstQueue: this.burstQueue,
            burstSpawnTimer: this.burstSpawnTimer,
            waveQueue: this.waveQueue,
            waveSpawnTimer: this.waveSpawnTimer,
            waveDelay: this.waveDelay,
            waveSpawnScale: this.waveSpawnScale,
            waveNumber: this.waveNumber,
            lastBossType: this.lastBossType
        };
    }

    deserialize(data) {
        if (!data) return;
        this.phase = data.phase;
        this.phaseTimer = data.phaseTimer;
        this.burstQueue = data.burstQueue;
        this.burstSpawnTimer = data.burstSpawnTimer;
        this.waveQueue = data.waveQueue;
        this.waveSpawnTimer = data.waveSpawnTimer;
        this.waveDelay = data.waveDelay;
        this.waveSpawnScale = data.waveSpawnScale;
        this.waveNumber = data.waveNumber;
        this.lastBossType = data.lastBossType || null;
    }
}

export class KamikazeEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        // Custom stats for kamikaze
        const speedScale = 1 + (difficultyScale - 1) * 0.1;
        this.baseSpeed = Math.min(1050, (500 + Math.random() * 50) * speedScale);
        this.turnSpeed = Math.min(7.0, 7.0 + Math.random() * 1.0);
        // Moderate health, slightly tougher than standard enemies but not sponges
        this.health = Math.ceil(25 + 14 * difficultyScale);

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
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        // Kamikaze are standard sprites
        const canvas = this.img.canvas || this.img;
        const logicalW = this.img.width || canvas.width;
        const logicalH = this.img.height || canvas.height;
        const w = logicalW * this.game.worldScale;
        const h = logicalH * this.game.worldScale;
        ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
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
        const speedScale = 1 + (difficultyScale - 1) * 0.1;
        this.baseSpeed = (800 + Math.random() * 100) * speedScale;
        this.turnSpeed = 7.0 + Math.random() * 1.0;
        this.health = Math.ceil(25 + 14 * difficultyScale);

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
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        const canvas = this.img.canvas || this.img;
        const logicalW = this.img.width || canvas.width;
        const logicalH = this.img.height || canvas.height;
        const w = logicalW * this.game.worldScale;
        const h = logicalH * this.game.worldScale;
        ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
        ctx.restore();
    }
}

export class HostileEncounter extends Enemy {
    constructor(game, worldX, worldY, difficultyScale, encounterDialogData) {
        super(game, worldX, worldY, difficultyScale);
        this.encounterVars = encounterDialogData ? (encounterDialogData.vars || {}) : {};
        this.rawScenario = encounterDialogData ? encounterDialogData.rawScenario : null;
        this.isDying = false;
        this.deathTimer = 0;
        this.deathExplosions = null;
        this.isHostileEncounter = true;
    }

    initEncounterData(img, spriteKey) {
        this.img = img;
        this.spriteKey = spriteKey;
        if (CollisionScanner && this.img) {
            this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
            this.radius = this._nativeRadius * 0.95;
        }

        const radiusScale = this.radius / 30.0;
        const scaleDist = Math.max(1.0, radiusScale * 1.2);

        this.attackRange = 700 * scaleDist;
        this.breakRange = 450 * scaleDist;
        this.reversalTriggerDist = 350 * scaleDist;
    }

    hit(damage) {
        if (this.invulnTimer > 0 || this.isDying) return false;
        this.health -= damage;
        if (this.health <= 0) {
            this._triggerDeathSequence();
            return false;
        }
        return false;
    }

    shoot() {
        if (!this.selectedUpgrades || this.selectedUpgrades.length === 0) {
            super.shoot();
            return;
        }

        // Type is already set by update() cycle
        super.shoot();

        // Advance cycle for the NEXT shot cycle
        this.weaponCycle++;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.isDying) {
            this._updateDying(dt);
            return;
        }

        // Sync upgradeType for the base Enemy class targeting logic
        if (this.selectedUpgrades && this.selectedUpgrades.length > 0) {
            this.weaponCycle = this.weaponCycle || 0;
            this.upgradeType = this.selectedUpgrades[this.weaponCycle % this.selectedUpgrades.length];
        }

        super.update(dt, player, asteroids, projectiles, enemies);
    }

    _updateDying(dt) {
        if (!this.alive) return;
        this.deathTimer -= dt;

        if (this.deathExplosions) {
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
                        this.game.camera.shake(2.0);
                    }
                } else if (!ex.finished) {
                    ex.animTimer += dt * 1000;
                    if (ex.animTimer >= ex.totalDuration) ex.finished = true;
                }
            }
        }

        if (this.deathTimer <= 0) {
            this.game.camera.shake(6.0);
            this.alive = false;
            // Play one final big boom
            this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });

            this._grantAbstractRewards();

            if (this.game.currentState && this.game.currentState._onEntityDestroyed) {
                this.game.currentState._onEntityDestroyed(this);
            }
        }
    }

    _grantAbstractRewards() {
        if (!this.rawScenario || !this.rawScenario.options) return;
        const state = this.game.currentState;
        if (!state || !state.player) return;

        const abstractActions = ['reveal_shop', 'reveal_event', 'reveal_event_2', 'heal', 'add_perm_health', 'add_scrap', 'add_upgrade'];

        for (const opt of this.rawScenario.options) {
            if (opt.actions) {
                for (const act of opt.actions) {
                    const colonIdx = act.indexOf(':');
                    const type = colonIdx >= 0 ? act.slice(0, colonIdx) : act;

                    if (abstractActions.includes(type)) {
                        switch (type) {
                            case 'reveal_shop':
                                state.spawnDistantShop();
                                break;
                            case 'reveal_event':
                                const events1 = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                                if (events1.length > 0) events1[0].revealed = true;
                                break;
                            case 'reveal_event_2':
                                const events2 = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                                if (events2.length > 0) events2[0].revealed = true;
                                if (events2.length > 1) events2[1].revealed = true;
                                break;
                            case 'heal':
                                state.player.heal(0.3);
                                break;
                            case 'add_perm_health':
                                state.player.permHealthBonus += 10;
                                break;
                            case 'add_scrap':
                                const scrapAmount = parseInt(act.split(':')[1]) || 0;
                                state.player.scrap += scrapAmount;
                                break;
                            case 'add_upgrade':
                                const upgVar = act.split(':')[1];
                                const upgrade = this.encounterVars[upgVar];
                                if (upgrade && state.itemPickups) {
                                    state.itemPickups.push(new ItemPickup(this.game, this.worldX, this.worldY, upgrade));
                                }
                                break;
                        }
                    }
                }
            }
        }
    }

    _triggerDeathSequence() {
        this.isDying = true;
        this.vx *= 0.1;
        this.vy *= 0.1;

        const img = this.game.assets.get(this.spriteKey);
        if (!img) {
            this.alive = false;
            return;
        }

        const fireFrames = this.game.assets.get('fire_explosion');
        const totalExplosionDuration = fireFrames ? fireFrames.reduce((sum, f) => sum + f.delay, 0) : 500;

        this.deathExplosions = [];
        const baseStaggers = [0, 0.3, 0.6, 0.9, 1.2];
        const asset = img;
        const logicalW = asset.width || (asset.canvas ? asset.canvas.width : asset.width);
        const logicalH = asset.height || (asset.canvas ? asset.canvas.height : asset.height);

        // Sampling for solid pixels to place explosions (logic from Boss.js)
        const canvas = document.createElement('canvas');
        canvas.width = logicalW;
        canvas.height = logicalH;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        // img is the asset object here, draw scaled to logical size
        ctx.drawImage(img.canvas || img, 0, 0, (img.canvas ? img.canvas.width : img.width), (img.canvas ? img.canvas.height : img.height), 0, 0, logicalW, logicalH);
        const data = ctx.getImageData(0, 0, logicalW, logicalH).data;

        const solidPoints = [];
        for (let i = 0; i < 200; i++) {
            const x = Math.floor(Math.random() * logicalW);
            const y = Math.floor(Math.random() * logicalH);
            if (data[(y * logicalW + x) * 4 + 3] > 60) {
                solidPoints.push({ lx: x - logicalW / 2, ly: y - logicalH / 2 });
            }
        }
        if (solidPoints.length === 0) solidPoints.push({ lx: 0, ly: 0 });

        for (let i = 0; i < baseStaggers.length; i++) {
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
        this.deathTimer = baseStaggers[baseStaggers.length - 1] + 0.4;
    }

    draw(ctx, camera) {
        super.draw(ctx, camera);

        if (this.isDying && this.deathExplosions) {
            const fireFrames = this.game.assets.get('fire_explosion');
            if (!fireFrames) return;
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);

            for (const ex of this.deathExplosions) {
                if (ex.fired && !ex.finished) {
                    let frame = fireFrames[0];
                    let elapsed = ex.animTimer;
                    for (const f of fireFrames) {
                        if (elapsed < f.delay) { frame = f; break; }
                        elapsed -= f.delay;
                    }
                    const ew = (frame.width || frame.canvas.width / 4) * this.game.worldScale * ex.scale;
                    const eh = (frame.height || frame.canvas.height / 4) * this.game.worldScale * ex.scale;
                    ctx.drawImage(frame.canvas || frame, ex.lx * this.game.worldScale - ew / 2, ex.ly * this.game.worldScale - eh / 2, ew, eh);
                }
            }
            ctx.restore();
        }
    }

    getSpawnOnDeath() {
        const spawns = [];
        const img = this.game.assets.get(this.spriteKey);

        if (img && VoronoiSlicer) {
            const fragments = VoronoiSlicer.slice(img, 80 + Math.floor(Math.random() * 40));
            for (const frag of fragments) {
                const rotAngle = this.angle + Math.PI / 2;
                const cosA = Math.cos(rotAngle);
                const sinA = Math.sin(rotAngle);
                const wx = this.worldX + (frag.lx * cosA - frag.ly * sinA);
                const wy = this.worldY + (frag.lx * sinA + frag.ly * cosA);

                const outAngle = Math.atan2(frag.ly, frag.lx) + rotAngle;
                const spread = 40 + Math.random() * 120;

                spawns.push(new ProceduralDebris(
                    this.game, wx, wy, frag,
                    Math.cos(outAngle) * spread, Math.sin(outAngle) * spread,
                    rotAngle, (Math.random() - 0.5) * 4, 3 + Math.random() * 2
                ));
            }
        }

        const scrapCount = 8 + Math.floor(Math.random() * 5);
        for (let i = 0; i < scrapCount; i++) {
            const outAngle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 60;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(outAngle) * dist, this.worldY + Math.sin(outAngle) * dist, Math.random() > 0.4 ? 'big' : 'small'));
        }

        for (const [key, val] of Object.entries(this.encounterVars)) {
            if (val && typeof val === 'object' && val.id && val.name && val.cost) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, val));
            }
        }

        return spawns;
    }
}
