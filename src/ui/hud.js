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
    }

    draw(ctx) {
        ctx.textBaseline = 'alphabetic';
        const p = this.player;
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = this.game.hudScale * 4;

        // HUD Displacement — lag behind camera
        // Displacement is in world units, convert to pixels and scale for HUD
        const lagX = (this.game.currentState.camera.displacementX || 0) * this.game.worldScale * 0.075;
        const lagY = (this.game.currentState.camera.displacementY || 0) * this.game.worldScale * 0.075;
        
        ctx.save();
        ctx.translate(Math.floor(lagX), Math.floor(lagY));

        // Health bar — lower left
        // ... (existing code remains but translated)
        const hbW = this.healthBarEmpty.width * this.game.hudScale;
        const hbH = this.healthBarEmpty.height * this.game.hudScale;
        const hbX = margin;
        const hbY = ch - hbH - margin;
        ctx.drawImage(this.healthBarEmpty, hbX, hbY, hbW, hbH);

        const healthPct = Math.max(0, Math.min(1, p.health / p.maxHealth));
        if (healthPct > 0) {
            const fillStart = 27;   // source px where bar starts
            const fillEnd = 118;    // source px where bar ends
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * healthPct);
            // Draw the fill portion: left dead space + filled region
            const srcClipW = fillStart + srcFillW;
            ctx.drawImage(
                this.healthBarFull,
                0, 0, srcClipW, this.healthBarFull.height,
                hbX, hbY, srcClipW * this.game.hudScale, hbH
            );
        }

        // Shield bar — above health bar (dimmed when broken)
        // Bar fill region: source pixels 4–75 (71px wide fill area)
        const sbW = this.shieldBarEmpty.width * this.game.hudScale;
        const sbH = this.shieldBarEmpty.height * this.game.hudScale;
        const sbX = margin;
        const sbY = hbY - sbH - this.game.hudScale * 2;

        if (p.shieldBroken) ctx.globalAlpha = 0.3;

        ctx.drawImage(this.shieldBarEmpty, sbX, sbY, sbW, sbH);

        const shieldPct = Math.max(0, Math.min(1, p.shieldEnergy / p.maxShieldEnergy));
        if (shieldPct > 0) {
            const fillStart = 4;
            const fillEnd = 75;
            const fillWidth = fillEnd - fillStart;
            const srcFillW = Math.floor(fillWidth * shieldPct);
            const srcClipW = fillStart + srcFillW;
            ctx.drawImage(
                this.shieldBarFull,
                0, 0, srcClipW, this.shieldBarFull.height,
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

        ctx.restore();
    }


    _drawRadar(ctx, cw, ch, margin) {
        if (!this.player.hasRadar) return;

        const img = this.game.assets.get('radar_frame');
        const backImg = this.game.assets.get('radar_frame_back');
        if (!img) return;

        const uiScale = this.game.hudScale;
        const rw = img.width * uiScale;
        const rh = img.height * uiScale;

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
            this.radarCtx.drawImage(backImg, 0, 0, rw, rh);

            // 2. Use source-atop to ONLY draw blips on the solid pixels of the back asset
            this.radarCtx.save();
            this.radarCtx.globalCompositeOperation = 'source-atop';

            const cx = Math.floor((rw / 2) / uiScale) * uiScale;
            const cy = Math.floor((rh / 2) / uiScale) * uiScale;

            const radarRange = 2000;
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
                drawDot(state.shops, '#44aaff', 1);
                drawDot(state.events, '#ffcc00', 1);
                drawDot(state.enemies, '#ff4444', 1);
                drawDot(state.encounters, '#44ffaa', 1);
            }

            this.radarCtx.restore();

            // Composite offscreen radar to main screen
            ctx.drawImage(this.radarCanvas, rx, ry);
        }

        // 3. Draw frame on top
        ctx.drawImage(img, rx, ry, rw, rh);
    }
}
