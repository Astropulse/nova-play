// ============================================================================
// collision.js — rotated-ellipse hit tests for combat entities.
// ----------------------------------------------------------------------------
// NOTE: deliberately NOT named "hitbox.js" — that filename is on common ad/
// privacy blocker lists, so Firefox+uBlock (etc.) silently block the request and
// the web build dies with a bare "Loading failed for the module" + black screen
// (Electron/file:// is unaffected). Keep runtime module filenames neutral; see
// docs/architecture/build-assets-persistence.md → "Blocker-safe filenames".
// ----------------------------------------------------------------------------
// Enemies/bosses/hostile-events carry an ellipse hitbox fitted to their sprite
// silhouette at pack time (see scripts/lib/fit_hitbox.mjs → atlas.json
// `hitboxes`). It is axis-aligned in the sprite's own frame and centered on the
// image; at runtime we rotate it with the entity's drawn orientation so a long
// or asymmetric ship collides along its actual hull instead of inside a fat
// bounding circle (the old behavior, kept as a fallback).
//
// An entity opts in just by having `spriteKey` + `game` — the ellipse is
// resolved lazily and re-resolved whenever spriteKey changes. Per-entity knobs
// (all optional, sensible defaults for ships/bosses):
//   * hitScale   — native-px → world-unit scale (default 1; e.g. CthulhuEvent
//                  draws at this.scale, so it sets hitScale to match).
//   * hitRotOffset — added to entity.angle to get the drawn rotation
//                    (default Math.PI/2: sprite "up" = forward, like ctx.rotate
//                    (this.angle + Math.PI/2) in the ship/boss draw paths).
//   * hitRotAbs  — absolute drawn rotation, overrides angle+offset entirely
//                  (e.g. YellowOne never rotates → hitRotAbs = 0).
// A radius of 0 means "hitbox disabled" (entities use that to switch off
// collision for a phase) and is honored here.
// ============================================================================

// Resolve (and cache) the entity's ellipse from the atlas, tracking spriteKey
// changes (upgrades, variant swaps). Returns { rx, ry } in native px or null.
function resolve(e) {
    const key = e.spriteKey;
    if (e._hbKey !== key) {
        e._hbKey = key;
        e.hitEllipse = (key && e.game && e.game.assets && e.game.assets.getHitbox)
            ? e.game.assets.getHitbox(key) : null;
    }
    return e.hitEllipse;
}

// Drawn world rotation of the sprite (must match the entity's ctx.rotate).
function rotationOf(e) {
    if (e.hitRotAbs !== undefined) return e.hitRotAbs;
    return (e.angle || 0) + (e.hitRotOffset !== undefined ? e.hitRotOffset : Math.PI / 2);
}

// True if world point (px,py) lies inside the entity's hitbox, optionally grown
// by `pad` world units (use the other body's radius for circle-vs-hull tests).
// Falls back to the entity's circular `radius` when it has no ellipse.
export function ellipseContains(e, px, py, pad = 0) {
    if (e.radius === 0) return false; // hitbox disabled this phase
    const dx = px - e.worldX, dy = py - e.worldY;
    const hb = resolve(e);
    if (!hb) {
        const r = (e.radius || 0) + pad;
        return dx * dx + dy * dy <= r * r;
    }
    const s = e.hitScale != null ? e.hitScale : 1;
    const phi = rotationOf(e);
    const c = Math.cos(phi), sn = Math.sin(phi);
    // Rotate the offset into sprite-local axes (inverse of the draw rotation).
    const lx = dx * c + dy * sn;
    const ly = -dx * sn + dy * c;
    const rx = hb.rx * s + pad, ry = hb.ry * s + pad;
    if (rx <= 0 || ry <= 0) return false;
    return (lx * lx) / (rx * rx) + (ly * ly) / (ry * ry) <= 1;
}

// Swept hit test for a projectile: true if the projectile's travel segment this
// frame (proj._prevX,_prevY → proj.worldX,worldY) intersects the entity's
// hitbox grown by the projectile radius. Mirrors playingState's _projSweepHit
// but against the rotated ellipse; falls back to a circle when there's no
// ellipse. Catches fast shots that would tunnel through at low fps.
export function ellipseSweep(e, proj, pad = 0) {
    const p1x = proj.worldX, p1y = proj.worldY;
    const p0x = proj._prevX !== undefined ? proj._prevX : p1x;
    const p0y = proj._prevY !== undefined ? proj._prevY : p1y;
    if (e.radius === 0) return false;

    const hb = resolve(e);
    if (!hb) {
        const cr = (e.radius || 0) + pad;
        const dx = p1x - p0x, dy = p1y - p0y;
        const len2 = dx * dx + dy * dy;
        let t = len2 > 0 ? ((e.worldX - p0x) * dx + (e.worldY - p0y) * dy) / len2 : 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = p0x + dx * t - e.worldX, ey = p0y + dy * t - e.worldY;
        return ex * ex + ey * ey < cr * cr;
    }

    const s = e.hitScale != null ? e.hitScale : 1;
    const rx = hb.rx * s + pad, ry = hb.ry * s + pad;
    if (rx <= 0 || ry <= 0) return false;
    const phi = rotationOf(e);
    const c = Math.cos(phi), sn = Math.sin(phi);
    // Map both endpoints into a frame where the ellipse is the unit circle:
    // rotate into sprite-local axes, then divide by the (padded) half-extents.
    const norm = (x, y) => {
        const dx = x - e.worldX, dy = y - e.worldY;
        return [(dx * c + dy * sn) / rx, (-dx * sn + dy * c) / ry];
    };
    const [ax, ay] = norm(p0x, p0y);
    const [bx, by] = norm(p1x, p1y);
    const ex = bx - ax, ey = by - ay;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? -(ax * ex + ay * ey) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const mx = ax + ex * t, my = ay + ey * t;
    return mx * mx + my * my <= 1;
}
