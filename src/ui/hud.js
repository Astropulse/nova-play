// HUD uses its own scaling factor (4x)

import { playerColor } from './chat.js';

export class HUD {
    constructor(game, player) {
        this.game = game;
        this.player = player;

        this.healthBarEmpty = game.assets.get('health_bar_empty');
        this.healthBarFull = game.assets.get('health_bar_full');
        this.healthBarOverflow = game.assets.get('health_bar_overflow');
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

    // vp (optional {x,y,w,h}) = a split-screen pane. The HUD then lays itself out
    // for the pane's ACTUAL size — corners anchored to the pane, scale derived
    // from the pane's height — i.e. as if the pane were the whole screen (NOT a
    // uniform-scaled copy of the fullscreen layout).
    draw(ctx, vp = null) {
        const p = this.player;
        const g = this.game;
        this._cw = vp ? vp.w : g.width;
        this._ch = vp ? vp.h : g.height;
        this._hudScale = vp ? Math.max(1, Math.round(g.hudScale * vp.h / g.height)) : g.hudScale;
        const cw = this._cw;
        const ch = this._ch;
        const margin = this._hudScale * 4;

        // HUD Displacement — lag behind camera
        // Displacement is in world units, convert to pixels and scale for HUD
        const lagX = (this.game.currentState.camera.displacementX || 0) * this.game.worldScale * 0.075;
        const lagY = (this.game.currentState.camera.displacementY || 0) * this.game.worldScale * 0.075;

        ctx.save();
        ctx.textBaseline = 'alphabetic';
        ctx.translate(Math.floor((vp ? vp.x : 0) + lagX), Math.floor((vp ? vp.y : 0) + lagY));

        // Health bar — lower left
        // ... (existing code remains but translated)
        const hImg = this.healthBarEmpty.canvas || this.healthBarEmpty;
        const hbW = (this.healthBarEmpty.width || hImg.width) * this._hudScale;
        const hbH = (this.healthBarEmpty.height || hImg.height) * this._hudScale;
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
                hbX, hbY, srcClipW * this._hudScale, hbH
            );
        }

        // Overheal overflow bars — layered on top of the (full) health bar.
        // Each 100% of overflow fills one bar; once full the next tier stacks
        // over it in the next upgrade-rarity color: common→rare→epic→legendary
        // (green → purple → red → yellow). Caps at 4 tiers (400% overflow).
        this._drawOverheal(ctx, p, hbX, hbY, hbH);

        // Shield bar — above health bar (dimmed when broken)
        // Bar fill region: source pixels 4–75 (71px wide fill area)
        const sImg = this.shieldBarEmpty.canvas || this.shieldBarEmpty;
        const sbW = (this.shieldBarEmpty.width || sImg.width) * this._hudScale;
        const sbH = (this.shieldBarEmpty.height || sImg.height) * this._hudScale;
        const sbX = margin;
        const sbY = hbY - sbH - this._hudScale * 2;
        // Exposed so overlays (multiplayer chat) can anchor just above the bars.
        this.shieldBarTopY = sbY;

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
                sbX, sbY, srcClipW * this._hudScale, sbH
            );
        }

        if (p.shieldBroken) ctx.globalAlpha = 1;

        // Scrap counter — upper right. Briefly garbles during dread glitches.
        const dread = this.game.currentState && this.game.currentState.dread;
        ctx.fillStyle = '#ccddee';
        ctx.font = `${8 * this._hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        // Payout roll-up: after encounter rewards, the counter visibly climbs
        const state = this.game.currentState;
        let shownScrap = p.scrap;
        if (state && state._scrapRoll) {
            const roll = state._scrapRoll;
            const rp = Math.min(1, roll.t / 0.8);
            const eased = 1 - Math.pow(1 - rp, 3);
            shownScrap = Math.round(roll.from + (p.scrap - roll.from) * eased);
        }
        const scrapText = (dread && dread.glitchScrap > 0)
            ? `SCRAP: ${dread.garble(String(p.scrap).length + 1)}`
            : `SCRAP: ${shownScrap}`;
        ctx.fillText(scrapText, cw - margin, this._hudScale * 10);
        ctx.textAlign = 'left';

        // Tracked achievements — vertical stack below the scrap counter.
        this._drawTrackedAchievements(ctx, cw, ch, margin);

        // Coordinates — dread glitches read as a lost fix
        ctx.fillStyle = '#445566';
        ctx.font = `${8 * this._hudScale}px Astro4x`;
        ctx.textAlign = 'right';
        const coordText = (dread && dread.glitchCoords > 0)
            ? '??, ??'
            : `${Math.floor(p.worldX)}, ${Math.floor(p.worldY)}`;
        ctx.fillText(coordText, cw - margin, ch - margin);
        ctx.textAlign = 'left';

        // Radar
        this._drawRadar(ctx, cw, ch, margin);

        // Wave Timer — top left. Multiplayer: also shows which pilot the wave
        // will center on, so the crew can rally to them (or leave them to it).
        const waveTimer = this.game.currentState.waveTimer;
        if (waveTimer !== undefined) {
            const mins = Math.floor(waveTimer / 60);
            const secs = Math.floor(waveTimer % 60).toString().padStart(2, '0');
            ctx.fillStyle = '#ff4444';
            ctx.font = `${8 * this._hudScale}px Astro4x`;
            ctx.textAlign = 'left';
            const timerText = `NEXT WAVE: ${mins}:${secs}`;
            ctx.fillText(timerText, margin, this._hudScale * 10);

            const state = this.game.currentState;
            const sync = state.netSync;
            if (sync && state.net && state.net.playerCount > 1) {
                const targetPid = sync.waveTargetPid;
                const isMe = targetPid === sync.myPid;
                const name = isMe ? 'YOU' : state.net.playerName(targetPid).toUpperCase();
                const tw = ctx.measureText(timerText).width;
                ctx.fillStyle = isMe ? '#ff8866' : '#ffd27a';
                ctx.font = `${6 * this._hudScale}px Astro4x`;
                ctx.fillText(`> TARGET: ${name}`, margin + tw + this._hudScale * 6, this._hudScale * 10);
            }
        }

        // Multiplayer crew roster — beneath the wave countdown.
        this._drawPlayerRoster(ctx, margin);

        this._drawExpBar(ctx, cw, ch);

        ctx.restore();

        // Note: the achievement toast is intentionally NOT drawn here. The
        // shop/pause/cache overlays paint over the HUD after this, which
        // would hide unlocks behind them. PlayingState calls drawToast()
        // separately, after the overlay pass, so toasts sit on top.
    }

    // Public draw for the achievement toast. Called from PlayingState after
    // the overlay/dialog pass so unlocks aren't hidden by the dark backdrop.
    drawToast(ctx) {
        // The toast is always fullscreen (drawn once, after the panes).
        const g = this.game;
        this._cw = g.width;
        this._ch = g.height;
        this._hudScale = g.hudScale;
        this._drawAchievementToast(ctx);
    }

    // Multiplayer crew roster — a stack of translucent cards top-left, below the
    // wave countdown. One card per OTHER pilot (the local player has their own
    // bars/counters elsewhere), outlined in their player color. Each card is a
    // header line — "NAME:  LEVEL n   SCRAP n" with fixed-width columns so the
    // numbers never shuffle the layout — above a real health bar. Drawn inside
    // the HUD displacement transform (caller's save/translate) so it lags and
    // garbles with the rest of the HUD. Single-player draws nothing.
    _drawPlayerRoster(ctx, margin) {
        const state = this.game.currentState;
        const sync = state.netSync;
        if (!sync || !state.net || state.net.playerCount <= 1) return;

        // Crewmates only — remotes come from the host-synced replica fields.
        const rows = [];
        for (const rp of sync.remotePlayers.values()) {
            if (!rp._hasState) continue;
            rows.push({
                pid: rp.pid,
                name: (rp.name || `P${rp.pid}`).toUpperCase(),
                healthPct: rp.maxHealth > 0 ? Math.max(0, Math.min(1, rp.health / rp.maxHealth)) : 0,
                level: rp.level || 0,
                scrap: rp.scrap || 0,
                dead: rp.isDead,
            });
        }
        if (rows.length === 0) return;
        // Stable order: ascending pid.
        rows.sort((a, b) => a.pid - b.pid);

        const s = this._hudScale;
        const font = `${6 * s}px Astro4x`;
        const padX = s * 3;
        const padY = s * 2;
        const lineH = s * 6;     // header text height
        const gapV = s * 2;      // header -> health bar
        const barH = s * 3;
        const colGap = s * 6;    // between name / level / scrap columns
        const cardGap = s * 3;   // between cards

        ctx.textAlign = 'left';
        ctx.font = font;

        // Fixed columns so changing numbers never reflow the row: the name column
        // fits the widest pilot, LEVEL reserves 3 digits, SCRAP reserves 6.
        let nameColW = 0;
        for (const r of rows) nameColW = Math.max(nameColW, ctx.measureText(`${r.name}:`).width);
        const levelLabelW = ctx.measureText('LEVEL ').width;
        const scrapLabelW = ctx.measureText('SCRAP ').width;
        const levelColW = levelLabelW + ctx.measureText('000').width;
        const scrapColW = scrapLabelW + ctx.measureText('000000').width;
        const innerW = nameColW + colGap + levelColW + colGap + scrapColW;
        const boxW = innerW + padX * 2;
        const cardH = padY + lineH + gapV + barH + padY;

        // Start just below where the wave countdown line sits.
        let y = s * 16;
        for (const r of rows) {
            const color = playerColor(r.pid);
            ctx.save();
            if (r.dead) ctx.globalAlpha = 0.4;

            // Translucent card so it never obscures the play area.
            ctx.fillStyle = 'rgba(8, 12, 20, 0.45)';
            ctx.fillRect(margin, y, boxW, cardH);

            // Thin, semi-transparent outline in the pilot's color.
            const lw = Math.max(1, s * 0.5);
            ctx.globalAlpha *= 0.7;
            ctx.strokeStyle = color;
            ctx.lineWidth = lw;
            ctx.strokeRect(margin + lw / 2, y + lw / 2, boxW - lw, cardH - lw);
            ctx.globalAlpha = r.dead ? 0.4 : 1;

            // Header: name in the pilot's color, level/scrap in muted labels.
            ctx.textBaseline = 'top';
            ctx.font = font;
            const tx = margin + padX;
            const ty = y + padY;
            const levelX = tx + nameColW + colGap;
            const scrapX = levelX + levelColW + colGap;

            ctx.fillStyle = color;
            ctx.fillText(`${r.name}:`, tx, ty);
            ctx.fillStyle = '#8fa0b4';
            ctx.fillText('LEVEL', levelX, ty);
            ctx.fillText('SCRAP', scrapX, ty);
            ctx.fillStyle = '#cdd9e6';
            ctx.fillText(String(r.level), levelX + levelLabelW, ty);
            ctx.fillText(String(r.scrap), scrapX + scrapLabelW, ty);

            // Health bar — full inner width, fill tinted from red (low) to green.
            const barY = ty + lineH + gapV;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
            ctx.fillRect(tx, barY, innerW, barH);
            ctx.fillStyle = this._healthColor(r.healthPct);
            ctx.fillRect(tx, barY, Math.round(innerW * r.healthPct), barH);

            ctx.restore();
            y += cardH + cardGap;
        }
        ctx.textBaseline = 'alphabetic';
    }

    // Health-bar fill tint: red at empty, green at full (orange in between).
    _healthColor(t) {
        t = Math.max(0, Math.min(1, t));
        const r = Math.round(255 + (90 - 255) * t);
        const g = Math.round(70 + (220 - 70) * t);
        const b = Math.round(70 + (110 - 70) * t);
        return `rgb(${r}, ${g}, ${b})`;
    }

    _drawOverheal(ctx, p, hbX, hbY, hbH) {
        if (!this.healthBarOverflow || !p.overheal || p.overheal <= 0 || p.maxHealth <= 0) return;

        // Upgrade-rarity colors for stacked overflow tiers, in fill order:
        // common (green), rare (purple), epic (red), legendary (yellow).
        const colors = ['#00ff00', '#b400ff', '#ff0000', '#ffff00'];
        const maxTiers = colors.length;
        // Overflow as a fraction of max health, capped at the number of tiers.
        const ovPct = Math.min(p.overheal / p.maxHealth, maxTiers);
        const tierIndex = Math.min(Math.floor(ovPct), maxTiers - 1);
        const frac = ovPct - tierIndex; // current filling tier (0–1; 1 at the cap)

        const asset = this.healthBarOverflow;
        const img = asset.canvas || asset;
        const ofH = asset.height || img.height;
        const prescale = img.width / (asset.width || img.width);

        // Same fill region as the health bar full asset.
        const fillStart = 27;
        const fillEnd = 118;
        const fillWidth = fillEnd - fillStart;

        const drawTier = (color, fillFrac) => {
            if (fillFrac <= 0) return;
            const srcClipW = fillStart + Math.floor(fillWidth * fillFrac);
            const tinted = this._getTintedOverflow(color);
            ctx.drawImage(
                tinted,
                0, 0, srcClipW * prescale, ofH * prescale,
                hbX, hbY, srcClipW * this._hudScale, hbH
            );
        };

        // Completed lower tier sits full underneath, current tier fills over it.
        if (tierIndex > 0) drawTier(colors[tierIndex - 1], 1);
        drawTier(colors[tierIndex], frac);
    }

    // Returns a cached canvas of the (grayscale) overflow bar tinted to `color`,
    // preserving the art's shading via a multiply blend masked to its alpha.
    // The rarity color is blended heavily toward white first so the tint reads
    // as a soft pastel rather than a harsh, fully-saturated wash — this also
    // keeps the green tier distinct from the (darker) base health-bar green.
    _getTintedOverflow(color) {
        if (!this._overflowTintCache) this._overflowTintCache = new Map();
        const cached = this._overflowTintCache.get(color);
        if (cached) return cached;

        const asset = this.healthBarOverflow;
        const img = asset.canvas || asset;
        const w = img.width;
        const h = img.height;

        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d');
        cx.imageSmoothingEnabled = false;

        cx.drawImage(img, 0, 0);
        cx.globalCompositeOperation = 'multiply';
        cx.fillStyle = this._desaturate(color, 0.55);
        cx.fillRect(0, 0, w, h);
        // Re-apply the source alpha so transparent areas stay transparent.
        cx.globalCompositeOperation = 'destination-in';
        cx.drawImage(img, 0, 0);

        this._overflowTintCache.set(color, c);
        return c;
    }

    // Blend a #rrggbb color toward white by `amt` (0 = unchanged, 1 = white).
    _desaturate(hex, amt) {
        const n = parseInt(hex.slice(1), 16);
        const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
        const mix = (ch) => Math.round(ch + (255 - ch) * amt);
        const to2 = (v) => v.toString(16).padStart(2, '0');
        return `#${to2(mix(r))}${to2(mix(g))}${to2(mix(b))}`;
    }


    _drawRadar(ctx, cw, ch, margin) {
        if (!this.player.hasRadar) return;

        const img = this.game.assets.get('radar_frame');
        const backImg = this.game.assets.get('radar_frame_back');
        if (!img) return;

        const uiScale = this._hudScale;
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
            const radarRange = 2800 * (fovMult * 0.75);
            const radarRangeSq = radarRange * radarRange;
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

                    if (distSq < radarRangeSq) {
                        const scale = radarSize / radarRange;
                        const rawX = cx + dx * scale;
                        const rawY = cy + dy * scale;

                        // Snap to HUD grid pixels (multiples of uiScale)
                        const snappedX = Math.floor(rawX / uiScale) * uiScale;
                        const snappedY = Math.floor(rawY / uiScale) * uiScale;

                        const isAsteroid = e.size !== undefined;

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
                drawDot(state.revealedShops, '#44aaff', 1);
                drawDot(state.events, '#ffcc00', 1);
                drawDot(state.enemies, '#ff4444', 1);
                drawDot(state.encounters, '#44ffaa', 1);
            }

            // New-intel ping: one bright sweep pulse expanding across the dish
            const pingT = (this.game.currentState && this.game.currentState.radarPingT) || 0;
            if (pingT > 0) {
                const p = 1 - pingT / 1.2;
                this.radarCtx.globalAlpha = (1 - p) * 0.8;
                this.radarCtx.strokeStyle = '#ffcc00';
                this.radarCtx.lineWidth = Math.max(1, uiScale);
                this.radarCtx.beginPath();
                this.radarCtx.arc(cx, cy, Math.max(1, p * (rw / 2)), 0, Math.PI * 2);
                this.radarCtx.stroke();
                this.radarCtx.globalAlpha = 1;
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
        const hudScale = this._hudScale;
        // 2/5 of width on a normal widescreen pane; narrower on tall/narrow panes
        // (e.g. side-by-side co-op) so the bar doesn't dominate and its segment
        // texture isn't stretched across the whole pane.
        const aspect = cw / ch;
        const widthFrac = aspect >= 1.7 ? 0.4 : Math.max(0.18, 0.4 * (aspect / 1.7));
        const barW = Math.floor(cw * widthFrac);
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
                // The two per-frame ctx.filter blur passes are the single
                // biggest constant HUD cost and brutal on weak/software-raster
                // hardware. Skip the outer bloom there (the bar fill + internal
                // pulse-wave still draw, so it stays readable and animated);
                // capable hardware renders the full bloom unchanged.
                if (!this.game.lowPerfMode) {
                // Reuse a cached offscreen canvas for the aura
                if (!this._auraTempCanvas) {
                    this._auraTempCanvas = document.createElement('canvas');
                    this._auraTempCtx = this._auraTempCanvas.getContext('2d');
                }
                if (this._auraTempCanvas.width !== barW || this._auraTempCanvas.height !== barH) {
                    this._auraTempCanvas.width = barW;
                    this._auraTempCanvas.height = barH;
                }
                const auraTempCanvas = this._auraTempCanvas;
                const auraTempCtx = this._auraTempCtx;
                auraTempCtx.clearRect(0, 0, barW, barH);
                
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
                } // end bloom (skipped in lowPerfMode)

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
                ctx.globalCompositeOperation = 'screen';
                ctx.drawImage(this.expGlowCanvas, x, y);
                ctx.restore();
            }
        }

        // Draw Level Text
        ctx.save();
        const state = this.game.currentState;
        // Level-up queues are per-pilot (Player._levelUpQueue) — each HUD shows
        // the claim call-to-action / flashing level only for ITS OWN pilot.
        const q = this.player._levelUpQueue;
        const hasUnclaimed = !!(q && q.length > 0);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = hudScale * 1; // 1 HUD-pixel outline
        ctx.lineJoin = 'round';
        ctx.font = `${6 * hudScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const textY = y - hudScale * 1.5;

        if (hasUnclaimed) {
            // Flash between yellow and white
            const flash = Math.sin(performance.now() * 0.005) * 0.5 + 0.5;
            const r = Math.round(255);
            const g = Math.round(255);
            const b = Math.round(flash * 255);
            ctx.fillStyle = `rgb(${r},${g},${b})`;
        } else {
            ctx.fillStyle = '#ffffff';
        }
        ctx.strokeText(`LEVEL ${p.level}`, cw / 2, textY);
        ctx.fillText(`LEVEL ${p.level}`, cw / 2, textY);

        // "CLAIM LEVELS IN INVENTORY" prompt when level-ups are queued.
        // Yellow flashing white — the exact same treatment as the LEVEL text
        // above, so the two read as one call-to-action. Plus a few light
        // sparks drifting off the text (no size/motion — that reads nauseating).
        if (hasUnclaimed) {
            const now = performance.now();
            const dt = this._lastBannerTime
                ? Math.min(0.05, (now - this._lastBannerTime) / 1000) : 0;
            this._lastBannerTime = now;

            const hintY = textY - hudScale * 9;
            const label = 'CLAIM LEVELS IN INVENTORY';
            // Same flash as the level text: yellow (b=0) <-> white (b=255).
            const b = Math.round((Math.sin(now * 0.005) * 0.5 + 0.5) * 255);
            ctx.font = `${6 * hudScale}px Astro5x`;
            ctx.lineWidth = hudScale * 1; // match the level text's 1px outline
            ctx.fillStyle = `rgb(255,255,${b})`;
            ctx.strokeText(label, cw / 2, hintY);
            ctx.fillText(label, cw / 2, hintY);

            // Light sparks rising off the prompt (sparse).
            const tw = ctx.measureText(label).width;
            this._updateBannerSparks(ctx, cw / 2, hintY, tw, hudScale, dt);
        } else {
            this._lastBannerTime = 0;
        }
        ctx.restore();
    }

    // A handful of cosmetic sparks drifting up off the claim-levels prompt.
    // Purely visual (screen space) — uses Math.random so it never touches the
    // seeded gameplay RNG stream. Capped low so it stays "a few embers".
    _updateBannerSparks(ctx, centerX, baseY, textW, hudScale, dt) {
        if (!this._bannerSparks) this._bannerSparks = [];
        const sparks = this._bannerSparks;

        // Spawn sparsely (~6/sec), capped at a small handful.
        this._sparkAccum = (this._sparkAccum || 0) + dt;
        const interval = 0.16;
        while (this._sparkAccum >= interval) {
            this._sparkAccum -= interval;
            if (sparks.length >= 8) continue;
            const spread = Math.min(textW, hudScale * 80);
            sparks.push({
                x: centerX + (Math.random() - 0.5) * spread,
                y: baseY - hudScale * 1.5,
                vx: (Math.random() - 0.5) * hudScale * 5,
                vy: -hudScale * (8 + Math.random() * 8),
                life: 0,
                ttl: 0.5 + Math.random() * 0.5,
            });
        }

        ctx.save();
        const sz = Math.max(1, Math.round(hudScale));
        for (let i = sparks.length - 1; i >= 0; i--) {
            const s = sparks[i];
            s.life += dt;
            if (s.life >= s.ttl) { sparks.splice(i, 1); continue; }
            s.x += s.vx * dt;
            s.y += s.vy * dt;
            s.vy += hudScale * 10 * dt;   // ease the rise so they hang then settle
            ctx.globalAlpha = 1 - s.life / s.ttl;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(Math.round(s.x), Math.round(s.y), sz, sz);
        }
        ctx.restore();
    }

    // Vertical stack of player-pinned achievements anchored under the scrap
    // counter. Mirrors the menu-card layout (icon + name + description +
    // flavor) at HUD scale so the player can read the unlock condition and
    // tone hint at a glance. Hidden achievements mask their description with
    // "???" but still surface their name + flavor (the only hint the player
    // is allowed to see while it's locked).
    _drawTrackedAchievements(ctx, cw, ch, margin) {
        const mgr = this.game.achievements;
        if (!mgr) return;
        const tracked = mgr.getTrackedAchievements();
        if (tracked.length === 0) return;

        const hudScale = this._hudScale;
        const rowW = Math.floor(hudScale * 130);
        const rowH = Math.floor(hudScale * 32);
        const rowGap = Math.floor(hudScale * 2);
        const iconSize = rowH;
        const stackX = cw - margin - rowW;
        const stackY = Math.floor(hudScale * 18);
        const padTop = Math.floor(hudScale * 2);
        const padBot = Math.floor(hudScale * 2);

        // Wrap cache — keyed on text+width+font so a resize or string change
        // invalidates the entry. Built lazily to avoid an unused Map on
        // sessions where nothing is tracked.
        if (!this._trackedWrapCache) this._trackedWrapCache = new Map();

        ctx.save();
        ctx.textBaseline = 'alphabetic';
        for (let i = 0; i < tracked.length; i++) {
            const ach = tracked[i];
            const y = stackY + i * (rowH + rowGap);

            // Panel
            ctx.fillStyle = 'rgba(8, 16, 28, 0.82)';
            ctx.fillRect(stackX, y, rowW, rowH);

            // Progress fill behind everything else — matches the menu card's
            // partial-width tint. Only shown when the achievement opts in.
            // Bar starts at the right edge of the icon so it tints the text
            // area without fighting with the artwork (mirrors menu layout).
            let progress = null;
            if (typeof ach.progress === 'function') {
                try { progress = ach.progress(mgr); } catch (e) { progress = null; }
                if (typeof progress !== 'number') progress = null;
                else progress = Math.max(0, Math.min(1, progress));
            }
            if (progress !== null && progress > 0) {
                const barX = stackX + Math.floor(hudScale * 1) + iconSize;
                const barMaxW = (stackX + rowW) - barX;
                const fillW = Math.max(1, Math.floor(barMaxW * progress));
                ctx.fillStyle = 'rgba(34, 85, 106, 0.55)';
                ctx.fillRect(barX, y, fillW, rowH);
            }

            ctx.strokeStyle = 'rgba(68, 221, 255, 0.55)';
            ctx.lineWidth = 1;
            ctx.strokeRect(stackX + 0.5, y + 0.5, rowW - 1, rowH - 1);

            // Left accent
            ctx.fillStyle = '#ffcc44';
            ctx.fillRect(stackX, y, Math.max(1, Math.floor(hudScale * 0.75)), rowH);

            // Icon
            const iconX = stackX + Math.floor(hudScale * 1);
            const asset = ach.icon ? this.game.assets.get(ach.icon) : null;
            if (asset) {
                const img = asset.canvas || asset;
                const aw = asset.width || img.width;
                const ah = asset.height || img.height;
                const scale = Math.min(iconSize / aw, iconSize / ah);
                const dw = aw * scale;
                const dh = ah * scale;
                ctx.save();
                ctx.globalAlpha = 0.9;
                ctx.drawImage(img,
                    Math.floor(iconX + (iconSize - dw) / 2),
                    Math.floor(y + (iconSize - dh) / 2), dw, dh);
                ctx.restore();
            } else {
                ctx.fillStyle = 'rgba(20, 40, 60, 0.9)';
                ctx.fillRect(iconX, y, iconSize, iconSize);
            }

            // Text region
            const textX = iconX + iconSize + Math.floor(hudScale * 3);
            const textRight = stackX + rowW - Math.floor(hudScale * 3);
            const textW = textRight - textX;

            const showDesc = !ach.hidden;
            const nameFontPx = Math.floor(5 * hudScale);
            const bodyFontPx = Math.floor(3.5 * hudScale);
            const nameLineH = Math.floor(hudScale * 6);
            const bodyLineH = Math.floor(hudScale * 4.5);
            const gapAfterName = Math.floor(hudScale * 1.5);
            const gapAfterDesc = Math.floor(hudScale * 1);

            ctx.font = `${nameFontPx}px Astro5x`;
            const nameStr = this._truncateText(ctx, ach.name.toUpperCase(), textW);

            // Compute how many body lines the card can hold, then split that
            // budget between description and flavor (description gets first
            // pick — the player needs the unlock condition more than the lore).
            // Wrap with no ellipsis; if more lines exist than fit, we just
            // drop them silently rather than mark the cut.
            const availBodyH = rowH - padTop - padBot - nameLineH - gapAfterName;
            const maxBodyLines = Math.max(0, Math.floor(availBodyH / bodyLineH));

            ctx.font = `${bodyFontPx}px Astro4x`;
            const descAll = this._wrapTrackedNoCap(ctx,
                showDesc ? ach.description : '???', textW,
                `${ach.id}@d@${showDesc}`);
            const flavorAll = ach.flavor
                ? this._wrapTrackedNoCap(ctx, '"' + ach.flavor + '"', textW, `${ach.id}@f`)
                : [];

            // Allocate lines. Try to reserve at least 1 line for flavor when
            // both fit; if not, description wins the remaining budget.
            let descBudget;
            let flavorBudget;
            if (flavorAll.length === 0) {
                descBudget = Math.min(descAll.length, maxBodyLines);
                flavorBudget = 0;
            } else if (descAll.length + flavorAll.length <= maxBodyLines) {
                descBudget = descAll.length;
                flavorBudget = flavorAll.length;
            } else if (descAll.length >= maxBodyLines) {
                descBudget = maxBodyLines;
                flavorBudget = 0;
            } else {
                descBudget = descAll.length;
                flavorBudget = Math.min(flavorAll.length, maxBodyLines - descAll.length);
            }
            // Flavor needs one body-line of vertical real estate for its
            // gap-after-desc — if it eats into our budget, drop a flavor line.
            if (flavorBudget > 0) {
                const flavorSpace = descBudget * 0 + gapAfterDesc;
                const flavorRoom = availBodyH - descBudget * bodyLineH - flavorSpace;
                const maxFlavor = Math.max(0, Math.floor(flavorRoom / bodyLineH));
                flavorBudget = Math.min(flavorBudget, maxFlavor);
            }
            const descLines = descAll.slice(0, descBudget);
            const flavorLines = flavorAll.slice(0, flavorBudget);

            let textY = y + padTop;

            // Name
            ctx.font = `${nameFontPx}px Astro5x`;
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(nameStr, textX, textY);
            textY += nameLineH;

            // Description
            if (descLines.length > 0) {
                textY += gapAfterName;
                ctx.font = `${bodyFontPx}px Astro4x`;
                ctx.fillStyle = '#ccddee';
                for (const line of descLines) {
                    ctx.fillText(line, textX, textY);
                    textY += bodyLineH;
                }
            }

            // Flavor
            if (flavorLines.length > 0) {
                textY += gapAfterDesc;
                ctx.font = `${bodyFontPx}px Astro4x`;
                ctx.fillStyle = '#88aabb';
                for (const line of flavorLines) {
                    ctx.fillText(line, textX, textY);
                    textY += bodyLineH;
                }
            }
        }
        ctx.restore();
    }

    // Full wrap with no ellipsis or line cap. Caller slices the result to fit
    // their available vertical room. Cached on text+width+font so we don't
    // re-measure every frame.
    _wrapTrackedNoCap(ctx, text, maxWidth, cacheKey) {
        if (!text) return [];
        const fullKey = `nocap@${cacheKey}@${Math.floor(maxWidth)}@${ctx.font}`;
        const cached = this._trackedWrapCache.get(fullKey);
        if (cached) return cached;

        const words = text.split(/\s+/);
        const lines = [];
        let current = '';
        for (const word of words) {
            const probe = current ? current + ' ' + word : word;
            if (ctx.measureText(probe).width <= maxWidth) current = probe;
            else { if (current) lines.push(current); current = word; }
        }
        if (current) lines.push(current);
        this._trackedWrapCache.set(fullKey, lines);
        return lines;
    }

    _wrapTracked(ctx, text, maxWidth, maxLines, cacheKey) {
        if (!text) return [];
        const fullKey = `${cacheKey}@${Math.floor(maxWidth)}@${ctx.font}@L${maxLines}`;
        const cached = this._trackedWrapCache.get(fullKey);
        if (cached) return cached;

        const words = text.split(/\s+/);
        const lines = [];
        let current = '';
        for (const word of words) {
            const probe = current ? current + ' ' + word : word;
            if (ctx.measureText(probe).width <= maxWidth) current = probe;
            else { if (current) lines.push(current); current = word; }
        }
        if (current) lines.push(current);

        let result;
        if (lines.length <= maxLines) {
            result = lines;
        } else {
            result = lines.slice(0, maxLines);
            let last = result[maxLines - 1];
            while (last.length > 0 && ctx.measureText(last + '…').width > maxWidth) {
                last = last.slice(0, -1);
            }
            result[maxLines - 1] = last + '…';
        }
        this._trackedWrapCache.set(fullKey, result);
        return result;
    }

    _drawAchievementToast(ctx) {
        const mgr = this.game.achievements;
        if (!mgr) return;

        // Self-clock so we don't need PlayingState to thread dt through draw.
        const now = performance.now();
        const dt = this._toastLastNow ? Math.min(0.1, (now - this._toastLastNow) / 1000) : 0.016;
        this._toastLastNow = now;

        const state = mgr.updateToast(dt);
        if (!state) return;

        const { ach, t } = state;
        const cw = this._cw;
        const ch = this._ch;
        const hudScale = this._hudScale;

        // Slide in over the first 12%, hold, slide out over the last 18%.
        let slide = 1;
        if (t < 0.12)      slide = t / 0.12;
        else if (t > 0.82) slide = Math.max(0, 1 - (t - 0.82) / 0.18);
        const eased = 1 - Math.pow(1 - slide, 3);

        // Box anchored bottom-right. Slides in horizontally from off-screen
        // (right edge) so the panel doesn't briefly cover the shield bar on
        // the left or the level text in the middle.
        const margin = Math.floor(hudScale * 6);
        const iconSize = Math.floor(hudScale * 14);
        const boxW = Math.floor(hudScale * 110);
        const boxH = Math.floor(hudScale * 22);
        const restingX = cw - margin - boxW;
        const offRightMax = boxW + margin;
        const boxX = Math.floor(restingX + (1 - eased) * offRightMax);
        const boxY = ch - margin - boxH;

        ctx.save();
        ctx.globalAlpha = eased;

        // Panel
        ctx.fillStyle = 'rgba(8, 16, 28, 0.94)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.strokeStyle = '#44ddff';
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, boxW - 1, boxH - 1);

        // Left accent bar
        ctx.fillStyle = '#44ddff';
        ctx.fillRect(boxX, boxY, Math.max(1, Math.floor(hudScale * 0.75)), boxH);

        // Icon box — placeholder when achievement has no icon asset. Sits
        // flush against the left edge of the panel.
        const iconX = boxX + Math.floor(hudScale * 3);
        const iconY = boxY + Math.floor((boxH - iconSize) / 2);
        const asset = ach.icon ? this.game.assets.get(ach.icon) : null;
        if (asset) {
            const img = asset.canvas || asset;
            const aw = asset.width || img.width;
            const ah = asset.height || img.height;
            const scale = Math.min(iconSize / aw, iconSize / ah);
            const dw = aw * scale;
            const dh = ah * scale;
            ctx.drawImage(img, Math.floor(iconX + (iconSize - dw) / 2), Math.floor(iconY + (iconSize - dh) / 2), dw, dh);
        } else {
            ctx.fillStyle = 'rgba(20, 40, 60, 0.9)';
            ctx.fillRect(iconX, iconY, iconSize, iconSize);
            ctx.strokeStyle = 'rgba(68, 221, 255, 0.5)';
            ctx.strokeRect(iconX + 0.5, iconY + 0.5, iconSize - 1, iconSize - 1);
        }

        const textX = iconX + iconSize + Math.floor(hudScale * 3);

        // Header
        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(3 * hudScale)}px Astro4x`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('ACHIEVEMENT UNLOCKED', textX, boxY + hudScale * 2);

        // Title — truncate with ellipsis if it overruns the panel.
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.floor(4.5 * hudScale)}px Astro5x`;
        const titleMaxW = boxX + boxW - textX - Math.floor(hudScale * 3);
        const title = this._truncateText(ctx, ach.name.toUpperCase(), titleMaxW);
        ctx.fillText(title, textX, boxY + hudScale * 9);

        ctx.restore();
    }

    _truncateText(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        const ellipsis = '…';
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) lo = mid;
            else hi = mid - 1;
        }
        return text.slice(0, lo) + ellipsis;
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
