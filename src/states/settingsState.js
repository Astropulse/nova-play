import { MenuState } from './menuState.js';
import { GP } from '../engine/inputManager.js';
import { SETTINGS, SETTINGS_OPTIONS, setSetting, resetSettings } from '../engine/settings.js';
import {
    KEY_ACTIONS, MOUSE_ACTIONS, TOUCH_ANCHORS,
    KEYS, MOUSE, touchAnchor,
    setKeyBinding, setMouseBinding, setTouchAnchor,
    resetKeyBindings, resetMouseBindings, resetTouchLayout,
    keyLabel, mouseLabel,
} from '../engine/controlBindings.js';

// Settings screen — the UI over engine/settings.js (persisted `nova_settings`)
// and engine/controlBindings.js (persisted `nova_controls`). Same chrome
// family as the achievements/upgrades screens: dark page, cyan header, home
// button bottom-left, gamepad spatial focus over live rects.
//
// Two tabs:
//   GENERAL  — startup audio defaults, distortion dials, performance levers.
//   CONTROLS — rebinding, per input method (device sub-tabs). Touch devices
//              get the interactive layout editor (a mock screen where every
//              touch control is dragged into place); desktops get keyboard
//              and mouse rebind lists (click a binding → press the new
//              key/button; conflicts swap; Escape cancels).
export class SettingsState {
    // `returnState`, when provided, is restored on home/Escape instead of a
    // fresh MenuState — used by the pause screen so the run isn't discarded.
    constructor(game, returnState = null) {
        this.game = game;
        this.returnState = returnState;

        this.tab = 'general';
        // Device sub-tabs are contextual: touch-first devices edit the touch
        // layout; desktops rebind keyboard/mouse. Defaults to the device in use.
        this.deviceTabs = game.touchMode ? ['touch'] : ['keyboard', 'mouse'];
        this.device = game.touchMode ? 'touch'
            : (game.input.lastInputDevice === 'mouse' ? 'mouse' : 'keyboard');

        const mkBtn = () => ({ x: 0, y: 0, w: 0, h: 0, hovered: false });

        // ── GENERAL rows (sliders reuse Game.drawVolumeRow; sounds above
        // music, matching the title/pause volume-row order) ────────────────
        this.generalRows = [
            { type: 'section', label: 'AUDIO DEFAULTS' },
            {
                type: 'slider', key: 'sfxVolume', label: 'SOUND VOLUME',
                hint: 'Volume the game starts with.',
                dec: mkBtn(), inc: mkBtn(),
                apply: (g, v) => g.sounds.setSfxVolume(v),
            },
            {
                type: 'slider', key: 'musicVolume', label: 'MUSIC VOLUME',
                hint: 'Volume the game starts with.',
                dec: mkBtn(), inc: mkBtn(),
                apply: (g, v) => g.sounds.setMusicVolume(v),
            },
            {
                type: 'slider', key: 'audioDistortion', label: 'AUDIO DISTORTION',
                hint: 'Kill-streak and dread audio corruption.',
                dec: mkBtn(), inc: mkBtn(),
            },
            { type: 'section', label: 'VISUALS' },
            {
                type: 'slider', key: 'visualDistortion', label: 'SCREEN DISTORTION',
                hint: 'CRT warp, shield ripples, boost and teleport bending.',
                dec: mkBtn(), inc: mkBtn(),
            },
            {
                // Tri-state cycle button: ON / AUTO / OFF (see settings.js).
                type: 'cycle', key: 'screenFx', label: 'SCREEN EFFECTS',
                hint: 'ON always runs them. AUTO lets weak hardware switch them off.',
                btn: mkBtn(),
            },
            { type: 'section', label: 'PERFORMANCE' },
            {
                type: 'toggle', key: 'voronoiFractures', label: 'VORONOI FRACTURES',
                hint: 'Chip damage and shattered-hull debris.',
                btn: mkBtn(),
            },
            {
                type: 'toggle', key: 'smoothScaling', label: 'SMOOTH SCALING',
                hint: 'Soft sprite filtering. OFF is crisper and cheaper.',
                btn: mkBtn(),
            },
            {
                type: 'toggle', key: 'reducedParticles', label: 'REDUCED PARTICLES',
                hint: 'Fewer sparks and debris, thinner starfield.',
                btn: mkBtn(),
            },
            {
                type: 'slider', key: 'juiceDensity', label: 'JUICE DENSITY',
                hint: 'How many sparks, smoke puffs and bursts the effects spawn.',
                dec: mkBtn(), inc: mkBtn(),
            },
        ];

        // ── CONTROLS rows ───────────────────────────────────────────────────
        this.keyRows = KEY_ACTIONS.map(a => ({ action: a, btn: mkBtn() }));
        this.mouseRows = MOUSE_ACTIONS.map(a => ({ action: a, btn: mkBtn() }));

        // Chrome buttons
        this.tabBtns = { general: mkBtn(), controls: mkBtn() };
        this.deviceBtns = { keyboard: mkBtn(), mouse: mkBtn(), touch: mkBtn() };
        this.homeBtn = mkBtn();
        this.resetBtn = mkBtn(); // contextual: settings defaults / keys / mouse / layout

        // Rebind capture: { type: 'key'|'mouse', action } while waiting for
        // the next key/button press. _captureDelay ignores the frames right
        // after the initiating click so it can't bind/cancel itself.
        this._capture = null;
        this._captureDelay = 0;

        // Touch layout editor drag state
        this._dragAnchor = null;   // anchor id being dragged
        this._dragPos = null;      // live normalized position while dragging
        this._editorRect = { x: 0, y: 0, w: 0, h: 0 };

        // Gamepad focus (spatial nav over live rects)
        this.focusId = 'tab:general';
        this._stickLatched = false;
    }

    enter() {
        this.game.sounds.startMusic();
    }

    exit() {}

    // ── Layout ──────────────────────────────────────────────────────────────
    // Deterministic from screen size + tab, so update() and draw() call it.
    _computeLayout() {
        const game = this.game;
        const uiScale = game.uiScale;
        const cw = game.width;
        const ch = game.height;
        const margin = Math.floor(uiScale * 12);

        const headerH = Math.floor(uiScale * 32);
        const footerH = Math.floor(uiScale * 24);

        this._panelW = Math.min(Math.floor(cw * 0.7), Math.floor(uiScale * 280));
        this._panelX = Math.floor(cw / 2 - this._panelW / 2);

        // Tab bar (GENERAL | CONTROLS), centered under the header.
        const tabW = Math.floor(uiScale * 70);
        const tabH = Math.floor(uiScale * 14);
        const tabGap = Math.floor(uiScale * 4);
        const tabY = headerH + Math.floor(uiScale * 12);
        const tabsLeft = Math.floor(cw / 2 - tabW - tabGap / 2);
        this.tabBtns.general.x = tabsLeft;
        this.tabBtns.general.y = tabY;
        this.tabBtns.general.w = tabW;
        this.tabBtns.general.h = tabH;
        this.tabBtns.controls.x = tabsLeft + tabW + tabGap;
        this.tabBtns.controls.y = tabY;
        this.tabBtns.controls.w = tabW;
        this.tabBtns.controls.h = tabH;

        const contentTop = tabY + tabH + Math.floor(uiScale * 10);
        const contentBottom = ch - margin - footerH - Math.floor(uiScale * 6);
        this._contentTop = contentTop;
        this._contentBottom = contentBottom;

        const panelRight = this._panelX + this._panelW;

        if (this.tab === 'general') {
            const sectionH = Math.floor(uiScale * 20);
            const rowH = Math.floor(uiScale * 26);
            this._sectionH = sectionH;
            this._rowH = rowH;

            let totalH = 0;
            for (const row of this.generalRows) totalH += row.type === 'section' ? sectionH : rowH;
            let y = Math.max(contentTop,
                contentTop + Math.floor((contentBottom - contentTop - totalH) / 2));

            const volBtnSize = game.spriteSize('left_arrow_off', uiScale);
            const barW = Math.floor(uiScale * 60);
            const volGap = Math.floor(uiScale * 6);

            for (const row of this.generalRows) {
                row.y = y;
                if (row.type === 'slider') {
                    const midY = y + Math.floor(rowH / 2);
                    row.inc.x = panelRight - volBtnSize.w;
                    row.inc.y = Math.floor(midY - volBtnSize.h / 2);
                    row.inc.w = volBtnSize.w;
                    row.inc.h = volBtnSize.h;
                    row.dec.x = row.inc.x - barW - volBtnSize.w - volGap * 2;
                    row.dec.y = row.inc.y;
                    row.dec.w = volBtnSize.w;
                    row.dec.h = volBtnSize.h;
                } else if (row.type === 'toggle' || row.type === 'cycle') {
                    const btnW = Math.floor(uiScale * 36);
                    const btnH = Math.floor(uiScale * 13);
                    row.btn.x = panelRight - btnW;
                    row.btn.y = y + Math.floor((rowH - btnH) / 2);
                    row.btn.w = btnW;
                    row.btn.h = btnH;
                }
                y += row.type === 'section' ? sectionH : rowH;
            }
        } else {
            // Device sub-tab row, centered.
            const devW = Math.floor(uiScale * 56);
            const devH = Math.floor(uiScale * 12);
            const devGap = Math.floor(uiScale * 4);
            const totalDevW = this.deviceTabs.length * devW + (this.deviceTabs.length - 1) * devGap;
            let dx = Math.floor(cw / 2 - totalDevW / 2);
            for (const id of ['keyboard', 'mouse', 'touch']) {
                const b = this.deviceBtns[id];
                if (!this.deviceTabs.includes(id)) { b.w = b.h = 0; continue; }
                b.x = dx; b.y = contentTop; b.w = devW; b.h = devH;
                dx += devW + devGap;
            }
            const listTop = contentTop + devH + Math.floor(uiScale * 10);
            this._listTop = listTop;

            if (this.device === 'keyboard' || this.device === 'mouse') {
                const rows = this.device === 'keyboard' ? this.keyRows : this.mouseRows;
                const rowH = Math.floor(uiScale * 17);
                this._bindRowH = rowH;
                const bindW = Math.floor(uiScale * 56);
                const bindH = Math.floor(uiScale * 12);
                let y = Math.max(listTop, listTop
                    + Math.floor((contentBottom - listTop - rows.length * rowH) / 2));
                for (const row of rows) {
                    row.y = y;
                    row.btn.x = panelRight - bindW;
                    row.btn.y = y + Math.floor((rowH - bindH) / 2);
                    row.btn.w = bindW;
                    row.btn.h = bindH;
                    y += rowH;
                }
            } else {
                // Touch layout editor: the biggest canvas-aspect rect that fits
                // the remaining space (a mock of the in-game screen).
                const availW = Math.floor(cw * 0.86);
                const availH = contentBottom - listTop - Math.floor(uiScale * 12);
                const aspect = cw / ch;
                let edW = availW;
                let edH = Math.floor(edW / aspect);
                if (edH > availH) { edH = availH; edW = Math.floor(edH * aspect); }
                this._editorRect = {
                    x: Math.floor(cw / 2 - edW / 2),
                    y: listTop,
                    w: edW, h: edH,
                };
            }
        }

        // Footer: home (left), contextual reset (right)
        const homeSize = game.spriteSize('home_button_off', uiScale);
        this.homeBtn.x = margin;
        this.homeBtn.y = ch - margin - homeSize.h;
        this.homeBtn.w = homeSize.w;
        this.homeBtn.h = homeSize.h;

        const resetW = Math.floor(uiScale * 64);
        this.resetBtn.x = cw - margin - resetW;
        this.resetBtn.y = ch - margin - homeSize.h;
        this.resetBtn.w = resetW;
        this.resetBtn.h = homeSize.h;
    }

    // The contextual reset button's label + action for the active tab/device.
    _resetContext() {
        if (this.tab === 'general') {
            return {
                label: 'RESET DEFAULTS',
                run: () => {
                    resetSettings();
                    this.game.sounds.setMusicVolume(SETTINGS.musicVolume);
                    this.game.sounds.setSfxVolume(SETTINGS.sfxVolume);
                },
            };
        }
        if (this.device === 'keyboard') return { label: 'RESET KEYS', run: resetKeyBindings };
        if (this.device === 'mouse') return { label: 'RESET MOUSE', run: resetMouseBindings };
        return { label: 'RESET LAYOUT', run: resetTouchLayout };
    }

    // Every focusable control with its live rect + activation, for the active
    // tab. The touch editor is pointer-driven and stays out of gamepad focus.
    _focusables() {
        const out = [];
        out.push({ id: 'tab:general', rect: this.tabBtns.general, activate: () => this._setTab('general') });
        out.push({ id: 'tab:controls', rect: this.tabBtns.controls, activate: () => this._setTab('controls') });
        if (this.tab === 'general') {
            for (let i = 0; i < this.generalRows.length; i++) {
                const row = this.generalRows[i];
                if (row.type === 'slider') {
                    out.push({ id: `gen:${i}:dec`, rect: row.dec, activate: () => this._adjust(row, -1) });
                    out.push({ id: `gen:${i}:inc`, rect: row.inc, activate: () => this._adjust(row, 1) });
                } else if (row.type === 'toggle' || row.type === 'cycle') {
                    out.push({ id: `gen:${i}:btn`, rect: row.btn, activate: () => this._toggle(row) });
                }
            }
        } else {
            for (const id of this.deviceTabs) {
                out.push({ id: `dev:${id}`, rect: this.deviceBtns[id], activate: () => this._setDevice(id) });
            }
            if (this.device === 'keyboard') {
                for (let i = 0; i < this.keyRows.length; i++) {
                    const row = this.keyRows[i];
                    out.push({ id: `key:${i}`, rect: row.btn, activate: () => this._startCapture('key', row.action.id) });
                }
            } else if (this.device === 'mouse') {
                for (let i = 0; i < this.mouseRows.length; i++) {
                    const row = this.mouseRows[i];
                    out.push({ id: `ms:${i}`, rect: row.btn, activate: () => this._startCapture('mouse', row.action.id) });
                }
            }
        }
        out.push({ id: 'home', rect: this.homeBtn, activate: () => this._goBack() });
        out.push({ id: 'reset', rect: this.resetBtn, activate: () => this._runReset() });
        return out;
    }

    // ── Actions ─────────────────────────────────────────────────────────────
    _setTab(tab) {
        if (this.tab === tab) return;
        this.tab = tab;
        this._capture = null;
        this._dragAnchor = null;
        this.game.sounds.play('click', 0.6);
    }

    _setDevice(id) {
        if (this.device === id) return;
        this.device = id;
        this._capture = null;
        this._dragAnchor = null;
        this.game.sounds.play('click', 0.6);
    }

    _adjust(row, dir) {
        const before = SETTINGS[row.key];
        const after = setSetting(row.key, before + dir * 0.1);
        if (row.apply) row.apply(this.game, after);
        this.game.sounds.play('click', after === before ? 0.3 : 0.5);
    }

    // Toggle rows flip; cycle rows step through their SETTINGS_OPTIONS list.
    _toggle(row) {
        if (row.type === 'cycle') {
            const opts = SETTINGS_OPTIONS[row.key] || [];
            const i = opts.indexOf(SETTINGS[row.key]);
            if (opts.length) setSetting(row.key, opts[(i + 1) % opts.length]);
        } else {
            setSetting(row.key, !SETTINGS[row.key]);
        }
        this.game.sounds.play('select', 0.6);
    }

    _startCapture(type, action) {
        this._capture = { type, action };
        this._captureDelay = 2;
        // Swallow the initiating click so it can't be captured as a mouse
        // binding (or cancel a key capture) on the very same press.
        this.game.input.consumeMouseButton(0);
        this.game.sounds.play('click', 0.6);
    }

    _runReset() {
        this._resetContext().run();
        this.game.sounds.play('select', 1.0);
    }

    _goBack() {
        this.game.sounds.play('click', 1.0);
        this.game.setState(this.returnState || new MenuState(this.game));
    }

    // Anchor position for the editor: the live drag preview while dragging,
    // otherwise the stored/default layout.
    _anchorPos(id) {
        return (this._dragAnchor === id && this._dragPos) ? this._dragPos : touchAnchor(id);
    }

    // Mock-space geometry for one touch control (mirrors touchControls._layout
    // proportions: x/y are w/h fractions, sizes are u = min(w,h) fractions).
    _editorControl(id) {
        const ed = this._editorRect;
        const u = Math.min(ed.w, ed.h);
        const p = this._anchorPos(id);
        const cx = ed.x + p.x * ed.w;
        const cy = ed.y + p.y * ed.h;
        switch (id) {
            case 'lHome': case 'rHome': return { cx, cy, r: u * 0.13 * 0.55 };
            case 'shieldToggle': return { cx, cy, r: u * 0.085 };
            case 'shield': return { cx, cy, r: u * 0.075 };
            case 'pause': return { cx, cy, r: u * 0.065 };
            case 'heal': return { cx, cy, r: u * 0.065 };
            case 'interact': return { cx, cy, hw: u * 0.22, hh: u * 0.06 };
        }
        return { cx, cy, r: u * 0.06 };
    }

    _hitAnchor(mouse) {
        // Reverse order so later-drawn controls win overlapping grabs.
        for (let i = TOUCH_ANCHORS.length - 1; i >= 0; i--) {
            const id = TOUCH_ANCHORS[i].id;
            const c = this._editorControl(id);
            if (c.hw !== undefined) {
                if (Math.abs(mouse.x - c.cx) <= c.hw && Math.abs(mouse.y - c.cy) <= c.hh) return id;
            } else {
                const dx = mouse.x - c.cx, dy = mouse.y - c.cy;
                const r = Math.max(c.r, 14); // finger-sized minimum grab area
                if (dx * dx + dy * dy <= r * r) return id;
            }
        }
        return null;
    }

    // ── Update ──────────────────────────────────────────────────────────────
    update(dt) {
        this._computeLayout();

        const input = this.game.input;
        const mouse = this.game.getMousePos();
        const gpActive = input.isGamepadActive();

        // ── Rebind capture owns ALL input while armed ────────────────────────
        if (this._capture) {
            if (this._captureDelay > 0) this._captureDelay--;
            // Escape / B always cancel.
            if (input.isKeyJustPressed('Escape') || input.isGamepadJustPressed(GP.B)) {
                this._capture = null;
                this.game.sounds.play('click', 0.4);
                return;
            }
            if (this._capture.type === 'key') {
                for (const code of input.keysJustPressed) {
                    const ok = setKeyBinding(this._capture.action, code);
                    this._capture = null;
                    input.consumeKey(code);
                    this.game.sounds.play(ok ? 'select' : 'click', 0.6);
                    return;
                }
                // A click ends a key capture without binding.
                if (this._captureDelay === 0 && input.isMouseJustPressed(0)) {
                    this._capture = null;
                    this.game.sounds.play('click', 0.4);
                }
            } else {
                if (this._captureDelay === 0) {
                    for (const b of [0, 1, 2]) {
                        if (input.isMouseJustPressed(b)) {
                            const ok = setMouseBinding(this._capture.action, b);
                            this._capture = null;
                            input.consumeMouseButton(b);
                            this.game.sounds.play(ok ? 'select' : 'click', 0.6);
                            return;
                        }
                    }
                }
            }
            return;
        }

        // ── Touch layout editor drag ─────────────────────────────────────────
        if (this.tab === 'controls' && this.device === 'touch') {
            const ed = this._editorRect;
            if (this._dragAnchor) {
                const nx = (mouse.x - ed.x) / Math.max(1, ed.w);
                const ny = (mouse.y - ed.y) / Math.max(1, ed.h);
                this._dragPos = {
                    x: Math.min(0.96, Math.max(0.04, nx)),
                    y: Math.min(0.96, Math.max(0.04, ny)),
                };
                if (!input.isMouseDown(0)) {
                    // Release → persist. setTouchAnchor re-clamps + saves.
                    setTouchAnchor(this._dragAnchor, this._dragPos.x, this._dragPos.y);
                    this._dragAnchor = null;
                    this._dragPos = null;
                    this.game.sounds.play('click', 0.6);
                }
                return; // the drag owns the pointer
            }
            if (input.isMouseJustPressed(0)) {
                const hit = this._hitAnchor(mouse);
                if (hit) {
                    // Don't consume the button — the drag tracks isMouseDown(0)
                    // and commits when it releases. Returning here keeps the
                    // press away from the generic click handler below.
                    this._dragAnchor = hit;
                    this._dragPos = { ...this._anchorPos(hit) };
                    this.game.sounds.play('click', 0.5);
                    return;
                }
            }
        }

        const focusables = this._focusables();

        // Mouse hover
        for (const f of focusables) {
            f.rect.hovered = this._isInside(mouse, f.rect);
        }

        // ── Gamepad spatial focus (achievements-screen pattern) ─────────────
        let curIdx = focusables.findIndex(f => f.id === this.focusId);
        if (curIdx < 0) curIdx = 0;

        const moveFocusSpatial = (dirX, dirY) => {
            if (focusables.length <= 1) return;
            const cur = focusables[curIdx].rect;
            const cx = cur.x + cur.w / 2;
            const cy = cur.y + cur.h / 2;
            let bestIdx = -1;
            let bestScore = Infinity;
            const CROSS_PENALTY = 2.0;
            for (let i = 0; i < focusables.length; i++) {
                if (i === curIdx) continue;
                const r = focusables[i].rect;
                if (r.w <= 0 || r.h <= 0) continue;
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
                if (score < bestScore) { bestScore = score; bestIdx = i; }
            }
            if (bestIdx >= 0) {
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

        // LB/RB flip main tabs — matches the bumper page-flip convention.
        if (input.isGamepadJustPressed(GP.LB)) this._setTab('general');
        if (input.isGamepadJustPressed(GP.RB)) this._setTab('controls');

        // Controller drives the same hover highlight the mouse uses.
        if (gpActive) {
            for (let i = 0; i < focusables.length; i++) {
                focusables[i].rect.hovered = i === curIdx;
            }
        }

        // A activates the focused control. Some activations change tab/state —
        // return so nothing runs against swapped-out layout.
        if (gpActive && input.isGamepadJustPressed(GP.A)) {
            focusables[curIdx].activate();
            return;
        }

        // Mouse clicks
        if (input.isMouseJustPressed(0)) {
            for (const f of focusables) {
                if (this._isInside(mouse, f.rect)) {
                    this.focusId = f.id;
                    f.activate();
                    return;
                }
            }
        }

        // Back to menu / pause (Escape / B / Back / Start)
        if (input.isKeyJustPressed('Escape')
            || input.isGamepadJustPressed(GP.B)
            || input.isGamepadJustPressed(GP.BACK)
            || input.isGamepadJustPressed(GP.START)) {
            this._goBack();
            return;
        }
    }

    // ── Draw ────────────────────────────────────────────────────────────────
    draw(ctx) {
        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const uiScale = game.uiScale;

        this._computeLayout();

        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';

        // Background + header (achievements-screen chrome)
        ctx.fillStyle = '#050a14';
        ctx.fillRect(0, 0, cw, ch);

        const headerH = Math.floor(uiScale * 32);
        ctx.fillStyle = '#0a1220';
        ctx.fillRect(0, 0, cw, headerH);

        ctx.fillStyle = '#44ddff';
        ctx.font = `${Math.floor(11 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('SETTINGS', cw / 2, Math.floor(headerH * 0.66));

        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillText('SAVED ON THIS DEVICE   ·   CHANGES APPLY INSTANTLY',
            cw / 2, headerH + Math.floor(uiScale * 8));

        // Tab bar
        this._drawTabButton(ctx, this.tabBtns.general, 'GENERAL', this.tab === 'general', uiScale);
        this._drawTabButton(ctx, this.tabBtns.controls, 'CONTROLS', this.tab === 'controls', uiScale);

        const gpActive = game.input.isGamepadActive();

        if (this.tab === 'general') this._drawGeneral(ctx, uiScale, gpActive);
        else this._drawControls(ctx, uiScale, gpActive);

        // Footer: home (left), contextual reset (right)
        game.drawSprite(ctx, this.homeBtn.hovered ? 'home_button_on' : 'home_button_off',
            this.homeBtn.x, this.homeBtn.y, uiScale);
        this._drawTextButton(ctx, this.resetBtn, this._resetContext().label,
            this.resetBtn.hovered ? '#ffffff' : '#88aabb',
            this.resetBtn.hovered ? 'rgba(28, 44, 60, 0.96)' : 'rgba(18, 28, 40, 0.92)',
            uiScale);

        // Controller focus ring for non-row chrome (rows draw their own).
        if (gpActive) {
            const focusRects = {
                'tab:general': this.tabBtns.general,
                'tab:controls': this.tabBtns.controls,
                'dev:keyboard': this.deviceBtns.keyboard,
                'dev:mouse': this.deviceBtns.mouse,
                'dev:touch': this.deviceBtns.touch,
            };
            const r = focusRects[this.focusId];
            if (r && r.w > 0) {
                ctx.strokeStyle = '#44ddff';
                ctx.lineWidth = 2;
                ctx.strokeRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
            }
        }

        ctx.restore();
    }

    _drawGeneral(ctx, uiScale, gpActive) {
        const game = this.game;
        const panelX = this._panelX;
        const panelRight = panelX + this._panelW;

        for (let ri = 0; ri < this.generalRows.length; ri++) {
            const row = this.generalRows[ri];
            if (row.type === 'section') {
                const baseY = row.y + this._sectionH - Math.floor(uiScale * 5);
                ctx.fillStyle = '#44ddff';
                ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
                ctx.textAlign = 'left';
                ctx.fillText(row.label, panelX, baseY);
                ctx.strokeStyle = '#1a2233';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(panelX, baseY + Math.floor(uiScale * 3) + 0.5);
                ctx.lineTo(panelRight, baseY + Math.floor(uiScale * 3) + 0.5);
                ctx.stroke();
                continue;
            }

            const midY = row.y + Math.floor(this._rowH / 2);
            ctx.textAlign = 'left';
            ctx.fillStyle = '#ffffff';
            ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
            ctx.fillText(row.label, panelX, midY - Math.floor(uiScale * 1));
            if (row.hint) {
                ctx.fillStyle = '#667788';
                ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
                ctx.fillText(row.hint, panelX, midY + Math.floor(uiScale * 6));
            }

            if (row.type === 'slider') {
                game.drawVolumeRow(ctx, '', SETTINGS[row.key], row.dec, row.inc);
            } else if (row.type === 'cycle') {
                const v = SETTINGS[row.key];
                const b = row.btn;
                const dim = v === 'off';
                this._drawTextButton(ctx, b, String(v || '').toUpperCase(),
                    b.hovered ? '#ffffff' : (dim ? '#667788' : '#44ddff'),
                    b.hovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)',
                    uiScale);
            } else {
                const on = !!SETTINGS[row.key];
                const b = row.btn;
                this._drawTextButton(ctx, b, on ? 'ON' : 'OFF',
                    b.hovered ? '#ffffff' : (on ? '#44ddff' : '#667788'),
                    b.hovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)',
                    uiScale);
            }

            if (gpActive) {
                const focused =
                    (this.focusId === `gen:${ri}:dec` && row.dec)
                    || (this.focusId === `gen:${ri}:inc` && row.inc)
                    || (this.focusId === `gen:${ri}:btn` && row.btn);
                if (focused) {
                    ctx.strokeStyle = '#44ddff';
                    ctx.lineWidth = 2;
                    ctx.strokeRect(focused.x - 2, focused.y - 2, focused.w + 4, focused.h + 4);
                }
            }
        }
    }

    _drawControls(ctx, uiScale, gpActive) {
        const panelX = this._panelX;

        // Device sub-tabs
        const devLabels = { keyboard: 'KEYBOARD', mouse: 'MOUSE', touch: 'TOUCH' };
        for (const id of this.deviceTabs) {
            this._drawTabButton(ctx, this.deviceBtns[id], devLabels[id], this.device === id, uiScale);
        }

        if (this.device === 'touch') {
            this._drawTouchEditor(ctx, uiScale);
            return;
        }

        const rows = this.device === 'keyboard' ? this.keyRows : this.mouseRows;
        const isKey = this.device === 'keyboard';

        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const midY = row.y + Math.floor(this._bindRowH / 2);
            ctx.textAlign = 'left';
            ctx.fillStyle = '#ffffff';
            ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
            ctx.textBaseline = 'middle';
            ctx.fillText(row.action.label, panelX, midY);
            ctx.textBaseline = 'alphabetic';

            const capturing = this._capture
                && this._capture.type === (isKey ? 'key' : 'mouse')
                && this._capture.action === row.action.id;
            const label = capturing
                ? (isKey ? 'PRESS KEY' : 'PRESS BTN')
                : (isKey ? keyLabel(KEYS[row.action.id]) : mouseLabel(MOUSE[row.action.id]));
            this._drawTextButton(ctx, row.btn, label,
                capturing ? '#ffff44' : (row.btn.hovered ? '#ffffff' : '#44ddff'),
                capturing ? 'rgba(50, 46, 10, 0.95)'
                    : (row.btn.hovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)'),
                uiScale);

            if (gpActive && this.focusId === `${isKey ? 'key' : 'ms'}:${i}`) {
                ctx.strokeStyle = '#44ddff';
                ctx.lineWidth = 2;
                ctx.strokeRect(row.btn.x - 2, row.btn.y - 2, row.btn.w + 4, row.btn.h + 4);
            }
        }

        // Footnotes under the list
        const last = rows[rows.length - 1];
        const noteY = last.y + this._bindRowH + Math.floor(uiScale * 10);
        ctx.textAlign = 'center';
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        const cx = this.game.width / 2;
        if (this._capture) {
            ctx.fillStyle = '#ffff44';
            ctx.fillText(isKey ? 'PRESS THE NEW KEY — ESC CANCELS'
                : 'CLICK THE NEW BUTTON — ESC CANCELS', cx, noteY);
        } else {
            ctx.fillText(isKey
                ? 'CLICK A BINDING TO CHANGE IT. PICKING A KEY IN USE SWAPS THE TWO.'
                : 'CLICK A BINDING, THEN PRESS THE MOUSE BUTTON. MIDDLE ALSO PANS CARGO.',
                cx, noteY);
        }
    }

    // Mock in-game screen with every touch control drawn at its anchor,
    // draggable. Mirrors touchControls.draw()'s flat pixel-art styling.
    _drawTouchEditor(ctx, uiScale) {
        const ed = this._editorRect;
        const u = Math.min(ed.w, ed.h);

        // Frame + faint half-split (the floating-stick zones)
        ctx.fillStyle = 'rgba(8, 12, 20, 0.9)';
        ctx.fillRect(ed.x, ed.y, ed.w, ed.h);
        ctx.strokeStyle = '#22556a';
        ctx.lineWidth = 1;
        ctx.strokeRect(ed.x + 0.5, ed.y + 0.5, ed.w - 1, ed.h - 1);
        ctx.strokeStyle = 'rgba(68, 221, 255, 0.12)';
        ctx.beginPath();
        ctx.moveTo(ed.x + ed.w / 2 + 0.5, ed.y);
        ctx.lineTo(ed.x + ed.w / 2 + 0.5, ed.y + ed.h);
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillStyle = 'rgba(102, 119, 136, 0.5)';
        ctx.fillText('LEFT STICK ZONE', ed.x + ed.w * 0.25, ed.y + Math.floor(uiScale * 8));
        ctx.fillText('RIGHT STICK ZONE', ed.x + ed.w * 0.75, ed.y + Math.floor(uiScale * 8));

        const lw = Math.max(2, Math.floor(uiScale));
        ctx.lineWidth = lw;
        const label = (text, x, y, color, alpha) => {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = color;
            ctx.fillText(text, x, y);
        };

        for (const anchor of TOUCH_ANCHORS) {
            const id = anchor.id;
            const c = this._editorControl(id);
            const active = this._dragAnchor === id;
            const baseAlpha = active ? 0.95 : 0.5;

            if (id === 'lHome' || id === 'rHome') {
                ctx.globalAlpha = baseAlpha * 0.7;
                ctx.strokeStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
                ctx.stroke();
                label(anchor.label, c.cx, c.cy + c.r + Math.floor(uiScale * 6), '#ffffff', baseAlpha);
            } else if (id === 'shieldToggle' || id === 'shield') {
                ctx.globalAlpha = baseAlpha;
                ctx.strokeStyle = '#66ccff';
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
                ctx.stroke();
                label('SHIELD', c.cx, c.cy, '#66ccff', baseAlpha);
                if (id === 'shield') {
                    label('HOLD', c.cx, c.cy + c.r + Math.floor(uiScale * 6), '#66ccff', baseAlpha * 0.8);
                }
            } else if (id === 'pause') {
                ctx.globalAlpha = baseAlpha;
                ctx.strokeStyle = '#ffffff';
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = '#ffffff';
                const bw = Math.max(2, Math.round(c.r * 0.18));
                const bh = Math.round(c.r * 0.7);
                ctx.fillRect(Math.round(c.cx - bw * 1.6), Math.round(c.cy - bh / 2), bw, bh);
                ctx.fillRect(Math.round(c.cx + bw * 0.6), Math.round(c.cy - bh / 2), bw, bh);
            } else if (id === 'heal') {
                ctx.globalAlpha = baseAlpha;
                ctx.strokeStyle = '#44ff44';
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, c.r, 0, Math.PI * 2);
                ctx.stroke();
                ctx.fillStyle = '#44ff44';
                const cw2 = Math.max(2, Math.round(c.r * 0.22));
                const cl2 = Math.round(c.r * 0.9);
                ctx.fillRect(Math.round(c.cx - cw2 / 2), Math.round(c.cy - cl2 / 2), cw2, cl2);
                ctx.fillRect(Math.round(c.cx - cl2 / 2), Math.round(c.cy - cw2 / 2), cl2, cw2);
            } else if (id === 'interact') {
                ctx.globalAlpha = baseAlpha;
                ctx.strokeStyle = '#ffff44';
                ctx.strokeRect(Math.round(c.cx - c.hw), Math.round(c.cy - c.hh),
                    Math.round(c.hw * 2), Math.round(c.hh * 2));
                label('INTERACT', c.cx, c.cy, '#ffff44', baseAlpha);
            }

            // Drag handle ring on the grabbed control
            if (active) {
                ctx.globalAlpha = 1;
                ctx.strokeStyle = '#44ddff';
                const rr = c.hw !== undefined ? Math.max(c.hw, c.hh) + lw * 2 : c.r + lw * 2;
                ctx.beginPath();
                ctx.arc(c.cx, c.cy, rr, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // Hint line under the editor
        ctx.fillStyle = '#667788';
        ctx.font = `${Math.floor(5 * uiScale)}px Astro4x`;
        ctx.fillText('DRAG A CONTROL TO MOVE IT — POSITIONS SAVE WHEN YOU LET GO',
            ed.x + ed.w / 2, ed.y + ed.h + Math.floor(uiScale * 8));
        ctx.textBaseline = 'alphabetic';
    }

    _drawTabButton(ctx, btn, label, active, uiScale) {
        this._drawTextButton(ctx, btn, label,
            active ? '#44ddff' : (btn.hovered ? '#ffffff' : '#667788'),
            active ? 'rgba(20, 50, 66, 0.95)'
                : (btn.hovered ? 'rgba(20, 40, 60, 0.92)' : 'rgba(10, 18, 28, 0.85)'),
            uiScale);
    }

    _drawTextButton(ctx, btn, label, fgColor, bgColor, uiScale) {
        if (btn.w <= 0 || btn.h <= 0) return;
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
