// Scaling is dynamic via game properties

// Seeded pseudo-random for deterministic star placement
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Parallax starfield — scatters random starfield sprites plus rare space objects
export class World {
    constructor(game) {
        this.game = game;

        // Collect all starfield images
        this.starImages = [];
        for (let i = 0; i <= 7; i++) {
            this.starImages.push(game.assets.get(`starfield_${i}`));
        }

        // Rare space objects
        this.rareImages = [
            game.assets.get('big_star'),
            game.assets.get('nebula'),
            game.assets.get('galaxy'),
        ];

        // Individual stars to mix into fields
        this.singleStars = [];
        for (let i = 0; i <= 10; i++) {
            const img = game.assets.get(`star_${i}`);
            if (img) this.singleStars.push(img);
        }

        // Build parallax layers
        this.layers = [];
        const allImages = [0, 1, 2, 3, 4, 5, 6, 7];
        const layerConfigs = [
            { parallax: 0.02, count: 320, alpha: 0.25, singleStarCount: 100 },   // very far, very dim
            { parallax: 0.05, count: 140, alpha: 0.35, singleStarCount: 160 },
            { parallax: 0.10, count: 120, alpha: 0.45, singleStarCount: 200 },
            { parallax: 0.18, count: 100, alpha: 0.60, singleStarCount: 120 },
            { parallax: 0.28, count: 80, alpha: 0.75, singleStarCount: 80 },
            { parallax: 0.40, count: 60, alpha: 0.90, singleStarCount: 40 },
            { parallax: 0.55, count: 40, alpha: 1.0, singleStarCount: 30 },    // closest, full brightness
        ];

        const rng = mulberry32(42);

        let lIdx = 0;
        for (const config of layerConfigs) {
            const stars = [];
            const regionSize = 7000;

            // Starfield clusters
            for (let i = 0; i < config.count; i++) {
                const imgIdx = Math.floor(rng() * allImages.length);
                const img = this.starImages[imgIdx];
                stars.push({
                    img,
                    x: rng() * regionSize,
                    y: rng() * regionSize,
                    rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                    twinkleSpeed: rng() * 1.5 + 0.5,
                    twinkleOffset: rng() * Math.PI * 2,
                    pulseAmount: 0.1 // Starfields pulse subtly
                });
            }

            // Individual stars to break up patterns
            for (let i = 0; i < config.singleStarCount; i++) {
                const imgIdx = Math.floor(rng() * this.singleStars.length);
                const img = this.singleStars[imgIdx];
                stars.push({
                    img,
                    x: rng() * regionSize,
                    y: rng() * regionSize,
                    rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                    twinkleSpeed: rng() * 2 + 1,
                    twinkleOffset: rng() * Math.PI * 2,
                    pulseAmount: 0.3 // Individual stars pulse more
                });
            }

            // Rare objects in layers 1 to 4 (inclusive)
            if (lIdx >= 1 && lIdx <= 4) {
                // Determine how many rare objects in this layer
                const rareCount = (rng() < 0.3) ? 8 : 3;
                for (let r = 0; r < rareCount; r++) {
                    const imgIdx = Math.floor(rng() * this.rareImages.length);
                    const img = this.rareImages[imgIdx];
                    stars.push({
                        img,
                        x: rng() * regionSize,
                        y: rng() * regionSize,
                        rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                        isRare: true,
                        twinkleSpeed: rng() * 0.8 + 0.2,
                        twinkleOffset: rng() * Math.PI * 2,
                        pulseAmount: 0.05 // Rare large objects pulse very slowly/subtly
                    });
                }
            }

            this.layers.push({
                parallax: config.parallax,
                alpha: config.alpha,
                stars,
                regionSize,
            });
            lIdx++;
        }

    }

    draw(ctx, camera, player, worldTime = 0) {
        const cw = this.game.width;
        const ch = this.game.height;
        if (!this.layerCanvas) {
            this.layerCanvas = document.createElement('canvas');
            this.layerCtx = this.layerCanvas.getContext('2d');
        }
        if (this.layerCanvas.width !== cw || this.layerCanvas.height !== ch) {
            this.layerCanvas.width = cw;
            this.layerCanvas.height = ch;
            this.layerCtx.imageSmoothingEnabled = false;
        }

        const boostIntensity = player ? player.boostIntensity : 0;
        const vx = player ? player.vx : 0;
        const vy = player ? player.vy : 0;
        const streakFactor = 0.04;
        const isBoosting = boostIntensity > 0.01;

        // Draw starfield layers (back to front via order)
        for (const layer of this.layers) {
            const offsetX = camera.x * layer.parallax;
            const offsetY = camera.y * layer.parallax;
            const rs = layer.regionSize;

            const svx = -vx * layer.parallax * streakFactor * boostIntensity;
            const svy = -vy * layer.parallax * streakFactor * boostIntensity;

            // 1. Draw all stars of this layer into an offscreen canvas (CRISP)
            this.layerCtx.clearRect(0, 0, cw, ch);
            this.layerCtx.save();
            this.layerCtx.globalAlpha = layer.alpha;
            this.layerCtx.globalCompositeOperation = 'screen';

            for (const star of layer.stars) {
                const img = star.img;
                if (!img) continue;
                const w = img.width * this.game.worldScale;
                const h = img.height * this.game.worldScale;

                let sx = ((star.x - offsetX) % rs + rs) % rs;
                let sy = ((star.y - offsetY) % rs + rs) % rs;

                // Pulsing effect
                const pulseAlpha = star.pulseAmount * Math.sin(worldTime * star.twinkleSpeed + star.twinkleOffset);
                this.layerCtx.globalAlpha = Math.max(0.1, Math.min(1.0, layer.alpha + pulseAlpha));

                for (let wy = sy - rs; wy < ch + h; wy += rs) {
                    for (let wx = sx - rs; wx < cw + w; wx += rs) {
                        if (wx + w < 0 || wx > cw || wy + h < 0 || wy > ch) continue;

                        if (star.rotation === 0) {
                            this.layerCtx.drawImage(img, Math.floor(wx), Math.floor(wy), w, h);
                        } else {
                            const cx = Math.floor(wx + w / 2);
                            const cy = Math.floor(wy + h / 2);
                            this.layerCtx.save();
                            this.layerCtx.translate(cx, cy);
                            this.layerCtx.rotate(star.rotation);
                            this.layerCtx.drawImage(img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
                            this.layerCtx.restore();
                        }
                    }
                }
            }
            this.layerCtx.restore();

            // 2. Composite the baked layer onto the main screen with ADDITIVE blur
            // This ensures overlapping stars in the layer don't bloom more than intended.
            // Close, bright stars get a boostFactor so they stay "solid" streaks.
            // We use sinusoidal weights to "taper" the edges of the trails.
            const samples = isBoosting ? 8 : 1;
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';

            // Boost factor ensures close stars (high layer.alpha) stay bright during the streak
            const boostFactor = 1 + Math.pow(layer.alpha, 2) * boostIntensity;

            // Calculate weights for sinusoidal tapering
            let weightSum = 0;
            const weights = [];
            for (let s = 0; s < samples; s++) {
                const t = samples > 1 ? s / (samples - 1) : 0.5;
                const w = samples > 1 ? Math.sin(t * Math.PI) : 1.0;
                weights.push(w);
                weightSum += w;
            }

            // Normalize alpha so the total energy matches our boostFactor target
            const baseAlpha = (1 / weightSum) * boostFactor;

            for (let s = 0; s < samples; s++) {
                const offsetMult = s / samples;
                ctx.globalAlpha = weights[s] * baseAlpha;
                ctx.drawImage(this.layerCanvas, svx * offsetMult, svy * offsetMult);
            }
            ctx.restore();
        }


        // Draw Shops
        if (this.game.currentState.shops) {
            for (const shop of this.game.currentState.shops) {
                shop.draw(ctx, camera);
            }
        }
    }
}
