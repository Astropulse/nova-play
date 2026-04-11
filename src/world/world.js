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

// Parallax starfield — pre-renders stars into tileable canvases for high performance
export class World {
    constructor(game, seed = 42) {
        this.game = game;
        this.tileSize = 2048; // Standard tile size for baking (safe for VRAM)
        this.seed = seed;

        // Assets
        this.starImages = [];
        for (let i = 0; i <= 7; i++) this.starImages.push(game.assets.get(`starfield_${i}`));

        this.rareImages = [
            game.assets.get('big_star'), game.assets.get('galaxy'),
            game.assets.get('nebula_0'), game.assets.get('nebula_1'),
            game.assets.get('nebula_2'), game.assets.get('nebula_3'),
        ];
        this.blackHoleImage = game.assets.get('black_hole');
        this.singleStars = [];
        for (let i = 0; i <= 10; i++) {
            const img = game.assets.get(`star_${i}`);
            if (img) this.singleStars.push(img);
        }

        this.layers = [];
        this._initLayers();
    }

    _initLayers() {
        const layerConfigs = [
            { parallax: 0.02, count: 320, alpha: 0.25, singleStarCount: 160 },   // very far
            { parallax: 0.05, count: 200, alpha: 0.35, singleStarCount: 200 },
            { parallax: 0.10, count: 160, alpha: 0.45, singleStarCount: 240 },
            { parallax: 0.18, count: 120, alpha: 0.60, singleStarCount: 160 },
            { parallax: 0.28, count: 80, alpha: 0.75, singleStarCount: 80 },
            { parallax: 0.40, count: 60, alpha: 0.90, singleStarCount: 40 },
            { parallax: 0.55, count: 40, alpha: 1.0, singleStarCount: 20 },    // closest
        ];

        const virtualSize = 4096; // Logical wrap window
        const rng = mulberry32(this.seed);

        // Rare object index pool (shuffle-bag) to ensure uniform distribution
        let rarePool = [];
        const refillPool = () => {
            // Pool 0..L-1
            rarePool = Array.from({ length: this.rareImages.length }, (_, i) => i);
            // Fisher-Yates shuffle with our seeded RNG
            for (let i = rarePool.length - 1; i > 0; i--) {
                const j = Math.floor(rng() * (i + 1));
                [rarePool[i], rarePool[j]] = [rarePool[j], rarePool[i]];
            }
        };
        refillPool();

        layerConfigs.forEach((config, idx) => {
            const stars = [];

            // Randomly distribute individual star entities
            for (let i = 0; i < config.count + config.singleStarCount; i++) {
                const isCluster = i < config.count;
                const assetList = isCluster ? this.starImages : this.singleStars;
                stars.push({
                    x: rng() * virtualSize,
                    y: rng() * virtualSize,
                    spriteIdx: Math.floor(rng() * assetList.length),
                    isCluster: isCluster,
                    type: 'star',
                    blend: 'lighter',
                    rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                    alphaBoost: 0.8 + rng() * 0.4
                });
            }

            // Rare objects in middle layers
            if (idx >= 1 && idx <= 4) {
                const rareCount = Math.floor(rng() * 7) + 1;
                for (let r = 0; r < rareCount; r++) {
                    let imgAsset;
                    let blend = 'screen';
                    let isBlackHole = false;
                    if (rng() < 0.03 && this.blackHoleImage && idx == 1) {
                        imgAsset = this.blackHoleImage;
                        blend = 'source-over';
                        isBlackHole = true;
                    } else {
                        // Use shuffle-bag for uniform rare selection
                        if (rarePool.length === 0) refillPool();
                        const rareIdx = rarePool.pop();
                        imgAsset = this.rareImages[rareIdx];
                    }

                    if (imgAsset) {
                        stars.push({
                            x: rng() * virtualSize,
                            y: rng() * virtualSize,
                            asset: imgAsset, // Store asset directly for rare items
                            type: 'rare',
                            blend: blend, // Use the correct blend mode
                            isBlackHole: isBlackHole,
                            rotation: Math.floor(rng() * 4) * (Math.PI / 2),
                            alphaBoost: isBlackHole ? 1.0 : (0.5 + rng() * 0.4) // No alpha boost needed for solid black hole
                        });
                    }
                }
            }

            this.layers.push({
                parallax: config.parallax,
                alpha: config.alpha,
                stars: stars
            });
        });
    }

    draw(ctx, camera, player, worldTime = 0) {
        const cw = ctx.canvas.width;
        const ch = ctx.canvas.height;
        const worldScale = this.game.worldScale;
        const boostIntensity = player ? player.boostIntensity : 0;
        const isBoosting = boostIntensity > 0.01;
        const streakFactor = 0.04;
        const virtualSize = 4096;

        // Razor-sharp: No sub-pixel blurring during individual star draw
        ctx.imageSmoothingEnabled = false;
        ctx.webkitImageSmoothingEnabled = false;
        ctx.msImageSmoothingEnabled = false;

        // Calculate tile coverage needed for current view bounds (including margin)
        const viewW = cw / worldScale;
        const viewH = ch / worldScale;
        const rangeX = Math.ceil(viewW / virtualSize / 2) + 1;
        const rangeY = Math.ceil(viewH / virtualSize / 2) + 1;

        // Draw parallax layers (Back to Front)
        for (const layer of this.layers) {
            const layerAlpha = layer.alpha * (0.95 + 0.05 * Math.sin(worldTime * (1 + layer.parallax * 2)));
            const samples = isBoosting ? 8 : 1;

            // Streak vectors
            const svx = player ? -player.vx * layer.parallax * streakFactor * boostIntensity * worldScale : 0;
            const svy = player ? -player.vy * layer.parallax * streakFactor * boostIntensity * worldScale : 0;

            for (const star of layer.stars) {
                // Calculate base wrapped position relative to camera
                let relX = (star.x - (camera.x * layer.parallax)) % virtualSize;
                let relY = (star.y - (camera.y * layer.parallax)) % virtualSize;

                const halfSize = virtualSize / 2;
                if (relX < -halfSize) relX += virtualSize;
                if (relX > halfSize) relX -= virtualSize;
                if (relY < -halfSize) relY += virtualSize;
                if (relY > halfSize) relY -= virtualSize;

                // Draw multiple wraps to fill the screen at any FOV
                for (let k = -rangeX; k <= rangeX; k++) {
                    for (let m = -rangeY; m <= rangeY; m++) {
                        const sx = relX + k * virtualSize;
                        const sy = relY + m * virtualSize;

                        const dx = sx * worldScale + (cw / 2);
                        const dy = sy * worldScale + (ch / 2);

                        // generous culling bounds to cover screen + margin
                        if (dx > -512 && dx < cw + 512 && dy > -512 && dy < ch + 512) {
                            const imgAsset = star.type === 'star' ?
                                (star.isCluster ? this.starImages[star.spriteIdx] : this.singleStars[star.spriteIdx]) :
                                star.asset;

                            if (!imgAsset) continue;

                            const img = imgAsset.canvas || imgAsset;
                            const sw = (imgAsset.width || img.width) * worldScale;
                            const sh = (imgAsset.height || img.height) * worldScale;

                            ctx.save();
                            ctx.globalCompositeOperation = star.blend;

                            for (let s = 0; s < samples; s++) {
                                const t = samples > 1 ? s / (samples - 1) : 0.5;
                                const weight = samples > 1 ? Math.sin(t * Math.PI) : 1.0;
                                const offsetMult = s / samples;
                                const boostComp = samples > 1 ? (1.8 / samples) : 1.0;
                                const finalAlpha = star.isBlackHole ? 1.0 : (layerAlpha * star.alphaBoost * weight * boostComp);
                                ctx.globalAlpha = Math.max(0, Math.min(1.0, finalAlpha));

                                const finalX = dx + (svx * offsetMult);
                                const finalY = dy + (svy * offsetMult);

                                if (star.rotation === 0) {
                                    ctx.drawImage(img, finalX - sw / 2, finalY - sh / 2, sw, sh);
                                } else {
                                    ctx.save();
                                    ctx.translate(finalX, finalY);
                                    ctx.rotate(star.rotation);
                                    ctx.drawImage(img, -sw / 2, -sh / 2, sw, sh);
                                    ctx.restore();
                                }
                            }
                            ctx.restore();
                        }
                    }
                }
            }
        }

        // Draw Shops
        if (this.game.currentState.shops) {
            for (const shop of this.game.currentState.shops) {
                shop.draw(ctx, camera);
            }
        }
    }
}

