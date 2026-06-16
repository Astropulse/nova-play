// ============================================================================
// fit_hitbox.mjs — fit axis-aligned ellipse hitboxes to a sprite's pixels.
// ----------------------------------------------------------------------------
// Given a sprite's RGBA buffer, computes two ellipses, BOTH centered on the
// image center (cx = w/2, cy = h/2), as required:
//
//   * OUTER — the minimum-area ellipse that still contains every opaque pixel.
//             (No part of the ship sticks outside it.)
//   * INNER — the maximum-area ellipse that contains only solid hull — it never
//             crosses into background. (Every point inside it is on the ship.)
//
// Both are axis-aligned in the sprite's own frame (rx along sprite-x, ry along
// sprite-y); the runtime rotates them with the ship's facing. The "true"
// collision shape lives between the two — a caller can blend (e.g. 0.5) to get
// a fair hitbox that is neither stingy nor generous.
//
// Why ellipses (not the current single circle): a long/asymmetric ship gets a
// circle sized to its farthest pixel, so it collides in empty space. An ellipse
// tracks the silhouette's two principal extents instead.
//
// Method: with the center fixed, an axis-aligned ellipse is
//   (dx/rx)^2 + (dy/ry)^2 = 1   <=>   a*dx^2 + b*dy^2 = 1   (a=1/rx^2, b=1/ry^2)
// so each pixel is a point (u,v) = (dx^2, dy^2) and the ellipse is a line
// a*u + b*v = 1 in (u,v) space. Fitting reduces to a 1-D search over the aspect
// ratio r = b/a, evaluated only against the relevant Pareto frontier of points.
// ============================================================================

const ALPHA_THRESHOLD = 25; // matches the runtime CollisionScanner cutoff

// Classify every pixel and flood-fill the background so that fully-enclosed
// holes (cockpit gaps, etc.) count as solid hull, not as forbidden background.
// Returns { cx, cy, opaque:[{dx,dy}], background:[{dx,dy}], w, h }.
function classify(rgba, w, h) {
    const cx = w / 2, cy = h / 2;
    const solid = new Uint8Array(w * h); // 1 = opaque
    for (let i = 0; i < w * h; i++) solid[i] = rgba[i * 4 + 3] > ALPHA_THRESHOLD ? 1 : 0;

    // Background = transparent pixels reachable from the border (4-conn flood).
    // Enclosed transparent regions are therefore NOT background → treated solid.
    const bg = new Uint8Array(w * h);
    const stack = [];
    const push = (x, y) => {
        const idx = y * w + x;
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        if (solid[idx] || bg[idx]) return;
        bg[idx] = 1; stack.push(idx);
    };
    for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
    for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
    while (stack.length) {
        const idx = stack.pop();
        const x = idx % w, y = (idx - x) / w;
        push(x - 1, y); push(x + 1, y); push(x, y - 1); push(x, y + 1);
    }

    const opaque = [], background = [];
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const idx = y * w + x;
            // Use pixel centers so the geometry is symmetric about the image center.
            const dx = (x + 0.5) - cx;
            const dy = (y + 0.5) - cy;
            if (solid[idx]) opaque.push({ dx, dy });
            else if (bg[idx]) background.push({ dx, dy });
        }
    }
    return { cx, cy, opaque, background, w, h };
}

// Upper-right Pareto frontier of (u,v): keep points not dominated from above.
// These are the only candidates that can bind the OUTER (containment) fit.
function upperFrontier(pts) {
    pts.sort((p, q) => q.u - p.u || q.v - p.v);
    const out = [];
    let maxV = -Infinity;
    for (const p of pts) {
        if (p.v > maxV) { out.push(p); maxV = p.v; }
    }
    return out;
}

// Lower-left Pareto frontier of (u,v): keep points not dominated from below.
// These are the only candidates that can bind the INNER (exclusion) fit.
function lowerFrontier(pts) {
    pts.sort((p, q) => p.u - q.u || p.v - q.v);
    const out = [];
    let minV = Infinity;
    for (const p of pts) {
        if (p.v < minV) { out.push(p); minV = p.v; }
    }
    return out;
}

// 1-D search over aspect ratio r = b/a (log-spaced coarse scan + local refine).
// `objective(r)` returns the area-proxy a*b to be maximized.
function searchRatio(objective) {
    let bestR = 1, bestF = -Infinity;
    const LO = -8, HI = 8; // r in [e^-8, e^8] ≈ [3e-4, 3e3]
    const N = 400;
    for (let i = 0; i <= N; i++) {
        const r = Math.exp(LO + (HI - LO) * (i / N));
        const f = objective(r);
        if (f > bestF) { bestF = f; bestR = r; }
    }
    // Golden-section refine in the decade around the coarse winner.
    let lo = bestR / Math.exp((HI - LO) / N);
    let hi = bestR * Math.exp((HI - LO) / N);
    const gr = (Math.sqrt(5) - 1) / 2;
    let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo);
    for (let i = 0; i < 60; i++) {
        if (objective(c) > objective(d)) { hi = d; d = c; c = hi - gr * (hi - lo); }
        else { lo = c; c = d; d = lo + gr * (hi - lo); }
    }
    const r = (lo + hi) / 2;
    return { r, f: objective(r) };
}

// Smallest centered axis-aligned ellipse containing every opaque pixel.
function fitOuter(opaque, w, h) {
    if (!opaque.length) return { rx: 0, ry: 0 };
    const frontier = upperFrontier(opaque.map(p => ({ u: p.dx * p.dx, v: p.dy * p.dy })));
    // For ratio r, tightest scale: a = 1 / max_i(u + r·v); area-proxy a*b = r·a^2.
    const objective = (r) => {
        let mx = 0;
        for (const p of frontier) { const e = p.u + r * p.v; if (e > mx) mx = e; }
        return mx > 0 ? r / (mx * mx) : 0;
    };
    const { r } = searchRatio(objective);
    let mx = 0;
    for (const p of frontier) { const e = p.u + r * p.v; if (e > mx) mx = e; }
    const a = 1 / mx, b = r * a;
    return { rx: Math.sqrt(1 / a), ry: Math.sqrt(1 / b) };
}

// Largest centered axis-aligned ellipse that excludes all background pixels
// (and stays within the image). Maximizes area = minimizes a*b.
function fitInner(background, w, h) {
    // Virtual forbidden points at the image-edge midpoints bound the ellipse to
    // the sprite frame even when the hull runs to the image edge.
    const pts = background.map(p => ({ u: p.dx * p.dx, v: p.dy * p.dy }));
    pts.push({ u: (w / 2) * (w / 2), v: 0 });
    pts.push({ u: 0, v: (h / 2) * (h / 2) });
    const frontier = lowerFrontier(pts);
    // For ratio r, tightest scale: a = 1 / min_i(u + r·v); we MINIMIZE a*b = r·a^2,
    // so maximize its negative to reuse searchRatio.
    const objective = (r) => {
        let mn = Infinity;
        for (const p of frontier) { const e = p.u + r * p.v; if (e < mn) mn = e; }
        return mn > 0 ? -(r / (mn * mn)) : -Infinity;
    };
    const { r } = searchRatio(objective);
    let mn = Infinity;
    for (const p of frontier) { const e = p.u + r * p.v; if (e < mn) mn = e; }
    const a = 1 / mn, b = r * a;
    return { rx: Math.sqrt(1 / a), ry: Math.sqrt(1 / b) };
}

// Current runtime behavior, for comparison: circle = max dist center→opaque.
function fitCircle(opaque) {
    let m = 0;
    for (const p of opaque) { const d = p.dx * p.dx + p.dy * p.dy; if (d > m) m = d; }
    return Math.sqrt(m);
}

// Main entry: returns the full fit for one sprite.
//   blend (0..1): 0 = inner, 1 = outer, 0.5 = midway (suggested hitbox).
export function fitHitbox(rgba, w, h, blend = 0.5) {
    const { cx, cy, opaque, background } = classify(rgba, w, h);
    const outer = fitOuter(opaque, w, h);
    const inner = fitInner(background, w, h);
    const circle = fitCircle(opaque);
    const hit = {
        rx: inner.rx + (outer.rx - inner.rx) * blend,
        ry: inner.ry + (outer.ry - inner.ry) * blend,
    };
    return { w, h, cx, cy, circle, inner, outer, hit, opaqueCount: opaque.length };
}
