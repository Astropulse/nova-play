// Procedural juice SFX, synthesized with WebAudio on the SoundManager's
// effects bus (so the SFX volume, ducking and audio-corruption chain all
// apply). No assets: each voice is a few oscillators / one shared noise
// buffer, scheduled and auto-disconnected. Every kind is rate-limited so a
// busy fight can't stack hundreds of voices.
//
//   zap(x, y, vol)        electrical crackle — stuttered bandpassed noise + buzz
//   coin(step)            casino ding; `step` climbs a pentatonic ladder
//   deflect(x, y)         ricochet "pyew" off an energy shield
//   thump(size, x, y)     sub-bass punch under explosions
//   crackle(x, y)         a few dry fire pops (burning ships)
//   chime()               rising sparkle arpeggio (level-up)

// Major-pentatonic ladder in semitones — every step sounds "right", so rapid
// pickups climb a melody instead of a siren.
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const MIN_GAP = { zap: 0.05, coin: 0.035, deflect: 0.045, thump: 0.06, crackle: 0.12, chime: 0.4, warp: 0.12, cash: 0.08, denied: 0.15, heartbeat: 0.3, drone: 1, shimmer: 1 };

export class SfxSynth {
    constructor(sounds) {
        this.sounds = sounds;
        this._last = {};
        this._noise = null;
    }

    // Common gate: context alive, kind not rate-limited, distance attenuation.
    // Returns the final linear volume (0 = skip).
    _gate(kind, vol, x, y) {
        const s = this.sounds;
        if (!s || !s.ctx) return 0;
        const now = s.ctx.currentTime;
        if (now - (this._last[kind] || -1) < MIN_GAP[kind]) return 0;
        let v = vol * (s.sfxVolume != null ? s.sfxVolume : 1);
        if (x != null && y != null && s._listenerDist) {
            const d = s._listenerDist(x, y);
            if (d >= 2200) return 0;
            if (d > 1000) v *= 1 - (d - 1000) / 1200;
        }
        if (v <= 0.002) return 0;
        if (s.ctx.state === 'suspended') s.ctx.resume();
        this._last[kind] = now;
        return v;
    }

    _out() { return this.sounds._fxBus || this.sounds.ctx.destination; }

    _noiseBuf() {
        if (this._noise) return this._noise;
        const ctx = this.sounds.ctx;
        const len = Math.floor(ctx.sampleRate * 0.6);
        const buf = ctx.createBuffer(1, len, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        this._noise = buf;
        return buf;
    }

    _env(g, t0, peak, attack, decay) {
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
    }

    _cleanup(nodes, at) {
        const last = nodes[0];
        last.onended = () => { for (const n of nodes) { try { n.disconnect(); } catch (e) { /* already gone */ } } };
        last.stop(at);
    }

    zap(x, y, vol = 0.35) {
        const v = this._gate('zap', vol, x, y);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.005;
        const dur = 0.12 + Math.random() * 0.1;
        const src = ctx.createBufferSource();
        src.buffer = this._noiseBuf();
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 2600 + Math.random() * 2400;
        bp.Q.value = 1.4;
        const g = ctx.createGain();
        // Stuttered gate: the "crackle" of an arc re-striking.
        g.gain.setValueAtTime(0, t0);
        let t = t0;
        while (t < t0 + dur) {
            const on = Math.random() < 0.7;
            g.gain.setValueAtTime(on ? v * (0.5 + Math.random() * 0.5) : 0, t);
            t += 0.006 + Math.random() * 0.014;
        }
        g.gain.setValueAtTime(0, t);
        // Mains-hum buzz underneath.
        const osc = ctx.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 90 + Math.random() * 60;
        const og = ctx.createGain();
        this._env(og, t0, v * 0.12, 0.004, dur);
        src.connect(bp); bp.connect(g); g.connect(this._out());
        osc.connect(og); og.connect(this._out());
        src.start(t0, Math.random() * 0.3);
        osc.start(t0);
        this._cleanup([src, bp, g], t0 + dur + 0.02);
        this._cleanup([osc, og], t0 + dur + 0.02);
    }

    coin(step = 0, vol = 0.22) {
        const v = this._gate('coin', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.003;
        const semis = PENTA[Math.min(step, 5)]; // cap at one octave
        const f = 784 * Math.pow(2, semis / 12); // G5 up the ladder
        // Two-partial "ding": square chip tone + a sine an octave up that
        // rings a touch longer — the slot-machine payout timbre.
        const o1 = ctx.createOscillator(); o1.type = 'square'; o1.frequency.value = f;
        const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 5200;
        const g1 = ctx.createGain(); this._env(g1, t0, v * 0.35, 0.003, 0.09);
        const g2 = ctx.createGain(); this._env(g2, t0, v * 0.5, 0.003, 0.18);
        o1.connect(g1); g1.connect(lp); lp.connect(this._out());
        o2.connect(g2); g2.connect(this._out());
        o1.start(t0); o2.start(t0);
        this._cleanup([o1, g1, lp], t0 + 0.12);
        this._cleanup([o2, g2], t0 + 0.22);
    }

    deflect(x, y, vol = 0.3) {
        const v = this._gate('deflect', vol, x, y);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.003;
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        const f0 = 2200 + Math.random() * 900;
        o.frequency.setValueAtTime(f0, t0);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.35, t0 + 0.16);
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.9;
        const g = ctx.createGain(); this._env(g, t0, v * 0.4, 0.004, 0.17);
        o.connect(bp); bp.connect(g); g.connect(this._out());
        o.start(t0);
        this._cleanup([o, bp, g], t0 + 0.2);
    }

    thump(size = 1, x, y, vol = 0.5) {
        const v = this._gate('thump', vol * Math.min(1.3, 0.55 + size * 0.45), x, y);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.003;
        const o = ctx.createOscillator(); o.type = 'sine';
        const f = 110 - Math.min(size, 2) * 25;
        o.frequency.setValueAtTime(f, t0);
        o.frequency.exponentialRampToValueAtTime(32, t0 + 0.28 + size * 0.1);
        const g = ctx.createGain(); this._env(g, t0, v * 0.9, 0.006, 0.3 + size * 0.15);
        o.connect(g); g.connect(this._out());
        o.start(t0);
        this._cleanup([o, g], t0 + 0.5 + size * 0.15);
    }

    crackle(x, y, vol = 0.12) {
        const v = this._gate('crackle', vol, x, y);
        if (!v) return;
        const ctx = this.sounds.ctx;
        const n = 2 + (Math.random() * 3 | 0);
        for (let i = 0; i < n; i++) {
            const t0 = ctx.currentTime + 0.005 + i * (0.02 + Math.random() * 0.05);
            const src = ctx.createBufferSource(); src.buffer = this._noiseBuf();
            const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1200 + Math.random() * 2000;
            const g = ctx.createGain(); this._env(g, t0, v * (0.5 + Math.random() * 0.5), 0.001, 0.02);
            src.connect(hp); hp.connect(g); g.connect(this._out());
            src.start(t0, Math.random() * 0.5);
            this._cleanup([src, hp, g], t0 + 0.04);
        }
    }

    // Warp-in arrival: a rising filtered "vwoop" into a soft pop.
    warp(x, y, vol = 0.22) {
        const v = this._gate('warp', vol, x, y);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.003;
        const o = ctx.createOscillator(); o.type = 'sawtooth';
        o.frequency.setValueAtTime(140, t0);
        o.frequency.exponentialRampToValueAtTime(1400, t0 + 0.17);
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
        lp.frequency.setValueAtTime(400, t0);
        lp.frequency.exponentialRampToValueAtTime(5000, t0 + 0.17);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(v * 0.3, t0 + 0.15);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.26);
        o.connect(lp); lp.connect(g); g.connect(this._out());
        o.start(t0);
        this._cleanup([o, lp, g], t0 + 0.28);
    }

    // Cash register: a bright two-note "ka-ching" over a metallic click.
    cash(vol = 0.22) {
        const v = this._gate('cash', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.003;
        const src = ctx.createBufferSource(); src.buffer = this._noiseBuf();
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000;
        const g = ctx.createGain(); this._env(g, t0, v * 0.5, 0.001, 0.03);
        src.connect(hp); hp.connect(g); g.connect(this._out());
        src.start(t0, Math.random() * 0.4);
        this._cleanup([src, hp, g], t0 + 0.05);
        [1568, 2093].forEach((f, i) => {
            const ti = t0 + 0.04 + i * 0.07;
            const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
            const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2.01;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6000;
            const gg = ctx.createGain(); this._env(gg, ti, v * 0.3, 0.002, 0.22);
            o.connect(lp); o2.connect(lp); lp.connect(gg); gg.connect(this._out());
            o.start(ti); o2.start(ti); o2.stop(ti + 0.26);
            this._cleanup([o, lp, gg], ti + 0.26);
        });
    }

    // Denied: a short descending two-tone buzz.
    denied(vol = 0.2) {
        const v = this._gate('denied', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx;
        [196, 147].forEach((f, i) => {
            const t0 = ctx.currentTime + 0.003 + i * 0.09;
            const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = f;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
            const g = ctx.createGain(); this._env(g, t0, v * 0.35, 0.004, 0.08);
            o.connect(lp); lp.connect(g); g.connect(this._out());
            o.start(t0);
            this._cleanup([o, lp, g], t0 + 0.1);
        });
    }

    // Heartbeat: lub-dub of two sub thumps.
    heartbeat(vol = 0.5) {
        const v = this._gate('heartbeat', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx;
        [[0, 1], [0.17, 0.7]].forEach(([dt, k]) => {
            const t0 = ctx.currentTime + 0.003 + dt;
            const o = ctx.createOscillator(); o.type = 'sine';
            o.frequency.setValueAtTime(70, t0);
            o.frequency.exponentialRampToValueAtTime(38, t0 + 0.16);
            const g = ctx.createGain(); this._env(g, t0, v * k, 0.008, 0.2);
            o.connect(g); g.connect(this._out());
            o.start(t0);
            this._cleanup([o, g], t0 + 0.25);
        });
    }

    // Dread drone: a low detuned swell that rises in pitch over `dur`.
    drone(dur = 6, vol = 0.18) {
        const v = this._gate('drone', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.01;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
        lp.frequency.setValueAtTime(200, t0); lp.frequency.exponentialRampToValueAtTime(900, t0 + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(v * 0.5, t0 + dur * 0.6);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        lp.connect(g); g.connect(this._out());
        [43.6, 44.4, 65.4].forEach((f) => {
            const o = ctx.createOscillator(); o.type = 'sawtooth';
            o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 1.5, t0 + dur);
            o.connect(lp); o.start(t0); o.stop(t0 + dur + 0.05);
            o.onended = () => { try { o.disconnect(); } catch (e) { /* gone */ } };
        });
        setTimeout(() => { try { lp.disconnect(); g.disconnect(); } catch (e) { /* gone */ } }, (dur + 0.3) * 1000);
    }

    // Holy shimmer: a high open-fifth pad with a soft swell (light breaking in).
    shimmer(dur = 3, vol = 0.12) {
        const v = this._gate('shimmer', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.01;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(v * 0.4, t0 + dur * 0.5);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(this._out());
        [1046.5, 1568, 2093, 2637].forEach((f, i) => {
            const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * (1 + (i - 1.5) * 0.002);
            o.connect(g); o.start(t0); o.stop(t0 + dur + 0.05);
            o.onended = () => { try { o.disconnect(); } catch (e) { /* gone */ } };
        });
        setTimeout(() => { try { g.disconnect(); } catch (e) { /* gone */ } }, (dur + 0.3) * 1000);
    }

    chime(vol = 0.25) {
        const v = this._gate('chime', vol, null, null);
        if (!v) return;
        const ctx = this.sounds.ctx;
        const steps = [0, 4, 7, 12, 16, 19, 24];
        for (let i = 0; i < steps.length; i++) {
            const t0 = ctx.currentTime + 0.01 + i * 0.045;
            const f = 784 * Math.pow(2, steps[i] / 12); // G5 arpeggio
            const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'square';
            o.frequency.value = f;
            const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 4800;
            const g = ctx.createGain(); this._env(g, t0, v * (i % 2 ? 0.5 : 0.22), 0.004, 0.22);
            o.connect(lp); lp.connect(g); g.connect(this._out());
            o.start(t0);
            this._cleanup([o, lp, g], t0 + 0.26);
        }
    }
}

// Pentatonic pitch multiplier for ladder step `n` (for playbackRate on
// recorded SFX — scrap/exp pickup chains).
export function ladderPitch(n, maxStep = 7) {
    return Math.pow(2, PENTA[Math.min(n, maxStep)] / 12);
}
