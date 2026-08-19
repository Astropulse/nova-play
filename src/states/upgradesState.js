import { UPGRADES, RARITY_COLORS, tierLabel } from '../data/upgrades.js';
import { MenuState } from './menuState.js';
import { GP } from '../engine/inputManager.js';

// Rarity sort order for the codex grid — commons first, uniques last.
const RARITY_RANK = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, unique: 5 };

// Upgrade codex — the collection browser for every upgrade in the game.
// Mirrors the achievements screen's layout (fixed-size cards, page flips,
// same footer chrome) so the two read as siblings. Three card states:
//   discovered   — collected at least once (lifetime.upgradesById): full art,
//                  name, description, rarity, collect count.
//   locked       — gated behind an achievement that isn't earned yet
//                  (unlock: { type: 'upgrade', id }): a question mark, plus
//                  the objective that unlocks it and its progress.
//   undiscovered — available in loot pools but never collected: the sprite
//                  as a dark silhouette, everything else masked.
// The header also surfaces the combine-tier ladder: the current fuse cap and
// the next objective that raises it.
export class UpgradesState {
    // `returnState`, when provided, is restored on home/Escape instead of a
    // fresh MenuState — used by the pause screen so browsing doesn't discard
    // the live run.
    constructor(game, returnState = null) {
        this.game = game;
        this.returnState = returnState;

        this.page = 0;

        this.homeBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.prevPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.nextPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };

        this._lastMouse = { x: 0, y: 0 };
        this._wrapCache = new Map();
        this._silhouetteCache = new Map();

        // Track-toggle chips on gate-locked cards (same mechanic as the
        // achievements screen — the chip pins the GATE achievement to the
        // HUD). Hitboxes refresh each draw; cleared at the top of draw() so a
        // page flip can't leave stale rects.
        this._trackBtns = [];
        this._hoveredTrackId = null;

        // Stable display order: rarity ladder, then name.
        this.entries = [...UPGRADES].sort((a, b) => {
            const ra = RARITY_RANK[a.rarity] ?? 99;
            const rb = RARITY_RANK[b.rarity] ?? 99;
            if (ra !== rb) return ra - rb;
            return a.name.localeCompare(b.name);
        });

        // Gamepad spatial focus, mirroring the achievements screen: cards are
        // focusable (A toggles tracking on gate-locked ones) alongside the
        // footer buttons ('home' | 'prev' | 'next'). `_cardRects` mirrors the
        // visible cards' hit rects from the last draw.
        this.focusId = 'card:0';
        this._stickLatched = false;
        this._totalPages = 1;
        this._cardRects = [];
        this._cardsPerPage = 1;
    }

    enter() {
        this.game.sounds.startMusic();
    }

    exit() {}

    // Card display state for an upgrade definition.
    // Discovered wins over locked so pre-gate collections (old saves) still
    // show their info — the LOCKED tag on the card marks the pool gate.
    _cardState(def) {
        const mgr = this.game.achievements;
        const collected = mgr ? (mgr.lifetime.upgradesById[def.id] || 0) : 0;
        const gate = mgr ? mgr.getUpgradeGate(def.id) : null;
        const gateLocked = !!gate && !mgr.unlocked.has(gate.id);
        if (collected > 0) return { kind: 'discovered', collected, gate, gateLocked };
        if (gateLocked) return { kind: 'locked', collected: 0, gate, gateLocked };
        return { kind: 'undiscovered', collected: 0, gate, gateLocked: false };
    }

    update(dt) {
        const mouse = this.game.getMousePos();
        this._lastMouse = mouse;

        this.homeBtn.hovered = this._isInside(mouse, this.homeBtn);
        this.prevPageBtn.hovered = this._isInside(mouse, this.prevPageBtn);
        this.nextPageBtn.hovered = this._isInside(mouse, this.nextPageBtn);

        // Track-chip hover (chips from last draw).
        this._hoveredTrackId = null;
        for (const btn of this._trackBtns) {
            if (this._isInside(mouse, btn)) {
                this._hoveredTrackId = btn.id;
                break;
            }
        }

        const input = this.game.input;
        const totalPages = Math.max(1, this._totalPages);
        const gpActive = input.isGamepadActive();

        const flipPage = (dir) => {
            const next = this.page + dir;
            if (next < 0 || next > totalPages - 1) return false;
            this.page = next;
            // Pin focus to the first card on the new page so the highlight
            // doesn't strand on a now-off-page card.
            this.focusId = `card:${Math.min(
                this.entries.length - 1,
                this.page * this._cardsPerPage
            )}`;
            this.game.sounds.play('click', 0.6);
            return true;
        };

        if (input.isKeyJustPressed('ArrowRight') || input.isKeyJustPressed('KeyD')
            || input.isGamepadJustPressed(GP.RB)) {
            flipPage(1);
        }
        if (input.isKeyJustPressed('ArrowLeft') || input.isKeyJustPressed('KeyA')
            || input.isGamepadJustPressed(GP.LB)) {
            flipPage(-1);
        }

        // ── Gamepad spatial focus over cards + footer buttons ────────────
        const focusables = [];
        for (const cr of this._cardRects) {
            focusables.push({ id: cr.id, kind: 'card', rect: cr });
        }
        if (this.prevPageBtn.w > 0) focusables.push({ id: 'prev', kind: 'btn', rect: this.prevPageBtn });
        if (this.nextPageBtn.w > 0) focusables.push({ id: 'next', kind: 'btn', rect: this.nextPageBtn });
        if (this.homeBtn.w > 0) focusables.push({ id: 'home', kind: 'btn', rect: this.homeBtn });

        let curIdx = focusables.findIndex(f => f.id === this.focusId);
        if (curIdx < 0 && focusables.length > 0) curIdx = 0;

        const moveFocusSpatial = (dirX, dirY) => {
            if (curIdx < 0 || focusables.length <= 1) return;
            const cur = focusables[curIdx].rect;
            const cx = cur.x + cur.w / 2;
            const cy = cur.y + cur.h / 2;
            let bestIdx = -1;
            let bestScore = Infinity;
            const CROSS_PENALTY = 2.0;
            for (let i = 0; i < focusables.length; i++) {
                if (i === curIdx) continue;
                const r = focusables[i].rect;
                const dx = r.x + r.w / 2 - cx;
                const dy = r.y + r.h / 2 - cy;
                if (dirX !== 0) {
                    if (Math.sign(dx) !== dirX) continue;
                    if (Math.abs(dy) > Math.abs(dx) * 2.5) continue;
                }
                if (dirY !== 0) {
                    if (Math.sign(dy) !== dirY) continue;
                    if (Math.abs(dx) > Math.abs(dy) * 2.5) continue;
                }
                const primary   = dirX !== 0 ? Math.abs(dx) : Math.abs(dy);
                const secondary = dirX !== 0 ? Math.abs(dy) : Math.abs(dx);
                const score = primary + secondary * CROSS_PENALTY;
                if (score < bestScore) {
                    bestScore = score;
                    bestIdx = i;
                }
            }
            if (bestIdx >= 0 && bestIdx !== curIdx) {
                curIdx = bestIdx;
                this.focusId = focusables[bestIdx].id;
                this.game.sounds.play('click', 0.5);
            }
        };

        if (input.isGamepadJustPressed(GP.DLEFT))  moveFocusSpatial(-1, 0);
        if (input.isGamepadJustPressed(GP.DRIGHT)) moveFocusSpatial(1, 0);
        if (input.isGamepadJustPressed(GP.DUP))    moveFocusSpatial(0, -1);
        if (input.isGamepadJustPressed(GP.DDOWN))  moveFocusSpatial(0, 1);

        const lx = input.leftStickX;
        const ly = input.leftStickY;
        const stickMag = Math.max(Math.abs(lx), Math.abs(ly));
        if (stickMag > 0.55) {
            if (!this._stickLatched) {
                this._stickLatched = true;
                if (Math.abs(lx) > Math.abs(ly)) moveFocusSpatial(lx < 0 ? -1 : 1, 0);
                else                             moveFocusSpatial(0, ly < 0 ? -1 : 1);
            }
        } else if (stickMag < 0.25) {
            this._stickLatched = false;
        }

        // A: cards toggle tracking of their gate achievement; buttons act.
        const mgr = this.game.achievements;
        const toggleGateTrack = (gateId) => {
            if (!mgr) return;
            const wasTracked = mgr.isTracked(gateId);
            const ok = mgr.toggleTrack(gateId);
            // toggleTrack returns false on untrack or when the cap is hit —
            // only the latter should fail-sound.
            if (!wasTracked && !ok) this.game.sounds.play('click', 0.4);
            else this.game.sounds.play('select', 0.6);
        };

        if (gpActive && input.isGamepadJustPressed(GP.A) && curIdx >= 0) {
            const focused = focusables[curIdx];
            if (focused.kind === 'card') {
                const idx = parseInt(focused.id.slice(5), 10);
                const def = this.entries[idx];
                if (def && mgr) {
                    const state = this._cardState(def);
                    if (state.gateLocked) toggleGateTrack(state.gate.id);
                }
            } else if (focused.id === 'prev') {
                if (flipPage(-1)) this.focusId = 'prev';
            } else if (focused.id === 'next') {
                if (flipPage(1)) this.focusId = 'next';
            } else if (focused.id === 'home') {
                this.game.sounds.play('click', 1.0);
                this.game.setState(this.returnState || new MenuState(this.game));
                return;
            }
        }

        // Controller focus drives the same hover signals the mouse uses.
        if (gpActive && curIdx >= 0) {
            const focused = focusables[curIdx];
            this.homeBtn.hovered = focused.id === 'home';
            this.prevPageBtn.hovered = focused.id === 'prev';
            this.nextPageBtn.hovered = focused.id === 'next';
            this._hoveredTrackId = null;
            if (focused.kind === 'card' && mgr) {
                const idx = parseInt(focused.id.slice(5), 10);
                const def = this.entries[idx];
                if (def) {
                    const state = this._cardState(def);
                    if (state.gateLocked) this._hoveredTrackId = state.gate.id;
                }
            }
        }

        if (input.isMouseJustPressed(0)) {
            if (this.homeBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.game.setState(this.returnState || new MenuState(this.game));
                return;
            }
            if (this._hoveredTrackId && mgr) {
                toggleGateTrack(this._hoveredTrackId);
                return;
            }
            if (this.prevPageBtn.hovered && this.page > 0) {
                this.page--;
                this.game.sounds.play('click', 0.6);
            }
            if (this.nextPageBtn.hovered && this.page < totalPages - 1) {
                this.page++;
                this.game.sounds.play('click', 0.6);
            }
        }

        if (input.isKeyJustPressed('Escape')
            || input.isGamepadJustPressed(GP.B)
            || input.isGamepadJustPressed(GP.BACK)
            || input.isGamepadJustPressed(GP.START)) {
            this.game.sounds.play('click', 1.0);
            this.game.setState(this.returnState || new MenuState(this.game));
            return;
        }
    }

    draw(ctx) {
        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const uiScale = game.uiScale;
        const margin = Math.floor(uiScale * 12);
        const mgr = game.achievements;

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';

        // Drop last frame's track-chip hitboxes and card rects — regenerated
        // as each visible card draws below.
        this._trackBtns.length = 0;
        this._cardRects.length = 0;

        // Background + header
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = '#0a1220';
        const headerH = Math.floor(uiScale * 32);
        ctx.fillRect(0, 0, cw, headerH);

        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(11 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('UPGRADES', cw / 2, Math.floor(headerH * 0.66));

        // Summary line: discovery count + combine cap; second line names the
        // objective that raises the cap (the ladder's whole point is that the
        // player can always see the next thing worth doing).
        if (mgr) {
            let discovered = 0;
            for (const def of this.entries) {
                if ((mgr.lifetime.upgradesById[def.id] || 0) > 0) discovered++;
            }
            const cap = mgr.combineTierCap();
            const capLabel = cap > 0 ? tierLabel(cap) : 'LOCKED';
            ctx.fillStyle = '#667788';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText(
                `DISCOVERED ${discovered} / ${this.entries.length}   ·   COMBINE LIMIT: ${capLabel}`,
                cw / 2, headerH + Math.floor(uiScale * 8));

            const nextGate = mgr.nextCombineGate();
            if (nextGate) {
                const objective = this._gateObjective(nextGate).toUpperCase();
                ctx.fillStyle = '#8899aa';
                ctx.fillText(`NEXT COMBINE TIER: ${objective}`,
                    cw / 2, headerH + Math.floor(uiScale * 16));
            }
        }

        // ── Grid layout (same card sizing rules as the achievements page) ──
        const footerH = Math.floor(uiScale * 24);
        const listTop = headerH + Math.floor(uiScale * 26);
        const listBottom = ch - margin - footerH - Math.floor(uiScale * 6);
        const listH = listBottom - listTop;

        const pageW = Math.floor(cw * 0.7);
        const pageX = Math.floor(cw / 2 - pageW / 2);

        const targetCardW = uiScale * 180;
        const colGap = Math.floor(uiScale * 8);
        const rowGap = Math.floor(uiScale * 8);

        const cols = Math.max(1, Math.floor((pageW + colGap) / (targetCardW + colGap)));
        const cardW = Math.floor((pageW - colGap * (cols - 1)) / cols);
        const cardH = Math.floor(cardW * 0.34);

        const rowsPerPage = Math.max(1, Math.floor((listH + rowGap) / (cardH + rowGap)));
        const cardsPerPage = cols * rowsPerPage;
        const totalPages = Math.max(1, Math.ceil(this.entries.length / cardsPerPage));
        this._totalPages = totalPages;
        this._cardsPerPage = cardsPerPage;
        if (this.page >= totalPages) this.page = totalPages - 1;
        if (this.page < 0) this.page = 0;

        const startIdx = this.page * cardsPerPage;
        const endIdx = Math.min(this.entries.length, startIdx + cardsPerPage);

        const gridBlockH = rowsPerPage * cardH + Math.max(0, rowsPerPage - 1) * rowGap;
        const gridTop = listTop + Math.max(0, Math.floor((listH - gridBlockH) / 2));

        const gpActive = game.input.isGamepadActive();
        for (let i = startIdx; i < endIdx; i++) {
            const localIdx = i - startIdx;
            const row = Math.floor(localIdx / cols);
            const col = localIdx % cols;
            const x = pageX + col * (cardW + colGap);
            const y = gridTop + row * (cardH + rowGap);
            const cardId = `card:${i}`;
            this._cardRects.push({ id: cardId, x, y, w: cardW, h: cardH });
            this._drawCard(ctx, this.entries[i], x, y, cardW, cardH, uiScale);

            // Controller focus ring — outside the card so it doesn't fight
            // the card's own 1px border; gamepad-only, like the achievements
            // screen.
            if (gpActive && this.focusId === cardId) {
                ctx.strokeStyle = '#44ddff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x - 1, y - 1, cardW + 2, cardH + 2);
            }
        }

        // ── Footer: home (left), page controls (center) ──────────────────
        const homeSize = game.spriteSize('home_button_off', uiScale);
        this.homeBtn.x = margin;
        this.homeBtn.y = ch - margin - homeSize.h;
        this.homeBtn.w = homeSize.w;
        this.homeBtn.h = homeSize.h;
        game.drawSprite(ctx, this.homeBtn.hovered ? 'home_button_on' : 'home_button_off',
            this.homeBtn.x, this.homeBtn.y, uiScale);

        if (totalPages > 1) {
            const pcY = ch - margin - homeSize.h;
            const pcH = homeSize.h;
            const arrowW = Math.floor(uiScale * 16);
            const labelW = Math.floor(uiScale * 48);
            const gap = Math.floor(uiScale * 4);
            const totalW = arrowW * 2 + labelW + gap * 2;
            const left = Math.floor(cw / 2 - totalW / 2);

            this.prevPageBtn.x = left;
            this.prevPageBtn.y = pcY;
            this.prevPageBtn.w = arrowW;
            this.prevPageBtn.h = pcH;

            this.nextPageBtn.x = left + arrowW + gap + labelW + gap;
            this.nextPageBtn.y = pcY;
            this.nextPageBtn.w = arrowW;
            this.nextPageBtn.h = pcH;

            const canPrev = this.page > 0;
            const canNext = this.page < totalPages - 1;

            this._drawTextButton(ctx, this.prevPageBtn, '◄',
                canPrev ? (this.prevPageBtn.hovered ? '#ffffff' : '#44ddff') : '#33445a',
                this.prevPageBtn.hovered && canPrev ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)',
                uiScale);
            this._drawTextButton(ctx, this.nextPageBtn, '►',
                canNext ? (this.nextPageBtn.hovered ? '#ffffff' : '#44ddff') : '#33445a',
                this.nextPageBtn.hovered && canNext ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)',
                uiScale);

            ctx.fillStyle = '#ccddee';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`PAGE ${this.page + 1} / ${totalPages}`,
                left + arrowW + gap + labelW / 2, pcY + pcH / 2);
            ctx.textBaseline = 'alphabetic';
        } else {
            this.prevPageBtn.w = this.prevPageBtn.h = 0;
            this.nextPageBtn.w = this.nextPageBtn.h = 0;
        }

        ctx.restore();
    }

    _drawCard(ctx, def, x, y, w, h, uiScale) {
        const state = this._cardState(def);
        const padX = Math.floor(uiScale * 6);
        const iconSize = h;
        const textX = x + iconSize + Math.floor(uiScale * 7);
        const textRightEdge = x + w - padX;
        const textMaxW = textRightEdge - textX;

        const discovered = state.kind === 'discovered';
        const locked = state.kind === 'locked';

        // Panel + gate-progress tint (locked cards fill toward their unlock,
        // matching the achievements page's progress treatment).
        ctx.fillStyle = discovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 14, 22, 0.92)';
        ctx.fillRect(x, y, w, h);

        if (locked && state.gate && typeof state.gate.progress === 'function') {
            const mgr = this.game.achievements;
            let p = 0;
            if (mgr) {
                try { p = state.gate.progress(mgr) || 0; } catch (e) { p = 0; }
            }
            p = Math.max(0, Math.min(1, p));
            if (p > 0) {
                ctx.fillStyle = 'rgba(34, 85, 106, 0.35)';
                ctx.fillRect(x + iconSize, y, Math.max(1, Math.floor((w - iconSize) * p)), h);
            }
        }

        ctx.strokeStyle = discovered ? '#22556a' : '#1a2233';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Icon box
        this._drawIconBox(ctx, def, state, x, y, iconSize, uiScale);

        // Text blocks — name / body / footer, top-anchored like the
        // achievements cards.
        const nameLineH = Math.floor(uiScale * 7);
        const bodyLineH = Math.floor(uiScale * 6);
        const gapAfterName = Math.floor(uiScale * 6);
        const baselineIn = (lineH) => lineH - Math.floor(lineH * 0.15);
        let cursorY = y + Math.floor(uiScale * 4);

        ctx.textAlign = 'left';

        // Gate-locked cards carry a track chip in the top-right corner —
        // reserve its width so the name can't run under it (widest label).
        let topRightReservedW = 0;
        if (state.gateLocked) {
            ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
            topRightReservedW = Math.ceil(ctx.measureText('★ TRACKED').width)
                + Math.floor(uiScale * 6) + Math.floor(uiScale * 6);
        }
        const nameMaxW = textMaxW - topRightReservedW;

        // Name
        const rarityColor = RARITY_COLORS[def.rarity] || '#ffffff';
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        const nameText = discovered ? def.name.toUpperCase() : '???';
        const nameLines = this._wrapClipped(ctx, `${def.id}@name@${state.kind}`, nameText, nameMaxW, 2);
        ctx.fillStyle = discovered ? '#ffffff' : '#778899';
        const firstNameTop = cursorY;
        for (const line of nameLines) {
            ctx.fillText(line, textX, cursorY + baselineIn(nameLineH));
            cursorY += nameLineH;
        }

        // Body: description (discovered), unlock objective (locked), masked
        // otherwise.
        let bodyText;
        if (discovered) bodyText = def.description;
        else if (locked) bodyText = 'UNLOCK: ' + this._gateObjective(state.gate) + '.';
        else bodyText = '???';
        cursorY += gapAfterName;
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillStyle = discovered ? '#ccddee' : (locked ? '#88aabb' : '#556677');
        const bodyLines = this._wrapClipped(ctx, `${def.id}@body@${state.kind}`, bodyText, textMaxW, 2);
        for (const line of bodyLines) {
            ctx.fillText(line, textX, cursorY + baselineIn(bodyLineH));
            cursorY += bodyLineH;
        }

        // Footer line, pinned to the card's bottom edge.
        const footY = y + h - Math.floor(uiScale * 4);
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        if (discovered && state.gateLocked) {
            // Collected before the gate shipped (old save) — the pool still
            // won't roll it until the objective is done. Replaces the whole
            // footer and wraps up to two lines, anchored to the bottom edge.
            ctx.fillStyle = '#ff8844';
            ctx.textAlign = 'left';
            const lockLines = this._wrapClipped(ctx, `${def.id}@pool@1`,
                'POOL LOCKED: ' + this._gateObjective(state.gate).toUpperCase(),
                textMaxW, 2);
            let ly = footY - (lockLines.length - 1) * bodyLineH;
            for (const line of lockLines) {
                ctx.fillText(line, textX, ly);
                ly += bodyLineH;
            }
        } else if (discovered) {
            ctx.fillStyle = rarityColor;
            ctx.textAlign = 'left';
            ctx.fillText(def.rarity.toUpperCase(), textX, footY);
            ctx.fillStyle = '#667788';
            ctx.textAlign = 'right';
            ctx.fillText(`COLLECTED x${state.collected}`, textRightEdge, footY);
        } else if (locked) {
            ctx.fillStyle = '#aa4444';
            ctx.textAlign = 'left';
            ctx.fillText('LOCKED', textX, footY);
            if (state.gate) {
                const reserved = Math.ceil(ctx.measureText('LOCKED').width) + Math.floor(uiScale * 6);
                ctx.fillStyle = '#667788';
                ctx.textAlign = 'right';
                ctx.fillText(this._truncatedTo(ctx, state.gate.name.toUpperCase(), textMaxW - reserved),
                    textRightEdge, footY);
            }
        } else {
            ctx.fillStyle = '#556677';
            ctx.textAlign = 'left';
            ctx.fillText(def.rarity.toUpperCase(), textX, footY);
            const reserved = Math.ceil(ctx.measureText(def.rarity.toUpperCase()).width) + Math.floor(uiScale * 6);
            ctx.textAlign = 'right';
            ctx.fillText(this._truncatedTo(ctx, 'NOT YET FOUND', textMaxW - reserved), textRightEdge, footY);
        }
        ctx.textAlign = 'left';

        // Track chip — any card whose gate is still locked, pinned beside the
        // title like the achievements screen's chip. Toggles HUD-tracking of
        // the GATE achievement.
        if (state.gateLocked) {
            this._drawTrackButton(ctx, state.gate, textRightEdge, firstNameTop, nameLineH, uiScale);
        }
    }

    _drawIconBox(ctx, def, state, x, y, size, uiScale) {
        // Box chrome matches the achievements placeholder styling.
        ctx.fillStyle = state.kind === 'discovered' ? '#0e1c2a' : '#0a0f18';
        ctx.fillRect(x, y, size, size);
        ctx.strokeStyle = state.kind === 'discovered' ? '#22556a' : '#1a2233';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

        if (state.kind === 'locked') {
            // Question mark — the player hasn't earned the right to see it.
            ctx.fillStyle = '#556677';
            ctx.font = `${Math.floor(size * 0.55)}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('?', x + size / 2, y + size / 2 + Math.floor(uiScale));
            ctx.textBaseline = 'alphabetic';
            return;
        }

        const pad = Math.floor(size * 0.12);
        const inner = size - pad * 2;
        if (state.kind === 'discovered') {
            const frame = this._assetImage(def.assetKey);
            if (!frame) return;
            const scale = Math.min(inner / frame.w, inner / frame.h);
            const dw = frame.w * scale;
            const dh = frame.h * scale;
            ctx.drawImage(frame.img, Math.floor(x + (size - dw) / 2), Math.floor(y + (size - dh) / 2), dw, dh);
        } else {
            // Undiscovered — flat single-color silhouette of the sprite.
            const sil = this._getSilhouette(def.assetKey);
            if (!sil) return;
            const scale = Math.min(inner / sil.width, inner / sil.height);
            const dw = sil.width * scale;
            const dh = sil.height * scale;
            ctx.drawImage(sil, Math.floor(x + (size - dw) / 2), Math.floor(y + (size - dh) / 2), dw, dh);
        }
    }

    // Drawable image + dimensions for an upgrade sprite. GIF-animated upgrades
    // (the uniques) are cached as frame arrays — use their first frame.
    _assetImage(assetKey) {
        const asset = this.game.assets.get(assetKey);
        if (!asset) return null;
        const img = asset.canvas || (Array.isArray(asset) ? asset[0] && asset[0].canvas : asset);
        if (!img) return null;
        const w = (Array.isArray(asset) ? img.width : asset.width) || img.width;
        const h = (Array.isArray(asset) ? img.height : asset.height) || img.height;
        if (!w || !h) return null;
        return { img, w, h };
    }

    // Flat-fill silhouette of an upgrade sprite, cached per asset key.
    _getSilhouette(assetKey) {
        const cached = this._silhouetteCache.get(assetKey);
        if (cached) return cached;
        const frame = this._assetImage(assetKey);
        if (!frame) return null;
        const { img, w, h } = frame;
        const cv = document.createElement('canvas');
        cv.width = w;
        cv.height = h;
        const c = cv.getContext('2d');
        c.drawImage(img, 0, 0, w, h);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = '#2c3e54';
        c.fillRect(0, 0, w, h);
        this._silhouetteCache.set(assetKey, cv);
        return cv;
    }

    // Short objective for a gate achievement: the dedicated `goal` field when
    // present, else the description's first sentence without its period.
    _gateObjective(gate) {
        return gate.goal || gate.description.split('. ')[0].replace(/\.$/, '');
    }

    // Track toggle chip — same styling and behavior as the achievements
    // screen's, but it pins the upgrade's GATE achievement to the HUD.
    _drawTrackButton(ctx, gate, textRightEdge, firstNameTop, nameLineH, uiScale) {
        const mgr = this.game.achievements;
        const isTracked = mgr ? mgr.isTracked(gate.id) : false;
        const isHovered = this._hoveredTrackId === gate.id;
        const capFull = mgr && !isTracked && mgr.tracked.size >= mgr.MAX_TRACKED;

        const label = isTracked ? '★ TRACKED' : (capFull ? '★ MAX' : '★ TRACK');
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        const padX = Math.floor(uiScale * 3);
        const labelW = Math.ceil(ctx.measureText(label).width);
        const btnW = labelW + padX * 2;
        const btnH = Math.floor(uiScale * 8);
        const btnX = Math.floor(textRightEdge - btnW);
        const btnY = Math.floor(firstNameTop + (nameLineH - btnH) / 2);

        let fg, bg, border;
        if (isTracked) {
            fg = isHovered ? '#ffffff' : '#ffcc44';
            bg = isHovered ? 'rgba(70, 50, 14, 0.95)' : 'rgba(40, 28, 8, 0.90)';
            border = isHovered ? '#ffdd66' : '#aa8822';
        } else if (capFull) {
            fg = '#556677';
            bg = 'rgba(20, 24, 32, 0.85)';
            border = '#33445a';
        } else {
            fg = isHovered ? '#ffffff' : '#88aabb';
            bg = isHovered ? 'rgba(20, 40, 60, 0.95)' : 'rgba(10, 18, 28, 0.85)';
            border = isHovered ? '#44ddff' : '#445566';
        }

        ctx.fillStyle = bg;
        ctx.fillRect(btnX, btnY, btnW, btnH);
        ctx.strokeStyle = border;
        ctx.lineWidth = 1;
        ctx.strokeRect(btnX + 0.5, btnY + 0.5, btnW - 1, btnH - 1);

        ctx.fillStyle = fg;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, btnX + btnW / 2, btnY + btnH / 2 + Math.floor(uiScale * 0.5));
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';

        // A capped chip's click would be a no-op — don't store the rect.
        if (!capFull) {
            this._trackBtns.push({ id: gate.id, x: btnX, y: btnY, w: btnW, h: btnH });
        }
    }

    _truncatedTo(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let trimmed = text;
        while (trimmed.length > 0 && ctx.measureText(trimmed + '…').width > maxWidth) {
            trimmed = trimmed.slice(0, -1);
        }
        return trimmed + '…';
    }

    _wrapClipped(ctx, key, text, maxWidth, maxLines) {
        const cacheKey = `${key}@${Math.floor(maxWidth)}@${ctx.font}@L${maxLines}`;
        const cached = this._wrapCache.get(cacheKey);
        if (cached) return cached;

        const all = this._wrapAll(ctx, text, maxWidth);
        let result;
        if (all.length <= maxLines) {
            result = all;
        } else {
            result = all.slice(0, maxLines);
            let last = result[maxLines - 1];
            while (last.length > 0 && ctx.measureText(last + '…').width > maxWidth) {
                last = last.slice(0, -1);
            }
            result[maxLines - 1] = last + '…';
        }
        this._wrapCache.set(cacheKey, result);
        return result;
    }

    _wrapAll(ctx, text, maxWidth) {
        const lines = [];
        if (!text) return lines;
        const words = text.split(/\s+/);
        let current = '';
        for (const word of words) {
            const probe = current ? current + ' ' + word : word;
            if (ctx.measureText(probe).width <= maxWidth) current = probe;
            else { if (current) lines.push(current); current = word; }
        }
        if (current) lines.push(current);
        return lines;
    }

    _drawTextButton(ctx, btn, label, fgColor, bgColor, uiScale) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
        ctx.strokeStyle = fgColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(btn.x + 0.5, btn.y + 0.5, btn.w - 1, btn.h - 1);

        ctx.fillStyle = fgColor;
        ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, btn.x + btn.w / 2, btn.y + btn.h / 2);
        ctx.textBaseline = 'alphabetic';
    }

    _isInside(point, rect) {
        return point.x >= rect.x && point.x <= rect.x + rect.w
            && point.y >= rect.y && point.y <= rect.y + rect.h;
    }
}
