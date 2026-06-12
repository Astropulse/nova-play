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
            pid: p.pid, name: p.name, shipId: p.shipId, alive: p.alive !== false, inRun: !!p.inRun
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
        if (this.players.size >= NET_MAX_PLAYERS) {
            entry.impl.sendTo(clientId, encode(MSG.REJECT, { reason: 'World is full (8 players max).' }));
            entry.impl.kick(clientId);
            return;
        }
        const pid = this._nextPid++;
        const name = String(hello.name || `P${pid}`).slice(0, 16) || `P${pid}`;
        const player = { pid, name, shipId: hello.shipId || 'fighter', alive: true, inRun: false, clientId, transport: entry };
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
        this.pushChat(0, `${name} joined.`);
        this.broadcast(MSG.CHAT, { pid: 0, text: `${name} joined.` }, pid);

        // Mid-run joiner: ship them the full world immediately.
        if (this.state === 'inRun' && this.sync) {
            this.sync.sendJoinSnapshot(pid);
            player.inRun = true;
        }
    }

    _onClientClosed(entry, clientId) {
        const pid = this._clientToPid.get(entry.key + clientId);
        if (pid === undefined) return;
        this._clientToPid.delete(entry.key + clientId);
        const p = this.players.get(pid);
        this.players.delete(pid);
        if (this.sync) this.sync.onPlayerLeft(pid);
        this.broadcast(MSG.PLAYER_LEFT, { pid });
        if (p) {
            this.pushChat(0, `${p.name} left.`);
            this.broadcast(MSG.CHAT, { pid: 0, text: `${p.name} left.` });
        }
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

        // Host-clock estimation (for snapshot interpolation timing)
        this._clockOffset = 0;     // hostTime - localTime
        this._clockSamples = [];
        this.rttMs = 0;
        this._pingTimer = 0;
        this._pendingSnapshot = null;
        this._expectSnapshot = false;
    }

    async connect(ip, port) {
        this.transport.onMessage = (raw) => this._onMessage(raw);
        this.transport.onClose = () => this._onClosed();
        const res = await this.transport.connect(ip, port);
        if (!res.ok) return res;
        return this._sendHelloAndAwaitWelcome();
    }

    // Join through the relay by room code. Above the transport everything is
    // identical to a direct connection — the relay just forwards raw protocol.
    async connectRelay(code) {
        this.transport = new RelayClientTransport();
        this.transport.onMessage = (raw) => this._onMessage(raw);
        this.transport.onClose = () => this._onClosed();
        const res = await this.transport.connectRelay(code);
        if (!res.ok) return res;
        return this._sendHelloAndAwaitWelcome();
    }

    _sendHelloAndAwaitWelcome() {
        this.send(MSG.HELLO, { name: this.myName, shipId: this.myShipId, ver: NET_PROTOCOL_VERSION });

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
                if (this.onStartRun) {
                    this.onStartRun({
                        runSeed: msg.payload.runSeed,
                        worldSeed: this.worldSeed,
                        joinSnapshot: msg.payload,
                    });
                }
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
        this._end('Lost connection to the host.');
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
        this._pingTimer -= dt;
        if (this._pingTimer <= 0) {
            this._pingTimer = 2.0;
            this.send(MSG.PING, { t: netNow() });
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
