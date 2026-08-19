// Headless logic test for the progression-gate systems:
//   - upgrade unlock gates (achievements with unlock: {type:'upgrade'})
//   - the combine-tier ladder (none -> uncommon -> rare -> epic -> legendary)
//   - Inventory.combineTargetAt honoring the cap
// Run: node --loader ./.autotest/hooks.mjs .autotest/progression_gates_test.mjs
// (from the repo root)

// The manager persists to localStorage on every notify — stub it first.
const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
};

const { AchievementManager } = await import('../src/engine/achievementManager.js');
const { Inventory } = await import('../src/engine/inventory.js');
const { UPGRADES, makeItem, isUpgradeUnlocked, MAX_COMBINE_TIER } = await import('../src/data/upgrades.js');
const { SHIPS, isShipUnlocked } = await import('../src/data/ships.js');
const { ACHIEVEMENTS } = await import('../src/data/achievements.js');

let failures = 0;
function check(label, cond) {
    if (cond) console.log('PASS', label);
    else { failures++; console.log('FAIL', label); }
}

const mgr = new AchievementManager(null);

// ── Baseline: fresh profile ────────────────────────────────────────────────
check('fresh profile: combine cap is 0 (no fusing)', mgr.combineTierCap() === 0);
check('fresh profile: laser_cartridge (ungated) is unlocked', mgr.isUpgradeUnlocked('laser_cartridge'));
check('fresh profile: blink_engine is locked', !mgr.isUpgradeUnlocked('blink_engine'));
check('fresh profile: auto_turret is locked', !mgr.isUpgradeUnlocked('auto_turret'));
check('getUpgradeGate maps blink_engine to its achievement',
    mgr.getUpgradeGate('blink_engine') && mgr.getUpgradeGate('blink_engine').id === 'unlock_blink_engine');
check('helper isUpgradeUnlocked(game) respects the gate',
    !isUpgradeUnlocked({ achievements: mgr }, 'blink_engine')
    && isUpgradeUnlocked({ achievements: mgr }, 'laser_cartridge')
    && isUpgradeUnlocked(null, 'blink_engine')); // no game -> everything open

// Ships: only the Fighter is ungated.
check('fresh profile: fighter is unlocked', mgr.isShipUnlocked('fighter'));
check('fresh profile: cruiser/bruiser/looper are locked',
    !mgr.isShipUnlocked('cruiser') && !mgr.isShipUnlocked('bruiser') && !mgr.isShipUnlocked('looper'));
check('getShipGate maps looper to its achievement',
    mgr.getShipGate('looper') && mgr.getShipGate('looper').id === 'unlock_looper');
check('helper isShipUnlocked(game) respects the gate',
    !isShipUnlocked({ achievements: mgr }, 'looper')
    && isShipUnlocked({ achievements: mgr }, 'fighter')
    && isShipUnlocked(null, 'looper')); // no game -> everything open
for (const a of ACHIEVEMENTS) {
    if (a.unlock && a.unlock.type === 'ship') {
        check(`gate ${a.id} grants a real ship id`, SHIPS.some(s => s.id === a.unlock.id));
    }
}

// Every upgrade-gate achievement grants a real upgrade id, uses a real icon
// key shape, and every combine gate id is on the ladder.
const upgradeIds = new Set(UPGRADES.map(u => u.id));
for (const a of ACHIEVEMENTS) {
    if (!a.unlock) continue;
    if (a.unlock.type === 'upgrade') {
        check(`gate ${a.id} grants a real upgrade id`, upgradeIds.has(a.unlock.id));
    } else if (a.unlock.type === 'combine') {
        check(`gate ${a.id} grants a real combine rung`,
            ['uncommon', 'rare', 'epic', 'legendary'].includes(a.unlock.id));
    }
}

// ── Combine ladder rung 1: level 10 in a single run ───────────────────────
mgr.notify('run_started');
// player_stats sets run.shipId; level_up records peak levels.
mgr.notify('player_stats', { player: { shipData: { id: 'fighter' }, level: 1 } });
mgr.notify('level_up', { level: 10 });
check('level 10 -> combine cap uncommon (2)', mgr.combineTierCap() === 2);
check('nextCombineGate is the rare rung', mgr.nextCombineGate().id === 'combine_tier_rare');

// ── Rung 2: level 20 with every ship ───────────────────────────────────────
for (const ship of ['fighter', 'cruiser', 'bruiser', 'looper']) {
    mgr.notify('run_started');
    mgr.notify('player_stats', { player: { shipData: { id: ship }, level: 1 } });
    mgr.notify('level_up', { level: 20 });
}
check('level 20 on all ships -> combine cap rare (4)', mgr.combineTierCap() === 4);

// ── Rung 3: the Yellow One ─────────────────────────────────────────────────
mgr.notify('boss_defeated', { bossId: 'YellowOne' });
check('YellowOne -> combine cap epic (6)', mgr.combineTierCap() === 6);

// ── Rung 4: every boss, dragon via the seven lone heads ────────────────────
for (const b of ['Starcore', 'AsteroidCrusher', 'EventHorizon', 'Seraph', 'Wheels', 'Swarm', 'Carcosa']) {
    mgr.notify('boss_defeated', { bossId: b });
}
check('all bosses but dragon -> still epic cap', mgr.combineTierCap() === 6);
for (const h of ['deception', 'accusation', 'murder', 'blasphemy', 'economic_control', 'false_worship', 'persecution']) {
    mgr.notify('boss_defeated', { bossId: 'Head:' + h });
}
check('all seven lone heads stand in for the Dragon -> legendary cap',
    mgr.combineTierCap() === MAX_COMBINE_TIER);

// Wave-boss kills along the way should have opened their upgrade gates too.
check('any wave boss unlocked the railgun', mgr.isUpgradeUnlocked('railgun'));
check('all three wave bosses unlocked the explosives unit', mgr.isUpgradeUnlocked('explosives_unit'));

// ── Upgrade gate: survive 20 minutes as the Looper ────────────────────────
check('blink_engine still locked before the looper run', !mgr.isUpgradeUnlocked('blink_engine'));
mgr.notify('run_started');
mgr.notify('player_stats', { player: { shipData: { id: 'looper' }, level: 1 } });
mgr.tickRun(1200); // 20 minutes of in-game time
check('20 min as looper unlocks blink_engine', mgr.isUpgradeUnlocked('blink_engine'));

// ── Ship unlock objectives ─────────────────────────────────────────────────
mgr.notify('player_damaged', { amount: 2500, shielded: false });
check('2500 damage taken unlocks the Bruiser', mgr.isShipUnlocked('bruiser'));
for (let i = 0; i < 50; i++) mgr.notify('dodge_performed');
check('50 boost dodges unlock the Looper', mgr.isShipUnlocked('looper'));
mgr.notify('player_traveled', { distance: 150000 });
check('150k units traveled (live run distance) unlocks the Cruiser', mgr.isShipUnlocked('cruiser'));

// Grandfather path: a profile that already completed a run with a ship keeps
// it — the boot reconcile unlocks its gate silently from `shipsUsed`.
{
    store.clear();
    store.set('nova_achievements', JSON.stringify({ lifetime: { shipsUsed: { looper: true } } }));
    const veteran = new AchievementManager(null);
    check('shipsUsed grandfathers the Looper at boot', veteran.isShipUnlocked('looper'));
    check('grandfathering is per-ship (cruiser still locked)', !veteran.isShipUnlocked('cruiser'));
}

// ── Inventory combine cap enforcement ──────────────────────────────────────
const freshMgr = (() => { store.clear(); return new AchievementManager(null); })();
const inv = new Inventory(4, 4);
inv.isPlayerInventory = true;
inv.playingState = { game: { achievements: freshMgr } };
inv.addItem(makeItem('laser_cartridge', 0), 0, 0);
const dragged = makeItem('laser_cartridge', 0);
check('cap 0: matching pair refuses to combine', inv.combineTargetAt(dragged, 0, 0) === null);
check('cap 0: ignoreCap probe still finds the would-be target',
    inv.combineTargetAt(dragged, 0, 0, true) !== null);
check('combineGateFor(1) names the uncommon rung',
    freshMgr.combineGateFor(1) && freshMgr.combineGateFor(1).id === 'combine_tier_uncommon');

freshMgr.notify('run_started');
freshMgr.notify('player_stats', { player: { shipData: { id: 'fighter' }, level: 1 } });
freshMgr.notify('level_up', { level: 10 });
check('cap 2: common pair combines to tier 1', !!inv.tryCombine(dragged, 0, 0));
const t1 = inv.getItemAt(0, 0).item;
check('fused item is tier 1', t1.tier === 1);
inv.clear();
inv.addItem(makeItem('laser_cartridge', 2), 0, 0);
check('cap 2: tier-2 pair refuses (result would be 3)',
    inv.combineTargetAt(makeItem('laser_cartridge', 2), 0, 0) === null);

// Non-player inventories (shop/cache/trade) are never capped.
const shopInv = new Inventory(4, 4);
shopInv.addItem(makeItem('laser_cartridge', 2), 0, 0);
check('non-player inventory ignores the cap',
    shopInv.combineTargetAt(makeItem('laser_cartridge', 2), 0, 0) !== null);

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
