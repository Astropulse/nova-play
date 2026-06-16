// Scaling is now dynamic via game properties
import { Projectile } from './projectile.js';
import { Scrap, Rubble, ItemPickup, ProceduralDebris, VoronoiSlicer, ExpOrb, resolveSpawnOverlap, getCachedShatter } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { Starcore } from './starcore.js';
import { AsteroidCrusher } from './asteroidCrusher.js';
import { EventHorizon } from './eventHorizon.js';

const AI_STATE = {
    PURSUIT: 'pursuit',   // Move toward player
    ATTACK: 'attack',     // Point and fire
    BREAK: 'break',       // Short turn to reposition
    REVERSAL: 'reversal', // Hard loop back when chased
    RECOVERY: 'recovery', // Boost away after collision
    REPOSITION: 'reposition', // Back off to standoff distance
    WINDUP: 'windup',     // Telegraph: slow, lock onto player, charge-up flash
    RAM: 'ram'            // Locked straight-line dash (Starcore-style ram)
};

const RADIUS_CACHE = {};

// Reused scratch for the per-enemy separation neighbour query — filled and
// fully consumed inside one _avoidObstacles call, so a single module-level
// buffer is safe (enemies update sequentially) and keeps the hot path
// allocation-free.
const _sepScratch = [];

// Reused scratch for the per-enemy projectile-dodge neighbour query — same
// single-buffer-is-safe reasoning as _sepScratch (filled and fully consumed
// within one _avoidObstacles call, enemies update sequentially).
const _projScratch = [];

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
        // Pixel-readback only → willReadFrequently keeps it off the GPU so the
        // getImageData below can't stall the main canvas's rasteriser.
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
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

        // Spawn-time content seed: this enemy's gameplay attributes (upgrade
        // path) and loot drops are fixed at spawn for reproducibility. AI/combat
        // micro-decisions stay on Math.random() (allowed to differ between
        // same-seed runs). Falls back outside a run. Enemies aren't serialized,
        // so this seed is ephemeral across save/load.
        if (game.rng) {
            const d = game.rng.deriveEntity('enemies');
            this.contentRng = d.rng;
            this.contentSeed = d.seed;
        } else {
            this.contentRng = null;
            this.contentSeed = null;
        }

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
        this.health = Math.ceil(10 + 10 * difficultyScale);
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

        // Ram cycle (used by chargers: kamikaze, cthulhu, kamikaze-upgraded).
        // Cruise in, telegraph with a wind-up, then commit to a locked dash the
        // player can read and dodge — modelled on the Starcore ramming phase.
        this.windupDuration = 0.45;       // Telegraph length (reaction window)
        this.windupSpeedMult = 0.15;      // Near-stop while charging up
        this.ramSpeedMult = 2.3;          // Dash speed = this × cruise speed (scales with difficulty)
        this.ramCrossMult = 2.3;          // Dash travels this × distance-to-player at commit
        this.ramTriggerScreenFrac = 0.9;  // Only wind up once on-screen (fraction of half-screen)

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

        // Dodge Persistence
        this.dodgeTimer = 0;
        this.dodgeDirectionAngle = 0;
        this.dodgeDecisionMap = new WeakMap(); // projectile -> { decided: boolean, canDodge: boolean, reactionTimer: number }

        // Phase offset so temporal AI LOD staggers re-solves across enemies
        // ("off-beat") instead of bunching them on the same frame. Random is
        // fine — it only spreads CPU load, not replicated state.
        this._aiOffset = (Math.floor(Math.random() * 997)) | 0;

        // Reused per-enemy buffers for the projectile-dodge scan — the active
        // threat list and a pool of threat records, so a frame of dodging
        // allocates nothing (the old code built a fresh array + an object per
        // threat every frame for every enemy).
        this._activeThreats = [];
        this._threatPool = [];
    }

    _getDistanceMult() {
        // 1. FOV Factor: increase engagement distance as player FOV increases (zooms out)
        const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;
        // Subtle scaling: 25% of the zoom-out factor is applied to distance
        const fovFactor = 1.0 + (fov - 1.0) * 0.25;

        // 2. Speed Factor: increase distances as velocity increases to prevent constant collisions
        const speed = this.baseSpeed * this.speedMult;
        // Hostile encounters are much faster and larger — scale distances more aggressively
        // so they start breaking earlier and don't overshoot into the player.
        const speedCoeff = this.isHostileEncounter ? 0.001 : 0.0004;
        const speedFactor = 1.0 + Math.max(0, (speed - 400) * speedCoeff);

        return fovFactor * speedFactor;
    }

    // opts.allowKamikaze (default true): when false, the kamikaze path is removed
    // and its probability is redistributed evenly to the stats/weapon paths. Used
    // by special enemies, which can be upgraded but shouldn't turn into rammers.
    _applyUpgrades(opts = {}) {
        if (this.isUpgraded) return;
        this.isUpgraded = true;
        const allowKamikaze = opts.allowKamikaze !== false;
        // Seeded so enemy strength is reproducible at the same spawn point.
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();
        const roll = rand();

        // With kamikaze: stats 40% / weapon 40% / kamikaze 20%.
        // Without: stats 50% / weapon 50% (kamikaze band split between them).
        const statsCut = allowKamikaze ? 0.4 : 0.5;
        const weaponCut = allowKamikaze ? 0.8 : 1.0;

        if (roll < statsCut) {
            // Stats Path
            const options = ['health', 'speed', 'firerate'];
            const count = rand() < 0.5 ? 1 : 2;
            for (let i = 0; i < count; i++) {
                const choice = options.splice(Math.floor(rand() * options.length), 1)[0];
                this.selectedUpgrades.push(choice);
                if (choice === 'health') this.health = Math.ceil(this.health * 1.5);
                if (choice === 'speed') this.speedMult = 1.4;
                if (choice === 'firerate') this.fireRateMult = 1.4;
            }
            this.upgradeType = 'stats';
        } else if (roll < weaponCut) {
            // Weapon Path
            const weaponOptions = ['bigBall', 'beam', 'multishot'];
            this.upgradeType = weaponOptions[Math.floor(rand() * weaponOptions.length)];
            this.selectedUpgrades.push(this.upgradeType);
        } else {
            // Kamikaze Path
            this.upgradeType = 'kamikaze';
            this.selectedUpgrades.push('kamikaze');
            this.speedMult = 2.0;
            this.attackRange = -1;
        }
    }

    // Apply a single named upgrade. Production rolls a seeded loadout via
    // _applyUpgrades(); this is the deterministic entry point (dev console).
    // Returns true if the upgrade name was recognized.
    static UPGRADE_TYPES = ['health', 'speed', 'firerate', 'bigBall', 'beam', 'multishot', 'kamikaze'];
    applyUpgrade(type) {
        if (!Enemy.UPGRADE_TYPES.includes(type)) return false;
        this.isUpgraded = true;
        if (!this.selectedUpgrades) this.selectedUpgrades = [];
        this.selectedUpgrades.push(type);
        switch (type) {
            case 'health': this.health = Math.ceil(this.health * 1.5); this.maxHealth = this.health; this.upgradeType = 'stats'; break;
            case 'speed': this.speedMult = 1.4; this.upgradeType = 'stats'; break;
            case 'firerate': this.fireRateMult = 1.4; this.upgradeType = 'stats'; break;
            case 'kamikaze': this.upgradeType = 'kamikaze'; this.speedMult = 2.0; this.attackRange = -1; break;
            default: this.upgradeType = type; break; // bigBall | beam | multishot
        }
        return true;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const angleToPlayer = Math.atan2(dy, dx);
        const distMult = this._getDistanceMult();
        const activeAttackRange = this.attackRange * distMult;
        const activeBreakRange = this.breakRange * distMult;

        // 1. Tactical State Updates
        this.invulnTimer = Math.max(0, this.invulnTimer - dt);
        this.freezeTimer = Math.max(0, this.freezeTimer - dt);
        this.dodgeTimer = Math.max(0, this.dodgeTimer - dt);

        // We'll manage the decision map and reaction timers inside _avoidObstacles 
        // because it needs access to the projectile list.

        if (this.freezeTimer > 0) {
            this.vx = 0;
            this.vy = 0;
            return; // Skip movement/rotation when frozen
        }

        this._updateAIState(dt, dist, angleToPlayer, player, enemies, distMult);

        // Starcore-style ram: a fully committed straight-line dash. Handled on
        // its own path with NO obstacle avoidance and NO speed overrides, so it
        // holds a dead-straight heading at full ram speed and overshoots clean
        // across the screen. (Avoidance is what made it curve and stutter.)
        if (this.state === AI_STATE.RAM) {
            this._updateRamMovement(dt);
            return;
        }

        // 2. Determine Target Angle
        let targetAngle = this._getTargetAngle(angleToPlayer, dist);

        // 3. Environmental Avoidance Override
        // Calculate speed first so avoidance can use it for look-ahead
        let currentMaxSpeed = this.baseSpeed;
        if (this.state === AI_STATE.WINDUP) {
            currentMaxSpeed = this.baseSpeed * this.windupSpeedMult;
        } else if (this.state === AI_STATE.RECOVERY) {
            currentMaxSpeed = this.baseSpeed * 1.8;
        } else if (this.state === AI_STATE.BREAK || this.state === AI_STATE.REPOSITION) {
            currentMaxSpeed = this.baseSpeed * 1.3;
        } else if (this.state === AI_STATE.ATTACK && this.attackPassCount === 0) {
            const closeFactor = Math.max(0.3, Math.min(0.6, dist / activeAttackRange));
            // Hostile encounters need harder braking to counteract their high speedMult
            const encBrake = this.isHostileEncounter ? (1.0 / this.speedMult) : 1.0;
            currentMaxSpeed = this.baseSpeed * closeFactor * encBrake;
        } else if (dist > 1500) {
            const boostFactor = Math.min(3.0, 1.0 + (dist - 1500) / (2000));
            currentMaxSpeed *= boostFactor;
        }

        const activeSpeed = currentMaxSpeed * this.speedMult;

        // Temporal AI LOD: the obstacle/dodge solve is the per-enemy cost that
        // makes dense waves expensive. In a crowd PlayingState clears
        // _avoidRecompute on most frames (staggered across enemies, "off-beat"),
        // so each enemy re-solves only every Nth frame and carries the result
        // over between. We cache the steering ADJUSTMENT (final − base) and
        // reapply it to the live base target, so player-tracking + aim stay
        // current every frame; only the obstacle/dodge reaction is up to a couple
        // frames stale. With few enemies the flag is never cleared → identical to
        // before. Default (undefined) also recomputes, so nothing changes unless
        // PlayingState opts an enemy out this frame.
        let avoidance, speedOverride;
        if (this._avoidRecompute !== false || this._avoidDelta === undefined) {
            avoidance = this._avoidObstacles(targetAngle, asteroids, projectiles, enemies, activeSpeed, dt);
            let d = avoidance.targetAngle - targetAngle;
            while (d > Math.PI) d -= Math.PI * 2;
            while (d < -Math.PI) d += Math.PI * 2;
            this._avoidDelta = d;
            this._avoidSpeedOverride = avoidance.speedOverride;
            speedOverride = avoidance.speedOverride;
            targetAngle = avoidance.targetAngle;
        } else {
            targetAngle += this._avoidDelta;
            speedOverride = this._avoidSpeedOverride;
        }

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
            if (this.shootTimer <= 0 && dist < activeAttackRange) {
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

    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        // Kamikaze-upgraded enemies don't do attack runs — they charge and ram.
        if (this.upgradeType === 'kamikaze') {
            this._updateRamCycle(dt, dist, angleToPlayer, distMult);
            return;
        }

        this.stateTimer -= dt;
        if (this.reversalCooldown > 0) this.reversalCooldown -= dt;

        // Detection: Is the player tailing/chasing me?
        // (Player is close AND player is behind me AND player is looking at me)
        const angleDiffToPlayer = angleToPlayer - this.angle;
        const absDiff = Math.abs(Math.atan2(Math.sin(angleDiffToPlayer), Math.cos(angleDiffToPlayer)));
        const playerIsBehind = absDiff > 2.2; // roughly 120-130 degrees behind

        const activeAttackRange = this.attackRange * distMult;
        const activeBreakRange = this.breakRange * distMult;
        const activeReversalDist = this.reversalTriggerDist * distMult;

        if (playerIsBehind && dist < activeReversalDist && (this.reversalCooldown || 0) <= 0
            && this.state !== AI_STATE.REVERSAL && this.state !== AI_STATE.RECOVERY) {
            // Check if player is actually pointing at us
            const playerToEnemyAngle = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
            const playerFacingDiff = playerToEnemyAngle - player.angle;
            const playerLookingAtMe = Math.abs(Math.atan2(Math.sin(playerFacingDiff), Math.cos(playerFacingDiff))) < 0.5;

            // ...and ACTUALLY PURSUING — the player's velocity must point toward us
            // (within ~60°), not just happen to be behind. Without this, the enemy
            // turning its own back during a reposition/break flips `playerIsBehind`
            // true and triggers a bogus reversal → the reposition↔reversal loop.
            const pvx = player.vx || 0, pvy = player.vy || 0;
            const pSpeed = Math.sqrt(pvx * pvx + pvy * pvy);
            const closingDot = pvx * (this.worldX - player.worldX) + pvy * (this.worldY - player.worldY);
            const playerClosing = pSpeed > 60 && closingDot > pSpeed * dist * 0.5;

            if (playerLookingAtMe && playerClosing) {
                this.state = AI_STATE.REVERSAL;
                this.stateTimer = 0.8 + Math.random() * 0.4;
                // Cooldown so a sustained chase can't re-trigger every reposition —
                // one reversal, then normal passes for a beat before another.
                this.reversalCooldown = 2.5 + Math.random() * 1.0;
                return;
            }
        }

        switch (this.state) {
            case AI_STATE.PURSUIT:
                // Charge at the player — transition to ATTACK when in range
                if (dist < activeAttackRange) {
                    this.state = AI_STATE.ATTACK;
                    this.burstShotsLeft = this.burstShotsMax;
                    this.shootTimer = 0.1;
                }
                break;

            case AI_STATE.ATTACK:
                // Stay in attack until burst is done OR we get very close
                // Hostile encounters are larger and faster — break further out
                const breakMult = this.isHostileEncounter ? 4.0 : 2.5;
                const minBreakDist = this.radius * breakMult + 50;
                const burstDone = this.burstShotsLeft <= 0;
                const tooClose = dist < minBreakDist;

                const breakThreshold = burstDone ? (activeBreakRange * 0.7) : minBreakDist;

                if (dist < breakThreshold || tooClose) {
                    if (this.attackPassCount >= this.maxAttackPasses) {
                        this._startReposition(angleToPlayer);
                    } else {
                        this._startVeerOff(angleToPlayer);
                    }
                } else if (dist > activeAttackRange + 400 * distMult) {
                    this.state = AI_STATE.PURSUIT;
                }
                break;

            case AI_STATE.REPOSITION:
                if (this.stateTimer <= 0 || dist > 600 * distMult) {
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
    }

    /**
     * Charge-and-ram cycle shared by all charger types (kamikaze, cthulhu, and
     * kamikaze-upgraded enemies). Modelled on the Starcore ramming phase:
     * cruise toward the player, telegraph with a brief wind-up that locks the
     * heading, then dash in a committed straight line the player can dodge.
     */
    // Dash speed scales off the enemy's effective cruise speed, which grows with
    // difficulty — faster enemies ram faster.
    _getRamSpeed() {
        return this.baseSpeed * this.speedMult * this.ramSpeedMult;
    }

    _updateRamCycle(dt, dist, angleToPlayer, distMult) {
        this.stateTimer -= dt;

        // A collision knocked us into RECOVERY — let it play out, then re-engage.
        if (this.state === AI_STATE.RECOVERY) {
            if (this.stateTimer <= 0) this.state = AI_STATE.PURSUIT;
            return;
        }

        // Only wind up once the charger is actually on-screen, so the player can
        // see it coming. worldScale already folds in the FOV zoom, so the distance
        // from screen-centre to the nearest edge (in world units) is half the
        // smaller screen dimension divided by worldScale.
        const halfScreen = Math.min(this.game.width, this.game.height) * 0.5;
        const triggerRange = (halfScreen / (this.game.worldScale || 1)) * this.ramTriggerScreenFrac;

        switch (this.state) {
            case AI_STATE.WINDUP:
                // Tracked the player during the wind-up; now lock the heading and
                // commit to the dash.
                if (this.stateTimer <= 0) {
                    this.state = AI_STATE.RAM;
                    // Cap the dash to ramCrossMult × the distance to the player at
                    // commit: it passes through and overshoots an equal distance,
                    // no further. duration = travel distance / speed.
                    this.stateTimer = (this.ramCrossMult * dist) / this._getRamSpeed();
                    // Lock the heading to the player's current bearing and snap to
                    // it — the dash is dead-straight from the first frame.
                    this.targetAngleOverride = angleToPlayer;
                    this.angle = angleToPlayer;
                    this.game.sounds.play('boost', { volume: 0.6, x: this.worldX, y: this.worldY });
                }
                break;

            case AI_STATE.RAM:
                // Locked straight-line dash — end on timeout, then peel away.
                if (this.stateTimer <= 0) {
                    this.state = AI_STATE.RECOVERY;
                    this.stateTimer = 0.5 + Math.random() * 0.3;
                    this.targetAngleOverride = angleToPlayer + Math.PI + (Math.random() - 0.5) * 0.8;
                }
                break;

            default:
                // PURSUIT: home in at cruise speed, then start the wind-up once in
                // range. The wind-up's slow + flash + sound is the telegraph.
                this.state = AI_STATE.PURSUIT;
                if (dist < triggerRange) {
                    this.state = AI_STATE.WINDUP;
                    this.stateTimer = this.windupDuration;
                    this.game.sounds.play('railgun_target', { volume: 0.45, x: this.worldX, y: this.worldY });
                }
                break;
        }
    }

    /**
     * Pure committed dash movement for the RAM state — mirrors the Starcore's
     * dash: travel straight along the locked heading at full ram speed, no
     * avoidance, no speed overrides, so it overshoots clean across the screen.
     */
    _updateRamMovement(dt) {
        const ramSpeed = this._getRamSpeed();
        this.vx = Math.cos(this.angle) * ramSpeed + this.externalVx;
        this.vy = Math.sin(this.angle) * ramSpeed + this.externalVy;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Dampen external forces (dt-compensated), same as the normal path.
        const externalFriction = Math.pow(0.99, dt * 60);
        this.externalVx *= externalFriction;
        this.externalVy *= externalFriction;
    }

    /**
     * Pulsing red charge-up glow drawn over a charger's sprite during the ram
     * wind-up. Intensifies as the wind-up completes so the player can read the
     * incoming dash. Called by the draw() of every charger type.
     */
    _drawWindupFlash(ctx, screen) {
        if (!this.img) return;
        const isWindup = this.state === AI_STATE.WINDUP;
        const isRam = this.state === AI_STATE.RAM;
        if (!isWindup && !isRam) return;

        // Wind-up ramps 0→1 as it completes; the ram holds at full intensity so
        // the red glow doubles as the "I'm invincible, dodge me" tell.
        const progress = isRam ? 1 : 1 - Math.max(0, this.stateTimer) / this.windupDuration;
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 40);
        const intensity = 0.35 + 0.65 * progress;

        const canvas = this.img.canvas || this.img;
        const w = (this.img.width || canvas.width) * this.game.worldScale;
        const h = (this.img.height || canvas.height) * this.game.worldScale;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        ctx.globalAlpha = intensity * pulse;
        ctx.globalCompositeOperation = 'lighter';
        ctx.shadowBlur = (10 + 20 * progress) * this.game.worldScale;
        ctx.shadowColor = '#ff3322';
        ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
        ctx.restore();
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
            case AI_STATE.WINDUP: // keep tracking the player while charging up
                return angleToPlayer;
            case AI_STATE.BREAK:
            case AI_STATE.RECOVERY:
            case AI_STATE.REPOSITION:
            case AI_STATE.RAM: // heading is locked at ram start — commit to the line
                return this.targetAngleOverride;
            default:
                return angleToPlayer;
        }
    }

    _avoidObstacles(baseTarget, asteroids, projectiles, enemies, activeSpeed, dt) {
        let finalTarget = baseTarget;
        let speedOverride = null;
        // Optional AI sub-phase profiler (asteroid-avoid / separation / dodge),
        // summed across enemies into Enemy._pAst/_pSep/_pDodge. Off unless the
        // perf harness sets Enemy._PROF, so production pays only a dead boolean.
        const _PF = Enemy._PROF; let _pt = _PF ? performance.now() : 0;

        // 1. DYNAMIC DETECTION RANGE
        // Using relative velocity would be ideal, but activeSpeed is a good proxy 
        // for most cases. Let's increase the floor and the multiplier slightly more.
        const baseLookAhead = Math.max(180, activeSpeed * 1.5);

        // 2. AVOID ASTEROIDS
        let maxUrgency = 0;

        // Squared base look-ahead, so the common "slow/distant rock" case rejects
        // with no sqrt at all (the relative-speed term only matters when it would
        // actually extend the scan past the base reach).
        const baseLookAheadSq = baseLookAhead * baseLookAhead;
        // Cheap broad reject: no asteroid past this distance can satisfy the
        // exact scanDist test below — baseLookAhead already scales with speed,
        // and the +margin bounds the largest possible safety radius plus the
        // relative-speed term. Skipping the per-rock relative-velocity math for
        // far asteroids is identical in result (avoidance only ever steers for
        // the single highest-urgency rock, which is always a near one), but
        // turns the dominant case — most rocks are out of range — into one
        // squared-distance compare instead of five mults + a branch.
        const maxScan = baseLookAhead + this.radius + 450;
        const maxScanSq = maxScan * maxScan;
        for (const ast of asteroids) {
            const adx = ast.worldX - this.worldX;
            const ady = ast.worldY - this.worldY;
            const adistSq = adx * adx + ady * ady;
            if (adistSq > maxScanSq) continue;

            const safetyRadius = this.radius + ast.radius + 35;

            // Predict collision based on relative movement. Scan distance scales
            // with RELATIVE speed to catch fast-moving asteroids — but the sqrt
            // for that is only needed when relSpeed*1.2 exceeds the base reach,
            // which is rare, so skip it for the overwhelming majority of rocks.
            const relVx = this.vx - (ast.vx || 0);
            const relVy = this.vy - (ast.vy || 0);
            const relSpeedSq = relVx * relVx + relVy * relVy;
            let scanDist = baseLookAhead + safetyRadius;
            if (relSpeedSq * 1.44 > baseLookAheadSq) {
                scanDist = Math.sqrt(relSpeedSq) * 1.2 + safetyRadius;
            }

            if (adistSq < scanDist * scanDist) {
                const adist = Math.sqrt(adistSq);
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

        if (_PF) { const _n = performance.now(); Enemy._pAst += _n - _pt; _pt = _n; }
        // 3. AVOID OTHER ENEMIES (Simpler, closer range)
        // The separation force is a plain sum over every peer within 120px, so
        // it's order-independent. A frame-coherent broad-phase grid (built in
        // PlayingState) returns exactly that neighbourhood without the old
        // O(n^2) scan of the entire enemy list — same accepted set, same math.
        const enemyAvoidDist = 120;
        const enemyAvoidDistSq = 14400; // 120^2
        const cs = this.game.currentState;
        const grid = cs && cs._enemyGrid;
        const neighbors = grid
            ? grid.queryInto(this.worldX, this.worldY, enemyAvoidDist, _sepScratch)
            : enemies;
        for (let n = 0; n < neighbors.length; n++) {
            const other = neighbors[n];
            if (other === this || !other.alive) continue;
            const edx = other.worldX - this.worldX;
            const edy = other.worldY - this.worldY;
            const edistSq = edx * edx + edy * edy;

            if (edistSq < enemyAvoidDistSq) {
                const edist = Math.sqrt(edistSq);
                const angleToOther = Math.atan2(edy, edx);
                let diff = angleToOther - this.angle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;

                const steerSide = diff > 0 ? -1 : 1;
                const steerIntensity = (1 - edist / enemyAvoidDist) * 1.5;
                finalTarget += steerSide * (Math.PI / 4) * steerIntensity;
            }
        }

        if (_PF) { const _n = performance.now(); Enemy._pSep += _n - _pt; _pt = _n; }
        // 4. Dodge Projectiles (Predictive Evasive Maneuvers)
        let primaryThreat = null;
        let highestThreatLevel = 0;
        const activeThreats = this._activeThreats;
        activeThreats.length = 0;
        const threatPool = this._threatPool;
        let poolIdx = 0;

        // Only the projectiles in this enemy's ~1500px neighbourhood can be
        // threats (the broad-phase below rejects anything farther). A frame-
        // coherent grid returns exactly that set without scanning every shot on
        // the field — same projectiles pass the broad-phase, so the chosen
        // threat is identical, but dense waves no longer cost enemies x shots.
        const projGrid = cs && cs._projGrid;
        const projList = projGrid
            ? projGrid.queryInto(this.worldX, this.worldY, 1500, _projScratch)
            : projectiles;
        for (let pi = 0; pi < projList.length; pi++) {
            const p = projList[pi];
            if (p.owner === this || !p.alive) continue;

            const pdx = p.worldX - this.worldX;
            const pdy = p.worldY - this.worldY;
            // Broad-phase: skip projectiles too far away to reach us in 1.2s
            if (pdx * pdx + pdy * pdy > 2250000) continue; // ~1500px max range
            const pvx = p.vx;
            const pvy = p.vy;

            // A projectile whose relative motion points away from us (dot ≥ 0)
            // can never have a future closest approach — reject it before the
            // reciprocal+divide rather than after. This is the exact same set as
            // the old `t_impact <= 0` cut (t_impact's sign is just -dot/speed²),
            // and in a dense wave most shots are receding from any given enemy.
            const dot = pdx * pvx + pdy * pvy;
            if (dot >= 0) continue;
            const pSpeedSq = pvx * pvx + pvy * pvy || 1;

            // Time to closest point of approach (CPA). Only near-future (1.2s).
            const t_impact = -dot / pSpeedSq;
            if (t_impact > 1.2) continue;

            const closestX = p.worldX + pvx * t_impact;
            const closestY = p.worldY + pvy * t_impact;
            const adx = closestX - this.worldX;
            const ady = closestY - this.worldY;
            const dist_cpa_sq = adx * adx + ady * ady;

            const shipRadius = this.radius;
            const projRadius = p.radius || 8;
            const requiredClearance = shipRadius + projRadius + 15; // 15px safety margin

            if (dist_cpa_sq < requiredClearance * requiredClearance) {
                const dist_cpa = Math.sqrt(dist_cpa_sq);
                const threatLevel = (1 - t_impact / 1.2) * (1 - dist_cpa / requiredClearance);
                // Reuse a pooled record instead of allocating one per threat.
                let threatData = threatPool[poolIdx];
                if (threatData === undefined) { threatData = {}; threatPool[poolIdx] = threatData; }
                poolIdx++;
                threatData.p = p;
                threatData.t_impact = t_impact;
                threatData.adx = adx;
                threatData.ady = ady;
                threatData.dist_cpa = dist_cpa;
                threatData.requiredClearance = requiredClearance;
                threatData.threatLevel = threatLevel;
                activeThreats.push(threatData);

                if (threatLevel > highestThreatLevel) {
                    highestThreatLevel = threatLevel;
                    primaryThreat = threatData;
                }

                // Saturation short-circuit: >4 simultaneous threats means the
                // check below nulls the dodge entirely, so once a 5th is found
                // the remaining shots can't change the outcome — stop scanning.
                // Identical result, but it skips the bulk of the per-enemy
                // projectile scan in exactly the dense waves that cost the most.
                if (activeThreats.length > 4) break;
            }
        }

        // Saturation Check + Decision Execution
        if (activeThreats.length > 4) primaryThreat = null;

        if (primaryThreat) {
            let decision = this.dodgeDecisionMap.get(primaryThreat.p);

            if (!decision) {
                const deficit = primaryThreat.requiredClearance - primaryThreat.dist_cpa;
                // Max lateral displacement rule: D = (s/w) * (1 - cos(w*t))
                const w = this.turnSpeed || 1;
                const d_max = (activeSpeed / w) * (1 - Math.cos(Math.min(Math.PI, w * primaryThreat.t_impact)));

                const canPhysicallyDodge = d_max >= (deficit * 0.8);
                const dodgeRoll = Math.random() < (0.75 + (this.difficultyScale - 1) * 0.05);

                if (canPhysicallyDodge && dodgeRoll) {
                    // --- MULTI-THREAT SIDE ANALYSIS ---
                    const laserAngle = Math.atan2(primaryThreat.p.vy, primaryThreat.p.vx);
                    const sides = [1, -1];
                    let bestSide = sides[0];
                    let bestMinClearance = -Infinity;

                    // Evaluate both perpendicular escape vectors
                    for (const side of sides) {
                        const dodgeAngle = laserAngle + (Math.PI / 2) * side;
                        const dx_dodge = Math.cos(dodgeAngle) * d_max;
                        const dy_dodge = Math.sin(dodgeAngle) * d_max;

                        let minClearanceForSide = Infinity;
                        for (const other of activeThreats) {
                            // New CPA distance: |V_cpa_old - D_dodge|
                            const new_adx = other.adx - dx_dodge;
                            const new_ady = other.ady - dy_dodge;
                            const new_dist_cpa = Math.sqrt(new_adx * new_adx + new_ady * new_ady);
                            const clearance = new_dist_cpa - other.requiredClearance;
                            if (clearance < minClearanceForSide) minClearanceForSide = clearance;
                        }

                        if (minClearanceForSide > bestMinClearance) {
                            bestMinClearance = minClearanceForSide;
                            bestSide = side;
                        }
                    }

                    // STAY-IN-GAP CHECK: If dodging causes more danger than staying put, cancel.
                    let currentMinClearance = Infinity;
                    for (const other of activeThreats) {
                        const clearance = other.dist_cpa - other.requiredClearance;
                        if (clearance < currentMinClearance) currentMinClearance = clearance;
                    }

                    if (bestMinClearance < (currentMinClearance - 5)) {
                        decision = { willDodge: false };
                    } else {
                        decision = {
                            willDodge: true,
                            reactionTimer: 0.08 + Math.random() * 0.15,
                            side: bestSide,
                            noise: (Math.random() - 0.5) * 0.2
                        };
                    }
                } else {
                    decision = { willDodge: false };
                }
                this.dodgeDecisionMap.set(primaryThreat.p, decision);
            }

            if (decision.willDodge) {
                decision.reactionTimer -= dt;
                if (decision.reactionTimer <= 0) {
                    const laserAngle = Math.atan2(primaryThreat.p.vy, primaryThreat.p.vx);
                    this.dodgeTimer = 0.45; // Hold for maneuver
                    this.dodgeDirectionAngle = laserAngle + (Math.PI / 2) * decision.side + decision.noise;
                }
            }
        }

        // Apply dodge persistence and blending
        if (this.dodgeTimer > 0) {
            let diff = this.dodgeDirectionAngle - finalTarget;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;

            const dodgeStrength = Math.min(1.0, this.dodgeTimer * 5.0);
            finalTarget += diff * dodgeStrength;
        }

        if (_PF) { Enemy._pDodge += performance.now() - _pt; }
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

        // Hitscan vs every player ship (multiplayer-aware; single player this
        // is just [player]). Damage routes to whichever pilot was hit.
        const state = this.game.currentState;
        const bodies = state.getPlayerBodies ? state.getPlayerBodies() : (state.player ? [state.player] : []);
        for (const body of bodies) {
            const dx = body.worldX - startX;
            const dy = body.worldY - startY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < length) {
                const dot = (dx * dirX + dy * dirY) / dist;
                if (dot > 0.99) { // Very narrow beam
                    const cross = Math.abs(dx * dirY - dy * dirX);
                    if (cross < body.radius) {
                        if (state.damagePlayerBody) state.damagePlayerBody(body, damage, this.worldX, this.worldY);
                        else state._damagePlayer(damage, this.worldX, this.worldY);
                        this.game.sounds.play('hit', { volume: 0.5, x: body.worldX, y: body.worldY });
                    }
                }
            }
        }
        // Replicate the beam flash to other machines.
        if (state.netSync && state.netSync.isHost) {
            state.netSync.broadcastEnemyBeam(this, startX, startY, this.angle);
        }
        this.game.sounds.play('railgun_shoot', { volume: 0.6, x: startX, y: startY });
    }

    hit(damage) {
        // Invulnerable mid-ram, like the Starcore dash — the player has to dodge,
        // not out-trade, the charge.
        if (this.invulnTimer > 0 || this.state === AI_STATE.RAM) return false;
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
        // While ramming, plow straight through the player and keep overshooting —
        // the dash is committed and invincible, like the Starcore. Don't recoil
        // or turn around. (The collision handler still applies contact damage.)
        if (this.state === AI_STATE.RAM) return;

        let damage = 20;

        // --- Shield Capacitor Impact Damage ---
        if (player.shielding && player.shieldCapacitorCount > 0) {
            damage = (20.0 + player.shieldCapacitorCount * 40.0) * (player.lvlShieldDamageMult || 1.0);
        }

        this.hit(damage);
        if (!this.alive) return;

        this.state = AI_STATE.RECOVERY;

        // Scale invulnerability window based on speed
        // 0.6s at 400 speed (standard), 0.2s at 800 speed (high speed)
        const currentSpeed = this.baseSpeed * this.speedMult;
        const invulnDuration = Math.max(0.1, 0.6 - Math.max(0, (currentSpeed - 400) * 0.001));

        this.stateTimer = Math.max(0.4, invulnDuration);
        this.invulnTimer = invulnDuration;

        // Steer away from player
        const angleAway = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
        this.targetAngleOverride = angleAway + (Math.random() - 0.5) * 0.5;
        this.game.sounds.play('boost', { volume: 0.3, x: this.worldX, y: this.worldY });
    }

    _generateProceduralDebris() {
        if (!this.img || !this.img.width) return [];

        // ~13 organic shards for enemies (layout cached per sprite so kills
        // don't re-slice mid-combat; trajectories stay per-death random)
        const shards = getCachedShatter(this.img, this.spriteKey, 13);
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
        // Loot rolls (scrap count, battery/locator drops) use the spawn-time
        // content RNG so an enemy's drops are fixed at spawn, not at kill time.
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        const spawns = this._generateProceduralDebris();
        // Multiplayer: drops grow with the lobby (netScrapMult is 1 in solo).
        const scrapMult = (this.game.currentState && this.game.currentState.netScrapMult) || 1.0;
        const count = Math.round((3 + Math.floor(rand() * 3)) * scrapMult);
        const difficultyScale = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const expAmount = Math.floor((4 + 1 * difficultyScale) * (this.isUpgraded ? 1.5 : 1));

        for (let i = 0; i < count; i++) spawns.push(new Scrap(this.game, this.worldX, this.worldY));
        for (let i = 0; i < 4; i++) spawns.push(new Rubble(this.game, this.worldX, this.worldY));

        // Spawn ExpOrbs individually for explosion effect
        for (let i = 0; i < expAmount; i++) {
            spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));
        }

        // 25% chance to drop a small battery
        if (rand() < 0.25) {
            const battery = UPGRADES.find(u => u.id === 'small_battery');
            if (battery) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, battery));
            }
        }

        if (rand() < 0.01) {
            const locator = UPGRADES.find(u => u.id === 'advanced_locator');
            if (locator) {
                spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, locator));
            }
        }

        // Special enemies are a tougher fight → better loot:
        // 40% small battery, 7% common upgrade, 3% uncommon upgrade, 50% nothing.
        if (this.isSpecialEnemy) {
            const r = rand();
            let item = null;
            if (r < 0.40) {
                item = UPGRADES.find(u => u.id === 'small_battery');
            } else if (r < 0.47) {
                const pool = UPGRADES.filter(u => u.rarity === 'common' && !u.consumable);
                if (pool.length) item = pool[Math.floor(rand() * pool.length)];
            } else if (r < 0.50) {
                const pool = UPGRADES.filter(u => u.rarity === 'uncommon' && !u.consumable);
                if (pool.length) item = pool[Math.floor(rand() * pool.length)];
            }
            if (item) spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, item));
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
        const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
        const h = (this.img.height || this.img.canvas.height) * this.game.worldScale;

        // Yellow Armada: use yellow glow sprite
        if (this.yellowArmada) {
            const glow = Enemy.getGlowSprite(this.img, this.spriteKey, '#ffdd44');
            const pxScale = w / glow.srcW;
            const gw = glow.canvas.width * pxScale;
            const gh = glow.canvas.height * pxScale;
            ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
        } else
        // Upgraded enemies: use pre-rendered glow sprite instead of per-frame shadowBlur
        if (this.isUpgraded) {
            const glow = Enemy.getGlowSprite(this.img, this.spriteKey, '#ff4444');
            // Scale so sprite portion matches original w×h exactly
            const pxScale = w / glow.srcW;
            const gw = glow.canvas.width * pxScale;
            const gh = glow.canvas.height * pxScale;
            ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
        } else {
            ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
        }

        ctx.restore();

        // Ram wind-up charge-up flash
        this._drawWindupFlash(ctx, screen);

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

    // Shared glow-sprite cache (blur-60 canvas builds cost 5-15ms — once per
    // sprite/color combo for the whole session, instead of once per enemy).
    static _glowCache = new Map();
    static getGlowSprite(imgAsset, spriteKey, color) {
        const key = `${spriteKey || 'unknown'}|${color}`;
        let glow = Enemy._glowCache.get(key);
        if (glow) return glow;
        const srcImg = imgAsset.canvas || imgAsset;
        // Neon glow baked once into the sprite's footprint (still cheaper than the
        // old 60px halo, but spread wide and intense enough to read clearly).
        // Multiple shadow passes stack the glow's opacity so it's vivid, not faint.
        const blur = 40; // ~10 logical px (prescale 4)
        const pad = blur * 2;
        const c = document.createElement('canvas');
        c.width = srcImg.width + pad * 2;
        c.height = srcImg.height + pad * 2;
        const gctx = c.getContext('2d');
        gctx.shadowBlur = blur;
        gctx.shadowColor = color;
        gctx.drawImage(srcImg, pad, pad);
        gctx.drawImage(srcImg, pad, pad);
        gctx.drawImage(srcImg, pad, pad); // stacked passes intensify the glow
        gctx.shadowBlur = 0;
        gctx.drawImage(srcImg, pad, pad);
        glow = { canvas: c, srcW: srcImg.width };
        Enemy._glowCache.set(key, glow);
        return glow;
    }

    // opts.chanceMult scales the upgrade probability (specials use < 1 for a
    // slightly lower rate); opts.allowKamikaze is forwarded to _applyUpgrades.
    static rollUpgrade(enemy, player, opts = {}) {
        if (!player || !player.inventory) return;
        const chanceMult = opts.chanceMult != null ? opts.chanceMult : 1;
        const chance = player.inventory.items.length * 0.03 * chanceMult;
        // Seeded at spawn so the set of upgraded enemies is reproducible.
        const r = enemy.contentRng ? enemy.contentRng.next() : Math.random();
        if (r < chance) {
            enemy._applyUpgrades({ allowKamikaze: opts.allowKamikaze !== false });
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

        // Wave burst queue (dynamic: burst sizes rolled at fire time, can overshoot)
        this.waveQueue = 0;          // Intended enemies remaining; may go to 0 (or negative on overshoot)
        this.waveSpawnedTotal = 0;   // Enemies actually spawned this wave (basis for 90%-cleared check)
        this.waveMaxBurstSize = 3;   // Upper bound for this wave's burst-size roll
        this.waveBurstTimer = 0;     // Time until next burst fires
        this.waveSpawnScale = 1.0;   // Difficulty at time wave was triggered
        this.waveNumber = 0;         // Tracks which wave we're on
        this.lastBossType = null;

        this.spawnRateMult = 1.0;
        this.spawnRateTimer = 0;
    }

    applySpawnMultiplier(mult, duration) {
        this.spawnRateMult = mult;
        this.spawnRateTimer = duration;
    }

    // Special-enemy roster. The OVERALL fraction of spawns that are special ramps
    // with run time; waves pass a higher `chanceMult` so waves are special-heavy.
    // When a slot rolls special, a weighted pick among the UNLOCKED ships chooses
    // which. `start` = unlock time (s); `weight` = relative frequency. Adding a
    // special = one row. (Replaced the old per-entry first-hit-wins roll, which
    // capped the total rate far too low — only ~2 specials by 11 min.)
    _rollSpecialClass(rand, chanceMult = 1) {
        const t = (this.game.currentState && this.game.currentState.totalGameTime) || 0;
        const roster = [
            { ctor: NaniteEnemy,    start: 240, weight: 1.2 },
            { ctor: ScavengerEnemy, start: 300, weight: 1.0 },
            { ctor: MissileEnemy,   start: 360, weight: 1.0 },
            { ctor: BlinkEnemy,     start: 420, weight: 0.9 },
            { ctor: ShieldEnemy,    start: 480, weight: 0.9 },
            { ctor: BerserkEnemy,   start: 540, weight: 0.8 },
        ];
        // Special fraction over run time (t seconds): ~0 early, ~15% @ 12min,
        // ~40% @ 40min, ~50% @ 60min, then flat. Piecewise-linear through those
        // reference points. Waves multiply it up modestly (capped).
        let base;
        if (t < 720) base = 0.15 * (t / 720);
        else if (t < 2400) base = 0.15 + 0.25 * ((t - 720) / 1680);
        else if (t < 3600) base = 0.40 + 0.10 * ((t - 2400) / 1200);
        else base = 0.50;
        const frac = Math.min(0.75, base * chanceMult);
        if (rand() >= frac) return null;

        // Weighted pick among the unlocked specials.
        let totalW = 0;
        for (const e of roster) if (t >= e.start) totalW += e.weight;
        if (totalW <= 0) return null;
        let r = rand() * totalW;
        for (const e of roster) {
            if (t < e.start) continue;
            r -= e.weight;
            if (r <= 0) return e.ctor;
        }
        return null;
    }

    // Build one enemy for a spawn slot: a special (per the time-gated roll) or a
    // plain Enemy. `chanceMult` boosts the special rate for wave spawns. Upgrade
    // rolls are gated to plain enemies (specials are already distinct).
    _makeEnemy(x, y, scale, rand, player, chanceMult = 1) {
        const SpecialCls = this._rollSpecialClass(rand, chanceMult);
        if (SpecialCls) {
            const en = new SpecialCls(this.game, x, y, scale);
            // Specials can also be upgraded — at a slightly lower rate, and never
            // into kamikazes (they have their own identity/death behavior).
            Enemy.rollUpgrade(en, player, { chanceMult: 0.7, allowKamikaze: false });
            return en;
        }
        const en = new Enemy(this.game, x, y, scale);
        Enemy.rollUpgrade(en, player);
        return en;
    }

    forceBoss(playerX, playerY, difficultyScale) {
        const rand = () => this.game.rng ? this.game.rng.enemies.next() : Math.random();
        const bosses = [Starcore, AsteroidCrusher, EventHorizon];
        const BossClass = bosses[Math.floor(rand() * bosses.length)];
        this.lastBossType = BossClass.name;

        const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;
        const dist = 1600 * fov;
        const angle = rand() * Math.PI * 2;
        const boss = new BossClass(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale);
        const resolved = resolveSpawnOverlap(this.game, boss.worldX, boss.worldY, boss.radius);
        boss.worldX = resolved.x;
        boss.worldY = resolved.y;
        return [boss];
    }

    // quantityMult (multiplayer): scales how MANY enemies spawn — burst sizes
    // and ambient counts — without inflating per-enemy stats.
    update(rawDt, playerX, playerY, difficultyScale = 1.0, quantityMult = 1.0) {
        let dt = rawDt;
        if (this.spawnRateTimer > 0) {
            this.spawnRateTimer -= rawDt;
            dt = rawDt * this.spawnRateMult;
            if (this.spawnRateTimer <= 0) this.spawnRateMult = 1.0;
        }

        const spawned = [];
        const player = this.game.currentState.player;

        // Seeded enemy stream drives burst sizes, spawn positions, and burst/
        // peace timers so the wave/ambient cadence is reproducible. Per-enemy AI
        // stays on Math.random(). Falls back outside a run.
        const rand = () => this.game.rng ? this.game.rng.enemies.next() : Math.random();

        // --- Drain wave bursts (dynamic sizing) ---
        if (this.waveQueue > 0) {
            this.waveBurstTimer -= dt;

            if (this.waveBurstTimer <= 0) {
                const minBurst = 3;
                let burstSize;
                if (this.waveQueue < minBurst) {
                    // Final dump: leftover smaller than a normal burst
                    burstSize = this.waveQueue;
                } else {
                    // Random size in [minBurst, waveMaxBurstSize]. May overshoot the
                    // queue — that's intentional: harder wave, no normalization.
                    burstSize = minBurst + Math.floor(rand() * (this.waveMaxBurstSize - minBurst + 1));
                }

                this.waveQueue -= burstSize;
                this.waveSpawnedTotal += burstSize;

                const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;

                for (let i = 0; i < burstSize; i++) {
                    const angle = rand() * Math.PI * 2;
                    const dist = (1800 + rand() * 640) * fov;
                    const en = this._makeEnemy(playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, this.waveSpawnScale, rand, player, 1.3);
                    const resolved = resolveSpawnOverlap(this.game, en.worldX, en.worldY, en.radius);
                    en.worldX = resolved.x;
                    en.worldY = resolved.y;
                    en.waveTag = this.waveNumber;
                    spawned.push(en);
                }

                // Schedule next burst (7-12s) if queue still has enemies
                if (this.waveQueue > 0) {
                    this.waveBurstTimer = 7 + rand() * 5;
                }
            }
            return spawned;  // Don't run ambient burst spawns during a wave
        }

        // --- Ambient burst spawning ---
        this.phaseTimer -= dt;

        if (this.phase === 'peace') {
            if (this.phaseTimer <= 0) {
                // Peace is over — start a burst
                this.phase = 'burst';
                // 1-3 enemies per burst, scaling with difficulty (and lobby size)
                this.burstQueue = Math.max(1, Math.round(Math.floor(1 + rand() * Math.min(3, 1 + difficultyScale * 0.5)) * quantityMult));
                this.burstSpawnTimer = 0; // First enemy spawns immediately
                this.phaseTimer = 12 + rand() * 6; // Burst window ~12-18s
            }
            return [];
        }

        // Burst phase: spawn enemies at staggered intervals
        if (this.burstQueue > 0) {
            this.burstSpawnTimer -= dt;
            if (this.burstSpawnTimer <= 0) {
                this.burstQueue--;
                // Stagger spawns 3-6s apart within the burst
                this.burstSpawnTimer = 3 + rand() * 3;

                const angle = rand() * Math.PI * 2;
                const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;
                const dist = (1400 + rand() * 600) * fov;
                const en = this._makeEnemy(playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale, rand, player);
                const resolved = resolveSpawnOverlap(this.game, en.worldX, en.worldY, en.radius);
                en.worldX = resolved.x;
                en.worldY = resolved.y;
                spawned.push(en);
            }
        }

        // Burst window expired or all enemies spawned
        if (this.phaseTimer <= 0 || this.burstQueue <= 0) {
            this.phase = 'peace';
            // Peace lasts 30-50s, shortens slightly with difficulty (floor 20s)
            const basePeace = 30 + rand() * 20;
            this.phaseTimer = Math.max(20, basePeace / (1 + (difficultyScale - 1) * 0.15));
        }

        return spawned;
    }

    spawnWave(playerX, playerY, difficultyScale = 1.0, quantityMult = 1.0) {
        this.waveNumber++;
        this._waveQuantityMult = quantityMult;

        // Boss wave every 4 waves
        if (this.waveNumber % 4 === 0) {
            this.waveQueue = 0;
            this.waveSpawnedTotal = 0;
            this.waveMaxBurstSize = 3;
            this.waveBurstTimer = 0;
            this.waveSpawnScale = difficultyScale;

            // Seeded so boss waves (type + placement) are reproducible.
            const rand = () => this.game.rng ? this.game.rng.enemies.next() : Math.random();

            // Spawn boss at a distance
            const angle = rand() * Math.PI * 2;
            const dist = 1600;

            // Randomly choose between available bosses, excluding the last one
            const bosses = [Starcore, AsteroidCrusher, EventHorizon];
            const availableBosses = bosses.filter(b => b.name !== this.lastBossType);

            // Final fallback if all filtered (shouldn't happen with 2+ bosses)
            const pool = availableBosses.length > 0 ? availableBosses : bosses;
            const BossClass = pool[Math.floor(rand() * pool.length)];

            this.lastBossType = BossClass.name;
            const boss = new BossClass(this.game, playerX + Math.cos(angle) * dist, playerY + Math.sin(angle) * dist, difficultyScale);
            const bossResolved = resolveSpawnOverlap(this.game, boss.worldX, boss.worldY, boss.radius);
            boss.worldX = bossResolved.x;
            boss.worldY = bossResolved.y;

            return [boss];
        }

        // First wave: max 3 enemies. Later waves grow with difficulty
        // (multiplied by lobby size in multiplayer).
        let count;
        if (this.waveNumber === 1) {
            count = 3;
        } else {
            count = Math.floor(2 + difficultyScale);
        }
        count = Math.max(1, Math.round(count * quantityMult));

        // Burst sizing is fully dynamic now: each burst rolls its size at fire time,
        // can overshoot the queue (harder wave), and a sub-minimum remainder gets
        // dumped as the final small burst. Cache the per-wave max here.
        // Max grows 3 → 16 across waves: ~3 at wave 1, ~16 by wave 26+.
        this.waveMaxBurstSize = Math.min(16, 3 + Math.floor(this.waveNumber / 1.8));
        this.waveQueue = count;
        this.waveSpawnedTotal = 0;
        this.waveBurstTimer = 0.8; // First burst delay — let the wave-start flash breathe
        this.waveSpawnScale = difficultyScale;

        // Return empty — enemies will be spawned via update() in bursts
        return [];
    }

    serialize() {
        return {
            phase: this.phase,
            phaseTimer: this.phaseTimer,
            burstQueue: this.burstQueue,
            burstSpawnTimer: this.burstSpawnTimer,
            waveQueue: this.waveQueue,
            waveSpawnedTotal: this.waveSpawnedTotal,
            waveMaxBurstSize: this.waveMaxBurstSize,
            waveBurstTimer: this.waveBurstTimer,
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
        this.waveSpawnedTotal = data.waveSpawnedTotal || 0;
        this.waveMaxBurstSize = data.waveMaxBurstSize || 3;
        this.waveBurstTimer = data.waveBurstTimer || 0;
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
        this.health = Math.ceil(18 + 9 * difficultyScale);

        // Disable shooting
        this.attackRange = -1; // Never enter ATTACK state based on distance
    }

    shoot() {
        // Do nothing, they don't shoot
    }

    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        this._updateRamCycle(dt, dist, angleToPlayer, distMult);
    }

    getSpawnOnDeath() {
        // Use inherited procedural debris
        const spawns = this._generateProceduralDebris();
        const difficultyScale = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const expAmount = Math.floor((4 + 1 * difficultyScale) * (this.isUpgraded ? 1.5 : 1));
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const scrapMult = (this.game.currentState && this.game.currentState.netScrapMult) || 1.0;
        const count = Math.round((1 + Math.floor(Math.random() * 2)) * scrapMult);
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

        // Ram wind-up charge-up flash
        this._drawWindupFlash(ctx, screen);
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
        this.health = Math.ceil(18 + 10 * difficultyScale);

        // Disable shooting
        this.attackRange = -1;
    }

    shoot() {
        // Do nothing, they don't shoot
    }

    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        this._updateRamCycle(dt, dist, angleToPlayer, distMult);
    }

    getSpawnOnDeath() {
        const spawns = this._generateProceduralDebris();
        const difficultyScale = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const expAmount = Math.floor((4 + 1 * difficultyScale) * (this.isUpgraded ? 1.5 : 1));
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const scrapMult = (this.game.currentState && this.game.currentState.netScrapMult) || 1.0;
        const count = Math.round((1 + Math.floor(Math.random() * 2)) * scrapMult);
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

        // Ram wind-up charge-up flash
        this._drawWindupFlash(ctx, screen);
    }
}

// ── Nanite: a carrier that bursts into a swarm of fast ram-drones on death ──
// The "splitter" of the special roster. Fights like a normal enemy while alive;
// its threat is what it leaves behind. Shares its swarm identity with the
// planned end-game swarm event.
export class NaniteEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `nanite_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // Tougher than a standard enemy — it's a payload that should survive long
        // enough to get into the fight before splitting.
        this.health = Math.ceil(24 + 14 * difficultyScale);
        this.maxHealth = this.health;

        // Tougher fight than chaff → better loot drops (see getSpawnOnDeath).
        this.isSpecialEnemy = true;

        // How many drones it bursts into on death.
        this.droneCount = 3 + Math.floor(Math.random() * 2); // 3-4
    }

    getSpawnOnDeath() {
        // Standard carrier loot (it's a special, so a normal payout) ...
        const spawns = super.getSpawnOnDeath();
        // ... plus the swarm. Drones are live enemies — playingState routes any
        // Enemy in this list through _addEnemies (see _handleEntityDeath).
        const ds = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        for (let i = 0; i < this.droneCount; i++) {
            const ang = Math.random() * Math.PI * 2;
            const r = 25 + Math.random() * 30; // scatter off the corpse
            const drone = new NaniteDrone(
                this.game,
                this.worldX + Math.cos(ang) * r,
                this.worldY + Math.sin(ang) * r,
                ds
            );
            // Coast outward from the corpse during the dormant phase, then wake.
            const driftSpeed = 170 + Math.random() * 130;
            drone.vx = Math.cos(ang) * driftSpeed;
            drone.vy = Math.sin(ang) * driftSpeed;
            drone.angle = ang;
            spawns.push(drone);
        }
        return spawns;
    }
}

// Individual nanite drone — small, fast, fragile, ram-only. Spawned in bursts by
export class NaniteDrone extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 5);
        this.spriteKey = `nanite_drone_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // Fast and fragile — a cloud of these is a dodge problem, not an HP wall.
        const speedScale = 1 + (difficultyScale - 1) * 0.1;
        this.baseSpeed = Math.min(1100, (450 + Math.random() * 80) * speedScale);
        this.turnSpeed = 8.0 + Math.random() * 1.5;
        this.health = Math.ceil(4 + 2 * difficultyScale);
        this.maxHealth = this.health;

        // Ram-only, like the kamikaze line.
        this.attackRange = -1;

        // Dormant on spawn: coast outward from the corpse (velocity is set by the
        // carrier in getSpawnOnDeath), then wake and hunt after a staggered delay.
        // While dormant they deal no contact damage (see PlayingState ram loop).
        this.dormant = true;
        this.activationTimer = 0.2 + Math.random() * 1.8;
    }

    shoot() { /* drones don't shoot */ }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.dormant) {
            this.activationTimer -= dt;
            // Drift outward, decelerating, so the swarm spreads before it activates.
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;
            const decay = Math.pow(0.1, dt); // ~slows to a crawl over a second
            this.vx *= decay;
            this.vy *= decay;
            this.freezeTimer = Math.max(0, this.freezeTimer - dt);
            this.invulnTimer = Math.max(0, this.invulnTimer - dt);
            if (this.activationTimer <= 0) this.dormant = false;
            return;
        }
        super.update(dt, player, asteroids, projectiles, enemies);
    }

    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        this._updateRamCycle(dt, dist, angleToPlayer, distMult);
    }

    getSpawnOnDeath() {
        // Minimal payout — the carrier already paid out; these are just chaff.
        const spawns = this._generateProceduralDebris();
        spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));
        return spawns;
    }
}

// ── Shield enemy: a directional FRONT shield that mirrors the player's. Shots
// striking the front arc are absorbed by a small regenerating pool; flank/rear
// shots hit the hull directly. Regen only starts after a delay since the last
// shield hit, so under sustained fire the pool drains faster than it recovers —
// the intended rhythm is "break the shield → window → kill". Flanking beats it. ──
export class ShieldEnemy extends Enemy {
    // Tuning knobs (ARC_HALF is tuned against enemy_shield.png — the sprite's arc).
    static ARC_HALF = Math.PI * 0.42;   // half-angle of the shielded front cone (~76°, ~152° total)
    static REGEN_DELAY = 1.5;           // seconds since last shield hit before regen begins
    static BREAK_DURATION = 3.0;        // seconds the shield stays fully down after breaking
    static REGEN_SECONDS = 3.0;         // pool regrows from empty→full over ~this long

    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `shield_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // Tanky hull — well over 2x a regular enemy (10+10*d) on top of the front
        // shield, so it's a genuine bullet-sponge from the front and still tough
        // when flanked.
        this.health = Math.ceil(22 + 22 * difficultyScale);
        this.maxHealth = this.health;

        // Just slightly below a regular enemy ship's cruise speed (92% of it).
        const speedScale = 1 + (difficultyScale - 1) * 0.08;
        this.baseSpeed = Math.min(900, (320 + Math.random() * 80) * speedScale) * 0.92;

        // Tougher fight than chaff → better loot drops (see getSpawnOnDeath).
        this.isSpecialEnemy = true;

        // Directional shield pool (acts as front-facing effective HP).
        this.shieldMax = Math.ceil(30 + 16 * difficultyScale);
        this.shieldHP = this.shieldMax;
        this.shieldBroken = false;
        this.shieldRegenCooldown = 0;
        this.shieldBreakTimer = 0;
        this.shieldJustBroke = false; // one-frame flag for break VFX (read+cleared by PlayingState)
        this._shieldHitFlash = 0;
        this._shieldImg = null;
    }

    get shieldActive() { return !this.shieldBroken && this.shieldHP > 0; }

    // True if the projectile is absorbed by the front shield (no hull damage).
    // Caller passes only player-owned projectiles; runs on the authoritative sim.
    tryBlock(proj) {
        if (!this.shieldActive) return false;
        // Is the shot coming from within the shielded front cone? Forward = this.angle.
        const toProj = Math.atan2(proj.worldY - this.worldY, proj.worldX - this.worldX);
        let d = toProj - this.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        if (Math.abs(d) > ShieldEnemy.ARC_HALF) return false;

        this.shieldHP -= proj.damage;
        this.shieldRegenCooldown = ShieldEnemy.REGEN_DELAY;
        this._shieldHitFlash = 0.15;
        if (this.shieldHP <= 0) {
            this.shieldHP = 0;
            this.shieldBroken = true;
            this.shieldBreakTimer = ShieldEnemy.BREAK_DURATION;
            this.shieldJustBroke = true;
        }
        return true;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this._shieldHitFlash > 0) this._shieldHitFlash -= dt;
        if (this.shieldBroken) {
            this.shieldBreakTimer -= dt;
            if (this.shieldBreakTimer <= 0) { this.shieldBroken = false; this.shieldRegenCooldown = 0; }
        } else if (this.shieldHP < this.shieldMax) {
            if (this.shieldRegenCooldown > 0) this.shieldRegenCooldown -= dt;
            else this.shieldHP = Math.min(this.shieldMax, this.shieldHP + (this.shieldMax / ShieldEnemy.REGEN_SECONDS) * dt);
        }
        super.update(dt, player, asteroids, projectiles, enemies);
    }

    draw(ctx, camera) {
        super.draw(ctx, camera); // hull (+ any upgrade glow / windup flash)
        if (!this.shieldActive) return;
        if (this.invulnTimer > 0 && Math.floor(Date.now() / 50) % 2 === 0) return;
        if (!this._shieldImg) this._shieldImg = this.game.assets.get('enemy_shield');
        const img = this._shieldImg;
        if (!img) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const sw = (img.width || img.canvas.width) * this.game.worldScale;
        const sh = (img.height || img.canvas.height) * this.game.worldScale;
        // Brighten briefly on a recent block (mirrors the player's impact surge).
        const flash = Math.max(0, this._shieldHitFlash) / 0.15;
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.35 * flash;
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2); // sprite up = forward, arc sits over the nose
        ctx.drawImage(img.canvas || img, -sw / 2, -sh / 2, sw, sh);
        ctx.restore();
    }
}

// ── Missile enemy: fights with normal front lasers (the base `shoot`) and, every
// few seconds, lobs a salvo of missiles out its SIDES (Event-Horizon style). The
// missiles fan out, home in hard for a moment, then lock heading and DASH straight
// at speed — so they swerve toward you, then commit to a fast line you must dodge. ──
export class MissileEnemy extends Enemy {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `missile_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // 2x a regular enemy's health (10+10*d). Front weapon is the stock laser
        // (base shoot); side missiles are a separate timed salvo.
        this.health = Math.ceil(20 + 20 * difficultyScale);
        this.maxHealth = this.health;
        this.missileTimer = 1.5 + Math.random() * 1.5; // first salvo soon after engaging

        // Tougher fight than chaff → better loot drops (see getSpawnOnDeath).
        this.isSpecialEnemy = true;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        super.update(dt, player, asteroids, projectiles, enemies); // movement + front lasers
        // Periodic side-missile salvo when a player is within range.
        this.missileTimer -= dt;
        if (this.missileTimer <= 0) {
            this.missileTimer = 2.0 + Math.random() * 1.5; // every ~2-3.5s
            const target = this.game.currentState && this.game.currentState.player;
            if (target) {
                const dx = target.worldX - this.worldX, dy = target.worldY - this.worldY;
                if (dx * dx + dy * dy < 1500 * 1500) this._fireSideMissiles(target);
            }
        }
    }

    _fireSideMissiles(target) {
        const damage = (7 + 2.0 * this.difficultyScale) * this.damageMult;
        for (const side of [1, -1]) {
            // Launch from the side mounts, pointing straight out the side.
            const offsetY = 50 * side;
            const px = this.worldX - 8 * Math.cos(this.angle) - offsetY * Math.sin(this.angle);
            const py = this.worldY - 8 * Math.sin(this.angle) + offsetY * Math.cos(this.angle);
            const launchAngle = this.angle + (Math.PI / 2) * side;

            const proj = new Projectile(this.game, px, py, launchAngle, 300, 'red_laser_ball_big', this, damage, 6.0);
            proj.isRocket = true;
            proj.target = target;
            proj.turnRate = 3.2;   // homes hard during the seek window...
            proj.homeTimer = 0.9;  // ...for ~0.9s, then:
            proj.dashSpeed = 950;  // locks heading and dashes straight, fast.
            this.pendingProjectiles.push(proj);
        }
        this.game.sounds.play('railgun_shoot', { volume: 0.4, x: this.worldX, y: this.worldY });
    }
}

// ── Blink enemy: a fragile teleport-strafer. It fights with normal lasers, then
// every couple seconds BLINKS to a new firing angle around the player. Every jump
// has a fair tell — it freezes, flares violet, and a ghost of itself fades in at
// the destination — so a sharp player can pre-aim the landing spot. Tests aim/
// prediction and counters lock-on/tracking. The jump uses the looper's teleport
// space-collapse screen morph (PlayingState._blinkWarp → getScreenFx collapse). ──
export class BlinkEnemy extends Enemy {
    static TELEGRAPH_TIME = 0.45;  // pre-blink tell (frozen + ghost shown)
    static BLINK_MIN = 1.6;        // seconds between blinks
    static BLINK_RAND = 1.2;

    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `blink_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // 1.9x a regular enemy's health (10+10*d).
        this.health = Math.ceil(19 + 19 * difficultyScale);
        this.maxHealth = this.health;

        this.blinkTimer = BlinkEnemy.BLINK_MIN + Math.random() * BlinkEnemy.BLINK_RAND;
        this.telegraphing = false;
        this.telegraphTimer = 0;
        this.blinkDestX = 0;
        this.blinkDestY = 0;

        this.isSpecialEnemy = true;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        // Charging a blink: freeze in place (the tell), no movement/shooting.
        if (this.telegraphing) {
            this.vx = 0; this.vy = 0;
            this.invulnTimer = Math.max(0, this.invulnTimer - dt);
            this.telegraphTimer -= dt;
            if (this.telegraphTimer <= 0) this._commitBlink();
            return;
        }

        super.update(dt, player, asteroids, projectiles, enemies);

        this.blinkTimer -= dt;
        if (this.blinkTimer <= 0) {
            const target = this.game.currentState && this.game.currentState.player;
            if (target) {
                const dx = target.worldX - this.worldX, dy = target.worldY - this.worldY;
                if (dx * dx + dy * dy < 1500 * 1500) { this._startTelegraph(target); return; }
            }
            this.blinkTimer = 1.0; // not engaged — retry soon
        }
    }

    _startTelegraph(target) {
        // Destination: a new firing angle AROUND the player at a fixed combat range,
        // swung off its current bearing so it visibly relocates (and the player has
        // to re-acquire it).
        const bearing = Math.atan2(this.worldY - target.worldY, this.worldX - target.worldX);
        const side = Math.random() > 0.5 ? 1 : -1;
        const swing = (Math.PI * 0.5 + Math.random() * Math.PI * 0.5) * side; // 90-180° around
        const destAng = bearing + swing;
        const combatDist = 420 + Math.random() * 160;
        const resolved = resolveSpawnOverlap(
            this.game,
            target.worldX + Math.cos(destAng) * combatDist,
            target.worldY + Math.sin(destAng) * combatDist,
            this.radius
        );
        this.blinkDestX = resolved.x;
        this.blinkDestY = resolved.y;

        this.telegraphing = true;
        this.telegraphTimer = BlinkEnemy.TELEGRAPH_TIME;
        this.vx = 0; this.vy = 0;
        // Warp the screen inward at the spot it's leaving FROM — peaks as it
        // teleports away (end of the tell).
        const st = this.game.currentState;
        if (st) st._blinkWarp = { x: this.worldX, y: this.worldY, t: BlinkEnemy.TELEGRAPH_TIME, dur: BlinkEnemy.TELEGRAPH_TIME, depart: true };
        this.game.sounds.play('teleport', { volume: 0.3, x: this.worldX, y: this.worldY });
    }

    _commitBlink() {
        const state = this.game.currentState;
        const ox = this.worldX, oy = this.worldY;

        // Collapse ring where it leaves...
        if (state && state.cinematics) {
            state.cinematics.spawnRing(ox, oy, { color: '#b066ff', maxR: this.radius * 1.7, dur: 0.25, width: 3 });
        }

        // ...jump...
        this.worldX = this.blinkDestX;
        this.worldY = this.blinkDestY;
        this.vx = 0; this.vy = 0;
        this.telegraphing = false;
        this._nearPlayer = true; // hittable at the new spot this frame
        this.blinkTimer = BlinkEnemy.BLINK_MIN + Math.random() * BlinkEnemy.BLINK_RAND;

        // ...arrival ring + sparks + the looper-style space-collapse screen morph.
        if (state && state.cinematics) {
            state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#b066ff', maxR: this.radius * 1.9, dur: 0.3, width: 3 });
        }
        if (state && state._spawnSparks) {
            state._spawnSparks(this.worldX, this.worldY, 9, { color: '#cc99ff', speedMin: 90, speedMax: 250 });
        }
        if (state) state._blinkWarp = { x: this.worldX, y: this.worldY, t: 0.4, dur: 0.4, depart: false };
        this.game.sounds.play('teleport', { volume: 0.45, x: this.worldX, y: this.worldY });
    }

    draw(ctx, camera) {
        // Ghost of itself fading in at the destination during the tell.
        if (this.telegraphing && this.img) {
            const ghost = camera.worldToScreen(this.blinkDestX, this.blinkDestY, this.game.width, this.game.height);
            const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
            const h = (this.img.height || this.img.canvas.height) * this.game.worldScale;
            const prog = 1 - Math.max(0, this.telegraphTimer) / BlinkEnemy.TELEGRAPH_TIME; // 0→1
            ctx.save();
            ctx.globalAlpha = 0.15 + 0.4 * prog;
            ctx.translate(ghost.x, ghost.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
            ctx.restore();
        }

        super.draw(ctx, camera); // the real hull at its current spot

        // Violet charge flare on the real ship while telegraphing.
        if (this.telegraphing && this.img) {
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const glow = Enemy.getGlowSprite(this.img, this.spriteKey, '#b066ff');
            const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
            const pxScale = w / glow.srcW;
            const gw = glow.canvas.width * pxScale;
            const gh = glow.canvas.height * pxScale;
            const pulse = 0.45 + 0.55 * Math.abs(Math.sin(Date.now() / 60));
            ctx.save();
            ctx.globalAlpha = pulse;
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
            ctx.restore();
        }
    }
}

// ── Berserk enemy: fights normally until it drops below HALF health, then ENRAGES
// — every stat but health ramps up (speed/turn/fire-rate/damage), it glows molten
// hot, and it periodically unleashes a DEATH BLOSSOM: spins in place spraying
// lasers out in a spiral. Exposed while it spins, so it's a risk/reward target. ──
export class BerserkEnemy extends Enemy {
    static BLOSSOM_DURATION = 1.5;
    static BLOSSOM_SPIN = 9.0;            // rad/s while blossoming
    static BLOSSOM_FIRE_INTERVAL = 0.05;  // rapid radial fire

    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `berserk_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // 2x a regular enemy's health (10+10*d). Below half it ENRAGES.
        this.health = Math.ceil(20 + 20 * difficultyScale);
        this.maxHealth = this.health;

        this.enraged = false;
        this.blossoming = false;
        this.blossomTimer = 0;       // counts down to the next blossom (only when enraged)
        this.blossomTime = 0;        // remaining duration of the active blossom
        this.blossomShootTimer = 0;
        this.blossomSpinDir = 1;

        this.isSpecialEnemy = true;
    }

    update(dt, player, asteroids, projectiles, enemies) {
        if (this.blossoming) { this._updateBlossom(dt); return; }

        super.update(dt, player, asteroids, projectiles, enemies);

        if (!this.enraged && this.health <= this.maxHealth * 0.5) this._enrage();

        if (this.enraged && this.blossomTimer > 0) {
            this.blossomTimer -= dt;
            if (this.blossomTimer <= 0) {
                const target = this.game.currentState && this.game.currentState.player;
                if (target) {
                    const dx = target.worldX - this.worldX, dy = target.worldY - this.worldY;
                    if (dx * dx + dy * dy < 1200 * 1200) { this._startBlossom(); return; }
                }
                this.blossomTimer = 1.5; // out of range — check again soon
            }
        }
    }

    _enrage() {
        this.enraged = true;
        // Everything but health ramps up.
        this.speedMult *= 1.5;
        this.turnSpeed = Math.min(16, this.turnSpeed * 1.4);
        this.fireRateMult *= 2.0;
        this.damageMult *= 1.4;
        this.burstShotsMax += 2;
        this.blossomTimer = 2.5 + Math.random() * 2.5; // first blossom shortly after

        const state = this.game.currentState;
        if (state) {
            if (state.cinematics) state.cinematics.spawnRing(this.worldX, this.worldY, { color: '#ff7733', maxR: this.radius * 2.4, dur: 0.4, width: 4 });
            if (state._spawnSparks) state._spawnSparks(this.worldX, this.worldY, 14, { color: '#ffaa55', speedMin: 120, speedMax: 360 });
            if (state._triggerShakeAt) state._triggerShakeAt(this.worldX, this.worldY, 1.2);
        }
        this.game.sounds.play('ship_explode', { volume: 0.3, x: this.worldX, y: this.worldY });
    }

    _startBlossom() {
        this.blossoming = true;
        this.blossomTime = BerserkEnemy.BLOSSOM_DURATION;
        this.blossomShootTimer = 0;
        this.blossomSpinDir = Math.random() > 0.5 ? 1 : -1;
        this.game.sounds.play('railgun_target', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    _updateBlossom(dt) {
        this.blossomTime -= dt;
        // Spin in place, bleeding off any momentum.
        this.angle += BerserkEnemy.BLOSSOM_SPIN * this.blossomSpinDir * dt;
        const fr = Math.pow(0.86, dt * 60);
        this.vx *= fr; this.vy *= fr;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.invulnTimer = Math.max(0, this.invulnTimer - dt);
        this.freezeTimer = Math.max(0, this.freezeTimer - dt);

        this.blossomShootTimer -= dt;
        if (this.blossomShootTimer <= 0) {
            this.blossomShootTimer = BerserkEnemy.BLOSSOM_FIRE_INTERVAL;
            this._fireBlossomShot();
        }
        if (this.blossomTime <= 0) {
            this.blossoming = false;
            this.blossomTimer = 3.5 + Math.random() * 3.0; // next blossom later
        }
    }

    _fireBlossomShot() {
        const speed = 680;
        const damage = (8 + 2.0 * this.difficultyScale) * this.damageMult;
        const arms = 2; // double spiral
        for (let i = 0; i < arms; i++) {
            const a = this.angle + (Math.PI * 2 / arms) * i;
            const px = this.worldX + Math.cos(a) * 22;
            const py = this.worldY + Math.sin(a) * 22;
            this.pendingProjectiles.push(new Projectile(this.game, px, py, a, speed, 'red_laser_ball', this, damage, 2.5));
        }
        this.game.sounds.play('laser', { volume: 0.18, x: this.worldX, y: this.worldY });
    }

    draw(ctx, camera) {
        super.draw(ctx, camera);
        if (!this.enraged || !this.img) return;
        // Molten heat glow when enraged — hotter (white-ish) during a death blossom.
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const color = this.blossoming ? '#ffcc66' : '#ff7733';
        const glow = Enemy.getGlowSprite(this.img, this.spriteKey, color);
        const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
        const pxScale = w / glow.srcW;
        const gw = glow.canvas.width * pxScale;
        const gh = glow.canvas.height * pxScale;
        const pulse = (this.blossoming ? 0.6 : 0.4) + 0.35 * Math.abs(Math.sin(Date.now() / 80));
        ctx.save();
        ctx.globalAlpha = pulse;
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        ctx.drawImage(glow.canvas, -gw / 2, -gh / 2, gw, gh);
        ctx.restore();
    }
}

// ── Scavenger enemy: a loot thief with the most distinct AI. It darts in, fires a
// few shots to provoke, grabs floating items/scrap with a stronger vacuum, then
// runs just outside engagement range to loiter and dodge — every so often diving
// back in. Stolen loot it HOLDS still ages and can despawn; kill it before then
// and it drops everything it's still carrying + 20% more scrap than it grabbed.
// Marked with a yellow "!" indicator instead of the red one. ──
export class ScavengerEnemy extends Enemy {
    static VACUUM_RANGE = 190;    // "stronger vacuum" — captures loot it flies near
    static HOLD_LIFE = 30;        // seconds a stolen item/scrap survives in its hold
    static SEARCH_RANGE = 1100;   // how far it'll chase loot

    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);

        const variant = Math.floor(Math.random() * 3);
        this.spriteKey = `scavenger_${variant}`;
        this.img = game.assets.get(this.spriteKey);
        this._nativeRadius = CollisionScanner.getRadius(this.img, this.spriteKey);
        this.radius = this._nativeRadius * 0.95;

        // Evasive, not tanky — you have to chase it down to reclaim its haul.
        this.health = Math.ceil(14 + 13 * difficultyScale);
        this.maxHealth = this.health;
        const speedScale = 1 + (difficultyScale - 1) * 0.08;
        this.baseSpeed = Math.min(950, (400 + Math.random() * 80) * speedScale); // nimble
        this.turnSpeed = Math.min(15, this.turnSpeed * 1.2);

        // Yellow "!" off-screen indicator instead of the red enemy one.
        this.indicatorColor = '#ffdd44';

        // Vacuum identity: PlayingState pulls nearby loot toward us (visual suck-in)
        // and calls captureLoot() once a piece reaches us.
        this.isScavenger = true;
        this.vacuumRange = ScavengerEnemy.VACUUM_RANGE;

        // Stolen loot — each entry ages and despawns; released on death.
        // { item: <upgrade data|null>, scrap: <value>, life }
        this.heldLoot = [];
        this.targetItem = null;
        this._fleeJitter = 0;
        this._fleeSide = 1;

        this.isSpecialEnemy = true;
        this._enterAttack();
    }

    // High-level behaviour — drives the base movement/avoidance/dodge/shooting by
    // setting this.state + targetAngleOverride (we don't touch base movement).
    _updateAIState(dt, dist, angleToPlayer, player, enemies, distMult) {
        this.stateTimer -= dt;
        this._tickHeldLoot(dt);

        const engage = this.attackRange * distMult;
        const fleeBand = engage * 1.35;

        switch (this.scavState) {
            case 'attack':
                this.state = AI_STATE.ATTACK; // base heads to player + fires
                if (this.burstShotsLeft <= 0 || dist < engage * 0.4 || this.stateTimer <= 0) {
                    if (this._findTargetItem()) this._enterCollect();
                    else this._enterFlee(angleToPlayer);
                }
                break;

            case 'collect': {
                this.state = AI_STATE.BREAK; // fast, no fire
                let it = this.targetItem;
                if (!it || !it.alive) {
                    // Grabbed it (or it vanished) — chain to the next nearby item
                    // until the collect window runs out, then run off.
                    if (this.stateTimer > 0 && this._findTargetItem()) it = this.targetItem;
                    else { this._enterFlee(angleToPlayer); break; }
                }
                if (this.stateTimer <= 0) { this._enterFlee(angleToPlayer); break; }
                this.targetAngleOverride = Math.atan2(it.worldY - this.worldY, it.worldX - this.worldX);
                break;
            }

            case 'flee':
            default:
                this.state = AI_STATE.REPOSITION; // fast, no fire
                if (dist < fleeBand) {
                    this.targetAngleOverride = angleToPlayer + Math.PI + this._fleeJitter; // run off
                } else {
                    this.targetAngleOverride = angleToPlayer + (Math.PI / 2) * this._fleeSide; // loiter at range
                }
                if (this.stateTimer <= 0) this._enterAttack(); // dive back in to provoke
                break;
        }
    }

    _enterAttack() {
        this.scavState = 'attack';
        this.state = AI_STATE.ATTACK;
        this.attackPassCount = 1;  // skip the first-pass speed throttle — dart in
        this.burstShotsLeft = 2 + Math.floor(Math.random() * 2);
        this.shootTimer = 0.15;
        this.stateTimer = 3.0;
    }
    _enterCollect() { this.scavState = 'collect'; this.stateTimer = 3.5; }
    _enterFlee(angleToPlayer) {
        this.scavState = 'flee';
        this.stateTimer = 1.6 + Math.random() * 1.6;
        this._fleeJitter = (Math.random() - 0.5) * 0.6;
        this._fleeSide = Math.random() > 0.5 ? 1 : -1;
    }

    _findTargetItem() {
        const st = this.game.currentState;
        if (!st) return false;
        const maxSq = ScavengerEnemy.SEARCH_RANGE * ScavengerEnemy.SEARCH_RANGE;
        let best = null, bestD = maxSq;
        const scan = (arr) => {
            if (!arr) return;
            for (const e of arr) {
                if (!e.alive) continue;
                const dx = e.worldX - this.worldX, dy = e.worldY - this.worldY;
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = e; }
            }
        };
        scan(st.itemPickups);              // prefer upgrade pickups...
        if (!best) scan(st.scrapEntities);  // ...then scrap
        this.targetItem = best;
        return !!best;
    }

    // Called by PlayingState once a vacuumed item/scrap has been pulled in close.
    // Stores it in the haul (each piece ages) and plays a small "tic" as it lands.
    captureLoot(entity) {
        if (this.heldLoot.length < 200) {
            if (entity.item) {
                this.heldLoot.push({ item: entity.item, scrap: 0, life: ScavengerEnemy.HOLD_LIFE });
                const st = this.game.currentState;
                if (st && st.spawnFloatingText) st.spawnFloatingText(this.worldX, this.worldY, 'STOLEN', '#ffdd44');
            } else {
                this.heldLoot.push({ item: null, scrap: entity.value || 1, life: ScavengerEnemy.HOLD_LIFE });
            }
        }
        entity.alive = false;
        this.game.sounds.play('type', { volume: 0.35, x: this.worldX, y: this.worldY });
    }

    _tickHeldLoot(dt) {
        for (let i = this.heldLoot.length - 1; i >= 0; i--) {
            this.heldLoot[i].life -= dt;
            if (this.heldLoot[i].life <= 0) this.heldLoot.splice(i, 1); // despawned in the hold
        }
    }

    getSpawnOnDeath() {
        const spawns = super.getSpawnOnDeath();
        // Release everything still held + a 20% scrap jackpot.
        let scrapValue = 0;
        for (const e of this.heldLoot) {
            if (e.item) spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, e.item));
            else scrapValue += e.scrap;
        }
        const total = scrapValue * 1.2;
        if (total > 0) {
            const n = Math.min(30, Math.max(1, Math.round(total / 4)));
            const per = Math.max(1, Math.round(total / n));
            for (let i = 0; i < n; i++) {
                const s = new Scrap(this.game, this.worldX, this.worldY);
                s.value = per;
                spawns.push(s);
            }
        }
        return spawns;
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

        this.attackRange = 850 * scaleDist;
        this.breakRange = 500 * scaleDist;
        this.reversalTriggerDist = 450 * scaleDist;
    }

    /**
     * When an encounter first turns hostile, give it a brief grace window and
     * have it quickly back away from the player to open up some fighting space
     * before it starts its attack runs.
     */
    startEvasiveEntry(player, invulnDuration = 1.5) {
        this.invulnTimer = Math.max(this.invulnTimer, invulnDuration);

        // Face directly away from the player so the retreat is immediate (no
        // turn-in delay), and use BREAK so it sprints at boosted speed for a
        // short burst before reverting to PURSUIT.
        const awayAngle = Math.atan2(this.worldY - player.worldY, this.worldX - player.worldX);
        this.angle = awayAngle;
        this.targetAngleOverride = awayAngle;
        this.state = AI_STATE.BREAK;
        this.stateTimer = 0.6;
    }

    hit(damage) {
        if (this.invulnTimer > 0 || this.isDying) return false;
        this.health -= damage;

        if (this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ff4444');
        }

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

        // Only grant loot from scenarios that actually offered a hostile path —
        // killing the ship implies the player took that path. Without this gate,
        // any HostileEncounter (including those spawned by other systems) would
        // erroneously drop the dialog's rewards.
        const hasHostilePath = this.rawScenario.options.some(o =>
            o.actions && o.actions.includes('convert_hostile')
        );
        if (!hasHostilePath) return;

        const abstractActions = ['reveal_shop', 'reveal_event', 'reveal_event_2', 'heal', 'add_perm_health', 'add_scrap', 'add_upgrade'];

        // Collect rewards across every option so the trader drops what they
        // were offering (buy/haggle options hold the add_upgrade, not the
        // convert_hostile option itself). Dedupe by action string so the same
        // upgrade listed under both Buy and Haggle only drops once.
        const seen = new Set();
        const rewardActions = [];
        for (const opt of this.rawScenario.options) {
            if (!opt.actions) continue;
            for (const act of opt.actions) {
                if (seen.has(act)) continue;
                const colonIdx = act.indexOf(':');
                const type = colonIdx >= 0 ? act.slice(0, colonIdx) : act;
                if (!abstractActions.includes(type)) continue;
                seen.add(act);
                rewardActions.push(act);
            }
        }

        const resolveScrap = (paramStr) => {
            if (!paramStr) return 0;
            const v = this.encounterVars[paramStr];
            if (typeof v === 'number') return v;
            const num = parseInt(paramStr, 10);
            return isNaN(num) ? 0 : num;
        };

        for (const act of rewardActions) {
            const colonIdx = act.indexOf(':');
            const type = colonIdx >= 0 ? act.slice(0, colonIdx) : act;
            const paramStr = colonIdx >= 0 ? act.slice(colonIdx + 1) : null;

            switch (type) {
                case 'reveal_shop':
                    state.spawnDistantShop();
                    break;
                case 'reveal_event': {
                    const events1 = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                    if (events1.length > 0) events1[0].revealed = true;
                    break;
                }
                case 'reveal_event_2': {
                    const events2 = state.events.filter(ev => !ev.revealed && !ev.isFinished);
                    if (events2.length > 0) events2[0].revealed = true;
                    if (events2.length > 1) events2[1].revealed = true;
                    break;
                }
                case 'heal':
                    state.player.heal(0.3);
                    break;
                case 'add_perm_health':
                    state.player.addPermHealthBonus(10);
                    break;
                case 'add_scrap': {
                    const scrapAmount = resolveScrap(paramStr);
                    if (scrapAmount > 0) {
                        state.player.scrap += scrapAmount;
                        if (state.stats) state.stats.scrapCollected += scrapAmount;
                        if (state.spawnFloatingText) {
                            state.spawnFloatingText(this.worldX, this.worldY, `+${scrapAmount} SCRAP`, '#ffff44');
                        }
                    }
                    break;
                }
                case 'add_upgrade': {
                    const upgrade = this.encounterVars[paramStr];
                    if (upgrade && state.itemPickups) {
                        state.itemPickups.push(new ItemPickup(this.game, this.worldX, this.worldY, upgrade));
                    }
                    break;
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
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
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
        const difficultyScale = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
        const expAmount = Math.floor((4 + 1 * difficultyScale) * (this.isUpgraded ? 1.5 : 1));
        for (let i = 0; i < expAmount; i++) spawns.push(new ExpOrb(this.game, this.worldX, this.worldY, 1));

        const img = this.game.assets.get(this.spriteKey);

        if (img) {
            const fragments = getCachedShatter(img, this.spriteKey, 100);
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

        // Loot count + scrap type seeded (contentRng); scatter stays visual.
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();
        const hostileScrapMult = (this.game.currentState && this.game.currentState.netScrapMult) || 1.0;
        const scrapCount = Math.round((8 + Math.floor(rand() * 5)) * hostileScrapMult);
        for (let i = 0; i < scrapCount; i++) {
            const outAngle = Math.random() * Math.PI * 2;
            const dist = Math.random() * 60;
            spawns.push(new Scrap(this.game, this.worldX + Math.cos(outAngle) * dist, this.worldY + Math.sin(outAngle) * dist, rand() > 0.4 ? 'big' : 'small'));
        }

        // Dialog-defined item drops (add_upgrade actions) are handled by
        // _grantAbstractRewards. Do not also drop upgrade-like encounterVars
        // here or every trader will drop their offering twice.

        return spawns;
    }
}
