// Shared helpers for the fiery death-explosion effect that enemies, bosses, and
// the Seraph all play as they blow apart. Each individual blast picks one of
// several authored GIF variants at random, so a dying ship shows a mix of
// explosion shapes instead of the same clip stamped over and over.

// The death-explosion GIF variants. `fire_explosion` is variant 1 — game.js's
// gif manifest aliases that base key to fire_explosion_1.gif — and _2 / _3 are
// the alternates. To fold in more variety, drop another gif in Assets/VFX,
// add its key to the manifest, and list it here (then re-run pack-assets).
export const FIRE_EXPLOSION_KEYS = ['fire_explosion', 'fire_explosion_2', 'fire_explosion_3'];

// Pick a random explosion variant for a single blast. Returns the atlas key to
// draw plus that variant's total run time (ms) so the caller can retire the
// blast when its clip finishes. Falls back to 500ms if the frames aren't
// resident yet (only possible before the full atlas has streamed in).
export function pickFireExplosion(assets) {
    const key = FIRE_EXPLOSION_KEYS[Math.floor(Math.random() * FIRE_EXPLOSION_KEYS.length)];
    const frames = assets.get(key);
    const totalDuration = frames ? frames.reduce((sum, f) => sum + f.delay, 0) : 500;
    return { key, totalDuration };
}

// Resolve which frame to draw for a blast that has been playing for `animTimer`
// milliseconds. `frames` is the array returned by assets.get(ex.fireKey).
// Returns null when the frames aren't loaded yet.
export function fireExplosionFrame(frames, animTimer) {
    if (!frames || !frames.length) return null;
    let elapsed = animTimer;
    for (const f of frames) {
        if (elapsed < f.delay) return f;
        elapsed -= f.delay;
    }
    return frames[frames.length - 1];
}
