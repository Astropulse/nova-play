// NetSession — connection/lobby/identity layer for multiplayer.
//
// One NetSession lives on `game.net` while multiplayer is active (lobby or
// in-run). It owns the transport, the player registry, chat, and message
// routing. World replication lives in netSync.js (HostWorldSync /
// ClientWorldSync) and is attached to the session as `session.sync` while a
// run is in progress.
//
// pid 0 is always the host. The host relays everything — clients never talk
// to each other directly, which keeps the topology simple and makes the host
// the single ground truth (per design).

import { HostTransport, ClientTransport, RelayHostTransport, RelayClientTransport, hostingAvailable } from './transport.js';
import { relayAvailable } from './relayConfig.js';
import { MSG, NET_PROTOCOL_VERSION, NET_MAX_PLAYERS, encode, decode } from './protocol.js';
import { randomSeed } from '../engine/rng.js';

function netNow() {
    return performance.now() / 1000;
}

// How long the host holds a dropped client's slot/pid/ghost open for a seamless
// auto-reconnect, and how long the client keeps retrying before giving up. The
// player's serialized ship/stats are retained for the WHOLE run regardless, so a
// later rejoin (past this window) still restores them into a fresh slot.
const RECONNECT_GRACE_MS = 10000;
const RECONNECT_GRACE_S = RECONNECT_GRACE_MS / 1000;

const TOKEN_KEY = 'nova_mp_token';

// A stable per-install identity so the host can recognise a returning player
// across a fresh socket (and even a full game relaunch) and give them their
// ship + stats back.
function loadOrCreateToken() {
    try {
        let t = localStorage.getItem(TOKEN_KEY);
        if (!t) {
            t = 'T' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            localStorage.setItem(TOKEN_KEY, t);
        }
        return t;
    } catch {
        // Private mode / storage blocked — a per-session token still enables the
        // in-grace seamless reconnect (just not restore after a relaunch).
        return 'T' + Math.random().toString(36).slice(2);
    }
}

class NetSessionBase {
    constructor(game) {
        this.game = game;
        this.isHost = false;
        this.pid = -1;
        this.myName = 'PILOT';
        this.players = new Map(); // pid -> {pid, name, shipId, alive, inRun, clientId?}
        this.state = 'lobby';     // 'lobby' | 'inRun' | 'ended'
        this.sync = null;         // HostWorldSync | ClientWorldSync while in run
        this.chatLog = [];        // [{pid, name, text, time}]

        // UI callbacks
        this.onLobbyChanged = null;   // ()
        this.onStartRun = null;       // ({runSeed, worldSeed, joinSnapshot|null})
        this.onChat = null;           // ({pid, name, text})
        this.onEnded = null;          // (reason)

        this._handlers = new Map();   // type -> fn(payload, fromPid)
    }

    get isMultiplayer() { return true; }
    get playerCount() { return this.players.size; }

    playerName(pid) {
        const p = this.players.get(pid);
        return p ? p.name : `P${pid}`;
    }

    on(type, fn) { this._handlers.set(type, fn); }
    off(type) { this._handlers.delete(type); }

    _dispatch(type, payload, fromPid) {
        const fn = this._handlers.get(type);
        if (fn) fn(payload, fromPid);
    }

    pushChat(pid, text) {
        const entry = { pid, name: this.playerName(pid), text, time: netNow() };
        this.chatLog.push(entry);
        if (this.chatLog.length > 100) this.chatLog.shift();
        if (this.onChat) this.onChat(entry);
    }

    _notifyLobby() {
        if (this.onLobbyChanged) this.onLobbyChanged();
    }

    lobbySnapshot() {
        return [...this.players.values()].map(p => ({
            pid: p.pid, name: p.name, shipId: p.shipId, alive: p.alive !== false,
            inRun: !!p.inRun, disconnected: !!p.disconnected
        }));
    }
}

// ── Host ─────────────────────────────────────────────────────────────────────
// A host can serve several transports at once: on desktop the LAN/direct
// server AND a relay room run side by side (relay code works for web players,
// ip codes for LAN). On the web build only the relay leg exists. Each client
// is keyed by `<transportKey><clientId>` (e.g. 'L3', 'R1') so ids never clash.
export class HostSession extends NetSessionBase {
    constructor(game, name, shipId) {
        super(game);
        this.isHost = true;
        this.pid = 0;
        this.myName = name;
        this.transports = []; // [{key:'L'|'R', impl}]
        this.players.set(0, { pid: 0, name, shipId, alive: true, inRun: false, clientId: 0, transport: null });
        this._clientToPid = new Map(); // `${key}${clientId}` -> pid
        this._nextPid = 1;
        // token -> {shipId, blob} — each client's last uploaded ship/stats, kept
        // for the whole run so a returning pilot (even after a relaunch) is
        // restored exactly. The host owns this record.
        this._tokenBlobs = new Map();
        this.runSeed = null;
        this.joinCodeInfo = null; // {port, lanIPs, publicIP, relayCode, relayError}
    }

    _wireTransport(key, impl) {
        const entry = { key, impl };
        impl.onClientMessage = (clientId, raw) => this._onClientMessage(entry, clientId, raw);
        impl.onClientClosed = (clientId) => this._onClientClosed(entry, clientId);
        // Connections only become players after a valid HELLO.
        this.transports.push(entry);
        return entry;
    }

    async start(port) {
        this.joinCodeInfo = { port: 0, lanIPs: [], publicIP: null, relayCode: null, relayError: null };

        // LAN/direct server (desktop only).
        let lanRes = null;
        if (hostingAvailable()) {
            const lan = new HostTransport();
            lanRes = await lan.start(port);
            if (!lanRes.ok && port !== 0) {
                // Port taken (another NOVA on this machine) — let the OS pick.
                lanRes = await lan.start(0);
            }
            if (lanRes.ok) {
                this._wireTransport('L', lan);
                this.joinCodeInfo.port = lan.port;
                this.joinCodeInfo.lanIPs = lan.lanIPs;
            }
        }

        // Relay room (works everywhere, incl. the website).
        if (relayAvailable()) {
            const relay = new RelayHostTransport();
            relay.onClosed = () => this._onRelayDown();
            const relayRes = await relay.start();
            if (relayRes.ok) {
                this._wireTransport('R', relay);
                this.joinCodeInfo.relayCode = relay.code;
            } else {
                this.joinCodeInfo.relayError = relayRes.error || 'Relay unavailable.';
            }
        }

        if (this.transports.length === 0) {
            return {
                ok: false,
                error: (lanRes && lanRes.error) || this.joinCodeInfo.relayError || 'Hosting is not available here.',
            };
        }

        // Best-effort public IP for internet play (optional, never blocks).
        if (this.joinCodeInfo.port) {
            try {
                const ipRes = await Promise.race([
                    fetch('https://api.ipify.org?format=json').then(r => r.json()),
                    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
                ]);
                if (ipRes && ipRes.ip) this.joinCodeInfo.publicIP = ipRes.ip;
            } catch { /* offline or blocked — LAN codes still work */ }
        }

        return { ok: true };
    }

    _onRelayDown() {
        // The relay leg dropped; its clients were already closed out one by one.
        if (this.state === 'ended') return;
        this.transports = this.transports.filter(t => t.key !== 'R');
        if (this.joinCodeInfo) {
            this.joinCodeInfo.relayCode = null;
            this.joinCodeInfo.relayError = 'Relay connection lost.';
        }
        if (this.transports.length === 0) {
            // Web host with no other leg — the world can't be reached anymore.
            const reason = 'Lost connection to the relay.';
            this.destroy(reason);
            if (this.onEnded) this.onEnded(reason);
            return;
        }
        this._notifyLobby();
    }

    _onClientMessage(entry, clientId, raw) {
        const msg = decode(raw);
        if (!msg) return;
        const pid = this._clientToPid.get(entry.key + clientId);

        if (msg.type === MSG.HELLO) {
            this._handleHello(entry, clientId, msg.payload || {});
            return;
        }
        if (pid === undefined) return; // not authenticated yet

        switch (msg.type) {
            case MSG.CHAT: {
                const text = String((msg.payload && msg.payload.text) || '').slice(0, 200);
                if (!text) return;
                this.pushChat(pid, text);
                this.broadcast(MSG.CHAT, { pid, text });
                return;
            }
            case MSG.SHIP_CHANGE: {
                const p = this.players.get(pid);
                if (p && this.state === 'lobby') {
                    p.shipId = msg.payload.shipId;
                    this._broadcastLobby();
                    this._notifyLobby();
                }
                return;
            }
            case MSG.PING:
                this.sendTo(pid, MSG.PONG, { t: msg.payload.t, ht: netNow() });
                return;
            case MSG.PLAYER_PERSIST: {
                // Client uploaded its current ship/stats — cache by token so we
                // can hand it straight back if they reconnect (host owns state).
                const p = this.players.get(pid);
                if (p && p.token && msg.payload && msg.payload.blob) {
                    // Keep the pid too so a late rejoin reuses the same identity
                    // (pilot colour is derived from pid — it must stay stable).
                    this._tokenBlobs.set(p.token, { pid: p.pid, shipId: msg.payload.shipId || p.shipId, blob: msg.payload.blob });
                }
                return;
            }
            default:
                this._dispatch(msg.type, msg.payload, pid);
        }
    }

    _handleHello(entry, clientId, hello) {
        if (hello.ver !== NET_PROTOCOL_VERSION) {
            entry.impl.sendTo(clientId, encode(MSG.REJECT, { reason: 'Version mismatch — both players need the same game version.' }));
            entry.impl.kick(clientId);
            return;
        }

        // Returning pilot? A matching token means a held grace slot (seamless
        // resume) or a retained ship/stats record (restore into a fresh slot).
        if (hello.token && this.state === 'inRun') {
            const held = this._findDisconnectedByToken(hello.token);
            if (held) { this._reattachPlayer(held, entry, clientId); return; }
        }

        if (this.players.size >= NET_MAX_PLAYERS) {
            entry.impl.sendTo(clientId, encode(MSG.REJECT, { reason: 'World is full (8 players max).' }));
            entry.impl.kick(clientId);
            return;
        }
        // Grace expired but we still hold their ship/stats — bring them back on
        // their saved hull, original pid (stable colour) and the snapshot below.
        const retained = (hello.token && this.state === 'inRun') ? this._tokenBlobs.get(hello.token) : null;
        let pid;
        if (retained && retained.pid != null && !this.players.has(retained.pid)) {
            pid = retained.pid; // freed pids are never reissued by _nextPid, so this can't collide
            if (pid >= this._nextPid) this._nextPid = pid + 1;
        } else {
            pid = this._nextPid++;
        }
        const name = String(hello.name || `P${pid}`).slice(0, 16) || `P${pid}`;
        const shipId = (retained && retained.shipId) || hello.shipId || 'fighter';
        const player = { pid, name, shipId, alive: true, inRun: false, clientId, transport: entry, token: hello.token || null };
        this.players.set(pid, player);
        this._clientToPid.set(entry.key + clientId, pid);

        this.sendTo(pid, MSG.WELCOME, {
            pid,
            players: this.lobbySnapshot(),
            worldSeed: this.game.worldSeed,
            inRun: this.state === 'inRun',
        });
        this._broadcastLobby(pid);
        this._notifyLobby();
        const joinVerb = retained ? 'reconnected.' : 'joined.';
        this.pushChat(0, `${name} ${joinVerb}`);
        this.broadcast(MSG.CHAT, { pid: 0, text: `${name} ${joinVerb}` }, pid);

        // Mid-run joiner: ship them the full world immediately. A returning pilot
        // also gets their retained ship/stats folded into the snapshot.
        if (this.state === 'inRun' && this.sync) {
            this.sync.sendJoinSnapshot(pid, retained ? { resumeBlob: retained.blob } : undefined);
            player.inRun = true;
        }
    }

    // Find a player currently held in the reconnect grace window by token.
    _findDisconnectedByToken(token) {
        for (const p of this.players.values()) {
            if (p.disconnected && p.token === token) return p;
        }
        return null;
    }

    // Seamless resume: a dropped client came back within the grace window. Reuse
    // the SAME pid and re-point it at the new socket, then resync the world.
    _reattachPlayer(player, entry, clientId) {
        if (player._graceTimer) { clearTimeout(player._graceTimer); player._graceTimer = null; }
        // Drop the stale clientId→pid mapping (the relay assigns a fresh id on
        // reconnect) and install the new one.
        if (player.transport) this._clientToPid.delete(player.transport.key + player.clientId);
        player.transport = entry;
        player.clientId = clientId;
        this._clientToPid.set(entry.key + clientId, player.pid);
        player.disconnected = false;
        player.inRun = true;
        player.alive = true;

        if (this.sync) this.sync.onPlayerReconnected(player.pid);

        this.sendTo(player.pid, MSG.WELCOME, {
            pid: player.pid,
            players: this.lobbySnapshot(),
            worldSeed: this.game.worldSeed,
            inRun: true,
        });
        // resume:true → the client keeps its own live ship; we only resync the
        // shared world it missed during the gap.
        if (this.sync) this.sync.sendJoinSnapshot(player.pid, { resume: true });
        this.broadcast(MSG.PLAYER_RECONNECTED, { pid: player.pid });
        this._broadcastLobby();
        this._notifyLobby();
        this.pushChat(0, `${player.name} reconnected.`);
        this.broadcast(MSG.CHAT, { pid: 0, text: `${player.name} reconnected.` });
    }

    _onClientClosed(entry, clientId) {
        const pid = this._clientToPid.get(entry.key + clientId);
        if (pid === undefined) return;
        const p = this.players.get(pid);
        // Stale close: this socket was already superseded by a reconnect (the
        // relay reassigns clientIds, so a late 'D' for the old id can arrive
        // after the new one took over). Ignore it.
        if (!p || p.clientId !== clientId || p.transport !== entry) return;

        // In a run: hold the slot open for a seamless reconnect rather than
        // tearing the pilot out immediately.
        if (this.state === 'inRun' && !p.disconnected) {
            p.disconnected = true;
            p.inRun = false; // exclude from wave targeting while frozen
            if (this.sync) this.sync.onPlayerDisconnected(pid);
            this.broadcast(MSG.PLAYER_DISCONNECTED, { pid });
            this.pushChat(0, `${p.name} dropped — reconnecting…`);
            this.broadcast(MSG.CHAT, { pid: 0, text: `${p.name} dropped — reconnecting…` });
            this._notifyLobby();
            p._graceTimer = setTimeout(() => { p._graceTimer = null; this._finalizeDrop(pid); }, RECONNECT_GRACE_MS);
            return;
        }

        // Lobby (or already finalising): remove immediately.
        this._clientToPid.delete(entry.key + clientId);
        this.players.delete(pid);
        if (this.sync) this.sync.onPlayerLeft(pid);
        this.broadcast(MSG.PLAYER_LEFT, { pid });
        this.pushChat(0, `${p.name} left.`);
        this.broadcast(MSG.CHAT, { pid: 0, text: `${p.name} left.` });
        this._broadcastLobby();
        this._notifyLobby();
    }

    // Grace window elapsed without a reconnect — release the slot for good. The
    // pilot's ship/stats stay in _tokenBlobs for the rest of the run, so a later
    // rejoin still restores them into a fresh slot.
    _finalizeDrop(pid) {
        const p = this.players.get(pid);
        if (!p || !p.disconnected) return;
        if (p.transport) this._clientToPid.delete(p.transport.key + p.clientId);
        this.players.delete(pid);
        if (this.sync) this.sync.onPlayerLeft(pid);
        this.broadcast(MSG.PLAYER_LEFT, { pid });
        this.pushChat(0, `${p.name} left.`);
        this.broadcast(MSG.CHAT, { pid: 0, text: `${p.name} left.` });
        this._broadcastLobby();
        this._notifyLobby();
    }

    _broadcastLobby(exceptPid = -1) {
        this.broadcast(MSG.LOBBY, { players: this.lobbySnapshot() }, exceptPid);
    }

    sendTo(pid, type, payload) {
        const p = this.players.get(pid);
        if (!p || pid === 0 || !p.transport) return;
        p.transport.impl.sendTo(p.clientId, encode(type, payload));
    }

    sendRawTo(pid, raw) {
        const p = this.players.get(pid);
        if (!p || pid === 0 || !p.transport) return;
        p.transport.impl.sendTo(p.clientId, raw);
    }

    broadcast(type, payload, exceptPid = -1) {
        const raw = encode(type, payload);
        this.broadcastRaw(raw, exceptPid);
    }

    broadcastRaw(raw, exceptPid = -1) {
        const exceptPlayer = exceptPid >= 0 ? this.players.get(exceptPid) : null;
        for (const entry of this.transports) {
            const except = (exceptPlayer && exceptPlayer.transport === entry) ? exceptPlayer.clientId : 0;
            entry.impl.broadcast(raw, except);
        }
    }

    sendChat(text) {
        this.pushChat(0, text);
        this.broadcast(MSG.CHAT, { pid: 0, text });
    }

    setMyShip(shipId) {
        this.players.get(0).shipId = shipId;
        this._broadcastLobby();
        this._notifyLobby();
    }

    // Begin a synchronized fresh run for everyone in the lobby.
    startRun() {
        if (this.game.worldSeed == null) this.game.worldSeed = randomSeed();
        this.runSeed = randomSeed();
        this.state = 'inRun';
        for (const p of this.players.values()) p.inRun = true;
        const payload = {
            runSeed: this.runSeed,
            worldSeed: this.game.worldSeed,
            players: this.lobbySnapshot(),
        };
        this.broadcast(MSG.START, payload);
        if (this.onStartRun) this.onStartRun({ runSeed: this.runSeed, worldSeed: this.game.worldSeed, joinSnapshot: null });
    }

    kickPlayer(pid) {
        const p = this.players.get(pid);
        if (!p || pid === 0 || !p.transport) return;
        this.sendTo(pid, MSG.REJECT, { reason: 'Kicked by host.' });
        p.transport.impl.kick(p.clientId);
    }

    hostNow() { return netNow(); }

    destroy(reason = 'Host closed the world.') {
        this.state = 'ended';
        // Cancel any pending grace timers so they don't fire on a dead session.
        for (const p of this.players.values()) {
            if (p._graceTimer) { clearTimeout(p._graceTimer); p._graceTimer = null; }
        }
        try { this.broadcast(MSG.END, { reason }); } catch { /* noop */ }
        for (const entry of this.transports) {
            try { entry.impl.stop(); } catch { /* noop */ }
        }
        this.transports = [];
        if (this.game.net === this) this.game.net = null;
    }
}

// ── Client ───────────────────────────────────────────────────────────────────
export class ClientSession extends NetSessionBase {
    constructor(game, name, shipId) {
        super(game);
        this.isHost = false;
        this.myName = name;
        this.myShipId = shipId;
        this.transport = new ClientTransport();
        this.runSeed = null;
        this.worldSeed = null;
        this.token = loadOrCreateToken();

        // Reconnect: how to re-reach the host, and whether a retry loop is live.
        this._reconnectFn = null;   // () => Promise<{ok}>  (re-runs connect/connectRelay)
        this._reconnecting = false;
        this.onReconnecting = null; // () — entered the grace retry loop
        this.onReconnected = null;  // () — resumed successfully
        this.onResume = null;       // (snapshot) — re-apply world to the LIVE PlayingState

        // Host-clock estimation (for snapshot interpolation timing)
        this._clockOffset = 0;     // hostTime - localTime
        this._clockSamples = [];
        this.rttMs = 0;
        this._pingTimer = 0;
        this._pendingSnapshot = null;
        this._expectSnapshot = false;
    }

    async connect(ip, port) {
        // Remember how to re-reach this host for a later auto-reconnect.
        this._reconnectFn = () => this.connect(ip, port);
        this.transport = new ClientTransport();
        this.transport.onMessage = (raw) => this._onMessage(raw);
        this.transport.onClose = () => this._onClosed();
        const res = await this.transport.connect(ip, port);
        if (!res.ok) return res;
        return this._sendHelloAndAwaitWelcome();
    }

    // Join through the relay by room code. Above the transport everything is
    // identical to a direct connection — the relay just forwards raw protocol.
    async connectRelay(code) {
        this._reconnectFn = () => this.connectRelay(code);
        this.transport = new RelayClientTransport();
        this.transport.onMessage = (raw) => this._onMessage(raw);
        this.transport.onClose = () => this._onClosed();
        const res = await this.transport.connectRelay(code);
        if (!res.ok) return res;
        return this._sendHelloAndAwaitWelcome();
    }

    _sendHelloAndAwaitWelcome() {
        this.send(MSG.HELLO, {
            name: this.myName, shipId: this.myShipId, ver: NET_PROTOCOL_VERSION,
            token: this.token, resuming: this._reconnecting,
        });

        // Wait for WELCOME / REJECT
        return new Promise((resolve) => {
            this._welcomeResolve = resolve;
            setTimeout(() => {
                if (this._welcomeResolve) {
                    this._welcomeResolve({ ok: false, error: 'Host did not respond.' });
                    this._welcomeResolve = null;
                    this.transport.close();
                }
            }, 8000);
        });
    }

    _onMessage(raw) {
        // Relay keepalive echo — keeps the edge connection warm but is NOT proof
        // the host is alive, so it must not reset the host-silence watchdog.
        if (raw === 'P0:') return;
        this._lastHostMsg = netNow();
        const msg = decode(raw);
        if (!msg) return;
        switch (msg.type) {
            case MSG.WELCOME: {
                const w = msg.payload;
                this.pid = w.pid;
                this.worldSeed = w.worldSeed;
                this.game.worldSeed = w.worldSeed; // identical starfield everywhere
                this.players.clear();
                for (const p of w.players) this.players.set(p.pid, { ...p });
                this._expectSnapshot = !!w.inRun;
                if (this._welcomeResolve) {
                    this._welcomeResolve({ ok: true, inRun: !!w.inRun });
                    this._welcomeResolve = null;
                }
                this._notifyLobby();
                return;
            }
            case MSG.REJECT: {
                const reason = (msg.payload && msg.payload.reason) || 'Rejected by host.';
                if (this._welcomeResolve) {
                    this._welcomeResolve({ ok: false, error: reason });
                    this._welcomeResolve = null;
                }
                this._end(reason);
                return;
            }
            case MSG.LOBBY: {
                const prevSelf = this.players.get(this.pid);
                this.players.clear();
                for (const p of msg.payload.players) this.players.set(p.pid, { ...p });
                if (prevSelf && this.players.has(this.pid)) {
                    // keep any local-only fields if added later
                }
                this._notifyLobby();
                return;
            }
            case MSG.PLAYER_LEFT: {
                const pid = msg.payload.pid;
                this.players.delete(pid);
                if (this.sync) this.sync.onPlayerLeft(pid);
                this._notifyLobby();
                return;
            }
            case MSG.CHAT:
                this.pushChat(msg.payload.pid, msg.payload.text);
                return;
            case MSG.START: {
                const s = msg.payload;
                this.runSeed = s.runSeed;
                this.worldSeed = s.worldSeed;
                this.game.worldSeed = s.worldSeed;
                this.players.clear();
                for (const p of s.players) this.players.set(p.pid, { ...p });
                this.state = 'inRun';
                if (this.onStartRun) this.onStartRun({ runSeed: s.runSeed, worldSeed: s.worldSeed, joinSnapshot: null });
                return;
            }
            case MSG.JOIN_SNAPSHOT: {
                this.state = 'inRun';
                this.runSeed = msg.payload.runSeed;
                // Seamless resume: we kept our live PlayingState through a blip,
                // so re-apply the world snapshot in place rather than rebuilding.
                if (msg.payload.resume && this.onResume) {
                    this.onResume(msg.payload);
                } else if (this.onStartRun) {
                    this.onStartRun({
                        runSeed: msg.payload.runSeed,
                        worldSeed: this.worldSeed,
                        joinSnapshot: msg.payload,
                    });
                }
                return;
            }
            case MSG.PLAYER_DISCONNECTED: {
                const info = this.players.get(msg.payload.pid);
                if (info) info.disconnected = true;
                if (this.sync) this.sync.onPlayerDisconnected(msg.payload.pid);
                this._notifyLobby();
                return;
            }
            case MSG.PLAYER_RECONNECTED: {
                const info = this.players.get(msg.payload.pid);
                if (info) info.disconnected = false;
                if (this.sync) this.sync.onPlayerReconnected(msg.payload.pid);
                this._notifyLobby();
                return;
            }
            case MSG.PONG: {
                const nowS = netNow();
                const rtt = nowS - msg.payload.t;
                this.rttMs = Math.round(rtt * 1000);
                const offset = (msg.payload.ht + rtt / 2) - nowS;
                this._clockSamples.push(offset);
                if (this._clockSamples.length > 8) this._clockSamples.shift();
                // Median is robust against delayed packets.
                const sorted = [...this._clockSamples].sort((a, b) => a - b);
                this._clockOffset = sorted[Math.floor(sorted.length / 2)];
                return;
            }
            case MSG.END:
                this._end((msg.payload && msg.payload.reason) || 'Session ended.');
                return;
            default:
                this._dispatch(msg.type, msg.payload, 0);
        }
    }

    _onClosed() {
        // A blip during a live run: don't drop to the menu — keep the run alive
        // and try to get back in within the grace window.
        if (this.state === 'inRun' && this._reconnectFn) {
            this.state = 'reconnecting';
            if (this.onReconnecting) this.onReconnecting();
            this._runReconnectLoop();
            return;
        }
        if (this.state === 'reconnecting') return; // a retry loop already owns it
        this._end('Lost connection to the host.');
    }

    // Re-reach the host on a fresh socket, re-HELLO with our token (so we resume
    // the same pid + ship), and resync. Gives up to the menu after the grace
    // window — past which the host has released our slot, but still holds our
    // ship/stats for a manual rejoin.
    async _runReconnectLoop() {
        if (this._reconnecting) return;
        this._reconnecting = true;
        const deadline = netNow() + RECONNECT_GRACE_S;
        while (this.state === 'reconnecting' && netNow() < deadline) {
            try { this.transport.close(); } catch { /* noop */ }
            let res = null;
            try { res = await this._reconnectFn(); } catch { res = { ok: false }; }
            if (this.state !== 'reconnecting') { this._reconnecting = false; return; }
            if (res && res.ok) {
                // Reseed clock + interpolation so remote ships don't snap from
                // stale timing after the gap, then resume the live run.
                this._clockSamples = [];
                this._clockOffset = 0;
                this._lastHostMsg = netNow();
                this._pingTimer = 0;
                this._reconnecting = false;
                this.state = 'inRun';
                if (this.sync && this.sync.resetRemoteInterp) this.sync.resetRemoteInterp();
                if (this.onReconnected) this.onReconnected();
                return;
            }
            await new Promise(r => setTimeout(r, 600));
        }
        this._reconnecting = false;
        if (this.state === 'reconnecting') {
            this.state = 'inRun'; // let _end run its normal teardown
            this._end('Lost connection to the host.');
        }
    }

    _end(reason) {
        if (this.state === 'ended') return;
        this.state = 'ended';
        this.transport.close();
        if (this.game.net === this) this.game.net = null;
        if (this.onEnded) this.onEnded(reason);
    }

    // Periodic upkeep — called every frame by whoever owns the session.
    update(dt) {
        // While reconnecting, the retry loop owns all timing — don't ping a dead
        // socket or trip the silence cutoff mid-recovery.
        if (this.state !== 'inRun') return;
        this._pingTimer -= dt;
        if (this._pingTimer <= 0) {
            this._pingTimer = 2.0;
            this.send(MSG.PING, { t: netNow() });
        }
        // The host answers every PING; in-run it also broadcasts constantly.
        // Sustained silence = the host is gone, OR our socket is half-open and
        // will never fire onclose. Route through the reconnect path (not a hard
        // end) so a half-open drop still gets the grace window.
        if (this._lastHostMsg && netNow() - this._lastHostMsg > 11) {
            this._onClosed();
        }
    }

    hostNow() { return netNow() + this._clockOffset; }

    send(type, payload) { this.transport.send(encode(type, payload)); }
    sendRaw(raw) { this.transport.send(raw); }

    sendChat(text) {
        this.send(MSG.CHAT, { text: String(text).slice(0, 200) });
        // Host echoes back to everyone including us — don't double-add locally.
    }

    setMyShip(shipId) {
        this.myShipId = shipId;
        const me = this.players.get(this.pid);
        if (me) me.shipId = shipId;
        this.send(MSG.SHIP_CHANGE, { shipId });
    }

    destroy() {
        this.state = 'ended';
        this.transport.close();
        if (this.game.net === this) this.game.net = null;
    }
}
