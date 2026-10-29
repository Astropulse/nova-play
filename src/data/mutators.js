// Mutators — short, timed run modifiers that shake up a stretch of play.
// They come from encounter deals ("add_mutator:<id>") and, rarely, from a
// space cache (a 1-in-10 roll derived from the cache's content seed, so it
// reproduces with the run without consuming the loot stream).
//
// Active mutators live on PlayingState.mutators as { id, t } (t = seconds
// left, sim time, so they pause with the game). Stat mutators are folded in
// at the end of _onInventoryChanged via applyMutators(); the rest are read
// where they act (damage taken, scrap pickup, shot ricochet).
//
// Multiplayer: mutators only ever touch the local pilot's own stats. The two
// that would bend shared state — ricochet (extra shots) and gold rush
// (pickup value) — are inert in networked sessions (`solo: true`).

export const MUTATORS = {
    overclock: {
        name: 'OVERCLOCK', color: '#ff9a3a', dur: 90,
        desc: '+25% fire rate',
        apply(p) { p.fireRateMult *= 0.8; },
    },
    glass_cannon: {
        name: 'GLASS CANNON', color: '#ff5a8a', dur: 90,
        desc: '+50% damage, +50% damage taken',
        apply(p) { p.laserCartridgeMult *= 1.5; },
        damageTaken: 1.5,
    },
    magnet_storm: {
        name: 'MAGNET STORM', color: '#9fe8ff', dur: 120,
        desc: 'Double scrap pull range',
        apply(p) { p.scrapRangeMult *= 2; },
    },
    ricochet: {
        name: 'RICOCHET', color: '#b070ff', dur: 90, solo: true,
        desc: 'Shots bounce once to a nearby enemy',
    },
    gold_rush: {
        name: 'GOLD RUSH', color: '#ffd24a', dur: 60, solo: true,
        desc: 'Scrap pickups worth +50%',
        scrapMult: 1.5,
    },
};

export const MUTATOR_IDS = Object.keys(MUTATORS);

// Is mutator `id` live (and allowed in this session)?
export function mutatorActive(state, id) {
    const list = state.mutators;
    if (!list || !list.length) return false;
    const def = MUTATORS[id];
    if (!def || (def.solo && state.netSync)) return false;
    for (const m of list) if (m.id === id) return true;
    return false;
}

// Product of a numeric field over the live mutators (e.g. 'damageTaken').
export function mutatorMult(state, field) {
    let k = 1;
    const list = state.mutators;
    if (!list) return k;
    for (const m of list) {
        const def = MUTATORS[m.id];
        if (!def || def[field] == null || (def.solo && state.netSync)) continue;
        k *= def[field];
    }
    return k;
}

export function applyMutators(p, list) {
    if (!list) return;
    for (const m of list) { const d = MUTATORS[m.id]; if (d && d.apply) d.apply(p); }
}

// Deterministic 1-in-10 per cache, from its content seed (never consumes RNG).
export function cacheRollsMutator(cache) {
    const seed = cache && cache.contentSeed;
    if (seed == null) return null;
    let h = Math.imul((seed | 0) ^ 0x5bd1e995, 2654435761);
    h ^= h >>> 15;
    const u = (h >>> 0) / 4294967296;
    if (u >= 0.1) return null;
    return MUTATOR_IDS[Math.floor(u * 10 * MUTATOR_IDS.length) % MUTATOR_IDS.length];
}
