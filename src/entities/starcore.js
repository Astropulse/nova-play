import { Projectile } from './projectile.js';
import { Scrap, Rubble, ItemPickup } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { Boss, BOSS_PHASE, BOSS_STATE } from './boss.js';

export class Starcore extends Boss {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);
        this.spriteKey = 'starcore';
        this.radius = 120;
        this.health = 300 + 50 * this.difficultyScale;
        this.maxHealth = this.health;

        this.shootTimer = 2.0;
        this.missileTimer = 5.0;
        this.beamTimer = 8.0;

        // Base cruising speed follows the user's specification
        this.baseSpeed = 600;
        this.turnSpeed = 6.0;
        this.attackRange = 1000;

        // Attack state
        this.isChargingBeam = false;
        this.chargeTimer = 0;

        this.gunBurstQueue = 0;
        this.gunBurstTimer = 0;
        this.musicKey = 'Starcore Showdown';

        this._lastPhase = this.phase;
    }

    _updateAI(dt, player, dist, angleToPlayer) {
        this.stateTimer -= dt;

        // Phase 2 Transition Logic - Immediate Dash
        if (this.phase !== this._lastPhase) {
            if (this.phase === BOSS_PHASE.ATTACK2) {
                this.state = BOSS_STATE.DASH;
                this.stateTimer = 1.2;
                this.baseSpeed = 2000; // Specified charge speed
                this.turnSpeed = 9.0;
                this.targetAngle = angleToPlayer;
                this.game.sounds.play('boost', { volume: 1.2, x: this.worldX, y: this.worldY });
            }
            this._lastPhase = this.phase;
        }

        // Active beam tracking & damage
        for (let i = this.activeBeams.length - 1; i >= 0; i--) {
            const b = this.activeBeams[i];
            b.timer -= dt;
            if (b.timer <= 0) {
                this.activeBeams.splice(i, 1);
            } else {
                // Track player while firing (deadly)
                let diff = angleToPlayer - b.angle;
                while (diff > Math.PI) diff -= Math.PI * 2;
                while (diff < -Math.PI) diff += Math.PI * 2;
                b.angle += diff * Math.min(1, 2.0 * dt);

                // Keep beam snapped to ship
                const px = this.worldX + Math.cos(this.angle) * 80;
                const py = this.worldY + Math.sin(this.angle) * 80;
                b.x = px;
                b.y = py;

                // Hit detection
                const dx = player.worldX - b.x;
                const dy = player.worldY - b.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < 36000000) { // 6000 range
                    const d = Math.sqrt(distSq);
                    const dirX = Math.cos(b.angle);
                    const dirY = Math.sin(b.angle);
                    const dot = (dx * dirX + dy * dirY) / d;
                    if (dot > 0.99) {
                        const cross = Math.abs(dx * dirY - dy * dirX);
                        if (cross < (player.radius + 30)) {
                            this.game.currentState._damagePlayer(50.0 * dt * this.curvedDifficultyScale);
                        }
                    }
                }
            }
        }

        // Only fire guns and progress burst if within attack range
        if (this.gunBurstQueue > 0 && dist < this.attackRange) {
            // Predicitive target for the turn logic
            const predAimAngle = this._getPredictedAngle(player, 1200);
            let angleDiff = predAimAngle - this.angle;
            while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
            while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

            // Only progress burst timer if reasonably facing the target
            if (Math.abs(angleDiff) < 0.4) {
                this.gunBurstTimer -= dt;
                if (this.gunBurstTimer <= 0) {
                    this.gunBurstQueue--;
                    this.gunBurstTimer = 0.08;

                    const offsets = [{ x: 40, y: 60 }, { x: 40, y: -60 }];
                    offsets.forEach(off => {
                        const px = this.worldX + off.x * Math.cos(this.angle) - off.y * Math.sin(this.angle);
                        const py = this.worldY + off.x * Math.sin(this.angle) + off.y * Math.cos(this.angle);
                        const spread = 0.05;
                        // Fire FORWARDS from the ship's current angle
                        const proj = new Projectile(
                            this.game, px, py,
                            this.angle + (Math.random() - 0.5) * spread,
                            1200, 'red_laser_ball', this, 5.0 * this.curvedDifficultyScale
                        );
                        this.pendingProjectiles.push(proj);
                    });
                    this.game.sounds.play('laser', { volume: 0.3, x: this.worldX, y: this.worldY });
                }
            }
        }

        // Phase 1 Avoidance: Force reposition if too close to player to avoid ramming
        if (this.phase === BOSS_PHASE.ATTACK1 && dist < 400 && this.state !== BOSS_STATE.REPOSITION) {
            this.state = BOSS_STATE.REPOSITION;
            this.stateTimer = 1.0;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + (Math.PI * 0.5) * side;
            this.baseSpeed = 600;
        }

        if (this.state === BOSS_STATE.IDLE) {
            // Predictive aiming while idle
            this.targetAngle = this._getPredictedAngle(player, 1200);
            if (this.stateTimer <= 0) {
                this._selectNextAction(dist, angleToPlayer);
            }
        } else if (this.state === BOSS_STATE.REPOSITION) {
            if (this.stateTimer <= 0) {
                this.state = BOSS_STATE.IDLE;
                this.stateTimer = 1.0;
            }
        } else if (this.state === BOSS_STATE.DASH) {
            if (this.stateTimer <= 0) {
                this.state = BOSS_STATE.IDLE;
                this.stateTimer = 0.5;
                // Return to phase-specific cruising speed
                this.baseSpeed = (this.phase === BOSS_PHASE.ATTACK2) ? 800 : 600;
            }
        }

        // Combat Timers - Only decrement if within range
        if (this.state !== BOSS_STATE.DASH && dist < this.attackRange) {
            this.shootTimer -= dt;
            this.missileTimer -= dt;
            this.beamTimer -= dt;

            if (this.shootTimer <= 0 && !this.isChargingBeam) {
                this._attackGuns(angleToPlayer);
                this.shootTimer = (this.phase === BOSS_PHASE.ATTACK2) ? 1.0 : 2.0;
            }

            if (this.missileTimer <= 0 && !this.isChargingBeam) {
                this._attackMissiles(player);
                this.missileTimer = (this.phase === BOSS_PHASE.ATTACK2) ? 3.5 : 6.0;
            }

            if (this.beamTimer <= 0 && !this.isChargingBeam) {
                this._startBeamCharge();
            }
        }

        if (this.isChargingBeam) {
            this._updateBeamCharge(dt, angleToPlayer);
        }
    }

    _selectNextAction(dist, angleToPlayer) {
        const roll = Math.random();

        if (this.phase === BOSS_PHASE.ATTACK2 && roll < 0.45) {
            // Ramming attack
            this.state = BOSS_STATE.DASH;
            this.stateTimer = 1.2;
            this.baseSpeed = 2000; // Specified charge speed
            this.targetAngle = angleToPlayer;
            this.game.sounds.play('boost', { volume: 1.2, x: this.worldX, y: this.worldY });
        } else if (roll < 0.7 || dist < 700) {
            // Reposition aggressively but not "charging" speed
            this.state = BOSS_STATE.REPOSITION;
            this.stateTimer = 1.0;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + (Math.PI * 0.4) * side;
            this.baseSpeed = (this.phase === BOSS_PHASE.ATTACK2) ? 800 : 600;
        } else {
            this.state = BOSS_STATE.IDLE;
            this.stateTimer = 0.3;
            this.baseSpeed = (this.phase === BOSS_PHASE.ATTACK2) ? 800 : 600;
        }
    }

    _attackGuns(angleToPlayer) {
        this.gunBurstQueue = this.phase === BOSS_PHASE.ATTACK2 ? 10 : 6;
        this.gunBurstTimer = 0;
    }

    _attackMissiles(player) {
        const count = this.phase === BOSS_PHASE.ATTACK2 ? 4 : 2;
        for (let i = 0; i < count; i++) {
            const side = i % 2 === 0 ? 1 : -1;
            const angle = this.angle + Math.PI * 0.7 * side;
            const px = this.worldX + Math.cos(angle) * 50;
            const py = this.worldY + Math.sin(angle) * 50;

            const proj = new Projectile(
                this.game, px, py, angle, 600, 'red_laser_ball_big', this, 10.0 * this.curvedDifficultyScale, 12.0
            );
            proj.isRocket = true;
            proj.target = player;
            proj.turnRate = 2.0;
            this.pendingProjectiles.push(proj);
        }
        this.game.sounds.play('railgun_shoot', { volume: 0.5, x: this.worldX, y: this.worldY });
    }

    _startBeamCharge() {
        this.isChargingBeam = true;
        this.chargeTimer = 1.5; // Faster charge
        this.game.sounds.play('railgun_target', { volume: 0.8, x: this.worldX, y: this.worldY });

        if (this.phase === BOSS_PHASE.ATTACK2 && Math.random() < 0.35) {
            this.isFakeout = true;
        } else {
            this.isFakeout = false;
        }
    }

    _updateBeamCharge(dt, angleToPlayer) {
        this.chargeTimer -= dt;

        // Track player closely during charge
        this.targetAngle = angleToPlayer;
        this.turnSpeed = 6.0;

        if (this.chargeTimer <= 0) {
            this.isChargingBeam = false;
            this.turnSpeed = 5.0; // Back to base
            this.beamTimer = 8.0;

            if (this.isFakeout) {
                this._attackGuns(angleToPlayer);
            } else {
                this._fireMegaBeam();
            }
        }
    }

    _getPredictedAngle(player, projSpeed) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const distSq = dx * dx + dy * dy;

        const pVx = player.vx || 0;
        const pVy = player.vy || 0;

        // Simple predictive lead
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

    _fireMegaBeam() {
        const px = this.worldX + Math.cos(this.angle) * 80;
        const py = this.worldY + Math.sin(this.angle) * 80;

        this.activeBeams.push({
            x: px,
            y: py,
            angle: this.angle,
            timer: 1.0 // Longer beam duration
        });

        this.game.sounds.play('railgun_shoot', { volume: 1.0, x: px, y: py });
        this.game.camera.shake(1.8);
    }

    draw(ctx, camera) {
        super.draw(ctx, camera);

        // Draw active beams
        const beamImg = this.game.assets.get('red_laser_beam_big');
        for (const b of this.activeBeams) {
            const screen = camera.worldToScreen(b.x, b.y, this.game.width, this.game.height);
            this._drawTiledBeam(ctx, screen.x, screen.y, b.angle, beamImg, b.timer / 0.3, 6000);
        }

        // Draw charge indicator
        if (this.isChargingBeam) {
            const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const px = screen.x + Math.cos(this.angle) * 80 * this.game.worldScale;
            const py = screen.y + Math.sin(this.angle) * 80 * this.game.worldScale;

            const targetImg = this.game.assets.get('red_laser_beam_targeting');
            const alpha = 0.4 + 0.6 * (Math.sin(Date.now() / 30) * 0.5 + 0.5);
            this._drawTiledBeam(ctx, px, py, this.angle, targetImg, alpha, 6000);
        }
    }
}
