// Title-screen warm-up of every per-sprite cache a run needs (fracture cell
// layouts, death-shatter shards, glow sprites, post-fx shaders). All of these
// are lazily built on first use, which used to mean the first kill / boost /
// chip of each sprite type paid a multi-ms slice or shader compile mid-combat.
// Pumping the same cache builds one at a time while the player sits on the
// title menu makes them free by the time a run starts.
//
// PlayingState resumes this same pump from its update() as a fallback (e.g. a
// run started before the title pump finished) — every entry here is
// idempotent and a cache hit costs only a Map lookup.
//
// Tasks may be plain functions or GENERATOR functions. A generator task is
// resumed across pump calls with a per-call time cap (SLICE_BUDGET_MS), so a
// big sprite's fracture partition (opaque pixels x up to 320 seeds) or a
// 16-frame animation's surfaces never land on one frame. Intermediate state
// stays private to the generator; caches are published whole on completion
// (asteroid.js FractureModel.prewarmSteps / prewarmShatterSteps).
import { FractureModel, prewarmShatterSteps, ExpOrb } from '../entities/asteroid.js';
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

    // ExpOrb glow halo per GIF frame (one frame per step).
    tasks.push(function* () {
        const expAsset = game.assets.get('exp');
        if (expAsset && Array.isArray(expAsset)) {
            for (const frame of expAsset) {
                const f = frame.canvas || frame;
                if (f) ExpOrb._getGlowForFrame(f);
                yield;
            }
        }
    });

    // Death-explosion GIF variants: materialize each variant's prescaled
    // frame surfaces (one frame per step) so the first ship/boss death
    // doesn't build them mid-combat. Frames are lazy in the loader;
    // warmFrame builds one WITHOUT the consumer lookahead (a plain `.canvas`
    // read would queue the next frame too and count as playback).
    tasks.push(function* () {
        for (const key of FIRE_EXPLOSION_KEYS) {
            const frames = game.assets.get(key);
            if (!Array.isArray(frames)) continue;
            for (const f of frames) {
                if (game.assets.warmFrame) game.assets.warmFrame(f); else f.canvas;
                yield;
            }
        }
    });

    // (Lasers now render as simple stroked streaks — no glow sprite to pre-bake.)

    // Per-sprite damage models: chip-damage cell layout, death shatter layout,
    // and the upgraded-enemy glow. One sprite per task, and each layout is
    // built a few pixel rows per pump call (the big asteroid partitions are
    // tens of ms end to end) so no single frame pays for a whole sprite.
    for (const [key, pieces] of FRACTURE_PREWARM_KEYS) {
        tasks.push(function* () {
            const img = game.assets.get(key);
            if (!img) return;
            yield* FractureModel.prewarmSteps(img, key);      // chip-damage cell layout
            yield* prewarmShatterSteps(img, key, pieces);    // death shatter layout
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
let _cur = null;            // in-progress generator task (resumed each call)
const STEP_INTERVAL = 0.12; // seconds between tasks — same cadence the in-run prewarm used
const SLICE_BUDGET_MS = 3;  // main-thread time one pump call may spend inside a resumable task

// Resume the current generator task until it finishes or the slice budget
// runs out. Errors drop the task (same as a failing plain task).
function _advance() {
    const t0 = performance.now();
    try {
        for (;;) {
            if (_cur.next().done) { _cur = null; break; }
            if (performance.now() - t0 >= SLICE_BUDGET_MS) break;
        }
    } catch (e) {
        console.warn('[Prewarm] task failed:', e);
        _cur = null;
    }
}

function _finished() {
    if (_tasks && _idx >= _tasks.length && !_cur) {
        if (!_finished.logged) {
            _finished.logged = true;
            console.log(`[Prewarm] warm-up complete (${_tasks.length} tasks)`);
        }
        return true;
    }
    return false;
}

/**
 * Advance the warm-up: resume an in-progress resumable task for at most
 * SLICE_BUDGET_MS, otherwise start the next task once STEP_INTERVAL has
 * elapsed. Call it from a state's update() once the full atlas is available
 * (the menu gates on its World being built, which already waits for the full
 * atlas; PlayingState calls it too as a fallback).
 * @returns {boolean} true once every task has run.
 */
export function pumpRunPrewarm(game, dt) {
    if (_cur) {
        _advance();
        if (!_cur) _accum = 0;
        return _finished();
    }
    if (_finished()) return true;
    _accum += dt;
    if (_accum < STEP_INTERVAL) return false;
    _accum = 0;
    if (!_tasks) _tasks = buildTasks(game);
    const task = _tasks[_idx++];
    try {
        const r = task();
        if (r && typeof r.next === 'function') {
            _cur = r;
            _advance();
        }
    } catch (e) {
        console.warn('[Prewarm] task failed:', e);
    }
    return _finished();
}
