import { AssetLoader } from './assetLoader.js';
import { InputManager } from './inputManager.js';
import { SoundManager } from './soundManager.js';
import { MenuState } from '../states/menuState.js';
import { DevConsole } from '../ui/devConsole.js';

export class Game {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');

        // Dynamic scaling
        this.worldScale = 2; // In-game world
        this.worldScaleModifier = 1.0;
        this.uiScale = 3;    // Menus / Pause
        this.hudScale = 4;   // HUD overlays

        this.resize();
        window.addEventListener('resize', () => this.resize());

        // Subsystems
        this.assets = new AssetLoader();
        this.input = new InputManager(canvas);
        this.sounds = new SoundManager();
        this.devConsole = new DevConsole(this);

        // State
        this.currentState = null;
        this.lastTime = 0;
        this.running = false;

        // Recording State
        this.isRecording = false;
        this.recordingEnabled = false;
        this.showHealth = false;
        this.recordTimer = 0;
        this.maxRecordTime = 5.0;
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.isEncoding = false;
    }

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        this.ctx.imageSmoothingEnabled = false;

        // Reference resolution 2560x1440 (16:9)
        const refW = 2560;
        const refH = 1440;
        const refMean = Math.sqrt(refW * refH);

        // World uses geometric mean to preserve context across orientations
        const currentMean = Math.sqrt(this.canvas.width * this.canvas.height);
        const meanRatio = currentMean / refMean;

        // UI and HUD use vertical height for consistent readability
        const heightRatio = this.canvas.height / refH;

        let rawWorldScale = 2 * meanRatio;
        const nearestWorldInt = Math.round(rawWorldScale);
        if (nearestWorldInt > 0 && Math.abs(rawWorldScale - nearestWorldInt) / nearestWorldInt <= 0.15) {
            rawWorldScale = nearestWorldInt;
        }
        this.worldScale = Math.max(0.1, rawWorldScale * this.worldScaleModifier);

        // UI and HUD scales should be strictly integers based on height
        this.uiScale = Math.max(1, Math.round(3 * heightRatio));
        this.hudScale = Math.max(1, Math.round(4 * heightRatio));
    }

    get width() { return window.innerWidth; }
    get height() { return window.innerHeight; }


    async init() {
        await this.assets.loadAll(this._getAssetManifest());
        await this.assets.loadAllGifs(this._getGifManifest());

        // Register sound effects
        await Promise.all([
            this.sounds.register('laser', [
                'Assets/Sounds/Effects/laser_ball_1.wav',
                'Assets/Sounds/Effects/laser_ball_2.wav',
                'Assets/Sounds/Effects/laser_ball_3.wav',
                'Assets/Sounds/Effects/laser_ball_4.wav',
            ]),
            this.sounds.register('asteroid_break', [
                'Assets/Sounds/Effects/asteroid_break_1.wav',
                'Assets/Sounds/Effects/asteroid_break_2.wav',
                'Assets/Sounds/Effects/asteroid_break_3.wav',
                'Assets/Sounds/Effects/asteroid_break_4.wav',
                'Assets/Sounds/Effects/asteroid_break_5.wav',
                'Assets/Sounds/Effects/asteroid_break_6.wav',
            ]),
            this.sounds.register('ship_explode', [
                'Assets/Sounds/Effects/ship_explode_1.wav',
                'Assets/Sounds/Effects/ship_explode_2.wav',
                'Assets/Sounds/Effects/ship_explode_3.wav',
            ]),
            this.sounds.register('boost', [
                'Assets/Sounds/Effects/boost_1.wav',
                'Assets/Sounds/Effects/boost_2.wav',
                'Assets/Sounds/Effects/boost_3.wav',
                'Assets/Sounds/Effects/boost_4.wav',
            ]),
            this.sounds.register('dodge', [
                'Assets/Sounds/Effects/dodge_1.wav',
                'Assets/Sounds/Effects/dodge_2.wav',
            ]),
            this.sounds.register('thrust', [
                'Assets/Sounds/Effects/thrust_1.wav',
                'Assets/Sounds/Effects/thrust_2.wav',
                'Assets/Sounds/Effects/thrust_3.wav',
                'Assets/Sounds/Effects/thrust_4.wav',
            ]),
            this.sounds.register('click', [
                'Assets/Sounds/Effects/click.wav',
            ]),
            this.sounds.register('select', [
                'Assets/Sounds/Effects/select.wav',
            ]),
            this.sounds.register('scrap', [
                'Assets/Sounds/Effects/scrap_1.wav',
                'Assets/Sounds/Effects/scrap_2.wav',
                'Assets/Sounds/Effects/scrap_3.wav',
                'Assets/Sounds/Effects/scrap_4.wav',
            ]),
            this.sounds.register('shield', [
                'Assets/Sounds/Effects/shield.wav',
            ]),
            this.sounds.register('shield_break', [
                'Assets/Sounds/Effects/shield_break.wav',
            ]),
            this.sounds.register('hit', [
                'Assets/Sounds/Effects/hit_1.wav',
                'Assets/Sounds/Effects/hit_2.wav',
                'Assets/Sounds/Effects/hit_3.wav',
            ]),
            this.sounds.register('railgun_target', [
                'Assets/Sounds/Effects/railgun_target.wav',
            ]),
            this.sounds.register('railgun_shoot', [
                'Assets/Sounds/Effects/railgun_shoot_1.wav',
                'Assets/Sounds/Effects/railgun_shoot_2.wav',
                'Assets/Sounds/Effects/railgun_shoot_3.wav',
                'Assets/Sounds/Effects/railgun_shoot_4.wav',
            ]),
            this.sounds.register('type', [
                'Assets/Sounds/Effects/type_1.wav',
                'Assets/Sounds/Effects/type_2.wav',
                'Assets/Sounds/Effects/type_3.wav',
                'Assets/Sounds/Effects/type_4.wav',
            ])
        ]);

        this.sounds.registerExplorationMusic([
            'Assets/Sounds/Songs/Exploration/Alone in the Stars.mp3',
            'Assets/Sounds/Songs/Exploration/Blue Shift.mp3',
            'Assets/Sounds/Songs/Exploration/Cosmic Plan.mp3',
            'Assets/Sounds/Songs/Exploration/Distant Nebula.mp3',
            'Assets/Sounds/Songs/Exploration/Gravity Well.mp3',
            'Assets/Sounds/Songs/Exploration/Orbital Daydream.mp3',
            'Assets/Sounds/Songs/Exploration/Pixel Stars.mp3',
            'Assets/Sounds/Songs/Exploration/Slingshot.mp3',
            'Assets/Sounds/Songs/Exploration/Starlight Armada.mp3',
        ]);

        this.sounds.registerCombatMusic([
            'Assets/Sounds/Songs/Combat/Binary Orbit.mp3',
            'Assets/Sounds/Songs/Combat/Direct Hit.mp3',
            'Assets/Sounds/Songs/Combat/Starfield Dogfight.mp3',
            'Assets/Sounds/Songs/Combat/Starfighter Cascade.mp3',
            'Assets/Sounds/Songs/Combat/Warning Lights.mp3',
        ]);

        // Register boss music separately
        this.sounds.registerBossMusic('Starlight Devourer', 'Assets/Sounds/Songs/Boss/Starlight Devourer.mp3');
        this.sounds.registerBossMusic('Derelict Orbit', 'Assets/Sounds/Songs/Boss/Derelict Orbit.mp3');
        this.sounds.registerBossMusic('Asteroid Crusher', 'Assets/Sounds/Songs/Boss/Asteroid Crusher.mp3');
        this.sounds.registerBossMusic('Event Horizon Chase', 'Assets/Sounds/Songs/Boss/Event Horizon Chase.mp3');
        this.sounds.registerBossMusic('Lidless Above the Void', 'Assets/Sounds/Songs/Boss/Lidless Above the Void.mp3');
        this.sounds.registerBossMusic('Starcore Showdown', 'Assets/Sounds/Songs/Boss/Starcore Showdown.mp3');
        this.sounds.registerBossMusic('The Yellow One', 'Assets/Sounds/Songs/Boss/The Yellow One.mp3');

        this.sounds.registerTitleMusic('Assets/Sounds/Songs/Title/NOVA.mp3');
        this.sounds.registerGameOverMusic('Assets/Sounds/Songs/Game Over/Sendoff.mp3');

        this.setState(new MenuState(this));
        this.running = true;
        this.lastTime = performance.now();
        requestAnimationFrame((t) => this.loop(t));
    }

    setState(state) {
        if (this.currentState && this.currentState.exit) {
            this.currentState.exit();
        }
        this.currentState = state;
        if (state.enter) state.enter();

        // One-time interaction to unlock audio for modern browsers
        const unlock = () => {
            this.sounds.unlock();
            window.removeEventListener('mousedown', unlock);
            window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('mousedown', unlock);
        window.addEventListener('keydown', unlock);
    }

    loop(timestamp) {
        if (!this.running) return;

        const dt = Math.min((timestamp - this.lastTime) / 1000, 0.05);
        this.lastTime = timestamp;

        this.input.update();

        // Developer Console Hotkey: d + e + v
        const devPressed = this.input.isKeyDown('KeyD') && this.input.isKeyDown('KeyE') && this.input.isKeyDown('KeyV');
        if (devPressed && !this._devPressedPrev) {
            this.devConsole.toggle();
        }
        this._devPressedPrev = devPressed;

        this.sounds.update(dt);

        // Screenshot/GIF Hotkey: P
        if (this.input.isKeyJustPressed('KeyP') && !this.devConsole.active) {
            this.takeScreenshot();
        }

        if (this.isEncoding) {
            // Game is effectively paused during final blob creation
            this.ctx.save();
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.fillStyle = '#ffffff';
            this.ctx.font = `${6 * this.uiScale}px Astro5x`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.fillText('SAVING CLIP (PLEASE WAIT)...', this.canvas.width / 2, this.canvas.height / 2);
            this.ctx.restore();
            requestAnimationFrame((t) => this.loop(t));
            return;
        }

        if (this.devConsole.active) {
            this.devConsole.update(dt);
        } else if (this.currentState) {
            this.currentState.update(dt);
        }

        // Clear canvas — state can set skipClear to handle its own clearing (motion blur)
        if (!this.currentState || !this.currentState.skipClear) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        }

        if (this.currentState) {
            this.currentState.draw(this.ctx);
        }

        this.devConsole.draw(this.ctx);
        this._drawCrosshair(this.ctx);

        // Handle Recording Timer
        if (this.isRecording) {
            this.recordTimer += dt;

            // Update DOM indicator
            const indicator = document.getElementById('recordingIndicator');
            const timer = document.getElementById('recordingTimer');
            if (indicator && timer) {
                indicator.style.display = 'block';
                timer.innerText = Math.max(0, this.maxRecordTime - this.recordTimer).toFixed(1);
            }

            if (this.recordTimer >= this.maxRecordTime) {
                this.stopRecording();
            }
        } else {
            const indicator = document.getElementById('recordingIndicator');
            if (indicator) indicator.style.display = 'none';
        }

        requestAnimationFrame((t) => this.loop(t));
    }

    // Draw a sprite at a given scale at the given position (in screen pixels)
    drawSprite(ctx, key, x, y, scale = this.uiScale) {
        const img = this.assets.get(key);
        if (!img) return;
        ctx.drawImage(img, Math.floor(x), Math.floor(y), img.width * scale, img.height * scale);
    }

    takeScreenshot() {
        if (!this.recordingEnabled || this.isRecording || this.isEncoding) return;
        this.startRecording();
    }

    startRecording() {
        if (this.isRecording || this.isEncoding) return;

        this.recordedChunks = [];
        const stream = this.canvas.captureStream(30);

        // Try to find a supported mime type
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : 'video/webm';

        this.mediaRecorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });

        this.mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) this.recordedChunks.push(e.data);
        };

        this.mediaRecorder.onstop = async () => {
            this.isRecording = false;
            document.body.classList.remove('recording');

            // Pause immediately to protect the player
            const wasPaused = this.currentState && this.currentState.paused;
            if (this.currentState) this.currentState.paused = true;

            // Wait 2 seconds before starting the "saving" phase
            // This gives the player time to release any keys ('P', movement, etc.)
            this.isEncoding = true;

            setTimeout(async () => {
                try {
                    const blob = new Blob(this.recordedChunks, { type: 'video/webm' });
                    const url = URL.createObjectURL(blob);

                    const link = document.createElement('a');
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                    link.download = `nova_clip_${timestamp}.webm`;
                    link.href = url;
                    link.click();

                    console.log('Video saved:', link.download);

                    // Keep the "SAVING" overlay visible for a bit longer
                    setTimeout(() => {
                        URL.revokeObjectURL(url);
                        this.isEncoding = false;
                        // Game stays paused as per previous user request
                    }, 1000);
                } catch (err) {
                    console.error('Failed to save video:', err);
                    this.isEncoding = false;
                }
            }, 2000);
        };

        this.recordTimer = 0;
        this.isRecording = true;
        document.body.classList.add('recording');
        this.mediaRecorder.start();
        console.log('Video recording started...');
    }

    _captureFrame() {
        // No longer needed
    }

    async stopRecording() {
        if (!this.isRecording || !this.mediaRecorder) return;
        this.mediaRecorder.stop();
    }

    // Draw a sprite centered at (cx, cy) in screen pixels
    drawSpriteCentered(ctx, key, cx, cy, scale = this.uiScale) {
        const img = this.assets.get(key);
        if (!img) return;
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, Math.floor(cx - w / 2), Math.floor(cy - h / 2), w, h);
    }

    // Shared UI Component: Volume Control Row
    // Bar is derived from decBtn/incBtn positions — no barW hint needed.
    drawVolumeRow(ctx, label, volume, decBtn, incBtn) {
        ctx.save();
        const uiScale = this.uiScale;
        const midY = Math.floor(decBtn.y + decBtn.h / 2);
        const barH = Math.floor(decBtn.h * 0.75);

        // --- Label text, vertically centered on the button midline ---
        ctx.font = `${10 * uiScale}px Astro4x`;
        ctx.fillStyle = '#667788';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, decBtn.x - uiScale * 6, midY - 1);

        // --- Arrow buttons ---
        this.drawSprite(ctx, decBtn.hovered ? 'left_arrow_on' : 'left_arrow_off', decBtn.x, decBtn.y, uiScale);
        this.drawSprite(ctx, incBtn.hovered ? 'right_arrow_on' : 'right_arrow_off', incBtn.x, incBtn.y, uiScale);

        // --- Volume bar, centered in the gap between the two buttons ---
        const gapStart = decBtn.x + decBtn.w;
        const gapEnd = incBtn.x;
        const gapW = gapEnd - gapStart;
        const barPad = Math.floor(uiScale * 3);
        const barW = gapW - barPad * 2;
        const barX = gapStart + barPad;
        this._drawVolumeBar(ctx, barX, midY, barW, barH, volume);
        ctx.restore();
    }

    _drawVolumeBar(ctx, x, midY, w, h, val) {
        const segments = 10;
        const segW = Math.floor(w / segments);
        const gap = Math.max(1, Math.floor(this.uiScale * 1));
        const totalRendered = (segW * segments) - gap;
        const leftover = w - totalRendered;
        const startX = x + Math.floor(leftover / 2); // center segments in available width
        const sy = Math.floor(midY - h / 2);

        // Round val to 1 decimal so 0.1+0.1+...+0.1 == 1.0 exactly
        const roundedVal = Math.round(val * 10) / 10;

        // Background rail
        ctx.fillStyle = '#0a101a';
        ctx.fillRect(startX, sy, totalRendered, h);

        for (let i = 0; i < segments; i++) {
            const threshold = (i + 1) / segments;
            const active = threshold <= roundedVal + 0.001;
            const sx = startX + i * segW;

            if (active) {
                ctx.fillStyle = '#44ddff';
                ctx.fillRect(sx, sy, segW - gap, h);
                ctx.fillStyle = '#99eeff';
                ctx.fillRect(sx, sy, segW - gap, Math.max(1, Math.floor(this.uiScale * 1)));
            } else {
                ctx.strokeStyle = '#111827';
                ctx.lineWidth = 1;
                ctx.strokeRect(sx + 0.5, sy + 0.5, segW - gap - 1, h - 1);
            }
        }
    }

    _drawCrosshair(ctx) {
        if (!this.isRecording || this.isEncoding) return;

        const mouse = this.getMousePos();
        const x = Math.floor(mouse.x);
        const y = Math.floor(mouse.y);
        const l = 7; // line length
        const g = 3; // gap from center

        ctx.save();
        
        // 1px black outline (3px wide strips)
        ctx.fillStyle = '#000000';
        // Left
        ctx.fillRect(x - l - g - 1, y - 1, l + 2, 3);
        // Right
        ctx.fillRect(x + g - 1, y - 1, l + 2, 3);
        // Top
        ctx.fillRect(x - 1, y - l - g - 1, 3, l + 2);
        // Bottom
        ctx.fillRect(x - 1, y + g - 1, 3, l + 2);

        // 1px white lines
        ctx.fillStyle = '#ffffff';
        // Left
        ctx.fillRect(x - l - g, y, l, 1);
        // Right
        ctx.fillRect(x + g, y, l, 1);
        // Top
        ctx.fillRect(x, y - l - g, 1, l);
        // Bottom
        ctx.fillRect(x, y + g, 1, l);

        ctx.restore();
    }

    spriteSize(key, scale = this.uiScale) {
        const img = this.assets.get(key);
        if (!img) return { w: 0, h: 0 };
        return { w: img.width * scale, h: img.height * scale };
    }

    getMousePos() {
        return { x: this.input.mouseScreenX, y: this.input.mouseScreenY };
    }

    _getAssetManifest() {
        return {
            // Ships - still
            'cruiser_still': 'Assets/Ships/Cruiser/cruiser_still.png',
            'bruiser_still': 'Assets/Ships/Bruiser/bruiser_still.png',
            'fighter_still': 'Assets/Ships/Fighter/fighter_still.png',
            'looper_still': 'Assets/Ships/Looper/looper_still.png',
            // Ships - jets (thrusting)
            'cruiser_jets': 'Assets/Ships/Cruiser/cruiser_jets.png',
            'bruiser_jets': 'Assets/Ships/Bruiser/bruiser_jets.png',
            'fighter_jets': 'Assets/Ships/Fighter/fighter_jets.png',
            'looper_jets': 'Assets/Ships/Looper/looper_jets.png',
            // Ships - broken pieces
            'fighter_broken_0': 'Assets/Ships/Fighter/fighter_broken_0.png',
            'fighter_broken_1': 'Assets/Ships/Fighter/fighter_broken_1.png',
            'fighter_broken_2': 'Assets/Ships/Fighter/fighter_broken_2.png',
            'fighter_broken_3': 'Assets/Ships/Fighter/fighter_broken_3.png',
            'fighter_broken_4': 'Assets/Ships/Fighter/fighter_broken_4.png',
            'cruiser_broken_0': 'Assets/Ships/Cruiser/cruiser_broken_0.png',
            'cruiser_broken_1': 'Assets/Ships/Cruiser/cruiser_broken_1.png',
            'cruiser_broken_2': 'Assets/Ships/Cruiser/cruiser_broken_2.png',
            'cruiser_broken_3': 'Assets/Ships/Cruiser/cruiser_broken_3.png',
            'cruiser_broken_4': 'Assets/Ships/Cruiser/cruiser_broken_4.png',
            'bruiser_broken_0': 'Assets/Ships/Bruiser/bruiser_broken_0.png',
            'bruiser_broken_1': 'Assets/Ships/Bruiser/bruiser_broken_1.png',
            'bruiser_broken_2': 'Assets/Ships/Bruiser/bruiser_broken_2.png',
            'bruiser_broken_3': 'Assets/Ships/Bruiser/bruiser_broken_3.png',
            'bruiser_broken_4': 'Assets/Ships/Bruiser/bruiser_broken_4.png',
            'looper_broken_0': 'Assets/Ships/Looper/looper_broken_0.png',
            'looper_broken_1': 'Assets/Ships/Looper/looper_broken_1.png',
            'looper_broken_2': 'Assets/Ships/Looper/looper_broken_2.png',
            'looper_broken_3': 'Assets/Ships/Looper/looper_broken_3.png',
            'looper_broken_4': 'Assets/Ships/Looper/looper_broken_4.png',
            // UI
            'title': 'Assets/UI/title.png',
            'start_flight_off': 'Assets/UI/start_flight_off.png',
            'start_flight_on': 'Assets/UI/start_flight_on.png',
            'fly_again_off': 'Assets/UI/fly_again_off.png',
            'fly_again_on': 'Assets/UI/fly_again_on.png',
            'ship_selection_off': 'Assets/UI/ship_selection_off.png',
            'ship_selection_on': 'Assets/UI/ship_selection_on.png',
            'left_arrow_off': 'Assets/UI/left_arrow_button_off.png',
            'left_arrow_on': 'Assets/UI/left_arrow_button_on.png',
            'right_arrow_off': 'Assets/UI/right_arrow_button_off.png',
            'right_arrow_on': 'Assets/UI/right_arrow_button_on.png',
            'pixel_wordmark': 'Assets/UI/pixel_wordmark.png',
            'health_bar_empty': 'Assets/UI/health_bar_empty.png',
            'health_bar_full': 'Assets/UI/health_bar_full.png',
            'shield_bar_empty': 'Assets/UI/shield_bar_empty.png',
            'shield_bar_full': 'Assets/UI/shield_bar_full.png',
            '9_slice_inventory': 'Assets/UI/9_slice_inventory.png',
            'blue_laser_ball': 'Assets/VFX/blue_laser_ball.png',
            'blue_laser_ball_big': 'Assets/VFX/blue_laser_ball_big.png',
            'blue_laser_beam': 'Assets/VFX/blue_laser_beam.png',
            'blue_laser_beam_big': 'Assets/VFX/blue_laser_beam_big.png',
            'blue_laser_beam_targeting': 'Assets/VFX/blue_laser_beam_targeting.png',
            'red_laser_ball': 'Assets/VFX/red_laser_ball.png',
            'red_laser_ball_big': 'Assets/VFX/red_laser_ball_big.png',
            'red_laser_beam': 'Assets/VFX/red_laser_beam.png',
            'red_laser_beam_big': 'Assets/VFX/red_laser_beam_big.png',
            'red_laser_beam_targeting': 'Assets/VFX/red_laser_beam_targeting.png',
            'enemy_ship_0': 'Assets/Ships/Enemy/enemy_ship_0.png',
            'enemy_ship_1': 'Assets/Ships/Enemy/enemy_ship_1.png',
            'enemy_ship_2': 'Assets/Ships/Enemy/enemy_ship_2.png',
            'enemy_ship_3': 'Assets/Ships/Enemy/enemy_ship_3.png',
            'enemy_ship_4': 'Assets/Ships/Enemy/enemy_ship_4.png',
            'cthulhu_ship_0': 'Assets/Ships/Cthulhu/cthulhu_0.png',
            'cthulhu_ship_1': 'Assets/Ships/Cthulhu/cthulhu_1.png',
            'cthulhu_ship_2': 'Assets/Ships/Cthulhu/cthulhu_2.png',
            // Shops
            'shop_0': 'Assets/Shops/shop_0.png',
            'shop_1': 'Assets/Shops/shop_1.png',
            'shop_2': 'Assets/Shops/shop_2.png',
            // Upgrades
            'blink_engine_3x2': 'Assets/Upgrades/blink_engine_3x2.png',
            'small_battery_1x1': 'Assets/Upgrades/small_battery_1x1.png',
            'firing_coordinator_1x1': 'Assets/Upgrades/firing_coordinator_1x1.png',
            'energy_canisters_2x2': 'Assets/Upgrades/energy_canisters_2x2.png',
            'pulse_boosters_2x2': 'Assets/Upgrades/pulse_boosters_2x2.png',
            'field_array_2x2': 'Assets/Upgrades/field_array_2x2.png',
            'auto_turret_3x2': 'Assets/Upgrades/auto_turret_3x2.png',
            'small_boosters_1x2': 'Assets/Upgrades/small_boosters_1x2.png',
            'rockets_2x1': 'Assets/Upgrades/rockets_2x1.png',
            'scrap_drone_1x1': 'Assets/Upgrades/scrap_drone_1x1.png',
            'mechnaical_claw_2x1': 'Assets/Upgrades/mechnaical_claw_2x1.png',
            'shop_map_1x1': 'Assets/Upgrades/shop_map_1x1.png',
            'advanced_locator_2x2': 'Assets/Upgrades/advanced_locator_2x2.png',
            'railgun_4x1': 'Assets/Upgrades/railgun_4x1.png',
            'energy_blaster_3x1': 'Assets/Upgrades/energy_blaster_3x1.png',
            'repeater_4x1': 'Assets/Upgrades/repeater_4x1.png',
            'laser_override_2x2': 'Assets/Upgrades/laser_override_2x2.png',
            'warning_system_1x1': 'Assets/Upgrades/warning_system_1x1.png',
            'radar_frame': 'Assets/UI/radar_frame.png',
            'radar_frame_back': 'Assets/UI/radar_frame_back.png',
            'pulse_jet_2x1': 'Assets/Upgrades/pulse_jet_2x1.png',
            'shield_booster_1x1': 'Assets/Upgrades/shield_booster_1x1.png',
            'targeting_module_2x2': 'Assets/Upgrades/targeting_module_2x2.png',
            'control_module_1x2': 'Assets/Upgrades/control_module_1x2.png',
            'mechanical_engines_2x2': 'Assets/Upgrades/mechanical_engines_2x2.png',
            'multishot_guns_2x1': 'Assets/Upgrades/multishot_guns_2x1.png',
            'high_density_capacitor_1x2': 'Assets/Upgrades/high_density_capacitor_1x2.png',
            'energy_cell_1x2': 'Assets/Upgrades/energy_cell_1x2.png',
            'explosives_unit_3x2': 'Assets/Upgrades/explosives_unit_3x2.png',
            'boost_drive_2x1': 'Assets/Upgrades/boost_drive_2x1.png',
            'momentum_module_1x1': 'Assets/Upgrades/momentum_module_1x1.png',
            'sensor_accelerator_1x1': 'Assets/Upgrades/sensor_accelerator_1x1.png',
            'nanite_tank_2x2': 'Assets/Upgrades/nanite_tank_2x2.png',
            'shield_capacitor_1x2': 'Assets/Upgrades/shield_capacitor_1x2.png',
            'asteroid_accumulator_2x2': 'Assets/Upgrades/asteroid_accumulator_2x2.png',
            // Events
            'cthulhu': 'Assets/Events/cthulhu.png',
            'cargo_ship': 'Assets/Events/cargo_ship.png',
            'fractured_station_0': 'Assets/Events/fractured_station_0.png',
            'fractured_station_1': 'Assets/Events/fractured_station_1.png',
            'fractured_station_2': 'Assets/Events/fractured_station_2.png',
            // Encounter Ships
            'encounter_cargo_trader_1': 'Assets/Ships/Encounter/cargo_trader_1.png',
            'encounter_cargo_trader_2': 'Assets/Ships/Encounter/cargo_trader_2.png',
            'encounter_civilian_1': 'Assets/Ships/Encounter/civilian_1.png',
            'encounter_civilian_2': 'Assets/Ships/Encounter/civilian_2.png',
            'encounter_civilian_3': 'Assets/Ships/Encounter/civilian_3.png',
            'encounter_colony_1': 'Assets/Ships/Encounter/colony_1.png',
            'encounter_colony_2': 'Assets/Ships/Encounter/colony_2.png',
            'encounter_colony_3': 'Assets/Ships/Encounter/colony_3.png',
            'encounter_engineer_1': 'Assets/Ships/Encounter/engineer_1.png',
            'encounter_engineer_2': 'Assets/Ships/Encounter/engineer_2.png',
            'encounter_engineer_3': 'Assets/Ships/Encounter/engineer_3.png',
            'encounter_engineer_4': 'Assets/Ships/Encounter/engineer_4.png',
            'encounter_explorer_1': 'Assets/Ships/Encounter/explorer_1.png',
            'encounter_explorer_2': 'Assets/Ships/Encounter/explorer_2.png',
            'encounter_junker_1': 'Assets/Ships/Encounter/junker_1.png',
            'encounter_junker_2': 'Assets/Ships/Encounter/junker_2.png',
            'encounter_law_enforcement_1': 'Assets/Ships/Encounter/law_enforcement_1.png',
            'encounter_law_enforcement_2': 'Assets/Ships/Encounter/law_enforcement_2.png',
            'encounter_black_market_1': 'Assets/Ships/Encounter/black_market_1.png',
            'encounter_black_market_2': 'Assets/Ships/Encounter/black_market_2.png',
            'encounter_black_market_3': 'Assets/Ships/Encounter/black_market_3.png',
            'encounter_tuner_1': 'Assets/Ships/Encounter/tuner_1.png',
            'encounter_tuner_2': 'Assets/Ships/Encounter/tuner_2.png',
            // Space backgrounds
            'starfield_0': 'Assets/Space/starfield_0.png',
            'starfield_1': 'Assets/Space/starfield_1.png',
            'starfield_2': 'Assets/Space/starfield_2.png',
            'starfield_3': 'Assets/Space/starfield_3.png',
            'starfield_4': 'Assets/Space/starfield_4.png',
            'starfield_5': 'Assets/Space/starfield_5.png',
            'starfield_6': 'Assets/Space/starfield_6.png',
            'starfield_7': 'Assets/Space/starfield_7.png',
            'big_star': 'Assets/Space/big_star.png',
            'nebula': 'Assets/Space/nebula.png',
            'galaxy': 'Assets/Space/galaxy.png',
            'star_0': 'Assets/Space/star_0.png',
            'star_1': 'Assets/Space/star_1.png',
            'star_2': 'Assets/Space/star_2.png',
            'star_3': 'Assets/Space/star_3.png',
            'star_4': 'Assets/Space/star_4.png',
            'star_5': 'Assets/Space/star_5.png',
            'star_6': 'Assets/Space/star_6.png',
            'star_7': 'Assets/Space/star_7.png',
            'star_8': 'Assets/Space/star_8.png',
            'star_9': 'Assets/Space/star_9.png',
            'star_10': 'Assets/Space/star_10.png',
            // Bosses
            'starcore': 'Assets/Ships/Bosses/Starcore/starcore.png',
            'asteroid_crusher': 'Assets/Ships/Bosses/Asteroid_Crusher/asteroid_crusher.png',
            // Shield overlay
            'shield': 'Assets/Ships/shield.png',
            // Asteroids
            'asteroid_big_0': 'Assets/Asteroids/asteroid_big_0.png',
            'asteroid_big_1': 'Assets/Asteroids/asteroid_big_1.png',
            'asteroid_big_2': 'Assets/Asteroids/asteroid_big_2.png',
            'asteroid_medium_0': 'Assets/Asteroids/asteroid_medium_0.png',
            'asteroid_medium_1': 'Assets/Asteroids/asteroid_medium_1.png',
            'asteroid_medium_2': 'Assets/Asteroids/asteroid_medium_2.png',
            'asteroid_small_0': 'Assets/Asteroids/asteroid_small_0.png',
            'asteroid_small_1': 'Assets/Asteroids/asteroid_small_1.png',
            'asteroid_tiny_00': 'Assets/Asteroids/asteroid_tiny_00.png',
            'asteroid_tiny_01': 'Assets/Asteroids/asteroid_tiny_01.png',
            'asteroid_tiny_02': 'Assets/Asteroids/asteroid_tiny_02.png',
            'asteroid_tiny_03': 'Assets/Asteroids/asteroid_tiny_03.png',
            'asteroid_tiny_04': 'Assets/Asteroids/asteroid_tiny_04.png',
            'asteroid_tiny_05': 'Assets/Asteroids/asteroid_tiny_05.png',
            'asteroid_tiny_06': 'Assets/Asteroids/asteroid_tiny_06.png',
            'asteroid_tiny_07': 'Assets/Asteroids/asteroid_tiny_07.png',
            'asteroid_tiny_08': 'Assets/Asteroids/asteroid_tiny_08.png',
            'asteroid_tiny_09': 'Assets/Asteroids/asteroid_tiny_09.png',
            'asteroid_tiny_10': 'Assets/Asteroids/asteroid_tiny_10.png',
            'asteroid_tiny_11': 'Assets/Asteroids/asteroid_tiny_11.png',
            'asteroid_tiny_12': 'Assets/Asteroids/asteroid_tiny_12.png',
            'asteroid_tiny_13': 'Assets/Asteroids/asteroid_tiny_13.png',
            'asteroid_tiny_14': 'Assets/Asteroids/asteroid_tiny_14.png',
            'asteroid_tiny_15': 'Assets/Asteroids/asteroid_tiny_15.png',
            'asteroid_tiny_16': 'Assets/Asteroids/asteroid_tiny_16.png',
            'asteroid_tiny_17': 'Assets/Asteroids/asteroid_tiny_17.png',
            'asteroid_tiny_18': 'Assets/Asteroids/asteroid_tiny_18.png',
            'asteroid_tiny_19': 'Assets/Asteroids/asteroid_tiny_19.png',
            'asteroid_tiny_20': 'Assets/Asteroids/asteroid_tiny_20.png',
            'asteroid_tiny_21': 'Assets/Asteroids/asteroid_tiny_21.png',
            'asteroid_tiny_22': 'Assets/Asteroids/asteroid_tiny_22.png',
            'asteroid_tiny_23': 'Assets/Asteroids/asteroid_tiny_23.png',
            'asteroid_tiny_24': 'Assets/Asteroids/asteroid_tiny_24.png',
            // Rubble (sample — load a subset for variety)
            'rubble_00': 'Assets/Asteroids/rubble_00.png',
            'rubble_01': 'Assets/Asteroids/rubble_01.png',
            'rubble_02': 'Assets/Asteroids/rubble_02.png',
            'rubble_03': 'Assets/Asteroids/rubble_03.png',
            'rubble_04': 'Assets/Asteroids/rubble_04.png',
            'rubble_05': 'Assets/Asteroids/rubble_05.png',
            'rubble_06': 'Assets/Asteroids/rubble_06.png',
            'rubble_07': 'Assets/Asteroids/rubble_07.png',
            'rubble_08': 'Assets/Asteroids/rubble_08.png',
            'rubble_09': 'Assets/Asteroids/rubble_09.png',
            'rubble_10': 'Assets/Asteroids/rubble_10.png',
            'rubble_11': 'Assets/Asteroids/rubble_11.png',
            // Scrap
            'big_scrap_0': 'Assets/Scrap/big_scrap_0.png',
            'big_scrap_1': 'Assets/Scrap/big_scrap_1.png',
            'big_scrap_2': 'Assets/Scrap/big_scrap_2.png',
            'big_scrap_3': 'Assets/Scrap/big_scrap_3.png',
            'big_scrap_4': 'Assets/Scrap/big_scrap_4.png',
            'scrap_00': 'Assets/Scrap/scrap_00.png',
            'scrap_01': 'Assets/Scrap/scrap_01.png',
            'scrap_02': 'Assets/Scrap/scrap_02.png',
            'scrap_03': 'Assets/Scrap/scrap_03.png',
            'scrap_04': 'Assets/Scrap/scrap_04.png',
            'scrap_05': 'Assets/Scrap/scrap_05.png',
            'scrap_06': 'Assets/Scrap/scrap_06.png',
            'scrap_07': 'Assets/Scrap/scrap_07.png',
            'scrap_08': 'Assets/Scrap/scrap_08.png',
            'scrap_09': 'Assets/Scrap/scrap_09.png',
            'scrap_10': 'Assets/Scrap/scrap_10.png',
            'scrap_11': 'Assets/Scrap/scrap_11.png',
            'scrap_12': 'Assets/Scrap/scrap_12.png',
            'scrap_13': 'Assets/Scrap/scrap_13.png',
            'scrap_14': 'Assets/Scrap/scrap_14.png',
            'scrap_15': 'Assets/Scrap/scrap_15.png',
            'scrap_16': 'Assets/Scrap/scrap_16.png',
            'scrap_17': 'Assets/Scrap/scrap_17.png',
            'scrap_18': 'Assets/Scrap/scrap_18.png',
            'scrap_19': 'Assets/Scrap/scrap_19.png',
            'scrap_20': 'Assets/Scrap/scrap_20.png',
            'scrap_21': 'Assets/Scrap/scrap_21.png',
            'scrap_22': 'Assets/Scrap/scrap_22.png',
            'scrap_23': 'Assets/Scrap/scrap_23.png',
            'scrap_24': 'Assets/Scrap/scrap_24.png',
            'scrap_25': 'Assets/Scrap/scrap_25.png',
            'scrap_26': 'Assets/Scrap/scrap_26.png',
            'scrap_27': 'Assets/Scrap/scrap_27.png',
            'scrap_28': 'Assets/Scrap/scrap_28.png',
        };
    }

    _getGifManifest() {
        return {
            'fire_explosion': 'Assets/VFX/fire_explosion.gif',
            'blue_laser_explosion': 'Assets/VFX/blue_laser_explosion.gif',
            'cruiser_flying': 'Assets/Ships/Cruiser/cruiser_flying.gif',
            'bruiser_flying': 'Assets/Ships/Bruiser/bruiser_flying.gif',
            'fighter_flying': 'Assets/Ships/Fighter/fighter_flying.gif',
            'looper_flying': 'Assets/Ships/Looper/looper_flying.gif',
            'cthulhu_wake': 'Assets/Events/cthulhu_wake.gif',
            'knowledge_eye': 'Assets/Events/knowledge_eye.gif',
            'obedience_1x1': 'Assets/Upgrades/obedience_1x1.gif',
            'sacrifice_1x2': 'Assets/Upgrades/sacrifice_1x2.gif',
            'knowledge_1x1': 'Assets/Upgrades/knowledge_1x1.gif',
            'ancient_curse_2x2': 'Assets/Upgrades/ancient_curse_2x2.gif',
        };
    }

    /**
     * Gets the current frame for an asset (handle both static and GIF).
     * @param {string} key Asset key.
     * @returns {HTMLImageElement|HTMLCanvasElement|null} Current frame image/canvas.
     */
    getAnimationFrame(key) {
        const asset = this.assets.get(key);
        if (!asset) return null;

        if (Array.isArray(asset)) {
            // It's a GIF frame array. Calculate frame based on time.
            const totalDelay = asset.reduce((sum, frame) => sum + frame.delay, 0);
            let timeMs = performance.now() % totalDelay;
            for (const frame of asset) {
                if (timeMs < frame.delay) return frame.canvas;
                timeMs -= frame.delay;
            }
            return asset[asset.length - 1].canvas;
        }

        return asset;
    }
}
