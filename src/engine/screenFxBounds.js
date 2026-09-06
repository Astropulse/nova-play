// Conservative output and source rectangles for the unchanged ScreenFX shader.
// Coordinates are Canvas pixels (top-down). Keep this in sync with screenFx.js.
// Gaussian boost/collapse tails and their GLOBAL chromatic aberration are never
// clipped: only an exact identity pane or the compact shield mask can skip output.
export function effectIsActive(fx, k) {
    return (fx.crt || 0) * k > 0.004 || (fx.warp || 0) * k > 0.004
        || !!(fx.ripple && fx.ripple.strength * k > 0.004)
        || !!(fx.flow && fx.flow.strength * k > 0.004)
        || !!(fx.collapse && fx.collapse.strength * k > 0.004);
}

function intersect(x0, y0, x1, y1, w, h) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(w, Math.ceil(x1)); y1 = Math.min(h, Math.ceil(y1));
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function effectBounds(fx, pane, w, h, k = 1) {
    // Match renderPanes' original GL scissor rounding, including odd canvases.
    const x = Math.round(pane.x), pw = Math.round(pane.w), ph = Math.round(pane.h);
    const y = h - (Math.round(h - pane.y - pane.h) + ph);
    const full = intersect(x, y, x + pw, y + ph, w, h);
    if (!full) return null;
    const all = { draw: full, source: { x: 0, y: 0, w, h } };
    const crt = Math.min(1, (fx.crt || 0) * k);
    const warp = Math.min(1, (fx.warp || 0) * k);
    const ripple = fx.ripple && fx.ripple.strength * k > 0.004 ? fx.ripple : null;
    const flow = fx.flow && fx.flow.strength * k > 0.004 ? fx.flow : null;
    const collapse = fx.collapse && fx.collapse.strength * k > 0.004 ? fx.collapse : null;
    const flowStr = flow ? Math.hypot(flow.dirX, flow.dirY) * flow.strength * k : 0;
    const collapseStr = collapse ? collapse.strength * k : 0;
    if (![crt, warp, flowStr, collapseStr, pane.w, pane.h].every(Number.isFinite)
        || pane.w <= 0 || pane.h <= 0) return all;

    let draw = full;
    if (crt === 0 && warp === 0 && flowStr === 0 && collapseStr === 0) {
        if (!ripple) return null; // exact identity; expose the original Canvas
        if (!(ripple.r > 0) || ![ripple.r, ripple.cx, ripple.cy].every(Number.isFinite)) return all;
        // The shield's smoothstep mask is exactly zero outside 1.2*r.
        // Two guard pixels cover raster/float roundoff; no Gaussian tail is cut.
        const r = ripple.r * 1.2 + 2;
        draw = intersect(Math.max(full.x, ripple.cx - r), Math.max(full.y, ripple.cy - r),
            Math.min(full.x + full.w, ripple.cx + r), Math.min(full.y + full.h, ripple.cy + r), w, h);
        if (!draw) return null;
    }

    // Bound displacement in pixels before chromatic scaling.
    // CRT: |(1+k*r2)*(1-.6*k)-1| <= 1.6*|k| + .6*k*k for 0<=r2<=1.
    // Extra margin covers fractional pane boundaries (up to one pixel).
    const barrel = 0.085 * 1.06 * Math.abs(crt);
    const stretch = 1.6 * barrel + 0.6 * barrel * barrel;
    let dx = (pane.w * 0.5 + 2) * stretch;
    let dy = (pane.h * 0.5 + 2) * stretch;
    if (warp > 0.001) { dx += pane.w * 0.023 * warp; dy += pane.h * 0.0065 * warp; }
    if (ripple) { dx += 5 * ripple.strength * k; dy += 5 * ripple.strength * k; }
    if (flowStr > 0.001) {
        // max d*exp(-d*d/R*R) = R/sqrt(2e). Bound both vector terms
        // separately, plus the constant drag (deliberately conservative).
        const R = 0.30 * Math.min(pane.w, pane.h);
        const d = R * (0.44 / Math.sqrt(2 * Math.E) + 0.13) * flowStr;
        dx += d; dy += d;
    }
    if (collapse) {
        if (!(collapse.r > 0)) return all;
        const d = collapseStr * Math.min(collapse.r * 0.08, 42);
        dx += d; dy += d;
    }
    const chroma = 0.011 * Math.abs(crt) + 0.004 * Math.abs(warp)
        + 0.002 * flowStr + 0.003 * collapseStr * Math.abs(collapse?.ab ?? 1);
    dx = dx * (1 + chroma) + (pane.w * 0.5 + 2) * chroma + 4;
    dy = dy * (1 + chroma) + (pane.h * 0.5 + 2) * chroma + 4;
    if (![dx, dy].every(Number.isFinite)) return all;
    const source = intersect(draw.x - dx, draw.y - dy, draw.x + draw.w + dx, draw.y + draw.h + dy, w, h);
    return { draw, source };
}

export function unionRect(a, b) {
    if (!a) return { ...b };
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// Upload planning: turn the per-effect source rects into the set of rects to
// texSubImage2D. Every input pixel ends up inside some output rect (no
// sampled texel can be stale), contained rects are dropped, and two rects are
// merged only when one upload of their union costs no more than about the two
// separate uploads (their overlap counted twice) plus a per-call allowance —
// so distant shield hits in different panes stay separate instead of copying
// the whole span between them, while dense/global effects still collapse to
// one big (or whole-frame) upload. More than MAX_UPLOAD_RECTS survivors fall
// back to a single union: many small calls can each cost a Canvas sync.
export const MAX_UPLOAD_RECTS = 8;
const MERGE_CALL_ALLOWANCE_PX = 96 * 96;
export function mergeUploadRects(rects) {
    const out = [];
    for (const r of rects) if (r && r.w > 0 && r.h > 0) out.push({ x: r.x, y: r.y, w: r.w, h: r.h });
    const area = (r) => r.w * r.h;
    const contains = (a, b) => b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
    const overlapArea = (a, b) => {
        const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return w > 0 && h > 0 ? w * h : 0;
    };
    let merged = true;
    while (merged && out.length > 1) {
        merged = false;
        outer: for (let i = 0; i < out.length; i++) {
            for (let j = i + 1; j < out.length; j++) {
                const a = out[i], b = out[j];
                let u = null;
                if (contains(a, b)) u = a;
                else if (contains(b, a)) u = b;
                else {
                    const cand = unionRect(a, b);
                    // Separate cost = both uploads (overlap paid twice) + a call.
                    if (area(cand) <= area(a) + area(b) + overlapArea(a, b) + MERGE_CALL_ALLOWANCE_PX) u = cand;
                }
                if (u) {
                    out.splice(j, 1);
                    out[i] = u;
                    merged = true;
                    break outer;
                }
            }
        }
    }
    if (out.length > MAX_UPLOAD_RECTS) return [out.reduce(unionRect, null)];
    return out;
}
