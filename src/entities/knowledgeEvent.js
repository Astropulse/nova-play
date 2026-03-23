import { Enemy } from './enemy.js';
import { Rubble, ItemPickup, Scrap } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';
import { Projectile } from './projectile.js';

export const KNOWLEDGE_STATE = {
    DORMANT: 0,
    NEAR: 1,
    BOSS: 2,
    DEFEATED: 3,
    FINISHED: 4
};

export class KnowledgeEvent {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.revealed = false;
        this.discovered = false;
        this.state = KNOWLEDGE_STATE.DORMANT;

        // Visuals
        this.baseImg = game.assets.get('knowledge');
        this.eyeGif = game.assets.get('knowledge_eye');

        // Eye tracking
        this.eyeX = 0;
        this.eyeY = 0;
        this.eyeAngle = 0;
        this.eyeFrame = 0;
        this.eyeTimer = 0;

        // Hitbox/Circle properties
        this.radius = 100;
        this.innerRadius = 150; // Trigger radius for boss
        this.bossRadius = 150; // Current expanding radius
        this.targetBossRadius = 800;

        // Interaction flags
        this.acceptsItems = true;
        this.acceptsEnemies = true;
        this.isFinished = false;

        // Attack timers
        this.attackTimer = 0;
        this.beamTimer = 1.0; // Start sooner

        // Health Phase 1: 50 damage to wake up
        this.health = 5;
        this.maxBossHealth = 40;
        this.invulnTimer = 0;

        this.pendingSpawns = [];
        this.blocksProjectiles = true;

        // Beam Targeting state
        this.isTargeting = false;
        this.targetingAngle = 0;
        this.targetingTimer = 0;
        this.activeBeams = [];
        this.patternTimer = 0; // Timer for switching patterns
        this.currentPattern = 0; // 0: random, 1: swirling, 2: waves
        this.healthScaled = false;
    }

    update(dt, player) {
        if (!this.alive && this.state !== KNOWLEDGE_STATE.DEFEATED && this.state !== KNOWLEDGE_STATE.FINISHED) return;

        // Update active beams
        for (let i = this.activeBeams.length - 1; i >= 0; i--) {
            this.activeBeams[i].timer -= dt;
            if (this.activeBeams[i].timer <= 0) this.activeBeams.splice(i, 1);
        }

        if (this.state === KNOWLEDGE_STATE.DEFEATED || this.state === KNOWLEDGE_STATE.FINISHED) {
            // Return to center if finished
            const lerp = 1 - Math.pow(0.1, dt);
            this.eyeX += (0 - this.eyeX) * lerp;
            this.eyeY += (0 - this.eyeY) * lerp;

            // Handle death explosion sequence
            if (this.state === KNOWLEDGE_STATE.DEFEATED && this.explosionCount < 5) {
                this.defeatTimer -= dt;
                if (this.defeatTimer <= 0) {
                    this.explosionCount++;
                    this.defeatTimer = 0.2 + Math.random() * 0.3; // Slower spacing for 5 explosions
                    const offX = (Math.random() - 0.5) * 300;
                    const offY = (Math.random() - 0.5) * 300;
                    const sound = Math.random() > 0.3 ? 'ship_explode' : 'asteroid_break';
                    this.game.sounds.play(sound, { volume: 0.7 + Math.random() * 0.3, x: this.worldX + offX, y: this.worldY + offY });

                    // Staggered scrap spawning (1-4 pieces per explosion)
                    const count = 2 + Math.floor(Math.random() * 8);
                    for (let i = 0; i < count; i++) {
                        const size = Math.random() > 0.6 ? 'big' : 'small';
                        const s = new Scrap(this.game, this.worldX, this.worldY, size);
                        const angle = Math.random() * Math.PI * 2;
                        const speed = 100 + Math.random() * 300;
                        s.vx = Math.cos(angle) * speed;
                        s.vy = Math.sin(angle) * speed;
                        this.pendingSpawns.push(s);
                    }
                }
            }

            // Stop GIF animation - handled in GIF logic section
            return;
        }

        this.invulnTimer = Math.max(0, this.invulnTimer - dt);
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Discovery logic (Signal indicator)
        if (!this.revealed && dist < 3500) {
            this.revealed = true;
        }

        // State changes
        if (this.state === KNOWLEDGE_STATE.DORMANT) {
            if (dist < 1200) {
                this.state = KNOWLEDGE_STATE.NEAR;
                this.game.sounds.playSpecificMusic('Lidless Above the Void');
            }
        }
        // Removed distance-based trigger for BOSS state - triggered in hit()

        // Eye tracking logic
        const isTrackingPlayer = (this.state !== KNOWLEDGE_STATE.DEFEATED && this.acceptsItems && this.acceptsEnemies);
        if (isTrackingPlayer) {
            this.eyeAngle = Math.atan2(dy, dx);
            const displacement = 20 * Math.min(1, dist / 600);
            this.eyeX = Math.cos(this.eyeAngle) * displacement;
            this.eyeY = Math.sin(this.eyeAngle) * displacement;
        } else if (this.state !== KNOWLEDGE_STATE.DEFEATED) {
            // Stop tracking, return to center
            const lerp = 1 - Math.pow(0.1, dt);
            this.eyeX += (0 - this.eyeX) * lerp;
            this.eyeY += (0 - this.eyeY) * lerp;
        }

        // GIF logic
        const isEyeAnimating = (this.state !== KNOWLEDGE_STATE.DEFEATED && this.state !== KNOWLEDGE_STATE.FINISHED);
        if (this.eyeGif && this.eyeGif.length > 0 && isEyeAnimating) {
            this.eyeTimer += dt * 1000;
            const currentFrame = this.eyeGif[this.eyeFrame];
            if (currentFrame) {
                const delay = currentFrame.delay || 100;
                if (this.eyeTimer >= delay) {
                    this.eyeTimer = 0;
                    this.eyeFrame = (this.eyeFrame + 1) % this.eyeGif.length;
                }
            }
        }

        // Suction & Luring
        if (this.state === KNOWLEDGE_STATE.NEAR) {
            this._handleSuction(dt, player);
        }

        // Boss fight mechanics
        if (this.state === KNOWLEDGE_STATE.BOSS) {
            const diff = this.game.currentState.difficultyScale || 1.0;

            // Expand circle
            if (this.bossRadius < this.targetBossRadius) {
                this.bossRadius = Math.min(this.targetBossRadius, this.bossRadius + 300 * dt);
            }

            // Attacks
            if (this.isTargeting) {
                // Tracking player during targeting
                const targetAngle = Math.atan2(dy, dx);
                let diffA = targetAngle - this.targetingAngle;
                while (diffA > Math.PI) diffA -= Math.PI * 2;
                while (diffA < -Math.PI) diffA += Math.PI * 2;
                this.targetingAngle += diffA * 3.0 * dt; // Smooth but fast track

                this.targetingTimer -= dt;
                if (this.targetingTimer <= 0) {
                    this.isTargeting = false;
                    this._fireHitscanBeam(player, diff);
                }
            } else {
                this.attackTimer -= dt;
                if (this.attackTimer <= 0) {
                    // Randomly choose between basic lasers, swirling, or waves
                    const patternRoll = Math.floor(Math.random() * 3);
                    if (patternRoll === 0) this._fireLasers(player, diff);
                    else if (patternRoll === 1) this._fireSwirlingProjectiles(player, diff);
                    else this._fireWaveProjectiles(player, diff);

                    this.attackTimer = (Math.max(1.0, 2.8 / (diff * 0.5 + 0.5))) * (0.7 + Math.random() * 0.6);
                }

                this.beamTimer -= dt;
                if (this.beamTimer <= 0) {
                    this._startBeamTargeting(player);
                    this.beamTimer = (Math.max(1.2, 3.5 / (diff * 0.5 + 0.5))) * (0.8 + Math.random() * 0.4);
                }
            }

            // If player leaves boss radius, reset (using target radius so it doesn't reset while expanding)
            if (dist > this.targetBossRadius + 400) {
                this._resetBoss();
            }
        }
    }

    _handleSuction(dt, player) {
        const suctionRadius = 600;
        const consumeRadius = 15;

        // 1. Items
        if (this.acceptsItems && this.game.currentState.itemPickups) {
            for (const item of this.game.currentState.itemPickups) {
                if (!item.alive) continue;
                const idx = item.worldX - this.worldX;
                const idy = item.worldY - this.worldY;
                const idist = Math.sqrt(idx * idx + idy * idy);

                if (idist < suctionRadius) {
                    // Dramatic swirling suction
                    const angleToCenter = Math.atan2(-idy, -idx);
                    // Add a tangential component for swirling
                    const swirlAngle = angleToCenter + Math.PI / 2;
                    const pullForce = 800 * (1 - idist / suctionRadius) + 200; // Increase pull near center
                    const swirlForce = 800 * (idist / suctionRadius); // Swirl more at edges

                    item.vx += (Math.cos(angleToCenter) * pullForce + Math.cos(swirlAngle) * swirlForce) * dt;
                    item.vy += (Math.sin(angleToCenter) * pullForce + Math.sin(swirlAngle) * swirlForce) * dt;

                    // Add some dampening to keep them from orbiting forever
                    item.vx *= 0.98;
                    item.vy *= 0.98;

                    if (idist < consumeRadius) {
                        this._consumeItem(item);
                    }
                }
            }
        }

        // 2. Enemies
        if (this.acceptsEnemies && this.game.currentState.enemies) {
            for (const en of this.game.currentState.enemies) {
                if (!en.alive) continue;
                const edx = en.worldX - this.worldX;
                const edy = en.worldY - this.worldY;
                const edist = Math.sqrt(edx * edx + edy * edy);

                if (edist < suctionRadius) {
                    const angleToCenter = Math.atan2(-edy, -edx);
                    const swirlAngle = angleToCenter + Math.PI / 2;
                    // Much stronger forces to overcome AI speed
                    const pullForce = 400 * (1 - edist / suctionRadius) + 200;
                    const swirlForce = 400;

                    en.externalVx += (Math.cos(angleToCenter) * pullForce + Math.cos(swirlAngle) * swirlForce) * dt;
                    en.externalVy += (Math.sin(angleToCenter) * pullForce + Math.sin(swirlAngle) * swirlForce) * dt;

                    if (edist < consumeRadius) {
                        this._consumeEnemy(en);
                    }
                }
            }
        }
    }

    _consumeItem(item) {
        item.alive = false;
        this.acceptsItems = false;
        this.acceptsEnemies = false; // Cannot interact again
        this.state = KNOWLEDGE_STATE.FINISHED;
        this.isFinished = true; // Deactivate signal indicators
        this.game.sounds.restoreMusic();
        this.game.sounds.play('asteroid_break', { volume: 1.0, x: this.worldX, y: this.worldY });

        // Drop Obedience upgrade
        const up = UPGRADES.find(u => u.id === 'obedience');
        if (up) {
            const reward = new ItemPickup(this.game, this.worldX, this.worldY, up);
            // Spit towards player
            const player = this.game.currentState.player;
            if (player) {
                const angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                const speed = 300;
                reward.vx = Math.cos(angle) * speed;
                reward.vy = Math.sin(angle) * speed;
            }
            this.pendingSpawns.push(reward);
        }
        this.game.sounds.play('select', { volume: 0.8, x: this.worldX, y: this.worldY });
    }

    _consumeEnemy(enemy) {
        enemy.alive = false;
        this.acceptsEnemies = false;
        this.acceptsItems = false; // Cannot interact again
        this.state = KNOWLEDGE_STATE.FINISHED;
        this.isFinished = true; // Deactivate signal indicators
        this.game.sounds.restoreMusic();
        this.game.sounds.play('asteroid_break', { volume: 1.0, x: this.worldX, y: this.worldY });
        this.game.sounds.play('ship_explode', { volume: 0.8, x: this.worldX, y: this.worldY });

        // Drop Sacrifice upgrade
        const up = UPGRADES.find(u => u.id === 'sacrifice');
        if (up) {
            const reward = new ItemPickup(this.game, this.worldX, this.worldY, up);
            // Spit towards player
            const player = this.game.currentState.player;
            if (player) {
                const angle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
                const speed = 400;
                reward.vx = Math.cos(angle) * speed;
                reward.vy = Math.sin(angle) * speed;
            }
            this.pendingSpawns.push(reward);
        }
        this.game.sounds.play('select', { volume: 0.8, x: this.worldX, y: this.worldY });
    }

    _startBeamTargeting(player) {
        this.isTargeting = true;
        this.targetingTimer = 1.5;
        this.targetingAngle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
        this.game.sounds.play('railgun_target', { volume: 0.7, x: this.worldX, y: this.worldY });
    }

    _fireLasers(player, diff) {
        // Spiral pattern
        const count = Math.floor(8 + (diff * 2));
        const damage = (1 + (diff - 1) * 0.5);
        for (let i = 0; i < count; i++) {
            const angle = (i / count) * Math.PI * 2 + (Math.random() * 0.2);
            const speed = 500 + (diff * 30);
            const proj = new Projectile(this.game, this.worldX, this.worldY, angle, speed, 'red_laser_ball_big', this, damage, 4.0);
            this.game.currentState.projectiles.push(proj);
        }
        this.game.sounds.play('laser', { volume: 0.5, x: this.worldX, y: this.worldY });
    }

    _fireSwirlingProjectiles(player, diff) {
        const count = Math.floor(12 + (diff * 4));
        const damage = (1 + (diff - 1) * 0.5);
        const baseAngle = Math.random() * Math.PI * 2;
        const speed = 400 + (diff * 20);
        const angularVelocity = 1.0 + Math.random() * 1.0; // Variable radius: 1.5 was current (small), 0.5 is large spiral

        for (let i = 0; i < count; i++) {
            const angle = baseAngle + (i / count) * Math.PI * 2;
            const proj = new Projectile(this.game, this.worldX, this.worldY, angle, speed, 'red_laser_ball_big', this, damage, 4.0);
            proj.speed = speed;

            // Add custom behavior for swirling
            const originalUpdate = proj.update;
            proj.update = function (dt) {
                this.angle += angularVelocity * dt;
                this.vx = Math.cos(this.angle) * this.speed;
                this.vy = Math.sin(this.angle) * this.speed;
                originalUpdate.call(this, dt);
            };

            this.game.currentState.projectiles.push(proj);
        }
        this.game.sounds.play('laser', { volume: 0.6, x: this.worldX, y: this.worldY });
    }

    _fireWaveProjectiles(player, diff) {
        const damage = (1 + (diff - 1) * 0.5);
        const waveAngle = Math.atan2(player.worldY - this.worldY, player.worldX - this.worldX);
        const arc = Math.PI * 0.4; // 40% of a circle
        const count = Math.floor(15 + (diff * 5));

        for (let i = 0; i < count; i++) {
            const angle = (waveAngle - arc / 2) + (i / (count - 1)) * arc;
            const speed = 600 + (diff * 20);
            const proj = new Projectile(this.game, this.worldX, this.worldY, angle, speed, 'red_laser_ball_big', this, damage, 4.0);
            this.game.currentState.projectiles.push(proj);
        }
        this.game.sounds.play('laser', { volume: 0.7, x: this.worldX, y: this.worldY });
    }

    _fireHitscanBeam(player, diff) {
        const angle = this.targetingAngle;
        const damage = (1 + (diff - 1) * 0.5) * 2.5;
        const length = 12000;

        this.activeBeams.push({
            x: this.worldX,
            y: this.worldY,
            angle: angle,
            timer: 0.3
        });

        // Hitscan logic
        if (player) {
            const dx = player.worldX - this.worldX;
            const dy = player.worldY - this.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist < length) {
                const dirX = Math.cos(angle);
                const dirY = Math.sin(angle);
                const dot = (dx * dirX + dy * dirY) / dist;
                if (dot > 0.995) { // Very narrow beam
                    const cross = Math.abs(dx * dirY - dy * dirX);
                    if (cross < player.radius * 1.5) {
                        this.game.currentState._damagePlayer(damage);
                        this.game.sounds.play('hit', { volume: 0.6, x: player.worldX, y: player.worldY });
                    }
                }
            }
        }

        this.game.sounds.play('railgun_shoot', { volume: 0.8, x: this.worldX, y: this.worldY });
    }

    _resetBoss() {
        this.isTargeting = false;
        this.state = KNOWLEDGE_STATE.NEAR;
        this.bossRadius = this.innerRadius;
        this.game.sounds.restoreMusic();
    }

    hit(damage) {
        if (this.state === KNOWLEDGE_STATE.NEAR) {
            if (!this.healthScaled) {
                const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
                this.health = Math.ceil(this.health * diff);
                this.healthScaled = true;
            }
            this.health -= damage;
            this.game.sounds.play('hit', { volume: 0.5, x: this.worldX, y: this.worldY });

            if (this.health <= 0) {
                this.state = KNOWLEDGE_STATE.BOSS;
                const diff = (this.game.currentState && this.game.currentState.difficultyScale) || 1.0;
                this.health = this.maxBossHealth * diff;
                this.game.sounds.play('bolt_fire', { volume: 1.0, x: this.worldX, y: this.worldY });
                this.game.sounds.play('railgun_target', { volume: 0.8, x: this.worldX, y: this.worldY });
            }
            return false;
        }

        if (this.state !== KNOWLEDGE_STATE.BOSS || this.invulnTimer > 0) return false;

        this.health -= damage;
        this.invulnTimer = 0.1;
        this.game.sounds.play('hit', { volume: 0.5, x: this.worldX, y: this.worldY });

        if (this.health <= 0) {
            this._onDefeat();
            return false; // Return false so PlayingState doesn't destroy the boss remnant
        }
        return false;
    }

    getSpawnOnDeath() {
        const spawns = [];
        // Spawn Knowledge upgrade
        const up = UPGRADES.find(u => u.id === 'knowledge');
        if (up) {
            const pickup = new ItemPickup(this.game, this.worldX, this.worldY, up);
            // Random velocity 100-400
            const angle = Math.random() * Math.PI * 2;
            const speed = 30 + Math.random() * 200;
            pickup.vx = Math.cos(angle) * speed;
            pickup.vy = Math.sin(angle) * speed;
            spawns.push(pickup);
        }

        return spawns;
    }

    _onDefeat() {
        this.state = KNOWLEDGE_STATE.DEFEATED;
        this.alive = true; // KEEP ALIVE for visual effect
        this.isFinished = true;
        this.game.sounds.restoreMusic();

        this.defeatTimer = 0;
        this.explosionCount = 0;

        // Spawn rewards immediately since we aren't calling PlayingState._onEntityDestroyed via alive=false
        const rewards = this.getSpawnOnDeath();
        for (const r of rewards) {
            this.pendingSpawns.push(r);
        }
    }

    get isActive() {
        return this.state === KNOWLEDGE_STATE.NEAR || this.state === KNOWLEDGE_STATE.BOSS;
    }

    draw(ctx, camera) {
        if (!this.alive && this.state !== KNOWLEDGE_STATE.DEFEATED) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        // Draw black circle during boss fight
        if (this.state === KNOWLEDGE_STATE.BOSS) {
            ctx.save();
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, this.bossRadius, 0, Math.PI * 2);
            ctx.strokeStyle = '#ff0000';
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = '#000000';
            ctx.fill();
            ctx.restore();
        }

        // Draw Eye (below base PNG)
        if (this.eyeGif && this.eyeGif.length > 0) {
            const frameEntry = this.eyeGif[this.eyeFrame];
            if (frameEntry) {
                const frame = frameEntry.canvas || frameEntry;
                const ew = frame.width * this.game.worldScale;
                const eh = frame.height * this.game.worldScale;

                ctx.save();
                if (this.state === KNOWLEDGE_STATE.DEFEATED) {
                    ctx.globalAlpha = 0.7;
                    ctx.globalCompositeOperation = 'screen';
                }
                ctx.translate(screen.x + this.eyeX * this.game.worldScale, screen.y + this.eyeY * this.game.worldScale);
                ctx.drawImage(frame, -ew / 2, -eh / 2, ew, eh);
                ctx.restore();
            }
        }

        // Draw Base PNG
        if (this.baseImg) {
            const bw = this.baseImg.width * this.game.worldScale;
            const bh = this.baseImg.height * this.game.worldScale;

            if (this.state === KNOWLEDGE_STATE.DEFEATED) {
                ctx.save();
                ctx.globalAlpha = 0.7;
                ctx.globalCompositeOperation = 'screen';
                ctx.drawImage(this.baseImg, screen.x - bw / 2, screen.y - bh / 2, bw, bh);
                ctx.restore();
            } else {
                ctx.drawImage(this.baseImg, screen.x - bw / 2, screen.y - bh / 2, bw, bh);
            }
        }

        // --- Boss VFX ---
        if (this.state === KNOWLEDGE_STATE.BOSS) {
            // Draw Arena Circle
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, this.bossRadius * this.game.worldScale, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
            ctx.lineWidth = 4 * this.game.worldScale;
            ctx.setLineDash([10 * this.game.worldScale, 10 * this.game.worldScale]);
            ctx.stroke();
            ctx.setLineDash([]); // Reset dash

            // Draw Targeting Beam
            if (this.isTargeting) {
                const targetImg = this.game.assets.get('red_laser_beam_targeting');
                if (targetImg) {
                    this._drawTiledBeam(ctx, screen.x, screen.y, this.targetingAngle, targetImg, 0.6);
                }
            }

            // Draw Active Beams
            const beamImg = this.game.assets.get('red_laser_beam');
            if (beamImg) {
                for (const beam of this.activeBeams) {
                    this._drawTiledBeam(ctx, screen.x, screen.y, beam.angle, beamImg, beam.timer / 0.3);
                }
            }
        }
    }

    _drawTiledBeam(ctx, x, y, angle, img, alpha) {
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(x, y);
        ctx.rotate(angle);

        const tileW = img.width * this.game.worldScale;
        const tileH = img.height * this.game.worldScale;
        const count = 150; // Tile long enough to cover 12000+ length

        for (let i = 0; i < count; i++) {
            ctx.drawImage(img, i * tileW, -tileH / 2, tileW, tileH);
        }
        ctx.restore();
    }

    // Helper for PlayingState to pop entities spawned by the event
    popSpawns() {
        const spawns = [...this.pendingSpawns];
        this.pendingSpawns = [];
        return spawns;
    }
}
