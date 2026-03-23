// Dynamic scaling is now handled via game.worldScale

// Asteroid sizes — maps to asset keys, stats, and split behavior
const ASTEROID_TYPES = {
    big: { keys: ['asteroid_big_0', 'asteroid_big_1', 'asteroid_big_2'], hp: 5, damage: 4, scrap: 3, splitInto: 'tiny', splitCount: 5, rubbleCount: 12 },
    medium: { keys: ['asteroid_medium_0', 'asteroid_medium_1', 'asteroid_medium_2'], hp: 3, damage: 3, scrap: 2, splitInto: 'rubble', splitCount: 0, rubbleCount: 8 },
    small: { keys: ['asteroid_small_0', 'asteroid_small_1'], hp: 2, damage: 2, scrap: 1, splitInto: 'rubble', splitCount: 0, rubbleCount: 5 },
    tiny: { keys: null, hp: 1, damage: 1, scrap: 1, splitInto: 'rubble', splitCount: 0, rubbleCount: 3 },
};

// All tiny keys
const TINY_KEYS = [];
for (let i = 0; i <= 24; i++) {
    TINY_KEYS.push(`asteroid_tiny_${String(i).padStart(2, '0')}`);
}
ASTEROID_TYPES.tiny.keys = TINY_KEYS;

// Rubble keys
const RUBBLE_KEYS = [];
for (let i = 0; i <= 11; i++) {
    RUBBLE_KEYS.push(`rubble_${String(i).padStart(2, '0')}`);
}

// Compute tight collision radius from an image's opaque pixels
function computeCollisionRadius(img) {
    if (!img || !img.width) return 10;
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);

    const data = ctx.getImageData(0, 0, img.width, img.height).data;
    const cx = img.width / 2;
    const cy = img.height / 2;
    let maxDistSq = 0;

    for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
            const alpha = data[(y * img.width + x) * 4 + 3];
            if (alpha > 30) { // opaque enough to count
                const dx = x - cx;
                const dy = y - cy;
                const distSq = dx * dx + dy * dy;
                if (distSq > maxDistSq) maxDistSq = distSq;
            }
        }
    }

    return Math.sqrt(maxDistSq);
}

// Cache for computed collision radii (native pixels, before S scaling)
const _radiusCache = new Map();
function getCachedRadius(img, key) {
    if (_radiusCache.has(key)) return _radiusCache.get(key);
    const r = computeCollisionRadius(img);
    _radiusCache.set(key, r);
    return r;
}

// Utility to slice a sprite into Voronoi-based shards for "clever" procedural breakup
export class VoronoiSlicer {
    static slice(img, numPieces) {
        if (!img || !img.width) return [];
        const w = img.width;
        const h = img.height;

        // 1. Get raw pixel data
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0);
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;

        // 2. Generate random seeds within the sprite area
        // We bias them away from the very edges to get better fragments
        const seeds = [];
        for (let i = 0; i < numPieces; i++) {
            seeds.push({
                x: Math.floor(w * (0.1 + Math.random() * 0.8)),
                y: Math.floor(h * (0.1 + Math.random() * 0.8))
            });
        }

        // 3. Partition pixels into shards based on nearest seed
        const shardData = Array.from({ length: numPieces }, () => ({
            minX: w, minY: h, maxX: 0, maxY: 0,
            pixels: [] // {x, y, r, g, b, a}
        }));

        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const idx = (y * w + x) * 4;
                const a = data[idx + 3];
                if (a < 30) continue; // Skip transparent/near-transparent

                let minDistSq = Infinity;
                let nearest = 0;
                for (let i = 0; i < numPieces; i++) {
                    const dx = x - seeds[i].x;
                    const dy = y - seeds[i].y;
                    const dSq = dx * dx + dy * dy;
                    if (dSq < minDistSq) {
                        minDistSq = dSq;
                        nearest = i;
                    }
                }

                const s = shardData[nearest];
                if (x < s.minX) s.minX = x;
                if (y < s.minY) s.minY = y;
                if (x > s.maxX) s.maxX = x;
                if (y > s.maxY) s.maxY = y;
                s.pixels.push({ x, y, r: data[idx], g: data[idx + 1], b: data[idx + 2], a: a });
            }
        }

        // 4. Create a canvas fragment for each shard
        const fragments = [];
        for (let i = 0; i < numPieces; i++) {
            const s = shardData[i];
            if (s.pixels.length < 5) continue; // Skip tiny or empty shards

            const sw = (s.maxX - s.minX) + 1;
            const sh = (s.maxY - s.minY) + 1;
            const fragCanvas = document.createElement('canvas');
            fragCanvas.width = sw;
            fragCanvas.height = sh;
            const fragCtx = fragCanvas.getContext('2d');
            const fragData = fragCtx.createImageData(sw, sh);

            for (const p of s.pixels) {
                const lx = p.x - s.minX;
                const ly = p.y - s.minY;
                const fIdx = (ly * sw + lx) * 4;
                fragData.data[fIdx] = p.r;
                fragData.data[fIdx + 1] = p.g;
                fragData.data[fIdx + 2] = p.b;
                fragData.data[fIdx + 3] = p.a;
            }
            fragCtx.putImageData(fragData, 0, 0);

            fragments.push({
                canvas: fragCanvas,
                // Center offset relative to original sprite center
                offsetX: (s.minX + sw / 2 - w / 2),
                offsetY: (s.minY + sh / 2 - h / 2)
            });
        }

        return fragments;
    }
}

// --- Pre-define classes used by others ---

// Rubble — small debris that fades and vanishes
export class Rubble {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.lifetime = 0.6 + Math.random() * 0.5;
        this.maxLifetime = this.lifetime;

        const key = RUBBLE_KEYS[Math.floor(Math.random() * RUBBLE_KEYS.length)];
        this.img = game.assets.get(key);

        const angle = Math.random() * Math.PI * 2;
        const speed = 30 + Math.random() * 100;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 5;
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;
        this.vx *= 0.97;
        this.vy *= 0.97;
        this.lifetime -= dt;
        if (this.lifetime <= 0) this.alive = false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        const alpha = Math.max(0, this.lifetime / this.maxLifetime);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}

// ProceduralDebris — similar to Rubble but uses a passed-in canvas/image (used for ship breakup)
export class ProceduralDebris {
    constructor(game, worldX, worldY, img, vx, vy, rotation, spin) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.img = img;
        this.vx = vx;
        this.vy = vy;
        this.rotation = rotation;
        this.spin = spin;
        this.alive = true;
        this.lifetime = 0.4 + Math.random() * 0.4;
        this.maxLifetime = this.lifetime;
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.spin * dt;
        this.vx *= 0.99;
        this.vy *= 0.99;
        this.lifetime -= dt;
        if (this.lifetime <= 0) this.alive = false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        // Culling
        if (screen.x < -100 || screen.x > this.game.width + 100 ||
            screen.y < -100 || screen.y > this.game.height + 100) return;

        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        const alpha = Math.max(0, this.lifetime / this.maxLifetime);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}

// Scrap entity keys
const BIG_SCRAP_KEYS = ['big_scrap_0', 'big_scrap_1', 'big_scrap_2', 'big_scrap_3', 'big_scrap_4'];
const SMALL_SCRAP_KEYS = [];
for (let i = 0; i <= 28; i++) {
    SMALL_SCRAP_KEYS.push(`scrap_${String(i).padStart(2, '0')}`);
}

// Physical Scrap that drifts and magnetizes to player
export class Scrap {
    constructor(game, worldX, worldY, type = 'small') {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.type = type;
        this.alive = true;

        const keys = type === 'big' ? BIG_SCRAP_KEYS : SMALL_SCRAP_KEYS;
        this.assetKey = keys[Math.floor(Math.random() * keys.length)];
        this.img = game.assets.get(this.assetKey);

        const angle = Math.random() * Math.PI * 2;
        const speed = 20 + Math.random() * 40;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 3;

        this.value = type === 'big' ? 5 : 1;
        this.magnetRange = this.game.unit(150);
        this.collectRange = this.game.unit(20);

        this.lifetime = 120; // 2 minutes
        this.maxLifetime = this.lifetime;
    }

    update(dt, playerX, playerY, magnetMult = 1.0) {
        const dx = playerX - this.worldX;
        const dy = playerY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const activeMagnetRange = this.magnetRange * magnetMult;

        if (dist < activeMagnetRange) {
            // Magnetize to player
            const angle = Math.atan2(dy, dx);
            const force = (1 - dist / activeMagnetRange) * this.game.unit(800);
            this.vx += Math.cos(angle) * force * dt;
            this.vy += Math.sin(angle) * force * dt;

            // Speed cap when magnetized to prevent orbiting too crazily
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            const maxSpeed = this.game.unit(600);
            if (speed > maxSpeed) {
                this.vx = (this.vx / speed) * maxSpeed;
                this.vy = (this.vy / speed) * maxSpeed;
            }
        } else {
            // Normal drift with light friction
            this.vx *= 0.99;
            this.vy *= 0.99;
        }

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;

        this.lifetime -= dt;
        if (this.lifetime <= 0) this.alive = false;
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            type: this.type,
            vx: this.vx,
            vy: this.vy,
            rotation: this.rotation,
            rotSpeed: this.rotSpeed,
            lifetime: this.lifetime,
            assetKey: this.assetKey
        };
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        if (screen.x + w < -50 || screen.x - w > this.game.width + 50 ||
            screen.y + h < -50 || screen.y - h > this.game.height + 50) return;

        let alpha = 1.0;
        if (this.lifetime < 5.0) {
            alpha = Math.max(0, this.lifetime / 5.0);
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }
}

/**
 * Physical item pickup that drifts and magnetizes to player
 */
export class ItemPickup {
    constructor(game, worldX, worldY, item) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.item = item;
        this.alive = true;

        this.assetKey = item.assetKey;
        this.img = game.assets.get(this.assetKey);

        const angle = Math.random() * Math.PI * 2;
        const speed = 10 + Math.random() * 20;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 2;

        this.magnetRange = this.game.unit(200);
        this.collectRange = this.game.unit(30);
    }

    update(dt, playerX, playerY, magnetMult = 1.0) {
        const dx = playerX - this.worldX;
        const dy = playerY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        const activeMagnetRange = this.magnetRange * magnetMult;

        if (dist < activeMagnetRange) {
            const angle = Math.atan2(dy, dx);
            const force = (1 - dist / activeMagnetRange) * this.game.unit(1000);
            this.vx += Math.cos(angle) * force * dt;
            this.vy += Math.sin(angle) * force * dt;

            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            const maxSpeed = this.game.unit(700);
            if (speed > maxSpeed) {
                this.vx = (this.vx / speed) * maxSpeed;
                this.vy = (this.vy / speed) * maxSpeed;
            }
        } else {
            this.vx *= 0.98;
            this.vy *= 0.98;
        }

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            itemId: this.item.id,
            vx: this.vx,
            vy: this.vy,
            rotation: this.rotation,
            rotSpeed: this.rotSpeed
        };
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        if (screen.x + w < -50 || screen.x - w > this.game.width + 50 ||
            screen.y + h < -50 || screen.y - h > this.game.height + 50) return;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.rotation);

        // Items are slightly larger in the world than their UI versions
        const renderScale = 1.2;
        ctx.drawImage(this.img, -Math.floor(w * renderScale / 2), -Math.floor(h * renderScale / 2), w * renderScale, h * renderScale);

        // Subtle glow or highlight? 
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(w, h) * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.restore();
    }
}

export class Asteroid {
    constructor(game, worldX, worldY, size, vx = 0, vy = 0) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.size = size;
        this.alive = true;

        const type = ASTEROID_TYPES[size];
        this.hp = type.hp;
        this.maxHp = type.hp;
        this.damage = type.damage;
        this.scrap = 0; // Scrap is now physical entities spawned on death
        this.splitInto = type.splitInto;
        this.splitCount = type.splitCount;
        this.rubbleCount = type.rubbleCount;
        this.scrapAmount = type.scrap; // Number of physical scrap pieces

        // Pick random asset
        this.assetKey = type.keys[Math.floor(Math.random() * type.keys.length)];
        this.img = game.assets.get(this.assetKey);

        // Collision radius from actual opaque shape
        this._nativeRadius = getCachedRadius(this.img, this.assetKey);

        // Velocity
        this.vx = vx;
        this.vy = vy;

        // Slow rotation
        this.rotation = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 1.5;

        // Despawn if very far from player
        this.despawnDist = game.unit(4500);
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            size: this.size,
            vx: this.vx,
            vy: this.vy,
            hp: this.hp,
            rotation: this.rotation,
            rotSpeed: this.rotSpeed,
            assetKey: this.assetKey
        };
    }

    hit(damage) {
        this.hp -= damage;
        if (this.hp <= 0) {
            this.alive = false;
            return true;
        }
        return false;
    }

    _generateProceduralDebris() {
        if (!this.img || !this.img.width) return [];

        // Scale number of pieces based on asteroid size
        let numPieces = 25 + Math.floor(Math.random() * 15); // Default (Medium)
        if (this.size === 'big') {
            numPieces = 50 + Math.floor(Math.random() * 20);
        } else if (this.size === 'small') {
            numPieces = 16 + Math.floor(Math.random() * 12);
        } else if (this.size === 'tiny') {
            numPieces = 10 + Math.floor(Math.random() * 8);
        }
        const shards = VoronoiSlicer.slice(this.img, numPieces);
        const debris = [];

        for (const shard of shards) {
            const cosA = Math.cos(this.rotation);
            const sinA = Math.sin(this.rotation);

            const worldOffX = (shard.offsetX * cosA - shard.offsetY * sinA) * this.game.worldScale;
            const worldOffY = (shard.offsetX * sinA + shard.offsetY * cosA) * this.game.worldScale;

            const outAngle = Math.atan2(worldOffY, worldOffX);
            const spread = 30 + Math.random() * 50;
            const vx = this.vx * 0.5 + Math.cos(outAngle) * spread;
            const vy = this.vy * 0.5 + Math.sin(outAngle) * spread;

            debris.push(new ProceduralDebris(
                this.game,
                this.worldX + worldOffX,
                this.worldY + worldOffY,
                shard.canvas,
                vx, vy,
                this.rotation,
                (Math.random() - 0.5) * 4
            ));
        }
        return debris;
    }

    // Returns array of new entities to spawn on death
    getSpawnOnDeath() {
        const spawns = this._generateProceduralDebris();

        // Always spawn rubble spread across the asteroid's shape
        const w = this.img ? this.img.width * this.game.worldScale : 20;
        const h = this.img ? this.img.height * this.game.worldScale : 20;
        for (let i = 0; i < this.rubbleCount; i++) {
            // Spread rubble across the asteroid's area (elliptical)
            const angle = Math.random() * Math.PI * 2;
            const dist = Math.random() * Math.min(w, h) * 0.4;
            spawns.push(new Rubble(
                this.game,
                this.worldX + Math.cos(angle) * dist,
                this.worldY + Math.sin(angle) * dist,
            ));
        }

        // Spawn physical scrap
        if (Math.random() < 0.8) { // 80% chance to drop scrap
            let count = 1;
            let forceBig = false;

            if (this.size === 'big') {
                count = 2 + Math.floor(Math.random() * 3);
            } else if (this.size === 'medium') {
                count = Math.random() < 0.4 ? 2 : 1; // 40% chance for 2 scrap
                if (Math.random() < 0.1) forceBig = true; // 10% chance for a big scrap
            }

            for (let i = 0; i < count; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist = Math.random() * Math.min(w, h) * 0.3;

                // For medium, if forceBig is true, first piece is big. For big, all are big.
                const isBig = (this.size === 'big') || (forceBig && i === 0);

                spawns.push(new Scrap(
                    this.game,
                    this.worldX + Math.cos(angle) * dist,
                    this.worldY + Math.sin(angle) * dist,
                    isBig ? 'big' : 'small'
                ));
            }
        }

        // Big asteroids also split into tiny asteroids
        if (this.splitInto === 'tiny') {
            for (let i = 0; i < this.splitCount; i++) {
                const angle = Math.random() * Math.PI * 2;
                const speed = 40 + Math.random() * 80;
                const dist = Math.random() * Math.min(w, h) * 0.3;
                spawns.push(new Asteroid(
                    this.game,
                    this.worldX + Math.cos(angle) * dist,
                    this.worldY + Math.sin(angle) * dist,
                    'tiny',
                    this.vx + Math.cos(angle) * speed,
                    this.vy + Math.sin(angle) * speed,
                ));
            }
        }

        return spawns;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        if (screen.x + w < -100 || screen.x - w > this.game.width + 100 ||
            screen.y + h < -100 || screen.y - h > this.game.height + 100) return;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }

    get radius() {
        return this._nativeRadius * this.game.worldScale;
    }
}

// Spawner — creates asteroids ahead of the player in their direction of travel
export class AsteroidSpawner {
    constructor(game) {
        this.game = game;
        this.distanceAccumulator = 0;
        this.beltCooldown = 15; // Number of spawns until a belt can happen

        // Track previous player position to calculate distance moved
        this.lastPlayerX = null;
        this.lastPlayerY = null;
    }

    update(dt, playerWorldX, playerWorldY, playerVx, playerVy) {
        const spawned = [];

        if (this.lastPlayerX === null || this.lastPlayerY === null) {
            this.lastPlayerX = playerWorldX;
            this.lastPlayerY = playerWorldY;
            return spawned;
        }

        const dx = playerWorldX - this.lastPlayerX;
        const dy = playerWorldY - this.lastPlayerY;
        const distMoved = Math.sqrt(dx * dx + dy * dy);

        this.lastPlayerX = playerWorldX;
        this.lastPlayerY = playerWorldY;

        this.distanceAccumulator += distMoved;

        // Check if player has moved enough units (scaled)
        const spawnThreshold = this.game.unit(60);
        if (this.distanceAccumulator >= spawnThreshold) {
            this.distanceAccumulator -= spawnThreshold;

            // Normal asteroid spawn
            const spawnChance = Math.random();
            if (spawnChance < 0.1) {
                // Chance to spawn one normal asteroid when the 150 unit threshold is met

                // Pick size
                const roll = Math.random();
                let size;
                if (roll < 0.08) size = 'big';
                else if (roll < 0.30) size = 'tiny';
                else if (roll < 0.60) size = 'medium';
                else size = 'small';

                const halfW = this.game.width / 2;
                const halfH = this.game.height / 2;

                // Big asteroids spawn much further out
                const margin = size === 'big' ? this.game.unit(1000) : this.game.unit(800);

                // Bias spawn toward direction of travel (70% forward, 30% any edge)
                const moveAngle = Math.atan2(playerVy, playerVx);
                let ox, oy;

                if (Math.random() < 0.7) {
                    // Spawn ahead of player in their approximate direction
                    const spread = (Math.random() - 0.5) * Math.PI * 0.8;
                    const angle = moveAngle + spread;
                    const dist = Math.max(halfW, halfH) + margin;
                    ox = Math.cos(angle) * dist;
                    oy = Math.sin(angle) * dist;
                } else {
                    // Random edge
                    const edge = Math.floor(Math.random() * 4);
                    switch (edge) {
                        case 0:
                            ox = (Math.random() - 0.5) * this.game.width;
                            oy = -halfH - margin;
                            break;
                        case 1:
                            ox = halfW + margin;
                            oy = (Math.random() - 0.5) * this.game.height;
                            break;
                        case 2:
                            ox = (Math.random() - 0.5) * this.game.width;
                            oy = halfH + margin;
                            break;
                        default:
                            ox = -halfW - margin;
                            oy = (Math.random() - 0.5) * this.game.height;
                            break;
                    }
                }

                const wx = playerWorldX + ox;
                const wy = playerWorldY + oy;

                // Drift velocity
                let vx = 0, vy = 0;
                if (Math.random() > 0.3) {
                    const towardAngle = Math.atan2(-oy, -ox) + (Math.random() - 0.5) * 1.2;
                    const speed = 20 + Math.random() * 60;
                    vx = Math.cos(towardAngle) * speed;
                    vy = Math.sin(towardAngle) * speed;
                }

                spawned.push(new Asteroid(this.game, wx, wy, size, vx, vy));

                this.beltCooldown--;
                // --- Belt Spawning Logic ---
                if (this.beltCooldown <= 0) {
                    // 15% chance to spawn a belt when the cooldown is ready
                    if (Math.random() < 0.15) {
                        this.beltCooldown = 20 + Math.floor(Math.random() * 25); // Next belt check after 20-45 spawns
                        // Spawn 4-10 asteroids
                        const numAsteroids = 4 + Math.floor(Math.random() * 6);

                        const moveAngle = Math.atan2(playerVy, playerVx);
                        const spread = (Math.random() - 0.5) * Math.PI * 0.5;
                        const beltCenterAngle = moveAngle + spread;
                        const dist = Math.max(this.game.width, this.game.height) / 2 + this.game.unit(1000);

                        const beltCx = playerWorldX + Math.cos(beltCenterAngle) * dist;
                        const beltCy = playerWorldY + Math.sin(beltCenterAngle) * dist;

                        const arcStartAngle = Math.random() * Math.PI * 2;
                        const arcExtent = (Math.random() * 0.5 + 0.3) * Math.PI; // 0.3 to 0.8 PI
                        const beltRadius = this.game.unit(200 + Math.random() * 400);
                        const beltRotation = Math.random() * Math.PI * 2;

                        for (let i = 0; i < numAsteroids; i++) {
                            const t = i / (numAsteroids - 1 || 1);
                            const angle = arcStartAngle + t * arcExtent;

                            // Add some random wobble so it's not perfectly uniform
                            const wobbleX = (Math.random() - 0.5) * this.game.unit(100);
                            const wobbleY = (Math.random() - 0.5) * this.game.unit(100);

                            const ax = beltCx + Math.cos(angle + beltRotation) * beltRadius + wobbleX;
                            const ay = beltCy + Math.sin(angle + beltRotation) * beltRadius + wobbleY;

                            // Belts have a higher mix of big and medium asteroids
                            const roll = Math.random();
                            let size = 'medium';
                            if (roll < 0.05) size = 'big';
                            else if (roll < 0.15) size = 'small';
                            else if (roll < 0.65) size = 'tiny';

                            // Belt asteroids inherit a slow group drift or are relatively stationary
                            let vx = 0, vy = 0;
                            if (Math.random() > 0.5) {
                                const driftAngle = Math.random() * Math.PI * 2;
                                const speed = 10 + Math.random() * 20;
                                vx = Math.cos(driftAngle) * speed;
                                vy = Math.sin(driftAngle) * speed;
                            }

                            spawned.push(new Asteroid(this.game, ax, ay, size, vx, vy));
                        }
                    }
                }
            }
        }

        return spawned;
    }
}
