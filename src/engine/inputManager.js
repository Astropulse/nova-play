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

import { TouchControls } from './touchControls.js';

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
// While no gamepad is connected, getGamepads() is probed only this often
// (frames) as a backstop to the 'gamepadconnected' event.
const GP_IDLE_PROBE_FRAMES = 30;
const TRIGGER_THRESHOLD = 0.35;
// Trigger hold hysteresis: a trigger counts as held once it passes
// TRIGGER_THRESHOLD and stays held until it drops below TRIGGER_RELEASE.
// isTriggerDown / isTriggerJustPressed (and the per-pad variants) all read
// this ONE tracked state, so a hold-to-use action can never see the edge fire
// and the hold fail on the next frame. (The old just-pressed used the pad's
// button boolean, which trips at a light ~0.12 pull on XInput while the hold
// needed 0.35 — a slow squeeze started the cloak and dropped it a frame later.)
const TRIGGER_RELEASE = 0.2;
const _mkTrig = () => ({ held: false, prev: false, frame: -1 });

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

        // Gamepad — the legacy top-level fields mirror the *primary* pad (first
        // connected) for single-player and UI. Per-pad state lives in `_pads`
        // so local co-op can route each controller to its own pilot.
        this.gamepadConnected = false;
        // Per-frame getGamepads() gate (see _pollGamepad). Starts true so the
        // very first update() polls once and picks up an already-exposed pad.
        this._gpPollActive = true;
        this.leftStickX = 0;
        this.leftStickY = 0;
        this.rightStickX = 0;
        this.rightStickY = 0;
        this.leftTrigger = 0;
        this.rightTrigger = 0;
        this._gpButtons = new Array(16).fill(false);
        this._gpButtonsPrev = new Array(16).fill(false);
        // Trigger hold/edge state for the mirrored "active pad" fields (see
        // _trigState). Points at the primary pad's own state objects while a
        // pad is connected, else at this pad-less pair (touch injects into the
        // top-level trigger values with no pad present).
        this._noPadTrig = { left: _mkTrig(), right: _mkTrig() };
        this._trig = this._noPadTrig;
        this._frame = 0;
        // Per-pad state: index → { connected, lx,ly,rx,ry, lt,rt, buttons[16], prev[16] }
        this._pads = [];

        // Input device tracking
        this.lastInputDevice = 'mouse';

        // Virtual cursor (synthesised from the left stick / d-pad while a UI
        // consumer has it enabled)
        this._gpCursorEnabled = false;
        this._gpVirtualMouseDown = false;
        this._gpVirtualMouseDownPrev = false;
        this._gpXPulseFrames = 0;

        this._bindEvents();

        // Touch (virtual dual-stick + pointer synthesis). Inert until Game
        // flips touch.enabled on coarse-pointer devices.
        this.touch = new TouchControls(this);
        this.touch.attach();
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
            // Convert CSS-pixel pointer coords into backing-store (physical) pixels,
            // which is the coordinate space the rest of the game renders in.
            const scaleX = rect.width ? this.canvas.width / rect.width : 1;
            const scaleY = rect.height ? this.canvas.height / rect.height : 1;
            this.mouseScreenX = (e.clientX - rect.left) * scaleX;
            this.mouseScreenY = (e.clientY - rect.top) * scaleY;

            if (this.mouseButtons.has(1)) { // Middle button
                this._accPanDeltaX += e.movementX * scaleX;
                this._accPanDeltaY += e.movementY * scaleY;
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
            this._gpPollActive = true; // resume per-frame getGamepads() polling
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
        this.touch.detach();
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
        // navigator.getGamepads() allocates fresh snapshots every call
        // (Chromium), so only hit it every frame while a pad may be present:
        // from the first 'gamepadconnected' until a poll finds none
        // connected. Otherwise probe every GP_IDLE_PROBE_FRAMES as a backstop
        // for engines that expose an already-attached pad without firing the
        // event. With polling idle, pads=null takes the exact "no pads" path
        // below (mirror zeroed each frame), which touch relies on.
        let pads = null;
        if (typeof navigator !== 'undefined' && navigator.getGamepads
            && (this._gpPollActive || (this._frame % GP_IDLE_PROBE_FRAMES) === 0)) {
            pads = navigator.getGamepads();
        }
        const len = pads ? pads.length : 0;

        let primary = -1;
        let anyActivity = false;
        for (let pi = 0; pi < len; pi++) {
            const p = pads[pi];
            let pad = this._pads[pi];
            if (!pad) {
                pad = { connected: false, lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0,
                        buttons: new Array(16).fill(false), prev: new Array(16).fill(false),
                        trig: { left: _mkTrig(), right: _mkTrig() } };
                this._pads[pi] = pad;
            }
            if (!p || !p.connected) {
                pad.connected = false;
                pad.lx = pad.ly = pad.rx = pad.ry = pad.lt = pad.rt = 0;
                for (let i = 0; i < 16; i++) pad.buttons[i] = false;
                continue;
            }
            pad.connected = true;
            if (primary < 0) primary = pi;

            pad.lx = this._applyDeadzone(p.axes[0] || 0);
            pad.ly = this._applyDeadzone(p.axes[1] || 0);
            pad.rx = this._applyDeadzone(p.axes[2] || 0);
            pad.ry = this._applyDeadzone(p.axes[3] || 0);
            const lt = p.buttons[GP.LT], rt = p.buttons[GP.RT];
            pad.lt = lt ? (lt.value || (lt.pressed ? 1 : 0)) : 0;
            pad.rt = rt ? (rt.value || (rt.pressed ? 1 : 0)) : 0;
            for (let i = 0; i < 16; i++) {
                const b = p.buttons[i];
                pad.buttons[i] = !!(b && (b.pressed || (b.value !== undefined && b.value > 0.5)));
            }
            const tilt = Math.max(Math.abs(pad.lx), Math.abs(pad.ly), Math.abs(pad.rx), Math.abs(pad.ry)) > 0.1;
            if (tilt || pad.buttons.some(Boolean) || pad.lt > 0.1 || pad.rt > 0.1) anyActivity = true;
        }

        this.gamepadConnected = primary >= 0;
        // Keep polling every frame while any pad is connected; the poll that
        // first sees none (after it marked every _pads[] entry disconnected
        // above) parks polling until the next 'gamepadconnected' / probe.
        if (pads) this._gpPollActive = primary >= 0;

        // Mirror the primary pad into the legacy top-level fields (single-player
        // + UI cursor read these).
        if (primary >= 0) {
            const pad = this._pads[primary];
            this.leftStickX = pad.lx; this.leftStickY = pad.ly;
            this.rightStickX = pad.rx; this.rightStickY = pad.ry;
            this.leftTrigger = pad.lt; this.rightTrigger = pad.rt;
            for (let i = 0; i < 16; i++) this._gpButtons[i] = pad.buttons[i];
            this._trig = pad.trig;
        } else {
            this.leftStickX = 0; this.leftStickY = 0;
            this.rightStickX = 0; this.rightStickY = 0;
            this.leftTrigger = 0; this.rightTrigger = 0;
            for (let i = 0; i < 16; i++) this._gpButtons[i] = false;
            this._trig = this._noPadTrig;
        }

        if (anyActivity) this.lastInputDevice = 'gamepad';
    }

    // Temporarily mirror a SPECIFIC pad into the legacy "active pad" fields
    // (leftStickX, _gpButtons, triggers, …) that all the single-player gamepad
    // code reads. Local co-op wraps each pilot's UI update in
    // setActivePad(theirPad) … restoreActivePad() so the EXACT single-player
    // handlers (inventory focus-stepping, dialog nav) drive that pilot's pad,
    // giving 1:1 controls without per-pad forks. Nestable-safe via a saved snapshot.
    setActivePad(i) {
        const pad = this._pads[i];
        if (!pad) return false;
        if (!this._savedActivePad) {
            this._savedActivePad = {
                lx: this.leftStickX, ly: this.leftStickY, rx: this.rightStickX, ry: this.rightStickY,
                lt: this.leftTrigger, rt: this.rightTrigger,
                btns: this._gpButtons.slice(), prev: this._gpButtonsPrev.slice(),
                trig: this._trig,
            };
        }
        this.leftStickX = pad.lx; this.leftStickY = pad.ly;
        this.rightStickX = pad.rx; this.rightStickY = pad.ry;
        this.leftTrigger = pad.lt; this.rightTrigger = pad.rt;
        for (let k = 0; k < 16; k++) { this._gpButtons[k] = pad.buttons[k]; this._gpButtonsPrev[k] = pad.prev[k]; }
        this._trig = pad.trig; // that pad's own trigger hold/edge state
        return true;
    }
    restoreActivePad() {
        const s = this._savedActivePad;
        if (!s) return;
        this.leftStickX = s.lx; this.leftStickY = s.ly; this.rightStickX = s.rx; this.rightStickY = s.ry;
        this.leftTrigger = s.lt; this.rightTrigger = s.rt;
        for (let k = 0; k < 16; k++) { this._gpButtons[k] = s.btns[k]; this._gpButtonsPrev[k] = s.prev[k]; }
        this._trig = s.trig;
        this._savedActivePad = null;
    }

    // ── Per-pad accessors (local co-op routes each controller to a pilot) ──
    padConnected(i) { const p = this._pads[i]; return !!(p && p.connected); }
    getConnectedPadIndices() {
        const out = [];
        for (let i = 0; i < this._pads.length; i++) if (this._pads[i] && this._pads[i].connected) out.push(i);
        return out;
    }
    padAxis(i, name) { const p = this._pads[i]; return p ? (p[name] || 0) : 0; }
    padButtonDown(i, btn) { const p = this._pads[i]; return !!(p && p.buttons[btn]); }
    padButtonJustPressed(i, btn) { const p = this._pads[i]; return !!(p && p.buttons[btn] && !p.prev[btn]); }
    padTrigger(i, side) { const p = this._pads[i]; if (!p) return 0; return side === 'left' ? p.lt : p.rt; }
    padTriggerDown(i, side) {
        const p = this._pads[i];
        return !!(p && this._trigState(p.trig[side], side === 'left' ? p.lt : p.rt).held);
    }
    padTriggerJustPressed(i, side) {
        const p = this._pads[i];
        if (!p) return false;
        const t = this._trigState(p.trig[side], side === 'left' ? p.lt : p.rt);
        return t.held && !t.prev;
    }

    // Called by UI consumers (inventory / pause / cache / shop) to let the
    // gamepad drive a virtual cursor. The caller should pass `false` when the
    // mode ends (release A-drag, close the UI) so nothing leaks.
    // padIndex (or null = primary) routes the virtual cursor to one controller;
    // clampRect (or null = whole canvas) confines it to a split-screen pane.
    setGamepadCursorEnabled(enabled, padIndex = null, clampRect = null) {
        if (!enabled && this._gpCursorEnabled) {
            // Ensure the synthesised button doesn't stay pressed after we leave.
            if (this._gpVirtualMouseDown) {
                this.mouseButtons.delete(0);
                this._gpVirtualMouseDown = false;
            }
        }
        this._gpCursorEnabled = enabled;
        this._gpCursorPad = enabled ? padIndex : null;
        this._gpCursorClamp = enabled ? clampRect : null;
    }

    isGamepadActive() {
        return this.gamepadConnected && this.lastInputDevice === 'gamepad';
    }

    // Touch-first device (phone/tablet). Committed per-device, not per-event —
    // used by UI code to pick tap-oriented prompt wording.
    isTouchActive() {
        return this.touch.enabled;
    }

    // Virtual-cursor driver. Called every frame while enabled; moves the
    // synthesised mouse position by the left stick / d-pad and turns A presses
    // into mouse-button toggles.
    //
    // dt is in seconds. speed is px/s at full stick deflection (default 800).
    _updateGamepadVirtualCursor(dt, speed = 800) {
        if (!this._gpCursorEnabled || !this.gamepadConnected) return;

        // Local co-op routes the cursor to a SPECIFIC pad + clamps it to that
        // pilot's pane (set via setGamepadCursorEnabled). Default: primary pad,
        // whole canvas.
        const pi = this._gpCursorPad;
        const ax = (n) => pi != null ? this.padAxis(pi, n) : this[n === 'lx' ? 'leftStickX' : n === 'ly' ? 'leftStickY' : n === 'rx' ? 'rightStickX' : 'rightStickY'];
        const btn = (b) => pi != null ? this.padButtonDown(pi, b) : this._gpButtons[b];
        const btnJP = (b) => pi != null ? this.padButtonJustPressed(pi, b) : (this._gpButtons[b] && !this._gpButtonsPrev[b]);

        // Combine left stick with d-pad (d-pad gives a constant-speed pulse).
        let dx = ax('lx') + ax('rx');
        let dy = ax('ly') + ax('ry');
        if (btn(GP.DLEFT))  dx -= 1;
        if (btn(GP.DRIGHT)) dx += 1;
        if (btn(GP.DUP))    dy -= 1;
        if (btn(GP.DDOWN))  dy += 1;

        const mag = Math.sqrt(dx * dx + dy * dy);
        if (mag > 0) {
            // Scale so deflection is throttle, clamped to 1 so stacking doesn't
            // boost past full speed.
            const scale = Math.min(1, mag);
            const nx = dx / mag;
            const ny = dy / mag;
            this.mouseScreenX += nx * scale * speed * dt;
            this.mouseScreenY += ny * scale * speed * dt;

            // Clamp to the clamp rect (pane) or the whole canvas.
            const cr = this._gpCursorClamp;
            const x0 = cr ? cr.x : 0, y0 = cr ? cr.y : 0;
            const x1 = cr ? cr.x + cr.w : this.canvas.width;
            const y1 = cr ? cr.y + cr.h : this.canvas.height;
            if (this.mouseScreenX < x0) this.mouseScreenX = x0;
            else if (this.mouseScreenX > x1) this.mouseScreenX = x1;
            if (this.mouseScreenY < y0) this.mouseScreenY = y0;
            else if (this.mouseScreenY > y1) this.mouseScreenY = y1;
        }

        // A button toggles a synthesised left-mouse-button "hold". First tap
        // presses it (pickup), next tap releases it (drop) — matching the
        // existing drag-drop contract.
        const aJustPressed = btnJP(GP.A);
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
        const xJustPressed = btnJP(GP.X);
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
        for (const pad of this._pads) {
            if (pad) for (let i = 0; i < 16; i++) pad.prev[i] = pad.buttons[i];
        }
        this._gpVirtualMouseDownPrev = this._gpVirtualMouseDown;

        // Poll hardware gamepad state so everything downstream sees the
        // latest values.
        this._frame++;
        this._pollGamepad();

        // Virtual cursor is updated before the "just pressed" diffs so that
        // synthesised presses register this frame.
        this._updateGamepadVirtualCursor(dt);

        // Touch writes into the primary-pad mirror + synthesized mouse in the
        // same window (after the poll zeroed the mirror, before the diffs).
        this.touch.update(dt);

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
    // Advances a trigger's hold state once per frame (lazily, on first read —
    // touch injects its trigger values AFTER _pollGamepad, so evaluating at
    // read time sees the injected value) and returns it. Hysteresis: press at
    // TRIGGER_THRESHOLD, release below TRIGGER_RELEASE. `held`/`prev` feed
    // both the down and the just-pressed accessors from the same source.
    _trigState(t, v) {
        if (t.frame !== this._frame) {
            t.frame = this._frame;
            t.prev = t.held;
            t.held = t.held ? v >= TRIGGER_RELEASE : v >= TRIGGER_THRESHOLD;
        }
        return t;
    }
    isTriggerDown(side) {
        return this._trigState(this._trig[side], side === 'left' ? this.leftTrigger : this.rightTrigger).held;
    }
    isTriggerJustPressed(side) {
        const t = this._trigState(this._trig[side], side === 'left' ? this.leftTrigger : this.rightTrigger);
        return t.held && !t.prev;
    }

    consumeMouseButton(button) {
        this.mouseButtons.delete(button);
        this.mouseButtonsJustPressed.delete(button);
        this._mouseButtonsPrev.add(button); // Prevent it from being "just pressed" in the next update
        if (button === 0) this._gpVirtualMouseDown = false;
    }

    // Swallow a key that a text-entry overlay (chat / dev console) just handled
    // via its own window keydown listener, so the polled gameplay logic doesn't
    // also see it as "just pressed" a frame later. Clears any pending edge and
    // seeds _keysDownPrev so the diff in update() won't re-emit it. Works whether
    // called before or after update() runs this frame.
    consumeKey(code) {
        this.keysJustPressed.delete(code);
        this._keysDownPrev.add(code);
    }
}
