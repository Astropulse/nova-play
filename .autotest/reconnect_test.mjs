// Deterministic, headless test of the HOST-side reconnection state machine.
//
// The full client auto-reconnect needs real WebSockets, but the host's grace +
// reattach + restore logic is pure and can be driven directly with a fake
// transport. Exercises the REAL HostSession:
//   1. HELLO with a token creates a player; a mid-run drop holds the slot
//      (grace) instead of removing it, and broadcasts PLAYER_DISCONNECTED.
//   2. A second HELLO with the same token WITHIN grace reattaches the SAME pid
//      (no new slot), clears the disconnected flag, and cancels the timer.
//   3. A stale close for the OLD clientId after reattach is ignored (the relay
//      reassigns clientIds) — the player stays connected.
//   4. After PLAYER_PERSIST + grace expiry (_finalizeDrop), the slot frees but
//      the ship/stats blob is retained; a later HELLO with that token gets a
//      FRESH pid and the retained blob folded into its join snapshot.

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

globalThis.window ||= {};
globalThis.document ||= { createElement: () => ({ getContext: () => ({}) }) };
globalThis.navigator ||= { getGamepads: () => [] };

const { HostSession } = await import('../src/net/netSession.js');
const { MSG, NET_PROTOCOL_VERSION, encode, decode } = await import('../src/net/protocol.js');

// ── Fake transport: records frames the host sends, lets us inject closes ──────
function makeHost() {
  const sent = [];        // {clientId, msg}
  const broadcasts = [];  // msg
  const impl = {
    sendTo: (clientId, raw) => sent.push({ clientId, msg: decode(raw) }),
    broadcast: (raw) => broadcasts.push(decode(raw)),
    kick: () => {},
    stop: () => {},
  };
  const game = { worldSeed: 123, net: null };
  const session = new HostSession(game, 'HOST', 'fighter');
  const entry = { key: 'L', impl };
  session.transports.push(entry);
  // Pretend a run is live (skips the world snapshot, which needs a real sync).
  session.state = 'inRun';
  session.sync = null;
  return { session, entry, impl, sent, broadcasts };
}

const hello = (name, token, ship = 'fighter') =>
  ({ name, shipId: ship, ver: NET_PROTOCOL_VERSION, token });

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 1. Drop holds the slot (grace), does not remove');
{
  const { session, entry, broadcasts } = makeHost();
  session._handleHello(entry, 100, hello('ALICE', 'tok-A'));
  const pid = session._clientToPid.get('L100');
  ok('joined with a pid', pid !== undefined && pid > 0, `pid=${pid}`);
  const p = session.players.get(pid);
  ok('token stored on player', p.token === 'tok-A');

  session._onClientClosed(entry, 100);
  ok('player NOT removed during grace', session.players.has(pid));
  ok('player flagged disconnected', session.players.get(pid).disconnected === true);
  ok('grace timer armed', !!session.players.get(pid)._graceTimer);
  ok('broadcast PLAYER_DISCONNECTED',
    broadcasts.some(m => m && m.type === MSG.PLAYER_DISCONNECTED && m.payload.pid === pid));
  clearTimeout(session.players.get(pid)._graceTimer);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 2. Reconnect within grace reuses the SAME pid');
{
  const { session, entry, broadcasts } = makeHost();
  session._handleHello(entry, 100, hello('ALICE', 'tok-A'));
  const pid = session._clientToPid.get('L100');
  session._onClientClosed(entry, 100);

  // Relay assigns a fresh clientId on reconnect.
  session._handleHello(entry, 207, hello('ALICE', 'tok-A'));
  ok('same pid after reattach', session._clientToPid.get('L207') === pid,
    `new key -> ${session._clientToPid.get('L207')}, pid=${pid}`);
  ok('old clientId mapping cleared', session._clientToPid.get('L100') === undefined);
  ok('disconnected flag cleared', session.players.get(pid).disconnected === false);
  ok('grace timer cancelled', !session.players.get(pid)._graceTimer);
  ok('no extra slot allocated', session.players.size === 2 /* host + alice */,
    `size=${session.players.size}`);
  ok('broadcast PLAYER_RECONNECTED',
    broadcasts.some(m => m && m.type === MSG.PLAYER_RECONNECTED && m.payload.pid === pid));
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 3. Stale close for the OLD clientId is ignored after reattach');
{
  const { session, entry } = makeHost();
  session._handleHello(entry, 100, hello('ALICE', 'tok-A'));
  const pid = session._clientToPid.get('L100');
  session._onClientClosed(entry, 100);
  session._handleHello(entry, 207, hello('ALICE', 'tok-A'));

  // The relay finally delivers the OLD socket's 'D' — must be a no-op.
  session._onClientClosed(entry, 100);
  ok('player still connected after stale close', session.players.has(pid));
  ok('still mapped to live clientId', session._clientToPid.get('L207') === pid);
  ok('not flagged disconnected', session.players.get(pid).disconnected !== true);
}

// ───────────────────────────────────────────────────────────────────────────
console.log('\n# 4. Grace expiry frees the slot but retains ship/stats for restore');
{
  const { session, entry, sent, broadcasts } = makeHost();
  session._handleHello(entry, 100, hello('ALICE', 'tok-A', 'looper'));
  const pid = session._clientToPid.get('L100');

  // Client uploaded its ship/stats.
  const blob = { health: 42, level: 5, inventory: null };
  session._onClientMessage(entry, 100, encode(MSG.PLAYER_PERSIST, { shipId: 'looper', blob }));
  // (compare by value — encode/decode round-trips through JSON, so it's a copy)
  ok('blob cached by token', session._tokenBlobs.get('tok-A')?.blob?.health === 42);

  // Drop, then force grace expiry.
  session._onClientClosed(entry, 100);
  session._finalizeDrop(pid);
  ok('slot freed after finalize', !session.players.has(pid));
  ok('PLAYER_LEFT broadcast', broadcasts.some(m => m && m.type === MSG.PLAYER_LEFT && m.payload.pid === pid));
  ok('ship/stats retained past grace', session._tokenBlobs.has('tok-A'));

  // Later rejoin with the same token → REUSES the original pid (stable colour)
  // + retained blob folded into the snapshot.
  sent.length = 0;
  session._handleHello(entry, 300, hello('ALICE', 'tok-A'));
  const newPid = session._clientToPid.get('L300');
  ok('reuses original pid on late rejoin (stable colour)', newPid === pid, `old=${pid} new=${newPid}`);
  ok('restored hull from retained blob', session.players.get(newPid).shipId === 'looper');
  const welcome = sent.find(s => s.msg && s.msg.type === MSG.WELCOME);
  ok('got a WELCOME', !!welcome);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
