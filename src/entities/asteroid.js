// Dynamic scaling is now handled via game.worldScale

// Asteroid sizes — maps to asset keys, stats, and split behavior
const ASTEROID_TYPES = {
    big: { keys: ['asteroid_big_0', 'asteroid_big_1', 'asteroid_big_2'], hp: 50, damage: 40, scrap: 3, splitInto: 'tiny', splitCount: 5, rubbleCount: 12 },
    medium: { keys: ['asteroid_medium_0', 'asteroid_medium_1', 'asteroid_medium_2'], hp: 30, damage: 30, scrap: 2, splitInto: 'rubble', splitCount: 0, rubbleCount: 8 },
    small: { keys: ['asteroid_small_0', 'asteroid_small_1'], hp: 20, damage: 20, scrap: 1, splitInto: 'rubble', splitCount: 0, rubbleCount: 5 },
    tiny: { keys: null, hp: 10, damage: 10, scrap: 1, splitInto: 'rubble', splitCount: 0, rubbleCount: 3 },
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
function computeCollisionRadius(asset, key) {
    if (!asset) return 10;
    if (key && _radiusCache.has(key)) return _radiusCache.get(key);

    const img = asset.canvas || asset;
    const aw = asset.width || img.width;
    const ah = asset.height || img.height;
    if (!aw) return 10;

    const canvas = document.createElement('canvas');
    canvas.width = aw;
    canvas.height = ah;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, aw, ah);

    const data = ctx.getImageData(0, 0, aw, ah).data;
    const cx = aw / 2;
    const cy = ah / 2;
    let maxDistSq = 0;

    for (let y = 0; y < ah; y++) {
        for (let x = 0; x < aw; x++) {
            const alpha = data[(y * aw + x) * 4 + 3];
            if (alpha > 30) { // opaque enough to count
                const dx = x - cx;
                const dy = y - cy;
                const distSq = dx * dx + dy * dy;
                if (distSq > maxDistSq) maxDistSq = distSq;
            }
        }
    }

    const radius = Math.sqrt(maxDistSq);
    if (key) _radiusCache.set(key, radius);
    return radius;
}

// Tiny decorrelated PRNG for cosmetic picks derived from a content seed —
// mulberry32 over (seed ^ salt) so it never advances the loot stream.
class CosmeticRNG {
    constructor(seed) {
        this._state = (seed ^ 0x5f3759df) | 0;
    }
    next() {
        this._state = (this._state + 0x6D2B79F5) | 0;
        let t = Math.imul(this._state ^ this._state >>> 15, 1 | this._state);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

// Cache for computed collision radii (native pixels, before scale scaling)
const _radiusCache = new Map();
function getCachedRadius(img, key) {
    if (_radiusCache.has(key)) return _radiusCache.get(key);
    const r = computeCollisionRadius(img);
    _radiusCache.set(key, r);
    return r;
}

/// Utility to slice a sprite into Voronoi-based shards — 'Fast' mode uses logical dimensions for speed
export class VoronoiSlicer {
    static slice(asset, numPieces) {
        if (!asset) return [];
        const img = asset.canvas || asset;

        // Use logical dimensions for high-performance scan
        const lw = asset.width || img.width;
        const lh = asset.height || img.height;
        if (!lw) return [];
        numPieces = Math.floor(numPieces);

        // 1. Get raw pixel data (Scaled to Logical size)
        const canvas = document.createElement('canvas');
        canvas.width = lw;
        canvas.height = lh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, lw, lh);
        const imgData = ctx.getImageData(0, 0, lw, lh);
        const data = imgData.data;

        // 2. Generate random seeds within the logical area
        const seeds = [];
        for (let i = 0; i < numPieces; i++) {
            seeds.push({
                x: Math.floor(lw * (0.1 + Math.random() * 0.8)),
                y: Math.floor(lh * (0.1 + Math.random() * 0.8))
            });
        }

        // 3. Partition pixels into shards based on nearest seed
        const shardData = Array.from({ length: numPieces }, () => ({
            minX: lw, minY: lh, maxX: 0, maxY: 0,
            pixels: []
        }));

        for (let y = 0; y < lh; y++) {
            for (let x = 0; x < lw; x++) {
                const idx = (y * lw + x) * 4;
                const a = data[idx + 3];
                if (a < 30) continue;

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
            if (s.pixels.length < 2) continue;

            const sw = (s.maxX - s.minX) + 1;
            const sh = (s.maxY - s.minY) + 1;
            const fragCanvas = document.createElement('canvas');
            fragCanvas.width = sw;
            fragCanvas.height = sh;
            const fragCtx = fragCanvas.getContext('2d');
            if (!fragCtx) continue;

            const fragData = fragCtx.createImageData(sw, sh);
            for (const p of s.pixels) {
                const px = p.x - s.minX;
                const py = p.y - s.minY;
                const idx = (py * sw + px) * 4;
                fragData.data[idx] = p.r;
                fragData.data[idx + 1] = p.g;
                fragData.data[idx + 2] = p.b;
                fragData.data[idx + 3] = p.a;
            }
            fragCtx.putImageData(fragData, 0, 0);

            fragments.push({
                canvas: fragCanvas,
                lx: (s.minX + sw / 2 - lw / 2),
                ly: (s.minY + sh / 2 - lh / 2)
            });
        }
        return fragments;
    }
}

// Cached death-shatter layouts, keyed by sprite asset key. Slicing a sprite
// into shards costs several ms (pixel partition + dozens of canvas allocs) —
// doing it fresh on EVERY kill caused visible frame hiccups during combat.
// The shard canvases are immutable (debris only ever draws them), so one
// layout per sprite is shared by every death; velocities/spins/rotations stay
// per-death random, which preserves nearly all the visual variety.
const _shatterCache = new Map();
export function getCachedShatter(asset, key, numPieces) {
    if (!asset) return [];
    if (key && _shatterCache.has(key)) return _shatterCache.get(key);
    const frags = VoronoiSlicer.slice(asset, numPieces);
    if (key) _shatterCache.set(key, frags);
    return frags;
}

// Module cache of persistent fracture layouts, keyed by asset + piece count.
// Every entity sharing a sprite shares one cell layout; each entity keeps its
// own removed-set, so the slice only ever runs once per sprite.
const _fractureModelCache = new Map();

// Target chunk size in logical pixels. Kept constant so a big sprite just gets
// MORE chunks rather than bigger ones — chips look the same scale everywhere.
const CHUNK_PX = 3.0;

/**
 * A persistent Voronoi "chip" layout for a sprite. Unlike the death shatter
 * (which slices a sprite into flying shards on destruction), this pre-computes
 * a fixed set of small cells once per asset. Only the cells on the sprite's
 * silhouette (its "shell") can break off, so hits erode the surface a little
 * rather than taking deep bites — and lasers can never bore through to the core.
 */
export class FractureModel {
    static get(asset, key) {
        if (!asset) return null;
        let model = _fractureModelCache.get(key);
        if (model === undefined) {
            model = new FractureModel(asset);
            if (!model.cells.length) model = null;
            _fractureModelCache.set(key, model);
        }
        return model;
    }

    // Single-pass build: ONE pixel readback of the sprite, partition + edge
    // detection done directly on that buffer, then one small canvas per cell.
    // (The previous implementation ran VoronoiSlicer and then re-read every
    // cell canvas with getImageData — up to 320 synchronous readbacks, a
    // 100ms+ frame stall the first time each sprite got shot.)
    constructor(asset) {
        const img = asset.canvas || asset;
        this.lw = asset.width || img.width;
        this.lh = asset.height || img.height;
        // Physical (prescaled) dimensions — composite at this resolution so a
        // chipped sprite matches the crispness of the un-chipped one exactly.
        this.pw = img.width;
        this.ph = img.height;
        this.prescale = asset.prescale || (this.lw ? img.width / this.lw : 1);

        const lw = this.lw, lh = this.lh;

        // Piece count scales with area → constant chunk size regardless of object.
        const numPieces = Math.max(12, Math.min(320, Math.round((lw * lh) / (CHUNK_PX * CHUNK_PX))));

        // One readback at logical resolution.
        const canvas = document.createElement('canvas');
        canvas.width = lw;
        canvas.height = lh;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, lw, lh);
        const data = ctx.getImageData(0, 0, lw, lh).data;

        // Alpha map for edge detection.
        const map = new Uint8Array(lw * lh);
        for (let i = 0; i < map.length; i++) map[i] = data[i * 4 + 3] > 30 ? 1 : 0;

        // Seeds + per-pixel nearest-seed partition, edge-flagging as we go.
        const seeds = [];
        for (let i = 0; i < numPieces; i++) {
            seeds.push({
                x: Math.floor(lw * (0.1 + Math.random() * 0.8)),
                y: Math.floor(lh * (0.1 + Math.random() * 0.8)),
            });
        }
        const shards = Array.from({ length: numPieces }, () => ({
            minX: lw, minY: lh, maxX: 0, maxY: 0, count: 0, edge: false, pixels: [],
        }));
        for (let y = 0; y < lh; y++) {
            for (let x = 0; x < lw; x++) {
                if (!map[y * lw + x]) continue;
                let minD = Infinity, nearest = 0;
                for (let i = 0; i < numPieces; i++) {
                    const dx = x - seeds[i].x, dy = y - seeds[i].y;
                    const d = dx * dx + dy * dy;
                    if (d < minD) { minD = d; nearest = i; }
                }
                const s = shards[nearest];
                if (x < s.minX) s.minX = x;
                if (y < s.minY) s.minY = y;
                if (x > s.maxX) s.maxX = x;
                if (y > s.maxY) s.maxY = y;
                s.count++;
                s.pixels.push(x, y);
                // Silhouette test straight off the alpha map.
                if (!s.edge) {
                    if (x === 0 || y === 0 || x === lw - 1 || y === lh - 1 ||
                        !map[(y - 1) * lw + x] || !map[(y + 1) * lw + x] ||
                        !map[y * lw + (x - 1)] || !map[y * lw + (x + 1)]) {
                        s.edge = true;
                    }
                }
            }
        }

        // Describe cells WITHOUT creating canvases. Canvas elements are the
        // expensive part (320 DOM allocations ≈ 40-150ms); a cell only needs a
        // real canvas once it actually breaks off or gets erased from the
        // composite — a handful per hit — so they materialize lazily in
        // ensureCanvas() from the retained sprite pixels.
        this._spriteData = data;
        const cells = [];
        let maxDist = 1;
        let edgeCount = 0;
        for (const s of shards) {
            if (s.count < 2) continue;
            const cw = (s.maxX - s.minX) + 1;
            const ch = (s.maxY - s.minY) + 1;
            const cell = {
                canvas: null,
                w: cw,
                h: ch,
                pixels: Uint16Array.from(s.pixels),
                lx: (s.minX + cw / 2 - lw / 2),
                ly: (s.minY + ch / 2 - lh / 2),
                ox: s.minX,
                oy: s.minY,
                edge: s.edge,
            };
            cell.dist = Math.hypot(cell.lx, cell.ly);
            if (cell.edge) edgeCount++;
            if (cell.dist > maxDist) maxDist = cell.dist;
            cells.push(cell);
        }
        this.cells = cells;
        this.maxDist = maxDist;
        // Only the silhouette shell is ever removable → surface damage only.
        this.maxRemovable = edgeCount;
    }

    // Create a cell's canvas on first use (break-off debris / composite erase).
    ensureCanvas(cell) {
        if (cell.canvas) return cell.canvas;
        const lw = this.lw;
        const data = this._spriteData;
        const cellCanvas = document.createElement('canvas');
        cellCanvas.width = cell.w;
        cellCanvas.height = cell.h;
        const ctx = cellCanvas.getContext('2d');
        const cellData = ctx.createImageData(cell.w, cell.h);
        const px = cell.pixels;
        for (let p = 0; p < px.length; p += 2) {
            const x = px[p], y = px[p + 1];
            const src = (y * lw + x) * 4;
            const dst = ((y - cell.oy) * cell.w + (x - cell.ox)) * 4;
            cellData.data[dst] = data[src];
            cellData.data[dst + 1] = data[src + 1];
            cellData.data[dst + 2] = data[src + 2];
            cellData.data[dst + 3] = data[src + 3];
        }
        ctx.putImageData(cellData, 0, 0);
        cell.canvas = cellCanvas;
        return cellCanvas;
    }
}

/**
 * Per-entity hull damage state: which cells of a FractureModel have broken off,
 * plus a cached composite canvas (source sprite with the broken cells erased).
 * Shared by asteroids (chip on hit) and the player ship (chip tied to health).
 */
export class HullFracture {
    constructor(model) {
        this.model = model;
        this.removed = [];          // ordered list of removed cell indices
        this._removedSet = new Set();
        this._composite = null;
        this._compositeVer = -1;
        this._compositeSrc = null;
        this.version = 0;           // bumps whenever the removed-set changes
    }

    get count() { return this.removed.length; }

    // Break off up to `count` of the nearest shell (silhouette) cells to local
    // point (lx, ly). Returns the removed cell objects (for spawning debris).
    chipNear(lx, ly, count) {
        const m = this.model;
        const taken = [];
        for (let n = 0; n < count; n++) {
            if (this.removed.length >= m.maxRemovable) break;
            let best = -1, bestD = Infinity;
            for (let i = 0; i < m.cells.length; i++) {
                if (this._removedSet.has(i)) continue;
                const c = m.cells[i];
                if (!c.edge) continue;
                const dx = c.lx - lx, dy = c.ly - ly;
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = i; }
            }
            if (best < 0) break;
            this._removedSet.add(best);
            this.removed.push(best);
            m.ensureCanvas(m.cells[best]); // debris + composite need the bitmap
            taken.push(m.cells[best]);
        }
        if (taken.length) this.version++;
        return taken;
    }

    // Nearest shell cell to a local point (regardless of removal) — used to spawn
    // a transient impact spark when a hit doesn't break anything new off.
    nearestOuterCell(lx, ly) {
        const m = this.model;
        let best = null, bestD = Infinity;
        for (const c of m.cells) {
            if (!c.edge) continue;
            const dx = c.lx - lx, dy = c.ly - ly;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; best = c; }
        }
        if (best) m.ensureCanvas(best);
        return best;
    }

    // Put back the innermost-removed cell (fills in from the core outward as the
    // ship heals). Returns true if a cell was restored.
    restoreOne() {
        if (!this.removed.length) return false;
        let bestPos = 0, bestDist = Infinity;
        for (let p = 0; p < this.removed.length; p++) {
            const d = this.model.cells[this.removed[p]].dist;
            if (d < bestDist) { bestDist = d; bestPos = p; }
        }
        const idx = this.removed.splice(bestPos, 1)[0];
        this._removedSet.delete(idx);
        this.version++;
        return true;
    }

    // Source sprite frame with the broken cells erased. Cached per (frame,
    // removed-version) so it only re-composites when something actually changes.
    composite(sourceAsset) {
        const srcImg = sourceAsset.canvas || sourceAsset;
        if (this._composite && this._compositeVer === this.version && this._compositeSrc === srcImg) {
            return this._composite;
        }
        const m = this.model;
        const s = m.prescale;
        let cv = this._composite;
        if (!cv) { cv = document.createElement('canvas'); cv.width = m.pw; cv.height = m.ph; this._composite = cv; }
        const ctx = cv.getContext('2d');
        ctx.clearRect(0, 0, m.pw, m.ph);
        ctx.imageSmoothingEnabled = false;
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(srcImg, 0, 0, srcImg.width, srcImg.height, 0, 0, m.pw, m.ph);
        // Erase broken cells at physical resolution (cell masks are logical, so
        // upscale them by prescale — nearest-neighbor lines up with the sprite).
        ctx.globalCompositeOperation = 'destination-out';
        for (const idx of this.removed) {
            const c = m.cells[idx];
            const cellCanvas = m.ensureCanvas(c);
            ctx.drawImage(cellCanvas, 0, 0, cellCanvas.width, cellCanvas.height,
                c.ox * s, c.oy * s, cellCanvas.width * s, cellCanvas.height * s);
        }
        ctx.globalCompositeOperation = 'source-over';
        this._compositeVer = this.version;
        this._compositeSrc = srcImg;
        return cv;
    }
}

/**
 * Build a flying-debris piece from a fractured cell, ejected outward from the
 * parent's center. `rotation` is the parent's draw rotation (so the shard keeps
 * the orientation it had while attached).
 */
export function ejectChipDebris(game, worldX, worldY, rotation, baseVx, baseVy, cell, shortLife = false) {
    const cosA = Math.cos(rotation), sinA = Math.sin(rotation);
    const wox = cell.lx * cosA - cell.ly * sinA;
    const woy = cell.lx * sinA + cell.ly * cosA;
    const outAngle = Math.atan2(woy, wox);
    const spread = 40 + Math.random() * 70;
    const life = shortLife ? (0.18 + Math.random() * 0.15) : (0.3 + Math.random() * 0.4);
    return new ProceduralDebris(
        game,
        worldX + wox, worldY + woy,
        cell.canvas,
        (baseVx || 0) * 0.4 + Math.cos(outAngle) * spread,
        (baseVy || 0) * 0.4 + Math.sin(outAngle) * spread,
        rotation,
        (Math.random() - 0.5) * 6,
        life
    );
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
        const currentFriction = Math.pow(0.97, dt * 60);
        this.vx *= currentFriction;
        this.vy *= currentFriction;
        this.lifetime -= dt;
        if (this.lifetime <= 0) this.alive = false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        const alpha = Math.max(0, this.lifetime / this.maxLifetime);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(sx, sy);
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }
}

// ProceduralDebris — similar to Rubble but uses a passed-in canvas/image (used for ship breakup)
export class ProceduralDebris {
    constructor(game, worldX, worldY, img, vx, vy, rotation, spin, lifetime = null, noFade = false) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.img = img;
        this.vx = vx;
        this.vy = vy;
        this.rotation = rotation;
        this.spin = spin;
        this.alive = true;
        this.lifetime = lifetime !== null ? lifetime : (0.4 + Math.random() * 0.4);
        this.maxLifetime = this.lifetime;
        this.noFade = noFade;
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.spin * dt;
        const currentFriction = Math.pow(0.99, dt * 60);
        this.vx *= currentFriction;
        this.vy *= currentFriction;
        this.lifetime -= dt;
        if (this.lifetime <= 0) this.alive = false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);

        // Culling
        if (screen.x < -100 || screen.x > this.game.width + 100 ||
            screen.y < -100 || screen.y > this.game.height + 100) return;

        // Logical scale by default now
        const canvas = this.img.canvas || this.img;
        const w = canvas.width * this.game.worldScale;
        const h = canvas.height * this.game.worldScale;

        const alpha = this.noFade ? 1.0 : Math.max(0, this.lifetime / this.maxLifetime);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.rotation);

        // Fast rendering mode: no smoothing during shard draw
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, -w / 2, -h / 2, w, h);
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
        this.magnetRange = 150;
        this.collectRange = 20;

        this.lifetime = 120; // 2 minutes
        this.maxLifetime = this.lifetime;
        this.suckTimer = 0;
    }

    update(dt, playerX, playerY, magnetMult = 1.0) {
        const dx = playerX - this.worldX;
        const dy = playerY - this.worldY;
        const distSq = dx * dx + dy * dy;

        const activeMagnetRange = this.magnetRange * magnetMult;

        if (distSq < activeMagnetRange * activeMagnetRange) {
            const dist = Math.sqrt(distSq);
            this.suckTimer += dt;
            const dtFactor = dt * 60;
            const suckFactor = 1.0 + this.suckTimer * 0.8; // Faster growth

            // Magnetize to player (use normalized dx/dy instead of atan2+cos+sin)
            const invDist = dist > 0 ? 1 / dist : 0;
            const nx = dx * invDist;
            const ny = dy * invDist;
            const force = (1 - dist / activeMagnetRange) * 1500 * suckFactor;
            this.vx += nx * force * dt;
            this.vy += ny * force * dt;

            // Steering: Pivot velocity vector toward player to kill orbiting
            const steerWeight = Math.min(0.95, (0.2 + this.suckTimer * 1.2) * dtFactor);
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            const targetVx = nx * speed;
            const targetVy = ny * speed;
            this.vx = this.vx * (1 - steerWeight) + targetVx * steerWeight;
            this.vy = this.vy * (1 - steerWeight) + targetVy * steerWeight;

            // Damping logic (dt-compensated, target 0.95 at dt=1/6)
            const damping = Math.pow(0.995, dt * 60);
            this.vx *= damping;
            this.vy *= damping;
        } else {
            this.suckTimer = 0;
            // Normal drift with light friction (dt-compensated)
            const currentFriction = Math.pow(0.99, dt * 60);
            this.vx *= currentFriction;
            this.vy *= currentFriction;
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
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        if (sx + w < -50 || sx - w > this.game.width + 50 ||
            sy + h < -50 || sy - h > this.game.height + 50) return;

        let alpha = 1.0;
        if (this.lifetime < 5.0) {
            alpha = Math.max(0, this.lifetime / 5.0);
        }

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(sx, sy);
        ctx.rotate(this.rotation);
        ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }
}

/**
 * Physical item pickup that drifts and magnetizes to player
 */
// Items the player has already touched but couldn't accept (full inventory)
// stop vacuuming and instead follow the player on a short leash, then despawn.
const ITEM_FOLLOW_DESPAWN = 30.0;
const ITEM_FOLLOW_FLASH_START = 10.0; // seconds before despawn to begin flashing

export class ItemPickup {
    constructor(game, worldX, worldY, item, pickupDelay = 0) {
        if (!item) {
            console.warn('ItemPickup created with undefined item at', worldX, worldY);
            return;
        }
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

        this.magnetRange = 200;
        this.collectRange = 30;
        this.suckTimer = 0;
        this.pickupDelay = pickupDelay;

        // Follow-leash state (engaged once the player touches the item but
        // can't pick it up — e.g. inventory full)
        this.encountered = false;
        this.followTimer = 0;
        this.followOffsetX = 0;
        this.followOffsetY = 0;
    }

    // Engage the follow-leash + despawn timer. Capture a stable offset so the
    // item trails the player from roughly where it was when contact happened.
    markEncountered(playerX, playerY) {
        if (this.encountered) return;
        this.encountered = true;
        this.followTimer = 0;
        // Clamp offset to a sensible leash distance so it stays visible
        let ox = this.worldX - playerX;
        let oy = this.worldY - playerY;
        const len = Math.sqrt(ox * ox + oy * oy);
        const leash = 40;
        if (len > leash && len > 0) {
            ox = (ox / len) * leash;
            oy = (oy / len) * leash;
        } else if (len < 1) {
            const a = Math.random() * Math.PI * 2;
            ox = Math.cos(a) * leash;
            oy = Math.sin(a) * leash;
        }
        this.followOffsetX = ox;
        this.followOffsetY = oy;
    }

    update(dt, playerX, playerY, magnetMult = 1.0) {
        if (this.pickupDelay > 0) {
            this.pickupDelay -= dt;
            const currentFriction = Math.pow(0.98, dt * 60);
            this.vx *= currentFriction;
            this.vy *= currentFriction;
            this.worldX += this.vx * dt;
            this.worldY += this.vy * dt;
            this.rotation += this.rotSpeed * dt;
            return;
        }

        if (this.encountered) {
            // The leash only drops on a genuine boost/blink: playingState feeds
            // dummy (-99999) coords while warping, which trips the break check
            // below. Normal flight — even at high upgraded speed — stays leashed
            // so the item never flip-flops between follow and vacuum, which is
            // what produced the jerky motion.
            const ldx = playerX - this.worldX;
            const ldy = playerY - this.worldY;
            const breakDist = 1000;
            if (ldx * ldx + ldy * ldy > breakDist * breakDist) {
                this.encountered = false;
                this.followTimer = 0;
                this.suckTimer = 0;
                // Fall through to vacuum logic below.
            } else {
                this.followTimer += dt;
                if (this.followTimer >= ITEM_FOLLOW_DESPAWN) {
                    this.alive = false;
                    return;
                }
                // Critically-damped spring toward the leash point (exact Juckett
                // integration). Carries the inbound vacuum velocity through the
                // hand-off so there's no sudden stop, and tracks the moving player
                // smoothly with no overshoot or oscillation.
                const targetX = playerX + this.followOffsetX;
                const targetY = playerY + this.followOffsetY;
                const omega = 12; // stiffness; higher = tighter, snappier follow
                const e = Math.exp(-omega * dt);

                const px = this.worldX - targetX;
                const detX = (this.vx + omega * px) * dt;
                this.worldX = targetX + (px + detX) * e;
                this.vx = (this.vx - omega * detX) * e;

                const py = this.worldY - targetY;
                const detY = (this.vy + omega * py) * dt;
                this.worldY = targetY + (py + detY) * e;
                this.vy = (this.vy - omega * detY) * e;

                this.rotation += this.rotSpeed * dt;
                return;
            }
        }

        const dx = playerX - this.worldX;
        const dy = playerY - this.worldY;
        const distSq = dx * dx + dy * dy;

        const activeMagnetRange = this.magnetRange * magnetMult;

        if (distSq < activeMagnetRange * activeMagnetRange) {
            const dist = Math.sqrt(distSq);
            this.suckTimer += dt;
            const dtFactor = dt * 60;
            const suckFactor = 1.0 + this.suckTimer * 0.8;

            const invDist = dist > 0 ? 1 / dist : 0;
            const nx = dx * invDist;
            const ny = dy * invDist;
            const force = (1 - dist / activeMagnetRange) * 1800 * suckFactor;
            this.vx += nx * force * dt;
            this.vy += ny * force * dt;

            // Steering Logic
            const steerWeight = Math.min(0.95, (0.2 + this.suckTimer * 1.5) * dtFactor);
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            const targetVx = nx * speed;
            const targetVy = ny * speed;
            this.vx = this.vx * (1 - steerWeight) + targetVx * steerWeight;
            this.vy = this.vy * (1 - steerWeight) + targetVy * steerWeight;

            // Damping logic
            const damping = Math.pow(0.95, dt * 60);
            this.vx *= damping;
            this.vy *= damping;
        } else {
            this.suckTimer = 0;
            const currentFriction = Math.pow(0.98, dt * 60);
            this.vx *= currentFriction;
            this.vy *= currentFriction;
        }

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;
    }

    // Returns true if the item should be hidden this frame because it's
    // mid-flash during the pre-despawn warning window.
    _isFlashOff() {
        if (!this.encountered) return false;
        const remaining = ITEM_FOLLOW_DESPAWN - this.followTimer;
        if (remaining > ITEM_FOLLOW_FLASH_START) return false;
        // Accelerate flash rate as we approach despawn: ~0.5 Hz at 10s out
        // (one slow blink every 2s), ramping up to ~3 Hz at zero.
        const t = 1 - remaining / ITEM_FOLLOW_FLASH_START;
        const hz = 0.5 + t * 2.5;
        return Math.floor(this.followTimer * hz * 2) % 2 === 1;
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            itemId: this.item.id,
            vx: this.vx,
            vy: this.vy,
            rotation: this.rotation,
            rotSpeed: this.rotSpeed,
            pickupDelay: this.pickupDelay
        };
    }

    draw(ctx, camera) {
        if (!this.alive) return;
        if (this._isFlashOff()) return;
        const frame = this.game.getAnimationFrame(this.assetKey);
        if (!frame) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = (frame.width || 16) * this.game.worldScale;
        const h = (frame.height || 16) * this.game.worldScale;

        if (screen.x + w < -50 || screen.x - w > this.game.width + 50 ||
            screen.y + h < -50 || screen.y - h > this.game.height + 50) return;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.rotation);

        // Items are slightly larger in the world than their UI versions
        const renderScale = 1.2;
        ctx.drawImage(frame.canvas || frame, -w * renderScale / 2, -h * renderScale / 2, w * renderScale, h * renderScale);

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

        // Spawn-time content seed: this asteroid's loot (scrap counts/types,
        // splits) is fixed now, independent of when/if it's later destroyed, so
        // kill order can't desync rewards. Falls back to Math.random() outside a
        // run (game.rng null — tutorial/menu). See engine/rng.js.
        if (game.rng) {
            const d = game.rng.deriveEntity('asteroids');
            this.contentRng = d.rng;
            this.contentSeed = d.seed;
        } else {
            this.contentRng = null;
            this.contentSeed = null;
        }

        // Cosmetic picks (sprite variant, rotation, spin) derive from a side
        // stream off the content seed — NOT from contentRng, so the loot draw
        // sequence is unchanged. Seeding these makes the same asteroid use the
        // same PNG and pose on every machine in multiplayer (and per-seed in
        // single player). Falls back to Math.random() outside a run.
        const cosmetic = this.contentSeed != null ? new CosmeticRNG(this.contentSeed) : null;
        const cr = () => cosmetic ? cosmetic.next() : Math.random();

        this.assetKey = type.keys[Math.floor(cr() * type.keys.length)];
        this.img = game.assets.get(this.assetKey);

        // Collision radius from actual opaque shape
        this._nativeRadius = getCachedRadius(this.img, this.assetKey);

        // Velocity
        this.vx = vx;
        this.vy = vy;

        // Slow rotation
        this.rotation = cr() * Math.PI * 2;
        this.rotSpeed = (cr() - 0.5) * 1.5;
        this.highlightRed = false;

        // Despawn if very far from player
        const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;
        this.despawnDist = 4500 * fov;
        this.tractorCooldown = 0;
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;
        if (this.tractorCooldown > 0) this.tractorCooldown -= dt;
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
            assetKey: this.assetKey,
            contentSeed: this.contentSeed
        };
    }

    hit(damage) {
        this.hp -= damage;

        if (this.game.currentState && this.game.currentState.spawnFloatingText) {
            this.game.currentState.spawnFloatingText(this.worldX, this.worldY, `-${Math.ceil(damage)}`, '#ff4444');
        }

        if (this.hp <= 0) {
            this.alive = false;
            return true;
        }
        return false;
    }

    onCollision(player) {
    }

    // Lazily build this asteroid's persistent fracture layout (only asteroids
    // that actually get shot pay for the slice).
    _ensureFracture() {
        if (this._fx !== undefined) return this._fx;
        const model = FractureModel.get(this.img, this.assetKey);
        this._fx = model ? new HullFracture(model) : null;
        return this._fx;
    }

    // Break a few outer cells off near a non-lethal hit point and return the
    // ejected debris. Hitbox is unaffected — this is purely cosmetic.
    chipHit(hitWorldX, hitWorldY) {
        const fx = this._ensureFracture();
        if (!fx) return [];
        // 1 world unit == 1 logical pixel, so the local hit maps straight onto
        // cell coordinates after undoing the asteroid's rotation.
        const dx = hitWorldX - this.worldX;
        const dy = hitWorldY - this.worldY;
        const a = -this.rotation;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);

        const count = 1 + (Math.random() < 0.5 ? 1 : 0);
        const cells = fx.chipNear(lx, ly, count);
        const debris = [];
        for (const c of cells) {
            debris.push(ejectChipDebris(this.game, this.worldX, this.worldY, this.rotation, this.vx, this.vy, c));
        }
        // Even when the rim near the hit is already gone, throw a small spark so
        // every laser hit reads as connecting.
        if (!cells.length) {
            const c = fx.nearestOuterCell(lx, ly);
            if (c) debris.push(ejectChipDebris(this.game, this.worldX, this.worldY, this.rotation, this.vx, this.vy, c, true));
        }
        return debris;
    }

    _generateProceduralDebris() {
        if (!this.img || !this.img.width) return [];

        // Scale number of pieces based on asteroid size. The layout is cached
        // per sprite (see getCachedShatter) so kills don't re-slice mid-combat.
        let numPieces = 32; // Default (Medium)
        if (this.size === 'big') numPieces = 60;
        else if (this.size === 'small') numPieces = 22;
        else if (this.size === 'tiny') numPieces = 14;
        const shards = getCachedShatter(this.img, this.assetKey, numPieces);
        const debris = [];

        for (const shard of shards) {
            const cosA = Math.cos(this.rotation);
            const sinA = Math.sin(this.rotation);

            const worldOffX = (shard.lx * cosA - shard.ly * sinA);
            const worldOffY = (shard.lx * sinA + shard.ly * cosA);

            const outAngle = Math.atan2(worldOffY, worldOffX);
            const spread = 30 + Math.random() * 50;
            const vx = this.vx * 0.5 + Math.cos(outAngle) * spread;
            const vy = this.vy * 0.5 + Math.sin(outAngle) * spread;

            debris.push(new ProceduralDebris(
                this.game,
                this.worldX + worldOffX,
                this.worldY + worldOffY,
                shard,
                vx, vy,
                this.rotation,
                (Math.random() - 0.5) * 4
            ));
        }
        return debris;
    }

    // Returns array of new entities to spawn on death
    getSpawnOnDeath() {
        // Gameplay rolls (drop chance, scrap counts/types, split placement) use
        // this asteroid's spawn-time content RNG so they're reproducible. Scatter
        // positions of rubble/scrap stay on Math.random() (visual only).
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();

        const spawns = this._generateProceduralDebris();

        // Always spawn rubble spread across the asteroid's shape
        const w = this.img ? this.img.width : 20;
        const h = this.img ? this.img.height : 20;
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
        // Multiplayer: the host stamps _killerDrillMult with the killer's drill
        // multiplier before rolling loot, so a teammate's drill build pays out
        // for their kills too. Falls back to the local player (single player).
        const drillMult = this._killerDrillMult
            ?? (this.game.currentState?.player ? this.game.currentState.player.asteroidDrillMult : 1.0);
        // Base 80% drop chance scaled by drill. The chance can exceed 100%: each full
        // 1.0 is a guaranteed scrap roll, the leftover fraction is a probabilistic roll,
        // so overflow past 100% keeps adding scrap instead of being wasted.
        const dropChance = 0.8 * drillMult;
        let drops = Math.floor(dropChance);
        if (rand() < dropChance - drops) drops++;

        if (drops > 0) {
            let count = 0;
            let forceBig = false;

            for (let d = 0; d < drops; d++) {
                if (this.size === 'big') {
                    count += 2 + Math.floor(rand() * 3);
                } else if (this.size === 'medium') {
                    count += rand() < 0.4 ? 2 : 1; // 40% chance for 2 scrap
                    if (rand() < 0.1) forceBig = true; // 10% chance for a big scrap
                } else {
                    count += 1;
                }
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

        // Big asteroids also split into tiny asteroids — these are new gameplay
        // entities, so their placement/velocity is seeded for reproducibility.
        if (this.splitInto === 'tiny') {
            for (let i = 0; i < this.splitCount; i++) {
                const angle = rand() * Math.PI * 2;
                const speed = 15 + rand() * 45;
                const dist = rand() * Math.min(w, h) * 0.3;
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
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        if (sx + w < -100 || sx - w > this.game.width + 100 ||
            sy + h < -100 || sy - h > this.game.height + 100) return;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(this.rotation);

        if (this.highlightRed) {
            ctx.shadowBlur = 15 * this.game.worldScale;
            ctx.shadowColor = '#ff4444';
        }

        // Once chipped, draw the composited sprite (logical-size, broken cells
        // erased) instead of the full sprite.
        const src = (this._fx && this._fx.count > 0) ? this._fx.composite(this.img) : (this.img.canvas || this.img);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    get radius() {
        return this._nativeRadius;
    }
}

/**
 * Experience orb dropped by enemies
 */
export class ExpOrb {
    constructor(game, worldX, worldY, amount = 5) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.amount = amount;
        this.alive = true;

        this.assetKey = 'exp';
        // GIF frames are handled by game.getAnimationFrame

        // Initial pop velocity (More exploding, more drama)
        const angle = Math.random() * Math.PI * 2;
        const speed = 350 + Math.random() * 450;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;

        this.rotation = Math.random() * Math.PI * 2;
        this.rotSpeed = (Math.random() - 0.5) * 4;

        this.collectRange = 18; // Closer pickup as requested
        this.suckTimer = 0;
        this.vacuumDelay = 0.2 + Math.random() * 0.3; // Randomized delay

        // Wave/Wobble properties
        this.wobbleFreq = 4 + Math.random() * 4;
        this.wobbleAmp = 100 + Math.random() * 150;
        this.wobbleOffset = Math.random() * Math.PI * 2;
        this.time = 0;

        // Animation variety
        this.animOffset = Math.random() * 1000; // Start at random time
        this.frameDuration = 40 + Math.random() * 30; // 40ms to 70ms per frame

        // Trail history
        this.history = [];
        this.maxHistory = 6;
    }

    update(dt, playerX, playerY) {
        this.time += dt;

        const dx = playerX - this.worldX;
        const dy = playerY - this.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const invDist = dist > 0 ? 1 / dist : 0;
        const nx = dx * invDist;
        const ny = dy * invDist;

        // ExpOrbs vacuum to player after a small delay
        this.suckTimer += dt;
        const pullProgress = Math.max(0, (this.suckTimer - this.vacuumDelay) * 1.5);
        const dtFactor = dt * 60;
        const suckFactor = 1.0 + pullProgress * 2.5;

        // Base force increases as it gets closer and with time
        const force = 1200 * suckFactor * (this.suckTimer < this.vacuumDelay ? 0.05 : 1.0);

        // Add wavy movement perpendicular to the pull direction (perpX=-ny, perpY=nx)
        const wobble = Math.sin(this.time * this.wobbleFreq + this.wobbleOffset) * this.wobbleAmp;

        this.vx += (nx * force + -ny * wobble) * dt;
        this.vy += (ny * force + nx * wobble) * dt;

        // More aggressive steering to prevent orbiting
        const steerWeight = Math.min(0.98, (0.3 + this.suckTimer * 2.0) * dtFactor);
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        const targetVx = nx * speed;
        const targetVy = ny * speed;
        this.vx = this.vx * (1 - steerWeight) + targetVx * steerWeight;
        this.vy = this.vy * (1 - steerWeight) + targetVy * steerWeight;

        // Damping
        const damping = Math.pow(0.94, dt * 60);
        this.vx *= damping;
        this.vy *= damping;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.rotation += this.rotSpeed * dt;

        // Update trail history (ring buffer)
        if (!this._histHead) this._histHead = 0;
        this._histHead = (this._histHead + 1) % this.maxHistory;
        const slot = this.history[this._histHead];
        if (slot) { slot.x = this.worldX; slot.y = this.worldY; slot.r = this.rotation; }
        else { this.history[this._histHead] = { x: this.worldX, y: this.worldY, r: this.rotation }; }
        if (this._histLen === undefined) this._histLen = 0;
        if (this._histLen < this.maxHistory) this._histLen++;
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            vx: this.vx,
            vy: this.vy,
            amount: this.amount,
            rotation: this.rotation,
            rotSpeed: this.rotSpeed,
            suckTimer: this.suckTimer,
            time: this.time
        };
    }

    // Per-frame glow cache: maps each GIF frame canvas to its pre-rendered glow
    // (avoids thrashing when orbs have different animation offsets)
    static _glowFrameCache = new Map();
    static _glowBlur = 15;
    static _glowPad = 30; // blur * 2

    static _getGlowForFrame(drawFrame) {
        let entry = ExpOrb._glowFrameCache.get(drawFrame);
        if (entry) return entry;

        const blur = ExpOrb._glowBlur;
        const pad = ExpOrb._glowPad;
        const c = document.createElement('canvas');
        c.width = drawFrame.width + pad * 2;
        c.height = drawFrame.height + pad * 2;
        const gctx = c.getContext('2d');
        gctx.shadowBlur = blur;
        gctx.shadowColor = '#915dbf';
        gctx.drawImage(drawFrame, pad, pad);
        gctx.shadowBlur = 0;
        gctx.drawImage(drawFrame, pad, pad);

        entry = { canvas: c, srcW: drawFrame.width };
        ExpOrb._glowFrameCache.set(drawFrame, entry);
        return entry;
    }

    draw(ctx, camera) {
        if (!this.alive) return;

        const asset = this.game.assets.get(this.assetKey);
        if (!asset || !Array.isArray(asset)) return;

        const frameIndex = Math.floor((this.time * 1000 + this.animOffset) / this.frameDuration) % asset.length;
        const frameData = asset[frameIndex];
        const frame = frameData.canvas || frameData;

        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const w = (frameData.width || 12) * this.game.worldScale;
        const h = (frameData.height || 12) * this.game.worldScale;

        if (sx + w < -100 || sx - w > this.game.width + 100 ||
            sy + h < -100 || sy - h > this.game.height + 100) return;

        ctx.save();
        ctx.globalCompositeOperation = 'screen';

        // Draw Trail — inlined worldToScreen
        const hLen = this._histLen || 0;
        const hMax = this.maxHistory;
        const wtsS = camera.wtsScale, wtsOX = camera.wtsOffX, wtsOY = camera.wtsOffY;
        for (let i = 0; i < hLen; i++) {
            const idx = (this._histHead - i + hMax) % hMax;
            const pos = this.history[idx];
            if (!pos) continue;
            const tsx = pos.x * wtsS + wtsOX;
            const tsy = pos.y * wtsS + wtsOY;
            const alpha = 0.4 * (1 - i / hLen);
            const scale = (1 - i / (hLen * 1.5));

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(tsx, tsy);
            ctx.scale(scale, scale);
            ctx.drawImage(frame, -w / 2, -h / 2, w, h);
            ctx.restore();
        }

        // Main orb with pre-rendered glow (cached per GIF frame, shared across all orbs)
        ctx.translate(sx, sy);
        const spawnScale = Math.min(1.0, this.suckTimer * 5.0);
        ctx.scale(spawnScale, spawnScale);

        const drawFrame = frame.canvas || frame;
        const glow = ExpOrb._getGlowForFrame(drawFrame);
        const pxScale = w / glow.srcW;
        const glowW = glow.canvas.width * pxScale;
        const glowH = glow.canvas.height * pxScale;
        ctx.drawImage(glow.canvas, -glowW / 2, -glowH / 2, glowW, glowH);

        ctx.restore();
    }
}

/**
 * Nudge a spawn position so it doesn't overlap any existing asteroid or enemy.
 * Mutates and returns {x, y}. Uses the candidate's radius for clearance.
 */
export function resolveSpawnOverlap(game, x, y, radius, padding = 20) {
    const state = game.currentState;
    if (!state) return { x, y };
    const entities = [];
    if (state.asteroids) entities.push(...state.asteroids);
    if (state.enemies) entities.push(...state.enemies);

    for (const e of entities) {
        if (!e.alive) continue;
        const dx = x - e.worldX;
        const dy = y - e.worldY;
        const distSq = dx * dx + dy * dy;
        const minDist = (radius + (e.radius || 0) + padding);
        if (distSq < minDist * minDist) {
            // Push candidate away from the overlapping entity
            const dist = Math.sqrt(distSq) || 1;
            const push = minDist - dist + 1;
            x += (dx / dist) * push;
            y += (dy / dist) * push;
        }
    }
    return { x, y };
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

    update(dt, playerWorldX, playerWorldY, playerVx, playerVy, spawnMult = 1.0) {
        const spawned = [];

        // Seeded asteroid stream drives spawn chance/size/position/drift so the
        // field is reproducible along the same flight path. Tiny cosmetic belt
        // wobble stays on Math.random(). Falls back outside a run.
        const R = this.game.rng ? this.game.rng.asteroids : null;
        const rand = () => R ? R.next() : Math.random();

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
        const spawnThreshold = 60;
        if (this.distanceAccumulator >= spawnThreshold) {
            this.distanceAccumulator -= spawnThreshold;

            const fov = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;

            // Normal asteroid spawn
            const spawnChance = rand();
            if (spawnChance < 0.1 * spawnMult * fov) {
                // Chance to spawn one normal asteroid

                // Pick size
                const roll = rand();
                let size;
                if (roll < 0.08) size = 'big';
                else if (roll < 0.30) size = 'tiny';
                else if (roll < 0.60) size = 'medium';
                else size = 'small';

                const halfW = this.game.width / 2 / this.game.worldScale;
                const halfH = this.game.height / 2 / this.game.worldScale;

                // Big asteroids spawn much further out
                const margin = (size === 'big' ? 800 : 500) * fov;

                // Bias spawn toward direction of travel (70% forward, 30% any edge)
                const moveAngle = Math.atan2(playerVy, playerVx);
                let ox, oy;

                if (rand() < 0.7) {
                    // Spawn ahead of player in their approximate direction
                    const spread = (rand() - 0.5) * Math.PI * 0.8;
                    const angle = moveAngle + spread;
                    const dist = Math.max(halfW, halfH) + margin;
                    ox = Math.cos(angle) * dist;
                    oy = Math.sin(angle) * dist;
                } else {
                    // Random edge
                    const edge = Math.floor(rand() * 4);
                    switch (edge) {
                        case 0:
                            ox = (rand() - 0.5) * this.game.width / this.game.worldScale;
                            oy = -halfH - margin;
                            break;
                        case 1:
                            ox = halfW + margin;
                            oy = (rand() - 0.5) * this.game.height / this.game.worldScale;
                            break;
                        case 2:
                            ox = (rand() - 0.5) * this.game.width / this.game.worldScale;
                            oy = halfH + margin;
                            break;
                        default:
                            ox = -halfW - margin;
                            oy = (rand() - 0.5) * this.game.height / this.game.worldScale;
                            break;
                    }
                }

                let wx = playerWorldX + ox;
                let wy = playerWorldY + oy;

                // Drift velocity
                let vx = 0, vy = 0;
                if (rand() > 0.3) {
                    const towardAngle = Math.atan2(-oy, -ox) + (rand() - 0.5) * 1.2;
                    const speed = 10 + rand() * 30;
                    vx = Math.cos(towardAngle) * speed;
                    vy = Math.sin(towardAngle) * speed;
                }

                const ast = new Asteroid(this.game, wx, wy, size, vx, vy);
                const resolved = resolveSpawnOverlap(this.game, wx, wy, ast.radius);
                ast.worldX = resolved.x;
                ast.worldY = resolved.y;
                spawned.push(ast);

                this.beltCooldown--;
                // --- Belt Spawning Logic ---
                if (this.beltCooldown <= 0) {
                    // 15% chance to spawn a belt when the cooldown is ready
                    if (rand() < 0.15) {
                        this.beltCooldown = 20 + Math.floor(rand() * 25); // Next belt check after 20-45 spawns
                        // Spawn 4-10 asteroids
                        const numAsteroids = 4 + Math.floor(rand() * 6);

                        const moveAngle = Math.atan2(playerVy, playerVx);
                        const spread = (rand() - 0.5) * Math.PI * 0.5;
                        const beltCenterAngle = moveAngle + spread;
                        const dist = Math.max(this.game.width, this.game.height) / 2 / this.game.worldScale + 1000;

                        const beltCx = playerWorldX + Math.cos(beltCenterAngle) * dist;
                        const beltCy = playerWorldY + Math.sin(beltCenterAngle) * dist;

                        const arcStartAngle = rand() * Math.PI * 2;
                        const arcExtent = (rand() * 0.5 + 0.3) * Math.PI; // 0.3 to 0.8 PI
                        const beltRadius = 200 + rand() * 400;
                        const beltRotation = rand() * Math.PI * 2;

                        for (let i = 0; i < numAsteroids; i++) {
                            const t = i / (numAsteroids - 1 || 1);
                            const angle = arcStartAngle + t * arcExtent;

                            // Add some random wobble so it's not perfectly uniform
                            // (cosmetic position jitter — stays on Math.random())
                            const wobbleX = (Math.random() - 0.5) * 100;
                            const wobbleY = (Math.random() - 0.5) * 100;

                            const ax = beltCx + Math.cos(angle + beltRotation) * beltRadius + wobbleX;
                            const ay = beltCy + Math.sin(angle + beltRotation) * beltRadius + wobbleY;

                            // Belts have a higher mix of big and medium asteroids
                            const roll = rand();
                            let size = 'medium';
                            if (roll < 0.05) size = 'big';
                            else if (roll < 0.15) size = 'small';
                            else if (roll < 0.65) size = 'tiny';

                            // Belt asteroids inherit a slow group drift or are relatively stationary
                            let vx = 0, vy = 0;
                            if (rand() > 0.5) {
                                const driftAngle = rand() * Math.PI * 2;
                                const speed = 10 + rand() * 20;
                                vx = Math.cos(driftAngle) * speed;
                                vy = Math.sin(driftAngle) * speed;
                            }

                            const beltAst = new Asteroid(this.game, ax, ay, size, vx, vy);
                            const beltResolved = resolveSpawnOverlap(this.game, ax, ay, beltAst.radius);
                            beltAst.worldX = beltResolved.x;
                            beltAst.worldY = beltResolved.y;
                            spawned.push(beltAst);
                        }
                    }
                }
            }
        }

        return spawned;
    }
}
