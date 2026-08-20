// Rebindable controls — keyboard keys, mouse buttons, and the touch-control
// layout — persisted to localStorage (`nova_controls`).
//
// Same shape as engine/settings.js: a module-level singleton so consumers
// (player.js, playingState.js, touchControls.js, menuState's controls list)
// read the LIVE binding objects directly instead of threading `game` through.
// Gameplay code references `KEYS.<action>` / `MOUSE.<action>` instead of
// hardcoded codes; `touchAnchor(id)` resolves a touch control's normalized
// screen position (player override or default). The SettingsState CONTROLS
// tab is the UI over this module.
//
// Gamepad bindings are deliberately NOT rebindable (fixed standard mapping).
// Every default preserves the pre-bindings behavior exactly.

// ── Keyboard ────────────────────────────────────────────────────────────────
// One primary code per action (KeyboardEvent.code). Hardcoded alternates
// (arrow keys for thrust, right-shift for shield) stay only while the action
// is on its default, so a rebind fully owns the action.
export const KEY_ACTIONS = [
    { id: 'thrustFwd',  label: 'THRUST FORWARD',   def: 'KeyW' },
    { id: 'thrustBack', label: 'THRUST BACK',      def: 'KeyS' },
    { id: 'moveLeft',   label: 'MOVE LEFT',        def: 'KeyA' },
    { id: 'moveRight',  label: 'MOVE RIGHT',       def: 'KeyD' },
    { id: 'rotateCCW',  label: 'ROTATE CCW',       def: 'KeyJ' },
    { id: 'rotateCW',   label: 'ROTATE CW',        def: 'KeyL' },
    { id: 'boost',      label: 'BOOST / TELEPORT', def: 'Space' },
    { id: 'shoot',      label: 'SHOOT (KEY)',      def: 'KeyI' },
    { id: 'shield',     label: 'SHIELD (KEY)',     def: 'ShiftLeft' },
    { id: 'interact',   label: 'INTERACT',         def: 'KeyE' },
    { id: 'heal',       label: 'USE BATTERY',      def: 'KeyQ' },
];

// ── Mouse ───────────────────────────────────────────────────────────────────
// Button indices: 0 left, 1 middle, 2 right. Middle also pans the inventory —
// assigning combat to it is allowed but the pan stays.
export const MOUSE_ACTIONS = [
    { id: 'shoot',  label: 'SHOOT',  def: 0 },
    { id: 'shield', label: 'SHIELD', def: 2 },
];

// ── Touch layout ────────────────────────────────────────────────────────────
// Normalized anchor positions (x = fraction of canvas width, y = of height)
// for every positionable touch control. Sizes stay fixed (u-relative) in
// touchControls._layout(); only the anchors move. Defaults mirror the
// original hardcoded layout exactly.
export const TOUCH_ANCHORS = [
    { id: 'lHome',        label: 'L-STICK',      x: 0.14, y: 0.74 },
    { id: 'rHome',        label: 'R-STICK',      x: 0.86, y: 0.74 },
    { id: 'shieldToggle', label: 'SHIELD',       x: 0.27, y: 0.60 },
    { id: 'shield',       label: 'HOLD SHIELD',  x: 0.87, y: 0.48 },
    { id: 'pause',        label: 'PAUSE',        x: 0.73, y: 0.60 },
    { id: 'heal',         label: 'HEAL',         x: 0.64, y: 0.74 },
    { id: 'interact',     label: 'INTERACT',     x: 0.76, y: 0.32 },
];

// Anchors clamp inside this margin so a dragged control can never leave the
// screen (or sit half under a display notch).
const ANCHOR_MIN = 0.04;
const ANCHOR_MAX = 0.96;

const STORAGE_KEY = 'nova_controls';

// Live binding state. Mutate only through the setters below so every change
// persists and conflicts resolve.
export const KEYS = {};   // action id → KeyboardEvent.code
export const MOUSE = {};  // action id → mouse button (0|1|2)
export const TOUCH = {};  // anchor id → { x, y } override (absent = default)

function _defaults() {
    for (const a of KEY_ACTIONS) KEYS[a.id] = a.def;
    for (const a of MOUSE_ACTIONS) MOUSE[a.id] = a.def;
    for (const k of Object.keys(TOUCH)) delete TOUCH[k];
}
_defaults();

export function loadBindings() {
    _defaults();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data.keys) {
            for (const a of KEY_ACTIONS) {
                const c = data.keys[a.id];
                if (typeof c === 'string' && c && c !== 'Escape') KEYS[a.id] = c;
            }
        }
        if (data.mouse) {
            for (const a of MOUSE_ACTIONS) {
                const b = data.mouse[a.id];
                if (b === 0 || b === 1 || b === 2) MOUSE[a.id] = b;
            }
        }
        if (data.touch) {
            for (const anchor of TOUCH_ANCHORS) {
                const p = data.touch[anchor.id];
                if (p && typeof p.x === 'number' && typeof p.y === 'number') {
                    TOUCH[anchor.id] = {
                        x: Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, p.x)),
                        y: Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, p.y)),
                    };
                }
            }
        }
    } catch (e) { /* no storage / corrupt JSON — keep defaults */ }
}

export function saveBindings() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            keys: KEYS, mouse: MOUSE, touch: TOUCH,
        }));
    } catch (e) { /* no storage */ }
}

// Bind `code` to `actionId`. If another action already holds that code, the
// two actions SWAP keys (no binding can silently die). Escape is reserved
// (pause/close everywhere). Returns true when the binding changed.
export function setKeyBinding(actionId, code) {
    if (!(actionId in KEYS) || typeof code !== 'string' || !code) return false;
    if (code === 'Escape') return false;
    const old = KEYS[actionId];
    if (old === code) return false;
    for (const id of Object.keys(KEYS)) {
        if (id !== actionId && KEYS[id] === code) KEYS[id] = old;
    }
    KEYS[actionId] = code;
    saveBindings();
    return true;
}

// Same swap semantics for the mouse buttons.
export function setMouseBinding(actionId, button) {
    if (!(actionId in MOUSE) || (button !== 0 && button !== 1 && button !== 2)) return false;
    const old = MOUSE[actionId];
    if (old === button) return false;
    for (const id of Object.keys(MOUSE)) {
        if (id !== actionId && MOUSE[id] === button) MOUSE[id] = old;
    }
    MOUSE[actionId] = button;
    saveBindings();
    return true;
}

// Move a touch control's anchor (normalized coords, clamped on-screen).
export function setTouchAnchor(id, x, y) {
    if (!TOUCH_ANCHORS.some(a => a.id === id)) return false;
    TOUCH[id] = {
        x: Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, x)),
        y: Math.min(ANCHOR_MAX, Math.max(ANCHOR_MIN, y)),
    };
    saveBindings();
    return true;
}

// Resolve a touch anchor: player override or the shipped default.
export function touchAnchor(id) {
    const o = TOUCH[id];
    if (o) return o;
    const d = TOUCH_ANCHORS.find(a => a.id === id);
    return d ? { x: d.x, y: d.y } : { x: 0.5, y: 0.5 };
}

export function resetKeyBindings() {
    for (const a of KEY_ACTIONS) KEYS[a.id] = a.def;
    saveBindings();
}

export function resetMouseBindings() {
    for (const a of MOUSE_ACTIONS) MOUSE[a.id] = a.def;
    saveBindings();
}

export function resetTouchLayout() {
    for (const k of Object.keys(TOUCH)) delete TOUCH[k];
    saveBindings();
}

// ── Display labels ──────────────────────────────────────────────────────────
const KEY_LABELS = {
    Space: 'SPACE',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT',
    ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
    AltLeft: 'L-ALT', AltRight: 'R-ALT',
    ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
    Tab: 'TAB', Enter: 'ENTER', Backspace: 'BKSP', CapsLock: 'CAPS',
    Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
};

// Human-readable label for a KeyboardEvent.code ('KeyW' → 'W', 'Space' →
// 'SPACE', 'Digit3' → '3', unknown codes uppercased as-is).
export function keyLabel(code) {
    if (!code) return '?';
    if (KEY_LABELS[code]) return KEY_LABELS[code];
    if (code.startsWith('Key')) return code.slice(3).toUpperCase();
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6).toUpperCase();
    return code.toUpperCase();
}

// 'L-MB' / 'M-MB' / 'R-MB' — the compact style the menu controls list uses.
export function mouseLabel(button) {
    return button === 0 ? 'L-MB' : button === 1 ? 'M-MB' : 'R-MB';
}
