import { Projectile } from './projectile.js';
import { Boss, BOSS_PHASE, BOSS_STATE } from './boss.js';

export class AsteroidCrusher extends Boss {
    constructor(game, worldX, worldY, difficultyScale = 1.0) {
        super(game, worldX, worldY, difficultyScale);
        this.spriteKey = 'asteroid_crusher';
        this.radius = 120;
        this.health = 400 + 50 * this.difficultyScale;
        this.maxHealth = this.health;

        this.baseSpeed = 400; // Slow moving tank
        this.turnSpeed = 7.0;
        this.attackRange = 800;

        this.missileTimer = 4.0;
        this.laserTimer = 2.5;
        this.tractorTimer = 6.0;

        this.tractoredAsteroid = null;
        this.tractorState = 'idle'; // idle, pulling, holding, launching
        this.tractorProgress = 0;

        // Missile Volley System
        this.missileVolleyQueue = 0;
        this.missileVolleyTimer = 0;
        this.missileSide = 1;

        // AI States
        this.state = BOSS_STATE.IDLE;
        this.stateTimer = 1.0;

        // Concurrent Launches
        this.launchingAsteroids = [];

        // Track missiles to stop seeking after duration
        this.activeMissiles = [];

        // Phase 2 Shield
        this.shieldAsteroids = [];
        this.shieldRotation = 0;
        this.shieldLaunchTimer = 3.0;
        this.musicKey = 'Asteroid Crusher';

        this._lastPhase = this.phase;
    }

    _updateAI(dt, player, dist, angleToPlayer) {
        this.stateTimer -= dt;

        // Phase 2 Transition
        if (this.phase !== this._lastPhase) {
            if (this.phase === BOSS_PHASE.ATTACK2) {
                this.game.sounds.play('ship_explode', { volume: 1.2, x: this.worldX, y: this.worldY });
                this.game.camera.shake(3.0);

                // Immediate reposition on phase change
                this.state = BOSS_STATE.REPOSITION;
                this.stateTimer = 1.5;
                const side = Math.random() > 0.5 ? 1 : -1;
                this.targetAngle = angleToPlayer + (Math.PI * 0.6) * side;
            }
            this._lastPhase = this.phase;
        }

        // Proximity Avoidance: Phase-dependent (Closer in P1, distant in P2)
        const avoidDist = (this.phase === BOSS_PHASE.ATTACK2) ? 380 : 250;
        if (dist < avoidDist && this.state !== BOSS_STATE.REPOSITION) {
            this.state = BOSS_STATE.REPOSITION;
            this.stateTimer = 1.2;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + (Math.PI * 0.5) * side;
        }

        // State Transitions
        // Dynamic speed based on distance
        if (dist > 2500) {
            this.baseSpeed = 1200; // Aggressive pursuit
            this.tractorTimer = Math.min(this.tractorTimer, 1.0); // Spam throws while closing
        } else {
            this.baseSpeed = 400;
        }

        if (this.state === BOSS_STATE.IDLE) {
            this.targetAngle = this._getPredictedAngle(player, 800) + this._getAvoidanceSteering();
            if (this.stateTimer <= 0) {
                this._selectNextAction(dist, angleToPlayer);
            }
        } else if (this.state === BOSS_STATE.REPOSITION) {
            if (this.stateTimer <= 0) {
                this.state = BOSS_STATE.IDLE;
                this.stateTimer = 2.0;
            }
        }

        // Weapon Timers - Only decrement if within range and not dead/intro
        if (dist < this.attackRange && this.state !== BOSS_STATE.INTRO) {
            this.missileTimer -= dt;
            this.laserTimer -= dt;
            this.tractorTimer -= dt;

            if (this.missileTimer <= 0 && this.missileVolleyQueue <= 0) {
                this._startMissileVolley();
                this.missileTimer = (this.phase === BOSS_PHASE.ATTACK2) ? 2.0 : 4.0;
            }

            if (this.laserTimer <= 0) {
                // Aiming precision check for the big laser
                const angleToPlayer = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                let angleDiff = angleToPlayer - this.angle;
                while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
                while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

                if (Math.abs(angleDiff) < 0.15) {
                    this._fireLasers();
                    this.laserTimer = (this.phase === BOSS_PHASE.ATTACK2) ? 1.0 : 2.0;
                }
            }
        }

        // Handle Concurrent Launches (Tractor & Shield)
        for (let i = this.launchingAsteroids.length - 1; i >= 0; i--) {
            const launch = this.launchingAsteroids[i];
            const ast = launch.asteroid;
            if (!ast || !ast.alive) {
                this.launchingAsteroids.splice(i, 1);
                continue;
            }

            launch.progress += dt;
            const duration = 0.5;
            const t = Math.min(1.0, launch.progress / duration);

            // Self-Hull Obstruction Avoidance (The Swing)
            if (launch.isSwinging && t < 0.4) {
                // Pull to a clear flank position before releasing
                const swingAngle = this.angle + (Math.PI * 0.8) * launch.swingSide;
                const tx = this.worldX + Math.cos(swingAngle) * 450;
                const ty = this.worldY + Math.sin(swingAngle) * 450;

                const sdx = tx - ast.worldX;
                const sdy = ty - ast.worldY;
                const sdist = Math.sqrt(sdx * sdx + sdy * sdy);
                if (sdist > 10) {
                    ast.vx = (sdx / sdist) * 1500;
                    ast.vy = (sdy / sdist) * 1500;
                }

                // Recalculate fire vector once clear
                const pTarget = this._getPredictedTarget(player, launch.maxSpeed || 1800);
                launch.dirX = (pTarget.x - ast.worldX);
                launch.dirY = (pTarget.y - ast.worldY);
                const l = Math.sqrt(launch.dirX ** 2 + launch.dirY ** 2);
                launch.dirX /= l;
                launch.dirY /= l;
                return;
            }

            // Quadratic acceleration: starting with a kick, then picking up massive speed
            const v0 = 200;
            const vMax = (launch.maxSpeed || 1200) * this.curvedDifficultyScale;
            const speed = v0 + (vMax - v0) * (t * t);

            ast.vx = launch.dirX * speed;
            ast.vy = launch.dirY * speed;

            if (t >= 1.0) {
                ast.tractoredBy = null;
                ast.tractorCooldown = 2.0; // Prevent immediate re-tractoring
                this.launchingAsteroids.splice(i, 1);
            }
        }

        // Handle Missile Volley Queue
        if (this.missileVolleyQueue > 0) {
            this.missileVolleyTimer -= dt;
            if (this.missileVolleyTimer <= 0) {
                this._fireSingleMissile(player);
                this.missileVolleyQueue--;
                this.missileVolleyTimer = 0.12;
                this.missileSide *= -1; // Alternate sides
            }
        }

        // Update active missiles (handle seek duration)
        for (let i = this.activeMissiles.length - 1; i >= 0; i--) {
            const m = this.activeMissiles[i];
            m.timer -= dt;
            if (m.timer <= 0 || !m.proj.alive) {
                if (m.proj.alive) m.proj.target = null;
                this.activeMissiles.splice(i, 1);
            }
        }

        // Tractor Beam Logic - Only if within range
        if (dist < this.attackRange) {
            this._updateTractorBeam(dt, player);
        }

        // Phase 2 Shield Logic - Defense remains active if already started
        if (this.phase === BOSS_PHASE.ATTACK2) {
            this._updateShield(dt, player);
        }
    }

    _selectNextAction(dist, angleToPlayer) {
        const roll = Math.random();
        // Reposition at 600 (P2) or 400 (P1)
        const repoThreshold = (this.phase === BOSS_PHASE.ATTACK2) ? 500 : 400;

        if (roll < 0.4 || dist < repoThreshold) {
            // Reposition sideways
            this.state = BOSS_STATE.REPOSITION;
            this.stateTimer = 1.0 + Math.random() * 0.5;
            const side = Math.random() > 0.5 ? 1 : -1;
            this.targetAngle = angleToPlayer + (Math.PI * 0.45) * side;
        } else {
            // Stay idle (pursuit)
            this.state = BOSS_STATE.IDLE;
            this.stateTimer = 1.0 + Math.random() * 1.0;
            this.targetAngle = angleToPlayer;
        }
    }

    _startMissileVolley() {
        this.missileVolleyQueue = this.phase === BOSS_PHASE.ATTACK2 ? 8 : 5;
        this.missileVolleyTimer = 0;
    }

    _fireSingleMissile(player) {
        // Precise alignment based on asset pods at the rear-flank
        const offsetY = 65 * this.missileSide;
        const offsetX = -105;

        const px = this.worldX + offsetX * Math.cos(this.angle) - offsetY * Math.sin(this.angle);
        const py = this.worldY + offsetX * Math.sin(this.angle) + offsetY * Math.cos(this.angle);

        const pTarget = this._getPredictedTarget(player, 550);
        const fireAngle = Math.atan2(pTarget.y - py, pTarget.x - px);

        const proj = new Projectile(
            this.game, px, py, fireAngle,
            550, 'red_laser_ball', this, 3.0 * this.curvedDifficultyScale, 8.0
        );
        proj.isRocket = true;
        proj.target = player;
        proj.turnRate = 2.5;

        this.activeMissiles.push({ proj, timer: 1.2 });
        this.pendingProjectiles.push(proj);
        this.game.sounds.play('laser', { volume: 0.3, x: this.worldX, y: this.worldY });
    }

    _fireLasers() {
        // Fire from front
        const px = this.worldX + Math.cos(this.angle) * 120;
        const py = this.worldY + Math.sin(this.angle) * 120;

        const proj = new Projectile(
            this.game, px, py, this.angle,
            750, 'red_laser_ball_big', this, 15.0 * this.curvedDifficultyScale, 6.0
        );
        this.pendingProjectiles.push(proj);
        this.game.sounds.play('railgun_shoot', { volume: 0.6, x: this.worldX, y: this.worldY });
    }

    _updateTractorBeam(dt, player) {
        if (this.tractorState === 'idle') {
            if (this.tractorTimer <= 0) {
                // Find nearest asteroid
                let nearest = null;
                let minDist = 1200;
                const asteroids = this.game.currentState.asteroids || [];
                for (const ast of asteroids) {
                    if (!ast.alive || ast.tractoredBy || ast.tractorCooldown > 0) continue;
                    const dx = ast.worldX - this.worldX;
                    const dy = ast.worldY - this.worldY;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < minDist) {
                        minDist = d;
                        nearest = ast;
                    }
                }

                if (nearest) {
                    // Kick off launch sequence IMMEDIATELY (direct fling/whip throw)
                    const adx = player.worldX - nearest.worldX;
                    const ady = player.worldY - nearest.worldY;
                    const adist = Math.sqrt(adx * adx + ady * ady);

                    nearest.tractoredBy = this;
                    nearest.highlightRed = true;

                    // Obstruction check: Determine if we need to "swing" the asteroid around the hull
                    const pTarget = this._getPredictedTarget(player, 1800);
                    const sdx = pTarget.x - nearest.worldX;
                    const sdy = pTarget.y - nearest.worldY;
                    const sdist = Math.sqrt(sdx * sdx + sdy * sdy);

                    // Simple circle-line intersection check for the boss hull
                    const dot = ((this.worldX - nearest.worldX) * (sdx / sdist) + (this.worldY - nearest.worldY) * (sdy / sdist));
                    const closestX = nearest.worldX + (sdx / sdist) * dot;
                    const closestY = nearest.worldY + (sdy / sdist) * dot;
                    const distToHull = Math.sqrt((closestX - this.worldX) ** 2 + (closestY - this.worldY) ** 2);

                    const isObstructed = dot > 0 && dot < sdist && distToHull < this.radius + 60;

                    this.launchingAsteroids.push({
                        asteroid: nearest,
                        progress: 0,
                        dirX: sdx / sdist,
                        dirY: sdy / sdist,
                        maxSpeed: 1500, // Slower for remote throws (reduced warning)
                        isSwinging: isObstructed,
                        swingSide: (Math.random() > 0.5 ? 1 : -1)
                    });

                    this.game.sounds.play('boost', { volume: 0.8, x: this.worldX, y: this.worldY });
                    this.game.camera.shake(1.0);

                    this.tractorState = 'idle';
                    this.tractorTimer = (this.phase === BOSS_PHASE.ATTACK2) ? 1.5 : 3.0;
                } else {
                    this.tractorTimer = 1.0; // Retry soon
                }
            }
        }
    }

    _updateShield(dt, player) {
        // Shield logic only executes in Phase 2
        if (this.phase !== BOSS_PHASE.ATTACK2) return;

        // Maintain shield
        const asteroids = this.game.currentState.asteroids || [];
        this.shieldAsteroids = this.shieldAsteroids.filter(ast => ast.alive);

        if (this.shieldAsteroids.length < 12) {
            // Find nearby asteroids to add to shield - Large 1200 range to find enough debris
            for (const ast of asteroids) {
                if (!ast.alive || ast.tractoredBy || ast.tractorCooldown > 0 || this.shieldAsteroids.includes(ast) || ast === this.tractoredAsteroid) continue;
                const dx = ast.worldX - this.worldX;
                const dy = ast.worldY - this.worldY;
                const d = Math.sqrt(dx * dx + dy * dy);
                if (d < 1200) {
                    ast.tractoredBy = this;
                    ast.highlightRed = true;
                    this.shieldAsteroids.push(ast);
                    if (this.shieldAsteroids.length >= 12) break;
                }
            }
        }

        // Rotate shield
        this.shieldRotation += dt * 1.5;
        this.shieldAsteroids.forEach((ast, i) => {
            const angle = this.shieldRotation + (i / this.shieldAsteroids.length) * Math.PI * 2;
            const orbitDist = 320; // More compact defensive ring
            const tx = this.worldX + Math.cos(angle) * orbitDist;
            const ty = this.worldY + Math.sin(angle) * orbitDist;

            // Smovely pull to orbit
            const dx = tx - ast.worldX;
            const dy = ty - ast.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 10) {
                const s = 600;
                ast.vx = (dx / dist) * s;
                ast.vy = (dy / dist) * s;
            } else {
                ast.worldX = tx;
                ast.worldY = ty;
                ast.vx = 0;
                ast.vy = 0;
            }
        });

        // Launch from shield
        this.shieldLaunchTimer -= dt;
        if (this.shieldLaunchTimer <= 0 && this.shieldAsteroids.length > 0) {
            const index = Math.floor(Math.random() * this.shieldAsteroids.length);
            const ast = this.shieldAsteroids.splice(index, 1)[0];

            const adx = player.worldX - ast.worldX;
            const ady = player.worldY - ast.worldY;
            const adist = Math.sqrt(adx * adx + ady * ady);

            this.launchingAsteroids.push({
                asteroid: ast,
                progress: 0,
                dirX: adx / adist,
                dirY: ady / adist,
                maxSpeed: 2200 // Faster for shield projectiles
            });

            this.game.sounds.play('boost', { volume: 0.8, x: this.worldX, y: this.worldY });
            this.shieldLaunchTimer = 2.0;
        }
    }

    _triggerDeathSequence() {
        super._triggerDeathSequence();

        // Stop all active missiles from seeking when the boss dies
        for (const m of this.activeMissiles) {
            if (m.proj.alive) {
                m.proj.target = null;
            }
        }
        this.activeMissiles = [];
    }

    hit(damage) {
        return super.hit(damage);
    }

    drawUnder(ctx, camera) {
        // Draw tractor beam
        if (this.tractorState === 'pulling' || this.tractorState === 'holding') {
            if (this.tractoredAsteroid && this.tractoredAsteroid.alive) {
                const screenS = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
                const screenE = camera.worldToScreen(this.tractoredAsteroid.worldX, this.tractoredAsteroid.worldY, this.game.width, this.game.height);

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(screenS.x, screenS.y);
                ctx.lineTo(screenE.x, screenE.y);
                ctx.strokeStyle = 'rgba(255, 50, 50, 0.6)';
                ctx.lineWidth = 4 * this.game.worldScale;
                ctx.setLineDash([10 * this.game.worldScale, 5 * this.game.worldScale]);
                ctx.lineDashOffset = -Date.now() / 20;
                ctx.stroke();

                // Outer glow
                ctx.strokeStyle = 'rgba(255, 100, 100, 0.2)';
                ctx.lineWidth = 12 * this.game.worldScale;
                ctx.stroke();
                ctx.restore();
            }
        }

        // Draw shield beams
        if (this.phase === BOSS_PHASE.ATTACK2) {
            const screenS = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            this.shieldAsteroids.forEach((ast, i) => {
                const screenE = camera.worldToScreen(ast.worldX, ast.worldY, this.game.width, this.game.height);

                // Spacing check to determine if "collecting"
                const orbitDist = 320;
                const angle = this.shieldRotation + (i / this.shieldAsteroids.length) * Math.PI * 2;
                const tx = this.worldX + Math.cos(angle) * orbitDist;
                const ty = this.worldY + Math.sin(angle) * orbitDist;
                const distTarget = Math.sqrt((tx - ast.worldX) ** 2 + (ty - ast.worldY) ** 2);
                const isCapturing = distTarget > 50;

                ctx.save();
                ctx.beginPath();
                ctx.moveTo(screenS.x, screenS.y);
                ctx.lineTo(screenE.x, screenE.y);

                if (isCapturing) {
                    // Thick, flickering beam for active collection
                    const flicker = Math.random() > 0.5 ? 0.8 : 0.4;
                    ctx.strokeStyle = `rgba(255, 100, 50, ${flicker})`;
                    ctx.lineWidth = (3 + Math.random() * 2) * this.game.worldScale;
                } else {
                    // Constant thin beam for "locked" status
                    ctx.strokeStyle = 'rgba(255, 50, 50, 0.2)';
                    ctx.lineWidth = 1.5 * this.game.worldScale;
                }

                ctx.stroke();
                ctx.restore();
            });
        }

        // Draw launching beams
        for (const launch of this.launchingAsteroids) {
            const ast = launch.asteroid;
            if (!ast || !ast.alive) continue;
            const screenS = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
            const screenE = camera.worldToScreen(ast.worldX, ast.worldY, this.game.width, this.game.height);
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(screenS.x, screenS.y);
            ctx.lineTo(screenE.x, screenE.y);
            ctx.strokeStyle = `rgba(255, 150, 50, ${0.6 * (1.0 - launch.progress / 0.5)})`;
            ctx.lineWidth = 3 * this.game.worldScale;
            ctx.stroke();
            ctx.restore();
        }
    }

    draw(ctx, camera) {
        super.draw(ctx, camera);
    }

    _getPredictedTarget(player, projSpeed) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const distSq = dx * dx + dy * dy;
        const pVx = player.vx || 0;
        const pVy = player.vy || 0;

        const a = pVx * pVx + pVy * pVy - projSpeed * projSpeed;
        const b = 2 * (dx * pVx + dy * pVy);
        const c = distSq;

        const disc = b * b - 4 * a * c;
        if (disc < 0) return { x: player.worldX, y: player.worldY };

        const t1 = (-b + Math.sqrt(disc)) / (2 * a);
        const t2 = (-b - Math.sqrt(disc)) / (2 * a);

        let t = Math.max(t1, t2);
        if (t < 0) t = Math.min(t1, t2);
        if (t < 0) return { x: player.worldX, y: player.worldY };

        return {
            x: player.worldX + pVx * t,
            y: player.worldY + pVy * t
        };
    }

    _getPredictedAngle(player, projSpeed) {
        const target = this._getPredictedTarget(player, projSpeed);
        return Math.atan2(target.y - this.worldY, target.x - this.worldX);
    }

    _getAvoidanceSteering() {
        const asteroids = this.game.currentState.asteroids || [];
        let totalAvoidX = 0;
        let totalAvoidY = 0;
        const avoidRange = 400;

        for (const ast of asteroids) {
            if (!ast.alive || this.shieldAsteroids.includes(ast)) continue;
            if (this.launchingAsteroids.some(l => l.asteroid === ast)) continue;

            const dx = this.worldX - ast.worldX;
            const dy = this.worldY - ast.worldY;
            const dSq = dx * dx + dy * dy;

            if (dSq < avoidRange * avoidRange) {
                const d = Math.sqrt(dSq);
                const weight = (1.0 - d / avoidRange);
                totalAvoidX += (dx / d) * weight;
                totalAvoidY += (dy / d) * weight;
            }
        }

        if (Math.abs(totalAvoidX) > 0.01 || Math.abs(totalAvoidY) > 0.01) {
            const avoidAngle = Math.atan2(totalAvoidY, totalAvoidX);
            // Return an angle offset to apply to targetAngle
            let diff = avoidAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            return diff * 0.4; // 40% strength steering
        }
        return 0;
    }
}
