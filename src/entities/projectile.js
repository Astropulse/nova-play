// Scaling is now dynamic via game properties

// Projectile fired by ships
export class Projectile {
    constructor(game, worldX, worldY, angle, speed, spriteKey = 'blue_laser_ball', owner = null, damage = 1, lifetime = 2.0) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;
        this.alive = true;
        this.lifetime = lifetime; // seconds before despawn
        this.damage = damage;
        this.owner = owner; // Who fired this (to prevent self-damage)

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

        // Map sprite keys to glow colors
        this.glowColor = '#1da2c0ff'; // Default Blue
        if (spriteKey.includes('yellow')) this.glowColor = '#ffdd44';
        else if (spriteKey.includes('red')) this.glowColor = '#ff4444';
        else if (spriteKey.includes('green')) this.glowColor = '#44ff44';

        // Pre-render glow sprite (eliminates per-frame shadowBlur — massive perf win)
        this._glowSprite = Projectile._getGlowSprite(this.img, this.glowColor);
    }

    // Static cache: pre-renders sprite + shadow glow once per sprite/color combo
    static _glowCache = new Map();
    static _getGlowSprite(imgAsset, glowColor) {
        if (!imgAsset) return null;
        const img = imgAsset.canvas || imgAsset;
        const key = img.src || img.dataset?.key || `${img.width}x${img.height}_${glowColor}`;
        const cached = Projectile._glowCache.get(key);
        if (cached) return cached;

        // Blur in pre-scaled pixel space (prescale=4, display at worldScale/4)
        // shadowBlur = 5*worldScale in screen px = 5*4 = 20 in pre-scale px
        const blur = 20;
        const pad = blur * 2;
        const c = document.createElement('canvas');
        c.width = img.width + pad * 2;
        c.height = img.height + pad * 2;
        const gctx = c.getContext('2d');

        // Draw with shadow to create glow
        gctx.shadowBlur = blur;
        gctx.shadowColor = glowColor;
        gctx.shadowOffsetX = 0;
        gctx.shadowOffsetY = 0;
        gctx.drawImage(img, pad, pad);

        // Draw sharp image on top (no shadow)
        gctx.shadowBlur = 0;
        gctx.drawImage(img, pad, pad);

        const result = { canvas: c, pad: pad, imgW: img.width, imgH: img.height };
        Projectile._glowCache.set(key, result);
        return result;
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

        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;
        this.lifetime -= dt;

        if (this.lifetime <= 0) this.alive = false;
    }

    draw(ctx, camera) {
        if (!this.alive || !this.img) return;
        const img = this.img.canvas || this.img;
        const w = img.width * this.game.worldScale / 4;
        const h = img.height * this.game.worldScale / 4;

        ctx.save();

        // Additive blending for energy effects
        ctx.globalCompositeOperation = 'screen';

        // 1. Draw Interpolated Trail — inlined worldToScreen to avoid object allocation
        const trailSteps = 4;
        const hLen = this.historyLen;
        const hMax = this.maxHistory;
        const cw = this.game.width, ch = this.game.height;
        const ws = this.game.worldScale;
        const camX = camera.x, camY = camera.y;
        const halfCW = cw / 2 + camera.shakeX, halfCH = ch / 2 + camera.shakeY;
        const hw = w / 2, hh = h / 2;

        let prevX = this.worldX, prevY = this.worldY, prevA = this.angle;
        for (let i = 0; i < hLen; i++) {
            const idx = (this.historyHead - i + hMax) % hMax;
            const end = this.history[idx];

            for (let j = 1; j <= trailSteps; j++) {
                const stepT = j / trailSteps;
                const ix = prevX + (end.x - prevX) * stepT;
                const iy = prevY + (end.y - prevY) * stepT;

                const sx = (ix - camX) * ws + halfCW;
                const sy = (iy - camY) * ws + halfCH;
                const totalI = i + stepT;
                const alpha = 0.5 * (1 - totalI / (hLen + 1));
                const trailScale = (1 - totalI / (hLen * 3));

                ctx.save();
                ctx.globalAlpha = alpha;
                ctx.translate(sx, sy);
                ctx.rotate(end.a + Math.PI / 2);
                ctx.scale(trailScale, trailScale);
                ctx.drawImage(img, -hw, -hh, w, h);
                ctx.restore();
            }
            prevX = end.x; prevY = end.y; prevA = end.a;
        }

        // 2. Draw Main Projectile with pre-rendered glow (no per-frame shadowBlur)
        const screenX = (this.worldX - camX) * ws + halfCW;
        const screenY = (this.worldY - camY) * ws + halfCH;
        ctx.translate(screenX, screenY);
        ctx.rotate(this.angle + Math.PI / 2);
        if (this._glowSprite) {
            // Scale so the sprite portion matches original w×h exactly
            const pxScale = w / this._glowSprite.imgW;
            const gw = this._glowSprite.canvas.width * pxScale;
            const gh = this._glowSprite.canvas.height * pxScale;
            ctx.drawImage(this._glowSprite.canvas, -gw / 2, -gh / 2, gw, gh);
        } else {
            ctx.drawImage(img, -hw, -hh, w, h);
        }

        ctx.restore();
    }

    // Collision radius (game units)
    get radius() {
        if (!this.img) return 4;
        return this.img.width * 0.4;
    }
}
