import { Projectile } from './projectile.js';
import { Boss, BOSS_PHASE, BOSS_STATE } from './boss.js';

// Extra states for Event Horizon's unique movement
const EH_STATE = {
    STRAFE: 'strafe',       // Flying alongside player, firing side guns
    ARC_DASH: 'arc_dash',   // High-speed arc pass in front of player, laying mines
    DRIFT: 'drift',         // Phase 2: cut power, float with inertia, spin and fire
    BLUFF: 'bluff',         // Phase 2: charge toward player then curve away
};

export class EventHorizon extends Boss {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);
        this.spriteKey = 'event_horizon';
        this.radius = 100;
        this.health = (150 * this.curvedDifficultyScale) + 58 * this.difficultyScale;
        this.maxHealth = this.health;

        // Speed-focused boss
        this.baseSpeed = 900;
        this.turnSpeed = 8.0;
        this.attackRange = 1000;

        // Timers
        this.sideGunTimer = 0.8;
        this.multishotTimer = 2.0;
        this.mineTimer = 4.0;

        // Side gun burst system
        this.sideGunBurstQueue = 0;
        this.sideGunBurstTimer = 0;

        // Multishot burst
        this.multishotBurstQueue = 0;
        this.multishotBurstTimer = 0;

        // Strafe state
        this.strafeTarget = { x: 0, y: 0 };
        this.strafeSide = Math.random() > 0.5 ? 1 : -1;
        this.strafeRepositionTimer = 0;

        // Arc dash
        this.arcDashAngle = 0;      // current arc progress
        this.arcDashCenter = { x: 0, y: 0 };
        this.arcDashRadius = 0;
        this.arcDashDir = 1;
        this.arcDashSpeed = 0;
        this.minesLaidThisDash = 0;
        this.dashMineTimer = 0;

        // Drift state (Phase 2)
        this.driftVx = 0;
        this.driftVy = 0;
        this.driftSpinSpeed = 0;
        this.driftFriction = 0.92;

        // Bluff charge (Phase 2)
        this.bluffTarget = { x: 0, y: 0 };
        this.bluffCurveDir = 1;
        this.bluffPhase = 'approach'; // 'approach' or 'curve'

        // Mine tracking
        this.activeMines = [];

        this.musicKey = 'Event Horizon Chase';
        this._lastPhase = this.phase;
        this._actionIndex = 0;

        // Override the base movement - we handle it ourselves for most states
        this._customMovement = false;
    }

    _updateAI(dt, player, dist, angleToPlayer) {
        this.stateTimer -= dt;
        const distMult = this._getDistanceMult();

        // Phase 2 Transition
        if (this.phase !== this._lastPhase) {
            if (this.phase === BOSS_PHASE.ATTACK2) {
                this.game.sounds.play('boost', { volume: 1.2, x: this.worldX, y: this.worldY });
                this.game.camera.shake(2.5);
                this.baseSpeed = 1150;
                this.turnSpeed = 10.0;
                // Immediately enter a dash to show off the speed increase
                this._startArcDash(player, angleToPlayer);
            }
            this._lastPhase = this.phase;
        }

        // Update mines: slow them down over time and clean up dead ones
        for (let i = this.activeMines.length - 1; i >= 0; i--) {
            const mine = this.activeMines[i];
            if (!mine.alive) {
                this.activeMines.splice(i, 1);
            } else {
                // Apply friction to slow mines down from their initial spread velocity
                const friction = Math.pow(0.92, dt * 60);
                mine.vx *= friction;
                mine.vy *= friction;
            }
        }

        // Process side gun bursts
        if (this.sideGunBurstQueue > 0) {
            this.sideGunBurstTimer -= dt;
            if (this.sideGunBurstTimer <= 0) {
                this._fireSideGunShot(player);
                this.sideGunBurstQueue--;
                this.sideGunBurstTimer = 0.07;
            }
        }

        // Process multishot bursts
        if (this.multishotBurstQueue > 0) {
            this.multishotBurstTimer -= dt;
            if (this.multishotBurstTimer <= 0) {
                this._fireMultishot(player);
                this.multishotBurstQueue--;
                this.multishotBurstTimer = 0.1;
            }
        }

        // Proximity avoidance - don't ram the player
        const avoidDist = ((this.phase === BOSS_PHASE.ATTACK2) ? 220 : 260) * distMult;
        if (dist < avoidDist && this.state !== BOSS_STATE.REPOSITION && this.state !== BOSS_STATE.DASH && this.state !== EH_STATE.BLUFF) {
            this.state = BOSS_STATE.REPOSITION;
            this.stateTimer = 0.5;
            this._customMovement = false;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + Math.PI + (Math.PI * 0.3) * side;
            this.baseSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 1400 : 1100;
        }

        // State machine
        const ehState = this.state;

        if (ehState === EH_STATE.STRAFE) {
            this._updateStrafe(dt, player, dist, angleToPlayer);
        } else if (ehState === EH_STATE.ARC_DASH) {
            this._updateArcDash(dt, player, dist, angleToPlayer);
        } else if (ehState === EH_STATE.DRIFT) {
            this._updateDrift(dt, player, dist, angleToPlayer);
        } else if (ehState === EH_STATE.BLUFF) {
            this._updateBluff(dt, player, dist, angleToPlayer);
        } else if (ehState === BOSS_STATE.IDLE) {
            this._customMovement = false;
            this.targetAngle = this._getPredictedAngle(player, 1000);
            if (this.stateTimer <= 0) {
                this._selectNextAction(player, dist, angleToPlayer);
            }
        } else if (ehState === BOSS_STATE.REPOSITION) {
            this._customMovement = false;
            if (this.stateTimer <= 0) {
                this._selectNextAction(player, dist, angleToPlayer);
            }
        } else if (ehState === BOSS_STATE.DASH) {
            this._customMovement = false;
            if (this.stateTimer <= 0) {
                this.baseSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 1150 : 900;
                this._selectNextAction(player, dist, angleToPlayer);
            }
        }

        // Weapon timers - fire during most states, not just idle
        const canFire = dist < this.attackRange * distMult && ehState !== EH_STATE.ARC_DASH;
        if (canFire) {
            this.sideGunTimer -= dt;
            this.multishotTimer -= dt;
            this.mineTimer -= dt;

            if (this.sideGunTimer <= 0 && this.sideGunBurstQueue <= 0) {
                this.sideGunBurstQueue = this.phase === BOSS_PHASE.ATTACK2 ? 7 : 4;
                this.sideGunBurstTimer = 0;
                this.sideGunTimer = this.phase === BOSS_PHASE.ATTACK2 ? 1.0 : 1.8;
            }

            if (this.multishotTimer <= 0 && this.multishotBurstQueue <= 0 && ehState !== EH_STATE.DRIFT) {
                this.multishotBurstQueue = this.phase === BOSS_PHASE.ATTACK2 ? 4 : 3;
                this.multishotBurstTimer = 0;
                this.multishotTimer = this.phase === BOSS_PHASE.ATTACK2 ? 2.2 : 3.0;
            }

            if (this.mineTimer <= 0 && ehState !== EH_STATE.DRIFT) {
                this._layMineCluster(player);
                this.mineTimer = this.phase === BOSS_PHASE.ATTACK2 ? 3.5 : 5.0;
            }
        }
    }

    // Override base update to support custom movement
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

        // Super boost if way too far
        if (dist > 1800 && !this._customMovement) {
            const boostMult = (this.phase === BOSS_PHASE.ATTACK2) ? 8 : 4;
            const effectiveSpeed = this.baseSpeed * boostMult;
            this.targetAngle = angleToPlayer;

            let diff = this.targetAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);

            this.vx = Math.cos(this.angle) * effectiveSpeed;
            this.vy = Math.sin(this.angle) * effectiveSpeed;
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            this._updateAI(dt, player, dist, angleToPlayer);
            this._updateBeams(dt);

            // Check Phase Transition
            if (this.phase === BOSS_PHASE.ATTACK1 && this.health < this.maxHealth * 0.4) {
                this.phase = BOSS_PHASE.ATTACK2;
                this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });
                this.game.camera.shake(2.0);
            }
            return;
        }

        this._updateAI(dt, player, dist, angleToPlayer);

        // Custom movement states handle their own physics
        if (!this._customMovement) {
            let diff = this.targetAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);

            this.vx = Math.cos(this.angle) * this.baseSpeed;
            this.vy = Math.sin(this.angle) * this.baseSpeed;

            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;
        }

        this._updateBeams(dt);

        // Check Phase Transition
        if (this.phase === BOSS_PHASE.ATTACK1 && this.health < this.maxHealth * 0.4) {
            this.phase = BOSS_PHASE.ATTACK2;
            this.game.sounds.play('ship_explode', { volume: 1.0, x: this.worldX, y: this.worldY });
            this.game.camera.shake(2.0);
        }
    }

    // ─── ACTION SELECTION ──────────────────────────────────────────────

    _selectNextAction(player, dist, angleToPlayer) {
        const roll = Math.random();
        const distMult = this._getDistanceMult();

        if (this.phase === BOSS_PHASE.ATTACK2) {
            // Phase 2: more varied and aggressive
            if (roll < 0.30) {
                this._startStrafe(player, dist, angleToPlayer);
            } else if (roll < 0.50) {
                this._startArcDash(player, angleToPlayer);
            } else if (roll < 0.70) {
                this._startDrift(player, dist, angleToPlayer);
            } else if (roll < 0.85) {
                this._startBluff(player, angleToPlayer);
            } else {
                // Quick reposition then back
                this.state = BOSS_STATE.REPOSITION;
                this.stateTimer = 0.8 + Math.random() * 0.4;
                const side = Math.random() > 0.5 ? 1 : -1;
                this.targetAngle = angleToPlayer + (Math.PI * 0.5) * side;
                this._customMovement = false;
            }
        } else {
            // Phase 1: mostly active, always doing something
            if (roll < 0.45) {
                this._startStrafe(player, dist, angleToPlayer);
            } else if (roll < 0.75) {
                this._startArcDash(player, angleToPlayer);
            } else if (roll < 0.90) {
                // Quick reposition into attack position
                this.state = BOSS_STATE.REPOSITION;
                this.stateTimer = 0.6 + Math.random() * 0.3;
                const side = Math.random() > 0.5 ? 1 : -1;
                this.targetAngle = angleToPlayer + (Math.PI * 0.35) * side;
                this._customMovement = false;
                this.baseSpeed = 900;
            } else {
                // Very brief aim
                this.state = BOSS_STATE.IDLE;
                this.stateTimer = 0.3 + Math.random() * 0.3;
                this._customMovement = false;
            }
        }
    }

    // ─── STRAFE: Fly alongside player, firing side guns ────────────────

    _startStrafe(player, dist, angleToPlayer) {
        this.state = EH_STATE.STRAFE;
        this._customMovement = true;
        this.strafeSide = -this.strafeSide; // Alternate sides
        this.stateTimer = 1.2 + Math.random() * 0.6;
        this.strafeRepositionTimer = 0;

        // Pick a point alongside the player
        this._updateStrafeTarget(player, angleToPlayer);
    }

    _updateStrafeTarget(player, angleToPlayer) {
        // Position to the side of the player, slightly ahead of their travel direction
        const playerHeading = Math.atan2(player.vy || 0, player.vx || 0);
        const playerSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);

        // Offset perpendicular to player's travel direction
        const sideAngle = playerHeading + (Math.PI / 2) * this.strafeSide;
        const desiredDist = 400 + Math.random() * 100;

        // Lead slightly ahead
        const leadDist = Math.min(playerSpeed * 0.3, 200);

        this.strafeTarget.x = player.worldX + Math.cos(sideAngle) * desiredDist + Math.cos(playerHeading) * leadDist;
        this.strafeTarget.y = player.worldY + Math.sin(sideAngle) * desiredDist + Math.sin(playerHeading) * leadDist;
    }

    _updateStrafe(dt, player, dist, angleToPlayer) {
        // Continuously update strafe target to follow player movement
        this.strafeRepositionTimer -= dt;
        if (this.strafeRepositionTimer <= 0) {
            this._updateStrafeTarget(player, angleToPlayer);
            this.strafeRepositionTimer = 0.3;
        }

        // Fly toward strafe target
        const dx = this.strafeTarget.x - this.worldX;
        const dy = this.strafeTarget.y - this.worldY;
        const distToTarget = Math.sqrt(dx * dx + dy * dy);
        const angleToTarget = Math.atan2(dy, dx);

        // Turn toward target position
        let diff = angleToTarget - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);

        // Speed modulation: fast approach, cruise when close to target
        const speed = distToTarget > 200 ? this.baseSpeed * 1.3 : this.baseSpeed * 0.9;

        this.vx = Math.cos(this.angle) * speed;
        this.vy = Math.sin(this.angle) * speed;
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        if (this.stateTimer <= 0) {
            this._customMovement = false;
            this._selectNextAction(player, dist, angleToPlayer);
        }
    }

    // ─── ARC DASH: High-speed arc in front of player, laying mines ─────

    _startArcDash(player, angleToPlayer) {
        this.state = EH_STATE.ARC_DASH;
        this._customMovement = true;

        // Pick arc direction
        this.arcDashDir = Math.random() > 0.5 ? 1 : -1;

        // Arc center is offset from the player
        const arcOffset = 350 + Math.random() * 100;
        const centerAngle = angleToPlayer + (Math.PI * 0.3) * this.arcDashDir;

        // The arc sweeps around a point near the player
        this.arcDashCenter.x = player.worldX + Math.cos(centerAngle) * arcOffset * 0.3;
        this.arcDashCenter.y = player.worldY + Math.sin(centerAngle) * arcOffset * 0.3;

        // Start angle is from arc center to current position
        const dxStart = this.worldX - this.arcDashCenter.x;
        const dyStart = this.worldY - this.arcDashCenter.y;
        this.arcDashAngle = Math.atan2(dyStart, dxStart);
        this.arcDashRadius = Math.sqrt(dxStart * dxStart + dyStart * dyStart);

        // Clamp radius to something reasonable
        this.arcDashRadius = Math.max(350, Math.min(600, this.arcDashRadius));

        this.arcDashSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 2200 : 1700;
        this.stateTimer = this.phase === BOSS_PHASE.ATTACK2 ? 1.0 : 1.2;
        this.minesLaidThisDash = 0;
        this.dashMineTimer = 0;

        this.game.sounds.play('boost', { volume: 0.9, x: this.worldX, y: this.worldY });
    }

    _updateArcDash(dt, player, dist, angleToPlayer) {
        // Sweep the arc angle
        const angularSpeed = this.arcDashSpeed / this.arcDashRadius;
        this.arcDashAngle += angularSpeed * dt * this.arcDashDir;

        // Move the arc center with the player (so we don't fly off if player moves)
        const playerHeading = Math.atan2(player.vy || 0, player.vx || 0);
        const playerSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);
        this.arcDashCenter.x += (player.vx || 0) * dt * 0.5;
        this.arcDashCenter.y += (player.vy || 0) * dt * 0.5;

        // Calculate position on arc
        const targetX = this.arcDashCenter.x + Math.cos(this.arcDashAngle) * this.arcDashRadius;
        const targetY = this.arcDashCenter.y + Math.sin(this.arcDashAngle) * this.arcDashRadius;

        // Move toward arc position
        const dx = targetX - this.worldX;
        const dy = targetY - this.worldY;
        const distToArc = Math.sqrt(dx * dx + dy * dy);

        // Face movement direction (tangent to arc)
        const tangentAngle = this.arcDashAngle + (Math.PI / 2) * this.arcDashDir;
        let diff = tangentAngle - this.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        this.angle += Math.sign(diff) * Math.min(Math.abs(diff), 12.0 * dt);

        // Move along arc with correction toward the arc path
        const tangentVx = Math.cos(tangentAngle) * this.arcDashSpeed;
        const tangentVy = Math.sin(tangentAngle) * this.arcDashSpeed;

        // Add correction toward the arc if we've drifted
        const correctionStrength = 3.0;
        this.vx = tangentVx + (dx * correctionStrength);
        this.vy = tangentVy + (dy * correctionStrength);

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Lay mines during the dash
        this.dashMineTimer -= dt;
        const maxMines = this.phase === BOSS_PHASE.ATTACK2 ? 5 : 3;
        if (this.dashMineTimer <= 0 && this.minesLaidThisDash < maxMines) {
            this._layMine(this.worldX, this.worldY, this.vx * 0.1, this.vy * 0.1);
            this.minesLaidThisDash++;
            this.dashMineTimer = 0.2;
        }

        if (this.stateTimer <= 0) {
            this._customMovement = false;
            this.baseSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 1150 : 900;
            this._selectNextAction(player, dist, angleToPlayer);
        }
    }

    // ─── DRIFT: Phase 2 only - cut power, spin, and fire ──────────────

    _startDrift(_player, dist, angleToPlayer) {
        this.state = EH_STATE.DRIFT;
        this._customMovement = true;
        this.stateTimer = 2.0 + Math.random() * 1.0;

        // Inherit current velocity as drift velocity
        this.driftVx = this.vx * 1.2;
        this.driftVy = this.vy * 1.2;

        // Add a kick perpendicular to the player
        const perpAngle = angleToPlayer + (Math.PI / 2) * (Math.random() > 0.5 ? 1 : -1);
        this.driftVx += Math.cos(perpAngle) * 400;
        this.driftVy += Math.sin(perpAngle) * 400;

        // Spin direction
        this.driftSpinSpeed = (4.0 + Math.random() * 3.0) * (Math.random() > 0.5 ? 1 : -1);

        this.game.sounds.play('boost', { volume: 0.6, x: this.worldX, y: this.worldY });
    }

    _updateDrift(dt, player, dist, angleToPlayer) {
        // Apply friction (sliding in space)
        const friction = Math.pow(this.driftFriction, dt * 60);
        this.driftVx *= friction;
        this.driftVy *= friction;

        // Gentle pull toward maintaining ~450 distance from player
        const desiredDist = 450;
        const distError = dist - desiredDist;
        const pullStrength = 80;
        this.driftVx += Math.cos(angleToPlayer) * (distError > 0 ? pullStrength : -pullStrength * 0.5) * dt;
        this.driftVy += Math.sin(angleToPlayer) * (distError > 0 ? pullStrength : -pullStrength * 0.5) * dt;

        // Spin the ship
        this.angle += this.driftSpinSpeed * dt;

        // Apply drift velocity
        this.vx = this.driftVx;
        this.vy = this.driftVy;
        this.worldX += this.driftVx * dt;
        this.worldY += this.driftVy * dt;

        // Fire side guns while spinning - the spin makes them sweep around
        this.sideGunTimer -= dt;
        if (this.sideGunTimer <= 0) {
            // Fire from both sides
            this._fireDriftShot(player, 1);
            this._fireDriftShot(player, -1);
            this.sideGunTimer = 0.15;
        }

        if (this.stateTimer <= 0 || dist > 900) {
            this._customMovement = false;
            this.baseSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 1150 : 900;
            this._selectNextAction(player, dist, angleToPlayer);
        }
    }

    // ─── BLUFF CHARGE: Fly at player, then curve away laying mines ────

    _startBluff(player, angleToPlayer) {
        this.state = EH_STATE.BLUFF;
        this._customMovement = true;
        this.stateTimer = 1.5;
        this.bluffPhase = 'approach';
        this.bluffCurveDir = Math.random() > 0.5 ? 1 : -1;

        // Aim slightly to the side of the player
        this.targetAngle = angleToPlayer;
        this.baseSpeed = 2000;

        this.game.sounds.play('boost', { volume: 1.0, x: this.worldX, y: this.worldY });
    }

    _updateBluff(dt, player, dist, angleToPlayer) {
        if (this.bluffPhase === 'approach') {
            // Fly toward player
            let diff = angleToPlayer - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), this.turnSpeed * dt);

            this.vx = Math.cos(this.angle) * this.baseSpeed;
            this.vy = Math.sin(this.angle) * this.baseSpeed;
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            // When close enough, curve away
            if (dist < 500) {
                this.bluffPhase = 'curve';
                this.stateTimer = 1.0;

                // Predict where the player is heading and lay mines there
                const playerHeading = Math.atan2(player.vy || 0, player.vx || 0);
                const playerSpeed = Math.sqrt((player.vx || 0) ** 2 + (player.vy || 0) ** 2);
                const leadTime = 0.8;
                const mineX = player.worldX + Math.cos(playerHeading) * playerSpeed * leadTime;
                const mineY = player.worldY + Math.sin(playerHeading) * playerSpeed * leadTime;

                // Lay a cluster of mines where the player is heading
                for (let i = 0; i < 3; i++) {
                    this._layMine(mineX, mineY, this.vx * 0.15, this.vy * 0.15);
                }
            }
        } else {
            // Curve away from the player
            const curveAngle = angleToPlayer + Math.PI + (Math.PI * 0.4) * this.bluffCurveDir;
            let diff = curveAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += Math.sign(diff) * Math.min(Math.abs(diff), 10.0 * dt);

            this.vx = Math.cos(this.angle) * this.baseSpeed;
            this.vy = Math.sin(this.angle) * this.baseSpeed;
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;

            // Decelerate during curve
            this.baseSpeed = Math.max(800, this.baseSpeed - 800 * dt);
        }

        if (this.stateTimer <= 0) {
            this._customMovement = false;
            this.baseSpeed = this.phase === BOSS_PHASE.ATTACK2 ? 1150 : 900;
            this._selectNextAction(player, dist, angleToPlayer);
        }
    }

    // ─── ATTACKS ───────────────────────────────────────────────────────

    _fireSideGunShot(player) {
        // Side-mounted guns with loose predictive aim
        const predAngle = this._getPredictedAngle(player, 900);

        for (const side of [1, -1]) {
            const offsetX = -10;
            const offsetY = 55 * side;
            const px = this.worldX + offsetX * Math.cos(this.angle) - offsetY * Math.sin(this.angle);
            const py = this.worldY + offsetX * Math.sin(this.angle) + offsetY * Math.cos(this.angle);

            // Base fire direction is perpendicular, aim-corrected toward player
            const sideAngle = this.angle + (Math.PI / 2) * side;
            let aimDiff = predAngle - sideAngle;
            while (aimDiff > Math.PI) aimDiff -= Math.PI * 2;
            while (aimDiff < -Math.PI) aimDiff += Math.PI * 2;

            // ~45 degree aim cone - can swivel but not snipe
            const maxAimCorrection = 0.8;
            const aimCorrection = Math.sign(aimDiff) * Math.min(Math.abs(aimDiff), maxAimCorrection);
            const fireAngle = sideAngle + aimCorrection + (Math.random() - 0.5) * 0.15;

            const proj = new Projectile(
                this.game, px, py,
                fireAngle,
                900, 'red_laser_ball', this, 4.5 * this.curvedDifficultyScale
            );
            this.pendingProjectiles.push(proj);
        }
        this.game.sounds.play('laser', { volume: 0.25, x: this.worldX, y: this.worldY });
    }

    _fireDriftShot(player, side) {
        // During drift, fire from side - less accurate but dangerous
        const offsetX = -10;
        const offsetY = 55 * side;
        const px = this.worldX + offsetX * Math.cos(this.angle) - offsetY * Math.sin(this.angle);
        const py = this.worldY + offsetX * Math.sin(this.angle) + offsetY * Math.cos(this.angle);

        const sideAngle = this.angle + (Math.PI / 2) * side;
        const spread = 0.15;
        const fireAngle = sideAngle + (Math.random() - 0.5) * spread;

        const proj = new Projectile(
            this.game, px, py,
            fireAngle,
            750, 'red_laser_ball', this, 3.5 * this.curvedDifficultyScale
        );
        this.pendingProjectiles.push(proj);
        this.game.sounds.play('laser', { volume: 0.15, x: this.worldX, y: this.worldY });
    }

    _fireMultishot(player) {
        // Aimed spread shot - fires toward predicted player position from the front of the ship
        const predAngle = this._getPredictedAngle(player, 1200);

        // Only skip if the player is nearly directly behind the ship
        let angleDiff = predAngle - this.angle;
        while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
        while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;
        if (Math.abs(angleDiff) > 1.2) return;

        const count = this.phase === BOSS_PHASE.ATTACK2 ? 5 : 3;
        const spreadTotal = this.phase === BOSS_PHASE.ATTACK2 ? 0.45 : 0.3;

        // Fire from front of ship but aimed at the player
        const px = this.worldX + Math.cos(this.angle) * 60;
        const py = this.worldY + Math.sin(this.angle) * 60;

        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0 : (i / (count - 1)) - 0.5;
            const fireAngle = predAngle + t * spreadTotal;

            const proj = new Projectile(
                this.game, px, py,
                fireAngle,
                1200, 'red_laser_ball', this, 5.0 * this.curvedDifficultyScale
            );
            this.pendingProjectiles.push(proj);
        }
        this.game.sounds.play('laser', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    // ─── MINES ─────────────────────────────────────────────────────────

    _layMine(x, y, kickVx, kickVy) {
        // Mines are big laser balls that spread out then slow to a stop
        const scatterAngle = Math.random() * Math.PI * 2;
        const scatterSpeed = 60 + Math.random() * 80;
        const baseVx = (kickVx || 0) + Math.cos(scatterAngle) * scatterSpeed;
        const baseVy = (kickVy || 0) + Math.sin(scatterAngle) * scatterSpeed;

        const proj = new Projectile(
            this.game, x, y,
            Math.atan2(baseVy, baseVx),
            Math.sqrt(baseVx * baseVx + baseVy * baseVy),
            'red_laser_ball_big',
            this,
            16.0 * this.curvedDifficultyScale,
            this.phase === BOSS_PHASE.ATTACK2 ? 6.0 : 5.0
        );
        proj.isMine = true;
        this.pendingProjectiles.push(proj);
        this.activeMines.push(proj);
    }

    _layMineCluster() {
        // Lay a cluster of mines that scatter outward from the ship
        const count = this.phase === BOSS_PHASE.ATTACK2 ? 5 : 3;

        // Eject behind the ship with spread
        const behindAngle = this.angle + Math.PI;
        const kickSpeed = 100 + Math.random() * 60;

        for (let i = 0; i < count; i++) {
            const spreadAngle = behindAngle + ((i - (count - 1) / 2) / count) * 1.2;
            const kickVx = Math.cos(spreadAngle) * kickSpeed + this.vx * 0.3;
            const kickVy = Math.sin(spreadAngle) * kickSpeed + this.vy * 0.3;

            const mx = this.worldX + Math.cos(behindAngle) * 40;
            const my = this.worldY + Math.sin(behindAngle) * 40;

            this._layMine(mx, my, kickVx, kickVy);
        }
        this.game.sounds.play('railgun_shoot', { volume: 0.4, x: this.worldX, y: this.worldY });
    }

    // ─── PREDICTIVE TARGETING ──────────────────────────────────────────

    _getPredictedAngle(player, projSpeed) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const distSq = dx * dx + dy * dy;

        const pVx = player.vx || 0;
        const pVy = player.vy || 0;

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

        const targetX = player.worldX + pVx * t;
        const targetY = player.worldY + pVy * t;
        return Math.atan2(targetY - this.worldY, targetX - this.worldX);
    }

    // ─── DRAWING ───────────────────────────────────────────────────────

    drawUnder(ctx, camera) {
        // Draw mine glow indicators
        for (const mine of this.activeMines) {
            if (!mine.alive) continue;
            const screen = camera.worldToScreen(mine.worldX, mine.worldY, this.game.width, this.game.height);

            // Pulsing danger glow around mines
            const pulse = 0.4 + 0.6 * (Math.sin(Date.now() / 150) * 0.5 + 0.5);
            const radius = 35 * this.game.worldScale * pulse;

            ctx.save();
            ctx.globalAlpha = 0.3 * pulse;
            ctx.fillStyle = '#ff2200';
            ctx.shadowBlur = 15 * this.game.worldScale;
            ctx.shadowColor = '#ff2200';
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }

        // Draw engine trail effect during dashes
        if (this.state === EH_STATE.ARC_DASH || this.state === EH_STATE.BLUFF) {
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const trailAngle = this.angle + Math.PI; // Behind the ship

            ctx.save();
            ctx.globalAlpha = 0.4;
            ctx.strokeStyle = '#ff6600';
            ctx.lineWidth = 3 * this.game.worldScale;
            ctx.shadowBlur = 10 * this.game.worldScale;
            ctx.shadowColor = '#ff4400';
            ctx.beginPath();
            const trailLen = 80 * this.game.worldScale;
            ctx.moveTo(screen.x, screen.y);
            ctx.lineTo(
                screen.x + Math.cos(trailAngle) * trailLen,
                screen.y + Math.sin(trailAngle) * trailLen
            );
            ctx.stroke();
            ctx.restore();
        }

        // Draw drift sparks/trails
        if (this.state === EH_STATE.DRIFT) {
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            ctx.save();
            ctx.globalAlpha = 0.3;

            // Scattered spark dots around the ship
            for (let i = 0; i < 3; i++) {
                const sparkAngle = this.angle + (Math.PI * 2 / 3) * i + Date.now() / 200;
                const sparkDist = (25 + Math.random() * 20) * this.game.worldScale;
                const sx = screen.x + Math.cos(sparkAngle) * sparkDist;
                const sy = screen.y + Math.sin(sparkAngle) * sparkDist;

                ctx.fillStyle = Math.random() > 0.5 ? '#ff4400' : '#ffaa00';
                ctx.fillRect(sx - 1, sy - 1, 2 * this.game.worldScale, 2 * this.game.worldScale);
            }
            ctx.restore();
        }
    }

    draw(ctx, camera) {
        super.draw(ctx, camera);
    }
}
