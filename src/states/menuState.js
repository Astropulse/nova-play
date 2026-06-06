import { SHIPS } from '../data/ships.js';
import { PlayingState } from './playingState.js';
import { TutorialState } from './tutorialState.js';
import { AchievementsState } from './achievementsState.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { GP } from '../engine/inputManager.js';
import { World } from '../world/world.js';
import { Camera } from '../world/camera.js';
import { Player } from '../entities/player.js';
import { HUD } from '../ui/hud.js';

// Scaling is now dynamic via game properties

export class MenuState {
    constructor(game) {
        this.game = game;
        this.selectedShipIndex = 0;

        // Reset the dynamic FOV scale. PlayingState inflates worldScaleModifier
        // (and thus worldScale) as the player picks up FOV upgrades; that state
        // lives on `game` and persists after a run ends. Without this reset, the
        // Start Flight transition — which zooms the world out to the current
        // game.worldScale — would target the previous run's blown-out FOV.
        this.game.worldScaleModifier = 1.0;
        this.game.resize();

        // Button hit areas (screen pixels)
        this.leftArrowBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.rightArrowBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.startBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.tutorialBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };

        this.musicDecBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.musicIncBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.sfxDecBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.sfxIncBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        this.wordmarkBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };
        // Text-only button — no sprite asset. Layout + hit rect computed each
        // frame in _computeLayout below.
        this.achievementsBtn = { x: 0, y: 0, w: 0, h: 0, hovered: false };

        // Track last hover state for click sound
        this.lastHovered = { left: false, right: false, start: false, tutorial: false, mDec: false, mInc: false, sDec: false, sInc: false };


        // Reuse the in-game starfield renderer so the background is literally
        // the same code the playing state uses. On Start Flight we hand this
        // World + Camera off to the new PlayingState, making the transition
        // visually seamless. Seeded randomly per visit so the title isn't
        // always the same patch of space.
        // Defer the World build (WebGL texture atlas + starfield generation,
        // ~200ms) until the title screen has painted once. The menu UI appears
        // immediately over a black background, then the starfield builds on the
        // first update after the first draw (see _ensureWorld / _painted).
        this.world = null;
        this._worldSeed = Math.floor(Math.random() * 1000000);
        this._painted = false;
        this._worldFade = 0; // 0..1 fade-in once the World is built, so it doesn't pop in hard
        this.camera = new Camera(this.game);

        this.time = 0;

        // Mouse / stick offset (-1..1 each axis), smoothed; converted to a
        // small camera displacement in world units so the World renderer's
        // own per-layer parallax handles the depth feel.
        this.parallaxX = 0;
        this.parallaxY = 0;

        // Transition state used when Start Flight is pressed: fades menu UI,
        // slides the ship preview to screen center, drifts the camera back to
        // (0,0), then hands off to PlayingState. Null while idle.
        this.transition = null;

        // Mirror the PlayingState default so HUD.draw's wave-timer block
        // (which reads `game.currentState.waveTimer`) shows the "NEXT WAVE"
        // counter during the transition handoff. PlayingState seeds its own
        // waveTimer to the same value, so there's no jump.
        this.waveTimer = 120;

        // Gamepad focus. Directional input walks the buttons spatially — the
        // closest button in the pressed direction wins — so the layout on
        // screen dictates navigation rather than list order.
        //   0 ship-left   1 ship-right   2 start   3 tutorial
        //   4 sfx-dec     5 sfx-inc      6 music-dec   7 music-inc
        this.focusIndex = 2; // default to START FLIGHT
        this._stickXLatched = false;
        this._rsXLatched = false;

        // Direct event listener to bypass any framework/loop delay for sounds
        this._onMouseDown = (e) => {
            const mouse = this.game.getMousePos();
            if (this._isInside(mouse, this.leftArrowBtn)) {
                this.game.sounds.play('select', 1.0);
            } else if (this._isInside(mouse, this.rightArrowBtn)) {
                this.game.sounds.play('select', 1.0);
            } else if (this._isInside(mouse, this.startBtn) || this._isInside(mouse, this.tutorialBtn)) {
                this.game.sounds.play('select', 1.0);

            } else if (this._isInside(mouse, this.musicDecBtn) || this._isInside(mouse, this.musicIncBtn) ||
                this._isInside(mouse, this.sfxDecBtn) || this._isInside(mouse, this.sfxIncBtn) ||
                this._isInside(mouse, this.wordmarkBtn) ||
                this._isInside(mouse, this.achievementsBtn)) {
                this.game.sounds.play('click', 1.0);
            }
        };
    }

    enter() {
        document.body.classList.remove('playing');
        this._computeLayout();
        this.game.sounds.playTitleMusic();
        // Warm the rest of the music (one track at a time) while the player is
        // on the title screen, so later tracks play with no fetch delay.
        this.game.sounds.preloadAllMusic();
        window.addEventListener('mousedown', this._onMouseDown);
    }

    exit() {
        window.removeEventListener('mousedown', this._onMouseDown);
    }

    update(dt) {
        this.time += dt;

        // Build the starfield once the menu has painted at least one frame, so
        // the title screen shows immediately and the ~200ms World build lands
        // on the following frame instead of blocking the first paint.
        if (this._painted) this._ensureWorld();
        // Ease the starfield in over ~0.6s once it's built.
        if (this.world && this._worldFade < 1) {
            this._worldFade = Math.min(1, this._worldFade + dt / 0.6);
        }

        const mouse = this.game.getMousePos();

        this._computeLayout();

        // Spatial focus map — pair each id with its live button rect so
        // directional navigation can pick whichever button is actually
        // closest in the pressed direction. Hoisted above the parallax
        // block so the gamepad parallax can read the focused rect too.
        const focusables = [
            { id: 'shipLeft',  rect: this.leftArrowBtn },
            { id: 'shipRight', rect: this.rightArrowBtn },
            { id: 'start',     rect: this.startBtn },
            { id: 'tutorial',  rect: this.tutorialBtn },
            { id: 'sfxDec',    rect: this.sfxDecBtn },
            { id: 'sfxInc',    rect: this.sfxIncBtn },
            { id: 'musicDec',  rect: this.musicDecBtn },
            { id: 'musicInc',  rect: this.musicIncBtn },
            { id: 'achievements', rect: this.achievementsBtn },
        ];
        if (this.focusIndex >= focusables.length) this.focusIndex = 0;

        // --- Background parallax target ---
        // Gamepad: track the focused button's screen position so the
        // background drifts as the user navigates rather than reacting to
        // held stick tilt. Mouse: normalize position around screen center
        // to -1..1. During transition both targets are forced to 0 so the
        // camera drifts back to where PlayingState's player will spawn.
        let targetX = 0, targetY = 0;
        if (!this.transition) {
            const cwHalf = this.game.width / 2;
            const chHalf = this.game.height / 2;
            if (this.game.input.isGamepadActive()) {
                const r = focusables[this.focusIndex].rect;
                const bx = r.x + r.w / 2;
                const by = r.y + r.h / 2;
                targetX = Math.max(-1, Math.min(1, (bx - cwHalf) / cwHalf));
                targetY = Math.max(-1, Math.min(1, (by - chHalf) / chHalf));
            } else {
                targetX = Math.max(-1, Math.min(1, (mouse.x - cwHalf) / cwHalf));
                targetY = Math.max(-1, Math.min(1, (mouse.y - chHalf) / chHalf));
            }
        }
        // Critically-damped-ish smoothing so motion is gentle and responsive.
        const k = 1 - Math.exp(-dt * 5);
        this.parallaxX += (targetX - this.parallaxX) * k;
        this.parallaxY += (targetY - this.parallaxY) * k;

        // Drive the World camera. Max displacement is small in world units so
        // the closest in-game parallax layer (0.55) only sweeps a few pixels —
        // enough to feel alive, not enough to feel like player motion.
        const CAM_MAX = 60;
        this.camera.x = this.parallaxX * CAM_MAX;
        this.camera.y = this.parallaxY * CAM_MAX;

        // --- Transition tick ---
        // While transitioning we suppress all input and just count down.
        if (this.transition) {
            this.transition.time += dt;
            if (this.transition.time >= this.transition.duration) {
                this.game.setState(new PlayingState(
                    this.game,
                    SHIPS[this.selectedShipIndex],
                    {
                        handoff: {
                            world: this.world,
                            camera: this.camera,
                            player: this.transition.player,
                            hud: this.transition.hud,
                        },
                    }
                ));
            }
            return;
        }

        this.leftArrowBtn.hovered = this._isInside(mouse, this.leftArrowBtn);
        this.rightArrowBtn.hovered = this._isInside(mouse, this.rightArrowBtn);
        this.startBtn.hovered = this._isInside(mouse, this.startBtn);
        this.tutorialBtn.hovered = this._isInside(mouse, this.tutorialBtn);

        this.musicDecBtn.hovered = this._isInside(mouse, this.musicDecBtn);
        this.musicIncBtn.hovered = this._isInside(mouse, this.musicIncBtn);
        this.sfxDecBtn.hovered = this._isInside(mouse, this.sfxDecBtn);
        this.sfxIncBtn.hovered = this._isInside(mouse, this.sfxIncBtn);
        this.wordmarkBtn.hovered = this._isInside(mouse, this.wordmarkBtn);
        this.achievementsBtn.hovered = this._isInside(mouse, this.achievementsBtn);

        // Hover sounds - literal "play once on hover start" logic
        if (this.leftArrowBtn.hovered && !this.lastHovered.left) {
            this.game.sounds.play('click', 1.0);
        }
        if (this.rightArrowBtn.hovered && !this.lastHovered.right) {
            this.game.sounds.play('click', 1.0);
        }
        if (this.startBtn.hovered && !this.lastHovered.start) {
            this.game.sounds.play('click', 1.0);
        }
        if (this.tutorialBtn.hovered && !this.lastHovered.tutorial) {
            this.game.sounds.play('click', 1.0);
        }

        if (this.musicDecBtn.hovered && !this.lastHovered.mDec) this.game.sounds.play('click', 0.5);
        if (this.musicIncBtn.hovered && !this.lastHovered.mInc) this.game.sounds.play('click', 0.5);
        if (this.sfxDecBtn.hovered && !this.lastHovered.sDec) this.game.sounds.play('click', 0.5);
        if (this.sfxIncBtn.hovered && !this.lastHovered.sInc) this.game.sounds.play('click', 0.5);

        this.lastHovered.left = this.leftArrowBtn.hovered;
        this.lastHovered.right = this.rightArrowBtn.hovered;
        this.lastHovered.start = this.startBtn.hovered;
        this.lastHovered.tutorial = this.tutorialBtn.hovered;

        this.lastHovered.mDec = this.musicDecBtn.hovered;
        this.lastHovered.mInc = this.musicIncBtn.hovered;
        this.lastHovered.sDec = this.sfxDecBtn.hovered;
        this.lastHovered.sInc = this.sfxIncBtn.hovered;
        this.lastHovered.wordmark = this.wordmarkBtn.hovered;

        // Visual state changes handled here, sounds handled in _onMouseDown for reliability
        if (this.game.input.isMouseJustPressed(0)) {
            if (this.leftArrowBtn.hovered) {
                this.selectedShipIndex = (this.selectedShipIndex - 1 + SHIPS.length) % SHIPS.length;
            }
            if (this.rightArrowBtn.hovered) {
                this.selectedShipIndex = (this.selectedShipIndex + 1) % SHIPS.length;
            }
            if (this.startBtn.hovered) {
                this.game.input.consumeMouseButton(0);
                this._beginStartTransition();
            }
            if (this.tutorialBtn.hovered) {
                this.game.input.consumeMouseButton(0);
                this.game.setState(new TutorialState(this.game));
            }

            if (this.musicDecBtn.hovered) {
                this.game.sounds.setMusicVolume(this.game.sounds.musicVolume - 0.1);
            }
            if (this.musicIncBtn.hovered) {
                this.game.sounds.setMusicVolume(this.game.sounds.musicVolume + 0.1);
            }
            if (this.sfxDecBtn.hovered) {
                this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume - 0.1);
            }
            if (this.sfxIncBtn.hovered) {
                this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume + 0.1);
            }
            if (this.wordmarkBtn.hovered) {
                window.open('https://www.retrodiffusion.ai/', '_blank');
            }
            if (this.achievementsBtn.hovered) {
                this.game.input.consumeMouseButton(0);
                this.game.setState(new AchievementsState(this.game));
                return;
            }
        }

        if (this.game.input.isKeyJustPressed('ArrowLeft') || this.game.input.isKeyJustPressed('KeyA')) {
            this.selectedShipIndex = (this.selectedShipIndex - 1 + SHIPS.length) % SHIPS.length;
            this.game.sounds.play('select', 1.0);
        }
        if (this.game.input.isKeyJustPressed('ArrowRight') || this.game.input.isKeyJustPressed('KeyD')) {
            this.selectedShipIndex = (this.selectedShipIndex + 1) % SHIPS.length;
            this.game.sounds.play('select', 1.0);
        }

        // --- Gamepad ---
        const input = this.game.input;

        const changeShip = (dir) => {
            this.selectedShipIndex = (this.selectedShipIndex + dir + SHIPS.length) % SHIPS.length;
            this.game.sounds.play('select', 1.0);
        };

        const moveFocusSpatial = (dirX, dirY) => {
            const cur = focusables[this.focusIndex].rect;
            const cx = cur.x + cur.w / 2;
            const cy = cur.y + cur.h / 2;
            let bestIdx = -1;
            let bestScore = Infinity;
            // Penalty on the cross-axis keeps us from jumping diagonally when
            // an on-axis neighbour exists.
            const CROSS_PENALTY = 2.0;
            for (let i = 0; i < focusables.length; i++) {
                if (i === this.focusIndex) continue;
                const r = focusables[i].rect;
                const rx = r.x + r.w / 2;
                const ry = r.y + r.h / 2;
                const dx = rx - cx;
                const dy = ry - cy;
                // The candidate must lie strictly in the pressed direction.
                if (dirX !== 0) {
                    if (Math.sign(dx) !== dirX) continue;
                    // Also require the primary axis motion to dominate so
                    // "right" doesn't snap to something that is mostly below.
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
            if (bestIdx >= 0 && bestIdx !== this.focusIndex) {
                this.focusIndex = bestIdx;
                this.game.sounds.play('click', 0.5);
            }
        };

        const activateFocus = () => {
            const id = focusables[this.focusIndex].id;
            switch (id) {
                case 'shipLeft':  changeShip(-1); break;
                case 'shipRight': changeShip(1); break;
                case 'start':
                    this._beginStartTransition();
                    return 'transition';
                case 'tutorial':
                    this.game.setState(new TutorialState(this.game));
                    return 'transition';
                case 'achievements':
                    this.game.setState(new AchievementsState(this.game));
                    return 'transition';
                case 'sfxDec':   this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume - 0.1); break;
                case 'sfxInc':   this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume + 0.1); break;
                case 'musicDec': this.game.sounds.setMusicVolume(this.game.sounds.musicVolume - 0.1); break;
                case 'musicInc': this.game.sounds.setMusicVolume(this.game.sounds.musicVolume + 0.1); break;
            }
            this.game.sounds.play('select', 0.8);
            return null;
        };

        // D-pad: one spatial step per press.
        if (input.isGamepadJustPressed(GP.DLEFT))  moveFocusSpatial(-1, 0);
        if (input.isGamepadJustPressed(GP.DRIGHT)) moveFocusSpatial(1, 0);
        if (input.isGamepadJustPressed(GP.DUP))    moveFocusSpatial(0, -1);
        if (input.isGamepadJustPressed(GP.DDOWN))  moveFocusSpatial(0, 1);

        // Left stick: flick-latched so a held tilt doesn't autoscroll. When
        // the stick is tilted past threshold, pick the dominant axis and take
        // one spatial step in that direction.
        const lx = input.leftStickX;
        const ly = input.leftStickY;
        const stickMag = Math.max(Math.abs(lx), Math.abs(ly));
        if (stickMag > 0.55) {
            if (!this._stickXLatched) {
                this._stickXLatched = true;
                if (Math.abs(lx) > Math.abs(ly)) moveFocusSpatial(lx < 0 ? -1 : 1, 0);
                else                             moveFocusSpatial(0, ly < 0 ? -1 : 1);
            }
        } else if (stickMag < 0.25) {
            this._stickXLatched = false;
        }

        // Right stick is reserved for ship change — independent of focus.
        const rx = input.rightStickX;
        if (Math.abs(rx) > 0.55) {
            if (!this._rsXLatched) {
                this._rsXLatched = true;
                changeShip(rx < 0 ? -1 : 1);
            }
        } else if (Math.abs(rx) < 0.25) {
            this._rsXLatched = false;
        }

        // A clicks the focused button. Start is a shortcut straight to game.
        if (input.isGamepadJustPressed(GP.A)) {
            if (activateFocus() === 'transition') return;
        }
        if (input.isGamepadJustPressed(GP.START)) {
            this.game.sounds.play('select', 1.0);
            this._beginStartTransition();
            return;
        }

        // Light up the existing _on sprite for whichever button is focused.
        if (input.isGamepadActive()) {
            const id = focusables[this.focusIndex].id;
            this.leftArrowBtn.hovered  = id === 'shipLeft';
            this.rightArrowBtn.hovered = id === 'shipRight';
            this.startBtn.hovered      = id === 'start';
            this.tutorialBtn.hovered   = id === 'tutorial';
            this.sfxDecBtn.hovered     = id === 'sfxDec';
            this.sfxIncBtn.hovered     = id === 'sfxInc';
            this.musicDecBtn.hovered   = id === 'musicDec';
            this.musicIncBtn.hovered   = id === 'musicInc';
            this.achievementsBtn.hovered = id === 'achievements';
        }
    }

    // Snapshot the ship-preview center where the menu draws it, then enter
    // the transition. draw() lerps the world+ship out from uiScale to
    // worldScale and slides the ship to screen center over `duration`,
    // drawing the HUD inside the same zoom transform so it scales with the
    // world. The Player+HUD pair we build here gets handed to PlayingState
    // so the visual is literally continuous (same objects, same state).
    // Build the deferred World on demand (idempotent). The starfield sprites
    // live in the full atlas, which loads in the background after the boot
    // atlas — so we wait until they're available before building.
    _ensureWorld() {
        if (this.world) return;
        if (!this.game.assets.get('starfield_0')) return; // full atlas not ready yet
        this.world = new World(this.game, this._worldSeed);
    }

    _beginStartTransition() {
        if (this.transition) return;
        this._ensureWorld();
        if (!this.world) return; // full atlas still loading — ignore the click until ready
        const shipCenter = this._currentShipCenter();
        const transitionPlayer = new Player(this.game, SHIPS[this.selectedShipIndex]);
        const transitionHud = new HUD(this.game, transitionPlayer);
        this.transition = {
            time: 0,
            duration: 0.85,
            shipFromX: shipCenter.x,
            shipFromY: shipCenter.y,
            player: transitionPlayer,
            hud: transitionHud,
        };
    }

    _currentShipCenter() {
        const game = this.game;
        const ship = SHIPS[this.selectedShipIndex];
        const shipSize = game.spriteSize(ship.assets.still, game.uiScale);
        const leftSize = game.spriteSize('left_arrow_off', game.uiScale);
        const arrowGap = Math.floor(game.uiScale * 4);
        const shipX = Math.floor(this.leftArrowBtn.x + leftSize.w + arrowGap);
        // shipY is the top-left used by drawSprite; mirror that math here.
        const titleSize = game.spriteSize('title', game.uiScale);
        const titleY = Math.floor(game.uiScale * 12);
        const nameY = Math.floor(titleY + titleSize.h + game.uiScale * 14);
        const shipY = Math.floor(nameY + game.uiScale * 6);
        return { x: shipX + shipSize.w / 2, y: shipY + shipSize.h / 2 };
    }

    _computeLayout() {
        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const cx = cw / 2;

        const titleSize = game.spriteSize('title', game.uiScale);
        const titleY = Math.floor(game.uiScale * 12);

        const ship = SHIPS[this.selectedShipIndex];
        const shipSize = game.spriteSize(ship.assets.still, game.uiScale);
        const nameY = Math.floor(titleY + titleSize.h + game.uiScale * 14);
        const shipY = Math.floor(nameY + game.uiScale * 6);
        const arrowGap = Math.floor(game.uiScale * 4);

        const leftSize = game.spriteSize('left_arrow_off', game.uiScale);
        const rightSize = game.spriteSize('right_arrow_off', game.uiScale);
        const startSize = game.spriteSize('start_flight_off', game.uiScale);
        const tutorialSize = game.spriteSize('tutorial_off', game.uiScale);


        const statsGap = Math.floor(game.uiScale * 6);
        const barWidth = Math.floor(game.uiScale * 30);
        const labelWidth = Math.floor(game.uiScale * 18);
        const totalW = leftSize.w + arrowGap + shipSize.w + arrowGap + rightSize.w + statsGap + labelWidth + barWidth;
        const startX = Math.floor(cx - totalW / 2);

        this.leftArrowBtn.x = startX;
        this.leftArrowBtn.w = leftSize.w;
        this.leftArrowBtn.h = leftSize.h;
        this.leftArrowBtn.y = Math.floor(shipY + shipSize.h / 2 - leftSize.h / 2);

        this.rightArrowBtn.x = Math.floor(startX + leftSize.w + arrowGap + shipSize.w + arrowGap);
        this.rightArrowBtn.w = rightSize.w;
        this.rightArrowBtn.h = rightSize.h;
        this.rightArrowBtn.y = this.leftArrowBtn.y;

        this.tutorialBtn.x = Math.floor(cx - tutorialSize.w / 2);
        this.tutorialBtn.w = tutorialSize.w;
        this.tutorialBtn.h = tutorialSize.h;
        this.tutorialBtn.y = Math.floor(ch - tutorialSize.h - game.uiScale * 12);

        this.startBtn.x = Math.floor(cx - startSize.w / 2);
        this.startBtn.w = startSize.w;
        this.startBtn.h = startSize.h;
        this.startBtn.y = Math.floor(this.tutorialBtn.y - startSize.h - game.uiScale * 4);


        // Volume Controls Layout (Bottom Right)
        const margin = Math.floor(game.uiScale * 8);
        const volBtnSize = game.spriteSize('left_arrow_off', game.uiScale);
        const volGap = Math.floor(game.uiScale * 6);
        const barW = Math.floor(game.uiScale * 60);
        const lineH = Math.floor(game.uiScale * 20);

        // Music (Bottom Line)
        this.musicDecBtn.x = cw - margin - volBtnSize.w - barW - volBtnSize.w - volGap * 2;
        this.musicDecBtn.y = ch - margin - volBtnSize.h;
        this.musicDecBtn.w = volBtnSize.w;
        this.musicDecBtn.h = volBtnSize.h;

        this.musicIncBtn.x = cw - margin - volBtnSize.w;
        this.musicIncBtn.y = this.musicDecBtn.y;
        this.musicIncBtn.w = volBtnSize.w;
        this.musicIncBtn.h = volBtnSize.h;

        // SFX (Line above Music)
        this.sfxDecBtn.x = this.musicDecBtn.x;
        this.sfxDecBtn.y = this.musicDecBtn.y - lineH;
        this.sfxDecBtn.w = volBtnSize.w;
        this.sfxDecBtn.h = volBtnSize.h;

        this.sfxIncBtn.x = this.musicIncBtn.x;
        this.sfxIncBtn.y = this.sfxDecBtn.y;
        this.sfxIncBtn.w = volBtnSize.w;
        this.sfxIncBtn.h = volBtnSize.h;

        // Wordmark Hit Area (matching draw offset)
        const wordmarkSize = game.spriteSize('pixel_wordmark', game.uiScale);
        const marginTL = Math.floor(game.uiScale * 12);
        this.wordmarkBtn.x = marginTL - (1 * game.uiScale);
        this.wordmarkBtn.y = marginTL + 7 * game.uiScale;
        this.wordmarkBtn.w = wordmarkSize.w;
        this.wordmarkBtn.h = wordmarkSize.h;

        // Achievements text button — top-right, mirroring the wordmark's
        // top-left margin so it reads as a paired UI element.
        const marginTR = Math.floor(game.uiScale * 12);
        const labelW = Math.floor(game.uiScale * 80);
        const labelH = Math.floor(game.uiScale * 22);
        this.achievementsBtn.x = cw - marginTR - labelW;
        this.achievementsBtn.y = marginTR;
        this.achievementsBtn.w = labelW;
        this.achievementsBtn.h = labelH;
    }

    draw(ctx) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';

        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const cx = cw / 2;

        // Transition progress 0..1 and easings. UI fades during the first
        // half of the transition; the world+ship zoom out together on
        // ease-out-cubic so the effect reads as the camera pulling back from
        // the ship rather than the ship shrinking on its own.
        let uiAlpha = 1;
        let animT = 0;
        if (this.transition) {
            const t = Math.min(1, this.transition.time / this.transition.duration);
            uiAlpha = Math.max(0, 1 - t * 2);
            animT = 1 - Math.pow(1 - t, 3);
        }

        // While in the menu, the world renders zoomed-in to uiScale so the
        // background lines up with the menu's ship size. During the
        // transition it lerps back to the real worldScale. Temporarily swap
        // game.worldScale because the World shader and the ship draw both
        // read it directly.
        const baseWorldScale = game.worldScale;
        const renderScale = game.uiScale + (baseWorldScale - game.uiScale) * animT;
        game.worldScale = renderScale;
        // World may not be built yet on the very first frame; the game loop has
        // already cleared to black, so the menu UI simply draws over black until
        // the starfield comes up next frame.
        if (this.world) {
            this.world.draw(ctx, this.camera, null, this.time);
            // Fade the starfield in from black so it doesn't pop in hard. Drawn
            // over the world but under the UI, so only the background fades.
            if (this._worldFade < 1) {
                ctx.save();
                ctx.globalAlpha = 1 - this._worldFade;
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, cw, ch);
                ctx.restore();
            }
        }

        const ship = SHIPS[this.selectedShipIndex];
        const shipSize = game.spriteSize(ship.assets.still, game.uiScale);
        const titleSize = game.spriteSize('title', game.uiScale);
        const titleY = Math.floor(game.uiScale * 12);
        const nameY = Math.floor(titleY + titleSize.h + game.uiScale * 14);
        const shipY = Math.floor(nameY + game.uiScale * 6);
        const leftSize = game.spriteSize('left_arrow_off', game.uiScale);
        const arrowGap = Math.floor(game.uiScale * 4);
        const shipX = Math.floor(this.leftArrowBtn.x + leftSize.w + arrowGap);

        // --- UI layer (everything except the ship) — wrapped in uiAlpha ---
        ctx.save();
        ctx.globalAlpha *= uiAlpha;

        game.drawSpriteCentered(ctx, 'title', Math.round(cx), Math.round(titleY + titleSize.h / 2), game.uiScale);

        ctx.fillStyle = '#ffffff';
        ctx.font = `${8 * game.uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText(ship.name.toUpperCase(), cx, nameY);

        game.drawSprite(ctx, this.leftArrowBtn.hovered ? 'left_arrow_on' : 'left_arrow_off', this.leftArrowBtn.x, this.leftArrowBtn.y, game.uiScale);
        game.drawSprite(ctx, this.rightArrowBtn.hovered ? 'right_arrow_on' : 'right_arrow_off', this.rightArrowBtn.x, this.rightArrowBtn.y, game.uiScale);

        const statsGap = Math.floor(game.uiScale * 6);
        const statsX = Math.floor(this.rightArrowBtn.x + this.rightArrowBtn.w + statsGap);
        const barWidth = Math.floor(game.uiScale * 30);
        const statsTopY = Math.floor(shipY + shipSize.h / 2 - game.uiScale * 18);
        this._drawStats(ctx, ship, statsTopY, statsX, barWidth);

        const descY = Math.floor(shipY + shipSize.h + game.uiScale * 8);
        ctx.fillStyle = '#8899aa';
        ctx.font = `${8 * game.uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        const descLines = ship.description.split('\n');
        for (let i = 0; i < descLines.length; i++) {
            ctx.fillText(descLines[i], cx, descY + i * Math.floor(game.uiScale * 10));
        }

        if (ship.special) {
            ctx.fillStyle = '#44ddff';
            const specialY = Math.floor(descY + descLines.length * game.uiScale * 10 + game.uiScale * 4);
            ctx.fillText(`[${ship.special.toUpperCase()}]`, cx, specialY);
        }

        game.drawSprite(ctx, this.startBtn.hovered ? 'start_flight_on' : 'start_flight_off', this.startBtn.x, this.startBtn.y, game.uiScale);
        game.drawSprite(ctx, this.tutorialBtn.hovered ? 'tutorial_on' : 'tutorial_off', this.tutorialBtn.x, this.tutorialBtn.y, game.uiScale);

        const marginTL = Math.floor(game.uiScale * 12);
        ctx.fillStyle = '#8899aa';
        ctx.font = `${8 * game.uiScale}px Astro4x`;
        ctx.textAlign = 'left';
        ctx.fillText('Made with', marginTL, marginTL + 4 * game.uiScale);
        game.drawSprite(ctx, 'pixel_wordmark', marginTL - (1 * game.uiScale), marginTL + 7 * game.uiScale, game.uiScale);

        // Achievements text button — text-only since no sprite asset exists.
        // Hover state mirrors the in-game UI palette (white = active).
        {
            const btn = this.achievementsBtn;
            ctx.font = `${8 * game.uiScale}px Astro5x`;
            ctx.textAlign = 'right';
            ctx.fillStyle = btn.hovered ? '#ffffff' : '#44ddff';
            ctx.fillText('ACHIEVEMENTS ►', btn.x + btn.w, btn.y + Math.floor(game.uiScale * 8));
            // Subtle unlock-count hint
            const mgr = game.achievements;
            if (mgr) {
                ctx.font = `${5 * game.uiScale}px Astro4x`;
                ctx.fillStyle = '#667788';
                ctx.fillText(`${mgr.unlocked.size} / ${ACHIEVEMENTS.length}`, btn.x + btn.w, btn.y + Math.floor(game.uiScale * 16));
            }
        }

        this._drawControls(ctx);
        this._drawVolumeControls(ctx);

        ctx.restore();

        // --- Ship sprite (not faded; slides during transition) ---
        // Drawn at the current renderScale (== game.worldScale right now), so
        // it shrinks together with the world — the visual ratio between ship
        // and stars stays constant, selling the camera-pullback.
        const fromCx = shipX + shipSize.w / 2;
        const fromCy = shipY + shipSize.h / 2;
        const sFromX = this.transition ? this.transition.shipFromX : fromCx;
        const sFromY = this.transition ? this.transition.shipFromY : fromCy;
        const sCenterX = sFromX + (cx - sFromX) * animT;
        const sCenterY = sFromY + (ch / 2 - sFromY) * animT;
        const stillAsset = game.assets.get(ship.assets.still);
        if (stillAsset) {
            const img = stillAsset.canvas || stillAsset;
            const w = (stillAsset.width || img.width) * renderScale;
            const h = (stillAsset.height || img.height) * renderScale;
            ctx.drawImage(img, Math.round(sCenterX - w / 2), Math.round(sCenterY - h / 2), w, h);
        }

        // HUD layered inside the world's zoom. Because every HUD element is
        // pinned to a screen edge, scaling the whole layer around screen
        // center by (renderScale / baseWorldScale) sells the HUD as if it
        // were frozen at the world's scale — it sits off-screen while the
        // world is zoomed-in and slides to its corners as the world zooms
        // back out. Alpha fades in over the transition so it doesn't pop on.
        if (this.transition && this.transition.hud) {
            const hudScaleFactor = renderScale / baseWorldScale;
            ctx.save();
            ctx.translate(cx, ch / 2);
            ctx.scale(hudScaleFactor, hudScaleFactor);
            ctx.translate(-cx, -ch / 2);
            ctx.globalAlpha *= animT;
            this.transition.hud.draw(ctx);
            ctx.restore();
        }

        game.worldScale = baseWorldScale;
        ctx.restore();

        // First paint done — update() will build the World on the next frame.
        this._painted = true;
    }


    _drawStats(ctx, ship, y, x, barWidth) {
        const stats = [
            { label: 'HEALTH', value: ship.health, max: 200, color: '#44ff66' },
            { label: 'SHIELD', value: ship.shield, max: 60, color: '#44aaff' },
            { label: 'SPEED', value: ship.speed, max: 10, color: '#aa66ff' },
            { label: 'DAMAGE', value: ship.baseDamage, max: 15, color: '#ff4444' },
            { label: 'CARGO', value: ship.storage.rows, max: 5, color: '#ffaa44' },
        ];

        const barHeight = Math.floor(this.game.uiScale * 3);
        const labelWidth = Math.floor(this.game.uiScale * 36);
        const barStartX = Math.floor(x + labelWidth);
        const lineHeight = Math.floor(this.game.uiScale * 9);

        ctx.font = `${8 * this.game.uiScale}px Astro4x`;

        for (let i = 0; i < stats.length; i++) {
            const stat = stats[i];
            const sy = Math.floor(y + i * lineHeight);

            ctx.fillStyle = '#667788';
            ctx.textAlign = 'right';
            ctx.fillText(stat.label, barStartX - this.game.uiScale * 2, sy + barHeight);

            ctx.fillStyle = '#1a2233';
            ctx.fillRect(barStartX, sy, barWidth, barHeight);

            ctx.fillStyle = stat.color;
            const fillW = Math.floor((stat.value / stat.max) * barWidth);
            ctx.fillRect(barStartX, sy, fillW, barHeight);
        }
        ctx.textAlign = 'center';
    }

    _isInside(point, rect) {
        return point.x >= rect.x && point.x <= rect.x + rect.w &&
            point.y >= rect.y && point.y <= rect.y + rect.h;
    }

    _drawVolumeControls(ctx) {
        this.game.drawVolumeRow(ctx, 'MUSIC', this.game.sounds.musicVolume, this.musicDecBtn, this.musicIncBtn);
        this.game.drawVolumeRow(ctx, 'SOUNDS', this.game.sounds.sfxVolume, this.sfxDecBtn, this.sfxIncBtn);
    }

    _drawControls(ctx) {
        const game = this.game;
        const uiScale = game.uiScale;
        const margin = Math.floor(uiScale * 12);
        const x = margin;

        const controls = game.input.gamepadConnected ? [
            { key: 'L-STICK',  desc: 'ROTATE + THRUST' },
            { key: 'R-STICK',  desc: 'AIM' },
            { key: 'D-PAD',    desc: 'FORWARDS / BACK' },
            { key: 'LT',       desc: 'BOOST / TELEPORT' },
            { key: 'RT',       desc: 'SHOOT' },
            { key: 'LB / RB',  desc: 'SHIELD' },
            { key: 'X',        desc: 'INTERACT' },
            { key: 'Y',        desc: 'USE ITEM' },
            { key: 'START',    desc: 'PAUSE / INVENTORY' }
        ] : [
            { key: 'W/S', desc: 'FORWARDS / BACK' },
            { key: 'J/L', desc: 'ROTATE CCW / CW' },
            { key: 'SPACE', desc: 'BOOST/TELEPORT' },
            { key: 'L-MB/I', desc: 'SHOOT' },
            { key: 'R-MB/SHIFT', desc: 'SHIELD' },
            { key: 'E', desc: 'INTERACT' },
            { key: 'ESC', desc: 'PAUSE / INVENTORY' }
        ];

        const lineHeight = Math.floor(uiScale * 9);
        const totalHeight = Math.floor(uiScale * 14) + controls.length * lineHeight;
        let y = game.height - margin - totalHeight + Math.floor(uiScale * 10);

        ctx.fillStyle = '#ffffff';
        ctx.font = `${10 * uiScale}px Astro5x`;
        ctx.textAlign = 'left';
        ctx.fillText('CONTROLS', x, y);

        y += Math.floor(uiScale * 14);
        ctx.font = `${7 * uiScale}px Astro4x`;

        const keyW = Math.floor(uiScale * 52);
        for (const ctrl of controls) {
            ctx.fillStyle = '#44ddff';
            ctx.fillText(ctrl.key, x, y);
            ctx.fillStyle = '#8899aa';
            ctx.fillText(ctrl.desc, x + keyW, y);
            y += lineHeight;
        }
    }
}
