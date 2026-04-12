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

        // Trail & Glow
        this.history = [];
        this.maxHistory = 2; // Keep it tight: only a few frames of history

        // Map sprite keys to glow colors
        this.glowColor = '#1da2c0ff'; // Default Blue
        if (spriteKey.includes('red')) this.glowColor = '#ff4444';
        else if (spriteKey.includes('green')) this.glowColor = '#44ff44';
    }

    update(dt) {
        // Record trail history (Capture position BEFORE moving for a true trail)
        this.history.unshift({ x: this.worldX, y: this.worldY, a: this.angle });
        if (this.history.length > this.maxHistory) this.history.pop();

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
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const img = this.img.canvas || this.img;
        const w = img.width * this.game.worldScale / 4;
        const h = img.height * this.game.worldScale / 4;

        ctx.save();

        // Additive blending for energy effects
        ctx.globalCompositeOperation = 'lighter';

        // 1. Draw Interpolated Trail (Tight streak)
        const trailSteps = 5;
        for (let i = 0; i < this.history.length; i++) {
            const start = (i === 0) ? { x: this.worldX, y: this.worldY, a: this.angle } : this.history[i - 1];
            const end = this.history[i];

            for (let j = 1; j <= trailSteps; j++) {
                const stepT = j / trailSteps;
                const ix = start.x * (1 - stepT) + end.x * stepT;
                const iy = start.y * (1 - stepT) + end.y * stepT;
                const ia = start.a;

                const tScreen = camera.worldToScreen(ix, iy, this.game.width, this.game.height);
                const totalI = i + stepT;
                const alpha = 0.5 * (1 - totalI / (this.history.length + 1));
                const trailScale = (1 - totalI / (this.history.length * 3));

                ctx.save();
                ctx.globalAlpha = Math.max(0, alpha);
                ctx.translate(tScreen.x, tScreen.y);
                ctx.rotate(ia + Math.PI / 2);
                ctx.scale(trailScale, trailScale);
                ctx.drawImage(img, -w / 2, -h / 2, w, h);
                ctx.restore();
            }
        }

        // 2. Draw Main Projectile with Bloom
        // Tight bloom: fixed value for clarity
        ctx.shadowBlur = 5 * this.game.worldScale;
        ctx.shadowColor = this.glowColor;

        ctx.translate(screen.x, screen.y);
        ctx.rotate(this.angle + Math.PI / 2);
        ctx.drawImage(img, -w / 2, -h / 2, w, h);

        ctx.restore();
    }

    // Collision radius (game units)
    get radius() {
        if (!this.img) return 4;
        return this.img.width * 0.4;
    }
}
