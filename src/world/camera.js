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

        this.displacementX = this.x - target.worldX;
        this.displacementY = this.y - target.worldY;
    }

    worldToScreen(wx, wy, canvasW, canvasH) {
        return {
            x: (wx - this.x) * this.game.worldScale + canvasW / 2,
            y: (wy - this.y) * this.game.worldScale + canvasH / 2
        };
    }

    screenToWorld(sx, sy, canvasW, canvasH) {
        return {
            x: (sx - canvasW / 2) / this.game.worldScale + this.x,
            y: (sy - canvasH / 2) / this.game.worldScale + this.y
        };
    }
}
