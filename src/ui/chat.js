// In-game chat overlay (multiplayer only).
//
// Enter opens the input line, Enter sends, Escape cancels. Recent messages
// stack above the input area bottom-left and fade out after a few seconds.
// While the input is open, gameplay controls are suppressed by the playing
// state (chat.active), the same way the dev console takes over typing.

const MSG_FADE_AFTER = 8.0;   // seconds a message stays fully visible
const MSG_FADE_TIME = 1.5;
const MAX_VISIBLE = 7;

const PLAYER_COLORS = ['#9fe8ff', '#ffd27a', '#b6ff9f', '#ff9fd0', '#c2a8ff', '#9fffe8', '#ffb29f', '#e8ff9f'];
export function playerColor(pid) {
    return PLAYER_COLORS[((pid % PLAYER_COLORS.length) + PLAYER_COLORS.length) % PLAYER_COLORS.length];
}

export class ChatOverlay {
    constructor(game, session) {
        this.game = game;
        this.session = session;
        this.active = false;        // input line open
        this.inputBuffer = '';
        this.cursorTimer = 0;
        this.showCursor = true;
        this.messages = [];         // {pid, name, text, age}
        this.scroll = 0;            // lines scrolled back from the newest message
        this._areaRect = null;      // last-drawn message area (mouse-wheel hover target)

        // Mirror chat arriving through the session.
        this._prevChatCb = session.onChat;
        session.onChat = (entry) => {
            this.messages.push({ pid: entry.pid, name: entry.name, text: entry.text, age: 0 });
            if (this.messages.length > 40) this.messages.shift();
            // Keep the view anchored on what's being read while scrolled back.
            if (this.scroll > 0) this.scroll++;
            if (this._prevChatCb) this._prevChatCb(entry);
        };

        this._keydownListener = (e) => this._handleKeydown(e);
        window.addEventListener('keydown', this._keydownListener);
    }

    destroy() {
        window.removeEventListener('keydown', this._keydownListener);
        if (this.session.onChat) this.session.onChat = this._prevChatCb;
    }

    _handleKeydown(e) {
        if (!this.active) return;
        if (e.key === 'Enter') {
            const text = this.inputBuffer.trim();
            if (text) this.session.sendChat(text);
            this.inputBuffer = '';
            this.active = false;
            this.scroll = 0; // sending snaps the view back to live
        } else if (e.key === 'Escape') {
            this.inputBuffer = '';
            this.active = false;
        } else if (e.key === 'Backspace') {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
        } else if (e.key.length === 1 && this.inputBuffer.length < 200) {
            this.inputBuffer += e.key;
        } else {
            return;
        }
        // Swallow the keystroke from the polled InputManager too, so it can't
        // leak into gameplay a frame later (e.g. Escape reopening the pause
        // menu, or Enter immediately re-opening this input box).
        if (this.game.input) this.game.input.consumeKey(e.code);
        e.preventDefault();
        e.stopPropagation();
    }

    open() {
        this.active = true;
        this.inputBuffer = '';
    }

    update(dt) {
        for (const m of this.messages) m.age += dt;
        this.cursorTimer += dt;
        if (this.cursorTimer >= 0.5) {
            this.cursorTimer = 0;
            this.showCursor = !this.showCursor;
        }

        // Mouse wheel over the chat area scrolls back through history.
        const input = this.game.input;
        const wheel = input ? input.mouseWheelDelta : 0;
        if (wheel && this._areaRect) {
            const m = this.game.getMousePos();
            const r = this._areaRect;
            if (m.x >= r.x && m.x <= r.x + r.w && m.y >= r.y && m.y <= r.y + r.h) {
                const step = Math.max(1, Math.floor(Math.abs(wheel) / 60));
                this.scroll += wheel < 0 ? step : -step;
                const maxScroll = Math.max(0, this.messages.length - MAX_VISIBLE);
                this.scroll = Math.max(0, Math.min(maxScroll, this.scroll));
            }
        }
    }

    // `anchorBottomY` — screen Y the chat block must stay above (the HUD's
    // shield bar). Messages stack upward from there, left side of the screen.
    draw(ctx, anchorBottomY = null) {
        const game = this.game;
        const uiScale = game.uiScale;
        const lineH = Math.floor(7 * uiScale);
        const margin = Math.floor(8 * uiScale);
        const bottom = (anchorBottomY != null ? anchorBottomY : Math.floor(game.height * 0.72))
            - Math.floor(uiScale * 4);

        ctx.save();
        ctx.font = `${5 * uiScale}px Astro4x`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';

        // Input line sits at the bottom of the block (just above the bars);
        // messages stack upward above it.
        const inputH = Math.floor(11 * uiScale);
        const msgBase = this.active ? bottom - inputH - Math.floor(uiScale * 3) : bottom;

        // The wheel-hover zone for scrolling — the strip where messages live.
        this._areaRect = {
            x: margin - uiScale,
            y: msgBase - MAX_VISIBLE * lineH,
            w: Math.floor(game.width * 0.4),
            h: bottom - (msgBase - MAX_VISIBLE * lineH),
        };

        // Scrolled back: the bottom slot becomes a "newer messages" marker so
        // it's obvious the view isn't live.
        const maxScroll = Math.max(0, this.messages.length - MAX_VISIBLE);
        if (this.scroll > maxScroll) this.scroll = maxScroll;
        let slots = MAX_VISIBLE;
        let baseY = msgBase;
        if (this.scroll > 0) {
            const marker = `-- ${this.scroll} newer message${this.scroll > 1 ? 's' : ''} below --`;
            const markerW = ctx.measureText(marker).width;
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = '#000000';
            ctx.fillRect(margin - uiScale, msgBase - lineH + uiScale, markerW + uiScale * 2, lineH);
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = '#8899aa';
            ctx.fillText(marker, margin, msgBase);
            baseY = msgBase - lineH;
            slots = MAX_VISIBLE - 1;
        }

        // Messages (newest at the bottom of the window)
        const end = this.messages.length - this.scroll;
        const visible = this.messages.slice(Math.max(0, end - slots), Math.max(0, end));
        for (let i = 0; i < visible.length; i++) {
            const m = visible[visible.length - 1 - i];
            let alpha = 1;
            // While scrolled (or typing) history must stay readable — skip the
            // age fade that normally hides old lines.
            if (!this.active && this.scroll === 0) {
                if (m.age > MSG_FADE_AFTER + MSG_FADE_TIME) continue;
                if (m.age > MSG_FADE_AFTER) alpha = 1 - (m.age - MSG_FADE_AFTER) / MSG_FADE_TIME;
            }
            const y = baseY - i * lineH;
            const nameStr = `${m.name}: `;
            const nameW = ctx.measureText(nameStr).width;
            const textW = ctx.measureText(m.text).width;

            ctx.globalAlpha = alpha * 0.55;
            ctx.fillStyle = '#000000';
            ctx.fillRect(margin - uiScale, y - lineH + uiScale, nameW + textW + uiScale * 2, lineH);

            ctx.globalAlpha = alpha;
            ctx.fillStyle = playerColor(m.pid);
            ctx.fillText(nameStr, margin, y);
            ctx.fillStyle = '#dde8f0';
            ctx.fillText(m.text, margin + nameW, y);
        }

        // Input line
        if (this.active) {
            const boxTop = bottom - inputH;
            const w = Math.floor(game.width * 0.4);
            ctx.globalAlpha = 0.75;
            ctx.fillStyle = '#000000';
            ctx.fillRect(margin - uiScale, boxTop, w, inputH);
            ctx.globalAlpha = 1;
            ctx.strokeStyle = '#44ddff';
            ctx.lineWidth = 1;
            ctx.strokeRect(margin - uiScale + 0.5, boxTop + 0.5, w - 1, inputH - 1);
            ctx.fillStyle = '#ffffff';
            let text = this.inputBuffer;
            if (this.showCursor) text += '_';
            ctx.fillText(text, margin + uiScale, boxTop + inputH - Math.floor(uiScale * 3.5));
        }

        ctx.restore();
    }
}
