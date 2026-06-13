// Transport abstraction.
//
// Concrete transports today:
//   HostTransport        — wraps the Electron main-process WebSocket server via
//                          the preload bridge (window.novaNet). Desktop-only.
//   ClientTransport      — a plain WebSocket to ws://ip:port (LAN/direct play).
//   RelayHostTransport   — hosts a room on the NOVA relay (Cloudflare Worker)
//                          over WSS. Works everywhere, incl. the HTTPS web
//                          build, no port forwarding. See relay/.
//   RelayClientTransport — joins a relay room by code.
//
// A future Steam build adds SteamHostTransport/SteamClientTransport over the
// Steamworks networking API with the exact same interface — nothing above this
// layer knows about sockets or join codes.

import { getRelayUrl, getRelayKey } from './relayConfig.js';

export function hostingAvailable() {
    return typeof window !== 'undefined' && !!window.novaNet;
}

// ── Host side ────────────────────────────────────────────────────────────────
export class HostTransport {
    constructor() {
        this.onClientConnected = null;  // (clientId)
        this.onClientMessage = null;    // (clientId, rawString)
        this.onClientClosed = null;     // (clientId)
        this._unsubs = [];
        this.port = 0;
        this.lanIPs = [];
    }

    async start(port) {
        if (!hostingAvailable()) {
            return { ok: false, error: 'Hosting requires the NOVA desktop app.' };
        }
        const res = await window.novaNet.hostStart(port);
        if (!res.ok) return res;
        this.port = res.port;
        this.lanIPs = res.lanIPs || [];

        this._unsubs.push(window.novaNet.onClientConnected(({ id }) => {
            if (this.onClientConnected) this.onClientConnected(id);
        }));
        this._unsubs.push(window.novaNet.onClientMessage(({ id, data }) => {
            if (this.onClientMessage) this.onClientMessage(id, data);
        }));
        this._unsubs.push(window.novaNet.onClientClosed(({ id }) => {
            if (this.onClientClosed) this.onClientClosed(id);
        }));
        return res;
    }

    sendTo(clientId, raw) { window.novaNet.sendTo(clientId, raw); }
    broadcast(raw, exceptId = 0) { window.novaNet.broadcast(raw, exceptId); }
    kick(clientId) { window.novaNet.kick(clientId); }

    stop() {
        for (const unsub of this._unsubs) { try { unsub(); } catch { /* noop */ } }
        this._unsubs = [];
        if (hostingAvailable()) window.novaNet.hostStop();
    }
}

// ── Client side ──────────────────────────────────────────────────────────────
export class ClientTransport {
    constructor() {
        this.onMessage = null;  // (rawString)
        this.onOpen = null;
        this.onClose = null;
        this.ws = null;
        this.connected = false;
    }

    connect(ip, port, timeoutMs = 8000) {
        return this.connectUrl(`ws://${ip}:${port}`, timeoutMs,
            'Connection blocked by the browser. Use a relay code, or the desktop app for direct play.');
    }

    connectUrl(url, timeoutMs = 8000, blockedMessage = 'Connection failed.') {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok, error) => {
                if (settled) return;
                settled = true;
                resolve({ ok, error });
            };
            let ws;
            try {
                ws = new WebSocket(url);
            } catch (err) {
                // https pages block ws:// — surface a useful message.
                finish(false, blockedMessage);
                return;
            }
            this.ws = ws;

            const timer = setTimeout(() => {
                try { ws.close(); } catch { /* noop */ }
                finish(false, 'Connection timed out. Check the join code and that the host is online.');
            }, timeoutMs);

            ws.onopen = () => {
                clearTimeout(timer);
                this.connected = true;
                if (this.onOpen) this.onOpen();
                finish(true);
            };
            ws.onmessage = (e) => {
                if (this.onMessage) this.onMessage(e.data);
            };
            ws.onclose = () => {
                clearTimeout(timer);
                const wasConnected = this.connected;
                this.connected = false;
                if (wasConnected && this.onClose) this.onClose();
                finish(false, 'Could not reach the host.');
            };
            ws.onerror = () => { /* onclose fires after */ };
        });
    }

    send(raw) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(raw);
        }
    }

    close() {
        this.connected = false;
        if (this.ws) {
            this.ws.onclose = null;
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
    }
}

// ── Relay (Cloudflare Worker rooms — works on the website, no port forward) ──

function relayWsBase() {
    return getRelayUrl().replace(/^http/, 'ws');
}

function relayKeyParam() {
    const key = getRelayKey();
    return key ? `&k=${encodeURIComponent(key)}` : '';
}

// Host side: one WSS connection carries every client, multiplexed with tiny
// envelopes (relay/src/worker.js documents the framing). Exposes the exact
// same surface as HostTransport so HostSession can run both at once.
//
// Resilient: if the relay socket drops unexpectedly (network blip, relay
// redeploy) it re-claims the same room with backoff — the relay parks the
// clients for a grace window, so a host hiccup no longer ends the world.
export class RelayHostTransport {
    constructor() {
        this.onClientConnected = null;  // (clientId)
        this.onClientMessage = null;    // (clientId, rawString)
        this.onClientClosed = null;     // (clientId)
        this.onClosed = null;           // relay connection permanently lost
        this.ws = null;
        this.code = null;               // room code (the join code)
        this._clientIds = new Set();
        this._stopped = false;
        this._reconnecting = false;
        this._pingTimer = null;
        this._lastAlive = 0;            // last time the relay proved itself alive
    }

    async start() {
        const base = getRelayUrl();
        if (!base) return { ok: false, error: 'No relay configured.' };

        // 1. Get a fresh room code.
        try {
            const key = getRelayKey();
            const resp = await fetch(`${base}/create${key ? `?k=${encodeURIComponent(key)}` : ''}`, {
                method: 'POST',
                signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined,
            });
            if (!resp.ok) return { ok: false, error: `Relay refused (${resp.status}).` };
            this.code = (await resp.json()).code;
        } catch {
            return { ok: false, error: 'Could not reach the relay.' };
        }

        // 2. Claim the room as host.
        if (!(await this._connect(8000))) {
            this.code = null;
            return { ok: false, error: 'Relay connection timed out.' };
        }
        return { ok: true };
    }

    // Open (or re-open) the room socket. Resolves true once claimed.
    _connect(timeoutMs) {
        return new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
            let ws;
            try {
                ws = new WebSocket(`${relayWsBase()}/room/${this.code}?role=host${relayKeyParam()}`);
            } catch {
                finish(false);
                return;
            }
            this.ws = ws;
            const timer = setTimeout(() => {
                try { ws.close(); } catch { /* noop */ }
                finish(false);
            }, timeoutMs);

            ws.onopen = () => {
                clearTimeout(timer);
                // From here on, a close means an established leg dropped.
                ws.onclose = () => this._onSocketClosed(ws);
                this._lastAlive = performance.now();
                this._startHeartbeat();
                finish(true);
            };
            ws.onmessage = (e) => this._onFrame(String(e.data));
            ws.onclose = () => {
                clearTimeout(timer);
                finish(false);
            };
        });
    }

    // Ping the relay every 2s and treat 6s of silence as a dead leg. A
    // half-open socket (network drop with no FIN) never fires onclose, and a
    // close handshake can wedge in CLOSING forever — this is the only way to
    // notice either within "a few seconds".
    _startHeartbeat() {
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => {
            if (this._stopped || this._reconnecting || !this.ws) return;
            const rs = this.ws.readyState;
            const force = (why) => {
                console.warn(`[net] relay leg ${why} — forcing reconnect`);
                const ws = this.ws;
                ws.onclose = null;
                try { ws.close(); } catch { /* noop */ }
                this._onSocketClosed(ws);
            };
            if (rs === WebSocket.OPEN) {
                this._sendRaw('P0:');
                if (performance.now() - this._lastAlive > 6000) force('unresponsive');
            } else if (rs === WebSocket.CLOSING || rs === WebSocket.CLOSED) {
                force('stuck closing'); // onclose never delivered
            }
        }, 2000);
    }

    _onFrame(raw) {
        this._lastAlive = performance.now();
        const sep = raw.indexOf(':');
        if (sep < 1) return;
        if (raw[0] === 'P') return; // heartbeat pong
        const id = parseInt(raw.slice(1, sep), 10) || 0;
        const body = raw.slice(sep + 1);
        switch (raw[0]) {
            case 'C':
                this._clientIds.add(id);
                if (this.onClientConnected) this.onClientConnected(id);
                break;
            case 'M':
                if (this.onClientMessage) this.onClientMessage(id, body);
                break;
            case 'D':
                this._clientIds.delete(id);
                if (this.onClientClosed) this.onClientClosed(id);
                break;
            case 'R': {
                // Roster on (re)claim — drop clients that left while we were
                // away (their D frames went nowhere).
                const live = new Set(body
                    ? body.split(',').map(n => parseInt(n, 10)).filter(n => n > 0)
                    : []);
                for (const known of [...this._clientIds]) {
                    if (!live.has(known)) {
                        this._clientIds.delete(known);
                        if (this.onClientClosed) this.onClientClosed(known);
                    }
                }
                break;
            }
        }
    }

    async _onSocketClosed(ws) {
        if (this._stopped || this._reconnecting || this.ws !== ws) return;
        this._reconnecting = true;
        this.ws = null;
        // Transient blip or relay redeploy — try to re-claim the room before
        // declaring the world over. Kept SHORT: clients sit frozen while the
        // host is gone, so a few seconds of retries is the most that's fair.
        console.warn('[net] relay socket lost — reconnecting...');
        const deadline = performance.now() + 8000;
        let attempt = 0;
        while (!this._stopped && performance.now() < deadline) {
            attempt++;
            await new Promise(r => setTimeout(r, 500));
            if (this._stopped) return;
            if (await this._connect(3000)) {
                console.warn(`[net] relay reconnected (attempt ${attempt})`);
                this._reconnecting = false;
                return; // roster frame reconciles who came/went
            }
            console.warn(`[net] relay reconnect attempt ${attempt} failed`);
        }
        this._reconnecting = false;
        if (this._stopped) return;
        console.warn('[net] relay reconnect gave up — dropping relay leg');
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this.ws) {
            // Last failed attempt may have left a dead socket behind.
            this.ws.onclose = null;
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
        for (const id of [...this._clientIds]) {
            this._clientIds.delete(id);
            if (this.onClientClosed) this.onClientClosed(id);
        }
        if (this.onClosed) this.onClosed();
    }

    _sendRaw(text) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(text);
        }
    }

    sendTo(clientId, raw) { this._sendRaw(`S${clientId}:${raw}`); }
    broadcast(raw, exceptId = 0) { this._sendRaw(`B${exceptId}:${raw}`); }
    kick(clientId) { this._sendRaw(`K${clientId}:`); }

    stop() {
        this._stopped = true;
        if (this._pingTimer) {
            clearInterval(this._pingTimer);
            this._pingTimer = null;
        }
        if (this.ws) {
            this.ws.onclose = null;
            try { this.ws.close(); } catch { /* noop */ }
            this.ws = null;
        }
        this._clientIds.clear();
    }
}

// Client side: indistinguishable from a direct connection above this layer —
// the relay forwards raw game-protocol strings both ways.
export class RelayClientTransport extends ClientTransport {
    connectRelay(code, timeoutMs = 8000) {
        const base = getRelayUrl();
        if (!base) {
            return Promise.resolve({ ok: false, error: 'No relay configured.' });
        }
        return this.connectUrl(
            `${relayWsBase()}/room/${code}?role=client`,
            timeoutMs,
            'Relay connection blocked.'
        );
    }
}
