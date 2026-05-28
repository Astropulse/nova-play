import { ACHIEVEMENTS } from '../data/achievements.js';
import { MenuState } from './menuState.js';
import { GP } from '../engine/inputManager.js';

// Achievements browser. Reads game.achievements for unlock state and lifetime
// stats; the data file (data/achievements.js) is the source of truth for
// everything else. Hidden achievements show name + flavor but mask their
// description until unlocked.
//
// Layout: a grid of fixed-size cards within a 70%-screen-width "page". Cards
// per page = cols × rowsPerPage (computed from available vertical space).
// The page index drives which slice of ACHIEVEMENTS is visible.
export class AchievementsState {
    // `returnState`, when provided, is the state to restore on home/Escape
    // instead of constructing a fresh MenuState. Used by the pause screen so
    // the in-progress run isn't discarded when the player browses unlocks.
    constructor(game, returnState = null) {
        this.game = game;
        this.returnState = returnState;

        // Pagination
        this.page = 0;

        this.homeBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.resetBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.prevPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.nextPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };

        // Confirmation dialog state (reset progress)
        this.confirmReset = false;
        this.confirmYes = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.confirmNo  = { x: 0, y: 0, w: 0, h: 0, hovered: false };

        this._lastMouse = { x: 0, y: 0 };

        // Hitboxes for per-card track toggle buttons, refreshed each draw.
        // Cleared at the top of draw() so a page flip can't leave stale rects
        // that the click handler would still match.
        this._trackBtns = [];
        this._hoveredTrackId = null;

        // Cache wrapped lines per achievement by id so we don't re-wrap every
        // frame. Keyed on `${id}@${maxWidth}@${unlocked}@${font}` so a window
        // resize or hidden-condition flip invalidates the cache automatically.
        this._wrapCache = new Map();

        // Gamepad focus. `focusId` selects one focusable — either a card
        // ('card:N' where N indexes ACHIEVEMENTS) or one of the footer
        // buttons ('home' | 'reset' | 'prev' | 'next'). Spatial navigation
        // works off live rectangles so the closest neighbour in the pressed
        // direction wins; that lets the page arrows participate in the same
        // grid the cards live in, instead of edge-flipping the page
        // implicitly. `_cardRects` mirrors the visible cards' hit rects so
        // update() can build a focusables list without re-running layout.
        this.focusId = 'card:0';
        this._stickLatched = false;
        this._cardRects = [];
        this._cols = 1;
        this._rowsPerPage = 1;
        this._cardsPerPage = 1;
    }

    enter() {
        this.game.sounds.startMusic();
    }

    exit() {}

    update(dt) {
        const mouse = this.game.getMousePos();
        this._lastMouse = mouse;

        // Modal owns input when open
        if (this.confirmReset) {
            this.confirmYes.hovered = this._isInside(mouse, this.confirmYes);
            this.confirmNo.hovered  = this._isInside(mouse, this.confirmNo);

            if (this.game.input.isMouseJustPressed(0)) {
                if (this.confirmYes.hovered) {
                    this.game.sounds.play('select', 1.0);
                    if (this.game.achievements) this.game.achievements.reset();
                    this.confirmReset = false;
                } else if (this.confirmNo.hovered) {
                    this.game.sounds.play('click', 1.0);
                    this.confirmReset = false;
                }
            }
            if (this.game.input.isKeyJustPressed('Escape')
                || this.game.input.isGamepadJustPressed(GP.B)
                || this.game.input.isGamepadJustPressed(GP.BACK)) {
                this.game.sounds.play('click', 1.0);
                this.confirmReset = false;
            }
            if (this.game.input.isGamepadJustPressed(GP.A)) {
                this.game.sounds.play('select', 1.0);
                if (this.game.achievements) this.game.achievements.reset();
                this.confirmReset = false;
            }
            return;
        }

        this.homeBtn.hovered  = this._isInside(mouse, this.homeBtn);
        this.resetBtn.hovered = this._isInside(mouse, this.resetBtn);
        this.prevPageBtn.hovered = this._isInside(mouse, this.prevPageBtn);
        this.nextPageBtn.hovered = this._isInside(mouse, this.nextPageBtn);

        // Track-button hover (cards from last draw). Mouse takes priority over
        // the buttons below so the card overlay still works when the cursor
        // sits over it.
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

        // ── Page-flip shortcut (keys + bumpers). The bumpers stay as a "jump
        // to next page" convenience; the page-arrow buttons themselves are
        // also focusable below so users can A-them like any other button.
        const flipPage = (dir) => {
            const next = this.page + dir;
            if (next < 0 || next > totalPages - 1) return false;
            this.page = next;
            // Pin focus to the first card on the new page so the highlight
            // doesn't strand on a now-off-page card.
            this.focusId = `card:${Math.min(
                ACHIEVEMENTS.length - 1,
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

        // ── Gamepad spatial focus ─────────────────────────────────────────
        // Build the list of focusables every frame from the live rects. Cards
        // come from the previous draw; page arrows are only included when
        // multi-page (their rect collapses to 0×0 on single-page layouts).
        const focusables = [];
        for (const cr of this._cardRects) {
            focusables.push({ id: cr.id, kind: 'card', rect: cr });
        }
        if (this.prevPageBtn.w > 0) focusables.push({ id: 'prev', kind: 'btn', rect: this.prevPageBtn });
        if (this.nextPageBtn.w > 0) focusables.push({ id: 'next', kind: 'btn', rect: this.nextPageBtn });
        if (this.homeBtn.w  > 0) focusables.push({ id: 'home',  kind: 'btn', rect: this.homeBtn });
        if (this.resetBtn.w > 0) focusables.push({ id: 'reset', kind: 'btn', rect: this.resetBtn });

        let curIdx = focusables.findIndex(f => f.id === this.focusId);
        // First-frame fallback: card rects haven't been populated yet. Park
        // focus on whatever's available (likely a button) but don't change
        // focusId — next frame's draw will restore the intended card.
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
                const rx = r.x + r.w / 2;
                const ry = r.y + r.h / 2;
                const dx = rx - cx;
                const dy = ry - cy;
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

        // A activates whichever focusable is highlighted. Cards toggle their
        // track state; buttons fire their respective action. Home is a state
        // transition — return early so subsequent input handling doesn't run
        // against a stale state.
        if (gpActive && input.isGamepadJustPressed(GP.A) && curIdx >= 0) {
            const focused = focusables[curIdx];
            if (focused.kind === 'card') {
                const idx = parseInt(focused.id.slice(5), 10);
                if (idx >= 0 && idx < ACHIEVEMENTS.length && this.game.achievements) {
                    const ach = ACHIEVEMENTS[idx];
                    const mgr = this.game.achievements;
                    if (!mgr.unlocked.has(ach.id)) {
                        const wasTracked = mgr.isTracked(ach.id);
                        const ok = mgr.toggleTrack(ach.id);
                        if (!wasTracked && !ok) this.game.sounds.play('click', 0.4);
                        else this.game.sounds.play('select', 0.6);
                    }
                }
            } else if (focused.id === 'prev') {
                if (flipPage(-1)) this.focusId = 'prev';
            } else if (focused.id === 'next') {
                if (flipPage(1)) this.focusId = 'next';
            } else if (focused.id === 'home') {
                this.game.sounds.play('click', 1.0);
                this.game.setState(this.returnState || new MenuState(this.game));
                return;
            } else if (focused.id === 'reset') {
                this.game.sounds.play('click', 1.0);
                this.confirmReset = true;
                return;
            }
        }

        // When the controller is the active device, drive the same "hover"
        // signal the mouse path uses so the focused button / card chip lights
        // up exactly the way a mouse hover would. Clearing the others keeps
        // a stale mouse-hover state from double-highlighting.
        if (gpActive && curIdx >= 0) {
            const focused = focusables[curIdx];
            this.homeBtn.hovered     = focused.id === 'home';
            this.resetBtn.hovered    = focused.id === 'reset';
            this.prevPageBtn.hovered = focused.id === 'prev';
            this.nextPageBtn.hovered = focused.id === 'next';
            this._hoveredTrackId = null;
            if (focused.kind === 'card' && this.game.achievements) {
                const idx = parseInt(focused.id.slice(5), 10);
                const ach = ACHIEVEMENTS[idx];
                if (ach && !this.game.achievements.unlocked.has(ach.id)) {
                    this._hoveredTrackId = ach.id;
                }
            }
        }

        // Button clicks
        if (input.isMouseJustPressed(0)) {
            if (this.homeBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.game.setState(this.returnState || new MenuState(this.game));
                return;
            }
            if (this.resetBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.confirmReset = true;
                return;
            }
            if (this._hoveredTrackId && this.game.achievements) {
                const mgr = this.game.achievements;
                const wasTracked = mgr.isTracked(this._hoveredTrackId);
                const ok = mgr.toggleTrack(this._hoveredTrackId);
                // toggleTrack returns false either on untrack or when the
                // tracked cap is hit — only the latter should fail-sound.
                if (!wasTracked && !ok) {
                    this.game.sounds.play('click', 0.4);
                } else {
                    this.game.sounds.play('select', 0.6);
                }
                return;
            }
            if (this.prevPageBtn.hovered && this.page > 0) {
                this.page--;
                this.focusId = 'prev';
                this.game.sounds.play('click', 0.6);
            }
            if (this.nextPageBtn.hovered && this.page < totalPages - 1) {
                this.page++;
                this.focusId = 'next';
                this.game.sounds.play('click', 0.6);
            }
        }

        // Back to menu (Escape / B / Back / Start)
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

        // Drop last frame's track-button hitboxes and card rects — both are
        // regenerated as each visible card is drawn below.
        this._trackBtns.length = 0;
        this._cardRects.length = 0;

        // Background
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);

        // Header
        ctx.fillStyle = '#0a1220';
        const headerH = Math.floor(uiScale * 32);
        ctx.fillRect(0, 0, cw, headerH);

        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(11 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('ACHIEVEMENTS', cw / 2, Math.floor(headerH * 0.66));

        if (mgr) {
            const lt = mgr.lifetime;
            const summary = `UNLOCKED ${mgr.unlocked.size} / ${ACHIEVEMENTS.length}   `
                + `·   KILLS ${lt.enemiesKilled}   `
                + `·   RUNS ${lt.runsCompleted}   `
                + `·   SCRAP ${lt.scrapCollected}`;
            ctx.fillStyle = '#667788';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillText(summary, cw / 2, headerH + Math.floor(uiScale * 8));
        }

        // ── Footer (drawn last but layout-computed now so we know the
        // available vertical space for the grid).
        const footerH = Math.floor(uiScale * 24);
        const listTop    = headerH + Math.floor(uiScale * 22);
        const listBottom = ch - margin - footerH - Math.floor(uiScale * 6);
        const listH = listBottom - listTop;

        // ── Grid layout: cards are sized at a fixed aspect ratio (the
        // dimensions the user signed off on at 2560×1440). On smaller
        // screens, we don't shrink cards — we just drop columns / rows so
        // they still fit. `targetCardW` is calibrated so 2560×1440 lands
        // exactly at 3 columns; narrower viewports step down to 2 or 1.
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
        const totalPages = Math.max(1, Math.ceil(ACHIEVEMENTS.length / cardsPerPage));
        this._totalPages = totalPages;
        // Snapshot grid dimensions for update()'s controller-focus math.
        this._cols = cols;
        this._rowsPerPage = rowsPerPage;
        this._cardsPerPage = cardsPerPage;
        // Clamp page if data shrank (e.g. resize)
        if (this.page >= totalPages) this.page = totalPages - 1;
        if (this.page < 0) this.page = 0;

        // Slice the visible achievements for this page
        const startIdx = this.page * cardsPerPage;
        const endIdx = Math.min(ACHIEVEMENTS.length, startIdx + cardsPerPage);

        // Reserve the full max-page block (rowsPerPage worth of rows) and
        // center that block vertically inside listH. Cards then fill from
        // the top-left of that block — so a half-empty last page leaves its
        // dead space at the bottom rather than vertically re-centering.
        // This keeps the grid origin stable across page flips.
        const gridBlockH = rowsPerPage * cardH + Math.max(0, rowsPerPage - 1) * rowGap;
        const gridTop = listTop + Math.max(0, Math.floor((listH - gridBlockH) / 2));

        const gpActive = game.input.isGamepadActive();
        for (let i = startIdx; i < endIdx; i++) {
            const localIdx = i - startIdx;
            const row = Math.floor(localIdx / cols);
            const col = localIdx % cols;
            const x = pageX + col * (cardW + colGap);
            const y = gridTop + row * (cardH + rowGap);
            const ach = ACHIEVEMENTS[i];
            const isUnlocked = mgr ? mgr.unlocked.has(ach.id) : false;

            // Hit rect for controller spatial nav. Pushed before the card
            // draws so an early bail-out (none today) couldn't strand update()
            // without it.
            const cardId = `card:${i}`;
            this._cardRects.push({ id: cardId, x, y, w: cardW, h: cardH });

            this._drawCard(ctx, ach, isUnlocked, x, y, cardW, cardH, uiScale);

            // Controller focus ring — sits just outside the card so it doesn't
            // fight the card's own 1px border. Only shown while the gamepad is
            // the active input device so mouse users don't see a floating
            // highlight that doesn't track their cursor.
            if (gpActive && this.focusId === cardId) {
                ctx.strokeStyle = '#44ddff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x - 1, y - 1, cardW + 2, cardH + 2);
            }
        }

        // ── Footer: home (left), page controls (center), reset (right)
        const homeSize = game.spriteSize('home_button_off', uiScale);
        this.homeBtn.x = margin;
        this.homeBtn.y = ch - margin - homeSize.h;
        this.homeBtn.w = homeSize.w;
        this.homeBtn.h = homeSize.h;
        game.drawSprite(ctx, this.homeBtn.hovered ? 'home_button_on' : 'home_button_off',
            this.homeBtn.x, this.homeBtn.y, uiScale);

        const resetW = Math.floor(uiScale * 64);
        const resetH = homeSize.h;
        this.resetBtn.x = cw - margin - resetW;
        this.resetBtn.y = ch - margin - resetH;
        this.resetBtn.w = resetW;
        this.resetBtn.h = resetH;
        this._drawTextButton(ctx, this.resetBtn, 'RESET PROGRESS',
            this.resetBtn.hovered ? '#ff8844' : '#aa4444',
            this.resetBtn.hovered ? 'rgba(60, 18, 12, 0.92)' : 'rgba(28, 10, 10, 0.85)',
            uiScale);

        // Page controls — only render when more than one page exists.
        if (totalPages > 1) {
            const pcY = ch - margin - homeSize.h;
            const pcH = homeSize.h;
            const arrowW = Math.floor(uiScale * 16);
            const labelW = Math.floor(uiScale * 48);
            const gap = Math.floor(uiScale * 4);
            const totalW = arrowW * 2 + labelW + gap * 2;
            const cx = cw / 2;
            const left = Math.floor(cx - totalW / 2);

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

            // Page indicator label
            ctx.fillStyle = '#ccddee';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`PAGE ${this.page + 1} / ${totalPages}`,
                left + arrowW + gap + labelW / 2,
                pcY + pcH / 2);
            ctx.textBaseline = 'alphabetic';
        } else {
            // Collapse the rects so click tests can't false-positive on a stale
            // layout from a prior frame with multiple pages.
            this.prevPageBtn.w = this.prevPageBtn.h = 0;
            this.nextPageBtn.w = this.nextPageBtn.h = 0;
        }

        ctx.restore();

        if (this.confirmReset) this._drawConfirmDialog(ctx);
    }

    // Fixed-size card. Description and flavor wrap to two lines each
    // (ellipsized on overflow) so a 3-column grid still reads cleanly.
    _drawCard(ctx, ach, unlocked, x, y, w, h, uiScale) {
        const showDescription = unlocked || !ach.hidden;
        const padX = Math.floor(uiScale * 6);

        // Icon takes the full card height — flush left, square. Its border
        // doubles as the card's color accent.
        const iconSize = h;
        const textX = x + iconSize + Math.floor(uiScale * 7);
        const textRightEdge = x + w - padX;
        const textMaxW = textRightEdge - textX;

        // Track button reserves space on the top row for locked achievements
        // so the title can't overrun it. Unlocked cards have no top-right
        // chrome (the lock icon already conveys state), so the name gets the
        // full width.
        let topRightReservedW = 0;
        if (!unlocked) {
            ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
            // Use the widest of the three possible labels so the reserved
            // width is stable regardless of which one is showing.
            const probeLabel = '★ TRACKED';
            topRightReservedW = Math.ceil(ctx.measureText(probeLabel).width)
                + Math.floor(uiScale * 6); // matches the button's interior padding
        }
        const nameMaxW = textMaxW - topRightReservedW - Math.floor(uiScale * 6);

        // Name: up to 2 lines (wrap on whitespace; ellipsize only as a last
        // resort if even 2 lines can't fit). Description & flavor: up to
        // 2 lines each.
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        const nameLines = this._wrapClipped(ctx, ach.id + '@name@' + unlocked,
            ach.name.toUpperCase(), nameMaxW, 2);

        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        const descLines = this._wrapClipped(ctx, ach.id + '@desc@' + unlocked,
            showDescription ? ach.description : '???', textMaxW, 2);

        const flavorLines = ach.flavor
            ? this._wrapClipped(ctx, ach.id + '@flav@' + unlocked,
                '"' + ach.flavor + '"', textMaxW, 2)
            : [];

        // Panel
        ctx.fillStyle = unlocked ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 14, 22, 0.92)';
        ctx.fillRect(x, y, w, h);

        // Progress fill — partial background tint for locked, non-hidden
        // lifetime-tracked achievements. The achievement opts in by defining
        // a `progress(mgr)` returning 0..1. Drawn to the right of the icon
        // so it tints the text area rather than fighting with the artwork.
        if (!unlocked && !ach.hidden && typeof ach.progress === 'function') {
            const mgr = this.game.achievements;
            let p = 0;
            if (mgr) {
                try { p = ach.progress(mgr) || 0; } catch (e) { p = 0; }
            }
            p = Math.max(0, Math.min(1, p));
            if (p > 0) {
                const barX = x + iconSize;
                const barMaxW = w - iconSize;
                const fillW = Math.max(1, Math.floor(barMaxW * p));
                ctx.fillStyle = 'rgba(34, 85, 106, 0.35)';
                ctx.fillRect(barX, y, fillW, h);
            }
        }

        // Card border
        ctx.strokeStyle = unlocked ? '#22556a' : '#1a2233';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Icon box — full height, flush against the left edge
        this._drawIconBox(ctx, ach, unlocked, x, y, iconSize, uiScale);

        // Vertical rhythm — line heights are slot heights (baseline-to-baseline
        // spacing). Block layout treats each text region as stacked slots and
        // anchors the whole stack to the top of the card so wave-of-text and
        // single-name cards share a consistent name baseline.
        const nameLineH = Math.floor(uiScale * 7);
        const bodyLineH = Math.floor(uiScale * 6);
        const gapAfterName = Math.floor(uiScale * 6);
        const gapAfterDesc = ach.flavor ? Math.floor(uiScale * 5) : 0;

        const blockTop = y + Math.floor(uiScale * 4);

        // Baseline lives near the bottom of each slot — 0.85 of lineH from
        // the top gives roughly the right cap/x-height alignment for these
        // pixel fonts.
        let cursorY = blockTop;
        const baselineIn = (lineH) => lineH - Math.floor(lineH * 0.15);

        ctx.textAlign = 'left';

        // Name
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        ctx.fillStyle = unlocked ? '#ffffff' : '#778899';
        const firstNameTop = cursorY;
        for (const line of nameLines) {
            ctx.fillText(line, textX, cursorY + baselineIn(nameLineH));
            cursorY += nameLineH;
        }

        // Description
        if (descLines.length > 0) {
            cursorY += gapAfterName;
            ctx.textAlign = 'left';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillStyle = unlocked ? '#ccddee' : '#667788';
            for (const line of descLines) {
                ctx.fillText(line, textX, cursorY + baselineIn(bodyLineH));
                cursorY += bodyLineH;
            }
        }

        // Flavor
        if (flavorLines.length > 0) {
            cursorY += gapAfterDesc;
            ctx.textAlign = 'left';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
            ctx.fillStyle = unlocked ? '#88aabb' : '#556677';
            for (const line of flavorLines) {
                ctx.fillText(line, textX, cursorY + baselineIn(bodyLineH));
                cursorY += bodyLineH;
            }
        }

        // Unlock badge — only when earned and granting something
        if (unlocked && ach.unlock) {
            ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
            ctx.fillStyle = '#ffcc44';
            ctx.textAlign = 'right';
            const badgeText = this._truncatedTo(ctx, `+${ach.unlock.id}`, textMaxW);
            ctx.fillText(badgeText, textRightEdge, y + h - Math.floor(uiScale * 4));
        }

        // Track toggle — only on locked achievements. Pinned to the top-right
        // corner of the card, aligned to the first name line. Hidden
        // achievements still get the toggle so the player can pin a name +
        // flavor hint to the HUD.
        if (!unlocked) {
            this._drawTrackButton(ctx, ach, x, y, w, h, textRightEdge, firstNameTop, nameLineH, uiScale);
        }
    }

    _drawTrackButton(ctx, ach, x, y, w, h, textRightEdge, firstNameTop, nameLineH, uiScale) {
        const mgr = this.game.achievements;
        const isTracked = mgr ? mgr.isTracked(ach.id) : false;
        const isHovered = this._hoveredTrackId === ach.id;
        // Refuse-track state: the cap is full and this one isn't on the list.
        const capFull = mgr && !isTracked && mgr.tracked.size >= mgr.MAX_TRACKED;

        const label = isTracked ? '★ TRACKED' : (capFull ? '★ MAX' : '★ TRACK');
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        const padX = Math.floor(uiScale * 3);
        const labelW = Math.ceil(ctx.measureText(label).width);
        const btnW = labelW + padX * 2;
        const btnH = Math.floor(uiScale * 8);
        const btnX = Math.floor(textRightEdge - btnW);
        // Center the button vertically on the first name line so it reads as
        // a chip "next to the title" rather than free-floating chrome.
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

        // Don't store the rect when the cap blocks tracking — the click would
        // be a no-op and the dim styling already signals "disabled".
        if (!capFull) {
            this._trackBtns.push({ id: ach.id, x: btnX, y: btnY, w: btnW, h: btnH });
        }
    }

    // Single-line truncation with ellipsis, used by the unlock badge inside
    // the compact card.
    _truncatedTo(ctx, text, maxWidth) {
        if (ctx.measureText(text).width <= maxWidth) return text;
        let trimmed = text;
        while (trimmed.length > 0 && ctx.measureText(trimmed + '…').width > maxWidth) {
            trimmed = trimmed.slice(0, -1);
        }
        return trimmed + '…';
    }

    _drawIconBox(ctx, ach, unlocked, x, y, size, uiScale) {
        const asset = ach.icon ? this.game.assets.get(ach.icon) : null;
        if (asset) {
            ctx.save();
            ctx.globalAlpha = unlocked ? 1 : 0.35;
            const img = asset.canvas || asset;
            const aw = asset.width || img.width;
            const ah = asset.height || img.height;
            const scale = Math.min(size / aw, size / ah);
            const dw = aw * scale;
            const dh = ah * scale;
            ctx.drawImage(img, Math.floor(x + (size - dw) / 2), Math.floor(y + (size - dh) / 2), dw, dh);
            ctx.restore();

            // Lock overlay sits on top of the dimmed icon at full opacity so
            // the padlock reads clearly even though the art behind it is faded.
            if (!unlocked) {
                const lock = this.game.assets.get('ach_lock');
                if (lock) {
                    const lImg = lock.canvas || lock;
                    const lw = lock.width || lImg.width;
                    const lh = lock.height || lImg.height;
                    const lScale = Math.min(size / lw, size / lh);
                    const ldw = lw * lScale;
                    const ldh = lh * lScale;
                    ctx.drawImage(lImg, Math.floor(x + (size - ldw) / 2), Math.floor(y + (size - ldh) / 2), ldw, ldh);
                }
            }
        } else {
            ctx.fillStyle = unlocked ? '#0e1c2a' : '#0a0f18';
            ctx.fillRect(x, y, size, size);
            ctx.strokeStyle = unlocked ? '#22556a' : '#1a2233';
            ctx.lineWidth = 1;
            ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);

            ctx.strokeStyle = unlocked ? 'rgba(68, 221, 255, 0.18)' : 'rgba(85, 102, 119, 0.18)';
            ctx.beginPath();
            ctx.moveTo(x + 2, y + 2);
            ctx.lineTo(x + size - 2, y + size - 2);
            ctx.moveTo(x + size - 2, y + 2);
            ctx.lineTo(x + 2, y + size - 2);
            ctx.stroke();
        }
    }

    // Cached word-wrap returning up to `maxLines` lines, ellipsizing the
    // last one if the text overflows.
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

    _drawConfirmDialog(ctx) {
        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const uiScale = game.uiScale;
        const mgr = game.achievements;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
        ctx.fillRect(0, 0, cw, ch);

        const panelW = Math.floor(Math.min(cw * 0.7, uiScale * 220));
        const pad = Math.floor(uiScale * 14);
        const titleSpace = Math.floor(uiScale * 22);
        const bodyLineH  = Math.floor(uiScale * 8);
        const bodyTopGap = Math.floor(uiScale * 6);
        const btnH       = Math.floor(uiScale * 14);
        const btnTopGap  = Math.floor(uiScale * 14);

        const total = mgr ? mgr.unlocked.size : 0;
        const bodyMaxW = panelW - pad * 2;

        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        const bodyLines1 = this._wrapAll(ctx,
            `This will erase ${total} unlocked achievement${total === 1 ? '' : 's'} and all lifetime stats.`,
            bodyMaxW);
        const bodyLines2 = this._wrapAll(ctx, 'This cannot be undone.', bodyMaxW);
        const bodyH = (bodyLines1.length + bodyLines2.length) * bodyLineH + Math.floor(uiScale * 4);

        const panelH = pad + titleSpace + bodyTopGap + bodyH + btnTopGap + btnH + pad;
        const panelX = Math.floor(cw / 2 - panelW / 2);
        const panelY = Math.floor(ch / 2 - panelH / 2);

        ctx.fillStyle = 'rgba(14, 22, 36, 0.96)';
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeStyle = '#aa4444';
        ctx.lineWidth = 2;
        ctx.strokeRect(panelX + 1, panelY + 1, panelW - 2, panelH - 2);

        ctx.fillStyle = '#ff8844';
        ctx.font = `${Math.floor(8 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('RESET ALL PROGRESS?', cw / 2, panelY + pad + titleSpace / 2);

        ctx.textBaseline = 'alphabetic';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        let by = panelY + pad + titleSpace + bodyTopGap + Math.floor(uiScale * 4);
        ctx.fillStyle = '#ccddee';
        for (const line of bodyLines1) { ctx.fillText(line, cw / 2, by); by += bodyLineH; }
        by += Math.floor(uiScale * 2);
        ctx.fillStyle = '#778899';
        for (const line of bodyLines2) { ctx.fillText(line, cw / 2, by); by += bodyLineH; }

        const btnW = Math.floor(uiScale * 50);
        const btnGap = Math.floor(uiScale * 10);
        const btnY = panelY + panelH - pad - btnH;
        const totalBtnW = btnW * 2 + btnGap;
        const btnStartX = Math.floor(cw / 2 - totalBtnW / 2);

        this.confirmYes.x = btnStartX;
        this.confirmYes.y = btnY;
        this.confirmYes.w = btnW;
        this.confirmYes.h = btnH;

        this.confirmNo.x = btnStartX + btnW + btnGap;
        this.confirmNo.y = btnY;
        this.confirmNo.w = btnW;
        this.confirmNo.h = btnH;

        this._drawTextButton(ctx, this.confirmYes, 'YES, RESET',
            this.confirmYes.hovered ? '#ffffff' : '#ff8844',
            this.confirmYes.hovered ? 'rgba(80, 24, 12, 0.96)' : 'rgba(40, 14, 10, 0.92)',
            uiScale);
        this._drawTextButton(ctx, this.confirmNo, 'CANCEL',
            this.confirmNo.hovered ? '#ffffff' : '#88aabb',
            this.confirmNo.hovered ? 'rgba(28, 44, 60, 0.96)' : 'rgba(18, 28, 40, 0.92)',
            uiScale);
    }

    _isInside(point, rect) {
        return point.x >= rect.x && point.x <= rect.x + rect.w
            && point.y >= rect.y && point.y <= rect.y + rect.h;
    }
}
