// Trade session model — two pilots swap upgrades and scrap.
//
// This class owns the trade STATE and the wire protocol; the actual interface
// is drawn by PlayingState (_drawTradeOverlay/_updateTradeUI) with the same
// inventory panels the shop screens use:
//   · partner's cargo grid on top, yours on the bottom
//   · click your items to offer them (cyan), click theirs to ask (yellow)
//   · scrap offer via +/- buttons beside your grid
//   · ACCEPT / DECLINE between the panels; both accept → the swap executes
// Changing anything (items or scrap, either side) clears both accepts so
// nobody can switch the goods after you've agreed. The world keeps running
// while you trade — pick a quiet moment.
//
// Items move by id+tier (data-driven; both machines own the same item defs).
// If something doesn't fit in your grid on commit, it drops beside your ship.

import { MSG } from '../net/protocol.js';
import { makeItem } from '../data/upgrades.js';
import { Inventory } from '../engine/inventory.js';

export class TradeUI {
    constructor(game, state, partnerPid) {
        this.game = game;
        this.state = state;            // PlayingState
        this.session = state.net;
        this.sync = state.netSync;
        this.partnerPid = partnerPid;
        this.partnerName = this.session.playerName(partnerPid);
        this.closed = false;

        // My side
        this.offered = new Set();      // entries from player.inventory.items
        this.scrapOffer = 0;
        this.wants = new Set();        // "x,y" origin keys into the PARTNER's grid
        this.locked = false;           // my ACCEPT

        // Partner side (from TRADE_OFFER messages). partnerInventory is a REAL
        // Inventory instance so the existing shop grid renderer/tooltips work
        // on it natively.
        this.partnerInventory = new Inventory(4, 4);
        this.partnerOffered = new Set(); // "x,y" keys in partner grid
        this.partnerScrap = 0;
        this.partnerWants = new Set();   // "x,y" keys in MY grid
        this.partnerLocked = false;

        this._committed = false;
        this._offerDirty = true;       // send the initial state right away
        this._offerSendTimer = 0;
        this._invWatchTimer = 0;
        this._lastInvJson = '';
        this.glowTimer = 0;
    }

    // ── Outgoing ────────────────────────────────────────────────────────────
    _send(type, payload = {}) {
        this.sync.sendTradeMsg(type, { ...payload, toPid: this.partnerPid });
    }

    _sendOffer() {
        const inv = this.state.player.inventory;
        this._send(MSG.TRADE_OFFER, {
            items: [...this.offered]
                .filter(e => inv.items.includes(e))
                .map(e => ({ id: e.item.id, tier: e.item.tier || 0, x: e.x, y: e.y })),
            scrap: this.scrapOffer,
            wants: [...this.wants],
            inv: {
                cols: inv.cols,
                rows: inv.rows,
                items: inv.items.map(e => ({ id: e.item.id, tier: e.item.tier || 0, x: e.x, y: e.y })),
            },
        });
    }

    _setLocked(locked) {
        if (this.locked === locked) return;
        this.locked = locked;
        this._send(MSG.TRADE_LOCK, { locked });
        if (locked) this._maybeCommit();
    }

    toggleAccept() {
        this.game.sounds.play('select', 0.8);
        this._setLocked(!this.locked);
    }

    _touchOffer() {
        // Any change un-locks both sides.
        this.locked = false;
        this.partnerLocked = false;
        this._offerDirty = true;
        this._send(MSG.TRADE_LOCK, { locked: false });
    }

    // Click handlers (driven by PlayingState's grid hit-testing)
    toggleOfferEntry(entry) {
        if (this.offered.has(entry)) this.offered.delete(entry);
        else this.offered.add(entry);
        this.game.sounds.play('click', 0.5);
        this._touchOffer();
    }

    toggleWantAt(x, y) {
        const key = `${x},${y}`;
        if (this.wants.has(key)) this.wants.delete(key);
        else this.wants.add(key);
        this.game.sounds.play('click', 0.5);
        this._touchOffer();
    }

    adjustScrap(delta) {
        const max = Math.floor(this.state.player.scrap);
        const next = Math.max(0, Math.min(max, this.scrapOffer + delta));
        if (next === this.scrapOffer) return;
        this.scrapOffer = next;
        this.game.sounds.play('click', 0.5);
        this._touchOffer();
    }

    cancel() {
        if (this.closed) return;
        this._send(MSG.TRADE_CANCEL, {});
        this.forceClose('Trade cancelled.');
    }

    forceClose(reason) {
        this.closed = true;
        if (reason) this.state.spawnFloatingText(this.state.player.worldX, this.state.player.worldY, reason, '#9fe8ff');
    }

    // ── Incoming (routed from playingState.onTradeMessage) ─────────────────
    onMessage(type, m) {
        switch (type) {
            case MSG.TRADE_OFFER: {
                if (m.inv) {
                    const inv = new Inventory(m.inv.cols || 4, m.inv.rows || 4);
                    for (const it of (m.inv.items || [])) {
                        const item = makeItem(it.id, it.tier || 0);
                        if (item) inv.addItem(item, it.x, it.y);
                    }
                    this.partnerInventory = inv;
                }
                this.partnerOffered = new Set((m.items || []).map(it => `${it.x},${it.y}`));
                this.partnerScrap = Math.max(0, m.scrap | 0);
                this.partnerWants = new Set(m.wants || []);
                // Their change voids any accepts.
                this.partnerLocked = false;
                this.locked = false;
                // Drop my "want" markers that no longer point at an item.
                for (const key of [...this.wants]) {
                    const [x, y] = key.split(',').map(Number);
                    const entry = this.partnerInventory.getItemAt(x, y);
                    if (!entry || entry.x !== x || entry.y !== y) this.wants.delete(key);
                }
                break;
            }
            case MSG.TRADE_LOCK:
                this.partnerLocked = !!m.locked;
                if (this.partnerLocked) this._maybeCommit();
                break;
            case MSG.TRADE_CANCEL:
                this.forceClose(`${this.partnerName} declined.`);
                break;
            case MSG.TRADE_COMMIT:
                this._commit();
                break;
        }
    }

    _maybeCommit() {
        if (this.locked && this.partnerLocked && !this._committed) {
            // Both sides see both accepts; whoever notices first pings COMMIT
            // so a lost message can't leave the two sides disagreeing.
            this._send(MSG.TRADE_COMMIT, {});
            this._commit();
        }
    }

    _commit() {
        if (this._committed || this.closed) return;
        this._committed = true;
        const p = this.state.player;
        const inv = p.inventory;

        // Give: remove my offered items + scrap.
        for (const entry of this.offered) {
            if (inv.items.includes(entry)) inv.removeItemAt(entry.x, entry.y);
        }
        const givenScrap = Math.min(this.scrapOffer, Math.floor(p.scrap));
        p.scrap -= givenScrap;

        // Receive: partner's offered items + scrap.
        for (const key of this.partnerOffered) {
            const [x, y] = key.split(',').map(Number);
            const entry = this.partnerInventory.getItemAt(x, y);
            if (!entry) continue;
            const item = makeItem(entry.item.id, entry.item.tier || 0);
            if (!item) continue;
            if (!inv.autoAdd(item)) {
                // No room — drop it beside the ship (networked, visible to all).
                this.state._dropItemToSpace(item,
                    p.worldX + (Math.random() - 0.5) * 60,
                    p.worldY + (Math.random() - 0.5) * 60, null, null, 0.5);
            }
        }
        p.scrap += this.partnerScrap;

        this.state._onInventoryChanged();
        this.game.sounds.play('buy', 0.8);
        this.state.spawnFloatingText(p.worldX, p.worldY, 'TRADE COMPLETE', '#44ff88');
        if (this.game.achievements) this.game.achievements.notify('trade_completed');
        this.closed = true;
    }

    // ── Per-frame network upkeep (no input — PlayingState owns that) ───────
    update(dt) {
        if (this.closed) return;
        this.glowTimer += dt;

        // Throttle offer updates.
        if (this._offerDirty) {
            this._offerSendTimer -= dt;
            if (this._offerSendTimer <= 0) {
                this._offerSendTimer = 0.1;
                this._offerDirty = false;
                this._sendOffer();
            }
        } else {
            this._offerSendTimer = 0;
        }

        // The world keeps running — if my inventory changed (vacuumed a drop
        // mid-trade), refresh the partner's view and prune dead offers.
        this._invWatchTimer -= dt;
        if (this._invWatchTimer <= 0) {
            this._invWatchTimer = 0.4;
            const inv = this.state.player.inventory;
            for (const e of [...this.offered]) {
                if (!inv.items.includes(e)) this.offered.delete(e);
            }
            const json = JSON.stringify(inv.items.map(e => [e.item.id, e.item.tier || 0, e.x, e.y]));
            if (json !== this._lastInvJson) {
                this._lastInvJson = json;
                this._offerDirty = true;
            }
        }
    }
}
