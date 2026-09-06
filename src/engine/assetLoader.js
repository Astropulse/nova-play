// Asset loader — loads and caches images and GIF animations
import { decodeGif } from './gifDecoder.js';

// ── Animation surface budget ────────────────────────────────────────────────
// Every atlas animation frame is a separate prescaled canvas (4x width AND
// height = 16x the native pixel area: a 256x256 frame is a 4 MiB surface).
// Materializing a whole animation on first get() used to create all of those
// in one update/draw (a 16-frame boss idle = 64 MiB in one frame) and keep
// them forever. Frames are descriptors whose `canvas` materializes on first
// access. The working set is driven by what consumers actually READ:
//   * a consumer read of frame i marks THAT frame used and queues one
//     lookahead frame (i+1, or i-1 when the reads are running backwards) for
//     tick() to build ahead of its deadline. A prefetched frame is never
//     itself a "read": it neither queues the next frame nor refreshes any
//     consumer last-use, so one access can never warm a whole animation.
//     Several entities playing one animation at different offsets each queue
//     their own lookahead, because each of their reads does.
//   * residency is accounted per FRAME. Once the materialized total exceeds
//     the budget, tick() releases the least-recently-used frames that no
//     consumer has read (and no prefetch has staged) within the grace period
//     — including old frames of an animation that is still playing. Frames
//     read/staged within the grace period are pinned; if the pinned set alone
//     exceeds the budget the overage is reported (once per period) and the
//     visuals are kept.
// Releasing drops the loader's canvas references (a consumer still holding a
// canvas keeps a valid surface until it lets go — nothing is zeroed under it);
// an evicted frame simply rematerializes from the atlas page on next access,
// through the same _materializeRect resampling, so pixels never change.
// warmAnimation / warmFrame (prewarm, boss staging) build frames without the
// consumer semantics above, so warming can't chain and a warmed-but-unused
// frame is an ordinary eviction candidate after the grace period.
const MiB = 1048576;
const ANIM_BUDGET_DEFAULT = 192 * MiB;  // Game lowers this on touch devices
const ANIM_EVICT_GRACE_MS = 4000;       // a frame read/staged this recently is pinned
const ANIM_EVICT_MIN_BYTES = 64 * 1024; // tiny frames aren't worth evicting
const ANIM_SWEEP_INTERVAL_MS = 500;
const ANIM_PREFETCH_PER_TICK = 2;
const ANIM_PREFETCH_BUDGET_MS = 2.5;
const ANIM_OVERAGE_REPORT_MS = 10000;

// One animation frame. Same public shape as a static asset / decoded GIF
// frame ({canvas, width, height, delay, prescale}) so every consumer
// (game.getAnimationFrame, fireExplosionFrame, gif[i].canvas, FractureModel
// on gif[0], ...) keeps working unchanged; only `canvas` is lazy.
class AnimFrame {
    constructor(loader, anim, index, meta) {
        this._loader = loader;
        this._anim = anim;
        this._index = index;
        this._meta = meta;
        this._canvas = null;
        this._queued = false;
        this._lastUse = -Infinity;   // last consumer read / prefetch staging (ms)
        this.width = meta.w;
        this.height = meta.h;
        this.delay = meta.delay;
        this.prescale = loader.atlasPrescale;
        this._bytes = meta.w * meta.h * this.prescale * this.prescale * 4;
    }

    get canvas() {
        const c = this._canvas;
        if (c) {
            this._loader._consumeFrame(this);
            return c;
        }
        return this._loader._materializeFrame(this, true);
    }

    set canvas(v) { this._canvas = v; }
}

export class AssetLoader {
    constructor() {
        this.cache = new Map();
        this.loading = 0;
        this.loaded = 0;

        // Animation surface budget state (see AnimFrame above).
        this.animBudgetBytes = ANIM_BUDGET_DEFAULT;
        this._anims = [];        // { key, frames, bytes, lastUse, lastIdx }
        this._animBytes = 0;     // materialized animation surface bytes
        this._prefetch = [];     // AnimFrame queue for tick()
        this._now = 0;
        this._lastSweep = 0;
        this._lastOverageReport = -Infinity;
        this.animOverageBytes = 0; // pinned demand above budget after the last sweep

        // Atlas state (populated by loadAtlas). When present, get() lazily
        // slices + prescales sprites out of the atlas pages on first access.
        this.atlasPages = [];      // HTMLImageElement per page
        this.atlasImages = null;   // key -> { page, x, y, w, h }
        this.atlasAnims = null;    // key -> { frames: [{ page, x, y, w, h, delay }] }
        this.atlasHitboxes = null; // key -> { rx, ry } ellipse half-extents (native px)
        this.atlasPrescale = 4;
    }

    /**
     * Load the packed atlas: fetch atlas.json, load every page image, and
     * register the sprite/animation rects. Individual sprites are NOT decoded
     * here — they're sliced and prescaled lazily on first get(), which keeps
     * startup fast and memory bounded even when large unused assets are packed.
     *
     * Throws if the atlas can't be fetched/parsed so callers can fall back to
     * the per-file manifest loader.
     * @param {string} jsonUrl Path to atlas.json (e.g. 'Assets/atlas/atlas.json').
     */
    async loadAtlas(jsonUrl) {
        const resp = await fetch(jsonUrl);
        if (!resp.ok) throw new Error(`Atlas fetch failed: ${resp.status} ${jsonUrl}`);
        const atlas = await resp.json();

        const baseDir = jsonUrl.slice(0, jsonUrl.lastIndexOf('/'));
        this.loading += atlas.pages.length;
        this.atlasPrescale = atlas.prescale || 4;

        // Load this atlas's pages. Can be called more than once (e.g. a small
        // boot atlas first, then the full atlas); each sprite stores a direct
        // reference to its page image so page indices never collide between
        // atlases. Later calls merge into the same key tables.
        const pages = await Promise.all(atlas.pages.map(p => new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = async () => {
                if (img.decode) { try { await img.decode(); } catch { /* drawImage still works */ } }
                this.loaded++;
                resolve(img);
            };
            img.onerror = () => reject(new Error(`Failed to load atlas page: ${p.file}`));
            img.src = `${baseDir}/${p.file}`;
        })));
        this.atlasPages.push(...pages);

        if (!this.atlasImages) this.atlasImages = {};
        if (!this.atlasAnims) this.atlasAnims = {};
        for (const [key, m] of Object.entries(atlas.images || {})) {
            this.atlasImages[key] = { x: m.x, y: m.y, w: m.w, h: m.h, img: pages[m.page] };
        }
        for (const [key, a] of Object.entries(atlas.animations || {})) {
            this.atlasAnims[key] = {
                frames: a.frames.map(f => ({ x: f.x, y: f.y, w: f.w, h: f.h, delay: f.delay, img: pages[f.page] })),
            };
        }
        // Ellipse hitboxes for combat sprites (packer-computed; see collision.js).
        if (atlas.hitboxes) {
            if (!this.atlasHitboxes) this.atlasHitboxes = {};
            Object.assign(this.atlasHitboxes, atlas.hitboxes);
        }
    }

    // Ellipse hitbox (half-extents rx/ry in native sprite px, centered on the
    // image) for a combat sprite key, or null if the key has none (non-combat
    // sprite, or the atlas predates hitboxes — callers fall back to a circle).
    getHitbox(key) {
        return (this.atlasHitboxes && this.atlasHitboxes[key]) || null;
    }

    // Slice a rect out of its atlas page into a prescaled canvas, matching the
    // output of loadImage (sharp nearest-neighbour upscale).
    _materializeRect(meta) {
        const prescale = this.atlasPrescale;
        const canvas = document.createElement('canvas');
        canvas.width = meta.w * prescale;
        canvas.height = meta.h * prescale;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;
        ctx.drawImage(meta.img, meta.x, meta.y, meta.w, meta.h,
            0, 0, canvas.width, canvas.height);
        return { canvas, width: meta.w, height: meta.h, prescale };
    }

    loadImage(key, path) {
        this.loading++;
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const prescale = 4; // Reduced from 8 to 4 for performance
                const canvas = document.createElement('canvas');
                canvas.width = img.width * prescale;
                canvas.height = img.height * prescale;
                const ctx = canvas.getContext('2d');
                
                // Razor sharpness: No smoothing
                ctx.imageSmoothingEnabled = false;
                ctx.webkitImageSmoothingEnabled = false;
                ctx.msImageSmoothingEnabled = false;
                
                ctx.drawImage(img, 0, 0, img.width, img.height, 0, 0, canvas.width, canvas.height);
                
                const asset = {
                    canvas: canvas,
                    width: img.width,
                    height: img.height,
                    prescale: prescale
                };
                this.cache.set(key, asset);
                this.loaded++;
                resolve(asset);
            };
            img.onerror = () => reject(new Error(`Failed to load: ${path}`));
            img.src = path;
        });
    }

    async loadGif(key, path) {
        this.loading++;
        const frames = await decodeGif(path);
        this.cache.set(key, frames); // Array of { canvas, delay }
        this.loaded++;
        return frames;
    }

    async loadAll(manifest) {
        const promises = Object.entries(manifest).map(([key, path]) =>
            this.loadImage(key, path)
        );
        await Promise.all(promises);
    }

    async loadAllGifs(manifest) {
        const promises = Object.entries(manifest).map(([key, path]) =>
            this.loadGif(key, path)
        );
        await Promise.all(promises);
    }

    get(key) {
        const cached = this.cache.get(key);
        if (cached) return cached;

        // Lazily materialize from the atlas on first access.
        if (this.atlasImages && this.atlasImages[key]) {
            const asset = this._materializeRect(this.atlasImages[key]);
            this.cache.set(key, asset);
            return asset;
        }
        if (this.atlasAnims && this.atlasAnims[key]) {
            // Descriptors only — each frame's surface materializes on first
            // `canvas` access (see the animation budget notes at the top).
            const metas = this.atlasAnims[key].frames;
            const anim = { key, frames: null, bytes: 0, lastUse: -Infinity, lastIdx: -1 };
            anim.frames = metas.map((f, i) => new AnimFrame(this, anim, i, f));
            this._anims.push(anim);
            this.cache.set(key, anim.frames);
            return anim.frames;
        }
        return undefined;
    }

    // Build a frame's surface now (first access, prefetch, warm, or after
    // eviction). `consumed` = a consumer read it (see _consumeFrame); a
    // prefetch/warm build only stages the frame (pins it for the grace period).
    _materializeFrame(frame, consumed) {
        const canvas = this._materializeRect(frame._meta).canvas;
        frame._canvas = canvas;
        frame._anim.bytes += frame._bytes;
        this._animBytes += frame._bytes;
        if (consumed) this._consumeFrame(frame);
        else frame._lastUse = this._now;
        return canvas;
    }

    // A consumer read this frame: mark it used and queue ONE lookahead frame
    // in the direction the reads are moving so a playing animation never pays
    // a materialization inside draw(). Prefetch itself never calls this.
    _consumeFrame(frame) {
        const now = this._now;
        const anim = frame._anim;
        frame._lastUse = now;
        anim.lastUse = now;
        const frames = anim.frames;
        const n = frames.length;
        const i = frame._index;
        if (n < 2) return;
        // Backwards playback: this read is the frame just before the last one
        // (wrap-aware). Anything else is treated as forward.
        const last = anim.lastIdx;
        const backwards = last >= 0 && (i === last - 1 || (last === 0 && i === n - 1));
        anim.lastIdx = i;
        const next = backwards ? frames[i > 0 ? i - 1 : n - 1] : frames[i + 1 < n ? i + 1 : 0];
        if (!next._canvas && !next._queued) {
            next._queued = true;
            this._prefetch.push(next);
        }
    }

    _releaseFrame(frame) {
        if (!frame._canvas) return;
        frame._canvas = null;
        frame._anim.bytes -= frame._bytes;
        this._animBytes -= frame._bytes;
    }

    // Build one frame's surface without consumer semantics (no lookahead, no
    // consumer last-use). For prewarm / staging loops.
    warmFrame(frame) {
        if (!(frame instanceof AnimFrame)) return frame && frame.canvas;
        if (frame._canvas) { frame._lastUse = this._now; return frame._canvas; }
        return this._materializeFrame(frame, false);
    }

    // Materialize every frame of an animation right now (prewarm / staging
    // before a boss encounter). Idempotent; never chains lookahead.
    warmAnimation(key) {
        const frames = this.get(key);
        if (Array.isArray(frames)) for (const f of frames) this.warmFrame(f);
        return frames;
    }

    // Per-frame housekeeping, called from Game.loop after the draw: build the
    // queued lookahead frames (a couple per tick, time-capped) and, when the
    // materialized total exceeds the budget, release the least-recently used
    // unpinned frames across every animation.
    tick(nowMs) {
        this._now = nowMs;
        const q = this._prefetch;
        if (q.length) {
            let done = 0;
            const t0 = performance.now();
            while (q.length && done < ANIM_PREFETCH_PER_TICK) {
                const f = q.shift();
                f._queued = false;
                if (f._canvas) continue;
                this._materializeFrame(f, false);
                done++;
                if (performance.now() - t0 > ANIM_PREFETCH_BUDGET_MS) break;
            }
        }
        if (this._animBytes > this.animBudgetBytes && nowMs - this._lastSweep >= ANIM_SWEEP_INTERVAL_MS) {
            this._lastSweep = nowMs;
            this._sweep(nowMs);
        }
    }

    _sweep(nowMs) {
        const idle = [];
        for (const a of this._anims) {
            if (a.bytes <= 0) continue;
            for (const f of a.frames) {
                if (f._canvas && f._bytes >= ANIM_EVICT_MIN_BYTES && nowMs - f._lastUse > ANIM_EVICT_GRACE_MS) idle.push(f);
            }
        }
        idle.sort((a, b) => a._lastUse - b._lastUse);
        for (const f of idle) {
            if (this._animBytes <= this.animBudgetBytes) break;
            this._releaseFrame(f);
        }
        const over = this._animBytes - this.animBudgetBytes;
        this.animOverageBytes = over > 0 ? over : 0;
        if (over > 0 && nowMs - this._lastOverageReport >= ANIM_OVERAGE_REPORT_MS) {
            this._lastOverageReport = nowMs;
            console.warn(`[AssetLoader] pinned animation frames exceed the surface budget by ${(over / MiB).toFixed(1)} MiB (${(this._animBytes / MiB).toFixed(1)} / ${(this.animBudgetBytes / MiB).toFixed(0)} MiB) — keeping them`);
        }
    }

    // Materialized animation surface bytes (dev/perf readout).
    get animSurfaceBytes() { return this._animBytes; }

    getProgress() {
        if (this.loading === 0) return 1;
        return this.loaded / this.loading;
    }

    destroy() {
        console.log(`[AssetLoader] Destroying ${this.cache.size} assets...`);
        for (const [key, asset] of this.cache) {
            if (Array.isArray(asset)) {
                // GIF / atlas animation frames (only surfaces that exist —
                // reading `.canvas` on a lazy frame would build one).
                asset.forEach(frame => {
                    const c = frame instanceof AnimFrame ? frame._canvas : frame.canvas;
                    if (c) {
                        c.width = 0;
                        c.height = 0;
                    }
                });
            } else if (asset && asset.canvas) {
                // Static image prescaled canvas
                asset.canvas.width = 0;
                asset.canvas.height = 0;
            }
        }
        this.cache.clear();
        this._anims = [];
        this._animBytes = 0;
        this._prefetch.length = 0;

        // Release atlas page images + rect tables.
        for (const page of this.atlasPages) page.src = '';
        this.atlasPages = [];
        this.atlasImages = null;
        this.atlasAnims = null;

        this.loading = 0;
        this.loaded = 0;
    }
}
