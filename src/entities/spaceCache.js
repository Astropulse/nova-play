/**
 * SpaceCache — a rare loot chest that spawns in the world.
 *
 * States:
 *   CLOSED     — idle, not yet discovered
 *   FOUND      — player is within discovery radius; shows on HUD
 *   OPENING    — lid/clips flying off (world-space physics, like Rubble)
 *   OPEN       — waiting for CacheUI to be created
 *   EMPTIED    — all items taken; 2-minute despawn timer running
 *   DESPAWNING — fading out then alive=false
 */

// ─── Tunable constants ────────────────────────────────────────────────────────
export const CACHE_CONFIG = {
    // Discovery radius (world units, multiplied by fov)
    discoveryRadius: 600,

    // Interaction radius — player must be this close to press E
    interactRadius: 180,

    // Despawn N seconds after being emptied
    emptiedDespawnTime: 30,

    // Fade-out duration when despawning
    despawnFadeTime: 2.0,

    // How long the opening animation runs before transitioning to OPEN
    openAnimDuration: 0.6,

    // ── Piece physics — gravity + friction applied each frame ────────────────
    lidGravity:     500,   // downward pull (world units/sec²)
    lidFriction:    0.94,  // velocity multiplier per frame (^(dt*60))
    lidRotSpeedMax: 4.0,   // max initial spin (rad/s)

    clipGravity:    300,
    clipFriction:   0.90,
    clipRotSpeedMax: 5.0,

    // ── Extra roll settings ───────────────────────────────────────────────────
    extraRollBaseChance: 0.25,
    maxExtraRolls:       3,

    // ── Spawn settings ────────────────────────────────────────────────────────
    spawnDistThreshold: 200,
    spawnChance:        0.007,
    maxActiveCaches:    4,

    // ── Glow pulse when FOUND ─────────────────────────────────────────────────
    glowPulseSpeed: 2.2,
};

// ─── State enum ───────────────────────────────────────────────────────────────
export const CACHE_STATE = {
    CLOSED:     'closed',
    FOUND:      'found',
    OPENING:    'opening',
    OPEN:       'open',
    EMPTIED:    'emptied',
    DESPAWNING: 'despawning',
};

// ─── SpaceCache ───────────────────────────────────────────────────────────────
export class SpaceCache {
    constructor(game, worldX, worldY) {
        this.game   = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive  = true;

        this.state      = CACHE_STATE.CLOSED;
        this.stateTimer = 0;
        this.emptiedTimer = 0;
        this.alpha      = 1.0;
        this.glowTimer  = 0;
        this.cacheRotation = Math.random() * Math.PI * 2;

        // Persistent CacheUI — created on first open, reused on subsequent opens
        this._cachedUI  = null;

        // ── Flying piece state (world-space, like Rubble) ─────────────────────
        // Piece positions are placeholders; open() sets them to centroid world offsets.
        this.lidWorldX   = worldX; this.lidWorldY   = worldY;
        this.lidVX       = 0;      this.lidVY       = 0;
        this.lidRotation = 0;      this.lidRotSpeed  = 0;

        this.clip0WorldX = worldX; this.clip0WorldY = worldY;
        this.clip0VX     = 0;      this.clip0VY     = 0;
        this.clip0Rot    = 0;      this.clip0RotSpd  = 0;

        this.clip1WorldX = worldX; this.clip1WorldY = worldY;
        this.clip1VX     = 0;      this.clip1VY     = 0;
        this.clip1Rot    = 0;      this.clip1RotSpd  = 0;

        this._loadAssets();
    }

    _loadAssets() {
        this.imgClosed = this.game.assets.get('cache');    // closed chest
        this.imgBase   = this.game.assets.get('cache_0');  // base (stays)
        this.imgLid    = this.game.assets.get('cache_1');  // lid flies up
        this.imgClip0  = this.game.assets.get('cache_2');  // left clip
        this.imgClip1  = this.game.assets.get('cache_3');  // right clip

        // Compute visual-centroid offsets (offset from image bounds center to
        // centre-of-mass of non-transparent pixels) so rotation looks natural.
        this._lidCentroid   = this._computeCentroid(this.imgLid);
        this._clip0Centroid = this._computeCentroid(this.imgClip0);
        this._clip1Centroid = this._computeCentroid(this.imgClip1);
    }

    // Returns {dx, dy} in image pixels — offset from image center to visual centroid.
    // dx/dy positive = visual mass is to the right/below the image center.
    _computeCentroid(asset) {
        if (!asset) return { dx: 0, dy: 0 };
        try {
            const img = asset.canvas || asset;
            const w   = asset.width  || img.width;
            const h   = asset.height || img.height;
            if (!w || !h) return { dx: 0, dy: 0 };

            const oc  = document.createElement('canvas');
            oc.width  = w;
            oc.height = h;
            const octx = oc.getContext('2d');
            octx.drawImage(img, 0, 0, w, h);

            const data = octx.getImageData(0, 0, w, h).data;
            let sumX = 0, sumY = 0, count = 0;
            for (let py = 0; py < h; py++) {
                for (let px = 0; px < w; px++) {
                    const a = data[(py * w + px) * 4 + 3];
                    if (a > 128) { sumX += px; sumY += py; count++; }
                }
            }
            if (count === 0) return { dx: 0, dy: 0 };
            return {
                dx: sumX / count - w / 2,
                dy: sumY / count - h / 2,
            };
        } catch { return { dx: 0, dy: 0 }; }
    }

    // ── Kick off the opening animation ───────────────────────────────────────
    open() {
        if (this.state !== CACHE_STATE.FOUND && this.state !== CACHE_STATE.CLOSED) return;

        this.state      = CACHE_STATE.OPENING;
        this.stateTimer = 0;

        const C = CACHE_CONFIG;
        const R = this.cacheRotation;

        // Rotate an image-space offset by the cache's world rotation
        const rot2D = (dx, dy) => ({
            x: dx * Math.cos(R) - dy * Math.sin(R),
            y: dx * Math.sin(R) + dy * Math.cos(R),
        });

        const lc  = this._lidCentroid   || { dx: 0, dy: 0 };
        const c0  = this._clip0Centroid || { dx: 0, dy: 0 };
        const c1  = this._clip1Centroid || { dx: 0, dy: 0 };
        const lcR = rot2D(lc.dx, lc.dy);
        const c0R = rot2D(c0.dx, c0.dy);
        const c1R = rot2D(c1.dx, c1.dy);

        // Lid: 40° cone aimed along the cache's "up" direction (image-up = -PI/2, rotated by R)
        const cacheUp  = R - Math.PI / 2;
        const lidAngle = cacheUp + (Math.random() - 0.5) * (40 * Math.PI / 180);
        const lidSpeed = 220 + Math.random() * 130;

        this.lidWorldX   = this.worldX + lcR.x;
        this.lidWorldY   = this.worldY + lcR.y;
        this.lidVX       = Math.cos(lidAngle) * lidSpeed;
        this.lidVY       = Math.sin(lidAngle) * lidSpeed;
        this.lidRotation = R;
        this.lidRotSpeed = (Math.random() - 0.5) * C.lidRotSpeedMax * 2;

        // Clips: random directions, start at their rotated centroid offsets
        const c0Angle = Math.random() * Math.PI * 2;
        const c1Angle = Math.random() * Math.PI * 2;
        const cSpeed  = () => 30 + Math.random() * 100;

        this.clip0WorldX = this.worldX + c0R.x;
        this.clip0WorldY = this.worldY + c0R.y;
        this.clip0VX     = Math.cos(c0Angle) * cSpeed();
        this.clip0VY     = Math.sin(c0Angle) * cSpeed();
        this.clip0Rot    = R;
        this.clip0RotSpd = (Math.random() - 0.5) * C.clipRotSpeedMax * 2;

        this.clip1WorldX = this.worldX + c1R.x;
        this.clip1WorldY = this.worldY + c1R.y;
        this.clip1VX     = Math.cos(c1Angle) * cSpeed();
        this.clip1VY     = Math.sin(c1Angle) * cSpeed();
        this.clip1Rot    = R;
        this.clip1RotSpd = (Math.random() - 0.5) * C.clipRotSpeedMax * 2;

        this.game.sounds.play('asteroid_break', 0.7);
    }

    // ── Called by PlayingState when CacheUI is closed ────────────────────────
    close() {
        // Cache stays OPEN — player can reopen the UI by pressing E again
    }

    markEmptied() {
        if (this.state === CACHE_STATE.EMPTIED || this.state === CACHE_STATE.DESPAWNING) return;
        this.state = CACHE_STATE.EMPTIED;
        // emptiedTimer keeps counting — despawn is 30s from open, not 30s from empty
    }

    get isFound()     { return this.state !== CACHE_STATE.CLOSED; }
    get interactRange() { return CACHE_CONFIG.interactRadius; }

    // Interact prompt shown when FOUND (ready to open) or OPEN (can re-open UI)
    get canInteract() {
        return this.state === CACHE_STATE.FOUND || this.state === CACHE_STATE.OPEN;
    }

    // ── Update ────────────────────────────────────────────────────────────────
    update(dt, playerWorldX, playerWorldY) {
        if (!this.alive) return;

        const fov = (this.game.currentState?.currentFovMult) || 1.0;
        this.glowTimer += dt;
        this.stateTimer += dt;

        switch (this.state) {

            case CACHE_STATE.CLOSED: {
                const dx = playerWorldX - this.worldX;
                const dy = playerWorldY - this.worldY;
                const r  = CACHE_CONFIG.discoveryRadius * fov;
                if (dx * dx + dy * dy < r * r) {
                    this.state = CACHE_STATE.FOUND;
                    this.stateTimer = 0;
                    this.game.currentState?.triggerFlash?.('#ffcc44', 0.4, 0.15);
                    this.game.sounds.play('select', 0.35);
                }
                break;
            }

            case CACHE_STATE.FOUND:
                // Idle — player hasn't pressed E yet
                break;

            case CACHE_STATE.OPENING: {
                const C = CACHE_CONFIG;
                const friction = Math.pow(0.97, dt * 60); // matches Rubble exactly

                // ── Lid ──────────────────────────────────────────────────────
                this.lidVX       *= friction;
                this.lidVY       *= friction;
                this.lidWorldX   += this.lidVX * dt;
                this.lidWorldY   += this.lidVY * dt;
                this.lidRotation += this.lidRotSpeed * dt;
                this.lidRotSpeed *= friction;

                // ── Clips ────────────────────────────────────────────────────
                this.clip0VX     *= friction;
                this.clip0VY     *= friction;
                this.clip0WorldX += this.clip0VX * dt;
                this.clip0WorldY += this.clip0VY * dt;
                this.clip0Rot    += this.clip0RotSpd * dt;
                this.clip0RotSpd *= friction;

                this.clip1VX     *= friction;
                this.clip1VY     *= friction;
                this.clip1WorldX += this.clip1VX * dt;
                this.clip1WorldY += this.clip1VY * dt;
                this.clip1Rot    += this.clip1RotSpd * dt;
                this.clip1RotSpd *= friction;

                if (this.stateTimer >= C.openAnimDuration) {
                    this.state = CACHE_STATE.OPEN;
                    this.stateTimer = 0;
                    this.emptiedTimer = 0; // despawn clock starts now
                }
                break;
            }

            case CACHE_STATE.OPEN:
                this._driftPieces(dt);
                this.emptiedTimer += dt;
                if (this.emptiedTimer >= CACHE_CONFIG.emptiedDespawnTime) {
                    this.state = CACHE_STATE.DESPAWNING;
                    this.stateTimer = 0;
                }
                break;

            case CACHE_STATE.EMPTIED: {
                this._driftPieces(dt);
                this.emptiedTimer += dt;
                if (this.emptiedTimer >= CACHE_CONFIG.emptiedDespawnTime) {
                    this.state = CACHE_STATE.DESPAWNING;
                    this.stateTimer = 0;
                }
                break;
            }

            case CACHE_STATE.DESPAWNING: {
                this._driftPieces(dt);
                this.alpha = Math.max(0, 1 - this.stateTimer / CACHE_CONFIG.despawnFadeTime);
                if (this.stateTimer >= CACHE_CONFIG.despawnFadeTime) {
                    this.alive = false;
                }
                break;
            }
        }
    }

    // Continued drift — same friction model as Rubble
    _driftPieces(dt) {
        const friction = Math.pow(0.97, dt * 60);
        this.lidVX *= friction;  this.lidVY *= friction;
        this.lidWorldX += this.lidVX * dt;
        this.lidWorldY += this.lidVY * dt;
        this.lidRotation += this.lidRotSpeed * dt;
        this.lidRotSpeed *= friction;

        this.clip0VX *= friction; this.clip0VY *= friction;
        this.clip0WorldX += this.clip0VX * dt;
        this.clip0WorldY += this.clip0VY * dt;
        this.clip0Rot += this.clip0RotSpd * dt;
        this.clip0RotSpd *= friction;

        this.clip1VX *= friction; this.clip1VY *= friction;
        this.clip1WorldX += this.clip1VX * dt;
        this.clip1WorldY += this.clip1VY * dt;
        this.clip1Rot += this.clip1RotSpd * dt;
        this.clip1RotSpd *= friction;
    }

    // ── Draw ─────────────────────────────────────────────────────────────────
    draw(ctx, camera) {
        if (!this.alive) return;

        const ws = this.game.worldScale;
        const cw = this.game.width;
        const ch = this.game.height;

        ctx.save();
        ctx.globalAlpha *= this.alpha;

        switch (this.state) {

            case CACHE_STATE.CLOSED:
            case CACHE_STATE.FOUND: {
                if (!this.imgClosed) break;
                const s = camera.worldToScreen(this.worldX, this.worldY, cw, ch);
                if (this._offscreen(s, ws, cw, ch)) break;
                if (this.state === CACHE_STATE.FOUND) this._drawGlow(ctx, s, ws);
                this._drawSprite(ctx, this.imgClosed, s.x, s.y, ws, this.cacheRotation);
                break;
            }

            case CACHE_STATE.OPENING:
            case CACHE_STATE.OPEN:
            case CACHE_STATE.EMPTIED:
            case CACHE_STATE.DESPAWNING: {
                // Base stays at the cache world position, rotated to match
                if (this.imgBase) {
                    const s = camera.worldToScreen(this.worldX, this.worldY, cw, ch);
                    if (!this._offscreen(s, ws, cw, ch)) {
                        this._drawSprite(ctx, this.imgBase, s.x, s.y, ws, this.cacheRotation);
                    }
                }

                // Flying / resting pieces — persist until the whole cache despawns
                if (this.imgLid) {
                    const s = camera.worldToScreen(this.lidWorldX, this.lidWorldY, cw, ch);
                    if (!this._offscreen(s, ws, cw, ch)) {
                        this._drawSprite(ctx, this.imgLid, s.x, s.y, ws, this.lidRotation, this._lidCentroid);
                    }
                }
                if (this.imgClip0) {
                    const s = camera.worldToScreen(this.clip0WorldX, this.clip0WorldY, cw, ch);
                    if (!this._offscreen(s, ws, cw, ch)) {
                        this._drawSprite(ctx, this.imgClip0, s.x, s.y, ws, this.clip0Rot, this._clip0Centroid);
                    }
                }
                if (this.imgClip1) {
                    const s = camera.worldToScreen(this.clip1WorldX, this.clip1WorldY, cw, ch);
                    if (!this._offscreen(s, ws, cw, ch)) {
                        this._drawSprite(ctx, this.imgClip1, s.x, s.y, ws, this.clip1Rot, this._clip1Centroid);
                    }
                }
                break;
            }
        }

        ctx.restore();
    }

    _offscreen(s, ws, cw, ch) {
        const r = 120 * ws;
        return (s.x + r < 0 || s.x - r > cw || s.y + r < 0 || s.y - r > ch);
    }

    _drawGlow(ctx, s, ws) {
        const pulse = 0.55 + 0.45 * Math.sin(this.glowTimer * CACHE_CONFIG.glowPulseSpeed * Math.PI * 2);
        const r = 30 * ws;
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
        g.addColorStop(0,   `rgba(255, 200, 80, ${0.55 * pulse})`);
        g.addColorStop(0.4, `rgba(255, 140, 20, ${0.3  * pulse})`);
        g.addColorStop(1,   'rgba(255,100,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // centroid: {dx, dy} — offset in image pixels from bounding-box center to visual CoM.
    // We translate to (sx, sy) so that the centroid sits at the rotation origin, then draw
    // the image offset so its centroid aligns with that origin.
    // Screen positions are integer-snapped (anti-jitter) like UI panels.
    _drawSprite(ctx, asset, sx, sy, ws, rotation, centroid) {
        if (!asset) return;
        const img = asset.canvas || asset;
        const w   = (asset.width  || img.width)  * ws;
        const h   = (asset.height || img.height) * ws;
        const cdx = centroid ? centroid.dx * ws : 0;
        const cdy = centroid ? centroid.dy * ws : 0;
        ctx.save();
        // Snap to integer pixels — same anti-jitter pattern as UI panels
        ctx.translate(Math.round(sx), Math.round(sy));
        if (rotation) ctx.rotate(rotation);
        // Draw image so its centroid lands at the rotation origin (0, 0)
        // Image bounding-box center is at (-cdx, -cdy) from origin, so top-left = (-w/2-cdx, -h/2-cdy)
        ctx.drawImage(img, -w / 2 - cdx, -h / 2 - cdy, w, h);
        ctx.restore();
    }

    get radius() {
        if (!this.imgClosed) return 20;
        return Math.max(this.imgClosed.width, this.imgClosed.height) / 2;
    }

    serialize() {
        return {
            worldX: this.worldX, worldY: this.worldY,
            state: this.state, alpha: this.alpha, emptiedTimer: this.emptiedTimer,
            cacheRotation: this.cacheRotation,
            lidWorldX: this.lidWorldX, lidWorldY: this.lidWorldY, lidRotation: this.lidRotation,
            clip0WorldX: this.clip0WorldX, clip0WorldY: this.clip0WorldY, clip0Rot: this.clip0Rot,
            clip1WorldX: this.clip1WorldX, clip1WorldY: this.clip1WorldY, clip1Rot: this.clip1Rot,
        };
    }

    deserialize(data) {
        this.worldX = data.worldX; this.worldY = data.worldY;
        this.state  = data.state  || CACHE_STATE.CLOSED;
        this.alpha  = data.alpha  ?? 1.0;
        this.emptiedTimer = data.emptiedTimer || 0;
        this.cacheRotation = data.cacheRotation ?? (Math.random() * Math.PI * 2);
        this.lidWorldX  = data.lidWorldX  ?? this.worldX;
        this.lidWorldY  = data.lidWorldY  ?? this.worldY;
        this.lidRotation = data.lidRotation ?? 0;
        this.clip0WorldX = data.clip0WorldX ?? this.worldX;
        this.clip0WorldY = data.clip0WorldY ?? this.worldY;
        this.clip0Rot    = data.clip0Rot    ?? 0;
        this.clip1WorldX = data.clip1WorldX ?? this.worldX;
        this.clip1WorldY = data.clip1WorldY ?? this.worldY;
        this.clip1Rot    = data.clip1Rot    ?? 0;
        this._loadAssets();
    }
}

// ─── CacheSpawner ─────────────────────────────────────────────────────────────
export class CacheSpawner {
    constructor(game) {
        this.game = game;
        this.distAccumulator = 0;
        this.lastPlayerX = null;
        this.lastPlayerY = null;
    }

    update(playerWorldX, playerWorldY, activeCacheCount, freqMult = 1.0) {
        const spawned = [];
        if (this.lastPlayerX === null) {
            this.lastPlayerX = playerWorldX;
            this.lastPlayerY = playerWorldY;
            return spawned;
        }

        const dx = playerWorldX - this.lastPlayerX;
        const dy = playerWorldY - this.lastPlayerY;
        this.distAccumulator += Math.sqrt(dx * dx + dy * dy);
        this.lastPlayerX = playerWorldX;
        this.lastPlayerY = playerWorldY;

        const C = CACHE_CONFIG;
        if (this.distAccumulator >= C.spawnDistThreshold) {
            this.distAccumulator -= C.spawnDistThreshold;
            if (activeCacheCount < C.maxActiveCaches && Math.random() < C.spawnChance * freqMult) {
                spawned.push(this._spawnCache(playerWorldX, playerWorldY));
            }
        }
        return spawned;
    }

    _spawnCache(px, py) {
        const fov    = (this.game.currentState?.currentFovMult) || 1.0;
        const hw     = this.game.width  / 2 / this.game.worldScale;
        const hh     = this.game.height / 2 / this.game.worldScale;
        const margin = 600 * fov;
        const angle  = Math.random() * Math.PI * 2;
        const dist   = Math.max(hw, hh) + margin + Math.random() * 400;
        return new SpaceCache(this.game, px + Math.cos(angle) * dist, py + Math.sin(angle) * dist);
    }

    spawnNear(px, py, distMin = 300, distMax = 600) {
        const angle = Math.random() * Math.PI * 2;
        const dist  = distMin + Math.random() * (distMax - distMin);
        return new SpaceCache(this.game, px + Math.cos(angle) * dist, py + Math.sin(angle) * dist);
    }
}
