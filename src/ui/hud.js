// HUD uses its own scaling factor (4x)

export class HUD {
    constructor(game, player) {
        this.game = game;
        this.player = player;

        this.healthBarEmpty = game.assets.get('health_bar_empty');
        this.healthBarFull = game.assets.get('health_bar_full');
        this.shieldBarEmpty = game.assets.get('shield_bar_empty');
        this.shieldBarFull = game.assets.get('shield_bar_full');

        // Offscreen radar masking
        this.radarCanvas = document.createElement('canvas');
        this.radarCtx = this.radarCanvas.getContext('2d');

        this.expBarEmpty = game.assets.get('3_slice_exp_bar_empty');
        this.expBarFull = game.assets.get('3_slice_exp_bar_full');

        this.expGlowCanvas = document.createElement('canvas');
        this.expGlowCtx = this.expGlowCanvas.getContext('2d');
    }

    draw(ctx) {
        const p = this.player;
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = this.game.hudScale * 4;

        // HUD Displacement — lag behind camera
        // Displacement is in world units, convert to pixels and scale for HUD
        const lagX = (this.game.currentState.camera.displacementX || 0) * this.game.worldScale * 0.075;
        const lagY = (this.game.currentState.camera.displacementY || 0) * this.game.worldScale * 0.075;

        ctx.save();
        ctx.textBaseline = 'alphabetic';
        ctx.translate(Math.floor(lagX), Math.floor(lagY));

        // Health bar — lower left
        // ... (existing code remains but translated)
        const hImg = this.healthBarEmpty.canvas || this.healthBarEmpty;
        const hbW = (this.healthBarEmpty.width || hImg.width) * this.game.hudScale;
        const hbH = (this.healthBarEmpty.height || hImg.height) * this.game.hudScale;
        const hbX = margin;
        const hbY = ch - hbH - margin;
        ctx.drawImage(hImg, hbX, hbY, hbW, hbH);

        const healthPct = Math.max(0, Math.min(1, p.health / p.maxHealth));
        if (healthPct > 0) {
            const fillStart = 27;   // source px where bar starts
            const fillEnd = 118;    // source px where bar ends
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * healthPct);
            // Draw the fill portion: left dead space + filled region
            const srcClipW = fillStart + srcFillW;
            const hfImg = this.healthBarFull.canvas || this.healthBarFull;
            const hfH = this.healthBarFull.height || hfImg.height;
            const hPrescale = hfImg.width / (this.healthBarFull.width || hfImg.width);

            ctx.drawImage(
                hfImg,
                0, 0, srcClipW * hPrescale, hfH * hPrescale,
                hbX, hbY, srcClipW * this.game.hudScale, hbH
            );
        }

        // Shield bar — above health bar (dimmed when broken)
        // Bar fill region: source pixels 4–75 (71px wide fill area)
        const sImg = this.shieldBarEmpty.canvas || this.shieldBarEmpty;
        const sbW = (this.shieldBarEmpty.width || sImg.width) * this.game.hudScale;
        const sbH = (this.shieldBarEmpty.height || sImg.height) * this.game.hudScale;
        const sbX = margin;
        const sbY = hbY - sbH - this.game.hudScale * 2;

        if (p.shieldBroken) ctx.globalAlpha = 0.3;

        ctx.drawImage(sImg, sbX, sbY, sbW, sbH);

        const shieldPct = Math.max(0, Math.min(1, p.shieldEnergy / p.maxShieldEnergy));
        if (shieldPct > 0) {
            const fillStart = 4;
            const fillEnd = 75;
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * shieldPct);
            const srcClipW = fillStart + srcFillW;
            const sfImg = this.shieldBarFull.canvas || this.shieldBarFull;
            const sfH = this.shieldBarFull.height || sfImg.height;
            const sPrescale = sfImg.width / (this.shieldBarFull.width || sfImg.width);

            ctx.drawImage(
                sfImg,
                0, 0, srcClipW * sPrescale, sfH * sPrescale,
                sbX, sbY, srcClipW * this.game.hudScale, sbH
            );
        }

        if (p.shieldBroken) ctx.globalAlpha = 1;

        // Scrap counter — upper right
        ctx.fillStyle = '#ccddee';
        ctx.font = `${8 * this.game.hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        ctx.fillText(`SCRAP: ${p.scrap}`, cw - margin, this.game.hudScale * 10);
        ctx.textAlign = 'left';

        // Coordinates
        ctx.fillStyle = '#445566';
        ctx.font = `${8 * this.game.hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        ctx.fillText(`${Math.floor(p.worldX)}, ${Math.floor(p.worldY)}`, cw - margin, ch - margin);
        ctx.textAlign = 'left';

        // Radar
        this._drawRadar(ctx, cw, ch, margin);

        // Wave Timer — top left
        const waveTimer = this.game.currentState.waveTimer;
        if (waveTimer !== undefined) {
            const mins = Math.floor(waveTimer / 60);
            const secs = Math.floor(waveTimer % 60).toString().padStart(2, '0');
            ctx.fillStyle = '#ff4444';
            ctx.font = `${8 * this.game.hudScale}px Astro4x`;
            ctx.textAlign = 'left';
            ctx.fillText(`NEXT WAVE: ${mins}:${secs}`, margin, this.game.hudScale * 10);
        }

        this._drawExpBar(ctx, cw, ch);

        ctx.restore();
    }


    _drawRadar(ctx, cw, ch, margin) {
        if (!this.player.hasRadar) return;

        const img = this.game.assets.get('radar_frame');
        const backImg = this.game.assets.get('radar_frame_back');
        if (!img) return;

        const uiScale = this.game.hudScale;
        const rw = (img.width || img.canvas.width) * uiScale;
        const rh = (img.height || img.canvas.height) * uiScale;

        // Position: Bottom Right, snapped to HUD grid
        const rx = Math.floor((cw - rw - margin) / uiScale) * uiScale;
        const ry = Math.floor((ch - rh - margin - (12 * uiScale)) / uiScale) * uiScale;

        // 1. Draw background to offscreen canvas for masking
        if (backImg) {
            if (this.radarCanvas.width !== rw || this.radarCanvas.height !== rh) {
                this.radarCanvas.width = rw;
                this.radarCanvas.height = rh;
                this.radarCtx.imageSmoothingEnabled = false;
            }
            this.radarCtx.clearRect(0, 0, rw, rh);
            this.radarCtx.drawImage(backImg.canvas || backImg, 0, 0, rw, rh);

            // 2. Use source-atop to ONLY draw blips on the solid pixels of the back asset
            this.radarCtx.save();
            this.radarCtx.globalCompositeOperation = 'source-atop';

            const cx = Math.floor((rw / 2) / uiScale) * uiScale;
            const cy = Math.floor((rh / 2) / uiScale) * uiScale;

            const fovMult = (this.game.currentState && this.game.currentState.currentFovMult) || 1.0;
            const radarRange = 2000 * (fovMult * 0.75);
            const radarSize = (rw / 2) - (2 * uiScale);

            const drawDot = (entities, color, size = 1) => {
                if (!entities) return;
                this.radarCtx.fillStyle = color;
                // Blip size is exactly 'size' HUD pixels
                const dotSize = Math.max(1, Math.round(size)) * uiScale;

                for (const e of entities) {
                    if (e.alive === false || e.isFinished) continue;

                    const dx = e.worldX - this.player.worldX;
                    const dy = e.worldY - this.player.worldY;
                    const distSq = dx * dx + dy * dy;

                    if (distSq < radarRange * radarRange) {
                        const dist = Math.sqrt(distSq);
                        const angle = Math.atan2(dy, dx);
                        const rDist = (dist / radarRange) * radarSize;

                        const rawX = cx + Math.cos(angle) * rDist;
                        const rawY = cy + Math.sin(angle) * rDist;

                        // Snap to HUD grid pixels (multiples of uiScale)
                        const snappedX = Math.floor(rawX / uiScale) * uiScale;
                        const snappedY = Math.floor(rawY / uiScale) * uiScale;

                        const isAsteroid = e.constructor.name === 'Asteroid' || (e.size && (e.size === 'tiny' || e.size === 'small' || e.size === 'medium' || e.size === 'big'));

                        if (isAsteroid) {
                            if (e.size === 'medium') {
                                // 4px square
                                const s = 2 * uiScale;
                                this.radarCtx.fillRect(snappedX - uiScale, snappedY - uiScale, s, s);
                            } else if (e.size === 'big') {
                                // 4px diameter circle (pixel art)
                                const bx = snappedX - uiScale;
                                const by = snappedY - uiScale;
                                // row 0
                                this.radarCtx.fillRect(bx + uiScale, by, 2 * uiScale, uiScale);
                                // rows 1 & 2
                                this.radarCtx.fillRect(bx, by + uiScale, 4 * uiScale, 2 * uiScale);
                                // row 3
                                this.radarCtx.fillRect(bx + uiScale, by + 3 * uiScale, 2 * uiScale, uiScale);
                            } else {
                                // Tiny/Small: 1px dot
                                this.radarCtx.fillRect(snappedX, snappedY, uiScale, uiScale);
                            }
                        } else {
                            this.radarCtx.fillRect(snappedX, snappedY, dotSize, dotSize);
                        }
                    }
                }
            };

            // Draw Player (center pixel)
            this.radarCtx.fillStyle = '#ffffff';
            this.radarCtx.fillRect(cx, cy, uiScale, uiScale);

            const state = this.game.currentState;
            if (state) {
                drawDot(state.asteroids, 'rgba(120, 120, 120, 0.5)', 1);
                drawDot(state.shops.filter(s => s.revealed), '#44aaff', 1);
                drawDot(state.events, '#ffcc00', 1);
                drawDot(state.enemies, '#ff4444', 1);
                drawDot(state.encounters, '#44ffaa', 1);
            }

            this.radarCtx.restore();

            // Composite offscreen radar to main screen
            ctx.drawImage(this.radarCanvas, rx, ry);
        }

        // 3. Draw frame on top
        ctx.drawImage(img.canvas || img, rx, ry, rw, rh);
    }

    _drawExpBar(ctx, cw, ch) {
        const p = this.player;
        const hudScale = this.game.hudScale;
        const barW = Math.floor(cw * 0.4); // 2/5 of screen width
        const emptyAsset = this.expBarEmpty;
        const fullAsset = this.expBarFull;
        if (!emptyAsset || !fullAsset) return;

        const imgH = emptyAsset.height || (emptyAsset.canvas ? emptyAsset.canvas.height / emptyAsset.prescale : emptyAsset.height);
        const barH = imgH * hudScale;
        const x = (cw - barW) / 2;
        const y = ch - barH - hudScale * 4;

        // Draw empty background
        this.draw3Slice(ctx, emptyAsset, x, y, barW, barH);

        const expPct = Math.max(0, Math.min(1, p.exp / p.expNeeded));
        if (expPct > 0) {
            const fillW = Math.floor(barW * expPct);
            if (fillW > 0) {
                // --- SHARED WAVE STATE ---
                const time = (this.game.currentState && this.game.currentState.trueTotalTime) || (performance.now() / 1000);
                const sweepProgress = (time % 2.0) / 2.0;
                const glowWidth = barW * 0.15;
                const glowCenter = -glowWidth + (barW + glowWidth * 2) * sweepProgress;
                
                // Rhythmic pulse for both wave and aura intensity
                const pulseIntensity = 0.8 + Math.sin(time * 6) * 0.2;

                // 1. Prepare Shape-Accurate Mask in offscreen buffer
                if (this.expGlowCanvas.width !== barW || this.expGlowCanvas.height !== barH) {
                    this.expGlowCanvas.width = barW;
                    this.expGlowCanvas.height = barH;
                }
                this.expGlowCtx.clearRect(0, 0, barW, barH);
                
                // Draw the filled segment silhouette
                this.draw3Slice(this.expGlowCtx, fullAsset, 0, 0, barW, barH);
                this.expGlowCtx.save();
                this.expGlowCtx.globalCompositeOperation = 'destination-in';
                this.expGlowCtx.fillStyle = 'white';
                this.expGlowCtx.fillRect(0, 0, fillW, barH);
                this.expGlowCtx.restore();

                // 2. SHAPE-ACCURATE BLOOM (Concentrated where the wave is)
                // We create a temporary masked version of the silhouette for the aura
                const auraTempCanvas = document.createElement('canvas');
                auraTempCanvas.width = barW;
                auraTempCanvas.height = barH;
                const auraTempCtx = auraTempCanvas.getContext('2d');
                
                auraTempCtx.drawImage(this.expGlowCanvas, 0, 0);
                auraTempCtx.save();
                auraTempCtx.globalCompositeOperation = 'source-in';
                
                // Gradient that peaks at the wave center
                const auraMask = auraTempCtx.createLinearGradient(glowCenter - glowWidth * 1.5, 0, glowCenter + glowWidth * 1.5, 0);
                auraMask.addColorStop(0, 'rgba(255, 255, 255, 0.2)'); // Base glow
                auraMask.addColorStop(0.5, 'rgba(255, 255, 255, 1.0)'); // Peak at wave
                auraMask.addColorStop(1, 'rgba(255, 255, 255, 0.2)'); // Base glow
                auraTempCtx.fillStyle = auraMask;
                auraTempCtx.fillRect(0, 0, barW, barH);
                auraTempCtx.restore();

                ctx.save();
                ctx.globalCompositeOperation = 'screen';
                // Apply bloom filters to the localized aura
                ctx.filter = `blur(${hudScale * 3.5}px)`;
                ctx.globalAlpha = 0.75 * pulseIntensity;
                ctx.drawImage(auraTempCanvas, x, y);
                
                ctx.filter = `blur(${hudScale * 1.5}px)`;
                ctx.globalAlpha = 0.5 * pulseIntensity;
                ctx.drawImage(auraTempCanvas, x, y);
                ctx.restore();

                // 3. PRIMARY BAR TEXTURE (Drawn normally)
                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, fillW, barH);
                ctx.clip();
                this.draw3Slice(ctx, fullAsset, x, y, barW, barH);
                ctx.restore();

                // 4. --- PULSE WAVE (The internal energy streak) ---
                // Re-clear and draw the wave streak onto the silhouette
                this.expGlowCtx.save();
                this.expGlowCtx.globalCompositeOperation = 'source-in';
                const grad = this.expGlowCtx.createLinearGradient(glowCenter - glowWidth, 0, glowCenter + glowWidth, 0);
                grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
                grad.addColorStop(0.5, `rgba(255, 255, 255, ${0.4 + 0.3 * pulseIntensity})`);
                grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                this.expGlowCtx.fillStyle = grad;
                this.expGlowCtx.fillRect(0, 0, barW, barH);
                this.expGlowCtx.restore();

                ctx.save();
                ctx.beginPath();
                ctx.rect(x, y, fillW, barH);
                ctx.clip();
                ctx.globalCompositeOperation = 'lighter';
                ctx.drawImage(this.expGlowCanvas, x, y);
                ctx.restore();
            }
        }

        // Draw Level Text
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = hudScale * 1; // 1 HUD-pixel outline
        ctx.lineJoin = 'round';
        ctx.font = `${6 * hudScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const textY = y - hudScale * 1.5;
        ctx.strokeText(`LEVEL ${p.level}`, cw / 2, textY);
        ctx.fillText(`LEVEL ${p.level}`, cw / 2, textY);
        ctx.restore();
    }

    /**
     * Draws a 3-slice sprite.
     * Assumes slices are equal thirds of the image width.
     */
    draw3Slice(ctx, asset, x, y, targetW, targetH) {
        const img = asset.canvas || asset;
        const srcW = asset.width || img.width;
        const srcH = asset.height || img.height;
        const prescale = asset.prescale || 1;

        const capSrcW = Math.floor(srcW / 3);
        const middleSrcW = srcW - capSrcW * 2;

        const hScale = targetH / srcH;
        const capDestW = Math.floor(capSrcW * hScale);
        const middleDestW = Math.max(0, Math.floor(targetW - capDestW * 2));

        const dx = Math.floor(x);
        const dy = Math.floor(y);
        const dh = Math.floor(targetH);

        // Left Cap (+1px overlap)
        ctx.drawImage(img,
            0, 0, capSrcW * prescale, srcH * prescale,
            dx, dy, capDestW + 1, dh
        );

        // Middle (Tile/Stretch) (+1px overlap)
        if (middleDestW > 0) {
            ctx.drawImage(img,
                capSrcW * prescale, 0, middleSrcW * prescale, srcH * prescale,
                dx + capDestW, dy, middleDestW + 1, dh
            );
        }

        // Right Cap
        ctx.drawImage(img,
            (capSrcW + middleSrcW) * prescale, 0, capSrcW * prescale, srcH * prescale,
            dx + capDestW + middleDestW, dy, capDestW, dh
        );
    }
}
