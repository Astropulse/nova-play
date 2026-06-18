// Camera tracks the player's world position in abstract game units.
// The player is always rendered at the center of its viewport.
// A scale (world units → screen pixels) is applied here.
//
// Viewport + scale (split-screen groundwork):
//   By default a camera fills the whole canvas and uses the global
//   `game.worldScale` — this is the single-player / single-view case and the
//   projection math below is byte-for-byte identical to the pre-split version.
//   Set `viewport` to a screen-pixel rect ({x,y,w,h}) and/or `scale` to a
//   per-camera world scale to render this camera into a sub-rectangle (one
//   split-screen pane). When both are null the camera transparently falls back
//   to the full canvas + global scale.
export class Camera {
    constructor(game) {
        this.game = game;
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;

        // Optional split-screen overrides. null => full canvas / global scale.
        this.viewport = null; // { x, y, w, h } in screen (backing-store) pixels
        this.scale = null;    // per-camera world scale; null => game.worldScale
        // Per-camera FOV-zoom accumulator (was the global game.worldScaleModifier).
        // The owning state lerps this from the followed pilot's speed and sets
        // `scale = baseWorldScale * scaleModifier`.
        this.scaleModifier = 1.0;

        // Screen Shake
        this.shakeIntensity = 0;
        this.shakeDecay = 10.0; // Higher = shorter duration
        this.shakeX = 0;
        this.shakeY = 0;

        // Directional punch — a one-shot view kick (screen pixels) that decays
        // exponentially. Unlike shake it has a direction, so explosions can
        // visibly knock the view away from the blast.
        this.punchX = 0;
        this.punchY = 0;
    }

    /**
     * Sets (or clears) this camera's split-screen viewport rect, in screen
     * (backing-store) pixels. Pass null to revert to the full canvas.
     */
    setViewport(rect) {
        this.viewport = rect || null;
    }

    // Effective world scale for this camera (per-camera override, else global).
    _scale() { return this.scale != null ? this.scale : this.game.worldScale; }

    // Effective viewport rect for this camera (override, else full canvas).
    _vpX() { return this.viewport ? this.viewport.x : 0; }
    _vpY() { return this.viewport ? this.viewport.y : 0; }
    _vpW() { return this.viewport ? this.viewport.w : this.game.width; }
    _vpH() { return this.viewport ? this.viewport.h : this.game.height; }

    /**
     * Immediately aligns the camera's position and velocity with the target.
     * @param {object} target - The object to snap to (must have worldX, worldY, vx, vy).
     */
    snapTo(target) {
        this.x = target.worldX || 0;
        this.y = target.worldY || 0;
        this.vx = target.vx || 0;
        this.vy = target.vy || 0;
        this.displacementX = 0;
        this.displacementY = 0;
        this.punchX = 0;
        this.punchY = 0;
    }

    /**
     * Kicks the view in the direction of (dx, dy) by `strength` screen pixels.
     * Decays exponentially over ~a quarter second.
     */
    punch(dx, dy, strength) {
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        this.punchX += (dx / len) * strength;
        this.punchY += (dy / len) * strength;
    }

    /**
     * Adds shake intensity to the camera.
     * @param {number} intensity - The amount of shake to add.
     * @param {number} [decay] - Optional decay rate override.
     */
    shake(intensity, decay = 10.0) {
        this.shakeIntensity = Math.min(5.0, this.shakeIntensity + intensity);
        this.shakeDecay = decay;
    }

    /**
     * Sets a minimum shake intensity for the current frame.
     * Useful for continuous rumble that doesn't accumulate.
     * @param {number} intensity 
     */
    rumble(intensity) {
        this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
    }

    update(dt, target) {
        if (dt > 0.1) dt = 0.1;

        const targetVx = target.vx || 0;
        const targetVy = target.vy || 0;

        // Stiff velocity matching — camera lerps toward player's velocity
        const stiffness = 22.0;
        const lf = 1.0 - Math.exp(-stiffness * dt);
        this.vx += (targetVx - this.vx) * lf;
        this.vy += (targetVy - this.vy) * lf;

        // Move camera at its velocity
        this.x += this.vx * dt;
        this.y += this.vy * dt;

        // Position Correction (Spring) — gently pulls the camera toward the target's position
        // This prevents drift and handles high-speed blinks smoothly.
        const posStiffness = 8.0;
        const plf = 1.0 - Math.exp(-posStiffness * dt);
        this.x += (target.worldX - this.x) * plf;
        this.y += (target.worldY - this.y) * plf;

        // Update Screen Shake
        if (this.shakeIntensity > 0) {
            this.shakeIntensity = Math.max(0, this.shakeIntensity - this.shakeDecay * dt * 3);
            const scale = 4.5;
            this.shakeX = (Math.random() - 0.5) * this.shakeIntensity * scale;
            this.shakeY = (Math.random() - 0.5) * this.shakeIntensity * scale;
        } else {
            this.shakeX = 0;
            this.shakeY = 0;
        }

        // Decay directional punch
        if (this.punchX !== 0 || this.punchY !== 0) {
            const pd = Math.exp(-9 * dt);
            this.punchX *= pd;
            this.punchY *= pd;
            if (Math.abs(this.punchX) < 0.05 && Math.abs(this.punchY) < 0.05) {
                this.punchX = 0;
                this.punchY = 0;
            }
        }

        this.displacementX = this.x - target.worldX;
        this.displacementY = this.y - target.worldY;

        // Precompute transform constants for this frame.
        // Entities can use: screenX = wx * this.wtsScale + this.wtsOffX
        // instead of calling worldToScreen() and allocating {x,y} objects.
        // The viewport center (its rect midpoint) is where the followed target
        // is drawn; for the default full-canvas camera this is width/2,height/2.
        const scale = this._scale();
        const cx = this._vpX() + this._vpW() / 2;
        const cy = this._vpY() + this._vpH() / 2;
        this.wtsScale = scale;
        this.wtsOffX = -this.x * scale + cx + this.shakeX + this.punchX;
        this.wtsOffY = -this.y * scale + cy + this.shakeY + this.punchY;
    }

    // canvasW/canvasH are honoured only for a full-canvas camera (no viewport);
    // once a viewport rect is set the camera projects into that rect instead, so
    // the passed canvas dimensions are ignored.
    worldToScreen(wx, wy, canvasW, canvasH) {
        const scale = this._scale();
        const cx = this.viewport ? (this.viewport.x + this.viewport.w / 2) : (canvasW / 2);
        const cy = this.viewport ? (this.viewport.y + this.viewport.h / 2) : (canvasH / 2);
        return {
            x: (wx - this.x) * scale + cx + this.shakeX + this.punchX,
            y: (wy - this.y) * scale + cy + this.shakeY + this.punchY
        };
    }

    screenToWorld(sx, sy, canvasW, canvasH) {
        const scale = this._scale();
        const cx = this.viewport ? (this.viewport.x + this.viewport.w / 2) : (canvasW / 2);
        const cy = this.viewport ? (this.viewport.y + this.viewport.h / 2) : (canvasH / 2);
        return {
            x: (sx - cx) / scale + this.x,
            y: (sy - cy) / scale + this.y
        };
    }
}
