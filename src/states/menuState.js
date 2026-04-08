import { SHIPS } from '../data/ships.js';
import { PlayingState } from './playingState.js';
import { TutorialState } from './tutorialState.js';

// Scaling is now dynamic via game properties

export class MenuState {
    constructor(game) {
        this.game = game;
        this.selectedShipIndex = 0;

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

        // Track last hover state for click sound
        this.lastHovered = { left: false, right: false, start: false, tutorial: false, mDec: false, mInc: false, sDec: false, sInc: false };


        // Star animation for background
        this.stars = [];
        for (let i = 0; i < 80; i++) {
            this.stars.push({
                x: Math.random(),
                y: Math.random(),
                spriteIdx: Math.floor(Math.random() * 11),
                brightness: Math.random() * 0.5 + 0.3,
                twinkleSpeed: Math.random() * 2 + 1,
                twinkleOffset: Math.random() * Math.PI * 2
            });
        }

        // Starfield clusters for menu background
        this.starfields = [];
        for (let i = 0; i < 6; i++) {
            this.starfields.push({
                x: Math.random(),
                y: Math.random(),
                spriteIdx: Math.floor(Math.random() * 8),
                rotation: Math.floor(Math.random() * 4) * (Math.PI / 2),
                alpha: 0.15 + Math.random() * 0.2
            });
        }

        this.showConstellation = Math.random() < 0.01;
        if (this.showConstellation) {
            const safeSpots = [
                { x: 0.15, y: 0.45 }, // Left Middle
                { x: 0.15, y: 0.65 }, // Left Bottom/Middle
                { x: 0.8, y: 0.25 },  // Top Right
                { x: 0.85, y: 0.5 },  // Right Middle
                { x: 0.8, y: 0.7 }    // Right Bottom/Middle
            ];
            const spot = safeSpots[Math.floor(Math.random() * safeSpots.length)];
            this.constellation = {
                // Pick a spot, then add a little random offset (+/- 5% of screen)
                x: spot.x + (Math.random() - 0.5) * 0.1,
                y: spot.y + (Math.random() - 0.5) * 0.1,
                alpha: 0.4 + Math.random() * 0.3,
                pulseSpeed: 0.5 + Math.random() * 0.5
            };
        }

        this.time = 0;

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
                this._isInside(mouse, this.wordmarkBtn)) {
                this.game.sounds.play('click', 1.0);
            }
        };
    }

    enter() {
        document.body.classList.remove('playing');
        this._computeLayout();

        if (this.constellation) {
            this.game.sounds.playMusicByLabel("King's Victory");
        } else {
            this.game.sounds.playTitleMusic();
        }

        window.addEventListener('mousedown', this._onMouseDown);
    }

    exit() {
        window.removeEventListener('mousedown', this._onMouseDown);
    }

    update(dt) {
        this.time += dt;
        const mouse = this.game.getMousePos();

        this._computeLayout();

        this.leftArrowBtn.hovered = this._isInside(mouse, this.leftArrowBtn);
        this.rightArrowBtn.hovered = this._isInside(mouse, this.rightArrowBtn);
        this.startBtn.hovered = this._isInside(mouse, this.startBtn);
        this.tutorialBtn.hovered = this._isInside(mouse, this.tutorialBtn);

        this.musicDecBtn.hovered = this._isInside(mouse, this.musicDecBtn);
        this.musicIncBtn.hovered = this._isInside(mouse, this.musicIncBtn);
        this.sfxDecBtn.hovered = this._isInside(mouse, this.sfxDecBtn);
        this.sfxIncBtn.hovered = this._isInside(mouse, this.sfxIncBtn);
        this.wordmarkBtn.hovered = this._isInside(mouse, this.wordmarkBtn);

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
                this.game.setState(new PlayingState(this.game, SHIPS[this.selectedShipIndex]));
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
        }

        if (this.game.input.isKeyJustPressed('ArrowLeft') || this.game.input.isKeyJustPressed('KeyA')) {
            this.selectedShipIndex = (this.selectedShipIndex - 1 + SHIPS.length) % SHIPS.length;
            this.game.sounds.play('select', 1.0);
        }
        if (this.game.input.isKeyJustPressed('ArrowRight') || this.game.input.isKeyJustPressed('KeyD')) {
            this.selectedShipIndex = (this.selectedShipIndex + 1) % SHIPS.length;
            this.game.sounds.play('select', 1.0);
        }
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
    }

    draw(ctx) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.textBaseline = 'alphabetic';

        const game = this.game;
        const cw = game.width;
        const ch = game.height;
        const cx = cw / 2;

        // Draw starfield clusters
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const sf of this.starfields) {
            ctx.globalAlpha = sf.alpha;
            const key = `starfield_${sf.spriteIdx}`;
            const img = game.assets.get(key);
            if (img) {
                const w = Math.round((img.width || img.canvas.width) * game.uiScale);
                const h = Math.round((img.height || img.canvas.height) * game.uiScale);
                const x = sf.x * cw;
                const y = sf.y * ch;
                const rx = Math.round(x);
                const ry = Math.round(y);

                if (sf.rotation === 0) {
                    ctx.drawImage(img.canvas || img, Math.round(rx - w / 2), Math.round(ry - h / 2), w, h);
                } else {
                    ctx.save();
                    ctx.translate(rx, ry);
                    ctx.rotate(sf.rotation);
                    ctx.drawImage(img.canvas || img, Math.round(-w / 2), Math.round(-h / 2), w, h);
                    ctx.restore();
                }
            }
        }
        ctx.restore();

        // Draw Christus Victor constellation if active
        if (this.constellation) {
            const key = 'christus_victor_constellation';
            const asset = game.assets.get(key);
            if (asset) {
                ctx.save();
                const pulse = Math.sin(this.time * this.constellation.pulseSpeed);
                ctx.globalAlpha = this.constellation.alpha + pulse * 0.15;
                ctx.globalCompositeOperation = 'screen';

                // Razor sharpness for this specific asset without global impact
                ctx.imageSmoothingEnabled = false;

                const img = asset.canvas || asset;
                const scale = game.uiScale;
                const w = Math.round((asset.width || img.width) * scale);
                const h = Math.round((asset.height || img.height) * scale);
                const cx = this.constellation.x * cw;
                const cy = this.constellation.y * ch;

                ctx.drawImage(img, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
                ctx.restore();
            }
        }

        // Render menu stars with pixel-perfect sharpness
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        for (const star of this.stars) {
            const key = `star_${star.spriteIdx}`;
            const asset = game.assets.get(key);
            if (!asset) continue;

            const alpha = star.brightness + Math.sin(this.time * star.twinkleSpeed + star.twinkleOffset) * 0.2;
            const img = asset.canvas || asset;
            const scale = game.uiScale;
            const w = Math.round((asset.width || img.width) * scale);
            const h = Math.round((asset.height || img.height) * scale);
            const cx = star.x * cw;
            const cy = star.y * ch;

            ctx.globalAlpha = Math.max(0.1, Math.min(1, alpha));
            ctx.drawImage(img, Math.round(cx - w / 2), Math.round(cy - h / 2), w, h);
        }
        ctx.restore();

        const titleSize = game.spriteSize('title', game.uiScale);
        const titleY = Math.floor(game.uiScale * 12);
        game.drawSpriteCentered(ctx, 'title', Math.round(cx), Math.round(titleY + titleSize.h / 2), game.uiScale);

        const ship = SHIPS[this.selectedShipIndex];
        const nameY = Math.floor(titleY + titleSize.h + game.uiScale * 14);

        ctx.fillStyle = '#ffffff';
        ctx.font = `${8 * game.uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText(ship.name.toUpperCase(), cx, nameY);

        const shipSize = game.spriteSize(ship.assets.still, game.uiScale);
        const shipY = Math.floor(nameY + game.uiScale * 6);
        const leftSize = game.spriteSize('left_arrow_off', game.uiScale);
        const arrowGap = Math.floor(game.uiScale * 4);
        const shipX = Math.floor(this.leftArrowBtn.x + leftSize.w + arrowGap);
        game.drawSprite(ctx, ship.assets.still, shipX, shipY, game.uiScale);

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


        // "Made with" Wordmark (Top Left)
        const marginTL = Math.floor(game.uiScale * 12);
        ctx.fillStyle = '#8899aa';
        ctx.font = `${8 * game.uiScale}px Astro4x`;
        ctx.textAlign = 'left';
        ctx.fillText('Made with', marginTL, marginTL + 4 * game.uiScale);
        game.drawSprite(ctx, 'pixel_wordmark', marginTL - (1 * game.uiScale), marginTL + 7 * game.uiScale, game.uiScale);

        this._drawControls(ctx);
        this._drawVolumeControls(ctx);

        ctx.restore();
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

        const controls = [
            { key: 'W/S', desc: 'FORWARDS / BACK' },
            { key: 'J/L', desc: 'ROTATE CCW / CW' },
            { key: 'A/D', desc: 'DODGE (IF CAPABLE)' },
            { key: 'SPACE', desc: 'BOOST' },
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
