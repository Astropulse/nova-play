// Camera tracks the player's world position in abstract game units.
// The player is always rendered at screen center.
// worldScale is applied here to convert game units → screen pixels.
export class Camera {
    constructor(game) {
        this.game = game;
        this.x = 0; // world-space center X (game units)
        this.y = 0; // world-space center Y (game units)
    }

    follow(target) {
        this.x = target.worldX;
        this.y = target.worldY;
    }

    // Convert world coords (game units) to screen coords (pixels)
    worldToScreen(wx, wy, canvasW, canvasH) {
        return {
            x: (wx - this.x) * this.game.worldScale + canvasW / 2,
            y: (wy - this.y) * this.game.worldScale + canvasH / 2
        };
    }

    // Convert screen coords (pixels) to world coords (game units)
    screenToWorld(sx, sy, canvasW, canvasH) {
        return {
            x: (sx - canvasW / 2) / this.game.worldScale + this.x,
            y: (sy - canvasH / 2) / this.game.worldScale + this.y
        };
    }
}
