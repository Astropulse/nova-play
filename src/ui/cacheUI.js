/**
 * CacheUI — rolling/reveal animation for Space Caches.
 *
 * This class owns ONLY the animation state machine and the overlay that
 * renders on top of the cache inventory grid.  All actual inventory
 * rendering and drag-drop interaction is handled by PlayingState using
 * the same infrastructure as the shop (_getInventoryLayout,
 * _drawInventoryGrid, draggedItem, etc.).
 *
 * States:
 *   OPENING   — panel slides in (handled by PlayingState alpha)
 *   ROLLING   — spinning slot-machine animation
 *   REVEALING — item solidifies, flashes, slides to slot
 *   WAIT_EXTRA— brief pause before checking for extra roll
 *   IDLE      — all rolls done; player drags items out
 *   CLOSING   — panel fades out
 *   DONE      — fully closed; parent destroys this object
 */

import { Inventory } from '../engine/inventory.js';
import { UPGRADES, RARITY_WEIGHTS, RARITY_COLORS } from '../data/upgrades.js';

// ─── Tunable UI constants ────────────────────────────────────────────────────
const UI = {
    openDuration:  0.0,
    closeDuration: 0.0,

    rollDuration:        2.8,
    rollFlashRateStart:  4,    // silhouette frames/sec at start (slow spin-up)
    rollFlashRatePeak:   25,   // peak speed reached at rollFlashPeakAt
    rollFlashRateEnd:    1.2,  // silhouette frames/sec at end (slow crawl to winner)
    rollFlashPeakAt:     0.35,  // progress (0–1) where peak speed is reached

    extraWaitDuration:   0.2,
    solidifyFlashDuration: 0.4,
    slideDuration:       0.35,

    glowPulseSpeed:      3.5,
    glitchChromaticMax:  4,    // max chromatic-aberration offset (UI pixels)
    scanlineAlpha:       0.10,

    gridMin: 1,
    gridMax: 4,
};

// ─── CacheUI state enum ──────────────────────────────────────────────────────
export const CUI_STATE = {
    OPENING:    'opening',
    ROLLING:    'rolling',
    REVEALING:  'revealing',
    WAIT_EXTRA: 'wait_extra',
    IDLE:       'idle',
    CLOSING:    'closing',
    DONE:       'done',
};

// ─── CacheUI class ───────────────────────────────────────────────────────────
export class CacheUI {
    constructor(game, cache, playerInventory) {
        this.game  = game;
        this.cache = cache;
        this.playerInventory = playerInventory;

        // Reuse the persistent inventory stored on the cache entity if it exists,
        // otherwise create a new random-sized one for the first open.
        if (cache._cachedInventory) {
            this.cacheInventory   = cache._cachedInventory;
            this.revealedItems    = cache._cachedRevealedItems || [];
            this._extraRollsGiven = cache._cachedExtraRolls   || 0;
            this._skipToIdle      = true;
            this.uiState          = CUI_STATE.IDLE;
        } else {
            const cols = UI.gridMin + Math.floor(Math.random() * (UI.gridMax - UI.gridMin + 1));
            const rows = UI.gridMin + Math.floor(Math.random() * (UI.gridMax - UI.gridMin + 1));
            this.cacheInventory   = new Inventory(cols, rows);
            this.revealedItems    = [];
            this._extraRollsGiven = 0;
            this._skipToIdle      = false;
            this.uiState          = CUI_STATE.ROLLING;
            // Persist on the cache entity
            cache._cachedInventory    = this.cacheInventory;
            cache._cachedRevealedItems = this.revealedItems;
        }

        this.stateTimer = 0;
        this.panelAlpha = 1;

        // Rolling
        this.rollTimer      = 0;
        this.rollFlashTimer = 0;
        this.rollIndex      = 0;
        this.silhouettes    = [];
        this.currentRollItem = null;

        // Reveal / slide
        this.revealItem   = null;
        this.revealFlash  = 0;
        this.slideT       = 0;
        this.slideToGridX = 0;
        this.slideToGridY = 0;

        this.glowTimer     = 0;
        this.closed        = false;
        this.skipRequested = false;

        this._buildSilhouettes();
        if (!this._skipToIdle) {
            this._prepareNextRoll();   // pre-pick winner; does NOT change state
        } else {
            this.currentRollItem = null;
        }
    }

    get isClosed()  { return this.closed; }
    get isAnimating() {
        return this.uiState === CUI_STATE.ROLLING ||
               this.uiState === CUI_STATE.REVEALING;
    }

    // ── Silhouette pool — only upgrades that fit in this grid ────────────────
    _buildSilhouettes() {
        const maxW = this.cacheInventory.cols;
        const maxH = this.cacheInventory.rows;
        const fitting = UPGRADES.filter(u => u.width <= maxW && u.height <= maxH);
        // Fall back to all upgrades if nothing fits (shouldn't happen)
        const pool = fitting.length > 0 ? fitting : [...UPGRADES];
        this.silhouettes = pool.sort(() => Math.random() - 0.5).slice(0, Math.min(16, pool.length));
    }

    // ── Luck-weighted roll (uses actual slot fit as eligibility check) ────────
    _rollUpgrade() {
        const luck = (this.game.currentState?.player?.luck) ?? 1.0;

        const possible = UPGRADES.filter(u =>
            u.rarity !== 'unique' &&
            !this.revealedItems.find(r => r.id === u.id) &&
            this._findSlotFor(u) !== null
        );
        if (possible.length === 0) return null;

        let total = 0;
        const weights = possible.map(u => {
            const base = RARITY_WEIGHTS[u.rarity] || 10;
            const w = Math.pow(base, 1 / Math.max(0.1, luck));
            total += w;
            return w;
        });

        let roll = Math.random() * total;
        for (let i = 0; i < possible.length; i++) {
            roll -= weights[i];
            if (roll <= 0) return possible[i];
        }
        return possible[0];
    }

    _findSlotFor(upgrade) {
        for (let y = 0; y <= this.cacheInventory.rows - upgrade.height; y++) {
            for (let x = 0; x <= this.cacheInventory.cols - upgrade.width; x++) {
                if (this.cacheInventory.canFit(upgrade, x, y)) return { x, y };
            }
        }
        return null;
    }

    // ── Pre-determine next roll result (no state change) ─────────────────────
    _prepareNextRoll() {
        const upgrade = this._rollUpgrade();
        if (!upgrade) { this.currentRollItem = null; return; }
        const slot = this._findSlotFor(upgrade);
        if (!slot)    { this.currentRollItem = null; return; }

        this.currentRollItem = { upgrade, slotX: slot.x, slotY: slot.y };
        this.rollTimer      = 0;
        this.rollFlashTimer = 0;
        this.rollIndex      = 1;   // start at 1; index 0 is reserved for the winner
        this.skipRequested  = false;

        // Guarantee the winner is in silhouettes[0] so the roll can land on it
        this.silhouettes[0] = upgrade;
    }

    // ── Kick off rolling for the pre-determined item ──────────────────────────
    _startNextRoll() {
        this._prepareNextRoll();
        this.uiState = this.currentRollItem ? CUI_STATE.ROLLING : CUI_STATE.IDLE;
    }

    // ─── Update ──────────────────────────────────────────────────────────────
    update(dt) {
        if (this.uiState === CUI_STATE.DONE) return;

        this.glowTimer  += dt;
        this.stateTimer += dt;

        switch (this.uiState) {

            case CUI_STATE.OPENING: {
                this.panelAlpha = Math.min(1, this.stateTimer / UI.openDuration);
                if (this.stateTimer >= UI.openDuration) {
                    this.panelAlpha = 1;
                    this.stateTimer = 0;
                    if (this._skipToIdle) {
                        this.uiState = CUI_STATE.IDLE;
                    } else {
                        this.uiState = this.currentRollItem ? CUI_STATE.ROLLING : CUI_STATE.IDLE;
                    }
                }
                break;
            }

            case CUI_STATE.ROLLING: {
                this.rollTimer += dt;
                const progress = Math.min(1, this.rollTimer / UI.rollDuration);
                // slow start → fast peak → slow crawl to winner
                let rate;
                if (progress < UI.rollFlashPeakAt) {
                    const t = progress / UI.rollFlashPeakAt;
                    rate = UI.rollFlashRateStart + (UI.rollFlashRatePeak - UI.rollFlashRateStart) * t;
                } else {
                    const t = (progress - UI.rollFlashPeakAt) / (1 - UI.rollFlashPeakAt);
                    rate = UI.rollFlashRatePeak * Math.pow(UI.rollFlashRateEnd / UI.rollFlashRatePeak, t);
                }
                this.rollFlashTimer += dt;
                if (this.rollFlashTimer >= 1 / rate) {
                    this.rollFlashTimer -= 1 / rate;
                    // In the final 25% of the roll, lock onto the winner (index 0)
                    if (progress < 0.75) {
                        const pool = Math.max(1, this.silhouettes.length - 1);
                        this.rollIndex = (this.rollIndex % pool) + 1;
                    } else {
                        this.rollIndex = 0;
                    }
                    this.game.sounds.play('select', 0.35);
                }
                if (this.skipRequested || progress >= 1.0) this._beginReveal();
                break;
            }

            case CUI_STATE.REVEALING: {
                this.slideT     = Math.min(1.0, this.slideT + dt / UI.slideDuration);
                this.revealFlash = Math.max(0, this.revealFlash - dt / UI.solidifyFlashDuration);
                if (this.skipRequested || this.slideT >= 1.0) {
                    this.slideT      = 1.0;
                    this.revealFlash = 0;
                    this._finalizeReveal();
                }
                break;
            }

            case CUI_STATE.WAIT_EXTRA: {
                if (this.stateTimer >= UI.extraWaitDuration) this._checkExtraRoll();
                break;
            }

            case CUI_STATE.IDLE:
                break;

            case CUI_STATE.CLOSING: {
                this.panelAlpha = Math.max(0, 1 - this.stateTimer / UI.closeDuration);
                if (this.stateTimer >= UI.closeDuration) {
                    this.uiState = CUI_STATE.DONE;
                    this.closed  = true;
                }
                break;
            }
        }
    }

    _beginReveal() {
        if (!this.currentRollItem) { this.uiState = CUI_STATE.IDLE; return; }
        const { slotX, slotY } = this.currentRollItem;
        this.revealItem   = this.currentRollItem.upgrade;
        this.revealFlash  = 1.0;
        this.slideT       = 0;
        this.slideToGridX = slotX;
        this.slideToGridY = slotY;
        this.uiState      = CUI_STATE.REVEALING;
        this.stateTimer   = 0;
        this.game.sounds.play('buy', 0.8);
    }

    _finalizeReveal() {
        if (!this.revealItem) return;
        const { slotX, slotY } = this.currentRollItem;
        this.cacheInventory.addItem(this.revealItem, slotX, slotY);
        this.revealedItems.push(this.revealItem);
        // Keep cache entity in sync so re-opens show the same state
        this.cache._cachedExtraRolls = this._extraRollsGiven;
        this.revealItem      = null;
        this.currentRollItem = null;
        this.uiState         = CUI_STATE.WAIT_EXTRA;
        this.stateTimer      = 0;
    }

    _checkExtraRoll() {
        if (this._extraRollsGiven >= 3) { this.uiState = CUI_STATE.IDLE; return; }

        // Must have room for another item
        const candidate = this._rollUpgrade();
        if (!candidate) { this.uiState = CUI_STATE.IDLE; return; }

        const luck   = (this.game.currentState?.player?.luck) ?? 1.0;
        const chance = Math.min(0.9, 0.25 * luck);
        if (Math.random() < chance) {
            this._extraRollsGiven++;
            this._startNextRoll();
        } else {
            this.uiState = CUI_STATE.IDLE;
        }
    }

    close() {
        if (this.uiState === CUI_STATE.DONE) return;
        this.uiState = CUI_STATE.DONE;
        this.closed  = true;
        this.game.sounds.play('click', 0.5);
    }

    // ─── Draw — ONLY the animation overlay on top of the cache grid ──────────
    // Called by PlayingState._drawCacheOverlay() with the exact grid coords.
    draw(ctx, gx, gy, gw, gh, slotSize, us) {
        if (this.uiState === CUI_STATE.ROLLING) {
            this._drawRolling(ctx, gx, gy, gw, gh, slotSize, us);
        } else if (this.uiState === CUI_STATE.REVEALING) {
            this._drawRevealing(ctx, gx, gy, gw, gh, slotSize, us);
        }
    }

    // ── Blue slot-machine rolling overlay ────────────────────────────────────
    _drawRolling(ctx, gx, gy, gw, gh, slotSize, us) {
        const progress = Math.min(1, this.rollTimer / UI.rollDuration);
        const pulse    = 0.5 + 0.5 * Math.sin(this.glowTimer * UI.glowPulseSpeed * Math.PI * 2);

        ctx.save();
        ctx.beginPath();
        ctx.rect(gx, gy, gw, gh);
        ctx.clip();

        // ── Background: deep blue fill + pulsing radial glow ─────────────────
        ctx.fillStyle = `rgba(0, 40, 110, 0.75)`;
        ctx.fillRect(gx, gy, gw, gh);

        const cx = gx + gw / 2;
        const cy = gy + gh / 2;
        const glowR = Math.max(gw, gh) * (0.6 + 0.25 * pulse);
        const radGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
        radGrad.addColorStop(0,   `rgba(0, 140, 255, ${0.45 * pulse})`);
        radGrad.addColorStop(0.4, `rgba(0,  80, 200, ${0.25 * pulse})`);
        radGrad.addColorStop(1,   'rgba(0, 0, 0, 0)');
        ctx.globalCompositeOperation = 'screen';
        ctx.fillStyle = radGrad;
        ctx.fillRect(gx, gy, gw, gh);
        ctx.globalCompositeOperation = 'source-over';

        // ── Silhouette ────────────────────────────────────────────────────────
        const sil = this.silhouettes[this.rollIndex % this.silhouettes.length];
        const frameAsset = this.game.getAnimationFrame(sil.assetKey);
        if (frameAsset) {
            const frame = frameAsset.canvas || frameAsset;
            const iw = sil.width  * slotSize;
            const ih = sil.height * slotSize;
            const ix = gx + (gw - iw) / 2;
            const iy = gy + (gh - ih) / 2;

            const glitchAmt = UI.glitchChromaticMax * us * (1 - progress * 0.75);
            const gx2 = (Math.random() - 0.5) * glitchAmt;
            const gy2 = (Math.random() - 0.5) * glitchAmt;

            // Dark silhouette base
            ctx.globalAlpha = 0.9;
            ctx.filter = `brightness(0) invert(0)`;
            ctx.drawImage(frame, ix, iy, iw, ih);

            // Blue/cyan glow screen layer
            ctx.globalCompositeOperation = 'screen';
            ctx.globalAlpha = 0.7 + pulse * 0.25;
            ctx.filter = `brightness(10) saturate(0) opacity(${0.6 + 0.3 * pulse}) hue-rotate(200deg) sepia(1) saturate(5)`;
            ctx.drawImage(frame, ix, iy, iw, ih);

            // Chromatic R channel (red, shifted)
            ctx.globalAlpha = 0.3;
            ctx.filter = `brightness(8) saturate(0) sepia(1) hue-rotate(-30deg) saturate(3) opacity(0.5)`;
            ctx.drawImage(frame, ix + gx2 * 1.5, iy + gy2, iw, ih);

            // Chromatic B channel (cyan, opposite shift)
            ctx.globalAlpha = 0.35;
            ctx.filter = `brightness(8) saturate(0) sepia(1) hue-rotate(180deg) saturate(4) opacity(0.55)`;
            ctx.drawImage(frame, ix - gx2 * 1.5, iy - gy2, iw, ih);

            ctx.filter = 'none';
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
        }

        // ── Scanlines ─────────────────────────────────────────────────────────
        ctx.globalAlpha = UI.scanlineAlpha;
        ctx.fillStyle   = '#000000';
        const lineH = Math.max(1, Math.floor(us));
        for (let sy = gy; sy < gy + gh; sy += lineH * 2) {
            ctx.fillRect(gx, sy, gw, lineH);
        }

        // ── Noise pixels ─────────────────────────────────────────────────────
        const noiseCount = Math.floor(12 * (1 - progress * 0.8));
        ctx.globalAlpha  = 0.8;
        for (let i = 0; i < noiseCount; i++) {
            const nx = gx + Math.random() * gw;
            const ny = gy + Math.random() * gh;
            ctx.fillStyle = Math.random() < 0.5 ? '#00ffff' : '#4488ff';
            ctx.fillRect(Math.floor(nx), Math.floor(ny), Math.ceil(us * 2), Math.ceil(us));
        }

        // ── Edge vignette (blue) ──────────────────────────────────────────────
        ctx.globalAlpha = 0.4 + 0.2 * pulse;
        const vSize = Math.min(gw, gh) * 0.35;
        const vGrad = ctx.createRadialGradient(cx, cy, Math.max(gw, gh) * 0.3, cx, cy, Math.max(gw, gh) * 0.7);
        vGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vGrad.addColorStop(1, `rgba(0, 10, 60, 0.7)`);
        ctx.fillStyle = vGrad;
        ctx.fillRect(gx, gy, gw, gh);

        ctx.globalAlpha = 1;
        ctx.restore();
    }

    // ── Reveal: item slides from grid center to its target slot ──────────────
    _drawRevealing(ctx, gx, gy, gw, gh, slotSize, us) {
        if (!this.revealItem) return;
        const item       = this.revealItem;
        const frameAsset = this.game.getAnimationFrame(item.assetKey);
        if (!frameAsset) return;
        const frame = frameAsset.canvas || frameAsset;

        const iw = item.width  * slotSize;
        const ih = item.height * slotSize;

        const toX   = gx + this.slideToGridX * slotSize;
        const toY   = gy + this.slideToGridY * slotSize;
        const fromX = gx + (gw - iw) / 2;
        const fromY = gy + (gh - ih) / 2;

        const ease = 1 - Math.pow(1 - this.slideT, 3);
        const rx   = fromX + (toX - fromX) * ease;
        const ry   = fromY + (toY - fromY) * ease;

        ctx.save();
        ctx.beginPath();
        ctx.rect(gx, gy, gw, gh);
        ctx.clip();

        // Flash burst
        if (this.revealFlash > 0) {
            const fa = this.revealFlash;
            ctx.fillStyle = `rgba(40, 160, 255, ${fa * 0.4})`;
            ctx.fillRect(gx, gy, gw, gh);

            const rcx = rx + iw / 2, rcy = ry + ih / 2;
            const burst = ctx.createRadialGradient(rcx, rcy, 0, rcx, rcy, Math.max(gw, gh) * 0.6);
            burst.addColorStop(0,   `rgba(100, 200, 255, ${fa * 0.7})`);
            burst.addColorStop(0.4, `rgba(0, 100, 255, ${fa * 0.3})`);
            burst.addColorStop(1,   'rgba(0,0,0,0)');
            ctx.globalCompositeOperation = 'screen';
            ctx.fillStyle = burst;
            ctx.fillRect(gx, gy, gw, gh);
            ctx.globalCompositeOperation = 'source-over';
        }

        // Item fades in as it slides
        ctx.globalAlpha = 0.2 + ease * 0.8;
        ctx.drawImage(frame, rx, ry, iw, ih);

        // Rarity rim
        const rarCol = RARITY_COLORS[item.rarity] || '#ffffff';
        ctx.globalAlpha = (1 - ease) * 0.7;
        ctx.strokeStyle = rarCol;
        ctx.lineWidth   = 2 * us;
        ctx.strokeRect(rx + 1, ry + 1, iw - 2, ih - 2);

        ctx.globalAlpha = 1;
        ctx.restore();
    }
}
