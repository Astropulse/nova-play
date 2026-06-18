// Dynamic scaling is now handled via game properties
import { Projectile } from './projectile.js';
import { GP } from '../engine/inputManager.js';

// Inert input stub. In multiplayer the world never pauses, so when a UI
// overlay is open the player's ship keeps simulating (drift, shields recharge,
// timers tick) but must ignore the keyboard/mouse the UI is using. Swapping
// the input source for this stub disables control without touching physics.
const NULL_INPUT = {
    isKeyDown: () => false,
    isKeyJustPressed: () => false,
    isMouseDown: () => false,
    isMouseJustPressed: () => false,
    isGamepadDown: () => false,
    isGamepadJustPressed: () => false,
    isTriggerDown: () => false,
    isTriggerJustPressed: () => false,
    leftStickX: 0, leftStickY: 0, rightStickX: 0, rightStickY: 0,
};

export class Player {
    constructor(game, shipData) {
        this.game = game;
        this.shipData = shipData;

        // Local co-op: per-pilot input source (null = the shared game.input, i.e.
        // single-player keyboard+mouse+primary pad). useMouseAim=false makes a
        // gamepad pilot hold its facing when the right stick centers (the ship
        // doesn't snap to the shared mouse cursor).
        this.input = null;
        this.useMouseAim = true;
        // Local co-op per-pilot death (distinct from the global game-over
        // this.isDead in PlayingState, which only fires when ALL pilots are down).
        this.dead = false;
        this.respawnTimer = 0;

        // World position (screen pixels)
        this.worldX = 0;
        this.worldY = 0;

        // Movement (screen pixels/sec)
        this.vx = 0;
        this.vy = 0;
        this.angle = -Math.PI / 2; // facing up
        this.baseSpeed = shipData.speed * 100;
        this.acceleration = this.baseSpeed * 3;
        this.friction = 0.95;

        // Boost — short powerful burst
        this.boostPower = 6000;
        this.boostDuration = 0.4;
        this.boostCooldown = 2.0;

        // Multipliers (modified by upgrades)
        this.fireRateMult = 1.0;
        this.boostRangeMult = 1.0;
        this.boostSpeedMult = 1.0;
        this.boostCooldownMult = 1.0;
        this.shieldDrainMult = 1.0;
        this.scrapRangeMult = 1.0;
        this.maxHealthMult = 1.0;

        // Permanent upgrades (from shops, not inventory items)
        this.permHealthBonus = 0;
        this.permShieldBonus = 0;
        this.permDamageBonus = 0;
        this.inventoryUpgradeTier = 0;

        // Active systems
        this.autoTurretTimer = 0;
        this.mechanicalClawTimer = 0;

        // New Upgrade Flags & Multipliers
        this.pulseJetMult = 1.0;
        this.shieldBoosterMult = 1.0;
        this.mechanicalEngineSpeedMult = 1.0;
        this.mechanicalEngineTurnMult = 1.0;
        this.shieldRegenMult = 1.0;
        this.hasTargetingModule = false;
        this.hasControlModule = false;
        this.hasWarningSystem = false;
        this.hasMultishotGuns = false;
        this.hasExplosivesUnit = false;
        this.hasAncientCurse = false;
        this.hasBoostDrive = false;
        this.naniteRegen = 0;
        this.naniteAccumulator = 0; // Accumulate for floating text
        this.shieldCapacitorCount = 0;
        this.asteroidSpawnMult = 1.0;

        // Knowledge Event Upgrades
        this.hasSacrifice = false;
        this.hasRadar = false;
        this.obedienceMult = 1.0;

        // Yellow One reward — permanent glow
        this.hasYellowGlow = false;
        this.yellowGlowTarget = { x: 0, y: 0 }; // Points toward next boss event
        this._yellowTrailHistory = [];
        this._yellowTrailTimer = 0;
        this._yellowTrailInterval = 0.005; // Match ancient curse speed
        this._yellowMaxTrail = 10;
        this._yellowGhostCache = null;

        // Cosmos Engine (inventory item)
        this.hasCosmosEngine = false;
        this.momentumSpeedMult = 0.5;
        this.momentumMaxSpeedMult = 2 * (0.97 / 0.99);
        this.momentumBoostMult = 0.5;

        this.boostTimer = 0;
        this.boostCooldownTimer = 0;
        this.isBoosting = false;
        this.boostIntensity = 0;
        this.boostFlash = 0;
        this._boostWasOnCooldown = false;

        // Dodge detection — blink-only.
        // The instant the blink fires, draw the line segment from the
        // pre-warp position (A) to the warp target (B). For each enemy
        // projectile, sweep its trajectory forward DODGE_TRAJ_LOOKAHEAD
        // seconds and check if that projectile sweep intersects the A→B
        // segment (within a small thickness). Those are the candidates —
        // the shots that would have hit the player at some point along
        // the blink line had they not blinked.
        // Then wait DODGE_GRACE seconds. If the player takes ANY damage
        // during the grace, the batch is voided (you didn't actually
        // dodge). Survivors score one dodge each.
        this.DODGE_GRACE = 0.4;             // s — damage-veto window post-blink
        this.DODGE_TRAJ_LOOKAHEAD = 0.2;    // s — projectile trajectory horizon
        this.dodgeWindowTimer = 0;
        this.dodgeCandidates = new Set();
        this.dodgeDamaged = false;

        // Distance tracking — running total of world-units flown this run,
        // pushed to the achievement manager every half second.
        this._runDistance = 0;
        this._distNotifyTimer = 0;

        // Belly Flop: armed when a warp ends inside an asteroid. The
        // playingState collision handler checks this in the same frame —
        // if the resulting damage kills the player, the achievement fires.
        // Otherwise it lapses harmlessly after the brief grace window.
        this._pendingBellyFlop = 0;

        this.experienceCondenserMult = 1.0;
        this.asteroidDrillMult = 1.0;
        this.laserCartridgeMult = 1.0;

        // Luck stat — affects Space Cache roll quality and extra-roll chance
        // 1.0 = baseline, >1 = luckier rolls, <1 = worse rolls
        this.luck = 1.0;

        // Warp — smooth timed blink (replaces boost for looper/blink engine)
        this.hasTeleport = shipData.special === 'teleport';
        this.teleportDuration = 0.2; // s
        this.warpDuration = 0.2;
        this.teleportDistance = 700;
        this.teleportCooldown = 1.25;
        this.teleportOutlineFade = 0;
        this.teleportGhost = null;
        this.teleportFlash = 0;
        this._teleportWasOnCooldown = false;
        this._blueGhostCache = null;

        this.isWarping = false;
        this.warpTimer = 0;
        this.warpDuration = 0.2;
        this.warpStartX = 0;
        this.warpStartY = 0;
        this.warpTargetX = 0;
        this.warpTargetY = 0;
        this.warpAngle = 0;

        // State
        this.thrusting = false;
        this.health = shipData.health;
        this.maxHealth = shipData.health;
        // Overheal — health stored above the normal cap. Drains at a constant
        // maxHealth/15 per second (so 100% overflow decays in 15s, 200% in 30s,
        // etc.) and is consumed before normal health when taking damage.
        // Capped at 4× maxHealth (400% overflow = the legendary bar, i.e. 500%
        // total health) to match the four overflow tiers drawn in the HUD.
        this.overheal = 0;
        this.alive = true;
        this.scrap = 0;

        // Shield — proper asset, breaks when depleted
        this.shieldEnergy = shipData.shield * 150;
        this.maxShieldEnergy = shipData.shield * 150;
        this.shielding = false;
        this.shieldBroken = false;        // true when fully depleted, must recharge to 30%
        this.shieldRechargeRate = 80;
        this.shieldDrainRate = 200;
        this.shieldImg = game.assets.get('shield');

        // Shooting
        this.shootCooldown = 0.2;
        this.shootTimer = 0;
        this.projectileSpeed = 1800;
        this.pendingProjectiles = []; // collected each frame by playingState
        this.hasRailgun = false;
        this.hasEnergyBlaster = false;
        this.energyBlasterCount = 0;
        this.hasRepeater = false;

        this.hasLaserOverride = false;
        this.isRailgunTargeting = false;
        this.railgunTargetTimer = 0;
        this.pendingRailgunFire = false;

        // Combine-scaled weapon multipliers (recomputed by _onInventoryChanged)
        this.railgunDmgMult = 1.0;
        this.laserOverrideMult = 1.0;
        this.multishotDamageMult = 1.0;
        this.controlSpeedMult = 1.0;
        this.targetingConeDeg = 10;
        this.boostDriveMult = 1.0;
        this.repeaterRateBonus = 0;

        // Sprite refs
        this.stillImg = game.assets.get(shipData.assets.still);
        this.jetsImg = game.assets.get(shipData.assets.jets);

        // GIF animation frames — pick randomly
        this.flyingFrames = game.assets.get(shipData.assets.flying) || [];
        this.currentFrame = 0;
        this.frameTimer = 0;
        this.frameInterval = 0.08;

        // Thruster sound loop
        this.thrustSoundTimer = 0;

        // Invulnerability after damage
        this.invulnTimer = 0;
        this.invulnDuration = 0.3;

        // Visual feedback
        this.lowHealthPulseTimer = 0;

        // Aiming control state
        this.useKeyboardAim = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;
        this.mouseThreshold = 20;
        // Gamepad flick-aim: set by any stick deflection, persists until the
        // ship rotates into alignment, another stick flick, or a mouse/key
        // input overrides it. Lets a quick stick flick commit a new heading
        // without the player having to hold the stick while the ship turns.
        this.gpTargetAngle = null;

        // Rotation physics
        this.rotationVelocity = 0;
        this.rotationAcceleration = 30.0;  // Rapid spin-up
        this.rotationFriction = 0.80;      // Snappy stop
        this.maxRotationVelocity = 10.0;   // Increased cap

        // Trail effect for Ancient Curse
        this.trailHistory = [];
        this.trailTimer = 0;
        this.trailInterval = 0.005; // Faster interval for more copies
        this.maxTrailLength = 10; // Even more copies for solidity
        this._trailCache = new Map(); // Cache for tinted sprites
        this.naniteAccumulator = 0; // Accumulate for floating text
        this.shieldCapacitorCount = 0;
        this.asteroidSpawnMult = 1.0;

        // EXP and Leveling
        this.level = 0;
        this.exp = 0;
        this.expNeeded = 10;

        // Level-up stat bonuses (accumulated, separate from inventory upgrades)
        this.lvlDamageMult           = 1.0;
        this.lvlMaxHpMult            = 1.0;
        this.lvlMaxShieldMult        = 1.0;
        this.lvlShieldDrainMult      = 1.0;  // <1 = less drain (positive)
        this.lvlSpeedMult            = 1.0;
        this.lvlProjectileSpeedMult  = 1.0;
        this.lvlBoostCooldownMult    = 1.0;  // <1 = faster recharge (positive)
        this.lvlFireRateMult         = 1.0;  // <1 = faster fire (positive)
        this.lvlShieldRechargeMult   = 1.0;
        this.lvlExpGainMult          = 1.0;
        this.lvlBoostSpeedMult       = 1.0;
        this.lvlBoostDurationMult    = 1.0;
        this.lvlAsteroidResistanceMult = 1.0; // <1 = less damage (positive)
        this.lvlAsteroidSpawnMult    = 1.0;
        this.lvlVacuumRangeMult      = 1.0;
        this.lvlTurnSpeedMult        = 1.0;
        this.lvlShieldDamageMult     = 1.0;
        this.lvlFovMult              = 1.0;
        this.lvlExtraProjectiles     = 0;    // flat integer
        this.lvlScrapChanceMult      = 1.0;
        this.lvlCacheFreqMult        = 1.0;
        this.lvlEncounterFreqMult    = 1.0;
        this.lvlEnemySpawnMult       = 1.0;
        this.lvlDifficultyMult       = 1.0;
        this.lvlWaveCountdownMult    = 1.0;  // <1 = shorter countdown (positive)
        this.lvlHpRegen              = 0.0;  // HP/sec
        this._lvlHpRegenAccum        = 0.0;  // for floating text
        this.lvlLuckMult             = 1.0;  // multiplies player.luck (epic stat)

        // Ordered history of the level-up picks applied this run, oldest first.
        // Each entry is a minimal, replayable record: { statId, isCursed, pct,
        // flatValue }. Used to reconstruct a fraction of progress on respawn
        // (drop the most recent picks, replay the rest). Recorded in
        // LevelUpDialog._selectChoice; the live bonuses live in the lvl* fields.
        this.lvlChoices              = [];

        // Per-type pick history used by the level-up roller to softly bias
        // future rolls away from over-picked types (offense/defense/mobility/
        // utility/difficulty). Accumulates over the run.
        this.upgradeTypeCounts       = {};
    }

    /**
     * Calculates the target angle for shots based on the targeting module and nearby enemies.
     * @param {number} originX - The X coordinate of the firing origin.
     * @param {number} originY - The Y coordinate of the firing origin.
     * @returns {number} The calculated firing angle.
     */
    getTargetAngle(originX, originY) {
        if (!this.hasTargetingModule || !this.game.currentState || !this.game.currentState.enemies) {
            return this.angle;
        }

        let closestEnemy = null;
        let minDist = Infinity;
        const targetingCone = (this.targetingConeDeg ?? 10) * (Math.PI / 180);

        for (const en of this.game.currentState.enemies) {
            if (!en.alive) continue;
            const dx = en.worldX - this.worldX;
            const dy = en.worldY - this.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 1500) {
                const angleToEn = Math.atan2(dy, dx);
                let diff = angleToEn - this.angle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;

                if (Math.abs(diff) < targetingCone && dist < minDist) {
                    closestEnemy = en;
                    minDist = dist;
                }
            }
        }

        if (closestEnemy) {
            return Math.atan2(closestEnemy.worldY - originY, closestEnemy.worldX - originX);
        }

        return this.angle;
    }

    update(dt) {
        // controlsEnabled === false → run physics/timers but ignore all input
        // (multiplayer: a menu/shop/trade overlay is open while the world runs).
        const controls = this.controlsEnabled !== false;
        const input = controls ? (this.input || this.game.input) : NULL_INPUT;
        const mouse = this.game.getMousePos();
        // Aim is measured from the ship's on-screen position. The ship renders at
        // the center of its viewport pane — the whole screen when not split, or a
        // sub-rect under split-screen co-op (set by PlayingState as aimCenterX/Y).
        const centerX = this.aimCenterX != null ? this.aimCenterX : this.game.width / 2;
        const centerY = this.aimCenterY != null ? this.aimCenterY : this.game.height / 2;

        // --- Gamepad sample ---
        // Right stick: aim. Left stick: rotate-and-thrust (or direct move
        // under the Ancient Curse). D-pad up/down: forward/back (or 8-way
        // movement under the curse).
        const rsMag = Math.sqrt(input.rightStickX * input.rightStickX + input.rightStickY * input.rightStickY);
        const lsMag = Math.sqrt(input.leftStickX * input.leftStickX + input.leftStickY * input.leftStickY);
        const rightStickActive = rsMag > 0.1;
        const leftStickActive  = lsMag > 0.1;
        const dpUp    = input.isGamepadDown(GP.DUP);
        const dpDown  = input.isGamepadDown(GP.DDOWN);
        const dpLeft  = input.isGamepadDown(GP.DLEFT);
        const dpRight = input.isGamepadDown(GP.DRIGHT);

        // Angle toward mouse (only if not using keyboard rotation)
        const isRotatingCCW = input.isKeyDown('KeyJ');
        const isRotatingCW = input.isKeyDown('KeyL');

        const currentRotationAccel = this.rotationAcceleration * this.mechanicalEngineTurnMult * this.lvlTurnSpeedMult;

        if (isRotatingCCW) {
            this.rotationVelocity -= currentRotationAccel * dt;
            this.useKeyboardAim = true;
            this.lastMouseX = mouse.x;
            this.lastMouseY = mouse.y;
            this.gpTargetAngle = null; // keyboard spin overrides flick target
        } else if (isRotatingCW) {
            this.rotationVelocity += currentRotationAccel * dt;
            this.useKeyboardAim = true;
            this.lastMouseX = mouse.x;
            this.lastMouseY = mouse.y;
            this.gpTargetAngle = null;
        } else {
            // Apply friction only when not accelerating (dt-compensated)
            this.rotationVelocity *= Math.pow(this.rotationFriction, dt * 60);
            if (Math.abs(this.rotationVelocity) < 0.01) this.rotationVelocity = 0;
        }

        // Cap only
        if (Math.abs(this.rotationVelocity) > this.maxRotationVelocity) {
            this.rotationVelocity = Math.sign(this.rotationVelocity) * this.maxRotationVelocity;
        }

        // Apply velocity to angle
        this.angle += this.rotationVelocity * dt;

        // Any active stick flick (re)sets the persistent aim target. The
        // right stick wins; the left stick only aims when there's no right-
        // stick input AND the Ancient Curse isn't swapping the scheme.
        if (rightStickActive) {
            this.gpTargetAngle = Math.atan2(input.rightStickY, input.rightStickX);
        } else if (leftStickActive && !this.hasAncientCurse) {
            this.gpTargetAngle = Math.atan2(input.leftStickY, input.leftStickX);
        }

        // Aim resolution priority: gamepad target (persists between flicks) →
        // mouse (only when keyboard hasn't taken over).
        if (!isRotatingCCW && !isRotatingCW) {
            if (this.gpTargetAngle !== null) {
                let diff = this.gpTargetAngle - this.angle;
                while (diff < -Math.PI) diff += Math.PI * 2;
                while (diff > Math.PI) diff -= Math.PI * 2;
                this.angle += diff * Math.min(1, 12 * dt * this.mechanicalEngineTurnMult);
                // Clear the target once the ship has arrived, so the stored
                // angle doesn't fight a later mouse input (we'd otherwise
                // immediately rotate back).
                if (Math.abs(diff) < 0.01) {
                    this.angle = this.gpTargetAngle;
                    this.gpTargetAngle = null;
                }
                // Suppress mouse-aim fallback while a flick target is active.
                this.useKeyboardAim = true;
                this.lastMouseX = mouse.x;
                this.lastMouseY = mouse.y;
            } else {
                // Mouse aiming logic (only if keyboard hasn't taken over or mouse moved substantially)
                if (this.useKeyboardAim) {
                    const dx = mouse.x - this.lastMouseX;
                    const dy = mouse.y - this.lastMouseY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist > this.mouseThreshold) {
                        this.useKeyboardAim = false;
                    }
                }

                if (controls && this.useMouseAim !== false && !this.useKeyboardAim && Math.abs(this.rotationVelocity) < 0.1) {
                    const dx = mouse.x - centerX;
                    const dy = mouse.y - centerY;
                    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                        const targetAngle = Math.atan2(dy, dx);
                        let diff = targetAngle - this.angle;
                        while (diff < -Math.PI) diff += Math.PI * 2;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        this.angle += diff * Math.min(1, 12 * dt * this.mechanicalEngineTurnMult);
                    }
                }
            }
        }

        // Thrusting logic
        this.thrusting = false;
        let accelX = 0;
        let accelY = 0;

        const currentAccel = this.acceleration * this.mechanicalEngineSpeedMult;

        if (this.hasAncientCurse) {
            // Free WASD movement independent of ship angle
            if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp') || dpUp) {
                accelY -= currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown') || dpDown) {
                accelY += currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft') || dpLeft) {
                accelX -= currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight') || dpRight) {
                accelX += currentAccel;
                this.thrusting = true;
            }
            // Under the curse the left stick is pure directional movement.
            if (leftStickActive) {
                const scale = Math.min(1, lsMag);
                accelX += input.leftStickX * currentAccel * scale;
                accelY += input.leftStickY * currentAccel * scale;
                this.thrusting = true;
            }
        } else {
            // Standard thrusting along the nose angle
            if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp') || dpUp) {
                accelX = Math.cos(this.angle) * currentAccel;
                accelY = Math.sin(this.angle) * currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown') || dpDown) {
                accelX = -Math.cos(this.angle) * currentAccel * 0.5;
                accelY = -Math.sin(this.angle) * currentAccel * 0.5;
                this.thrusting = true;
            }
            // Left stick thrust, under two modes:
            //
            //   • Right stick idle: classic "point-and-go" — the ship has
            //     already been rotated toward the left stick direction, so
            //     forward thrust along the nose, scaled by deflection.
            //
            //   • Right stick active: right stick owns aim. The left stick
            //     becomes a pure throttle — its vector is projected onto the
            //     ship's nose direction (= right stick direction). A left
            //     stick pointed opposite the aim yields reverse thrust;
            //     perpendicular yields zero. A ship can't move sideways, so
            //     only the forward/back component of the stick is used.
            if (leftStickActive) {
                if (rightStickActive) {
                    const cosA = Math.cos(this.angle);
                    const sinA = Math.sin(this.angle);
                    let projection = input.leftStickX * cosA + input.leftStickY * sinA;
                    if (projection > 1) projection = 1;
                    else if (projection < -1) projection = -1;
                    if (Math.abs(projection) > 0.01) {
                        // Reverse is half power to match the KeyS back-thrust.
                        const throttle = projection >= 0 ? projection : projection * 0.5;
                        accelX += cosA * currentAccel * throttle;
                        accelY += sinA * currentAccel * throttle;
                        this.thrusting = true;
                    }
                } else {
                    const throttle = Math.min(1, lsMag);
                    accelX += Math.cos(this.angle) * currentAccel * throttle;
                    accelY += Math.sin(this.angle) * currentAccel * throttle;
                    this.thrusting = true;
                }
            }
        }

        // --- Boost / Teleport ---
        this.boostCooldownTimer = Math.max(0, this.boostCooldownTimer - dt);

        if (this.boostTimer > 0) {
            this.boostTimer -= dt;
            this.boostIntensity = this.boostTimer / this.boostDuration;
            if (this.boostTimer <= 0) {
                this.isBoosting = false;
                this.boostIntensity = 0;
            }
        }

        const boostJustPressed = input.isKeyJustPressed('Space') || input.isTriggerJustPressed('left');
        const boostDown        = input.isKeyDown('Space')        || input.isTriggerDown('left');

        if (this.hasTeleport) {
            if (boostJustPressed && this.boostCooldownTimer <= 0 && !this.isWarping) {
                // Record Ghost at start
                this.teleportGhost = {
                    x: this.worldX,
                    y: this.worldY,
                    angle: this.angle,
                    asset: this.stillImg,
                    life: 1.0
                };

                // Initialize Warp
                this.isWarping = true;
                this.warpTimer = 0;
                this.warpStartX = this.worldX;
                this.warpStartY = this.worldY;
                const dist = this.teleportDistance * this.momentumBoostMult * this.boostRangeMult * this.boostSpeedMult;
                this.warpTargetX = this.worldX + Math.cos(this.angle) * dist;
                this.warpTargetY = this.worldY + Math.sin(this.angle) * dist;
                this.warpAngle = this.angle;

                // Audio Start
                this.game.sounds.play('teleport', { volume: 0.5, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.0, 20.0);

                this.boostCooldownTimer = this.teleportCooldown * this.boostCooldownMult;
                this._teleportWasOnCooldown = true;

                this._armDodgeWindow(this.warpStartX, this.warpStartY,
                                     this.warpTargetX, this.warpTargetY);

                if (this.game.achievements) {
                    const bdx = this.warpTargetX - this.warpStartX;
                    const bdy = this.warpTargetY - this.warpStartY;
                    this.game.achievements.notify('blink_used', {
                        distance: Math.sqrt(bdx * bdx + bdy * bdy)
                    });
                }
            }
        }

        if (this.isWarping) {
            const prevX = this.worldX;
            const prevY = this.worldY;

            this.warpTimer += dt;
            const rawT = Math.min(1.0, this.warpTimer / this.warpDuration);

            this.isBoosting = true; // Bypasses speed capping during warp

            // Cubic Ease In-Out
            const t = rawT < 0.5 ? 4 * rawT * rawT * rawT : 1 - Math.pow(-2 * rawT + 2, 3) / 2;

            this.worldX = this.warpStartX + (this.warpTargetX - this.warpStartX) * t;
            this.worldY = this.warpStartY + (this.warpTargetY - this.warpStartY) * t;

            // Update velocity to reflect the warp movement (helps camera tracking)
            this.vx = (this.worldX - prevX) / dt;
            this.vy = (this.worldY - prevY) / dt;

            if (rawT >= 1.0) {
                this.isWarping = false;
                this.isBoosting = false;
                this.teleportOutlineFade = 1.0;

                // Explicit Exit Momentum
                // We set velocity directly to ensure we come out of the warp with consistent forward power,
                // regardless of how much the easing curve slowed down at the very end.
                const exitSpeed = 800; // Average warp speed (3500) + Kick (1200)
                this.vx = Math.cos(this.warpAngle) * exitSpeed;
                this.vy = Math.sin(this.warpAngle) * exitSpeed;

                // Belly Flop arming — did we land inside an asteroid? Don't
                // notify yet; we want to count this only if the impending
                // collision damage actually kills us. PlayingState checks
                // _pendingBellyFlop in its player-vs-asteroid handler.
                const ps = this.game.currentState;
                if (ps && ps.asteroids) {
                    for (let i = 0; i < ps.asteroids.length; i++) {
                        const ast = ps.asteroids[i];
                        if (!ast || !ast.alive) continue;
                        const adx = ast.worldX - this.worldX;
                        const ady = ast.worldY - this.worldY;
                        const ar = ast.radius || 0;
                        if (adx * adx + ady * ady < ar * ar) {
                            this._pendingBellyFlop = 0.25;
                            break;
                        }
                    }
                }
            }
        } else if (this.hasBoostDrive) {
            if (boostDown && this.boostCooldownTimer <= 0) {
                // Play sound once when starting
                if (!this.isBoosting) {
                    this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(1.2, 15.0);
                }

                this.isBoosting = true;
                this.thrusting = true;
                this.boostIntensity = 1.0;
                this.boostTimer = 0.1; // Keep it alive for trail effect

                const power = this.acceleration * 4.5 * (this.boostDriveMult ?? 1.0) * dt;
                this.vx += Math.cos(this.angle) * power;
                this.vy += Math.sin(this.angle) * power;

                // Subtle continuous jitter while holding boost
                this.game.camera.rumble(0.4);
            } else {
                // Just stopped boosting (released or hit cooldown) — start the cooldown
                if (this.isBoosting) {
                    this.boostCooldownTimer = this.boostCooldown * this.boostCooldownMult;
                    this._boostWasOnCooldown = true;
                }
                this.isBoosting = false;
                this.boostIntensity = 0;
            }
        } else {
            if (boostJustPressed && this.boostCooldownTimer <= 0) {
                this.isBoosting = true;
                this.boostTimer = this.boostDuration * this.lvlBoostDurationMult;
                this.boostCooldownTimer = this.boostCooldown * this.boostCooldownMult;
                this.boostIntensity = 1;
                this._boostWasOnCooldown = true;
                const power = this.boostPower * this.boostRangeMult * this.boostSpeedMult * this.momentumBoostMult;
                this.vx += Math.cos(this.angle) * power;
                this.vy += Math.sin(this.angle) * power;
                this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
                this.game.camera.shake(1.5, 15.0);
            }
        }

        if (this._boostWasOnCooldown && this.boostCooldownTimer <= 0) {
            this.boostFlash = 1;
            this._boostWasOnCooldown = false;
            // Energy motes drawn into the hull — the drive is charged
            const st = this.game.currentState;
            if (st && st._spawnReadyAbsorb) st._spawnReadyAbsorb(this);
        }
        this.boostFlash = Math.max(0, this.boostFlash - dt * 2);

        if (this._teleportWasOnCooldown && this.boostCooldownTimer <= 0) {
            this.teleportFlash = 1;
            this._teleportWasOnCooldown = false;
            const st = this.game.currentState;
            if (st && st._spawnReadyAbsorb) st._spawnReadyAbsorb(this);
        }
        this.teleportFlash = Math.max(0, this.teleportFlash - dt * 4);

        // Update Ghost Life
        if (this.teleportGhost) {
            this.teleportGhost.life -= dt * 3.0;
            if (this.teleportGhost.life <= 0) this.teleportGhost = null;
        }

        // Update Outline Fade
        if (this.teleportOutlineFade > 0) {
            this.teleportOutlineFade -= dt * 4.0;
        }

        // Belly Flop pending — lapses harmlessly if no fatal collision
        // lands within the grace window. Cleared by playingState when it
        // fires the achievement notify.
        if (this._pendingBellyFlop > 0) {
            this._pendingBellyFlop -= dt;
            if (this._pendingBellyFlop < 0) this._pendingBellyFlop = 0;
        }

        // Dodge: candidates were captured at the activation instant by
        // _scanDodgeCandidates. Here we only watch for damage during the
        // grace window — if anything lands, the batch is voided. Commit
        // when the window ends.
        if (this.dodgeWindowTimer > 0) {
            this.dodgeWindowTimer -= dt;
            if (this.invulnTimer > 0) this.dodgeDamaged = true;
            if (this.dodgeWindowTimer <= 0) {
                this._commitDodges();
                this.dodgeCandidates.clear();
                this.dodgeDamaged = false;
            }
        }

        // --- Physics ---
        this.vx += accelX * dt;
        this.vy += accelY * dt;

        let maxSpeed = this.baseSpeed * this.pulseJetMult * this.mechanicalEngineSpeedMult * this.momentumMaxSpeedMult;
        const currentSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (!this.isBoosting && currentSpeed > maxSpeed) {
            const decay = Math.max(maxSpeed / currentSpeed, 1 - dt * 5);
            this.vx *= decay;
            this.vy *= decay;
        }

        // Applied with dt-compensation
        const currentFriction = Math.pow(this.friction, dt * 60);
        this.vx *= currentFriction;
        this.vy *= currentFriction;
        if (Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1) {
            this.vx = 0;
            this.vy = 0;
        }

        const _prevPosX = this.worldX;
        const _prevPosY = this.worldY;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Distance tracking — accumulates each frame, pushed to the
        // achievement manager every 0.5s so the Frequent Flyer check ticks
        // forward steadily without spamming notifies every frame.
        const _ddx = this.worldX - _prevPosX;
        const _ddy = this.worldY - _prevPosY;
        this._runDistance += Math.sqrt(_ddx * _ddx + _ddy * _ddy);
        this._distNotifyTimer += dt;
        if (this._distNotifyTimer >= 0.5) {
            this._distNotifyTimer = 0;
            if (this.game.achievements) {
                this.game.achievements.notify('player_traveled', { distance: this._runDistance });
            }
        }

        // --- Thruster sound (speed-based overlapping) ---
        if (this.thrusting && currentSpeed > 50) {
            this.thrustSoundTimer -= dt;
            if (this.thrustSoundTimer <= 0) {
                const speedRatio = Math.min(1, currentSpeed / this.baseSpeed);
                this.thrustSoundTimer = 0.05; // stack them heavily
                this.game.sounds.play('thrust', { volume: 0.1 + speedRatio * 0.15, x: this.worldX, y: this.worldY });
            }
        } else {
            this.thrustSoundTimer = 0;
        }

        // --- Shield ---
        const isShiftDown = input.isKeyDown('ShiftLeft') || input.isKeyDown('ShiftRight');
        const isBumperDown = input.isGamepadDown(GP.LB) || input.isGamepadDown(GP.RB);
        const wantShield = (input.isMouseDown(2) || isShiftDown || isBumperDown) && !this.shieldBroken && this.shieldEnergy > 0;

        // Sound: Shield activation
        if (wantShield && !this.shielding) {
            this.game.sounds.play('shield', { volume: 0.4, x: this.worldX, y: this.worldY });
        }

        this.shielding = wantShield;

        if (this.shielding) {
            this.shieldEnergy -= this.shieldDrainRate * this.shieldDrainMult * dt;
            if (this.shieldEnergy <= 0) {
                this.shieldEnergy = 0;
                this.shieldBroken = true;
                this.shielding = false;
                this.game.sounds.play('shield_break', { volume: 0.6, x: this.worldX, y: this.worldY });
                this.game.camera.shake(3.0, 8.0);
            }
        } else {
            this.shieldEnergy = Math.min(this.maxShieldEnergy, this.shieldEnergy + (this.shieldRechargeRate * this.shieldRegenMult) * dt);
            // Un-break when recharged to 30%
            if (this.shieldBroken && this.shieldEnergy >= this.maxShieldEnergy * 0.3) {
                this.shieldBroken = false;
                // Regen glint: a sweep around the bubble as the shield returns
                const st = this.game.currentState;
                if (st && st.shieldGlint !== undefined) {
                    st.shieldGlint = 0.15;
                    this.game.sounds.play('shield', { volume: 0.3, x: this.worldX, y: this.worldY });
                }
            }
        }

        // --- Overheal decay ---
        // Constant rate: maxHealth/15 per second. The overflow above the cap
        // bleeds back down to 100% over 15s per extra 100% of health.
        if (this.overheal > 0) {
            this.overheal = Math.max(0, this.overheal - (this.maxHealth / 15) * dt);
        }

        // --- Level-up HP regen ---
        if (this.lvlHpRegen > 0 && this.health > 0 && this.health < this.maxHealth) {
            this.health = Math.min(this.maxHealth, this.health + this.lvlHpRegen * dt);
            this._lvlHpRegenAccum += this.lvlHpRegen * dt;
            if (this._lvlHpRegenAccum >= 1) {
                this._lvlHpRegenAccum -= 1;
                if (this.game.currentState && this.game.currentState.spawnFloatingText) {
                    this.game.currentState.spawnFloatingText(this.worldX, this.worldY, '+1', '#44ff88', 0.8);
                }
            }
        }

        // --- Shooting (left mouse) ---
        this.shootTimer = Math.max(0, this.shootTimer - dt);

        const shootDown = input.isMouseDown(0) || input.isKeyDown('KeyI') || input.isTriggerDown('right');

        if (this.hasRailgun) {
            const isShooting = shootDown;
            if (isShooting && this.shootTimer <= 0 && !this.isRailgunTargeting) {
                this.isRailgunTargeting = true;
                // Repeater reduces charge time, control module reduces it further
                let baseCharge = (this.hasRepeater ? 0.1 : 0.25) * this.fireRateMult;
                if (this.hasControlModule) baseCharge *= 0.5; // 50% faster charge
                baseCharge /= this.lvlProjectileSpeedMult; // Projectile speed reduces charge time
                const variance = this.hasEnergyBlaster ? (Math.random() - 0.5) * 0.2 : 0;
                this.railgunTargetTimer = baseCharge + variance;
                this.game.sounds.play('railgun_target', { volume: 0.6, x: this.worldX, y: this.worldY });
            }

            if (this.isRailgunTargeting) {
                this.railgunTargetTimer -= dt;
                if (this.railgunTargetTimer <= 0) {
                    this.isRailgunTargeting = false;
                    this.pendingRailgunFire = true;
                    // Lower volume if firing very fast
                    const vol = 0.7 * Math.max(0.5, this.fireRateMult);
                    this.game.sounds.play('railgun_shoot', { volume: vol, x: this.worldX, y: this.worldY });
                    this.shootTimer = 0.8 * this.fireRateMult; // Dynamic cooldown for railgun
                }
            }

            // If mouse released during targeting, cancel? 
            // The prompt says "when the player presses OR holds... after 0.5 seconds it actually shoots"
            // Let's stick to simple: if released, targeting continues but maybe user wants it to stop.
            // "When player presses or holds" implies it might be a hold-only or fire-one.
            // Let's make it so releasing stops targeting.
            if (!isShooting && this.isRailgunTargeting) {
                this.isRailgunTargeting = false;
                this.railgunTargetTimer = 0;
            }
        } else {
            if (shootDown && this.shootTimer <= 0) {
                const noseOffset = 30;
                const px = this.worldX + Math.cos(this.angle) * noseOffset;
                const py = this.worldY + Math.sin(this.angle) * noseOffset;

                let damageMult = (this.hasRepeater ? 0.5 : 1.0) * this.laserOverrideMult;
                const spriteKey = this.hasLaserOverride ? 'blue_laser_ball_big' : 'blue_laser_ball';

                let baseProjSpeed = this.projectileSpeed * this.lvlProjectileSpeedMult;
                if (this.hasControlModule) baseProjSpeed *= this.controlSpeedMult;


                // Determine firing origins
                const fireAngle = this.getTargetAngle(px, py);
                const origins = [];
                if (this.hasMultishotGuns) {
                    const perpAngle = this.angle + Math.PI / 2;
                    const offset = 15;
                    origins.push({
                        px: px + Math.cos(perpAngle) * offset,
                        py: py + Math.sin(perpAngle) * offset
                    });
                    origins.push({
                        px: px - Math.cos(perpAngle) * offset,
                        py: py - Math.sin(perpAngle) * offset
                    });
                    damageMult *= this.multishotDamageMult; // individual damage reduction (combine shrinks it)
                } else {
                    origins.push({ px, py });
                }

                let currentBaseDamage = (this.shipData.baseDamage * this.obedienceMult + this.permDamageBonus) * this.laserCartridgeMult;

                if (this.hasEnergyBlaster) {
                    origins.forEach(origin => {
                        const extraCount = (this.energyBlasterCount - 1) * 2;
                        const count = 3 + Math.floor(Math.random() * 3) + extraCount + this.lvlExtraProjectiles; // 3-5 + 2 per extra + Multi-Shot
                        const spreadBase = 0.5 + (this.energyBlasterCount - 1) * 0.1; // Wider with more blasters
                        const dmgReduc = Math.pow(0.85, this.energyBlasterCount - 1); // 15% reduction per extra

                        for (let i = 0; i < count; i++) {
                            const spread = (Math.random() - 0.5) * spreadBase;
                            const speedVar = baseProjSpeed * (0.8 + Math.random() * 0.4);
                            this.pendingProjectiles.push(
                                new Projectile(this.game, origin.px, origin.py, fireAngle + spread, speedVar, spriteKey, this, currentBaseDamage * 0.3 * dmgReduc * damageMult)
                            );
                        }
                    });
                    this.shootTimer = this.shootCooldown * this.fireRateMult * 1.5;
                } else {
                    origins.forEach(origin => {
                        this.pendingProjectiles.push(
                            new Projectile(this.game, origin.px, origin.py, fireAngle, baseProjSpeed, spriteKey, this, currentBaseDamage * damageMult)
                        );
                    });
                    // Extra projectiles from level-up — same origin, increasing spread per shot
                    if (this.lvlExtraProjectiles > 0) {
                        for (let ei = 0; ei < this.lvlExtraProjectiles; ei++) {
                            const spread = (0.08 + ei * 0.06) * (Math.random() < 0.5 ? 1 : -1);
                            for (const origin of origins) {
                                this.pendingProjectiles.push(
                                    new Projectile(this.game, origin.px, origin.py, fireAngle + spread, baseProjSpeed, spriteKey, this, currentBaseDamage * damageMult * 0.7)
                                );
                            }
                        }
                    }
                    this.shootTimer = this.shootCooldown * this.fireRateMult;
                }
                // Lower volume if firing very fast
                const vol = 0.3 * Math.max(0.5, this.fireRateMult);
                this.game.sounds.play('laser', { volume: vol, x: px, y: py });

                // Muzzle glint at each firing origin
                const st = this.game.currentState;
                if (st && st._addMuzzleFlash) {
                    for (const o of origins) st._addMuzzleFlash(o.px, o.py, fireAngle);
                }
            }
        }

        // --- Random frame selection ---
        if (this.thrusting && this.flyingFrames.length > 1) {
            this.frameTimer -= dt;
            if (this.frameTimer <= 0) {
                this.frameTimer = this.frameInterval;
                // Avoid picking the same frame twice in a row
                let nextFrame;
                do {
                    nextFrame = Math.floor(Math.random() * this.flyingFrames.length);
                } while (nextFrame === this.currentFrame);
                this.currentFrame = nextFrame;
            }
        } else {
            this.currentFrame = 0;
            this.frameTimer = 0;
        }

        // --- Invulnerability ---
        if (this.invulnTimer > 0) {
            this.invulnTimer -= dt;
        }

        // --- Low health pulse ---
        if (this.health < this.maxHealth * 0.1) {
            this.lowHealthPulseTimer += dt * 5; // Pulsing speed
        } else {
            this.lowHealthPulseTimer = 0;
        }

        // --- Trail History ---
        if (this.hasAncientCurse) {
            this.trailTimer -= dt;
            if (this.trailTimer <= 0) {
                this.trailTimer = this.trailInterval;

                // Record state regardless of movement for a solid feel
                this.trailHistory.unshift({
                    x: this.worldX,
                    y: this.worldY,
                    angle: this.angle,
                    asset: (this.thrusting && this.flyingFrames.length > 0) ? this.flyingFrames[this.currentFrame] : this.stillImg,
                    life: 1.0,
                    seed: Math.random() * Math.PI * 2 // Individual offset for smooth wavy motion
                });

                if (this.trailHistory.length > this.maxTrailLength) {
                    this.trailHistory.pop();
                }
            }
        } else if (this.trailHistory.length > 0) {
            this.trailHistory = [];
        }

        // Age trail life slightly even if not active (for smooth fade out if needed,
        // though here we just clear it for simplicity if curse is removed)
        if (this.trailHistory.length > 0) {
            let write = 0;
            for (let i = 0; i < this.trailHistory.length; i++) {
                const t = this.trailHistory[i];
                t.life -= dt * 6; // Fast fade but enough to see the length
                if (t.life > 0) this.trailHistory[write++] = t;
            }
            this.trailHistory.length = write;
        }

        // --- Yellow Glow Trail (post-Yellow One reward) ---
        // Trail ghosts are all centered on the player but rotated toward the glow target.
        // Older layers rotate further toward the target, creating a directional "pointing" glow.
        if (this.hasYellowGlow) {
            this._yellowTrailTimer -= dt;
            if (this._yellowTrailTimer <= 0) {
                this._yellowTrailTimer = this._yellowTrailInterval;

                this._yellowTrailHistory.unshift({
                    angle: this.angle,
                    asset: (this.thrusting && this.flyingFrames.length > 0) ? this.flyingFrames[this.currentFrame] : this.stillImg,
                    life: 1.0
                });

                if (this._yellowTrailHistory.length > this._yellowMaxTrail) {
                    this._yellowTrailHistory.pop();
                }
            }

            let write = 0;
            for (let i = 0; i < this._yellowTrailHistory.length; i++) {
                const t = this._yellowTrailHistory[i];
                t.life -= dt * 6;
                if (t.life > 0) this._yellowTrailHistory[write++] = t;
            }
            this._yellowTrailHistory.length = write;
        }

        // --- Nanite Tank Regeneration ---
        if (this.naniteRegen > 0 && this.health < this.maxHealth) {
            const healed = this.naniteRegen * dt;
            this.health = Math.min(this.maxHealth, this.health + healed);

            this.naniteAccumulator += healed;
            if (this.naniteAccumulator >= 1.0) {
                const count = Math.floor(this.naniteAccumulator);
                if (this.game.currentState && this.game.currentState.spawnFloatingText) {
                    this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `+${count}`, '#44ff44');
                }
                this.naniteAccumulator -= count;
            }
        } else {
            this.naniteAccumulator = 0; // Reset if full or no regen
        }
    }

    draw(ctx, camera) {
        if (!camera) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        // --- Ghost Trail (Ancient Curse) ---
        if (this.hasAncientCurse && this.trailHistory.length > 0) {
            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            for (let i = 0; i < this.trailHistory.length; i++) {
                const t = this.trailHistory[i];
                const alpha = t.life * 0.15 * (1 - i / this.maxTrailLength);
                if (alpha <= 0) continue;

                const tScreen = camera.worldToScreen(t.x, t.y, this.game.width, this.game.height);
                const asset = t.asset;
                const img = asset.canvas || asset;
                const w = (asset.width || img.width) * this.game.worldScale;
                const h = (asset.height || img.height) * this.game.worldScale;

                let greenImg = this._trailCache.get(img);
                if (!greenImg) {
                    greenImg = this._createGreenGhost(img);
                    this._trailCache.set(img, greenImg);
                }

                ctx.save();
                ctx.translate(tScreen.x, tScreen.y);
                ctx.rotate(t.angle + Math.PI / 2);
                ctx.globalAlpha = alpha;
                ctx.drawImage(greenImg, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
            ctx.restore();
        }

        // --- Yellow Glow Trail (post-Yellow One) ---
        // Ghosts trail from the player toward the glow target, like a comet tail pointing at the destination
        if (this.hasYellowGlow && this._yellowTrailHistory.length > 0) {
            const toTargetAngle = Math.atan2(
                this.yellowGlowTarget.y - this.worldY,
                this.yellowGlowTarget.x - this.worldX
            );

            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            for (let i = 0; i < this._yellowTrailHistory.length; i++) {
                const t = this._yellowTrailHistory[i];
                const alpha = t.life * 0.15 * (1 - i / this._yellowMaxTrail);
                if (alpha <= 0) continue;

                const asset = t.asset;
                const tImg = asset.canvas || asset;
                const w = (asset.width || tImg.width) * this.game.worldScale;
                const h = (asset.height || tImg.height) * this.game.worldScale;

                if (!this._yellowGhostCache) {
                    this._yellowGhostCache = this._createYellowGhost(tImg);
                }

                // Position each ghost further along the direction toward the target
                const trailDist = ((i + 1) / this._yellowMaxTrail) * 30 * this.game.worldScale;
                const gx = screen.x + Math.cos(toTargetAngle) * trailDist;
                const gy = screen.y + Math.sin(toTargetAngle) * trailDist;

                ctx.save();
                ctx.translate(gx, gy);
                ctx.rotate(t.angle + Math.PI / 2);
                ctx.globalAlpha = alpha;
                ctx.drawImage(this._yellowGhostCache, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
            ctx.restore();
        }

        // --- Teleport Ghost (Start point) ---
        if (this.teleportGhost) {
            const t = this.teleportGhost;
            const tScreen = camera.worldToScreen(t.x, t.y, this.game.width, this.game.height);
            const img = t.asset.canvas || t.asset;
            const w = (t.asset.width || img.width) * this.game.worldScale;
            const h = (t.asset.height || img.height) * this.game.worldScale;

            let blueImg = this._blueGhostCache;
            if (!blueImg) {
                blueImg = this._createBlueGhost(img);
                this._blueGhostCache = blueImg;
            }

            ctx.save();
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = t.life * 0.8;
            ctx.translate(tScreen.x, tScreen.y);
            ctx.rotate(t.angle + Math.PI / 2);
            ctx.drawImage(blueImg, -w / 2, -h / 2, w, h);
            ctx.restore();
        }

        // Choose sprite
        let asset;
        if (this.thrusting && this.flyingFrames.length > 0) {
            asset = this.flyingFrames[this.currentFrame];
        } else {
            asset = this.stillImg;
        }
        const img = asset.canvas || asset;

        const w = (asset.width || img.width) * this.game.worldScale;
        const h = (asset.height || img.height) * this.game.worldScale;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);

        // Hide ship while warping
        if (!this.isWarping) {
            // Blinking if invulnerable
            if (this.invulnTimer > 0) {
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
                ctx.globalCompositeOperation = 'screen';
                ctx.globalAlpha = 0.5;
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'source-over';
            } else {
                ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
            }

            // Low health red pulse
            if (this.lowHealthPulseTimer > 0) {
                const pulseIntensity = (Math.sin(this.lowHealthPulseTimer) + 1) / 2; // 0 to 1
                this._drawTinted(ctx, img, -Math.floor(w / 2), -Math.floor(h / 2), w, h, `rgba(255, 0, 0, ${pulseIntensity * 0.5})`);
            }
        }

        // Ready flash
        const flash = Math.max(this.boostFlash, this.teleportFlash);
        if (flash > 0.01) {
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = flash;
            ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
            ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }

        // Teleport Outline Phase-in
        if (this.teleportOutlineFade > 0.01) {
            ctx.globalCompositeOperation = 'screen';
            this._drawTinted(ctx, img, -Math.floor(w / 2), -Math.floor(h / 2), w, h, `rgba(0, 150, 255, ${this.teleportOutlineFade * 0.8})`);
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();

        // Shield visual — proper asset, 70% transparent. Impacts surge the
        // brightness briefly; the actual ripple distortion is a displacement
        // wave rendered by the ScreenFX post-pass (see getScreenFx).
        if (this.shielding && this.shieldImg) {
            const sw = (this.shieldImg.width || this.shieldImg.canvas.width) * this.game.worldScale;
            const sh = (this.shieldImg.height || this.shieldImg.canvas.height) * this.game.worldScale;

            let surge = 0;
            const st = this.game.currentState;
            if (st && st.shieldRipples && st.shieldRipples.length) {
                const rip = st.shieldRipples[st.shieldRipples.length - 1];
                surge = Math.exp(-5 * Math.min(1, rip.t / 0.35));
            }

            ctx.save();
            ctx.globalAlpha = 0.3 + 0.3 * surge;
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(this.shieldImg.canvas || this.shieldImg, -sw / 2, -sh / 2, sw, sh);
            ctx.restore();
        }

        // (Yellow glow trail is drawn above, before the ship sprite)

        // Shield bar dimming when broken
        // (HUD handles visual, but we expose state via shieldBroken)
    }

    // The shield bubble's visual radius in world units (from the actual
    // shield sprite), so ring/sweep/ripple effects match what's on screen.
    get shieldRadius() {
        if (this.shieldImg) {
            return (this.shieldImg.width || this.shieldImg.canvas.width) / 2;
        }
        return this.radius * 1.5;
    }

    // Collision radius computed from sprite's opaque pixels (for broad-phase)
    get radius() {
        if (this._cachedRadius != null) return this._cachedRadius;
        const asset = this.stillImg;
        const canvas = asset.canvas || asset;

        // Logical size for analysis (ensures radius is in world units)
        const aw = asset.width || canvas.width;
        const ah = asset.height || canvas.height;

        const offCanvas = document.createElement('canvas');
        offCanvas.width = aw;
        offCanvas.height = ah;
        // Readback-only canvas → willReadFrequently keeps it CPU-side so this
        // getImageData can't stall the GPU rasteriser / main canvas.
        const ctx = offCanvas.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingEnabled = false;

        // MUST scale the physical buffer (64x64) down to logical (16x16) to avoid clipping and miscounting
        ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, aw, ah);

        const data = ctx.getImageData(0, 0, aw, ah).data;
        const cx = aw / 2, cy = ah / 2;
        let maxDistSq = 0;
        for (let y = 0; y < ah; y++) {
            for (let x = 0; x < aw; x++) {
                if (data[(y * aw + x) * 4 + 3] > 30) {
                    const dx = x - cx, dy = y - cy;
                    const d = dx * dx + dy * dy;
                    if (d > maxDistSq) maxDistSq = d;
                }
            }
        }
        this._cachedRadius = Math.sqrt(maxDistSq);
        return this._cachedRadius;
    }


    /**
     * Pixel-perfect collision check.
     * Takes world coordinates and checks against the current sprite's bitmask.
     */
    checkPixelCollision(worldX, worldY) {
        if (this.isWarping) return false;

        // 1. Broad phase: Distance check
        const dx = worldX - this.worldX;
        const dy = worldY - this.worldY;
        const distSq = dx * dx + dy * dy;
        const r = this.radius;
        if (distSq > r * r) return false;

        // 2. Narrow phase: Pixel check
        const asset = (this.thrusting && this.flyingFrames.length > 0) ?
            this.flyingFrames[this.currentFrame] :
            this.stillImg;

        const mask = this._getPixelMask(asset);
        if (!mask) return true; // Fallback to broad phase if mask fails

        const prescale = asset.prescale || 1;

        // Transform world point to local sprite space
        // Local relative to center
        const lx = worldX - this.worldX;
        const ly = worldY - this.worldY;

        // Rotate point reverse of ship angle
        const angle = -(this.angle + Math.PI / 2);
        const rx = lx * Math.cos(angle) - ly * Math.sin(angle);
        const ry = lx * Math.sin(angle) + ly * Math.cos(angle);

        // Map to pixel coords (center is width/2, height/2)
        const px = Math.floor(rx * prescale + mask.width / 2);
        const py = Math.floor(ry * prescale + mask.height / 2);

        if (px < 0 || py < 0 || px >= mask.width || py >= mask.height) return false;

        return mask.data[py * mask.width + px];
    }

    _getPixelMask(imgWrapper) {
        if (!imgWrapper) return null;
        if (imgWrapper._pixelMask) return imgWrapper._pixelMask;

        const img = imgWrapper.canvas || imgWrapper;
        if (!img || !img.width) return null;

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        // Readback-only canvas → keep it CPU-side (willReadFrequently).
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);

        const data = ctx.getImageData(0, 0, img.width, img.height).data;
        const maskData = new Uint8Array(img.width * img.height);

        for (let i = 0; i < maskData.length; i++) {
            maskData[i] = data[i * 4 + 3] > 50 ? 1 : 0;
        }

        imgWrapper._pixelMask = {
            width: img.width,
            height: img.height,
            data: maskData
        };
        return imgWrapper._pixelMask;
    }

    heal(percent) {
        const amount = this.maxHealth * percent;
        const prev = this.health + this.overheal;

        // Fill normal health first; any surplus spills into overheal.
        this.health += amount;
        if (this.health > this.maxHealth) {
            this.overheal += this.health - this.maxHealth;
            this.health = this.maxHealth;
        }
        // Cap overheal at 4× maxHealth (400% overflow = the legendary bar, i.e.
        // 500% total health) to match the four overflow tiers drawn in the HUD.
        if (this.overheal > this.maxHealth * 4) this.overheal = this.maxHealth * 4;

        const healed = (this.health + this.overheal) - prev;
        if (healed > 0 && this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `+${Math.ceil(healed)}`, '#44ff44');
        }

        this.game.sounds.play('select', { volume: 0.5, x: this.worldX, y: this.worldY }); // Heal sound
    }

    updateMaxHealth(multiplier) {
        // Preserve current health % across max-pool changes so picking up /
        // dropping max-HP items (e.g. energy canisters) can't be milked for free
        // healing. Flat permHealthBonus grants are added via addPermHealthBonus,
        // which updates maxHealth + health together so the ratio stays put here.
        const oldMax = this.maxHealth;
        const ratio = oldMax > 0 ? this.health / oldMax : 1;

        this.maxHealthMult = multiplier;
        const base = this.shipData.health * this.obedienceMult;
        this.maxHealth = base * this.maxHealthMult + this.permHealthBonus;

        this.health = Math.max(0, Math.min(this.maxHealth, this.maxHealth * ratio));
    }

    addPermHealthBonus(amount) {
        this.permHealthBonus += amount;
        this.maxHealth += amount;
        this.health = Math.min(this.maxHealth, this.health + amount);
    }

    updateMaxShield(flatBonus) {
        this.permShieldBonus += flatBonus;
        const base = this.shipData.shield * 15 * this.obedienceMult;
        this.maxShieldEnergy = (base + this.permShieldBonus) * this.shieldBoosterMult;
        this.shieldEnergy += flatBonus; // instantly grant the new capacity
        this.shieldEnergy = Math.max(0, Math.min(this.maxShieldEnergy, this.shieldEnergy));
    }

    /**
     * Draws an image tinted with a solid color, masked by the image's alpha channel.
     */
    _drawTinted(ctx, img, x, y, w, h, color) {
        if (!this._tintCanvas) {
            this._tintCanvas = document.createElement('canvas');
            this._tintCtx = this._tintCanvas.getContext('2d');
            this._tintCtx.imageSmoothingEnabled = false;
        }

        const canvas = img.canvas || img;
        const aw = img.width || canvas.width;
        const ah = img.height || canvas.height;

        // Ensure canvas is large enough for the image (unscaled)
        if (this._tintCanvas.width < aw || this._tintCanvas.height < ah) {
            this._tintCanvas.width = aw;
            this._tintCanvas.height = ah;
        }

        const tCtx = this._tintCtx;
        tCtx.clearRect(0, 0, this._tintCanvas.width, this._tintCanvas.height);

        // 1. Draw the base image
        tCtx.drawImage(canvas, 0, 0);

        // 2. Overlay the color using source-atop to mask it to the image pixels
        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.fillStyle = color;
        tCtx.fillRect(0, 0, aw, ah);
        tCtx.globalCompositeOperation = 'source-over';

        // 3. Draw the resulting tinted image to the main context
        ctx.drawImage(this._tintCanvas, 0, 0, aw, ah, x, y, w, h);
    }

    _createGreenGhost(img) {
        const canvas = img.canvas || img;
        const aw = img.width || canvas.width;
        const ah = img.height || canvas.height;
        const ghostCanvas = document.createElement('canvas');
        ghostCanvas.width = aw;
        ghostCanvas.height = ah;
        const tCtx = ghostCanvas.getContext('2d');
        tCtx.imageSmoothingEnabled = false;

        // Apply a large blur for a soft, glowing aurora look
        tCtx.filter = 'blur(8px)';

        // 1. Draw base
        tCtx.drawImage(canvas, 0, 0);

        // 2. Green tint
        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.fillStyle = 'rgba(0, 255, 100, 1)';
        tCtx.fillRect(0, 0, aw, ah);

        return ghostCanvas;
    }

    _createYellowGhost(img) {
        const canvas = img.canvas || img;
        const aw = img.width || canvas.width;
        const ah = img.height || canvas.height;
        const ghostCanvas = document.createElement('canvas');
        ghostCanvas.width = aw;
        ghostCanvas.height = ah;
        const tCtx = ghostCanvas.getContext('2d');
        tCtx.imageSmoothingEnabled = false;

        tCtx.filter = 'blur(4px)';
        tCtx.drawImage(canvas, 0, 0);

        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.fillStyle = 'rgba(255, 230, 80, 1)';
        tCtx.fillRect(0, 0, aw, ah);

        // Draw again without blur for a bright core
        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.filter = 'none';
        tCtx.globalAlpha = 0.5;
        tCtx.fillStyle = 'rgba(255, 255, 180, 1)';
        tCtx.fillRect(0, 0, aw, ah);

        return ghostCanvas;
    }

    _createBlueGhost(img) {
        const canvas = img.canvas || img;
        const aw = img.width || canvas.width;
        const ah = img.height || canvas.height;
        const ghostCanvas = document.createElement('canvas');
        ghostCanvas.width = aw;
        ghostCanvas.height = ah;
        const tCtx = ghostCanvas.getContext('2d');
        tCtx.imageSmoothingEnabled = false;

        tCtx.filter = 'blur(10px)';
        tCtx.drawImage(canvas, 0, 0);

        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.fillStyle = 'rgba(0, 150, 255, 1)';
        tCtx.fillRect(0, 0, aw, ah);

        return ghostCanvas;
    }

    // Blink-only dodge candidate scan.
    // (ax, ay) is the pre-warp position; (bx, by) is the warp target.
    // For each enemy projectile, sweep its trajectory forward
    // DODGE_TRAJ_LOOKAHEAD seconds and check if that swept segment passes
    // within the player's body radius of the A→B blink segment. Those are
    // the projectiles that "would have hit" the player along the line.
    _armDodgeWindow(ax, ay, bx, by) {
        this.dodgeCandidates.clear();
        this.dodgeDamaged = false;
        this.dodgeWindowTimer = this.DODGE_GRACE;
        if (this.invulnTimer > 0) {
            // Just got hit — the blink is reactive, not a dodge.
            this.dodgeWindowTimer = 0;
            return;
        }

        const state = this.game.currentState;
        const list = state && state.projectiles;
        if (!list || !list.length) return;

        const lookahead = this.DODGE_TRAJ_LOOKAHEAD;
        const thickness = this.radius;
        const thickSq = thickness * thickness;

        for (let i = 0; i < list.length; i++) {
            const proj = list[i];
            if (!proj || !proj.alive) continue;
            if (proj.owner === this) continue;
            const vx = proj.vx || 0;
            const vy = proj.vy || 0;
            const speedSq = vx * vx + vy * vy;
            if (speedSq < 100) continue; // Stationary — not a threat
            const cx = proj.worldX + vx * lookahead;
            const cy = proj.worldY + vy * lookahead;
            // Closest distance² between projectile sweep [P → C] and blink
            // line [A → B]. Within one body radius = "would have hit".
            if (this._segSegDistSq(proj.worldX, proj.worldY, cx, cy, ax, ay, bx, by) <= thickSq) {
                this.dodgeCandidates.add(proj);
            }
        }
    }

    // Commit dodges at the end of the grace window. If ANY damage landed
    // in the past DODGE_GRACE seconds, the whole batch voids — the player
    // got hit, so they didn't successfully dodge.
    _commitDodges() {
        if (this.dodgeDamaged) return;
        if (this.dodgeCandidates.size === 0) return;
        if (!this.game.achievements) return;
        for (let i = 0; i < this.dodgeCandidates.size; i++) {
            this.game.achievements.notify('dodge_performed');
        }
    }

    // Squared minimum distance between two line segments [P1→P2] and
    // [P3→P4] in 2D. Standard algorithm — parameterize each segment,
    // solve for the closest pair, clamp parameters to [0, 1].
    _segSegDistSq(p1x, p1y, p2x, p2y, p3x, p3y, p4x, p4y) {
        const d1x = p2x - p1x, d1y = p2y - p1y;
        const d2x = p4x - p3x, d2y = p4y - p3y;
        const rx  = p1x - p3x, ry  = p1y - p3y;
        const a = d1x * d1x + d1y * d1y;
        const e = d2x * d2x + d2y * d2y;
        const f = d2x * rx + d2y * ry;
        let s, t;
        if (a <= 1e-6 && e <= 1e-6) {
            return rx * rx + ry * ry;
        }
        if (a <= 1e-6) {
            s = 0;
            t = Math.max(0, Math.min(1, f / e));
        } else {
            const c = d1x * rx + d1y * ry;
            if (e <= 1e-6) {
                t = 0;
                s = Math.max(0, Math.min(1, -c / a));
            } else {
                const b = d1x * d2x + d1y * d2y;
                const denom = a * e - b * b;
                s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
                t = (b * s + f) / e;
                if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
                else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
            }
        }
        const c1x = p1x + d1x * s, c1y = p1y + d1y * s;
        const c2x = p3x + d2x * t, c2y = p3y + d2y * t;
        const dx = c1x - c2x, dy = c1y - c2y;
        return dx * dx + dy * dy;
    }

    /**
     * Adds experience and handles leveling up.
     * @param {number} amount
     */
    addExp(amount) {
        this.exp += amount * this.lvlExpGainMult;
        while (this.exp >= this.expNeeded) {
            this.exp -= this.expNeeded;
            this.level++;
            this.expNeeded = Math.floor(this.expNeeded * 1.16);

            // Visual feedback
            if (this.game.currentState && this.game.currentState.spawnFloatingText) {
                this.game.currentState.spawnFloatingText(this.worldX, this.worldY, 'LEVEL UP!', '#ffff44', 2.0);
            }

            if (this.game.achievements) {
                this.game.achievements.notify('level_up', { level: this.level });
            }

            // Queue upgrade dialog (sound plays when dialog opens) — queue onto
            // THIS pilot so co-op claims/dialogs stay per-pilot.
            if (this.game.currentState && this.game.currentState.queueLevelUp) {
                this.game.currentState.queueLevelUp(this.level, this);
            } else {
                this.game.sounds.play('select', { volume: 1.0, x: this.worldX, y: this.worldY });
            }
        }
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            vx: this.vx,
            vy: this.vy,
            angle: this.angle,
            health: this.health,
            maxHealth: this.maxHealth,
            overheal: this.overheal,
            scrap: this.scrap,
            shieldEnergy: this.shieldEnergy,
            shieldBroken: this.shieldBroken,
            permHealthBonus: this.permHealthBonus,
            permShieldBonus: this.permShieldBonus,
            permDamageBonus: this.permDamageBonus,
            inventoryUpgradeTier: this.inventoryUpgradeTier,
            level: this.level,
            exp: this.exp,
            expNeeded: this.expNeeded,
            lvlDamageMult: this.lvlDamageMult,
            lvlMaxHpMult: this.lvlMaxHpMult,
            lvlMaxShieldMult: this.lvlMaxShieldMult,
            lvlShieldDrainMult: this.lvlShieldDrainMult,
            lvlSpeedMult: this.lvlSpeedMult,
            lvlProjectileSpeedMult: this.lvlProjectileSpeedMult,
            lvlBoostCooldownMult: this.lvlBoostCooldownMult,
            lvlFireRateMult: this.lvlFireRateMult,
            lvlShieldRechargeMult: this.lvlShieldRechargeMult,
            lvlExpGainMult: this.lvlExpGainMult,
            lvlBoostSpeedMult: this.lvlBoostSpeedMult,
            lvlBoostDurationMult: this.lvlBoostDurationMult,
            lvlAsteroidResistanceMult: this.lvlAsteroidResistanceMult,
            lvlAsteroidSpawnMult: this.lvlAsteroidSpawnMult,
            lvlVacuumRangeMult: this.lvlVacuumRangeMult,
            lvlTurnSpeedMult: this.lvlTurnSpeedMult,
            lvlShieldDamageMult: this.lvlShieldDamageMult,
            lvlFovMult: this.lvlFovMult,
            lvlScrapChanceMult: this.lvlScrapChanceMult,
            lvlCacheFreqMult: this.lvlCacheFreqMult,
            lvlEncounterFreqMult: this.lvlEncounterFreqMult,
            lvlEnemySpawnMult: this.lvlEnemySpawnMult,
            lvlDifficultyMult: this.lvlDifficultyMult,
            lvlWaveCountdownMult: this.lvlWaveCountdownMult,
            lvlExtraProjectiles: this.lvlExtraProjectiles,
            lvlHpRegen: this.lvlHpRegen,
            lvlLuckMult: this.lvlLuckMult,
            lvlChoices: this.lvlChoices.map(c => ({ ...c })),
            upgradeTypeCounts: { ...this.upgradeTypeCounts },
            hasYellowGlow: this.hasYellowGlow,
            inventory: this.inventory ? this.inventory.serialize() : null
        };
    }

    async deserialize(data) {
        this.worldX = data.worldX;
        this.worldY = data.worldY;
        this.vx = data.vx;
        this.vy = data.vy;
        this.angle = data.angle;
        this.health = data.health;
        this.maxHealth = data.maxHealth;
        this.overheal = data.overheal || 0;
        this.scrap = data.scrap;
        this.shieldEnergy = data.shieldEnergy;
        this.shieldBroken = data.shieldBroken;
        this.permHealthBonus = data.permHealthBonus;
        this.permShieldBonus = data.permShieldBonus;
        this.permDamageBonus = data.permDamageBonus;
        this.inventoryUpgradeTier = data.inventoryUpgradeTier;
        this.level = data.level || 1;
        this.exp = data.exp || 0;
        this.expNeeded = data.expNeeded || 10;

        // Restore level-up bonuses
        if (data.lvlDamageMult !== undefined) {
            this.lvlDamageMult           = data.lvlDamageMult;
            this.lvlMaxHpMult            = data.lvlMaxHpMult;
            this.lvlMaxShieldMult        = data.lvlMaxShieldMult;
            this.lvlShieldDrainMult      = data.lvlShieldDrainMult;
            this.lvlSpeedMult            = data.lvlSpeedMult;
            this.lvlProjectileSpeedMult  = data.lvlProjectileSpeedMult;
            this.lvlBoostCooldownMult    = data.lvlBoostCooldownMult;
            this.lvlFireRateMult         = data.lvlFireRateMult;
            this.lvlShieldRechargeMult   = data.lvlShieldRechargeMult;
            this.lvlExpGainMult          = data.lvlExpGainMult;
            this.lvlBoostSpeedMult       = data.lvlBoostSpeedMult;
            this.lvlBoostDurationMult    = data.lvlBoostDurationMult;
            this.lvlAsteroidResistanceMult = data.lvlAsteroidResistanceMult;
            this.lvlAsteroidSpawnMult    = data.lvlAsteroidSpawnMult;
            this.lvlVacuumRangeMult      = data.lvlVacuumRangeMult;
            this.lvlTurnSpeedMult        = data.lvlTurnSpeedMult;
            this.lvlShieldDamageMult     = data.lvlShieldDamageMult;
            this.lvlFovMult              = data.lvlFovMult;
            this.lvlScrapChanceMult      = data.lvlScrapChanceMult;
            this.lvlCacheFreqMult        = data.lvlCacheFreqMult;
            this.lvlEncounterFreqMult    = data.lvlEncounterFreqMult;
            this.lvlEnemySpawnMult       = data.lvlEnemySpawnMult;
            this.lvlDifficultyMult       = data.lvlDifficultyMult;
            this.lvlWaveCountdownMult    = data.lvlWaveCountdownMult;
            this.lvlExtraProjectiles     = data.lvlExtraProjectiles || 0;
            this.lvlHpRegen              = data.lvlHpRegen || 0;
            this.lvlLuckMult             = data.lvlLuckMult || 1.0;
            this.lvlChoices              = Array.isArray(data.lvlChoices) ? data.lvlChoices.map(c => ({ ...c })) : [];
            this.upgradeTypeCounts       = data.upgradeTypeCounts ? { ...data.upgradeTypeCounts } : {};
            this.hasYellowGlow           = data.hasYellowGlow || false;
        }

        if (data.inventory && this.inventory) {
            await this.inventory.deserialize(data.inventory);
        }
    }
}
