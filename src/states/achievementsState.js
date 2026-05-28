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
    constructor(game) {
        this.game = game;

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

        // Cache wrapped lines per achievement by id so we don't re-wrap every
        // frame. Keyed on `${id}@${maxWidth}@${unlocked}@${font}` so a window
        // resize or hidden-condition flip invalidates the cache automatically.
        this._wrapCache = new Map();
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

        // Page navigation — keys + bumpers + d-pad LR
        const input = this.game.input;
        const totalPages = Math.max(1, this._totalPages);

        if (input.isKeyJustPressed('ArrowRight') || input.isKeyJustPressed('KeyD')
            || input.isGamepadJustPressed(GP.RB) || input.isGamepadJustPressed(GP.DRIGHT)) {
            if (this.page < totalPages - 1) {
                this.page++;
                this.game.sounds.play('click', 0.6);
            }
        }
        if (input.isKeyJustPressed('ArrowLeft') || input.isKeyJustPressed('KeyA')
            || input.isGamepadJustPressed(GP.LB) || input.isGamepadJustPressed(GP.DLEFT)) {
            if (this.page > 0) {
                this.page--;
                this.game.sounds.play('click', 0.6);
            }
        }

        // Button clicks
        if (input.isMouseJustPressed(0)) {
            if (this.homeBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.game.setState(new MenuState(this.game));
                return;
            }
            if (this.resetBtn.hovered) {
                this.game.sounds.play('click', 1.0);
                this.confirmReset = true;
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

        // Back to menu (Escape / B / Back / Start)
        if (input.isKeyJustPressed('Escape')
            || input.isGamepadJustPressed(GP.B)
            || input.isGamepadJustPressed(GP.BACK)
            || input.isGamepadJustPressed(GP.START)) {
            this.game.sounds.play('click', 1.0);
            this.game.setState(new MenuState(this.game));
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

        for (let i = startIdx; i < endIdx; i++) {
            const localIdx = i - startIdx;
            const row = Math.floor(localIdx / cols);
            const col = localIdx % cols;
            const x = pageX + col * (cardW + colGap);
            const y = gridTop + row * (cardH + rowGap);
            const ach = ACHIEVEMENTS[i];
            const isUnlocked = mgr ? mgr.unlocked.has(ach.id) : false;
            this._drawCard(ctx, ach, isUnlocked, x, y, cardW, cardH, uiScale);
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

        // Status pill width reserved on the top row.
        const statusText = unlocked ? 'UNLOCKED' : 'LOCKED';
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        const statusW = ctx.measureText(statusText).width;
        const nameMaxW = textMaxW - statusW - Math.floor(uiScale * 6);

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

        // Card border
        ctx.strokeStyle = unlocked ? '#22556a' : '#1a2233';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

        // Icon box — full height, flush against the left edge
        this._drawIconBox(ctx, ach, unlocked, x, y, iconSize, uiScale);

        // Vertical rhythm — line heights are slot heights (baseline-to-baseline
        // spacing). Block layout treats each text region as stacked slots so
        // we can measure the full visual height and center it inside the card.
        const nameLineH = Math.floor(uiScale * 9);
        const bodyLineH = Math.floor(uiScale * 7);
        const gapAfterName = Math.floor(uiScale * 7);
        const gapAfterDesc = ach.flavor ? Math.floor(uiScale * 6) : 0;

        // Total visual height of the text block.
        let contentH = nameLines.length * nameLineH;
        if (descLines.length > 0)   contentH += gapAfterName + descLines.length * bodyLineH;
        if (flavorLines.length > 0) contentH += gapAfterDesc + flavorLines.length * bodyLineH;

        const blockTop = y + Math.max(0, Math.floor((h - contentH) / 2));

        // Baseline lives near the bottom of each slot — 0.85 of lineH from
        // the top gives roughly the right cap/x-height alignment for these
        // pixel fonts.
        let cursorY = blockTop;
        const baselineIn = (lineH) => lineH - Math.floor(lineH * 0.15);

        ctx.textAlign = 'left';

        // Name
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        ctx.fillStyle = unlocked ? '#ffffff' : '#778899';
        const firstNameBaseline = cursorY + baselineIn(nameLineH);
        for (const line of nameLines) {
            ctx.fillText(line, textX, cursorY + baselineIn(nameLineH));
            cursorY += nameLineH;
        }

        // Status pill — anchored to first name line baseline
        ctx.font = `${Math.floor(4 * uiScale)}px Astro4x`;
        ctx.fillStyle = unlocked ? '#44ddff' : '#445566';
        ctx.textAlign = 'right';
        ctx.fillText(statusText, textRightEdge, firstNameBaseline);

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
