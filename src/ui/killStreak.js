import { RARITY_COLORS } from '../data/upgrades.js';

// Kill-streak fanfare, three escalating layers:
//   1. Extra world particles — confetti (later gore) bursting from each kill.
//   2. A streak score readout under the run timer that grows with the tier.
//   3. HUD-level vfx that escalate with the streak: rarity vignette breathing,
//      sparkle motes around the score, confetti drizzling down the screen at
//      the legendary peak, then blood running from the top edge when the
//      party turns to horror.
// Strictly cosmetic and strictly local — each player has their own streak
// (only their kills count), nothing is replicated, all randomness is
// Math.random().
//
// `window` is how long the streak survives without a kill — every kill
// refills the timer bar, and higher tiers drain faster.
const STREAK_WINDOW = 5.0; // window before the first tier is reached

const TIERS = [
    { kills: 3,  window: 5.0, color: RARITY_COLORS.common,    vAlpha: 0.06, pulse: 1.6, confetti: 0,  gore: 0 },
    { kills: 6,  window: 4.5, color: RARITY_COLORS.uncommon,  vAlpha: 0.10, pulse: 2.2, confetti: 7,  gore: 0 },
    { kills: 10, window: 4.0, color: RARITY_COLORS.rare,      vAlpha: 0.16, pulse: 2.8, confetti: 13, gore: 0, motes: true },
    { kills: 14, window: 3.5, color: RARITY_COLORS.epic,      vAlpha: 0.24, pulse: 3.4, confetti: 21, gore: 0, motes: true, drizzle: 3 },
    { kills: 19, window: 3.0, color: RARITY_COLORS.legendary, vAlpha: 0.34, pulse: 4.2, confetti: 32, gore: 0, motes: true, drizzle: 14, fireworks: true },
    { kills: 25, window: 2.5, color: '#7a0808',               vAlpha: 0.55, pulse: 5.2, confetti: 0,  gore: 15, drips: true } // the party is over
];

const CONFETTI_KEYS = Array.from({ length: 44 }, (_, i) => `confetti_${String(i).padStart(2, '0')}`);
const GORE_KEYS = Array.from({ length: 28 }, (_, i) => `gore_${String(i).padStart(2, '0')}`);

const MAX_PARTICLES = 300;       // world-space kill bursts
const MAX_SCREEN_PARTS = 140;    // HUD-layer drizzle/motes/drips

export class KillStreakFX {
    constructor(game, state) {
        this.game = game;
        this.state = state;

        this.streak = 0;
        this.timer = 0;          // time left before the streak expires
        this.window = STREAK_WINDOW; // current refill size (shrinks per tier)
        this.fxIntensity = 0;    // smoothed 0..1 driver for the CRT post-fx
        this.time = 0;           // running clock for pulse phases
        this.pop = 0;            // score pop-scale impulse (1 → 0)
        this.particles = [];     // world-space burst particles
        this.screenParts = [];   // HUD-layer particles (screen pixels)
        this.rings = [];         // tier-up rings around the score
        this._spawnAcc = { mote: 0, drizzle: 0, drip: 0, chunk: 0 };

        this._vignetteAlpha = 0; // smoothed toward the active tier's alpha
        this._vignetteColor = null;
        this._gradCache = new Map(); // color -> gradient (rebuilt on resize)
        this._gradW = 0;
        this._gradH = 0;

        this._confettiAssets = null; // resolved lazily once assets are ready
        this._goreAssets = null;
    }

    tier() {
        let t = null;
        for (const candidate of TIERS) {
            if (this.streak >= candidate.kills) t = candidate;
        }
        return t;
    }

    _tierIndex() {
        let idx = -1;
        for (let i = 0; i < TIERS.length; i++) {
            if (this.streak >= TIERS[i].kills) idx = i;
        }
        return idx;
    }

    // ── Kills ────────────────────────────────────────────────────────────────

    onKill(entity) {
        const prevTier = this.tier();
        this.streak++;
        const tier = this.tier();
        // Refill the timer bar; tighter window the higher you climb
        this.window = tier ? tier.window : STREAK_WINDOW;
        this.timer = this.window;
        if (!tier) return;

        this.pop = tier !== prevTier ? 1.6 : 1.0;
        if (tier !== prevTier) {
            // Tier-up: ring bursts out from the score readout + a stinger
            this.rings.push({ t: 0, dur: 0.45, color: tier.color });
            if (this.game.sounds && this.game.sounds.playStreakTier) {
                this.game.sounds.playStreakTier(this._tierIndex(), tier.gore > 0);
            }
        }

        const x = entity.worldX, y = entity.worldY;
        if (tier.gore > 0) {
            this._burst(this._getGoreAssets(), tier.gore, x, y, true);
            // Red spray under the chunks sells the wet hit.
            if (this.state._spawnSparks) {
                this.state._spawnSparks(x, y, 10, { color: '#b41818', speedMin: 80, speedMax: 320 });
            }
        } else if (tier.confetti > 0) {
            this._burst(this._getConfettiAssets(), tier.confetti, x, y, false);
            if (tier.fireworks && this.state._spawnSparks) {
                this.state._spawnSparks(x, y, 14, { color: '#ffd24a', speedMin: 200, speedMax: 520 });
            }
        }
    }

    _getConfettiAssets() {
        if (!this._confettiAssets) {
            const list = CONFETTI_KEYS.map(k => this.game.assets.get(k)).filter(Boolean);
            if (list.length === 0) return null; // not loaded yet — retry next kill
            this._confettiAssets = list;
        }
        return this._confettiAssets;
    }

    _getGoreAssets() {
        if (!this._goreAssets) {
            const list = GORE_KEYS.map(k => this.game.assets.get(k)).filter(Boolean);
            if (list.length === 0) return null;
            this._goreAssets = list;
        }
        return this._goreAssets;
    }

    _burst(assets, count, x, y, isGore) {
        if (!assets) return;
        const room = MAX_PARTICLES - this.particles.length;
        const n = Math.min(count, room);
        for (let i = 0; i < n; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = isGore
                ? 120 + Math.random() * 260
                : 150 + Math.random() * 320;
            this.particles.push({
                asset: assets[Math.floor(Math.random() * assets.length)],
                x, y,
                vx: Math.cos(angle) * speed,
                vy: Math.sin(angle) * speed,
                rot: Math.random() * Math.PI * 2,
                rotSpeed: (Math.random() - 0.5) * (isGore ? 6 : 14),
                life: 0,
                maxLife: isGore ? (0.9 + Math.random() * 0.7) : (1.1 + Math.random() * 1.1),
                // Confetti flutters sideways as it slows; gore just tumbles.
                flutterPhase: Math.random() * Math.PI * 2,
                flutterFreq: 6 + Math.random() * 5,
                flutterAmp: isGore ? 0 : 22 + Math.random() * 26,
                drag: isGore ? 1.6 : 2.8
            });
        }
    }

    // ── Update ───────────────────────────────────────────────────────────────

    update(dt) {
        this.time += dt;
        if (this.pop > 0) this.pop = Math.max(0, this.pop - dt * 6);

        if (this.streak > 0) {
            if (this.state.isDead) {
                this.streak = 0; // death ends the party
            } else {
                this.timer -= dt;
                if (this.timer <= 0) this.streak = 0;
            }
        }

        // Vignette eases toward the active tier (and back out when it ends)
        const tier = this.tier();
        const targetAlpha = tier ? tier.vAlpha : 0;
        const k = 1 - Math.exp(-4 * dt);
        this._vignetteAlpha += (targetAlpha - this._vignetteAlpha) * k;
        if (tier) this._vignetteColor = tier.color;

        // CRT post-fx intensity: a step per tier plus a spike on each kill
        const FX_BY_TIER = [0.10, 0.20, 0.35, 0.50, 0.70, 1.00];
        const tierIdx = this._tierIndex();
        const fxTarget = Math.min(1, (tierIdx >= 0 ? FX_BY_TIER[tierIdx] : 0) + this.pop * 0.15);
        this.fxIntensity += (fxTarget - this.fxIntensity) * (1 - Math.exp(-3 * dt));
        if (this.fxIntensity < 0.005 && fxTarget === 0) this.fxIntensity = 0;

        // All audio corrupts along with the screen
        if (this.game.sounds && this.game.sounds.setAudioCorruption) {
            this.game.sounds.setAudioCorruption(this.fxIntensity);
        }

        // World burst particles
        const parts = this.particles;
        for (let i = parts.length - 1; i >= 0; i--) {
            const p = parts[i];
            p.life += dt;
            if (p.life >= p.maxLife) {
                parts[i] = parts[parts.length - 1];
                parts.pop();
                continue;
            }
            const drag = Math.exp(-p.drag * dt);
            p.vx *= drag;
            p.vy *= drag;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.flutterAmp > 0) {
                p.x += Math.cos(p.flutterPhase + p.life * p.flutterFreq) * p.flutterAmp * dt;
            }
            p.rot += p.rotSpeed * dt;
        }

        this._updateScreenFx(dt, tier);

        for (let i = this.rings.length - 1; i >= 0; i--) {
            this.rings[i].t += dt;
            if (this.rings[i].t >= this.rings[i].dur) this.rings.splice(i, 1);
        }
    }

    // HUD-layer ambience by tier: sparkle motes around the score, confetti
    // drizzle from the top edge at the party peak, blood drips at the flip.
    _updateScreenFx(dt, tier) {
        const W = this.game.width;
        const hudScale = this.game.hudScale;
        const acc = this._spawnAcc;
        const room = () => MAX_SCREEN_PARTS - this.screenParts.length;

        if (tier && tier.motes) {
            acc.mote += dt * 5;
            while (acc.mote >= 1 && room() > 0) {
                acc.mote -= 1;
                // Drift up and outward from around the score readout
                const cx = W / 2 + (Math.random() - 0.5) * 16 * hudScale;
                const cy = 22 * hudScale + (Math.random() - 0.5) * 6 * hudScale;
                this.screenParts.push({
                    kind: 'mote', x: cx, y: cy,
                    vx: (Math.random() - 0.5) * 18, vy: -20 - Math.random() * 25,
                    life: 0, maxLife: 0.5 + Math.random() * 0.5,
                    color: tier.color
                });
            }
        } else acc.mote = 0;

        const drizzleRate = tier && tier.drizzle ? tier.drizzle : 0;
        if (drizzleRate > 0) {
            const assets = this._getConfettiAssets();
            acc.drizzle += dt * drizzleRate;
            while (acc.drizzle >= 1 && assets && room() > 0) {
                acc.drizzle -= 1;
                this.screenParts.push({
                    kind: 'confetti',
                    asset: assets[Math.floor(Math.random() * assets.length)],
                    x: Math.random() * W, y: -6 * hudScale,
                    vx: 0, vy: (40 + Math.random() * 60) * (hudScale / 4),
                    rot: Math.random() * Math.PI * 2,
                    rotSpeed: (Math.random() - 0.5) * 10,
                    swayPhase: Math.random() * Math.PI * 2,
                    swayFreq: 3 + Math.random() * 4,
                    swayAmp: (14 + Math.random() * 20) * (hudScale / 4),
                    life: 0, maxLife: 3.5 + Math.random() * 2.0
                });
            }
        } else acc.drizzle = 0;

        if (tier && tier.drips) {
            acc.drip += dt * 5.0;
            while (acc.drip >= 1 && room() > 0) {
                acc.drip -= 1;
                this.screenParts.push({
                    kind: 'drip', x: Math.random() * W, y: 0,
                    vy: (12 + Math.random() * 22) * (hudScale / 4),
                    len: 0, maxLen: (16 + Math.random() * 40) * (hudScale / 2),
                    life: 0, maxLife: 2.5 + Math.random() * 2.0,
                    color: Math.random() < 0.5 ? '#a01212' : '#c41a1a'
                });
            }
            // Meat sliding down the glass
            const goreAssets = this._getGoreAssets();
            acc.chunk += dt * 3.0;
            while (acc.chunk >= 1 && goreAssets && room() > 0) {
                acc.chunk -= 1;
                this.screenParts.push({
                    kind: 'confetti', // same motion model, no sway
                    asset: goreAssets[Math.floor(Math.random() * goreAssets.length)],
                    big: true,
                    x: Math.random() * W, y: -6 * hudScale,
                    vx: 0, vy: (25 + Math.random() * 35) * (hudScale / 4),
                    rot: Math.random() * Math.PI * 2,
                    rotSpeed: (Math.random() - 0.5) * 3,
                    swayPhase: 0, swayFreq: 0, swayAmp: 0,
                    life: 0, maxLife: 4.0 + Math.random() * 2.0
                });
            }
        } else { acc.drip = 0; acc.chunk = 0; }

        const H = this.game.height;
        const sp = this.screenParts;
        for (let i = sp.length - 1; i >= 0; i--) {
            const p = sp[i];
            p.life += dt;
            if (p.kind === 'drip') {
                p.len = Math.min(p.maxLen, p.len + p.vy * dt * 2);
                p.y += p.vy * dt;
            } else {
                p.x += (p.vx || 0) * dt;
                p.y += p.vy * dt;
                if (p.swayAmp) p.x += Math.cos(p.swayPhase + p.life * p.swayFreq) * p.swayAmp * dt;
                if (p.rotSpeed) p.rot += p.rotSpeed * dt;
            }
            if (p.life >= p.maxLife || p.y - (p.len || 0) > H + 20) {
                sp[i] = sp[sp.length - 1];
                sp.pop();
            }
        }
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    // World-space particles — drawn with the other particles, under the HUD.
    drawWorld(ctx, camera) {
        if (this.particles.length === 0) return;
        const ws = this.game.worldScale;
        const W = this.game.width, H = this.game.height;
        ctx.save();
        for (const p of this.particles) {
            const sx = p.x * camera.wtsScale + camera.wtsOffX;
            const sy = p.y * camera.wtsScale + camera.wtsOffY;
            if (sx < -40 || sx > W + 40 || sy < -40 || sy > H + 40) continue;
            const asset = p.asset;
            const img = asset.canvas || asset;
            const w = (asset.width || img.width) * ws;
            const h = (asset.height || img.height) * ws;
            const lifeFrac = p.life / p.maxLife;
            ctx.globalAlpha = lifeFrac > 0.7 ? (1 - lifeFrac) / 0.3 : 1;
            ctx.translate(sx, sy);
            ctx.rotate(p.rot);
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
            ctx.rotate(-p.rot);
            ctx.translate(-sx, -sy);
        }
        ctx.restore();
    }

    // Screen-space layer: vignette, HUD particles, streak score. Drawn just
    // before the HUD so gameplay-critical readouts stay on top.
    drawOverlay(ctx) {
        const W = this.game.width, H = this.game.height;
        const hudScale = this.game.hudScale;
        const tier = this.tier();

        // Rarity vignette, breathing faster as the tier climbs
        if (this._vignetteAlpha > 0.005 && this._vignetteColor) {
            const pulseRate = tier ? tier.pulse : 2.0;
            let pulse = 0.75 + 0.25 * Math.sin(this.time * pulseRate);
            if (tier && tier.gore > 0) {
                // Horror tier: irregular double-beat, like a heartbeat going wrong
                pulse = 0.7 + 0.18 * Math.sin(this.time * pulseRate) + 0.12 * Math.sin(this.time * 7.3);
            }

            if (this._gradW !== W || this._gradH !== H) {
                this._gradCache.clear();
                this._gradW = W;
                this._gradH = H;
            }
            let grad = this._gradCache.get(this._vignetteColor);
            if (!grad) {
                // Full color lands exactly at the screen corners, with a biased
                // mid-stop so the edges carry visible color too.
                const cornerDist = Math.sqrt(W * W + H * H) / 2;
                const inner = Math.min(W, H) * 0.30;
                const cr = parseInt(this._vignetteColor.slice(1, 3), 16);
                const cg = parseInt(this._vignetteColor.slice(3, 5), 16);
                const cb = parseInt(this._vignetteColor.slice(5, 7), 16);
                grad = ctx.createRadialGradient(W / 2, H / 2, inner, W / 2, H / 2, cornerDist);
                grad.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
                grad.addColorStop(0.55, `rgba(${cr},${cg},${cb},0.35)`);
                grad.addColorStop(1, `rgba(${cr},${cg},${cb},1)`);
                this._gradCache.set(this._vignetteColor, grad);
            }
            ctx.save();
            ctx.globalAlpha = this._vignetteAlpha * pulse;
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);
            ctx.restore();
        }

        // HUD-layer particles
        if (this.screenParts.length > 0) {
            ctx.save();
            const partScale = hudScale * 0.5;
            for (const p of this.screenParts) {
                const fade = p.life / p.maxLife;
                if (p.kind === 'mote') {
                    ctx.globalAlpha = 1 - fade;
                    ctx.fillStyle = p.color;
                    const s = Math.max(1, Math.round(hudScale / 2));
                    ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
                } else if (p.kind === 'drip') {
                    ctx.globalAlpha = fade > 0.6 ? (1 - fade) / 0.4 * 0.95 : 0.95;
                    ctx.fillStyle = p.color;
                    const w = Math.max(2, Math.round(hudScale * 0.75));
                    ctx.fillRect(Math.round(p.x), Math.round(p.y - p.len), w, Math.round(p.len));
                } else {
                    const asset = p.asset;
                    const img = asset.canvas || asset;
                    const scale = p.big ? partScale * 1.7 : partScale;
                    const w = (asset.width || img.width) * scale;
                    const h = (asset.height || img.height) * scale;
                    ctx.globalAlpha = fade > 0.75 ? (1 - fade) / 0.25 : 1;
                    ctx.translate(p.x, p.y);
                    ctx.rotate(p.rot);
                    ctx.drawImage(img, -w / 2, -h / 2, w, h);
                    ctx.rotate(-p.rot);
                    ctx.translate(-p.x, -p.y);
                }
            }
            ctx.restore();
        }

        // Streak score readout — grows a step per tier, pops per kill
        if (tier) {
            const horror = tier.gore > 0;
            const tierIdx = this._tierIndex();
            const scale = (1 + tierIdx * 0.12) * (1 + 0.45 * this.pop);
            const size = Math.floor(8 * hudScale * scale);
            let cx = Math.round(W / 2);
            let cy = Math.round(19 * hudScale);
            if (horror) {
                cx += Math.round((Math.random() - 0.5) * hudScale);
                cy += Math.round((Math.random() - 0.5) * hudScale);
            }
            const o = Math.max(1, Math.round(hudScale / 2));
            const color = horror ? '#cc2222' : tier.color;

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            // Tier-up rings radiating from the score
            for (const r of this.rings) {
                const p = r.t / r.dur;
                ctx.globalAlpha = (1 - p) * 0.8;
                ctx.strokeStyle = r.color;
                ctx.lineWidth = Math.max(1, (1 - p) * hudScale);
                ctx.beginPath();
                ctx.arc(cx, cy + size * 0.5, (4 + p * 26) * hudScale, 0, Math.PI * 2);
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            const text = `x${this.streak}`;
            ctx.font = `${size}px Astro4x`;
            ctx.fillStyle = '#000000';
            ctx.fillText(text, cx - o, cy);
            ctx.fillText(text, cx + o, cy);
            ctx.fillText(text, cx, cy - o);
            ctx.fillText(text, cx, cy + o);
            ctx.fillStyle = color;
            ctx.fillText(text, cx, cy);

            // Small label under the number
            const labelSize = Math.floor(4 * hudScale);
            const labelY = cy + size + Math.round(hudScale);
            ctx.font = `${labelSize}px Astro4x`;
            ctx.globalAlpha = 0.85;
            ctx.fillStyle = '#000000';
            ctx.fillText('STREAK', cx - o, labelY);
            ctx.fillText('STREAK', cx + o, labelY);
            ctx.fillText('STREAK', cx, labelY - o);
            ctx.fillText('STREAK', cx, labelY + o);
            ctx.fillStyle = horror ? '#881111' : '#ccddee';
            ctx.fillText('STREAK', cx, labelY);

            // Timer bar — full on every kill, drains to zero, faster per tier.
            const frac = Math.max(0, Math.min(1, this.timer / this.window));
            const barW = Math.round(26 * hudScale);
            const barH = Math.max(2, Math.round(1.5 * hudScale));
            const bx = cx - Math.round(barW / 2);
            const by = labelY + labelSize + Math.round(hudScale);
            const edge = Math.max(1, Math.round(hudScale / 4));
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = '#000000';
            ctx.fillRect(bx - edge, by - edge, barW + edge * 2, barH + edge * 2);
            ctx.fillStyle = '#1a2128';
            ctx.fillRect(bx, by, barW, barH);
            // Urgency blink when the streak is about to die
            if (frac < 0.25) ctx.globalAlpha = 0.45 + 0.55 * ((Math.sin(this.time * 14) + 1) / 2);
            ctx.fillStyle = color;
            ctx.fillRect(bx, by, Math.round(barW * frac), barH);
            ctx.restore();
        }
    }
}
