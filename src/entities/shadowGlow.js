// Baked replacement for per-frame `ctx.shadowBlur` on big sprites / shapes.
//
// A live canvas shadow (offset 0) is the source's alpha, Gaussian-blurred
// (sigma = shadowBlur / 2, in SCREEN px), tinted shadowColor, composited under
// the drawn content with the same globalAlpha / globalCompositeOperation.
// Doing that blur every frame on a boss-sized sprite is one of the most
// expensive Canvas2D operations. These helpers draw exactly that shadow layer
// from a cached "shadow-only" canvas; the caller then draws its sprite/shape
// as before with NO shadow. Two sequential layers (shadow, then content)
// composite the same as the browser's built-in shadow pass, including under
// globalAlpha and 'lighter'.
//
// A bake renders the content with a real shadow into an offscreen canvas,
// with the content itself pushed off-canvas by shadowOffsetX so only the
// shadow lands (the shadow under the content is preserved, unlike a
// destination-out erase). It is baked UNROTATED in the content's own frame
// and drawn with the caller's transform — a Gaussian is isotropic, so
// rotate(blur(x)) == blur(rotate(x)).
//
// Resolution: baked at the native (logical) world pixel scale — the world
// layer's scale — raised 2x/4x (nearest-neighbour for sprites, like the asset
// prescale) only when the blur is small, so the baked sigma is always >= ~5
// bake px and the smooth bilinear blit is indistinguishable from the live
// screen-res shadow. Blur is quantized to 1 logical px (0.5 below 10) — far
// finer than any per-frame change of an animated radius; constant radii hit a
// single entry. Entries live in one bounded LRU (count + bytes).

const MAX_ENTRIES = 256;
const MAX_BYTES = 64 * 1024 * 1024;
const _cache = new Map();   // key -> { canvas, pad, m, bytes }
let _bytes = 0;
const _ids = new WeakMap(); // source canvas -> small int id
let _nextId = 1;

function _srcId(c) {
    let id = _ids.get(c);
    if (id === undefined) { id = _nextId++; _ids.set(c, id); }
    return id;
}

function _quantBlur(raw) {
    return raw >= 10 ? Math.round(raw) : Math.round(raw * 2) / 2;
}
function _resMult(blurLogical) {
    return blurLogical >= 5 ? 1 : (blurLogical >= 2.5 ? 2 : 4);
}
// Skia/Gecko clip a shadow at ~3 sigma = 1.5 * shadowBlur.
function _pad(blurBake) { return Math.ceil(blurBake * 1.5) + 2; }

// LRU lookup; `bake()` returns { canvas, pad, m } on a miss.
function _lookup(key, bake) {
    let e = _cache.get(key);
    if (e) {
        _cache.delete(key); _cache.set(key, e); // LRU touch
        return e;
    }
    e = bake();
    e.bytes = e.canvas.width * e.canvas.height * 4;
    _cache.set(key, e);
    _bytes += e.bytes;
    while ((_cache.size > MAX_ENTRIES || _bytes > MAX_BYTES) && _cache.size > 1) {
        const oldKey = _cache.keys().next().value;
        _bytes -= _cache.get(oldKey).bytes;
        _cache.delete(oldKey);
    }
    return e;
}

// Offscreen canvas set up so anything drawn at (x - off, y) casts its shadow
// at (x, y) while the content itself lands off-canvas.
function _shadowCanvas(w, h, blurBake, color) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    const off = w + 64;
    g.shadowColor = color;
    g.shadowBlur = blurBake;
    g.shadowOffsetX = off;
    g.shadowOffsetY = 0;
    return { c, g, off };
}

function _blit(ctx, canvas, x, y, w, h) {
    const prevSmooth = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(canvas, x, y, w, h);
    ctx.imageSmoothingEnabled = prevSmooth;
}

/**
 * Draw the shadow that
 *     ctx.shadowBlur = blur; ctx.shadowColor = color;
 *     ctx.drawImage(src, dx, dy, dw, dh);
 * would cast (offset 0) — WITHOUT the sprite. Uses the caller's current
 * transform / globalAlpha / composite op. `blur` is in screen px (assumes no
 * extra ctx scale beyond dw/dh, true for every world draw in this codebase).
 *
 * @param src      source canvas (prescaled asset canvas or a composite)
 * @param nativeW  logical (world-layer) pixel width of the sprite
 * @param nativeH  logical pixel height
 * @param stamp    bump when `src`'s pixels change in place (e.g. a
 *                 HullFracture composite version); 0 for immutable sprites
 */
export function drawShadowGlow(ctx, src, nativeW, nativeH, dx, dy, dw, dh, blur, color, stamp = 0) {
    if (!(blur > 0) || !src || !nativeW || !nativeH || !dw || !dh) return;
    const blurLogical = _quantBlur(blur * (nativeW / Math.abs(dw)));
    if (blurLogical <= 0) return;
    const m = _resMult(blurLogical);
    const e = _lookup(`s|${_srcId(src)}|${stamp}|${color}|${blurLogical}|${m}`, () => {
        const blurBake = blurLogical * m;
        const sw = nativeW * m, sh = nativeH * m;
        const pad = _pad(blurBake);
        const { c, g, off } = _shadowCanvas(sw + pad * 2, sh + pad * 2, blurBake, color);
        g.drawImage(src, 0, 0, src.width, src.height, pad - off, pad, sw, sh);
        return { canvas: c, pad, m };
    });
    const ux = dw / (nativeW * e.m), uy = dh / (nativeH * e.m);
    _blit(ctx, e.canvas, dx - e.pad * ux, dy - e.pad * uy, e.canvas.width * ux, e.canvas.height * uy);
}

/**
 * Shadow of `ctx.arc(cx, cy, r, 0, 2π); ctx.fill()` (opaque fill) with
 * shadowBlur = blur / shadowColor = color — without the disc. `unit` is
 * screen px per logical px (worldScale); r and blur are screen px. The radius
 * is quantized to 0.5 logical px (the blur dwarfs it).
 */
export function drawDiscShadow(ctx, cx, cy, r, blur, color, unit) {
    if (!(blur > 0) || !(r > 0) || !(unit > 0)) return;
    const blurLogical = _quantBlur(blur / unit);
    if (blurLogical <= 0) return;
    const rLogical = Math.max(0.5, Math.round(r / unit * 2) / 2);
    const m = _resMult(blurLogical);
    const e = _lookup(`d|${color}|${blurLogical}|${rLogical}|${m}`, () => {
        const blurBake = blurLogical * m, rb = rLogical * m;
        const pad = _pad(blurBake);
        const size = Math.ceil(rb * 2) + pad * 2;
        const { c, g, off } = _shadowCanvas(size, size, blurBake, color);
        g.fillStyle = color;
        g.beginPath();
        g.arc(size / 2 - off, size / 2, rb, 0, Math.PI * 2);
        g.fill();
        return { canvas: c, pad, m };
    });
    const u = unit / e.m, s = e.canvas.width * u;
    _blit(ctx, e.canvas, cx - s / 2, cy - s / 2, s, s);
}

/**
 * Shadow of a butt-capped stroked segment from (x, y) of length `len` at
 * `angle` with lineWidth `lw` (opaque stroke), shadowBlur = blur — without
 * the stroke. All lengths are screen px; `unit` = worldScale. Baked
 * horizontal and drawn rotated about (x, y).
 */
export function drawSegmentShadow(ctx, x, y, angle, len, lw, blur, color, unit) {
    if (!(blur > 0) || !(len > 0) || !(lw > 0) || !(unit > 0)) return;
    const blurLogical = _quantBlur(blur / unit);
    if (blurLogical <= 0) return;
    const lenL = Math.round(len / unit * 2) / 2, lwL = Math.round(lw / unit * 2) / 2;
    const m = _resMult(blurLogical);
    const e = _lookup(`l|${color}|${blurLogical}|${lenL}|${lwL}|${m}`, () => {
        const blurBake = blurLogical * m, lb = lenL * m, wb = lwL * m;
        const pad = _pad(blurBake);
        const cw = Math.ceil(lb) + pad * 2, ch = Math.ceil(wb) + pad * 2;
        const { c, g, off } = _shadowCanvas(cw, ch, blurBake, color);
        g.strokeStyle = color;
        g.lineWidth = wb;
        g.beginPath();
        g.moveTo(pad - off, ch / 2);
        g.lineTo(pad + lb - off, ch / 2);
        g.stroke();
        return { canvas: c, pad, m };
    });
    const u = unit / e.m;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    _blit(ctx, e.canvas, -e.pad * u, -(e.canvas.height / 2) * u, e.canvas.width * u, e.canvas.height * u);
    ctx.restore();
}

// Test/introspection hook.
export function _shadowGlowStats() { return { entries: _cache.size, bytes: _bytes }; }
