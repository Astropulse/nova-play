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
    }

    update(dt) {
        if (this.target && this.target.alive) {
            const desiredAngle = Math.atan2(this.target.worldY - this.worldY, this.target.worldX - this.worldX);
            let diff = desiredAngle - this.angle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            this.angle += diff * Math.min(1, 4.0 * dt);
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
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        ctx.rotate(this.angle + Math.PI / 2);
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
        ctx.restore();
    }

    // Collision radius (game units)
    get radius() {
        if (!this.img) return 4;
        return this.img.width * 0.4;
    }
}
