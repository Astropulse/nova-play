// Dynamic scaling via game properties
import { PerfProfiler } from '../engine/perfProfiler.js';
import { World } from '../world/world.js';
import { Camera } from '../world/camera.js';
import { Player } from '../entities/player.js';
import { HUD } from '../ui/hud.js';
import { Asteroid, AsteroidSpawner, Rubble, Scrap, ItemPickup, ProceduralDebris, VoronoiSlicer, ExpOrb, FractureModel, getCachedShatter } from '../entities/asteroid.js';
import { EnemySpawner, Enemy, HostileEncounter } from '../entities/enemy.js';
import { Shop } from '../entities/shop.js';
import { Inventory } from '../engine/inventory.js';
import { UPGRADES, RARITY_COLORS, itemTier, rarityToTier, MAX_COMBINE_TIER, makeItem, tierColor, tierLabel } from '../data/upgrades.js';
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
import { AchievementsState } from './achievementsState.js';
import { ACHIEVEMENTS } from '../data/achievements.js';
import { FloatingText } from '../entities/floatingText.js';
import { MUSIC_STATE } from '../engine/soundManager.js';
import { BOSS_STATE } from '../entities/boss.js';
import { EncounterShip, ENC_STATE } from '../entities/encounter.js';
import { rollEncounterType, generateEncounterDialog } from '../data/encounters.js';
import { EncounterDialog } from '../ui/encounterDialog.js';
import { SpaceCache, CacheSpawner, CACHE_STATE, CACHE_CONFIG } from '../entities/spaceCache.js';
import { CacheUI } from '../ui/cacheUI.js';
import { LevelUpDialog } from '../ui/levelUpDialog.js';
import { GP } from '../engine/inputManager.js';
import { RandomStreams, randomSeed, RNG } from '../engine/rng.js';
import { HostWorldSync, ClientWorldSync, mpQuantityMult, mpHealthMult, mpScrapMult } from '../net/netSync.js';
import { MSG, KIND } from '../net/protocol.js';
import { ChatOverlay, playerColor } from '../ui/chat.js';
import { TradeUI } from '../ui/tradeUI.js';
import { drawShipOutline } from '../net/remotePlayer.js';
import { CinematicDirector } from '../ui/cinematics.js';
import { KillStreakFX } from '../ui/killStreak.js';
import { DreadDirector } from '../ui/dread.js';
import { Ambience } from '../world/ambience.js';
import { FRACTURE_PREWARM_KEYS } from '../engine/prewarm.js';
import { SpatialHash } from '../engine/spatialHash.js';

// Module-level filters (defined once so the per-frame grid rebuilds allocate no
// closures). Skip dead entities so neighbour queries never return them.
const _enemyAlive = (e) => e.alive;
const _projAlive = (p) => p.alive;

// Swept projectile hit-test: true if this frame's travel segment
// (proj._prevX,_prevY → proj.worldX,worldY) passes within `cr` of (cx,cy).
// At normal fps prev≈current so it's a point test; at low fps (big dt) it
// catches fast shots that would otherwise tunnel through small targets.
function _projSweepHit(proj, cx, cy, cr) {
    const p0x = proj._prevX !== undefined ? proj._prevX : proj.worldX;
    const p0y = proj._prevY !== undefined ? proj._prevY : proj.worldY;
    const dx = proj.worldX - p0x, dy = proj.worldY - p0y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((cx - p0x) * dx + (cy - p0y) * dy) / len2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const ex = p0x + dx * t - cx, ey = p0y + dy * t - cy;
    return ex * ex + ey * ey < cr * cr;
}

export class PlayingState {
    constructor(game, shipData, { skipInit = false, handoff = null, netRun = null } = {}) {
        this.game = game;
        this.shipData = shipData;
        this.paused = false;
        this.skipClear = false;

        // ── Multiplayer session (null in single player) ─────────────────────
        // In a synchronized multiplayer start every machine builds the SAME
        // initial world from netRun.runSeed; from then on the host is ground
        // truth and this.netSync replicates everything else.
        this.net = game.net || null;
        this.netSync = null;
        this.chatUI = null;
        this.tradeUI = null;
        this.isTradeOpen = false;
        this._tradeRequestFrom = -1;     // incoming trade request pid
        this._tradeRequestTimer = 0;
        this._pendingLocks = new Map();  // "kind:id" -> callback (client lock requests)
        this._respawnCooldown = 0;

        // ── Deterministic run seed ──────────────────────────────────────────
        // Rolled once per fresh run; drives all gameplay randomness via the
        // per-domain streams in `this.rng`. Set on `game.rng` BEFORE any
        // spawner/entity is constructed below so they can derive content RNGs.
        // On a save-resume (skipInit) the rolled value + stream states are
        // overwritten by deserialize(). Settable mid-run via /seed.
        this.runSeed = (netRun && netRun.runSeed != null) ? netRun.runSeed : randomSeed();
        this.rng = new RandomStreams(this.runSeed);
        game.rng = this.rng;

        // Reset per-run achievement counters before any side effects that
        // could record into them — _onInventoryChanged in particular fires
        // a player_stats notify, which would otherwise write into the
        // previous run's state and then get clobbered. Save-resume goes
        // through deserialize (skipInit=true), so leave the run state alone
        // for loads.
        if (!skipInit && game.achievements) {
            game.achievements.notify('run_started');
        }

        // Optional handoff from the menu state — reuse the same World/Camera
        // and the Player+HUD pair the menu built so every drawn pixel is
        // continuous across the state boundary.
        this.camera = handoff && handoff.camera ? handoff.camera : new Camera(game);
        this.world = handoff && handoff.world ? handoff.world : new World(game, game.worldSeed != null ? game.worldSeed : Math.floor(Math.random() * 1000000));
        this.player = handoff && handoff.player ? handoff.player : new Player(game, shipData);
        if (handoff && handoff.camera && !handoff.player) {
            // Align a fresh player's spawn with the menu camera position;
            // a handed-off player already sits at the right spot.
            this.player.worldX = handoff.camera.x;
            this.player.worldY = handoff.camera.y;
        }
        if (netRun && netRun.spawnX != null) {
            // Multiplayer spawn point (small per-pid ring on fresh starts; a
            // free spot near the host for join-in-progress). Set BEFORE the
            // initial asteroid field spawns so nothing lands on top of us.
            this.player.worldX = netRun.spawnX;
            this.player.worldY = netRun.spawnY;
            this.camera.snapTo(this.player);
        }
        this.hud = handoff && handoff.hud ? handoff.hud : new HUD(game, this.player);

        // Entity lists
        this.projectiles = [];
        this.asteroids = [];
        this.enemies = [];
        this.rubble = [];
        this.scrapEntities = [];
        this.itemPickups = [];
        this.activeBeams = []; // specific fx
        this.explosions = []; // area fx
        this.sparks = []; // short-lived impact spark streaks
        this._boostFlowLevel = 0;  // eased 0..1 driver for the boost space-bend post-fx
        this._trailAccum = 0;      // fractional engine-wash particles owed
        this.events = [];
        this.expOrbs = [];
        // Encounter system
        this.encounters = [];
        // First encounter around ~1 minute (seeded; not serialized).
        this.encounterSpawnTimer = 60 + (this.rng ? this.rng.encounters.next() : Math.random()) * 10;
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
        // Cached rolls (keyed by level) for level-ups the player Esc'd out of,
        // so re-opening shows the same choices instead of re-rolling.
        this._levelUpRolls       = {};

        // Skip-and-stack: skipping a level-up banks a multiplier for the next
        // roll. Picking cashes in the multiplier. The skip budget
        // (LEVELUP_MAX_SKIPS) is a per-run pool — it persists across picks
        // and only refills on new game.
        this.LEVELUP_MAX_SKIPS       = 2;
        this.LEVELUP_SKIP_MULT_STEP  = 1.8;
        this.levelUpSkipsRemaining   = this.LEVELUP_MAX_SKIPS;
        this.pendingLevelUpMult      = 1;

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

        // ── Multiplayer wiring ───────────────────────────────────────────────
        // Created after the initial world spawn so HostWorldSync/ClientWorldSync
        // can number the (identical) initial entities deterministically on every
        // machine. Join-in-progress arrives with skipInit=true and fills the
        // world from the host's snapshot instead (applyNetJoinSnapshot).
        if (this.net) {
            this.netSync = this.net.isHost
                ? new HostWorldSync(this.net, this)
                : new ClientWorldSync(this.net, this);
            this.net.sync = this.netSync;
            this.netSync.bind();
            // Music sync: the host picks exploration/combat songs and broadcasts
            // each choice; clients play exactly what the host sends instead of
            // rolling their own random track (boss cues already use MUSIC_CUE).
            if (this.net.isHost) {
                this.game.sounds.onSelectMusicTrack = (mode, index) => {
                    if (this.netSync) this.netSync.broadcastMusicTrack(mode, index);
                };
            } else {
                this.game.sounds.remoteMusicControl = true;
            }
            this.chatUI = new ChatOverlay(game, this.net);
            this._mpAsteroidSpawners = new Map(); // pid -> AsteroidSpawner (host)
            this._mpCacheSpawners = new Map();    // pid -> CacheSpawner (host)
            if (this.net.isHost) this.netSync.chooseWaveTarget();
            // In multiplayer the world never pauses — `paused` only means
            // "my pause menu is open".
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
        this._waveWasActive = false;
        this._lastCrashWave = 0; // last wave number that spawned a crash-landing resupply cache
        this._crashCacheTimer = 0; // countdown before the queued resupply drop arrives (0 = none pending)
        this.difficultyScale = 1.0;

        // Tunable Difficulty Constants
        this.difficultyRampTime = 240; // 4 minutes (transition to linear)
        this.difficultyExponent = 1.55; // Starts slow, curves up (convex)
        this.difficultyGain = 0.000366; // Calculated for smooth transition at 4m
        this.difficultySteadyRate = 0.013; // Steady linear growth after ramp

        this.flashTimer = 0;

        // Cinematic overlay layer (boss telegraphs, shockwaves, letterbox).
        // Cosmetic only — it never pauses the sim and never touches seeded RNG.
        this.cinematics = new CinematicDirector(game, this);

        // Kill-streak fanfare (rarity vignette + confetti/gore bursts).
        // Local-only: each player's own kills feed their own streak.
        this.killStreak = new KillStreakFX(game, this);

        // Story-dread ambience: rare uncanny moments keyed to how much of the
        // horror chain the player has witnessed. Cosmetic only.
        this.dread = new DreadDirector(game, this);

        // Sector weather + sky events (nebula banks, dust, comet showers).
        // Deterministic by world position — same sky on every machine.
        this.ambience = new Ambience(game, this);

        // Moment-to-moment juice (all cosmetic, all capped)
        this.muzzleFlashes = [];   // { x, y, angle, t }
        this.boostTrail = [];      // flat [x, y, ...] history while boosting
        this._wasBoosting = false;
        this.shieldRipples = [];   // { angle, t }
        this.shieldGlint = 0;      // regen sweep timer
        this.readyAbsorb = [];     // boost/blink-ready: motes drawn into the hull
        this._dialogTear = 0;      // hostile-turn transmission tear
        this.radarPingT = 0;       // radar sweep pulse (new intel revealed)
        this._scrapRoll = null;    // { from, t } — HUD scrap counter roll-up

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
        // Gamepad/keyboard selection on the death screen (0 = fly again,
        // 1 = ship selection), independent of mouse hover.
        this.deathScreenSelected = 0;
        this._deathStickLatched = false;
        this.pauseButtons = {
            musicDec: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            musicInc: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            sfxDec: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            sfxInc: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            shipSelection: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            claimLevels: { x: 0, y: 0, w: 0, h: 0, hovered: false },
            achievements: { x: 0, y: 0, w: 0, h: 0, hovered: false }
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

        // Broad-phase grid of live enemies, rebuilt each frame. Enemy AI uses it
        // for O(1)-ish neighbour separation instead of an O(n^2) all-pairs scan;
        // cell size matches the 120px separation radius. (engine/spatialHash.js)
        this._enemyGrid = new SpatialHash(128);

        // Broad-phase grid of live projectiles, rebuilt each frame. Enemy AI uses
        // it for projectile-dodge so each enemy only tests shots in its ~1500px
        // neighbourhood instead of scanning EVERY projectile — that all-pairs
        // scan (enemies x projectiles) is what makes dense waves lag, since both
        // counts climb together. Cell size ~ the dodge broad-phase radius.
        this._projGrid = new SpatialHash(1024);

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

        // (Projectile lasers now draw as simple stroked streaks — no glow
        // sprite to pre-bake.)

        // Warm the fracture/shatter caches in the background (one sprite every
        // ~120ms) so the first shot/kill on each asteroid or enemy type never
        // pays the slice cost mid-combat.
        this._startFracturePrewarm();
    }

    // Background pre-warm of the per-sprite damage models. Each step costs a
    // few ms; spreading them out keeps the frame budget intact while making
    // first-hit chip damage and death shatters effectively free later.
    // Normally the title-screen prewarm (engine/prewarm.js) has already built
    // all of these, making every step here a cache hit — this run-time pass
    // only does real work when a run starts before that pump finished.
    _startFracturePrewarm() {
        const keys = FRACTURE_PREWARM_KEYS;

        let idx = 0;
        const step = () => {
            this._prewarmTimer = null;
            if (this.game.currentState !== this || idx >= keys.length) return;
            const [key, pieces] = keys[idx++];
            const img = this.game.assets.get(key);
            if (img) {
                FractureModel.get(img, key);      // chip-damage cell layout
                getCachedShatter(img, key, pieces); // death shatter layout
                if (key.startsWith('enemy_ship')) {
                    Enemy.getGlowSprite(img, key, '#ff4444'); // upgraded-enemy glow
                }
            }
            this._prewarmTimer = setTimeout(step, 150);
        };
        this._prewarmTimer = setTimeout(step, 1200);
    }

    // Host-side: batch-despawn anything in arr that died without its own
    // KILL/TOOK broadcast. Only allocates when something actually died, so
    // the steady-state per-frame cost is a plain scan with zero garbage.
    _broadcastDeadDespawns(kind, arr) {
        let dead = null;
        for (const e of arr) {
            if (!e.alive && e.netId !== undefined) (dead || (dead = [])).push(e);
        }
        if (dead) this.netSync.broadcastDespawn(kind, dead);
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

    // Continuous, non-accumulating rumble attenuated by distance to the player.
    // For sustained effects (e.g. an incoming cache) that shouldn't build up like shake().
    _rumbleAt(x, y, intensity, minPassDist = 1200, maxDist = 5000) {
        const dx = x - this.player.worldX;
        const dy = y - this.player.worldY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= maxDist) return;

        let finalIntensity = intensity;
        if (dist > minPassDist) {
            finalIntensity *= 1.0 - ((dist - minPassDist) / (maxDist - minPassDist));
        }
        if (finalIntensity > 0.05) this.camera.rumble(finalIntensity);
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
        // Event placement is seeded so the world's points of interest are in the
        // same spots for the same run seed. Falls back outside a run.
        const rand = () => this.game.rng ? this.game.rng.events.next() : Math.random();

        // Spawn Cthulhu very far away
        const angle = rand() * Math.PI * 2;
        const dist = 20000 + rand() * 10000;
        const cx = Math.cos(angle) * dist;
        const cy = Math.sin(angle) * dist;

        const cthulhu = new CthulhuEvent(this.game, cx, cy);
        this.events.push(cthulhu);

        // Spawn Cargo Ship Event
        const cargoAngle = rand() * Math.PI * 2;
        const cargoDist = 3000 + rand() * 3000;
        const csx = Math.cos(cargoAngle) * cargoDist;
        const csy = Math.sin(cargoAngle) * cargoDist;

        const cargoShip = new CargoShipEvent(this.game, csx, csy);
        this.events.push(cargoShip);

        // Spawn Fractured Station Event
        // Station 1: Randomized distance for discovery
        const f1Angle = rand() * Math.PI * 2;
        const f1Dist = 4000 + rand() * 2000;
        const f1x = Math.cos(f1Angle) * f1Dist;
        const f1y = Math.sin(f1Angle) * f1Dist;

        // Station 2: Medium distance
        const f2Angle = rand() * Math.PI * 2;
        const f2Dist = 6000 + rand() * 2000;
        const f2x = Math.cos(f2Angle) * f2Dist;
        const f2y = Math.sin(f2Angle) * f2Dist;

        // Station 3: Far away
        const f3Angle = rand() * Math.PI * 2;
        const f3Dist = 15000 + rand() * 5000;
        const f3x = Math.cos(f3Angle) * f3Dist;
        const f3y = Math.sin(f3Angle) * f3Dist;

        this.events.push(new FracturedStationEvent(this.game, [
            { x: f1x, y: f1y },
            { x: f2x, y: f2y },
            { x: f3x, y: f3y }
        ]));

        // Spawn Knowledge Event (Extreme distance)
        const kAngle = rand() * Math.PI * 2;
        const kDist = 30000 + rand() * 15000;
        const kx = Math.cos(kAngle) * kDist;
        const ky = Math.sin(kAngle) * kDist;
        this.events.push(new KnowledgeEvent(this.game, kx, ky));

        // Spawn Yellow One (Extreme distance, opposite direction from Knowledge)
        const yoAngle = kAngle + Math.PI + (rand() - 0.5) * 1.0;
        const yoDist = 35000 + rand() * 15000;
        const yox = Math.cos(yoAngle) * yoDist;
        const yoy = Math.sin(yoAngle) * yoDist;
        this.events.push(new YellowOne(this.game, yox, yoy));
    }

    _spawnInitialAsteroids() {
        // Seeded initial field via the asteroids stream.
        const rand = () => this.game.rng ? this.game.rng.asteroids.next() : Math.random();
        const numAsteroids = 6 + Math.floor(rand() * 8); // Reduced from 18-35 to 6-13
        // Multiplayer: anchor on the world origin instead of the local ship so
        // every machine derives the exact same field (players spawn in a small
        // ring around the origin; their positions differ slightly per pid).
        const anchorX = this.net ? 0 : this.player.worldX;
        const anchorY = this.net ? 0 : this.player.worldY;
        for (let i = 0; i < numAsteroids; i++) {
            const angle = rand() * Math.PI * 2;
            const dist = 400 + rand() * 2500; // Wider initial spread
            const ax = anchorX + Math.cos(angle) * dist;
            const ay = anchorY + Math.sin(angle) * dist;

            const roll = rand();
            let size = 'medium';
            if (roll < 0.05) size = 'big'; // reduced from 0.15 to 0.05
            else if (roll < 0.45) size = 'small';
            else if (roll < 0.60) size = 'tiny';

            let vx = 0, vy = 0;
            if (rand() > 0.5) {
                const driftAngle = rand() * Math.PI * 2;
                const speed = 10 + rand() * 20;
                vx = Math.cos(driftAngle) * speed;
                vy = Math.sin(driftAngle) * speed;
            }

            this.asteroids.push(new Asteroid(this.game, ax, ay, size, vx, vy));
        }
    }

    // Dev/testing: re-seed the run AND rebuild the procedural world from scratch
    // so the new seed actually takes effect — event/shop/asteroid placement is
    // baked in at run start, so just swapping the streams wouldn't move anything
    // already spawned. Keeps the player's ship/inventory/progress but snaps them
    // back to the spawn origin so player-relative initial asteroids and the
    // origin-relative events line up exactly with a fresh run on this seed.
    reseedRun(seed) {
        // Multiplayer worlds can't be reseeded mid-run — the seed is the
        // shared contract between every machine in the session.
        if (this.net) {
            console.log('Cannot reseed a multiplayer world.');
            return;
        }
        this.runSeed = seed;
        this.rng = new RandomStreams(seed);
        this.game.rng = this.rng;

        // Fresh spawners reset their distance/time accumulators and wave/phase
        // state so future spawns follow the new seed deterministically.
        this.asteroidSpawner = new AsteroidSpawner(this.game);
        this.enemySpawner = new EnemySpawner(this.game);
        this.cacheSpawner = new CacheSpawner(this.game);

        // Snap to spawn so the regenerated world matches the canonical layout.
        this.player.worldX = 0;
        this.player.worldY = 0;
        this.player.vx = 0;
        this.player.vy = 0;
        if (this.camera && this.camera.snapTo) this.camera.snapTo(this.player);

        // Clear all procedural + transient world entities.
        this.events = [];
        this.shops = [];
        this.revealedShops = [];
        this.asteroids = [];
        this.enemies = [];
        this.caches = [];
        this.encounters = [];
        this.scrapEntities = [];
        this.itemPickups = [];
        this.expOrbs = [];
        this.projectiles = [];
        this.rubble = [];
        this.activeBeams = [];
        this.explosions = [];
        this.sparks = [];
        this._boostFlowLevel = 0;
        this._trailAccum = 0;
        this.floatingTexts = [];

        // First encounters-stream draw — matches the constructor's ordering.
        this.encounterSpawnTimer = 60 + this.rng.encounters.next() * 10;

        // Regenerate the world in the same order as the constructor so each
        // domain stream is consumed identically to a fresh run on this seed.
        this._spawnInitialShops();
        this._spawnEvents();
        this._spawnInitialAsteroids();
    }

    exit() {
        document.body.classList.remove('playing');
        // Drop the shared run RNG reference so post-run states fall back to
        // Math.random() (MenuState also clears this on enter).
        if (this.game.rng === this.rng) this.game.rng = null;

        if (this._prewarmTimer) {
            clearTimeout(this._prewarmTimer);
            this._prewarmTimer = null;
        }

        // Leaving a multiplayer run ends the session: the host closes the
        // world for everyone, a client just disconnects.
        if (this.chatUI) { this.chatUI.destroy(); this.chatUI = null; }
        if (this.netSync) { this.netSync.destroy(); this.netSync = null; }
        // Hand music control back to single-player (host picks at random again).
        // (sounds can already be gone during app-quit teardown.)
        if (this.game.sounds) {
            this.game.sounds.onSelectMusicTrack = null;
            this.game.sounds.remoteMusicControl = false;
            // Leaving the run mid-streak shouldn't carry corruption to the menu
            if (this.game.sounds.setAudioCorruption) this.game.sounds.setAudioCorruption(0);
            if (this.game.sounds.setDreadWarble) this.game.sounds.setDreadWarble(0);
            if (this.game.sounds.setMusicDuck) this.game.sounds.setMusicDuck(0);
        }
        if (this.net) {
            const session = this.net;
            this.net = null;
            if (session.state !== 'ended') session.destroy();
        }
    }

    update(dt) {
        // mp = multiplayer run. The cardinal rule: in multiplayer the WORLD
        // NEVER PAUSES. Menus/shops/dialogs become overlays — the local ship
        // just stops accepting input while they're open.
        const mp = !!this.net;
        if (mp) {
            this._netPreFrame(dt);
            // The session may have just ended (host left) — _netPreFrame swaps
            // to the menu; don't run a frame on the dead state.
            if (!this.net) return;
        }

        // Increment true total time only if not paused, not in shop, and not dead
        if ((mp || (!this.paused && !this.isShopOpen && !this.isEncounterOpen && !this.isCacheOpen && !this.isLevelUpOpen && !this.isTradeOpen)) && !this.isDead) {
            this.trueTotalTime += dt;
            if (this.game.achievements) this.game.achievements.tickRun(dt);
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
                if (!mp) {
                    // Also update rubble so it keeps drifting (multiplayer ticks
                    // rubble in the world update below)
                    for (const r of this.rubble) r.update(dt);
                }
                if (this.deathTimer >= 3.0) {
                    this.showDeathScreen = true;
                    // Ensure d-pad/stick drive button selection rather than a
                    // lingering virtual mouse cursor from an inventory UI.
                    this.game.input.setGamepadCursorEnabled(false);
                    if (!this.yellowOneDeathScreen) {
                        this.game.sounds.playGameOverMusic();
                    }
                }
            }
            if (!mp) return;
            // The death screen's SHIP SELECTION button calls setState(MenuState),
            // which runs exit() and destroys net/netSync mid-update. `mp` was
            // captured before that, so bail before the world update below runs
            // on the exited state and throws (killing the rAF loop → black
            // screen). Mirrors the pause-menu guard in the overlay phase.
            if (this.game.currentState !== this) return;

            // Multiplayer: being dead doesn't stop the world (the host must
            // keep simulating it, and clients keep mirroring it). Spectate a
            // living teammate until you respawn or leave.
            this._respawnCooldown = Math.max(0, this._respawnCooldown);
            this._updateSpectate(dt);
            this.player.controlsEnabled = false;
            this._updateWorld(dt, mp);
            if (this.netSync) this.netSync.tick(dt);
            return;
        }

        // ── UI overlay phase ─────────────────────────────────────────────────
        // Single player: an open overlay freezes the world (early return at the
        // bottom). Multiplayer: the overlay updates here, then we fall through
        // to the world update with player controls disabled.
        let uiBlocked = false;

        // --- Level-up dialog ---
        if (this.isLevelUpOpen && this.activeLevelUpDialog) {
            this.activeLevelUpDialog.update(dt);
            if (this.activeLevelUpDialog.closed) {
                // Esc-dismissed: bank this level back onto the queue (it wasn't
                // spent) and exit the whole stack instead of advancing it. The
                // roll is cached so re-opening shows the same choices rather
                // than re-rolling (which would advance the seeded stream).
                const dlg = this.activeLevelUpDialog;
                const dismissed = dlg.dismissed;
                if (dismissed) {
                    this.levelUpQueue.unshift(dlg.level);
                    this._levelUpRolls[dlg.level] = { choices: dlg.choices, bonusMult: dlg.bonusMult };
                } else {
                    // Resolved (picked or skipped) — drop any cached roll.
                    delete this._levelUpRolls[dlg.level];
                }
                this.isLevelUpOpen       = false;
                this.activeLevelUpDialog = null;
                if (!dismissed && this.levelUpQueue.length > 0) {
                    this._openLevelUpDialog(this.levelUpQueue.shift());
                } else {
                    // Return to pause menu if that's where we came from;
                    // cache/shop contexts manage paused via isCacheOpen/isShopOpen.
                    this.paused = (this._levelUpOrigin === 'pause');
                    this._levelUpOrigin = null;
                }
            }
            uiBlocked = true;
        }

        // --- Encounter Dialog ---
        else if (this.isEncounterOpen && this.activeEncounterDialog) {
            this.activeEncounterDialog.update(dt);
            if (this.activeEncounterDialog.closed) {
                const enc = this.activeEncounterDialog.encounter;
                this.isEncounterOpen = false;
                this.paused = false;
                this._finishEncounterDialog(enc);
                this.activeEncounterDialog = null;
            }
            uiBlocked = true;
        }

        // --- Cache UI ---
        else if (this.isCacheOpen && this.activeCacheUI) {
            this._updateCacheUI(dt);
            uiBlocked = true;
        }

        else if (this.isShopOpen) {
            this._updateShopUI(dt);
            uiBlocked = true;
        }

        // --- Trade dialog (multiplayer) ---
        else if (this.isTradeOpen && this.tradeUI) {
            this._updateTradeUI(dt);
            uiBlocked = true;
        }

        // While typing in chat, keys belong to the chat box — skip pause/
        // interact handling entirely.
        const typingInChat = mp && this.chatUI && this.chatUI.active;
        if (!uiBlocked && !typingInChat) {
            this._updateInteractions(dt, mp);
            if (this.paused) {
                this._updatePauseUI(dt);
                uiBlocked = true;
            }
            // The pause menu's SHIP SELECTION confirm calls setState(MenuState)
            // — in MP there's no early return below (the world keeps running
            // through overlays), so without this bail the rest of this frame
            // would run on the exited state (netSync already destroyed) and
            // the resulting throw kills the rAF loop → black screen.
            if (this.game.currentState !== this) return;
        }

        if (uiBlocked && !mp) return;
        if (typingInChat) uiBlocked = true;

        this.player.controlsEnabled = !uiBlocked;
        this._updateWorld(dt, mp);
        if (mp && this.netSync) this.netSync.tick(dt);
    }

    // The interact/pause input section — extracted from update() so multiplayer
    // can skip it while an overlay is open without freezing the world.
    _updateInteractions(dt, mp) {
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

        // Gamepad shortcuts in gameplay:
        //   BACK / START → pause-toggle (Escape equivalent)
        //   X            → interact with whatever is nearby; falls back to
        //                  opening the pause menu if nothing is interactable.
        //                  In-UI consume-on-X is handled separately in the
        //                  pause / cache / shop paths, which return early
        //                  before this block runs.
        const gpInput = this.game.input;
        const gpPauseToggle = gpInput.isGamepadJustPressed(GP.BACK)
                           || gpInput.isGamepadJustPressed(GP.START)
                           || gpInput.isGamepadJustPressed(GP.B);
        const gpInteract    = gpInput.isGamepadJustPressed(GP.X);

        if (this.game.input.isKeyJustPressed('Escape') || gpPauseToggle) {
            if (this.paused) {
                // About to unpause, return dragged item
                if (this.draggedItem) {
                    this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                    this._onInventoryChanged();
                    this.draggedItem = null;
                }
                this._releaseGamepadCursor();
            }
            this.paused = !this.paused;
            this.game.sounds.play('click', 0.5);
        }

        // Multiplayer: nearby teammate → trade prompt, Enter → chat.
        let nearPlayer = null;
        if (mp && this.netSync) {
            if ((this.game.input.isKeyJustPressed('KeyT') || this.game.input.isKeyJustPressed('Enter'))
                && !this.chatUI.active && !this.game.devConsole.active) {
                this.chatUI.open();
            }
            const TRADE_RANGE = 220;
            for (const rp of this.netSync.remotePlayers.values()) {
                if (!rp._hasState || rp.isDead) continue;
                const dx = rp.worldX - this.player.worldX;
                const dy = rp.worldY - this.player.worldY;
                if (dx * dx + dy * dy < TRADE_RANGE * TRADE_RANGE) { nearPlayer = rp; break; }
            }
            this.canInteractPlayer = !!nearPlayer && !nearShop && !nearEncounter && !nearCache;

            // Incoming trade request prompt — Y accepts, N declines.
            if (this._tradeRequestFrom >= 0) {
                this._tradeRequestTimer -= dt;
                const input = this.game.input;
                const acceptReq = input.isKeyJustPressed('KeyY') || input.isGamepadJustPressed(GP.A);
                const declineReq = input.isKeyJustPressed('KeyN') || input.isGamepadJustPressed(GP.B);
                if (this._tradeRequestTimer <= 0 || !this.net.players.has(this._tradeRequestFrom)) {
                    this._tradeRequestFrom = -1;
                } else if (acceptReq) {
                    const fromPid = this._tradeRequestFrom;
                    this._tradeRequestFrom = -1;
                    this.netSync.sendTradeMsg(MSG.TRADE_ACCEPT, { toPid: fromPid });
                    this._openTrade(fromPid);
                } else if (declineReq) {
                    this.netSync.sendTradeMsg(MSG.TRADE_CANCEL, { toPid: this._tradeRequestFrom });
                    this._tradeRequestFrom = -1;
                }
            }
        }

        const interactTriggered = this.game.input.isKeyJustPressed('KeyE') || gpInteract;
        if (interactTriggered && !(mp && this.chatUI.active)) {
            if (nearEncounter) {
                // Prioritize encounter interaction
                if (mp) {
                    this._netRequestLock('encounter', nearEncounter.netId, (granted) => {
                        if (granted) this._openEncounterDialog(nearEncounter);
                        else this.spawnFloatingText(nearEncounter.worldX, nearEncounter.worldY, 'IN USE', '#ff8866');
                    });
                } else {
                    this._openEncounterDialog(nearEncounter);
                }
            } else if (nearCache) {
                if (mp) {
                    this._netRequestLock('cache', nearCache.netId, (granted) => {
                        if (granted) this._netOpenCache(nearCache);
                        else this.spawnFloatingText(nearCache.worldX, nearCache.worldY, 'IN USE', '#ff8866');
                    });
                } else if (nearCache.state === CACHE_STATE.OPEN) {
                    // Chest already open — show the UI immediately
                    this._openCacheUI(nearCache);
                } else {
                    // FOUND state: kick off the opening animation.
                    // The UI will appear once the animation completes.
                    nearCache.open();
                    this._pendingCache = nearCache;
                    if (this.game.achievements) {
                        this.game.achievements.notify('cache_opened', { cache: nearCache });
                    }
                }
            } else if (nearShop) {
                if (mp) {
                    this._netRequestLock('shop', nearShop.netId, (granted) => {
                        if (granted) this._openShop(nearShop);
                        else this.spawnFloatingText(nearShop.worldX, nearShop.worldY, 'IN USE', '#ff8866');
                    });
                } else {
                    this._openShop(nearShop);
                }
            } else if (nearPlayer) {
                // Request a trade with the nearby pilot.
                this.netSync.sendTradeMsg(MSG.TRADE_REQ, { toPid: nearPlayer.pid });
                this.spawnFloatingText(this.player.worldX, this.player.worldY, `TRADE REQUEST SENT`, '#9fe8ff');
                this.game.sounds.play('click', 0.5);
            } else {
                // Nothing in range — fall back to toggling the pause menu.
                if (this.paused) {
                    if (this.draggedItem) {
                        this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                        this._onInventoryChanged();
                        this.draggedItem = null;
                    }
                    this._releaseGamepadCursor();
                }
                this.paused = !this.paused;
                this.game.sounds.play('click', 0.5);
            }
        }
    }

    _openShop(shop) {
        this.activeShop = shop;
        this.isShopOpen = true;
        this.paused = true;
        this.game.sounds.play('click', 0.5);
        if (this.game.achievements) {
            this.game.achievements.notify('shop_opened', { shop });
        }

        // Good-stock surprise: no advance warning — the moment the doors open
        // and the player SEES a great spread, the panel glints. "Great" means
        // a well-stocked shelf or anything epic-or-better on it. Once per
        // shop visit cycle (re-arms when stock changes meaningfully).
        if (!shop._stockCelebrated) {
            let best = -1;
            for (const e of shop.inventory.items) best = Math.max(best, itemTier(e.item));
            const wellStocked = shop.inventory.items.length >= 6;
            const hasEpic = best >= 6;
            if (wellStocked || hasEpic) {
                shop._stockCelebrated = true;
                this._shopOpenFx = {
                    start: performance.now(),
                    epic: hasEpic,
                    // Glint positions as fractions of the shop panel, staggered
                    sparkles: Array.from({ length: hasEpic ? 14 : 9 }, () => ({
                        rx: 0.08 + Math.random() * 0.84,
                        ry: 0.08 + Math.random() * 0.84,
                        delay: Math.random() * 0.7,
                        dur: 0.3 + Math.random() * 0.25
                    }))
                };
                this.game.sounds.playJackpot(hasEpic ? 1 : 0);
            }
        }
    }

    // ── The world simulation ────────────────────────────────────────────────
    // Extracted from update(). `mp` toggles the multiplayer paths; when mp is
    // true and we're not the host, all authority-side systems (spawners, waves,
    // enemy AI, despawns, drops) are skipped — the host's messages drive them.
    _updateWorld(dt, mp = false) {
        const isNetHost = !mp || (this.netSync && this.netSync.isHost);
        const bodies = mp ? this.netSync.playerBodies() : null;

        // Update player (freeze during Yellow One scripted sequence)
        this.perf.begin('player');
        if (!this.yellowOneScriptActive && !this.isDead) {
            this.player.update(dt);
        }
        this.perf.end('player');
        this.game.sounds.setListenerPosition(this.player.worldX, this.player.worldY);

        // Advance replicated entities (remote players everywhere; enemy/
        // encounter interpolation on clients).
        if (mp && this.netSync) {
            if (this.netSync.updateReplicas) this.netSync.updateReplicas(dt);
            else this.netSync.updateRemotePlayers(dt);
        }

        // --- Event Update ---
        // Multiplayer: every machine runs event logic against the nearest
        // pilot (so proximity behaviors feel right for whoever is actually
        // there), while the host's EVENT_SYNC stream keeps the authoritative
        // state/health/position converged.
        let isEventActive = false;
        for (const ev of this.events) {
            let evTarget = this.player;
            if (mp && bodies && bodies.length) {
                evTarget = this.netSync.nearestBodyTo(ev.worldX, ev.worldY) || this.player;
            }
            ev.update(dt, evTarget);
            // Discovery fires when the event physically enters the player's
            // viewport — either by exploration or by following a signal to
            // the event's actual location. `revealed` (radar/locator pings)
            // intentionally does NOT count as discovery; the player has to
            // reach the event itself. Viewport bounds in world units are
            // `width / worldScale` × `height / worldScale`, centered on the
            // camera which tracks the player. Event radius pads the test so
            // discovery fires the moment any of the event is on screen.
            if (!ev.discovered && !ev.isFinished) {
                const edx = ev.worldX - this.player.worldX;
                const edy = ev.worldY - this.player.worldY;
                const halfViewW = (this.game.width / 2) / this.game.worldScale;
                const halfViewH = (this.game.height / 2) / this.game.worldScale;
                const radius = ev.radius || 100;
                if (Math.abs(edx) < halfViewW + radius
                    && Math.abs(edy) < halfViewH + radius) {
                    ev.discovered = true;
                    this.stats.eventsDiscovered++;
                    if (this.game.achievements) {
                        this.game.achievements.notify('event_discovered', { event: ev });
                    }
                }
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
                if (newEnemies.length > 0 && isNetHost) {
                    this._addEnemies(newEnemies);
                }
            } else if (ev.activeEnemies && ev.activeEnemies.length > 0) {
                // Add event enemies to the main list so they get drawn and hit by player projectiles
                if (isNetHost) this._addEnemies(ev.activeEnemies);
                ev.activeEnemies = [];
            }
            if (ev.popSpawns) {
                const spawns = ev.popSpawns();
                const gameplaySpawns = [];
                for (const s of spawns) {
                    // Clients keep only the cosmetic spawns — gameplay drops
                    // (scrap/asteroids/items/exp) arrive from the host as
                    // explicit spawn events instead.
                    if (s instanceof Rubble || s instanceof ProceduralDebris) {
                        if (this.rubble.length < 250) this.rubble.push(s);
                        continue;
                    }
                    if (!isNetHost) continue;
                    if (s instanceof Scrap) { if (this.scrapEntities.length < 200) { this.scrapEntities.push(s); gameplaySpawns.push(s); } }
                    else if (s instanceof Asteroid) { this.asteroids.push(s); gameplaySpawns.push(s); }
                    else if (s instanceof ItemPickup) { this.itemPickups.push(s); gameplaySpawns.push(s); this._onItemDropped(s); }
                    else if (s instanceof ExpOrb) { if (this.expOrbs.length < 150) { this.expOrbs.push(s); gameplaySpawns.push(s); } }
                }
                if (mp && isNetHost && gameplaySpawns.length) {
                    this.netSync.broadcastSpawns(gameplaySpawns);
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
                let minDistSq = 1500 * 1500;

                for (const en of this.enemies) {
                    if (!en.alive) continue;
                    const edx = en.worldX - this.player.worldX;
                    const edy = en.worldY - this.player.worldY;
                    const edistSq = edx * edx + edy * edy;
                    if (edistSq < minDistSq) {
                        target = en;
                        minDistSq = edistSq;
                    }
                }

                if (!target) {
                    for (const ast of this.asteroids) {
                        if (!ast.alive) continue;
                        const adx = ast.worldX - this.player.worldX;
                        const ady = ast.worldY - this.player.worldY;
                        const adistSq = adx * adx + ady * ady;
                        if (adistSq < minDistSq) {
                            target = ast;
                            minDistSq = adistSq;
                        }
                    }
                }
                if (!target) {
                    for (const ev of this.events) {
                        if (!ev.isAttackable) continue;
                        const edx = ev.worldX - this.player.worldX;
                        const edy = ev.worldY - this.player.worldY;
                        const edistSq = edx * edx + edy * edy;
                        if (edistSq < minDistSq) {
                            target = ev;
                            minDistSq = edistSq;
                        }
                    }
                }

                if (target) {
                    const aimAngle = Math.atan2(target.worldY - this.player.worldY, target.worldX - this.player.worldX);
                    // Increased damage and applied modifiers
                    const currentBaseDamage = (this.player.shipData.baseDamage * this.player.obedienceMult + this.player.permDamageBonus) * this.player.laserCartridgeMult;
                    const damage = (currentBaseDamage * 3.0) * this.player.laserOverrideMult;
                    const spriteKey = 'blue_laser_ball_big';

                    const proj = new Projectile(this.game, this.player.worldX, this.player.worldY, aimAngle, 1200, spriteKey, this.player, damage);
                    proj.isRocket = true;
                    proj.target = target;
                    proj.friendly = true;
                    if (this.netSync) this.netSync.queueLocalShot(0, proj.worldX, proj.worldY, aimAngle, 1200, spriteKey);
                    this.projectiles.push(proj);
                    this.game.sounds.play('laser', { volume: 0.4, x: this.player.worldX, y: this.player.worldY });
                    this.player.rocketsTimer = this.rocketInterval;
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
                let minDistSq = 800 * 800;

                // Check Enemies
                for (const en of this.enemies) {
                    if (!en.alive) continue;
                    const edx = en.worldX - this.player.worldX;
                    const edy = en.worldY - this.player.worldY;
                    const edistSq = edx * edx + edy * edy;
                    if (edistSq < minDistSq) {
                        const angleToEn = Math.atan2(edy, edx);
                        let diff = angleToEn - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = en;
                            minDistSq = edistSq;
                        }
                    }
                }

                // Check Asteroids
                for (const ast of this.asteroids) {
                    if (!ast.alive) continue;
                    const adx = ast.worldX - this.player.worldX;
                    const ady = ast.worldY - this.player.worldY;
                    const adistSq = adx * adx + ady * ady;
                    if (adistSq < minDistSq) {
                        const angleToAst = Math.atan2(ady, adx);
                        let diff = angleToAst - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = ast;
                            minDistSq = adistSq;
                        }
                    }
                }

                for (const ev of this.events) {
                    if (!ev.isAttackable) continue;
                    const edx = ev.worldX - this.player.worldX;
                    const edy = ev.worldY - this.player.worldY;
                    const edistSq = edx * edx + edy * edy;
                    if (edistSq < minDistSq) {
                        const angleToEv = Math.atan2(edy, edx);
                        let diff = angleToEv - turretAngle;
                        while (diff > Math.PI) diff -= Math.PI * 2;
                        while (diff < -Math.PI) diff += Math.PI * 2;

                        if (Math.abs(diff) < turretCone / 2) {
                            target = ev;
                            minDistSq = edistSq;
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
                    const damage = currentBaseDamage * this.player.laserOverrideMult;

                    const turretProj = new Projectile(this.game, px, py, aimAngle, 2400, spriteKey, this.player, damage);
                    turretProj.friendly = true;
                    if (this.netSync) this.netSync.queueLocalShot(0, px, py, aimAngle, 2400, spriteKey);
                    this.projectiles.push(turretProj);
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
                    const edistSq = edx * edx + edy * edy;
                    if (edistSq < 150 * 150) {
                        en.freeze(3.0);
                        // Multiplayer client: the real enemy lives on the host —
                        // ask it to apply the stun there too.
                        if (this.netSync && !this.netSync.isHost && this.netSync.reportEnemyContact) {
                            this.netSync.reportEnemyContact(en, 0, 3.0);
                        }
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
        } else if (!(mp && this.isDead)) {
            // (While dead in multiplayer the spectate camera drives instead.)
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
            for (const proj of this.player.pendingProjectiles) {
                proj.friendly = true; // player-owned — never collides with player ships
                if (mp && this.netSync) {
                    // Replicate as a visual so the other pilots see our lasers.
                    const speed = Math.hypot(proj.vx, proj.vy);
                    this.netSync.queueLocalShot(0, proj.worldX, proj.worldY, proj.angle, speed, proj.spriteKey);
                }
            }
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

        // --- Update impact sparks ---
        if (this.sparks.length) {
            const drag = Math.pow(0.84, dt * 60);
            for (let i = this.sparks.length - 1; i >= 0; i--) {
                const s = this.sparks[i];
                s.worldX += s.vx * dt;
                s.worldY += s.vy * dt;
                s.vx *= drag;
                s.vy *= drag;
                s.life -= dt;
                if (s.life <= 0) this.sparks.splice(i, 1);
            }
        }

        // --- Movement fx: boost space-bend level + engine-wash trail ---
        if (this.player && !this.isDead) {
            const pl = this.player;
            // The post-fx lens hits full strength the instant the boost fires
            // (it's an impulse — easing the attack just blunted it), then
            // relaxes gently so the bend doesn't snap off
            const flowTarget = pl.isWarping ? 0 : pl.boostIntensity;
            if (flowTarget > this._boostFlowLevel) {
                this._boostFlowLevel = flowTarget;
            } else {
                this._boostFlowLevel += (flowTarget - this._boostFlowLevel) * Math.min(1, dt * 6);
            }

            // Pixel exhaust streaming off the hull, denser the faster it flies
            const spd = Math.hypot(pl.vx, pl.vy);
            const frac = Math.min(1.5, spd / (pl.baseSpeed || 1));
            if (frac > 0.3 && !pl.isWarping) {
                const rate = 6 + 26 * frac * frac + (pl.isBoosting ? 26 : 0);
                this._trailAccum += rate * dt;
                const back = Math.atan2(-pl.vy, -pl.vx);
                while (this._trailAccum >= 1) {
                    this._trailAccum -= 1;
                    const off = (Math.random() - 0.5) * 36;
                    const bx = pl.worldX + Math.cos(back) * pl.radius - Math.sin(back) * off;
                    const by = pl.worldY + Math.sin(back) * pl.radius + Math.cos(back) * off;
                    this._spawnSparks(bx, by, 1, {
                        dir: back, spread: 1.7,
                        color: Math.random() < 0.25 ? '#e8f7ff'
                             : (pl.isBoosting ? '#ffd27f' : '#8fc8ff'),
                        speedMin: 8 + 22 * frac,
                        speedMax: 25 + 55 * frac,
                        lifeMin: 0.05, lifeMax: 0.16
                    });
                }
            } else {
                this._trailAccum = 0;
            }
        }

        if (this.eventBufferTimer > 0) {
            this.eventBufferTimer -= dt;
        }

        // Spawn asteroids always (not frozen by events)
        this.perf.begin('asteroids');
        if (isNetHost) {
            // Multiplayer "blob" spawning: the host runs one spawner per pilot,
            // each tracking that pilot's own movement (so everyone gets a field
            // to fly through), but a rock is vetoed if it would pop into
            // existence inside another pilot's no-spawn bubble.
            const cap = 180 + (mp ? (this.net.playerCount - 1) * 60 : 0);
            if (this.asteroids.length < cap) {
                if (!mp) {
                    const newAsteroids = this.asteroidSpawner.update(
                        dt, this.player.worldX, this.player.worldY,
                        this.player.vx, this.player.vy, this.player.asteroidSpawnMult
                    );
                    this.asteroids.push(...newAsteroids);
                } else {
                    this._mpSpawnAsteroidsFor(dt, this.asteroidSpawner, this.player, this.player.asteroidSpawnMult);
                    for (const rp of this.netSync.remotePlayers.values()) {
                        if (!rp._hasState || rp.isDead) continue;
                        let spawner = this._mpAsteroidSpawners.get(rp.pid);
                        if (!spawner) {
                            spawner = new AsteroidSpawner(this.game);
                            this._mpAsteroidSpawners.set(rp.pid, spawner);
                        }
                        this._mpSpawnAsteroidsFor(dt, spawner, rp, rp.asteroidSpawnMult || 1.0);
                    }
                }
            }
        }
        this.perf.end('asteroids');

        // --- Freeze spawning if an event is active ---
        // (Authority-side systems — clients only tick the cosmetic clocks in
        // the else-branch below; the host's WORLD_STATE stream corrects them.)
        if (isNetHost && !isEventActive && this.eventBufferTimer <= 0) {

            // Spawn caches (rare, distance-accumulator based). Multiplayer:
            // one spawner per pilot so everyone finds caches on their own path.
            if (!mp) {
                const newCaches = this.cacheSpawner.update(
                    this.player.worldX, this.player.worldY, this.caches.length, this.player.lvlCacheFreqMult
                );
                this.caches.push(...newCaches);
            } else {
                // Each pilot's travel still drives cache cadence (one accumulator
                // per pilot), but every cache that spawns is placed near a randomly
                // chosen live pilot — so caches aren't tied to whoever happened to
                // trigger them. (Wave reward caches override this and target the
                // wave's pilot; see the crash-cache drop above.)
                const liveBodies = this.netSync.playerBodies();
                const randTarget = () => {
                    const b = liveBodies.length
                        ? liveBodies[Math.floor(Math.random() * liveBodies.length)]
                        : this.player;
                    return { x: b.worldX, y: b.worldY };
                };
                const hostCaches = this.cacheSpawner.update(
                    this.player.worldX, this.player.worldY, this.caches.length, this.player.lvlCacheFreqMult,
                    randTarget()
                );
                for (const c of hostCaches) { this.caches.push(c); this.netSync.registerCache(c); }
                for (const rp of this.netSync.remotePlayers.values()) {
                    if (!rp._hasState || rp.isDead) continue;
                    let cs = this._mpCacheSpawners.get(rp.pid);
                    if (!cs) {
                        cs = new CacheSpawner(this.game);
                        this._mpCacheSpawners.set(rp.pid, cs);
                    }
                    const rpCaches = cs.update(rp.worldX, rp.worldY, this.caches.length, 1.0, randTarget());
                    for (const c of rpCaches) { this.caches.push(c); this.netSync.registerCache(c); }
                }
            }

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

            // Wave timer: fixed 2-minute interval, but pauses while a wave is still
            // in flight so waves don't bleed into one another. Wave is "active" until
            // 90% of its spawned enemies are destroyed.
            let bossAlive = false;
            let currentWaveAlive = 0;
            const currentWaveNum = this.enemySpawner.waveNumber;
            for (const e of this.enemies) {
                if (e.isBoss && e.alive) bossAlive = true;
                if (e.alive && e.waveTag === currentWaveNum) currentWaveAlive++;
            }
            const waveSpawned = this.enemySpawner.waveSpawnedTotal || 0;
            const waveStillSpawning = this.enemySpawner.waveQueue > 0;
            const waveClearedPct = waveSpawned > 0 ? 1 - (currentWaveAlive / waveSpawned) : 1;
            const waveActive = waveStillSpawning || (waveSpawned > 0 && waveClearedPct < 0.9);

            // Wave clear: transition from active -> inactive (player killed 90%+).
            if (this._waveWasActive && !waveActive) {
                this.stats.wavesCleared++;
                if (this.game.achievements) {
                    this.game.achievements.notify('wave_cleared');
                }
                // Everyone in the lobby cleared it together.
                if (mp) this.net.broadcast(MSG.WAVE_CLEARED, { num: currentWaveNum });
            }
            this._waveWasActive = waveActive;

            // Full wave clear (every spawned enemy of this wave destroyed) → a resupply
            // cache crash-lands in from off-screen. Boss waves spawn 0 normal enemies and
            // already drop a cache on boss death, so they naturally don't trigger this.
            const waveFullyCleared = waveSpawned > 0 && !waveStillSpawning && currentWaveAlive === 0;
            if (waveFullyCleared && currentWaveNum > 0 && this._lastCrashWave !== currentWaveNum) {
                this._lastCrashWave = currentWaveNum;
                this._crashCacheTimer = 3.0; // brief beat before the drop streaks in
            }

            // Deliver the queued resupply drop once the delay elapses, aimed at
            // the wave target's position at arrival time (the player whose wave
            // it was — in single player that's just you).
            if (this._crashCacheTimer > 0) {
                this._crashCacheTimer -= dt;
                if (this._crashCacheTimer <= 0) {
                    this._crashCacheTimer = 0;
                    if (this.caches.length < CACHE_CONFIG.maxActiveCaches + 2) {
                        const crashTarget = mp ? this.netSync.waveTargetBody() : this.player;
                        const crashCache = this.cacheSpawner.spawnCrash(crashTarget.worldX, crashTarget.worldY);
                        this.caches.push(crashCache);
                        if (mp) {
                            this.netSync.registerCache(crashCache, {
                                px: crashTarget.worldX, py: crashTarget.worldY,
                                angle: crashCache.cacheRotation - Math.PI / 2,
                                tx: crashCache.crashTargetX, ty: crashCache.crashTargetY,
                            });
                        }
                    }
                }
            }

            if (!bossAlive && !this.yellowOneFightActive) {
                this.postWaveTimer += dt;
                if (!waveActive) {
                    this.waveTimer -= dt;
                }
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
                // Pick (and announce) who the NEXT wave will center on, so the
                // countdown can show it for the whole two minutes.
                if (mp) this.netSync.chooseWaveTarget();
            }

            // Spawn enemies. Multiplayer: ambient/wave spawns center on the
            // wave target while a wave is draining, otherwise on a random
            // living pilot — and quantity scales with the lobby size.
            this.perf.begin('enemies');
            let spawnAnchor = this.player;
            let quantityMult = 1.0;
            if (mp) {
                quantityMult = mpQuantityMult(this.net.playerCount);
                if (this.enemySpawner.waveQueue > 0) {
                    spawnAnchor = this.netSync.waveTargetBody();
                } else {
                    const liveBodies = this.netSync.playerBodies();
                    if (liveBodies.length) {
                        spawnAnchor = liveBodies[Math.floor(Math.random() * liveBodies.length)];
                    }
                }
            }
            const newEnemies = this.enemySpawner.update(
                dt, spawnAnchor.worldX, spawnAnchor.worldY,
                this.difficultyScale * this.player.lvlEnemySpawnMult, quantityMult
            );
            this._addEnemies(newEnemies);
            this.perf.end('enemies');
        } else if (mp && !isNetHost) {
            // Client: cosmetic clocks tick locally between WORLD_STATE packets
            // so the HUD counts smoothly; the host's values correct any drift.
            if (!isEventActive && this.eventBufferTimer <= 0) {
                this.totalGameTime += dt;
                if (this.waveTimer > 0) this.waveTimer = Math.max(0, this.waveTimer - dt);
            }
            // Music transitions still react to local combat presence.
            if (this.waveTimer <= 6 && !this.musicCombatTriggered) {
                this.game.sounds.setTargetState(MUSIC_STATE.COMBAT);
                this.musicCombatTriggered = true;
            }
            this.postWaveTimer += dt;
            if (this.musicCombatTriggered && this.postWaveTimer >= 10 && this.waveTimer > 10) {
                if (this.enemies.length === 0) {
                    this.quietTimer += dt;
                    if (this.quietTimer >= 3.0) {
                        this.game.sounds.setTargetState(MUSIC_STATE.EXPLORATION);
                        this.musicCombatTriggered = false;
                        this.quietTimer = 0;
                    }
                } else {
                    this.quietTimer = 0;
                }
            }
        }

        // Boss death immunity: while any boss is dying, and for 2 seconds after
        // (runs on every machine — clients have boss replicas in DYING too)
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
        // In-place removal (the array is tiny; avoids a per-frame allocation)
        for (let i = this.bossWrecks.length - 1; i >= 0; i--) {
            if (this.bossWrecks[i].isFinished) this.bossWrecks.splice(i, 1);
        }

        if (this.flashTimer > 0) {
            this.flashTimer -= dt;
        }

        // Cinematic effects tick with the world (multiplayer: never pauses;
        // single player: freezes with the world under menus, like the flash).
        this.cinematics.update(dt);
        this.killStreak.update(dt);
        this.dread.update(dt);
        this.ambience.update(dt);

        // --- Combat/movement juice timers ---
        for (let i = this.muzzleFlashes.length - 1; i >= 0; i--) {
            this.muzzleFlashes[i].t -= dt;
            if (this.muzzleFlashes[i].t <= 0) this.muzzleFlashes.splice(i, 1);
        }
        for (let i = this.shieldRipples.length - 1; i >= 0; i--) {
            this.shieldRipples[i].t += dt;
            if (this.shieldRipples[i].t >= 0.35) this.shieldRipples.splice(i, 1);
        }
        if (this.shieldGlint > 0) this.shieldGlint -= dt;
        if (this._dialogTear > 0) this._dialogTear -= dt;
        if (this.radarPingT > 0) this.radarPingT -= dt;
        if (this._scrapRoll) {
            this._scrapRoll.t += dt;
            if (this._scrapRoll.t >= 0.8) this._scrapRoll = null;
        }
        for (let i = this.readyAbsorb.length - 1; i >= 0; i--) {
            const p = this.readyAbsorb[i];
            p.delay -= dt;
            if (p.delay > 0) continue;
            p.speed += 380 * dt;      // accelerating pull
            p.dist -= p.speed * dt;
            if (p.dist <= 6) {
                this.readyAbsorb[i] = this.readyAbsorb[this.readyAbsorb.length - 1];
                this.readyAbsorb.pop();
            }
        }

        // Boost ion ribbon: record the exhaust point while boosting, drain
        // quickly once it ends (with an ignition ring / cutoff puff).
        const boosting = this.player.isBoosting && !this.player.isWarping && !this.isDead;
        if (boosting) {
            const bx = this.player.worldX - Math.cos(this.player.angle) * 16;
            const by = this.player.worldY - Math.sin(this.player.angle) * 16;
            this.boostTrail.push(bx, by);
            if (this.boostTrail.length > 36) this.boostTrail.splice(0, 2);
            if (!this._wasBoosting) {
                this.cinematics.spawnRing(this.player.worldX, this.player.worldY,
                    { color: '#7fd4ff', maxR: 90, dur: 0.35, width: 3 });
                this._spawnSparks(bx, by, 8, {
                    dir: this.player.angle + Math.PI, spread: 0.9,
                    color: '#9fdcff', speedMin: 180, speedMax: 420
                });
            }
        } else {
            if (this._wasBoosting) {
                this._spawnSparks(
                    this.player.worldX - Math.cos(this.player.angle) * 16,
                    this.player.worldY - Math.sin(this.player.angle) * 16,
                    5, { color: '#9fdcff', speedMin: 40, speedMax: 140 });
            }
            if (this.boostTrail.length) this.boostTrail.splice(0, 4);
        }
        this._wasBoosting = boosting;

        // Update enemies — split into boss vs regular for perf tracking
        // Pre-filter asteroids near the player for enemy AI avoidance (avoid
        // 30×200 loop). Refills a persistent scratch array instead of
        // allocating a fresh one every frame.
        let enemyAvoidAsteroids = this.asteroids;
        if (this.asteroids.length > 60) {
            const near = this._avoidScratch || (this._avoidScratch = []);
            near.length = 0;
            for (const a of this.asteroids) {
                if (a._nearPlayer) near.push(a);
            }
            enemyAvoidAsteroids = near;
        }

        // Multiplayer host: each enemy hunts whichever pilot is closest.
        // Clients don't run AI at all — replicas are driven by snapshots.
        const enemyTarget = (e) => {
            if (!mp || !bodies || bodies.length === 0) return this.player;
            let best = this.player, bestD = Infinity;
            for (const b of bodies) {
                const dx = b.worldX - e.worldX, dy = b.worldY - e.worldY;
                const d = dx * dx + dy * dy;
                if (d < bestD) { bestD = d; best = b; }
            }
            return best;
        };
        const collectEnemyProjectiles = (e) => {
            if (e.pendingProjectiles.length > 0) {
                if (mp) {
                    for (const proj of e.pendingProjectiles) this.netSync.queueEnemyProjectile(proj, e);
                }
                this.projectiles.push(...e.pendingProjectiles);
                e.pendingProjectiles.length = 0;
            }
        };

        // Rebuild the enemy + projectile broad-phase grids from this frame's
        // start positions so each enemy's separation and projectile-dodge steps
        // only test nearby cells, not the whole enemy/projectile lists.
        this._enemyGrid.rebuild(this.enemies, _enemyAlive);
        this._projGrid.rebuild(this.projectiles, _projAlive);

        // Temporal AI LOD stride: with few enemies everyone re-solves obstacle
        // avoidance/dodge every frame (no change). In a crowd the expensive solve
        // is spread over `stride` frames — each enemy re-solves on its scheduled,
        // offset tick and carries the result over between (Enemy.update). Bosses
        // always re-solve (few, and they matter). Halves/thirds the dominant AI
        // cost in dense waves; the only effect is obstacle/dodge reaction landing
        // a frame or two later, which is imperceptible amid that many ships.
        this._aiFrame = (this._aiFrame | 0) + 1;
        const _enN = this.enemies.length;
        const _aiStride = _enN <= 8 ? 1 : (_enN <= 16 ? 2 : 3);

        this.perf.begin('enemies');
        if (isNetHost) {
            this.perf.begin('boss');
            for (const e of this.enemies) {
                if (!e.isBoss) continue;
                e._avoidRecompute = true;
                e.update(dt, enemyTarget(e), enemyAvoidAsteroids, this.projectiles, this.enemies);
                collectEnemyProjectiles(e);
            }
            this.perf.end('boss');
            const despawnedEnemies = mp ? [] : null;
            for (const e of this.enemies) {
                if (e.isBoss) continue;
                e._avoidRecompute = (_aiStride === 1) || (((this._aiFrame + e._aiOffset) % _aiStride) === 0);
                e.update(dt, enemyTarget(e), enemyAvoidAsteroids, this.projectiles, this.enemies);
                collectEnemyProjectiles(e);

                // Despawn if way too far — from EVERY pilot, not just us.
                const despawnR = 3500 * this.currentFovMult;
                let minDistSq = Infinity;
                if (mp && bodies) {
                    for (const b of bodies) {
                        const dx = e.worldX - b.worldX, dy = e.worldY - b.worldY;
                        minDistSq = Math.min(minDistSq, dx * dx + dy * dy);
                    }
                } else {
                    const dxArr = e.worldX - this.player.worldX;
                    const dyArr = e.worldY - this.player.worldY;
                    minDistSq = dxArr * dxArr + dyArr * dyArr;
                }
                if (minDistSq > despawnR * despawnR && !e.isBoss) {
                    e.alive = false;
                    if (despawnedEnemies) despawnedEnemies.push(e);
                }
            }
            if (mp && despawnedEnemies && despawnedEnemies.length) {
                this.netSync.broadcastDespawn(KIND.ENEMY, despawnedEnemies);
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
        // Update asteroids (linear drift — identical math on every machine, so
        // multiplayer replicas integrate for free). Despawn is host-authority:
        // a rock has to be far from EVERY pilot before it's culled.
        this.perf.begin('asteroids');
        const despawnedAsteroids = (mp && isNetHost) ? [] : null;
        for (const a of this.asteroids) {
            a.update(dt);
            if (!isNetHost) continue; // clients: host broadcasts despawns
            let minDistSq;
            if (mp && bodies && bodies.length) {
                minDistSq = Infinity;
                for (const b of bodies) {
                    const dx = a.worldX - b.worldX, dy = a.worldY - b.worldY;
                    minDistSq = Math.min(minDistSq, dx * dx + dy * dy);
                }
            } else {
                const dx = a.worldX - this.player.worldX;
                const dy = a.worldY - this.player.worldY;
                minDistSq = dx * dx + dy * dy;
            }
            if (minDistSq > a.despawnDist * a.despawnDist) {
                a.alive = false;
                if (despawnedAsteroids) despawnedAsteroids.push(a);
            }
        }
        if (despawnedAsteroids && despawnedAsteroids.length) {
            this.netSync.broadcastDespawn(KIND.ASTEROID, despawnedAsteroids);
        }
        this.perf.end('asteroids');

        // Tag entities near ANY pilot for broad-phase collision/AI culling
        {
            const cullRange = 3000 * this.currentFovMult;
            const cullRangeSq = cullRange * cullRange;
            const nearAnyBody = (x, y) => {
                if (mp && bodies && bodies.length) {
                    for (const b of bodies) {
                        const dx = x - b.worldX, dy = y - b.worldY;
                        if (dx * dx + dy * dy < cullRangeSq) return true;
                    }
                    return false;
                }
                const dx = x - this.player.worldX, dy = y - this.player.worldY;
                return dx * dx + dy * dy < cullRangeSq;
            };
            for (const a of this.asteroids) {
                a._nearPlayer = nearAnyBody(a.worldX, a.worldY);
            }
            for (const en of this.enemies) {
                en._nearPlayer = nearAnyBody(en.worldX, en.worldY);
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

        // Cleanup stale indicator opacities — build a Set for O(1) lookups.
        // Entries for dead entities are never read (the render side iterates
        // the live arrays and looks opacities up by entity), so this is pure
        // garbage collection — running it twice a second instead of every
        // frame skips ~300 Set inserts per frame with no observable change.
        this._indicatorSweepTimer = (this._indicatorSweepTimer || 0) - dt;
        if (this.indicatorOpacities.size > 0 && this._indicatorSweepTimer <= 0) {
            this._indicatorSweepTimer = 0.5;
            const liveEntities = new Set();
            for (const e of this.enemies) liveEntities.add(e);
            for (const a of this.asteroids) liveEntities.add(a);
            for (const s of this.shops) liveEntities.add(s);
            for (const ev of this.events) liveEntities.add(ev);
            for (const enc of this.encounters) liveEntities.add(enc);
            for (const w of this.bossWrecks) liveEntities.add(w);
            for (const c of this.caches) liveEntities.add(c);
            // Teammates' HUD dots fade in via the same opacity map — without
            // this they'd be purged every frame and never become visible.
            if (this.netSync) {
                for (const rp of this.netSync.remotePlayers.values()) liveEntities.add(rp);
            }
            for (const entity of this.indicatorOpacities.keys()) {
                if (!liveEntities.has(entity)) {
                    this.indicatorOpacities.delete(entity);
                }
            }
        }

        // Magnet anchor: in multiplayer a pickup vacuums toward whichever
        // pilot is closest (so loot doesn't fly across the screen to the wrong
        // ship); collection itself is still strictly local + host-arbitrated.
        const magnetTargetFor = (ent) => {
            if (mp && bodies && bodies.length) {
                let best = null, bestD = Infinity;
                for (const b of bodies) {
                    if (b === this.player && (this.player.isWarping || this.isDead)) continue;
                    if (b.isWarping) continue;
                    const dx = b.worldX - ent.worldX, dy = b.worldY - ent.worldY;
                    const d = dx * dx + dy * dy;
                    if (d < bestD) { bestD = d; best = b; }
                }
                return best;
            }
            return (!this.player.isWarping && !this.isDead) ? this.player : null;
        };
        const canCollect = !this.player.isWarping && !this.isDead;

        // Update scrap entities (magnetized to nearest pilot)
        for (const s of this.scrapEntities) {
            const target = magnetTargetFor(s);
            if (target) {
                const magnetMult = target === this.player ? this.player.scrapRangeMult : (target.scrapRangeMult || 1.0);
                s.update(dt, target.worldX, target.worldY, magnetMult);
            } else {
                s.update(dt, -99999, -99999); // drift only
            }

            // Collection collision — local pilot only
            if (canCollect && s.alive) {
                const dx = s.worldX - this.player.worldX;
                const dy = s.worldY - this.player.worldY;
                const collectRange = (s.collectRange + this.player.radius);
                if (dx * dx + dy * dy < collectRange * collectRange) {
                    if (mp) {
                        if (this.netSync.isHost) {
                            if (this.netSync.localTake(s)) {
                                s.alive = false;
                                this.player.scrap += s.value;
                                this.stats.scrapCollected += s.value;
                                if (this.game.achievements) {
                                    this.game.achievements.notify('scrap_collected', { amount: s.value });
                                }
                                this.game.sounds.play('scrap', { volume: 0.4, x: s.worldX, y: s.worldY });
                                this.spawnFloatingText(s.worldX, s.worldY, `+${s.value}`, '#ffff00');
                            }
                        } else {
                            // Effects play on the host's TOOK confirmation
                            // (sub-100ms) so a lost race can't double-count.
                            this.netSync.requestTake(s);
                        }
                    } else {
                        s.alive = false;
                        this.player.scrap += s.value;
                        this.stats.scrapCollected += s.value;
                        if (this.game.achievements) {
                            this.game.achievements.notify('scrap_collected', { amount: s.value });
                        }
                        this.game.sounds.play('scrap', { volume: 0.4, x: s.worldX, y: s.worldY });
                        this.spawnFloatingText(s.worldX, s.worldY, `+${s.value}`, '#ffff00');
                    }
                }
            }
        }

        // Update item pickups (magnetized to nearest pilot)
        for (const it of this.itemPickups) {
            const target = magnetTargetFor(it);
            if (target) {
                const magnetMult = target === this.player ? this.player.scrapRangeMult : (target.scrapRangeMult || 1.0);
                it.update(dt, target.worldX, target.worldY, magnetMult);
            } else {
                it.update(dt, -99999, -99999); // Pass dummy coords to prevent magnetization
            }

            // Collection collision — local pilot only
            if (canCollect && it.alive) {
                const dx = it.worldX - this.player.worldX;
                const dy = it.worldY - this.player.worldY;
                const collectRange = (it.collectRange + this.player.radius);

                if (dx * dx + dy * dy < collectRange * collectRange && (it.pickupDelay || 0) <= 0) {
                    if (mp) {
                        if (this.netSync.isHost) {
                            if (this.player.inventory.autoAdd(it.item)) {
                                if (this.netSync.localTake(it)) {
                                    it.alive = false;
                                    this.game.sounds.play('select', 0.5);
                                    if (this.game.achievements) {
                                        this.game.achievements.notify('upgrade_collected', { item: it.item });
                                    }
                                    this._onInventoryChanged();
                                    this.celebratePickup(it.item);
                                } else {
                                    // Already claimed — undo the optimistic add.
                                    const entry = this.player.inventory.items.find(e => e.item === it.item);
                                    if (entry) this.player.inventory.removeItemAt(entry.x, entry.y);
                                }
                            } else {
                                it.markEncountered(this.player.worldX, this.player.worldY);
                            }
                        } else {
                            // requestTake handles the optimistic inventory add +
                            // host arbitration; full inventory → leash like SP.
                            const before = it._pendingTake;
                            this.netSync.requestTake(it);
                            if (!it._pendingTake && !before) {
                                it.markEncountered(this.player.worldX, this.player.worldY);
                            }
                        }
                    } else if (this.player.inventory.autoAdd(it.item)) {
                        it.alive = false;
                        this.game.sounds.play('select', 0.5);
                        if (this.game.achievements) {
                            this.game.achievements.notify('upgrade_collected', { item: it.item });
                        }
                        this._onInventoryChanged();
                        this.celebratePickup(it.item);
                    } else {
                        // Inventory full — engage the follow-leash so the item
                        // stops bouncing around the player and eventually despawns.
                        it.markEncountered(this.player.worldX, this.player.worldY);
                    }
                }
            }
            // Despawn check (only for non-encountered items — encountered ones
            // ride the follow-leash and despawn on their own timer). Host-only
            // in multiplayer; clients mirror the host's despawn broadcasts.
            if (!it.encountered && isNetHost) {
                const ddx = it.worldX - this.player.worldX;
                const ddy = it.worldY - this.player.worldY;
                if (ddx * ddx + ddy * ddy > 4000 * 4000 && (!mp || !this._anyBodyNear(it.worldX, it.worldY, 4000))) {
                    it.alive = false;
                }
            }
        }

        // Update ExpOrbs. Owned orbs (multiplayer: XP belongs to the pilot who
        // landed the kill) home to their owner and ignore everyone else.
        for (let i = this.expOrbs.length - 1; i >= 0; i--) {
            const orb = this.expOrbs[i];
            let target = null;
            const owned = mp && orb.ownerPid != null;
            if (owned) {
                if (orb.ownerPid === this.netSync.myPid) {
                    target = this.player;
                } else {
                    target = this.netSync.remotePlayers.get(orb.ownerPid) || null;
                    // Owner left the session → the XP is up for grabs.
                    if (!target && !this.net.players.has(orb.ownerPid)) orb.ownerPid = null;
                }
            }
            if (!target) target = magnetTargetFor(orb) || this.player;
            orb.update(dt, target.worldX, target.worldY);

            // Collection collision — local pilot only (and only OUR orbs when owned)
            const canTakeOrb = !owned || orb.ownerPid === this.netSync.myPid;
            const dx = orb.worldX - this.player.worldX;
            const dy = orb.worldY - this.player.worldY;
            const distSq = dx * dx + dy * dy;
            const collectRange = (orb.collectRange + this.player.radius);

            if (canCollect && canTakeOrb && orb.alive && distSq < collectRange * collectRange) {
                if (mp) {
                    if (this.netSync.isHost) {
                        if (this.netSync.localTake(orb)) {
                            orb.alive = false;
                            const finalExp = Math.ceil(orb.amount * (this.player.experienceCondenserMult || 1.0));
                            this.player.addExp(finalExp);
                            this.game.sounds.play('exp', { volume: 0.15, x: orb.worldX, y: orb.worldY });
                            this.spawnFloatingText(orb.worldX + (Math.random() - 0.5) * 20, orb.worldY + (Math.random() - 0.5) * 20, `+${finalExp} XP`, '#915dbf');
                        }
                    } else {
                        this.netSync.requestTake(orb);
                    }
                } else {
                    orb.alive = false;
                    const finalExp = Math.ceil(orb.amount * (this.player.experienceCondenserMult || 1.0));
                    this.player.addExp(finalExp);
                    this.game.sounds.play('exp', { volume: 0.15, x: orb.worldX, y: orb.worldY });

                    // Floating text for every collection
                    const offsetX = (Math.random() - 0.5) * 20;
                    const offsetY = (Math.random() - 0.5) * 20;
                    this.spawnFloatingText(orb.worldX + offsetX, orb.worldY + offsetY, `+${finalExp} XP`, '#915dbf');
                }
            }

            // Despawn check (host authority in multiplayer)
            if (distSq > 25000000 && isNetHost && (!mp || !this._anyBodyNear(orb.worldX, orb.worldY, 5000))) {
                orb.alive = false; // 5000^2
            }
        }

        // --- Collision: Projectiles vs Everything ---
        this.perf.begin('collisions');

        // _nearPlayer tags are already computed after asteroid update (used by enemy AI too)

        for (const proj of this.projectiles) {
            if (!proj.alive) continue;

            // vs Asteroids (All Projectiles)
            for (const ast of this.asteroids) {
                if (!ast.alive || !ast._nearPlayer) continue;
                const cr = proj.radius + ast.radius;
                if (_projSweepHit(proj, ast.worldX, ast.worldY, cr)) {
                    proj.alive = false;
                    this.game.sounds.play('hit', { volume: 0.4, x: proj.worldX, y: proj.worldY });
                    this._spawnSparks(proj.worldX, proj.worldY, 5 + Math.floor(Math.random() * 4), {
                        // Fan out along the surface normal (center → impact point)
                        dir: Math.atan2(proj.worldY - ast.worldY, proj.worldX - ast.worldX),
                        spread: Math.PI * 0.9
                    });
                    // Replicated visual shots stop on rocks but deal no damage
                    // (the shooter's own machine reports the real hit).
                    if (!proj.netVisual) {
                        if (this._routeDamage(ast, proj.damage, proj.worldX, proj.worldY)) {
                            this._onEntityDestroyed(ast);
                        } else {
                            this._triggerShakeAt(proj.worldX, proj.worldY, 0.4);
                            // Break a few outer chips off where the laser landed
                            const chips = ast.chipHit(proj.worldX, proj.worldY);
                            for (const d of chips) { if (this.rubble.length < 250) this.rubble.push(d); }
                            // Dust puff + a visual-only kick to the rock's spin.
                            // Torque is physical: lever arm (center → impact)
                            // crossed with the shot direction, divided by the
                            // rock's moment of inertia (∝ r²) — edge hits spin
                            // it, center hits barely do, small rocks spin more.
                            this._spawnSparks(proj.worldX, proj.worldY, 3,
                                { color: '#9a958c', speedMin: 30, speedMax: 110 });
                            if (ast.rotSpeed !== undefined) {
                                const rx = proj.worldX - ast.worldX;
                                const ry = proj.worldY - ast.worldY;
                                const vlen = Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy) || 1;
                                const lever = (rx * proj.vy - ry * proj.vx) / vlen;
                                const inertia = Math.max(ast.radius * ast.radius, 100);
                                const kick = Math.max(-1.2, Math.min(1.2, (lever / inertia) * 35));
                                ast.rotSpeed += kick;
                            }
                        }
                    }
                    // Player-only Explosives Unit vs Shared Rockets
                    if (!proj.netVisual && ((proj.owner === this.player && this.player.hasExplosivesUnit) || proj.isRocket)) {
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
                    const cr = proj.radius + ev.radius;
                    if (_projSweepHit(proj, ev.worldX, ev.worldY, cr)) {
                        proj.alive = false;
                        if (this._routeDamage(ev, proj.damage, proj.worldX, proj.worldY)) {
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
                    const cr = proj.radius + en.radius;
                    if (_projSweepHit(proj, en.worldX, en.worldY, cr)) {
                        proj.alive = false;
                        this.game.sounds.play('hit', { volume: 0.4, x: proj.worldX, y: proj.worldY });
                        this._spawnSparks(proj.worldX, proj.worldY, 5 + Math.floor(Math.random() * 4), {
                            dir: Math.atan2(proj.worldY - en.worldY, proj.worldX - en.worldX),
                            spread: Math.PI * 0.9, color: '#fff2b0'
                        });
                        if (this._routeDamage(en, proj.damage, proj.worldX, proj.worldY)) {
                            this.cinematics.deathPop(en);
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
            // Enemy projectiles vs Player. `friendly` covers other players'
            // replicated shots — teammates can never hit each other.
            else if (proj.owner !== this.player && !proj.friendly && !this.isDead) {
                const dx = proj.worldX - this.player.worldX;
                const dy = proj.worldY - this.player.worldY;
                const cr = proj.radius + this.player.radius;

                // Near-miss: a shot slipping just past the hull leaves a streak
                if (!proj._nearMiss && dx * dx + dy * dy < cr * cr * 5.5) {
                    proj._nearMiss = true;
                    const va = Math.atan2(proj.vy || 0, proj.vx || 0);
                    this._spawnSparks(proj.worldX, proj.worldY, 2,
                        { dir: va, spread: 0.15, color: '#cfe8ff', speedMin: 320, speedMax: 520 });
                }

                // Broad-phase squared-distance check followed by pixel-perfect check
                if (dx * dx + dy * dy < cr * cr) {
                    if (this.player.checkPixelCollision(proj.worldX, proj.worldY)) {
                        proj.alive = false;
                        this._damagePlayer(proj.damage, proj.worldX, proj.worldY); // proj.damage is already scaled in Enemy.shoot
                        this._spawnSparks(proj.worldX, proj.worldY, 7 + Math.floor(Math.random() * 4), {
                            dir: Math.atan2(proj.worldY - this.player.worldY, proj.worldX - this.player.worldX),
                            spread: Math.PI * 0.9,
                            color: this.player.shielding ? '#9fe8ff' : '#ff9a5a'
                        });

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
        if (!this.player.isWarping && !this.isDead) {
            // Player vs Asteroids
            for (const ast of this.asteroids) {
                if (!ast.alive) continue;
                const dx = this.player.worldX - ast.worldX;
                const dy = this.player.worldY - ast.worldY;
                const cr = this.player.radius + ast.radius;
                if (dx * dx + dy * dy < cr * cr) {
                    const wasPendingBellyFlop = this.player._pendingBellyFlop > 0;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    ast.onCollision(this.player);
                    this._damagePlayer(ast.damage * this.player.lvlAsteroidResistanceMult, ast.worldX, ast.worldY);
                    if (this.netSync && !this.netSync.isHost) {
                        // Replica: cosmetic shatter now, host arbitrates the kill + loot.
                        this.netSync.reportAsteroidRam(ast);
                    } else {
                        if (this.netSync) ast._lastDamageBy = this.netSync.myPid;
                        ast.alive = false;
                        this._onEntityDestroyed(ast);
                    }
                    this._applyKnockback(dx, dy, dist, 200);
                    if (this.game.achievements) {
                        this.game.achievements.notify('asteroid_rammed');
                        // Belly Flop: this collision happened right after a
                        // blink landed inside an asteroid, AND it killed us.
                        if (wasPendingBellyFlop && this.isDead) {
                            this.game.achievements.notify('belly_flop_death');
                            this.player._pendingBellyFlop = 0;
                        }
                    }
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
                    this._damagePlayer(20, en.worldX, en.worldY); // Ramming hurts!
                    if (this.netSync && !this.netSync.isHost) {
                        // Compute the contact damage we deal (shield capacitor
                        // builds hit harder) and let the host apply it.
                        let ramDmg = 20;
                        if (this.player.shielding && this.player.shieldCapacitorCount > 0) {
                            ramDmg = (20.0 + this.player.shieldCapacitorCount * 40.0) * (this.player.lvlShieldDamageMult || 1.0);
                        }
                        this.netSync.reportEnemyContact(en, ramDmg);
                        // Brief local invuln mirror so the replica can't re-ram every frame.
                        en.invulnTimer = Math.max(en.invulnTimer, 0.4);
                    } else {
                        if (this.netSync) en._lastDamageBy = this.netSync.myPid;
                        en.onCollision(this.player);
                        if (!en.alive) this._onEntityDestroyed(en);
                    }
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
                    this._damagePlayer(20, ev.worldX, ev.worldY);
                    this._routeDamage(ev, 1); // Triggers wake (host-arbitrated in MP)
                    this._applyKnockback(dx, dy, dist, 600); // Big knockback from boss
                }
            }
        }

        // --- Collision: Enemies vs Asteroids ---
        // (Note: still inside collisions timing block. Host-authority: both
        // sides are replicas on clients, so the host resolves these.)
        if (isNetHost) {
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
                        if (mp && en.alive) this.netSync.markHpDirty(KIND.ENEMY, en);

                        // Don't break if tractored by THIS enemy OR recently released by a crusher
                        if (ast.tractoredBy === en || (en instanceof AsteroidCrusher && ast.tractorCooldown > 0)) continue;

                        if (ast.hit(1)) {
                            this._onEntityDestroyed(ast);
                        } else if (mp) {
                            this.netSync.markHpDirty(KIND.ASTEROID, ast);
                        }
                        if (!en.alive) {
                            this._onEntityDestroyed(en);
                        }
                    }
                }
            }
        }

        this.perf.end('collisions');

        // Multiplayer host: anything that died without an explicit KILL/TOOK
        // broadcast (lifetimes, despawn rules) gets a batched DESPAWN so the
        // clients' nid maps never leak.
        if (mp && isNetHost) {
            this._broadcastDeadDespawns(KIND.PICKUP, this.scrapEntities);
            this._broadcastDeadDespawns(KIND.PICKUP, this.expOrbs);
            this._broadcastDeadDespawns(KIND.PICKUP, this.itemPickups);
            this._broadcastDeadDespawns(KIND.ENEMY, this.encounters);
            this._broadcastDeadDespawns(KIND.CACHE, this.caches);
        }

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

        // Update existing encounters. Host simulates them against the pilot
        // they spawned for; clients interpolate replicas (netSync) instead.
        if (isNetHost) {
            for (const enc of this.encounters) {
                let encTarget = this.player;
                if (mp && enc.netTargetPid !== undefined && enc.netTargetPid !== this.netSync.myPid) {
                    encTarget = this.netSync.remotePlayers.get(enc.netTargetPid) || this.player;
                }
                enc.update(dt, encTarget);
            }
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

        if (isNetHost && !bossAlive2 && !isEventActive && !enemiesOnScreen && this.encounters.length === 0) {
            this.encounterSpawnTimer -= dt;
            if (this.encounterSpawnTimer <= 0) {
                // Multiplayer: the visitor seeks out a random living pilot.
                let encAnchor = null;
                if (mp) {
                    const liveBodies = this.netSync.playerBodies();
                    if (liveBodies.length) encAnchor = liveBodies[Math.floor(Math.random() * liveBodies.length)];
                }
                this._spawnEncounter(undefined, encAnchor);
                // Frequency scales with exploration: more travel/events/shops = shorter wait
                const explorationFactor = Math.min(4.0,
                    1.0 + (this.playerDistanceTraveled / 15000) * 0.3
                    + (this.stats.eventsDiscovered * 0.2)
                    + (this.stats.shopsUnlocked * 0.15)
                );
                const baseWait = 140; // ~2.3 minutes base
                const minWait = 45;   // 45 seconds minimum
                const encR = this.game.rng ? this.game.rng.encounters.next() : Math.random();
                const wait = Math.max(minWait, baseWait / explorationFactor + (encR - 0.5) * 40);
                this.encounterSpawnTimer = wait / Math.max(0.1, this.player.lvlEncounterFreqMult);
            }
        }
    }

    // killerPid (multiplayer): who actually landed the kill. Defaults to the
    // entity's last damage source, falling back to the local pilot.
    _onEntityDestroyed(entity, killerPid = undefined) {
        const mp = !!this.netSync;
        if (mp && killerPid === undefined) {
            killerPid = entity._lastDamageBy !== undefined ? entity._lastDamageBy : this.netSync.myPid;
        }
        const killerIsLocal = !mp || killerPid === this.netSync.myPid;

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
                if (mp) this.netSync.registerCache(bossCache);
            }
        }
        // Track stats — in multiplayer these are personal: only the pilot who
        // landed the kill counts it (remote machines do the same via KILL).
        if (entity instanceof Asteroid) {
            if (killerIsLocal) {
                this.stats.asteroidsDestroyed++;
                if (this.game.achievements) {
                    this.game.achievements.notify('asteroid_destroyed', {
                        entity,
                        playerShieldBroken: this.player.shieldBroken && !this.player.shielding
                    });
                }
            }
        } else if (!(entity instanceof CthulhuEvent) && !(entity instanceof CargoShipEvent)) {
            if (killerIsLocal) {
                this.stats.enemiesDefeated++;
                this.killStreak.onKill(entity);
                if (this.game.achievements) {
                    this.game.achievements.notify('enemy_killed', { entity });
                }
            }
        }

        // Loot rolls credit the killer's drill build (asteroids only).
        if (mp && entity instanceof Asteroid) {
            if (killerIsLocal) entity._killerDrillMult = this.player.asteroidDrillMult;
            else {
                const rp = this.netSync.remotePlayers.get(killerPid);
                entity._killerDrillMult = rp ? (rp.asteroidDrillMult || 1.0) : 1.0;
            }
        }

        const spawns = entity.getSpawnOnDeath();
        const gameplaySpawns = mp ? [] : null;
        // Multiplayer: EXP belongs to whoever landed the final blow — the orbs
        // home to and can only be collected by the killer.
        if (mp) {
            for (const s of spawns) {
                if (s instanceof ExpOrb) s.ownerPid = killerPid;
            }
        }
        for (const s of spawns) {
            if (s instanceof Scrap) { if (this.scrapEntities.length < 200) { this.scrapEntities.push(s); if (gameplaySpawns) gameplaySpawns.push(s); } }
            else if (s instanceof Rubble || s instanceof ProceduralDebris) { if (this.rubble.length < 250) this.rubble.push(s); }
            else if (s instanceof Asteroid) {
                // Mid-tick spawns won't have _nearPlayer set yet, which would cause
                // projectiles fired this frame to skip them via the broad-phase filter.
                s._nearPlayer = true;
                this.asteroids.push(s);
                if (gameplaySpawns) gameplaySpawns.push(s);
            }
            else if (s instanceof ItemPickup) { this.itemPickups.push(s); if (gameplaySpawns) gameplaySpawns.push(s); this._onItemDropped(s); }
            else if (s instanceof ExpOrb) { if (this.expOrbs.length < 150) { this.expOrbs.push(s); if (gameplaySpawns) gameplaySpawns.push(s); } }
        }

        // Replicate the kill + its loot (multiplayer host).
        if (mp && this.netSync.isHost) {
            this.netSync.onEntityKilled(entity, killerPid, gameplaySpawns);
        }
    }

    // ── Multiplayer helpers ──────────────────────────────────────────────────

    // Every pilot's ship as a targetable "body" (single player: just you).
    getPlayerBodies() {
        return this.netSync ? this.netSync.playerBodies() : [this.player];
    }

    // Enemy scrap drops scale with lobby size (read by getSpawnOnDeath rolls
    // on the host — clients receive the resulting spawns over the wire).
    get netScrapMult() {
        return this.net ? mpScrapMult(this.net.playerCount) : 1.0;
    }

    // Drop an item into space. Single player / host: spawn it (and replicate).
    // Multiplayer client: ask the host to spawn it so EVERY pilot can see and
    // grab it — never a local-only ghost item.
    _dropItemToSpace(item, x, y, vx = null, vy = null, pickupDelay = 0) {
        if (this.netSync && !this.netSync.isHost) {
            this.net.send(MSG.DROP_ITEM, {
                id: item.id, tier: item.tier || 0,
                x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100,
                vx: vx != null ? Math.round(vx * 100) / 100 : null,
                vy: vy != null ? Math.round(vy * 100) / 100 : null,
            });
            return;
        }
        const it = new ItemPickup(this.game, x, y, item, pickupDelay);
        if (vx != null) { it.vx = vx; it.vy = vy; }
        this.itemPickups.push(it);
        if (this.netSync) this.netSync.broadcastSpawns([it]);
    }

    // Route damage from a host-side world check to whichever pilot it hit.
    damagePlayerBody(body, amount, x, y) {
        if (this.netSync) this.netSync.damagePlayerBody(body, amount, x, y);
        else this._damagePlayer(amount, x, y);
    }

    // Local damage to a (possibly replicated) world entity. Returns true if it
    // died — on multiplayer clients that's always false; the host's KILL
    // message is what actually destroys things.
    _routeDamage(ent, amount, hitX, hitY) {
        if (this.netSync) return this.netSync.damageEntity(ent, amount, hitX, hitY);
        return ent.hit(amount);
    }

    _anyBodyNear(x, y, range) {
        if (!this.netSync) {
            const dx = x - this.player.worldX, dy = y - this.player.worldY;
            return dx * dx + dy * dy < range * range;
        }
        for (const b of this.netSync.playerBodies()) {
            const dx = x - b.worldX, dy = y - b.worldY;
            if (dx * dx + dy * dy < range * range) return true;
        }
        return false;
    }

    // Central enemy intake: applies the multiplayer health curve and
    // replicates spawns (host). Use this instead of pushing into this.enemies.
    _addEnemies(arr) {
        if (!arr || !arr.length) return;
        const mpHost = !!this.netSync && this.netSync.isHost;
        for (const en of arr) {
            if (mpHost && this.net.playerCount > 1 && !en._mpScaled) {
                en._mpScaled = true;
                const hm = mpHealthMult(this.net.playerCount);
                en.health = Math.ceil(en.health * hm);
                en.maxHealth = Math.ceil((en.maxHealth || en.health) * hm);
            }
            this.enemies.push(en);
            if (mpHost) this.netSync.registerEnemy(en);
        }
    }

    // Host: run one pilot's asteroid spawner, vetoing rocks that would pop
    // into existence inside another pilot's view bubble ("blob" spawning).
    _mpSpawnAsteroidsFor(dt, spawner, body, mult) {
        const spawned = spawner.update(dt, body.worldX, body.worldY, body.vx || 0, body.vy || 0, mult || 1.0);
        if (!spawned.length) return;
        const NO_SPAWN_R = 1500;
        const bodies = this.netSync.playerBodies();
        for (const ast of spawned) {
            let vetoed = false;
            for (const b of bodies) {
                if (b === body) continue;
                const dx = ast.worldX - b.worldX, dy = ast.worldY - b.worldY;
                if (dx * dx + dy * dy < NO_SPAWN_R * NO_SPAWN_R) { vetoed = true; break; }
            }
            if (vetoed) continue;
            this.asteroids.push(ast);
            this.netSync.registerAsteroid(ast);
        }
    }

    // Per-frame multiplayer upkeep that runs before anything else.
    _netPreFrame(dt) {
        if (this.chatUI) this.chatUI.update(dt);
        if (this._respawnCooldown > 0) this._respawnCooldown -= dt;
        if (!this.net || this.net.state === 'ended') {
            // Session dropped (host left / connection lost) — back to title.
            this.net = null;
            this.netSync = null;
            this.game.setState(new MenuState(this.game));
        }
    }

    // Dead in multiplayer: camera follows the nearest living teammate.
    _updateSpectate(dt) {
        if (!this.netSync) return;
        let target = null, bestD = Infinity;
        for (const rp of this.netSync.remotePlayers.values()) {
            if (!rp._hasState || rp.isDead) continue;
            const dx = rp.worldX - this.camera.x, dy = rp.worldY - this.camera.y;
            const d = dx * dx + dy * dy;
            if (d < bestD) { bestD = d; target = rp; }
        }
        if (target) this.camera.update(dt, target);
    }

    // ── Interactable locks (one pilot per shop/cache/encounter at a time) ──
    _netRequestLock(kind, id, cb) {
        if (!this.netSync) { cb(true); return; }
        if (this.netSync.isHost) {
            cb(this.netSync.tryLock(kind, id, this.netSync.myPid));
            return;
        }
        const key = `${kind}:${id}`;
        if (this._pendingLocks.has(key)) return;
        this._pendingLocks.set(key, cb);
        this.net.send(MSG.LOCK_REQ, { kind, id });
        setTimeout(() => {
            if (this._pendingLocks.get(key) === cb) this._pendingLocks.delete(key);
        }, 4000);
    }

    onLockResult(m) {
        const key = `${m.kind}:${m.id}`;
        const cb = this._pendingLocks.get(key);
        if (cb) {
            this._pendingLocks.delete(key);
            cb(!!m.granted);
        }
    }

    _netReleaseLock(kind, id) {
        if (!this.netSync) return;
        if (this.netSync.isHost) this.netSync.releaseLock(kind, id, this.netSync.myPid);
        else this.net.send(MSG.UNLOCK, { kind, id });
    }

    _netSendCacheState(m) {
        if (!this.netSync) return;
        if (this.netSync.isHost) this.net.broadcast(MSG.CACHE_STATE, m);
        else this.net.send(MSG.CACHE_STATE, m);
    }

    _netSendShopState(shop) {
        if (!this.netSync || shop.netId === undefined) return;
        const m = { idx: shop.netId, inv: shop.inventory.serialize(), perm: { ...shop.permUpgrades } };
        if (this.netSync.isHost) this.net.broadcast(MSG.SHOP_STATE, m);
        else this.net.send(MSG.SHOP_STATE, m);
    }

    // Lock-holder opens a cache: everyone sees the lid fly off.
    _netOpenCache(cache) {
        if (cache.state === CACHE_STATE.OPEN) {
            this._openCacheUI(cache);
        } else if (cache.state === CACHE_STATE.FOUND || cache.state === CACHE_STATE.CLOSED) {
            cache.open();
            this._pendingCache = cache;
            this._netSendCacheState({ nid: cache.netId, action: 'open' });
            if (this.game.achievements) {
                this.game.achievements.notify('cache_opened', { cache });
            }
        }
    }

    // ── Encounter dialog outcome (multiplayer-aware) ────────────────────────
    // The deal goes bad: the transmission tears away, the ship flashes red.
    _hostileTurnFx(enc) {
        this._dialogTear = 0.3;
        enc.hostileFlash = 1.2;
        this.cinematics.spawnRing(enc.worldX, enc.worldY,
            { color: '#ff3333', maxR: 160, dur: 0.5, width: 4 });
        this._spawnSparks(enc.worldX, enc.worldY, 8,
            { color: '#ff5544', speedMin: 100, speedMax: 280 });
        if (this.game.sounds.playStreakTier) this.game.sounds.playStreakTier(0, true);
    }

    _finishEncounterDialog(enc) {
        if (!this.netSync) {
            if (enc.shouldConvertHostile) {
                this._hostileTurnFx(enc);
                this._convertEncounterToEnemy(enc);
            } else if (!enc.shouldStay) {
                enc.depart();
            }
            enc.shouldStay = false;
            return;
        }

        const outcome = enc.shouldConvertHostile ? 'hostile' : (enc.shouldStay ? 'stay' : 'depart');
        const maxScrap = outcome === 'hostile' ? this._encounterMaxScrap(enc.dialogData) : 0;
        const forced = !!(enc.dialogData && enc.dialogData.forced);
        enc.shouldStay = false;

        if (outcome === 'hostile') {
            // Same grace window the SP path grants.
            this.player.invulnTimer = Math.max(this.player.invulnTimer, 1.5);
            this._hostileTurnFx(enc);
        }

        if (this.netSync.isHost) {
            this.netSync.releaseLock('encounter', enc.netId, this.netSync.myPid);
            if (outcome === 'hostile') {
                this._convertEncounterToEnemyNet(enc, maxScrap, forced);
            } else if (outcome === 'depart') {
                enc.depart();
                this.net.broadcast(MSG.ENCOUNTER_OUTCOME, { nid: enc.netId, outcome: 'depart' });
            }
        } else {
            this.net.send(MSG.ENCOUNTER_OUTCOME, { nid: enc.netId, outcome, maxScrap, forced });
        }
    }

    // Wealth scan extracted from _convertEncounterToEnemy so clients can report
    // it to the host (the host never saw the dialog).
    _encounterMaxScrap(dialogData) {
        let maxScrap = 0;
        if (dialogData && dialogData.vars) {
            for (const val of Object.values(dialogData.vars)) {
                if (typeof val === 'number') {
                    maxScrap = Math.max(maxScrap, val);
                } else if (val && typeof val === 'object') {
                    if (val.item && typeof val.item.cost === 'number') maxScrap = Math.max(maxScrap, val.item.cost);
                    else if (typeof val.cost === 'number') maxScrap = Math.max(maxScrap, val.cost);
                    else if (typeof val.offer === 'number') maxScrap = Math.max(maxScrap, val.offer);
                    else if (typeof val.negotiate === 'number') maxScrap = Math.max(maxScrap, val.negotiate);
                }
            }
        }
        return maxScrap;
    }

    // Host-side hostile conversion when any pilot picked a fight (mirrors
    // _convertEncounterToEnemy with the wealth scaling reported over the wire).
    _convertEncounterToEnemyNet(encounter, maxScrap, forced) {
        const en = new HostileEncounter(this.game, encounter.worldX, encounter.worldY, this.difficultyScale, null);
        const wealthBonus = 1.0 + Math.max(0, (maxScrap - 100) / 400);
        en.initEncounterData(encounter.img, encounter.assetKey);

        const curvedDifficultyScale = Math.pow(this.difficultyScale, 0.6);
        const bossBaseHealth = (220 * curvedDifficultyScale) + 70 * this.difficultyScale;
        const healthMult = forced ? 0.45 : 0.9;
        en.health = Math.ceil(bossBaseHealth * healthMult * wealthBonus);
        en.maxHealth = en.health;
        en.speedMult = 1.5 + (wealthBonus - 1) * 0.5;
        en.fireRateMult = 1.8 * wealthBonus;
        en.damageMult = 1.0 * wealthBonus;
        en.isUpgraded = true;
        en.selectedUpgrades = ['bigBall', 'beam', 'multishot'];
        en.weaponCycle = 0;

        this._addEnemies([en]);
        encounter.alive = false;
        if (this.netSync) this.netSync.broadcastDespawn(KIND.ENEMY, [encounter]);

        const targetBody = (encounter.netTargetPid !== undefined && this.netSync.remotePlayers.get(encounter.netTargetPid)) || this.player;
        en.startEvasiveEntry(targetBody, 1.5);
    }

    // ── Trading ─────────────────────────────────────────────────────────────
    onTradeMessage(type, m, fromPid) {
        const pid = m.pid !== undefined ? m.pid : fromPid;
        switch (type) {
            case MSG.TRADE_REQ: {
                if (this.isTradeOpen || this.isShopOpen || this.isCacheOpen || this.isEncounterOpen || this.isDead) return;
                this._tradeRequestFrom = pid;
                this._tradeRequestTimer = 12;
                this.game.sounds.play('click', 0.8);
                break;
            }
            case MSG.TRADE_ACCEPT:
                if (!this.isTradeOpen) this._openTrade(pid);
                break;
            default:
                if (this.tradeUI && this.tradeUI.partnerPid === pid) {
                    this.tradeUI.onMessage(type, m);
                }
        }
    }

    _openTrade(partnerPid) {
        this.tradeUI = new TradeUI(this.game, this, partnerPid);
        this.isTradeOpen = true;
        this._tradeRequestFrom = -1;
        this._tradeButtons = {};
        this.shopScrollX = 0;
        this.shopScrollY = 0;
        this.playerScrollX = 0;
        this.playerScrollY = 0;
        this.game.sounds.play('select', 0.8);
    }

    // ── Trade overlay — built on the same inventory panels the shop uses ────
    _updateTradeUI(dt) {
        const t = this.tradeUI;
        t.update(dt);
        if (t.closed) {
            this.isTradeOpen = false;
            this.tradeUI = null;
            this.paused = false;
            this._releaseGamepadCursor();
            return;
        }

        const theirInv = t.partnerInventory;
        const playerInv = this.player.inventory;
        const theirLayout = this._getInventoryLayout(theirInv, 'shop');
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        const panels = [
            { layout: theirLayout, scrollXKey: 'shopScrollX', scrollYKey: 'shopScrollY', inv: theirInv, panelKey: 'shop' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', inv: playerInv, panelKey: 'player' }
        ];

        // Gamepad focus first so it can snap the virtual cursor onto a slot or
        // button (and handle its own A-press activations) before mouse code.
        this._gamepadTradeUpdate(dt, panels, t);

        // Re-read in case gamepad snapped the virtual cursor.
        const mouse = this.game.getMousePos();
        if (this._applyScrollPanels(dt, mouse, panels)) return;

        if (this.game.input.isMouseJustPressed(0)) {
            // Buttons (accept/decline/scrap) — rects from the last draw.
            for (const [id, r] of Object.entries(this._tradeButtons || {})) {
                if (r && mouse.x >= r.x && mouse.x <= r.x + r.w && mouse.y >= r.y && mouse.y <= r.y + r.h) {
                    if (id === 'accept') t.toggleAccept();
                    else if (id === 'decline') t.cancel();
                    else if (id.startsWith('scrap')) t.adjustScrap(parseInt(id.slice(5), 10) || 0);
                    return;
                }
            }

            // Your grid: toggle offered
            const myCell = this._tradeCellAt(playerLayout, this.playerScrollX, this.playerScrollY, mouse, playerInv);
            if (myCell) {
                const entry = playerInv.getItemAt(myCell.col, myCell.row);
                if (entry) t.toggleOfferEntry(entry);
                return;
            }

            // Their grid: toggle "I want this"
            const theirCell = this._tradeCellAt(theirLayout, this.shopScrollX, this.shopScrollY, mouse, theirInv);
            if (theirCell) {
                const entry = theirInv.getItemAt(theirCell.col, theirCell.row);
                if (entry) t.toggleWantAt(entry.x, entry.y);
                return;
            }
        }

        // Close keys — same set the shop uses.
        const input = this.game.input;
        const closePressed =
            input.isKeyJustPressed('KeyE') ||
            input.isKeyJustPressed('Escape') ||
            input.isGamepadJustPressed(GP.B) ||
            input.isGamepadJustPressed(GP.BACK) ||
            input.isGamepadJustPressed(GP.START);
        if (closePressed) {
            t.cancel();
        }
    }

    _tradeCellAt(layout, scrollX, scrollY, mouse, inv) {
        if (mouse.x < layout.gridVisX || mouse.x >= layout.gridVisX + layout.visW) return null;
        if (mouse.y < layout.gridVisY || mouse.y >= layout.gridVisY + layout.visH) return null;
        const col = Math.floor((mouse.x - layout.gridVisX + scrollX) / layout.slotSize);
        const row = Math.floor((mouse.y - layout.gridVisY + scrollY) / layout.slotSize);
        if (col < 0 || row < 0 || col >= inv.cols || row >= inv.rows) return null;
        return { col, row };
    }

    // Gamepad navigation for the trade overlay. Unlike the shop/cache grids
    // (which pick up and drag items), trade slots TOGGLE an offer/want on A and
    // the accept/decline/scrap controls are plain buttons — so this is a
    // trimmed cousin of _gamepadInventoryUpdate: snap-navigate the focusables,
    // A toggles or activates, no drag mode.
    _gamepadTradeUpdate(dt, panels, t) {
        const input = this.game.input;
        if (!input.gamepadConnected) {
            input.setGamepadCursorEnabled(false);
            return;
        }
        // Snap mode only — the trade UI never drags, so the smooth cursor stays off.
        input.setGamepadCursorEnabled(false);
        if (!input.isGamepadActive()) {
            this._gpFocusablesCache = null;
            return;
        }

        // The trade controls drawn last frame become focusable buttons.
        const extraButtons = [];
        const btn = this._tradeButtons || {};
        const addBtn = (id, onActivate) => {
            const r = btn[id];
            if (r) extraButtons.push({ id, rect: r, onActivate });
        };
        addBtn('accept', () => t.toggleAccept());
        addBtn('decline', () => t.cancel());
        for (const step of [1, 10, 100]) {
            addBtn(`scrap${step}`, () => t.adjustScrap(step));
            addBtn(`scrap-${step}`, () => t.adjustScrap(-step));
        }

        const focusables = this._buildFocusables(panels, extraButtons);
        this._gpFocusablesCache = focusables;
        if (focusables.length === 0) return;

        const fallbackPanel = panels[0] && panels[0].layout;
        const fbX = fallbackPanel ? fallbackPanel.gridVisX + fallbackPanel.visW / 2 : 0;
        const fbY = fallbackPanel ? fallbackPanel.gridVisY + fallbackPanel.visH / 2 : 0;
        let idx = this._resolveFocusIndex(focusables, fbX, fbY);

        const stepFocus = (dx, dy) => {
            const next = this._stepFocusSpatial(focusables, idx, dx, dy);
            if (next !== idx) { idx = next; this.game.sounds.play('click', 0.4); }
        };

        // Same hold-to-repeat directional stepping the inventory grids use.
        let dx = 0, dy = 0;
        if (input.isGamepadDown(GP.DRIGHT)) dx += 1;
        if (input.isGamepadDown(GP.DLEFT))  dx -= 1;
        if (input.isGamepadDown(GP.DDOWN))  dy += 1;
        if (input.isGamepadDown(GP.DUP))    dy -= 1;
        if (dx === 0 && dy === 0) {
            const lx = input.leftStickX;
            const ly = input.leftStickY;
            if (Math.abs(lx) > 0.5 || Math.abs(ly) > 0.5) {
                if (Math.abs(lx) > Math.abs(ly)) dx = lx > 0 ? 1 : -1;
                else                             dy = ly > 0 ? 1 : -1;
            }
        }
        const dirChanged = dx !== this._gpHeldDx || dy !== this._gpHeldDy;
        if (dirChanged) {
            this._gpHeldDx = dx;
            this._gpHeldDy = dy;
            this._gpHeldTime = 0;
            if (dx !== 0 || dy !== 0) { stepFocus(dx, dy); this._gpRepeatDelay = 0.35; }
        } else if (dx !== 0 || dy !== 0) {
            this._gpHeldTime = (this._gpHeldTime || 0) + dt;
            this._gpRepeatDelay -= dt;
            if (this._gpRepeatDelay <= 0) {
                stepFocus(dx, dy);
                this._gpRepeatDelay = Math.max(0.055, 0.11 - this._gpHeldTime * 0.04);
            }
        }

        const focused = focusables[idx];
        this._recordFocus(focused);

        // Snap the virtual mouse onto the focus so hover/tooltip code lights up.
        input.mouseScreenX = focused.rect.x + focused.rect.w / 2;
        input.mouseScreenY = focused.rect.y + focused.rect.h / 2;

        // A activates a button, or toggles offer (your grid) / want (theirs).
        if (input.isGamepadJustPressed(GP.A)) {
            if (focused.kind === 'button' && typeof focused.onActivate === 'function') {
                focused.onActivate();
            } else if (focused.kind === 'slot') {
                if (focused.panelKey === 'player') {
                    const entry = this.player.inventory.getItemAt(focused.col, focused.row);
                    if (entry) t.toggleOfferEntry(entry);
                } else {
                    const entry = t.partnerInventory.getItemAt(focused.col, focused.row);
                    if (entry) t.toggleWantAt(entry.x, entry.y);
                }
            }
        }
    }

    _drawTradeOverlay(ctx) {
        const t = this.tradeUI;
        if (!t) return;
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;
        this._tradeButtons = {};

        const theirInv = t.partnerInventory;
        const playerInv = this.player.inventory;
        const theirLayout = this._getInventoryLayout(theirInv, 'shop');
        const playerLayout = this._getInventoryLayout(playerInv, 'player');
        const partnerColor = playerColor(t.partnerPid);
        const myColor = playerColor(this.netSync ? this.netSync.myPid : 0);

        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.82)';
        ctx.fillRect(0, 0, cw, ch);

        // ── Partner cargo panel (top — where the shop's stock goes) ─────────
        this._draw9Slice(ctx, this.inventoryImg, theirLayout.panelX, theirLayout.panelY, theirLayout.totalW, theirLayout.totalH);
        ctx.fillStyle = partnerColor;
        ctx.font = `${8 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(`${t.partnerName.toUpperCase()}'S CARGO`, cw / 2, theirLayout.panelY - uiScale * 10);
        this._drawInventoryGrid(ctx, theirInv, theirLayout, this.shopScrollX, this.shopScrollY);
        this._drawTradeHighlights(ctx, theirInv, theirLayout, this.shopScrollX, this.shopScrollY,
            (entry) => t.partnerOffered.has(`${entry.x},${entry.y}`),
            (entry) => t.wants.has(`${entry.x},${entry.y}`));
        this._draw9Slice(ctx, this.inventoryBorderImg, theirLayout.panelX, theirLayout.panelY, theirLayout.totalW, theirLayout.totalH);
        this._drawScrollbars(ctx, theirLayout, this.shopScrollX, this.shopScrollY);

        // Partner's scrap offer + status — right of their panel (clear of the
        // scrollbar track, which sits at totalW + 8..16·uiScale).
        const theirSideX = theirLayout.panelX + theirLayout.totalW + uiScale * 20;
        ctx.textAlign = 'left';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.fillStyle = '#ffff66';
        ctx.fillText(`OFFERS ${t.partnerScrap} SCRAP`, theirSideX, theirLayout.panelY + uiScale * 10);
        ctx.fillStyle = t.partnerLocked ? '#44ff88' : '#667788';
        ctx.fillText(t.partnerLocked ? 'ACCEPTED ✓' : 'CHOOSING...', theirSideX, theirLayout.panelY + uiScale * 19);

        // ── Middle bar: accept / decline between the two panels ─────────────
        const midTop = theirLayout.panelY + theirLayout.totalH;
        const midBottom = playerLayout.panelY;
        const midY = Math.floor((midTop + midBottom) / 2);
        const btnW = Math.floor(uiScale * 56);
        const btnH = Math.floor(uiScale * 14);
        this._tradeButtons.accept = { x: Math.floor(cw / 2 - btnW - uiScale * 6), y: Math.floor(midY - btnH / 2), w: btnW, h: btnH };
        this._tradeButtons.decline = { x: Math.floor(cw / 2 + uiScale * 6), y: Math.floor(midY - btnH / 2), w: btnW, h: btnH };
        this._drawTradeButton(ctx, this._tradeButtons.accept, t.locked ? 'ACCEPTED' : 'ACCEPT',
            t.locked ? '#44ff88' : '#9fe8ff', t.locked ? 'rgba(20, 60, 35, 0.95)' : 'rgba(10, 28, 40, 0.95)');
        this._drawTradeButton(ctx, this._tradeButtons.decline, 'DECLINE', '#ff8866', 'rgba(50, 16, 12, 0.95)');

        // ── Your cargo panel (bottom — same place the shop puts it) ─────────
        this._draw9Slice(ctx, this.inventoryImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        ctx.fillStyle = myColor;
        ctx.font = `${8 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.fillText('YOUR CARGO', cw / 2, playerLayout.panelY - uiScale * 10);
        this._drawInventoryGrid(ctx, playerInv, playerLayout, this.playerScrollX, this.playerScrollY);
        this._drawTradeHighlights(ctx, playerInv, playerLayout, this.playerScrollX, this.playerScrollY,
            (entry) => t.offered.has(entry),
            (entry) => t.partnerWants.has(`${entry.x},${entry.y}`));
        this._draw9Slice(ctx, this.inventoryBorderImg, playerLayout.panelX, playerLayout.panelY, playerLayout.totalW, playerLayout.totalH);
        this._drawScrollbars(ctx, playerLayout, this.playerScrollX, this.playerScrollY);

        // ── Scrap offer controls — right of your panel ───────────────────────
        // Offset clears the vertical scrollbar track (totalW + 8..16·uiScale)
        // so it doesn't get bumped on scrollable inventories.
        const scX = playerLayout.panelX + playerLayout.totalW + uiScale * 20;
        let scY = playerLayout.panelY + uiScale * 4;
        ctx.textAlign = 'left';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.fillStyle = '#8899aa';
        ctx.fillText('OFFER SCRAP', scX, scY + uiScale * 5);
        scY += uiScale * 9;
        ctx.font = `${9 * uiScale}px Astro5x`;
        ctx.fillStyle = '#ffff66';
        ctx.fillText(`${t.scrapOffer}`, scX, scY + uiScale * 9);
        scY += uiScale * 13;

        const sBtnW = Math.floor(uiScale * 22);
        const sBtnH = Math.floor(uiScale * 10);
        const sGap = Math.floor(uiScale * 2);
        const steps = [1, 10, 100];
        for (let i = 0; i < steps.length; i++) {
            const rowY = scY + i * (sBtnH + sGap);
            this._tradeButtons[`scrap${steps[i]}`] = { x: scX, y: rowY, w: sBtnW, h: sBtnH };
            this._tradeButtons[`scrap-${steps[i]}`] = { x: scX + sBtnW + sGap, y: rowY, w: sBtnW, h: sBtnH };
            this._drawTradeButton(ctx, this._tradeButtons[`scrap${steps[i]}`], `+${steps[i]}`, '#9fe8ff', 'rgba(10, 28, 40, 0.95)');
            this._drawTradeButton(ctx, this._tradeButtons[`scrap-${steps[i]}`], `-${steps[i]}`, '#8899aa', 'rgba(14, 20, 30, 0.95)');
        }
        scY += steps.length * (sBtnH + sGap) + uiScale * 6;
        ctx.font = `${5 * uiScale}px Astro4x`;
        ctx.fillStyle = '#667788';
        ctx.fillText(`SCRAP: ${Math.floor(this.player.scrap)}`, scX, scY);

        // ── Hints + tooltips ─────────────────────────────────────────────────
        ctx.fillStyle = '#667788';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        const hint = this.game.input.isGamepadActive()
            ? '(A) offer your items / ask for theirs  •  (B) to cancel'
            : 'Click your items to offer  •  click theirs to ask  •  E to cancel';
        ctx.fillText(hint, cw / 2, ch - uiScale * 10);

        this._drawInventoryTooltip(ctx, [
            { inv: theirInv, layout: theirLayout, scrollX: this.shopScrollX, scrollY: this.shopScrollY },
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

        // Gamepad focus corners (slots + accept/decline/scrap buttons).
        this._drawGamepadSelection(ctx, [
            { layout: theirLayout, scrollXKey: 'shopScrollX', scrollYKey: 'shopScrollY', inv: theirInv, panelKey: 'shop' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', inv: playerInv, panelKey: 'player' }
        ]);

        ctx.restore();
    }

    // Offer/want overlays painted over a grid: cyan = changing hands,
    // pulsing yellow = requested by the other pilot.
    _drawTradeHighlights(ctx, inv, layout, scrollX, scrollY, isOffered, isWanted) {
        const { gridVisX: startX, gridVisY: startY, visW, visH, slotSize } = layout;
        const t = this.tradeUI;
        ctx.save();
        ctx.beginPath();
        ctx.rect(startX, startY, visW, visH);
        ctx.clip();
        for (const entry of inv.items) {
            const x = startX + entry.x * slotSize - scrollX;
            const y = startY + entry.y * slotSize - scrollY;
            const w = entry.item.width * slotSize;
            const h = entry.item.height * slotSize;
            if (x + w < startX || x > startX + visW || y + h < startY || y > startY + visH) continue;

            if (isOffered(entry)) {
                ctx.fillStyle = 'rgba(68, 221, 255, 0.20)';
                ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
                ctx.strokeStyle = '#44ddff';
                ctx.lineWidth = 2;
                ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
            }
            if (isWanted(entry)) {
                const pulse = 0.55 + 0.45 * Math.sin(t.glowTimer * 6);
                ctx.save();
                ctx.globalAlpha = pulse;
                ctx.strokeStyle = '#ffdd44';
                ctx.lineWidth = 2;
                ctx.strokeRect(x + 3.5, y + 3.5, w - 7, h - 7);
                ctx.restore();
            }
        }
        ctx.restore();
    }

    _drawTradeButton(ctx, rect, label, color, bg) {
        const uiScale = this.game.uiScale;
        ctx.fillStyle = bg;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
        ctx.fillStyle = color;
        ctx.font = `${Math.floor(6 * uiScale)}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, rect.x + rect.w / 2, rect.y + rect.h / 2 + 1);
        ctx.textBaseline = 'alphabetic';
    }

    // Picks which inventory entries are lost when a ship is destroyed on respawn.
    // You keep everything else — only common/uncommon/rare items can ever be lost
    // (epic and above always survive), and the number lost scales with how long
    // this life lasted: nothing under 2 minutes, 0–1 items past 2 minutes, 1–3 past 5.
    _rollLostItems(items, survivedSec) {
        let count;
        if (survivedSec >= 300) {
            count = 1 + Math.floor(Math.random() * 3); // 1–3
        } else if (survivedSec >= 120) {
            count = Math.floor(Math.random() * 2);      // 0–1
        } else {
            return [];                                  // died quickly — lose no items
        }
        if (count <= 0) return [];

        // Only items below epic on the tier ladder are at risk.
        const eligible = items.filter(entry => entry.item && itemTier(entry.item) < rarityToTier('epic'));

        // Fisher–Yates shuffle, then take up to `count`.
        for (let i = eligible.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
        }
        return eligible.slice(0, count);
    }

    // ── Respawn (multiplayer): a fresh ship in the same shared world ────────
    _netRespawn() {
        const game = this.game;

        // Death penalty: lose half your scrap and a few low-rarity items, but
        // keep everything else (the whole rest of your inventory carries over).
        const prevItems = (this.player && this.player.inventory) ? this.player.inventory.items.slice() : [];
        const prevScrap = this.player ? this.player.scrap : 0;
        const retainedScrap = Math.floor(prevScrap * 0.5);
        const lostItems = this._rollLostItems(prevItems, this.trueTotalTime);
        const lostSet = new Set(lostItems);
        const keptEntries = prevItems.filter(entry => !lostSet.has(entry));

        this.player = new Player(game, this.shipData);
        this.player.inventory = new Inventory(this.shipData.storage.cols, this.shipData.storage.rows);
        this.player.inventory.isPlayerInventory = true;
        this.player.inventory.playingState = this;
        this.inventoryCols = this.shipData.storage.cols;
        this.inventoryRows = this.shipData.storage.rows;
        this.encounterBonuses = { speedMult: 1.0, fireRateMult: 1.0, turnMult: 1.0 };
        this.levelUpQueue = [];
        this.isLevelUpOpen = false;
        this.activeLevelUpDialog = null;
        this._levelUpRolls = {};
        this.levelUpSkipsRemaining = this.LEVELUP_MAX_SKIPS;
        this.pendingLevelUpMult = 1;
        this.fovUpgradeMult = 1.0;

        // Fresh personal run stats (the shared world keeps going).
        this.stats = {
            asteroidsDestroyed: 0, enemiesDefeated: 0, wavesCleared: 0,
            scrapCollected: 0, shopsUnlocked: 1, eventsDiscovered: 0,
        };
        this.trueTotalTime = 0;

        // Spawn near a living teammate (or back at the origin).
        let anchor = null;
        for (const rp of this.netSync.remotePlayers.values()) {
            if (rp._hasState && !rp.isDead) { anchor = rp; break; }
        }
        const angle = Math.random() * Math.PI * 2;
        this.player.worldX = (anchor ? anchor.worldX : 0) + Math.cos(angle) * 300;
        this.player.worldY = (anchor ? anchor.worldY : 0) + Math.sin(angle) * 300;
        this.player.invulnTimer = 2.5;

        this.isDead = false;
        this.showDeathScreen = false;
        this.deathTimer = 0;
        this.shipDebris = [];
        this.hud = new HUD(game, this.player);
        this.camera.snapTo(this.player);

        // Carry the surviving inventory over to the fresh ship, keeping each
        // item in its original slot (same ship type → same grid, so it fits).
        this.player.scrap = retainedScrap;
        for (const entry of keptEntries) {
            this.player.inventory.addItem(entry.item, entry.x, entry.y);
        }

        // Tell the player what the wreck cost them.
        const scrapLost = prevScrap - retainedScrap;
        const parts = [];
        if (scrapLost > 0) parts.push(`${scrapLost} SCRAP`);
        if (lostItems.length > 0) parts.push(`${lostItems.length} ITEM${lostItems.length > 1 ? 'S' : ''}`);
        if (parts.length > 0) {
            this.spawnFloatingText(this.player.worldX, this.player.worldY - 24, `LOST ${parts.join(' + ')}`, '#ff6644');
        }

        this._onInventoryChanged();
        if (game.achievements) game.achievements.notify('run_started');

        if (this.netSync.isHost) {
            const info = this.net.players.get(0);
            if (info) info.alive = true;
            this.net.broadcast(MSG.PLAYER_RESPAWN, { pid: 0, shipId: this.shipData.id });
        } else {
            this.net.send(MSG.PLAYER_RESPAWN, { shipId: this.shipData.id });
        }
        this.game.sounds.startMusic();
    }

    _damagePlayer(amount, hitX, hitY) {
        if (this.player.invulnTimer > 0 || this.isDead || this.bossDeathImmunityTimer > 0) return;

        // Cap damage at 1/5th of max health per instance
        const finalAmount = Math.min(amount, this.player.maxHealth / 5);

        if (this.game.achievements) {
            this.game.achievements.notify('player_damaged', {
                amount: finalAmount,
                shielded: !!this.player.shielding
            });
        }

        if (this.player.shielding) {
            this.spawnFloatingText(this.player.worldX, this.player.worldY, `-${Math.ceil(finalAmount)}`, '#44ddff');
            this.player.shieldEnergy -= finalAmount * 5;
            // Ripple flare on the bubble rim at the impact angle
            if (hitX !== undefined && this.shieldRipples.length < 6) {
                this.shieldRipples.push({
                    angle: Math.atan2(hitY - this.player.worldY, hitX - this.player.worldX),
                    t: 0
                });
            }
            if (this.player.shieldEnergy <= 0) {
                this.player.shieldEnergy = 0;
                this.player.shieldBroken = true;
                this.player.shielding = false;
                this.camera.shake(3.0, 8.0); // Big impact for shield break
                this.game.sounds.play('shield_break', { volume: 0.7, x: this.player.worldX, y: this.player.worldY });
                // The bubble shatters: shard burst + ring sized to the bubble
                this.shieldRipples.length = 0;
                this._spawnSparks(this.player.worldX, this.player.worldY, 14,
                    { color: '#44ddff', speedMin: 160, speedMax: 420 });
                this.cinematics.spawnRing(this.player.worldX, this.player.worldY,
                    { color: '#44ddff', maxR: Math.round(this.player.shieldRadius * 1.25), dur: 0.4, width: 4 });
            } else {
                this.camera.shake(0.4, 15.0); // Subtle hit feedback
                this.game.sounds.play('asteroid_break', { volume: 0.3, x: this.player.worldX, y: this.player.worldY }); // Shield hit sound
            }
        } else {
            this.spawnFloatingText(this.player.worldX, this.player.worldY, `-${Math.ceil(finalAmount)}`, '#ff4444');
            // Overheal soaks damage before normal health.
            let dmgRemaining = finalAmount;
            if (this.player.overheal > 0) {
                const absorbed = Math.min(this.player.overheal, dmgRemaining);
                this.player.overheal -= absorbed;
                dmgRemaining -= absorbed;
            }
            this.player.health -= dmgRemaining;
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
            // Run seed + per-domain stream states so a resumed run continues
            // deterministically (see deserialize, which restores these last).
            runSeed: this.runSeed,
            rng: this.rng.serialize(),
            totalGameTime: this.totalGameTime,
            trueTotalTime: this.trueTotalTime,
            difficultyScale: this.difficultyScale,
            stats: { ...this.stats },
            waveTimer: this.waveTimer,
            lastCrashWave: this._lastCrashWave,
            crashCacheTimer: this._crashCacheTimer,
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
            levelUpSkipsRemaining: this.levelUpSkipsRemaining,
            pendingLevelUpMult: this.pendingLevelUpMult,
            playerDistanceTraveled: this.playerDistanceTraveled,
            expOrbs: this.expOrbs.map(orb => orb.serialize())
        };
    }

    async deserialize(data) {
        // Restore the run seed; stream STATES are restored at the very end of
        // this method (after all entity reconstruction) so the throwaway draws
        // entity constructors make during rebuild don't corrupt the streams.
        if (data.runSeed != null) this.runSeed = data.runSeed;
        this.game.rng = this.rng;

        this.totalGameTime = data.totalGameTime;
        this.trueTotalTime = data.trueTotalTime || 0;
        this.difficultyScale = data.difficultyScale;
        this.stats = { ...data.stats };
        this.waveTimer = data.waveTimer;
        this._lastCrashWave = data.lastCrashWave || 0;
        this._crashCacheTimer = data.crashCacheTimer || 0;

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
                    if (evData.type === 'KnowledgeEvent') {
                        ev.isFinished = evData.isFinished || false;
                        // Belt-and-suspenders: derive from state in case an older
                        // save was written before isFinished was persisted, so
                        // the signal indicator + radar dot stay hidden.
                        if (ev.state === KNOWLEDGE_STATE.DEFEATED || ev.state === KNOWLEDGE_STATE.FINISHED) {
                            ev.isFinished = true;
                            ev.acceptsItems = false;
                            ev.acceptsEnemies = false;
                        }
                    }
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

        // Reseed the achievement run-set from already-discovered events.
        // Without this, save/load wipes run.eventsDiscovered (it lives only in
        // memory) while events keep `discovered=true`, so the discovery
        // detector never re-notifies and Cartographer can never trigger after
        // a load.
        if (this.game.achievements) {
            const runSet = this.game.achievements.run.eventsDiscovered;
            for (const ev of this.events) {
                if (ev.discovered) runSet.add(ev.constructor.name);
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
            // Restore the saved content seed so this asteroid's loot reproduces
            // (overrides the throwaway seed drawn by the constructor above).
            if (aData.contentSeed != null) {
                ast.contentSeed = aData.contentSeed;
                ast.contentRng = new RNG(aData.contentSeed);
            }
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
        this._levelUpRolls = {};
        this.levelUpSkipsRemaining = data.levelUpSkipsRemaining != null
            ? data.levelUpSkipsRemaining
            : this.LEVELUP_MAX_SKIPS;
        this.pendingLevelUpMult = data.pendingLevelUpMult != null
            ? data.pendingLevelUpMult
            : 1;

        // Restore encounter bonuses
        if (data.encounterBonuses) this.encounterBonuses = { ...data.encounterBonuses };
        if (data.playerDistanceTraveled) this.playerDistanceTraveled = data.playerDistanceTraveled;

        // Reset camera
        this.camera.snapTo(this.player);

        // Recalculate all stats and multipliers based on loaded inventory
        this._onInventoryChanged();

        // Restore RNG stream states LAST — every entity reconstructed above drew
        // a throwaway content seed from its domain stream during construction;
        // overwriting the stream states here neutralizes those draws so future
        // spawns continue deterministically from where the save left off.
        if (data.rng) this.rng.deserialize(data.rng);
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

    // Burst of short, bright spark streaks at an impact point. `opts.dir` aims
    // the spray (radians); `opts.spread` widens it; `opts.color` tints it.
    _spawnSparks(x, y, count = 6, opts = {}) {
        const _spk = this.sparks.length;
        if (_spk > 350) return; // hard cap so spam fire can't pile up
        // Particle LOD: thin auxiliary sparks once the field is already busy, so a
        // chaotic wave doesn't keep spawning hundreds of streaks per frame. Below
        // ~120 live sparks (normal play / light combat) this never triggers, so
        // the effect is visually unchanged outside heavy pile-ups.
        if (_spk > 220) count = Math.max(1, count >> 2);
        else if (_spk > 120) count = Math.max(1, count >> 1);
        const dir = opts.dir != null ? opts.dir : Math.random() * Math.PI * 2;
        const spread = opts.spread != null ? opts.spread : Math.PI * 2;
        const color = opts.color || '#ffe08a';
        const sMin = opts.speedMin != null ? opts.speedMin : 140;
        const sMax = opts.speedMax != null ? opts.speedMax : 420;
        const lMin = opts.lifeMin != null ? opts.lifeMin : 0.12;
        const lMax = opts.lifeMax != null ? opts.lifeMax : 0.30;
        for (let i = 0; i < count; i++) {
            const a = dir + (Math.random() - 0.5) * spread;
            const sp = sMin + Math.random() * (sMax - sMin);
            const life = lMin + Math.random() * (lMax - lMin);
            this.sparks.push({
                worldX: x, worldY: y,
                vx: Math.cos(a) * sp,
                vy: Math.sin(a) * sp,
                life, maxLife: life,
                size: Math.random() < 0.7 ? 1 : 2, // chunk size in logical pixels
                color
            });
        }
    }

    spawnFloatingText(x, y, text, color) {
        this.floatingTexts.push(new FloatingText(this.game, x, y, text, color));
    }

    // Boost/blink ready: energy motes materialize around the ship and get
    // pulled into the hull. Positions are ship-relative (angle + shrinking
    // distance), so the effect tracks the ship at any speed.
    _spawnReadyAbsorb() {
        if (this.readyAbsorb.length > 40) return;
        for (let i = 0; i < 14; i++) {
            this.readyAbsorb.push({
                angle: Math.random() * Math.PI * 2,
                dist: 55 + Math.random() * 35,
                speed: 110 + Math.random() * 70,
                delay: Math.random() * 0.18
            });
        }
    }

    _drawReadyAbsorb(ctx) {
        if (this.readyAbsorb.length === 0) return;
        const cam = this.camera;
        const ws = this.game.worldScale;
        const px = this.player.worldX * cam.wtsScale + cam.wtsOffX;
        const py = this.player.worldY * cam.wtsScale + cam.wtsOffY;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const p of this.readyAbsorb) {
            if (p.delay > 0) continue;
            const cosA = Math.cos(p.angle), sinA = Math.sin(p.angle);
            const sx = px + cosA * p.dist * ws;
            const sy = py + sinA * p.dist * ws;
            // Brighter and slightly streakier as it closes in
            const closeness = 1 - p.dist / 90;
            ctx.globalAlpha = 0.35 + closeness * 0.6;
            ctx.fillStyle = '#7fd4ff';
            const s = Math.max(1, Math.round(ws * (1 + closeness)));
            ctx.fillRect(Math.round(sx - s / 2), Math.round(sy - s / 2), s, s);
            // Inward motion streak
            ctx.strokeStyle = '#5ab8e8';
            ctx.lineWidth = Math.max(1, ws * 0.5);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + cosA * 6 * ws * closeness, sy + sinA * 6 * ws * closeness);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Brief additive glint at a gun point when it fires.
    _addMuzzleFlash(x, y, angle) {
        if (this.muzzleFlashes.length > 24) this.muzzleFlashes.shift();
        this.muzzleFlashes.push({ x, y, angle, t: 0.07 });
    }

    _drawMuzzleFlashes(ctx) {
        if (this.muzzleFlashes.length === 0) return;
        const cam = this.camera;
        const ws = this.game.worldScale;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const m of this.muzzleFlashes) {
            const sx = m.x * cam.wtsScale + cam.wtsOffX;
            const sy = m.y * cam.wtsScale + cam.wtsOffY;
            const f = m.t / 0.07;
            ctx.globalAlpha = f * 0.9;
            ctx.fillStyle = '#cfeaff';
            const core = Math.max(2, Math.round(3 * ws * f));
            ctx.fillRect(Math.round(sx - core / 2), Math.round(sy - core / 2), core, core);
            // Short spike along the firing direction
            ctx.strokeStyle = '#9fdcff';
            ctx.lineWidth = Math.max(1, ws * f);
            ctx.beginPath();
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx + Math.cos(m.angle) * 9 * ws * f, sy + Math.sin(m.angle) * 9 * ws * f);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Cyan ion ribbon trailing the ship while boosting — same trail-history
    // technique as the comets, drawn under the ship.
    _drawBoostTrail(ctx) {
        const n = this.boostTrail.length / 2;
        if (n < 2) return;
        const cam = this.camera;
        const ws = this.game.worldScale;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.strokeStyle = '#5ab8e8';
        for (let k = 0; k < n - 1; k++) {
            const f = k / (n - 1); // 0 = oldest
            const x0 = this.boostTrail[k * 2] * cam.wtsScale + cam.wtsOffX;
            const y0 = this.boostTrail[k * 2 + 1] * cam.wtsScale + cam.wtsOffY;
            const x1 = this.boostTrail[k * 2 + 2] * cam.wtsScale + cam.wtsOffX;
            const y1 = this.boostTrail[k * 2 + 3] * cam.wtsScale + cam.wtsOffY;
            ctx.globalAlpha = f * 0.5;
            ctx.lineWidth = Math.max(1, 4 * ws * f);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }
        ctx.restore();
    }

    // Regen sweep glint. (Shield impacts distort the bubble itself — drawn
    // inside Player.draw — rather than overlaying arcs here.)
    _drawShieldFx(ctx) {
        if (this.shieldGlint <= 0) return;
        const cam = this.camera;
        const ws = this.game.worldScale;
        const sx = this.player.worldX * cam.wtsScale + cam.wtsOffX;
        const sy = this.player.worldY * cam.wtsScale + cam.wtsOffY;
        const r = this.player.shieldRadius * ws;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = '#44ddff';
        ctx.lineCap = 'round';
        if (this.shieldGlint > 0) {
            // One quick sweep around the bubble as the shield returns
            const p = 1 - this.shieldGlint / 0.15;
            const a = -Math.PI / 2 + p * Math.PI * 2;
            ctx.globalAlpha = Math.sin(p * Math.PI) * 0.8;
            ctx.lineWidth = Math.max(1, 2 * ws);
            ctx.beginPath();
            ctx.arc(sx, sy, r, a - 0.5, a + 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }

    draw(ctx) {
        ctx.textBaseline = 'alphabetic';

        // --- World / starfield ---
        this.perf.begin('world');
        this.world.draw(ctx, this.camera, this.player, this.totalGameTime);
        // Backdrop stack, deepest first: the Eye, then sector weather/sky
        // events, then the nearer dread moments (void patches, ghost ships).
        this.dread.drawEye(ctx);
        this.ambience.draw(ctx, this.camera);
        this.dread.drawBackground(ctx);
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
            // Cull off-screen enemy sprites (they show as off-screen indicators,
            // not sprites). Beams/targeting lines extend far past the hull, so a
            // beaming enemy is never culled — keeps the visual identical.
            const dx = e.worldX - camX, dy = e.worldY - camY;
            if ((dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                || e.isTargeting || (e.activeBeams && e.activeBeams.length))
                e.draw(ctx, this.camera);
        }
        for (const enc of this.encounters) {
            enc.draw(ctx, this.camera); // Encounters are few
        }
        this.perf.end('enemies');

        // --- Other pilots (multiplayer) ---
        if (this.netSync) {
            this.netSync.drawRemotePlayers(ctx, this.camera);
        }

        // --- Projectiles draw ---
        // Cull off-screen projectiles: each renders a multi-quad trail + glow
        // (the heaviest draw in a busy frame) yet most are mid-flight off-screen.
        // The trail only reaches a frame or two behind the head, so the standard
        // draw margin covers it — culled projectiles produce no visible pixels.
        // Set the additive 'screen' blend ONCE for the whole batch (each shot's
        // body assumes it) instead of one composite-op change per projectile.
        this.perf.begin('projectiles');
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        for (const p of this.projectiles) {
            const dx = p.worldX - camX, dy = p.worldY - camY;
            if (dx > -drawCullX && dx < drawCullX && dy > -drawCullY && dy < drawCullY)
                p._drawBody(ctx, this.camera);
        }
        ctx.restore();
        this.perf.end('projectiles');

        // --- Railgun Visuals ---
        // (Also drawn without a local railgun so teammates' replicated beam
        // flashes are visible in multiplayer.)
        if (this.player.hasRailgun || (this.activeBeams && this.activeBeams.length)) {
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

            // Multiplayer: chat keeps working while dead/spectating.
            if (this.chatUI) this.chatUI.draw(ctx, this.hud ? this.hud.shieldBarTopY : null);

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
        this._drawBoostTrail(ctx);
        this._drawReadyAbsorb(ctx);
        // Multiplayer: your own ship wears your pilot color too.
        if (this.netSync && !this.player.isWarping) {
            drawShipOutline(ctx, this.game, this.camera, this.player.stillImg, this.shipData.id,
                playerColor(this.netSync.myPid), this.player.worldX, this.player.worldY, this.player.angle);
        }
        this.player.draw(ctx, this.camera);
        this._drawShieldFx(ctx);
        this._drawMuzzleFlashes(ctx);
        this.perf.end('player');

        if ((this.canInteractShop || this.canInteractEncounter || this.canInteractCache || this.canInteractPlayer) && !this.isShopOpen && !this.isEncounterOpen && !this.isCacheOpen && !this.isTradeOpen) {
            this._drawInteractPrompt(ctx);
        }

        // Explosions (drawn above most things, below UI)
        this.perf.begin('particles');
        this._drawExplosions(ctx);
        this._drawSparks(ctx);
        this.cinematics.drawWorld(ctx, this.camera);
        this.killStreak.drawWorld(ctx, this.camera);

        // Draw floating texts
        for (const ft of this.floatingTexts) {
            ft.draw(ctx, this.camera);
        }
        this.perf.end('particles');

        // Hide HUD and all indicators during Yellow One cutscene
        if (!this.yellowOneScriptActive) {
            // Streak vignette + counter sit under the HUD elements
            this.killStreak.drawOverlay(ctx);
            this.dread.drawOverlay(ctx);
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

            // --- Teammate Indicators (multiplayer) ---
            if (this.netSync) {
                this._drawPlayerIndicators(ctx);
            }
        }

        if (this.isLevelUpOpen && this.activeLevelUpDialog) {
            this.activeLevelUpDialog.draw(ctx);
        } else if (this.isEncounterOpen && this.activeEncounterDialog) {
            this.activeEncounterDialog.draw(ctx);
        } else if (this.isCacheOpen && this.activeCacheUI) {
            this._drawCacheOverlay(ctx);
        } else if (this.isShopOpen) {
            this._drawShopOverlay(ctx);
        } else if (this.isTradeOpen && this.tradeUI) {
            this._drawTradeOverlay(ctx);
        } else if (this.paused) {
            this._drawPauseOverlay(ctx);
        }

        // Combine fanfare — above the inventory dialogs it happens inside
        this._drawCombineFx(ctx);

        // Transmission tear: the dialog rips away in static when a deal turns
        // hostile (drawn where the panel was for a few frames)
        if (this._dialogTear > 0) {
            const f = this._dialogTear / 0.3;
            const pw = Math.min(this.game.width * 0.6, 160 * this.game.uiScale);
            const px = (this.game.width - pw) / 2;
            const pt = this.game.height * 0.2;
            const ph = this.game.height * 0.35;
            ctx.save();
            for (let i = 0; i < 8; i++) {
                ctx.globalAlpha = f * (0.2 + Math.random() * 0.4);
                ctx.fillStyle = Math.random() < 0.5 ? '#0a1420' : '#ff5544';
                const by = pt + Math.random() * ph;
                ctx.fillRect(px + (Math.random() - 0.5) * 40 * f, by, pw, 1 + Math.random() * 5);
            }
            ctx.restore();
        }

        // Achievement toast sits on top of overlays/dialogs so an unlock
        // popping mid-shop or mid-pause is still visible. Suppressed during
        // the Yellow One cutscene to match how the rest of the HUD behaves.
        if (!this.yellowOneScriptActive) {
            this.hud.drawToast(ctx);
        }

        // Multiplayer overlays: chat + incoming trade request prompt.
        if (this.chatUI) this.chatUI.draw(ctx, this.hud ? this.hud.shieldBarTopY : null);
        if (this._tradeRequestFrom >= 0 && this.net) {
            this._drawTradeRequestPrompt(ctx);
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

        // Cinematic overlay (letterbox + warning banner) above HUD and flash,
        // below the Yellow One scripted fades.
        this.cinematics.drawOverlay(ctx);

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

    // Combine fanfare — scaled to the tier the fuse produced. Drawn in screen
    // space at the drop cursor, since combines happen inside menu overlays
    // (where the world is frozen in single player). Uses a real-time clock so
    // it animates even while the sim is paused.
    _celebrateCombine(draggedItem) {
        const resultTier = itemTier(draggedItem) + 1;
        const mouse = this.game.getMousePos();
        this._combineFx = {
            x: mouse.x, y: mouse.y,
            color: tierColor(resultTier),
            label: tierLabel(resultTier),
            max: resultTier >= MAX_COMBINE_TIER,
            start: performance.now()
        };
        if (resultTier >= MAX_COMBINE_TIER) this.game.sounds.playJackpot(2);
        else if (resultTier >= 6) this.game.sounds.playJackpot(1);
        else if (resultTier >= 4) this.game.sounds.playJackpot(0);
        else this.game.sounds.play('select', 0.8);
    }

    _drawCombineFx(ctx) {
        const fx = this._combineFx;
        if (!fx) return;
        const dur = fx.max ? 1.4 : 0.9;
        const t = (performance.now() - fx.start) / 1000;
        if (t >= dur) { this._combineFx = null; return; }
        const p = t / dur;
        const hudScale = this.game.hudScale;
        const ease = 1 - Math.pow(1 - p, 3);
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = Math.max(1, (1 - p) * hudScale);
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, ease * 30 * hudScale, 0, Math.PI * 2);
        ctx.stroke();
        if (fx.max) {
            // Max tier gets a second gold ring chasing the first
            ctx.strokeStyle = '#ffd24a';
            ctx.beginPath();
            ctx.arc(fx.x, fx.y, ease * 18 * hudScale, 0, Math.PI * 2);
            ctx.stroke();
        }
        // Tier label rising off the fuse point
        const ty = fx.y - 10 * hudScale - p * 8 * hudScale;
        const size = Math.floor(6 * hudScale * (p < 0.12 ? 1.4 - (p / 0.12) * 0.4 : 1));
        const o = Math.max(1, Math.round(hudScale / 2));
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = `${size}px Astro4x`;
        ctx.globalAlpha = p > 0.7 ? (1 - p) / 0.3 : 1;
        ctx.fillStyle = '#000000';
        ctx.fillText(fx.label, Math.round(fx.x) - o, Math.round(ty));
        ctx.fillText(fx.label, Math.round(fx.x) + o, Math.round(ty));
        ctx.fillText(fx.label, Math.round(fx.x), Math.round(ty) - o);
        ctx.fillText(fx.label, Math.round(fx.x), Math.round(ty) + o);
        ctx.fillStyle = fx.color;
        ctx.fillText(fx.label, Math.round(fx.x), Math.round(ty));
        ctx.restore();
    }

    // Casino jackpot ceremony for rare+ upgrade pickups. Cosmetic only —
    // fires locally for the collecting player (SP, MP host, and MP client
    // confirmation paths all route here).
    celebratePickup(item) {
        if (!item || !item.rarity) return;
        // 'unique' is the top of the actual item ladder (horror rewards like
        // the Cosmos Engine) — it gets the full legendary treatment.
        const tier = { rare: 0, epic: 1, legendary: 2, unique: 2 }[item.rarity];
        if (tier === undefined) return;
        const color = RARITY_COLORS[item.rarity] || '#ffd24a';
        this.cinematics.jackpotReel(item.name || item.id, color, tier);
        this.game.sounds.playJackpot(tier);
        this._spawnSparks(this.player.worldX, this.player.worldY, 10 + tier * 6,
            { color: '#ffd24a', speedMin: 120, speedMax: 380 });
        this.cinematics.spawnRing(this.player.worldX, this.player.worldY,
            { color, maxR: 160 + tier * 60, dur: 0.5, width: 3 });
        if (tier === 2) this.triggerFlash('#ffd24a', 0.6, 0.18);
    }

    // A rare+ item landing in the world announces itself with a glint so the
    // player spots the prize in the wreckage.
    _onItemDropped(it) {
        const item = it && it.item;
        if (!item || !item.rarity) return;
        if (item.rarity !== 'rare' && item.rarity !== 'epic' &&
            item.rarity !== 'legendary' && item.rarity !== 'unique') return;
        const color = RARITY_COLORS[item.rarity];
        this.cinematics.spawnRing(it.worldX, it.worldY, { color, maxR: 120, dur: 0.6, width: 3 });
        this._spawnSparks(it.worldX, it.worldY, 8, { color, speedMin: 60, speedMax: 200 });
    }

    // Drives the shader post-fx pass in Game.loop. crt = kill-streak CRT look,
    // warp/invert = dread insanity moments. All zero = pass skipped entirely.
    getScreenFx() {
        if (this.yellowOneScriptActive || this.isDead) return { crt: 0, warp: 0 };
        const d = this.dread ? this.dread.getFx() : null;

        // Shield impact ripple: true displacement wave across the bubble,
        // rendered by the post-pass shader from the freshest impact.
        let ripple = null, flow = null, collapse = null;
        if (this.camera.wtsScale !== undefined) {
            const ws = this.game.worldScale;
            const cx = this.player.worldX * this.camera.wtsScale + this.camera.wtsOffX;
            const cy = this.player.worldY * this.camera.wtsScale + this.camera.wtsOffY;

            if (this.shieldRipples.length > 0) {
                const rip = this.shieldRipples[this.shieldRipples.length - 1];
                const p = Math.min(1, rip.t / 0.35);
                const r = this.player.shieldRadius * ws;
                ripple = {
                    x: cx + Math.cos(rip.angle) * r,
                    y: cy + Math.sin(rip.angle) * r,
                    cx, cy, r,
                    strength: 1 - p,
                    t: rip.t
                };
            }

            // Boost: space bends around the hull in the direction of travel
            // (level eased in update so the lens swells/relaxes, never pops)
            if (this._boostFlowLevel > 0.01) {
                const spd = Math.hypot(this.player.vx, this.player.vy);
                if (spd > 1) {
                    flow = {
                        x: cx, y: cy,
                        dirX: this.player.vx / spd, dirY: this.player.vy / spd,
                        strength: Math.min(1, this._boostFlowLevel)
                    };
                }
            }

            // Teleport: space collapses in toward the ship — strongest
            // mid-warp, with a smaller settling pulse as the hull phases
            // back in at the destination
            const p = this.player;
            let cStr = 0;
            if (p.isWarping) {
                cStr = Math.sin(Math.PI * Math.min(1, p.warpTimer / p.warpDuration));
            } else if (p.teleportOutlineFade > 0.01) {
                cStr = p.teleportOutlineFade * 0.55;
            }
            if (cStr > 0.01) {
                collapse = { x: cx, y: cy, r: 270 * ws, strength: cStr };
            }
        }

        return {
            crt: this.killStreak ? this.killStreak.fxIntensity : 0,
            warp: d ? d.warp : 0,
            ripple, flow, collapse
        };
    }

    triggerFlash(color = '#ff0000', duration = 0.8, alpha = 0.35) {
        this.flashColor = color;
        this.flashTimer = duration;
        this.flashAlpha = alpha;
    }

    _triggerWave() {
        // Multiplayer: the wave centers on the announced target pilot (chosen
        // when the countdown started, shown in the HUD the whole time).
        const mp = !!this.netSync;
        const targetBody = mp ? this.netSync.waveTargetBody() : this.player;
        const quantityMult = mp ? mpQuantityMult(this.net.playerCount) : 1.0;
        const waveEnemies = this.enemySpawner.spawnWave(targetBody.worldX, targetBody.worldY, this.difficultyScale, quantityMult);

        // Check if a boss was spawned
        const boss = waveEnemies.find(e => e.isBoss);
        if (boss) {
            this.triggerFlash('#ffffff', 1.2, 0.5); // Dramatic white flash for boss arrival
            const mKey = boss.musicKey || 'Starcore Showdown';
            this.game.sounds.playSpecificMusic(mKey);
            this.game.camera.shake(1.5);
            if (mp) this.netSync.broadcastMusicCue(mKey);
        } else {
            this.triggerFlash('#ff0000', 0.8, 0.35); // Standard red wave flash
            this.game.sounds.play('ship_explode', 0.6); // Use explosion sound for wave impact
        }
        if (mp) this.netSync.announceWave(this.enemySpawner.waveNumber, boss ? (boss.musicKey || 'boss') : null);

        this._addEnemies(waveEnemies);
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

        // ── Hint text ─────────────────────────────────────────────────────────
        if (ui.isAnimating) {
            ctx.fillStyle = 'rgba(255, 204, 68, 0.6)';
            ctx.font = `${6 * uiScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const skipHint = this.game.input.isGamepadActive() ? 'A TO SKIP' : 'CLICK TO SKIP';
            ctx.fillText(skipHint, cw / 2, cacheLayout.panelY + cacheLayout.totalH + uiScale * 12);
        }
        ctx.fillStyle = '#667788';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const cacheCloseHint = this.game.input.isGamepadActive() ? 'A to move  •  B to close' : 'Drag to move  •  E to close';
        ctx.fillText(cacheCloseHint, cw / 2, ch - uiScale * 10);

        if (!ui.isAnimating) {
            this._drawInventoryTooltip(ctx, [
                { inv: cacheInv,  layout: cacheLayout,  scrollX: this.cacheScrollX,  scrollY: this.cacheScrollY },
                { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
            ]);
        }

        this._drawStatsPanel(ctx);
        this._drawClaimLevelsButton(ctx);

        // Gamepad selection corners draw over all static UI (including the
        // claim-levels button) but beneath the dragged item which follows the
        // cursor.
        this._drawGamepadSelection(ctx, [
            { inv: cacheInv,  layout: cacheLayout,  scrollXKey: 'cacheScrollX',  scrollYKey: 'cacheScrollY',  panelKey: 'cache' },
            { inv: playerInv, layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', panelKey: 'player' }
        ]);

        this._drawDraggedItem(ctx, slotSize);
        this._drawCombinePreview(ctx, [
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

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

        // Good-stock glints twinkling over the shelf (set in _openShop)
        if (this._shopOpenFx) {
            const fx = this._shopOpenFx;
            const t = (performance.now() - fx.start) / 1000;
            if (t > 1.5) {
                this._shopOpenFx = null;
            } else {
                const us = this.game.uiScale;
                ctx.save();
                ctx.fillStyle = fx.epic ? '#ffe9b0' : '#ffd24a';
                for (const sp of fx.sparkles) {
                    const st = (t - sp.delay) / sp.dur;
                    if (st <= 0 || st >= 1) continue;
                    const twinkle = Math.sin(st * Math.PI); // grow then shrink
                    const cx = Math.round(shopLayout.panelX + sp.rx * shopLayout.totalW);
                    const cy = Math.round(shopLayout.panelY + sp.ry * shopLayout.totalH);
                    const arm = Math.max(2, Math.round(4 * us * twinkle));
                    const thick = Math.max(1, Math.round(us / 2));
                    ctx.globalAlpha = twinkle;
                    // 4-point star glint
                    ctx.fillRect(cx - arm, cy - thick, arm * 2, thick * 2);
                    ctx.fillRect(cx - thick, cy - arm, thick * 2, arm * 2);
                }
                ctx.restore();
            }
        }
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

        ctx.fillStyle = '#667788';
        ctx.font = `${6 * uiScale}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        const shopCloseHint = this.game.input.isGamepadActive() ? 'A to buy/sell/move • B to close' : 'Drag to buy/sell/move • E to close';
        ctx.fillText(shopCloseHint, cw / 2, ch - uiScale * 10);

        this._drawInventoryTooltip(ctx, [
            { inv: shopInv,   layout: shopLayout,   scrollX: this.shopScrollX,   scrollY: this.shopScrollY },
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

        this._drawStatsPanel(ctx);
        this._drawClaimLevelsButton(ctx);

        // Selection corners go above static UI so they frame the focused
        // slot, perm-upgrade button, or claim-levels button cleanly.
        this._drawGamepadSelection(ctx, [
            { inv: shopInv,   layout: shopLayout,   scrollXKey: 'shopScrollX',   scrollYKey: 'shopScrollY',   panelKey: 'shop' },
            { inv: playerInv, layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', panelKey: 'player' }
        ]);
        this._drawDraggedItem(ctx, slotSize, shopInv);
        this._drawCombinePreview(ctx, [
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);
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

            // Draw rarity overlay (combined items carry a blended tier color)
            const baseColor = item.color || RARITY_COLORS[item.rarity] || '#ffffff';
            const alphaMap = { common: 0.15, uncommon: 0.2, rare: 0.25, epic: 0.25, legendary: 0.3, unique: 0.3 };
            ctx.globalAlpha = item.tier ? Math.min(0.3, 0.15 + item.tier * 0.02) : (alphaMap[item.rarity] || 0.2);
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

    _drawTooltip(ctx, item, mouse, opts = {}) {
        const previewLabel = opts.previewLabel || null;
        const cw = this.game.width;
        const ch = this.game.height;
        const uiScale = this.game.uiScale;

        const pad = 8 * uiScale;
        const fontSize = Math.floor(5 * uiScale);
        const titleFontSize = Math.floor(6 * uiScale);
        ctx.font = `${fontSize}px Astro4x`;

        // Calculate dimensions
        const name = item.name.toUpperCase();
        const rarity = item.rarityLabel || (item.rarity || 'common').toUpperCase();
        let desc = item.description || '';
        if (this.game.input.isGamepadActive()) {
            desc = desc.replace(/Right-click in cargo/gi, 'Press Y in cargo');
        }

        const maxWidth = 120 * uiScale;
        const descLines = this._wrapText(ctx, desc, maxWidth);

        // Combinable upgrades that aren't yet maxed get a hint footer (not on a
        // combine-result preview, which is itself the outcome of combining).
        const canCombine = !previewLabel && item.combine && itemTier(item) < MAX_COMBINE_TIER;
        const hintLines = canCombine
            ? this._wrapText(ctx, 'Drop onto a copy to combine', maxWidth)
            : [];

        const headerW = Math.max(ctx.measureText(name).width * 1.2, ctx.measureText(rarity).width,
            previewLabel ? ctx.measureText(previewLabel).width : 0);
        const bodyW = descLines.concat(hintLines).reduce((max, l) => Math.max(max, ctx.measureText(l).width), 0);
        const tw = Math.max(headerW, bodyW) + pad * 2;
        // 3 header units = name + rarity + (cost OR preview label); hint adds lines.
        const th = (descLines.length + hintLines.length + 3) * fontSize * 1.5 + pad * 2;

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

        // Preview header (e.g. "COMBINE →")
        if (previewLabel) {
            ctx.font = `${fontSize}px Astro4x`;
            ctx.fillStyle = item.color || RARITY_COLORS[item.rarity] || '#88ccff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(previewLabel, tx + pad, cy);
            cy += fontSize * 1.5;
        }

        // Name
        ctx.font = `${titleFontSize}px Astro5x`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(name, tx + pad, cy);
        cy += titleFontSize * 1.5;

        // Rarity
        ctx.font = `${fontSize}px Astro4x`;
        ctx.fillStyle = item.color || RARITY_COLORS[item.rarity] || '#ffffff';
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

        // Combine hint footer
        if (hintLines.length) {
            cy += fontSize * 0.4;
            ctx.fillStyle = item.color || RARITY_COLORS[item.rarity] || '#88ccff';
            for (const line of hintLines) {
                ctx.fillText(line, tx + pad, cy);
                cy += fontSize * 1.4;
            }
        }

        if (item.cost && !previewLabel) {
            cy += fontSize * 0.5;
            ctx.fillStyle = '#ffff44';
            ctx.fillText(`BASE VALUE: ${item.cost} SCRAP`, tx + pad, cy);
        }

        ctx.restore();
    }
    // ── Shared inventory UI helpers ────────────────────────────────────────────

    // Called once any inventory UI finishes closing, so the cursor mode
    // doesn't linger into plain mouse gameplay.
    _releaseGamepadCursor() {
        this.game.input.setGamepadCursorEnabled(false);
        this._gamepadUICursorInitialized = false;
        this._gpFocus = null;
        this._gpFocusablesCache = null;
    }

    // Draws four corner sprites framing a rectangular region.
    _drawSelectionCorners(ctx, x, y, w, h) {
        const uiScale = this.game.uiScale;
        const tl = this.game.assets.get('corner_tl');
        const tr = this.game.assets.get('corner_tr');
        const bl = this.game.assets.get('corner_bl');
        const br = this.game.assets.get('corner_br');
        if (!tl || !tr || !bl || !br) return;
        const cw = Math.round((tl.width || tl.canvas.width) * uiScale);
        const ch = Math.round((tl.height || tl.canvas.height) * uiScale);
        const prevSmooth = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tl.canvas || tl, Math.round(x),          Math.round(y),          cw, ch);
        ctx.drawImage(tr.canvas || tr, Math.round(x + w - cw), Math.round(y),          cw, ch);
        ctx.drawImage(bl.canvas || bl, Math.round(x),          Math.round(y + h - ch), cw, ch);
        ctx.drawImage(br.canvas || br, Math.round(x + w - cw), Math.round(y + h - ch), cw, ch);
        ctx.imageSmoothingEnabled = prevSmooth;
    }

    // Builds the current frame's focus-candidate list: every visible slot in
    // each panel, plus any extra buttons provided by the caller. A multi-cell
    // item collapses into a single focusable whose rect covers the whole
    // item, so directional stepping treats the item as one block (e.g. a 2x2
    // takes one press to step past, not two).
    //
    // panels: [{ inv, layout, scrollXKey, scrollYKey, panelKey }]
    // extraButtons: [{ rect, id }]
    _buildFocusables(panels, extraButtons = []) {
        const out = [];
        for (const p of panels) {
            const l = p.layout;
            const seen = new Set();
            for (let r = 0; r < p.inv.rows; r++) {
                for (let c = 0; c < p.inv.cols; c++) {
                    const entry = p.inv.getItemAt(c, r);
                    if (entry) {
                        if (seen.has(entry)) continue; // already emitted this item
                        seen.add(entry);
                        const ix = l.gridVisX + entry.x * l.slotSize - this[p.scrollXKey];
                        const iy = l.gridVisY + entry.y * l.slotSize - this[p.scrollYKey];
                        const iw = entry.item.width  * l.slotSize;
                        const ih = entry.item.height * l.slotSize;
                        // Include the item if any part of it is visible.
                        if (ix + iw <= l.gridVisX || ix >= l.gridVisX + l.visW) continue;
                        if (iy + ih <= l.gridVisY || iy >= l.gridVisY + l.visH) continue;
                        out.push({
                            kind: 'slot',
                            panelKey: p.panelKey,
                            col: entry.x, row: entry.y,
                            rect: { x: ix, y: iy, w: iw, h: ih },
                            hasItem: true
                        });
                    } else {
                        const sx = l.gridVisX + c * l.slotSize - this[p.scrollXKey];
                        const sy = l.gridVisY + r * l.slotSize - this[p.scrollYKey];
                        if (sx + l.slotSize <= l.gridVisX || sx >= l.gridVisX + l.visW) continue;
                        if (sy + l.slotSize <= l.gridVisY || sy >= l.gridVisY + l.visH) continue;
                        out.push({
                            kind: 'slot',
                            panelKey: p.panelKey,
                            col: c, row: r,
                            rect: { x: sx, y: sy, w: l.slotSize, h: l.slotSize },
                            hasItem: false
                        });
                    }
                }
            }
        }
        for (const b of extraButtons) {
            if (!b.rect || b.rect.w <= 0 || b.rect.h <= 0) continue;
            out.push({ kind: 'button', id: b.id, rect: b.rect, onActivate: b.onActivate });
        }
        return out;
    }

    // Finds the index in `focusables` that best matches `this._gpFocus`,
    // falling back to a sensible starting focus when nothing was stored:
    // prefer a slot that actually contains an item (so e.g. a freshly-
    // rolled cache lands the cursor on loot, not an empty cell), then any
    // slot, then any button. Nearest to (fallbackX, fallbackY) breaks ties.
    _resolveFocusIndex(focusables, fallbackX, fallbackY) {
        if (focusables.length === 0) return -1;
        const f = this._gpFocus;
        if (f) {
            for (let i = 0; i < focusables.length; i++) {
                const e = focusables[i];
                if (f.kind === 'slot' && e.kind === 'slot'
                    && f.panelKey === e.panelKey && f.col === e.col && f.row === e.row) return i;
                if (f.kind === 'button' && e.kind === 'button' && f.id === e.id) return i;
            }
        }
        const nearest = (predicate) => {
            let bestIdx = -1;
            let bestDist = Infinity;
            for (let i = 0; i < focusables.length; i++) {
                if (!predicate(focusables[i])) continue;
                const r = focusables[i].rect;
                const cx = r.x + r.w / 2;
                const cy = r.y + r.h / 2;
                const d = (cx - fallbackX) ** 2 + (cy - fallbackY) ** 2;
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            }
            return bestIdx;
        };
        let idx = nearest(e => e.kind === 'slot' && e.hasItem);
        if (idx < 0) idx = nearest(e => e.kind === 'slot');
        if (idx < 0) idx = nearest(() => true);
        return idx < 0 ? 0 : idx;
    }

    // Spatial directional step. Compares whole rects so that a multi-cell
    // item directly above/below the cursor wins over a single cell that is
    // only diagonal. The score favours: (a) candidates that overlap the
    // cursor on the cross-axis, (b) the smallest primary-axis distance.
    _stepFocusSpatial(focusables, curIdx, dirX, dirY) {
        if (curIdx < 0 || curIdx >= focusables.length) return curIdx;
        const cur = focusables[curIdx].rect;
        const curCx = cur.x + cur.w / 2;
        const curCy = cur.y + cur.h / 2;
        let bestIdx = -1;
        let bestScore = Infinity;
        for (let i = 0; i < focusables.length; i++) {
            if (i === curIdx) continue;
            const r = focusables[i].rect;
            const rCx = r.x + r.w / 2;
            const rCy = r.y + r.h / 2;

            // Must be in the pressed direction (compared by center).
            if (dirX !== 0 && Math.sign(rCx - curCx) !== dirX) continue;
            if (dirY !== 0 && Math.sign(rCy - curCy) !== dirY) continue;

            let primary, crossOverlapping;
            if (dirX !== 0) {
                // Primary distance: edge-to-edge gap when there's clear
                // separation, falls back to center distance when rects
                // overlap in the primary axis.
                primary = dirX > 0
                    ? Math.max(r.x - (cur.x + cur.w), rCx - curCx)
                    : Math.max(cur.x - (r.x + r.w), curCx - rCx);
                const yInter = Math.min(r.y + r.h, cur.y + cur.h) - Math.max(r.y, cur.y);
                crossOverlapping = yInter > 0;
            } else {
                primary = dirY > 0
                    ? Math.max(r.y - (cur.y + cur.h), rCy - curCy)
                    : Math.max(cur.y - (r.y + r.h), curCy - rCy);
                const xInter = Math.min(r.x + r.w, cur.x + cur.w) - Math.max(r.x, cur.x);
                crossOverlapping = xInter > 0;
            }

            // Heavy penalty for candidates that aren't aligned on the cross-
            // axis — guarantees that a multi-cell item covering the cursor's
            // column/row beats any diagonal neighbour.
            const alignmentPenalty = crossOverlapping ? 0 : (cur.w + cur.h + r.w + r.h);
            const score = primary + alignmentPenalty;
            if (score < bestScore) { bestScore = score; bestIdx = i; }
        }
        return bestIdx >= 0 ? bestIdx : curIdx;
    }

    // Writes a focusable back into `_gpFocus` so the next frame can find it
    // again even if the focusables array is rebuilt (scroll, stock change).
    _recordFocus(f) {
        if (!f) { this._gpFocus = null; return; }
        if (f.kind === 'slot') {
            this._gpFocus = { kind: 'slot', panelKey: f.panelKey, col: f.col, row: f.row };
        } else {
            this._gpFocus = { kind: 'button', id: f.id };
        }
    }

    // Drives the inventory UI with the gamepad:
    //   - When idle, the left stick / d-pad snap-navigates between focusables
    //     (slots + buttons) and the virtual mouse sits at the current focus
    //     center so existing mouse-driven click handlers fire.
    //   - When an item is held, smooth-cursor mode takes over (InputManager)
    //     so the player can fine-position the drop.
    //   - A always synthesises a left-mouse press (pickup/place/click).
    //
    // panels: [{ inv, layout, scrollXKey, scrollYKey, panelKey }]
    // extraButtons: [{ rect, id }]  -- typically perm upgrades, claim levels
    _gamepadInventoryUpdate(dt, panels, extraButtons = []) {
        const input = this.game.input;
        if (!input.gamepadConnected) {
            input.setGamepadCursorEnabled(false);
            return;
        }

        // While holding an item, smooth stick-driven cursor wins so the
        // player can position the drop freely.
        if (this.draggedItem) {
            input.setGamepadCursorEnabled(true);
            return;
        }

        // Idle snap mode: no smooth cursor, focus jumps slot-to-slot.
        input.setGamepadCursorEnabled(false);

        if (!input.isGamepadActive()) {
            // Gamepad connected but user is using mouse — leave focus alone
            // so we don't fight them.
            this._gpFocusablesCache = null;
            return;
        }

        const focusables = this._buildFocusables(panels, extraButtons);
        this._gpFocusablesCache = focusables;
        if (focusables.length === 0) return;

        const fallbackPanel = panels[0] && panels[0].layout;
        const fbX = fallbackPanel ? fallbackPanel.gridVisX + fallbackPanel.visW / 2 : 0;
        const fbY = fallbackPanel ? fallbackPanel.gridVisY + fallbackPanel.visH / 2 : 0;
        let idx = this._resolveFocusIndex(focusables, fbX, fbY);

        const step = (dx, dy) => {
            const next = this._stepFocusSpatial(focusables, idx, dx, dy);
            if (next !== idx) {
                idx = next;
                this.game.sounds.play('click', 0.4);
            }
        };

        // Hold-to-repeat: a direction fires immediately, then after an
        // initial delay it auto-repeats at an accelerating cadence so the
        // player can rip across a big inventory without mashing the stick.
        let dx = 0, dy = 0;
        if (input.isGamepadDown(GP.DRIGHT)) dx += 1;
        if (input.isGamepadDown(GP.DLEFT))  dx -= 1;
        if (input.isGamepadDown(GP.DDOWN))  dy += 1;
        if (input.isGamepadDown(GP.DUP))    dy -= 1;
        if (dx === 0 && dy === 0) {
            // Fall through to left stick — only the dominant axis counts so
            // held diagonals don't cause zigzag stepping.
            const lx = input.leftStickX;
            const ly = input.leftStickY;
            if (Math.abs(lx) > 0.5 || Math.abs(ly) > 0.5) {
                if (Math.abs(lx) > Math.abs(ly)) dx = lx > 0 ? 1 : -1;
                else                             dy = ly > 0 ? 1 : -1;
            }
        }

        const dirChanged = dx !== this._gpHeldDx || dy !== this._gpHeldDy;
        if (dirChanged) {
            this._gpHeldDx = dx;
            this._gpHeldDy = dy;
            this._gpHeldTime = 0;
            if (dx !== 0 || dy !== 0) {
                step(dx, dy);
                this._gpRepeatDelay = 0.35; // initial delay before auto-repeat
            }
        } else if (dx !== 0 || dy !== 0) {
            this._gpHeldTime = (this._gpHeldTime || 0) + dt;
            this._gpRepeatDelay -= dt;
            if (this._gpRepeatDelay <= 0) {
                step(dx, dy);
                // Accelerate from ~10 steps/sec down to a minimum of ~18
                // steps/sec the longer the direction is held.
                const rate = Math.max(0.055, 0.11 - this._gpHeldTime * 0.04);
                this._gpRepeatDelay = rate;
            }
        }

        const focused = focusables[idx];
        this._recordFocus(focused);

        // Snap the virtual mouse onto the current focus center so existing
        // hover-state rendering and tooltip code light up the right thing.
        input.mouseScreenX = focused.rect.x + focused.rect.w / 2;
        input.mouseScreenY = focused.rect.y + focused.rect.h / 2;

        // A activates the focus. Buttons run their action directly. Slots
        // trigger an in-place pickup and transition into smooth-cursor drag
        // mode (the InputManager's cursor code handles the A press that
        // releases the drag on the next press, wired via _gpVirtualMouseDown).
        if (input.isGamepadJustPressed(GP.A)) {
            if (focused.kind === 'button' && typeof focused.onActivate === 'function') {
                focused.onActivate();
            } else if (focused.kind === 'slot') {
                const panel = panels.find(p => p.panelKey === focused.panelKey);
                if (panel) {
                    const slotCenter = {
                        x: focused.rect.x + focused.rect.w / 2,
                        y: focused.rect.y + focused.rect.h / 2
                    };
                    if (this._tryPickUpItem(slotCenter, panel.inv, panel.layout, panel.scrollXKey, panel.scrollYKey)) {
                        // Keep mouse-button-0 synthetically held so the drop
                        // code (which waits for !isMouseDown(0)) doesn't fire
                        // instantly, and the cursor-mode A handler can flip
                        // it off on the player's next A press.
                        input.mouseButtons.add(0);
                        input._gpVirtualMouseDown = true;
                    }
                }
            }
        }

        // Y consumes the item in the focused player slot (same semantics as
        // right-click on mouse).
        if (input.isGamepadJustPressed(GP.Y)
            && focused.kind === 'slot'
            && focused.panelKey === 'player') {
            const panel = panels.find(p => p.panelKey === 'player');
            if (panel) {
                const entry = panel.inv.getItemAt(focused.col, focused.row);
                if (entry) this._tryUseConsumable(entry, panel.inv);
            }
        }
    }

    // Renders selection corners for the current gamepad focus. When dragging,
    // shows the snapped drop position on whichever panel the cursor is over.
    _drawGamepadSelection(ctx, panels) {
        const input = this.game.input;
        if (!input.isGamepadActive()) return;

        if (this.draggedItem) {
            // Smooth-cursor mode — corners frame the snapped drop cell.
            const mouse = this.game.getMousePos();
            const item = this.draggedItem.item;
            for (const p of panels) {
                const l = p.layout;
                if (mouse.x < l.gridVisX || mouse.x > l.gridVisX + l.visW) continue;
                if (mouse.y < l.gridVisY || mouse.y > l.gridVisY + l.visH) continue;
                const { col, row } = this._getDropPosition(mouse, l, p.scrollXKey, p.scrollYKey);
                const fits = p.inv.canFit(item, col, row) ||
                             (this.draggedItem.originInventory === p.inv &&
                              p.inv.canSwap(item, col, row, this.draggedItem.x, this.draggedItem.y));
                const sx = l.gridVisX + col * l.slotSize - this[p.scrollXKey];
                const sy = l.gridVisY + row * l.slotSize - this[p.scrollYKey];
                const w  = item.width  * l.slotSize;
                const h  = item.height * l.slotSize;
                ctx.save();
                if (!fits) ctx.globalAlpha = 0.4;
                this._drawSelectionCorners(ctx, sx, sy, w, h);
                ctx.restore();
                return;
            }
            return;
        }

        // Idle — corners around the focused slot or button.
        const focusables = this._gpFocusablesCache;
        const f = this._gpFocus;
        if (!focusables || !f) return;
        let focused = null;
        for (const e of focusables) {
            if (f.kind === 'slot' && e.kind === 'slot'
                && f.panelKey === e.panelKey && f.col === e.col && f.row === e.row) { focused = e; break; }
            if (f.kind === 'button' && e.kind === 'button' && f.id === e.id) { focused = e; break; }
        }
        if (!focused) return;

        if (focused.kind === 'slot') {
            // Widen the corners to frame the whole item if one is under this
            // slot (the focus point might be any cell within a multi-cell item).
            const panel = panels.find(p => p.panelKey === focused.panelKey);
            if (panel) {
                const entry = panel.inv.getItemAt(focused.col, focused.row);
                if (entry) {
                    const l = panel.layout;
                    const sx = l.gridVisX + entry.x * l.slotSize - this[panel.scrollXKey];
                    const sy = l.gridVisY + entry.y * l.slotSize - this[panel.scrollYKey];
                    this._drawSelectionCorners(ctx, sx, sy, entry.item.width * l.slotSize, entry.item.height * l.slotSize);
                    return;
                }
            }
        }
        this._drawSelectionCorners(ctx, focused.rect.x, focused.rect.y, focused.rect.w, focused.rect.h);
    }

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
        const mult = this.pendingLevelUpMult || 1;
        const hasMult = mult > 1.00001;
        ctx.fillStyle   = cl.hovered ? '#333300' : '#1a1a00';
        ctx.strokeStyle = cl.hovered ? '#ffff55' : '#aaaa00';
        ctx.lineWidth = 1;
        ctx.fillRect(cl.x, cl.y, cl.w, cl.h);
        ctx.strokeRect(cl.x, cl.y, cl.w, cl.h);
        ctx.fillStyle = cl.hovered ? '#ffff55' : '#cccc00';
        ctx.font = `${6 * us}px Astro4x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = hasMult
            ? `CLAIM ${count} LEVEL${count !== 1 ? 'S' : ''}  (x${mult.toFixed(2)})`
            : `CLAIM ${count} LEVEL${count !== 1 ? 'S' : ''}`;
        ctx.fillText(label, cl.x + cl.w / 2, cl.y + cl.h / 2);
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

    // While dragging a combinable item, preview the combine result wherever the
    // drop would merge with a matching item in the player's inventory. Drawn
    // AFTER the dragged item so it sits on top of the cursor sprite.
    _drawCombinePreview(ctx, panels) {
        if (!this.draggedItem) return;
        const dragged = this.draggedItem.item;
        if (!dragged.combine) return;
        const mouse = this.game.getMousePos();
        for (const p of panels) {
            if (p.inv !== this.player.inventory) continue;
            const slotSize = p.layout.slotSize;
            const col = Math.floor((mouse.x - p.layout.gridVisX + p.scrollX - this.draggedItem.offsetX) / slotSize + 0.5);
            const row = Math.floor((mouse.y - p.layout.gridVisY + p.scrollY - this.draggedItem.offsetY) / slotSize + 0.5);
            const target = p.inv.combineTargetAt(dragged, col, row);
            if (target) {
                const result = makeItem(dragged.id, itemTier(target.item) + 1);
                this._drawTooltip(ctx, result, mouse, { previewLabel: 'COMBINE →' });
                return;
            }
        }
    }

    // Attempts to use a consumable item. Returns true if the item was handled.
    _tryUseConsumable(entry, playerInv) {
        if (!entry || !entry.item.consumable) return false;
        const id = entry.item.id;
        if (id === 'small_battery') {
            this.player.heal(entry.item.bonus ?? 0.2);
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

    // Applies a perm-upgrade purchase given the bounds descriptor. Shared by
    // the mouse click handler and the gamepad A-button focus path.
    _applyPermUpgrade(bounds) {
        if (bounds.canBuy) {
            this.player.scrap -= bounds.cost;
            this.activeShop.permUpgrades[bounds.id].stock--;

            if (bounds.id === 'health') {
                this.player.addPermHealthBonus(30);
                this._onInventoryChanged();
            } else if (bounds.id === 'shield') {
                this.player.updateMaxShield(100);
            } else if (bounds.id === 'damage') {
                this.player.permDamageBonus += 5.0;
                this.game.sounds.play('laser', 0.2);
            } else if (bounds.id === 'inventory') {
                this.player.inventoryUpgradeTier++;
                const ejected = this.player.inventory.resize(this.player.inventory.cols + 1, this.player.inventory.rows);
                if (ejected && ejected.length > 0) this._ejectItems(ejected);
            }
            this.game.sounds.play('select', 0.8);
        } else if (!bounds.maxed && this.activeShop.permUpgrades[bounds.id].stock > 0) {
            this.game.sounds.play('asteroid_break', 0.3);
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
        let offsetX, offsetY;
        if (this.game.input.isGamepadActive()) {
            // Centre the item on the virtual cursor so stick-driven dragging
            // lines up with the selection corners.
            offsetX = entry.item.width  * slotSize / 2;
            offsetY = entry.item.height * slotSize / 2;
        } else {
            offsetX = mouse.x - (layout.gridVisX - this[scrollXKey] + entry.x * slotSize);
            offsetY = mouse.y - (layout.gridVisY - this[scrollYKey] + entry.y * slotSize);
        }
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
        const edgeMargin = 24 * uiScale;
        const speed = baseSpeed * dt * uiScale;
        for (const p of panels) {
            const { layout } = p;
            if (mouse.x >= layout.gridVisX && mouse.x <= layout.gridVisX + layout.visW &&
                mouse.y >= layout.gridVisY && mouse.y <= layout.gridVisY + layout.visH) {
                if (layout.scrollableY) {
                    const distTop = mouse.y - layout.gridVisY;
                    const distBottom = (layout.gridVisY + layout.visH) - mouse.y;
                    if (distTop < edgeMargin)         this[p.scrollYKey] -= speed * (1 - distTop / edgeMargin);
                    else if (distBottom < edgeMargin) this[p.scrollYKey] += speed * (1 - distBottom / edgeMargin);
                }
                if (layout.scrollableX) {
                    const distLeft = mouse.x - layout.gridVisX;
                    const distRight = (layout.gridVisX + layout.visW) - mouse.x;
                    if (distLeft < edgeMargin)         this[p.scrollXKey] -= speed * (1 - distLeft / edgeMargin);
                    else if (distRight < edgeMargin)   this[p.scrollXKey] += speed * (1 - distRight / edgeMargin);
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

    // Right stick pans the focused panel (or first scrollable panel as fallback)
    // when the gamepad is in snap-focus mode. While dragging, the cursor uses the
    // stick directly and edge-scroll takes over, so we skip.
    _applyGamepadScroll(dt, panels, speed = 400) {
        const input = this.game.input;
        if (!input.isGamepadActive() || this.draggedItem) return;
        const rx = input.rightStickX;
        const ry = input.rightStickY;
        if (Math.abs(rx) < 0.15 && Math.abs(ry) < 0.15) return;

        const focusKey = this._gpFocus && this._gpFocus.panelKey;
        let target = focusKey ? panels.find(p => p.panelKey === focusKey) : null;
        if (!target) target = panels.find(p => p.layout.maxScrollX > 0 || p.layout.maxScrollY > 0);
        if (!target) return;

        if (target.layout.maxScrollX > 0) this[target.scrollXKey] += rx * speed * dt;
        if (target.layout.maxScrollY > 0) this[target.scrollYKey] += ry * speed * dt;
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
        this._applyGamepadScroll(dt, panels);
        this._clampScrollPanels(panels);
        return false;
    }

    _updateCacheUI(dt) {
        const ui = this.activeCacheUI;
        if (!ui) return;

        ui.update(dt);

        const cacheInv  = ui.cacheInventory;
        const playerInv = this.player.inventory;

        const cacheLayout  = this._getInventoryLayout(cacheInv,  'shop');
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        const panels = [
            { layout: cacheLayout,  scrollXKey: 'cacheScrollX',  scrollYKey: 'cacheScrollY', inv: cacheInv,  panelKey: 'cache' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', inv: playerInv, panelKey: 'player' }
        ];

        const extraButtons = [];
        const cl = this.pauseButtons.claimLevels;
        if (this.levelUpQueue.length > 0 && cl.w > 0) {
            extraButtons.push({
                id: 'claimLevels',
                rect: cl,
                onActivate: () => {
                    this._levelUpOrigin = 'cache';
                    this._openLevelUpDialog(this.levelUpQueue.shift());
                }
            });
        }

        // Skip gamepad focus during the rolling animation — only the skip
        // input matters in that state.
        if (!ui.isAnimating) {
            this._gamepadInventoryUpdate(dt, panels, extraButtons);
        }

        // Re-read mouse in case gamepad focus snapped the virtual cursor to
        // a slot or button center.
        const mouse = this.game.getMousePos();

        if (this._applyScrollPanels(dt, mouse, panels)) return;

        // ── Skip animation on click / Space / A / X (matches dialog skip) ────
        if (ui.isAnimating && (
            this.game.input.isMouseJustPressed(0) ||
            this.game.input.isKeyJustPressed('Space') ||
            this.game.input.isGamepadJustPressed(GP.A) ||
            this.game.input.isGamepadJustPressed(GP.X)
        )) {
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
                    const fromCache = this.draggedItem.originInventory === cacheInv;
                    playerInv.addItem(this.draggedItem.item, pCol, pRow);
                    this._onInventoryChanged();
                    this.game.sounds.play('select', 0.8);
                    if (fromCache) {
                        if (this.game.achievements) {
                            this.game.achievements.notify('upgrade_collected', { item: this.draggedItem.item });
                        }
                        if (cacheInv.items.length === 0 && this._activeCache) this._activeCache.markEmptied();
                    }
                    this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
                } else if (this.draggedItem.originInventory === playerInv &&
                           playerInv.tryCombine(this.draggedItem.item, pCol, pRow)) {
                    this._onInventoryChanged();
                    this._celebrateCombine(this.draggedItem.item);
                    this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
                } else if (this.draggedItem.originInventory === playerInv &&
                           playerInv.trySwap(this.draggedItem.item, pCol, pRow, this.draggedItem.x, this.draggedItem.y)) {
                    this._onInventoryChanged();
                    this.game.sounds.play('click', 0.5);
                    this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
                } else if (cacheInv.canFit(this.draggedItem.item, cCol, cRow)) {
                    cacheInv.addItem(this.draggedItem.item, cCol, cRow);
                    if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                    this.game.sounds.play('click', 0.5);
                    this._gpFocus = { kind: 'slot', panelKey: 'cache', col: cCol, row: cRow };
                } else if (this.draggedItem.originInventory === cacheInv &&
                           cacheInv.trySwap(this.draggedItem.item, cCol, cRow, this.draggedItem.x, this.draggedItem.y)) {
                    this.game.sounds.play('click', 0.5);
                    this._gpFocus = { kind: 'slot', panelKey: 'cache', col: cCol, row: cRow };
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
                        this._dropItemToSpace(this.draggedItem.item, worldMouse.x + dropOffset, worldMouse.y + dropOffset2);
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

        // ── E / ESC / gamepad B / X / Back / Start close ─────────────────────
        const input = this.game.input;
        const closePressed =
            input.isKeyJustPressed('KeyE') ||
            input.isKeyJustPressed('Escape') ||
            input.isGamepadJustPressed(GP.B) ||
            input.isGamepadJustPressed(GP.X) ||
            input.isGamepadJustPressed(GP.BACK) ||
            input.isGamepadJustPressed(GP.START);
        if (closePressed) {
            if (this.draggedItem) {
                this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                this.draggedItem = null;
            }
            // Preserve any in-progress roll so the player doesn't lose loot
            // by closing mid-spin — the item lands in the cache and can be
            // claimed by re-opening it.
            if (ui.isAnimating) ui.forceFinalize();
            ui.close();
        }

        // ── Teardown ─────────────────────────────────────────────────────────
        if (ui.isClosed) {
            this.isCacheOpen = false;
            this.paused      = false;
            if (this._activeCache) {
                this._activeCache.close();
                // Multiplayer: publish what's left in the chest + release the
                // lock so the next pilot sees exactly the remaining loot.
                if (this.netSync && this._activeCache.netId !== undefined) {
                    const remaining = ui.cacheInventory
                        ? ui.cacheInventory.items.map(e => ({ id: e.item.id, tier: e.item.tier || 0, x: e.x, y: e.y }))
                        : [];
                    this._activeCache.netItems = remaining;
                    this._netSendCacheState({
                        nid: this._activeCache.netId,
                        items: remaining,
                        emptied: remaining.length === 0,
                    });
                    this._netReleaseLock('cache', this._activeCache.netId);
                }
            }
            this.activeCacheUI  = null;
            this._activeCache   = null;
            this.cacheScrollX   = 0;
            this.cacheScrollY   = 0;
            this._releaseGamepadCursor();
        }
    }

    _updateShopUI(dt) {
        const shopInv    = this.activeShop.inventory;
        const shopLayout = this._getInventoryLayout(shopInv, 'shop');
        const playerInv  = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'player');

        const panels = [
            { layout: shopLayout,   scrollXKey: 'shopScrollX',   scrollYKey: 'shopScrollY',   inv: shopInv,   panelKey: 'shop' },
            { layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', inv: playerInv, panelKey: 'player' }
        ];

        const extraButtons = [];
        if (this._currentPermButtons) {
            for (const btn of this._currentPermButtons) {
                extraButtons.push({
                    id: 'perm_' + btn.bounds.id,
                    rect: { x: btn.bounds.x, y: btn.bounds.y, w: btn.bounds.w, h: btn.bounds.h },
                    onActivate: () => this._applyPermUpgrade(btn.bounds)
                });
            }
        }
        const cl = this.pauseButtons.claimLevels;
        if (this.levelUpQueue.length > 0 && cl.w > 0) {
            extraButtons.push({
                id: 'claimLevels',
                rect: cl,
                onActivate: () => {
                    this._levelUpOrigin = 'shop';
                    this._openLevelUpDialog(this.levelUpQueue.shift());
                }
            });
        }

        this._gamepadInventoryUpdate(dt, panels, extraButtons);

        const mouse = this.game.getMousePos();

        if (this._applyScrollPanels(dt, mouse, panels)) return;

        if (this.game.input.isMouseJustPressed(0)) {
            // Check Permanent Upgrade clicks
            if (this._currentPermButtons) {
                let clickedPerm = false;
                for (const btn of this._currentPermButtons) {
                    if (mouse.x >= btn.bounds.x && mouse.x <= btn.bounds.x + btn.bounds.w &&
                        mouse.y >= btn.bounds.y && mouse.y <= btn.bounds.y + btn.bounds.h) {
                        clickedPerm = true;
                        this._applyPermUpgrade(btn.bounds);
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
                        this._onInventoryChanged();
                        if (this.game.achievements) {
                            this.game.achievements.notify('upgrade_collected', { item: this.draggedItem.item });
                        }
                        this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
                    } else {
                        shopInv.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                        this.game.sounds.play('asteroid_break', 0.5);
                    }
                } else {
                    playerInv.addItem(this.draggedItem.item, pCol, pRow);
                    this.game.sounds.play('click', 0.5);
                    this._onInventoryChanged();
                    this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
                }
            }
            // 1b. Combine within player inventory
            else if (this.draggedItem.originInventory === playerInv &&
                     playerInv.tryCombine(this.draggedItem.item, pCol, pRow)) {
                this._celebrateCombine(this.draggedItem.item);
                this._onInventoryChanged();
                this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
            }
            // 1c. Swap within player inventory
            else if (this.draggedItem.originInventory === playerInv &&
                     playerInv.trySwap(this.draggedItem.item, pCol, pRow, this.draggedItem.x, this.draggedItem.y)) {
                this.game.sounds.play('click', 0.5);
                this._onInventoryChanged();
                this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
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
                this._gpFocus = { kind: 'slot', panelKey: 'shop', col: sCol, row: sRow };
            }
            // 2b. Swap within shop inventory
            else if (this.draggedItem.originInventory === shopInv &&
                     shopInv.trySwap(this.draggedItem.item, sCol, sRow, this.draggedItem.x, this.draggedItem.y)) {
                this.game.sounds.play('click', 0.5);
                this._gpFocus = { kind: 'slot', panelKey: 'shop', col: sCol, row: sRow };
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
                    this._dropItemToSpace(this.draggedItem.item, worldMouse.x + dropOffset, worldMouse.y + dropOffset2);
                    this._onInventoryChanged();
                    this.game.sounds.play('click', 0.5);
                }
            }

            this.draggedItem = null;
        }

        if (this._updateClaimLevelsButton(mouse, 'shop')) return;

        const input = this.game.input;
        const closePressed =
            input.isKeyJustPressed('KeyE') ||
            input.isKeyJustPressed('Escape') ||
            input.isGamepadJustPressed(GP.B) ||
            input.isGamepadJustPressed(GP.BACK) ||
            input.isGamepadJustPressed(GP.START);
        if (closePressed) {
            if (this.draggedItem) {
                this.draggedItem.originInventory.addItem(this.draggedItem.item, this.draggedItem.x, this.draggedItem.y);
                if (this.draggedItem.originInventory === playerInv) this._onInventoryChanged();
                this.draggedItem = null;
            }
            // Multiplayer: publish the shop's new stock + release the lock.
            if (this.netSync && this.activeShop && this.activeShop.netId !== undefined) {
                this._netSendShopState(this.activeShop);
                this._netReleaseLock('shop', this.activeShop.netId);
            }
            this.isShopOpen = false;
            this.paused = false;
            this.activeShop = null;
            this.game.sounds.play('click', 0.5);
            this._releaseGamepadCursor();
        }
    }

    _updatePauseUI(dt) {
        const uiScale = this.game.uiScale;
        const cw = this.game.width;
        const ch = this.game.height;

        const playerInv    = this.player.inventory;
        const playerLayout = this._getInventoryLayout(playerInv, 'pause');

        const panels = [{ layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', inv: playerInv, panelKey: 'player' }];

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

        // Achievements button — mirrors the main-menu placement (top-right
        // text button) so the two screens read consistently.
        const achMargin = Math.floor(uiScale * 12);
        const achW = Math.floor(uiScale * 80);
        const achH = Math.floor(uiScale * 22);
        this.pauseButtons.achievements.x = cw - achMargin - achW;
        this.pauseButtons.achievements.y = achMargin;
        this.pauseButtons.achievements.w = achW;
        this.pauseButtons.achievements.h = achH;

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

        // ── Build gamepad focusables once all button rects are known ────────
        const pauseExtraButtons = [];
        const addBtn = (id, rect, activate) => {
            if (!rect || rect.w <= 0 || rect.h <= 0) return;
            pauseExtraButtons.push({ id, rect, onActivate: activate });
        };
        if (this.confirmRestart) {
            addBtn('confirmYes', this.confirmRestartButtons.yes, () => {
                this.game.sounds.play('select', 1.0);
                this.game.setState(new MenuState(this.game));
            });
            addBtn('confirmNo', this.confirmRestartButtons.no, () => {
                this.game.sounds.play('click', 0.5);
                this.confirmRestart = false;
                this._gpFocus = { kind: 'button', id: 'shipSelection' };
            });
        } else {
            addBtn('shipSelection', this.pauseButtons.shipSelection, () => {
                this.game.sounds.play('click', 0.5);
                this.confirmRestart = true;
            });
            addBtn('musicDec', this.pauseButtons.musicDec, () => {
                this.game.sounds.setMusicVolume(this.game.sounds.musicVolume - 0.1);
                this.game.sounds.play('click', 0.5);
            });
            addBtn('musicInc', this.pauseButtons.musicInc, () => {
                this.game.sounds.setMusicVolume(this.game.sounds.musicVolume + 0.1);
                this.game.sounds.play('click', 0.5);
            });
            addBtn('sfxDec', this.pauseButtons.sfxDec, () => {
                this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume - 0.1);
                this.game.sounds.play('click', 0.5);
            });
            addBtn('sfxInc', this.pauseButtons.sfxInc, () => {
                this.game.sounds.setSfxVolume(this.game.sounds.sfxVolume + 0.1);
                this.game.sounds.play('click', 0.5);
            });
            addBtn('achievements', this.pauseButtons.achievements, () => {
                this.game.sounds.play('click', 1.0);
                this.game.setState(new AchievementsState(this.game, this));
            });
            if (this.levelUpQueue.length > 0 && this.pauseButtons.claimLevels.w > 0) {
                addBtn('claimLevels', this.pauseButtons.claimLevels, () => {
                    this._levelUpOrigin = 'pause';
                    this._openLevelUpDialog(this.levelUpQueue.shift());
                });
            }
        }

        // While the confirm-restart modal is open, the only valid focus
        // targets are Yes/No — suppress the inventory panels so stick
        // navigation can't fall back into cargo slots.
        const gamepadPanels = this.confirmRestart ? [] : panels;
        this._gamepadInventoryUpdate(dt, gamepadPanels, pauseExtraButtons);

        const mouse = this.game.getMousePos();

        if (this._applyScrollPanels(dt, mouse, panels, 500)) return;

        // Now run the original claim-levels button update with the live mouse
        // (this also handles the mouse-click fallback path).
        this._updateClaimLevelsButton(mouse, 'pause');

        // Hover checks (use current mouse position — which may have been
        // snapped by the gamepad focus code above)
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
                if (pb.achievements.hovered) {
                    this.game.input.consumeMouseButton(0);
                    this.game.sounds.play('click', 1.0);
                    this.game.setState(new AchievementsState(this.game, this));
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
                this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
            } else if (playerInv.tryCombine(this.draggedItem.item, pCol, pRow)) {
                this._celebrateCombine(this.draggedItem.item);
                this._onInventoryChanged();
                this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
            } else if (playerInv.trySwap(this.draggedItem.item, pCol, pRow, this.draggedItem.x, this.draggedItem.y)) {
                this.game.sounds.play('click', 0.5);
                this._onInventoryChanged();
                this._gpFocus = { kind: 'slot', panelKey: 'player', col: pCol, row: pRow };
            } else {
                const worldMouse = this.camera.screenToWorld(mouse.x, mouse.y, this.game.width, this.game.height);
                const dropOffset  = (Math.random() - 0.5) * 20;
                const dropOffset2 = (Math.random() - 0.5) * 20;
                this._dropItemToSpace(this.draggedItem.item, worldMouse.x + dropOffset, worldMouse.y + dropOffset2);
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
        const label = this.game.input.isGamepadActive() ? 'X' : 'E';
        ctx.fillText(label, cw / 2, ch / 2 - 60 * this.game.worldScale);
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

    _onInventoryChanged() {
        const p = this.player;

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

        // Combine-scaled weapon/ability multipliers (default = un-combined behavior)
        p.railgunDmgMult = 1.0;        // ×(1 + bonus) on railgun beam damage
        p.laserOverrideMult = 1.0;     // damage mult when laser override present (1.3 base)
        p.multishotDamageMult = 0;     // sentinel; max() below picks the highest-tier copy (gated by hasMultishotGuns)
        p.controlSpeedMult = 1.0;      // projectile speed mult when control module present (1.2 base)
        p.targetingConeDeg = 10;       // half-cone for targeting module seek
        p.boostDriveMult = 1.0;        // boost-drive thrust mult
        p.repeaterRateBonus = 0;       // extra repeater fire-rate fraction
        this.rocketInterval = 3.0;     // seconds between rockets

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
            if (item.id === 'firing_coordinator') {
                // Combined coordinators carry a tier-scaled bonus; tier-0 = +10%.
                const bonus = item.bonus ?? 0.10;
                fireRateMult *= 1 / (1 + bonus);
            }
            if (item.id === 'energy_canisters') {
                maxHealthMult *= 1 + (item.bonus ?? 0.60);
            }
            if (item.id === 'pulse_boosters') {
                const b = item.bonus ?? 0.40;
                boostRangeMult *= 1 + b;
                boostCooldownMult *= Math.max(0.2, 1 - b * 0.75);
            }
            if (item.id === 'field_array') shieldDrainMult *= Math.max(0.05, 1 - (item.bonus ?? 0.30));
            if (item.id === 'scrap_drone') scrapRangeMult *= 1 + (item.bonus ?? 3.0);
            if (item.id === 'auto_turret') this.hasAutoTurret = true;
            if (item.id === 'mechanical_claw') this.hasMechanicalClaw = true;
            if (item.id === 'railgun') {
                p.hasRailgun = true;
                p.railgunDmgMult = Math.max(p.railgunDmgMult, 1 + (item.bonus ?? 0));
            }
            if (item.id === 'energy_blaster') {
                p.hasEnergyBlaster = true;
                p.energyBlasterCount += 1 + (item.bonus ?? 0);
            }
            if (item.id === 'repeater') {
                p.hasRepeater = true;
                repeaters++;
                p.repeaterRateBonus = Math.max(p.repeaterRateBonus, item.bonus ?? 0);
            }
            if (item.id === 'laser_override') {
                p.hasLaserOverride = true;
                p.laserOverrideMult = Math.max(p.laserOverrideMult, 1 + (item.bonus ?? 0.30));
            }
            if (item.id === 'pulse_jet') p.pulseJetMult *= 1 + (item.bonus ?? 0.15);
            if (item.id === 'shield_booster') p.shieldBoosterMult *= 1 + (item.bonus ?? 0.20);
            if (item.id === 'targeting_module') {
                p.hasTargetingModule = true;
                p.targetingConeDeg = Math.max(p.targetingConeDeg, item.bonus ?? 10);
            }
            if (item.id === 'control_module') {
                p.hasControlModule = true;
                p.controlSpeedMult = Math.max(p.controlSpeedMult, 1 + (item.bonus ?? 0.20));
            }
            if (item.id === 'warning_system') p.hasWarningSystem = true;
            if (item.id === 'mechanical_engines') {
                p.mechanicalEngineTurnMult *= 2.0;
                p.mechanicalEngineSpeedMult *= 1 + (item.bonus ?? 0.25);
            }
            if (item.id === 'multishot_guns') {
                p.hasMultishotGuns = true;
                // Penalty multiplier (<1); higher tier = smaller penalty = higher
                // mult. Reset to 0, so max() prefers the highest-tier copy.
                p.multishotDamageMult = Math.max(p.multishotDamageMult, 1 - (item.bonus ?? 0.30));
            }
            if (item.id === 'high_density_capacitor') boostCooldownMult *= Math.max(0.05, 1 - (item.bonus ?? 0.50));
            if (item.id === 'energy_cell') shieldRegenMult *= 1 + (item.bonus ?? 0.30);
            if (item.id === 'explosives_unit') p.hasExplosivesUnit = true;
            if (item.id === 'small_boosters') p.boostSpeedMult *= 1 + (item.bonus ?? 0.10);
            if (item.id === 'rockets') {
                this.hasRockets = true;
                this.rocketInterval = Math.min(this.rocketInterval, item.bonus ?? 3.0);
            }
            if (item.id === 'ancient_curse') p.hasAncientCurse = true;
            if (item.id === 'boost_drive') {
                p.hasBoostDrive = true;
                p.boostDriveMult = Math.max(p.boostDriveMult, 1 + (item.bonus ?? 0));
            }
            if (item.id === 'momentum_module') {
                p.momentumSpeedMult = 0.75;
                p.momentumMaxSpeedMult = 1.5;
                p.momentumBoostMult = 0.75;
                p.friction = 0.98;
            }
            if (item.id === 'sensor_accelerator') {
                fovMult *= 1 + (item.bonus ?? 0.10);
            }
            if (item.id === 'nanite_tank') p.naniteRegen += (item.bonus ?? 0.6);
            if (item.id === 'shield_capacitor') p.shieldCapacitorCount += (item.bonus ?? 1);
            if (item.id === 'asteroid_accumulator') p.asteroidSpawnMult += (item.bonus ?? 0.5);

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
            if (item.id === 'cargo_expansion') cargoExpansions += (item.bonus ?? 1);
            if (item.id === 'experience_condenser') p.experienceCondenserMult += (item.bonus ?? 0.2);
            if (item.id === 'asteroid_drill') p.asteroidDrillMult += (item.bonus ?? 0.5);
            if (item.id === 'laser_cartridge') p.laserCartridgeMult += (item.bonus ?? 0.1);
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
            // Combined repeaters add extra fire rate (lower mult = faster).
            rMult *= 1 / (1 + p.repeaterRateBonus);
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
        // Compound the epic Luck stat on top of any item-based luck (e.g. cosmos engine).
        p.luck *= p.lvlLuckMult;

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

        if (this.game.achievements) {
            // fovUpgradeMult already composes the sensor_accelerator upgrade with
            // the level-up FOV bonus; pass it so the FOV achievement counts both.
            this.game.achievements.notify('player_stats', { player: p, fovMult: this.fovUpgradeMult });
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

    spawnDistantShop(targetBody = null) {
        // Multiplayer client: only the host may add world objects — ask it to
        // (it spawns the shop near us and broadcasts it back).
        if (this.netSync && !this.netSync.isHost) {
            this.net.send(MSG.SHOP_SPAWN_REQ, {});
            return true;
        }

        // Seeded placement via the shops stream (reproducible).
        const rand = () => this.game.rng ? this.game.rng.shops.next() : Math.random();
        // Random direction
        const angle = rand() * Math.PI * 2;
        // 6,000 to 10,000 pixels away
        const dist = 6000 + rand() * 4000;

        const anchor = targetBody || this.player;
        const sx = anchor.worldX + Math.cos(angle) * dist;
        const sy = anchor.worldY + Math.sin(angle) * dist;

        const newShop = new Shop(this.game, sx, sy);
        this.shops.push(newShop);
        this._revealShop(newShop);
        if (this.netSync) this.netSync.registerShop(newShop);

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


    _spawnEncounter(specificType, targetBody = null) {
        // Encounter type + placement seeded via the encounters stream.
        const er = this.game.rng ? this.game.rng.encounters : null;
        const rand = () => er ? er.next() : Math.random();
        const type = specificType || rollEncounterType(er);
        const angle = rand() * Math.PI * 2;
        const dist = 2000 + rand() * 500;
        const anchor = targetBody || this.player;
        const wx = anchor.worldX + Math.cos(angle) * dist;
        const wy = anchor.worldY + Math.sin(angle) * dist;

        const encounter = new EncounterShip(this.game, wx, wy, type);
        if (this.netSync) {
            // Multiplayer: the dialog is generated lazily by whichever pilot
            // interacts (offers scale with THEIR scrap/inventory). The host
            // simulates the ship against the pilot it spawned for.
            encounter.netTargetPid = (anchor === this.player || !anchor.pid) ? this.netSync.myPid : anchor.pid;
            this.netSync.registerEncounter(encounter);
        } else {
            const dialog = generateEncounterDialog(type, this.player, this);
            encounter.dialogData = dialog;
        }
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
        // Level-up burst off the ship
        this.cinematics.spawnRing(this.player.worldX, this.player.worldY,
            { color: '#ffd24a', maxR: 140, dur: 0.5, width: 3 });
        this._spawnSparks(this.player.worldX, this.player.worldY, 16,
            { color: '#ffd24a', speedMin: 120, speedMax: 360 });
    }

    _openLevelUpDialog(level) {
        // Reuse the cached roll if the player previously Esc'd out of this level,
        // so exiting can't re-roll the choices.
        const savedRoll = this._levelUpRolls[level] || null;
        this.activeLevelUpDialog = new LevelUpDialog(this.game, this.player, this, level, savedRoll);
        this.isLevelUpOpen = true;
        this.paused        = true;
        this.game.sounds.play('scrap', 0.8);
    }

    _openEncounterDialog(encounter) {
        encounter.startInteraction();

        // Multiplayer: dialogs generate at interaction time for whoever locked
        // the encounter, scaled to THEIR scrap/upgrades.
        if (!encounter.dialogData) {
            encounter.dialogData = generateEncounterDialog(encounter.encounterType, this.player, this);
        }

        // Use the dialog that was generated when the encounter spawned
        this.activeEncounterDialog = new EncounterDialog(
            this.game, encounter, encounter.dialogData, this.player, this
        );
        this.isEncounterOpen = true;
        this.paused = true;
        this.game.sounds.play('click', 0.5);

        if (this.game.achievements) {
            this.game.achievements.notify('encounter_dialog_opened', {
                type: encounter.encounterType,
                scenarioId: encounter.dialogData && encounter.dialogData.rawScenario
                    ? encounter.dialogData.rawScenario.id
                    : null
            });
        }
    }

    _convertEncounterToEnemy(encounter) {
        const en = new HostileEncounter(this.game, encounter.worldX, encounter.worldY, this.difficultyScale, encounter.dialogData);

        if (this.game.achievements) {
            this.game.achievements.notify('encounter_converted_hostile', {
                type: encounter.encounterType,
                scenarioId: encounter.dialogData && encounter.dialogData.rawScenario
                    ? encounter.dialogData.rawScenario.id
                    : null
            });
        }

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

        // Grant the player a brief grace window so a freshly-hostile encounter
        // can't instantly damage them at point-blank range.
        this.player.invulnTimer = Math.max(this.player.invulnTimer, 1.5);

        // Give the enemy a matching grace window and have it quickly back away
        // to make some space before engaging.
        en.startEvasiveEntry(this.player, 1.5);
    }

    // Pixel-circle bitmaps for the teammate dots, by diameter in HUD pixels.
    // Drawn cell-by-cell so they stay chunky/crisp like the rest of the HUD.
    static PLAYER_DOT_MASKS = {
        1: [[1]],
        2: [[1, 1], [1, 1]],
        3: [[0, 1, 0], [1, 1, 1], [0, 1, 0]],
        4: [[0, 1, 1, 0], [1, 1, 1, 1], [1, 1, 1, 1], [0, 1, 1, 0]],
        5: [[0, 1, 1, 1, 0], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [1, 1, 1, 1, 1], [0, 1, 1, 1, 0]],
        6: [
            [0, 0, 1, 1, 0, 0],
            [0, 1, 1, 1, 1, 0],
            [1, 1, 1, 1, 1, 1],
            [1, 1, 1, 1, 1, 1],
            [0, 1, 1, 1, 1, 0],
            [0, 0, 1, 1, 0, 0],
        ],
    };

    // Teammate dots — works like the warning sensor's edge dots but with
    // infinite range: a pixel circle in the pilot's color sits on the
    // indicator ring pointing toward them. Size encodes distance in whole HUD
    // pixels: 6px within 1000 units, shrinking to 1px at 25000 (and clamped
    // there — it never disappears, no matter how far they roam). Their name
    // (first 5 characters) sits above the dot.
    _drawPlayerIndicators(ctx) {
        const cw = this.game.width;
        const ch = this.game.height;
        const dt = this.game.lastDt || 0.016;
        const hudScale = this.game.hudScale;

        const NEAR = 1000, FAR = 25000;

        for (const rp of this.netSync.remotePlayers.values()) {
            if (!rp._hasState || rp.isDead) continue;
            const screen = this.camera.worldToScreen(rp.worldX, rp.worldY, cw, ch);

            const dx = rp.worldX - this.player.worldX;
            const dy = rp.worldY - this.player.worldY;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);

            const isOnScreen = screen.x >= 0 && screen.x <= cw && screen.y >= 0 && screen.y <= ch;
            const opacity = this._getIndicatorOpacity(rp, !isOnScreen, dt);
            if (opacity <= 0) continue;

            // 6 HUD pixels at ≤1000 units → 1 at ≥25000, whole pixels only.
            const t = Math.max(0, Math.min(1, (dist - NEAR) / (FAR - NEAR)));
            const sizeUnits = Math.max(1, Math.min(6, Math.round(6 - t * 5)));
            const px = sizeUnits * hudScale;

            const cx = cw / 2;
            const cy = ch / 2;
            const radius = Math.min(cw, ch) * this.indicatorRadiusFactorExclamation;
            const ix = cx + Math.cos(angle) * radius;
            const iy = cy + Math.sin(angle) * radius;
            const color = playerColor(rp.pid);

            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = color;
            // Pixel circle, cell by cell (1 cell = 1 HUD pixel).
            const mask = PlayingState.PLAYER_DOT_MASKS[sizeUnits] || PlayingState.PLAYER_DOT_MASKS[1];
            const originX = Math.floor(ix - px / 2);
            const originY = Math.floor(iy - px / 2);
            for (let r = 0; r < mask.length; r++) {
                for (let c = 0; c < mask[r].length; c++) {
                    if (mask[r][c]) {
                        ctx.fillRect(originX + c * hudScale, originY + r * hudScale, hudScale, hudScale);
                    }
                }
            }

            ctx.font = `${5 * hudScale}px Astro4x`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'alphabetic';
            ctx.fillText(rp.name.toUpperCase().slice(0, 5), ix, Math.floor(iy - px / 2) - Math.floor(hudScale * 2));

            // Distance (Below the dot), matching shop/event indicators.
            ctx.globalAlpha = opacity * 0.7;
            ctx.textBaseline = 'top';
            ctx.fillText(`${Math.floor(dist)}`, ix, Math.floor(iy + px / 2) + Math.floor(hudScale * 2));
            ctx.restore();
        }
    }

    _drawTradeRequestPrompt(ctx) {
        const game = this.game;
        const uiScale = game.uiScale;
        const name = this.net.playerName(this._tradeRequestFrom).toUpperCase();
        const gp = this.game.input.isGamepadActive();
        const text = gp
            ? `${name} WANTS TO TRADE — (A) ACCEPT  (B) DECLINE`
            : `${name} WANTS TO TRADE — [Y] ACCEPT  [N] DECLINE`;
        const y = Math.floor(game.height * 0.22);

        ctx.save();
        ctx.font = `${7 * uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const w = ctx.measureText(text).width + uiScale * 12;
        const h = Math.floor(uiScale * 16);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(game.width / 2 - w / 2, y - h / 2, w, h);
        ctx.strokeStyle = '#44ddff';
        ctx.lineWidth = 1;
        ctx.strokeRect(game.width / 2 - w / 2 + 0.5, y - h / 2 + 0.5, w - 1, h - 1);
        ctx.fillStyle = '#9fe8ff';
        ctx.fillText(text, game.width / 2, y);
        ctx.restore();
    }

    // Join-in-progress (multiplayer): rebuild the entire shared world from the
    // host's snapshot. Mirrors deserialize()'s entity reconstruction, but with
    // network ids so ongoing replication lines up.
    async applyNetJoinSnapshot(snap) {
        const sync = this.netSync;
        // Anything replicated in the gap between connect and this snapshot is
        // already inside the snapshot — start the registry clean.
        sync.byNid.clear();
        this.runSeed = snap.runSeed;
        this.rng = new RandomStreams(this.runSeed);
        this.rng.deserialize(snap.rng);
        this.game.rng = this.rng;

        this.totalGameTime = snap.totalGameTime || 0;
        this.difficultyScale = snap.difficultyScale || 1;
        this.waveTimer = snap.waveTimer != null ? snap.waveTimer : 120;
        this.enemySpawner.waveNumber = snap.waveNumber || 0;
        sync.waveTargetPid = snap.waveTargetPid || 0;

        // Player spawn near the host.
        this.player.worldX = snap.spawnX || 0;
        this.player.worldY = snap.spawnY || 0;
        this.player.invulnTimer = 2.5;
        this.camera.snapTo(this.player);

        // Events (same classes/ordering as the save-file path).
        const EVENT_CLASSES = {
            'CthulhuEvent': CthulhuEvent,
            'CargoShipEvent': CargoShipEvent,
            'FracturedStationEvent': FracturedStationEvent,
            'KnowledgeEvent': KnowledgeEvent,
            'YellowOne': YellowOne
        };
        this.events = [];
        for (const evData of (snap.events || [])) {
            const Cls = EVENT_CLASSES[evData.type];
            if (!Cls) continue;
            let ev;
            if (evData.type === 'FracturedStationEvent') {
                ev = new Cls(this.game, evData.positions || [{ x: evData.worldX, y: evData.worldY }]);
                if (evData.angles) ev.angles = evData.angles;
            } else {
                ev = new Cls(this.game, evData.worldX, evData.worldY);
            }
            if (evData.state !== undefined && evData.state !== null) ev.state = evData.state;
            if (evData.wave !== undefined) ev.wave = evData.wave;
            if (evData.spawnedInitialScrap !== undefined) ev.spawnedInitialScrap = evData.spawnedInitialScrap;
            if (evData.health !== undefined && evData.health !== null) ev.health = evData.health;
            if (evData.maxHealth !== undefined && evData.maxHealth !== null) ev.maxHealth = evData.maxHealth;
            if (evData.isFinished) ev.isFinished = true;
            if (evData.invulnerable !== undefined) ev.invulnerable = evData.invulnerable;
            if (evData.phase1Triggered !== undefined) ev.phase1Triggered = evData.phase1Triggered;
            ev.netId = evData.netId;
            this.events.push(ev);
        }

        // Shops (with their current inventories).
        this.shops = [];
        this.revealedShops = [];
        for (const shopData of (snap.shops || [])) {
            const s = new Shop(this.game, shopData.worldX, shopData.worldY);
            await s.deserialize(shopData);
            s.netId = shopData.netId;
            s.revealed = false; // radar reveals are personal — discover your own
            this.shops.push(s);
        }
        // Always reveal the spawn shop if it's nearby (parity with a fresh run).
        if (this.shops.length) this._revealShop(this.shops[0]);

        // World entities via the same spawn handlers ongoing replication uses.
        this.asteroids = [];
        this.enemies = [];
        this.encounters = [];
        this.caches = [];
        this.scrapEntities = [];
        this.itemPickups = [];
        this.expOrbs = [];
        for (const d of (snap.asteroids || [])) sync._spawnAsteroid(d);
        for (const d of (snap.enemies || [])) sync._spawnEnemy(d);
        for (const d of (snap.encounters || [])) sync._spawnEncounter(d);
        for (const d of (snap.caches || [])) sync._spawnCache(d);
        for (const d of (snap.pickups || [])) sync._spawnPickup(d);

        // Drop into the same song (and playhead) the rest of the lobby is hearing.
        if (snap.music) {
            if (snap.music.mode === 'boss') this.game.sounds.playSpecificMusic(snap.music.key);
            else this.game.sounds.playSyncedTrack(snap.music.mode, snap.music.index, snap.music.pos || 0);
        }

        this._onInventoryChanged();
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
        // Inlined world→screen (hoisted constants) so the per-enemy on-screen
        // test allocates no {x,y} object — matters once a wave fills the list.
        const ws = this.game.worldScale;
        const offX = -this.camera.x * ws + cw / 2 + this.camera.shakeX + this.camera.punchX;
        const offY = -this.camera.y * ws + ch / 2 + this.camera.shakeY + this.camera.punchY;

        // Font/align/baseline + the save/restore are hoisted out of the loop:
        // setting ctx.font re-parses it, which dominated this draw once a wave
        // filled the indicator list. Per-enemy only the colour + alpha change.
        ctx.save();
        ctx.font = `${12 * this.game.uiScale}px Astro5x`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

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

            const screenX = en.worldX * ws + offX;
            const screenY = en.worldY * ws + offY;
            const dist = Math.sqrt(distSq);

            const isOnScreen = screenX >= 0 && screenX <= cw && screenY >= 0 && screenY <= ch;
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
            ctx.globalAlpha = opacity;
            ctx.fillStyle = en.isBoss ? '#ff44ff' : '#ff2222';
            ctx.fillText('!', ix, iy);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
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

            // Draw yellow dot indicator (centered)
            const px = this.game.uiScale * 2;
            ctx.save();
            ctx.globalAlpha = opacity;
            ctx.fillStyle = '#ffff44';
            ctx.fillRect(Math.floor(ix - px / 2), Math.floor(iy - px / 2), px, px);
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

            // Networked drop in multiplayer (clients route through the host).
            this._dropItemToSpace(item, spawnX, spawnY, vx, vy, 1.0); // 1s delay
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

        ctx.textAlign = 'center';
        ctx.fillStyle = '#445566';
        const pauseHint = this.game.input.isGamepadActive()
            ? 'A to pick up/place | Y to use | B to resume'
            : 'Drag to move | Right-click to use | ESC to resume';
        ctx.fillText(pauseHint, cw / 2, ch - uiScale * 8);

        this._drawInventoryTooltip(ctx, [
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

        this._drawPauseVolumeControls(ctx);

        if (!this.confirmRestart) {
            const ss = this.pauseButtons.shipSelection;
            this.game.drawSprite(ctx, ss.hovered ? 'ship_selection_on' : 'ship_selection_off', ss.x, ss.y, uiScale);

            // Achievements text button — visual parity with the main menu's
            // top-right entry. Renders cyan, white on hover, with a small
            // unlock-count hint underneath.
            const ab = this.pauseButtons.achievements;
            ctx.font = `${8 * uiScale}px Astro5x`;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'alphabetic';
            ctx.fillStyle = ab.hovered ? '#ffffff' : '#44ddff';
            ctx.fillText('ACHIEVEMENTS ►', ab.x + ab.w, ab.y + Math.floor(uiScale * 8));
            const mgr = this.game.achievements;
            if (mgr) {
                ctx.font = `${5 * uiScale}px Astro4x`;
                ctx.fillStyle = '#667788';
                ctx.fillText(`${mgr.unlocked.size} / ${ACHIEVEMENTS.length}`, ab.x + ab.w, ab.y + Math.floor(uiScale * 16));
            }
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

        // Selection corners render above all static pause UI so they frame
        // the focused button or inventory slot.
        this._drawGamepadSelection(ctx, [
            { inv: playerInv, layout: playerLayout, scrollXKey: 'playerScrollX', scrollYKey: 'playerScrollY', panelKey: 'player' }
        ]);

        this._drawDraggedItem(ctx, playerLayout.slotSize);
        this._drawCombinePreview(ctx, [
            { inv: playerInv, layout: playerLayout, scrollX: this.playerScrollX, scrollY: this.playerScrollY }
        ]);

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
        //   value = number  → shown as %, reflects level-up bonuses AND upgrades
        //   value = string  → shown as-is, grey at zero / green when active
        //   lowerIsBetter   → green < 100%, red > 100% (drain/cooldown/difficulty stats)
        // Combined stats fold every source together the same way _onInventoryChanged
        // and achievementManager do, so the panel shows the ship's true effective
        // stats — inventory upgrades, level-ups, encounters and ship hull alike.
        const sd = p.shipData;
        const dmgMult = (sd.baseDamage > 0)
            ? ((sd.baseDamage * p.obedienceMult + p.permDamageBonus) * p.laserCartridgeMult) / sd.baseDamage
            : p.laserCartridgeMult;
        const hullMult   = (sd.health > 0) ? p.maxHealth / sd.health : p.maxHealthMult;
        const shieldBase = sd.shield * 15;
        const shieldMult = (shieldBase > 0) ? p.maxShieldEnergy / shieldBase : p.lvlMaxShieldMult;
        const stockSpeed = sd.speed * 100;
        const speedMult  = (stockSpeed > 0)
            ? (p.baseSpeed * p.pulseJetMult * p.mechanicalEngineSpeedMult * p.momentumMaxSpeedMult) / stockSpeed
            : p.lvlSpeedMult;
        const projSpeedMult = p.lvlProjectileSpeedMult * (p.hasControlModule ? p.controlSpeedMult : 1);
        const turnMult      = p.lvlTurnSpeedMult * p.mechanicalEngineTurnMult;
        const expMult       = p.lvlExpGainMult * p.experienceCondenserMult;
        const hullRegen     = p.lvlHpRegen + p.naniteRegen;
        const fovMult       = this.fovUpgradeMult ?? p.lvlFovMult;
        // Guaranteed extra projectiles per volley beyond the single baseline shot
        // (Multishot doubles origins; Energy Blaster fires a 3+ spread per origin).
        const origins   = p.hasMultishotGuns ? 2 : 1;
        const perOrigin = p.hasEnergyBlaster
            ? 3 + Math.max(0, (p.energyBlasterCount || 1) - 1) * 2 + p.lvlExtraProjectiles
            : 1 + p.lvlExtraProjectiles;
        const extraShots = origins * perOrigin - 1;

        const colA = [
            ['Max Hull',      hullMult],
            ['Max Shield',    shieldMult],
            ['Damage',        dmgMult],
            ['Fire Rate',     1 / Math.max(0.01, p.fireRateMult)],       // lower cooldown = higher rate
            ['Proj. Speed',   projSpeedMult],
            ['Shld Drain',    p.shieldDrainMult,           true],        // less drain = good, shown < 100%
            ['Shld Regen',    p.shieldRegenMult],
            ['Shld Impact',   p.lvlShieldDamageMult],
            ['Asteroid Res.', 1 / Math.max(0.01, p.lvlAsteroidResistanceMult)], // less damage taken = higher resistance
            ['Difficulty',    p.lvlDifficultyMult,         true],        // lower difficulty scaling = good
            ['Hull Regen',    `+${hullRegen > 0 ? hullRegen.toFixed(1) : '0.0'}/s`],
            ['Cache Rate',    p.lvlCacheFreqMult],
            ['Enc. Rate',     p.lvlEncounterFreqMult],
        ];
        const colB = [
            ['Ship Speed',     speedMult],
            ['Turn Speed',     turnMult],
            ['Boost Speed',    p.boostSpeedMult],
            ['Boost Duration', p.lvlBoostDurationMult],
            ['Boost Rech.',    1 / Math.max(0.01, p.boostCooldownMult)], // shorter cooldown = faster recharge
            ['Field of View',  fovMult],
            ['Vacuum Range',   p.scrapRangeMult],
            ['Exp Gain',       expMult],
            ['Scrap Chance',   p.asteroidDrillMult],
            ['Ast. Density',   p.asteroidSpawnMult],
            ['Enemy Spawn',    p.lvlEnemySpawnMult,        true],        // fewer enemies = good, shown < 100%
            ['Wave Speed',     1 / Math.max(0.01, p.lvlWaveCountdownMult)], // shorter countdown = faster waves
            ['Extra Shots',    `+${extraShots}`],
            ['Luck',           p.luck],
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
        let damageMult = (p.hasRepeater ? 0.5 : 1.0) * p.laserOverrideMult;
        if (p.hasMultishotGuns) damageMult *= p.multishotDamageMult;

        const currentBaseDamage = (p.shipData.baseDamage * p.obedienceMult + p.permDamageBonus) * p.laserCartridgeMult;

        if (p.hasEnergyBlaster) {
            origins.forEach(origin => {
                const extraCount = (p.energyBlasterCount - 1) * 2;
                // Multi-Shot level-up adds extra beams to the burst
                const count = 3 + Math.floor(Math.random() * 3) + extraCount + p.lvlExtraProjectiles; // 3-5 + 2 per extra + Multi-Shot
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
                // The big gun has recoil — view kicks opposite the beam
                this.camera.punch(-dirX, -dirY, 9);
                this._fireSingleBeam(origin.x, origin.y, dirX, dirY, beamLength, currentBaseDamage * 2.5 * p.railgunDmgMult * damageMult);
                // Extra beams from Multi-Shot level-up — increasing spread, reduced damage
                for (let ei = 0; ei < p.lvlExtraProjectiles; ei++) {
                    const spread = (0.08 + ei * 0.06) * (Math.random() < 0.5 ? 1 : -1);
                    const a = fireAngle + spread;
                    this._fireSingleBeam(origin.x, origin.y, Math.cos(a), Math.sin(a), beamLength, currentBaseDamage * 2.5 * p.railgunDmgMult * damageMult * 0.7);
                }
            });
        }
    }

    _fireSingleBeam(startX, startY, dirX, dirY, length, damage) {
        // Replicate the beam flash to the other pilots (visual only).
        if (this.netSync) {
            this.netSync.queueLocalShot(1, startX, startY, Math.atan2(dirY, dirX), 0, 'blue_laser_ball');
        }

        // vs Asteroids
        for (const ast of this.asteroids) {
            if (!ast.alive) continue;
            if (this._rayIntersectsCircle(startX, startY, dirX, dirY, length, ast.worldX, ast.worldY, ast.radius)) {
                this.game.sounds.play('hit', 0.6);
                if (this._routeDamage(ast, damage)) {
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
                if (this._routeDamage(en, damage)) {
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
                if (this._routeDamage(ev, damage)) {
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
                if (this._routeDamage(en, damage, x, y)) {
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
                if (this._routeDamage(ast, damage, x, y)) {
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
        // Use camera projection for explosions (inlined, allocation-free)
        const cam = this.camera;
        const wtsS = cam.wtsScale, wtsOX = cam.wtsOffX, wtsOY = cam.wtsOffY;

        for (const exp of this.explosions) {
            const progress = 1.0 - (exp.timer / exp.maxTimer);
            const frameIndex = Math.min(Math.floor(progress * frames.length), frames.length - 1);
            const img = frames[frameIndex].canvas;

            ctx.globalAlpha = 1.0; // GIF contains its own alpha typically, or we can fade it slightly
            const size = baseSize * this.game.worldScale;

            // screen coordinates via camera
            const sx = exp.worldX * wtsS + wtsOX;
            const sy = exp.worldY * wtsS + wtsOY;

            ctx.drawImage(img, sx - size / 2, sy - size / 2, size, size);
        }
        ctx.restore();
    }

    _drawSparks(ctx) {
        if (!this.sparks || this.sparks.length === 0) return;

        // One logical pixel, rounded to whole screen pixels so blocks stay crisp
        // and match the chunky scale of the game's sprites.
        const pix = Math.max(1, Math.round(this.game.worldScale));
        const W = this.game.width, H = this.game.height;

        ctx.save();
        ctx.imageSmoothingEnabled = false;

        const cam = this.camera;
        const wtsS = cam.wtsScale, wtsOX = cam.wtsOffX, wtsOY = cam.wtsOffY;
        for (const s of this.sparks) {
            const scrX = s.worldX * wtsS + wtsOX;
            const scrY = s.worldY * wtsS + wtsOY;
            if (scrX < -20 || scrX > W + 20 || scrY < -20 || scrY > H + 20) continue;

            const t = Math.max(0, s.life / s.maxLife);
            const blockSize = s.size * pix;

            // Trail is a row of discrete pixel blocks stepping back along the
            // velocity (one logical pixel per step) — longer when fast, shorter
            // as the spark slows and dies.
            const vmag = Math.hypot(s.vx, s.vy) || 1;
            const stepX = -(s.vx / vmag) * pix;
            const stepY = -(s.vy / vmag) * pix;
            const trail = Math.max(0, Math.min(4, Math.round((vmag / 220) * (0.3 + t))));
            const headAlpha = Math.min(1, t * 2.2); // hold bright, fade only at the end

            ctx.fillStyle = s.color;
            for (let i = trail; i >= 0; i--) {
                ctx.globalAlpha = headAlpha * (1 - i / (trail + 1));
                // Snap each block to the logical-pixel grid for crisp edges
                const px = Math.round((scrX + stepX * i) / pix) * pix;
                const py = Math.round((scrY + stepY * i) / pix) * pix;
                ctx.fillRect(px, py, blockSize, blockSize);
            }
        }
        ctx.globalAlpha = 1;
        ctx.restore();
    }

    // --- Death System ---

    _triggerDeath() {
        this.isDead = true;
        this.player.alive = false;
        this.deathTimer = 0;
        this.game.sounds.stopMusic();
        this.game.sounds.play('ship_explode', 0.8);

        if (this.game.achievements) {
            this.game.achievements.notify('run_ended', { time: this.trueTotalTime, stats: this.stats });
        }

        // Multiplayer: announce it and arm the respawn cooldown.
        if (this.net) {
            this._respawnCooldown = 10.0;
            if (this.net.isHost) {
                const info = this.net.players.get(0);
                if (info) info.alive = false;
                this.net.broadcast(MSG.PLAYER_DIED, { pid: 0 });
            } else {
                this.net.send(MSG.PLAYER_DIED, {});
            }
        }

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

        const input = this.game.input;
        const gamepadActive = input.isGamepadActive();
        // Buttons are hidden (and therefore not interactive) during the Yellow
        // One scripted death sequence.
        const buttonsActive = !this.yellowOneDeathScreen;

        const fa = this.deathScreenButtons.flyAgain;
        const ss = this.deathScreenButtons.shipSelection;

        // Mouse hover detection
        const faMouse = mouse.x >= fa.x && mouse.x <= fa.x + fa.w && mouse.y >= fa.y && mouse.y <= fa.y + fa.h;
        const ssMouse = mouse.x >= ss.x && mouse.x <= ss.x + ss.w && mouse.y >= ss.y && mouse.y <= ss.y + ss.h;

        // Gamepad/keyboard navigation between the two buttons.
        if (buttonsActive && gamepadActive) {
            if (input.isGamepadJustPressed(GP.DLEFT))  this._stepDeathSelection(-1);
            if (input.isGamepadJustPressed(GP.DRIGHT)) this._stepDeathSelection(1);

            const sx = input.leftStickX;
            if (Math.abs(sx) > 0.55) {
                if (!this._deathStickLatched) {
                    this._deathStickLatched = true;
                    this._stepDeathSelection(sx < 0 ? -1 : 1);
                }
            } else if (Math.abs(sx) < 0.25) {
                this._deathStickLatched = false;
            }
        }

        // When the gamepad is the active device the selected index drives the
        // highlight; otherwise the mouse does.
        fa.hovered = gamepadActive ? (this.deathScreenSelected === 0) : faMouse;
        ss.hovered = gamepadActive ? (this.deathScreenSelected === 1) : ssMouse;

        const flyAgain = () => {
            if (this.net) {
                // Multiplayer: respawn into the SAME shared world with a fresh
                // ship (your run ended; the world didn't).
                if (this._respawnCooldown > 0) {
                    this.game.sounds.play('click', 0.4);
                    return;
                }
                this.game.sounds.play('select', 1.0);
                this._netRespawn();
                return;
            }
            this.game.sounds.play('select', 1.0);
            this.game.setState(new PlayingState(this.game, this.shipData));
        };
        const shipSelection = () => {
            // Multiplayer: leaving the death screen leaves the session
            // (exit() tears the connection down).
            this.game.sounds.play('select', 1.0);
            this.game.setState(new MenuState(this.game));
        };

        if (buttonsActive) {
            if (input.isMouseJustPressed(0)) {
                if (faMouse) flyAgain();
                else if (ssMouse) shipSelection();
            }

            // Gamepad A confirms the selected button.
            if (gamepadActive && input.isGamepadJustPressed(GP.A)) {
                if (this.deathScreenSelected === 0) flyAgain();
                else shipSelection();
            }
        }
    }

    _stepDeathSelection(dir) {
        this.deathScreenSelected = (this.deathScreenSelected + dir + 2) % 2;
        this.game.sounds.play('click', 0.5);
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

            // Multiplayer: FLY AGAIN = respawn into the shared world (after a
            // short cooldown); SHIP SELECTION leaves the session.
            if (this.net && this._respawnCooldown > 0) {
                ctx.save();
                ctx.globalAlpha = 0.45;
                this.game.drawSprite(ctx, 'fly_again_off', fa.x, fa.y, uiScale);
                ctx.restore();
                ctx.fillStyle = '#9fe8ff';
                ctx.font = `${6 * uiScale}px Astro4x`;
                ctx.textAlign = 'center';
                ctx.fillText(`RESPAWN IN ${Math.ceil(this._respawnCooldown)}`, fa.x + fa.w / 2, fa.y - Math.floor(uiScale * 4));
            } else {
                this.game.drawSprite(ctx, fa.hovered ? 'fly_again_on' : 'fly_again_off', fa.x, fa.y, uiScale);
                if (this.net) {
                    ctx.fillStyle = '#9fe8ff';
                    ctx.font = `${6 * uiScale}px Astro4x`;
                    ctx.textAlign = 'center';
                    ctx.fillText('RESPAWN (FRESH SHIP)', fa.x + fa.w / 2, fa.y - Math.floor(uiScale * 4));
                }
            }
            this.game.drawSprite(ctx, ss.hovered ? 'ship_selection_on' : 'ship_selection_off', ss.x, ss.y, uiScale);
            if (this.net) {
                ctx.fillStyle = '#667788';
                ctx.font = `${6 * uiScale}px Astro4x`;
                ctx.textAlign = 'center';
                ctx.fillText('LEAVE WORLD', ss.x + ss.w / 2, ss.y - Math.floor(uiScale * 4));
            }

            if (this.game.input.isGamepadActive()) {
                ctx.fillStyle = '#667788';
                ctx.font = `${6 * uiScale}px Astro4x`;
                ctx.textAlign = 'center';
                ctx.fillText('A to confirm', cw / 2, fa.y + fa.h + Math.floor(uiScale * 10));
            }
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
