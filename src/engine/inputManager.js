// Input manager — tracks keyboard, mouse, and gamepad state.
//
// Gamepad support:
//   - Polls all connected gamepads each update() and exposes a unified stick/
//     trigger/button interface (XInput layout, standard mapping).
//   - Tracks `lastInputDevice` ('kb', 'mouse', 'gamepad'). UI code can check
//     `isGamepadActive()` to decide whether to show a virtual cursor, corner
//     selection highlights, or controller glyphs.
//   - While the gamepad is the active device AND a consumer enables virtual-
//     cursor mode via `setGamepadCursorEnabled(true)`, the left stick / d-pad
//     drives `mouseScreenX/Y` and the A button synthesises a mouseButton(0)
//     toggle (press → click+hold, press again → release). This lets the
//     existing mouse-driven drag-drop inventory code work with a controller
//     without being rewritten.

// Gamepad button indices — standard mapping:
//   0 A       1 B       2 X       3 Y
//   4 LB      5 RB      6 LT      7 RT
//   8 Back    9 Start
//  10 L-stick click 11 R-stick click
//  12 DUp 13 DDown 14 DLeft 15 DRight
export const GP = {
    A: 0, B: 1, X: 2, Y: 3,
    LB: 4, RB: 5, LT: 6, RT: 7,
    BACK: 8, START: 9,
    LSTICK: 10, RSTICK: 11,
    DUP: 12, DDOWN: 13, DLEFT: 14, DRIGHT: 15
};

const STICK_DEADZONE = 0.18;
const TRIGGER_THRESHOLD = 0.35;

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

        this._accWheelDelta = 0;
        this._accPanDeltaX = 0;
        this._accPanDeltaY = 0;

        this.mouseWheelDelta = 0;
        this.mousePanDeltaX = 0;
        this.mousePanDeltaY = 0;

        // Gamepad
        this.gamepadConnected = false;
        this.leftStickX = 0;
        this.leftStickY = 0;
        this.rightStickX = 0;
        this.rightStickY = 0;
        this.leftTrigger = 0;
        this.rightTrigger = 0;
        this._gpButtons = new Array(16).fill(false);
        this._gpButtonsPrev = new Array(16).fill(false);

        // Input device tracking
        this.lastInputDevice = 'mouse';

        // Virtual cursor (synthesised from the left stick / d-pad while a UI
        // consumer has it enabled)
        this._gpCursorEnabled = false;
        this._gpVirtualMouseDown = false;
        this._gpVirtualMouseDownPrev = false;
        this._gpXPulseFrames = 0;

        this._bindEvents();
    }

    _bindEvents() {
        this._keydownListener = (e) => {
            this.keysDown.add(e.code);
            this.lastInputDevice = 'kb';
        };
        this._keyupListener = (e) => {
            this.keysDown.delete(e.code);
            this.keysJustReleased.add(e.code);
        };
        this._mousemoveListener = (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouseScreenX = e.clientX - rect.left;
            this.mouseScreenY = e.clientY - rect.top;

            if (this.mouseButtons.has(1)) { // Middle button
                this._accPanDeltaX += e.movementX;
                this._accPanDeltaY += e.movementY;
            }
            if (Math.abs(e.movementX) + Math.abs(e.movementY) > 0) {
                this.lastInputDevice = 'mouse';
            }
        };
        this._mousedownListener = (e) => {
            this.mouseButtons.add(e.button);
            this.lastInputDevice = 'mouse';
        };
        this._mouseupListener = (e) => {
            this.mouseButtons.delete(e.button);
        };
        this._contextmenuListener = (e) => {
            e.preventDefault();
        };
        this._wheelListener = (e) => {
            this._accWheelDelta += e.deltaY;
            this.lastInputDevice = 'mouse';
        };
        this._gamepadConnectedListener = (e) => {
            this.gamepadConnected = true;
        };
        this._gamepadDisconnectedListener = (e) => {
            // Re-check on the next poll; there may still be others connected.
            this.gamepadConnected = false;
        };

        window.addEventListener('keydown', this._keydownListener);
        window.addEventListener('keyup', this._keyupListener);
        this.canvas.addEventListener('mousemove', this._mousemoveListener);
        this.canvas.addEventListener('mousedown', this._mousedownListener);
        this.canvas.addEventListener('mouseup', this._mouseupListener);
        this.canvas.addEventListener('contextmenu', this._contextmenuListener);
        this.canvas.addEventListener('wheel', this._wheelListener, { passive: true });
        window.addEventListener('gamepadconnected', this._gamepadConnectedListener);
        window.addEventListener('gamepaddisconnected', this._gamepadDisconnectedListener);
    }

    destroy() {
        window.removeEventListener('keydown', this._keydownListener);
        window.removeEventListener('keyup', this._keyupListener);
        this.canvas.removeEventListener('mousemove', this._mousemoveListener);
        this.canvas.removeEventListener('mousedown', this._mousedownListener);
        this.canvas.removeEventListener('mouseup', this._mouseupListener);
        this.canvas.removeEventListener('contextmenu', this._contextmenuListener);
        this.canvas.removeEventListener('wheel', this._wheelListener);
        window.removeEventListener('gamepadconnected', this._gamepadConnectedListener);
        window.removeEventListener('gamepaddisconnected', this._gamepadDisconnectedListener);
    }

    _applyDeadzone(v) {
        const a = Math.abs(v);
        if (a < STICK_DEADZONE) return 0;
        // Rescale so the value just outside the deadzone starts at 0.
        return Math.sign(v) * ((a - STICK_DEADZONE) / (1 - STICK_DEADZONE));
    }

    _pollGamepad() {
        const pads = (typeof navigator !== 'undefined' && navigator.getGamepads) ? navigator.getGamepads() : null;
        let active = null;
        if (pads) {
            for (const p of pads) {
                if (p && p.connected) { active = p; break; }
            }
        }
        this.gamepadConnected = !!active;

        // Reset to neutral when nothing is connected so stale values don't linger.
        if (!active) {
            this.leftStickX = 0;
            this.leftStickY = 0;
            this.rightStickX = 0;
            this.rightStickY = 0;
            this.leftTrigger = 0;
            this.rightTrigger = 0;
            for (let i = 0; i < 16; i++) this._gpButtons[i] = false;
            return;
        }

        this.leftStickX  = this._applyDeadzone(active.axes[0] || 0);
        this.leftStickY  = this._applyDeadzone(active.axes[1] || 0);
        this.rightStickX = this._applyDeadzone(active.axes[2] || 0);
        this.rightStickY = this._applyDeadzone(active.axes[3] || 0);

        // Triggers are analog on button.value in standard mapping.
        const lt = active.buttons[GP.LT];
        const rt = active.buttons[GP.RT];
        this.leftTrigger  = lt ? (lt.value || (lt.pressed ? 1 : 0)) : 0;
        this.rightTrigger = rt ? (rt.value || (rt.pressed ? 1 : 0)) : 0;

        for (let i = 0; i < 16; i++) {
            const b = active.buttons[i];
            this._gpButtons[i] = !!(b && (b.pressed || (b.value !== undefined && b.value > 0.5)));
        }

        // Detect activity for device tracking.
        const anyStickTilt = Math.max(
            Math.abs(this.leftStickX), Math.abs(this.leftStickY),
            Math.abs(this.rightStickX), Math.abs(this.rightStickY)
        ) > 0.1;
        const anyButton = this._gpButtons.some(Boolean) || this.leftTrigger > 0.1 || this.rightTrigger > 0.1;
        if (anyStickTilt || anyButton) {
            this.lastInputDevice = 'gamepad';
        }
    }

    // Called by UI consumers (inventory / pause / cache / shop) to let the
    // gamepad drive a virtual cursor. The caller should pass `false` when the
    // mode ends (release A-drag, close the UI) so nothing leaks.
    setGamepadCursorEnabled(enabled) {
        if (!enabled && this._gpCursorEnabled) {
            // Ensure the synthesised button doesn't stay pressed after we leave.
            if (this._gpVirtualMouseDown) {
                this.mouseButtons.delete(0);
                this._gpVirtualMouseDown = false;
            }
        }
        this._gpCursorEnabled = enabled;
    }

    isGamepadActive() {
        return this.gamepadConnected && this.lastInputDevice === 'gamepad';
    }

    // Virtual-cursor driver. Called every frame while enabled; moves the
    // synthesised mouse position by the left stick / d-pad and turns A presses
    // into mouse-button toggles.
    //
    // dt is in seconds. speed is px/s at full stick deflection (default 800).
    _updateGamepadVirtualCursor(dt, speed = 800) {
        if (!this._gpCursorEnabled || !this.gamepadConnected) return;

        // Combine left stick with d-pad (d-pad gives a constant-speed pulse).
        let dx = this.leftStickX + this.rightStickX;
        let dy = this.leftStickY + this.rightStickY;
        if (this._gpButtons[GP.DLEFT])  dx -= 1;
        if (this._gpButtons[GP.DRIGHT]) dx += 1;
        if (this._gpButtons[GP.DUP])    dy -= 1;
        if (this._gpButtons[GP.DDOWN])  dy += 1;

        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag > 0) {
            // Scale so deflection is throttle, clamped to 1 so stacking doesn't
            // boost past full speed.
            const scale = Math.min(1, mag);
            const nx = dx / mag;
            const ny = dy / mag;
            this.mouseScreenX += nx * scale * speed * dt;
            this.mouseScreenY += ny * scale * speed * dt;

            // Clamp to canvas so the cursor can't vanish.
            const w = this.canvas.width;
            const h = this.canvas.height;
            if (this.mouseScreenX < 0) this.mouseScreenX = 0;
            else if (this.mouseScreenX > w) this.mouseScreenX = w;
            if (this.mouseScreenY < 0) this.mouseScreenY = 0;
            else if (this.mouseScreenY > h) this.mouseScreenY = h;
        }

        // A button toggles a synthesised left-mouse-button "hold". First tap
        // presses it (pickup), next tap releases it (drop) — matching the
        // existing drag-drop contract.
        const aJustPressed = this._gpButtons[GP.A] && !this._gpButtonsPrev[GP.A];
        if (aJustPressed) {
            if (this._gpVirtualMouseDown) {
                this._gpVirtualMouseDown = false;
                this.mouseButtons.delete(0);
            } else {
                this._gpVirtualMouseDown = true;
                this.mouseButtons.add(0);
                this.mouseButtonsJustPressed.add(0);
            }
        }

        // Synthesise a right-click (consumable use) on the X button.
        const xJustPressed = this._gpButtons[GP.X] && !this._gpButtonsPrev[GP.X];
        if (xJustPressed) {
            this.mouseButtonsJustPressed.add(2);
            // Briefly hold then release — a single-frame "pulse".
            this.mouseButtons.add(2);
            this._gpXPulseFrames = 1;
        } else if (this._gpXPulseFrames > 0) {
            this._gpXPulseFrames--;
            if (this._gpXPulseFrames === 0) this.mouseButtons.delete(2);
        }
    }

    update(dt = 1 / 60) {
        // Snapshot the previous frame's gamepad state BEFORE polling so
        // consumers that call isGamepadJustPressed() after update() see a
        // true edge (current-frame pressed, prev-frame not).
        for (let i = 0; i < 16; i++) this._gpButtonsPrev[i] = this._gpButtons[i];
        this._gpVirtualMouseDownPrev = this._gpVirtualMouseDown;

        // Poll hardware gamepad state so everything downstream sees the
        // latest values.
        this._pollGamepad();

        // Virtual cursor is updated before the "just pressed" diffs so that
        // synthesised presses register this frame.
        this._updateGamepadVirtualCursor(dt);

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

        this.mouseWheelDelta = this._accWheelDelta;
        this.mousePanDeltaX = this._accPanDeltaX;
        this.mousePanDeltaY = this._accPanDeltaY;
        this._accWheelDelta = 0;
        this._accPanDeltaX = 0;
        this._accPanDeltaY = 0;
    }

    isKeyDown(code) { return this.keysDown.has(code); }
    isKeyJustPressed(code) { return this.keysJustPressed.has(code); }
    isMouseDown(button) { return this.mouseButtons.has(button); }
    isMouseJustPressed(button) { return this.mouseButtonsJustPressed.has(button); }

    // Gamepad accessors — consumers may also read the public fields directly.
    isGamepadDown(btn) { return !!this._gpButtons[btn]; }
    isGamepadJustPressed(btn) { return !!this._gpButtons[btn] && !this._gpButtonsPrev[btn]; }
    isTriggerDown(side) {
        const v = side === 'left' ? this.leftTrigger : this.rightTrigger;
        return v >= TRIGGER_THRESHOLD;
    }
    isTriggerJustPressed(side) {
        const v = side === 'left' ? this.leftTrigger : this.rightTrigger;
        // Edge: was-below → now-above. We approximate by using the button
        // boolean which is what _gpButtons[GP.LT|RT] tracks.
        const idx = side === 'left' ? GP.LT : GP.RT;
        return !!this._gpButtons[idx] && !this._gpButtonsPrev[idx];
    }

    consumeMouseButton(button) {
        this.mouseButtons.delete(button);
        this.mouseButtonsJustPressed.delete(button);
        this._mouseButtonsPrev.add(button); // Prevent it from being "just pressed" in the next update
        if (button === 0) this._gpVirtualMouseDown = false;
    }
}
