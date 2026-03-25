import { KamikazeEnemy, Enemy, CthulhuEnemy } from './enemy.js';
import { Rubble, ItemPickup } from './asteroid.js';
import { UPGRADES } from '../data/upgrades.js';

export const CTHULHU_STATE = {
    DORMANT: 0,
    WAKING: 1,
    COMBAT: 2,
    SLEEPING: 3,
    DESTRUCTIBLE: 4
};

export class CthulhuEvent {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.revealed = false; // Hidden until discovered
        this.discovered = false; // Track for stats

        this.state = CTHULHU_STATE.DORMANT;

        this.angle = 0;

        // Visuals
        this.stillImg = game.assets.get('cthulhu');
        this.wakeAnim = game.assets.get('cthulhu_wake');
        this.frameIndex = 0;
        this.frameTimer = 0;

        // Scaling (Big boss)
        this.scale = 1.0;
        this.radius = (this.stillImg ? Math.max(this.stillImg.width, this.stillImg.height) / 2 : 128) * this.scale;

        // Combat/Wave State
        this.wave = 0;
        this.maxWaves = 3;
        this.enemiesToSpawn = 0;
        this.activeEnemies = []; // Queue for playingState
        this.spawnedEnemies = []; // Track alive enemies for wave completion
        this.spawnTimer = 0;

        // Damage tracking
        this.health = 20; // Only matters in DESTRUCTIBLE state
        this.invulnTimer = 0;

        // Wake Rumble for polish
        this.wakeRumbleTimer = 0;
    }

    update(dt, player) {
        this.invulnTimer = Math.max(0, this.invulnTimer - dt);

        // Discovery logic
        if (!this.revealed) {
            const dx = this.worldX - player.worldX;
            const dy = this.worldY - player.worldY;
            if (Math.sqrt(dx * dx + dy * dy) < 2500) {
                this.revealed = true;
                this.game.sounds.play('select', { volume: 0.8, x: this.worldX, y: this.worldY }); // Little ping sound for discovery
            }
        }

        if (this.state === CTHULHU_STATE.WAKING) {
            if (this.wakeAnim) {
                this.frameTimer += dt * 1000;
                if (this.frameTimer >= this.wakeAnim[this.frameIndex].delay) {
                    this.frameTimer = 0;
                    this.frameIndex++;
                    if (this.frameIndex >= this.wakeAnim.length) {
                        this.frameIndex = this.wakeAnim.length - 1; // Stay on last frame
                        this.state = CTHULHU_STATE.COMBAT;
                        this.startWave(player);
                    }
                }
            } else {
                this.state = CTHULHU_STATE.COMBAT;
                this.startWave(player);
            }
        }
        else if (this.state === CTHULHU_STATE.COMBAT) {
            // Track spawned enemies internally to know when the wave is actually cleared
            this.spawnedEnemies = this.spawnedEnemies.filter(e => e.alive);

            if (this.enemiesToSpawn > 0) {
                this.spawnTimer -= dt;
                if (this.spawnTimer <= 0) {
                    this.spawnTimer = 1.0 + Math.random();
                    this.enemiesToSpawn--;
                    // Spawn far away relative to the player
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1800 + Math.random() * 600; // Match standard wave spawn distance 
                    const ex = player.worldX + Math.cos(angle) * dist;
                    const ey = player.worldY + Math.sin(angle) * dist;

                    const enemy = new CthulhuEnemy(this.game, ex, ey, 1 + (this.wave * 0.5));
                    // Respect player inventory for upgrades
                    Enemy.rollUpgrade(enemy, player);
                    this.activeEnemies.push(enemy);   // Consumed by playingState
                    this.spawnedEnemies.push(enemy);  // Tracked by Cthulhu
                }
            } else if (this.spawnedEnemies.length === 0) {
                // Wave cleared
                if (this.wave < this.maxWaves) {
                    this.startWave(player);
                } else {
                    this.state = CTHULHU_STATE.SLEEPING;
                }
            }
        }
        else if (this.state === CTHULHU_STATE.SLEEPING) {
            if (this.wakeAnim) {
                this.frameTimer += dt * 1000;
                if (this.frameTimer >= this.wakeAnim[this.frameIndex].delay) {
                    this.frameTimer = 0;
                    this.frameIndex--;
                    if (this.frameIndex < 0) {
                        this.frameIndex = 0;
                        this.state = CTHULHU_STATE.DESTRUCTIBLE;
                    }
                }
            } else {
                this.state = CTHULHU_STATE.DESTRUCTIBLE;
            }
        }
        else if (this.state === CTHULHU_STATE.DESTRUCTIBLE) {
            // Rotates slowly
            this.angle += dt * 0.5;
        }

        // --- Wake Rumble Update ---
        if (this.wakeRumbleTimer > 0) {
            this.wakeRumbleTimer -= dt;
            const t = 1.0 - this.wakeRumbleTimer; // 0.0 to 1.0 over 1 second
            if (t <= 1.0) {
                // Bell curve intensity: peaks at 0.5s
                const intensity = Math.sin(t * Math.PI) * 5.0; // Strong max intensity of 5.0
                this.game.camera.rumble(intensity);
            }
        }
    }

    get isActive() {
        return this.state !== CTHULHU_STATE.DORMANT;
    }

    startWave(player) {
        this.wave++;
        this.enemiesToSpawn = 5; // 3 waves of 5 enemies = 15 total
        this.spawnTimer = 2.0;
        this.game.sounds.play('ship_explode', { volume: 0.6, x: this.worldX, y: this.worldY }); // Boss roar effect
    }

    hit(damage) {
        if (this.state === CTHULHU_STATE.DORMANT) {
            this.triggerEvent();
            return false;
        }

        if (this.state !== CTHULHU_STATE.DESTRUCTIBLE || this.invulnTimer > 0) {
            return false;
        }

        // Only take damage if destructible
        this.health -= damage;
        this.invulnTimer = 0.1;
        this.game.sounds.play('asteroid_break', { volume: 0.6, x: this.worldX, y: this.worldY });

        if (this.health <= 0) {
            this.alive = false; // Mark dead here immediately so it falls out of playingState lists
            this.game.sounds.restoreMusic(); // Restore normal music only once fully destroyed
            return true;
        }
        return false;
    }

    triggerEvent() {
        this.state = CTHULHU_STATE.WAKING;
        this.wakeRumbleTimer = 1.0; // 1 second pulse
        this.game.sounds.playSpecificMusic('Starlight Devourer');
    }

    getSpawnOnDeath() {
        if (this.spawnedDeath) return []; // Prevent double drops
        this.spawnedDeath = true;

        this.game.sounds.play('asteroid_break', { volume: 0.8, x: this.worldX, y: this.worldY });
        this.game.sounds.play('ship_explode', { volume: 0.8, x: this.worldX, y: this.worldY });

        const spawns = [];

        // Lots of rubble
        for (let i = 0; i < 20; i++) {
            spawns.push(new Rubble(this.game, this.worldX, this.worldY));
        }

        // Special upgrade drop
        const curseUpgrade = UPGRADES.find(u => u.id === 'ancient_curse');
        if (curseUpgrade) {
            spawns.push(new ItemPickup(this.game, this.worldX, this.worldY, curseUpgrade));
        }

        return spawns;
    }

    // Allows us to extract active enemies and append them to PlayingState so player weapons can hit them
    popNewEnemies() {
        if (this.state === CTHULHU_STATE.COMBAT) {
            // Check if there are enemies that haven't been picked up by the playing state
            // This requires the playing state to maintain a list of enemies managed by the boss
            // We'll manage this actively in playingState
        }
    }

    draw(ctx, camera) {
        if (!this.alive) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        let img = this.stillImg;
        if ((this.state === CTHULHU_STATE.WAKING || this.state === CTHULHU_STATE.COMBAT || this.state === CTHULHU_STATE.SLEEPING) && this.wakeAnim) {
            img = this.wakeAnim[this.frameIndex].canvas || this.wakeAnim[this.frameIndex];
        }

        if (!img) return;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle);
        const w = img.width * this.game.worldScale * this.scale;
        const h = img.height * this.game.worldScale * this.scale;
        ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}
