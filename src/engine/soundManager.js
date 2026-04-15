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

        if (this.ctx) {
            // Main music gain (user volume control) — no analyser node
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
            trackGain.connect(this.musicGain);
        }

        // Attach gain node to audio element for control
        audio.trackGain = trackGain;
        return audio;
    }

    // Simple time-based transition: wait for the cutoff, then switch
    update(dt) {
        if (this.isTransitioning) {
            this.transitionWaitTimer += dt;
            if (this.transitionWaitTimer >= this.maxTransitionWait) {
                this._executeTransition();
            }
        }
    }

    setTargetState(state, force = false) {
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
    }

    _playCombat(oldState = null, forceNew = false) {
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
        this.setTargetState(MUSIC_STATE.GAMEOVER, true);
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
        this.setTargetState(MUSIC_STATE.TITLE, true);
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

        // Disconnect nodes after playback to prevent audio graph leak
        source.onended = () => {
            source.disconnect();
            gainNode.disconnect();
        };

        source.start(0);
    }

    destroy() {
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
