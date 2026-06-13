// Scaling is now dynamic via game properties

// Projectile fired by ships
export class Projectile {
    constructor(game, worldX, worldY, angle, speed, spriteKey = 'blue_laser_ball', owner = null, damage = 1, lifetime = 2.0) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this._prevX = worldX; // start of the current frame's travel (swept collision)
        this._prevY = worldY;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.alive = true;
        this.lifetime = lifetime; // seconds before despawn
        this.damage = damage;
        this.owner = owner; // Who fired this (to prevent self-damage)
        this.spriteKey = spriteKey; // kept for multiplayer replication

        // One-shot image for the laser ball
        this.img = game.assets.get(spriteKey);
        this.angle = angle;

        this.isRocket = false;
        this.target = null;
        this.turnRate = 4.0;

        // Trail & Glow (ring buffer)
        this.history = new Array(2);
        this.historyLen = 0;
        this.historyHead = 0;  // points to newest entry
        this.maxHistory = 2; // Keep it tight: only a few frames of history

        // Laser color for the stroked streak (drawn in _drawBody — no sprite).
        this.glowColor = '#1da2c0ff'; // Default Blue
        if (spriteKey.includes('yellow')) this.glowColor = '#ffdd44';
        else if (spriteKey.includes('red')) this.glowColor = '#ff4444';
        else if (spriteKey.includes('green')) this.glowColor = '#44ff44';
    }

    update(dt) {
        // Record trail history (ring buffer — no array shifting)
        this.historyHead = (this.historyHead + 1) % this.maxHistory;
        const slot = this.history[this.historyHead];
        if (slot) { slot.x = this.worldX; slot.y = this.worldY; slot.a = this.angle; }
        else { this.history[this.historyHead] = { x: this.worldX, y: this.worldY, a: this.angle }; }
        if (this.historyLen < this.maxHistory) this.historyLen++;

        if (this.target && this.target.alive && (!this.owner || (this.owner.alive && this.owner.state !== 'dying'))) {
            const desiredAngle = Math.atan2(this.target.worldY - this.worldY, this.target.worldX - this.worldX);
            let diff = desiredAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += diff * Math.min(1, this.turnRate * dt);
            const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            this.vx = Math.cos(this.angle) * speed;
            this.vy = Math.sin(this.angle) * speed;
        }

        // Remember where this frame's travel started so collision can sweep the
        // whole segment (prev → current) — at low fps a fast shot covers a big
        // gap per frame and a point-only test tunnels through small targets.
        this._prevX = this.worldX;
        this._prevY = this.worldY;

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.lifetime -= dt;

        if (this.lifetime <= 0) this.alive = false;
    }

    // Standalone draw: brackets the additive 'screen' blend the body needs.
    // The hot projectile loop in PlayingState instead sets 'screen' ONCE for the
    // whole batch and calls _drawBody per projectile, so a busy frame pays one
    // composite-op state change (which flushes the 2D batch) instead of one per
    // shot. Pixel-identical either way.
    draw(ctx, camera) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        this._drawBody(ctx, camera);
        ctx.restore();
    }

    // Render body WITHOUT the save/composite/restore wrapper. Only valid inside
    // a 'screen' composite context (draw() above, or the batched loop). Uses
    // absolute screen coords with NO transform, so it leaves no transform state
    // that would leak between batched projectiles.
    //
    // The laser is drawn as a simple stroked streak — a wide faint colored line
    // (glow) + a thin bright core + a round head — instead of a motion-blur
    // stack of sprite quads and a big pre-baked glow blit. For fast-moving shots
    // this reads the same, but it's ~3 cheap vector ops per projectile instead
    // of up to 9 image draws + a large translucent glow fill, which is the
    // dominant projectile draw cost when a wave fills the screen with fire.
    _drawBody(ctx, camera) {
        if (!this.alive) return;
        const ws = this.game.worldScale;
        const camX = camera.x, camY = camera.y;
        const halfCW = this.game.width / 2 + camera.shakeX;
        const halfCH = this.game.height / 2 + camera.shakeY;

        if (!this.img) return;
        const hx = (this.worldX - camX) * ws + halfCW;
        const hy = (this.worldY - camY) * ws + halfCH;
        const img = this.img.canvas || this.img;
        // Display size matches the original sprite (prescale 4 → /4).
        const w = img.width * ws / 4;
        const h = img.height * ws / 4;

        // 1. Tapered trail — a filled triangle that's full width at the head and
        // narrows to a POINT at the tail (the oldest retained history position),
        // so it reads as a real comet streak, not a fixed-width bar. Two stacked
        // tapers: a wide colored glow + a narrower white-hot core. Plain fills
        // (no per-shot gradient), and the additive 'screen' blend makes them glow.
        const hLen = this.historyLen, hMax = this.maxHistory;
        if (hLen > 0) {
            const idx = (this.historyHead - (hLen - 1) + hMax) % hMax;
            const tail = this.history[idx];
            if (tail) {
                const tx = (tail.x - camX) * ws + halfCW;
                const ty = (tail.y - camY) * ws + halfCH;
                const dx = hx - tx, dy = hy - ty;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len > 1) {
                    const nx = -dy / len, ny = dx / len; // unit perpendicular
                    const glowHW = w * 0.5;  // half-width at head — colored glow
                    const coreHW = w * 0.13; // half-width at head — faint center
                    // Colored glow taper — soft/translucent so it reads as a
                    // fading wisp behind the bolt, not a solid wedge.
                    ctx.globalAlpha = 0.4;
                    ctx.fillStyle = this.glowColor;
                    ctx.beginPath();
                    ctx.moveTo(hx + nx * glowHW, hy + ny * glowHW);
                    ctx.lineTo(hx - nx * glowHW, hy - ny * glowHW);
                    ctx.lineTo(tx, ty);
                    ctx.closePath();
                    ctx.fill();
                    // Thin, subtle lighter center — just a hint, not a white bar.
                    ctx.globalAlpha = 0.3;
                    ctx.fillStyle = '#ffffff';
                    ctx.beginPath();
                    ctx.moveTo(hx + nx * coreHW, hy + ny * coreHW);
                    ctx.lineTo(hx - nx * coreHW, hy - ny * coreHW);
                    ctx.lineTo(tx, ty);
                    ctx.closePath();
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }
            }
        }

        // 2. Core — the real laser sprite, drawn LAST (on top of the trail) and
        // at full opacity so it stays the crisp bright bolt, with the faded
        // tapered streak sitting behind it.
        const ma = this.angle + Math.PI / 2;
        const mc = Math.cos(ma), msn = Math.sin(ma);
        ctx.setTransform(mc, msn, -msn, mc, hx, hy);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    // Collision radius (game units)
    get radius() {
        if (!this.img) return 4;
        return this.img.width * 0.4;
    }
}
