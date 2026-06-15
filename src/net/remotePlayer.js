// RemotePlayer — the local stand-in for another player's ship.
//
// Rendering is buffered interpolation: we hold the last ~1s of state snapshots
// and draw the ship INTERP_DELAY behind the host clock, blending between the
// two snapshots that bracket the render time. With a 30Hz send rate and a
// 100ms buffer, one dropped packet is invisible and motion stays glassy.
// Beyond the newest snapshot we extrapolate with the last velocity (dead
// reckoning) and ease back when fresh data arrives — no teleporting, no jitter.
//
// The object also doubles as a "player body" for host-side enemy AI targeting
// and for proximity checks (trading, wave centering), so it exposes the same
// worldX/worldY/vx/vy/angle/radius/shielding surface the real Player has.

import { SHIPS } from '../data/ships.js';
import { PF, INTERP_DELAY } from './protocol.js';
import { playerColor } from '../ui/chat.js';

// ── Player-color ship outlines ───────────────────────────────────────────────
// A 1-logical-pixel ring in the pilot's color, drawn behind the ship sprite so
// every ship in a lobby is identifiable at a glance. Built once per
// ship/color combo: tint the sprite's silhouette, stamp it at 8 one-pixel
// offsets — the sprite drawn on top covers the middle, leaving just the ring.
const _outlineCache = new Map();
export function getShipOutline(asset, shipId, color) {
    const key = `${shipId}|${color}`;
    let o = _outlineCache.get(key);
    if (o) return o;

    const img = asset.canvas || asset;
    const prescale = asset.prescale || 4;
    const pad = prescale; // 1 logical pixel

    const tint = document.createElement('canvas');
    tint.width = img.width;
    tint.height = img.height;
    const tctx = tint.getContext('2d');
    tctx.drawImage(img, 0, 0);
    tctx.globalCompositeOperation = 'source-in';
    tctx.fillStyle = color;
    tctx.fillRect(0, 0, tint.width, tint.height);

    const c = document.createElement('canvas');
    c.width = img.width + pad * 2;
    c.height = img.height + pad * 2;
    const cctx = c.getContext('2d');
    for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        cctx.drawImage(tint, pad + ox * pad, pad + oy * pad);
    }

    o = {
        canvas: c,
        logicalW: (asset.width || img.width) + 2,
        logicalH: (asset.height || img.height) + 2,
    };
    _outlineCache.set(key, o);
    return o;
}

// Draw an outline ring at a world position (used for the LOCAL player too).
export function drawShipOutline(ctx, game, camera, asset, shipId, color, worldX, worldY, angle) {
    if (!asset) return;
    const outline = getShipOutline(asset, shipId, color);
    const screen = camera.worldToScreen(worldX, worldY, game.width, game.height);
    const ow = outline.logicalW * game.worldScale;
    const oh = outline.logicalH * game.worldScale;
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.rotate(angle + Math.PI / 2);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(outline.canvas, -ow / 2, -oh / 2, ow, oh);
    ctx.restore();
}

export class RemotePlayer {
    constructor(game, pid, name, shipId) {
        this.game = game;
        this.pid = pid;
        this.name = name;
        this.alive = true;
        this.isRemotePlayer = true;

        this.worldX = 0;
        this.worldY = 0;
        this.vx = 0;
        this.vy = 0;
        this.angle = -Math.PI / 2;

        this.thrusting = false;
        this.shielding = false;
        this.isWarping = false;
        this.isBoosting = false;
        this.isDead = false;
        this.hasAncientCurse = false;

        this.healthFrac = 1;
        this.shieldFrac = 1;
        this.level = 0;
        this.scrap = 0;          // roster stat, synced from host

        this._buffer = [];           // snapshots sorted by t
        this._lastSnapT = -1;
        this._hasState = false;

        // Animation
        this.currentFrame = 0;
        this.frameTimer = 0;
        this.frameInterval = 0.08;

        this.setShip(shipId);
    }

    setShip(shipId) {
        this.shipId = shipId;
        this.shipData = SHIPS.find(s => s.id === shipId) || SHIPS[0];
        this.stillImg = this.game.assets.get(this.shipData.assets.still);
        this.flyingFrames = this.game.assets.get(this.shipData.assets.flying) || [];
        this.shieldImg = this.game.assets.get('shield');
        this._cachedRadius = null;
    }

    get radius() {
        if (this._cachedRadius != null) return this._cachedRadius;
        const asset = this.stillImg;
        if (!asset) return 12;
        // Sprite half-diagonal in logical pixels is a fine collision radius here.
        const w = asset.width || (asset.canvas ? asset.canvas.width : 24);
        const h = asset.height || (asset.canvas ? asset.canvas.height : 24);
        this._cachedRadius = Math.sqrt(w * w + h * h) / 2 * 0.85;
        return this._cachedRadius;
    }

    // Convenience for damage cap logic etc. (fractions are what's replicated).
    get health() { return this.healthFrac * 100; }
    get maxHealth() { return 100; }

    // Ingest one state sample (host time `t`).
    pushState(t, x, y, vx, vy, angle, flags, healthFrac, shieldFrac, level) {
        if (t <= this._lastSnapT) return; // stale/out-of-order
        this._lastSnapT = t;
        this._buffer.push({ t, x, y, vx, vy, angle });
        // Keep ~1.2s of history
        while (this._buffer.length > 2 && this._buffer[0].t < t - 1.2) this._buffer.shift();

        this.thrusting = !!(flags & PF.THRUSTING);
        this.shielding = !!(flags & PF.SHIELDING);
        this.isWarping = !!(flags & PF.WARPING);
        this.isBoosting = !!(flags & PF.BOOSTING);
        this.isDead = !!(flags & PF.DEAD);
        this.hasAncientCurse = !!(flags & PF.CURSED);
        this.healthFrac = healthFrac;
        this.shieldFrac = shieldFrac;
        this.level = level;
        this._hasState = true;
    }

    // Advance interpolation. renderT is the host-clock time we want to display.
    update(dt, renderT) {
        if (!this._hasState) return;

        const buf = this._buffer;
        if (buf.length === 0) return;

        // Find the bracketing pair around renderT.
        let a = null, b = null;
        for (let i = buf.length - 1; i >= 0; i--) {
            if (buf[i].t <= renderT) {
                a = buf[i];
                b = buf[i + 1] || null;
                break;
            }
        }

        let tx, ty, tangle;
        if (a && b) {
            const span = b.t - a.t;
            const f = span > 0.0001 ? Math.min(1, (renderT - a.t) / span) : 1;
            tx = a.x + (b.x - a.x) * f;
            ty = a.y + (b.y - a.y) * f;
            tangle = lerpAngle(a.angle, b.angle, f);
            this.vx = (b.x - a.x) / Math.max(span, 0.0001);
            this.vy = (b.y - a.y) / Math.max(span, 0.0001);
        } else {
            // Past the newest snapshot — dead-reckon from it, clamped so a
            // stalled connection doesn't fly the ghost off into space.
            const latest = buf[buf.length - 1];
            const ahead = Math.min(Math.max(0, renderT - latest.t), 0.25);
            tx = latest.x + latest.vx * ahead;
            ty = latest.y + latest.vy * ahead;
            tangle = latest.angle;
            this.vx = latest.vx;
            this.vy = latest.vy;
        }

        // First sample snaps; afterwards converge smoothly (kills micro-jitter
        // from clock noise without adding visible lag).
        if (this.worldX === 0 && this.worldY === 0 && !this._initialized) {
            this.worldX = tx; this.worldY = ty; this.angle = tangle;
            this._initialized = true;
        } else {
            const k = 1 - Math.exp(-dt * 30);
            this.worldX += (tx - this.worldX) * k;
            this.worldY += (ty - this.worldY) * k;
            let dAngle = tangle - this.angle;
            while (dAngle > Math.PI) dAngle -= Math.PI * 2;
            while (dAngle < -Math.PI) dAngle += Math.PI * 2;
            this.angle += dAngle * k;
            // Hard snap if wildly off (warp/teleport)
            const ex = tx - this.worldX, ey = ty - this.worldY;
            if (ex * ex + ey * ey > 600 * 600) {
                this.worldX = tx; this.worldY = ty; this.angle = tangle;
            }
        }

        // Thrust animation
        if (this.thrusting && this.flyingFrames.length > 1) {
            this.frameTimer -= dt;
            if (this.frameTimer <= 0) {
                this.frameTimer = this.frameInterval;
                let next;
                do {
                    next = Math.floor(Math.random() * this.flyingFrames.length);
                } while (next === this.currentFrame);
                this.currentFrame = next;
            }
        } else {
            this.currentFrame = 0;
        }
    }

    draw(ctx, camera) {
        if (!this._hasState || this.isDead) return;
        const game = this.game;
        const screen = camera.worldToScreen(this.worldX, this.worldY, game.width, game.height);

        // Cull
        if (screen.x < -200 || screen.x > game.width + 200 ||
            screen.y < -200 || screen.y > game.height + 200) return;

        let asset = (this.thrusting && this.flyingFrames.length > 0)
            ? this.flyingFrames[this.currentFrame]
            : this.stillImg;
        if (!asset) return;
        const img = asset.canvas || asset;
        const w = (asset.width || img.width) * game.worldScale;
        const h = (asset.height || img.height) * game.worldScale;

        if (!this.isWarping) {
            // Pilot-color outline ring behind the ship.
            drawShipOutline(ctx, game, camera, this.stillImg, this.shipId,
                playerColor(this.pid), this.worldX, this.worldY, this.angle);

            ctx.save();
            ctx.translate(screen.x, screen.y);
            ctx.rotate(this.angle + Math.PI / 2);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.restore();

            if (this.shielding && this.shieldImg) {
                const sw = (this.shieldImg.width || this.shieldImg.canvas.width) * game.worldScale;
                const sh = (this.shieldImg.height || this.shieldImg.canvas.height) * game.worldScale;
                ctx.save();
                ctx.globalAlpha = 0.3;
                ctx.translate(screen.x, screen.y);
                ctx.rotate(this.angle + Math.PI / 2);
                ctx.drawImage(this.shieldImg.canvas || this.shieldImg, -sw / 2, -sh / 2, sw, sh);
                ctx.restore();
            }
        }

        // Name tag (+ health sliver when hurt)
        const uiScale = game.uiScale;
        const tagY = screen.y - h / 2 - uiScale * 6;
        ctx.save();
        ctx.font = `${5 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        const tw = ctx.measureText(this.name).width;
        ctx.fillRect(screen.x - tw / 2 - uiScale, tagY - 5 * uiScale, tw + uiScale * 2, 6 * uiScale);
        ctx.fillStyle = '#9fe8ff';
        ctx.fillText(this.name, screen.x, tagY);

        if (this.healthFrac < 0.999) {
            const barW = 24 * uiScale;
            const barH = Math.max(2, Math.floor(1.2 * uiScale));
            const bx = screen.x - barW / 2;
            const by = tagY + 2 * uiScale;
            ctx.fillStyle = 'rgba(0,0,0,0.5)';
            ctx.fillRect(bx, by, barW, barH);
            ctx.fillStyle = this.healthFrac > 0.35 ? '#44ff66' : '#ff4444';
            ctx.fillRect(bx, by, barW * Math.max(0, this.healthFrac), barH);
        }
        ctx.restore();
    }
}

function lerpAngle(a, b, f) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * f;
}
