export const MUSIC_STATE = {
    EXPLORATION: 'exploration',
    COMBAT: 'combat',
    BOSS: 'boss',
    TITLE: 'title',
    GAMEOVER: 'gameover',
    NONE: 'none'
};

// Sound manager — uses Web Audio API for SFX (low latency) and Audio Element for Music (streaming)
export class SoundManager {
    constructor() {
        this.ctx = null;
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) this.ctx = new AudioContextClass();
        } catch (e) {
            console.error("Web Audio API not supported", e);
        }

        this.sfxBuffers = {};     // key -> Array of AudioBuffers

        // Music Management
        this.explorationTracks = []; // Audio elements
        this.combatTracks = [];      // Audio elements
        this.bossTracks = {};        // key -> Audio
        this.titleTrack = null;
        this.gameOverTrack = null;

        this.currentMusic = null;
        this.currentExplorationTrack = null;

        // Simple time-based transitions (no FFT/analyser)
        this.isTransitioning = false;
        this.transitionWaitTimer = 0;
        this.maxTransitionWait = 4.0;

        this.musicVolume = 0.5;
        this.sfxVolume = 0.5;
        this.musicBaseVolume = 0.4;
        this.unlocked = false;

        // Background music preloading (warms tracks one-by-one on the title
        // screen so there's no fetch delay when a track first plays).
        this._musicPreloadStarted = false;
        this._destroyed = false;

        // Hard lock — when true, NO music changes are allowed (setTargetState, playSpecific, restore, stop all blocked)
        this.musicLocked = false;

        // Multiplayer music sync. On the host, onSelectMusicTrack(mode, index) is
        // invoked whenever an exploration/combat track is chosen, so the choice
        // can be broadcast. On clients, remoteMusicControl suppresses local random
        // selection — they only play tracks the host sends via playSyncedTrack().
        this.onSelectMusicTrack = null;
        this.remoteMusicControl = false;

        if (this.ctx) {
            // Main music gain (user volume control) — no analyser node
            this.musicGain = this.ctx.createGain();
            this.musicGain.gain.value = this.musicVolume * this.musicBaseVolume;

            // Master corruption bus: ALL audio (music + SFX) funnels through
            // here, splitting into a dry path and a parallel distorted path
            // (waveshaper → darkening lowpass). Blending toward the wet path
            // makes everything sound progressively broken — driven by the kill
            // streak (and later, story dread). Dry=1/wet=0 at rest, so normal
            // play is bit-identical passthrough.
            this._fxBus = this.ctx.createGain();
            this._busDry = this.ctx.createGain();
            this._busDry.gain.value = 1;
            this._busWet = this.ctx.createGain();
            this._busWet.gain.value = 0;
            this._busShaper = this.ctx.createWaveShaper();
            const curve = new Float32Array(1024);
            const drive = 8;
            for (let i = 0; i < 1024; i++) {
                const x = (i / 511.5) - 1;
                curve[i] = (1 + drive) * x / (1 + drive * Math.abs(x));
            }
            this._busShaper.curve = curve;
            this._busShaper.oversample = '2x';
            this._busFilter = this.ctx.createBiquadFilter();
            this._busFilter.type = 'lowpass';
            this._busFilter.frequency.value = 4500;
            this._corruption = 0;

            // Stage 2 — dread warble: a copy of the signal through a slowly
            // LFO-wobbled delay line, mixed quietly under the dry path. Reads
            // as a queasy tape-warble/chorus: subtle and wrong, completely
            // unlike the streak's clipping. Passthrough at rest.
            this._stage2 = this.ctx.createGain();
            this._warbleDry = this.ctx.createGain();
            this._warbleDry.gain.value = 1;
            this._warbleWet = this.ctx.createGain();
            this._warbleWet.gain.value = 0;
            this._warbleDelay = this.ctx.createDelay(0.1);
            this._warbleDelay.delayTime.value = 0.028;
            this._warbleLfo = this.ctx.createOscillator();
            this._warbleLfo.type = 'sine';
            this._warbleLfo.frequency.value = 0.31;
            this._warbleLfoGain = this.ctx.createGain();
            this._warbleLfoGain.gain.value = 0.011; // ±11ms — an unmistakable seasick bend
            this._warbleLfo.connect(this._warbleLfoGain);
            this._warbleLfoGain.connect(this._warbleDelay.delayTime);
            this._warbleLfo.start();
            this._warbleAmt = 0;

            // Horror-proximity duck: music (only) fades as the player nears a
            // dormant horror — the soundtrack going quiet before anything has
            // actually happened. SFX stay full.
            this._duckGain = this.ctx.createGain();
            this._duckGain.gain.value = 1;
            this._duckAmt = 0;

            this.musicGain.connect(this._duckGain);
            this._duckGain.connect(this._fxBus);
            this._fxBus.connect(this._busDry);
            this._busDry.connect(this._stage2);
            this._fxBus.connect(this._busShaper);
            this._busShaper.connect(this._busFilter);
            this._busFilter.connect(this._busWet);
            this._busWet.connect(this._stage2);
            this._stage2.connect(this._warbleDry);
            this._warbleDry.connect(this.ctx.destination);
            this._stage2.connect(this._warbleDelay);
            this._warbleDelay.connect(this._warbleWet);
            this._warbleWet.connect(this.ctx.destination);
        }

        // Spatial Audio Properties
        this.listenerX = 0;
        this.listenerY = 0;
        // Local co-op: multiple listeners (one per pilot) sharing one output. A
        // positional sound uses the NEAREST listener's distance, so it's audible
        // around any pilot and still plays only once. null = single-listener.
        this.listeners = null;
    }

    setListenerPosition(x, y) {
        this.listenerX = x;
        this.listenerY = y;
        this.listeners = null;
    }

    // positions: array of {x, y} (live pilots). Pass null/empty to revert to the
    // single listener set via setListenerPosition.
    setListeners(positions) {
        this.listeners = (positions && positions.length) ? positions : null;
        if (this.listeners) { this.listenerX = positions[0].x; this.listenerY = positions[0].y; }
    }

    // Distance from a world point to the nearest active listener.
    _listenerDist(x, y) {
        if (this.listeners) {
            let best = Infinity;
            for (const L of this.listeners) {
                const dx = x - L.x, dy = y - L.y;
                const d = dx * dx + dy * dy;
                if (d < best) best = d;
            }
            return Math.sqrt(best);
        }
        const dx = x - this.listenerX, dy = y - this.listenerY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    // Register sounds - we'll fetch them as buffers
    async register(key, paths) {
        if (!this.ctx) return;

        const buffers = await Promise.all(paths.map(async (path) => {
            try {
                const response = await fetch(path);
                const arrayBuffer = await response.arrayBuffer();
                return await this.ctx.decodeAudioData(arrayBuffer);
            } catch (e) {
                console.error(`Failed to load sound: ${path}`, e);
                return null;
            }
        }));

        this.sfxBuffers[key] = buffers.filter(b => b !== null);
    }

    // Register exploration music
    registerExplorationMusic(paths) {
        this.explorationTracks = paths.map(p => this._createMusicElement(p));
    }

    // Register combat music
    registerCombatMusic(paths) {
        this.combatTracks = paths.map(p => this._createMusicElement(p));
    }

    _createMusicElement(path, preload = 'none') {
        // Lazy by default: with preload 'none' the browser doesn't fetch the
        // file until the track is first played, so only the title song and
        // SFX load at startup. Set preload BEFORE src so no eager fetch starts.
        // Pass 'auto' for tracks that must be ready immediately (title music).
        const audio = new Audio();
        audio.preload = preload;
        audio.loop = false;
        audio.crossOrigin = "anonymous";
        audio.src = path;

        let trackGain = null;
        if (this.ctx) {
            trackGain = this.ctx.createGain();
            trackGain.gain.value = 0; // Start silent for fade-ins

            const source = this.ctx.createMediaElementSource(audio);
            source.connect(trackGain);
            trackGain.connect(this.musicGain);
        }

        // Attach gain node to audio element for control
        audio.trackGain = trackGain;
        return audio;
    }

    // Simple time-based transition: wait for the cutoff, then switch
    update(dt) {
        if (this.musicLocked) {
            this.isTransitioning = false;
            return;
        }
        if (this.isTransitioning) {
            this.transitionWaitTimer += dt;
            if (this.transitionWaitTimer >= this.maxTransitionWait) {
                this._executeTransition();
            }
        }
    }

    setTargetState(state, force = false) {
        if (this.musicLocked) return;
        if (this.targetMusicState === state) return;

        // Protection: Don't allow normal transitions to override BOSS state unless forced
        if (!force && this.musicState === MUSIC_STATE.BOSS) {
            if (state === MUSIC_STATE.EXPLORATION || state === MUSIC_STATE.COMBAT) {
                return;
            }
        }

        // Calculate transition cutoff window
        let cutoff = 4.0; // Default

        if (state === MUSIC_STATE.BOSS || state === MUSIC_STATE.GAMEOVER) {
            cutoff = 2.0;
        } else if (state === MUSIC_STATE.TITLE || state === MUSIC_STATE.NONE) {
            cutoff = 0.0;
        } else if (this.musicState === MUSIC_STATE.TITLE || this.musicState === MUSIC_STATE.NONE) {
            // Instant transition when starting from non-game states
            cutoff = 0.0;
        } else if (this.musicState === MUSIC_STATE.EXPLORATION && state === MUSIC_STATE.COMBAT) {
            cutoff = 5.0;
        } else if (this.musicState === MUSIC_STATE.COMBAT && state === MUSIC_STATE.EXPLORATION) {
            cutoff = 3.0;
        }

        this.targetMusicState = state;
        this.maxTransitionWait = cutoff;
        this.transitionWaitTimer = 0;

        // If instant, execute now
        if (cutoff === 0) {
            this._executeTransition();
        } else {
            this.isTransitioning = true;
        }
    }

    _executeTransition() {
        this.isTransitioning = false;
        if (this.musicLocked) return;
        const oldState = this.musicState;
        this.musicState = this.targetMusicState;

        if (oldState === this.musicState && this.currentMusic) return;

        // Logic for specific target states
        switch (this.musicState) {
            case MUSIC_STATE.EXPLORATION:
                this._playExploration(oldState);
                break;
            case MUSIC_STATE.COMBAT:
                this._playCombat(oldState);
                break;
            case MUSIC_STATE.BOSS:
                // Handled via playSpecificMusic, but we centralize here if needed
                break;
            case MUSIC_STATE.TITLE:
                this._playTitle(oldState);
                break;
            case MUSIC_STATE.GAMEOVER:
                this._playGameOver(oldState);
                break;
            case MUSIC_STATE.NONE:
                this.stopMusic();
                break;
        }
    }

    _playExploration(oldState = null, forceNew = false) {
        if (!forceNew && this.currentMusic && this.explorationTracks.includes(this.currentMusic) && this.musicState === MUSIC_STATE.EXPLORATION) return;

        // Multiplayer clients never pick their own track — the host broadcasts
        // the choice (and playhead) and playSyncedTrack() drives the switch.
        if (this.remoteMusicControl) return;

        const isStartup = !this.currentMusic ||
            this.currentMusic === this.titleTrack ||
            this.currentMusic === this.gameOverTrack ||
            oldState === MUSIC_STATE.TITLE ||
            oldState === MUSIC_STATE.GAMEOVER;

        if (isStartup) {
            if (this.currentExplorationTrack) {
                this.currentExplorationTrack.currentTime = 0;
            }
            this.currentExplorationTrack = null;
        }

        let track = this.currentExplorationTrack;
        if (!track || track.ended || forceNew) {
            const candidates = this.explorationTracks.filter(t => t !== track);
            const pool = candidates.length > 0 ? candidates : this.explorationTracks;
            track = pool[Math.floor(Math.random() * pool.length)];
            track.currentTime = 0;
        }

        this._switchTrack(track, oldState);
        this.currentExplorationTrack = track;

        track.onended = () => {
            this._playExploration(this.musicState, true);
        };

        this._notifyTrackSelected('exploration', this.explorationTracks.indexOf(track));
    }

    _playCombat(oldState = null, forceNew = false) {
        // Clients defer to the host's broadcast track (see _playExploration).
        if (this.remoteMusicControl) return;

        const current = this.currentMusic;
        const candidates = this.combatTracks.filter(t => t !== current);
        const pool = candidates.length > 0 ? candidates : this.combatTracks;

        const track = pool[Math.floor(Math.random() * pool.length)];
        if (track) {
            track.currentTime = 0;
            track.onended = () => {
                this._playCombat(this.musicState, true);
            };
        }

        this._switchTrack(track, oldState);
        this._notifyTrackSelected('combat', this.combatTracks.indexOf(track));
    }

    // Host: report the freshly chosen exploration/combat track so it can be
    // mirrored to every client. No-op in single-player (no callback set).
    _notifyTrackSelected(mode, index) {
        if (this.onSelectMusicTrack && index >= 0) this.onSelectMusicTrack(mode, index);
    }

    // Client: play an exact exploration/combat track (by registration index)
    // at the host's playhead, so all players hear the same song in lockstep.
    playSyncedTrack(mode, index, pos = 0) {
        if (this.musicLocked) return;
        const pool = mode === 'combat' ? this.combatTracks : this.explorationTracks;
        const track = pool[index];
        if (!track) return;

        const oldState = this.musicState;
        const targetState = mode === 'combat' ? MUSIC_STATE.COMBAT : MUSIC_STATE.EXPLORATION;
        this.musicState = targetState;
        this.targetMusicState = targetState;
        this.isTransitioning = false;
        if (mode === 'exploration') this.currentExplorationTrack = track;

        // Already the active song — leave it playing rather than restarting it.
        if (track === this.currentMusic) return;

        try { track.currentTime = pos || 0; } catch (e) { /* not seekable yet */ }
        this._switchTrack(track, oldState);
        // The host cues the next track on its end; clients never self-advance.
        track.onended = null;
    }

    _playTitle(oldState = null) {
        this._switchTrack(this.titleTrack, oldState);
        if (this.currentMusic) this.currentMusic.loop = true;
    }

    _playGameOver(oldState = null) {
        this._switchTrack(this.gameOverTrack, oldState);
        if (this.currentMusic) this.currentMusic.loop = true;
    }

    _switchTrack(nextTrack, oldState = null) {
        if (!nextTrack) return;
        if (this.musicLocked) return;

        const isExitingCombat = oldState === MUSIC_STATE.COMBAT && this.musicState === MUSIC_STATE.EXPLORATION;
        const isStartup = !oldState || oldState === MUSIC_STATE.TITLE || oldState === MUSIC_STATE.GAMEOVER || oldState === MUSIC_STATE.NONE;

        // Instant for startup, slow 4s for combat exit, 1s for other in-game transitions
        const fadeTime = isStartup ? 0.2 : (isExitingCombat ? 4.0 : 0.5);
        const now = this.ctx ? this.ctx.currentTime : 0;

        // 1. FADE OUT current track
        if (this.currentMusic && this.currentMusic !== nextTrack) {
            const oldTrack = this.currentMusic;
            if (oldTrack.trackGain && this.ctx) {
                oldTrack.trackGain.gain.cancelScheduledValues(now);
                oldTrack.trackGain.gain.setValueAtTime(oldTrack.trackGain.gain.value, now);
                oldTrack.trackGain.gain.linearRampToValueAtTime(0, now + fadeTime);

                setTimeout(() => {
                    if (oldTrack !== this.currentMusic) {
                        oldTrack.pause();
                        oldTrack.onended = null;
                    }
                }, fadeTime * 1000);
            } else {
                oldTrack.pause();
            }
        }

        // 2. FADE IN next track SIMULTANEOUSLY
        this.currentMusic = nextTrack;
        if (this.currentMusic.trackGain && this.ctx) {
            this.currentMusic.trackGain.gain.cancelScheduledValues(now);
            this.currentMusic.trackGain.gain.setValueAtTime(0, now);
            this.currentMusic.trackGain.gain.linearRampToValueAtTime(1, now + fadeTime);
        }

        // Always start playing immediately for overlapping crossfade
        this.currentMusic.play().catch(() => { });
    }

    // LEGACY METHODS (to keep compatibility while refactoring)
    registerMusic(paths) {
        this.registerExplorationMusic(paths);
    }

    startMusic(volume = null) {
        this.musicLocked = false; // New game — always unlock
        if (volume !== null) this.setMusicVolume(volume);
        this.setTargetState(MUSIC_STATE.EXPLORATION);
    }

    registerBossMusic(key, path) {
        this.bossTracks[key] = this._createMusicElement(path);
        this.bossTracks[key].loop = true;
    }

    registerTitleMusic(path) {
        // Eager: the title song plays on the menu, so it loads at startup.
        this.titleTrack = this._createMusicElement(path, 'auto');
    }

    registerGameOverMusic(path) {
        this.gameOverTrack = this._createMusicElement(path);
    }

    // Warm every (lazy) music track in the background, one at a time. Called
    // from the title screen, where the player typically spends several seconds
    // making selections — more than enough time to buffer the tracks so the
    // first play of exploration/combat/boss/game-over music has no delay.
    // Sequential (not parallel) to avoid the bandwidth contention that the old
    // all-at-once eager preload caused. Safe to call repeatedly (no-op after
    // the first call); the title song is excluded since it loads eagerly.
    async preloadAllMusic() {
        if (this._musicPreloadStarted) return;
        this._musicPreloadStarted = true;

        const tracks = [
            ...this.explorationTracks,
            ...this.combatTracks,
            ...Object.values(this.bossTracks),
            this.gameOverTrack,
        ].filter(Boolean);

        for (const track of tracks) {
            if (this._destroyed) return;
            await this._preloadTrack(track);
        }
    }

    // Buffer a single track to the point it can play through, then resolve.
    // Resolves early on error or after a timeout so one slow/failed track can't
    // stall the rest of the queue.
    _preloadTrack(audio) {
        return new Promise((resolve) => {
            if (audio.readyState >= 4) { resolve(); return; } // HAVE_ENOUGH_DATA

            let timer = null;
            const finish = () => {
                if (timer === null) return;
                clearTimeout(timer);
                timer = null;
                audio.removeEventListener('canplaythrough', finish);
                audio.removeEventListener('error', finish);
                resolve();
            };

            audio.addEventListener('canplaythrough', finish);
            audio.addEventListener('error', finish);
            timer = setTimeout(finish, 20000);

            // Switching preload from 'none' to 'auto' starts buffering the
            // already-assigned src (no .load() — that would fetch twice).
            audio.preload = 'auto';
        });
    }

    playGameOverMusic() {
        this.setTargetState(MUSIC_STATE.GAMEOVER, true);
    }

    stopMusic() {
        if (this.musicLocked) return;
        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
            this.currentMusic = null;
        }
        this.musicState = MUSIC_STATE.NONE;
        this.targetMusicState = MUSIC_STATE.NONE;
    }

    playTitleMusic() {
        this.musicLocked = false;
        this.setTargetState(MUSIC_STATE.TITLE, true);
    }

    playSpecificMusic(key) {
        this.musicLocked = false; // Boss music always overrides
        if (this.bossTracks && this.bossTracks[key]) {
            // Cancel any pending transition so it can't override this track
            this.isTransitioning = false;
            const oldState = this.musicState;
            this.musicState = MUSIC_STATE.BOSS;
            this.targetMusicState = MUSIC_STATE.BOSS;
            this._switchTrack(this.bossTracks[key], oldState);
        }
    }

    playMusicByLabel(key) {
        this.musicLocked = false;
        this.playSpecificMusic(key);
    }

    restoreMusic() {
        this.setTargetState(MUSIC_STATE.EXPLORATION, true);
    }

    setMusicVolume(v) {
        this.musicVolume = Math.min(1.0, Math.max(0.0, v));
        if (this.musicGain) {
            this.musicGain.gain.value = this.musicVolume * this.musicBaseVolume;
        }
    }

    setSfxVolume(v) {
        this.sfxVolume = Math.min(1.0, Math.max(0.0, v));
    }

    unlock() {
        if (this.unlocked) return;
        this.unlocked = true;

        if (this.ctx && this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        if (this.currentMusic && this.currentMusic.paused) {
            this.currentMusic.play().catch(() => { });
        }
    }

    // Blend ALL audio (music + SFX share the master bus) toward the distorted
    // path. 0 = clean passthrough, 1 = heavily corrupted (clipped + darkened +
    // static). Smoothed at the param level, and callers can fire this every
    // frame — tiny deltas are ignored.
    //
    // Loudness-compensated: a soft-clipper massively raises RMS, so the wet
    // gain is kept low and the dry path only ducks by what the wet path adds —
    // the track should *degrade*, not swell. The blend curve is squared so the
    // early tiers are barely-there.
    setAudioCorruption(amount) {
        if (!this.ctx || !this._busDry) return;
        const a = Math.min(1, Math.max(0, amount));
        if (Math.abs(a - this._corruption) < 0.01) return;
        this._corruption = a;
        const t = this.ctx.currentTime;
        const blend = a * a; // gentle entry, committed by the top tiers
        this._busDry.gain.setTargetAtTime(1 - 0.62 * blend, t, 0.1);
        this._busWet.gain.setTargetAtTime(0.34 * blend, t, 0.1);
        this._busFilter.frequency.setTargetAtTime(4500 - 2900 * blend, t, 0.1);

        // Static crackle for the final phase only (fades in past ~0.75)
        const staticAmt = a > 0.75 ? (a - 0.75) / 0.25 : 0;
        if (staticAmt > 0 && !this._staticSource) this._initStatic();
        if (this._staticGain) {
            this._staticGain.gain.setTargetAtTime(staticAmt * 0.045, t, 0.15);
        }
    }

    // Looping white-noise bed for the corruption static. Created on first use
    // and left running at gain 0 afterward (a silent source is ~free).
    _initStatic() {
        if (!this.ctx || this._staticSource) return;
        const sr = this.ctx.sampleRate;
        const buf = this.ctx.createBuffer(1, sr, sr); // 1s loop
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 3200;
        const g = this.ctx.createGain();
        g.gain.value = 0;
        // Routed into the music bus pre-split, so it respects the music volume
        // setting and picks up the same corruption shaping.
        src.connect(lp);
        lp.connect(g);
        g.connect(this.musicGain);
        src.start();
        this._staticSource = src;
        this._staticGain = g;
    }

    // Dread warble: mixes a pitch-wobbled copy under the dry signal during
    // dread moments. 0 = passthrough. Kept gentle — at full it's still mostly
    // dry, just... wrong.
    setDreadWarble(amount) {
        if (!this.ctx || !this._warbleDry) return;
        const a = Math.min(1, Math.max(0, amount));
        if (Math.abs(a - this._warbleAmt) < 0.01) return;
        this._warbleAmt = a;
        const t = this.ctx.currentTime;
        this._warbleDry.gain.setTargetAtTime(1 - 0.45 * a, t, 0.08);
        this._warbleWet.gain.setTargetAtTime(0.55 * a, t, 0.08);
    }

    // Duck the music toward silence (0 = full volume, 1 = nearly gone).
    // Slow time constant — the quiet should creep in, not snap.
    setMusicDuck(amount) {
        if (!this.ctx || !this._duckGain) return;
        const a = Math.min(1, Math.max(0, amount));
        if (Math.abs(a - this._duckAmt) < 0.01) return;
        this._duckAmt = a;
        this._duckGain.gain.setTargetAtTime(1 - a, this.ctx.currentTime, 0.5);
    }

    // Casino jackpot jingle for rare+ pickups: a rising bell arpeggio, one
    // extra note per rarity tier (3/4/5 notes).
    playJackpot(tier = 0) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const vol = Math.min(1, Math.max(0, 0.5 * this.sfxVolume));
        if (vol <= 0) return;
        const t0 = this.ctx.currentTime + 0.01;
        const master = this.ctx.createGain();
        master.gain.value = vol * 0.4;
        master.connect(this._fxBus || this.ctx.destination);
        const NOTES = [523.25, 659.25, 783.99, 1046.5, 1318.5]; // C5 E5 G5 C6 E6
        const count = 3 + tier;
        for (let i = 0; i < count; i++) {
            const start = t0 + i * 0.085;
            const f = NOTES[i];
            // Bell-ish: sine fundamental + quiet triangle an octave up
            for (const [type, mult, g0] of [['sine', 1, 1], ['triangle', 2, 0.25]]) {
                const osc = this.ctx.createOscillator();
                osc.type = type;
                osc.frequency.value = f * mult;
                const g = this.ctx.createGain();
                g.gain.setValueAtTime(0, start);
                g.gain.linearRampToValueAtTime(g0, start + 0.008);
                g.gain.exponentialRampToValueAtTime(0.001, start + 0.24);
                osc.connect(g);
                g.connect(master);
                osc.start(start);
                osc.stop(start + 0.26);
            }
        }
    }

    // Short radio-static crackle for comms transmissions opening.
    playCommsStatic() {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const vol = Math.min(1, Math.max(0, 0.5 * this.sfxVolume));
        if (vol <= 0) return;
        const sr = this.ctx.sampleRate;
        const t0 = this.ctx.currentTime + 0.01;
        const buf = this.ctx.createBuffer(1, Math.floor(sr * 0.3), sr);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = this.ctx.createBufferSource();
        src.buffer = buf;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1900;
        bp.Q.value = 0.8;
        const g = this.ctx.createGain();
        g.gain.setValueAtTime(vol * 0.14, t0);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.28);
        src.connect(bp);
        bp.connect(g);
        g.connect(this._fxBus || this.ctx.destination);
        src.start(t0);
        src.stop(t0 + 0.3);
    }

    // Rare, quiet ambient stings for the dread system. Three flavors, picked
    // at random: a sub-bass swell with beat-frequency unease, a filtered-noise
    // breath, or a dissonant tone cluster. All deliberately faint — the player
    // should half-notice them.
    playDreadSting(level = 1) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const vol = Math.min(1, Math.max(0, this.sfxVolume * (0.7 + 0.1 * level)));
        if (vol <= 0) return;
        const t0 = this.ctx.currentTime + 0.05;
        const out = this.ctx.createGain();
        out.gain.value = vol;
        out.connect(this._fxBus || this.ctx.destination);
        const variant = Math.floor(Math.random() * 3);

        if (variant === 0) {
            // Sub swell — two sines a hair apart so they beat against each other
            for (const f of [52, 52.8]) {
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(f, t0);
                osc.frequency.linearRampToValueAtTime(f * 0.82, t0 + 3.0);
                const g = this.ctx.createGain();
                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(0.10, t0 + 1.2);
                g.gain.linearRampToValueAtTime(0, t0 + 3.0);
                osc.connect(g); g.connect(out);
                osc.start(t0); osc.stop(t0 + 3.1);
            }
        } else if (variant === 1) {
            // Breath — bandpassed noise sweeping downward
            const sr = this.ctx.sampleRate;
            const buf = this.ctx.createBuffer(1, sr * 2, sr);
            const data = buf.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
            const src = this.ctx.createBufferSource();
            src.buffer = buf;
            const bp = this.ctx.createBiquadFilter();
            bp.type = 'bandpass';
            bp.Q.value = 2.5;
            bp.frequency.setValueAtTime(1400, t0);
            bp.frequency.exponentialRampToValueAtTime(450, t0 + 2.0);
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(0.05, t0 + 0.7);
            g.gain.linearRampToValueAtTime(0, t0 + 2.0);
            src.connect(bp); bp.connect(g); g.connect(out);
            src.start(t0); src.stop(t0 + 2.1);
        } else {
            // Dissonant cluster — minor-second rubs, drifting apart
            for (const f of [220, 233.1, 277.2]) {
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(f, t0);
                osc.detune.linearRampToValueAtTime((Math.random() - 0.5) * 40, t0 + 2.5);
                const g = this.ctx.createGain();
                g.gain.setValueAtTime(0, t0);
                g.gain.linearRampToValueAtTime(0.03, t0 + 0.9);
                g.gain.linearRampToValueAtTime(0, t0 + 2.5);
                osc.connect(g); g.connect(out);
                osc.start(t0); osc.stop(t0 + 2.6);
            }
        }
    }

    // Short arcade stinger when the kill streak crosses into a new tier.
    // Pitch climbs with the tier; the final (horror) tier gets a low,
    // descending groan instead of a chime.
    playStreakTier(tierIdx, horror = false) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const vol = Math.min(1, Math.max(0, 0.5 * this.sfxVolume));
        if (vol <= 0) return;
        const t0 = this.ctx.currentTime + 0.01;
        const master = this.ctx.createGain();
        master.gain.value = vol * (horror ? 0.5 : 0.35);
        master.connect(this._fxBus || this.ctx.destination);

        if (horror) {
            const osc = this.ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(130, t0);
            osc.frequency.exponentialRampToValueAtTime(48, t0 + 0.42);
            const lp = this.ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = 900;
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, t0);
            g.gain.linearRampToValueAtTime(1, t0 + 0.03);
            g.gain.setValueAtTime(1, t0 + 0.25);
            g.gain.linearRampToValueAtTime(0, t0 + 0.45);
            osc.connect(lp); lp.connect(g); g.connect(master);
            osc.start(t0); osc.stop(t0 + 0.5);
            return;
        }

        // Two-note rising chime, a semitone-ish step higher per tier
        const base = 392 * Math.pow(2, tierIdx * 0.17);
        const notes = [base, base * 1.335];
        for (let i = 0; i < notes.length; i++) {
            const start = t0 + i * 0.07;
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.value = notes[i];
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(1, start + 0.01);
            g.gain.exponentialRampToValueAtTime(0.001, start + 0.16);
            osc.connect(g); g.connect(master);
            osc.start(start); osc.stop(start + 0.18);
        }
    }

    // Two-tone arcade alarm for the boss warning telegraph, synthesized with
    // WebAudio (square wave through a lowpass). Placeholder until a recorded
    // klaxon SFX asset exists — swap this for `play('klaxon')` when it does.
    playKlaxon(volume = 0.5) {
        if (!this.ctx) return;
        if (this.ctx.state === 'suspended') this.ctx.resume();
        const vol = Math.min(1.0, Math.max(0.0, volume * this.sfxVolume));
        if (vol <= 0) return;

        const t0 = this.ctx.currentTime + 0.02;
        const lp = this.ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        const master = this.ctx.createGain();
        master.gain.value = vol * 0.16;
        lp.connect(master);
        master.connect(this._fxBus || this.ctx.destination);

        // Three soft two-tone pulses, each quieter than the last.
        for (let i = 0; i < 3; i++) {
            const start = t0 + i * 0.5;
            const peak = 1.0 - i * 0.2;
            const osc = this.ctx.createOscillator();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(370, start);        // F#4
            osc.frequency.setValueAtTime(247, start + 0.18); // B3
            const g = this.ctx.createGain();
            g.gain.setValueAtTime(0, start);
            g.gain.linearRampToValueAtTime(peak, start + 0.02);
            g.gain.setValueAtTime(peak, start + 0.28);
            g.gain.linearRampToValueAtTime(0, start + 0.38);
            osc.connect(g);
            g.connect(lp);
            osc.start(start);
            osc.stop(start + 0.4);
        }
    }

    play(key, options = 0.5) {
        if (!this.ctx) return;

        let volume = 0.5;
        let x = null, y = null;
        let minPassDist = 1200, maxDist = 2500;

        if (typeof options === 'number') {
            volume = options * this.sfxVolume;
        } else if (typeof options === 'object') {
            volume = (options.volume !== undefined ? options.volume : 0.5) * this.sfxVolume;
            x = options.x; y = options.y;
            if (options.minDistance !== undefined) minPassDist = options.minDistance;
            if (options.maxDistance !== undefined) maxDist = options.maxDistance;
        } else {
            volume = 0.5 * this.sfxVolume;
        }

        if (x !== null && y !== null) {
            const dist = this._listenerDist(x, y); // nearest pilot in co-op
            if (dist >= maxDist) return;
            if (dist > minPassDist) {
                const attenuation = 1.0 - ((dist - minPassDist) / (maxDist - minPassDist));
                volume *= attenuation;
            }
        }

        if (this.ctx.state === 'suspended') this.ctx.resume();

        const buffers = this.sfxBuffers[key];
        if (!buffers || buffers.length === 0) return;

        const buffer = buffers[Math.floor(Math.random() * buffers.length)];
        const source = this.ctx.createBufferSource();
        source.buffer = buffer;
        if (typeof options === 'object' && options.pitch) {
            source.playbackRate.value = options.pitch;
        }

        const gainNode = this.ctx.createGain();
        gainNode.gain.value = Math.min(1.0, Math.max(0.0, volume));

        source.connect(gainNode);
        gainNode.connect(this._fxBus || this.ctx.destination);

        // Disconnect nodes after playback to prevent audio graph leak
        source.onended = () => {
            source.disconnect();
            gainNode.disconnect();
        };

        source.start(0);
    }

    destroy() {
        this._destroyed = true;
        this.stopMusic();
        if (this.ctx) {
            this.ctx.close().catch(err => console.error('Failed to close AudioContext:', err));
            this.ctx = null;
        }

        this.sfxBuffers = {};

        // Clear references
        this.explorationTracks.forEach(t => { t.pause(); t.src = ""; });
        this.combatTracks.forEach(t => { t.pause(); t.src = ""; });
        Object.values(this.bossTracks).forEach(t => { t.pause(); t.src = ""; });
        if (this.titleTrack) { this.titleTrack.pause(); this.titleTrack.src = ""; }
        if (this.gameOverTrack) { this.gameOverTrack.pause(); this.gameOverTrack.src = ""; }
    }
}
