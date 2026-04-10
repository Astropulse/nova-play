export class FloatingText {
    constructor(game, worldX, worldY, text, color) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.text = text;
        this.color = color;
        this.alive = true;
        this.lifetime = 0.6 + Math.random() * 0.3; // Snappier, 0.6s to 0.9s
        this.maxLifetime = this.lifetime;

        // Spread spawn point more randomly for "impact" feel
        this.worldX += (Math.random() - 0.5) * 40;
        this.worldY += (Math.random() - 0.5) * 40;

        // Broader velocity arc and higher speed
        const angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.5; // Wider arc
        const speed = 120 + Math.random() * 80; // Much faster
        this.vx = Math.cos(angle) * speed;
        this.vy = Math.sin(angle) * speed;

        // Scale based on number magnitude: 0 -> 1x, 100 -> 2x, etc.
        const numValue = parseFloat(this.text.replace(/[^0-9.-]/g, '')) || 0;
        const magnitudeMult = 1 + (Math.abs(numValue) / 100);

        this.targetScale = (1.1 + Math.random() * 0.4) * magnitudeMult;
        this.scale = this.targetScale * 0.5; // Initial pop-in scale
    }

    update(dt) {
        this.worldX += this.vx * dt;
        this.worldY += this.vy * dt;

        // Apply light friction to slow down the float
        this.vx *= 0.96;
        this.vy *= 0.96;

        this.lifetime -= dt;
        if (this.lifetime <= 0) {
            this.alive = false;
        }

        // Animation logic
        if (this.lifetime > this.maxLifetime * 0.8) {
            // Snappier "Pop" in
            this.scale += (this.targetScale - this.scale) * dt * 25;
        } else if (this.lifetime < this.maxLifetime * 0.4) {
            // Shrink out snappier
            this.scale *= 0.92;
        }
    }

    draw(ctx, camera) {
        if (!this.alive) return;

        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const alpha = Math.min(1.0, this.lifetime / (this.maxLifetime * 0.3));

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(screen.x, screen.y);
        ctx.scale(this.scale * this.game.worldScale, this.scale * this.game.worldScale);

        // Pre-configure font
        const fontSize = 8;
        ctx.font = `${fontSize}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // 1. Draw black outline (4-pass approach for solid feel)
        ctx.fillStyle = '#000000';
        const off = 1;
        ctx.fillText(this.text, -off, 0);
        ctx.fillText(this.text, off, 0);
        ctx.fillText(this.text, 0, -off);
        ctx.fillText(this.text, 0, off);

        // 2. Draw main colored text
        ctx.fillStyle = this.color;
        ctx.fillText(this.text, 0, 0);

        ctx.restore();
    }
}
