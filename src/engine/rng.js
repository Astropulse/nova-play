// Deterministic seeded RNG infrastructure.
//
// This is the backbone of the master-seed system: a run's gameplay randomness
// (asteroid spawns, scrap rewards, shop stock, cache spawns + contents, enemy
// spawns, drops, cache rolls, level-up bonuses, encounter outcomes, event
// placement) is driven from a single run seed so that the same seed + the same
// player actions produce a nearly identical run.
//
// Visual-only randomness (particles, rubble, sparks, voronoi fractures,
// floating text, screen shake, sound/sprite variant picks) and enemy AI
// decisions intentionally stay on Math.random() — they're allowed to differ
// between same-seed runs and keeping them off the seeded streams prevents them
// from desyncing gameplay determinism.

// mulberry32: tiny, fast, well-distributed 32-bit PRNG. Same algorithm the
// starfield (world.js) uses for deterministic star placement. `seed` is the
// single 32-bit integer the generator advances; that integer IS the full state.
export function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// FNV-1a style string hash → 32-bit int. Used to decorrelate domain streams
// derived from one master seed (so the 'asteroids' stream and the 'enemies'
// stream don't march in lockstep).
function hashStringToInt(str, seed = 0) {
    let h = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

export const SEED_MAX = 100000000; // 8 digits: 00000000–99999999

// Roll a fresh random run/world seed (used when none is set, or `0` is given).
export function randomSeed() {
    return Math.floor(Math.random() * SEED_MAX);
}

// 8-digit zero-padded display string.
export function formatSeed(n) {
    const v = ((Number(n) % SEED_MAX) + SEED_MAX) % SEED_MAX;
    return String(Math.floor(v)).padStart(8, '0');
}

// Parse user input into a seed integer. Returns null on invalid input.
// `0` is a sentinel meaning "randomize" — the caller decides how to handle it
// (this returns 0, callers map 0 → randomSeed()).
export function parseSeed(str) {
    if (str == null) return null;
    const trimmed = String(str).trim();
    if (!/^\d+$/.test(trimmed)) return null;
    const n = parseInt(trimmed, 10);
    if (isNaN(n)) return null;
    return n % SEED_MAX;
}

// Stateful seeded RNG with convenience helpers. The internal state is a single
// 32-bit integer (`_state`), so serialization is trivial.
export class RNG {
    constructor(seed = 0) {
        // State is a single 32-bit int (the value mulberry32 advances), so
        // serialization is just this number.
        this._state = (seed | 0);
    }

    // Advance and return a float in [0, 1). Mirrors Math.random(). This is the
    // mulberry32 step, inlined so we own `_state` for getState/setState.
    next() {
        this._state = (this._state + 0x6D2B79F5) | 0;
        let t = Math.imul(this._state ^ this._state >>> 15, 1 | this._state);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }

    // Raw 32-bit unsigned int — used to derive child seeds.
    nextUint32() {
        return Math.floor(this.next() * 4294967296) >>> 0;
    }

    // Float in [min, max).
    range(min, max) {
        return min + this.next() * (max - min);
    }

    // Integer in [min, max] inclusive.
    int(min, max) {
        return Math.floor(this.range(min, max + 1));
    }

    // True with probability p (0..1).
    chance(p) {
        return this.next() < p;
    }

    // Coin flip.
    bool() {
        return this.next() < 0.5;
    }

    // Random element of an array (undefined for empty arrays).
    pick(arr) {
        if (!arr || arr.length === 0) return undefined;
        return arr[Math.floor(this.next() * arr.length)];
    }

    // In-place Fisher–Yates shuffle; returns the same array.
    shuffle(arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(this.next() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    getState() {
        return this._state | 0;
    }

    setState(state) {
        this._state = (state | 0);
        return this;
    }
}

// Domain names for the per-system streams. Keeping them in one place avoids
// typos when both producers and the serializer reference them.
export const STREAM_DOMAINS = [
    'asteroids',
    'enemies',
    'caches',
    'shops',
    'encounters',
    'events',
    'levelup',
    'drops',
];

// One master seed → a bundle of independent, decorrelated RNG streams (one per
// gameplay domain). Spawners read the relevant stream directly; entities derive
// their own per-instance RNG via deriveEntity() so their loot is fixed at spawn
// time (independent of when/if they later die).
export class RandomStreams {
    constructor(masterSeed = 0) {
        this.masterSeed = (masterSeed | 0);
        for (const domain of STREAM_DOMAINS) {
            this[domain] = new RNG(hashStringToInt(domain, this.masterSeed));
        }
    }

    // Fresh RNG seeded from the given domain stream — for spawn-time entity
    // seeding. Returns { rng, seed } so callers can persist the seed.
    deriveEntity(domain) {
        const stream = this[domain] || this.drops;
        const seed = stream.nextUint32();
        return { rng: new RNG(seed), seed };
    }

    serialize() {
        const states = {};
        for (const domain of STREAM_DOMAINS) {
            states[domain] = this[domain].getState();
        }
        return { masterSeed: this.masterSeed, states };
    }

    deserialize(data) {
        if (!data) return this;
        this.masterSeed = (data.masterSeed | 0);
        if (data.states) {
            for (const domain of STREAM_DOMAINS) {
                if (data.states[domain] !== undefined && this[domain]) {
                    this[domain].setState(data.states[domain]);
                }
            }
        }
        return this;
    }
}
