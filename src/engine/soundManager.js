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
        this.musicTracks = [];   // Array of Audio elements
        this.currentMusic = null;
        this.musicVolume = 0.5;
        this.sfxVolume = 0.5;
        this.musicBaseVolume = 0.4;
        this.unlocked = false;

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

    // Register music (streams)
    registerMusic(paths) {
        this.musicTracks = paths.map(p => {
            const audio = new Audio(p);
            audio.preload = 'auto';
            audio.loop = false;
            return audio;
        });
    }

    startMusic(volume = null) {
        if (volume !== null) this.musicVolume = volume;
        this._playNextSong();
    }

    _playNextSong() {
        if (this.musicTracks.length === 0) return;

        let nextTrack;
        if (this.musicTracks.length > 1 && this.currentMusic) {
            const others = this.musicTracks.filter(t => t.src !== this.currentMusic.src);
            nextTrack = others[Math.floor(Math.random() * others.length)];
        } else {
            nextTrack = this.musicTracks[Math.floor(Math.random() * this.musicTracks.length)];
        }

        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
        }

        this.currentMusic = nextTrack;
        this.currentMusic.volume = this.musicVolume * this.musicBaseVolume;
        this.currentMusic.currentTime = 0;

        this.currentMusic.play().catch(() => { });
        this.currentMusic.onended = () => this._playNextSong();
    }

    // Register a specific track (like Boss music)
    registerBossMusic(key, path) {
        if (!this.bossTracks) this.bossTracks = {};
        const audio = new Audio(path);
        audio.preload = 'auto';
        audio.loop = true; // Boss music usually loops
        this.bossTracks[key] = audio;
    }

    registerTitleMusic(path) {
        this.titleTrack = new Audio(path);
        this.titleTrack.preload = 'auto';
        this.titleTrack.loop = true;
    }

    registerGameOverMusic(path) {
        this.gameOverTrack = new Audio(path);
        this.gameOverTrack.preload = 'auto';
        this.gameOverTrack.loop = true;
    }

    playGameOverMusic() {
        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
        }

        if (this.gameOverTrack) {
            this.currentMusic = this.gameOverTrack;
            this.currentMusic.volume = this.musicVolume * this.musicBaseVolume;
            this.currentMusic.currentTime = 0;
            this.currentMusic.play().catch(() => { });
        }
    }

    stopMusic() {
        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
            this.currentMusic = null;
        }
    }

    playTitleMusic() {
        if (this.currentMusic === this.titleTrack) return;

        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
        }

        if (this.titleTrack) {
            this.currentMusic = this.titleTrack;
            this.currentMusic.volume = this.musicVolume * this.musicBaseVolume;
            this.currentMusic.currentTime = 0;
            this.currentMusic.play().catch(() => { });
        }
    }

    playSpecificMusic(key) {
        if (this.currentMusic) {
            this.currentMusic.pause();
            this.currentMusic.onended = null;
        }

        if (this.bossTracks && this.bossTracks[key]) {
            this.currentMusic = this.bossTracks[key];
            this.currentMusic.volume = this.musicVolume * this.musicBaseVolume;
            this.currentMusic.currentTime = 0;
            this.currentMusic.play().catch(() => { });
        }
    }

    playMusicByLabel(key) {
        this.playSpecificMusic(key);
    }

    restoreMusic() {
        if (this.currentMusic && this.bossTracks && Object.values(this.bossTracks).includes(this.currentMusic)) {
            this.currentMusic.pause();
        }
        this._playNextSong();
    }

    setMusicVolume(v) {
        this.musicVolume = Math.min(1.0, Math.max(0.0, v));
        console.log(`[SoundManager] Music Volume set to: ${this.musicVolume.toFixed(2)}`);
        if (this.currentMusic) {
            this.currentMusic.volume = this.musicVolume * this.musicBaseVolume;
        }
    }

    setSfxVolume(v) {
        this.sfxVolume = Math.min(1.0, Math.max(0.0, v));
    }

    // Unlocks all audio on the first interaction
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

    // Play a sound effect using Web Audio API (absolute reliability)
    // Options: { volume, x, y, maxDistance } or just a numeric volume
    play(key, options = 0.5) {
        if (!this.ctx) return;

        let volume = 0.5;
        let x = null;
        let y = null;
        let minPassDist = 1200; // Full volume within this distance
        let maxDist = 2500;    // Completely silent at this distance

        if (typeof options === 'number') {
            volume = options * this.sfxVolume;
        } else if (typeof options === 'object') {
            volume = (options.volume !== undefined ? options.volume : 0.5) * this.sfxVolume;
            x = options.x;
            y = options.y;
            if (options.minDistance !== undefined) minPassDist = options.minDistance;
            if (options.maxDistance !== undefined) maxDist = options.maxDistance;
        } else {
            volume = 0.5 * this.sfxVolume;
        }

        // Apply spatial attenuation if position is provided
        if (x !== null && y !== null) {
            const dx = x - this.listenerX;
            const dy = y - this.listenerY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist >= maxDist) return; // Silent beyond cutoff

            if (dist > minPassDist) {
                // Linear falloff between min and max
                const attenuation = 1.0 - ((dist - minPassDist) / (maxDist - minPassDist));
                volume *= attenuation;
            }
            // else: within minPassDist, keep full volume
        }

        // Auto-resume context on any interaction if it's suspended
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

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
