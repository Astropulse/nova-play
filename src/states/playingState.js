// Dynamic scaling via game properties
import { PerfProfiler } from '../engine/perfProfiler.js';
import { World } from '../world/world.js';
import { Camera } from '../world/camera.js';
import { Player } from '../entities/player.js';
import { HUD } from '../ui/hud.js';
import { Asteroid, AsteroidSpawner, Rubble, Scrap, ItemPickup, ProceduralDebris, VoronoiSlicer, ExpOrb } from '../entities/asteroid.js';
import { EnemySpawner, Enemy, HostileEncounter } from '../entities/enemy.js';
import { Shop } from '../entities/shop.js';
import { Inventory } from '../engine/inventory.js';
import { UPGRADES, RARITY_COLORS } from '../data/upgrades.js';
import { CthulhuEvent, CTHULHU_STATE } from '../entities/cthulhuEvent.js';
import { CargoShipEvent, CARGO_SHIP_STATE } from '../entities/cargoShipEvent.js';
import { FracturedStationEvent } from '../entities/fracturedStationEvent.js';
import { KnowledgeEvent, KNOWLEDGE_STATE } from '../entities/knowledgeEvent.js';
import { Projectile } from '../entities/projectile.js';
import { Starcore } from '../entities/starcore.js';
import { AsteroidCrusher } from '../entities/asteroidCrusher.js';
import { EventHorizon } from '../entities/eventHorizon.js';
import { YellowOne, YO_STATE } from '../entities/yellowOne.js';
import { MenuState } from './menuState.js';
import { FloatingText } from '../entities/floatingText.js';
import { MUSIC_STATE } from '../engine/soundManager.js';
import { BOSS_STATE } from '../entities/boss.js';
import { EncounterShip, ENC_STATE } from '../entities/encounter.js';
import { rollEncounterType, generateEncounterDialog } from '../data/encounters.js';
import { EncounterDialog } from '../ui/encounterDialog.js';
import { SpaceCache, CacheSpawner, CACHE_STATE, CACHE_CONFIG } from '../entities/spaceCache.js';
import { CacheUI } from '../ui/cacheUI.js';
import { LevelUpDialog } from '../ui/levelUpDialog.js';

export class PlayingState {
    constructor(game, shipData, { skipInit = false } = {}) {
        this.game = game;
        this.shipData = shipData;
        this.paused = false;
        this.skipClear = false;

        this.camera = new Camera(game);
        this.world = new World(game, Math.floor(Math.random() * 1000000));
        this.player = new Player(game, shipData);
        this.hud = new HUD(game, this.player);

        // Entity lists
        this.projectiles = [];
        this.asteroids = [];
        this.enemies = [];
        this.rubble = [];
        this.scrapEntities = [];
        this.itemPickups = [];
        this.activeBeams = []; // specific fx
        this.explosions = []; // area fx
        this.events = [];
        this.expOrbs = [];
        // Encounter system
        this.encounters = [];
        this.encounterSpawnTimer = 60 + Math.random() * 10; // First encounter around ~1 minute
        this.isEncounterOpen = false;
        this.activeEncounterDialog = null;
        this.canInteractEncounter = false;
        this.playerDistanceTraveled = 0;
        this._lastPlayerX = 0;
        this._lastPlayerY = 0;
        this.encounterBonuses = { speedMult: 1.0, fireRateMult: 1.0, turnMult: 1.0 };

        this.particles = [];
        this.floatingTexts = [];

        this.asteroidSpawner = new AsteroidSpawner(game);
        this.enemySpawner = new EnemySpawner(game);
        this.cacheSpawner = new CacheSpawner(game);

        // Level-up dialog queue
        this.levelUpQueue        = [];
        this.isLevelUpOpen       = false;
        this.activeLevelUpDialog = null;
        this._levelUpOrigin      = null; // 'pause' | 'cache' | 'shop'

        // Space Caches
        this.caches = [];
        this.activeCacheUI  = null;
        this.isCacheOpen    = false;
        this.canInteractCache = false;
        this._activeCache   = null;  // cache whose UI is currently open
        this._pendingCache  = null;  // cache mid-opening animation (UI not shown yet)
        this.cacheScrollX   = 0;
        this.cacheScrollY   = 0;

        // Inventory
        this.inventoryImg = game.assets.get('9_slice_inventory');
        this.inventoryBorderImg = game.assets.get('9_slice_inventory_border');
        this.shopScrollX = 0;
        this.shopScrollY = 0;
        this.playerScrollX = 0;
        this.playerScrollY = 0;
        this.draggingScrollbar = null;
        this.inventoryCols = shipData.storage.cols;
        this.inventoryRows = shipData.storage.rows;

        // Shops
        this.shops = [];
        this.revealedShops = []; // Queue for radar limit (max 3)
        if (!skipInit) {
            this._spawnInitialShops();
            this._spawnEvents();
            this._spawnInitialAsteroids();
        }

        // Player Inventory instance
        this.player.inventory = new Inventory(this.inventoryCols, this.inventoryRows);
        this.player.inventory.isPlayerInventory = true;
        this.player.inventory.playingState = this;

        // Ensure initial stats are synced (e.g. if ship starts with items)
        this._onInventoryChanged();

        // Shop UI state
        this.activeShop = null;
        this.isShopOpen = false;

        // Drag and drop state for shop/inventory
        this.draggedItem = null; // { item, originInventory, offsetX, offsetY, rotated }

        // Scaling Difficulty & Waves
        this.totalGameTime = 0;
        this.trueTotalTime = 0; // Persistent game time
        this.waveTimer = 120; // 2 minutes
        this.difficultyScale = 1.0;

        // Tunable Difficulty Constants
        this.difficultyRampTime = 240; // 4 minutes (transition to linear)
        this.difficultyExponent = 1.55; // Starts slow, curves up (convex)
        this.difficultyGain = 0.000366; // Calculated for smooth transition at 4m
        this.difficultySteadyRate = 0.013; // Steady linear growth after ramp

        this.flashTimer = 0;

        // Music System Overhaul State
        this.musicCombatTriggered = false;
        this.postWaveTimer = 0;
        this.quietTimer = 0;

        // Stats tracking
        this.stats = {
            asteroidsDestroyed: 0,
            enemiesDefeated: 0,
            wavesCleared: 0,
            scrapCollected: 0,
            shopsUnlocked: 1,
            eventsDiscovered: 0
        };

        this.lastIsEventActive = false;
        this.eventBufferTimer = 0;

        // Yellow One boss fight state
        this.yellowOneFightActive = false;
        this.yellowOneScriptActive = false;
        this.yellowOneDeathScreen = false;
        this.yellowOneEnraged = false;

        // Death state
        this.isDead = false;
        this.deathTimer = 0;
        this.showDeathScreen = false;
        this.shipDebris = [];
        this.deathScreenButtons = {
            flyAgain: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            shipSelection: { x: 0, y: 0, w: 0, h: 0, hovered: false }
        };
        this.pauseButtons = {
            musicDec: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            musicInc: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            sfxDec: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            sfxInc: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            shipSelection: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            claimLevels: { x: 0, y: 0, w: 0, h: 0, hovered: false }
        };
        this.confirmRestart = false;
        this.confirmRestartButtons = {
            yes: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            no: { x: 0, y: 0, w: 0, h: 0, hovered: false }
        };
        this.bossDeathImmunityTimer = 0;
        this.bossWrecks = [];

        // FOV Scaling state
        this.fovUpgradeMult = 1.0;
        this.currentFovMult = 1.0;

        // Off-screen indicator radii
        this.indicatorRadiusFactorArrow = 0.36;
        this.indicatorRadiusFactorExclamation = 0.42;

        this.indicatorOpacities = new Map(); // entity -> { opacity }

        // Performance profiler (dev mode only)
        this.perf = new PerfProfiler();

        // Pre-create ExpOrb glow frames so they're ready before first use.
        const expAsset = game.assets.get('exp');
        if (expAsset && Array.isArray(expAsset)) {
            for (const frame of expAsset) {
                const f = frame.canvas || frame;
                if (f) ExpOrb._getGlowForFrame(f);
            }
        }

        // Also pre-create projectile glow sprites for all variants
        const projGlowKeys = [
            ['blue_laser_ball', '#1da2c0ff'],
            ['blue_laser_ball_big', '#1da2c0ff'],
            ['red_laser_ball', '#ff4444'],
            ['red_laser_ball_big', '#ff4444'],
        ];
        for (const [key, color] of projGlowKeys) {
            const asset = game.assets.get(key);
            if (asset) Projectile._getGlowSprite(asset, color);
        }
    }

    // In-place removal of dead entities — avoids allocating a new array every frame
    _compactAlive(arr) {
        let write = 0;
        for (let read = 0; read < arr.length; read++) {
            if (arr[read].alive) {
                if (write !== read) arr[write] = arr[read];
                write++;
            }
        }
        arr.length = write;
    }

    _triggerShakeAt(x, y, intensity, minPassDist = 1200, maxDist = 4000) {
        const dx = x - this.player.worldX;
        const dy = y - this.player.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist >= maxDist) return;

        let finalIntensity = intensity;
        if (dist > minPassDist) {
            const attenuation = 1.0 - ((dist - minPassDist) / (maxDist - minPassDist));
            finalIntensity *= attenuation;
        }

        if (finalIntensity > 0.1) {
            this.camera.shake(finalIntensity);
        }
    }

    enter() {
        document.body.classList.add('playing');
        this.game.sounds.startMusic();
        this.game.camera = this.camera;
    }

    exit() {
        document.body.classList.remove('playing');
        this.game.camera = null;
    }

    _spawnInitialShops() {
        // First shop near spawn, always revealed
        const s1 = new Shop(this.game, 400, 400);
        this.shops.push(s1);
        this._revealShop(s1);
    }

    _spawnEvents() {
        // Spawn Cthulhu very far away
        const angle = Math.random() * Math.PI * 2;
        const dist = 20000 + Math.random() * 10000;
        const cx = Math.cos(angle) * dist;
        const cy = Math.sin(angle) * dist;

        const cthulhu = new CthulhuEvent(this.game, cx, cy);
        this.events.push(cthulhu);

        // Spawn Cargo Ship Event
        const cargoAngle = Math.random() * Math.PI * 2;
        const cargoDist = 3000 + Math.random() * 3000;
        const csx = Math.cos(cargoAngle) * cargoDist;
        const csy = Math.sin(cargoAngle) * cargoDist;

        const cargoShip = new CargoShipEvent(this.game, csx, csy);
        this.events.push(cargoShip);

        // Spawn Fractured Station Event
        // Station 1: Randomized distance for discovery
        const f1Angle = Math.random() * Math.PI * 2;
        const f1Dist = 4000 + Math.random() * 2000;
        const f1x = Math.cos(f1Angle) * f1Dist;
        const f1y = Math.sin(f1Angle) * f1Dist;

        // Station 2: Medium distance
        const f2Angle = Math.random() * Math.PI * 2;
        const f2Dist = 6000 + Math.random() * 2000;
        const f2x = Math.cos(f2Angle) * f2Dist;
        const f2y = Math.sin(f2Angle) * f2Dist;

        // Station 3: Far away
        const f3Angle = Math.random() * Math.PI * 2;
        const f3Dist = 15000 + Math.random() * 5000;
        const f3x = Math.cos(f3Angle) * f3Dist;
        const f3y = Math.sin(f3Angle) * f3Dist;

        this.events.push(new FracturedStationEvent(this.game, [
            { x: f1x, y: f1y },
            { x: f2x, y: f2y },
            { x: f3x, y: f3y }
        ]));

        // Spawn Knowledge Event (Extreme distance)
        const kAngle = Math.random() * Math.PI * 2;
        const kDist = 30000 + Math.random() * 15000;
        const kx = Math.cos(kAngle) * kDist;
        const ky = Math.sin(kAngle) * kDist;
        this.events.push(new KnowledgeEvent(this.game, kx, ky));

        // Spawn Yellow One (Extreme distance, opposite direction from Knowledge)
        const yoAngle = kAngle + Math.PI + (Math.random() - 0.5) * 1.0;
        const yoDist = 35000 + Math.random() * 15000;
        const yox = Math.cos(yoAngle) * yoDist;
        const yoy = Math.sin(yoAngle) * yoDist;
        this.events.push(new YellowOne(this.game, yox, yoy));
    }

    _spawnInitialAsteroids() {
        const numAsteroids = 6 + Math.floor(Math.random() * 8); // Reduced from 18-35 to 6-13
        for (let i = 0; i < numAsteroids; i++) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 400 + Math.random() * 2500; // Wider initial spread
            // Player starts near 0,0, but using their actual pos is safest
            const ax = this.player.worldX + Math.cos(angle) * dist;
            const ay = this.player.worldY + Math.sin(angle) * dist;

            const roll = Math.random();
            let size = 'medium';
            if (roll < 0.05) size = 'big'; // reduced from 0.15 to 0.05
            else if (roll < 0.45) size = 'small';
            else if (roll < 0.60) size = 'tiny';

            let vx = 0, vy = 0;
            if (Math.random() > 0.5) {
                const driftAngle = Math.random() * Math.PI * 2;
                const speed = 10 + Math.random() * 20;
                vx = Math.cos(driftAngle) * speed;
                vy = Math.sin(driftAngle) * speed;
            }

            this.asteroids.push(new Asteroid(this.game, ax, ay, size, vx, vy));
        }
    }



    exit() {
        document.body.classList.remove('playing');
    }

    update(dt) {
        // Increment true total time only if not paused, not in shop, and not dead
        if (!this.paused && !this.isShopOpen && !this.isEncounterOpen && !this.isCacheOpen && !this.isLevelUpOpen && !this.isDead) {
            this.trueTotalTime += dt;
        }

        // --- Death sequence ---
        if (this.isDead) {
            // Keep Yellow One updating during its scripted death sequence
            if (this.yellowOneDeathScreen) {
                for (const ev of this.events) {
                    if (ev instanceof YellowOne && ev.state === YO_STATE.SCRIPTED) {
                        ev.update(dt, this.player);
                    }
                }
            }

            if (this.showDeathScreen) {
                if (!this.yellowOneDeathScreen) {
                    this._updateDeathScreen(dt);
                }
                // During Yellow One death: show the screen but block button clicks
            } else {
                this.deathTimer += dt;
                // Update debris drift
                for (const d of this.shipDebris) d.update(dt);
                // Also update rubble so it keeps drifting
                for (const r of this.rubble) r.update(dt);
                if (this.deathTimer >= 3.0) {
                    this.showDeathScreen = true;
                    if (!this.yellowOneDeathScreen) {
                        this.game.sounds.playGameOverMusic();
                    }
                }
            }
            return;
        }

        // --- Level-up dialog ---
        if (this.isLevelUpOpen && this.activeLevelUpDialog) {
            this.activeLevelUpDialog.update(dt);
            if (this.activeLevelUpDialog.closed) {
                this.isLevelUpOpen       = false;
                this.activeLevelUpDialog = null;
                if (this.levelUpQueue.length > 0) {
                    this._openLevelUpDialog(this.levelUpQueue.shift());
                } else {
                    // Return to pause menu if that's where we came from;
                    // cache/shop contexts manage paused via isCacheOpen/isShopOpen.
                    this.paused = (this._levelUpOrigin === 'pause');
                    this._levelUpOrigin = null;
                }
            }
            return;
        }

        // --- Encounter Dialog ---
        if (this.isEncounterOpen && this.activeEncounterDialog) {
            this.activeEncounterDialog.update(dt);
            if (this.activeEncounterDialog.closed) {
                const enc = this.activeEncounterDialog.encounter;
                this.isEncounterOpen = false;
                this.paused = false;
                if (enc.shouldConvertHostile) {
                    this._convertEncounterToEnemy(enc);
                } else if (!enc.shouldStay) {
                    enc.depart();
                }

                // Clear the stay flag for next time it's approached
                enc.shouldStay = false;
                this.activeEncounterDialog = null;
            }
            return;
        }

        // --- Cache UI ---
        if (this.isCacheOpen && this.activeCacheUI) {
            this._updateCacheUI(dt);
            return;
        }

        if (this.isShopOpen) {
            this._updateShopUI(dt);
            return;
        }

        // Shop interaction check (moved up for input handling priority)
        const nearShop = this.shops.find(s => {
            const dx = s.worldX - this.player.worldX;
            const dy = s.worldY - this.player.worldY;
            return dx * dx + dy * dy < s.interactRange * s.interactRange;
        });
        this.canInteractShop = !!nearShop;

        // Encounter interaction check
        const nearEncounter = this.encounters.find(enc => {
            if (enc.state === ENC_STATE.DEPARTING || enc.state === ENC_STATE.HOSTILE) return false;
            const dx = enc.worldX - this.player.worldX;
            const dy = enc.worldY - this.player.worldY;
            return dx * dx + dy * dy < enc.interactRange * enc.interactRange;
        });
        this.canInteractEncounter = !!nearEncounter;

        // Cache interaction check
        const nearCache = this.caches.find(c => {
            if (!c.canInteract) return false;
            const dx = c.worldX - this.player.worldX;
            const dy = c.worldY - this.player.worldY;
            return dx * dx + dy * dy < c.interactRange * c.interactRange;
        });
        this.canInteractCache = !!nearCache;

        if (this.game.input.isKeyJustPressed('Escape')) {
            if (this.paused) {
                // About to unpause, return dragged item
                if (this.draggedItem) {
                    this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                    this._onInventoryChanged();
                    this.draggedItem = null;
                }
            }
            this.paused = !this.paused;
            this.game.sounds.play('click', 0.5);
        }

        if (this.game.input.isKeyJustPressed('KeyE')) {
            if (nearEncounter) {
                // Prioritize encounter interaction
                this._openEncounterDialog(nearEncounter);
            } else if (nearCache) {
                if (nearCache.state === CACHE_STATE.OPEN) {
                    // Chest already open — show the UI immediately
                    this._openCacheUI(nearCache);
                } else {
                    // FOUND state: kick off the opening animation.
                    // The UI will appear once the animation completes.
                    nearCache.open();
                    this._pendingCache = nearCache;
                }
            } else if (nearShop) {
                // Shop interaction
                this.activeShop = nearShop;
                this.isShopOpen = true;
                this.paused = true;
                this.game.sounds.play('click', 0.5);
            } else {
                // Otherwise toggle pause
                if (this.paused) {
                    // About to unpause, return dragged item
                    if (this.draggedItem) {
                        this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                        this._onInventoryChanged();
                        this.draggedItem = null;
                    }
                }
                this.paused = !this.paused;
                this.game.sounds.play('click', 0.5);
            }
        }

        if (this.paused) {
            this._updatePauseUI(dt);
            return;
        }

        // Update player (freeze during Yellow One scripted sequence)
        this.perf.begin('player');
        if (!this.yellowOneScriptActive) {
            this.player.update(dt);
        }
        this.perf.end('player');
        this.game.sounds.setListenerPosition(this.player.worldX, this.player.worldY);

        // --- Event Update ---
        let isEventActive = false;
        for (const ev of this.events) {
            const wasRevealed = ev.revealed;
            ev.update(dt, this.player);
            if (!wasRevealed && ev.revealed && !ev.discovered) {
                ev.discovered = true;
                this.stats.eventsDiscovered++;
            }
            if (ev.isActive) {
                const edx = ev.worldX - this.player.worldX;
                const edy = ev.worldY - this.player.worldY;
                if (edx * edx + edy * edy < 25000000) { // 5000^2
                    isEventActive = true;
                }
            }
            if (ev.popEnemies) {
                const newEnemies = ev.popEnemies();
                if (newEnemies.length > 0) {
                    this.enemies.push(...newEnemies);
                }
            } else if (ev.activeEnemies && ev.activeEnemies.length > 0) {
                // Add event enemies to the main list so they get drawn and hit by player projectiles
                this.enemies.push(...ev.activeEnemies);
                ev.activeEnemies = [];
            }
            if (ev.popSpawns) {
                const spawns = ev.popSpawns();
                for (const s of spawns) {
                    if (s instanceof Scrap) { if (this.scrapEntities.length < 200) this.scrapEntities.push(s); }
                    else if (s instanceof Rubble || s instanceof ProceduralDebris) { if (this.rubble.length < 250) this.rubble.push(s); }
                    else if (s instanceof Asteroid) this.asteroids.push(s);
                    else if (s instanceof ItemPickup) this.itemPickups.push(s);
                    else if (s instanceof ExpOrb) { if (this.expOrbs.length < 150) this.expOrbs.push(s); }
                }
            }
        }

        if (this.lastIsEventActive && !isEventActive) {
            this.eventBufferTimer = 6.0;
        }
        this.lastIsEventActive = isEventActive;

        // --- Active Upgrades Logic ---
        // Rockets
        if (this.hasRockets) {
            this.player.rocketsTimer = (this.player.rocketsTimer || 0) - dt;
            if (this.player.rocketsTimer <= 0) {
                let target = null;
                let minDist = 1500;

                for (const en of this.enemies) {
                    if (!en.alive) continue;
                    const edx = en.worldX - this.player.worldX;
                    const edy = en.worldY - this.player.worldY;
                    const edist = Math.sqrt(edx * edx + edy * edy);
                    if (edist < minDist) {
                        target = en;
                        minDist = edist;
                    }
                }

                if (!target) {
                    for (const ast of this.asteroids) {
                        if (!ast.alive) continue;
                        const adx = ast.worldX - this.player.worldX;
                        const ady = ast.worldY - this.player.worldY;
                        const adist = Math.sqrt(adx * adx + ady * ady);
                        if (adist < minDist) {
                            target = ast;
                            minDist = adist;
                        }
                    }
                }
                if (!target) {
                    for (const ev of this.events) {
                        if (!ev.isAttackable) continue;
                        const edx = ev.worldX - this.player.worldX;
                        const edy = ev.worldY - this.player.worldY;
                        const edist = Math.sqrt(edx * edx + edy * edy);
                        if (edist < minDist) {
                            target = ev;
                            minDist = edist;
                        }
                    }
                }

                if (target) {
                    const aimAngle = Math.atan2(target.worldY - this.player.worldY, target.worldX - this.player.worldX);
                    // Increased damage and applied modifiers
                    const currentBaseDamage = (this.player.shipData.baseDamage * this.player.obedienceMult + this.player.permDamageBonus) * this.player.laserCartridgeMult;
                    const damage = (currentBaseDamage * 3.0) * (this.player.hasLaserOverride ? 1.3 : 1.0);
                    const spriteKey = 'blue_laser_ball_big';

                    const proj = new Projectile(this.game, this.player.worldX, this.player.worldY, aimAngle, 1200, spriteKey, this.player, damage);
                    proj.isRocket = true;
                    proj.target = target;
                    this.projectiles.push(proj);
                    this.game.sounds.play('laser', { volume: 0.4, x: this.player.worldX, y: this.player.worldY });
                    this.player.rocketsTimer = 3.0;
                }
            }
        }

        // Auto Turret
        if (this.hasAutoTurret) {
            this.player.autoTurretTimer -= dt;
            if (this.player.autoTurretTimer <= 0) {
                // Find enemy in 50 deg cone
                const turretAngle = this.player.angle;
                const turretCone = 50 * (Math.PI / 180);

                let target = null;
                let minDist = 800;

                // Check Enemies
                for (const en of this.enemies) {
                    if (!en.alive) continue;
                    const edx = en.worldX - this.player.worldX;
                    const edy = en.worldY - this.player.worldY;
                    const edist = Math.sqrt(edx * edx + edy * edy);
                    if (edist < minDist) {
                        const angleToEn = Math.atan2(edy, edx);
                        let diff = angleToEn - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = en;
                            minDist = edist;
                        }
                    }
                }

                // Check Asteroids
                for (const ast of this.asteroids) {
                    if (!ast.alive) continue;
                    const adx = ast.worldX - this.player.worldX;
                    const ady = ast.worldY - this.player.worldY;
                    const adist = Math.sqrt(adx * adx + ady * ady);
                    if (adist < minDist) {
                        const angleToAst = Math.atan2(ady, adx);
                        let diff = angleToAst - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = ast;
                            minDist = adist;
                        }
                    }
                }

                for (const ev of this.events) {
                    if (!ev.isAttackable) continue;
                    const edx = ev.worldX - this.player.worldX;
                    const edy = ev.worldY - this.player.worldY;
                    const edist = Math.sqrt(edx * edx + edy * edy);
                    if (edist < minDist) {
                        const angleToEv = Math.atan2(edy, edx);
                        let diff = angleToEv - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = ev;
                            minDist = edist;
                        }
                    }
                }

                if (target) {
                    const noseOffset = 20;
                    const px = this.player.worldX + Math.cos(turretAngle) * noseOffset;
                    const py = this.player.worldY + Math.sin(turretAngle) * noseOffset;

                    // Aim directly at target center
                    const aimAngle = Math.atan2(target.worldY - py, target.worldX - px);

                    const spriteKey = this.player.hasLaserOverride ? 'blue_laser_ball_big' : 'blue_laser_ball';
                    const currentBaseDamage = (this.player.shipData.baseDamage * this.player.obedienceMult + this.player.permDamageBonus) * this.player.laserCartridgeMult;
                    const damage = currentBaseDamage * (this.player.hasLaserOverride ? 1.3 : 1.0);

                    this.projectiles.push(
                        new Projectile(this.game, px, py, aimAngle, 2400, spriteKey, this.player, damage)
                    );
                    this.game.sounds.play('laser', { volume: 0.2, x: px, y: py });
                    this.player.autoTurretTimer = 1.0;
                }
            }
        }

        // Mechanical Claw
        if (this.hasMechanicalClaw) {
            this.player.mechanicalClawTimer -= dt;
            if (this.player.mechanicalClawTimer <= 0) {
                let triggered = false;
                for (const en of this.enemies) {
                    if (!en.alive) continue;
                    const edx = en.worldX - this.player.worldX;
                    const edy = en.worldY - this.player.worldY;
                    const edist = Math.sqrt(edx * edx + edy * edy);
                    if (edist < 150) {
                        en.freeze(3.0);
                        triggered = true;
                    }
                }
                if (triggered) {
                    this.game.sounds.play('shield', { volume: 0.4, x: this.player.worldX, y: this.player.worldY }); // Stun sound
                    this.player.mechanicalClawTimer = 5.0; // Cooldown for the claw itself
                }
            }
        }
        this.perf.begin('misc');
        if (this.yellowOneScriptActive) {
            // Hard lock camera centered on player during cutscene
            this.camera.snapTo(this.player);
        } else {
            this.camera.update(dt, this.player);
        }

        // --- Dynamic FOV Scaling ---
        const currentSpeed = Math.sqrt(this.player.vx * this.player.vx + this.player.vy * this.player.vy);
        // Scale FOV from 1.0 to 1.3 based on speed. Max zoom reached at 2000 px/s (typical boost speed)
        const speedFactor = Math.min(1.0, currentSpeed / 2000);
        const speedFovMult = 1.0 + (speedFactor * 0.3);
        const targetFovMult = this.fovUpgradeMult * speedFovMult;

        // Smoothly interpolate FOV to avoid jitter
        const fovLerpSpeed = 5.0; // Adjust for snappiness
        this.currentFovMult += (targetFovMult - this.currentFovMult) * dt * fovLerpSpeed;

        // Apply scale to engine
        // Dynamic FOV Scaling — Smoothing with Lerp
        const targetScale = 1.0 / this.currentFovMult;
        const scaleStiffness = 4.0; // Pacing of the zoom (higher = faster)

        this.game.worldScaleModifier += (targetScale - this.game.worldScaleModifier) * (1.0 - Math.exp(-scaleStiffness * dt));
        // Recalculate scaling without expensive resize()
        const currentMean = Math.sqrt(this.game.width * this.game.height);
        const refMean = Math.sqrt(2560 * 1440);
        this.game.worldScale = Math.max(0.1, (2 * (currentMean / refMean)) * this.game.worldScaleModifier);
        this.perf.end('misc');

        // Shop interaction check (already calculated above for input priority)

        // Collect projectiles from player
        if (this.player.pendingProjectiles.length > 0) {
            this.projectiles.push(...this.player.pendingProjectiles);
            this.player.pendingProjectiles.length = 0;
        }

        // --- Primary Weapon Hitscan (Railgun/Energy Blaster) ---
        if (this.player.pendingRailgunFire) {
            this.player.pendingRailgunFire = false;
            this._handlePrimaryWeaponFire();
        }

        // --- Update Active Beams ---
        if (this.activeBeams) {
            for (let i = this.activeBeams.length - 1; i >= 0; i--) {
                this.activeBeams[i].timer -= dt;
                if (this.activeBeams[i].timer <= 0) {
                    this.activeBeams.splice(i, 1);
                }
            }
        }

        // --- Update Explosions ---
        if (this.explosions) {
            for (let i = this.explosions.length - 1; i >= 0; i--) {
                this.explosions[i].timer -= dt;
                if (this.explosions[i].timer <= 0) {
                    this.explosions.splice(i, 1);
                }
            }
        }

        if (this.eventBufferTimer > 0) {
            this.eventBufferTimer -= dt;
        }

        // Spawn asteroids always (not frozen by events)
        this.perf.begin('asteroids');
        if (this.asteroids.length < 180) {
            const newAsteroids = this.asteroidSpawner.update(
                dt, this.player.worldX, this.player.worldY,
                this.player.vx, this.player.vy, this.player.asteroidSpawnMult
            );
            this.asteroids.push(...newAsteroids);
        }
        this.perf.end('asteroids');

        // --- Freeze spawning if an event is active ---
        if (!isEventActive && this.eventBufferTimer <= 0) {

            // Spawn caches (rare, distance-accumulator based)
            const newCaches = this.cacheSpawner.update(
                this.player.worldX, this.player.worldY, this.caches.length, this.player.lvlCacheFreqMult
            );
            this.caches.push(...newCaches);

            // Update total game time
            this.totalGameTime += dt;

            // --- Tunable Difficulty Constants (Defined in constructor) ---

            let timeScale = 1.0;
            if (this.totalGameTime <= this.difficultyRampTime) {
                // Phase 1: Convex Ramp (Power Curve) - Starts slow, accelerates
                timeScale += (this.difficultyGain * this.player.lvlDifficultyMult * Math.pow(this.totalGameTime, this.difficultyExponent));
            } else {
                // Phase 2: Steady Growth (Linear)
                const rampMax = this.difficultyGain * Math.pow(this.difficultyRampTime, this.difficultyExponent);
                const steadyTime = this.totalGameTime - this.difficultyRampTime;
                timeScale += rampMax + (this.difficultySteadyRate * steadyTime);
            }

            // Power-aware difficulty
            const powerLevel = this._calculatePlayerPowerLevel();
            this.difficultyScale = timeScale + powerLevel;

            // Wave timer: fixed 2-minute interval
            let bossAlive = false;
            for (const e of this.enemies) { if (e.isBoss && e.alive) { bossAlive = true; break; } }
            if (!bossAlive && !this.yellowOneFightActive) {
                this.waveTimer -= dt;
                this.postWaveTimer += dt;
            }

            // --- Music System Logic ---
            // 1. Pre-wave combat trigger (6s before)
            if (this.waveTimer <= 6 && !this.musicCombatTriggered) {
                this.game.sounds.setTargetState(MUSIC_STATE.COMBAT);
                this.musicCombatTriggered = true;
            }

            // 2. Post-wave exploration return
            // 10 seconds after wave start (1:50 on 2min timer), start checking for enemies
            // (Only if we are in the combat state and the countdown isn't active)
            if (this.musicCombatTriggered && this.postWaveTimer >= 10 && this.waveTimer > 10 && !this.yellowOneScriptActive) {
                if (this.enemies.length === 0) {
                    this.quietTimer += dt;
                    if (this.quietTimer >= 3.0) { // 3s of continuous silence
                        this.game.sounds.setTargetState(MUSIC_STATE.EXPLORATION);
                        this.musicCombatTriggered = false;
                        this.quietTimer = 0;
                    }
                } else {
                    this.quietTimer = 0;
                }
            }

            if (this.waveTimer <= 0) {
                this._triggerWave();
                this.waveTimer = 120 * this.player.lvlWaveCountdownMult;
                this.postWaveTimer = 0;
            }

            // Spawn enemies
            this.perf.begin('enemies');
            const newEnemies = this.enemySpawner.update(dt, this.player.worldX, this.player.worldY, this.difficultyScale * this.player.lvlEnemySpawnMult);
            this.enemies.push(...newEnemies);
            this.perf.end('enemies');

            // Boss death immunity: while any boss is dying, and for 2 seconds after
            const isBossDying = this.enemies.some(e => e.isBoss && e.state === BOSS_STATE.DYING);
            if (isBossDying) {
                this.bossDeathImmunityTimer = 2.0;
            } else if (this.bossDeathImmunityTimer > 0) {
                this.bossDeathImmunityTimer -= dt;
            }

            // Boss wreckage tracking - clean up when player is close OR too far
            if (!this.player.isWarping) {
                for (const wreck of this.bossWrecks) {
                    const dx = wreck.worldX - this.player.worldX;
                    const dy = wreck.worldY - this.player.worldY;
                    const distSq = dx * dx + dy * dy;
                    if (distSq < 450 * 450 || distSq > 15000 * 15000) {
                        wreck.isFinished = true;
                    }
                }
            }
            this.bossWrecks = this.bossWrecks.filter(w => !w.isFinished);
        }

        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
        }

        // Update enemies — split into boss vs regular for perf tracking
        // Pre-filter asteroids near the player for enemy AI avoidance (avoid 30×200 loop)
        const enemyAvoidAsteroids = this.asteroids.length > 60
            ? this.asteroids.filter(a => a._nearPlayer)
            : this.asteroids;

        this.perf.begin('enemies');
        this.perf.begin('boss');
        for (const e of this.enemies) {
            if (!e.isBoss) continue;
            e.update(dt, this.player, enemyAvoidAsteroids, this.projectiles, this.enemies);
            if (e.pendingProjectiles.length > 0) {
                this.projectiles.push(...e.pendingProjectiles);
                e.pendingProjectiles.length = 0;
            }
        }
        this.perf.end('boss');
        for (const e of this.enemies) {
            if (e.isBoss) continue;
            e.update(dt, this.player, enemyAvoidAsteroids, this.projectiles, this.enemies);
            if (e.pendingProjectiles.length > 0) {
                this.projectiles.push(...e.pendingProjectiles);
                e.pendingProjectiles.length = 0;
            }

            // Despawn if way too far
            const dxArr = e.worldX - this.player.worldX;
            const dyArr = e.worldY - this.player.worldY;
            const despawnR = 3500 * this.currentFovMult;
            if (dxArr * dxArr + dyArr * dyArr > despawnR * despawnR && !e.isBoss) {
                e.alive = false;
            }
        }
        this.perf.end('enemies');

        // Update projectiles
        this.perf.begin('projectiles');
        for (const p of this.projectiles) {
            p.update(dt);
        }
        this.perf.end('projectiles');

        // --- Collision Handling ---
        // Update asteroids
        this.perf.begin('asteroids');
        for (const a of this.asteroids) {
            a.update(dt);
            const dx = a.worldX - this.player.worldX;
            const dy = a.worldY - this.player.worldY;
            if (dx * dx + dy * dy > a.despawnDist * a.despawnDist) {
                a.alive = false;
            }
        }
        this.perf.end('asteroids');

        // Tag entities near the player for broad-phase collision/AI culling
        {
            const cpx = this.player.worldX, cpy = this.player.worldY;
            const cullRange = 3000 * this.currentFovMult;
            const cullRangeSq = cullRange * cullRange;
            for (const a of this.asteroids) {
                const dx = a.worldX - cpx, dy = a.worldY - cpy;
                a._nearPlayer = (dx * dx + dy * dy < cullRangeSq);
            }
            for (const en of this.enemies) {
                const dx = en.worldX - cpx, dy = en.worldY - cpy;
                en._nearPlayer = (dx * dx + dy * dy < cullRangeSq);
            }
        }

        // Update rubble / particles
        this.perf.begin('particles');
        for (const r of this.rubble) {
            r.update(dt);
        }

        // Update floating texts
        for (let i = this.floatingTexts.length - 1; i >= 0; i--) {
            this.floatingTexts[i].update(dt);
            if (!this.floatingTexts[i].alive) {
                this.floatingTexts.splice(i, 1);
            }
        }
        this.perf.end('particles');

        // Cleanup stale indicator opacities — build a Set for O(1) lookups
        if (this.indicatorOpacities.size > 0) {
            const liveEntities = new Set();
            for (const e of this.enemies) liveEntities.add(e);
            for (const a of this.asteroids) liveEntities.add(a);
            for (const s of this.shops) liveEntities.add(s);
            for (const ev of this.events) liveEntities.add(ev);
            for (const enc of this.encounters) liveEntities.add(enc);
            for (const w of this.bossWrecks) liveEntities.add(w);
            for (const c of this.caches) liveEntities.add(c);
            for (const entity of this.indicatorOpacities.keys()) {
                if (!liveEntities.has(entity)) {
                    this.indicatorOpacities.delete(entity);
                }
            }
        }

        // Update scrap entities (magnetized to player)
        for (const s of this.scrapEntities) {
            if (!this.player.isWarping) {
                s.update(dt, this.player.worldX, this.player.worldY, this.player.scrapRangeMult);

                // Collection collision
                const dx = s.worldX - this.player.worldX;
                const dy = s.worldY - this.player.worldY;
                const collectRange = (s.collectRange + this.player.radius);
                if (dx * dx + dy * dy < collectRange * collectRange) {
                    s.alive = false;
                    this.player.scrap += s.value;
                    this.stats.scrapCollected += s.value;
                    this.game.sounds.play('scrap', { volume: 0.4, x: s.worldX, y: s.worldY });
                    this.spawnFloatingText(s.worldX, s.worldY, `+${s.value}`, '#ffff00');
                }
            } else {
                // Just update drift/friction if not magnetized (Scrap.update handles it if player coords are not passed? No, it needs them)
                // Actually Scrap.update has a dist check internal. Let's just skip it so they drift.
                s.update(dt, -99999, -99999); // Pass dummy coords to prevent magnetization
            }
        }

        // Update item pickups (magnetized to player)
        for (const it of this.itemPickups) {
            if (!this.player.isWarping) {
                it.update(dt, this.player.worldX, this.player.worldY, this.player.scrapRangeMult);

                // Collection collision
                const dx = it.worldX - this.player.worldX;
                const dy = it.worldY - this.player.worldY;
                const collectRange = (it.collectRange + this.player.radius);

                if (dx * dx + dy * dy < collectRange * collectRange && (it.pickupDelay || 0) <= 0) {
                    // Try to add to inventory
                    if (this.player.inventory.autoAdd(it.item)) {
                        it.alive = false;
                        this.game.sounds.play('select', 0.5);
                        this._onInventoryChanged(true);
                    }
                }
            } else {
                it.update(dt, -99999, -99999); // Pass dummy coords to prevent magnetization
            }
            // Despawn check
            const ddx = it.worldX - this.player.worldX;
            const ddy = it.worldY - this.player.worldY;
            if (ddx * ddx + ddy * ddy > 4000 * 4000) it.alive = false;
        }

        // Update ExpOrbs
        for (let i = this.expOrbs.length - 1; i >= 0; i--) {
            const orb = this.expOrbs[i];
            orb.update(dt, this.player.worldX, this.player.worldY);

            // Collection collision
            const dx = orb.worldX - this.player.worldX;
            const dy = orb.worldY - this.player.worldY;
            const distSq = dx * dx + dy * dy;
            const collectRange = (orb.collectRange + this.player.radius);

            if (distSq < collectRange * collectRange) {
                orb.alive = false;
                const finalExp = Math.ceil(orb.amount * (this.player.experienceCondenserMult || 1.0));
                this.player.addExp(finalExp);
                this.game.sounds.play('exp', { volume: 0.15, pitch: 1.5, x: orb.worldX, y: orb.worldY });

                // Floating text for every collection
                const offsetX = (Math.random() - 0.5) * 20;
                const offsetY = (Math.random() - 0.5) * 20;
                this.spawnFloatingText(orb.worldX + offsetX, orb.worldY + offsetY, `+${finalExp} XP`, '#915dbf');
            }

            // Despawn check
            if (distSq > 25000000) orb.alive = false; // 5000^2
        }

        // --- Collision: Projectiles vs Everything ---
        this.perf.begin('collisions');

        // _nearPlayer tags are already computed after asteroid update (used by enemy AI too)

        for (const proj of this.projectiles) {
            if (!proj.alive) continue;

            // vs Asteroids (All Projectiles)
            for (const ast of this.asteroids) {
                if (!ast.alive || !ast._nearPlayer) continue;
                const dx = proj.worldX - ast.worldX;
                const dy = proj.worldY - ast.worldY;
                const cr = proj.radius + ast.radius;
                if (dx * dx + dy * dy < cr * cr) {
                    proj.alive = false;
                    this.game.sounds.play('hit', { volume: 0.4, x: proj.worldX, y: proj.worldY });
                    if (ast.hit(proj.damage)) {
                        this._onEntityDestroyed(ast);
                    } else {
                        this._triggerShakeAt(proj.worldX, proj.worldY, 0.4);
                    }
                    // Player-only Explosives Unit vs Shared Rockets
                    if ((proj.owner === this.player && this.player.hasExplosivesUnit) || proj.isRocket) {
                        this._spawnExplosion(proj.worldX, proj.worldY, proj.damage * 0.5);
                    }
                    break;
                }
            }
            if (!proj.alive) continue;

            // Player projectiles vs Enemies/Events
            if (proj.owner === this.player) {
                // vs Events
                for (const ev of this.events) {
                    if (!ev.alive || ev.blocksProjectiles === false) continue;
                    const dx = proj.worldX - ev.worldX;
                    const dy = proj.worldY - ev.worldY;
                    const cr = proj.radius + ev.radius;
                    if (dx * dx + dy * dy < cr * cr) {
                        proj.alive = false;
                        if (ev.hit(proj.damage)) {
                            this._onEntityDestroyed(ev);
                        } else {
                            this._triggerShakeAt(proj.worldX, proj.worldY, 0.6);
                            // Specialized logic for Cthulhu rubble spawn
                            if (ev.state === 4) { // 4 = DESTRUCTIBLE
                                for (let j = 0; j < 2; j++) {
                                    this.rubble.push(new Rubble(this.game, proj.worldX, proj.worldY));
                                }
                            }
                        }
                        if (this.player.hasExplosivesUnit || proj.isRocket) {
                            this._spawnExplosion(proj.worldX, proj.worldY, proj.damage * 0.5);
                        }
                        break;
                    }
                }
                if (!proj.alive) continue;

                // vs Enemies
                for (const en of this.enemies) {
                    if (!en.alive || !en._nearPlayer) continue;
                    const dx = proj.worldX - en.worldX;
                    const dy = proj.worldY - en.worldY;
                    const cr = proj.radius + en.radius;
                    if (dx * dx + dy * dy < cr * cr) {
                        proj.alive = false;
                        this.game.sounds.play('hit', { volume: 0.4, x: proj.worldX, y: proj.worldY });
                        if (en.hit(proj.damage)) {
                            this._onEntityDestroyed(en);
                        } else {
                            this._triggerShakeAt(proj.worldX, proj.worldY, 0.5);
                        }
                        if (this.player.hasExplosivesUnit || proj.isRocket) {
                            this._spawnExplosion(proj.worldX, proj.worldY, proj.damage * 0.5);
                        }
                        break;
                    }
                }
            }
            // Enemy projectiles vs Player
            else if (proj.owner !== this.player) {
                const dx = proj.worldX - this.player.worldX;
                const dy = proj.worldY - this.player.worldY;
                const cr = proj.radius + this.player.radius;

                // Broad-phase squared-distance check followed by pixel-perfect check
                if (dx * dx + dy * dy < cr * cr) {
                    if (this.player.checkPixelCollision(proj.worldX, proj.worldY)) {
                        proj.alive = false;
                        this._damagePlayer(proj.damage); // proj.damage is already scaled in Enemy.shoot

                        const kdx = this.player.worldX - proj.worldX;
                        const kdy = this.player.worldY - proj.worldY;
                        const dist = Math.sqrt(kdx * kdx + kdy * kdy);
                        this._applyKnockback(kdx, kdy, dist, 100);

                        // Play shield hit sound if shielding
                        if (this.player.shielding) {
                            this.game.sounds.play('shield', { volume: 0.5, x: this.player.worldX, y: this.player.worldY });
                        }
                    }
                }
            }
        }

        // --- Collision: Player vs Everything (Physical) ---
        if (!this.player.isWarping) {
            // Player vs Asteroids
            for (const ast of this.asteroids) {
                if (!ast.alive) continue;
                const dx = this.player.worldX - ast.worldX;
                const dy = this.player.worldY - ast.worldY;
                const cr = this.player.radius + ast.radius;
                if (dx * dx + dy * dy < cr * cr) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    ast.onCollision(this.player);
                    this._damagePlayer(ast.damage * this.player.lvlAsteroidResistanceMult);
                    ast.alive = false;
                    this._onEntityDestroyed(ast);
                    this._applyKnockback(dx, dy, dist, 200);
                }
            }

            // Player vs Enemies (Ramming)
            for (const en of this.enemies) {
                if (!en.alive || en.invulnTimer > 0) continue;
                const dx = this.player.worldX - en.worldX;
                const dy = this.player.worldY - en.worldY;
                const cr = this.player.radius + en.radius;
                if (dx * dx + dy * dy < cr * cr) {
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    this._damagePlayer(20); // Ramming hurts!
                    en.onCollision(this.player);
                    if (!en.alive) this._onEntityDestroyed(en);
                    this._applyKnockback(dx, dy, dist, 300);
                }
            }

            // Player vs Events (Ramming)
            for (const ev of this.events) {
                if (!ev.alive || ev.state !== CTHULHU_STATE.DORMANT) continue;
                const dx = this.player.worldX - ev.worldX;
                const dy = this.player.worldY - ev.worldY;
                const cr = this.player.radius + ev.radius * 0.5;
                if (dx * dx + dy * dy < cr * cr) { // Smaller inner radius for waking
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    this._damagePlayer(20);
                    ev.hit(1); // Triggers wake
                    this._applyKnockback(dx, dy, dist, 600); // Big knockback from boss
                }
            }
        }

        // --- Collision: Enemies vs Asteroids ---
        // (Note: still inside collisions timing block)
        for (const en of this.enemies) {
            if (!en.alive || !en._nearPlayer) continue;
            for (const ast of this.asteroids) {
                if (!ast.alive || !ast._nearPlayer) continue;
                const dx = en.worldX - ast.worldX;
                const dy = en.worldY - ast.worldY;
                const cr = en.radius + ast.radius;
                if (dx * dx + dy * dy < cr * cr) {
                    // Bosses take nearly no damage from asteroids (1.0 damage per hit)
                    // AsteroidCrusher takes NO damage from asteroids
                    const damage = (en instanceof AsteroidCrusher) ? 0 : (en.isBoss ? 1.0 : 10);
                    en.hit(damage);

                    // Don't break if tractored by THIS enemy OR recently released by a crusher
                    if (ast.tractoredBy === en || (en instanceof AsteroidCrusher && ast.tractorCooldown > 0)) continue;

                    if (ast.hit(1)) {
                        this._onEntityDestroyed(ast);
                    }
                    if (!en.alive) {
                        this._onEntityDestroyed(en);
                    }
                }
            }
        }

        this.perf.end('collisions');

        // Cleanup dead entities (in-place compaction to avoid allocating new arrays)
        this._compactAlive(this.projectiles);
        this._compactAlive(this.asteroids);
        this._compactAlive(this.enemies);
        this._compactAlive(this.rubble);
        this._compactAlive(this.scrapEntities);
        this._compactAlive(this.itemPickups);
        this._compactAlive(this.expOrbs);
        this._compactAlive(this.events);
        this._compactAlive(this.encounters);
        this._compactAlive(this.shops);
        this._compactAlive(this.caches);

        // Update caches and discovery
        for (const c of this.caches) {
            c.update(dt, this.player.worldX, this.player.worldY);
        }

        // Once the pending cache finishes its opening animation, show the UI
        if (this._pendingCache) {
            if (!this._pendingCache.alive) {
                this._pendingCache = null;
            } else if (this._pendingCache.state === CACHE_STATE.OPEN) {
                this._openCacheUI(this._pendingCache);
                this._pendingCache = null;
            }
        }

        // Shop proximity discovery & tracking refresh
        for (const s of this.shops) {
            const dx = s.worldX - this.player.worldX;
            const dy = s.worldY - this.player.worldY;
            if (dx * dx + dy * dy < 1200 * 1200) {
                // If not revealed, or revealed but not the most recent one, refresh it
                if (!s.revealed || this.revealedShops[this.revealedShops.length - 1] !== s) {
                    this._revealShop(s);
                }
            }
        }

        // --- Encounter Spawning ---
        // Track player distance traveled
        const travelDx = this.player.worldX - this._lastPlayerX;
        const travelDy = this.player.worldY - this._lastPlayerY;
        this.playerDistanceTraveled += Math.sqrt(travelDx * travelDx + travelDy * travelDy);
        this._lastPlayerX = this.player.worldX;
        this._lastPlayerY = this.player.worldY;

        // Update existing encounters
        for (const enc of this.encounters) {
            enc.update(dt, this.player);
        }

        // Spawn timer — scales with exploration, must have NO combatants visibly attacking
        let bossAlive2 = false;
        let enemiesOnScreen = false;
        const ws = this.game.worldScale;
        const halfVW = this.game.width / ws / 2 + 100;
        const halfVH = this.game.height / ws / 2 + 100;
        const cx = this.camera.x, cy = this.camera.y;
        for (const e of this.enemies) {
            if (!e.alive) continue;
            if (e.isBoss) bossAlive2 = true;
            if (!enemiesOnScreen) {
                const dx = e.worldX - cx, dy = e.worldY - cy;
                if (dx > -halfVW && dx < halfVW && dy > -halfVH && dy < halfVH) {
                    enemiesOnScreen = true;
                }
            }
            if (bossAlive2 && enemiesOnScreen) break;
        }

        if (!bossAlive2 && !isEventActive && !enemiesOnScreen && this.encounters.length === 0) {
            this.encounterSpawnTimer -= dt;
            if (this.encounterSpawnTimer <= 0) {
                this._spawnEncounter();
                // Frequency scales with exploration: more travel/events/shops = shorter wait
                const explorationFactor = Math.min(4.0,
                    1.0 + (this.playerDistanceTraveled / 15000) * 0.3
                    + (this.stats.eventsDiscovered * 0.2)
                    + (this.stats.shopsUnlocked * 0.15)
                );
                const baseWait = 140; // ~2.3 minutes base
                const minWait = 45;   // 45 seconds minimum
                const wait = Math.max(minWait, baseWait / explorationFactor + (Math.random() - 0.5) * 40);
                this.encounterSpawnTimer = wait / Math.max(0.1, this.player.lvlEncounterFreqMult);
            }
        }
    }

    _onEntityDestroyed(entity) {
        this._triggerShakeAt(entity.worldX, entity.worldY, entity instanceof Asteroid ? 1.5 : 1.8);
        this.game.sounds.play(entity instanceof Asteroid ? 'asteroid_break' : 'ship_explode', { volume: 0.4, x: entity.worldX, y: entity.worldY });

        // Boss Music: Return to previous music state when all bosses are dead
        if (entity.isBoss) {
            const otherBosses = this.enemies.some(e => e.isBoss && e.alive && e !== entity);
            if (!otherBosses) {
                if (this.musicCombatTriggered) {
                    this.game.sounds.setTargetState(MUSIC_STATE.COMBAT, true);
                } else {
                    this.game.sounds.restoreMusic();
                }
            }

            // Spawn a cache on boss death (always)
            if (this.caches.length < CACHE_CONFIG.maxActiveCaches + 2) {
                const bossCache = this.cacheSpawner.spawnNear(entity.worldX, entity.worldY, 0, 0);
                this.caches.push(bossCache);
            }
        }
        // Track stats
        if (entity instanceof Asteroid) {
            this.stats.asteroidsDestroyed++;
        } else if (!(entity instanceof CthulhuEvent) && !(entity instanceof CargoShipEvent)) {
            this.stats.enemiesDefeated++;
        }
        const spawns = entity.getSpawnOnDeath();
        for (const s of spawns) {
            if (s instanceof Scrap) { if (this.scrapEntities.length < 200) this.scrapEntities.push(s); }
            else if (s instanceof Rubble || s instanceof ProceduralDebris) { if (this.rubble.length < 250) this.rubble.push(s); }
            else if (s instanceof Asteroid) this.asteroids.push(s);
            else if (s instanceof ItemPickup) this.itemPickups.push(s);
            else if (s instanceof ExpOrb) { if (this.expOrbs.length < 150) this.expOrbs.push(s); }
        }
    }

    _damagePlayer(amount) {
        if (this.player.invulnTimer > 0 || this.isDead || this.bossDeathImmunityTimer > 0) return;

        // Cap damage at 1/5th of max health per instance
        const finalAmount = Math.min(amount, this.player.maxHealth / 5);

        if (this.player.shielding) {
            this.spawnFloatingText(this.player.worldX, this.player.worldY, `-${Math.ceil(finalAmount)}`, '#44ddff');
            this.player.shieldEnergy -= finalAmount * 5;
            if (this.player.shieldEnergy <= 0) {
                this.player.shieldEnergy = 0;
                this.player.shieldBroken = true;
                this.player.shielding = false;
                this.camera.shake(3.0, 8.0); // Big impact for shield break
                this.game.sounds.play('shield_break', { volume: 0.7, x: this.player.worldX, y: this.player.worldY });
            } else {
                this.camera.shake(0.4, 15.0); // Subtle hit feedback
                this.game.sounds.play('asteroid_break', { volume: 0.3, x: this.player.worldX, y: this.player.worldY }); // Shield hit sound
            }
        } else {
            this.spawnFloatingText(this.player.worldX, this.player.worldY, `-${Math.ceil(finalAmount)}`, '#ff4444');
            this.player.health -= finalAmount;
            // Increased with damage slightly, but with diminishing returns (sqrt)
            this.camera.shake(Math.sqrt(finalAmount) * 1.2, 15.0);
            this.game.sounds.play('ship_explode', { volume: 0.5, x: this.player.worldX, y: this.player.worldY });

            if (this.player.health <= 0) {
                if (this.player.hasSacrifice && !this.yellowOneEnraged) {
                    this.player.hasSacrifice = false; // Consume it
                    this.spawnFloatingText(this.player.worldX, this.player.worldY, `+${Math.ceil(this.player.maxHealth)}`, '#44ff44');
                    this.player.health = this.player.maxHealth;
                    this.player.shieldEnergy = this.player.maxShieldEnergy;
                    this.player.shieldBroken = false;
                    this.player.invulnTimer = 3.0; // Extra invuln duration
                    this.triggerFlash('#b400ff', 1.2, 0.6); // Dramatic purple flash
                    this.game.sounds.play('shield', { volume: 1.0, x: this.player.worldX, y: this.player.worldY });

                    // Also need to remove the Sacrifice item from inventory
                    this._removeSacrificeItem();
                } else if (this.yellowOneEnraged) {
                    // Yellow One enraged phase: cutscene handles death, don't trigger normal death
                    this.player.health = 0;
                } else {
                    this.player.health = 0;
                    this._triggerDeath();
                }
            }
        }

        this.player.invulnTimer = this.player.invulnDuration;
    }

    _applyKnockback(dx, dy, dist, str) {
        if (dist > 0) {
            this.player.vx += (dx / dist) * str;
            this.player.vy += (dy / dist) * str;
        }
    }

    serialize() {
        return {
            totalGameTime: this.totalGameTime,
            trueTotalTime: this.trueTotalTime,
            difficultyScale: this.difficultyScale,
            stats: { ...this.stats },
            waveTimer: this.waveTimer,
            shipId: this.shipData.id,
            enemySpawner: this.enemySpawner.serialize(),
            musicState: {
                musicCombatTriggered: this.musicCombatTriggered,
                postWaveTimer: this.postWaveTimer,
                quietTimer: this.quietTimer
            },
            player: this.player.serialize(),
            events: this.events.map(ev => ({
                type: ev.constructor.name,
                worldX: ev.worldX,
                worldY: ev.worldY,
                revealed: ev.revealed,
                discovered: ev.discovered,
                state: ev.state,
                // Specific fields for certain events
                wave: ev.wave, // Cthulhu
                spawnedInitialScrap: ev.spawnedInitialScrap, // CargoShip
                positions: ev.positions, // FracturedStation
                angles: ev.angles, // FracturedStation
                // YellowOne
                health: ev.health,
                maxHealth: ev.maxHealth,
                isFinished: ev.isFinished,
                invulnerable: ev.invulnerable,
                musicPlaying: ev.musicPlaying,
                phase1Triggered: ev.phase1Triggered
            })),
            itemPickups: this.itemPickups.map(i => i.serialize()),
            scrapEntities: this.scrapEntities.map(s => s.serialize()),
            asteroids: this.asteroids.map(a => a.serialize()),
            shops: this.shops.map(s => s.serialize()),
            encounterBonuses: { ...this.encounterBonuses },
            playerDistanceTraveled: this.playerDistanceTraveled,
            expOrbs: this.expOrbs.map(orb => orb.serialize())
        };
    }

    async deserialize(data) {
        this.totalGameTime = data.totalGameTime;
        this.trueTotalTime = data.trueTotalTime || 0;
        this.difficultyScale = data.difficultyScale;
        this.stats = { ...data.stats };
        this.waveTimer = data.waveTimer;

        if (data.enemySpawner) {
            this.enemySpawner.deserialize(data.enemySpawner);
        }

        if (data.musicState) {
            this.musicCombatTriggered = data.musicState.musicCombatTriggered;
            this.postWaveTimer = data.musicState.postWaveTimer;
            this.quietTimer = data.musicState.quietTimer;
        }

        if (data.player) {
            // Ensure inventory knows it belongs to the player and this state
            if (this.player.inventory) {
                this.player.inventory.isPlayerInventory = true;
                this.player.inventory.playingState = this;
            }
            await this.player.deserialize(data.player);
            // Snap camera to player immediately on load to prevent starting at origin
            this.camera.snapTo(this.player);
        }

        const { UPGRADES } = await import('../data/upgrades.js');
        const { Asteroid, Scrap, ItemPickup, ExpOrb } = await import('../entities/asteroid.js');

        // Recreate events
        this.events = [];
        const EVENT_CLASSES = {
            'CthulhuEvent': CthulhuEvent,
            'CargoShipEvent': CargoShipEvent,
            'FracturedStationEvent': FracturedStationEvent,
            'KnowledgeEvent': KnowledgeEvent,
            'YellowOne': YellowOne
        };

        for (const evData of data.events) {
            const Cls = EVENT_CLASSES[evData.type];
            if (Cls) {
                let ev;
                if (evData.type === 'FracturedStationEvent') {
                    ev = new Cls(this.game, evData.positions);
                    if (evData.angles) ev.angles = evData.angles;
                    ev.state = evData.state;
                } else {
                    ev = new Cls(this.game, evData.worldX, evData.worldY);
                    ev.state = evData.state;
                    if (evData.type === 'CthulhuEvent') ev.wave = evData.wave;
                    if (evData.type === 'CargoShipEvent') ev.spawnedInitialScrap = evData.spawnedInitialScrap;
                    if (evData.type === 'YellowOne') {
                        ev.health = evData.health;
                        ev.maxHealth = evData.maxHealth;
                        ev.isFinished = evData.isFinished || false;
                        ev.invulnerable = evData.invulnerable;
                        ev.musicPlaying = evData.musicPlaying || false;
                        ev.phase1Triggered = evData.phase1Triggered || false;
                        // If the fight was already finished, mark it done
                        if (ev.isFinished || ev.state === 'finished' || ev.state === 'scripted') {
                            ev.state = 'finished';
                            ev.isFinished = true;
                            ev.alive = true;
                        }
                    }
                }
                ev.revealed = evData.revealed;
                ev.discovered = evData.discovered;
                this.events.push(ev);
            }
        }

        // Recreate shops
        this.shops = [];
        this.revealedShops = [];
        for (const shopData of (data.shops || [])) {
            const s = new Shop(this.game, shopData.worldX, shopData.worldY);
            await s.deserialize(shopData);
            this.shops.push(s);
            if (s.revealed) this.revealedShops.push(s);
        }

        // Recreate items on ground
        this.itemPickups = [];
        for (const iData of (data.itemPickups || [])) {
            const upgrade = UPGRADES.find(u => u.id === iData.itemId);
            if (upgrade) {
                const item = new ItemPickup(this.game, iData.worldX, iData.worldY, upgrade);
                item.vx = iData.vx;
                item.vy = iData.vy;
                item.rotation = iData.rotation;
                item.rotSpeed = iData.rotSpeed;
                this.itemPickups.push(item);
            }
        }

        // Recreate scrap
        this.scrapEntities = [];
        for (const sData of (data.scrapEntities || [])) {
            const scrap = new Scrap(this.game, sData.worldX, sData.worldY, sData.type);
            scrap.vx = sData.vx;
            scrap.vy = sData.vy;
            scrap.rotation = sData.rotation;
            scrap.rotSpeed = sData.rotSpeed;
            scrap.lifetime = sData.lifetime;
            scrap.assetKey = sData.assetKey;
            this.scrapEntities.push(scrap);
        }

        // Recreate asteroids
        this.asteroids = [];
        for (const aData of (data.asteroids || [])) {
            const ast = new Asteroid(this.game, aData.worldX, aData.worldY, aData.size, aData.vx, aData.vy);
            ast.hp = aData.hp;
            ast.rotation = aData.rotation;
            ast.rotSpeed = aData.rotSpeed;
            ast.assetKey = aData.assetKey;
            this.asteroids.push(ast);
        }

        // Recreate EXP Orbs
        this.expOrbs = [];
        for (const oData of (data.expOrbs || [])) {
            const orb = new ExpOrb(this.game, oData.worldX, oData.worldY, oData.amount);
            orb.vx = oData.vx;
            orb.vy = oData.vy;
            orb.rotation = oData.rotation;
            orb.rotSpeed = oData.rotSpeed;
            orb.suckTimer = oData.suckTimer;
            orb.time = oData.time;
            this.expOrbs.push(orb);
        }

        // Cleanup other lists
        this.projectiles = [];
        this.enemies = [];
        this.rubble = [];
        this.encounters = [];

        // Reset level-up queue / dialog so prior session's pending level-ups don't carry over
        this.levelUpQueue = [];
        this.isLevelUpOpen = false;
        this.activeLevelUpDialog = null;

        // Restore encounter bonuses
        if (data.encounterBonuses) this.encounterBonuses = { ...data.encounterBonuses };
        if (data.playerDistanceTraveled) this.playerDistanceTraveled = data.playerDistanceTraveled;

        // Reset camera
        this.camera.snapTo(this.player);

        // Recalculate all stats and multipliers based on loaded inventory
        this._onInventoryChanged(true);
    }

    _spawnExplosion(x, y, damage) {
        // Simple explosion object for now, could be a class later
        this.explosions.push({
            worldX: x,
            worldY: y,
            radius: 50,
            timer: 0.3, // Duration of the explosion effect
            color: 'rgba(255, 165, 0, 0.8)', // Orange
            damage: damage // Potentially for area damage
        });
        this._triggerShakeAt(x, y, 2.0);
    }

    spawnFloatingText(x, y, text, color) {
        this.floatingTexts.push(new FloatingText(this.game, x, y, text, color));
    }

    draw(ctx) {
        ctx.textBaseline = 'alphabetic';

        // --- World / starfield ---
        this.perf.begin('world');
        this.world.draw(ctx, this.camera, this.player, this.totalGameTime);
        this.perf.end('world');

        // --- Pre-compute draw culling bounds ---
        // Entities outside this radius from the camera center don't need draw calls.
        // This avoids calling worldToScreen + draw for hundreds of distant entities.
        const camX = this.camera.x;
        const camY = this.camera.y;
        const ws = this.game.worldScale;
        const drawCullX = this.game.width / ws / 2 + 200;  // half-viewport + margin in world units
        const drawCullY = this.game.height / ws / 2 + 200;

        // --- Particles / rubble / scrap / events / pickups ---
        this.perf.begin('particles');
        for (const r of this.rubble) {
            const dx = r.worldX - camX, dy = r.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                r.draw(ctx, this.camera);
        }
        for (const s of this.scrapEntities) {
            const dx = s.worldX - camX, dy = s.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                s.draw(ctx, this.camera);
        }
        for (const ev of this.events) {
            ev.draw(ctx, this.camera); // Events are few and may have large visuals
        }
        for (const c of this.caches) {
            c.draw(ctx, this.camera); // Caches are few
        }
        for (const it of this.itemPickups) {
            const dx = it.worldX - camX, dy = it.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                it.draw(ctx, this.camera);
        }
        for (const orb of this.expOrbs) {
            const dx = orb.worldX - camX, dy = orb.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                orb.draw(ctx, this.camera);
        }
        this.perf.end('particles');

        // --- Boss under-layer (beams, shadows) ---
        this.perf.begin('boss');
        for (const e of this.enemies) {
            if (e.drawUnder) e.drawUnder(ctx, this.camera);
        }
        this.perf.end('boss');

        // --- Asteroids draw ---
        this.perf.begin('asteroids');
        for (const a of this.asteroids) {
            const dx = a.worldX - camX, dy = a.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                a.draw(ctx, this.camera);
        }
        this.perf.end('asteroids');

        // --- Enemies & encounters draw ---
        this.perf.begin('boss');
        for (const e of this.enemies) {
            if (e.isBoss) e.draw(ctx, this.camera);
        }
        this.perf.end('boss');
        this.perf.begin('enemies');
        for (const e of this.enemies) {
            if (e.isBoss) continue;
            e.draw(ctx, this.camera);
        }
        for (const enc of this.encounters) {
            enc.draw(ctx, this.camera); // Encounters are few
        }
        this.perf.end('enemies');

        // --- Projectiles draw ---
        this.perf.begin('projectiles');
        for (const p of this.projectiles) {
            p.draw(ctx, this.camera);
        }
        this.perf.end('projectiles');

        // --- Railgun Visuals ---
        if (this.player.hasRailgun) {
            this._drawRailgunVisuals(ctx);
        }

        if (this.isDead) {
            // Draw debris in world space
            const centerX = this.game.width / 2;
            const centerY = this.game.height / 2;
            for (const d of this.shipDebris) {
                d.draw(ctx, this.camera);
            }

            if (this.showDeathScreen) {
                this._drawDeathScreen(ctx);
            }

            // Draw Yellow One fade overlays on top of death screen
            for (const ev of this.events) {
                if (ev instanceof YellowOne) {
                    if (ev.fadeToWhite > 0) {
                        ctx.save();
                        ctx.globalAlpha = ev.fadeToWhite;
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, this.game.width, this.game.height);
                        ctx.restore();
                    }
                    break;
                }
            }
            return;
        }

        this.perf.begin('player');
        this.player.draw(ctx, this.camera);
        this.perf.end('player');

        if ((this.canInteractShop || this.canInteractEncounter || this.canInteractCache) && !this.isShopOpen && !this.isEncounterOpen && !this.isCacheOpen) {
            this._drawInteractPrompt(ctx);
        }

        // Explosions (drawn above most things, below UI)
        this.perf.begin('particles');
        this._drawExplosions(ctx);

        // Draw floating texts
        for (const ft of this.floatingTexts) {
            ft.draw(ctx, this.camera);
        }
        this.perf.end('particles');

        // Hide HUD and all indicators during Yellow One cutscene
        if (!this.yellowOneScriptActive) {
            this.hud.draw(ctx);

            // --- Total Game Timer ---
            this._drawTotalGameTimer(ctx);

            // --- Health Indicators (Dev Command) ---
            this._drawHealthIndicators(ctx);

            // --- Off-screen Asteroid Warnings (under enemy/boss markers) ---
            if (this.player.hasWarningSystem) {
                this._drawAsteroidWarnings(ctx);
            }

            // --- Shop Indicators ---
            this._drawShopIndicators(ctx);

            // --- Cache Indicators ---
            this._drawCacheIndicators(ctx);

            // --- Event Indicators ---
            this._drawEventIndicators(ctx);
            this._drawBossWreckIndicators(ctx);

            // --- Off-screen Enemy Indicators (drawn last so they're on top) ---
            this._drawEnemyIndicators(ctx);

            // --- Encounter Indicators ---
            this._drawEncounterIndicators(ctx);
        }

        if (this.isLevelUpOpen && this.activeLevelUpDialog) {
            this.activeLevelUpDialog.draw(ctx);
        } else if (this.isEncounterOpen && this.activeEncounterDialog) {
            this.activeEncounterDialog.draw(ctx);
        } else if (this.isCacheOpen && this.activeCacheUI) {
            this._drawCacheOverlay(ctx);
        } else if (this.isShopOpen) {
            this._drawShopOverlay(ctx);
        } else if (this.paused) {
            this._drawPauseOverlay(ctx);
        }

        // Screen Flash Effect (Vignette Pulse)
        if (this.flashTimer > 0) {
            const pulse = Math.sin(this.flashTimer * 6) * 0.5 + 0.5;
            const alpha = Math.min(this.flashAlpha || 0.35, this.flashTimer * 0.5) * (0.7 + 0.3 * pulse);

            // Re-use or create the vignette gradient only when needed
            const color = this.flashColor || '#ff0000';
            if (!this._vignetteGrad || this._vignetteWidth !== this.game.width || this._vignetteHeight !== this.game.height || this._lastFlashColor !== color) {
                this._vignetteWidth = this.game.width;
                this._vignetteHeight = this.game.height;
                this._lastFlashColor = color;
                this._vignetteGrad = ctx.createRadialGradient(
                    this.game.width / 2, this.game.height / 2, 0,
                    this.game.width / 2, this.game.height / 2, this.game.width * 0.8
                );

                // Convert hex/string color to rgba for gradient if needed, or just use it
                this._vignetteGrad.addColorStop(0, 'rgba(0,0,0,0)');
                this._vignetteGrad.addColorStop(1, color);
            }

            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.fillStyle = this._vignetteGrad;
            ctx.fillRect(0, 0, this.game.width, this.game.height);
            ctx.restore();
        }

        // --- Yellow One scripted fade overlays ---
        for (const ev of this.events) {
            if (ev instanceof YellowOne) {
                if (ev.fadeToWhite > 0) {
                    ctx.save();
                    ctx.globalAlpha = ev.fadeToWhite;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, this.game.width, this.game.height);
                    ctx.restore();
                }
                if (ev.fadeFromWhite > 0) {
                    ctx.save();
                    ctx.globalAlpha = ev.fadeFromWhite;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, this.game.width, this.game.height);
                    ctx.restore();
                }
                break;
            }
        }

        if (this.game.devMode) {
            this._drawDevOverlay(ctx);
            // Commit after the overlay so the graph always shows the *previous* complete frame.
            // world timing (begin/end inside draw) is already accumulated before we commitFrame.
            this.perf.commitFrame();
        }
    }

    _getIndicatorOpacity(entity, shouldShow, dt) {
        let state = this.indicatorOpacities.get(entity);
        if (!state) {
            state = { opacity: 0 };
            this.indicatorOpacities.set(entity, state);
        }

        const fadeSpeed = 2.0; // Fades in/out in 0.5s
        if (shouldShow) {
            state.opacity = Math.min(1.0, state.opacity + dt * fadeSpeed);
        } else {
            state.opacity = Math.max(0.0, state.opacity - dt * fadeSpeed);
        }

        return state.opacity;
    }

    _drawHealthIndicators(ctx) {
        if (!this.game.showHealth && !this.game.devMode) return;

        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const uiScale = this.game.hudScale;
        ctx.font = `${Math.floor(6 * uiScale)}px Astro4x`;
        ctx.fillStyle = '#44ddff'; // Bright blue

        const drawHP = (entities) => {
            if (!entities) return;
            for (const e of entities) {
                const hp = e.health !== undefined ? e.health : e.hp;
                if (!e.alive || hp === undefined) continue;
                const screen = this.camera.worldToScreen(e.worldX, e.worldY, this.game.width, this.game.height);
                // Only draw if on screen
                if (screen.x < -100 || screen.x > this.game.width + 100 || screen.y < -100 || screen.y > this.game.height + 100) continue;

                const offset = (e.radius || 20) * this.game.worldScale + 5 * uiScale;
                ctx.fillText(Math.ceil(hp).toString(), Math.floor(screen.x), Math.floor(screen.y - offset));
            }
        };

        drawHP(this.enemies);
        drawHP(this.asteroids);
        drawHP(this.events);

        // Player
        const p = this.player;
        const pScreen = this.camera.worldToScreen(p.worldX, p.worldY, this.game.width, this.game.height);
        const pOffset = (p.radius || 20) * this.game.worldScale + 5 * uiScale;
        ctx.fillText(Math.ceil(p.health || 0).toString(), Math.floor(pScreen.x), Math.floor(pScreen.y - pOffset));

        ctx.restore();
    }

    triggerFlash(color = '#ff0000', duration = 0.8, alpha = 0.35) {
        this.flashColor = color;
        this.flashTimer = duration;
        this.flashAlpha = alpha;
    }

    _triggerWave() {
        this.stats.wavesCleared++;
        const waveEnemies = this.enemySpawner.spawnWave(this.player.worldX, this.player.worldY, this.difficultyScale);

        // Check if a boss was spawned
        const boss = waveEnemies.find(e => e.isBoss);
        if (boss) {
            this.triggerFlash('#ffffff', 1.2, 0.5); // Dramatic white flash for boss arrival
            const mKey = boss.musicKey || 'Starcore Showdown';
            this.game.sounds.playSpecificMusic(mKey);
            this.game.camera.shake(1.5);
        } else {
            this.triggerFlash('#ff0000', 0.8, 0.35); // Standard red wave flash
            this.game.sounds.play('ship_explode', 0.6); // Use explosion sound for wave impact
        }

        this.enemies.push(...waveEnemies);
    }

    _drawShopIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 20 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        for (const shop of this.shops) {
            if (!shop.revealed) continue;
            const screen = this.camera.worldToScreen(shop.worldX, shop.worldY, cw, ch);

            const dx = shop.worldX - this.player.worldX;
            const dy = shop.worldY - this.player.worldY;
            const angle = Math.atan2(dy, dx);

            // If on screen, shouldShow is false (to trigger fade out)
            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const opacity = this._getIndicatorOpacity(shop, !isOnScreen, dt);
            if (opacity <= 0) continue;

            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorArrow;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Draw arrow (chevron style)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.translate(ix, iy);
            ctx.rotate(angle);

            ctx.fillStyle = '#44ddff';
            ctx.beginPath();
            ctx.moveTo(10 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale, -8 * this.game.uiScale);
            ctx.lineTo(-2 * this.game.uiScale, 0); // Cutout center
            ctx.lineTo(-6 * this.game.uiScale, 8 * this.game.uiScale);
            ctx.closePath();
            ctx.fill();

            ctx.restore();

            // Label "SHOP" (Above)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#44ddff';
            ctx.font = `${6 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SHOP', ix, iy - 16 * this.game.uiScale);

            // Distance (Below)
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.fillStyle = 'rgba(68, 221, 255, 0.7)';
            const dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillText(`${Math.floor(dist)}`, ix, iy + 16 * this.game.uiScale);
            ctx.restore();
        }
    }

    _drawCacheIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const dt = this.game.lastDt || 0.016;

        for (const cache of this.caches) {
            // Only show indicator for found (not yet emptied/despawning) caches
            if (!cache.isFound || cache.state === CACHE_STATE.EMPTIED || cache.state === CACHE_STATE.DESPAWNING) continue;

            const screen = this.camera.worldToScreen(cache.worldX, cache.worldY, cw, ch);
            const dx = cache.worldX - this.player.worldX;
            const dy = cache.worldY - this.player.worldY;
            const angle = Math.atan2(dy, dx);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const opacity = this._getIndicatorOpacity(cache, !isOnScreen, dt);
            if (opacity <= 0) continue;

            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorArrow;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Gold chevron arrow
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.translate(ix, iy);
            ctx.rotate(angle);

            ctx.fillStyle = '#ffcc44';
            ctx.beginPath();
            ctx.moveTo(10 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale, -8 * this.game.uiScale);
            ctx.lineTo(-2 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale,  8 * this.game.uiScale);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            // Label
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#ffcc44';
            ctx.font = `${6 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('CACHE', ix, iy - 16 * this.game.uiScale);

            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.fillStyle = 'rgba(255, 204, 68, 0.7)';
            const dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillText(`${Math.floor(dist)}`, ix, iy + 16 * this.game.uiScale);
            ctx.restore();
        }
    }

    _drawEventIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 20 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        for (const ev of this.events) {
            if (!ev.revealed || ev.isFinished) continue; // Keep marker until destroyed or finished (scrap spawned)
            const screen = this.camera.worldToScreen(ev.worldX, ev.worldY, cw, ch);

            const dx = ev.worldX - this.player.worldX;
            const dy = ev.worldY - this.player.worldY;
            const angle = Math.atan2(dy, dx);

            // If on screen, shouldShow is false
            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const opacity = this._getIndicatorOpacity(ev, !isOnScreen, dt);
            if (opacity <= 0) continue;

            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorArrow;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Draw arrow (chevron style)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.translate(ix, iy);
            ctx.rotate(angle);

            ctx.fillStyle = '#ffdd44'; // Yellow marker for events
            ctx.beginPath();
            ctx.moveTo(10 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale, -8 * this.game.uiScale);
            ctx.lineTo(-2 * this.game.uiScale, 0); // Cutout center
            ctx.lineTo(-6 * this.game.uiScale, 8 * this.game.uiScale);
            ctx.closePath();
            ctx.fill();

            ctx.restore();

            // Label "SIGNAL" (Above)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#ffdd44';
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('SIGNAL', ix, iy - 16 * this.game.uiScale);

            // Distance (Below)
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.fillStyle = 'rgba(255, 221, 68, 0.7)';
            const dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillText(`${Math.floor(dist)}`, ix, iy + 16 * this.game.uiScale);
            ctx.restore();
        }
    }

    _drawBossWreckIndicators(ctx) {
        if (this.bossWrecks.length === 0) return;
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 20 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        for (const wreck of this.bossWrecks) {
            const screen = this.camera.worldToScreen(wreck.worldX, wreck.worldY, cw, ch);

            const dx = wreck.worldX - this.player.worldX;
            const dy = wreck.worldY - this.player.worldY;
            const angle = Math.atan2(dy, dx);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const opacity = this._getIndicatorOpacity(wreck, !isOnScreen, dt);
            if (opacity <= 0) continue;

            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorArrow;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.translate(ix, iy);
            ctx.rotate(angle);
            ctx.fillStyle = '#ff44ff'; // Purple/Magenta for wreckage
            ctx.beginPath();
            ctx.moveTo(10 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale, -8 * this.game.uiScale);
            ctx.lineTo(-2 * this.game.uiScale, 0); // Cutout center
            ctx.lineTo(-6 * this.game.uiScale, 8 * this.game.uiScale);
            ctx.closePath();
            ctx.fill();
            ctx.restore();

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#ff44ff';
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('WRECKAGE', ix, iy - 16 * this.game.uiScale);

            // Distance
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            ctx.fillStyle = 'rgba(255, 68, 255, 0.7)';
            const dist = Math.sqrt(dx * dx + dy * dy);
            ctx.fillText(`${Math.floor(dist)}`, ix, iy + 16 * this.game.uiScale);
            ctx.restore();
        }
    }

    _drawCacheOverlay(ctx) {
        if (!this.activeCacheUI) return;
        const ui      = this.activeCacheUI;
        const cw      = this.game.width;
        const ch      = this.game.height;
        const uiScale = this.game.uiScale;
        const slotSize = 32 * uiScale;

        const cacheInv  = ui.cacheInventory;
        const playerInv = this.player.inventory;

        const cacheLayout  = this._getInventoryLayout(cacheInv,  'shop');
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        ctx.save();
        ctx.globalAlpha = ui.panelAlpha;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
        ctx.fillRect(0, 0, cw, ch);

        // ── Cache inventory panel ─────────────────────────────────────────────
        this._draw9Slice(ctx, this.inventoryImg, cacheLayout.panelX, cacheLayout.panelY, cacheLayout.totalW, cacheLayout.totalH);
        ctx.fillStyle = '#ffcc44';
        ctx.font = `${8 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('SPACE CACHE', cw / 2, cacheLayout.panelY - uiScale * 10);
        this._drawInventoryGrid(ctx, cacheInv, cacheLayout, this.cacheScrollX, this.cacheScrollY);
        this._draw9Slice(ctx, this.inventoryBorderImg, cacheLayout.panelX, cacheLayout.panelY, cacheLayout.totalW, cacheLayout.totalH);
        this._drawScrollbars(ctx, cacheLayout, this.cacheScrollX, this.cacheScrollY);
        ui.draw(ctx, cacheLayout.gridVisX, cacheLayout.gridVisY, cacheLayout.visW, cacheLayout.visH, slotSize, uiScale);

        // ── Player inventory panel ────────────────────────────────────────────
        this._draw9Slice(ctx, this.inventoryImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        ctx.fillStyle = '#88aabb';
        ctx.font = `${8 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('YOUR SHIP CARGO', cw / 2, playerLayout.panelY - uiScale * 10);
        this._drawInventoryGrid(ctx, playerInv, playerLayout, this.playerScrollX, this.playerScrollY);
        this._draw9Slice(ctx, this.inventoryBorderImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        this._drawScrollbars(ctx, playerLayout, this.playerScrollX, this.playerScrollY);

        this._drawDraggedItem(ctx, slotSize);

        // ── Hint text ─────────────────────────────────────────────────────────
        if (ui.isAnimating) {
            ctx.fillStyle = 'rgba(255, 204, 68, 0.6)';
            ctx.font = `${6 * uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('CLICK TO SKIP', cw / 2, cacheLayout.panelY + cacheLayout.totalH + uiScale * 12);
        }
        ctx.fillStyle = '#667788';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Drag to move  •  E to close', cw / 2, ch - uiScale * 10);

        if (!ui.isAnimating) {
            this._drawInventoryTooltip(ctx, [
                { inv: cacheInv,  layout: cacheLayout,  scrollX: this.cacheScrollX,  scrollY: this.cacheScrollY },
                { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
            ]);
        }

        this._drawStatsPanel(ctx);
        this._drawClaimLevelsButton(ctx);

        ctx.restore();
    }

    _drawShopOverlay(ctx) {
        ctx.save();
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;
        const slotSize = 32 * uiScale;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, 0, cw, ch);

        const shopInv    = this.activeShop.inventory;
        const shopLayout = this._getInventoryLayout(shopInv, 'shop');
        const playerInv  = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        // ── Shop panel ────────────────────────────────────────────────────────
        this._draw9Slice(ctx, this.inventoryImg, shopLayout.panelX, shopLayout.panelY, shopLayout.totalW, shopLayout.totalH);
        ctx.fillStyle = '#44ddff';
        ctx.font = `${8 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('SPACE STATION SHOP', cw / 2, shopLayout.panelY - uiScale * 10);

        // ── Player panel ──────────────────────────────────────────────────────
        this._draw9Slice(ctx, this.inventoryImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        ctx.fillStyle = '#88aabb';
        ctx.font = `${8 * uiScale}px Astro4x`;
        ctx.fillText('YOUR SHIP CARGO', cw / 2, playerLayout.panelY - uiScale * 10);

        this._drawInventoryGrid(ctx, shopInv, shopLayout, this.shopScrollX, this.shopScrollY);
        this._drawInventoryGrid(ctx, playerInv, playerLayout, this.playerScrollX, this.playerScrollY);
        this._draw9Slice(ctx, this.inventoryBorderImg, shopLayout.panelX, shopLayout.panelY, shopLayout.totalW, shopLayout.totalH);
        this._draw9Slice(ctx, this.inventoryBorderImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        this._drawScrollbars(ctx, shopLayout, this.shopScrollX, this.shopScrollY);
        this._drawScrollbars(ctx, playerLayout, this.playerScrollX, this.playerScrollY);

        // ── Permanent Upgrades ────────────────────────────────────────────────
        const btnW = 60 * uiScale;
        const btnH = 24 * uiScale;
        const gap  = 8  * uiScale;
        const totalBtnsH = (btnH * 4) + (gap * 3);
        const startX = shopLayout.panelX + shopLayout.totalW + 24 * uiScale;
        const startY = shopLayout.panelY + (shopLayout.totalH - totalBtnsH) / 2;

        this.healthCostMult = 0.125;
        this.shieldCostMult = 0.5;
        this.damageCostMult = 1.5;

        const permCosts = {
            health:    Math.floor((this.player.shipData.health + this.player.permHealthBonus) * this.healthCostMult),
            shield:    Math.floor(((this.player.shipData.shield * 15 + this.player.permShieldBonus) / 10) * this.shieldCostMult),
            damage:    Math.floor((this.player.shipData.baseDamage + this.player.permDamageBonus) * this.damageCostMult),
            inventory: 60 * Math.pow(2, this.player.inventoryUpgradeTier)
        };

        const upgrades = [
            { id: 'health',    label: '+Max HP',  cost: permCosts.health,    stock: this.activeShop.permUpgrades.health.stock },
            { id: 'shield',    label: '+Shield',  cost: permCosts.shield,    stock: this.activeShop.permUpgrades.shield.stock },
            { id: 'damage',    label: '+Damage',  cost: permCosts.damage,    stock: this.activeShop.permUpgrades.damage.stock },
            { id: 'inventory', label: '+Cargo',   cost: permCosts.inventory, stock: this.activeShop.permUpgrades.inventory.stock }
        ];

        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        upgrades.forEach((up, i) => {
            const bx = startX;
            const by = startY + i * (btnH + gap);
            const canAfford = this.player.scrap >= up.cost;
            const available = up.stock > 0 && !up.maxed;

            ctx.fillStyle   = available ? (canAfford ? '#113322' : '#331111') : '#222222';
            ctx.strokeStyle = available ? (canAfford ? '#44ff44' : '#ff4444') : '#555555';
            ctx.lineWidth = 1;
            ctx.fillRect(bx, by, btnW, btnH);
            ctx.strokeRect(bx, by, btnW, btnH);

            ctx.fillStyle = available ? '#ffffff' : '#888888';
            ctx.fillText(up.label, bx + btnW / 2, by + Math.floor(btnH * 0.35));

            ctx.fillStyle = available ? (canAfford ? '#44ff44' : '#ff4444') : '#555555';
            ctx.fillText(up.maxed ? 'MAXED' : (available ? `${up.cost} SCRAP` : 'SOLD OUT'), bx + btnW / 2, by + Math.floor(btnH * 0.75));

            up.bounds = { x: bx, y: by, w: btnW, h: btnH, canBuy: available && canAfford, cost: up.cost, id: up.id, maxed: up.maxed };
        });

        this._currentPermButtons = upgrades;
        ctx.textBaseline = 'alphabetic';

        // ── Scrap display ─────────────────────────────────────────────────────
        ctx.fillStyle = '#ffff44';
        ctx.font = `${10 * uiScale}px Astro5x`;
        ctx.fillText(`SCRAP: ${this.player.scrap}`, cw / 2, playerLayout.panelY - 30 * uiScale);

        this._drawDraggedItem(ctx, slotSize, shopInv);

        ctx.fillStyle = '#667788';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('Drag to buy/sell/move • E to close', cw / 2, ch - uiScale * 10);

        this._drawInventoryTooltip(ctx, [
            { inv: shopInv,   layout: shopLayout,   scrollX: this.shopScrollX,   scrollY: this.shopScrollY },
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

        this._drawStatsPanel(ctx);
        this._drawClaimLevelsButton(ctx);
    }

    _drawTotalGameTimer(ctx) {
        const cw = this.game.width;
        const hudScale = this.game.hudScale;

        ctx.save();
        ctx.fillStyle = '#888888'; // Grey
        ctx.font = `${8 * hudScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        const minutes = Math.floor(this.trueTotalTime / 60);
        const seconds = Math.floor(this.trueTotalTime % 60);
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        ctx.fillText(timeStr, cw / 2, 10 * hudScale);
        ctx.restore();
    }

    _wrapText(ctx, text, maxWidth) {
        if (!text || typeof text !== 'string') return [];
        const words = text.split(' ');
        const lines = [];
        let currentLine = words[0];

        for (let i = 1; i < words.length; i++) {
            const word = words[i];
            const width = ctx.measureText(currentLine + " " + word).width;
            if (width < maxWidth) {
                currentLine += " " + word;
            } else {
                lines.push(currentLine);
                currentLine = word;
            }
        }
        lines.push(currentLine);
        return lines;
    }

    _getInventoryLayout(inv, yHint) {
        const uiScale = this.game.uiScale;
        const slotSize = 32 * uiScale;
        const borderSize = 48 * uiScale;

        const gridW = inv.cols * slotSize;
        const gridH = inv.rows * slotSize;

        const maxW = Math.floor(this.game.width * 0.4);
        const maxH = Math.floor(this.game.height * 0.4);

        let gridVisCols = inv.cols;
        let gridVisRows = inv.rows;

        const maxVisibleCols = Math.floor((maxW - borderSize * 2 + slotSize * 2) / slotSize);
        const maxVisibleRows = Math.floor((maxH - borderSize * 2 + slotSize * 2) / slotSize);

        if (gridVisCols > maxVisibleCols) {
            gridVisCols = maxVisibleCols;
        }
        if (gridVisRows > maxVisibleRows) {
            gridVisRows = maxVisibleRows;
        }

        const totalW = gridVisCols * slotSize + borderSize * 2 - slotSize * 2;
        const totalH = gridVisRows * slotSize + borderSize * 2 - slotSize * 2;

        const scrollableX = inv.cols > gridVisCols;
        const scrollableY = inv.rows > gridVisRows;

        const panelX = Math.floor((this.game.width - totalW) / 2);

        // yHint is 'shop', 'player', or 'pause'
        let panelY;
        if (yHint === 'shop') panelY = uiScale * 20;
        else if (yHint === 'player') panelY = this.game.height - totalH - uiScale * 40;
        else if (yHint === 'pause') panelY = uiScale * 24;

        const visW = gridVisCols * slotSize;
        const visH = gridVisRows * slotSize;

        const gridVisX = panelX + borderSize - slotSize;
        const gridVisY = panelY + borderSize - slotSize;

        const maxScrollX = Math.max(0, gridW - visW);
        const maxScrollY = Math.max(0, gridH - visH);

        const trackMargin = 8 * uiScale;
        const trackSize = 8 * uiScale;

        const trackYBounds = scrollableY ? { x: panelX + totalW + trackMargin, y: panelY, w: trackSize, h: totalH } : null;
        const trackXBounds = scrollableX ? { x: panelX, y: panelY + totalH + trackMargin, w: totalW, h: trackSize } : null;

        return {
            panelX, panelY, totalW, totalH,
            gridVisX, gridVisY, visW, visH,
            gridW, gridH,
            maxScrollX, maxScrollY, slotSize, borderSize,
            scrollableX, scrollableY,
            trackYBounds, trackXBounds, trackSize
        };
    }

    _drawScrollbars(ctx, layout, scrollX, scrollY) {
        if (!layout.scrollableX && !layout.scrollableY) return;

        const trackSize = layout.trackSize;

        if (layout.scrollableY && layout.trackYBounds) {
            const b = layout.trackYBounds;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, b.w / 2);
            ctx.fill();

            ctx.strokeStyle = '#334455';
            ctx.lineWidth = 1;
            ctx.stroke();

            const thumbH = Math.max(16 * this.game.uiScale, b.h * (layout.visH / layout.gridH));
            const thumbY = b.y + (b.h - thumbH) * (scrollY / layout.maxScrollY);

            ctx.fillStyle = '#44ddff';
            ctx.beginPath();
            ctx.roundRect(b.x + 1 * this.game.uiScale, thumbY + 1 * this.game.uiScale, b.w - 2 * this.game.uiScale, thumbH - 2 * this.game.uiScale, b.w / 2);
            ctx.fill();
        }

        if (layout.scrollableX && layout.trackXBounds) {
            const b = layout.trackXBounds;

            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.beginPath();
            ctx.roundRect(b.x, b.y, b.w, b.h, b.h / 2);
            ctx.fill();

            ctx.strokeStyle = '#334455';
            ctx.lineWidth = 1;
            ctx.stroke();

            const thumbW = Math.max(16 * this.game.uiScale, b.w * (layout.visW / layout.gridW));
            const thumbX = b.x + (b.w - thumbW) * (scrollX / layout.maxScrollX);

            ctx.fillStyle = '#44ddff';
            ctx.beginPath();
            ctx.roundRect(thumbX + 1 * this.game.uiScale, b.y + 1 * this.game.uiScale, thumbW - 2 * this.game.uiScale, b.h - 2 * this.game.uiScale, b.h / 2);
            ctx.fill();
        }
    }

    _drawInventoryGrid(ctx, inv, layout, scrollX, scrollY) {
        const { gridVisX: startX, gridVisY: startY, visW, visH, slotSize } = layout;

        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, startY, visW, visH);
        ctx.clip();
        // Draw slots
        ctx.strokeStyle = '#425a69';
        ctx.lineWidth = Math.max(1, Math.floor(this.game.hudScale));
        for (let r = 0; r < inv.rows; r++) {
            for (let c = 0; c < inv.cols; c++) {
                const sx = startX + c * slotSize - scrollX;
                const sy = startY + r * slotSize - scrollY;
                if (sx + slotSize >= startX && sx <= startX + visW && sy + slotSize >= startY && sy <= startY + visH) {
                    ctx.strokeRect(sx, sy, slotSize, slotSize);
                }
            }
        }

        const rarityColors = {
            common: 'rgba(0, 255, 0, 0.15)',
            uncommon: 'rgba(0, 120, 255, 0.2)',
            rare: 'rgba(180, 0, 255, 0.25)',
            epic: 'rgba(255, 0, 0, 0.25)',
            legendary: 'rgba(255, 255, 0, 0.3)',
            unique: 'rgba(255, 255, 255, 0.3)'
        };

        // Draw items
        for (const entry of inv.items) {
            if (this.draggedItem && this.draggedItem.entry === entry) continue;

            const { item, x, y } = entry;
            const frameAsset = this.game.getAnimationFrame(item.assetKey);
            const frame = frameAsset ? (frameAsset.canvas || frameAsset) : null;
            if (!frame) continue;

            const ix = startX + x * slotSize - scrollX;
            const iy = startY + y * slotSize - scrollY;
            const w = item.width * slotSize;
            const h = item.height * slotSize;

            // Simple cull
            if (ix + w < startX || ix > startX + visW || iy + h < startY || iy > startY + visH) continue;

            // Draw rarity overlay
            const baseColor = RARITY_COLORS[item.rarity] || '#ffffff';
            const alphaMap = { common: 0.15, uncommon: 0.2, rare: 0.25, epic: 0.25, legendary: 0.3, unique: 0.3 };
            ctx.globalAlpha = alphaMap[item.rarity] || 0.2;
            ctx.fillStyle = baseColor;
            ctx.fillRect(ix + 2, iy + 2, w - 4, h - 4); // Inset to keep grid lines clear
            ctx.globalAlpha = 1.0;

            ctx.drawImage(frame, ix, iy, w, h);
        }

        // Draw overflow scroll indicators
        const shadowSize = 12 * this.game.uiScale;
        const maxAlpha = 0.6;

        if (scrollX > 0) {
            const alpha = Math.min(1, scrollX / slotSize) * maxAlpha;
            const grad = ctx.createLinearGradient(startX, 0, startX + shadowSize, 0);
            grad.addColorStop(0, `rgba(68, 221, 255, ${alpha})`);
            grad.addColorStop(1, 'rgba(68, 221, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(startX, startY, shadowSize, visH);
        }
        if (scrollX < layout.maxScrollX) {
            const scrollRemaining = layout.maxScrollX - scrollX;
            const alpha = Math.min(1, scrollRemaining / slotSize) * maxAlpha;
            const grad = ctx.createLinearGradient(startX + visW, 0, startX + visW - shadowSize, 0);
            grad.addColorStop(0, `rgba(68, 221, 255, ${alpha})`);
            grad.addColorStop(1, 'rgba(68, 221, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(startX + visW - shadowSize, startY, shadowSize, visH);
        }
        if (scrollY > 0) {
            const alpha = Math.min(1, scrollY / slotSize) * maxAlpha;
            const grad = ctx.createLinearGradient(0, startY, 0, startY + shadowSize);
            grad.addColorStop(0, `rgba(68, 221, 255, ${alpha})`);
            grad.addColorStop(1, 'rgba(68, 221, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(startX, startY, visW, shadowSize);
        }
        if (scrollY < layout.maxScrollY) {
            const scrollRemaining = layout.maxScrollY - scrollY;
            const alpha = Math.min(1, scrollRemaining / slotSize) * maxAlpha;
            const grad = ctx.createLinearGradient(0, startY + visH, 0, startY + visH - shadowSize);
            grad.addColorStop(0, `rgba(68, 221, 255, ${alpha})`);
            grad.addColorStop(1, 'rgba(68, 221, 255, 0)');
            ctx.fillStyle = grad;
            ctx.fillRect(startX, startY + visH - shadowSize, visW, shadowSize);
        }

        ctx.restore();
    }

    _drawTooltip(ctx, item, mouse) {
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        const pad = 8 * uiScale;
        const fontSize = Math.floor(5 * uiScale);
        const titleFontSize = Math.floor(6 * uiScale);
        ctx.font = `${fontSize}px Astro4x`;

        // Calculate dimensions
        const name = item.name.toUpperCase();
        const rarity = (item.rarity || 'common').toUpperCase();
        const desc = item.description || '';

        const maxWidth = 120 * uiScale;
        const descLines = this._wrapText(ctx, desc, maxWidth);

        const headerW = Math.max(ctx.measureText(name).width * 1.2, ctx.measureText(rarity).width);
        const tw = Math.max(headerW, descLines.reduce((max, l) => Math.max(max, ctx.measureText(l).width), 0)) + pad * 2;
        const th = (descLines.length + 3) * fontSize * 1.5 + pad * 2;

        let tx = mouse.x + 10;
        let ty = mouse.y + 10;
        if (tx + tw > cw) tx = mouse.x - tw - 10;
        if (ty + th > ch) ty = mouse.y - th - 10;

        ctx.save();

        // Frame
        ctx.fillStyle = 'rgba(25, 45, 80, 0.99)';
        ctx.strokeStyle = '#44ddff';
        ctx.lineWidth = 1.5;
        ctx.fillRect(tx, ty, tw, th);
        ctx.strokeRect(tx, ty, tw, th);

        let cy = ty + pad;

        // Name
        ctx.font = `${titleFontSize}px Astro5x`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(name, tx + pad, cy);
        cy += titleFontSize * 1.5;

        // Rarity
        ctx.font = `${fontSize}px Astro4x`;
        ctx.fillStyle = RARITY_COLORS[item.rarity] || '#ffffff';
        ctx.fillText(rarity, tx + pad, cy);
        cy += fontSize * 2;

        // Divider
        ctx.strokeStyle = '#335577';
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

        if (item.cost) {
            cy += fontSize * 0.5;
            ctx.fillStyle = '#ffff44';
            ctx.fillText(`BASE VALUE: ${item.cost} SCRAP`, tx + pad, cy);
        }

        ctx.restore();
    }
    // ── Shared inventory UI helpers ────────────────────────────────────────────

    // Renders the currently-dragged item under the cursor.
    // Pass shopInv to show a cost indicator when dragging from the shop.
    _drawDraggedItem(ctx, slotSize, shopInv = null) {
        if (!this.draggedItem) return;
        const { item, offsetX, offsetY } = this.draggedItem;
        const mouse = this.game.getMousePos();
        const frameAsset = this.game.getAnimationFrame(item.assetKey);
        if (!frameAsset) return;
        const frame = frameAsset.canvas || frameAsset;
        const w = item.width  * slotSize;
        const h = item.height * slotSize;
        ctx.drawImage(frame, mouse.x - offsetX, mouse.y - offsetY, w, h);
        if (shopInv && this.draggedItem.originInventory === shopInv) {
            ctx.fillStyle = this.player.scrap >= item.cost ? '#44ff44' : '#ff4444';
            ctx.font = `${6 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.fillText(`COST: ${item.cost}`, mouse.x - offsetX + w / 2, mouse.y - offsetY + h + 10);
        }
    }

    // Renders the "CLAIM N LEVELS" button (shared across shop, cache, and pause).
    _drawClaimLevelsButton(ctx) {
        const cl = this.pauseButtons.claimLevels;
        if (cl.w <= 0) return;
        const count = this.levelUpQueue.length;
        const us = this.game.uiScale;
        ctx.fillStyle   = cl.hovered ? '#333300' : '#1a1a00';
        ctx.strokeStyle = cl.hovered ? '#ffff55' : '#aaaa00';
        ctx.lineWidth = 1;
        ctx.fillRect(cl.x, cl.y, cl.w, cl.h);
        ctx.strokeRect(cl.x, cl.y, cl.w, cl.h);
        ctx.fillStyle = cl.hovered ? '#ffff55' : '#cccc00';
        ctx.font = `${6 * us}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`CLAIM ${count} LEVEL${count !== 1 ? 'S' : ''}`, cl.x + cl.w / 2, cl.y + cl.h / 2);
    }

    // Draws a tooltip for the first item found under the mouse across all given panels.
    // panels: [{ inv, layout, scrollX, scrollY }]
    _drawInventoryTooltip(ctx, panels) {
        if (this.draggedItem) return;
        const mouse = this.game.getMousePos();
        for (const p of panels) {
            const vx = mouse.x - p.layout.gridVisX;
            const vy = mouse.y - p.layout.gridVisY;
            if (vx >= 0 && vx < p.layout.visW && vy >= 0 && vy < p.layout.visH) {
                const entry = p.inv.getItemAt(
                    Math.floor((vx + p.scrollX) / p.layout.slotSize),
                    Math.floor((vy + p.scrollY) / p.layout.slotSize)
                );
                if (entry) { this._drawTooltip(ctx, entry.item, mouse); return; }
            }
        }
    }

    // Attempts to use a consumable item. Returns true if the item was handled.
    _tryUseConsumable(entry, playerInv) {
        if (!entry || !entry.item.consumable) return false;
        const id = entry.item.id;
        if (id === 'small_battery') {
            this.player.heal(0.2);
            playerInv.removeItemAt(entry.x, entry.y);
            this.game.sounds.play('select', 0.8);
            this._onInventoryChanged();
            return true;
        }
        if (id === 'shop_map') {
            if (this.spawnDistantShop()) {
                playerInv.removeItemAt(entry.x, entry.y);
                this.game.sounds.play('select', 0.8);
                this._onInventoryChanged();
            }
            return true;
        }
        if (id === 'advanced_locator') {
            if (this.revealNearestEvent()) {
                playerInv.removeItemAt(entry.x, entry.y);
                this.game.sounds.play('select', 0.8);
                this._onInventoryChanged();
            } else {
                this.game.sounds.play('asteroid_break', 0.5);
            }
            return true;
        }
        return false;
    }

    // Handles right-click consumable use from the player inventory.
    _handleRightClickConsumable(mouse, playerLayout, playerInv) {
        if (!this.game.input.isMouseJustPressed(2) || this.draggedItem) return;
        const vx = mouse.x - playerLayout.gridVisX;
        const vy = mouse.y - playerLayout.gridVisY;
        if (vx < 0 || vx >= playerLayout.visW || vy < 0 || vy >= playerLayout.visH) return;
        const entry = playerInv.getItemAt(
            Math.floor((vx + this.playerScrollX) / playerLayout.slotSize),
            Math.floor((vy + this.playerScrollY) / playerLayout.slotSize)
        );
        this._tryUseConsumable(entry, playerInv);
    }

    // Applies mouse-wheel / trackpad-pan scroll input to the given panels.
    // panels: [{ layout, scrollXKey, scrollYKey }]  — *Key props are property names on `this`
    _applyScrollInput(panels) {
        const mouse = this.game.getMousePos();
        for (const p of panels) {
            const { layout } = p;
            if (mouse.x >= layout.gridVisX && mouse.x <= layout.gridVisX + layout.visW &&
                mouse.y >= layout.gridVisY && mouse.y <= layout.gridVisY + layout.visH) {
                this[p.scrollYKey] += this.game.input.mouseWheelDelta;
                this[p.scrollXKey] -= this.game.input.mousePanDeltaX;
                this[p.scrollYKey] -= this.game.input.mousePanDeltaY;
                break;
            }
        }
    }

    // Tries to pick up an item from inv at the mouse position. Returns true if successful.
    // scrollXKey / scrollYKey are property names on `this`.
    _tryPickUpItem(mouse, inv, layout, scrollXKey, scrollYKey) {
        const slotSize = 32 * this.game.uiScale;
        const vx = mouse.x - layout.gridVisX;
        const vy = mouse.y - layout.gridVisY;
        if (vx < 0 || vx >= layout.visW || vy < 0 || vy >= layout.visH) return false;
        const entry = inv.getItemAt(
            Math.floor((vx + this[scrollXKey]) / slotSize),
            Math.floor((vy + this[scrollYKey]) / slotSize)
        );
        if (!entry) return false;
        const offsetX = mouse.x - (layout.gridVisX - this[scrollXKey] + entry.x * slotSize);
        const offsetY = mouse.y - (layout.gridVisY - this[scrollYKey] + entry.y * slotSize);
        inv.removeItemAt(entry.x, entry.y);
        this.draggedItem = { ...entry, entry, originInventory: inv, offsetX, offsetY };
        this.game.sounds.play('click', 0.5);
        return true;
    }

    // Returns the snapped grid {col, row} for dropping the dragged item onto a panel.
    _getDropPosition(mouse, layout, scrollXKey, scrollYKey) {
        const slotSize = 32 * this.game.uiScale;
        return {
            col: Math.floor((mouse.x - layout.gridVisX + this[scrollXKey] - this.draggedItem.offsetX) / slotSize + 0.5),
            row: Math.floor((mouse.y - layout.gridVisY + this[scrollYKey] - this.draggedItem.offsetY) / slotSize + 0.5)
        };
    }

    // Applies edge-scrolling while an item is being dragged near the border of a panel.
    _applyEdgeScroll(dt, panels, baseSpeed = 300) {
        if (!this.draggedItem) return;
        const mouse = this.game.getMousePos();
        const uiScale = this.game.uiScale;
        const edgeMargin = 40 * uiScale;
        const speed = baseSpeed * dt * uiScale;
        for (const p of panels) {
            const { layout } = p;
            if (mouse.x >= layout.gridVisX && mouse.x <= layout.gridVisX + layout.visW &&
                mouse.y >= layout.gridVisY && mouse.y <= layout.gridVisY + layout.visH) {
                if (layout.scrollableY) {
                    if (mouse.y < layout.gridVisY + edgeMargin)                    this[p.scrollYKey] -= speed;
                    else if (mouse.y > layout.gridVisY + layout.visH - edgeMargin) this[p.scrollYKey] += speed;
                }
                if (layout.scrollableX) {
                    if (mouse.x < layout.gridVisX + edgeMargin)                    this[p.scrollXKey] -= speed;
                    else if (mouse.x > layout.gridVisX + layout.visW - edgeMargin) this[p.scrollXKey] += speed;
                }
            }
        }
    }

    // Updates the Claim Levels button position/hover and opens the dialog on click.
    // Returns true if the dialog was opened (caller should return early).
    _updateClaimLevelsButton(mouse, origin) {
        const cl = this.pauseButtons.claimLevels;
        if (this.levelUpQueue.length > 0 && this._statsPanelRect) {
            const sp = this._statsPanelRect;
            const us = this.game.uiScale;
            cl.x = Math.floor(sp.x);
            cl.y = Math.floor(sp.y + sp.h + us * 6);
            cl.w = Math.floor(sp.w);
            cl.h = Math.floor(us * 20);
            cl.hovered = mouse.x >= cl.x && mouse.x <= cl.x + cl.w &&
                         mouse.y >= cl.y && mouse.y <= cl.y + cl.h;
            if (this.game.input.isMouseJustPressed(0) && cl.hovered && !this.draggedItem) {
                this._levelUpOrigin = origin;
                this._openLevelUpDialog(this.levelUpQueue.shift());
                return true;
            }
        } else {
            cl.w = 0;
            cl.h = 0;
        }
        return false;
    }

    // panels: [{ layout, scrollXKey, scrollYKey }]
    _updateScrollbarDragging(mouse, panels) {
        if (!this.game.input.isMouseDown(0)) {
            this.draggingScrollbar = null;
            return false;
        }

        if (this.game.input.isMouseJustPressed(0)) {
            for (const p of panels) {
                const { layout } = p;
                if (layout.scrollableY && layout.trackYBounds) {
                    const b = layout.trackYBounds;
                    if (mouse.x >= b.x - 4 * this.game.uiScale && mouse.x <= b.x + b.w + 4 * this.game.uiScale &&
                        mouse.y >= b.y && mouse.y <= b.y + b.h) {
                        const thumbH = Math.max(16 * this.game.uiScale, b.h * (layout.visH / layout.gridH));
                        const thumbY = b.y + (b.h - thumbH) * (this[p.scrollYKey] / layout.maxScrollY);
                        const offset = (mouse.y >= thumbY && mouse.y <= thumbY + thumbH) ? mouse.y - thumbY : thumbH / 2;
                        this.draggingScrollbar = { layout, scrollXKey: p.scrollXKey, scrollYKey: p.scrollYKey, axis: 'y', offset };
                        return true;
                    }
                }
                if (layout.scrollableX && layout.trackXBounds) {
                    const b = layout.trackXBounds;
                    if (mouse.x >= b.x && mouse.x <= b.x + b.w &&
                        mouse.y >= b.y - 4 * this.game.uiScale && mouse.y <= b.y + b.h + 4 * this.game.uiScale) {
                        const thumbW = Math.max(16 * this.game.uiScale, b.w * (layout.visW / layout.gridW));
                        const thumbX = b.x + (b.w - thumbW) * (this[p.scrollXKey] / layout.maxScrollX);
                        const offset = (mouse.x >= thumbX && mouse.x <= thumbX + thumbW) ? mouse.x - thumbX : thumbW / 2;
                        this.draggingScrollbar = { layout, scrollXKey: p.scrollXKey, scrollYKey: p.scrollYKey, axis: 'x', offset };
                        return true;
                    }
                }
            }
        }

        if (this.draggingScrollbar) {
            const drag = this.draggingScrollbar;
            if (!drag.layout) { this.draggingScrollbar = null; return false; }
            if (drag.axis === 'y') {
                const b = drag.layout.trackYBounds;
                const thumbH = Math.max(16 * this.game.uiScale, b.h * (drag.layout.visH / drag.layout.gridH));
                this[drag.scrollYKey] = ((mouse.y - b.y - drag.offset) / (b.h - thumbH)) * drag.layout.maxScrollY;
            } else {
                const b = drag.layout.trackXBounds;
                const thumbW = Math.max(16 * this.game.uiScale, b.w * (drag.layout.visW / drag.layout.gridW));
                this[drag.scrollXKey] = ((mouse.x - b.x - drag.offset) / (b.w - thumbW)) * drag.layout.maxScrollX;
            }
            return true;
        }
        return false;
    }

    _clampScrollPanels(panels) {
        for (const p of panels) {
            this[p.scrollXKey] = Math.max(0, Math.min(this[p.scrollXKey], p.layout.maxScrollX));
            this[p.scrollYKey] = Math.max(0, Math.min(this[p.scrollYKey], p.layout.maxScrollY));
        }
    }

    // Handles all scroll input for the given panels in one call.
    // Returns true if a scrollbar was dragged (caller should return early to skip drag-drop).
    _applyScrollPanels(dt, mouse, panels, edgeSpeed = 300) {
        if (this._updateScrollbarDragging(mouse, panels)) {
            this._clampScrollPanels(panels);
            return true;
        }
        this._applyEdgeScroll(dt, panels, edgeSpeed);
        this._applyScrollInput(panels);
        this._clampScrollPanels(panels);
        return false;
    }

    _updateCacheUI(dt) {
        const ui = this.activeCacheUI;
        if (!ui) return;

        ui.update(dt);

        const mouse     = this.game.getMousePos();
        const cacheInv  = ui.cacheInventory;
        const playerInv = this.player.inventory;

        const cacheLayout  = this._getInventoryLayout(cacheInv,  'shop');
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        const panels = [
            { layout: cacheLayout,  scrollXKey: 'cacheScrollX',  scrollYKey: 'cacheScrollY' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY' }
        ];

        if (this._applyScrollPanels(dt, mouse, panels)) return;

        // ── Skip animation on click ──────────────────────────────────────────
        if (this.game.input.isMouseJustPressed(0) && ui.isAnimating) {
            ui.skipRequested = true;
        }

        // ── Drag-drop (only when IDLE) ───────────────────────────────────────
        if (!ui.isAnimating) {
            if (this.game.input.isMouseJustPressed(0) && !this.draggedItem) {
                if (!this._tryPickUpItem(mouse, cacheInv, cacheLayout, 'cacheScrollX', 'cacheScrollY')) {
                    this._tryPickUpItem(mouse, playerInv, playerLayout, 'playerScrollX', 'playerScrollY');
                }
            }

            // Release drag
            if (this.draggedItem && !this.game.input.isMouseDown(0)) {
                const { col: pCol, row: pRow } = this._getDropPosition(mouse, playerLayout, 'playerScrollX', 'playerScrollY');
                const { col: cCol, row: cRow } = this._getDropPosition(mouse, cacheLayout,  'cacheScrollX',  'cacheScrollY');

                if (playerInv.canFit(this.draggedItem.item, pCol, pRow)) {
                    playerInv.addItem(this.draggedItem.item, pCol, pRow);
                    this._onInventoryChanged(true);
                    this.game.sounds.play('select', 0.8);
                    if (this.draggedItem.originInventory === cacheInv && cacheInv.items.length === 0) {
                        if (this._activeCache) this._activeCache.markEmptied();
                    }
                } else if (cacheInv.canFit(this.draggedItem.item, cCol, cRow)) {
                    cacheInv.addItem(this.draggedItem.item, cCol, cRow);
                    if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                    this.game.sounds.play('click', 0.5);
                } else {
                    // Check if mouse is outside both inventory panels → drop into space
                    const inCache  = mouse.x >= cacheLayout.gridVisX  && mouse.x <= cacheLayout.gridVisX  + cacheLayout.visW  &&
                                     mouse.y >= cacheLayout.gridVisY  && mouse.y <= cacheLayout.gridVisY  + cacheLayout.visH;
                    const inPlayer = mouse.x >= playerLayout.gridVisX && mouse.x <= playerLayout.gridVisX + playerLayout.visW &&
                                     mouse.y >= playerLayout.gridVisY && mouse.y <= playerLayout.gridVisY + playerLayout.visH;

                    if (!inCache && !inPlayer) {
                        const worldMouse = this.camera.screenToWorld(mouse.x, mouse.y, this.game.width, this.game.height);
                        const dropOffset  = (Math.random() - 0.5) * 20;
                        const dropOffset2 = (Math.random() - 0.5) * 20;
                        this.itemPickups.push(new ItemPickup(this.game, worldMouse.x + dropOffset, worldMouse.y + dropOffset2, this.draggedItem.item));
                        if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                        if (this.draggedItem.originInventory === cacheInv && cacheInv.items.length === 0) {
                            if (this._activeCache) this._activeCache.markEmptied();
                        }
                        this.game.sounds.play('click', 0.5);
                    } else {
                        this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                        if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                        this.game.sounds.play('click', 0.3);
                    }
                }

                this.draggedItem = null;
            }

            this._handleRightClickConsumable(mouse, playerLayout, playerInv);
        }

        if (this._updateClaimLevelsButton(mouse, 'cache')) return;

        // ── E or ESC closes ───────────────────────────────────────────────────
        if (this.game.input.isKeyJustPressed('KeyE') || this.game.input.isKeyJustPressed('Escape')) {
            if (this.draggedItem) {
                this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                this.draggedItem = null;
            }
            ui.close();
        }

        // ── Teardown ─────────────────────────────────────────────────────────
        if (ui.isClosed) {
            this.isCacheOpen = false;
            this.paused      = false;
            if (this._activeCache) this._activeCache.close();
            this.activeCacheUI  = null;
            this._activeCache   = null;
            this.cacheScrollX   = 0;
            this.cacheScrollY   = 0;
        }
    }

    _updateShopUI(dt) {
        const mouse = this.game.getMousePos();

        const shopInv    = this.activeShop.inventory;
        const shopLayout = this._getInventoryLayout(shopInv, 'shop');
        const playerInv  = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        const panels = [
            { layout: shopLayout,   scrollXKey: 'shopScrollX',   scrollYKey: 'shopScrollY' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY' }
        ];

        if (this._applyScrollPanels(dt, mouse, panels)) return;

        if (this.game.input.isMouseJustPressed(0)) {
            // Check Permanent Upgrade clicks
            if (this._currentPermButtons) {
                let clickedPerm = false;
                for (const btn of this._currentPermButtons) {
                    if (mouse.x >= btn.bounds.x && mouse.x <= btn.bounds.x + btn.bounds.w &&
                        mouse.y >= btn.bounds.y && mouse.y <= btn.bounds.y + btn.bounds.h) {

                        clickedPerm = true;
                        if (btn.bounds.canBuy) {
                            this.player.scrap -= btn.bounds.cost;
                            this.activeShop.permUpgrades[btn.bounds.id].stock--;

                            if (btn.bounds.id === 'health') {
                                this.player.permHealthBonus += 30;
                                this._onInventoryChanged(true);
                            } else if (btn.bounds.id === 'shield') {
                                this.player.updateMaxShield(100);
                            } else if (btn.bounds.id === 'damage') {
                                this.player.permDamageBonus += 5.0;
                                this.game.sounds.play('laser', 0.2);
                            } else if (btn.bounds.id === 'inventory') {
                                this.player.inventoryUpgradeTier++;
                                const ejected = this.player.inventory.resize(this.player.inventory.cols + 1, this.player.inventory.rows);
                                if (ejected && ejected.length > 0) this._ejectItems(ejected);
                            }
                            this.game.sounds.play('select', 0.8);
                        } else {
                            if (!btn.bounds.maxed && this.activeShop.permUpgrades[btn.bounds.id].stock > 0) {
                                this.game.sounds.play('asteroid_break', 0.3);
                            }
                        }
                        break;
                    }
                }
                if (clickedPerm) return;
            }

            if (!this._tryPickUpItem(mouse, shopInv, shopLayout, 'shopScrollX', 'shopScrollY')) {
                this._tryPickUpItem(mouse, playerInv, playerLayout, 'playerScrollX', 'playerScrollY');
            }
        }

        this._handleRightClickConsumable(mouse, playerLayout, playerInv);

        if (this.draggedItem && !this.game.input.isMouseDown(0)) {
            const { col: pCol, row: pRow } = this._getDropPosition(mouse, playerLayout, 'playerScrollX', 'playerScrollY');
            const { col: sCol, row: sRow } = this._getDropPosition(mouse, shopLayout,   'shopScrollX',   'shopScrollY');

            // 1. Try Drop in Player Inventory
            if (playerInv.canFit(this.draggedItem.item, pCol, pRow)) {
                if (this.draggedItem.originInventory === shopInv) {
                    if (this.player.scrap >= this.draggedItem.item.cost) {
                        this.player.scrap -= this.draggedItem.item.cost;
                        playerInv.addItem(this.draggedItem.item, pCol, pRow);
                        this.game.sounds.play('select', 0.8);
                        this._onInventoryChanged(true);
                    } else {
                        shopInv.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                        this.game.sounds.play('asteroid_break', 0.5);
                    }
                } else {
                    playerInv.addItem(this.draggedItem.item, pCol, pRow);
                    this.game.sounds.play('click', 0.5);
                    this._onInventoryChanged();
                }
            }
            // 2. Try Drop in Shop Inventory (Sell/Return)
            else if (shopInv.canFit(this.draggedItem.item, sCol, sRow)) {
                if (this.draggedItem.originInventory === playerInv) {
                    this.player.scrap += Math.floor(this.draggedItem.item.cost * 0.7);
                    shopInv.addItem(this.draggedItem.item, sCol, sRow);
                    this.game.sounds.play('select', 0.8);
                    this._onInventoryChanged();
                } else {
                    shopInv.addItem(this.draggedItem.item, sCol, sRow);
                    this.game.sounds.play('click', 0.5);
                }
            }
            // 3. Drop failed
            else {
                if (this.draggedItem.originInventory === shopInv) {
                    this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                    this.game.sounds.play('click', 0.3);
                } else {
                    const worldMouse = this.camera.screenToWorld(mouse.x, mouse.y, this.game.width, this.game.height);
                    const dropOffset  = (Math.random() - 0.5) * 20;
                    const dropOffset2 = (Math.random() - 0.5) * 20;
                    this.itemPickups.push(new ItemPickup(this.game, worldMouse.x + dropOffset, worldMouse.y + dropOffset2, this.draggedItem.item));
                    this._onInventoryChanged();
                    this.game.sounds.play('click', 0.5);
                }
            }

            this.draggedItem = null;
        }

        if (this._updateClaimLevelsButton(mouse, 'shop')) return;

        if (this.game.input.isKeyJustPressed('KeyE') || this.game.input.isKeyJustPressed('Escape')) {
            if (this.draggedItem) {
                this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                this.draggedItem = null;
            }
            this.isShopOpen = false;
            this.paused = false;
            this.activeShop = null;
            this.game.sounds.play('click', 0.5);
        }
    }

    _updatePauseUI(dt) {
        const mouse = this.game.getMousePos();
        const uiScale = this.game.uiScale;
        const cw = this.game.width;
        const ch = this.game.height;

        const playerInv    = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'pause');

        const panels = [{ layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY' }];

        if (this._applyScrollPanels(dt, mouse, panels, 500)) return;

        // Volume Buttons Layout (MUST match menuState.js exactly)
        const volMargin  = Math.floor(uiScale * 8);
        const volBtnSize = this.game.spriteSize('left_arrow_off', uiScale);
        const volBtnW    = volBtnSize.w;
        const volBtnH    = volBtnSize.h;
        const lineH      = Math.floor(uiScale * 20);
        const barW       = Math.floor(uiScale * 60);
        const volGap     = Math.floor(uiScale * 6);

        this.pauseButtons.musicInc.x = cw - volMargin - volBtnW;
        this.pauseButtons.musicInc.y = ch - volMargin - volBtnH;
        this.pauseButtons.musicInc.w = volBtnW;
        this.pauseButtons.musicInc.h = volBtnH;

        this.pauseButtons.musicDec.x = this.pauseButtons.musicInc.x - barW - volBtnW - volGap * 2;
        this.pauseButtons.musicDec.y = this.pauseButtons.musicInc.y;
        this.pauseButtons.musicDec.w = volBtnW;
        this.pauseButtons.musicDec.h = volBtnH;

        this.pauseButtons.sfxInc.x = this.pauseButtons.musicInc.x;
        this.pauseButtons.sfxInc.y = this.pauseButtons.musicInc.y - lineH;
        this.pauseButtons.sfxInc.w = volBtnW;
        this.pauseButtons.sfxInc.h = volBtnH;

        this.pauseButtons.sfxDec.x = this.pauseButtons.musicDec.x;
        this.pauseButtons.sfxDec.y = this.pauseButtons.sfxInc.y;
        this.pauseButtons.sfxDec.w = volBtnW;
        this.pauseButtons.sfxDec.h = volBtnH;

        const shipSelSize = this.game.spriteSize('ship_selection_off', uiScale);
        this.pauseButtons.shipSelection.x = Math.floor(cw / 2 - shipSelSize.w / 2);
        this.pauseButtons.shipSelection.y = ch - Math.floor(uiScale * 30) - shipSelSize.h;
        this.pauseButtons.shipSelection.w = shipSelSize.w;
        this.pauseButtons.shipSelection.h = shipSelSize.h;

        this._updateClaimLevelsButton(mouse, 'pause');

        if (this.confirmRestart) {
            this.confirmRestartButtons.yes = {
                x: Math.floor(cw / 2 - 40 * uiScale), y: ch / 2 + 20 * uiScale,
                w: 30 * uiScale, h: 20 * uiScale, hovered: false
            };
            this.confirmRestartButtons.no = {
                x: Math.floor(cw / 2 + 10 * uiScale), y: ch / 2 + 20 * uiScale,
                w: 30 * uiScale, h: 20 * uiScale, hovered: false
            };
        }

        // Hover checks
        const pb = this.pauseButtons;
        for (const k in pb) {
            const b = pb[k];
            b.hovered = mouse.x >= b.x && mouse.x <= b.x + b.w && mouse.y >= b.y && mouse.y <= b.y + b.h;
        }

        if (this.confirmRestart) {
            for (const k in this.confirmRestartButtons) {
                const b = this.confirmRestartButtons[k];
                b.hovered = mouse.x >= b.x && mouse.x <= b.x + b.w && mouse.y >= b.y && mouse.y <= b.y + b.h;
            }
        }

        if (this.game.input.isMouseJustPressed(0)) {
            if (this.confirmRestart) {
                if (this.confirmRestartButtons.yes.hovered) {
                    this.game.sounds.play('select', 1.0);
                    this.game.setState(new MenuState(this.game));
                    return;
                }
                if (this.confirmRestartButtons.no.hovered) {
                    this.game.sounds.play('click', 0.5);
                    this.confirmRestart = false;
                    return;
                }
            } else {
                if (pb.shipSelection.hovered) {
                    this.game.sounds.play('click', 0.5);
                    this.confirmRestart = true;
                    return;
                }
            }

            if (pb.musicDec.hovered) this.game.sounds.setMusicVolume(this.game.sounds.musicVolume - 0.1);
            if (pb.musicInc.hovered) this.game.sounds.setMusicVolume(this.game.sounds.musicVolume + 0.1);
            if (pb.sfxDec.hovered)   this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume - 0.1);
            if (pb.sfxInc.hovered)   this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume + 0.1);
            if (pb.musicDec.hovered || pb.musicInc.hovered || pb.sfxDec.hovered || pb.sfxInc.hovered) {
                this.game.sounds.play('click', 0.5);
            }

            this._tryPickUpItem(mouse, playerInv, playerLayout, 'playerScrollX', 'playerScrollY');
        }

        this._handleRightClickConsumable(mouse, playerLayout, playerInv);

        if (this.draggedItem && !this.game.input.isMouseDown(0)) {
            const { col: pCol, row: pRow } = this._getDropPosition(mouse, playerLayout, 'playerScrollX', 'playerScrollY');

            if (playerInv.canFit(this.draggedItem.item, pCol, pRow)) {
                playerInv.addItem(this.draggedItem.item, pCol, pRow);
                this.game.sounds.play('click', 0.5);
                this._onInventoryChanged();
            } else {
                const worldMouse = this.camera.screenToWorld(mouse.x, mouse.y, this.game.width, this.game.height);
                const dropOffset  = (Math.random() - 0.5) * 20;
                const dropOffset2 = (Math.random() - 0.5) * 20;
                this.itemPickups.push(new ItemPickup(this.game, worldMouse.x + dropOffset, worldMouse.y + dropOffset2, this.draggedItem.item));
                this._onInventoryChanged();
                this.game.sounds.play('click', 0.5);
            }
            this.draggedItem = null;
        }
    }

    _drawInteractPrompt(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        ctx.save();
        ctx.fillStyle = '#ffff44';
        ctx.font = `${10 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        // Above player (player is centered at cw/2, ch/2) - Increased height
        ctx.fillText('E', cw / 2, ch / 2 - 60 * this.game.worldScale);
        ctx.restore();
    }

    _calculatePlayerPowerLevel() {
        if (!this.player) return 0;
        let power = 0;

        // 1. Inventory Weight (Rarity-weighted)
        if (this.player.inventory) {
            for (const entry of this.player.inventory.items) {
                const item = entry.item;
                const rarity = (item.rarity || 'common').toLowerCase();
                switch (rarity) {
                    case 'common': power += 0.04; break;
                    case 'uncommon': power += 0.08; break;
                    case 'rare': power += 0.15; break;
                    case 'epic': power += 0.35; break;
                    case 'legendary': power += 0.7; break;
                    case 'unique': power += 1.0; break;
                    default: power += 0.04; break;
                }
            }
        }

        // 2. Permanent Upgrades Weight
        // Health: 50hp blocks. ~0.1 per block.
        const healthWeight = (this.player.permHealthBonus / 50) * 0.15;
        // Shield: 50 energy blocks. ~0.1 per block.
        const shieldWeight = (this.player.permShieldBonus / 50) * 0.15;
        // Damage: flat bonus. ~0.2 per 10 points. 
        const damageWeight = (this.player.permDamageBonus / 10) * 0.25;

        power += healthWeight + shieldWeight + damageWeight;

        // 3. Additional high-power flags
        if (this.player.hasMultishotGuns) power += 0.1;
        if (this.player.hasExplosivesUnit) power += 0.15;
        if (this.player.hasRailgun) power += 0.1;

        return power;
    }

    _onInventoryChanged(healAcquisition = false) {
        const p = this.player;
        const oldMax = p.maxHealth;

        // Reset multipliers and flags
        p.fireRateMult = 1.0;
        p.boostRangeMult = 1.0;
        p.boostSpeedMult = 1.0;
        p.boostCooldownMult = 1.0;
        p.shieldDrainMult = 1.0;
        p.scrapRangeMult = 1.0;
        p.hasTeleport = p.shipData.special === 'teleport';
        p.hasRailgun = false;
        p.hasEnergyBlaster = false;
        p.energyBlasterCount = 0;
        p.hasRepeater = false;
        p.hasLaserOverride = false;
        p.pulseJetMult = 1.0;
        p.shieldBoosterMult = 1.0;
        p.hasTargetingModule = false;
        p.hasControlModule = false;
        p.hasWarningSystem = false;
        p.mechanicalEngineTurnMult = 1.0;
        p.mechanicalEngineSpeedMult = 1.0;
        p.shieldRegenMult = 1.0;
        p.hasMultishotGuns = false;
        p.hasExplosivesUnit = false;
        p.hasAncientCurse = false;
        p.hasBoostDrive = false;
        p.naniteRegen = 0;
        p.shieldCapacitorCount = 0;
        p.asteroidSpawnMult = 1.0;
        p.friction = 0.95;
        p.momentumSpeedMult = 1.0;
        p.momentumMaxSpeedMult = 1.0;
        p.momentumBoostMult = 1.0;
        p.experienceCondenserMult = 1.0;
        p.asteroidDrillMult = 1.0;
        p.laserCartridgeMult = 1.0;

        // Knowledge Event Upgrades
        p.hasSacrifice = false;
        p.hasRadar = false;
        p.obedienceMult = 1.0;
        p.hasCosmosEngine = false;
        p.luck = 1.0;

        this.hasAutoTurret = false;
        this.hasMechanicalClaw = false;
        this.hasRockets = false;

        let boostCooldownMult = 1.0;
        let boostRangeMult = 1.0;
        let shieldDrainMult = 1.0;
        let scrapRangeMult = 1.0;
        let fireRateMult = 1.0;
        let shieldRegenMult = 1.0;
        let maxHealthMult = 1.0;

        let blinkEngines = 0;
        let repeaters = 0;
        let cargoExpansions = 0;

        let fovMult = 1.0; // Default base FOV
        for (const entry of p.inventory.items) {
            const item = entry.item;

            if (item.id === 'blink_engine') blinkEngines++;
            if (item.id === 'firing_coordinator') fireRateMult *= 0.9;
            if (item.id === 'energy_canisters') {
                maxHealthMult *= 1.6;
            }
            if (item.id === 'pulse_boosters') {
                boostRangeMult *= 1.4;
                boostCooldownMult *= 0.7;
            }
            if (item.id === 'field_array') shieldDrainMult *= 0.7;
            if (item.id === 'scrap_drone') scrapRangeMult *= 4.0;
            if (item.id === 'auto_turret') this.hasAutoTurret = true;
            if (item.id === 'mechanical_claw') this.hasMechanicalClaw = true;
            if (item.id === 'railgun') p.hasRailgun = true;
            if (item.id === 'energy_blaster') {
                p.hasEnergyBlaster = true;
                p.energyBlasterCount++;
            }
            if (item.id === 'repeater') {
                p.hasRepeater = true;
                repeaters++;
            }
            if (item.id === 'laser_override') p.hasLaserOverride = true;
            if (item.id === 'pulse_jet') p.pulseJetMult *= 1.15;
            if (item.id === 'shield_booster') p.shieldBoosterMult *= 1.2;
            if (item.id === 'targeting_module') p.hasTargetingModule = true;
            if (item.id === 'control_module') p.hasControlModule = true;
            if (item.id === 'warning_system') p.hasWarningSystem = true;
            if (item.id === 'mechanical_engines') {
                p.mechanicalEngineTurnMult *= 2.0;
                p.mechanicalEngineSpeedMult *= 1.25;
            }
            if (item.id === 'multishot_guns') p.hasMultishotGuns = true;
            if (item.id === 'high_density_capacitor') boostCooldownMult *= 0.5;
            if (item.id === 'energy_cell') shieldRegenMult *= 1.3;
            if (item.id === 'explosives_unit') p.hasExplosivesUnit = true;
            if (item.id === 'small_boosters') p.boostSpeedMult *= 1.1;
            if (item.id === 'rockets') this.hasRockets = true;
            if (item.id === 'ancient_curse') p.hasAncientCurse = true;
            if (item.id === 'boost_drive') p.hasBoostDrive = true;
            if (item.id === 'momentum_module') {
                p.momentumSpeedMult = 0.75;
                p.momentumMaxSpeedMult = 1.5;
                p.momentumBoostMult = 0.75;
                p.friction = 0.98;
            }
            if (item.id === 'sensor_accelerator') {
                fovMult *= 1.1; // 10% increase in FOV
            }
            if (item.id === 'nanite_tank') p.naniteRegen += 0.6;
            if (item.id === 'shield_capacitor') p.shieldCapacitorCount += 1;
            if (item.id === 'asteroid_accumulator') p.asteroidSpawnMult += 0.5;

            // Knowledge Upgrades
            if (item.id === 'obedience') p.obedienceMult = 1.2;
            if (item.id === 'sacrifice') p.hasSacrifice = true;
            if (item.id === 'knowledge') p.hasRadar = true;

            if (item.id === 'cosmos_engine') {
                p.hasCosmosEngine = true;
                // 10% boost to main stats applied via multipliers below
                // 20% boost to luck
                p.luck += 0.2;
            }
            if (item.id === 'cargo_expansion') cargoExpansions++;
            if (item.id === 'experience_condenser') p.experienceCondenserMult += 0.2;
            if (item.id === 'asteroid_drill') p.asteroidDrillMult += 0.5;
            if (item.id === 'laser_cartridge') p.laserCartridgeMult += 0.1;
        }

        const targetRows = this.inventoryRows + cargoExpansions;
        if (p.inventory.rows !== targetRows) {
            const ejected = p.inventory.resize(p.inventory.cols, targetRows);
            if (ejected && ejected.length > 0) {
                this._ejectItems(ejected);
            }
        }

        // Store FOV upgrade contribution (include level-up FOV bonus here)
        this.fovUpgradeMult = fovMult * p.lvlFovMult;

        if (repeaters > 0) {
            let rMult = 0.5;
            for (let i = 1; i < repeaters; i++) {
                if (i === 1) rMult *= 0.75;
                else rMult *= 0.85;
            }
            fireRateMult *= rMult;
        }

        if (blinkEngines > 0) {
            p.hasTeleport = true;
            // More blink engines reduce cooldown
            boostCooldownMult *= Math.max(0.3, 1.0 - (blinkEngines - 1) * 0.2);
        }

        // Apply Cosmos Engine 10% stat boost
        if (p.hasCosmosEngine) {
            fireRateMult *= 0.9; // 10% faster (lower mult = faster)
            maxHealthMult *= 1.1;
            shieldRegenMult *= 1.1;
        }

        // Apply calculated multipliers to player
        // Apply encounter bonuses before assigning to player
        fireRateMult *= this.encounterBonuses.fireRateMult;

        // Apply level-up bonuses on top of inventory bonuses
        fireRateMult      *= p.lvlFireRateMult;
        boostCooldownMult *= p.lvlBoostCooldownMult;
        shieldDrainMult   *= p.lvlShieldDrainMult;
        scrapRangeMult    *= p.lvlVacuumRangeMult;
        shieldRegenMult   *= p.lvlShieldRechargeMult;
        maxHealthMult     *= p.lvlMaxHpMult;
        p.boostSpeedMult  *= p.lvlBoostSpeedMult;
        p.asteroidSpawnMult *= p.lvlAsteroidSpawnMult;
        p.asteroidDrillMult *= p.lvlScrapChanceMult;
        p.laserCartridgeMult *= p.lvlDamageMult;

        p.boostCooldownMult = boostCooldownMult;
        p.boostRangeMult = boostRangeMult;
        p.shieldDrainMult = shieldDrainMult;
        p.scrapRangeMult = scrapRangeMult;
        p.fireRateMult = fireRateMult;
        p.shieldRegenMult = shieldRegenMult;

        // Update Max Stats
        p.updateMaxHealth(maxHealthMult);
        p.updateMaxShield(0); // This uses obedienceMult internally now
        // Apply level-up shield capacity bonus
        p.maxShieldEnergy *= p.lvlMaxShieldMult;
        p.shieldEnergy = Math.min(p.shieldEnergy, p.maxShieldEnergy);

        // Apply Cosmos Engine shield capacity boost
        if (p.hasCosmosEngine) {
            p.maxShieldEnergy *= 1.1;
            p.shieldEnergy = Math.min(p.shieldEnergy, p.maxShieldEnergy);
            p.laserCartridgeMult *= 1.1; // 10% damage boost
        }

        // Update base speed and acceleration
        const cosmosSpeedMult = p.hasCosmosEngine ? 1.1 : 1.0;
        p.baseSpeed = p.shipData.speed * 100 * p.obedienceMult * p.momentumSpeedMult * this.encounterBonuses.speedMult * cosmosSpeedMult;
        p.baseSpeed *= p.lvlSpeedMult;
        p.acceleration = p.baseSpeed * 3;

        if (healAcquisition) {
            const diff = p.maxHealth - oldMax;
            if (diff > 0) p.health += diff;
        }
    }

    _removeSacrificeItem() {
        if (!this.player.inventory) return;
        const entry = this.player.inventory.items.find(i => i.item.id === 'sacrifice');
        if (entry) {
            this.player.inventory.removeItemAt(entry.x, entry.y);
            this._onInventoryChanged();
            this.game.sounds.play('asteroid_break', { volume: 0.8, x: this.player.worldX, y: this.player.worldY });
        }
    }

    _revealShop(shop) {
        if (!shop) return;

        // If already revealed, move to the end of the queue (most recent)
        const idx = this.revealedShops.indexOf(shop);
        if (idx !== -1) {
            this.revealedShops.splice(idx, 1);
        }

        shop.revealed = true;
        this.revealedShops.push(shop);

        // Prune oldest shop marker if count > 3
        while (this.revealedShops.length > 3) {
            const oldest = this.revealedShops.shift();
            if (oldest) {
                oldest.revealed = false;
                oldest.alive = false; // Despawn from world when pruned from radar
            }
        }
    }

    spawnDistantShop() {
        // Random direction
        const angle = Math.random() * Math.PI * 2;
        // 6,000 to 10,000 pixels away
        const dist = 6000 + Math.random() * 4000;

        const sx = this.player.worldX + Math.cos(angle) * dist;
        const sy = this.player.worldY + Math.sin(angle) * dist;

        const newShop = new Shop(this.game, sx, sy);
        this.shops.push(newShop);
        this._revealShop(newShop);

        this.stats.shopsUnlocked++;
        return true;
    }

    revealNearestEvent() {
        let nearest = null;
        let minDistSq = Infinity;
        for (const ev of this.events) {
            if (!ev.revealed && !ev.isFinished) {
                const dx = ev.worldX - this.player.worldX;
                const dy = ev.worldY - this.player.worldY;
                const distSq = dx * dx + dy * dy;
                if (distSq < minDistSq) {
                    minDistSq = distSq;
                    nearest = ev;
                }
            }
        }

        if (nearest) {
            nearest.revealed = true;
            return true;
        }
        return false;
    }


    _spawnEncounter(specificType) {
        const type = specificType || rollEncounterType();
        const angle = Math.random() * Math.PI * 2;
        const dist = 2000 + Math.random() * 500;
        const wx = this.player.worldX + Math.cos(angle) * dist;
        const wy = this.player.worldY + Math.sin(angle) * dist;

        const encounter = new EncounterShip(this.game, wx, wy, type);
        const dialog = generateEncounterDialog(type, this.player, this);
        encounter.dialogData = dialog;
        this.encounters.push(encounter);

        // Notify player via sound
        this.game.sounds.play('boost', 0.8);
    }

    _openCacheUI(cache) {
        this._activeCache = cache;

        if (cache._cachedUI && !cache._cachedUI.closed) {
            // Reuse the existing UI — no fade, just re-show it
            const ui = cache._cachedUI;
            ui.playerInventory = this.player.inventory;
            ui.uiState    = 'idle';  // CUI_STATE.IDLE
            ui.panelAlpha = 1;
            ui.closed     = false;
            this.activeCacheUI = ui;
        } else {
            const ui = new CacheUI(this.game, cache, this.player.inventory);
            cache._cachedUI    = ui;
            this.activeCacheUI = ui;
        }

        this.isCacheOpen = true;
        this.paused      = true;
    }

    queueLevelUp(level) {
        this.levelUpQueue.push(level);
        this.game.sounds.play('level', 0.5);
    }

    _openLevelUpDialog(level) {
        this.activeLevelUpDialog = new LevelUpDialog(this.game, this.player, this, level);
        this.isLevelUpOpen = true;
        this.paused        = true;
        this.game.sounds.play('scrap', 0.8);
    }

    _openEncounterDialog(encounter) {
        encounter.startInteraction();

        // Use the dialog that was generated when the encounter spawned
        this.activeEncounterDialog = new EncounterDialog(
            this.game, encounter, encounter.dialogData, this.player, this
        );
        this.isEncounterOpen = true;
        this.paused = true;
        this.game.sounds.play('click', 0.5);
    }

    _convertEncounterToEnemy(encounter) {
        const en = new HostileEncounter(this.game, encounter.worldX, encounter.worldY, this.difficultyScale, encounter.dialogData);

        // --- Wealth-based scaling ---
        let maxScrap = 0;
        if (encounter.dialogData && encounter.dialogData.vars) {
            for (const val of Object.values(encounter.dialogData.vars)) {
                if (typeof val === 'number') {
                    maxScrap = Math.max(maxScrap, val);
                } else if (val && typeof val === 'object') {
                    // Check for item cost or explicit cost/offer properties
                    if (val.item && typeof val.item.cost === 'number') {
                        maxScrap = Math.max(maxScrap, val.item.cost);
                    } else if (typeof val.cost === 'number') {
                        maxScrap = Math.max(maxScrap, val.cost);
                    } else if (typeof val.offer === 'number') {
                        maxScrap = Math.max(maxScrap, val.offer);
                    } else if (typeof val.negotiate === 'number') {
                        maxScrap = Math.max(maxScrap, val.negotiate);
                    }
                }
            }
        }

        // 100 scrap is baseline (1.0). 500 scrap is 2.0x strength bonus.
        // Formula: 1.0 + max(0, (maxScrap - 100) / 400)
        const wealthBonus = 1.0 + Math.max(0, (maxScrap - 100) / 400);

        // Override sprite and compute correct radii for the encounter ship
        en.initEncounterData(encounter.img, encounter.assetKey);

        // --- Boss-based health scaling ---
        const curvedDifficultyScale = Math.pow(this.difficultyScale, 0.6);
        const bossBaseHealth = (220 * curvedDifficultyScale) + 70 * this.difficultyScale;

        // Forced encounters that turned hostile are weaker than ones the player picked a fight with.
        // Chosen fights: 90% of boss HP. Forced fights: ~45% (between normal enemy and boss).
        const forcedFight = !!(encounter.dialogData && encounter.dialogData.forced);
        const healthMult = forcedFight ? 0.45 : 0.9;
        en.health = Math.ceil(bossBaseHealth * healthMult * wealthBonus);
        en.maxHealth = en.health;

        // Scale other attributes
        en.speedMult = 1.5 + (wealthBonus - 1) * 0.5; // Starts at 1.5, up to 2.0
        en.fireRateMult = 1.8 * wealthBonus;
        en.damageMult = 1.0 * wealthBonus;
        en.isUpgraded = true;

        // They get ALL weapon types natively, which they will cycle through
        en.selectedUpgrades = ['bigBall', 'beam', 'multishot'];
        en.weaponCycle = 0;

        this.enemies.push(en);
        encounter.alive = false;
    }

    _drawEncounterIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 20 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        for (const enc of this.encounters) {
            if (!enc.alive || enc.state === ENC_STATE.HOSTILE || enc.state === ENC_STATE.DEPARTING) continue;

            const screen = this.camera.worldToScreen(enc.worldX, enc.worldY, cw, ch);

            const dx = enc.worldX - this.player.worldX;
            const dy = enc.worldY - this.player.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const isWithinDist = dist <= Math.max(cw, ch) * 3;
            const opacity = this._getIndicatorOpacity(enc, !isOnScreen && isWithinDist, dt);
            if (opacity <= 0) continue;

            const angle = Math.atan2(dy, dx);
            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorArrow;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Draw arrow
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.translate(ix, iy);
            ctx.rotate(angle);

            ctx.fillStyle = enc.indicatorColor || '#44ffaa';
            ctx.beginPath();
            ctx.moveTo(10 * this.game.uiScale, 0);
            ctx.lineTo(-6 * this.game.uiScale, -8 * this.game.uiScale);
            ctx.lineTo(-2 * this.game.uiScale, 0); // Cutout center
            ctx.lineTo(-6 * this.game.uiScale, 8 * this.game.uiScale);
            ctx.closePath();
            ctx.fill();

            ctx.restore();

            // Draw text label (Above)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.font = `${6 * this.game.uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = enc.indicatorColor || '#44ffaa';
            ctx.fillText(enc.displayName.toUpperCase(), ix, iy - 16 * this.game.uiScale);

            // Distance (Below)
            ctx.font = `${5 * this.game.uiScale}px Astro4x`;
            const color = enc.indicatorColor || '#44ffaa';
            // Simple approach to dim the color: parse if it starts with #
            if (color.startsWith('#')) {
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.7)`;
            } else {
                ctx.fillStyle = color;
            }
            ctx.fillText(`${Math.floor(dist)}`, ix, iy + 16 * this.game.uiScale);
            ctx.restore();
        }
    }

    _drawEnemyIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 15 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        const maxIndicatorDist = Math.max(cw, ch) * 2;
        const maxIndicatorDistSq = maxIndicatorDist * maxIndicatorDist;

        for (const en of this.enemies) {
            const dx = en.worldX - this.player.worldX;
            const dy = en.worldY - this.player.worldY;
            const distSq = dx * dx + dy * dy;

            if (distSq > maxIndicatorDistSq) {
                const state = this.indicatorOpacities.get(en);
                if (state && state.opacity > 0) {
                    state.opacity = Math.max(0, state.opacity - dt * 2.0);
                }
                continue;
            }

            const screen = this.camera.worldToScreen(en.worldX, en.worldY, cw, ch);
            const dist = Math.sqrt(distSq);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const isWithinDist = dist <= maxIndicatorDist;
            const opacity = this._getIndicatorOpacity(en, !isOnScreen && isWithinDist, dt);
            if (opacity <= 0) continue;

            const angle = Math.atan2(dy, dx);
            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorExclamation;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Draw "!" indicator (bosses are purple, regular enemies red)
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = en.isBoss ? '#ff44ff' : '#ff2222';
            ctx.font = `${12 * this.game.uiScale}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', ix, iy);
            ctx.restore();
        }
    }

    _drawAsteroidWarnings(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const margin = 15 * this.game.uiScale;

        const dt = this.game.lastDt || 0.016;
        // Pre-compute max relevant distance squared to skip far asteroids entirely
        const maxIndicatorDist = Math.max(cw, ch) * 1.5;
        const maxIndicatorDistSq = maxIndicatorDist * maxIndicatorDist;

        for (const ast of this.asteroids) {
            if (!ast.alive) continue;

            const dx = ast.worldX - this.player.worldX;
            const dy = ast.worldY - this.player.worldY;
            const distSq = dx * dx + dy * dy;

            // Quick reject: skip asteroids way too far to ever show an indicator
            if (distSq > maxIndicatorDistSq) {
                // If it had an opacity, let it fade (but don't compute screen pos)
                const state = this.indicatorOpacities.get(ast);
                if (state && state.opacity > 0) {
                    state.opacity = Math.max(0, state.opacity - dt * 2.0);
                }
                continue;
            }

            const screen = this.camera.worldToScreen(ast.worldX, ast.worldY, cw, ch);
            const dist = Math.sqrt(distSq);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const isWithinDist = dist <= maxIndicatorDist;
            const opacity = this._getIndicatorOpacity(ast, !isOnScreen && isWithinDist, dt);
            if (opacity <= 0) continue;

            const angle = Math.atan2(dy, dx);
            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorExclamation;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;

            // Draw yellow "!" indicator
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#ffff44';
            ctx.font = `${12 * this.game.uiScale}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', ix, iy);
            ctx.restore();
        }
    }

    _ejectItems(items) {
        if (!items || items.length === 0) return;

        const p = this.player;
        const ItemPickupClass = ItemPickup; // Available from imports

        for (const item of items) {
            const angle = Math.random() * Math.PI * 2;
            const dist = 10 + Math.random() * 20;
            const spawnX = p.worldX + Math.cos(angle) * dist;
            const spawnY = p.worldY + Math.sin(angle) * dist;

            const throwAngle = Math.random() * Math.PI * 2;
            const throwSpeed = 100 + Math.random() * 200;
            const vx = p.vx + Math.cos(throwAngle) * throwSpeed;
            const vy = p.vy + Math.sin(throwAngle) * throwSpeed;

            const pickup = new ItemPickupClass(this.game, spawnX, spawnY, item, 1.0); // 1s delay
            pickup.vx = vx;
            pickup.vy = vy;
            this.itemPickups.push(pickup);
        }

        this.game.sounds.play('asteroid_break', { volume: 0.6, x: p.worldX, y: p.worldY });
    }

    _drawPauseOverlay(ctx) {
        ctx.save();
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
        ctx.fillRect(0, 0, cw, ch);

        ctx.fillStyle = '#ffffff';
        ctx.font = `${8 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('PAUSED', cw / 2, uiScale * 16);

        const playerInv    = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'pause');

        this._draw9Slice(ctx, this.inventoryImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        this._drawInventoryGrid(ctx, playerInv, playerLayout, this.playerScrollX, this.playerScrollY);
        this._draw9Slice(ctx, this.inventoryBorderImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        this._drawScrollbars(ctx, playerLayout, this.playerScrollX, this.playerScrollY);

        const scrollLabelOffsetY = playerLayout.scrollableX ? uiScale * 18 : 0;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#88aabb';
        ctx.fillText('SHIP INVENTORY', cw / 2, playerLayout.panelY + playerLayout.totalH + uiScale * 12 + scrollLabelOffsetY);

        const p = this.player;
        const statsY = playerLayout.panelY + playerLayout.totalH + uiScale * 28 + scrollLabelOffsetY;
        ctx.fillStyle = '#667788';
        ctx.font = `${8 * uiScale}px Astro4x`;
        ctx.fillText(`HEALTH: ${Math.ceil(p.health)}/${Math.round(p.maxHealth)}`, cw / 2, statsY);
        ctx.fillText(`SHIELD: ${Math.floor(p.shieldEnergy)}/${Math.round(p.maxShieldEnergy)}${p.shieldBroken ? ' [BROKEN]' : ''}`, cw / 2, statsY + uiScale * 10);
        ctx.fillText(`SCRAP: ${p.scrap}`, cw / 2, statsY + uiScale * 20);

        this._drawDraggedItem(ctx, playerLayout.slotSize);

        ctx.textAlign = 'center';
        ctx.fillStyle = '#445566';
        ctx.fillText('Drag to move | Right-click to use | ESC to resume', cw / 2, ch - uiScale * 8);

        this._drawInventoryTooltip(ctx, [
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

        this._drawPauseVolumeControls(ctx);

        if (!this.confirmRestart) {
            const ss = this.pauseButtons.shipSelection;
            this.game.drawSprite(ctx, ss.hovered ? 'ship_selection_on' : 'ship_selection_off', ss.x, ss.y, uiScale);
        } else {
            ctx.fillStyle = 'rgba(0,0,0,0.85)';
            ctx.fillRect(0, 0, cw, ch);

            ctx.fillStyle = '#ffffff';
            ctx.font = `${10 * uiScale}px Astro5x`;
            ctx.textAlign = 'center';
            ctx.fillText('ARE YOU SURE YOU WANT TO RESTART?', cw / 2, ch / 2 - uiScale * 10);

            const yb = this.confirmRestartButtons.yes;
            ctx.fillStyle = yb.hovered ? '#44ff44' : '#228822';
            ctx.fillRect(yb.x, yb.y, yb.w, yb.h);
            ctx.fillStyle = '#ffffff';
            ctx.font = `${8 * uiScale}px Astro4x`;
            ctx.textBaseline = 'middle';
            ctx.fillText('YES', yb.x + yb.w / 2, yb.y + yb.h / 2);

            const nb = this.confirmRestartButtons.no;
            ctx.fillStyle = nb.hovered ? '#ff4444' : '#882222';
            ctx.fillRect(nb.x, nb.y, nb.w, nb.h);
            ctx.fillStyle = '#ffffff';
            ctx.fillText('NO', nb.x + nb.w / 2, nb.y + nb.h / 2);
            ctx.textBaseline = 'bottom';
        }

        this._drawStatsPanel(ctx);
        if (!this.confirmRestart) this._drawClaimLevelsButton(ctx);

        ctx.restore();
    }

    _drawStatsPanel(ctx) {
        const p  = this.player;
        const us = this.game.uiScale;

        const statFont = Math.floor(6 * us);
        const headFont = Math.floor(7 * us);
        const lh    = Math.floor(statFont * 1.5);   // tight row height
        const ipad  = Math.floor(6 * us);            // gap between label and value
        const opad  = Math.floor(10 * us);           // panel outer padding
        const cGap  = Math.floor(14 * us);           // gap between the two columns
        const sep   = Math.floor(5 * us);            // gap around separator lines

        ctx.save();
        ctx.font         = `${statFont}px Astro4x`;
        ctx.textBaseline = 'middle';

        // Each entry: [label, value, lowerIsBetter?]
        //   value = number  → shown as %, reflects level-up bonuses only
        //   value = string  → shown as-is, grey at zero / green when active
        //   lowerIsBetter   → green < 100%, red > 100% (drain/cooldown/difficulty stats)
        const colA = [
            ['Max Hull',      p.lvlMaxHpMult],
            ['Max Shield',    p.lvlMaxShieldMult],
            ['Damage',        p.lvlDamageMult],
            ['Fire Rate',     1 / Math.max(0.01, p.lvlFireRateMult)],   // lower cooldown = higher rate
            ['Proj. Speed',   p.lvlProjectileSpeedMult],
            ['Shld Drain',    p.lvlShieldDrainMult,        true],        // less drain = good, shown < 100%
            ['Shld Regen',    p.lvlShieldRechargeMult],
            ['Shld Impact',   p.lvlShieldDamageMult],
            ['Asteroid Res.', 1 / Math.max(0.01, p.lvlAsteroidResistanceMult)], // less damage taken = higher resistance
            ['Difficulty',    p.lvlDifficultyMult,         true],        // lower difficulty scaling = good
            ['Hull Regen',    `+${p.lvlHpRegen > 0 ? p.lvlHpRegen.toFixed(1) : '0.0'}/s`],
            ['Cache Rate',    p.lvlCacheFreqMult],
            ['Enc. Rate',     p.lvlEncounterFreqMult],
        ];
        const colB = [
            ['Ship Speed',     p.lvlSpeedMult],
            ['Turn Speed',     p.lvlTurnSpeedMult],
            ['Boost Speed',    p.lvlBoostSpeedMult],
            ['Boost Duration', p.lvlBoostDurationMult],
            ['Boost Rech.',    1 / Math.max(0.01, p.lvlBoostCooldownMult)], // shorter cooldown = faster recharge
            ['Field of View',  p.lvlFovMult],
            ['Vacuum Range',   p.lvlVacuumRangeMult],
            ['Exp Gain',       p.lvlExpGainMult],
            ['Scrap Chance',   p.lvlScrapChanceMult],
            ['Ast. Density',   p.lvlAsteroidSpawnMult],
            ['Enemy Spawn',    p.lvlEnemySpawnMult,        true],        // fewer enemies = good, shown < 100%
            ['Wave Speed',     1 / Math.max(0.01, p.lvlWaveCountdownMult)], // shorter countdown = faster waves
            ['Extra Shots',    `+${p.lvlExtraProjectiles}`],
        ];

        // Measure column widths — value slot wide enough for 4-digit % or flat strings
        const maxValW  = Math.max(ctx.measureText(' 9999%').width, ctx.measureText('+99.9/s').width);
        const maxNameA = colA.reduce((m, [n]) => Math.max(m, ctx.measureText(n).width), 0);
        const maxNameB = colB.reduce((m, [n]) => Math.max(m, ctx.measureText(n).width), 0);
        const colAW    = maxNameA + ipad + maxValW;
        const colBW    = maxNameB + ipad + maxValW;

        const rows   = Math.max(colA.length, colB.length);
        const panelW = opad + colAW + cGap + colBW + opad;
        const panelH = opad + headFont + sep + rows * lh + opad;

        // Offset from screen edge
        const px = Math.floor(20 * us);
        const py = Math.floor(20 * us);

        // Background
        ctx.fillStyle   = 'rgba(4, 8, 18, 0.92)';
        ctx.strokeStyle = '#233040';
        ctx.lineWidth   = Math.max(1, Math.round(us));
        ctx.fillRect(px, py, panelW, panelH);
        ctx.strokeRect(px, py, panelW, panelH);

        // Header
        ctx.font         = `${headFont}px Astro5x`;
        ctx.fillStyle    = '#5577aa';
        ctx.textAlign    = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('SHIP STATS', px + opad, py + Math.floor(opad * 0.6));

        // Divider under header
        const divY = py + Math.floor(opad * 0.6) + headFont + Math.floor(sep * 0.5);
        ctx.strokeStyle = '#1e3048';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(px + opad, divY);
        ctx.lineTo(px + panelW - opad, divY);
        ctx.stroke();

        ctx.font = `${statFont}px Astro4x`;
        const startY = divY + Math.floor(sep * 0.5) + Math.floor(lh * 0.5);

        const drawEntry = (colX, y, label, value, colW, lowerIsBetter = false) => {
            let valStr, color;
            if (typeof value === 'string') {
                valStr = value;
                color  = (value === '+0' || value === '+0.0/s') ? '#556677' : '#33dd66';
            } else {
                const pct = Math.round(value * 100);
                valStr = `${pct}%`;
                if (lowerIsBetter) {
                    color = pct < 100 ? '#33dd66' : pct > 100 ? '#dd4422' : '#556677';
                } else {
                    color = pct > 100 ? '#33dd66' : pct < 100 ? '#dd4422' : '#556677';
                }
            }
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = '#4a6070';
            ctx.fillText(label, colX, y);
            ctx.textAlign = 'right';
            ctx.fillStyle = color;
            ctx.fillText(valStr, colX + colW, y);
        };

        for (let i = 0; i < colA.length; i++) {
            drawEntry(px + opad, startY + i * lh, colA[i][0], colA[i][1], colAW, colA[i][2]);
        }
        for (let i = 0; i < colB.length; i++) {
            drawEntry(px + opad + colAW + cGap, startY + i * lh, colB[i][0], colB[i][1], colBW, colB[i][2]);
        }

        // Cache bounds for button positioning in _updatePauseUI
        this._statsPanelRect = { x: px, y: py, w: panelW, h: panelH };

        ctx.restore();
    }

    _drawPauseVolumeControls(ctx) {
        const pb = this.pauseButtons;
        this.game.drawVolumeRow(ctx, 'MUSIC', this.game.sounds.musicVolume, pb.musicDec, pb.musicInc);
        this.game.drawVolumeRow(ctx, 'SOUNDS', this.game.sounds.sfxVolume, pb.sfxDec, pb.sfxInc);
    }

    _draw9Slice(ctx, img, x, y, w, h) {
        if (!img) return;
        const C = 48;  // corner size in source pixels
        const M = 32;  // middle tile size in source pixels

        const canvas = img.canvas || img;
        const prescale = canvas.width / (img.width || canvas.width);
        const sC = C * prescale;
        const sM = M * prescale;

        // Destination sizes - clamp corners so they don't exceed half the panel
        const dcFull = C * this.game.uiScale;
        const dcX = Math.min(dcFull, w / 2);
        const dcY = Math.min(dcFull, h / 2);
        const dm = M * this.game.uiScale;

        // Source crop ratios (1.0 when full size, <1.0 when cropped)
        const cropX = dcX / dcFull;
        const cropY = dcY / dcFull;
        const sCX = sC * cropX;  // cropped source corner width
        const sCY = sC * cropY;  // cropped source corner height

        const mw = w - dcX * 2;  // middle width to fill
        const mh = h - dcY * 2;  // middle height to fill

        // Top row
        ctx.drawImage(canvas, 0, 0, sCX, sCY, x, y, dcX, dcY); // TL
        const cols = Math.round(mw / dm);
        for (let i = 0; i < cols; i++) {
            ctx.drawImage(canvas, sC, 0, sM, sCY, x + dcX + i * dm, y, dm, dcY); // T-edge
        }
        ctx.drawImage(canvas, sC + sM + (sC - sCX), 0, sCX, sCY, x + dcX + mw, y, dcX, dcY); // TR

        // Middle rows
        const rows = Math.round(mh / dm);
        for (let j = 0; j < rows; j++) {
            const ry = y + dcY + j * dm;
            ctx.drawImage(canvas, 0, sC, sCX, sM, x, ry, dcX, dm); // L-edge
            for (let i = 0; i < cols; i++) {
                ctx.drawImage(canvas, sC, sC, sM, sM, x + dcX + i * dm, ry, dm, dm); // Center
            }
            ctx.drawImage(canvas, sC + sM + (sC - sCX), sC, sCX, sM, x + dcX + mw, ry, dcX, dm); // R-edge
        }

        // Bottom row
        const by = y + dcY + mh;
        ctx.drawImage(canvas, 0, sC + sM + (sC - sCY), sCX, sCY, x, by, dcX, dcY); // BL
        for (let i = 0; i < cols; i++) {
            ctx.drawImage(canvas, sC, sC + sM + (sC - sCY), sM, sCY, x + dcX + i * dm, by, dm, dcY); // B-edge
        }
        ctx.drawImage(canvas, sC + sM + (sC - sCX), sC + sM + (sC - sCY), sCX, sCY, x + dcX + mw, by, dcX, dcY); // BR
    }

    _handlePrimaryWeaponFire() {
        if (this.player.hasRailgun && this.player.isFiring) {
            this.camera.shake(1.8, 12.0);
        }
        if (this.player.hasEnergyBlaster && this.player.isFiring) {
            this.camera.shake(1.0, 15.0);
        }
        const p = this.player;
        const noseOffset = 36;

        // Determine firing origins
        const origins = [];
        if (p.hasMultishotGuns) {
            const perpAngle = p.angle + Math.PI / 2;
            const offset = 15;
            origins.push({
                x: p.worldX + Math.cos(p.angle) * noseOffset + Math.cos(perpAngle) * offset,
                y: p.worldY + Math.sin(p.angle) * noseOffset + Math.sin(perpAngle) * offset
            });
            origins.push({
                x: p.worldX + Math.cos(p.angle) * noseOffset - Math.cos(perpAngle) * offset,
                y: p.worldY + Math.sin(p.angle) * noseOffset - Math.sin(perpAngle) * offset
            });
        } else {
            origins.push({
                x: p.worldX + Math.cos(p.angle) * noseOffset,
                y: p.worldY + Math.sin(p.angle) * noseOffset
            });
        }

        const beamLength = 8000;
        let damageMult = (p.hasRepeater ? 0.5 : 1.0) * (p.hasLaserOverride ? 1.3 : 1.0);
        if (p.hasMultishotGuns) damageMult *= 0.7; // 30% reduction

        const currentBaseDamage = (p.shipData.baseDamage * p.obedienceMult + p.permDamageBonus) * p.laserCartridgeMult;

        if (p.hasEnergyBlaster) {
            origins.forEach(origin => {
                const extraCount = (p.energyBlasterCount - 1) * 2;
                const count = 3 + Math.floor(Math.random() * 3) + extraCount; // 3-5 + 2 per extra
                const spreadBase = 0.5 + (p.energyBlasterCount - 1) * 0.1; // Wider with more blasters
                const dmgReduc = Math.pow(0.85, p.energyBlasterCount - 1); // 15% reduction per extra

                const fireAngle = p.getTargetAngle(origin.x, origin.y);
                for (let i = 0; i < count; i++) {
                    const spread = (Math.random() - 0.5) * spreadBase;
                    const angle = fireAngle + spread;
                    const dirX = Math.cos(angle);
                    const dirY = Math.sin(angle);
                    this._fireSingleBeam(origin.x, origin.y, dirX, dirY, beamLength, currentBaseDamage * 0.6 * dmgReduc * damageMult);
                }
            });
        } else { // Default to Railgun if no Energy Blaster
            origins.forEach(origin => {
                const fireAngle = p.getTargetAngle(origin.x, origin.y);
                const dirX = Math.cos(fireAngle);
                const dirY = Math.sin(fireAngle);
                this._fireSingleBeam(origin.x, origin.y, dirX, dirY, beamLength, currentBaseDamage * 2.5 * damageMult);
            });
        }
    }

    _fireSingleBeam(startX, startY, dirX, dirY, length, damage) {
        // vs Asteroids
        for (const ast of this.asteroids) {
            if (!ast.alive) continue;
            if (this._rayIntersectsCircle(startX, startY, dirX, dirY, length, ast.worldX, ast.worldY, ast.radius)) {
                this.game.sounds.play('hit', 0.6);
                if (ast.hit(damage)) {
                    this._onEntityDestroyed(ast);
                }
                if (this.player.hasExplosivesUnit) {
                    // Approximate hit location on the asteroid
                    const dx = ast.worldX - startX, dy = ast.worldY - startY;
                    const projDistance = Math.max(0, dx * dirX + dy * dirY);
                    const hitX = startX + dirX * projDistance;
                    const hitY = startY + dirY * projDistance;
                    this._spawnExplosion(hitX, hitY, damage * 0.5);
                }
            }
        }

        // vs Enemies
        for (const en of this.enemies) {
            if (!en.alive) continue;
            if (this._rayIntersectsCircle(startX, startY, dirX, dirY, length, en.worldX, en.worldY, en.radius)) {
                this.game.sounds.play('hit', 0.6);
                if (en.hit(damage)) {
                    this._onEntityDestroyed(en);
                }
                if (this.player.hasExplosivesUnit) {
                    const dx = en.worldX - startX, dy = en.worldY - startY;
                    const projDistance = Math.max(0, dx * dirX + dy * dirY);
                    const hitX = startX + dirX * projDistance;
                    const hitY = startY + dirY * projDistance;
                    this._spawnExplosion(hitX, hitY, damage * 0.5);
                }
            }
        }

        // vs Events
        for (const ev of this.events) {
            if (!ev.alive) continue;
            if (this._rayIntersectsCircle(startX, startY, dirX, dirY, length, ev.worldX, ev.worldY, ev.radius)) {
                this.game.sounds.play('hit', 0.6);
                if (ev.hit(damage)) {
                    this._onEntityDestroyed(ev);
                } else if (ev.state === CTHULHU_STATE.DESTRUCTIBLE) {
                    const dx = ev.worldX - startX, dy = ev.worldY - startY;
                    const projDistance = Math.max(0, dx * dirX + dy * dirY);
                    const hitX = startX + dirX * projDistance;
                    const hitY = startY + dirY * projDistance;
                    for (let i = 0; i < 2; i++) {
                        this.rubble.push(new Rubble(this.game, hitX, hitY));
                    }
                }
                if (this.player.hasExplosivesUnit) {
                    const dx = ev.worldX - startX, dy = ev.worldY - startY;
                    const projDistance = Math.max(0, dx * dirX + dy * dirY);
                    const hitX = startX + dirX * projDistance;
                    const hitY = startY + dirY * projDistance;
                    this._spawnExplosion(hitX, hitY, damage * 0.5);
                }
            }
        }

        // Add visual - we need to store multiple beams if we want them all to show
        // but for now let's just use the existing activeBeam and maybe make it an array?
        // Actually, let's just set the flash and the line.
        // We'll use a local activeBeam object but store it in a way that allows
        // PlayingState to draw all of them.
        if (!this.activeBeams) this.activeBeams = [];
        this.activeBeams.push({
            x: startX,
            y: startY,
            angle: Math.atan2(dirY, dirX),
            timer: 0.15
        });
    }

    _rayIntersectsCircle(rx, ry, dx, dy, maxDist, cx, cy, radius) {
        const vx = cx - rx;
        const vy = cy - ry;
        const projection = vx * dx + vy * dy;

        if (projection < 0 || projection > maxDist) {
            // Check if circle contains start point?
            const dSq = vx * vx + vy * vy;
            return dSq < radius * radius;
        }

        const closestX = rx + dx * projection;
        const closestY = ry + dy * projection;
        const distSq = (cx - closestX) ** 2 + (cy - closestY) ** 2;

        return distSq < radius * radius;
    }

    _drawRailgunVisuals(ctx) {
        const p = this.player;
        const game = this.game;

        // Targeting line
        if (p.isRailgunTargeting) {
            const img = game.assets.get('blue_laser_beam_targeting');
            if (img) {
                const screen = this.camera.worldToScreen(p.worldX, p.worldY, game.width, game.height);
                const noseOffset = 36 * game.worldScale;

                if (p.hasMultishotGuns) {
                    const perpAngle = p.angle + Math.PI / 2;
                    const offset = 15 * game.worldScale;
                    this._drawTiledLine(ctx, img, p.angle, 0.4, screen.x + Math.cos(p.angle) * noseOffset + Math.cos(perpAngle) * offset, screen.y + Math.sin(p.angle) * noseOffset + Math.sin(perpAngle) * offset);
                    this._drawTiledLine(ctx, img, p.angle, 0.4, screen.x + Math.cos(p.angle) * noseOffset - Math.cos(perpAngle) * offset, screen.y + Math.sin(p.angle) * noseOffset - Math.sin(perpAngle) * offset);
                } else {
                    this._drawTiledLine(ctx, img, p.angle, 0.4, screen.x + Math.cos(p.angle) * noseOffset, screen.y + Math.sin(p.angle) * noseOffset);
                }
            }
        }

        // Active beams flash
        if (this.activeBeams) {
            const spriteKey = p.hasLaserOverride ? 'blue_laser_beam_big' : 'blue_laser_beam';
            const img = game.assets.get(spriteKey);
            if (img) {
                const centerX = game.width / 2;
                const centerY = game.height / 2;
                for (const beam of this.activeBeams) {
                    const screen = this.camera.worldToScreen(beam.x, beam.y, game.width, game.height);
                    this._drawTiledLine(ctx, img, beam.angle, beam.timer / 0.15, screen.x, screen.y);
                }
            }
        }
    }

    _drawTiledLine(ctx, img, angle, alpha, startX, startY) {
        const game = this.game;

        const canvas = img.canvas || img;
        const tileW = (img.width || img.canvas.width) * game.worldScale;
        const tileH = (img.height || img.canvas.height) * game.worldScale;
        const count = 80; // Enough to go off screen at high FOV

        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.translate(startX, startY);
        ctx.rotate(angle);

        for (let i = 0; i < count; i++) {
            ctx.drawImage(canvas, i * tileW, -tileH / 2, tileW, tileH);
        }

        ctx.restore();
    }

    _spawnExplosion(x, y, damage) {
        if (!this.explosions) this.explosions = [];
        this.explosions.push({
            worldX: x,
            worldY: y,
            timer: 0.3, // Explosion visuals last 0.3s
            maxTimer: 0.3
        });
        this._triggerShakeAt(x, y, 2.5);

        // Explosion area of effect
        const radius = 64;

        // Damage nearby enemies
        for (const en of this.enemies) {
            if (!en.alive) continue;
            const dx = en.worldX - x;
            const dy = en.worldY - y;
            if (Math.sqrt(dx * dx + dy * dy) <= radius + en.radius) {
                if (en.hit(damage)) {
                    this._onEntityDestroyed(en);
                }
            }
        }

        // Damage nearby asteroids
        for (const ast of this.asteroids) {
            if (!ast.alive) continue;
            const dx = ast.worldX - x;
            const dy = ast.worldY - y;
            if (Math.sqrt(dx * dx + dy * dy) <= radius + ast.radius) {
                if (ast.hit(damage)) {
                    this._onEntityDestroyed(ast);
                }
            }
        }
    }

    _drawExplosions(ctx) {
        if (!this.explosions || this.explosions.length === 0) return;

        const frames = this.game.assets.get('blue_laser_explosion');
        if (!frames || !frames.length) return;

        const baseSize = 64;

        ctx.save();
        // Use camera projection for explosions

        for (const exp of this.explosions) {
            const progress = 1.0 - (exp.timer / exp.maxTimer);
            const frameIndex = Math.min(Math.floor(progress * frames.length), frames.length - 1);
            const img = frames[frameIndex].canvas;

            ctx.globalAlpha = 1.0; // GIF contains its own alpha typically, or we can fade it slightly
            const size = baseSize * this.game.worldScale;

            // screen coordinates via camera
            const screen = this.camera.worldToScreen(exp.worldX, exp.worldY, this.game.width, this.game.height);
            const sx = screen.x;
            const sy = screen.y;

            ctx.drawImage(img, sx - size / 2, sy - size / 2, size, size);
        }
        ctx.restore();
    }

    // --- Death System ---

    _triggerDeath() {
        this.isDead = true;
        this.player.alive = false;
        this.deathTimer = 0;
        this.game.sounds.stopMusic();
        this.game.sounds.play('ship_explode', 0.8);

        // Generate debris from ship sprite
        this.shipDebris = this._generateShipDebris();
    }

    _generateShipDebris() {
        const debris = [];
        if (!this.player.stillImg) return debris;

        // 16-24 organic shards for the player ship
        const numPieces = 16 + Math.floor(Math.random() * 8);
        const shards = VoronoiSlicer.slice(this.player.stillImg, numPieces);
        const lifetime = 60.0; // Shards stay for a long time (noFade handles opacity)

        for (const shard of shards) {
            const cosA = Math.cos(this.player.angle + Math.PI / 2);
            const sinA = Math.sin(this.player.angle + Math.PI / 2);

            // Transform local fragment offset to world space
            const worldOffX = (shard.lx * cosA - shard.ly * sinA);
            const worldOffY = (shard.lx * sinA + shard.ly * cosA);

            const outAngle = Math.atan2(worldOffY, worldOffX);
            const spread = 40 + Math.random() * 70;
            const vx = this.player.vx * 0.3 + Math.cos(outAngle) * spread;
            const vy = this.player.vy * 0.3 + Math.sin(outAngle) * spread;

            debris.push(new ProceduralDebris(
                this.game,
                this.player.worldX + worldOffX,
                this.player.worldY + worldOffY,
                shard,
                vx, vy,
                this.player.angle + Math.PI / 2,
                (Math.random() - 0.5) * 10, // Fast spin
                lifetime,
                true // noFade
            ));
        }

        return debris;
    }

    _updateDeathScreen(dt) {
        const mouse = this.game.getMousePos();
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        // Compute button layout
        const flyAgainSize = this.game.spriteSize('fly_again_off', uiScale);
        const shipSelSize = this.game.spriteSize('ship_selection_off', uiScale);
        const gap = 16 * uiScale;
        const totalW = flyAgainSize.w + gap + shipSelSize.w;
        const btnY = ch - Math.floor(uiScale * 30) - flyAgainSize.h;

        this.deathScreenButtons.flyAgain = {
            x: Math.floor(cw / 2 - totalW / 2),
            y: btnY,
            w: flyAgainSize.w,
            h: flyAgainSize.h,
            hovered: false
        };
        this.deathScreenButtons.shipSelection = {
            x: Math.floor(cw / 2 - totalW / 2 + flyAgainSize.w + gap),
            y: btnY,
            w: shipSelSize.w,
            h: shipSelSize.h,
            hovered: false
        };

        // Hover detection
        const fa = this.deathScreenButtons.flyAgain;
        fa.hovered = mouse.x >= fa.x && mouse.x <= fa.x + fa.w && mouse.y >= fa.y && mouse.y <= fa.y + fa.h;
        const ss = this.deathScreenButtons.shipSelection;
        ss.hovered = mouse.x >= ss.x && mouse.x <= ss.x + ss.w && mouse.y >= ss.y && mouse.y <= ss.y + ss.h;

        if (this.game.input.isMouseJustPressed(0)) {
            if (fa.hovered) {
                this.game.sounds.play('select', 1.0);
                this.game.setState(new PlayingState(this.game, this.shipData));
            }
            if (ss.hovered) {
                this.game.sounds.play('select', 1.0);
                this.game.setState(new MenuState(this.game));
            }
        }
    }

    _drawDeathScreen(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        // Dim background
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(0, 0, cw, ch);

        // "GAME OVER" title
        ctx.fillStyle = '#ff4444';
        ctx.font = `${12 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('GAME OVER', cw / 2, Math.floor(uiScale * 30));

        const minutes = Math.floor(this.trueTotalTime / 60);
        const seconds = Math.floor(this.trueTotalTime % 60);
        const timeStr = `${minutes}:${seconds.toString().padStart(2, '0')}`;

        // Stats
        const statsList = [
            { label: 'TIME SURVIVED', value: timeStr },
            { label: 'ASTEROIDS DESTROYED', value: this.stats.asteroidsDestroyed },
            { label: 'ENEMIES DEFEATED', value: this.stats.enemiesDefeated },
            { label: 'WAVES CLEARED', value: this.stats.wavesCleared },
            { label: 'SCRAP COLLECTED', value: this.stats.scrapCollected },
            { label: 'SHOPS UNLOCKED', value: this.stats.shopsUnlocked },
            { label: 'EVENTS DISCOVERED', value: this.stats.eventsDiscovered },
        ];

        const lineH = Math.floor(uiScale * 12);
        const startY = Math.floor(ch / 2 - (statsList.length * lineH) / 2);

        ctx.font = `${8 * uiScale}px Astro4x`;
        for (let i = 0; i < statsList.length; i++) {
            const s = statsList[i];
            const y = startY + i * lineH;

            ctx.fillStyle = '#667788';
            ctx.textAlign = 'right';
            ctx.fillText(s.label, cw / 2 - uiScale * 4, y);

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.fillText(String(s.value), cw / 2 + uiScale * 4, y);
        }

        // Buttons (hidden during Yellow One scripted death)
        if (!this.yellowOneDeathScreen) {
            const fa = this.deathScreenButtons.flyAgain;
            const ss = this.deathScreenButtons.shipSelection;

            this.game.drawSprite(ctx, fa.hovered ? 'fly_again_on' : 'fly_again_off', fa.x, fa.y, uiScale);
            this.game.drawSprite(ctx, ss.hovered ? 'ship_selection_on' : 'ship_selection_off', ss.x, ss.y, uiScale);
        }
    }

    _drawDevOverlay(ctx) {
        const uiScale = this.game.uiScale;
        const cw = this.game.width;
        const ch = this.game.height;

        ctx.save();

        // --- Top-Left Stats Box ---
        const boxW = 100 * uiScale;
        const boxH = 35 * uiScale;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(10 * uiScale, 10 * uiScale, boxW, boxH);
        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 1;
        ctx.strokeRect(10 * uiScale, 10 * uiScale, boxW, boxH);

        ctx.fillStyle = '#00ff00';
        ctx.font = `${6 * uiScale}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';

        ctx.fillText(`FPS: ${this.game.fps} (POT: ${this.game.potentialFps})`, 15 * uiScale, 15 * uiScale);

        // Performance Headroom Bar
        const headroomBarW = (boxW - 10 * uiScale);
        const headroomBarH = 2 * uiScale;
        const headroomBarX = 15 * uiScale;
        const headroomBarY = 21 * uiScale;

        // Background
        ctx.fillStyle = '#002200';
        ctx.fillRect(headroomBarX, headroomBarY, headroomBarW, headroomBarH);

        // Load factor (Real / Potential)
        const load = this.game.potentialFps > 0 ? (this.game.fps / this.game.potentialFps) : 0;
        const fillW = Math.min(headroomBarW, headroomBarW * load);

        ctx.fillStyle = load > 0.8 ? '#ff4444' : (load > 0.5 ? '#ffff44' : '#00ff00');
        ctx.fillRect(headroomBarX, headroomBarY, fillW, headroomBarH);

        ctx.fillStyle = '#00ff00';
        ctx.fillText(`DIFF: ${this.difficultyScale.toFixed(2)}`, 15 * uiScale, 26 * uiScale);

        // --- Entity Vectors ---
        const drawVector = (entities, color = '#ff00ff') => {
            if (!entities) return;
            for (const e of entities) {
                if (!e.alive) continue;
                const screen = this.camera.worldToScreen(e.worldX, e.worldY, cw, ch);
                // Wider margin for vectors which might extend off-screen
                if (screen.x < -200 || screen.x > cw + 200 || screen.y < -200 || screen.y > ch + 200) continue;

                const vx = e.vx || 0;
                const vy = e.vy || 0;
                if (Math.abs(vx) < 1 && Math.abs(vy) < 1) continue;

                // Draw velocity vector (scaled for visibility)
                const vScaling = 0.5;
                const vEnd = this.camera.worldToScreen(e.worldX + vx * vScaling, e.worldY + vy * vScaling, cw, ch);

                ctx.strokeStyle = color;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(screen.x, screen.y);
                ctx.lineTo(vEnd.x, vEnd.y);
                ctx.stroke();

                // Arrow head or dot
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(vEnd.x, vEnd.y, 1.5 * uiScale, 0, Math.PI * 2);
                ctx.fill();
            }
        };

        drawVector(this.enemies, '#ff4444');
        drawVector(this.asteroids, '#ffff44');
        drawVector([this.player], '#44ff44');
        drawVector(this.encounters, '#4444ff');

        // --- Render-Time Graph (bottom-right) ---
        this._drawPerfGraph(ctx, uiScale, cw, ch);

        ctx.restore();
    }

    _drawPerfGraph(ctx, uiScale, cw, ch) {
        // Fixed pixel sizes independent of uiScale — generous but clamped to screen
        const MARGIN = 8;
        const graphW = Math.floor(Math.min(cw * 0.55, 900)); // up to 55% width or 900px
        const graphH = Math.floor(Math.min(ch * 0.30, 300)); // up to 30% height or 300px

        // Anchor to bottom-right, above the HUD coordinate readout
        const hudMargin = this.game.hudScale * 4;
        const coordRowH = this.game.hudScale * 10;

        const gx = cw - graphW - hudMargin;
        const gy = ch - hudMargin - coordRowH - graphH - MARGIN;

        // Clamp so it never exits the screen
        const clampedGx = Math.max(MARGIN, Math.min(gx, cw - graphW - MARGIN));
        const clampedGy = Math.max(MARGIN, Math.min(gy, ch - graphH - MARGIN));

        this.perf.draw(ctx, clampedGx, clampedGy, graphW, graphH, uiScale);
    }
}
