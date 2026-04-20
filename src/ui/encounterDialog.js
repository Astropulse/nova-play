/**
 * EncounterDialog — FTL-style dialog overlay with typewriter text and options.
 *
 * Color tags: [scrap], [upgrade], [cost], [good], [warn]
 * Typewriter: ~2 seconds for full text, type sfx every 2 chars.
 * Tooltip: Shows upgrade properties on hover.
 */

import { UPGRADES, RARITY_COLORS } from '../data/upgrades.js';

const TAG_COLORS = {
    scrap: '#ffff44',
    upgrade: '#44ddff',
    cost: '#ff4444',
    good: '#44ff44',
    warn: '#ff8844'
};

const DIALOG_STATE = {
    TYPING_MESSAGE: 0,
    SHOWING_OPTIONS: 1,
    TYPING_RESPONSE: 2,
    CLOSED: 3
};

export class EncounterDialog {
    constructor(game, encounter, dialogData, player, playingState) {
        this.game = game;
        this.encounter = encounter;
        this.player = player;
        this.playingState = playingState;

        this.state = DIALOG_STATE.TYPING_MESSAGE;
        this.closed = false;
        this.forced = dialogData.forced || false;

        // Current message
        this.segments = this._parse(dialogData.message);
        this.totalChars = this.segments.reduce((s, seg) => s + seg.text.length, 0);
        this.revealedChars = 0;
        this.typingSpeed = Math.max(this.totalChars / 2.0, 30); // chars/sec, ~2s total
        this.lastSoundChar = -2; // tracks when we last played a type sound

        // Options
        this.options = dialogData.options || [];
        this.hoveredOption = -1;

        // Response state (after choosing an option)
        this.responseSegments = null;
        this.responseTotalChars = 0;
        this.responseRevealedChars = 0;
        this.responseTypingSpeed = 0;
        this.responseCloseTimer = -1;

        // Layout cache
        this._layoutDirty = true;
        this.upgradeHitboxes = [];
        this.hoveredUpgrade = null;
    }

    _parse(text) {
        if (!text) return [{ text: '', color: null, meta: null }];
        const segments = [];
        let pos = 0;
        const regex = /\[(\w+)\](.*?)\[\/\1\]/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > pos) {
                segments.push({ text: text.slice(pos, match.index), color: null, meta: null });
            }

            const tag = match[1];
            let content = match[2];
            let meta = null;

            if (tag === 'upgrade' && content.includes('#')) {
                const parts = content.split('#');
                content = parts[0];
                meta = parts[1];
            }

            segments.push({
                text: content,
                color: TAG_COLORS[tag] || null,
                tag: tag,
                meta: meta
            });
            pos = match.index + match[0].length;
        }
        if (pos < text.length) {
            segments.push({ text: text.slice(pos), color: null, meta: null });
        }
        return segments;
    }

    update(dt) {
        if (this.closed) return;

        const input = this.game.input;

        switch (this.state) {
            case DIALOG_STATE.TYPING_MESSAGE: {
                const prevChars = Math.floor(this.revealedChars);
                this.revealedChars += this.typingSpeed * dt;
                const nowChars = Math.floor(this.revealedChars);

                // Play type sounds every 2 chars
                for (let c = prevChars; c < nowChars; c++) {
                    if (c - this.lastSoundChar >= 2) {
                        this.game.sounds.play('type', 0.3);
                        this.lastSoundChar = c;
                    }
                }

                if (this.revealedChars >= this.totalChars) {
                    this.revealedChars = this.totalChars;
                    this.state = DIALOG_STATE.SHOWING_OPTIONS;
                }

                // Click to skip
                if (input.isMouseJustPressed(0) || input.isKeyJustPressed('Space')) {
                    this.revealedChars = this.totalChars;
                    this.state = DIALOG_STATE.SHOWING_OPTIONS;
                }
                break;
            }

            case DIALOG_STATE.SHOWING_OPTIONS: {
                // Handle click on options
                if (input.isMouseJustPressed(0) && this.hoveredOption >= 0) {
                    this._selectOption(this.hoveredOption);
                }

                // Number keys 1-9
                for (let i = 0; i < Math.min(this.options.length, 9); i++) {
                    if (input.isKeyJustPressed(`Digit${i + 1}`)) {
                        this._selectOption(i);
                    }
                }

                // Escape to close (blocked on forced encounters)
                if (!this.forced && input.isKeyJustPressed('Escape')) {
                    this.closed = true;
                    this.encounter.shouldStay = true;
                }
                break;
            }

            case DIALOG_STATE.TYPING_RESPONSE: {
                const prevChars = Math.floor(this.responseRevealedChars);
                this.responseRevealedChars += this.responseTypingSpeed * dt;
                const nowChars = Math.floor(this.responseRevealedChars);

                for (let c = prevChars; c < nowChars; c++) {
                    if (c % 2 === 0) {
                        this.game.sounds.play('type', 0.3);
                    }
                }

                if (this.responseRevealedChars >= this.responseTotalChars) {
                    this.responseRevealedChars = this.responseTotalChars;

                    if (this.options.length > 0) {
                        this.state = DIALOG_STATE.SHOWING_OPTIONS;
                    } else {
                        this.responseCloseTimer = (this.responseCloseTimer === -1) ? 1.5 : this.responseCloseTimer - dt;
                        if (this.responseCloseTimer <= 0) {
                            this.closed = true;
                        }
                    }
                }

                // Click to skip response typing
                if (input.isMouseJustPressed(0) || input.isKeyJustPressed('Space')) {
                    this.responseRevealedChars = this.responseTotalChars;
                    if (this.options.length === 0) {
                        this.responseCloseTimer = 0.5;
                    }
                }
                break;
            }
        }

        // Hover identification
        this.hoveredUpgrade = null;
        if (this.upgradeHitboxes.length > 0) {
            const mouse = this.game.getMousePos();
            for (const h of this.upgradeHitboxes) {
                if (mouse.x >= h.x && mouse.x <= h.x + h.w &&
                    mouse.y >= h.y && mouse.y <= h.y + h.h) {
                    this.hoveredUpgrade = UPGRADES.find(u => u.id === h.id);
                    break;
                }
            }
        }
    }

    _selectOption(index) {
        if (index < 0 || index >= this.options.length) return;
        const opt = this.options[index];
        this.game.sounds.play('click', 0.5);

        if (!opt.action) {
            this.closed = true;
            return;
        }

        const result = opt.action(this.player, this.playingState, this.encounter);
        if (!result) {
            this.closed = true;
            return;
        }

        // Show response
        if (result.message) {
            this.responseSegments = this._parse(result.message);
            this.responseTotalChars = this.responseSegments.reduce((s, seg) => s + seg.text.length, 0);
            this.responseRevealedChars = 0;
            this.responseTypingSpeed = Math.max(this.responseTotalChars / 1.5, 20);
            this.responseCloseTimer = -1;
        }

        if (result.close) {
            this.options = [];
            this.state = DIALOG_STATE.TYPING_RESPONSE;
            this.responseCloseTimer = -1; // will be set in update once typing finishes
        } else if (result.options) {
            this.options = result.options;
            this.hoveredOption = -1;
            this.state = DIALOG_STATE.TYPING_RESPONSE;
        } else {
            this.options = [];
            this.state = DIALOG_STATE.TYPING_RESPONSE;
        }
    }

    draw(ctx) {
        if (this.closed) return;

        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        // Dim background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, 0, cw, ch);

        this.upgradeHitboxes = []; // Reset hitboxes for this frame

        // Panel dimensions
        const panelW = Math.min(cw * 0.6, 160 * uiScale);
        const panelX = Math.floor((cw - panelW) / 2);
        const panelTop = Math.floor(ch * 0.2);
        const pad = 10 * uiScale;
        const fontSize = Math.floor(6 * uiScale);
        const headerFontSize = Math.floor(8 * uiScale);
        const lineHeight = Math.floor(fontSize * 1.6);

        // Portrait area (64x64 source, integer-scaled, with colored 1-pixel border)
        const portraitLogicalSize = 64;
        const portraitScale = Math.max(1, Math.round(40 * uiScale / portraitLogicalSize));
        const portraitDrawSize = portraitLogicalSize * portraitScale;
        const avatarSize = portraitDrawSize + portraitScale * 2;
        const avatarX = panelX + pad;
        const avatarY = panelTop + pad;

        // Header
        const headerX = avatarX + avatarSize + pad;
        const headerY = panelTop + pad + headerFontSize;

        ctx.save();

        // Panel background
        ctx.fillStyle = '#0a101a';
        ctx.strokeStyle = '#223344';
        ctx.lineWidth = 2;

        // Calculate message height for panel sizing
        ctx.font = `${fontSize}px Astro4x`;
        const msgMaxW = panelW - pad * 2;
        const messageLines = this._wrapSegments(ctx, this.segments, msgMaxW);
        const responseLinesArr = this.responseSegments ? this._wrapSegments(ctx, this.responseSegments, msgMaxW) : [];

        let contentH = avatarSize + pad * 2; // avatar area
        contentH += messageLines.length * lineHeight + pad;
        if (responseLinesArr.length > 0) contentH += responseLinesArr.length * lineHeight + pad;
        if (this.state === DIALOG_STATE.SHOWING_OPTIONS) {
            contentH += this.options.length * lineHeight + pad;
        }
        contentH += pad * 2;

        const panelH = contentH;

        // Draw panel
        ctx.fillRect(panelX, panelTop, panelW, panelH);
        ctx.strokeRect(panelX, panelTop, panelW, panelH);

        // Draw encounter portrait with colored 1-pixel border
        if (this.encounter.portraitImg) {
            const asset = this.encounter.portraitImg;
            const img = asset.canvas || asset;

            ctx.fillStyle = this.encounter.indicatorColor || '#44ffaa';
            ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);

            const prevSmoothing = ctx.imageSmoothingEnabled;
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(img,
                avatarX + portraitScale,
                avatarY + portraitScale,
                portraitDrawSize, portraitDrawSize);
            ctx.imageSmoothingEnabled = prevSmoothing;
        }

        // Draw ship type name
        ctx.font = `${headerFontSize}px Astro5x`;
        ctx.fillStyle = this.encounter.indicatorColor || '#44ffaa';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(this.encounter.displayName, headerX, panelTop + pad);

        // Divider under header
        const divY = avatarY + avatarSize + pad * 0.5;
        ctx.strokeStyle = '#223344';
        ctx.beginPath();
        ctx.moveTo(panelX + pad, divY);
        ctx.lineTo(panelX + panelW - pad, divY);
        ctx.stroke();

        // Draw message text
        ctx.font = `${fontSize}px Astro4x`;
        ctx.textBaseline = 'top';
        let textY = divY + pad;
        this._drawWrappedText(ctx, messageLines, panelX + pad, textY, lineHeight,
            Math.floor(this.revealedChars));

        textY += messageLines.length * lineHeight;

        // Draw response text
        if (this.responseSegments && this.responseRevealedChars > 0) {
            textY += pad * 0.5;
            ctx.font = `${fontSize}px Astro4x`;
            this._drawWrappedText(ctx, responseLinesArr, panelX + pad, textY, lineHeight,
                Math.floor(this.responseRevealedChars));
            textY += responseLinesArr.length * lineHeight;
        }

        // Draw options
        if (this.state === DIALOG_STATE.SHOWING_OPTIONS && this.options.length > 0) {
            textY += pad;
            const mouse = this.game.getMousePos();
            this.hoveredOption = -1;

            const optFontSize = Math.floor(6 * uiScale);
            ctx.font = `${optFontSize}px Astro4x`;

            for (let i = 0; i < this.options.length; i++) {
                const optY = textY + i * lineHeight;
                const optH = lineHeight;

                // Hit test
                const inBounds = mouse.x >= panelX + pad && mouse.x <= panelX + panelW - pad &&
                    mouse.y >= optY && mouse.y <= optY + optH;
                if (inBounds) this.hoveredOption = i;

                // Number prefix
                const prefix = `[${i + 1}] `;
                const prefixW = ctx.measureText(prefix).width;

                ctx.fillStyle = inBounds ? '#ffffff' : '#667788';
                ctx.fillText(prefix, panelX + pad, optY);

                // Option label with color tags
                const optSegs = this._parse(this.options[i].label);
                let ox = panelX + pad + prefixW;
                for (const seg of optSegs) {
                    const textW = ctx.measureText(seg.text).width;
                    if (seg.meta) {
                        this.upgradeHitboxes.push({
                            x: ox, y: optY, w: textW, h: optH,
                            id: seg.meta
                        });
                    }
                    ctx.fillStyle = seg.color || (inBounds ? '#ffffff' : '#88aabb');
                    ctx.fillText(seg.text, ox, optY);
                    ox += textW;
                }
            }
        }

        // Draw tooltip
        if (this.hoveredUpgrade) {
            this._drawUpgradeTooltip(ctx, this.hoveredUpgrade);
        }

        ctx.restore();
    }

    _wrapSegments(ctx, segments, maxWidth) {
        // Flatten to plain text, compute line breaks, return array of lines
        // Each line is an array of {text, color} segments
        const fullText = segments.map(s => s.text).join('');
        const words = fullText.split(' ');
        const lines = [];
        let currentLine = '';

        for (const word of words) {
            const test = currentLine ? currentLine + ' ' + word : word;
            if (ctx.measureText(test).width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = test;
            }
        }
        if (currentLine) lines.push(currentLine);

        // Now re-map lines back to colored segments
        const result = [];
        let charPos = 0;

        for (const lineText of lines) {
            const lineSegs = [];
            let lineRemaining = lineText.length;

            // Account for space between words (the space removed by split)
            if (charPos > 0) charPos++; // skip the space
            let lineStart = charPos;

            // Walk through segments to find which colors apply
            let segIdx = 0;
            let segOffset = 0;
            let lPos = 0;

            // Recalculate from absolute char position
            // This approach is simpler: draw using segments directly
            result.push(lineText);
            charPos += lineText.length;
        }

        // Simplified: return plain text lines (color applied during draw)
        return lines.map(l => l);
    }

    _drawWrappedText(ctx, lines, x, y, lineHeight, maxChars) {
        let totalDrawn = 0;
        const allSegments = (this.responseSegments && totalDrawn === 0 &&
            lines.length > 0 && this.responseSegments.map(s => s.text).join('').includes(lines[0]))
            ? this.responseSegments : this.segments;

        const { colorMap, metaMap } = this._buildMaps(allSegments);

        let charIdx = 0;
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            let curX = x;
            const ly = y + li * lineHeight;

            let wordStart = 0;
            for (let ci = 0; ci <= line.length; ci++) {
                const isEnd = ci === line.length;
                const isSpace = !isEnd && line[ci] === ' ';

                if (isSpace || isEnd) {
                    const word = line.slice(wordStart, ci);
                    if (word.length > 0 && charIdx < maxChars) {
                        const visibleLen = Math.min(word.length, maxChars - charIdx);
                        const visible = word.slice(0, visibleLen);

                        const color = charIdx < colorMap.length ? colorMap[charIdx] : null;
                        const meta = charIdx < metaMap.length ? metaMap[charIdx] : null;

                        const textW = ctx.measureText(visible).width;
                        if (meta && charIdx < maxChars) {
                            this.upgradeHitboxes.push({
                                x: curX, y: ly, w: textW, h: lineHeight,
                                id: meta
                            });
                        }

                        ctx.fillStyle = color || '#ccddee';
                        ctx.fillText(visible, curX, ly);
                        curX += textW;
                        charIdx += visibleLen;
                    }
                    if (isSpace && charIdx < maxChars) {
                        curX += ctx.measureText(' ').width;
                        charIdx++;
                    }
                    wordStart = ci + 1;
                }
            }
            if (li < lines.length - 1) charIdx++;
        }
    }

    _buildMaps(segments) {
        const colorMap = [];
        const metaMap = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.text.length; i++) {
                colorMap.push(seg.color);
                metaMap.push(seg.meta);
            }
        }
        return { colorMap, metaMap };
    }

    _drawUpgradeTooltip(ctx, upg) {
        const mouse = this.game.getMousePos();
        const uiScale = this.game.uiScale;

        const pad = 8 * uiScale;
        const fontSize = Math.floor(5 * uiScale);
        const titleFontSize = Math.floor(6 * uiScale);
        ctx.font = `${fontSize}px Astro4x`;

        // Calculate dimensions
        const name = upg.name.toUpperCase();
        const rarity = upg.rarity.toUpperCase();
        const desc = upg.description;

        const maxWidth = 120 * uiScale;
        const descLines = [];
        const words = desc.split(' ');
        let curLine = '';
        for (const w of words) {
            const test = curLine ? curLine + ' ' + w : w;
            if (ctx.measureText(test).width > maxWidth) {
                descLines.push(curLine);
                curLine = w;
            } else {
                curLine = test;
            }
        }
        if (curLine) descLines.push(curLine);

        const headerW = Math.max(ctx.measureText(name).width * 1.2, ctx.measureText(rarity).width);
        const tw = Math.max(headerW, descLines.reduce((max, l) => Math.max(max, ctx.measureText(l).width), 0)) + pad * 2;
        const th = (descLines.length + 3) * fontSize * 1.5 + pad * 2;

        let tx = mouse.x + 10;
        let ty = mouse.y + 10;
        if (tx + tw > this.game.width) tx = mouse.x - tw - 10;
        if (ty + th > this.game.height) ty = mouse.y - th - 10;

        // Frame
        ctx.fillStyle = 'rgba(5, 10, 20, 0.95)';
        ctx.strokeStyle = '#334455';
        ctx.lineWidth = 1;
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeRect(tx, ty, tw, th);

        let cy = ty + pad;

        // Name
        ctx.font = `${titleFontSize}px Astro5x`;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(name, tx + pad, cy);
        cy += titleFontSize * 1.5;

        // Rarity
        ctx.font = `${fontSize}px Astro4x`;
        ctx.fillStyle = RARITY_COLORS[upg.rarity] || '#ffffff';
        ctx.fillText(rarity, tx + pad, cy);
        cy += fontSize * 2;

        // Divider
        ctx.strokeStyle = '#223344';
        ctx.beginPath();
        ctx.moveTo(tx + pad, cy - fontSize * 0.5);
        ctx.lineTo(tx + tw - pad, cy - fontSize * 0.5);
        ctx.stroke();

        // Description
        ctx.fillStyle = '#ccddee';
        for (const line of descLines) {
            ctx.fillText(line, tx + pad, cy);
            cy += fontSize * 1.4;
        }

        if (upg.cost) {
            cy += fontSize * 0.5;
            ctx.fillStyle = '#ffff44';
            ctx.fillText(`BASE VALUE: ${upg.cost} SCRAP`, tx + pad, cy);
        }
    }
}
