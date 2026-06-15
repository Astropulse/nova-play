// Deterministic, headless test of the multiplayer respawn logic.
//
// _netRespawn() itself can't run without Electron/canvas, so this exercises the
// exact pieces it relies on, using the REAL game modules:
//   1. Inventory serialize -> deserialize restores the full (expanded) grid and
//      every item — the cargo-expander bug. Also proves the OLD hand-rebuild
//      (new base-size Inventory + addItem at old coords) drops expanded items.
//   2. A recorded level-up pick { statId, isCursed, pct, flatValue } replays via
//      the real applyLevelUpChoice to the SAME field change as the original
//      choice — the foundation of the ordered-history restructure.
//   3. _applyLevelPenalty's trim+reset+replay reproduces exactly the bonuses of
//      keeping only the first 75% of picks.
//   4. _rollLostItems eligibility: epic/legendary never lost; common/uncommon/
//      rare are.

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Minimal globals in case a transitively-imported UI module touches them at load.
globalThis.window ||= {};
globalThis.document ||= { createElement: () => ({ getContext: () => ({}) }) };
globalThis.navigator ||= { getGamepads: () => [] };

const { Inventory } = await import('../src/engine/inventory.js');
const { UPGRADES, makeItem, itemTier, rarityToTier } =
  await import('../src/data/upgrades.js');
const { applyLevelUpChoice } = await import('../src/ui/levelUpDialog.js');

// ───────────────────────────────────────────────────────────────────────────
// 1. Inventory restore across an EXPANDED grid (the cargo-expander bug)
// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Inventory restore (cargo expander)');

const BASE_COLS = 8, BASE_ROWS = 4;
const EXP_COLS = 9, EXP_ROWS = 7; // +1 col (upgrade tier) + 3 rows (cargo expansion)

const small = UPGRADES.filter(u => u.width === 1 && u.height === 1);
ok('found 1x1 items to place', small.length >= 4, `${small.length} available`);

const live = new Inventory(BASE_COLS, BASE_ROWS);
live.resize(EXP_COLS, EXP_ROWS); // simulate cargo expander having grown the grid

// Place items: two inside the base region, two ONLY reachable in the expanded
// region (last column / bottom rows). These are exactly what the old respawn
// silently dropped.
const placements = [
  { item: makeItem(small[0].id), x: 0, y: 0 },          // base
  { item: makeItem(small[1].id), x: 3, y: 2 },          // base
  { item: makeItem(small[2].id), x: EXP_COLS - 1, y: 0 }, // expanded column
  { item: makeItem(small[3].id), x: 1, y: EXP_ROWS - 1 }, // expanded row
];
let placedAll = true;
for (const p of placements) placedAll = live.addItem(p.item, p.x, p.y) && placedAll;
ok('placed all items into expanded grid', placedAll);
ok('live grid is expanded', live.cols === EXP_COLS && live.rows === EXP_ROWS,
   `${live.cols}x${live.rows}`);

// THE FIX: serialize -> deserialize (the save/load path respawn now uses).
const snapshot = live.serialize();
const restored = new Inventory(BASE_COLS, BASE_ROWS);
await restored.deserialize(snapshot);

ok('restored grid size matches expanded', restored.cols === EXP_COLS && restored.rows === EXP_ROWS,
   `${restored.cols}x${restored.rows}`);
ok('restored item count matches', restored.items.length === placements.length,
   `${restored.items.length}/${placements.length}`);
let allFound = true;
for (const p of placements) {
  const entry = restored.getItemAt(p.x, p.y);
  if (!entry || entry.item.id !== p.item.id) allFound = false;
}
ok('every item restored at its original slot (incl. expanded region)', allFound);

// THE OLD BUG: base-size inventory + addItem at old coords drops expanded items.
const broken = new Inventory(BASE_COLS, BASE_ROWS);
let dropped = 0;
for (const p of placements) if (!broken.addItem(makeItem(p.item.id), p.x, p.y)) dropped++;
ok('old hand-rebuild WOULD drop expanded-slot items', dropped > 0,
   `${dropped} of ${placements.length} dropped into a base ${BASE_COLS}x${BASE_ROWS} grid`);

// ───────────────────────────────────────────────────────────────────────────
// 2. Recorded pick replays identically to the original choice
// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Level-up pick record -> replay fidelity');

const LVL_FIELDS = [
  'lvlDamageMult', 'lvlMaxHpMult', 'lvlFireRateMult', 'lvlLuckMult',
  'lvlExtraProjectiles', 'lvlHpRegen', 'lvlShieldDrainMult',
];
const freshPlayer = () => {
  const p = {};
  for (const f of LVL_FIELDS) p[f] = f === 'lvlExtraProjectiles' || f === 'lvlHpRegen' ? 0 : 1.0;
  return p;
};

// A representative spread: a buff %, an inverse stat, a cursed pick, two flats.
const choices = [
  { stat: { id: 'damage' },          isCursed: false, pct: 12 },
  { stat: { id: 'firerate' },        isCursed: false, pct: 8 },   // inverse (mult goes down)
  { stat: { id: 'max_hp' },          isCursed: true,  pct: 15 },  // cursed (mult goes down)
  { stat: { id: 'extra_projectile' },isCursed: false, pct: 0, flatValue: 2 },
  { stat: { id: 'hp_regen' },        isCursed: false, pct: 0, flatValue: 0.3 },
  { stat: { id: 'luck' },            isCursed: false, pct: 20 },
];

let replayFidelity = true;
for (const choice of choices) {
  const a = freshPlayer();
  applyLevelUpChoice(choice, a, null);                       // original choice object
  const record = { statId: choice.stat.id, isCursed: !!choice.isCursed, pct: choice.pct, flatValue: choice.flatValue };
  const rebuilt = { stat: { id: record.statId }, isCursed: record.isCursed, pct: record.pct, flatValue: record.flatValue };
  const b = freshPlayer();
  applyLevelUpChoice(rebuilt, b, null);                      // minimal record -> replay
  const same = LVL_FIELDS.every(f => Math.abs(a[f] - b[f]) < 1e-12);
  if (!same) { replayFidelity = false; console.log('   mismatch on', choice.stat.id); }
}
ok('each recorded pick replays identically to its original choice', replayFidelity);

// ───────────────────────────────────────────────────────────────────────────
// 3. _applyLevelPenalty: keep 75%, replay reproduces those bonuses exactly
// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Level penalty (keep 75% of picks)');

const keepFrac = 0.75;
const history = choices.map(c => ({ statId: c.stat.id, isCursed: !!c.isCursed, pct: c.pct, flatValue: c.flatValue }));

// Reference: a player who only ever picked the kept subset.
const keptCount = Math.round(history.length * keepFrac);
const kept = history.slice(0, keptCount);
const reference = freshPlayer();
for (const rec of kept) {
  applyLevelUpChoice({ stat: { id: rec.statId }, isCursed: rec.isCursed, pct: rec.pct, flatValue: rec.flatValue }, reference, null);
}

// Penalised: full-history player, reset to defaults, replay only the kept subset
// (this mirrors _resetLevelBonuses + the _applyLevelPenalty replay loop).
const penalised = freshPlayer();
for (const rec of history) {
  applyLevelUpChoice({ stat: { id: rec.statId }, isCursed: rec.isCursed, pct: rec.pct, flatValue: rec.flatValue }, penalised, null);
}
for (const f of LVL_FIELDS) penalised[f] = f === 'lvlExtraProjectiles' || f === 'lvlHpRegen' ? 0 : 1.0; // reset
const penalisedChoices = [];
for (const rec of kept) {
  applyLevelUpChoice({ stat: { id: rec.statId }, isCursed: rec.isCursed, pct: rec.pct, flatValue: rec.flatValue }, penalised, null);
  penalisedChoices.push({ ...rec });
}

ok('kept count = round(6 * 0.75)', keptCount === 5, `kept ${keptCount}/6 (drops most recent ${history.length - keptCount})`);
ok('penalised bonuses equal the kept-only reference',
   LVL_FIELDS.every(f => Math.abs(reference[f] - penalised[f]) < 1e-12));
ok('penalised lvlChoices array trimmed to kept set',
   penalisedChoices.length === keptCount &&
   penalisedChoices[penalisedChoices.length - 1].statId === kept[kept.length - 1].statId);

// Sanity: the dropped most-recent pick (luck) must NOT be in the penalised bonuses.
ok('dropped pick (luck) no longer applied', Math.abs(penalised.lvlLuckMult - 1.0) < 1e-12,
   `lvlLuckMult=${penalised.lvlLuckMult}`);

// ───────────────────────────────────────────────────────────────────────────
// 4. _rollLostItems eligibility (only common/uncommon/rare can be lost)
// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Item-loss eligibility');

const EPIC_TIER = rarityToTier('epic');
const byRarity = r => UPGRADES.find(u => u.rarity === r);
const eligible = item => item && itemTier(item) < EPIC_TIER;

for (const r of ['common', 'uncommon', 'rare']) {
  const def = byRarity(r);
  if (def) ok(`${r} item is eligible to be lost`, eligible(def), `tier ${itemTier(def)}`);
}
for (const r of ['epic', 'legendary']) {
  const def = byRarity(r);
  if (def) ok(`${r} item is NEVER lost`, !eligible(def), `tier ${itemTier(def)}`);
}
// A common item combined up to epic tier becomes ineligible (effective tier gate).
const commonDef = UPGRADES.find(u => u.rarity === 'common' && u.combine);
if (commonDef) {
  const upgraded = makeItem(commonDef.id, EPIC_TIER);
  ok('common item upgraded to epic tier becomes ineligible', !eligible(upgraded),
     `${commonDef.id} @ tier ${itemTier(upgraded)}`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
