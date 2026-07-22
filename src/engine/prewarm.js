// Title-screen warm-up of every per-sprite cache a run needs (fracture cell
// layouts, death-shatter shards, glow sprites, post-fx shaders). All of these
// are lazily built on first use, which used to mean the first kill / boost /
// chip of each sprite type paid a multi-ms slice or shader compile mid-combat.
// Pumping the same cache builds one at a time while the player sits on the
// title menu makes them free by the time a run starts.
//
// PlayingState keeps its own staggered prewarm as a fallback (e.g. a run
// started before the title pump finished) — every entry here is idempotent
// and a cache hit costs only a Map lookup.
import { FractureModel, getCachedShatter, ExpOrb } from '../entities/asteroid.js';
import { Enemy } from '../entities/enemy.js';
import { ScreenFX } from './screenFx.js';
import { FIRE_EXPLOSION_KEYS } from './vfx.js';

// Piece counts must match what _generateProceduralDebris asks for — the
// shatter cache keeps whichever layout is built first. Shared with
// PlayingState._startFracturePrewarm so the two lists can never drift.
export const FRACTURE_PREWARM_KEYS = (() => {
    const keys = [];
    for (const k of ['asteroid_big_0', 'asteroid_big_1', 'asteroid_big_2']) keys.push([k, 60]);
    for (const k of ['asteroid_medium_0', 'asteroid_medium_1', 'asteroid_medium_2']) keys.push([k, 32]);
    for (const k of ['asteroid_small_0', 'asteroid_small_1']) keys.push([k, 22]);
    for (let i = 0; i <= 24; i++) keys.push([`asteroid_tiny_${String(i).padStart(2, '0')}`, 14]);
    for (let i = 0; i <= 4; i++) keys.push([`enemy_ship_${i}`, 13]);
    // The dragon's seven heads shatter-and-reform constantly — their voronoi
    // layouts must be warm before the fight (48 = dragon.js SHATTER_PIECES).
    for (const k of ['dragon_deception', 'dragon_accusation', 'dragon_murder',
        'dragon_blasphemy', 'dragon_economic_control', 'dragon_false_worship',
        'dragon_persecution']) keys.push([k, 48]);
    return keys;
})();

function buildTasks(game) {
    const tasks = [];

    // Post-fx pipeline: compile the ScreenFX shaders now so the first effect
    // that lights it up in a run — usually the first boost — doesn't pay the
    // WebGL context + shader compile cost mid-gameplay.
    tasks.push(() => {
        if (!game.screenFx) game.screenFx = new ScreenFX(game);
        game.screenFx.warm();
    });

    // ExpOrb glow halo per GIF frame.
    tasks.push(() => {
        const expAsset = game.assets.get('exp');
        if (expAsset && Array.isArray(expAsset)) {
            for (const frame of expAsset) {
                const f = frame.canvas || frame;
                if (f) ExpOrb._getGlowForFrame(f);
            }
        }
    });

    // Death-explosion GIF variants: slice + prescale each variant's atlas frames
    // now so the first ship/boss death doesn't materialize them mid-combat.
    tasks.push(() => {
        for (const key of FIRE_EXPLOSION_KEYS) game.assets.get(key);
    });

    // (Lasers now render as simple stroked streaks — no glow sprite to pre-bake.)

    // Per-sprite damage models: chip-damage cell layout, death shatter layout,
    // and the upgraded-enemy glow. One sprite per task — the big asteroid
    // slices are the most expensive single steps (tens of ms), so they each
    // get their own pump slot.
    for (const [key, pieces] of FRACTURE_PREWARM_KEYS) {
        tasks.push(() => {
            const img = game.assets.get(key);
            if (!img) return;
            FractureModel.get(img, key);      // chip-damage cell layout
            getCachedShatter(img, key, pieces); // death shatter layout
            if (key.startsWith('enemy_ship')) {
                Enemy.getGlowSprite(img, key, '#ff4444'); // upgraded-enemy glow
            }
        });
    }
    return tasks;
}

// Pump state lives at module level so progress survives menu re-entry
// (achievements screen, multiplayer lobby, returning from a run).
let _tasks = null;
let _idx = 0;
let _accum = 0;
const STEP_INTERVAL = 0.12; // seconds between tasks — same cadence the in-run prewarm uses

/**
 * Run at most one warm-up task per call, spaced STEP_INTERVAL apart. Call it
 * from a state's update() once the full atlas is available (the menu gates on
 * its World being built, which already waits for the full atlas).
 * @returns {boolean} true once every task has run.
 */
export function pumpRunPrewarm(game, dt) {
    if (_tasks && _idx >= _tasks.length) return true;
    _accum += dt;
    if (_accum < STEP_INTERVAL) return false;
    _accum = 0;
    if (!_tasks) _tasks = buildTasks(game);
    const task = _tasks[_idx++];
    try {
        task();
    } catch (e) {
        console.warn('[Prewarm] task failed:', e);
    }
    if (_idx >= _tasks.length) {
        console.log(`[Prewarm] title-screen warm-up complete (${_tasks.length} tasks)`);
        return true;
    }
    return false;
}
