// Asset loader — loads and caches images and GIF animations
import { decodeGif } from './gifDecoder.js';

export class AssetLoader {
    constructor() {
        this.cache = new Map();
        this.loading = 0;
        this.loaded = 0;

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
        // Ellipse hitboxes for combat sprites (packer-computed; see hitbox.js).
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
            const frames = this.atlasAnims[key].frames.map(f => {
                const frame = this._materializeRect(f);
                frame.delay = f.delay;
                return frame;
            });
            this.cache.set(key, frames);
            return frames;
        }
        return undefined;
    }

    getProgress() {
        if (this.loading === 0) return 1;
        return this.loaded / this.loading;
    }

    destroy() {
        console.log(`[AssetLoader] Destroying ${this.cache.size} assets...`);
        for (const [key, asset] of this.cache) {
            if (Array.isArray(asset)) {
                // GIF Frames
                asset.forEach(frame => {
                    if (frame.canvas) {
                        frame.canvas.width = 0;
                        frame.canvas.height = 0;
                    }
                });
            } else if (asset && asset.canvas) {
                // Static image prescaled canvas
                asset.canvas.width = 0;
                asset.canvas.height = 0;
            }
        }
        this.cache.clear();

        // Release atlas page images + rect tables.
        for (const page of this.atlasPages) page.src = '';
        this.atlasPages = [];
        this.atlasImages = null;
        this.atlasAnims = null;

        this.loading = 0;
        this.loaded = 0;
    }
}
