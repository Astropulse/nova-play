// Touch controls — virtual dual-stick gamepad + synthesized mouse pointer.
//
// Owned by InputManager (input.touch). Two modes, decided per-touch at
// touchstart by whether PlayingState asserted "gameplay" this frame via
// setGameplayContext():
//
//   GAMEPLAY  — the screen halves are floating sticks. A touch anchors a stick
//               where it lands; dragging deflects it. The values are written
//               into the InputManager's PRIMARY GAMEPAD MIRROR (leftStickX,
//               rightTrigger, _gpButtons, …) right after _pollGamepad() zeroes
//               it, so the existing pad consumption paths in player.js and
//               playingState.js drive the ship untouched:
//                 fire   = RT held      (tap right half toggles it)
//                 shield = LB held      (tap left half toggles it)
//                 boost  = LT           (button near the left stick; becomes a
//                                        press-on/press-off toggle when the
//                                        pilot has the Boost Drive)
//                 pause  = START pulse  (button left of the right stick)
//                 interact = X pulse    (contextual button, top center)
//
//   POINTER   — everywhere else (menus, dialogs, inventory, death screen) a
//               touch drives mouseScreenX/Y + a synthesized left button. The
//               press is applied one update AFTER the position so the polled
//               hover-then-click UIs (hover computed from last frame's cursor)
//               hit the right widget. Long-press = right-click (consumable
//               use), a second finger dragging = wheel scroll.
//
// All writes happen in update(), called by InputManager.update() after the
// hardware pad poll and before the just-pressed diffs — the same window the
// gamepad virtual cursor uses — so synthesized edges register the same frame.
import { GP } from './inputManager.js';

const TAP_MAX_SECONDS = 0.3;   // press shorter than this …
const LONG_PRESS_SECONDS = 0.5;
const CONTEXT_STALE_FRAMES = 3; // gameplay assert older than this = modal/menu

export class TouchControls {
    constructor(input) {
        this.im = input;
        this.canvas = input.canvas;
        this.enabled = false;      // set true by Game on coarse-pointer devices

        // Per-role touch tracking (touch identifier → role record)
        this.lstick = null;        // { id, ax, ay, vx, vy, t, maxDist, engaged }
        this.rstick = null;
        this.shieldFinger = null;  // touch id holding the right-side shield button

        // One-update LT pulse queued by a left-zone tap (boost impulse /
        // teleport on ships without the Boost Drive toggle)
        this._pulseLT = false;
        this._ptr = null;          // pointer-mode touch (see _updatePointer)
        this._scroll = null;       // second-finger scroll { id, lastY }

        // Latched toggles (survive across touches / pause)
        this.fireOn = false;
        this.shieldOn = false;
        this.boostOn = false;      // only meaningful in boostToggle mode

        // Single-update button pulses queued by touchstart handlers
        this._pulseStart = false;
        this._pulseX = false;
        this._pulseB = false;
        this._btn2PulseFrames = 0;

        // Pressed-visual timers for the tap buttons
        this._pauseFlash = 0;
        this._interactFlash = 0;
        this._healFlash = 0;

        // Queued heal-button tap, consumed by PlayingState (uses the first
        // Small Battery in cargo, scanning left-to-right, top-to-bottom).
        this._healTap = false;

        // Long-press right-click staging: the initial press picked the item UP,
        // so the drag is released first (item returns to its slot that frame)
        // and the right-click fires one update later, when the slot is full again.
        this._btn2DelayFrames = 0;

        // Set for a couple of updates when a pointer touch ends as a clean tap
        // (short, no movement). UIs consume it for tap shortcuts (e.g. tap a
        // shop item = buy it straight into the ship).
        this._pointerTapFrames = 0;

        // Gameplay context, re-asserted every PlayingState.update
        this._ctx = { active: false, modal: false, closeButton: false,
                      boostToggle: false, shieldBroken: false,
                      interact: false, interactLabel: 'OPEN' };
        this._ctxFrame = -1000;
        this._frame = 0;

        this._touchStart = (e) => this._onStart(e);
        this._touchMove = (e) => this._onMove(e);
        this._touchEnd = (e) => this._onEnd(e);
    }

    attach() {
        // Non-passive so preventDefault() suppresses scrolling/zoom AND the
        // browser's synthesized compatibility mouse events (which would
        // double-drive the input state).
        this.canvas.addEventListener('touchstart', this._touchStart, { passive: false });
        this.canvas.addEventListener('touchmove', this._touchMove, { passive: false });
        this.canvas.addEventListener('touchend', this._touchEnd, { passive: false });
        this.canvas.addEventListener('touchcancel', this._touchEnd, { passive: false });
    }

    detach() {
        this.canvas.removeEventListener('touchstart', this._touchStart);
        this.canvas.removeEventListener('touchmove', this._touchMove);
        this.canvas.removeEventListener('touchend', this._touchEnd);
        this.canvas.removeEventListener('touchcancel', this._touchEnd);
    }

    // PlayingState calls this every update frame while it is the active state.
    // Staleness (no assert for a few frames) means a menu/dialog owns the
    // screen and every touch becomes a pointer.
    setGameplayContext(ctx) {
        this._ctx = ctx;
        this._ctxFrame = this._frame;
    }

    get gameplayActive() {
        return this.enabled && this._ctx.active
            && (this._frame - this._ctxFrame) <= CONTEXT_STALE_FRAMES;
    }

    // True once per heal-button tap. PlayingState consumes it and uses the
    // first Small Battery in cargo.
    consumeHealTap() {
        if (this._healTap) {
            this._healTap = false;
            return true;
        }
        return false;
    }

    // True once when the last pointer touch ended as a clean tap (short, no
    // movement). Consumed by UI tap shortcuts (shop/cache: tap item = take it).
    consumePointerTap() {
        if (this._pointerTapFrames > 0) {
            this._pointerTapFrames = 0;
            return true;
        }
        return false;
    }

    // A modal run UI (pause/shop/cache/dialog) is open and closable — show the
    // tappable ✕ that pulses GP.B, which every modal accepts as "close".
    get modalCloseVisible() {
        return this.enabled && this._ctx.closeButton
            && (this._frame - this._ctxFrame) <= CONTEXT_STALE_FRAMES;
    }

    _closeRect() {
        const w = this.canvas.width, h = this.canvas.height;
        const u = Math.min(w, h);
        const half = u * 0.055;
        return { x: w - u * 0.075, y: u * 0.075, half };
    }

    // ── Geometry (backing-store pixels, recomputed on demand) ──────────────
    _layout() {
        const w = this.canvas.width, h = this.canvas.height;
        const u = Math.min(w, h);
        return {
            w, h, u,
            stickMax: u * 0.13,          // full deflection radius
            tapDist: u * 0.035,          // movement below this can still be a tap
            // Shield TOGGLE button near the left stick (boost lives on the
            // left-zone tap; the right-side hold-to-shield is OR'd with this)
            shieldToggle: { x: w * 0.27, y: h * 0.60, r: u * 0.085 },
            pause: { x: w * 0.73, y: h * 0.60, r: u * 0.065 },
            // Heal (use first Small Battery) — below/left of pause, clear of
            // the right stick's resting arc. Shown only while a battery is held.
            heal: { x: w * 0.64, y: h * 0.74, r: u * 0.065 },
            // Hold-to-shield — above the right stick's resting arc (the left
            // zone's tap-toggle stays; the two are OR'd)
            shield: { x: w * 0.87, y: h * 0.48, r: u * 0.075 },
            // Contextual interact button — right side, above the pause button
            interact: { x: w * 0.76, y: h * 0.32, hw: u * 0.22, hh: u * 0.06 },
            // Resting-position hints for the floating sticks
            lHome: { x: w * 0.14, y: h * 0.74 },
            rHome: { x: w * 0.86, y: h * 0.74 },
        };
    }

    _toCanvas(t) {
        const rect = this.canvas.getBoundingClientRect();
        const sx = rect.width ? this.canvas.width / rect.width : 1;
        const sy = rect.height ? this.canvas.height / rect.height : 1;
        return { x: (t.clientX - rect.left) * sx, y: (t.clientY - rect.top) * sy };
    }

    // ── DOM handlers ────────────────────────────────────────────────────────
    _onStart(e) {
        if (!this.enabled) return;
        e.preventDefault();
        this.im.lastInputDevice = 'touch';
        const L = this._layout();
        for (const t of e.changedTouches) {
            const p = this._toCanvas(t);
            if (this.gameplayActive) {
                const inCircle = (c) => {
                    const dx = p.x - c.x, dy = p.y - c.y;
                    return dx * dx + dy * dy <= c.r * c.r;
                };
                if (this._ctx.interact
                    && Math.abs(p.x - L.interact.x) <= L.interact.hw
                    && Math.abs(p.y - L.interact.y) <= L.interact.hh) {
                    this._pulseX = true;
                    this._interactFlash = 0.2;
                } else if (inCircle(L.pause)) {
                    this._pulseStart = true;
                    this._pauseFlash = 0.2;
                } else if ((this._ctx.healCount || 0) > 0 && inCircle(L.heal)) {
                    this._healTap = true;
                    this._healFlash = 0.2;
                } else if (inCircle(L.shield) && this.shieldFinger === null) {
                    this.shieldFinger = t.identifier;
                } else if (inCircle(L.shieldToggle)) {
                    this.shieldOn = !this.shieldOn;
                } else if (p.x < L.w * 0.5) {
                    if (!this.lstick) this.lstick = { id: t.identifier, ax: p.x, ay: p.y, vx: 0, vy: 0, t: 0, maxDist: 0, engaged: false };
                } else {
                    if (!this.rstick) this.rstick = { id: t.identifier, ax: p.x, ay: p.y, vx: 0, vy: 0, t: 0, maxDist: 0, engaged: false };
                }
            } else if (this.modalCloseVisible
                && Math.abs(p.x - this._closeRect().x) <= this._closeRect().half
                && Math.abs(p.y - this._closeRect().y) <= this._closeRect().half) {
                this._pulseB = true;
            } else if (!this._ptr) {
                // Pointer mode: move the cursor now, press next update so the
                // hover pass sees the new position first.
                this.im.mouseScreenX = p.x;
                this.im.mouseScreenY = p.y;
                this._ptr = { id: t.identifier, phase: 'preDown', downFrames: 0,
                              longT: 0, moved: false, sx: p.x, sy: p.y, up: false };
            } else if (!this._scroll) {
                // Second finger while pointer held = wheel scroll
                this._scroll = { id: t.identifier, lastY: p.y };
            }
        }
    }

    _onMove(e) {
        if (!this.enabled) return;
        e.preventDefault();
        const L = this._layout();
        for (const t of e.changedTouches) {
            const p = this._toCanvas(t);
            const stick = (this.lstick && this.lstick.id === t.identifier) ? this.lstick
                        : (this.rstick && this.rstick.id === t.identifier) ? this.rstick : null;
            if (stick) {
                const dx = p.x - stick.ax, dy = p.y - stick.ay;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist > stick.maxDist) stick.maxDist = dist;
                if (stick.maxDist > L.tapDist) stick.engaged = true;
                if (stick.engaged && dist > 0) {
                    // Deflection past the tap threshold maps 0..1 out to stickMax
                    const mag = Math.min(1, (dist - L.tapDist) / Math.max(1, L.stickMax - L.tapDist));
                    stick.vx = (dx / dist) * mag;
                    stick.vy = (dy / dist) * mag;
                }
            } else if (this._ptr && this._ptr.id === t.identifier) {
                this.im.mouseScreenX = p.x;
                this.im.mouseScreenY = p.y;
                const mdx = p.x - this._ptr.sx, mdy = p.y - this._ptr.sy;
                if (mdx * mdx + mdy * mdy > L.tapDist * L.tapDist) this._ptr.moved = true;
            } else if (this._scroll && this._scroll.id === t.identifier) {
                // Finger up scrolls down, matching wheel semantics
                this.im._accWheelDelta += (this._scroll.lastY - p.y) * 2;
                this._scroll.lastY = p.y;
            }
        }
    }

    _onEnd(e) {
        if (!this.enabled) return;
        e.preventDefault();
        for (const t of e.changedTouches) {
            const id = t.identifier;
            if (this.lstick && this.lstick.id === id) {
                // Short stationary press = boost (Boost Drive: on/off toggle;
                // otherwise a one-update LT pulse — impulse or teleport)
                if (!this.lstick.engaged && this.lstick.t < TAP_MAX_SECONDS) {
                    if (this._ctx.boostToggle) this.boostOn = !this.boostOn;
                    else this._pulseLT = true;
                }
                this.lstick = null;
            } else if (this.rstick && this.rstick.id === id) {
                if (!this.rstick.engaged && this.rstick.t < TAP_MAX_SECONDS) this.fireOn = !this.fireOn;
                this.rstick = null;
            } else if (this.shieldFinger === id) {
                this.shieldFinger = null;
            } else if (this._ptr && this._ptr.id === id) {
                this._ptr.up = true; // released in update() after ≥1 held frame
            } else if (this._scroll && this._scroll.id === id) {
                this._scroll = null;
            }
        }
    }

    // ── Per-frame drive, called from InputManager.update() after the pad poll
    //    (which zeroes the primary mirror when no pad is connected) and before
    //    the just-pressed diffs. ─────────────────────────────────────────────
    update(dt) {
        this._frame++;
        if (!this.enabled) return;
        const im = this.im;

        if (this._pointerTapFrames > 0) this._pointerTapFrames--;
        if (this._pauseFlash > 0) this._pauseFlash -= dt;
        if (this._interactFlash > 0) this._interactFlash -= dt;
        if (this._healFlash > 0) this._healFlash -= dt;

        // Delayed right-click from a long-press: fires one update after the
        // held item was dropped back into its slot, so the use-consumable
        // handler finds it there (a right-click while dragging hits nothing).
        if (this._btn2DelayFrames > 0 && --this._btn2DelayFrames === 0) {
            im.mouseButtons.add(2);
            this._btn2PulseFrames = 2;
        }

        if (this.gameplayActive) {
            if (this.lstick) {
                this.lstick.t += dt;
                im.leftStickX = this.lstick.vx;
                im.leftStickY = this.lstick.vy;
            }
            if (this.rstick) {
                this.rstick.t += dt;
                im.rightStickX = this.rstick.vx;
                im.rightStickY = this.rstick.vy;
            }
            if (this.fireOn) {
                im.rightTrigger = 1;
                im._gpButtons[GP.RT] = true;
            }
            if (this.shieldOn || this.shieldFinger !== null) im._gpButtons[GP.LB] = true;
            if ((this._ctx.boostToggle && this.boostOn) || this._pulseLT) {
                im.leftTrigger = 1;
                im._gpButtons[GP.LT] = true;
                this._pulseLT = false;
            }
        } else {
            // A menu/dialog took over mid-hold: drop transient stick state so
            // the ship doesn't keep flying under the overlay. Toggles persist.
            this.lstick = null;
            this.rstick = null;
            this.shieldFinger = null;
            this._pulseLT = false;
        }

        // Tap-button pulses (single update; the prev-frame snapshot in
        // InputManager.update turns them into just-pressed edges)
        if (this._pulseStart) { im._gpButtons[GP.START] = true; this._pulseStart = false; }
        if (this._pulseX) { im._gpButtons[GP.X] = true; this._pulseX = false; }
        if (this._pulseB) { im._gpButtons[GP.B] = true; this._pulseB = false; }

        // Pointer state machine
        const ptr = this._ptr;
        if (ptr) {
            if (ptr.phase === 'preDown') {
                // Wait one full frame with only the position moved: dialogs
                // (encounter/level-up) compute hover during DRAW, so a press in
                // the very next update would land on last frame's stale hover.
                ptr.phase = 'arm';
            } else if (ptr.phase === 'arm') {
                ptr.phase = 'down';
                im.mouseButtons.add(0);
            } else if (ptr.phase === 'down') {
                ptr.downFrames++;
                ptr.longT += dt;
                if (!ptr.up && !ptr.moved && ptr.longT >= LONG_PRESS_SECONDS) {
                    // Long-press = right-click (use the item under the finger).
                    // Release the synthesized left button now — the press had
                    // picked the item up, and releasing drops it back into its
                    // slot this frame; the right-click is staged for the NEXT
                    // update so the use-handler sees the item back in place.
                    im.mouseButtons.delete(0);
                    this._btn2DelayFrames = 1;
                    ptr.phase = 'long';
                }
            }
            if (ptr.up && ptr.phase === 'down' && ptr.downFrames >= 1) {
                im.mouseButtons.delete(0);
                if (!ptr.moved && ptr.longT < TAP_MAX_SECONDS) this._pointerTapFrames = 2;
                this._ptr = null;
                this._scroll = null;
            } else if (ptr.up && ptr.phase === 'long') {
                this._ptr = null;
                this._scroll = null;
            }
            // (phases preDown/arm with up=true fall through: the press still
            // gets applied for >=1 held frame before the release above runs)
        }
        if (this._btn2PulseFrames > 0) {
            if (--this._btn2PulseFrames === 0) im.mouseButtons.delete(2);
        }
    }

    // ── Overlay rendering (flat pixel-art: plain fills + square-ish strokes,
    //    no gradients). Drawn onto the game canvas after the state draw. ─────
    draw(ctx, game) {
        if (!this.enabled) return;

        // Modal ✕ close button (pulses GP.B — accepted by every modal UI)
        if (this.modalCloseVisible) {
            const c = this._closeRect();
            const hs = game.hudScale;
            ctx.save();
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = '#000000';
            ctx.fillRect(Math.round(c.x - c.half), Math.round(c.y - c.half), Math.round(c.half * 2), Math.round(c.half * 2));
            ctx.strokeStyle = '#ccddee';
            ctx.lineWidth = Math.max(2, hs);
            ctx.strokeRect(Math.round(c.x - c.half), Math.round(c.y - c.half), Math.round(c.half * 2), Math.round(c.half * 2));
            ctx.fillStyle = '#ccddee';
            ctx.font = `${7 * hs}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('X', c.x, c.y + hs);
            ctx.restore();
        }

        if (!this.gameplayActive) return;
        const L = this._layout();
        const hs = game.hudScale;
        const px = Math.max(2, hs); // stroke weight

        ctx.save();
        ctx.lineWidth = px;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        // Floating sticks: faint home rings when idle, anchor ring + thumb dot
        // while held. Left = boost color while toggled, right = fire color.
        const drawStick = (stick, home, onColor, isOn) => {
            const color = isOn ? onColor : '#ffffff';
            if (stick && stick.engaged) {
                ctx.globalAlpha = 0.22;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.arc(stick.ax, stick.ay, L.stickMax, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = 0.5;
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(stick.ax + stick.vx * L.stickMax, stick.ay + stick.vy * L.stickMax, L.stickMax * 0.32, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.globalAlpha = isOn ? 0.35 : 0.14;
                ctx.strokeStyle = color;
                ctx.beginPath();
                ctx.arc(home.x, home.y, L.stickMax * 0.55, 0, Math.PI * 2);
                ctx.stroke();
            }
        };
        const boostActive = this._ctx.boostToggle && this.boostOn;
        drawStick(this.lstick, L.lHome, '#ffff44', boostActive);
        drawStick(this.rstick, L.rHome, '#ff6644', this.fireOn);

        // Toggle status labels under each home position
        ctx.font = `${5 * hs}px Astro4x`;
        if (boostActive) {
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = '#ffff44';
            ctx.fillText('BOOST', L.lHome.x, L.lHome.y + L.stickMax * 0.55 + 8 * hs);
        }
        if (this.fireOn) {
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = '#ff6644';
            ctx.fillText('FIRE', L.rHome.x, L.rHome.y + L.stickMax * 0.55 + 8 * hs);
        }

        // Shield TOGGLE button (left) — filled while the toggle is on
        {
            const on = this.shieldOn;
            const broken = this._ctx.shieldBroken;
            ctx.globalAlpha = broken ? 0.15 : (on ? 0.6 : 0.28);
            ctx.strokeStyle = '#66ccff';
            ctx.beginPath();
            ctx.arc(L.shieldToggle.x, L.shieldToggle.y, L.shieldToggle.r, 0, Math.PI * 2);
            ctx.stroke();
            if (on && !broken) {
                ctx.globalAlpha = 0.18;
                ctx.fillStyle = '#66ccff';
                ctx.fill();
            }
            ctx.globalAlpha = broken ? 0.25 : (on ? 0.9 : 0.5);
            ctx.fillStyle = '#66ccff';
            ctx.font = `${5 * hs}px Astro4x`;
            ctx.fillText('SHIELD', L.shieldToggle.x, L.shieldToggle.y);
        }

        // Hold-to-shield button — filled while held or while the toggle is on
        {
            const held = this.shieldFinger !== null;
            const on = held || this.shieldOn;
            const broken = this._ctx.shieldBroken;
            ctx.globalAlpha = broken ? 0.15 : (on ? 0.6 : 0.28);
            ctx.strokeStyle = '#66ccff';
            ctx.beginPath();
            ctx.arc(L.shield.x, L.shield.y, L.shield.r, 0, Math.PI * 2);
            ctx.stroke();
            if (on && !broken) {
                ctx.globalAlpha = 0.18;
                ctx.fillStyle = '#66ccff';
                ctx.fill();
            }
            ctx.globalAlpha = broken ? 0.25 : (on ? 0.9 : 0.5);
            ctx.fillStyle = '#66ccff';
            ctx.font = `${5 * hs}px Astro4x`;
            ctx.fillText('SHIELD', L.shield.x, L.shield.y);
        }

        // Heal button — green cross + battery count; only while batteries held
        if ((this._ctx.healCount || 0) > 0) {
            const hk = this._healFlash > 0;
            ctx.globalAlpha = hk ? 0.7 : 0.3;
            ctx.strokeStyle = '#44ff44';
            ctx.beginPath();
            ctx.arc(L.heal.x, L.heal.y, L.heal.r, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = hk ? 0.95 : 0.55;
            ctx.fillStyle = '#44ff44';
            const cw2 = Math.max(2, Math.round(L.heal.r * 0.22));
            const cl2 = Math.round(L.heal.r * 0.9);
            ctx.fillRect(Math.round(L.heal.x - cw2 / 2), Math.round(L.heal.y - cl2 / 2), cw2, cl2);
            ctx.fillRect(Math.round(L.heal.x - cl2 / 2), Math.round(L.heal.y - cw2 / 2), cl2, cw2);
            ctx.font = `${5 * hs}px Astro4x`;
            ctx.fillText(`x${this._ctx.healCount}`, L.heal.x, L.heal.y + L.heal.r + 6 * hs);
        }

        // Pause button — two flat bars
        const pk = this._pauseFlash > 0;
        ctx.globalAlpha = pk ? 0.7 : 0.25;
        ctx.strokeStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(L.pause.x, L.pause.y, L.pause.r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = pk ? 0.9 : 0.45;
        ctx.fillStyle = '#ffffff';
        const bw = Math.max(2, Math.round(L.pause.r * 0.18));
        const bh = Math.round(L.pause.r * 0.7);
        ctx.fillRect(Math.round(L.pause.x - bw * 1.6), Math.round(L.pause.y - bh / 2), bw, bh);
        ctx.fillRect(Math.round(L.pause.x + bw * 0.6), Math.round(L.pause.y - bh / 2), bw, bh);

        // Contextual interact button
        if (this._ctx.interact) {
            const it = L.interact;
            const hot = this._interactFlash > 0;
            ctx.globalAlpha = hot ? 0.9 : 0.75;
            ctx.fillStyle = '#000000';
            ctx.fillRect(Math.round(it.x - it.hw), Math.round(it.y - it.hh), Math.round(it.hw * 2), Math.round(it.hh * 2));
            ctx.strokeStyle = '#ffff44';
            ctx.strokeRect(Math.round(it.x - it.hw), Math.round(it.y - it.hh), Math.round(it.hw * 2), Math.round(it.hh * 2));
            ctx.fillStyle = '#ffff44';
            ctx.font = `${6 * hs}px Astro4x`;
            ctx.fillText(this._ctx.interactLabel || 'OPEN', it.x, it.y + hs);
        }

        ctx.restore();
    }
}
