import { BOSS_PHASE, BOSS_STATE } from '../entities/boss.js';

// Threat readouts for the warning banner. Deliberately no boss names —
// enemy identity/strength stays unknown until the player learns it by fighting.
const BOSS_SUBTITLES = {
    starcore: 'MASSIVE ENERGY SIGNATURE DETECTED',
    asteroid_crusher: 'HEAVY HULL SIGNATURE DETECTED',
    event_horizon: 'HIGH-VELOCITY CONTACT INBOUND'
};
const DEFAULT_SUBTITLE = 'UNIDENTIFIED MASSIVE CONTACT';

const WARN_DURATION = 2.9;     // total warning sequence length (s)
const WARN_BARS_OUT = 2.2;     // when the letterbox starts retracting
const MAX_RINGS = 12;

// Herald fanfare chart — measured off the actual WAV envelopes (RMS windows):
//   blast = sounding length (the tail past it is room decay), pops = note
//   attacks within the phrase (seconds after the burst starts). trumpet_1 is
//   a triple-tongued fanfare pulsing about every 0.45s; the others are single
//   blasts of differing lengths.
const TRUMPET_BURSTS = [
    { key: 'trumpet_1', blast: 2.0, pops: [0, 0.45, 0.9, 1.35] },
    { key: 'trumpet_2', blast: 1.1, pops: [0] },
    { key: 'trumpet_3', blast: 1.7, pops: [0] },
    { key: 'trumpet_4', blast: 1.15, pops: [0] },
];

// Screen-level cinematic effects: letterbox bars, warning banner, world-space
// shockwave rings and boss death silhouettes. Strictly cosmetic — it never
// pauses the simulation (multiplayer invariant), uses Math.random() only, and
// triggers off locally-observable entity state (phase/state/alive), which is
// already replicated to multiplayer clients. So every machine — single player,
// host, client — sees the same show without any protocol changes.
export class CinematicDirector {
    constructor(game, state) {
        this.game = game;
        this.state = state;

        this.letterbox = 0;        // 0..1 current bar extension
        this.letterboxTarget = 0;

        this.card = null;          // { title, subtitle }
        this._warnElapsed = -1;    // -1 = no warning sequence active

        this.rings = [];           // world-space shockwave rings
        this.silhouettes = [];     // boss death flash-frames
        this.reel = null;          // jackpot slot-reel name reveal
        this.heralds = [];         // trumpet fanfares (post-Yellow One boss deaths)

        this._watched = [];        // bosses we're tracking for transitions
        this._silhouetteCache = new Map();
    }

    // ── Update ───────────────────────────────────────────────────────────────

    update(dt) {
        this._watchBosses();

        if (this._warnElapsed >= 0) {
            this._warnElapsed += dt;
            const t = this._warnElapsed;
            if (t < 1.0) this.game.camera.rumble(0.9 * (1.0 - t));
            this.letterboxTarget = t < WARN_BARS_OUT ? 1 : 0;
            if (t >= WARN_DURATION) {
                this._warnElapsed = -1;
                this.card = null;
                this.letterboxTarget = 0;
            }
        }

        // Letterbox slide (in slightly faster than out)
        if (this.letterbox !== this.letterboxTarget) {
            const speed = this.letterboxTarget > this.letterbox ? (1 / 0.35) : (1 / 0.45);
            const dir = Math.sign(this.letterboxTarget - this.letterbox);
            this.letterbox = Math.max(0, Math.min(1, this.letterbox + dir * speed * dt));
        }

        for (let i = this.rings.length - 1; i >= 0; i--) {
            const r = this.rings[i];
            r.t += dt;
            if (r.t >= r.dur) this.rings.splice(i, 1);
        }
        for (let i = this.silhouettes.length - 1; i >= 0; i--) {
            const s = this.silhouettes[i];
            s.t += dt;
            if (s.t >= s.dur) this.silhouettes.splice(i, 1);
        }

        if (this.reel) {
            this.reel.t += dt;
            if (this.reel.t >= this.reel.dur) this.reel = null;
        }

        this._updateHeralds(dt);
    }

    _updateHeralds(dt) {
        for (let i = this.heralds.length - 1; i >= 0; i--) {
            const h = this.heralds[i];
            h.t += dt;
            const bt = h.t - h.swoop; // time since the blast began

            // The burst fires the moment the swoop lands.
            if (!h.played && bt >= 0) {
                h.played = true;
                this.game.sounds.play(h.soundKey, { volume: 0.85, x: h.x, y: h.y });
            }

            // Phrase attacks: recoil pop + a gold burst from the bell. Multi-pop
            // charts (trumpet_1's triple-tonguing) re-fire on every swell.
            while (h.pops.length && bt >= h.pops[0]) {
                h.pops.shift();
                h.pop = 1;
                this._heraldBellSparks(h, 10 + Math.floor(Math.random() * 6));
            }
            h.pop = Math.max(0, h.pop - dt * 4.5);

            // Blare envelope rides the sounding length; a lazy spark stream
            // flows from the bell while the note holds.
            h.blare = bt < 0 ? 0 : Math.max(0, Math.min(1, Math.min(bt / 0.08, (h.blast - bt) / 0.25)));
            if (h.blare > 0.4) {
                h.streamAcc += dt * 7;
                while (h.streamAcc >= 1) {
                    h.streamAcc -= 1;
                    this._heraldBellSparks(h, 1);
                }
            }

            if (bt >= h.blast + 0.25 + 0.7) this.heralds.splice(i, 1);
        }
    }

    _heraldBellSparks(h, count) {
        if (!this.state || !this.state._spawnSparks) return;
        const flip = h.flip ? -1 : 1;
        this.state._spawnSparks(h.x + 46 * -flip, h.y + 22, count, {
            dir: Math.atan2(0.75, -0.66 * flip), spread: 0.55,
            color: Math.random() < 0.5 ? '#ffd050' : '#ffee99',
            speedMin: 120, speedMax: 320
        });
    }

    // Jackpot reel: the item name spins like a slot readout before settling.
    // pilot (co-op): the local player who collected it, so the reel centers on
    // THEIR pane instead of the whole screen.
    jackpotReel(text, color, tier, pilot = null) {
        this.reel = {
            text: String(text).toUpperCase(),
            color,
            tier,
            t: 0,
            settleAt: 0.45,
            dur: 1.7,
            pilot
        };
    }

    // Watches state.enemies for boss lifecycle transitions. Bosses are rare
    // (almost always 0, at most 1-2), so this scan is effectively free.
    _watchBosses() {
        const enemies = this.state.enemies;
        for (let i = 0; i < enemies.length; i++) {
            const e = enemies[i];
            if (!e.isBoss || !e.alive || e._cineMeta) continue;
            e._cineMeta = { phase: e.phase, sawDying: false, fired: 0, finished: false };
            this._watched.push(e);
            // Pre-warm the caches during the intro so neither the phase-2 aura
            // nor the death silhouette ever costs a mid-fight frame.
            if (e.constructor._getPhaseGlow) e.constructor._getPhaseGlow(this.game, e.spriteKey);
            this._getSilhouette(e.spriteKey);
            // Fresh arrival (intro phase) gets the full warning telegraph.
            // Bosses restored mid-fight (saves, join-in-progress) skip it.
            if (e.phase === BOSS_PHASE.INTRO && !this.state.yellowOneScriptActive) {
                this._startWarning(e);
            }
        }

        for (let i = this._watched.length - 1; i >= 0; i--) {
            const b = this._watched[i];
            const m = b._cineMeta;
            if (b.alive) {
                if (m.phase === BOSS_PHASE.INTRO && b.phase !== BOSS_PHASE.INTRO) {
                    // Engage moment: the blink-in ends and the fight is on.
                    this.spawnRing(b.worldX, b.worldY, { color: '#ffd24a', maxR: 280, dur: 0.5, width: 4 });
                }
                if (m.phase !== BOSS_PHASE.ATTACK2 && b.phase === BOSS_PHASE.ATTACK2) {
                    this._onPhase2(b);
                }
                m.phase = b.phase;

                if (b.state === BOSS_STATE.DYING) {
                    m.sawDying = true;
                    // Camera kick on each staggered death explosion.
                    if (b.deathExplosions) {
                        let fired = 0;
                        for (const ex of b.deathExplosions) if (ex.fired) fired++;
                        if (fired > m.fired) {
                            m.fired = fired;
                            if (this._isNearView(b.worldX, b.worldY)) {
                                const cam = this.game.camera;
                                cam.punch(cam.x - b.worldX, cam.y - b.worldY, 14);
                            }
                        }
                    }
                }
            } else {
                if (m.sawDying && !m.finished) {
                    m.finished = true;
                    this._onBossDestroyed(b);
                }
                this._watched.splice(i, 1);
            }
        }
    }

    // ── Sequence triggers ────────────────────────────────────────────────────

    _startWarning(boss) {
        if (this._warnElapsed >= 0) return; // one warning at a time
        this._warnElapsed = 0;
        this.card = {
            title: 'WARNING',
            subtitle: BOSS_SUBTITLES[boss.spriteKey] || DEFAULT_SUBTITLE
        };
        if (this.game.sounds && this.game.sounds.playKlaxon) {
            this.game.sounds.playKlaxon();
        }
    }

    // Fullscreen flash/shake only when the moment happens near the local view —
    // a boss event 3000 units away shouldn't white out this player's screen.
    _isNearView(worldX, worldY) {
        const cam = this.game.camera;
        const dx = worldX - cam.x, dy = worldY - cam.y;
        return (dx * dx + dy * dy) < 2500 * 2500;
    }

    _onPhase2(boss) {
        // The fanfare for the 40%-health phase flip. Boss.update only flips the
        // phase; sound/shake live here so replicas get them too.
        this.game.sounds.play('ship_explode', { volume: 1.0, x: boss.worldX, y: boss.worldY });
        if (this._isNearView(boss.worldX, boss.worldY)) {
            this.game.camera.shake(2.5);
            this.state.triggerFlash('#ff4422', 0.7, 0.3);
        }
        this.spawnRing(boss.worldX, boss.worldY, { color: '#ff5533', maxR: 420, dur: 0.55, width: 6 });
        this.spawnRing(boss.worldX, boss.worldY, { color: '#ffd24a', maxR: 260, dur: 0.4, width: 3 });
    }

    _onBossDestroyed(boss) {
        if (this._isNearView(boss.worldX, boss.worldY)) {
            this.state.triggerFlash('#ffffff', 0.7, 0.5);
            this.game.camera.shake(4.0);
        }
        this.spawnRing(boss.worldX, boss.worldY, { color: '#ffffff', maxR: 700, dur: 0.7, width: 8 });
        this.spawnRing(boss.worldX, boss.worldY, { color: '#ffd24a', maxR: 460, dur: 0.55, width: 4 });

        const sil = this._getSilhouette(boss.spriteKey);
        if (sil) {
            this.silhouettes.push({
                x: boss.worldX, y: boss.worldY,
                angle: boss.angle + Math.PI / 2,
                entry: sil,
                t: 0, dur: 0.22
            });
        }
    }

    // ── Effect spawners ──────────────────────────────────────────────────────

    // 1-frame-ish white silhouette pop for regular enemy kills — the small
    // sibling of the boss death flash-frame.
    deathPop(ent) {
        if (!ent || !ent.spriteKey) return;
        const sil = this._getSilhouette(ent.spriteKey);
        if (!sil) return;
        if (this.silhouettes.length > 12) this.silhouettes.shift();
        this.silhouettes.push({
            x: ent.worldX, y: ent.worldY,
            angle: (ent.angle || 0) + Math.PI / 2,
            entry: sil,
            t: 0, dur: 0.14
        });
    }

    spawnRing(worldX, worldY, opts = {}) {
        if (this.rings.length >= MAX_RINGS) this.rings.shift();
        this.rings.push({
            x: worldX, y: worldY,
            t: 0,
            dur: opts.dur || 0.5,
            maxR: opts.maxR || 300,     // world units
            width: opts.width || 4,     // logical px
            color: opts.color || '#ffffff'
        });
    }

    // A lone winged herald (the Yellow One ceremony's trumpet art) swoops in
    // above a fallen post-Yellow One boss and sounds a single burst. Each of
    // the four recordings phrases differently, so the animation is fitted to
    // the chosen burst via TRUMPET_BURSTS (sounding length + swell chart).
    trumpetFanfare(worldX, worldY) {
        const cfg = TRUMPET_BURSTS[Math.floor(Math.random() * TRUMPET_BURSTS.length)];
        this.heralds.push({
            t: 0,
            x: worldX, y: worldY - 210,   // hovers above the wreck, blaring down at it
            key: 'vfx_trumpet_down',
            flip: Math.random() < 0.5,
            swoop: 0.55,
            soundKey: cfg.key,
            blast: cfg.blast,
            pops: cfg.pops.slice(),
            pop: 0,
            blare: 0,
            streamAcc: 0,
            played: false,
            bob: Math.random() * Math.PI * 2
        });
    }

    _getSilhouette(spriteKey) {
        let entry = this._silhouetteCache.get(spriteKey);
        if (entry !== undefined) return entry;
        const asset = this.game.assets.get(spriteKey);
        if (!asset) return null; // asset not ready — retry on next call
        const img = asset.canvas || (Array.isArray(asset) ? asset[0].canvas : asset);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = '#ffffff';
        g.fillRect(0, 0, canvas.width, canvas.height);
        entry = {
            canvas,
            logicalW: asset.width || img.width,
            logicalH: asset.height || img.height
        };
        this._silhouetteCache.set(spriteKey, entry);
        return entry;
    }

    // ── Drawing ──────────────────────────────────────────────────────────────

    // World-space effects: drawn with the entities, under HUD.
    drawWorld(ctx, camera) {
        if (this.rings.length === 0 && this.silhouettes.length === 0 &&
            this.heralds.length === 0) return;

        // Heralds are solid pixel art — drawn source-over, before the additive
        // rings/silhouettes pass.
        if (this.heralds.length > 0) this._drawHeralds(ctx, camera);
        if (this.rings.length === 0 && this.silhouettes.length === 0) return;

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        const ws = this.game.worldScale;

        for (const r of this.rings) {
            const p = r.t / r.dur;
            const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
            const radius = r.maxR * ease * ws;
            const sx = r.x * camera.wtsScale + camera.wtsOffX;
            const sy = r.y * camera.wtsScale + camera.wtsOffY;
            ctx.globalAlpha = (1 - p) * 0.85;
            ctx.strokeStyle = r.color;
            ctx.lineWidth = Math.max(1, r.width * (1 - p) * ws);
            ctx.beginPath();
            ctx.arc(sx, sy, radius, 0, Math.PI * 2);
            ctx.stroke();
        }

        for (const s of this.silhouettes) {
            const p = s.t / s.dur;
            const scale = 1 + 0.25 * p;
            const w = s.entry.logicalW * ws * scale;
            const h = s.entry.logicalH * ws * scale;
            const sx = s.x * camera.wtsScale + camera.wtsOffX;
            const sy = s.y * camera.wtsScale + camera.wtsOffY;
            ctx.globalAlpha = 1 - p;
            ctx.translate(sx, sy);
            ctx.rotate(s.angle);
            ctx.drawImage(s.entry.canvas, -w / 2, -h / 2, w, h);
            ctx.rotate(-s.angle);
            ctx.translate(-sx, -sy);
        }

        ctx.restore();
    }

    // Swoop in from high overhead (ease-out cubic), winged hover + brass
    // vibrato while the note blares, ascend away once the burst ends. Same
    // visual language as the King's Victory ceremony heralds.
    _drawHeralds(ctx, camera) {
        for (const h of this.heralds) {
            const img = this.game.assets.get(h.key);
            if (!img) continue;
            const canvas = img.canvas || img;
            const logicalW = img.width || canvas.width;
            const logicalH = img.height || canvas.height;

            const e = Math.min(1, h.t / h.swoop);
            const ease = 1 - Math.pow(1 - e, 3);
            let wx = h.x + (h.flip ? -1 : 1) * 260 * (1 - ease);
            let wy = h.y - 340 * (1 - ease);
            wx += Math.sin(h.t * 1.3 + h.bob) * 4 * ease;
            wy += Math.sin(h.t * 2.1 + h.bob) * 7 * ease;

            let alpha = 1;
            const out = h.t - h.swoop - h.blast - 0.25;
            if (out > 0) {
                const o = Math.min(1, out / 0.7);
                wy -= o * o * 520;
                wx += (h.flip ? -1 : 1) * o * o * 130;
                alpha = 1 - o;
            }

            const screen = camera.worldToScreen(wx, wy, this.game.width, this.game.height);
            const ws = this.game.worldScale;
            const scale = ws * (1 + 0.07 * h.blare + 0.12 * h.pop * h.pop);
            const w = logicalW * scale, hh = logicalH * scale;
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(screen.x, screen.y);
            if (h.flip) ctx.scale(-1, 1);
            // Lean into the note with a brass vibrato while it holds.
            ctx.rotate(-0.07 * h.blare + 0.05 * h.blare * Math.sin(h.t * 22 + h.bob));
            if (h.blare > 0.05) {
                ctx.shadowBlur = 20 * ws * h.blare;
                ctx.shadowColor = '#ffdd44';
            }
            ctx.drawImage(canvas, -w / 2, -hh / 2, w, hh);
            ctx.restore();
        }
    }

    // Screen-space overlay: letterbox + warning banner. Drawn above the HUD.
    drawOverlay(ctx) {
        const st = this.state;
        if (st.yellowOneScriptActive) return;
        if (this.letterbox <= 0 && !this.card && !this.reel) return;
        // Behind a local fullscreen menu the sequence is just noise — skip it.
        // (In multiplayer the world keeps running; this only hides the overlay
        // for the player who has the menu open.)
        if (st.paused || st.isShopOpen || st.isEncounterOpen || st.isCacheOpen ||
            st.isLevelUpOpen || st.isTradeOpen) return;

        const W = this.game.width;
        const H = this.game.height;
        const hudScale = this.game.hudScale;

        // Jackpot reel — spins above the ship, settles on the prize name.
        // Co-op: center on the COLLECTING pilot's pane (scaled to it), not the
        // whole screen, so the prize reads for whoever grabbed it.
        if (this.reel) {
            const r = this.reel;
            let cx = Math.round(W / 2);
            let cy = Math.round(H * 0.40);
            let rScale = hudScale;
            if (st.localPlayers && st.localPlayers.length > 1 && r.pilot) {
                const i = st.localPlayers.findIndex(lp => lp.player === r.pilot);
                if (i >= 0 && st._paneRectFor) {
                    const pr = st._paneRectFor(i);
                    cx = Math.round(pr.x + pr.w / 2);
                    cy = Math.round(pr.y + pr.h * 0.40);
                    rScale = Math.max(1, hudScale * pr.h / H);
                }
            }
            const o = Math.max(1, Math.round(rScale / 2));
            const fadeOut = r.t > r.dur - 0.4 ? (r.dur - r.t) / 0.4 : 1;
            let text, color, scale = 1;
            if (r.t < r.settleAt) {
                // Spinning: random characters at the name's length, re-rolled
                // every frame like tumbling reels
                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                text = '';
                for (let i = 0; i < r.text.length; i++) {
                    text += r.text[i] === ' ' ? ' ' : chars[Math.floor(Math.random() * chars.length)];
                }
                color = '#ccddee';
            } else {
                text = r.text;
                color = r.color;
                // Settle pop
                const since = r.t - r.settleAt;
                scale = since < 0.15 ? 1.35 - (since / 0.15) * 0.35 : 1;
            }
            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `${Math.floor(7 * rScale * scale)}px Astro4x`;
            ctx.globalAlpha = fadeOut;
            ctx.fillStyle = '#000000';
            ctx.fillText(text, cx - o, cy);
            ctx.fillText(text, cx + o, cy);
            ctx.fillText(text, cx, cy - o);
            ctx.fillText(text, cx, cy + o);
            ctx.fillStyle = color;
            ctx.fillText(text, cx, cy);
            ctx.restore();
        }

        const ease = this.letterbox * this.letterbox * (3 - 2 * this.letterbox); // smoothstep
        const barH = Math.round(H * 0.06 * ease);
        if (this.letterbox > 0) {
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, W, barH);
            ctx.fillRect(0, H - barH, W, barH);
        }

        if (this.card && this._warnElapsed >= 0) {
            const t = this._warnElapsed;
            const fadeIn = Math.min(1, t / 0.2);
            const fadeOut = t > WARN_BARS_OUT ? Math.max(0, 1 - (t - WARN_BARS_OUT) / 0.5) : 1;
            const bandAlpha = fadeIn * fadeOut;
            if (bandAlpha <= 0) return;

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            // Banner band docked just under the top letterbox bar, framed like
            // the rest of the HUD: dark backing strip with thin red rule lines.
            const bandH = Math.round(21 * hudScale);
            const bandY = barH;
            const line = Math.max(1, Math.round(hudScale / 4));

            ctx.globalAlpha = 0.6 * bandAlpha;
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, bandY, W, bandH);

            const pulse = 0.55 + 0.35 * Math.sin(t * 6.0);
            ctx.globalAlpha = pulse * bandAlpha;
            ctx.fillStyle = '#ff4444';
            ctx.fillRect(0, bandY, W, line);
            ctx.fillRect(0, bandY + bandH - line, W, line);

            // Title — HUD-style 4-pass black outline, soft arcade blink
            const titleY = bandY + Math.round(7.5 * hudScale);
            const blink = (t % 0.7) < 0.45 ? 1 : 0.45;
            const o = Math.max(1, Math.round(hudScale / 2));
            const cx = Math.round(W / 2);
            ctx.font = `${Math.floor(10 * hudScale)}px Astro4x`;
            ctx.globalAlpha = blink * bandAlpha;
            ctx.fillStyle = '#000000';
            ctx.fillText('WARNING', cx - o, titleY);
            ctx.fillText('WARNING', cx + o, titleY);
            ctx.fillText('WARNING', cx, titleY - o);
            ctx.fillText('WARNING', cx, titleY + o);
            ctx.fillStyle = '#ff4444';
            ctx.fillText('WARNING', cx, titleY);

            // Subtitle teletypes in beneath the title (steady, no blink)
            if (t > 0.45) {
                const chars = Math.floor((t - 0.45) / 0.025);
                const text = this.card.subtitle.substring(0, chars);
                if (text.length > 0) {
                    const subY = bandY + Math.round(15.5 * hudScale);
                    ctx.font = `${Math.floor(6 * hudScale)}px Astro4x`;
                    ctx.globalAlpha = bandAlpha;
                    ctx.fillStyle = '#000000';
                    ctx.fillText(text, cx - o, subY);
                    ctx.fillText(text, cx + o, subY);
                    ctx.fillText(text, cx, subY - o);
                    ctx.fillText(text, cx, subY + o);
                    ctx.fillStyle = '#ccddee';
                    ctx.fillText(text, cx, subY);
                }
            }
            ctx.restore();
        }
    }
}
