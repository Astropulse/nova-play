import { CODEX_BOSSES, CODEX_EVENTS } from '../data/codex.js';
import { MenuState } from './menuState.js';
import { GP } from '../engine/inputManager.js';

// Codex — bosses and world events. A sibling of the upgrades codex (same
// header, page flips and footer chrome). Three card states:
//   defeated / discovered — full art, name, lore, kill / sighting count;
//   sighted (bosses only)  — full art dimmed, name, lore, "NOT YET DEFEATED";
//   unknown                — dark silhouette, everything else masked.
// Reads AchievementManager.lifetime: bossesDefeated, bossesEncountered,
// eventTypes.
export class BestiaryState {
    constructor(game, returnState = null) {
        this.game = game;
        this.returnState = returnState;
        this.page = 0;
        this.homeBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.prevPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.nextPageBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.entries = [
            ...CODEX_BOSSES.map(e => ({ ...e, kind: 'boss' })),
            ...CODEX_EVENTS.map(e => ({ ...e, kind: 'event' })),
        ];
        this._totalPages = 1;
        this._silhouetteCache = new Map();
        this._wrapCache = new Map();
    }

    enter() { this.game.sounds.startMusic(); }
    exit() {}

    _state(e) {
        const L = this.game.achievements ? this.game.achievements.lifetime : null;
        if (!L) return { kind: 'unknown', n: 0 };
        if (e.kind === 'boss') {
            let n = (L.bossesDefeated && L.bossesDefeated[e.id]) || 0;
            // The Dragon also counts by its seven heads hunted one by one.
            if (e.id === 'Dragon' && L.bossesDefeated) {
                let heads = 0;
                for (const k in L.bossesDefeated) if (k.startsWith('Head:')) heads++;
                if (!n && heads) return { kind: 'sighted', n: 0, heads };
            }
            if (n > 0) return { kind: 'defeated', n };
            if (L.bossesEncountered && L.bossesEncountered[e.id]) return { kind: 'sighted', n: 0 };
            return { kind: 'unknown', n: 0 };
        }
        const n = (L.eventTypes && L.eventTypes[e.id]) || 0;
        return n > 0 ? { kind: 'defeated', n } : { kind: 'unknown', n: 0 };
    }

    _back() {
        this.game.sounds.play('click', 1.0);
        this.game.setState(this.returnState || new MenuState(this.game));
    }

    update(dt) {
        const mouse = this.game.getMousePos();
        const inside = (r) => mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h;
        this.homeBtn.hovered = inside(this.homeBtn);
        this.prevPageBtn.hovered = inside(this.prevPageBtn);
        this.nextPageBtn.hovered = inside(this.nextPageBtn);
        const input = this.game.input;
        const flip = (d) => {
            const n = this.page + d;
            if (n < 0 || n > this._totalPages - 1) return;
            this.page = n;
            this.game.sounds.play('click', 0.6);
        };
        if (input.isKeyJustPressed('ArrowRight') || input.isKeyJustPressed('KeyD') || input.isGamepadJustPressed(GP.RB)) flip(1);
        if (input.isKeyJustPressed('ArrowLeft') || input.isKeyJustPressed('KeyA') || input.isGamepadJustPressed(GP.LB)) flip(-1);
        if (input.isMouseJustPressed(0)) {
            if (this.homeBtn.hovered) return this._back();
            if (this.prevPageBtn.hovered) flip(-1);
            if (this.nextPageBtn.hovered) flip(1);
        }
        if (input.isKeyJustPressed('Escape') || input.isGamepadJustPressed(GP.B)
            || input.isGamepadJustPressed(GP.BACK) || input.isGamepadJustPressed(GP.START)) return this._back();
    }

    draw(ctx) {
        const game = this.game, cw = game.width, ch = game.height, uiScale = game.uiScale;
        const margin = Math.floor(uiScale * 12);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);
        ctx.fillStyle = '#0a1220';
        const headerH = Math.floor(uiScale * 32);
        ctx.fillRect(0, 0, cw, headerH);
        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(11 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('CODEX', cw / 2, Math.floor(headerH * 0.66));

        let bossN = 0, evN = 0;
        for (const e of this.entries) {
            const s = this._state(e);
            if (s.kind === 'defeated') { if (e.kind === 'boss') bossN++; else evN++; }
        }
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillText(`BOSSES FELLED ${bossN} / ${CODEX_BOSSES.length}   ·   EVENTS FOUND ${evN} / ${CODEX_EVENTS.length}`,
            cw / 2, headerH + Math.floor(uiScale * 8));

        const footerH = Math.floor(uiScale * 24);
        const listTop = headerH + Math.floor(uiScale * 18);
        const listBottom = ch - margin - footerH - Math.floor(uiScale * 6);
        const listH = listBottom - listTop;
        const pageW = Math.floor(cw * 0.7), pageX = Math.floor(cw / 2 - pageW / 2);
        const targetW = uiScale * 180, colGap = Math.floor(uiScale * 8), rowGap = colGap;
        const cols = Math.max(1, Math.floor((pageW + colGap) / (targetW + colGap)));
        const cardW = Math.floor((pageW - colGap * (cols - 1)) / cols);
        const cardH = Math.floor(cardW * 0.42);
        const rows = Math.max(1, Math.floor((listH + rowGap) / (cardH + rowGap)));
        const per = cols * rows;
        this._totalPages = Math.max(1, Math.ceil(this.entries.length / per));
        this.page = Math.max(0, Math.min(this.page, this._totalPages - 1));
        const start = this.page * per, end = Math.min(this.entries.length, start + per);
        const blockH = rows * cardH + (rows - 1) * rowGap;
        const top = listTop + Math.max(0, Math.floor((listH - blockH) / 2));
        for (let i = start; i < end; i++) {
            const k = i - start, r = Math.floor(k / cols), c = k % cols;
            this._drawCard(ctx, this.entries[i], pageX + c * (cardW + colGap), top + r * (cardH + rowGap), cardW, cardH, uiScale);
        }

        // Footer: home + page controls (same chrome as the upgrades codex).
        const homeSize = game.spriteSize('home_button_off', uiScale);
        Object.assign(this.homeBtn, { x: margin, y: ch - margin - homeSize.h, w: homeSize.w, h: homeSize.h });
        game.drawSprite(ctx, this.homeBtn.hovered ? 'home_button_on' : 'home_button_off', this.homeBtn.x, this.homeBtn.y, uiScale);
        if (this._totalPages > 1) {
            const pcY = ch - margin - homeSize.h, pcH = homeSize.h;
            const arrowW = Math.floor(uiScale * 16), labelW = Math.floor(uiScale * 48), gap = Math.floor(uiScale * 4);
            const left = Math.floor(cw / 2 - (arrowW * 2 + labelW + gap * 2) / 2);
            Object.assign(this.prevPageBtn, { x: left, y: pcY, w: arrowW, h: pcH });
            Object.assign(this.nextPageBtn, { x: left + arrowW + gap + labelW + gap, y: pcY, w: arrowW, h: pcH });
            const canP = this.page > 0, canN = this.page < this._totalPages - 1;
            this._btn(ctx, this.prevPageBtn, '◄', canP ? (this.prevPageBtn.hovered ? '#ffffff' : '#44ddff') : '#33445a', uiScale);
            this._btn(ctx, this.nextPageBtn, '►', canN ? (this.nextPageBtn.hovered ? '#ffffff' : '#44ddff') : '#33445a', uiScale);
            ctx.fillStyle = '#ccddee';
            ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`PAGE ${this.page + 1} / ${this._totalPages}`, left + arrowW + gap + labelW / 2, pcY + pcH / 2);
        } else {
            this.prevPageBtn.w = this.nextPageBtn.w = 0;
        }
        ctx.restore();
    }

    _drawCard(ctx, e, x, y, w, h, uiScale) {
        const st = this._state(e);
        const known = st.kind !== 'unknown';
        const px = uiScale;
        ctx.fillStyle = known ? 'rgba(14, 24, 38, 0.95)' : 'rgba(10, 16, 26, 0.9)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = st.kind === 'defeated' ? e.color : known ? '#556677' : '#223344';
        ctx.fillRect(x, y, w, px); ctx.fillRect(x, y + h - px, w, px);
        ctx.fillRect(x, y, px, h); ctx.fillRect(x + w - px, y, px, h);

        // Portrait box.
        const box = h - 8 * px, bx = x + 4 * px, by = y + 4 * px;
        ctx.fillStyle = '#070d18';
        ctx.fillRect(bx, by, box, box);
        const a = this._asset(e.sprite);
        if (a) {
            const s = Math.min(box / a.w, box / a.h) * 0.92;
            const dw = Math.floor(a.w * s), dh = Math.floor(a.h * s);
            const dx = bx + Math.floor((box - dw) / 2), dy = by + Math.floor((box - dh) / 2);
            if (!known) { const sil = this._silhouette(e.sprite, a); if (sil) ctx.drawImage(sil, dx, dy, dw, dh); }
            else {
                ctx.globalAlpha = st.kind === 'sighted' ? 0.55 : 1;
                ctx.drawImage(a.img, dx, dy, dw, dh);
                ctx.globalAlpha = 1;
            }
        }

        // Text column.
        const tx = bx + box + 6 * px, tw = x + w - tx - 6 * px;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = known ? e.color : '#445566';
        ctx.font = `${Math.floor(7 * uiScale)}px Astro5x`;
        ctx.fillText(known ? e.name : '? ? ?', tx, y + 6 * px);
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillStyle = '#8899aa';
        const tag = e.kind === 'boss'
            ? (st.kind === 'defeated' ? `DEFEATED ×${st.n}` : st.kind === 'sighted' ? (st.heads ? `HEADS TAKEN ${st.heads} / 7` : 'SIGHTED · NOT YET DEFEATED') : 'UNKNOWN BOSS')
            : (st.kind === 'defeated' ? `FOUND ×${st.n}` : 'UNKNOWN EVENT');
        ctx.fillText(tag, tx, y + 16 * px);
        if (known) {
            ctx.fillStyle = '#ccddee';
            const lines = this._wrap(ctx, e.id, e.lore, tw);
            const lh = Math.floor(7 * uiScale);
            const maxL = Math.max(1, Math.floor((y + h - 4 * px - (y + 26 * px)) / lh));
            for (let i = 0; i < Math.min(lines.length, maxL); i++) ctx.fillText(lines[i], tx, y + 26 * px + i * lh);
        }
        ctx.textBaseline = 'alphabetic';
    }

    _wrap(ctx, key, text, maxW) {
        const k = key + '|' + maxW;
        const c = this._wrapCache.get(k);
        if (c) return c;
        const words = text.split(' '), out = [];
        let line = '';
        for (const w of words) {
            const t = line ? line + ' ' + w : w;
            if (line && ctx.measureText(t).width > maxW) { out.push(line); line = w; } else line = t;
        }
        if (line) out.push(line);
        this._wrapCache.set(k, out);
        return out;
    }

    _asset(key) {
        const asset = this.game.assets.get(key);
        if (!asset) return null;
        const img = asset.canvas || (Array.isArray(asset) ? asset[0] && asset[0].canvas : asset);
        if (!img) return null;
        const w = (Array.isArray(asset) ? img.width : asset.width) || img.width;
        const h = (Array.isArray(asset) ? img.height : asset.height) || img.height;
        return w && h ? { img, w, h } : null;
    }

    _silhouette(key, a) {
        if (this._silhouetteCache.has(key)) return this._silhouetteCache.get(key);
        const cv = document.createElement('canvas');
        cv.width = a.img.width; cv.height = a.img.height;
        const c = cv.getContext('2d');
        c.drawImage(a.img, 0, 0);
        c.globalCompositeOperation = 'source-in';
        c.fillStyle = '#2c3e54';
        c.fillRect(0, 0, cv.width, cv.height);
        this._silhouetteCache.set(key, cv);
        return cv;
    }

    _btn(ctx, b, label, fg, uiScale) {
        ctx.fillStyle = b.hovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.strokeStyle = fg;
        ctx.lineWidth = 1;
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1);
        ctx.fillStyle = fg;
        ctx.font = `${Math.floor(5 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
        ctx.textBaseline = 'alphabetic';
    }
}
