// Deterministic, headless test of the SAVED (pinned) station: the one shop per
// run the player marks from the shop overlay so it is never pruned from the
// radar queue / despawned when newer shops are revealed (shop maps, proximity).
//
// Uses the REAL modules: `Shop` (flag + serialize round-trip), the real
// `PlayingState.prototype._revealShop` / `_toggleSaveStation` bound to a minimal
// state object, and the real multiplayer `applyShopState` applier from netSync.
//
// Run: node --loader ./.autotest/hooks.mjs .autotest/saved_station_test.mjs

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// Minimal globals so transitively-imported UI/engine modules load headless.
globalThis.window ||= globalThis;
globalThis.document ||= { createElement: () => ({ getContext: () => ({}) }) };
globalThis.navigator ||= { getGamepads: () => [] };
globalThis.localStorage ||= { getItem() { return null; }, setItem() {}, removeItem() {} };

const { Shop } = await import('../src/entities/shop.js');
const { PlayingState } = await import('../src/states/playingState.js');
const { HostWorldSync } = await import('../src/net/netSync.js');

// A game stub good enough for Shop (no rng → Math.random content, no atlas).
const game = { assets: { get: () => null }, sounds: { play() {} } };
const mkShop = (x) => new Shop(game, x, 0);

// A PlayingState-shaped object carrying only what the two methods touch.
const mkState = () => {
  const st = { game, shops: [], revealedShops: [] };
  st._revealShop = PlayingState.prototype._revealShop.bind(st);
  st._toggleSaveStation = PlayingState.prototype._toggleSaveStation.bind(st);
  return st;
};
const addShop = (st, x) => { const s = mkShop(x); st.shops.push(s); return s; };

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Shop flag + serialize round-trip');
{
  const a = mkShop(0);
  ok('new Shop is unsaved', a.saved === false);
  a.saved = true;
  const data = a.serialize();
  ok('serialize carries saved', data.saved === true);
  const b = mkShop(0);
  await b.deserialize(data);
  ok('deserialize restores saved', b.saved === true);
  const legacy = a.serialize(); delete legacy.saved;
  const c = mkShop(0); c.saved = true;
  await c.deserialize(legacy);
  ok('legacy save without the field → unsaved', c.saved === false);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Baseline radar cap (3) still prunes + despawns the oldest');
{
  const st = mkState();
  const s = [0, 1, 2, 3].map(x => addShop(st, x));
  s.forEach(sh => st._revealShop(sh));
  ok('queue holds 3', st.revealedShops.length === 3);
  ok('oldest pruned: hidden + dead', s[0].revealed === false && s[0].alive === false);
  ok('others alive + revealed', s.slice(1).every(sh => sh.revealed && sh.alive));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Saved station never prunes, never counts against the cap');
{
  const st = mkState();
  const s = [0, 1, 2, 3, 4, 5].map(x => addShop(st, x));
  st._revealShop(s[0]);
  st._toggleSaveStation(s[0]);            // pin the first shop
  ok('pinned flag set', s[0].saved === true);
  // Reveal five newer shops (as five shop maps would).
  s.slice(1).forEach(sh => st._revealShop(sh));
  ok('pinned shop still alive', s[0].alive === true);
  ok('pinned shop still on radar', s[0].revealed === true);
  ok('queue = 3 unsaved + 1 saved', st.revealedShops.length === 4
    && st.revealedShops.filter(x => x.saved).length === 1);
  ok('the two oldest UNSAVED shops were pruned', s[1].alive === false && s[2].alive === false);
  ok('newest three unsaved survive', [s[3], s[4], s[5]].every(sh => sh.alive && sh.revealed));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Only one saved station: pinning another moves the pin');
{
  const st = mkState();
  const a = addShop(st, 0), b = addShop(st, 1);
  st._revealShop(a); st._revealShop(b);
  st._toggleSaveStation(a);
  st._toggleSaveStation(b);
  ok('a unpinned, b pinned', a.saved === false && b.saved === true);
  ok('exactly one saved shop', st.shops.filter(x => x.saved).length === 1);
  st._toggleSaveStation(b);
  ok('toggling the pinned shop unpins it', b.saved === false);
  ok('no saved shop left', st.shops.every(x => !x.saved));
  ok('both still alive (queue under cap)', a.alive && b.alive);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 5. Unpinning with a full queue lets the oldest unsaved age out');
{
  const st = mkState();
  const s = [0, 1, 2, 3].map(x => addShop(st, x));
  st._revealShop(s[0]); st._toggleSaveStation(s[0]);
  s.slice(1).forEach(sh => st._revealShop(sh));   // 3 unsaved + 1 saved
  ok('4 on radar while pinned', st.revealedShops.length === 4);
  st._toggleSaveStation(s[0]);                     // unpin at the docked shop
  ok('back to cap of 3', st.revealedShops.length === 3);
  ok('docked (just-unpinned) shop is newest, survives', s[0].alive && s[0].revealed);
  ok('the oldest unsaved shop aged out', s[1].alive === false);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 6. Multiplayer applyShopState carries the pin to every machine');
{
  const shops = [mkShop(0), mkShop(1)];
  shops.forEach((s, i) => { s.netId = i; });
  shops[0].saved = true;
  const fake = {
    state: { shops },
    findShopByNetId(id) { return shops.find(s => s.netId === id) || null; },
  };
  const apply = HostWorldSync.prototype.applyShopState.bind(fake);
  apply({ idx: 1, saved: true });
  ok('remote pin moves to shop 1', shops[1].saved === true);
  ok('previous pin cleared', shops[0].saved === false);
  apply({ idx: 1, inv: shops[1].inventory.serialize() });   // legacy-shaped msg
  ok('message without saved leaves the pin alone', shops[1].saved === true);
  apply({ idx: 1, saved: false });
  ok('remote unpin clears it', shops[1].saved === false);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
