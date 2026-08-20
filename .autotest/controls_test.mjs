// Deterministic, headless test of the rebindable-controls system
// (engine/controlBindings.js): defaults, swap-on-conflict rebinding for keys
// and mouse buttons, the Escape reservation, touch-anchor clamping +
// resolution, persistence round-trip, corrupt-store tolerance, per-scope
// resets, and the display-label helpers.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/controls_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

globalThis.window ||= {};
globalThis.document ||= { createElement: () => ({ getContext: () => ({}) }) };
globalThis.navigator ||= { getGamepads: () => [] };
globalThis.localStorage ||= {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const {
  KEY_ACTIONS, MOUSE_ACTIONS, TOUCH_ANCHORS,
  KEYS, MOUSE, TOUCH, touchAnchor,
  loadBindings, setKeyBinding, setMouseBinding, setTouchAnchor,
  resetKeyBindings, resetMouseBindings, resetTouchLayout,
  keyLabel, mouseLabel,
} = await import('../src/engine/controlBindings.js');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Defaults preserve pre-bindings behavior');
{
  ok('thrust W/S', KEYS.thrustFwd === 'KeyW' && KEYS.thrustBack === 'KeyS');
  ok('rotate J/L', KEYS.rotateCCW === 'KeyJ' && KEYS.rotateCW === 'KeyL');
  ok('boost Space, shoot I, shield L-shift, interact E',
     KEYS.boost === 'Space' && KEYS.shoot === 'KeyI'
     && KEYS.shield === 'ShiftLeft' && KEYS.interact === 'KeyE');
  ok('mouse shoot=LMB shield=RMB', MOUSE.shoot === 0 && MOUSE.shield === 2);
  ok('no touch overrides', Object.keys(TOUCH).length === 0);
  ok('touchAnchor serves defaults', touchAnchor('pause').x === 0.73 && touchAnchor('pause').y === 0.60);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Key rebinding — swap-on-conflict, Escape reserved');
{
  ok('simple rebind', setKeyBinding('boost', 'KeyB') === true && KEYS.boost === 'KeyB');
  ok('same code is a no-op', setKeyBinding('boost', 'KeyB') === false);
  // Bind interact to the shoot key → the two actions swap.
  const shootWas = KEYS.shoot, interactWas = KEYS.interact;
  setKeyBinding('interact', shootWas);
  ok('conflict swaps both actions', KEYS.interact === shootWas && KEYS.shoot === interactWas);
  ok('Escape refused', setKeyBinding('boost', 'Escape') === false && KEYS.boost === 'KeyB');
  ok('unknown action refused', setKeyBinding('warpDrive', 'KeyZ') === false && !('warpDrive' in KEYS));
  ok('no duplicate codes after swaps',
     new Set(Object.values(KEYS)).size === Object.keys(KEYS).length);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Mouse rebinding — swap-on-conflict');
{
  setMouseBinding('shoot', 2); // takes shield's button → shield gets old shoot button
  ok('conflict swaps buttons', MOUSE.shoot === 2 && MOUSE.shield === 0);
  ok('middle allowed', setMouseBinding('shield', 1) === true && MOUSE.shield === 1);
  ok('invalid button refused', setMouseBinding('shoot', 5) === false && MOUSE.shoot === 2);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Touch anchors — clamped, resolved, resettable');
{
  setTouchAnchor('pause', 1.4, -0.2);
  ok('anchor clamps on-screen', TOUCH.pause.x === 0.96 && TOUCH.pause.y === 0.04);
  setTouchAnchor('heal', 0.5, 0.5);
  ok('override resolves', touchAnchor('heal').x === 0.5 && touchAnchor('heal').y === 0.5);
  ok('unknown anchor refused', setTouchAnchor('warpButton', 0.5, 0.5) === false);
  ok('unmoved anchors keep defaults', touchAnchor('lHome').x === 0.14);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 5. Persistence round-trip + corrupt store');
{
  loadBindings(); // reload from the store the setters wrote
  ok('keys survive reload', KEYS.boost === 'KeyB');
  ok('mouse survives reload', MOUSE.shoot === 2 && MOUSE.shield === 1);
  ok('touch survives reload', touchAnchor('heal').x === 0.5);

  localStorage.setItem('nova_controls', '{broken');
  loadBindings();
  ok('corrupt JSON → defaults', KEYS.boost === 'Space' && MOUSE.shoot === 0
     && Object.keys(TOUCH).length === 0);

  localStorage.setItem('nova_controls', JSON.stringify({
    keys: { boost: 'Escape', shoot: 42, interact: 'KeyQ' },
    mouse: { shoot: 7, shield: 1 },
    touch: { pause: { x: 2, y: 0.5 }, heal: { x: 'a', y: 0.5 } },
  }));
  loadBindings();
  ok('Escape/typed-wrong keys skipped, valid kept',
     KEYS.boost === 'Space' && KEYS.shoot === 'KeyI' && KEYS.interact === 'KeyQ');
  ok('invalid mouse skipped, valid kept', MOUSE.shoot === 0 && MOUSE.shield === 1);
  ok('touch overrides validated + clamped',
     TOUCH.pause.x === 0.96 && TOUCH.heal === undefined);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 6. Per-scope resets');
{
  setKeyBinding('boost', 'KeyB');
  setMouseBinding('shoot', 1);
  setTouchAnchor('pause', 0.2, 0.2);
  resetKeyBindings();
  ok('key reset only touches keys', KEYS.boost === 'Space' && MOUSE.shoot === 1 && TOUCH.pause.x === 0.2);
  resetMouseBindings();
  ok('mouse reset', MOUSE.shoot === 0 && MOUSE.shield === 2);
  resetTouchLayout();
  ok('layout reset', Object.keys(TOUCH).length === 0);
  loadBindings();
  ok('resets persisted', KEYS.boost === 'Space' && Object.keys(TOUCH).length === 0);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 7. Labels');
{
  ok('KeyW → W', keyLabel('KeyW') === 'W');
  ok('Space → SPACE', keyLabel('Space') === 'SPACE');
  ok('ShiftLeft → L-SHIFT', keyLabel('ShiftLeft') === 'L-SHIFT');
  ok('Digit3 → 3', keyLabel('Digit3') === '3');
  ok('ArrowUp → UP', keyLabel('ArrowUp') === 'UP');
  ok('mouse labels', mouseLabel(0) === 'L-MB' && mouseLabel(1) === 'M-MB' && mouseLabel(2) === 'R-MB');
  ok('every action has a label', KEY_ACTIONS.every(a => keyLabel(a.def) !== '?')
     && MOUSE_ACTIONS.length === 2 && TOUCH_ANCHORS.length === 7);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
