// Shared text-sprite cache — the generalisation of FloatingText's glyph
// cache for screen-space text that is redrawn every frame with the same
// string/style (HUD readouts, the kill-streak counter, cinematic cards).
//
// A text run (and its outline passes) is rasterised ONCE into a small
// transparent canvas and blitted per frame at an integer offset. To keep the
// glyph pixels identical to a direct fillText, the sprite is rendered with
// the SAME sub-pixel phase as the on-screen anchor: the anchor's fractional
// part (x − floor(x), y − floor(y)) is part of the cache key and the text is
// drawn at (L + fx, T + fy) inside the sprite, which is then blitted at
// (floor(x) − L, floor(y) − T). Same font / align / baseline / phase → same
// glyph raster; the only difference is 8-bit premultiplied rounding at the
// anti-aliased glyph edges (≤ 1 level).
//
// Multi-pass outlines (4-way offset fills or strokeText) are composited in
// the sprite exactly in the original order. Because overlapping passes at
// globalAlpha < 1 compound, outlined text at alpha ≠ 1 is only cached when
// the caller opts in with `bakeAlpha` (the alpha becomes part of the key and
// the passes are drawn at it inside the sprite, then the sprite is blitted at
// alpha 1 — the same math as compositing each pass directly). Otherwise it
// falls back to the original direct draw calls, byte-for-byte.
//
// CALLER CONTRACT: the ctx transform must be identity or an integer
// translation (true for the HUD / overlay layers that use this), and no
// filter/shadow may be active. Text that changes every frame (moving
// coordinates, flashing colours, re-rolled reels) should NOT be routed here —
// it would just churn the LRU; draw it directly.
//
// Until web fonts report loaded, everything draws directly (no caching of
// fallback-font glyphs); the cache is flushed on every `loadingdone`.

export const TEXT_FILL = 0;      // plain fill
export const TEXT_OUTLINE4 = 1;  // 4 offset fills (±ow, 0) (0, ±ow) in outline colour, then fill
export const TEXT_STROKE = 2;    // strokeText(lineWidth = ow, lineJoin) in outline colour, then fill

const MAX_ENTRIES = 96;
const _cache = new Map();
let _measure = null;
let _fontsHooked = false;

function fontsReady() {
    const f = typeof document !== 'undefined' ? document.fonts : null;
    if (!f) return true;
    if (!_fontsHooked && f.addEventListener) {
        _fontsHooked = true;
        f.addEventListener('loadingdone', () => _cache.clear());
    }
    return f.status === 'loaded';
}

function drawPasses(c, text, x, y, fill, mode, oc, ow, lineJoin) {
    if (mode === TEXT_OUTLINE4) {
        c.fillStyle = oc;
        c.fillText(text, x - ow, y);
        c.fillText(text, x + ow, y);
        c.fillText(text, x, y - ow);
        c.fillText(text, x, y + ow);
    } else if (mode === TEXT_STROKE) {
        c.strokeStyle = oc;
        c.lineWidth = ow;
        c.lineJoin = lineJoin;
        c.strokeText(text, x, y);
    }
    c.fillStyle = fill;
    c.fillText(text, x, y);
}

function build(text, font, align, baseline, fill, mode, oc, ow, lineJoin, passAlpha, fx, fy) {
    const m = _measure || (_measure = document.createElement('canvas').getContext('2d'));
    m.font = font; m.textAlign = align; m.textBaseline = baseline;
    const mt = m.measureText(text);
    const sizeGuess = parseFloat(font) || 16;
    const bl = mt.actualBoundingBoxLeft != null ? mt.actualBoundingBoxLeft : mt.width;
    const br = mt.actualBoundingBoxRight != null ? mt.actualBoundingBoxRight : mt.width;
    const ba = mt.actualBoundingBoxAscent != null ? mt.actualBoundingBoxAscent : sizeGuess * 1.5;
    const bd = mt.actualBoundingBoxDescent != null ? mt.actualBoundingBoxDescent : sizeGuess * 1.5;
    // Outline reach: offset fills reach ow; a stroke reaches ow/2 for
    // round/bevel joins, up to miterLimit (10) × ow/2 for miters.
    const reach = mode === TEXT_OUTLINE4 ? ow
        : mode === TEXT_STROKE ? (lineJoin === 'miter' ? ow * 5 : ow / 2) : 0;
    const pad = Math.ceil(reach) + 2;
    const L = Math.max(0, Math.ceil(bl)) + pad;
    const T = Math.max(0, Math.ceil(ba)) + pad;
    const w = Math.max(1, L + Math.max(0, Math.ceil(br)) + pad + 1);
    const h = Math.max(1, T + Math.max(0, Math.ceil(bd)) + pad + 1);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const c = canvas.getContext('2d');
    c.font = font; c.textAlign = align; c.textBaseline = baseline;
    c.globalAlpha = passAlpha;
    drawPasses(c, text, L + fx, T + fy, fill, mode, oc, ow, lineJoin);
    return { canvas, L, T, width: mt.width };
}

/**
 * Draw (cached) text. Arguments mirror the direct calls it replaces:
 * the caller's ctx.font/textAlign/textBaseline are NOT required to be set,
 * and the cached path leaves the ctx's text/fill state untouched (the direct
 * fallback sets font/align/baseline/fillStyle[/strokeStyle/lineWidth/
 * lineJoin] exactly like the original code did).
 * @returns {number} the text's advance width (measureText().width), or NaN
 *          when it drew directly (callers needing it then measure).
 */
export function drawCachedText(ctx, text, x, y, font, align, baseline, fill,
    mode = TEXT_FILL, oc = '#000000', ow = 0, lineJoin = 'miter', bakeAlpha = false) {
    const ga = ctx.globalAlpha;
    const multi = mode !== TEXT_FILL;
    if (!text || !fontsReady() || ctx.globalCompositeOperation !== 'source-over'
        || (multi && ga !== 1 && !bakeAlpha)) {
        ctx.font = font; ctx.textAlign = align; ctx.textBaseline = baseline;
        drawPasses(ctx, text, x, y, fill, mode, oc, ow, lineJoin);
        return NaN;
    }
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const passAlpha = multi ? ga : 1;
    const key = text + '\u0001' + font + '\u0001' + align + '\u0001' + baseline + '\u0001' + fill
        + '\u0001' + mode + '\u0001' + (multi ? oc + '\u0001' + ow + '\u0001' + lineJoin + '\u0001' + passAlpha : '')
        + '\u0001' + fx + '\u0001' + fy;
    let e = _cache.get(key);
    if (e) {
        // LRU refresh
        _cache.delete(key);
        _cache.set(key, e);
    } else {
        e = build(text, font, align, baseline, fill, mode, oc, ow, lineJoin, passAlpha, fx, fy);
        if (_cache.size >= MAX_ENTRIES) _cache.delete(_cache.keys().next().value);
        _cache.set(key, e);
    }
    if (multi && ga !== 1) {
        ctx.globalAlpha = 1;
        ctx.drawImage(e.canvas, ix - e.L, iy - e.T);
        ctx.globalAlpha = ga;
    } else {
        ctx.drawImage(e.canvas, ix - e.L, iy - e.T);
    }
    return e.width;
}

/** Drop every cached text sprite (e.g. on resize storms / memory pressure). */
export function clearTextSprites() { _cache.clear(); }
