// Per-pilot input sources for local co-op. Each local Player reads its controls
// through one of these instead of the shared InputManager directly, so multiple
// controllers each drive their own ship. They expose exactly the surface
// Player.update consumes (see NULL_INPUT in player.js).
//
// In single-player a pilot's `input` is left null and Player falls back to the
// shared game.input (keyboard + mouse + primary pad) — unchanged behaviour.
//
// In co-op: pilot 0 = keyboard + mouse (KeyboardMouseInputSource, ignores pads),
// each additional pilot = one gamepad (GamepadInputSource, ignores kb/mouse).
import { GP } from './inputManager.js';

// Pilot driven by keyboard + mouse only (gamepad reads are inert so a pad
// assigned to another pilot can't also move this one).
export class KeyboardMouseInputSource {
    constructor(input) { this.im = input; this.usesMouseAim = true; }

    get leftStickX() { return 0; }
    get leftStickY() { return 0; }
    get rightStickX() { return 0; }
    get rightStickY() { return 0; }

    isKeyDown(c) { return this.im.isKeyDown(c); }
    isKeyJustPressed(c) { return this.im.isKeyJustPressed(c); }
    isMouseDown(b) { return this.im.isMouseDown(b); }
    isMouseJustPressed(b) { return this.im.isMouseJustPressed(b); }

    isGamepadDown() { return false; }
    isGamepadJustPressed() { return false; }
    isTriggerDown() { return false; }
    isTriggerJustPressed() { return false; }
}

// Pilot driven by a single gamepad (keyboard/mouse reads are inert so the
// shared keyboard only drives the keyboard pilot). Aims with the right stick.
export class GamepadInputSource {
    constructor(input, padIndex) {
        this.im = input;
        this.padIndex = padIndex;
        this.usesMouseAim = false; // right-stick aim; no cursor follow
    }

    get leftStickX() { return this.im.padAxis(this.padIndex, 'lx'); }
    get leftStickY() { return this.im.padAxis(this.padIndex, 'ly'); }
    get rightStickX() { return this.im.padAxis(this.padIndex, 'rx'); }
    get rightStickY() { return this.im.padAxis(this.padIndex, 'ry'); }

    isKeyDown() { return false; }
    isKeyJustPressed() { return false; }
    isMouseDown() { return false; }
    isMouseJustPressed() { return false; }

    isGamepadDown(btn) { return this.im.padButtonDown(this.padIndex, btn); }
    isGamepadJustPressed(btn) { return this.im.padButtonJustPressed(this.padIndex, btn); }
    isTriggerDown(side) { return this.im.padTriggerDown(this.padIndex, side); }
    isTriggerJustPressed(side) { return this.im.padTriggerJustPressed(this.padIndex, side); }
}

// Expose GP so callers needing button indices don't re-import inputManager.
export { GP };
