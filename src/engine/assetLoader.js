// Asset loader — loads and caches images and GIF animations
import { decodeGif } from './gifDecoder.js';

export class AssetLoader {
    constructor() {
        this.cache = new Map();
        this.loading = 0;
        this.loaded = 0;
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
        return this.cache.get(key);
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
        this.loading = 0;
        this.loaded = 0;
    }
}
