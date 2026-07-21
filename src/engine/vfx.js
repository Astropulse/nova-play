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

// ─── Tiled beam strips ──────────────────────────────────────────────────────
// Beams (railgun lines, boss mega-beams, the Seraph's fire beam) are long rows
// of one small repeating tile. Drawing them tile-by-tile can't be seamless:
// fractional tile positions open hairline gaps (antialiased edges), and
// overlapping the tiles instead doubles the translucent pixels into bright
// lines. So each tile is pre-tiled ONCE into a long strip canvas at native
// resolution with integer offsets (seam-free by construction), and a beam then
// renders as a single stretched drawImage of that strip — no seams, and 1–2
// draw calls instead of hundreds.

const STRIP_TILES = 48;        // long enough to cross any screen in one strip
const _stripCache = new Map(); // tile canvas -> pre-tiled strip canvas

function _getStrip(tileCanvas) {
    let strip = _stripCache.get(tileCanvas);
    if (!strip) {
        strip = document.createElement('canvas');
        strip.width = tileCanvas.width * STRIP_TILES;
        strip.height = tileCanvas.height;
        const g = strip.getContext('2d');
        for (let i = 0; i < STRIP_TILES; i++) {
            g.drawImage(tileCanvas, i * tileCanvas.width, 0);
        }
        _stripCache.set(tileCanvas, strip);
    }
    return strip;
}

// Draw a beam `screenLen` px long along +x from the current origin — the
// caller has already translated/rotated and set alpha/composite. `img` is the
// tile asset ({canvas,width,height} object, GIF frame, or raw canvas);
// tileW/tileH are its on-screen tile size. Beams longer than one strip repeat
// it (the rare strip-to-strip junction lands far off-screen).
export function drawBeamStrip(ctx, img, tileW, tileH, screenLen) {
    if (!img || tileW <= 0) return;
    const tileCanvas = img.canvas || img;
    const strip = _getStrip(tileCanvas);
    let x = 0;
    while (x < screenLen) {
        const tiles = Math.min(STRIP_TILES, Math.ceil((screenLen - x) / tileW));
        ctx.drawImage(strip, 0, 0, tiles * tileCanvas.width, strip.height,
            x, -tileH / 2, tiles * tileW, tileH);
        x += tiles * tileW;
    }
}
