// Deterministic, headless test of the new-player engagement gifts:
//   1. AchievementManager.consumeEngagementGift — one-shot per key, persisted.
//   2. First-ever level-up: rollChoices (via the real LevelUpDialog) forces a
//      legendary-tier bonus in slot 0 and a rare-tier in slot 1, never cursed;
//      the gift never fires twice, and never on a veteran profile.
//   3. First-ever shop: guaranteed centerpiece + two rare upgrades in stock,
//      strictly within the unlock gates — a big weapon when one is unlocked,
//      otherwise a really-good ungated item (SHOWROOM_FALLBACK_IDS).
//   4. First-flight welcome cache: a cache with minRolls = 3 reveals at least
//      3 items through the real CacheUI state machine, grid clamped to fit.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/engagement_gifts_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Minimal globals for transitively-imported UI modules.
globalThis.window ||= {};
globalThis.document ||= { createElement: () => ({ getContext: () => ({}) }) };
globalThis.navigator ||= { getGamepads: () => [] };
globalThis.localStorage ||= {
  _s: {},
  getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};

const { AchievementManager } = await import('../src/engine/achievementManager.js');
const { LevelUpDialog } = await import('../src/ui/levelUpDialog.js');
const { Shop } = await import('../src/entities/shop.js');
const { CacheUI, CUI_STATE } = await import('../src/ui/cacheUI.js');
const { UPGRADES } = await import('../src/data/upgrades.js');

const BIG_WEAPONS = ['railgun', 'repeater', 'auto_turret', 'energy_blaster', 'laser_override', 'explosives_unit'];

const stubSounds = { play() {}, playJackpot() {} };
const freshGame = () => {
  localStorage._s = {}; // wipe the persisted profile between scenarios
  const game = { sounds: stubSounds, rng: null, assets: { get: () => null }, currentState: null };
  game.achievements = new AchievementManager(game);
  return game;
};

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. consumeEngagementGift — one-shot, persisted');
{
  const game = freshGame();
  const mgr = game.achievements;
  ok('first consume returns true', mgr.consumeEngagementGift('test_gift') === true);
  ok('second consume returns false', mgr.consumeEngagementGift('test_gift') === false);
  const mgr2 = new AchievementManager(game); // reload from the same storage
  ok('consumption survives reload', mgr2.consumeEngagementGift('test_gift') === false);
  ok('other keys unaffected', mgr2.consumeEngagementGift('other_gift') === true);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. First-ever level-up gift');
{
  const game = freshGame();
  const player = { luck: 1, upgradeTypeCounts: {} };
  const d1 = new LevelUpDialog(game, player, null, 2);
  ok('rolled 4 choices', d1.choices.length === 4, `${d1.choices.length}`);
  const c0 = d1.choices[0], c1 = d1.choices[1];
  ok('slot 0 is legendary tier', c0.bonusRarity === 'legendary' && c0.pct >= 10 && c0.pct <= 20,
     `${c0.bonusRarity} ${c0.pct?.toFixed(1)}%`);
  ok('slot 1 is rare tier', c1.bonusRarity === 'rare' && c1.pct >= 3 && c1.pct <= 6,
     `${c1.bonusRarity} ${c1.pct?.toFixed(1)}%`);
  ok('gift slots are not cursed', !c0.isCursed && !c1.isCursed);
  ok('gift consumed', game.achievements.lifetime.engagementGifts.first_level_up === true);

  // Second dialog: no forced legendary — over 30 rolls the natural legendary
  // rate (1%) can't plausibly hit slot 0 every time.
  let alwaysLegendary = true;
  for (let i = 0; i < 30; i++) {
    const d = new LevelUpDialog(game, player, null, 3);
    if (d.choices[0].bonusRarity !== 'legendary') { alwaysLegendary = false; break; }
  }
  ok('gift does not repeat', !alwaysLegendary);
}
{
  const game = freshGame();
  game.achievements.lifetime.levelUps = 500; // veteran profile
  const d = new LevelUpDialog(game, { luck: 1, upgradeTypeCounts: {} }, null, 2);
  ok('veteran profile gets no gift', !game.achievements.lifetime.engagementGifts.first_level_up);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. First-ever shop showroom');
{
  const FALLBACK = ['energy_canisters', 'mechanical_engines', 'boost_drive', 'control_module'];
  // 50 fresh-profile shops: the guarantee must hold every time, and the
  // unlock gates must NEVER be bypassed (fresh = all big weapons locked).
  // (50 because the original random placement failed ~1/1500 by grid
  // fragmentation — guaranteed items now pack exhaustively.)
  let fallbackAlways = true, raresAlways = true, gatesAlways = true, noWeaponEver = true;
  for (let i = 0; i < 50; i++) {
    const game = freshGame();
    const shop = new Shop(game, 0, 0, { firstEverShop: true });
    const items = shop.inventory.items;
    if (!items.some(e => FALLBACK.includes(e.item.id))) fallbackAlways = false;
    if (items.filter(e => e.item.rarity === 'rare').length < 2) raresAlways = false;
    if (!items.every(e => game.achievements.isUpgradeUnlocked(e.item.id))) gatesAlways = false;
    if (items.some(e => BIG_WEAPONS.includes(e.item.id))) noWeaponEver = false;
  }
  ok('fresh profile: always stocks a fallback centerpiece (50 shops)', fallbackAlways);
  ok('fresh profile: always stocks 2 rares (50 shops)', raresAlways);
  ok('fresh profile: never bypasses unlock gates (50 shops)', gatesAlways);
  ok('fresh profile: no locked big weapon appears (50 shops)', noWeaponEver);

  // With a big-weapon gate unlocked, the centerpiece IS that weapon.
  const game = freshGame();
  const gate = game.achievements.getUpgradeGate('railgun');
  game.achievements.unlocked.add(gate.id);
  const shop = new Shop(game, 0, 0, { firstEverShop: true });
  ok('unlocked big weapon becomes the centerpiece',
     shop.inventory.items.some(e => e.item.id === 'railgun'));

  const game2 = freshGame();
  const normal = new Shop(game2, 0, 0);
  ok('normal shop still generates', normal.inventory.items.length >= 4,
     `${normal.inventory.items.length} items`);
  ok('normal shop respects unlock gates',
     normal.inventory.items.every(e => game2.achievements.isUpgradeUnlocked(e.item.id)));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. First-flight welcome cache (minRolls = 3)');
{
  const drive = (ui) => {  // run the roll state machine to completion
    let guard = 0;
    while (ui.uiState !== CUI_STATE.IDLE && guard++ < 60) {
      if (ui.uiState === CUI_STATE.ROLLING) ui._beginReveal();
      else if (ui.uiState === CUI_STATE.REVEALING) { ui.slideT = 1; ui._finalizeReveal(); }
      else if (ui.uiState === CUI_STATE.WAIT_EXTRA) ui._checkExtraRoll();
      else break;
    }
  };

  // 20 welcome caches: at least 3 items every time, grid always big enough.
  let minAlways = true, gridAlways = true;
  for (let i = 0; i < 20; i++) {
    const game = freshGame();
    const cache = { minRolls: 3, contentRng: null };
    const ui = new CacheUI(game, cache, null);
    drive(ui);
    if (ui.revealedItems.length < 3) minAlways = false;
    if (ui.cacheInventory.cols < 3 || ui.cacheInventory.rows < 3) gridAlways = false;
  }
  ok('welcome cache always reveals >= 3 items (20 caches)', minAlways);
  ok('welcome cache grid always >= 3x3 (20 caches)', gridAlways);

  const game = freshGame();
  const ui = new CacheUI(game, { contentRng: null }, null);
  drive(ui);
  ok('normal cache still rolls (>= 1 item, <= 4)',
     ui.revealedItems.length >= 1 && ui.revealedItems.length <= 4,
     `${ui.revealedItems.length} items`);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
