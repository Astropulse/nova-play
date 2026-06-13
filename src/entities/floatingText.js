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
        const magnitudeMult = 1 + Math.pow(Math.abs(numValue), 0.5) / 10; // Power scaling for diminishing returns

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

        const ws = this.game.worldScale;
        const sx = this.worldX * camera.wtsScale + camera.wtsOffX;
        const sy = this.worldY * camera.wtsScale + camera.wtsOffY;
        const alpha = Math.min(1.0, this.lifetime / (this.maxLifetime * 0.3));

        // The text + 4-pass outline never changes for a given (string, color,
        // size) — re-rasterizing it with 5 custom-font fillText calls every
        // frame (×~42 frames of life) is pure waste. Render it ONCE into a small
        // canvas, cached globally so repeated numbers (and every other instance)
        // reuse it, then blit. Pixel-identical at the rendered size; the pop-in /
        // shrink animation just scales the blit.
        const glyph = FloatingText._getGlyph(this.text, this.color, this.targetScale * ws);
        const s = (this.scale * ws) / glyph.renderScale;

        ctx.globalAlpha = alpha;
        ctx.setTransform(s, 0, 0, s, sx, sy);
        ctx.drawImage(glyph.canvas, -glyph.cx, -glyph.cy);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
    }

    // Global cache of pre-rendered outlined glyphs, keyed by text + color +
    // size-bucket. Bounded LRU-ish (oldest evicted) so memory stays small even
    // across a long run of distinct damage numbers.
    static _getGlyph(text, color, renderScale) {
        // Bucket the size so continuously-varying targetScale doesn't explode
        // the cache; the blit scale below corrects for the small bucket delta.
        const bucket = Math.max(0.5, Math.round(renderScale * 2) / 2);
        const key = `${text}|${color}|${bucket}`;
        let cache = FloatingText._glyphCache;
        if (!cache) cache = FloatingText._glyphCache = new Map();
        let g = cache.get(key);
        if (g) return g;

        const fontSize = 8;
        const px = fontSize * bucket;
        const m = FloatingText._measureCtx || (FloatingText._measureCtx = document.createElement('canvas').getContext('2d'));
        m.font = `${px}px Astro4x`;
        const tw = Math.ceil(m.measureText(text).width);
        const off = bucket; // 1 logical outline unit at this size
        const pad = Math.ceil(off + 1);
        const cw = Math.max(1, tw + pad * 2);
        const ch = Math.max(1, Math.ceil(px + pad * 2));
        const canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        const c = canvas.getContext('2d');
        c.font = `${px}px Astro4x`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        const cx = cw / 2, cy = ch / 2;
        c.fillStyle = '#000000';
        c.fillText(text, cx - off, cy);
        c.fillText(text, cx + off, cy);
        c.fillText(text, cx, cy - off);
        c.fillText(text, cx, cy + off);
        c.fillStyle = color;
        c.fillText(text, cx, cy);

        g = { canvas, cx, cy, renderScale: bucket };
        // Bound the cache: drop the oldest entry once it gets large.
        if (cache.size >= 256) { const first = cache.keys().next().value; cache.delete(first); }
        cache.set(key, g);
        return g;
    }
}
