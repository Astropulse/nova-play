// Multiplayer screen — host a world or join one with a code, hang out in the
// lobby (pick ships, chat), then launch the shared run.
//
// Flow:
//   MENU → [HOST]  → server starts → join code on screen → friends connect →
//                    START FLIGHT → everyone spawns into the same seeded world.
//   MENU → [JOIN]  → enter code → lobby (or instantly into a run in progress).
//
// Visual language mirrors the achievements screen (header bar, card panels,
// text buttons, home-button footer) with the title screen's ship presentation
// (arrow sprites + stat bars) for the ship selector.
//
// The lobby survives into the run: the same NetSession object moves onto
// game.net and PlayingState picks it up from there.

import { SHIPS } from '../data/ships.js';
import { PlayingState } from './playingState.js';
import { MenuState } from './menuState.js';
import { HostSession, ClientSession } from '../net/netSession.js';
import { hostingAvailable } from '../net/transport.js';
import { relayAvailable, looksLikeRelayCode, normalizeRelayCode, formatRelayCode } from '../net/relayConfig.js';
import { encodeJoinCode, decodeJoinCode } from '../net/joinCode.js';
import { NET_DEFAULT_PORT, NET_MAX_PLAYERS } from '../net/protocol.js';
import { playerColor } from '../ui/chat.js';
import { GP } from '../engine/inputManager.js';

const NAME_KEY = 'nova_mp_name';
const MAX_LOCAL = 4; // local couch co-op caps at 4 pilots

// Deterministic spawn ring for synchronized starts — every machine computes
// every pilot's spawn the same way, so the initial world lines up exactly.
export function spawnForPid(pid) {
    if (pid === 0) return { x: 0, y: 0 };
    const angle = ((pid - 1) / (NET_MAX_PLAYERS - 1)) * Math.PI * 2;
    return { x: Math.round(Math.cos(angle) * 150), y: Math.round(Math.sin(angle) * 150) };
}

export class MultiplayerState {
    constructor(game) {
        this.game = game;
        this.mode = 'menu';   // 'menu' | 'hostStarting' | 'lobby' | 'joinEntry' | 'connecting' | 'localLobby'
        this.session = null;
        // Local co-op lobby roster: [{ device:'kb'|'gamepad', padIndex, shipIndex }].
        // Slot 0 (keyboard host) is created on entering the local lobby.
        this.localRoster = null;
        this.error = '';
        this.statusText = '';
        this.shipIndex = 0;
        this.time = 0;

        this.pilotName = (localStorage.getItem(NAME_KEY) || '').slice(0, 16) || `PILOT${Math.floor(Math.random() * 900 + 100)}`;
        this.codeInput = '';
        this.activeField = null; // 'name' | 'code' | 'chat'
        this.chatInput = '';
        this.chatScroll = 0;      // lines scrolled back from the newest message
        this._chatMsgRect = null; // lobby chat message area (wheel hover target)
        this.cursorTimer = 0;
        this.showCursor = true;

        this._buttons = {};        // id -> rect (rebuilt every draw)
        this._hovered = null;      // id under the mouse this frame
        this._starting = false;
        // Gamepad spatial-focus navigation (mirrors the title screen): a single
        // navigator focuses any on-screen button by id and A activates it.
        this._focusId = null;
        this._navMode = null;            // last mode seen (resets focus on change)
        this._navStickLatched = false;   // flick-latch for left-stick nav
        this._lastMouseHovered = null;   // prev mouse hover (for the hover blip)

        // "COPIED!" feedback for the join-code copy buttons
        this._copiedId = null;
        this._copiedTimer = 0;

        this._keydownListener = (e) => this._handleKeydown(e);
    }

    enter() {
        document.body.classList.remove('playing');
        this.game.rng = null;
        window.addEventListener('keydown', this._keydownListener);
    }

    exit() {
        window.removeEventListener('keydown', this._keydownListener);
        // If we leave this screen without entering a run, tear the session down
        // — unless a run start is in flight (PlayingState owns it from here).
        if (this.session && !this._starting) {
            this.session.destroy();
            this.session = null;
            this.game.net = null;
        }
    }

    // ── Text input ───────────────────────────────────────────────────────────
    _handleKeydown(e) {
        if (!this.activeField) return;
        if (e.key === 'Escape') {
            this.activeField = null;
        } else if (e.key === 'Enter') {
            if (this.activeField === 'code') {
                this.activeField = null;
                this._tryJoin();
            } else if (this.activeField === 'chat') {
                const text = this.chatInput.trim();
                if (text && this.session) this.session.sendChat(text);
                this.chatInput = '';
                this.activeField = null;
            } else {
                this.activeField = null;
            }
        } else if (e.key === 'Backspace') {
            if (this.activeField === 'name') this.pilotName = this.pilotName.slice(0, -1);
            else if (this.activeField === 'code') this.codeInput = this.codeInput.slice(0, -1);
            else if (this.activeField === 'chat') this.chatInput = this.chatInput.slice(0, -1);
        } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
            // Ctrl+V pastes into whichever field is focused (and never types a
            // literal "V").
            this._pasteFromClipboard();
        } else if (e.ctrlKey || e.metaKey) {
            return; // other shortcuts — don't type their letters
        } else if (e.key.length === 1) {
            if (this.activeField === 'name' && this.pilotName.length < 16) {
                if (/[a-zA-Z0-9_\- ]/.test(e.key)) this.pilotName += e.key.toUpperCase();
            } else if (this.activeField === 'code' && this.codeInput.length < 24) {
                this.codeInput += e.key.toUpperCase();
            } else if (this.activeField === 'chat' && this.chatInput.length < 200) {
                this.chatInput += e.key;
            }
        } else {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
    }

    _saveName() {
        const name = this.pilotName.trim() || 'PILOT';
        this.pilotName = name;
        localStorage.setItem(NAME_KEY, name);
        return name;
    }

    // ── Clipboard (join-code copy buttons) ───────────────────────────────────
    _copyToClipboard(text, id) {
        const done = () => {
            this._copiedId = id;
            this._copiedTimer = 1.6;
            this.game.sounds.play('select', 0.8);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done).catch(() => { this._legacyCopy(text); done(); });
        } else {
            this._legacyCopy(text);
            done();
        }
    }

    // Paste clipboard text into the focused (or join-code) field.
    async _pasteFromClipboard(targetField = null) {
        const field = targetField || this.activeField || 'code';
        let text = '';
        try {
            text = await navigator.clipboard.readText();
        } catch {
            this.error = 'Could not read the clipboard.';
            return;
        }
        text = (text || '').trim();
        if (!text) return;
        if (field === 'code') {
            this.codeInput = text.toUpperCase().slice(0, 24);
        } else if (field === 'name') {
            this.pilotName = text.toUpperCase().replace(/[^A-Z0-9_\- ]/g, '').slice(0, 16);
        } else if (field === 'chat') {
            this.chatInput = (this.chatInput + text).slice(0, 200);
        }
        this.game.sounds.play('select', 0.6);
    }

    _legacyCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch { /* best effort */ }
        ta.remove();
    }

    // ── Session wiring ───────────────────────────────────────────────────────
    _wireSession(session) {
        this.session = session;
        this.game.net = session;
        session.onLobbyChanged = () => { /* redrawn every frame */ };
        // Keep the chat view anchored while scrolled back (the window is
        // relative to the newest message, so each arrival shifts it by one).
        session.onChat = () => { if (this.chatScroll > 0) this.chatScroll++; };
        session.onEnded = (reason) => {
            if (this._starting) return;
            this.session = null;
            this.game.net = null;
            this.mode = 'menu';
            this.error = reason || 'Session ended.';
        };
        session.onStartRun = (info) => this._launchRun(info);
    }

    async _startHosting() {
        this.error = '';
        if (!hostingAvailable() && !relayAvailable()) {
            this.error = 'Hosting needs the NOVA desktop app (the web version can only join).';
            return;
        }
        this.mode = 'hostStarting';
        this.statusText = 'Starting host server...';
        const name = this._saveName();
        const session = new HostSession(this.game, name, SHIPS[this.shipIndex].id);
        const res = await session.start(NET_DEFAULT_PORT);
        if (!res.ok) {
            this.error = res.error || 'Could not start the host server.';
            this.mode = 'menu';
            session.destroy();
            return;
        }
        this._wireSession(session);
        this.mode = 'lobby';
    }

    async _tryJoin() {
        this.error = '';
        const target = decodeJoinCode(this.codeInput);
        const relayCode = !target && looksLikeRelayCode(this.codeInput) && relayAvailable()
            ? normalizeRelayCode(this.codeInput) : null;
        if (!target && !relayCode) {
            this.error = 'That join code doesn\'t look right.';
            return;
        }
        this.mode = 'connecting';
        this.statusText = target ? `Connecting to ${target.ip}...` : 'Connecting through the relay...';
        const name = this._saveName();
        const session = new ClientSession(this.game, name, SHIPS[this.shipIndex].id);
        this._wireSession(session);
        const res = target
            ? await session.connect(target.ip, target.port)
            : await session.connectRelay(relayCode);
        if (!res.ok) {
            this.error = res.error || 'Could not connect.';
            this.mode = 'joinEntry';
            this.session = null;
            this.game.net = null;
            return;
        }
        // If the host is mid-run, START/JOIN_SNAPSHOT arrives next and
        // onStartRun fires; otherwise we sit in the lobby.
        this.mode = 'lobby';
        this.statusText = res.inRun ? 'World in progress — joining...' : '';
    }

    _launchRun({ runSeed, worldSeed, joinSnapshot }) {
        if (this._starting) return;
        this._starting = true;
        const game = this.game;
        game.worldSeed = worldSeed != null ? worldSeed : game.worldSeed;

        const me = this.session.players.get(this.session.pid);
        const shipId = (me && me.shipId) || SHIPS[this.shipIndex].id;
        const shipData = SHIPS.find(s => s.id === shipId) || SHIPS[0];

        if (joinSnapshot) {
            const state = new PlayingState(game, shipData, {
                skipInit: true,
                netRun: { runSeed: joinSnapshot.runSeed, spawnX: joinSnapshot.spawnX, spawnY: joinSnapshot.spawnY },
            });
            game.setState(state);
            state.applyNetJoinSnapshot(joinSnapshot);
        } else {
            const spawn = spawnForPid(this.session.pid);
            const state = new PlayingState(game, shipData, {
                netRun: { runSeed, spawnX: spawn.x, spawnY: spawn.y },
            });
            game.setState(state);
        }
    }

    // ── Local split-screen co-op lobby ────────────────────────────────────────
    _enterLocalLobby() {
        this.mode = 'localLobby';
        this.error = '';
        // Empty roster — every pilot opts in: a controller presses A to join, or
        // a keyboard/mouse player clicks an empty slot. Nobody is forced in, so a
        // controller-only group never has an orphan keyboard pilot.
        this.localRoster = [];
    }

    _cycleSlotShip(i, dir) {
        const r = this.localRoster && this.localRoster[i];
        if (!r) return;
        r.shipIndex = (r.shipIndex + dir + SHIPS.length) % SHIPS.length;
        this.game.sounds.play('select', 0.7);
    }

    // All selectable input devices: keyboard + every connected gamepad.
    _availableDevices() {
        const devs = [{ device: 'kb', padIndex: null }];
        const im = this.game.input;
        if (im.getConnectedPadIndices) {
            for (const idx of im.getConnectedPadIndices()) devs.push({ device: 'gamepad', padIndex: idx });
        }
        return devs;
    }

    _sameDevice(a, b) {
        return a.device === b.device && (a.device !== 'gamepad' || a.padIndex === b.padIndex);
    }

    // Cycle slot i to the next/prev device NOT already used by another slot.
    _cycleSlotDevice(i, dir) {
        const roster = this.localRoster;
        const slot = roster && roster[i];
        if (!slot) return;
        const devs = this._availableDevices();
        if (devs.length <= 1) return;
        const claimedByOther = (d) => roster.some((s, j) => j !== i && this._sameDevice(s, d));
        let cur = devs.findIndex(d => this._sameDevice(d, slot));
        if (cur < 0) cur = 0;
        for (let k = 1; k <= devs.length; k++) {
            const d = devs[((cur + dir * k) % devs.length + devs.length) % devs.length];
            if (!claimedByOther(d)) {
                slot.device = d.device;
                slot.padIndex = d.padIndex;
                this.game.sounds.play('select', 0.7);
                return;
            }
        }
    }

    // Add a pilot slot using the first unclaimed device (mouse "+ ADD").
    _addLobbySlot() {
        const roster = this.localRoster;
        if (!roster || roster.length >= MAX_LOCAL) return;
        const free = this._availableDevices().find(d => !roster.some(s => this._sameDevice(s, d)));
        if (!free) return;
        roster.push({ device: free.device, padIndex: free.padIndex, shipIndex: roster.length % SHIPS.length });
        this.game.sounds.play('select', 0.9);
    }

    // Keyboard conveniences in the local lobby (gamepad uses the spatial nav).
    _updateLocalLobby(dt) {
        const im = this.game.input;
        const roster = this.localRoster;
        if (!roster) return;
        const kbSlot = roster.findIndex(r => r.device === 'kb');
        if (kbSlot >= 0) {
            if (im.isKeyJustPressed('ArrowLeft')) this._cycleSlotShip(kbSlot, -1);
            if (im.isKeyJustPressed('ArrowRight')) this._cycleSlotShip(kbSlot, 1);
        }
        if (im.isKeyJustPressed('Enter') && roster.length >= 1) this._launchLocalCoop();
    }

    // ── Gamepad spatial-focus navigation (shared by all MP screens) ───────────
    // The buttons that can hold gamepad focus this frame (every clickable rect
    // except the text-entry fields, which need a keyboard).
    _focusList() {
        const skip = { name: 1, code: 1, chat: 1 };
        const out = [];
        for (const id in this._buttons) {
            const r = this._buttons[id];
            if (r && !skip[id]) out.push({ id, rect: r });
        }
        return out;
    }

    _focusSlotIndex() {
        const m = (this._focusId || '').match(/^(?:slotLeft|slotRight|devLeft|devRight|addSlot)(\d+)$/);
        return m ? parseInt(m[1], 10) : -1;
    }

    // Pick the nearest focusable in the pressed direction (title-screen algorithm).
    _moveFocusSpatial(dirX, dirY, focusables) {
        const cur = focusables.find(f => f.id === this._focusId) || focusables[0];
        const cx = cur.rect.x + cur.rect.w / 2, cy = cur.rect.y + cur.rect.h / 2;
        let bestId = null, bestScore = Infinity;
        const CROSS_PENALTY = 2.0;
        for (const f of focusables) {
            if (f.id === cur.id) continue;
            const rx = f.rect.x + f.rect.w / 2, ry = f.rect.y + f.rect.h / 2;
            const dx = rx - cx, dy = ry - cy;
            if (dirX !== 0) { if (Math.sign(dx) !== dirX) continue; if (Math.abs(dy) > Math.abs(dx) * 2.5) continue; }
            if (dirY !== 0) { if (Math.sign(dy) !== dirY) continue; if (Math.abs(dx) > Math.abs(dy) * 2.5) continue; }
            const primary = dirX !== 0 ? Math.abs(dx) : Math.abs(dy);
            const secondary = dirX !== 0 ? Math.abs(dy) : Math.abs(dx);
            const score = primary + secondary * CROSS_PENALTY;
            if (score < bestScore) { bestScore = score; bestId = f.id; }
        }
        if (bestId) { this._focusId = bestId; this.game.sounds.play('click', 0.5); }
    }

    _updateGamepadNav(input) {
        if (this._navMode !== this.mode) { this._navMode = this.mode; this._focusId = null; }
        if (this.activeField) return; // typing into a text field — don't navigate
        const focusables = this._focusList();
        if (!focusables.length) { this._focusId = null; return; }
        if (!this._focusId || !focusables.some(f => f.id === this._focusId)) this._focusId = focusables[0].id;

        // D-pad: one spatial step per press.
        if (input.isGamepadJustPressed(GP.DLEFT))  this._moveFocusSpatial(-1, 0, focusables);
        if (input.isGamepadJustPressed(GP.DRIGHT)) this._moveFocusSpatial(1, 0, focusables);
        if (input.isGamepadJustPressed(GP.DUP))    this._moveFocusSpatial(0, -1, focusables);
        if (input.isGamepadJustPressed(GP.DDOWN))  this._moveFocusSpatial(0, 1, focusables);
        // Left stick: flick-latched (held tilt doesn't autoscroll), dominant axis.
        const lx = input.leftStickX, ly = input.leftStickY;
        const mag = Math.max(Math.abs(lx), Math.abs(ly));
        if (mag > 0.55) {
            if (!this._navStickLatched) {
                this._navStickLatched = true;
                if (Math.abs(lx) > Math.abs(ly)) this._moveFocusSpatial(lx < 0 ? -1 : 1, 0, focusables);
                else                             this._moveFocusSpatial(0, ly < 0 ? -1 : 1, focusables);
            }
        } else if (mag < 0.25) {
            this._navStickLatched = false;
        }

        // Highlight the focused control while a gamepad is the active device.
        if (input.lastInputDevice === 'gamepad') this._hovered = this._focusId;

        // A activates the focused button (same path as a mouse click).
        if (input.isGamepadJustPressed(GP.A)) this._activateButton(this._focusId);

        // X removes the focused pilot in the local lobby (quick kick).
        if (this.mode === 'localLobby' && input.isGamepadJustPressed(GP.X)) {
            const si = this._focusSlotIndex();
            if (si >= 0 && this.localRoster && si < this.localRoster.length) {
                this.localRoster.splice(si, 1);
                this.game.sounds.play('click', 0.6);
                this._focusId = null;
            }
        }
    }

    _launchLocalCoop() {
        if (this._starting || !this.localRoster || this.localRoster.length < 1) return;
        this._starting = true;
        const game = this.game;
        game.net = null; // local co-op runs no network session
        const roster = this.localRoster.map(r => ({
            shipId: SHIPS[r.shipIndex].id, device: r.device, padIndex: r.padIndex,
        }));
        const shipData = SHIPS.find(s => s.id === roster[0].shipId) || SHIPS[0];
        this.game.sounds.play('select', 1.0);
        game.setState(new PlayingState(game, shipData, { localCoop: roster }));
    }

    _leaveToMenu() {
        this.game.sounds.play('click', 0.6);
        this.game.setState(new MenuState(this.game));
    }

    _leaveLobby() {
        this.game.sounds.play('click', 0.6);
        if (this.session) {
            this.session.destroy();
            this.session = null;
            this.game.net = null;
        }
        this.mode = 'menu';
        this.error = '';
    }

    // ── Update ───────────────────────────────────────────────────────────────
    update(dt) {
        this.time += dt;
        this.cursorTimer += dt;
        if (this.cursorTimer > 0.5) { this.cursorTimer = 0; this.showCursor = !this.showCursor; }
        if (this._copiedTimer > 0) {
            this._copiedTimer -= dt;
            if (this._copiedTimer <= 0) this._copiedId = null;
        }

        const input = this.game.input;
        const mouse = this.game.getMousePos();

        // Hover tracking (buttons laid out by the last draw). The hover "blip"
        // is tracked against the previous MOUSE hover only — `_hovered` is also
        // driven by gamepad focus, so comparing against it would replay the sound
        // every frame (a feedback loop). Only the mouse plays the hover blip.
        let hovered = null;
        for (const [id, r] of Object.entries(this._buttons)) {
            if (r && mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h) {
                hovered = id;
                break;
            }
        }
        if (hovered !== this._lastMouseHovered && hovered && input.lastInputDevice === 'mouse') {
            this.game.sounds.play('click', 0.35);
        }
        this._lastMouseHovered = hovered;
        this._hovered = hovered;

        // Mouse wheel over the lobby chat scrolls back through history.
        const wheel = input.mouseWheelDelta;
        if (wheel && this.mode === 'lobby' && this.session && this._chatMsgRect) {
            const r = this._chatMsgRect;
            if (mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h) {
                const step = Math.max(1, Math.floor(Math.abs(wheel) / 60));
                this.chatScroll += wheel < 0 ? step : -step;
                // Clamped against the live log size in _drawChatPanel.
                this.chatScroll = Math.max(0, this.chatScroll);
            }
        }

        if (this.mode === 'localLobby') this._updateLocalLobby(dt);

        // Gamepad spatial-focus navigation (mirrors the title screen) for every
        // multiplayer screen — focus a button, A activates it (same actions as a
        // mouse click).
        this._updateGamepadNav(input);

        // Back: Escape (kb) or the gamepad B / Back button. (Removal in the local
        // lobby is X, so B is free to mean "back" everywhere.)
        const gpBack = input.isGamepadJustPressed(GP.BACK) || input.isGamepadJustPressed(GP.B);
        if ((input.isKeyJustPressed('Escape') || gpBack) && !this.activeField) {
            if (this.mode === 'lobby' || this.mode === 'connecting') {
                this._leaveLobby();
            } else if (this.mode === 'joinEntry' || this.mode === 'localLobby') {
                this.mode = 'menu';
            } else {
                this._leaveToMenu();
                return;
            }
        }

        if (!input.isMouseJustPressed(0)) return;
        // Mouse click activates whatever the cursor is over (shared with A).
        this.activeField = null;
        this._activateButton(hovered);
    }

    // Run the action bound to a button id — shared by mouse click and gamepad A.
    _activateButton(id) {
        if (!id) return;
        if (id === 'name') { this.activeField = 'name'; return; }
        if (this.mode === 'menu') {
            if (id === 'host') { this.game.sounds.play('select', 1.0); this._startHosting(); }
            else if (id === 'join') { this.game.sounds.play('select', 1.0); this.mode = 'joinEntry'; this.error = ''; }
            else if (id === 'local') { this.game.sounds.play('select', 1.0); this._enterLocalLobby(); }
            else if (id === 'home') { this._leaveToMenu(); }
        } else if (this.mode === 'localLobby') {
            if (id === 'startLocal') { this.game.sounds.play('select', 1.0); this._launchLocalCoop(); }
            else if (id === 'home') { this.game.sounds.play('click', 0.6); this.mode = 'menu'; }
            else if (id.startsWith('slotLeft')) this._cycleSlotShip(parseInt(id.slice(8), 10), -1);
            else if (id.startsWith('slotRight')) this._cycleSlotShip(parseInt(id.slice(9), 10), 1);
            else if (id.startsWith('devLeft')) this._cycleSlotDevice(parseInt(id.slice(7), 10), -1);
            else if (id.startsWith('devRight')) this._cycleSlotDevice(parseInt(id.slice(8), 10), 1);
            else if (id.startsWith('addSlot')) this._addLobbySlot();
        } else if (this.mode === 'joinEntry') {
            if (id === 'code') { this.activeField = 'code'; }
            else if (id === 'paste') { this._pasteFromClipboard('code'); this.activeField = 'code'; }
            else if (id === 'connect') { this.game.sounds.play('select', 1.0); this._tryJoin(); }
            else if (id === 'home') { this.game.sounds.play('click', 0.6); this.mode = 'menu'; }
        } else if (this.mode === 'lobby' && this.session) {
            if (id === 'shipLeft' || id === 'shipRight') {
                this.shipIndex = (this.shipIndex + (id === 'shipLeft' ? -1 : 1) + SHIPS.length) % SHIPS.length;
                this.session.setMyShip(SHIPS[this.shipIndex].id);
                this.game.sounds.play('select', 0.8);
            } else if (id === 'chat') { this.activeField = 'chat'; }
            else if (id === 'copyLan' && this._lanCode) this._copyToClipboard(this._lanCode, 'copyLan');
            else if (id === 'copyNet' && this._netCode) this._copyToClipboard(this._netCode, 'copyNet');
            else if (id === 'copyRelay' && this._relayCode) this._copyToClipboard(this._relayCode, 'copyRelay');
            else if (id === 'start' && this.session.isHost) { this.game.sounds.play('select', 1.0); this.session.startRun(); }
            else if (id === 'home' || id === 'leave') this._leaveLobby();
        }
    }

    // ── Draw ─────────────────────────────────────────────────────────────────
    draw(ctx) {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width, ch = game.height;
        const margin = Math.floor(uiScale * 12);
        this._buttons = {};

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';

        // Background + header bar (matches the achievements screen)
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);

        const headerH = Math.floor(uiScale * 32);
        ctx.fillStyle = '#0a1220';
        ctx.fillRect(0, 0, cw, headerH);

        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(11 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('MULTIPLAYER', cw / 2, Math.floor(headerH * 0.66));

        // Header sub-line
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        let subline = 'CO-OP FOR UP TO 8 PILOTS · ONE SHARED WORLD';
        if (this.mode === 'lobby' && this.session) {
            if (this.session.isHost) {
                // Web hosts run the world in this tab — browsers throttle hidden
                // tabs hard, which would freeze the run for everyone.
                subline = hostingAvailable()
                    ? 'SHARE A JOIN CODE — FRIENDS CAN ALSO JOIN MID-FLIGHT'
                    : 'YOU ARE THE WORLD — KEEP THIS TAB VISIBLE OR EVERYONE FREEZES';
            } else {
                subline = this.statusText || 'WAITING FOR THE HOST TO START THE FLIGHT';
            }
        } else if (this.mode === 'joinEntry') {
            subline = 'ENTER THE JOIN CODE YOUR FRIEND SHARED (RAW IP:PORT ALSO WORKS)';
        } else if (this.mode === 'localLobby') {
            subline = 'SPLIT-SCREEN CO-OP ON THIS SCREEN · UP TO 4 PILOTS';
        }
        ctx.fillText(subline.toUpperCase(), cw / 2, headerH + Math.floor(uiScale * 8));

        // Mode content
        if (this.mode === 'menu') this._drawModeMenu(ctx, headerH);
        else if (this.mode === 'hostStarting' || this.mode === 'connecting') this._drawBusy(ctx);
        else if (this.mode === 'joinEntry') this._drawJoinEntry(ctx, headerH);
        else if (this.mode === 'lobby' && this.session) this._drawLobby(ctx, headerH);
        else if (this.mode === 'localLobby') this._drawLocalLobby(ctx, headerH);

        // Footer: home button (back / leave) bottom-left, like achievements
        const homeSize = game.spriteSize('home_button_off', uiScale);
        this._buttons.home = { x: margin, y: ch - margin - homeSize.h, w: homeSize.w, h: homeSize.h };
        game.drawSprite(ctx, this._hovered === 'home' ? 'home_button_on' : 'home_button_off',
            this._buttons.home.x, this._buttons.home.y, uiScale);

        // Error line above the footer
        if (this.error) {
            ctx.fillStyle = '#ff8866';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.fillText(this.error, cw / 2, ch - margin - Math.floor(uiScale * 2));
        }

        ctx.restore();
    }

    // ── Screens ──────────────────────────────────────────────────────────────
    _drawModeMenu(ctx, headerH) {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width, ch = game.height;

        const colW = Math.min(Math.floor(cw * 0.42), Math.floor(uiScale * 240));
        const colX = Math.floor(cw / 2 - colW / 2);
        // Center the column in the space between header and footer.
        const contentH = Math.floor(uiScale * 95);
        let y = headerH + Math.max(Math.floor(uiScale * 26),
            Math.floor((ch - headerH - contentH) * 0.36));

        // Pilot name
        y = this._drawField(ctx, 'name', 'PILOT NAME', this.pilotName, colX, y, colW);
        y += Math.floor(uiScale * 14);

        // Host / Join cards
        const canHost = hostingAvailable() || relayAvailable();
        let hostDesc = 'Hosting needs the NOVA desktop app — the web version can only join.';
        if (hostingAvailable()) hostDesc = 'Open a world on this PC and invite up to 7 friends with a join code.';
        else if (relayAvailable()) hostDesc = 'Host through the NOVA relay — friends join with your code, no setup.';
        y = this._drawCardButton(ctx, 'host', 'HOST WORLD', hostDesc, colX, y, colW, canHost);
        y += Math.floor(uiScale * 8);
        y = this._drawCardButton(ctx, 'join', 'JOIN WORLD',
            'Enter a friend\'s join code and fly in their world — even mid-flight.',
            colX, y, colW, true);
        y += Math.floor(uiScale * 8);
        this._drawCardButton(ctx, 'local', 'LOCAL CO-OP',
            'Split-screen on this screen — up to 4 pilots, one controller each.',
            colX, y, colW, true);
    }

    _drawBusy(ctx) {
        const game = this.game;
        const uiScale = game.uiScale;
        ctx.fillStyle = '#9fe8ff';
        ctx.font = `${Math.floor(7 * uiScale)}px Astro4x`;
        ctx.textAlign = 'center';
        const dots = '.'.repeat(1 + Math.floor(this.time * 2) % 3);
        ctx.fillText(this.statusText + dots, game.width / 2, game.height / 2);
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillText('ESC to cancel', game.width / 2, game.height / 2 + Math.floor(uiScale * 12));
    }

    _drawJoinEntry(ctx, headerH) {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width;

        const colW = Math.min(Math.floor(cw * 0.42), Math.floor(uiScale * 240));
        const colX = Math.floor(cw / 2 - colW / 2);
        const ch = game.height;
        const contentH = Math.floor(uiScale * 90);
        let y = headerH + Math.max(Math.floor(uiScale * 26),
            Math.floor((ch - headerH - contentH) * 0.36));

        y = this._drawField(ctx, 'name', 'PILOT NAME', this.pilotName, colX, y, colW);
        y += Math.floor(uiScale * 14);

        // Join code field with a PASTE button at its right edge.
        const pasteW = Math.floor(uiScale * 34);
        const pasteGap = Math.floor(uiScale * 4);
        const fieldBottom = this._drawField(ctx, 'code', 'JOIN CODE', this.codeInput,
            colX, y, colW - pasteW - pasteGap, 'e.g. 60N0S-84V41 or 8Q3K-F7NA');
        const fieldH = fieldBottom - y;
        this._buttons.paste = { x: colX + colW - pasteW, y, w: pasteW, h: fieldH };
        this._drawTextButton(ctx, this._buttons.paste, 'PASTE',
            this._hovered === 'paste' ? '#ffffff' : '#9fe8ff',
            this._hovered === 'paste' ? 'rgba(30, 55, 80, 0.95)' : 'rgba(10, 18, 28, 0.85)');
        y = fieldBottom;

        y += Math.floor(uiScale * 14);
        this._drawCardButton(ctx, 'connect', 'CONNECT', 'Fly to your friend\'s world.', colX, y, colW, true);
    }

    // Local co-op lobby: a row of up to 4 pilot slots, each with a ship preview
    // and its input device, plus a START FLIGHT button. Pilot 1 is the
    // keyboard/mouse host; others join by pressing Start on a controller.
    _drawLocalLobby(ctx, headerH) {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width, ch = game.height;
        const margin = Math.floor(uiScale * 12);
        const roster = this.localRoster || [];

        const pageW = Math.floor(cw * 0.88);
        const pageX = Math.floor(cw / 2 - pageW / 2);
        const gap = Math.floor(uiScale * 8);
        const topY = headerH + Math.floor(uiScale * 18);
        const footerReserve = Math.floor(uiScale * 50);
        const panelH = Math.max(Math.floor(uiScale * 110), ch - topY - footerReserve - margin);
        const slotW = Math.floor((pageW - gap * (MAX_LOCAL - 1)) / MAX_LOCAL);

        for (let i = 0; i < MAX_LOCAL; i++) {
            const x = pageX + i * (slotW + gap);
            this._drawLocalSlot(ctx, i, x, topY, slotW, panelH, roster[i]);
        }

        // START FLIGHT (center) + control hint just above it.
        const startSize = game.spriteSize('start_flight_off', uiScale);
        const sx = Math.floor(cw / 2 - startSize.w / 2);
        const sy = ch - margin - startSize.h;
        this._buttons.startLocal = { x: sx, y: sy, w: startSize.w, h: startSize.h };
        game.drawSprite(ctx, this._hovered === 'startLocal' ? 'start_flight_on' : 'start_flight_off', sx, sy, uiScale);

        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.fillText('STICK / D-PAD: MOVE   ·   (A): SELECT   ·   (X): REMOVE PILOT   ·   (B): BACK',
            cw / 2, sy - Math.floor(uiScale * 4));
    }

    // Smooth filled chevron arrow (device selector). dir: -1 points left, +1 right.
    _drawChevron(ctx, cxp, cyp, dir, w, h, color) {
        const hw = w / 2, hh = h / 2;
        ctx.save();
        ctx.fillStyle = color;
        ctx.beginPath();
        if (dir < 0) {
            ctx.moveTo(cxp + hw, cyp - hh);
            ctx.lineTo(cxp - hw, cyp);
            ctx.lineTo(cxp + hw, cyp + hh);
        } else {
            ctx.moveTo(cxp - hw, cyp - hh);
            ctx.lineTo(cxp + hw, cyp);
            ctx.lineTo(cxp - hw, cyp + hh);
        }
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    _drawLocalSlot(ctx, i, x, y, w, h, slot) {
        const game = this.game;
        const uiScale = game.uiScale;
        this._panel(ctx, x, y, w, h, `P${i + 1}`);

        const cx = x + Math.floor(w / 2);
        const headerSpace = Math.floor(uiScale * 16);
        const padX = Math.floor(uiScale * 6);

        if (!slot) {
            // Empty slot — clickable to add, or press Start on a controller.
            this._buttons['addSlot' + i] = { x, y, w, h };
            const hov = this._hovered === 'addSlot' + i;
            ctx.textAlign = 'center';
            const baseY = y + Math.floor(h * 0.38);
            ctx.fillStyle = hov ? '#9fe8ff' : '#33414f';
            ctx.font = `${Math.floor(18 * uiScale)}px Astro5x`;
            ctx.fillText('+', cx, baseY);
            ctx.fillStyle = hov ? '#9fb4c4' : '#556677';
            ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
            ctx.fillText('ADD PILOT', cx, baseY + Math.floor(uiScale * 24));
            ctx.fillStyle = hov ? '#667788' : '#445566';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText('(A) OR CLICK', cx, baseY + Math.floor(uiScale * 36));
            return;
        }

        const ship = SHIPS[slot.shipIndex] || SHIPS[0];
        const arrowSize = game.spriteSize('left_arrow_off', uiScale);

        // ── Sizes (uiScale-derived; generous gaps). The ship-select arrows sit at
        //    the LEFT/RIGHT panel edges so the ship owns the wide middle (like the
        //    title screen). The sprite is fit to a uiScale box and scaled
        //    fractionally + smoothed (the lobby pilot-icon technique) so it scales
        //    DOWN cleanly instead of overrunning at native size.
        const dRowH = Math.floor(uiScale * 14);    // device selector row
        const gap = Math.floor(uiScale * 16);      // space between sections
        const nameBlockH = Math.floor(uiScale * 22);
        const statLineH = Math.floor(uiScale * 9);
        const statsBlockH = 5 * statLineH;
        const availTop = y + headerSpace;
        const availH = h - headerSpace - Math.floor(uiScale * 8);

        // Ship at the title-screen scale (game.uiScale). The select arrows are
        // anchored to the SHIP (they flank it with a small gap), so the ship +
        // arrows together must fit the column — shrink the ship only if they
        // wouldn't (or the leftover vertical space is too small).
        const shipArrowGap = Math.floor(uiScale * 10);
        const otherH = dRowH + gap * 3 + nameBlockH + statsBlockH;
        const fitW = w - (arrowSize.w + shipArrowGap) * 2 - Math.floor(uiScale * 10);
        const fitH = availH - otherH;
        const asset = game.assets.get(ship.assets.still);
        let dw = 0, dh = 0, img = null;
        if (asset) {
            img = asset.canvas || asset;
            const aw = asset.width || img.width, ah = asset.height || img.height;
            const shipScale = Math.min(uiScale, fitW / aw, fitH / ah);
            dw = aw * shipScale; dh = ah * shipScale;
        }
        const boxH = dh; // preview occupies the ship's actual drawn height

        // Center the whole block vertically in the panel (like the online lobby).
        const contentH = dRowH + gap + boxH + gap + nameBlockH + gap + statsBlockH;
        const blockTop = availTop + Math.max(0, Math.floor((availH - contentH) / 2));

        // ── Device selector: ◄ LABEL ► — bold label flanked by smooth, rendered
        //    chevron arrows sized to the text (not icon-button sprites). ──
        const devLabel = slot.device === 'kb' ? 'KEYBOARD' : `GAMEPAD ${slot.padIndex + 1}`;
        const devColor = slot.device === 'kb' ? '#9fe8ff' : playerColor(i);
        const dRowY = blockTop;
        const dMidY = dRowY + Math.floor(dRowH / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        const devLabelW = ctx.measureText(devLabel).width;
        ctx.fillStyle = devColor;
        ctx.fillText(devLabel, cx, dMidY);
        const chGap = Math.floor(uiScale * 10);
        const chW = Math.floor(uiScale * 6);
        const chH = Math.floor(uiScale * 10);
        const lcx = cx - devLabelW / 2 - chGap - chW / 2;
        const rcx = cx + devLabelW / 2 + chGap + chW / 2;
        const hitPad = Math.floor(uiScale * 6);
        this._buttons['devLeft' + i] = { x: Math.floor(lcx - chW / 2 - hitPad), y: dRowY, w: chW + hitPad * 2, h: dRowH };
        this._buttons['devRight' + i] = { x: Math.floor(rcx - chW / 2 - hitPad), y: dRowY, w: chW + hitPad * 2, h: dRowH };
        this._drawChevron(ctx, lcx, dMidY, -1, chW, chH, this._hovered === 'devLeft' + i ? '#ffffff' : '#7088a0');
        this._drawChevron(ctx, rcx, dMidY, 1, chW, chH, this._hovered === 'devRight' + i ? '#ffffff' : '#7088a0');
        ctx.textBaseline = 'alphabetic';

        // ── Ship preview (centered), select arrows anchored to the ship width ──
        const previewCY = dRowY + dRowH + gap + Math.floor(boxH / 2);
        if (img) {
            ctx.imageSmoothingEnabled = true;
            ctx.drawImage(img, Math.floor(cx - dw / 2), Math.floor(previewCY - dh / 2), dw, dh);
            ctx.imageSmoothingEnabled = false;
        }
        const ax0 = Math.floor(cx - dw / 2 - shipArrowGap - arrowSize.w);
        const ax1 = Math.floor(cx + dw / 2 + shipArrowGap);
        const ay = previewCY - arrowSize.h / 2;
        this._buttons['slotLeft' + i] = { x: ax0, y: ay, w: arrowSize.w, h: arrowSize.h };
        this._buttons['slotRight' + i] = { x: ax1, y: ay, w: arrowSize.w, h: arrowSize.h };
        game.drawSprite(ctx, this._hovered === 'slotLeft' + i ? 'left_arrow_on' : 'left_arrow_off', ax0, ay, uiScale);
        game.drawSprite(ctx, this._hovered === 'slotRight' + i ? 'right_arrow_on' : 'right_arrow_off', ax1, ay, uiScale);

        // ── Ship name + special — exact fonts/spacing from the online lobby's
        //    YOUR SHIP panel (_drawShipPanel): name 8·Astro5x, special 5·Astro4x. ──
        let textY = previewCY + Math.floor(boxH / 2) + Math.floor(uiScale * 12);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.floor(8 * uiScale)}px Astro5x`;
        ctx.fillText(ship.name.toUpperCase(), cx, textY);
        textY += Math.floor(uiScale * 9);
        if (ship.special) {
            ctx.fillStyle = '#44ddff';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText(`[${ship.special.toUpperCase()}]`, cx, textY);
        }

        // ── Stat bars — exact layout from _drawShipPanel ──
        const stats = [
            { label: 'HEALTH', value: ship.health, max: 200, color: '#44ff66' },
            { label: 'SHIELD', value: ship.shield, max: 60, color: '#44aaff' },
            { label: 'SPEED', value: ship.speed, max: 10, color: '#aa66ff' },
            { label: 'DAMAGE', value: ship.baseDamage, max: 15, color: '#ff4444' },
            { label: 'CARGO', value: ship.storage.rows, max: 5, color: '#ffaa44' },
        ];
        const barH = Math.floor(uiScale * 3);
        const labelW = Math.floor(uiScale * 30);
        const labelGap = Math.floor(uiScale * 4);
        const barW = Math.min(Math.floor(w * 0.45), Math.floor(uiScale * 110));
        const blockX = Math.floor(cx - (labelW + labelGap + barW) / 2);
        const labelRight = blockX + labelW;
        const barX = labelRight + labelGap;
        let sy = textY + Math.floor(uiScale * 12);
        ctx.font = `${Math.floor(6 * uiScale)}px Astro4x`;
        for (const stat of stats) {
            if (sy + barH > y + h - Math.floor(uiScale * 6)) break;
            ctx.fillStyle = '#667788';
            ctx.textAlign = 'right';
            ctx.fillText(stat.label, labelRight, sy + barH);
            ctx.fillStyle = '#1a2233';
            ctx.fillRect(barX, sy, barW, barH);
            ctx.fillStyle = stat.color;
            ctx.fillRect(barX, sy, Math.floor((stat.value / stat.max) * barW), barH);
            sy += statLineH;
        }
        ctx.textAlign = 'center';
    }

    _drawLobby(ctx, headerH) {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width, ch = game.height;
        const s = this.session;
        const margin = Math.floor(uiScale * 12);

        // Content column — same 70% page width the achievements grid uses.
        const pageW = Math.floor(cw * 0.7);
        const pageX = Math.floor(cw / 2 - pageW / 2);
        const gap = Math.floor(uiScale * 8);

        let topY = headerH + Math.floor(uiScale * 16);

        // ── Join codes (host) ─────────────────────────────────────────────
        if (s.isHost && s.joinCodeInfo) {
            const info = s.joinCodeInfo;
            const lanIP = info.lanIPs && info.lanIPs[0];
            this._lanCode = lanIP ? (encodeJoinCode(lanIP, info.port) || `${lanIP}:${info.port}`) : null;
            this._netCode = info.publicIP ? (encodeJoinCode(info.publicIP, info.port) || `${info.publicIP}:${info.port}`) : null;
            this._relayCode = info.relayCode ? formatRelayCode(info.relayCode) : null;

            // Up to three panels share the row: LAN · INTERNET · RELAY.
            const panels = [];
            if (this._relayCode) {
                panels.push(['copyRelay', 'RELAY', this._relayCode, '#66ff99',
                    'works everywhere — no port forwarding']);
            }
            if (this._lanCode) {
                panels.push(['copyLan', 'SAME NETWORK', this._lanCode, '#44ddff',
                    `${lanIP}:${info.port}`]);
            }
            if (this._netCode) {
                panels.push(['copyNet', 'INTERNET', this._netCode, '#ffd27a',
                    `needs TCP port ${info.port} forwarded to this PC`]);
            }
            if (panels.length > 0) {
                const codeH = Math.floor(uiScale * 34);
                const codeColW = panels.length > 1
                    ? Math.floor((pageW - gap * (panels.length - 1)) / panels.length)
                    : Math.floor(pageW * 0.6);
                let codeX = panels.length > 1 ? pageX : Math.floor(cw / 2 - codeColW / 2);
                for (const [id, label, code, color, note] of panels) {
                    this._drawCodePanel(ctx, id, codeX, topY, codeColW, codeH, label, code, color, note);
                    codeX += codeColW + gap;
                }
                topY += codeH + gap;
            }
        } else {
            this._lanCode = this._netCode = this._relayCode = null;
        }

        // ── Main panels: pilots (left) · your ship (right) ────────────────
        const footerReserve = Math.floor(uiScale * 46);
        const chatH = Math.floor(uiScale * 44);
        const panelsH = Math.max(Math.floor(uiScale * 80), ch - topY - chatH - gap - footerReserve - margin);
        const leftW = Math.floor(pageW * 0.52);
        const rightW = pageW - leftW - gap;

        this._drawPilotsPanel(ctx, pageX, topY, leftW, panelsH);
        this._drawShipPanel(ctx, pageX + leftW + gap, topY, rightW, panelsH);

        // ── Chat ──────────────────────────────────────────────────────────
        const chatY = topY + panelsH + gap;
        this._drawChatPanel(ctx, pageX, chatY, pageW, chatH);

        // ── Footer: start flight (host) / waiting (client), leave right ───
        const homeSize = game.spriteSize('home_button_off', uiScale);
        if (s.isHost) {
            const startSize = game.spriteSize('start_flight_off', uiScale);
            const sx = Math.floor(cw / 2 - startSize.w / 2);
            const sy = ch - margin - startSize.h;
            this._buttons.start = { x: sx, y: sy, w: startSize.w, h: startSize.h };
            game.drawSprite(ctx, this._hovered === 'start' ? 'start_flight_on' : 'start_flight_off', sx, sy, uiScale);
        } else {
            ctx.fillStyle = '#667788';
            ctx.font = `${Math.floor(6 * uiScale)}px Astro4x`;
            ctx.textAlign = 'center';
            const dots = '.'.repeat(1 + Math.floor(this.time * 2) % 3);
            ctx.fillText(`waiting for ${s.playerName(0)} to start the flight${dots}`,
                cw / 2, ch - margin - Math.floor(uiScale * 8));
        }

        const leaveW = Math.floor(uiScale * 64);
        this._buttons.leave = { x: cw - margin - leaveW, y: ch - margin - homeSize.h, w: leaveW, h: homeSize.h };
        this._drawTextButton(ctx, this._buttons.leave, s.isHost ? 'CLOSE WORLD' : 'LEAVE',
            this._hovered === 'leave' ? '#ff8844' : '#aa4444',
            this._hovered === 'leave' ? 'rgba(60, 18, 12, 0.92)' : 'rgba(28, 10, 10, 0.85)');
    }

    // ── Lobby panels ─────────────────────────────────────────────────────────
    _drawPilotsPanel(ctx, x, y, w, h) {
        const game = this.game;
        const uiScale = game.uiScale;
        const s = this.session;

        this._panel(ctx, x, y, w, h, `PILOTS  ${s.playerCount} / ${NET_MAX_PLAYERS}`);

        const padX = Math.floor(uiScale * 6);
        const headerSpace = Math.floor(uiScale * 16);
        const slotH = Math.floor((h - headerSpace - padX) / NET_MAX_PLAYERS);
        const iconH = Math.floor(slotH * 0.78);

        const players = [...s.players.values()].sort((a, b) => a.pid - b.pid);
        for (let i = 0; i < NET_MAX_PLAYERS; i++) {
            const rowY = y + headerSpace + i * slotH;
            const p = players[i];

            // Row separator
            ctx.strokeStyle = 'rgba(34, 85, 106, 0.25)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + padX, rowY + slotH - 0.5);
            ctx.lineTo(x + w - padX, rowY + slotH - 0.5);
            ctx.stroke();

            if (!p) {
                ctx.fillStyle = '#2a3646';
                ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
                ctx.textAlign = 'left';
                ctx.fillText('— open slot —', x + padX + Math.floor(iconH * 1.4), rowY + Math.floor(slotH * 0.62));
                continue;
            }

            const ship = SHIPS.find(sh => sh.id === p.shipId) || SHIPS[0];

            // Ship icon — scaled to a FIXED slot height so every ship reads at
            // the same size regardless of its native sprite dimensions. Drawn
            // with smoothing ON (like world rendering): the 4×-prescaled sprite
            // downsamples cleanly, so small icons stay crisp instead of
            // nearest-neighbor crunchy.
            const asset = game.assets.get(ship.assets.still);
            if (asset) {
                const img = asset.canvas || asset;
                const aw = asset.width || img.width;
                const ah = asset.height || img.height;
                const scale = iconH / Math.max(aw, ah);
                const dw = aw * scale, dh = ah * scale;
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(img, x + padX + (iconH - dw) / 2, rowY + (slotH - dh) / 2, dw, dh);
                ctx.imageSmoothingEnabled = false;
            }

            const textX = x + padX + Math.floor(iconH * 1.4);
            const midY = rowY + Math.floor(slotH * 0.45);
            ctx.textAlign = 'left';
            ctx.fillStyle = playerColor(p.pid);
            ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
            ctx.fillText(p.name, textX, midY);

            ctx.fillStyle = '#8899aa';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText(ship.name.toUpperCase(), textX, midY + Math.floor(uiScale * 7));

            // Tags as right-aligned chips
            const tags = [];
            if (p.pid === 0) tags.push('HOST');
            if (p.pid === s.pid) tags.push('YOU');
            let chipRight = x + w - padX;
            ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
            for (const tag of tags) {
                const tw = ctx.measureText(tag).width + Math.floor(uiScale * 5);
                const chipH = Math.floor(uiScale * 8);
                const chipX = chipRight - tw;
                const chipY = rowY + Math.floor((slotH - chipH) / 2);
                ctx.fillStyle = 'rgba(68, 221, 255, 0.12)';
                ctx.fillRect(chipX, chipY, tw, chipH);
                ctx.strokeStyle = 'rgba(68, 221, 255, 0.45)';
                ctx.strokeRect(chipX + 0.5, chipY + 0.5, tw - 1, chipH - 1);
                ctx.fillStyle = '#9fe8ff';
                ctx.textAlign = 'center';
                ctx.fillText(tag, chipX + tw / 2, chipY + chipH - Math.floor(uiScale * 2.2));
                ctx.textAlign = 'left';
                chipRight = chipX - Math.floor(uiScale * 3);
            }
        }
    }

    _drawShipPanel(ctx, x, y, w, h) {
        const game = this.game;
        const uiScale = game.uiScale;
        const ship = SHIPS[this.shipIndex];

        this._panel(ctx, x, y, w, h, 'YOUR SHIP');

        const cx = x + Math.floor(w / 2);
        const headerSpace = Math.floor(uiScale * 16);
        const availH = h - headerSpace - Math.floor(uiScale * 8);

        // Ship preview — the hero of the panel: a BIG sprite filling roughly
        // the upper half, flanked by the title-screen arrow buttons.
        // The special-tag line is ALWAYS reserved (even for ships without one)
        // so the vertical centering doesn't shift when cycling past the Looper.
        const nameBlockH = Math.floor(uiScale * (12 + 9 + 9));
        const statsBlockH = Math.floor(uiScale * (12 + 9 * 5));
        const previewH = Math.max(Math.floor(uiScale * 40),
            Math.min(Math.floor(availH - nameBlockH - statsBlockH - uiScale * 6), Math.floor(uiScale * 110)));
        const contentH = previewH + nameBlockH + statsBlockH + Math.floor(uiScale * 6);
        const blockTop = y + headerSpace + Math.max(0, Math.floor((availH - contentH) / 2));
        const previewCY = blockTop + Math.floor(previewH / 2);

        const asset = game.assets.get(ship.assets.still);
        if (asset) {
            const img = asset.canvas || asset;
            const aw = asset.width || img.width;
            const ah = asset.height || img.height;
            // Whole-integer pixel scale (same snapping as uiScale elsewhere) so
            // the sprite's pixels stay perfectly square at any panel size.
            const scale = Math.max(1, Math.floor(previewH / Math.max(aw, ah)));
            const dw = aw * scale, dh = ah * scale;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img, Math.floor(cx - dw / 2), Math.floor(previewCY - dh / 2), dw, dh);
        }

        // Arrows anchor on the preview BOX, not the sprite's own width, so they
        // don't slide around as ships of different sizes cycle through.
        const arrowSize = game.spriteSize('left_arrow_off', uiScale);
        const arrowGapX = Math.floor(previewH / 2 + uiScale * 12);
        this._buttons.shipLeft = { x: cx - arrowGapX - arrowSize.w, y: previewCY - arrowSize.h / 2, w: arrowSize.w, h: arrowSize.h };
        this._buttons.shipRight = { x: cx + arrowGapX, y: previewCY - arrowSize.h / 2, w: arrowSize.w, h: arrowSize.h };
        game.drawSprite(ctx, this._hovered === 'shipLeft' ? 'left_arrow_on' : 'left_arrow_off',
            this._buttons.shipLeft.x, this._buttons.shipLeft.y, uiScale);
        game.drawSprite(ctx, this._hovered === 'shipRight' ? 'right_arrow_on' : 'right_arrow_off',
            this._buttons.shipRight.x, this._buttons.shipRight.y, uiScale);

        // Name + special. The special line's slot is always consumed (the tag
        // just stays blank for ships without one) — stable layout across ships.
        let textY = blockTop + previewH + Math.floor(uiScale * 12);
        ctx.fillStyle = '#ffffff';
        ctx.font = `${Math.floor(8 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText(ship.name.toUpperCase(), cx, textY);
        textY += Math.floor(uiScale * 9);
        if (ship.special) {
            ctx.fillStyle = '#44ddff';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText(`[${ship.special.toUpperCase()}]`, cx, textY);
        }

        // Stat bars — same set as the title screen, centered as a block
        // (label column + bar column together straddle the panel's midline).
        const stats = [
            { label: 'HEALTH', value: ship.health, max: 200, color: '#44ff66' },
            { label: 'SHIELD', value: ship.shield, max: 60, color: '#44aaff' },
            { label: 'SPEED', value: ship.speed, max: 10, color: '#aa66ff' },
            { label: 'DAMAGE', value: ship.baseDamage, max: 15, color: '#ff4444' },
            { label: 'CARGO', value: ship.storage.rows, max: 5, color: '#ffaa44' },
        ];
        const lineH = Math.floor(uiScale * 9);
        const barH = Math.floor(uiScale * 3);
        const labelW = Math.floor(uiScale * 30);
        const labelGap = Math.floor(uiScale * 4);
        const barW = Math.min(Math.floor(w * 0.45), Math.floor(uiScale * 110));
        const blockW = labelW + labelGap + barW;
        const blockX = Math.floor(cx - blockW / 2);
        const labelRight = blockX + labelW;
        const barX = labelRight + labelGap;
        let sy = textY + Math.floor(uiScale * 12);

        ctx.font = `${Math.floor(6 * uiScale)}px Astro4x`;
        for (const stat of stats) {
            if (sy + barH > y + h - Math.floor(uiScale * 6)) break;
            ctx.fillStyle = '#667788';
            ctx.textAlign = 'right';
            ctx.fillText(stat.label, labelRight, sy + barH);

            ctx.fillStyle = '#1a2233';
            ctx.fillRect(barX, sy, barW, barH);
            ctx.fillStyle = stat.color;
            ctx.fillRect(barX, sy, Math.floor((stat.value / stat.max) * barW), barH);
            sy += lineH;
        }
        ctx.textAlign = 'center';
    }

    _drawChatPanel(ctx, x, y, w, h) {
        const game = this.game;
        const uiScale = game.uiScale;
        const s = this.session;

        this._panel(ctx, x, y, w, h, 'COMMS');

        const padX = Math.floor(uiScale * 6);
        const headerSpace = Math.floor(uiScale * 14);
        const inputH = Math.floor(uiScale * 10);
        const lineH = Math.floor(uiScale * 7);

        // Messages — newest at the bottom, clipped to the panel. The wheel
        // scrolls back through history (handled in update via _chatMsgRect).
        const msgBottom = y + h - inputH - Math.floor(uiScale * 4);
        const maxLines = Math.max(1, Math.floor((msgBottom - (y + headerSpace)) / lineH));
        const total = s.chatLog.length;
        const maxScroll = Math.max(0, total - maxLines);
        if (this.chatScroll > maxScroll) this.chatScroll = maxScroll;
        const winEnd = total - this.chatScroll;
        const lines = s.chatLog.slice(Math.max(0, winEnd - maxLines), winEnd);
        this._chatMsgRect = { x: x + 2, y: y + Math.floor(uiScale * 4), w: w - 4, h: msgBottom - y - Math.floor(uiScale * 4) };
        ctx.textAlign = 'left';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        let cy = msgBottom - (lines.length - 1) * lineH;
        for (const m of lines) {
            ctx.fillStyle = playerColor(m.pid);
            const nameStr = `${m.name}: `;
            ctx.fillText(nameStr, x + padX, cy);
            ctx.fillStyle = '#ccddee';
            ctx.fillText(m.text, x + padX + ctx.measureText(nameStr).width, cy);
            cy += lineH;
        }
        if (lines.length === 0) {
            ctx.fillStyle = '#2a3646';
            ctx.fillText('say hi while you wait...', x + padX, y + headerSpace + lineH);
        }

        // Slim scrollbar once the log overflows; thumb sits at the bottom
        // while live and rides up as you scroll back.
        if (total > maxLines) {
            const trackX = x + w - Math.floor(uiScale * 2) - 2;
            const trackY = y + headerSpace - Math.floor(lineH * 0.7);
            const trackH = msgBottom - trackY;
            ctx.fillStyle = 'rgba(34, 85, 106, 0.35)';
            ctx.fillRect(trackX, trackY, 2, trackH);
            const thumbH = Math.max(Math.floor(uiScale * 4), Math.floor(trackH * maxLines / total));
            const thumbY = trackY + Math.floor((trackH - thumbH) * (maxScroll - this.chatScroll) / maxScroll);
            ctx.fillStyle = this.chatScroll > 0 ? '#44ddff' : '#22556a';
            ctx.fillRect(trackX, thumbY, 2, thumbH);
        }

        // Input row
        const inputY = y + h - inputH - Math.floor(uiScale * 2);
        this._buttons.chat = { x: x + 2, y: inputY, w: w - 4, h: inputH };
        const active = this.activeField === 'chat';
        ctx.fillStyle = active ? 'rgba(68, 221, 255, 0.10)' : 'rgba(255, 255, 255, 0.04)';
        ctx.fillRect(x + 2, inputY, w - 4, inputH);
        ctx.strokeStyle = active ? '#44ddff' : 'rgba(34, 85, 106, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 2.5, inputY + 0.5, w - 5, inputH - 1);
        ctx.fillStyle = active ? '#ffffff' : '#556677';
        let chatText = active ? this.chatInput : 'click to chat...';
        if (active && this.showCursor) chatText += '_';
        ctx.fillText(chatText, x + padX, inputY + inputH - Math.floor(uiScale * 3));
    }

    _drawCodePanel(ctx, id, x, y, w, h, label, code, color, note) {
        const game = this.game;
        const uiScale = game.uiScale;

        // Panel
        ctx.fillStyle = 'rgba(20, 40, 60, 0.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#22556a';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        const padX = Math.floor(uiScale * 6);

        // Label + note
        ctx.textAlign = 'left';
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        ctx.fillText(label, x + padX, y + Math.floor(uiScale * 7));
        ctx.fillStyle = '#556677';
        ctx.fillText(note, x + padX, y + h - Math.floor(uiScale * 4));

        // The code itself — shrink to fit beside the copy button (three panels
        // side by side leave less room than the old two-panel layout).
        const btnW = Math.floor(uiScale * 36);
        const codeMaxW = w - padX * 3 - btnW;
        ctx.fillStyle = color;
        for (let size = 9; size >= 5; size--) {
            ctx.font = `${Math.floor(size * uiScale)}px Astro5x`;
            if (ctx.measureText(code).width <= codeMaxW || size === 5) break;
        }
        ctx.fillText(code, x + padX, y + Math.floor(uiScale * 20));

        // Copy button — right side, full of feedback
        const copied = this._copiedId === id;
        const btnH = Math.floor(uiScale * 12);
        const btn = { x: x + w - padX - btnW, y: y + Math.floor((h - btnH) / 2) - Math.floor(uiScale * 2), w: btnW, h: btnH };
        this._buttons[id] = btn;
        this._drawTextButton(ctx, btn,
            copied ? 'COPIED!' : 'COPY',
            copied ? '#44ff88' : (this._hovered === id ? '#ffffff' : '#9fe8ff'),
            copied ? 'rgba(20, 60, 35, 0.92)' : (this._hovered === id ? 'rgba(30, 55, 80, 0.95)' : 'rgba(10, 18, 28, 0.85)'));
    }

    // ── Shared widgets ───────────────────────────────────────────────────────
    _panel(ctx, x, y, w, h, title) {
        const uiScale = this.game.uiScale;
        ctx.fillStyle = 'rgba(10, 14, 22, 0.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = '#22556a';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        if (title) {
            ctx.fillStyle = '#44ddff';
            ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
            ctx.textAlign = 'left';
            ctx.fillText(title, x + Math.floor(uiScale * 6), y + Math.floor(uiScale * 9));
        }
    }

    _drawTextButton(ctx, rect, label, color, bg) {
        const uiScale = this.game.uiScale;
        ctx.fillStyle = bg;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
        ctx.fillStyle = color;
        ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
        ctx.textBaseline = 'alphabetic';
    }

    // Big menu card (HOST WORLD / JOIN WORLD / CONNECT) — achievement-card
    // styling: dark panel, cyan border, title + description.
    _drawCardButton(ctx, id, title, description, x, y, w, enabled) {
        const uiScale = this.game.uiScale;
        const h = Math.floor(uiScale * 28);
        const hovered = enabled && this._hovered === id;
        this._buttons[id] = enabled ? { x, y, w, h } : null;

        ctx.fillStyle = !enabled ? 'rgba(10, 14, 22, 0.6)'
            : hovered ? 'rgba(30, 55, 80, 0.95)' : 'rgba(20, 40, 60, 0.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = !enabled ? '#1a2233' : hovered ? '#44ddff' : '#22556a';
        ctx.lineWidth = hovered ? 2 : 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        const padX = Math.floor(uiScale * 8);
        ctx.textAlign = 'left';
        ctx.fillStyle = !enabled ? '#445566' : hovered ? '#ffffff' : '#9fe8ff';
        ctx.font = `${Math.floor(8 * uiScale)}px Astro5x`;
        ctx.fillText(title, x + padX, y + Math.floor(uiScale * 12));

        ctx.fillStyle = !enabled ? '#334455' : '#8899aa';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillText(description, x + padX, y + h - Math.floor(uiScale * 6));

        return y + h;
    }

    // Labeled input field. Returns the y below it.
    _drawField(ctx, id, label, value, x, y, w, placeholder = '') {
        const uiScale = this.game.uiScale;
        const h = Math.floor(uiScale * 13);
        const active = this.activeField === id;
        this._buttons[id] = { x, y, w, h };

        ctx.textAlign = 'left';
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        ctx.fillStyle = '#667788';
        ctx.fillText(label, x, y - Math.floor(uiScale * 2));

        ctx.fillStyle = active ? 'rgba(68, 221, 255, 0.10)' : 'rgba(20, 40, 60, 0.92)';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = active ? '#44ddff' : (this._hovered === id ? '#9fe8ff' : '#22556a');
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
        const textX = x + Math.floor(uiScale * 4);
        const textY = y + h - Math.floor(uiScale * 4);
        if (value) {
            ctx.fillStyle = '#ffffff';
            let text = value;
            if (active && this.showCursor) text += '_';
            ctx.fillText(text, textX, textY);
        } else if (active) {
            // Focused + empty: just the blinking cursor — never flash the
            // placeholder in and out underneath it.
            if (this.showCursor) {
                ctx.fillStyle = '#ffffff';
                ctx.fillText('_', textX, textY);
            }
        } else {
            ctx.fillStyle = '#445566';
            ctx.fillText(placeholder, textX, textY);
        }
        return y + h;
    }
}
