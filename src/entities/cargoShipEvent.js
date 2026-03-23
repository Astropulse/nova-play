import { Scrap } from './asteroid.js';

export const CARGO_SHIP_STATE = {
    DORMANT: 0,
    OPENED: 1
};

export class CargoShipEvent {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.revealed = false; // Hidden until discovered
        this.discovered = false; // Track for stats

        this.state = CARGO_SHIP_STATE.OPENED;
        this.angle = Math.random() * Math.PI * 2;

        // Visuals
        this.img = game.assets.get('cargo_ship');

        // Scaling
        this.scale = 1.0;
        this.radius = (this.img ? Math.max(this.img.width, this.img.height) / 2 : 128) * this.game.worldScale * this.scale;

        this.pendingSpawns = [];
        this.spawnedInitialScrap = false;
        this.blocksProjectiles = false;
        this._scrapQueue = 0;
    }

    update(dt, player) {
        const dx = player.worldX - this.worldX;
        const dy = player.worldY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (!this.spawnedInitialScrap) {
            // Trigger when player gets within 1200 world units
            if (dist < 1200 * this.game.worldScale) {
                this.spawnedInitialScrap = true;
                this.revealed = true; // Reveal on radar when close

                // Queue 50-80 scrap to be spawned gradually
                const scrapCount = 50 + Math.floor(Math.random() * 31);
                this._scrapQueue = scrapCount;

                this.game.sounds.play('asteroid_break', { volume: 0.6, x: this.worldX, y: this.worldY });
            }
        }

        // Process scrap queue: spawn up to 5 pieces per frame to avoid lag
        if (this._scrapQueue > 0) {
            const numToSpawn = Math.min(this._scrapQueue, 5);
            for (let i = 0; i < numToSpawn; i++) {
                const angle = Math.random() * Math.PI * 2;
                const spawnDist = Math.random() * this.radius * 1.5;
                const sx = this.worldX + Math.cos(angle) * spawnDist;
                const sy = this.worldY + Math.sin(angle) * spawnDist;

                let type = 'small';
                if (Math.random() > 0.85) type = 'big';

                this.pendingSpawns.push(new Scrap(this.game, sx, sy, type));
            }
            this._scrapQueue -= numToSpawn;
        }

        // Remove tracker once very close
        if (this.revealed && dist < 200 * this.game.worldScale) {
            this.revealed = false;
        }
    }

    get isFinished() {
        return this.spawnedInitialScrap;
    }

    get isActive() {
        return false;
    }

    getSpawnOnDeath() {
        return [];
    }

    // Called by playingState to collect spawns
    popSpawns() {
        if (this.pendingSpawns && this.pendingSpawns.length > 0) {
            const spawns = this.pendingSpawns;
            this.pendingSpawns = [];
            return spawns;
        }
        return [];
    }

    hit(damage) {
        // Indestructible
        return false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle);
        const w = this.img.width * this.game.worldScale * this.scale;
        const h = this.img.height * this.game.worldScale * this.scale;

        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}
