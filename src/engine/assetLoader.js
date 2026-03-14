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
                this.cache.set(key, img);
                this.loaded++;
                resolve(img);
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
}
