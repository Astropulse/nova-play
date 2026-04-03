/**
 * EncounterDialog — FTL-style dialog overlay with typewriter text and options.
 *
 * Color tags: [scrap], [upgrade], [cost], [good], [warn]
 * Typewriter: ~2 seconds for full text, type sfx every 2 chars.
 */

const TAG_COLORS = {
    scrap:   '#ffff44',
    upgrade: '#44ddff',
    cost:    '#ff4444',
    good:    '#44ff44',
    warn:    '#ff8844'
};

const DIALOG_STATE = {
    TYPING_MESSAGE:  0,
    SHOWING_OPTIONS: 1,
    TYPING_RESPONSE: 2,
    CLOSED:          3
};

export class EncounterDialog {
    constructor(game, encounter, dialogData, player, playingState) {
        this.game = game;
        this.encounter = encounter;
        this.player = player;
        this.playingState = playingState;

        this.state = DIALOG_STATE.TYPING_MESSAGE;
        this.closed = false;

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
    }

    _parse(text) {
        if (!text) return [{ text: '', color: null }];
        const segments = [];
        let pos = 0;
        const regex = /\[(\w+)\](.*?)\[\/\1\]/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            if (match.index > pos) {
                segments.push({ text: text.slice(pos, match.index), color: null });
            }
            segments.push({ text: match[2], color: TAG_COLORS[match[1]] || null });
            pos = match.index + match[0].length;
        }
        if (pos < text.length) {
            segments.push({ text: text.slice(pos), color: null });
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

                // Escape to close
                if (input.isKeyJustPressed('Escape')) {
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

        // Panel dimensions
        const panelW = Math.min(cw * 0.6, 160 * uiScale);
        const panelX = Math.floor((cw - panelW) / 2);
        const panelTop = Math.floor(ch * 0.2);
        const pad = 10 * uiScale;
        const fontSize = Math.floor(6 * uiScale);
        const headerFontSize = Math.floor(8 * uiScale);
        const lineHeight = Math.floor(fontSize * 1.6);

        // Ship avatar area
        const avatarSize = 40 * uiScale;
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

        // Draw ship avatar
        if (this.encounter.img) {
            const img = this.encounter.img;
            const aspect = img.width / img.height;
            let drawW = avatarSize;
            let drawH = avatarSize;
            if (aspect > 1) { drawH = avatarSize / aspect; }
            else { drawW = avatarSize * aspect; }
            ctx.drawImage(img,
                avatarX + (avatarSize - drawW) / 2,
                avatarY + (avatarSize - drawH) / 2,
                drawW, drawH);
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
                    ctx.fillStyle = seg.color || (inBounds ? '#ffffff' : '#88aabb');
                    ctx.fillText(seg.text, ox, optY);
                    ox += ctx.measureText(seg.text).width;
                }
            }
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
        // Draw using original segments with character count limit
        let totalDrawn = 0;
        const segments = (this.state === DIALOG_STATE.TYPING_RESPONSE && this.responseSegments)
            ? (lines === this._wrapSegments(ctx, this.responseSegments, 1000) ? this.responseSegments : this.segments)
            : this.segments;

        // Simple approach: render each line from flattened plain text,
        // applying segment colors based on character position
        const allSegments = (this.responseSegments && totalDrawn === 0 &&
            lines.length > 0 && this.responseSegments.map(s => s.text).join('').includes(lines[0]))
            ? this.responseSegments : this.segments;

        // Build a character-color map
        const colorMap = this._buildColorMap(allSegments);

        let charIdx = 0;
        for (let li = 0; li < lines.length; li++) {
            const line = lines[li];
            let curX = x;
            const ly = y + li * lineHeight;

            // Render word by word to maintain spacing but char by char for color
            let wordStart = 0;
            for (let ci = 0; ci <= line.length; ci++) {
                const isEnd = ci === line.length;
                const isSpace = !isEnd && line[ci] === ' ';

                if (isSpace || isEnd) {
                    // Render the word
                    const word = line.slice(wordStart, ci + (isSpace ? 0 : 0));
                    if (word.length > 0 && charIdx < maxChars) {
                        const visibleLen = Math.min(word.length, maxChars - charIdx);
                        const visible = word.slice(0, visibleLen);

                        // Get color from map at this position
                        const color = charIdx < colorMap.length ? colorMap[charIdx] : null;
                        ctx.fillStyle = color || '#ccddee';
                        ctx.fillText(visible, curX, ly);
                        curX += ctx.measureText(visible).width;
                        charIdx += visibleLen;
                    }
                    if (isSpace && charIdx < maxChars) {
                        curX += ctx.measureText(' ').width;
                        charIdx++;
                    }
                    wordStart = ci + 1;
                }
            }
            if (li < lines.length - 1) {
                // Account for the space that was removed by word wrapping
                charIdx++;
            }
        }
    }

    _buildColorMap(segments) {
        const map = [];
        for (const seg of segments) {
            for (let i = 0; i < seg.text.length; i++) {
                map.push(seg.color);
            }
        }
        return map;
    }
}
