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

        this.isTransitioning = false;
        this.transitionWaitTimer = 0;
        this.maxTransitionWait = 4.0; // Force transition after 4 seconds
        this.breakDuration = 0; // Tracks sustained silence
        this.requiredBreakDuration = 0.2; // 0.2s of sustained silence

        // Advanced Analysis State
        this.maxHistory = 120; // ~2 seconds at 60fps
        this.energyHistory = {
            all: [],
            bass: [],
            mids: [],
            highs: []
        };
        this.prevSpectrum = null; // For spectral flux
        this.fluxHistory = [];

        this.musicVolume = 0.5;
        this.sfxVolume = 0.5;
        this.musicBaseVolume = 0.4;
        this.unlocked = false;

        // Analysis
        this.analyser = null;
        if (this.ctx) {
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 1024; // 512 frequency bins (~43Hz resolution)
            this.analyser.smoothingTimeConstant = 0.5;
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

            // Main music gain (user volume control)
            this.musicGain = this.ctx.createGain();
            this.musicGain.gain.value = this.musicVolume * this.musicBaseVolume;
            this.musicGain.connect(this.ctx.destination);
        }

        // Spatial Audio Properties
        this.listenerX = 0;
        this.listenerY = 0;
    }

    setListenerPosition(x, y) {
        this.listenerX = x;
        this.listenerY = y;
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

    _createMusicElement(path) {
        const audio = new Audio(path);
        audio.preload = 'auto';
        audio.loop = false;
        audio.crossOrigin = "anonymous";

        let trackGain = null;
        if (this.ctx) {
            trackGain = this.ctx.createGain();
            trackGain.gain.value = 0; // Start silent for fade-ins

            const source = this.ctx.createMediaElementSource(audio);
            source.connect(trackGain);
            // SIDE-CHAIN: Connect source directly to analyser 
            // This ensures transitions/fades don't pollute the detection data
            source.connect(this.analyser);
            trackGain.connect(this.musicGain);
        }

        // Attach gain node to audio element for control
        audio.trackGain = trackGain;
        return audio;
    }

    // Handle state transitions
    update(dt) {
        if (this.isTransitioning) {
            this.transitionWaitTimer += dt;

            // Calculate progress (0 to 1) and leniency factor (1.0 to 2.0)
            // As we approach maxTransitionWait, we become more lenient with thresholds
            const progress = this.maxTransitionWait > 0 ? Math.min(1.0, this.transitionWaitTimer / this.maxTransitionWait) : 1.0;
            const leniency = 1.0 + progress;

            // Enhanced break detection: looking for SUSTAINED low energy
            if (this._detectLowEnergy(leniency)) {
                this.breakDuration += dt;
            } else {
                this.breakDuration = 0;
            }

            const breakFound = this.breakDuration >= this.requiredBreakDuration;
            const timeoutReached = this.transitionWaitTimer >= this.maxTransitionWait;

            if (breakFound || timeoutReached) {
                console.log(`[SoundManager] Transition Triggered: timer=${this.transitionWaitTimer.toFixed(2)}, breakFound=${breakFound}, timeoutReached=${timeoutReached}`);
                this._executeTransition();
            }
        }
    }

    _detectLowEnergy(leniency = 1.0) {
        if (!this.analyser || !this.currentMusic || this.currentMusic.paused) return true;

        this.analyser.getByteFrequencyData(this.dataArray);
        const binCount = this.dataArray.length;

        // 1. ADVANCED SPECTRAL ANALYSIS
        let eAll = 0, eBass = 0, eMids = 0, eHighs = 0;
        let flux = 0;

        for (let i = 0; i < binCount; i++) {
            const amp = this.dataArray[i];
            const ampSq = amp * amp;
            eAll += ampSq;

            if (i <= 6) eBass += ampSq; // ~250Hz
            else if (i <= 70) eMids += ampSq; // ~3kHz
            else eHighs += ampSq;

            if (this.prevSpectrum) {
                const diff = amp - this.prevSpectrum[i];
                if (diff > 0) flux += diff;
            }
        }

        if (!this.prevSpectrum) this.prevSpectrum = new Uint8Array(binCount);
        this.prevSpectrum.set(this.dataArray);

        const rms = Math.sqrt(eAll / binCount);

        // Update History
        const pushHistory = (arr, val) => {
            arr.push(val);
            if (arr.length > this.maxHistory) arr.shift();
        };
        pushHistory(this.energyHistory.all, rms);
        pushHistory(this.energyHistory.bass, Math.sqrt(eBass / 7));
        pushHistory(this.energyHistory.highs, Math.sqrt(eHighs / (binCount - 71)));
        pushHistory(this.fluxHistory, flux);

        // 2. MUSICAL BREAK DETECTION (HEURISTICS)
        // We look for "energy stability" - a period where the song has settled into a quiet tail.
        const getStats = (arr) => {
            if (arr.length < 20) return { avg: 1000, var: 1000 };
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            const variance = Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / arr.length);
            return { avg, variance };
        };

        const statsAll = getStats(this.energyHistory.all);
        const statsBass = getStats(this.energyHistory.bass);
        const statsFlux = getStats(this.fluxHistory);

        // A. Sustained Low Energy: Current volume is significantly below the 2-second average
        // Leniency increases the threshold (makes it easier to be considered "quiet")
        const isSustainedQuiet = rms < (statsAll.avg * 0.7 * leniency) && rms < (45 * leniency);

        // B. Rhythm Break: Flux (beats) is low and stable (low variance)
        const isRhythmBreak = flux < (statsFlux.avg * 0.8 * leniency) && statsFlux.variance < (statsFlux.avg * 0.5 * leniency);

        // C. Bass Drop: Often the best indicator of a phrase end in electronic/game music
        const isBassDrop = Math.sqrt(eBass / 7) < (statsBass.avg * 0.5 * leniency) && statsBass.avg < (80 * leniency);

        // D. Onset Masking: Never transition if we just hit a peak
        // Leniency increases the onset threshold (makes it harder to be "masked"/blocked)
        const isOnset = flux > (statsFlux.avg * 1.5 * leniency);

        // FINAL VERDICT: Trigger if we have a sustained quiet period OR a clear rhythm/bass break,
        // provided we aren't currently hitting a new note/beat.
        const signal = isSustainedQuiet || (isRhythmBreak && isBassDrop);

        return signal && !isOnset;
    }

    _findBreak() {
        // Redundant with new update logic, but kept for internal clarity
        return this.breakDuration >= this.requiredBreakDuration;
    }

    setTargetState(state) {
        if (this.targetMusicState === state) return;

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
        // Only return early if we're not forcing a new track and we're already playing an exploration track
        if (!forceNew && this.currentMusic && this.explorationTracks.includes(this.currentMusic) && this.musicState === MUSIC_STATE.EXPLORATION) return;

        // Reset tracking if we're coming from a non-gameplay state (Restart/Title)
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

        // Transition handling will now be managed entirely by _switchTrack
        // which performs the fade-out of the old track and fade-in of the new one.

        // Resume or start new exploration track
        let track = this.currentExplorationTrack;
        if (!track || track.ended || forceNew) {
            // Filter out current track to avoid immediate repetition if possible
            const candidates = this.explorationTracks.filter(t => t !== track);
            const pool = candidates.length > 0 ? candidates : this.explorationTracks;
            track = pool[Math.floor(Math.random() * pool.length)];
            track.currentTime = 0;
        }

        this._switchTrack(track, oldState);
        this.currentExplorationTrack = track;

        // Chain next track when this one ends
        track.onended = () => {
            console.log(`[SoundManager] Exploration track ended, chaining next...`);
            this._playExploration(this.musicState, true);
        };
    }

    _playCombat(oldState = null, forceNew = false) {
        // Combat always starts a fresh track, but if we're chaining we want a DIFFERENT one
        const current = this.currentMusic;
        const candidates = this.combatTracks.filter(t => t !== current);
        const pool = candidates.length > 0 ? candidates : this.combatTracks;

        const track = pool[Math.floor(Math.random() * pool.length)];
        if (track) {
            track.currentTime = 0;
            track.onended = () => {
                console.log(`[SoundManager] Combat track ended, chaining next...`);
                this._playCombat(this.musicState, true);
            };
        }

        this._switchTrack(track, oldState);
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

        const isExitingCombat = oldState === MUSIC_STATE.COMBAT && this.musicState === MUSIC_STATE.EXPLORATION;
        const isStartup = !oldState || oldState === MUSIC_STATE.TITLE || oldState === MUSIC_STATE.GAMEOVER || oldState === MUSIC_STATE.NONE;

        // Instant for startup, slow 4s for combat exit, 1s for other in-game transitions
        const fadeTime = isStartup ? 0.2 : (isExitingCombat ? 4.0 : 0.5);
        const now = this.ctx ? this.ctx.currentTime : 0;

        // Reset analysis for new track
        this.prevSpectrum = null;
        this.energyHistory.all = [];
        this.energyHistory.bass = [];
        this.energyHistory.highs = [];
        this.fluxHistory = [];

        // 1. FADE OUT current track
        if (this.currentMusic && this.currentMusic !== nextTrack) {
            const oldTrack = this.currentMusic;
            if (oldTrack.trackGain && this.ctx) {
                // Professional: Overlap the fades. Outgoing starts dropping NOW.
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
            // Overlap: Incoming starts rising NOW.
            this.currentMusic.trackGain.gain.linearRampToValueAtTime(1, now + fadeTime);
        }

        // Always start playing immediately for overlapping crossfade
        this.currentMusic.play().catch(() => { });
    }

    // LEGACY METHODS (to keep compatibility while refactoring)
    registerMusic(paths) {
        // Assume these are exploration if not specified
        this.registerExplorationMusic(paths);
    }

    startMusic(volume = null) {
        if (volume !== null) this.setMusicVolume(volume);
        this.setTargetState(MUSIC_STATE.EXPLORATION);
    }

    registerBossMusic(key, path) {
        this.bossTracks[key] = this._createMusicElement(path);
        this.bossTracks[key].loop = true;
    }

    registerTitleMusic(path) {
        this.titleTrack = this._createMusicElement(path);
    }

    registerGameOverMusic(path) {
        this.gameOverTrack = this._createMusicElement(path);
    }

    playGameOverMusic() {
        this.setTargetState(MUSIC_STATE.GAMEOVER);
    }

    stopMusic() {
        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
            this.currentMusic = null;
        }
        this.musicState = MUSIC_STATE.NONE;
        this.targetMusicState = MUSIC_STATE.NONE;
    }

    playTitleMusic() {
        this.setTargetState(MUSIC_STATE.TITLE);
    }

    playSpecificMusic(key) {
        if (this.bossTracks && this.bossTracks[key]) {
            const oldState = this.musicState;
            this.musicState = MUSIC_STATE.BOSS;
            this.targetMusicState = MUSIC_STATE.BOSS;
            this._switchTrack(this.bossTracks[key], oldState);
        }
    }

    playMusicByLabel(key) {
        this.playSpecificMusic(key);
    }

    restoreMusic() {
        // Restore to exploration by default
        this.setTargetState(MUSIC_STATE.EXPLORATION);
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
            const dx = x - this.listenerX;
            const dy = y - this.listenerY;
            const dist = Math.sqrt(dx * dx + dy * dy);
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

        const gainNode = this.ctx.createGain();
        gainNode.gain.value = Math.min(1.0, Math.max(0.0, volume));

        source.connect(gainNode);
        gainNode.connect(this.ctx.destination);
        source.start(0);
    }
}
