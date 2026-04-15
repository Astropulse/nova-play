// Camera tracks the player's world position in abstract game units.
// The player is always rendered at screen center.
// worldScale is applied here to convert game units → screen pixels.
export class Camera {
    constructor(game) {
        this.game = game;
        this.x = 0;
        this.y = 0;
        this.vx = 0;
        this.vy = 0;

        // Screen Shake
        this.shakeIntensity = 0;
        this.shakeDecay = 10.0; // Higher = shorter duration
        this.shakeX = 0;
        this.shakeY = 0;
    }

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

        this.displacementX = this.x - target.worldX;
        this.displacementY = this.y - target.worldY;

        // Precompute transform constants for this frame.
        // Entities can use: screenX = wx * this.wtsScale + this.wtsOffX
        // instead of calling worldToScreen() and allocating {x,y} objects.
        const cw = this.game.width, ch = this.game.height;
        this.wtsScale = this.game.worldScale;
        this.wtsOffX = -this.x * this.game.worldScale + cw / 2 + this.shakeX;
        this.wtsOffY = -this.y * this.game.worldScale + ch / 2 + this.shakeY;
    }

    worldToScreen(wx, wy, canvasW, canvasH) {
        return {
            x: (wx - this.x) * this.game.worldScale + canvasW / 2 + this.shakeX,
            y: (wy - this.y) * this.game.worldScale + canvasH / 2 + this.shakeY
        };
    }

    screenToWorld(sx, sy, canvasW, canvasH) {
        return {
            x: (sx - canvasW / 2) / this.game.worldScale + this.x,
            y: (sy - canvasH / 2) / this.game.worldScale + this.y
        };
    }
}
