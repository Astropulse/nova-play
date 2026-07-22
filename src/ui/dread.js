import { KnowledgeEvent, KNOWLEDGE_STATE } from '../entities/knowledgeEvent.js';
import { CthulhuEvent, CTHULHU_STATE } from '../entities/cthulhuEvent.js';
import { YellowOne, YO_STATE } from '../entities/yellowOne.js';
import { Carcosa } from '../entities/bones.js';

// DreadLevel: a cosmetic 0..4 measure of how far the player has looked into
// the things that should not be looked into. Unlike the kill streak, dread is
// NOT a constant filter — it manifests as rare, brief, easily-missed moments,
// each rate-limited to stay uncanny instead of annoying:
//
//   L1 (found anything)        — void patches: something dark drifts across
//                                 the stars; faint audio stings
//   L2 (woke the God / Galaxy) — + the Eye opens in the deep background;
//                                 the HUD briefly garbles
//   L3 (the King is known)     — + gold light creeps in from a screen corner:
//                                 the reward color, arriving uninvited
//   L4 (the universe is ending)— everything above, more often
//
// Strictly local + cosmetic (Math.random only, never the seeded streams).
// Levels only rise within a run, never fall.

// [minDelay, maxDelay] seconds between occurrences, and the level required
const SCHEDULE = {
    patches:     { min: 90,  max: 180, level: 1 },
    sting:       { min: 110, max: 220, level: 1 },
    warp:        { min: 55,  max: 130, level: 1 },
    hudGlitch:   { min: 70,  max: 150, level: 2 },
    shadow:      { min: 80,  max: 190, level: 2 },
    eye:         { min: 200, max: 380, level: 2 },
    yellowCreep: { min: 100, max: 210, level: 3 }
};

const SHADOW_SPRITES = ['enemy_ship_0', 'enemy_ship_1', 'enemy_ship_2', 'enemy_ship_3', 'enemy_ship_4'];

const GARBLE_CHARS = '0123456789#?!/';

export class DreadDirector {
    constructor(game, state) {
        this.game = game;
        this.state = state;
        this.level = 0;

        // Test hooks (NOVA_AUTOTEST_DREAD): pin a level + compress the clock
        this.forceLevel = 0;
        this.debugFast = false;

        this._next = {};
        for (const key in SCHEDULE) this._next[key] = this._roll(SCHEDULE[key]);

        this.patches = [];     // drifting dark blobs over the starfield
        this.eye = null;       // the watcher in the deep background
        this.creep = null;     // { t, dur, corner }
        this.glitchScrap = 0;  // seconds left of garbled scrap counter
        this.glitchCoords = 0;
        this.warp = null;      // { t, dur, peak } — reality-warp shader pulse
        this.shadows = [];     // hallucinated ships at the edge of vision
        this._frenzyNext = 0.5; // fast clock for the Yellow One's stalk
        this._shadowCache = new Map();
        this._creepGrad = null; // origin-centered gradient, translated per frame

        this._patchSprite = null;
        this._creepGrads = null;
        this._creepW = 0;
        this._creepH = 0;
    }

    _roll(sched) {
        const d = sched.min + Math.random() * (sched.max - sched.min);
        return d * (this.debugFast ? 0.04 : 1);
    }

    // Highest horror the player has witnessed, from locally-visible state
    // (event states are replicated to multiplayer clients, so this works the
    // same on every machine).
    _computeLevel() {
        const st = this.state;
        let lvl = 0;
        if (st.stats && st.stats.eventsDiscovered >= 1) lvl = 1;
        for (const ev of st.events) {
            if (ev instanceof KnowledgeEvent && ev.state >= KNOWLEDGE_STATE.NEAR) lvl = Math.max(lvl, 2);
            else if (ev instanceof CthulhuEvent && ev.state >= CTHULHU_STATE.WAKING) lvl = Math.max(lvl, 2);
            else if (ev instanceof YellowOne && ev.state !== YO_STATE.IDLE) lvl = Math.max(lvl, 3);
        }
        if (st.yellowOneFightActive) lvl = Math.max(lvl, 3);
        if (st.player && st.player.hasYellowGlow) lvl = Math.max(lvl, 4);
        return Math.max(lvl, this.forceLevel);
    }

    update(dt) {
        this.level = Math.max(this.level, this._computeLevel());

        // Active moments keep fading even while suppressed; only NEW moments
        // are held back during the scripted sequence or death.
        const suppressed = this.state.yellowOneScriptActive || this.state.isDead;

        if (!suppressed && this.level > 0) {
            const freqMult = this.level >= 4 ? 0.6 : 1;
            for (const key in SCHEDULE) {
                const sched = SCHEDULE[key];
                if (this.level < sched.level) continue;
                this._next[key] -= dt / freqMult;
                if (this._next[key] <= 0) {
                    this._next[key] = this._roll(sched);
                    this._trigger(key);
                }
            }
        }

        // The Yellow One's stalk: while he silently follows the player
        // (pre-fight), reality degrades relentlessly — a haunting moment lands
        // at LEAST every couple of seconds, usually faster. Same moments as
        // the slow scheduler above, on its own compressed clock.
        let stalk = false;
        for (const ev of this.state.events) {
            if (ev instanceof YellowOne && ev.state === YO_STATE.FOLLOWING) { stalk = true; break; }
        }

        // Carcosa's static: nearing the starfield of bones frays reality on a
        // sliding scale — the same haunting-moment pool as the stalk, firing
        // faster the closer you get, plus a standing shader warp (getFx) and a
        // faint tremor — all of it until the city is rebuilt.
        let carcosa = 0;
        let tribute = 0;
        for (const ev of this.state.events) {
            if (!(ev instanceof Carcosa)) continue;
            if (ev.dreadFactor) carcosa = Math.max(carcosa, ev.dreadFactor);
            // Post-fight: total silence until the tribute is claimed.
            if (ev.awaitingTribute) tribute = 1;
        }
        this.carcosaProx = (this.carcosaProx || 0)
            + (carcosa - (this.carcosaProx || 0)) * (1 - Math.exp(-2 * dt));
        this._tributeSilence = (this._tributeSilence || 0)
            + (tribute - (this._tributeSilence || 0)) * (1 - Math.exp(-1.2 * dt));
        if (this.carcosaProx > 0.35) {
            this.game.camera.rumble((this.carcosaProx - 0.35) * 0.4);
        }

        const frenzy = stalk ? 1 : (this.carcosaProx > 0.06 ? 0.1 + 0.9 * this.carcosaProx : 0);
        if (frenzy > 0 && !suppressed) {
            this._frenzyNext -= dt * frenzy;
            if (this._frenzyNext <= 0) {
                this._frenzyNext = 0.4 + Math.random() * 1.1; // ≤1.5s gap at full pressure
                this._triggerStalkMoment();
            }
        } else {
            this._frenzyNext = Math.min(this._frenzyNext, 0.5);
        }

        for (let i = this.patches.length - 1; i >= 0; i--) {
            const p = this.patches[i];
            p.t += dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            if (p.t >= p.dur) this.patches.splice(i, 1);
        }
        if (this.eye) {
            const e = this.eye;
            e.t += dt;
            // The world trembles faintly while it watches
            const prog = e.t / e.dur;
            this.game.camera.rumble(0.3 * Math.sin(prog * Math.PI));
            this._updateEyeGaze(e, dt);
            if (e.t >= e.dur) this.eye = null;
        }
        if (this.creep) {
            this.creep.t += dt;
            this.creep.x += this.creep.vx * dt;
            this.creep.y += this.creep.vy * dt;
            if (this.creep.t >= this.creep.dur) this.creep = null;
        }
        if (this.glitchScrap > 0) this.glitchScrap -= dt;
        if (this.glitchCoords > 0) this.glitchCoords -= dt;
        if (this.warp) {
            this.warp.t += dt;
            if (this.warp.t >= this.warp.dur) this.warp = null;
        }
        for (let i = this.shadows.length - 1; i >= 0; i--) {
            const s = this.shadows[i];
            s.t += dt;
            s.wx += s.vx * dt;
            s.wy += s.vy * dt;
            if (s.t >= s.dur) this.shadows.splice(i, 1);
        }

        // Audio warble follows whatever moment is active — fast attack, slow
        // release, so it lingers a couple of seconds after the moment passes.
        // Sporadic like the visuals, never a standing effect.
        const warbleNow = this._warbleAmount();
        this._warbleEnv = Math.max(warbleNow, (this._warbleEnv || 0) - dt * 0.4);
        if (this.game.sounds && this.game.sounds.setDreadWarble) {
            this.game.sounds.setDreadWarble(this._warbleEnv);
        }

        // Horror anti-fanfare: nearing a dormant horror, the casino goes
        // quiet — music creeps toward silence and the screen edges darken.
        // Spatial rather than sporadic: this is the approach experience.
        const prox = this._horrorProximity();
        this.horrorProx = (this.horrorProx || 0) + (prox - (this.horrorProx || 0)) * (1 - Math.exp(-2 * dt));
        if (this.game.sounds && this.game.sounds.setMusicDuck) {
            // Tribute silence outranks the approach hush — full duck.
            this.game.sounds.setMusicDuck(Math.max(this.horrorProx * 0.75, this._tributeSilence || 0));
        }
    }

    // 0 far → 1 close, against the nearest STILL-DORMANT horror. Once a thing
    // wakes, its own music takes over and the hush releases.
    _horrorProximity() {
        const st = this.state;
        const p = st.player;
        if (!p) return 0;
        const START = 3200, FULL = 900;
        let best = 0;
        for (const ev of st.events) {
            let dormant = false;
            let start = START, full = FULL;
            if (ev instanceof KnowledgeEvent) dormant = ev.state === KNOWLEDGE_STATE.DORMANT;
            else if (ev instanceof CthulhuEvent) dormant = ev.state === CTHULHU_STATE.DORMANT;
            else if (ev instanceof YellowOne) dormant = ev.state === YO_STATE.IDLE;
            else if (ev instanceof Carcosa) {
                // The hush reaches out past the bone belt — the main music
                // dies on the approach, well before the event song takes over
                // (once that starts, hushActive drops and the duck releases).
                dormant = ev.hushActive;
                start = 7000; full = 2800;
            }
            if (!dormant) continue;
            const dx = ev.worldX - p.worldX;
            const dy = ev.worldY - p.worldY;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d < start) best = Math.max(best, Math.min(1, (start - d) / (start - full)));
        }
        return best;
    }

    _warbleAmount() {
        let amt = 0;
        if (this.warp) {
            amt = Math.max(amt, Math.sin((this.warp.t / this.warp.dur) * Math.PI) * this.warp.peak);
        }
        if (this.eye) {
            amt = Math.max(amt, Math.sin((this.eye.t / this.eye.dur) * Math.PI) * 0.7);
        }
        if (this.creep) {
            amt = Math.max(amt, Math.sin((this.creep.t / this.creep.dur) * Math.PI) * 0.4);
        }
        return amt;
    }

    // The pupil fixates on something — usually you — then snaps to the next
    // thing: a rock drifting past, one of the ships hunting you.
    _updateEyeGaze(e, dt) {
        e.gazeTimer -= dt;
        if (e.gazeTimer <= 0) {
            e.gazeTimer = 0.7 + Math.random() * 0.8;
            const st = this.state;
            let target = st.player;
            const roll = Math.random();
            if (roll > 0.6 && st.enemies.length > 0) {
                target = st.enemies[Math.floor(Math.random() * st.enemies.length)];
            } else if (roll > 0.35 && st.asteroids.length > 0) {
                target = st.asteroids[Math.floor(Math.random() * st.asteroids.length)];
            }
            e.gazeTarget = target;
        }
        // Where is the eye, in world terms? Its parallax anchor resolved back
        // through the camera.
        const cam = this.game.camera;
        const eyeWx = e.spawnCamX + e.offX + (cam.x - e.spawnCamX) * (1 - e.parallax);
        const eyeWy = e.spawnCamY + e.offY + (cam.y - e.spawnCamY) * (1 - e.parallax);
        const tgt = e.gazeTarget || this.state.player;
        const dx = (tgt.worldX !== undefined ? tgt.worldX : eyeWx) - eyeWx;
        const dy = (tgt.worldY !== undefined ? tgt.worldY : eyeWy) - eyeWy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        // Same displacement language as the real Knowledge event (~20 units max)
        const maxDisp = 18;
        const wantX = (dx / len) * maxDisp;
        const wantY = (dy / len) * maxDisp;
        // Quick snap between fixation points — a dart, not a glide
        const k = 1 - Math.exp(-10 * dt);
        e.pupilX += (wantX - e.pupilX) * k;
        e.pupilY += (wantY - e.pupilY) * k;
    }

    // Shader-side moment intensities, consumed by Game.loop via the state.
    getFx() {
        let warp = 0;
        if (this.warp) {
            const p = this.warp.t / this.warp.dur;
            warp = Math.sin(p * Math.PI) * this.warp.peak;
        }
        // Carcosa's standing distortion floor: the closer to the dead city,
        // the more the whole screen tears and desaturates (transient pulses
        // still spike above it).
        if (this.carcosaProx > 0.05) {
            warp = Math.max(warp, this.carcosaProx * 0.38);
        }
        return { warp };
    }

    // One stalk-frenzy moment, weighted toward the cheap, high-read effects
    // (reality warps, ghost ships, HUD garbage). The Eye stays rare even here
    // — it lasts 7s and loses its menace if it's always open.
    _triggerStalkMoment() {
        const roll = Math.random();
        if (roll < 0.30) this._trigger('warp');
        else if (roll < 0.52) this._trigger('shadow');
        else if (roll < 0.68) this._trigger('hudGlitch');
        else if (roll < 0.82) this._trigger('patches');
        else if (roll < 0.91) this._trigger('yellowCreep');
        else if (roll < 0.97) this._trigger('sting');
        else if (!this.eye) this._trigger('eye');
        else this._trigger('warp');
    }

    _trigger(key) {
        const W = this.game.width, H = this.game.height;
        switch (key) {
            case 'patches': {
                const count = 2 + Math.floor(Math.random() * 3);
                for (let i = 0; i < count; i++) {
                    this.patches.push({
                        x: Math.random() * W,
                        y: Math.random() * H,
                        r: (0.14 + Math.random() * 0.16) * Math.min(W, H),
                        vx: (Math.random() - 0.5) * 24,
                        vy: (Math.random() - 0.5) * 24,
                        t: -Math.random() * 1.2, // stagger their arrival
                        dur: 3 + Math.random() * 2
                    });
                }
                break;
            }
            case 'sting':
                if (this.game.sounds && this.game.sounds.playDreadSting) {
                    this.game.sounds.playDreadSting(this.level);
                }
                break;
            case 'hudGlitch':
                if (Math.random() < 0.65) this.glitchScrap = 0.4 + Math.random() * 0.8;
                else this.glitchCoords = 0.4 + Math.random() * 0.8;
                break;
            case 'eye': {
                // A world-space presence: anchored in deep space with a
                // parallax factor, drawn at the sprite's true world scale —
                // exactly like the real Knowledge event renders.
                const cam = this.game.camera;
                this.eye = {
                    t: 0, dur: 7.0,
                    offX: (Math.random() - 0.5) * 400,   // world units from view center at spawn
                    offY: -60 - Math.random() * 180,     // biased above the player
                    spawnCamX: cam.x,
                    spawnCamY: cam.y,
                    parallax: 0.35,                      // drifts at 35% of world scroll — vast and far
                    pupilX: 0, pupilY: 0,                // darting gaze offset (world units)
                    gazeTarget: null,
                    gazeTimer: 0,
                    frameTimer: 0,
                    frame: 0
                };
                // It does not arrive silently
                if (this.game.sounds && this.game.sounds.playDreadSting) {
                    this.game.sounds.playDreadSting(this.level);
                }
                break;
            }
            case 'yellowCreep': {
                // Bleeds in from a random point along any screen edge, then
                // slowly seeps inward while it lasts.
                const side = Math.floor(Math.random() * 4);
                let x, y, nx, ny; // position on the border + inward normal
                if (side === 0) { x = Math.random() * W; y = 0; nx = 0; ny = 1; }
                else if (side === 1) { x = Math.random() * W; y = H; nx = 0; ny = -1; }
                else if (side === 2) { x = 0; y = Math.random() * H; nx = 1; ny = 0; }
                else { x = W; y = Math.random() * H; nx = -1; ny = 0; }
                const seep = 14 + Math.random() * 18; // px/s inward
                const slide = (Math.random() - 0.5) * 26; // px/s along the edge
                this.creep = {
                    t: 0, dur: 5.0, x, y,
                    vx: nx * seep + ny * slide,
                    vy: ny * seep + nx * slide
                };
                break;
            }
            case 'warp':
                // A second or two where the picture stops being trustworthy
                this.warp = {
                    t: 0,
                    dur: 0.8 + Math.random() * 1.0,
                    peak: 0.45 + 0.12 * this.level
                };
                if (Math.random() < 0.35 && this.game.sounds && this.game.sounds.playDreadSting) {
                    this.game.sounds.playDreadSting(this.level);
                }
                break;
            case 'shadow': {
                // A ship that isn't there, at the edge of vision, sliding
                // toward you — gone the moment you look at it.
                const cam = this.game.camera;
                const ws = this.game.worldScale;
                const halfW = this.game.width / ws / 2;
                const halfH = this.game.height / ws / 2;
                const side = Math.floor(Math.random() * 4);
                let wx, wy;
                if (side === 0) { wx = cam.x - halfW * 0.85; wy = cam.y + (Math.random() - 0.5) * halfH * 1.6; }
                else if (side === 1) { wx = cam.x + halfW * 0.85; wy = cam.y + (Math.random() - 0.5) * halfH * 1.6; }
                else if (side === 2) { wx = cam.x + (Math.random() - 0.5) * halfW * 1.6; wy = cam.y - halfH * 0.85; }
                else { wx = cam.x + (Math.random() - 0.5) * halfW * 1.6; wy = cam.y + halfH * 0.85; }
                const toCam = Math.atan2(cam.y - wy, cam.x - wx);
                const drift = 40 + Math.random() * 60;
                this.shadows.push({
                    sprite: SHADOW_SPRITES[Math.floor(Math.random() * SHADOW_SPRITES.length)],
                    wx, wy,
                    vx: Math.cos(toCam) * drift,
                    vy: Math.sin(toCam) * drift,
                    angle: toCam + Math.PI / 2,
                    scale: 1.5 + Math.random() * 1.5,
                    t: 0,
                    dur: 0.3 + Math.random() * 0.45
                });
                break;
            }
        }
    }

    _getShadowSilhouette(spriteKey) {
        let entry = this._shadowCache.get(spriteKey);
        if (entry !== undefined) return entry;
        const asset = this.game.assets.get(spriteKey);
        if (!asset) return null;
        const img = asset.canvas || (Array.isArray(asset) ? asset[0].canvas : asset);
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const g = canvas.getContext('2d');
        g.drawImage(img, 0, 0);
        g.globalCompositeOperation = 'source-in';
        g.fillStyle = '#0a0814'; // near-black violet — a hole in the starfield
        g.fillRect(0, 0, canvas.width, canvas.height);
        entry = { canvas, logicalW: asset.width || img.width, logicalH: asset.height || img.height };
        this._shadowCache.set(spriteKey, entry);
        return entry;
    }

    // Random garbage for the HUD glitches — re-rolled every frame it's drawn,
    // so the readout crawls.
    garble(n) {
        let s = '';
        for (let i = 0; i < n; i++) s += GARBLE_CHARS[Math.floor(Math.random() * GARBLE_CHARS.length)];
        return s;
    }

    _getPatchSprite() {
        if (this._patchSprite) return this._patchSprite;
        const size = 256;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const g = c.getContext('2d');
        const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, 'rgba(0,0,0,1)');
        grad.addColorStop(0.6, 'rgba(0,0,0,0.7)');
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, size, size);
        this._patchSprite = c;
        return c;
    }

    // Drawn immediately after the starfield, under every entity — these only
    // touch the backdrop.
    // The Eye is the deepest thing there is — drawn alone, immediately on top
    // of the bare starfield, beneath even the ambience weather.
    drawEye(ctx) {
        if (this.eye) {
            const pupilFrames = this.game.assets.get('knowledge_eye');
            const baseImg = this.game.assets.get('knowledge');
            if (pupilFrames && Array.isArray(pupilFrames) && pupilFrames.length && baseImg) {
                const e = this.eye;
                const cam = this.game.camera;
                const ws = this.game.worldScale;
                const W = this.game.width, H = this.game.height;
                const prog = e.t / e.dur;
                const alpha = Math.sin(prog * Math.PI);
                const sx = W / 2 + (e.offX - (cam.x - e.spawnCamX) * e.parallax) * ws;
                const sy = H / 2 + (e.offY - (cam.y - e.spawnCamY) * e.parallax) * ws;

                // Advance the pupil GIF on its own delays
                e.frameTimer += this.game.lastDt ? this.game.lastDt * 1000 : 16;
                const cur = pupilFrames[e.frame % pupilFrames.length];
                if (cur.delay && e.frameTimer >= cur.delay) {
                    e.frameTimer = 0;
                    e.frame = (e.frame + 1) % pupilFrames.length;
                }

                const baseCanvas = baseImg.canvas || baseImg;
                const blw = baseImg.width || baseCanvas.width;
                const blh = baseImg.height || baseCanvas.height;
                const bw = blw * ws;
                const bh = blh * ws;

                // Compose pupil-under-base at FULL opacity offscreen (the
                // opaque galaxy masks the pupil exactly like the real event),
                // then stamp the result once at the apparition's alpha — so
                // the pupil can never bleed through the translucent base.
                const nativeW = baseCanvas.width, nativeH = baseCanvas.height;
                if (!this._eyeCompose || this._eyeCompose.width !== nativeW || this._eyeCompose.height !== nativeH) {
                    this._eyeCompose = document.createElement('canvas');
                    this._eyeCompose.width = nativeW;
                    this._eyeCompose.height = nativeH;
                }
                const cc = this._eyeCompose.getContext('2d');
                cc.clearRect(0, 0, nativeW, nativeH);
                const prescale = nativeW / blw; // native px per logical px
                const pf = pupilFrames[e.frame % pupilFrames.length];
                const pImg = pf.canvas || pf;
                cc.drawImage(pImg,
                    nativeW / 2 + e.pupilX * prescale - pImg.width / 2,
                    nativeH / 2 + e.pupilY * prescale - pImg.height / 2);
                cc.drawImage(baseCanvas, 0, 0);

                // Darkness pools around it as it opens
                const halo = this._getPatchSprite();
                ctx.save();
                ctx.globalAlpha = alpha * 0.7;
                ctx.drawImage(halo, sx - bw * 1.1, sy - bh * 1.1, bw * 2.2, bh * 2.2);
                ctx.globalAlpha = alpha * alpha * 0.55;
                ctx.drawImage(this._eyeCompose, sx - bw / 2, sy - bh / 2, bw, bh);
                ctx.restore();
            }
        }
    }

    drawBackground(ctx) {
        if (this.patches.length === 0 && this.shadows.length === 0) return;

        if (this.patches.length > 0) {
            const sprite = this._getPatchSprite();
            ctx.save();
            for (const p of this.patches) {
                if (p.t < 0) continue; // still staggered out
                const prog = p.t / p.dur;
                ctx.globalAlpha = Math.sin(prog * Math.PI) * 0.75;
                ctx.drawImage(sprite, p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
            }
            ctx.restore();
        }

        // Hallucinated ships — flickering, half-glimpsed, gone when checked
        if (this.shadows.length > 0) {
            const cam = this.game.camera;
            const ws = this.game.worldScale;
            ctx.save();
            for (const s of this.shadows) {
                const sil = this._getShadowSilhouette(s.sprite);
                if (!sil) continue;
                const sx = s.wx * cam.wtsScale + cam.wtsOffX;
                const sy = s.wy * cam.wtsScale + cam.wtsOffY;
                const w = sil.logicalW * s.scale * ws;
                const h = sil.logicalH * s.scale * ws;
                // Hard per-frame flicker — it never holds still enough to be sure
                ctx.globalAlpha = (0.3 + Math.random() * 0.4) * Math.sin((s.t / s.dur) * Math.PI);
                ctx.translate(sx, sy);
                ctx.rotate(s.angle);
                ctx.drawImage(sil.canvas, -w / 2, -h / 2, w, h);
                ctx.rotate(-s.angle);
                ctx.translate(-sx, -sy);
            }
            ctx.restore();
        }
    }

    // Drawn just under the HUD: the horror-approach hush and the gold creep.
    // vp (optional): a pane rect — co-op centers the approach-hush vignette on
    // each pane. Null = full screen. (Dread is shared global state.)
    drawOverlay(ctx, vp = null) {
        // Approach hush: a steady darkening at the edges, no pulse, no color —
        // the opposite of fanfare.
        if (this.horrorProx > 0.01) {
            const W = vp ? vp.w : this.game.width;
            const H = vp ? vp.h : this.game.height;
            const ox = vp ? vp.x : 0, oy = vp ? vp.y : 0;
            let g;
            if (!vp && this._hushGrad && this._hushW === W && this._hushH === H) {
                g = this._hushGrad;
            } else {
                const cornerDist = Math.sqrt(W * W + H * H) / 2;
                const cx = ox + W / 2, cy = oy + H / 2;
                g = ctx.createRadialGradient(cx, cy, Math.min(W, H) * 0.3, cx, cy, cornerDist);
                g.addColorStop(0, 'rgba(0,0,0,0)');
                g.addColorStop(0.6, 'rgba(0,0,0,0.45)');
                g.addColorStop(1, 'rgba(0,0,0,1)');
                if (!vp) { this._hushGrad = g; this._hushW = W; this._hushH = H; }
            }
            ctx.save();
            ctx.globalAlpha = this.horrorProx * 0.4;
            ctx.fillStyle = g;
            ctx.fillRect(ox, oy, W, H);
            ctx.restore();
        }

        if (!this.creep) return;
        const W = this.game.width, H = this.game.height;
        const radius = Math.min(W, H) * 0.6;
        if (!this._creepGrad || this._creepW !== W || this._creepH !== H) {
            this._creepW = W;
            this._creepH = H;
            // Origin-centered; translated to the bleed point each frame so the
            // gradient itself is built once.
            const g = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
            g.addColorStop(0, 'rgba(232,200,74,1)');
            g.addColorStop(0.45, 'rgba(232,200,74,0.4)');
            g.addColorStop(1, 'rgba(232,200,74,0)');
            this._creepGrad = g;
        }
        const prog = this.creep.t / this.creep.dur;
        // Uneven flickering arrival — light that shouldn't be there
        const flicker = 0.9 + 0.1 * Math.sin(this.creep.t * 13.7) * Math.sin(this.creep.t * 5.1);
        ctx.save();
        ctx.globalAlpha = Math.sin(prog * Math.PI) * 0.12 * flicker;
        ctx.translate(this.creep.x, this.creep.y);
        ctx.fillStyle = this._creepGrad;
        ctx.fillRect(-this.creep.x, -this.creep.y, W, H);
        ctx.restore();
    }
}
