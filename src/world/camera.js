// Camera tracks the player's world position (in screen pixels).
// The player is always rendered at screen center.
export class Camera {
    constructor() {
        this.x = 0; // world-space center X (screen pixels)
        this.y = 0; // world-space center Y (screen pixels)
    }

    follow(target) {
        this.x = target.worldX;
        this.y = target.worldY;
    }

    // Convert world coords to screen coords
    worldToScreen(wx, wy, canvasW, canvasH) {
        return {
            x: wx - this.x + canvasW / 2,
            y: wy - this.y + canvasH / 2
        };
    }

    // Convert screen coords to world coords
    screenToWorld(sx, sy, canvasW, canvasH) {
        return {
            x: sx + this.x - canvasW / 2,
            y: sy + this.y - canvasH / 2
        };
    }
}
