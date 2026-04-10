// Dynamic scaling is now handled via game properties
import { Projectile } from './projectile.js';

export class Player {
    constructor(game, shipData) {
        this.game = game;
        this.shipData = shipData;

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
        this.momentumSpeedMult = 0.5;
        this.momentumMaxSpeedMult = 2 * (0.97 / 0.99);
        this.momentumBoostMult = 0.5;

        this.boostTimer = 0;
        this.boostCooldownTimer = 0;
        this.isBoosting = false;
        this.boostIntensity = 0;
        this.boostFlash = 0;
        this._boostWasOnCooldown = false;

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
        this.hasRepeater = false;
        this.hasLaserOverride = false;
        this.isRailgunTargeting = false;
        this.railgunTargetTimer = 0;
        this.pendingRailgunFire = false;

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
        this._cachedRadius = null;
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
        const targetingCone = 10 * (Math.PI / 180); // ±5 degrees

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
        const input = this.game.input;
        const mouse = this.game.getMousePos();
        const centerX = this.game.width / 2;
        const centerY = this.game.height / 2;

        // Angle toward mouse (only if not using keyboard rotation)
        const isRotatingCCW = input.isKeyDown('KeyJ');
        const isRotatingCW = input.isKeyDown('KeyL');

        const currentRotationAccel = this.rotationAcceleration * this.mechanicalEngineTurnMult;

        if (isRotatingCCW) {
            this.rotationVelocity -= currentRotationAccel * dt;
            this.useKeyboardAim = true;
            this.lastMouseX = mouse.x;
            this.lastMouseY = mouse.y;
        } else if (isRotatingCW) {
            this.rotationVelocity += currentRotationAccel * dt;
            this.useKeyboardAim = true;
            this.lastMouseX = mouse.x;
            this.lastMouseY = mouse.y;
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

        // Mouse aiming logic (only if keyboard hasn't taken over or mouse moved substantially)
        if (!isRotatingCCW && !isRotatingCW) {
            // Check if mouse has moved enough to regain control
            if (this.useKeyboardAim) {
                const dx = mouse.x - this.lastMouseX;
                const dy = mouse.y - this.lastMouseY;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > this.mouseThreshold) {
                    this.useKeyboardAim = false;
                }
            }

            if (!this.useKeyboardAim && Math.abs(this.rotationVelocity) < 0.1) {
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

        // Thrusting logic
        this.thrusting = false;
        let accelX = 0;
        let accelY = 0;

        const currentAccel = this.acceleration * this.mechanicalEngineSpeedMult;

        if (this.hasAncientCurse) {
            // Free WASD movement independent of ship angle
            if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) {
                accelY -= currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) {
                accelY += currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyA') || input.isKeyDown('ArrowLeft')) {
                accelX -= currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyD') || input.isKeyDown('ArrowRight')) {
                accelX += currentAccel;
                this.thrusting = true;
            }
        } else {
            // Standard thrusting along the nose angle
            if (input.isKeyDown('KeyW') || input.isKeyDown('ArrowUp')) {
                accelX = Math.cos(this.angle) * currentAccel;
                accelY = Math.sin(this.angle) * currentAccel;
                this.thrusting = true;
            }
            if (input.isKeyDown('KeyS') || input.isKeyDown('ArrowDown')) {
                accelX = -Math.cos(this.angle) * currentAccel * 0.5;
                accelY = -Math.sin(this.angle) * currentAccel * 0.5;
                this.thrusting = true;
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

        if (this.hasTeleport) {
            if (input.isKeyJustPressed('Space') && this.boostCooldownTimer <= 0 && !this.isWarping) {
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
            }
        } else if (this.hasBoostDrive) {
            if (input.isKeyDown('Space')) {
                // Play sound once when starting
                if (!this.isBoosting) {
                    this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(1.2, 15.0);
                }

                this.isBoosting = true;
                this.thrusting = true;
                this.boostIntensity = 1.0;
                this.boostTimer = 0.1; // Keep it alive for trail effect

                const power = this.acceleration * 4.5 * dt;
                this.vx += Math.cos(this.angle) * power;
                this.vy += Math.sin(this.angle) * power;

                // Subtle continuous jitter while holding boost
                this.game.camera.rumble(0.4);
            } else {
                this.isBoosting = false;
                this.boostIntensity = 0;
            }
        } else {
            if (input.isKeyJustPressed('Space') && this.boostCooldownTimer <= 0) {
                this.isBoosting = true;
                this.boostTimer = this.boostDuration;
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
        }
        this.boostFlash = Math.max(0, this.boostFlash - dt * 4);

        if (this._teleportWasOnCooldown && this.boostCooldownTimer <= 0) {
            this.teleportFlash = 1;
            this._teleportWasOnCooldown = false;
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

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

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
        const wantShield = (input.isMouseDown(2) || isShiftDown) && !this.shieldBroken && this.shieldEnergy > 0;

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
            }
        }

        // --- Shooting (left mouse) ---
        this.shootTimer = Math.max(0, this.shootTimer - dt);

        if (this.hasRailgun) {
            const isShooting = input.isMouseDown(0) || input.isKeyDown('KeyI');
            if (isShooting && this.shootTimer <= 0 && !this.isRailgunTargeting) {
                this.isRailgunTargeting = true;
                // Repeater reduces charge time, control module reduces it further
                let baseCharge = (this.hasRepeater ? 0.1 : 0.25) * this.fireRateMult;
                if (this.hasControlModule) baseCharge *= 0.5; // 50% faster charge
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
            if ((input.isMouseDown(0) || input.isKeyDown('KeyI')) && this.shootTimer <= 0) {
                const noseOffset = 30;
                const px = this.worldX + Math.cos(this.angle) * noseOffset;
                const py = this.worldY + Math.sin(this.angle) * noseOffset;

                let damageMult = (this.hasRepeater ? 0.5 : 1.0) * (this.hasLaserOverride ? 1.3 : 1.0);
                const spriteKey = this.hasLaserOverride ? 'blue_laser_ball_big' : 'blue_laser_ball';

                let baseProjSpeed = this.projectileSpeed;
                if (this.hasControlModule) baseProjSpeed *= 1.2;


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
                    damageMult *= 0.7; // 30% individual damage reduction
                } else {
                    origins.push({ px, py });
                }

                let currentBaseDamage = this.shipData.baseDamage * this.obedienceMult + this.permDamageBonus;

                if (this.hasEnergyBlaster) {
                    origins.forEach(origin => {
                        const count = 3 + Math.floor(Math.random() * 3); // 3-5 shots
                        for (let i = 0; i < count; i++) {
                            const spread = (Math.random() - 0.5) * 0.5; // ~±15 degrees
                            const speedVar = baseProjSpeed * (0.8 + Math.random() * 0.4); // 80% to 120%
                            this.pendingProjectiles.push(
                                new Projectile(this.game, origin.px, origin.py, fireAngle + spread, speedVar, spriteKey, this, currentBaseDamage * 0.3 * damageMult)
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
                    this.shootTimer = this.shootCooldown * this.fireRateMult;
                }
                // Lower volume if firing very fast
                const vol = 0.3 * Math.max(0.5, this.fireRateMult);
                this.game.sounds.play('laser', { volume: vol, x: px, y: py });
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
        for (let i = 0; i < this.trailHistory.length; i++) {
            this.trailHistory[i].life -= dt * 6; // Fast fade but enough to see the length
        }
        this.trailHistory = this.trailHistory.filter(t => t.life > 0);

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
            ctx.globalCompositeOperation = 'lighter';
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
            ctx.globalCompositeOperation = 'lighter';
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
                ctx.globalCompositeOperation = 'lighter';
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
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = flash * 0.6;
            ctx.drawImage(img.canvas || img, -w / 2, -h / 2, w, h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }

        // Teleport Outline Phase-in
        if (this.teleportOutlineFade > 0.01) {
            ctx.globalCompositeOperation = 'lighter';
            this._drawTinted(ctx, img, -Math.floor(w / 2), -Math.floor(h / 2), w, h, `rgba(0, 150, 255, ${this.teleportOutlineFade * 0.8})`);
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();

        // Shield visual — proper asset, 70% transparent
        if (this.shielding && this.shieldImg) {
            const sw = (this.shieldImg.width || this.shieldImg.canvas.width) * this.game.worldScale;
            const sh = (this.shieldImg.height || this.shieldImg.canvas.height) * this.game.worldScale;
            ctx.save();
            ctx.globalAlpha = 0.3; // 70% transparent
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(this.shieldImg.canvas || this.shieldImg, -sw / 2, -sh / 2, sw, sh);
            ctx.restore();
        }

        // Shield bar dimming when broken
        // (HUD handles visual, but we expose state via shieldBroken)
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
        const ctx = offCanvas.getContext('2d');
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
        const ctx = canvas.getContext('2d');
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
        const prev = this.health;
        this.health = Math.min(this.maxHealth, this.health + amount);

        const healed = this.health - prev;
        if (healed > 0 && this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `+${Math.ceil(healed)}`, '#44ff44');
        }

        this.game.sounds.play('select', { volume: 0.5, x: this.worldX, y: this.worldY }); // Heal sound
    }

    updateMaxHealth(multiplier) {
        this.maxHealthMult = multiplier;
        const base = this.shipData.health * this.obedienceMult;
        this.maxHealth = base * this.maxHealthMult + this.permHealthBonus;

        // Clamp health to new max and ensure it doesn't go below 0
        this.health = Math.max(0, Math.min(this.maxHealth, this.health));
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

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            vx: this.vx,
            vy: this.vy,
            angle: this.angle,
            health: this.health,
            maxHealth: this.maxHealth,
            scrap: this.scrap,
            shieldEnergy: this.shieldEnergy,
            shieldBroken: this.shieldBroken,
            permHealthBonus: this.permHealthBonus,
            permShieldBonus: this.permShieldBonus,
            permDamageBonus: this.permDamageBonus,
            inventoryUpgradeTier: this.inventoryUpgradeTier,
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
        this.scrap = data.scrap;
        this.shieldEnergy = data.shieldEnergy;
        this.shieldBroken = data.shieldBroken;
        this.permHealthBonus = data.permHealthBonus;
        this.permShieldBonus = data.permShieldBonus;
        this.permDamageBonus = data.permDamageBonus;
        this.inventoryUpgradeTier = data.inventoryUpgradeTier;

        if (data.inventory && this.inventory) {
            await this.inventory.deserialize(data.inventory);
        }
    }
}
