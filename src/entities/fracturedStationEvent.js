import { Enemy } from './enemy.js';
import { Asteroid } from './asteroid.js';

export const FRACTURED_STATION_STATE = {
    WAIT_SUB1: 0,
    WAVE_SUB1: 1,
    SIGNAL_SUB2: 2,
    WAIT_SUB2: 3,
    WAVE_SUB2: 4,
    SIGNAL_SUB3: 5,
    WAIT_SUB3: 6,
    BELT_SUB3: 7,
    FINISHED: 8
};

export class FracturedStationEvent {
    constructor(game, positions) {
        this.game = game;
        this.positions = positions; // Array of 3 {x, y} objects
        this.alive = true;
        this.revealed = false; // Hidden until detection

        this.state = FRACTURED_STATION_STATE.WAIT_SUB1;

        // Stations have different images
        this.images = [
            game.assets.get('fractured_station_0'),
            game.assets.get('fractured_station_1'),
            game.assets.get('fractured_station_2')
        ];

        this.detectionDist = 1200 * this.game.worldScale;
        this.spawnDist = 300 * this.game.worldScale;
        this.radius = 0; // COSMETIC ONLY - NO COLLISION

        this.activeEnemies = [];
        this.pendingEnemies = [];
        this.pendingSpawns = [];

        this.spawnQueue = [];
        this.spawnTimer = 0;
        this.spawnInterval = 2.0; // 1 second between enemy spawns
        this._beltQueue = [];

        this.musicStarted = false;
        // Random angles for stations
        this.angles = [Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2];

        // Asteroid belt size probabilities (roll thresholds)
        this.beltSizeProbs = {
            big: 0.05,    // 5%
            small: 0.15,  // 10%
            tiny: 0.65    // 50%
        };
    }

    get worldX() {
        if (this.state <= FRACTURED_STATION_STATE.WAVE_SUB1) return this.positions[0].x;
        if (this.state <= FRACTURED_STATION_STATE.WAVE_SUB2) return this.positions[1].x;
        return this.positions[2].x;
    }

    get worldY() {
        if (this.state <= FRACTURED_STATION_STATE.WAVE_SUB1) return this.positions[0].y;
        if (this.state <= FRACTURED_STATION_STATE.WAVE_SUB2) return this.positions[1].y;
        return this.positions[2].y;
    }

    update(dt, player) {
        if (this.state === FRACTURED_STATION_STATE.FINISHED) return;

        // Current target station index
        let stationIdx = 0;
        if (this.state >= FRACTURED_STATION_STATE.WAIT_SUB2 && this.state <= FRACTURED_STATION_STATE.WAVE_SUB2) stationIdx = 1;
        if (this.state >= FRACTURED_STATION_STATE.WAIT_SUB3) stationIdx = 2;

        const pos = this.positions[stationIdx];
        const dx = player.worldX - pos.x;
        const dy = player.worldY - pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Radar Identification / Signal Discovery
        if (!this.revealed && dist < this.detectionDist) {
            this.revealed = true;
            // Music Trigger on first station discovery
            if (!this.musicStarted && stationIdx === 0) {
                this.musicStarted = true;
                this.game.sounds.playMusicByLabel('Derelict Orbit');
            }
        }

        // Handle Gradual Spawning (Like Waves)
        if (this.spawnQueue.length > 0) {
            this.spawnTimer -= dt;
            if (this.spawnTimer <= 0) {
                const enemy = this.spawnQueue.shift();
                this.activeEnemies.push(enemy);
                this.pendingEnemies.push(enemy);
                // Matched to wave stagger: 1.5-3s
                this.spawnTimer = 1.5 + Math.random() * 1.5;
            }
        }

        // Handle Gradual Asteroid Belt Spawning
        if (this._beltQueue && this._beltQueue.length > 0) {
            const numToSpawn = Math.min(this._beltQueue.length, 5);
            for (let i = 0; i < numToSpawn; i++) {
                const data = this._beltQueue.shift();
                const asteroid = new Asteroid(this.game, data.ax, data.ay, data.size, 0, 0);
                asteroid.despawnDist = Infinity; // DON'T DESPAWN
                this.pendingSpawns.push(asteroid);
            }
        }

        switch (this.state) {
            case FRACTURED_STATION_STATE.WAIT_SUB1:
                if (dist < this.spawnDist) {
                    this.state = FRACTURED_STATION_STATE.WAVE_SUB1;
                    this.revealed = false; // Hide radar while fighting
                    this._spawnWave(player.worldX, player.worldY, 4);
                }
                break;

            case FRACTURED_STATION_STATE.WAVE_SUB1:
                // Check if wave defeated
                this.activeEnemies = this.activeEnemies.filter(e => e.alive);
                if (this.activeEnemies.length === 0 && this.spawnQueue.length === 0) {
                    this.state = FRACTURED_STATION_STATE.SIGNAL_SUB2;
                    this.revealed = true; // Show signal for next
                }
                break;

            case FRACTURED_STATION_STATE.SIGNAL_SUB2:
                this.state = FRACTURED_STATION_STATE.WAIT_SUB2;
                break;

            case FRACTURED_STATION_STATE.WAIT_SUB2:
                if (dist < this.spawnDist) {
                    this.state = FRACTURED_STATION_STATE.WAVE_SUB2;
                    this.revealed = false;
                    this._spawnWave(player.worldX, player.worldY, 6);
                }
                break;

            case FRACTURED_STATION_STATE.WAVE_SUB2:
                this.activeEnemies = this.activeEnemies.filter(e => e.alive);
                if (this.activeEnemies.length === 0 && this.spawnQueue.length === 0) {
                    this.state = FRACTURED_STATION_STATE.SIGNAL_SUB3;
                    this.revealed = true;
                    // Trigger asteroids immediately at destination
                    this._spawnAsteroidBelt(this.positions[2].x, this.positions[2].y);
                }
                break;

            case FRACTURED_STATION_STATE.SIGNAL_SUB3:
                this.state = FRACTURED_STATION_STATE.WAIT_SUB3;
                break;

            case FRACTURED_STATION_STATE.WAIT_SUB3:
                if (dist < this.spawnDist) {
                    this.state = FRACTURED_STATION_STATE.BELT_SUB3;
                    this.revealed = false;
                }
                break;

            case FRACTURED_STATION_STATE.BELT_SUB3:
                // End event when reaching the final station
                if (dist < 300 * this.game.worldScale) {
                    this.state = FRACTURED_STATION_STATE.FINISHED;
                    this.revealed = false; // Hide marker
                    this.game.sounds.restoreMusic();
                }
                break;
        }
    }

    _spawnWave(playerX, playerY, count) {
        const difficulty = this.game.currentState.difficultyScale || 1.0;
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            // Spawn further out so they arrive staggered (1800-2400) like standard waves
            const dist = 1800 + Math.random() * 600;
            const ex = playerX + Math.cos(angle) * dist;
            const ey = playerY + Math.sin(angle) * dist;

            const enemy = new Enemy(this.game, ex, ey, difficulty);
            enemy._applyUpgrades();
            this.spawnQueue.push(enemy);
        }
        this.spawnTimer = 0; // First enemy spawns immediately
    }

    popEnemies() {
        const enemies = this.pendingEnemies || [];
        this.pendingEnemies = [];
        return enemies;
    }

    _spawnAsteroidBelt(x, y) {
        this._beltQueue = [];
        const count = 80 + Math.floor(Math.random() * 20);
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = (400 + Math.random() * 1200) * this.game.worldScale;
            const ax = x + Math.cos(angle) * dist;
            const ay = y + Math.sin(angle) * dist;

            const roll = Math.random();
            let size = 'medium';
            if (roll < this.beltSizeProbs.big) size = 'big';
            else if (roll < this.beltSizeProbs.small) size = 'small';
            else if (roll < this.beltSizeProbs.tiny) size = 'tiny';

            this._beltQueue.push({ ax, ay, size });
        }
    }

    get isActive() {
        return this.state === FRACTURED_STATION_STATE.WAVE_SUB1 ||
            this.state === FRACTURED_STATION_STATE.WAVE_SUB2;
    }

    get isFinished() {
        return this.state === FRACTURED_STATION_STATE.FINISHED;
    }

    popSpawns() {
        let spawns = [...this.pendingSpawns];
        this.pendingSpawns = [];

        // Also inject enemies if they are new
        // PlayingState logic usually handles this via activeEnemies property if added
        return spawns;
    }

    hit(damage) {
        return false; // Indestructible stations
    }

    draw(ctx, camera) {
        const cw = this.game.width;
        const ch = this.game.height;

        // Draw all discovered stations or the current one
        for (let i = 0; i <= 2; i++) {
            // Logic for when to draw which station:
            // Station 0: always after discovery started
            // Station 1: after discovered
            // Station 2: after discovered

            let shouldDraw = false;
            // Station 0 is cosmetic-permanent after it's even just slightly approached/discovered
            if (i === 0 && (this.musicStarted || this.state >= FRACTURED_STATION_STATE.WAIT_SUB1)) shouldDraw = true;
            // Station 1 is cosmetic-permanent after discovery
            if (i === 1 && this.state >= FRACTURED_STATION_STATE.WAIT_SUB2) shouldDraw = true;
            // Station 2 is cosmetic-permanent after discovery
            if (i === 2 && this.state >= FRACTURED_STATION_STATE.WAIT_SUB3) shouldDraw = true;

            if (shouldDraw) {
                const pos = this.positions[i];
                const screen = camera.worldToScreen(pos.x, pos.y, cw, ch);
                const img = this.images[i];
                if (img) {
                    ctx.save();
                    ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
                    ctx.rotate(this.angles[i]);
                    const w = img.width * this.game.worldScale;
                    const h = img.height * this.game.worldScale;
                    ctx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
                    ctx.restore();
                }
            }
        }
    }
}
