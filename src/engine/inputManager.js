// Input manager — tracks keyboard and mouse state
export class InputManager {
    constructor(canvas) {
        this.canvas = canvas;

        // Keyboard
        this.keysDown = new Set();
        this.keysJustPressed = new Set();
        this.keysJustReleased = new Set();
        this._keysDownPrev = new Set();

        // Mouse (screen pixels)
        this.mouseScreenX = 0;
        this.mouseScreenY = 0;
        this.mouseButtons = new Set();
        this.mouseButtonsJustPressed = new Set();
        this._mouseButtonsPrev = new Set();

        this._bindEvents();
    }

    _bindEvents() {
        window.addEventListener('keydown', (e) => {
            this.keysDown.add(e.code);
        });
        window.addEventListener('keyup', (e) => {
            this.keysDown.delete(e.code);
            this.keysJustReleased.add(e.code);
        });

        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseScreenX = e.clientX - rect.left;
            this.mouseScreenY = e.clientY - rect.top;
        });
        this.canvas.addEventListener('mousedown', (e) => {
            this.mouseButtons.add(e.button);
        });
        this.canvas.addEventListener('mouseup', (e) => {
            this.mouseButtons.delete(e.button);
        });
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }

    update() {
        this.keysJustPressed.clear();
        for (const key of this.keysDown) {
            if (!this._keysDownPrev.has(key)) {
                this.keysJustPressed.add(key);
            }
        }
        this._keysDownPrev = new Set(this.keysDown);

        this.mouseButtonsJustPressed.clear();
        for (const btn of this.mouseButtons) {
            if (!this._mouseButtonsPrev.has(btn)) {
                this.mouseButtonsJustPressed.add(btn);
            }
        }
        this._mouseButtonsPrev = new Set(this.mouseButtons);

        this.keysJustReleased.clear();
    }

    isKeyDown(code) { return this.keysDown.has(code); }
    isKeyJustPressed(code) { return this.keysJustPressed.has(code); }
    isMouseDown(button) { return this.mouseButtons.has(button); }
    isMouseJustPressed(button) { return this.mouseButtonsJustPressed.has(button); }

    consumeMouseButton(button) {
        this.mouseButtons.delete(button);
        this.mouseButtonsJustPressed.delete(button);
        this._mouseButtonsPrev.add(button); // Prevent it from being "just pressed" in the next update
    }
}
