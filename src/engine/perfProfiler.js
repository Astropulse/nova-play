/**
 * PerfProfiler — High-accuracy per-component timing for dev mode.
 *
 * Usage:
 *   profiler.begin('asteroids');
 *   // ... work ...
 *   profiler.end('asteroids');
 *
 *   // At end of frame:
 *   profiler.commitFrame();   // Seals the current frame sample and rolls the buffer
 *
 *   // In draw:
 *   profiler.draw(ctx, x, y, w, h);
 */
export class PerfProfiler {
    constructor() {
        // How many seconds of history to keep
        this.historySeconds = 5;

        // Target sample rate — record every frame.
        // 1800 = 5s @360fps ceiling; used only as ring buffer size, not display size.
        this.maxSamples = 1800;

        // Ring buffer of frame samples.
        // Each entry is a Map<componentName, ms>
        this._ring = [];
        this._ringHead = 0;
        this._ringCount = 0;

        // In-flight timing for the current frame
        this._pending = new Map(); // name -> startTime
        this._current = new Map(); // name -> accumulated ms this frame

        // Ordered list of component names for consistent legend & stacking
        this.components = [
            'player',
            'asteroids',
            'enemies',
            'boss',
            'projectiles',
            'collisions',
            'world',
            'particles',
            'misc',
        ];

        // Color palette — one per component, in order above
        this._colors = [
            '#44ddff', // player      — cyan
            '#aaaaaa', // asteroids   — grey
            '#ff4444', // enemies     — red
            '#ff8800', // boss        — orange
            '#ffff44', // projectiles — yellow
            '#ff44ff', // collisions  — magenta
            '#44ff88', // world       — green
            '#4488ff', // particles   — blue
            '#888888', // misc        — dim grey
        ];

        // Map for O(1) color lookup
        this._colorMap = new Map();
        for (let i = 0; i < this.components.length; i++) {
            this._colorMap.set(this.components[i], this._colors[i] || '#ffffff');
        }
    }

    /** Start timing a component. Nested calls for the same name accumulate. */
    begin(name) {
        this._pending.set(name, performance.now());
    }

    /** Stop timing a component and accumulate into the current frame. */
    end(name) {
        const start = this._pending.get(name);
        if (start === undefined) return;
        const elapsed = performance.now() - start;
        this._pending.delete(name);
        const prev = this._current.get(name) || 0;
        this._current.set(name, prev + elapsed);
    }

    /**
     * Seal the current frame, write it to the ring buffer, and reset.
     * Call this once per frame, after all begin/end pairs are done.
     */
    commitFrame() {
        // Snapshot current frame data with wall-clock timestamp
        const sample = { data: new Map(this._current), t: performance.now() };

        if (this._ringCount < this.maxSamples) {
            this._ring.push(sample);
            this._ringCount++;
            this._ringHead = this._ringCount - 1;
        } else {
            this._ringHead = (this._ringHead + 1) % this.maxSamples;
            this._ring[this._ringHead] = sample;
        }

        // Reset for next frame
        this._current.clear();
        this._pending.clear();
    }

    /**
     * Draw the stacked bar chart into the given screen rectangle.
     * x/y/w/h define the TOTAL panel box — all content is clipped inside it.
     *
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} x       Left edge (screen px)
     * @param {number} y       Top edge (screen px)
     * @param {number} w       Panel width (screen px)
     * @param {number} h       Panel height (screen px)
     * @param {number} uiScale Game's UI scale (used only for swatch sizes)
     */
    draw(ctx, x, y, w, h, uiScale = 1) {
        if (this._ringCount === 0) return;

        // Clamp all content to panel bounds — nothing escapes
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();

        // ---- Background ----
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // ---- Layout ----
        // Legend row at the bottom, fixed pixel height independent of uiScale
        const LEGEND_H = Math.max(14, Math.round(h * 0.14)); // ~14% of panel height
        const PADDING   = Math.max(2, Math.round(h * 0.025));
        const graphY    = y + PADDING;
        const graphH    = h - LEGEND_H - PADDING * 3; // bars region
        const legendY   = graphY + graphH + PADDING * 2;

        // ---- Font — fixed px sizes, capped so they fit ----
        const labelFontPx  = Math.max(10, Math.min(13, Math.round(h * 0.07)));
        const axisFontPx   = Math.max(9,  Math.min(11, Math.round(h * 0.055)));

        // ---- Y-axis guide lines ----
        const MAX_MS = 50;
        const msLines = [
            { ms: 8.33,  label: '120fps', color: 'rgba(0,255,0,0.30)' },
            { ms: 16.67, label: '60fps',  color: 'rgba(255,255,0,0.40)' },
            { ms: 33.33, label: '30fps',  color: 'rgba(255,80,80,0.40)' },
        ];

        ctx.font = `${axisFontPx}px monospace`;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';

        for (const { ms, label, color } of msLines) {
            const lineY = graphY + graphH - (ms / MAX_MS) * graphH;
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x + 1, lineY);
            ctx.lineTo(x + w - 1, lineY);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = color;
            ctx.fillText(label, x + PADDING, lineY - 1);
        }

        // ---- Bars — time-windowed, always live ----
        // Collect only samples within the last historySeconds of wall-clock time.
        // Walk backwards from the newest sample so the rightmost bar is always "now".
        const windowMs    = this.historySeconds * 1000;
        const now         = performance.now();
        const viewSamples = []; // chronological, oldest first

        for (let i = 0; i < this._ringCount; i++) {
            const offset = (this._ringHead - i + this.maxSamples) % this.maxSamples;
            const s = this._ring[offset];
            if (!s) break;
            if (now - s.t > windowMs) break;  // older than window → stop
            viewSamples.unshift(s);            // prepend to keep chronological order
        }

        if (viewSamples.length === 0) {
            ctx.restore();
            return;
        }

        // Each sample maps to barW pixels. barW ≥ 1 so bars are always visible.
        const barW = Math.max(1, w / viewSamples.length);

        for (let i = 0; i < viewSamples.length; i++) {
            const sample = viewSamples[i].data;
            const bx     = x + i * barW;
            let stackMs  = 0;

            for (const name of this.components) {
                const ms = sample.get(name) || 0;
                if (ms <= 0) continue;

                const barBottom = graphY + graphH - (stackMs / MAX_MS) * graphH;
                const segH      = Math.min((ms / MAX_MS) * graphH, barBottom - graphY);
                if (segH < 0.5) { stackMs += ms; continue; }

                ctx.fillStyle = this._colorMap.get(name) || '#ffffff';
                ctx.fillRect(
                    Math.floor(bx),
                    Math.floor(barBottom - segH),
                    Math.max(1, Math.ceil(barW)),
                    Math.ceil(segH)
                );

                stackMs += ms;
            }
        }

        // ---- Latest frame total (top-right) ----
        const latestSample = viewSamples[viewSamples.length - 1];
        if (latestSample) {
            let total = 0;
            for (const v of latestSample.data.values()) total += v;
            ctx.font = `${labelFontPx}px monospace`;
            ctx.textBaseline = 'top';
            ctx.textAlign = 'right';
            ctx.fillStyle = total > 33.33 ? '#ff4444' : (total > 16.67 ? '#ffff44' : '#00ff00');
            ctx.fillText(`${total.toFixed(2)}ms`, x + w - PADDING, y + PADDING);
        }

        // ---- Legend — check bounds BEFORE drawing each item ----
        const swatchSz  = Math.max(6, Math.round(LEGEND_H * 0.4));
        const swatchGap = Math.max(3, Math.round(swatchSz * 0.5));
        ctx.font = `${axisFontPx}px monospace`;
        ctx.textBaseline = 'middle';
        const midLegendY = legendY + LEGEND_H * 0.5;

        let lx = x + PADDING;
        const rightLimit = x + w - PADDING;

        for (const name of this.components) {
            const color  = this._colorMap.get(name);
            const label  = name.toUpperCase();
            const textW  = ctx.measureText(label).width;
            const itemW  = swatchSz + swatchGap + textW + PADDING;

            // Skip if this item won't fit
            if (lx + itemW > rightLimit) break;

            // Swatch
            ctx.fillStyle = color;
            ctx.fillRect(lx, midLegendY - swatchSz / 2, swatchSz, swatchSz);

            // Label
            ctx.fillStyle = '#dddddd';
            ctx.textAlign = 'left';
            ctx.fillText(label, lx + swatchSz + swatchGap, midLegendY);

            lx += itemW;
        }

        ctx.restore();
    }

    /** Returns the color for a given component name (for external labeling). */
    colorOf(name) {
        return this._colorMap.get(name) || '#ffffff';
    }
}
