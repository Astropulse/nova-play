// Split-screen manager — local co-op groundwork (see memory project_local_coop).
//
// Owns the screen-partition layout and a pool of per-pane "render clone"
// cameras. The shared world sim still runs once; only *rendering* fans out.
// Each pane camera carries its own `viewport` rect (+ scale), so the existing
// camera-relative draw code renders that pane unchanged when clipped to the rect.
//
// Phase 1 scope: all panes follow the single local player (the cameras are pure
// clones of the primary camera with different viewports), to validate the
// layout + clipping + per-viewport WebGL/Canvas2D paths before real co-op
// players exist. Phase 2 gives each pane its own player + camera.

import { Camera } from './camera.js';

// Pick the grid (cols×rows) for a pane count, then tile the screen row-major.
// 1→full, 2→side-by-side halves, 3-4→2×2, 5-6→3×2, 7-8→4×2 (the agreed ladder).
export function splitGrid(count) {
    if (count <= 1) return { cols: 1, rows: 1 };
    if (count === 2) return { cols: 2, rows: 1 };
    if (count <= 4) return { cols: 2, rows: 2 };
    if (count <= 6) return { cols: 3, rows: 2 };
    return { cols: 4, rows: 2 };
}

// Returns `count` non-overlapping, gap-free pixel rects {x,y,w,h} tiling w×h.
// Edges are computed from rounded fractional boundaries so adjacent panes share
// an exact seam (no 1px gaps or overlaps from independent floor/ceil).
export function computeSplitLayout(count, w, h) {
    count = Math.max(1, Math.min(8, count | 0));
    const { cols, rows } = splitGrid(count);
    const rects = [];
    for (let i = 0; i < count; i++) {
        const col = i % cols;
        const row = (i / cols) | 0;
        const x0 = Math.round((col * w) / cols);
        const x1 = Math.round(((col + 1) * w) / cols);
        const y0 = Math.round((row * h) / rows);
        const y1 = Math.round(((row + 1) * h) / rows);
        rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return rects;
}

export class SplitScreenManager {
    constructor(game) {
        this.game = game;
        this.count = 1;
        this._cameras = []; // lazily grown pane camera pool
    }

    // Split rendering is engaged only with more than one pane; count===1 keeps
    // the original single-view path (byte-identical).
    get active() { return this.count > 1; }

    setCount(n) {
        this.count = Math.max(1, Math.min(8, n | 0));
        return this.count;
    }

    // Build this frame's pane views, one per local pilot. Pane 0 clones the live
    // sim camera (`primaryCamera`, already position/FOV/shake-updated this frame)
    // so the host pilot's pane keeps gameplay shake/punch. Other panes snap-follow
    // their own pilot. Each pane camera is assigned its viewport rect and its
    // fast-projection constants recomputed. Returns [{ camera, player, rect }].
    //
    // camera.update() is intentionally NOT called on these render cameras — the
    // sim camera already integrated motion; these just project. (Phase 2a uses a
    // hard snap-follow for non-host panes; smoothing/shake for them is later.)
    buildViews(localPlayers, primaryCamera) {
        const w = this.game.width, h = this.game.height;
        const n = localPlayers.length;
        const rects = computeSplitLayout(n, w, h);
        while (this._cameras.length < n) this._cameras.push(new Camera(this.game));

        const views = [];
        for (let i = 0; i < n; i++) {
            const cam = this._cameras[i];
            const slot = localPlayers[i];
            const player = slot.player;
            const r = rects[i];
            // Each pane clones its pilot's live follow camera (slot 0 = the sim
            // camera, which carries gameplay shake/punch), then adds the viewport.
            const src = slot.camera || primaryCamera;
            // FOV adapts to the (smaller) pane: scale down by the square-root of
            // the pane's area fraction so each pane is a proportionally shrunk
            // copy of the full-screen view — same world extent, ships sized
            // consistently — instead of a zoomed-in crop of a quarter-screen.
            // 2×2 → 0.5, 3×2 → 0.41, 4×2 → 0.35. Purely a render scale; the sim
            // camera (this.camera) is untouched, so gameplay/aim/audio are unchanged.
            const fovFactor = Math.sqrt((r.w * r.h) / (w * h));
            const scale = (src.scale != null ? src.scale : this.game.worldScale) * fovFactor;
            cam.x = src.x; cam.y = src.y;
            // Shake/punch: a pane feels its OWN pilot's feedback (per-pilot damage
            // shakes that pilot's slot camera) PLUS the sim camera's global shake
            // (boss/wave/cinematic spectacle is applied to the sim camera, so it
            // reaches every pane). Slot 0's camera IS the sim camera — don't add
            // it twice.
            const gShakeX = src === primaryCamera ? 0 : (primaryCamera.shakeX || 0);
            const gShakeY = src === primaryCamera ? 0 : (primaryCamera.shakeY || 0);
            const gPunchX = src === primaryCamera ? 0 : (primaryCamera.punchX || 0);
            const gPunchY = src === primaryCamera ? 0 : (primaryCamera.punchY || 0);
            cam.shakeX = src.shakeX + gShakeX; cam.shakeY = src.shakeY + gShakeY;
            cam.punchX = src.punchX + gPunchX; cam.punchY = src.punchY + gPunchY;
            cam.scale = scale;
            cam.scaleModifier = src.scaleModifier;
            cam.setViewport(r);
            // Mirror Camera.update's precompute, using this pane's viewport center.
            cam.wtsScale = scale;
            cam.wtsOffX = -cam.x * scale + (r.x + r.w / 2) + cam.shakeX + cam.punchX;
            cam.wtsOffY = -cam.y * scale + (r.y + r.h / 2) + cam.shakeY + cam.punchY;
            views.push({ camera: cam, player, rect: r });
        }
        return views;
    }
}
