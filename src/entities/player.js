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
        this.baseSpeed = shipData.speed * 240;
        this.acceleration = this.baseSpeed * 3;
        this.friction = 0.96;

        // Boost — short powerful burst
        this.boostPower = 12000;
        this.boostDuration = 0.4;
        this.boostCooldown = 2.0;

        // Multipliers (modified by upgrades)
        this.fireRateMult = 1.0;
        this.boostRangeMult = 1.0;
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
        this.boostSpeedMult = 1.0;
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

        this.boostTimer = 0;
        this.boostCooldownTimer = 0;
        this.isBoosting = false;
        this.boostIntensity = 0;
        this.boostFlash = 0;
        this._boostWasOnCooldown = false;

        // Dodge — lateral dash (A/D)
        this.dodgePower = 5000;
        this.dodgeCooldown = 0.6;
        this.dodgeCooldownTimer = 0;
        this.canDodge = shipData.special === 'dodge'; // Overridden by hasAncientCurse dynamically below
        this.isDodging = false;
        this.dodgeTimer = 0;
        this.dodgeDuration = 0.15;
        this.dodgeFlash = 0;
        this._dodgeWasOnCooldown = false;

        // State
        this.thrusting = false;
        this.health = shipData.health;
        this.maxHealth = shipData.health;
        this.scrap = 0;

        // Shield — proper asset, breaks when depleted
        this.shieldEnergy = shipData.shield * 15;
        this.maxShieldEnergy = shipData.shield * 15;
        this.shielding = false;
        this.shieldBroken = false;        // true when fully depleted, must recharge to 30%
        this.shieldRechargeRate = 8;
        this.shieldDrainRate = 20;
        this.shieldImg = game.assets.get('shield');

        // Shooting
        this.shootCooldown = 0.2;
        this.shootTimer = 0;
        this.projectileSpeed = 3600;
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
            if (dist < 1500 * this.game.worldScale) {
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
            // Apply friction only when not accelerating
            this.rotationVelocity *= this.rotationFriction;
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

        // --- Boost ---
        this.boostCooldownTimer = Math.max(0, this.boostCooldownTimer - dt);
        if (this.boostTimer > 0) {
            this.boostTimer -= dt;
            this.boostIntensity = this.boostTimer / this.boostDuration;
            if (this.boostTimer <= 0) {
                this.isBoosting = false;
                this.boostIntensity = 0;
            }
        }

        if (this.hasBoostDrive) {
            if (input.isKeyDown('Space')) {
                // Play sound once when starting
                if (!this.isBoosting) {
                    this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
                }

                this.isBoosting = true;
                this.thrusting = true;
                this.boostIntensity = 1.0;
                this.boostTimer = 0.1; // Keep it alive for trail effect

                const power = this.acceleration * 4.5 * dt;
                this.vx += Math.cos(this.angle) * power;
                this.vy += Math.sin(this.angle) * power;
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
                const power = this.boostPower * this.boostRangeMult * this.boostSpeedMult;
                this.vx += Math.cos(this.angle) * power;
                this.vy += Math.sin(this.angle) * power;
                this.game.sounds.play('boost', { volume: 0.5, x: this.worldX, y: this.worldY });
            }
        }

        if (this._boostWasOnCooldown && this.boostCooldownTimer <= 0) {
            this.boostFlash = 1;
            this._boostWasOnCooldown = false;
        }
        this.boostFlash = Math.max(0, this.boostFlash - dt * 4);

        // --- Dodge ---
        this.dodgeCooldownTimer = Math.max(0, this.dodgeCooldownTimer - dt);
        if (this.dodgeTimer > 0) {
            this.dodgeTimer -= dt;
            if (this.dodgeTimer <= 0) this.isDodging = false;
        }

        if (this.canDodge && !this.hasAncientCurse && this.dodgeCooldownTimer <= 0) {
            if (input.isKeyJustPressed('KeyA')) {
                const perpAngle = this.angle - Math.PI / 2;
                this.vx += Math.cos(perpAngle) * this.dodgePower;
                this.vy += Math.sin(perpAngle) * this.dodgePower;
                this.isDodging = true;
                this.dodgeTimer = this.dodgeDuration;
                this.dodgeCooldownTimer = this.dodgeCooldown;
                this._dodgeWasOnCooldown = true;
                this.game.sounds.play('dodge', { volume: 0.4, x: this.worldX, y: this.worldY });
            }
            if (input.isKeyJustPressed('KeyD')) {
                const perpAngle = this.angle + Math.PI / 2;
                this.vx += Math.cos(perpAngle) * this.dodgePower;
                this.vy += Math.sin(perpAngle) * this.dodgePower;
                this.isDodging = true;
                this.dodgeTimer = this.dodgeDuration;
                this.dodgeCooldownTimer = this.dodgeCooldown;
                this._dodgeWasOnCooldown = true;
                this.game.sounds.play('dodge', { volume: 0.4, x: this.worldX, y: this.worldY });
            }
        }

        if (this._dodgeWasOnCooldown && this.dodgeCooldownTimer <= 0) {
            this.dodgeFlash = 1;
            this._dodgeWasOnCooldown = false;
        }
        this.dodgeFlash = Math.max(0, this.dodgeFlash - dt * 4);

        // --- Physics ---
        this.vx += accelX * dt;
        this.vy += accelY * dt;

        let maxSpeed = this.baseSpeed * this.pulseJetMult * this.mechanicalEngineSpeedMult;
        const currentSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (!this.isBoosting && !this.isDodging && currentSpeed > maxSpeed) {
            const decay = Math.max(maxSpeed / currentSpeed, 1 - dt * 5);
            this.vx *= decay;
            this.vy *= decay;
        }

        this.vx *= this.friction;
        this.vy *= this.friction;
        if (Math.abs(this.vx) < 0.1 && Math.abs(this.vy) < 0.1) {
            this.vx = 0;
            this.vy = 0;
        }

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // --- Thruster sound (speed-based overlapping) ---
        if (this.thrusting && currentSpeed > 100) {
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
                const noseOffset = 30 * this.game.worldScale;
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
                    const offset = 15 * this.game.worldScale;
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

                if (this.hasEnergyBlaster) {
                    origins.forEach(origin => {
                        const count = 3 + Math.floor(Math.random() * 3); // 3-5 shots
                        for (let i = 0; i < count; i++) {
                            const spread = (Math.random() - 0.5) * 0.5; // ~±15 degrees
                            const speedVar = baseProjSpeed * (0.8 + Math.random() * 0.4); // 80% to 120%
                            this.pendingProjectiles.push(
                                new Projectile(this.game, origin.px, origin.py, fireAngle + spread, speedVar, spriteKey, this, (this.shipData.baseDamage * 0.3 + this.permDamageBonus) * damageMult)
                            );
                        }
                    });
                    this.shootTimer = this.shootCooldown * this.fireRateMult * 1.5;
                } else {
                    origins.forEach(origin => {
                        this.pendingProjectiles.push(
                            new Projectile(this.game, origin.px, origin.py, fireAngle, baseProjSpeed, spriteKey, this, (this.shipData.baseDamage + this.permDamageBonus) * damageMult)
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
    }

    draw(ctx) {
        const centerX = this.game.width / 2;
        const centerY = this.game.height / 2;

        // Choose sprite
        let img;
        if (this.thrusting && this.flyingFrames.length > 0) {
            img = this.flyingFrames[this.currentFrame].canvas;
        } else {
            img = this.stillImg;
        }

        const w = img.width * this.game.worldScale;
        const h = img.height * this.game.worldScale;

        ctx.save();
        ctx.translate(Math.floor(centerX), Math.floor(centerY));
        ctx.rotate(this.angle + Math.PI / 2);

        // Blinking if invulnerable
        if (this.invulnTimer > 0) {
            ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = 0.5;
            ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        } else {
            ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        }

        // Low health red pulse
        if (this.lowHealthPulseTimer > 0) {
            const pulseIntensity = (Math.sin(this.lowHealthPulseTimer) + 1) / 2; // 0 to 1
            this._drawTinted(ctx, img, -Math.floor(w / 2), -Math.floor(h / 2), w, h, `rgba(255, 0, 0, ${pulseIntensity * 0.5})`);
        }

        // Ready flash
        const flash = Math.max(this.boostFlash, this.dodgeFlash);
        if (flash > 0.01) {
            ctx.globalCompositeOperation = 'lighter';
            ctx.globalAlpha = flash * 0.6;
            ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
        }

        ctx.restore();

        // Shield visual — proper asset, 70% transparent
        if (this.shielding && this.shieldImg) {
            const sw = this.shieldImg.width * this.game.worldScale;
            const sh = this.shieldImg.height * this.game.worldScale;
            ctx.save();
            ctx.globalAlpha = 0.3; // 70% transparent
            ctx.translate(Math.floor(centerX), Math.floor(centerY));
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(this.shieldImg, -Math.floor(sw / 2), -Math.floor(sh / 2), sw, sh);
            ctx.restore();
        }

        // Shield bar dimming when broken
        // (HUD handles visual, but we expose state via shieldBroken)
    }

    // Collision radius computed from sprite's opaque pixels (for broad-phase)
    get radius() {
        if (this._cachedRadius != null) return this._cachedRadius;
        const img = this.stillImg;
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const data = ctx.getImageData(0, 0, img.width, img.height).data;
        const cx = img.width / 2, cy = img.height / 2;
        let maxDistSq = 0;
        for (let y = 0; y < img.height; y++) {
            for (let x = 0; x < img.width; x++) {
                if (data[(y * img.width + x) * 4 + 3] > 30) {
                    const dx = x - cx, dy = y - cy;
                    const d = dx * dx + dy * dy;
                    if (d > maxDistSq) maxDistSq = d;
                }
            }
        }
        this._cachedRadius = Math.sqrt(maxDistSq) * this.game.worldScale;
        return this._cachedRadius;
    }

    /**
     * Pixel-perfect collision check.
     * Takes world coordinates and checks against the current sprite's bitmask.
     */
    checkPixelCollision(worldX, worldY) {
        // 1. Broad phase: Distance check
        const dx = worldX - this.worldX;
        const dy = worldY - this.worldY;
        const distSq = dx * dx + dy * dy;
        const r = this.radius;
        if (distSq > r * r) return false;

        // 2. Narrow phase: Pixel check
        const img = this.thrusting && this.flyingFrames.length > 0 ?
            this.flyingFrames[this.currentFrame] :
            { canvas: this.stillImg };

        const mask = this._getPixelMask(img);
        if (!mask) return true; // Fallback to broad phase if mask fails

        // Transform world point to local sprite space
        // Local relative to center
        const lx = worldX - this.worldX;
        const ly = worldY - this.worldY;

        // Rotate point reverse of ship angle
        const angle = -(this.angle + Math.PI / 2);
        const rx = lx * Math.cos(angle) - ly * Math.sin(angle);
        const ry = lx * Math.sin(angle) + ly * Math.cos(angle);

        // Map to pixel coords (center is width/2, height/2)
        const px = Math.floor(rx / this.game.worldScale + mask.width / 2);
        const py = Math.floor(ry / this.game.worldScale + mask.height / 2);

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
        this.health = Math.min(this.maxHealth, this.health + amount);
        this.game.sounds.play('select', { volume: 0.5, x: this.worldX, y: this.worldY }); // Heal sound
    }

    updateMaxHealth(multiplier) {
        this.maxHealthMult = multiplier;
        this.maxHealth = this.shipData.health * this.maxHealthMult + this.permHealthBonus;

        // Clamp health to new max and ensure it doesn't go below 0
        this.health = Math.max(0, Math.min(this.maxHealth, this.health));
    }

    updateMaxShield(flatBonus) {
        this.permShieldBonus += flatBonus;
        this.maxShieldEnergy = (this.shipData.shield * 15 + this.permShieldBonus) * this.shieldBoosterMult;
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
        }

        // Ensure canvas is large enough for the image (unscaled)
        if (this._tintCanvas.width < img.width || this._tintCanvas.height < img.height) {
            this._tintCanvas.width = img.width;
            this._tintCanvas.height = img.height;
        }

        const tCtx = this._tintCtx;
        tCtx.clearRect(0, 0, this._tintCanvas.width, this._tintCanvas.height);

        // 1. Draw the base image
        tCtx.drawImage(img, 0, 0);

        // 2. Overlay the color using source-atop to mask it to the image pixels
        tCtx.globalCompositeOperation = 'source-atop';
        tCtx.fillStyle = color;
        tCtx.fillRect(0, 0, img.width, img.height);
        tCtx.globalCompositeOperation = 'source-over';

        // 3. Draw the resulting tinted image to the main context
        ctx.drawImage(this._tintCanvas, 0, 0, img.width, img.height, x, y, w, h);
    }
}
