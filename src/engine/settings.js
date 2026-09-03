// Persistent player-facing settings, saved to localStorage (`nova_settings`).
//
// A tiny module-level singleton (like the fracture caches) so leaf modules
// (asteroid.js, world.js, soundManager.js) can read flags directly instead of
// threading `game` through every constructor. `Game` loads it at boot and
// exposes it as `game.settings`; `SettingsState` is the UI over it.
//
// Every default preserves pre-settings behavior exactly — a missing or wiped
// store plays identically to how the game played before this module existed.

export const SETTINGS_DEFAULTS = Object.freeze({
    // Startup audio — what the volume sliders open at. The title/pause
    // quick-sliders stay session-only; these are the boot values.
    musicVolume: 0.5,
    sfxVolume: 0.5,

    // 0..1 scale on the audio corruption FX buses (kill-streak clipping,
    // dread warble). 0 = the music/SFX always stay clean.
    audioDistortion: 1.0,

    // 0..1 scale on the ScreenFX post-pass (kill-streak CRT, dread wobble,
    // shield ripples, boost/teleport space-bending). 0 = pass never runs.
    visualDistortion: 1.0,

    // Whether the ScreenFX post-pass runs at all:
    //   'on'   — always (default). Ignores the adaptive self-disable latch
    //            and low-perf mode, so effects never quietly stop mid-run.
    //   'auto' — the adaptive behavior: weak hardware may latch it off
    //            (nova_screenfx_off / nova_lowperf).
    //   'off'  — never.
    screenFx: 'on',

    // Voronoi fracture systems: chip-damage cell layouts (asteroids, hive,
    // idols) and full-count cosmetic death shatters. Off = no chip erosion,
    // deaths break into a few chunks instead of a full shard cloud.
    voronoiFractures: true,

    // Bilinear filtering when world sprites draw at non-native scale.
    // Off = nearest-neighbour everywhere: crunchier pixels, cheaper sampling.
    smoothScaling: true,

    // Fewer cosmetic particles (sparks, rubble, death debris) and a thinner
    // starfield (~half the ordinary stars). Rare objects are never culled.
    reducedParticles: false,
});

// Allowed values for string-valued settings (validated on load/set).
export const SETTINGS_OPTIONS = Object.freeze({
    screenFx: ['on', 'auto', 'off'],
});

const STORAGE_KEY = 'nova_settings';

// The live settings bag. Mutate only through setSetting/resetSettings so
// every change persists.
export const SETTINGS = { ...SETTINGS_DEFAULTS };

function _clamp(key, value) {
    if (typeof SETTINGS_DEFAULTS[key] === 'number') {
        return Math.min(1, Math.max(0, Math.round(value * 10) / 10));
    }
    if (typeof SETTINGS_DEFAULTS[key] === 'string') {
        const opts = SETTINGS_OPTIONS[key];
        return (opts && opts.includes(value)) ? value : SETTINGS_DEFAULTS[key];
    }
    return !!value;
}

export function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        for (const key of Object.keys(SETTINGS_DEFAULTS)) {
            if (data[key] !== undefined && typeof data[key] === typeof SETTINGS_DEFAULTS[key]) {
                SETTINGS[key] = _clamp(key, data[key]);
            }
        }
    } catch (e) { /* no storage / corrupt JSON — keep defaults */ }
}

export function saveSettings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(SETTINGS));
    } catch (e) { /* no storage */ }
}

// Set one key (unknown keys are ignored; numbers clamp to 0..1 in 0.1 steps,
// booleans coerce, strings must be in SETTINGS_OPTIONS or fall back to the
// default) and persist immediately. Returns the stored value.
export function setSetting(key, value) {
    if (!(key in SETTINGS_DEFAULTS)) return undefined;
    SETTINGS[key] = _clamp(key, value);
    saveSettings();
    return SETTINGS[key];
}

export function resetSettings() {
    Object.assign(SETTINGS, SETTINGS_DEFAULTS);
    saveSettings();
}
