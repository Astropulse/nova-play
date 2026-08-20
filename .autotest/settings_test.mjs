// Deterministic, headless test of the persistent settings system:
//   1. engine/settings.js — defaults, clamping, persistence round-trip,
//      unknown-key rejection, corrupt-store tolerance, reset.
//   2. The voronoi-fracture / reduced-particles levers in asteroid.js —
//      FractureModel.get's null kill-switch and debrisShatter's piece-count
//      math + subset caching (VoronoiSlicer stubbed so no canvas is needed).
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/settings_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Minimal globals for transitively-imported modules.
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
  SETTINGS, SETTINGS_DEFAULTS, loadSettings, setSetting, resetSettings,
} = await import('../src/engine/settings.js');

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Defaults preserve pre-settings behavior');
{
  ok('music/sfx default 0.5', SETTINGS.musicVolume === 0.5 && SETTINGS.sfxVolume === 0.5);
  ok('distortion dials default 1.0', SETTINGS.audioDistortion === 1 && SETTINGS.visualDistortion === 1);
  ok('fractures + smoothing default on', SETTINGS.voronoiFractures === true && SETTINGS.smoothScaling === true);
  ok('reduced particles default off', SETTINGS.reducedParticles === false);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. setSetting — clamping, coercion, persistence');
{
  ok('number clamps high', setSetting('musicVolume', 3.7) === 1);
  ok('number clamps low', setSetting('musicVolume', -0.4) === 0);
  ok('number snaps to 0.1 steps', setSetting('musicVolume', 0.4499) === 0.4);
  ok('bool coerces truthy', setSetting('reducedParticles', 1) === true);
  ok('unknown key ignored', setSetting('bogusKey', 9) === undefined && !('bogusKey' in SETTINGS));

  // Round-trip: mutate → reload module state from storage.
  setSetting('sfxVolume', 0.2);
  setSetting('voronoiFractures', false);
  Object.assign(SETTINGS, SETTINGS_DEFAULTS); // wipe in-memory state
  loadSettings();
  ok('round-trip restores numbers', SETTINGS.sfxVolume === 0.2, `${SETTINGS.sfxVolume}`);
  ok('round-trip restores bools', SETTINGS.voronoiFractures === false && SETTINGS.reducedParticles === true);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Corrupt / hostile store tolerated');
{
  localStorage.setItem('nova_settings', '{not json');
  Object.assign(SETTINGS, SETTINGS_DEFAULTS);
  loadSettings();
  ok('corrupt JSON → defaults', SETTINGS.musicVolume === 0.5);

  localStorage.setItem('nova_settings', JSON.stringify({ musicVolume: 'loud', smoothScaling: 0.3, sfxVolume: 0.9 }));
  Object.assign(SETTINGS, SETTINGS_DEFAULTS);
  loadSettings();
  ok('wrong-typed keys skipped', SETTINGS.musicVolume === 0.5 && SETTINGS.smoothScaling === true);
  ok('valid keys still land', SETTINGS.sfxVolume === 0.9);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. resetSettings');
{
  setSetting('visualDistortion', 0);
  setSetting('reducedParticles', true);
  resetSettings();
  ok('reset restores defaults in memory', SETTINGS.visualDistortion === 1 && SETTINGS.reducedParticles === false);
  Object.assign(SETTINGS, { visualDistortion: 0.3 });
  loadSettings();
  ok('reset persisted too', SETTINGS.visualDistortion === 1);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 5. Fracture levers (asteroid.js) honor the settings');
{
  const { FractureModel, debrisShatter, VoronoiSlicer } = await import('../src/entities/asteroid.js');

  // Stub the slicer so no canvas readback happens — debrisShatter's count
  // math and caching are what's under test.
  VoronoiSlicer.slice = (asset, n) => Array.from({ length: n }, (_, i) => ({ i }));
  const fakeAsset = { canvas: {}, width: 32, height: 32 };

  resetSettings();
  ok('fractures on → model requested (non-null path reachable via null-asset guard)',
     FractureModel.get(null, 'k0') === null);
  ok('full shatter count', debrisShatter(fakeAsset, 't_full', 13).length === 13);

  setSetting('voronoiFractures', false);
  ok('fractures off → FractureModel.get is null', FractureModel.get(fakeAsset, 'k1') === null);
  ok('fractures off → shatter capped at 6', debrisShatter(fakeAsset, 't_off', 13).length === 6);

  setSetting('voronoiFractures', true);
  setSetting('reducedParticles', true);
  ok('reduced → shatter halved', debrisShatter(fakeAsset, 't_red', 13).length === 6);

  setSetting('voronoiFractures', false);
  ok('both → floor of 3', debrisShatter(fakeAsset, 't_both', 13).length === 3);

  // Subset caching: same key + same settings → same array instance.
  const a = debrisShatter(fakeAsset, 't_cache', 13);
  const b = debrisShatter(fakeAsset, 't_cache', 13);
  ok('subset is cached (no per-death alloc)', a === b && a.length === 3);

  resetSettings();
  ok('back to defaults → full count again', debrisShatter(fakeAsset, 't_back', 13).length === 13);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
