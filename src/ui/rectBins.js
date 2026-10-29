// RectBins — per-colour batching of opaque pixel rects (the screen-space
// counterpart of ImpactFX._px/_flush). Rects are collected per fillStyle and
// emitted as ONE path + ONE fill per colour.
//
// Only use for rects drawn at globalAlpha 1 with 'source-over' and integer-
// aligned coordinates: then same-colour overlaps are identical to drawing
// them one by one. (At alpha < 1 or under 'lighter' a merged overlap is
// covered once instead of twice — draw those directly.) Flushing reorders
// DIFFERENT colours relative to each other; callers flush at any point where
// painter order against other draws matters (blend/alpha changes).
// Arrays are reused frame to frame: no per-frame allocation once warm.

export class RectBins {
    constructor(maxColors = 256) {
        this.map = new Map();
        this.any = false;
        this.maxColors = maxColors;
    }

    add(col, x, y, w, h) {
        let b = this.map.get(col);
        if (!b) {
            if (this.map.size >= this.maxColors) this.map.clear();
            b = { col, a: [], n: 0 };
            this.map.set(col, b);
        }
        const a = b.a, n = b.n;
        a[n] = x; a[n + 1] = y; a[n + 2] = w; a[n + 3] = h;
        b.n = n + 4;
        this.any = true;
    }

    flush(ctx) {
        if (!this.any) return;
        this.any = false;
        for (const b of this.map.values()) {
            const n = b.n;
            if (!n) continue;
            const a = b.a;
            ctx.fillStyle = b.col;
            ctx.beginPath();
            for (let k = 0; k < n; k += 4) ctx.rect(a[k], a[k + 1], a[k + 2], a[k + 3]);
            ctx.fill();
            b.n = 0;
        }
    }
}
