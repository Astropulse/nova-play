import { SaveManager } from '../engine/saveManager.js';
import { formatSeed, parseSeed, randomSeed } from '../engine/rng.js';

export class DevConsole {
    constructor(game) {
        this.game = game;
        this.active = false;
        this.inputBuffer = '';
        this.history = [];
        this.historyIndex = -1;
        this.cursorTimer = 0;
        this.showCursor = true;

        this.commands = {
            'time': (args) => this._cmdTime(args),
            'spawn': (args) => this._cmdSpawn(args),
            'enemy': (args) => this._cmdEnemy(args),
            'stat': (args) => this._cmdStat(args),
            'wave': (args) => this._cmdWave(args),
            'scrap': (args) => this._cmdScrap(args),
            'exp': (args) => this._cmdExp(args),
            'locate': (args) => this._cmdLocate(args),
            'save': () => this._cmdSave(),
            'load': () => this._cmdLoad(),
            'record': (args) => this._cmdRecord(args),
            'boss': (args) => this._cmdBoss(args),
            'hp': () => this._cmdHP(),
            'encounter': (args) => this._cmdEncounter(args),
            'cache': (args) => this._cmdCache(args),
            'seed': (args) => this._cmdSeed(args),
            'diff': (args) => this._cmdDiff(args),
            'dev': () => this._cmdDev(),
            'fps_uncap': () => this._cmdFPSUncap(),
            'perf': () => this._cmdPerf(),
            'split': (args) => this._cmdSplit(args),
            'coop': (args) => this._cmdSplit(args),
            'help': () => this._cmdHelp()
        };

        this._keydownListener = (e) => this._handleKeydown(e);
        window.addEventListener('keydown', this._keydownListener);
    }

    destroy() {
        window.removeEventListener('keydown', this._keydownListener);
    }

    toggle() {
        this.active = !this.active;
        if (this.active) {
            this.inputBuffer = '';
            this.historyIndex = -1;
            this.game.sounds.play('click', 0.5);
        }
    }

    update(dt) {
        if (!this.active) return;

        this.cursorTimer += dt;
        if (this.cursorTimer >= 0.5) {
            this.cursorTimer = 0;
            this.showCursor = !this.showCursor;
        }

        const input = this.game.input;

        // Command history navigation
        if (input.isKeyJustPressed('ArrowUp')) {
            if (this.history.length > 0) {
                this.historyIndex = Math.min(this.historyIndex + 1, this.history.length - 1);
                this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
            }
        } else if (input.isKeyJustPressed('ArrowDown')) {
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.inputBuffer = this.history[this.history.length - 1 - this.historyIndex];
            } else {
                this.historyIndex = -1;
                this.inputBuffer = '';
            }
        }
    }

    _handleKeydown(e) {
        if (!this.active) return;

        if (e.key === 'Enter') {
            this._executeCommand();
        } else if (e.key === 'Backspace') {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
        } else if (e.key === 'Escape') {
            this.active = false;
        } else if (e.key.length === 1) {
            this.inputBuffer += e.key;
        } else {
            return;
        }
        // Swallow the keystroke from the polled InputManager too, so closing the
        // console with Enter/Escape doesn't leak into gameplay a frame later
        // (e.g. Enter opening the multiplayer chat, Escape toggling pause).
        if (this.game.input) this.game.input.consumeKey(e.code);
        e.preventDefault();
        e.stopPropagation();
    }

    _executeCommand() {
        const fullCmd = this.inputBuffer.trim();
        if (fullCmd) {
            this.history.push(fullCmd);
            this.historyIndex = -1;

            const parts = fullCmd.split(' ');
            const cmdName = parts[0].toLowerCase();
            const args = parts.slice(1);

            if (this.commands[cmdName]) {
                this.commands[cmdName](args);
            } else {
                console.log(`Unknown command: ${cmdName}`);
            }
        }
        this.inputBuffer = '';
        this.active = false;
    }

    // Print the live difficulty (no args), or pin it to a value by solving for
    // the totalGameTime that produces it (difficulty is recomputed every frame
    // from game time + player power, so setting the scale directly wouldn't
    // stick). `diff 20` → jumps the run clock so difficultyScale ≈ 20.
    _cmdDiff(args) {
        const state = this.game.currentState;
        if (!state || state.difficultyScale === undefined) { console.log('Not in a run.'); return; }

        if (args.length >= 1) {
            const target = parseFloat(args[0]);
            if (isNaN(target) || target < 1) { console.log('Usage: diff [value >= 1]'); return; }
            const power = state._calculatePlayerPowerLevel ? state._calculatePlayerPowerLevel() : 0;
            const rampMax = state.difficultyGain * Math.pow(state.difficultyRampTime, state.difficultyExponent);
            // Invert the steady-phase formula; clamp into the steady phase.
            const t = Math.max(state.difficultyRampTime + 1,
                state.difficultyRampTime + (target - 1 - rampMax - power) / state.difficultySteadyRate);
            this._cmdTime([String(Math.round(t))]);
        }

        const d = state.difficultyScale;
        const power = state._calculatePlayerPowerLevel ? state._calculatePlayerPowerLevel() : 0;
        console.log(`difficultyScale = ${d.toFixed(2)}  (gameTime ${Math.round(state.totalGameTime)}s, playerPower ${power.toFixed(2)})`);
        console.log(`  → Seraph/Wheels pool at this diff: ${Math.round(4200 + 1000 * d)}  |  YellowOne: ${Math.round(2000 + 400 * d)}  |  Hive: ${Math.round(5200 + 1200 * d)} (+Mother ${Math.round(2800 + 650 * d)})`);
    }

    _cmdTime(args) {
        if (args.length < 1) return;
        const time = parseFloat(args[0]);
        const state = this.game.currentState;
        if (!isNaN(time) && state && state.totalGameTime !== undefined) {
            state.totalGameTime = time;
            state.trueTotalTime = time;

            // Recalculate difficultyScale immediately
            let timeScale = 1.0;
            if (time <= state.difficultyRampTime) {
                timeScale += (state.difficultyGain * (state.player?.lvlDifficultyMult || 1) * Math.pow(time, state.difficultyExponent));
            } else {
                const rampMax = state.difficultyGain * Math.pow(state.difficultyRampTime, state.difficultyExponent);
                const steadyTime = time - state.difficultyRampTime;
                timeScale += rampMax + (state.difficultySteadyRate * steadyTime);
            }
            const powerLevel = state._calculatePlayerPowerLevel ? state._calculatePlayerPowerLevel() : 0;
            state.difficultyScale = timeScale + powerLevel;

            // Reset wave state to match new time
            const waveInterval = 120 * (state.player?.lvlWaveCountdownMult || 1);
            const expectedWaves = Math.floor(time / waveInterval);
            if (state.enemySpawner) {
                state.enemySpawner.waveNumber = expectedWaves;
            }
            state.waveTimer = waveInterval - (time % waveInterval);
        }
    }

    _cmdSpawn(args) {
        if (args.length < 1) return;
        const upgradeId = args[0];
        const state = this.game.currentState;
        if (state && state.player && state.player.inventory) {
            import('../data/upgrades.js').then(({ UPGRADES }) => {
                const upgradeData = UPGRADES.find(u => u.id === upgradeId);
                if (upgradeData) {
                    if (!state.player.inventory.autoAdd(upgradeData)) {
                        // If inventory full, maybe drop as ItemPickup?
                        // For now just console log
                        console.log("Inventory full, could not spawn upgrade.");
                    } else {
                        if (state._onInventoryChanged) state._onInventoryChanged();
                    }
                }
            });
        }
    }

    // enemy <type> [count] [upgrade...] — spawn enemies near the player for testing.
    //   types:    basic, upgraded, kamikaze, cthulhu, nanite, drone
    //   upgrades: health, speed, firerate, bigBall, beam, multishot, kamikaze
    //   examples: "enemy nanite 3"        spawn 3 nanite carriers
    //             "enemy basic 1 beam"    one basic enemy with the beam upgrade
    //             "enemy basic 2 health speed"  two enemies with both upgrades
    //             "enemy upgraded 5"      five enemies with a random upgrade each
    _cmdEnemy(args) {
        const state = this.game.currentState;
        if (!state || !state.player || !state._addEnemies) { console.log('No active game.'); return; }

        import('../entities/enemy.js').then((mod) => {
            const classMap = {
                basic: mod.Enemy, regular: mod.Enemy, enemy: mod.Enemy, upgraded: mod.Enemy,
                kamikaze: mod.KamikazeEnemy, cthulhu: mod.CthulhuEnemy,
                nanite: mod.NaniteEnemy, drone: mod.NaniteDrone, shield: mod.ShieldEnemy,
                missile: mod.MissileEnemy, blink: mod.BlinkEnemy, berserk: mod.BerserkEnemy,
                scavenger: mod.ScavengerEnemy, scav: mod.ScavengerEnemy,
            };
            const upgradeNames = mod.Enemy.UPGRADE_TYPES;

            if (!args.length || ['help', 'list'].includes(args[0].toLowerCase())) {
                console.log('usage: enemy <type> [count] [upgrade...]');
                console.log('  types:    ' + Object.keys(classMap).join(', '));
                console.log('  upgrades: ' + upgradeNames.join(', '));
                console.log('  e.g. "enemy nanite 3", "enemy basic 1 beam", "enemy upgraded 5"');
                return;
            }

            const type = args[0].toLowerCase();
            const Cls = classMap[type];
            if (!Cls) { console.log(`Unknown enemy type: ${type} (try "enemy list")`); return; }

            // Optional count (first trailing integer), then upgrade names.
            let rest = args.slice(1);
            let count = 1;
            if (rest.length && /^\d+$/.test(rest[0])) { count = Math.max(1, Math.min(100, parseInt(rest[0]))); rest = rest.slice(1); }
            const upgrades = rest.filter(u => upgradeNames.includes(u));
            const bad = rest.filter(u => !upgradeNames.includes(u));
            if (bad.length) console.log(`Ignoring unknown upgrades: ${bad.join(', ')}`);

            const ds = state.difficultyScale || 1.0;
            const spawned = [];
            for (let i = 0; i < count; i++) {
                const ang = Math.random() * Math.PI * 2;
                const dist = 450 + Math.random() * 250;
                const en = new Cls(
                    this.game,
                    state.player.worldX + Math.cos(ang) * dist,
                    state.player.worldY + Math.sin(ang) * dist,
                    ds
                );
                if (upgrades.length) {
                    for (const u of upgrades) en.applyUpgrade(u);
                } else if (type === 'upgraded' && en._applyUpgrades) {
                    en._applyUpgrades(); // seeded random upgrade
                }
                spawned.push(en);
            }
            state._addEnemies(spawned);
            const note = upgrades.length ? ` [${upgrades.join('+')}]` : (type === 'upgraded' ? ' [random upgrade]' : '');
            console.log(`Spawned ${count} ${type}${note}`);
        });
    }

    _cmdStat(args) {
        if (args.length < 1) return;
        const stat = args[0].toLowerCase();

        const p = this.game.currentState?.player;
        if (!p) return;

        // Handle 'cargo' which can be 'stat cargo 1,4' or 'stat cargo 1 4'
        if (stat === 'cargo' && args.length >= 2) {
            const parts = args.slice(1).join(' ').split(/[\s,]+/).filter(p => p.length > 0);
            if (parts.length >= 2) {
                const cols = parseInt(parts[0]);
                const rows = parseInt(parts[1]);
                if (!isNaN(cols) && !isNaN(rows)) {
                    const state = this.game.currentState;
                    if (state) {
                        state.inventoryCols = Math.max(1, cols);
                        state.inventoryRows = Math.max(1, rows);
                    }
                    const ejected = p.inventory.resize(Math.max(1, cols), Math.max(1, rows));
                    if (state && state._ejectItems && ejected && ejected.length > 0) {
                        state._ejectItems(ejected);
                    }
                    if (state._onInventoryChanged) {
                        state._onInventoryChanged();
                    }
                }
            }
            return;
        }

        if (args.length < 2) return;
        const value = parseFloat(args[1]);
        if (isNaN(value)) return;

        switch (stat) {
            case 'scrap': p.scrap = value; break;
            case 'health': p.health = value; p.maxHealth = Math.max(p.health, p.maxHealth); break;
            case 'speed': p.speedMult = value; break;
            case 'shield': p.maxShieldEnergy = value; p.shieldEnergy = value; break;
            case 'rows':
            case 'cargo_rows':
                {
                    const state = this.game.currentState;
                    if (state) state.inventoryRows = Math.max(1, Math.floor(value));
                    const ejected = p.inventory.resize(p.inventory.cols, Math.max(1, Math.floor(value)));
                    if (state && state._ejectItems && ejected && ejected.length > 0) state._ejectItems(ejected);
                }
                break;
            case 'cols':
            case 'cargo_cols':
                {
                    const state = this.game.currentState;
                    if (state) state.inventoryCols = Math.max(1, Math.floor(value));
                    const ejected = p.inventory.resize(Math.max(1, Math.floor(value)), p.inventory.rows);
                    if (state && state._ejectItems && ejected && ejected.length > 0) state._ejectItems(ejected);
                }
                break;
        }

        if (this.game.currentState._onInventoryChanged) {
            this.game.currentState._onInventoryChanged();
        }
    }

    _cmdWave(args) {
        if (args.length < 1) return;
        const time = parseFloat(args[0]);
        if (!isNaN(time) && this.game.currentState && this.game.currentState.waveTimer !== undefined) {
            this.game.currentState.waveTimer = time;
        }
    }

    _cmdScrap(args) {
        if (args.length < 1) return;
        const amount = parseFloat(args[0]);
        const p = this.game.currentState?.player;
        if (!isNaN(amount) && p) {
            p.scrap = (p.scrap || 0) + amount;
        }
    }

    _cmdExp(args) {
        if (args.length < 1) return;
        const amount = parseFloat(args[0]);
        const p = this.game.currentState?.player;
        if (!isNaN(amount) && p && p.addExp) {
            p.addExp(amount);
        }
    }

    _cmdLocate(args) {
        const state = this.game.currentState;
        if (!state || !state.events) return;

        if (args.length < 1) {
            console.log("Locate requires an event type: knowledge, cthulhu, station, cargo, yellowone, seraph, wheels, hive");
            return;
        }

        const type = args[0].toLowerCase();
        let targetEvent = null;

        for (const ev of state.events) {
            const name = ev.constructor ? ev.constructor.name.toLowerCase() : '';
            if (type === 'knowledge' && name.includes('knowledge')) targetEvent = ev;
            else if (type === 'cthulhu' && name.includes('cthulhu')) targetEvent = ev;
            else if (type === 'station' && name.includes('station')) targetEvent = ev;
            else if (type === 'cargo' && name.includes('cargo')) targetEvent = ev;
            else if ((type === 'yellowone' || type === 'yellow') && name.includes('yellow')) targetEvent = ev;
            else if (type === 'seraph' && name.includes('seraph')) targetEvent = ev;
            else if (type === 'wheels' && name.includes('wheels')) targetEvent = ev;
            else if (type === 'hive' && name.includes('hive')) targetEvent = ev;
        }

        if (targetEvent) {
            targetEvent.revealed = true;
            console.log(`Signal activated for ${targetEvent.constructor.name} at ${Math.floor(targetEvent.worldX)}, ${Math.floor(targetEvent.worldY)}`);
        } else {
            console.log(`Could not find event of type: ${type}`);
        }
    }

    _cmdSave() {
        if (this.game.net) { console.log('Save/load is disabled in multiplayer.'); return; }
        SaveManager.save(this.game.currentState);
    }

    _cmdLoad() {
        if (this.game.net) { console.log('Save/load is disabled in multiplayer.'); return; }
        SaveManager.load(this.game);
    }

    _cmdBoss(args) {
        if (args.length < 1) return;
        const bossId = args[0].toLowerCase();
        const state = this.game.currentState;
        if (state && state.player) {
            if (bossId === 'starcore') {
                import('../entities/starcore.js').then(({ Starcore }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1200;
                    const boss = new Starcore(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist,
                        state.difficultyScale
                    );
                    if (state._addEnemies) state._addEnemies([boss]); else state.enemies.push(boss);
                    state.triggerFlash('#ffffff', 1.2, 0.5);
                    this.game.sounds.playSpecificMusic(boss.musicKey || 'Starcore Showdown');
                });
            } else if (bossId === 'asteroid_crusher' || bossId === 'crusher') {
                import('../entities/asteroidCrusher.js').then(({ AsteroidCrusher }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1200;
                    const boss = new AsteroidCrusher(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist,
                        state.difficultyScale
                    );
                    if (state._addEnemies) state._addEnemies([boss]); else state.enemies.push(boss);
                    state.triggerFlash('#ffffff', 1.2, 0.5);
                    this.game.sounds.playSpecificMusic(boss.musicKey || 'Asteroid Crusher');
                });
            } else if (bossId === 'event_horizon' || bossId === 'horizon') {
                import('../entities/eventHorizon.js').then(({ EventHorizon }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1200;
                    const boss = new EventHorizon(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist,
                        state.difficultyScale
                    );
                    if (state._addEnemies) state._addEnemies([boss]); else state.enemies.push(boss);
                    state.triggerFlash('#ffffff', 1.2, 0.5);
                    this.game.sounds.playSpecificMusic(boss.musicKey || 'Event Horizon Chase');
                });
            } else if (bossId === 'seraph') {
                // Event-based boss: spawns into the events list, fight starts on
                // approach (like finding it in the wild post-Yellow One).
                import('../entities/seraph.js').then(({ Seraph }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1600;
                    const seraph = new Seraph(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist
                    );
                    seraph.revealed = true;
                    state.events.push(seraph);
                    console.log(`Seraph spawned at ${Math.floor(seraph.worldX)}, ${Math.floor(seraph.worldY)}`);
                });
            } else if (bossId === 'wheels') {
                // Event-based boss: spawns into the events list, fight starts on
                // approach (like finding it in the wild post-Seraph).
                import('../entities/wheels.js').then(({ Wheels }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 1600;
                    const wheels = new Wheels(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist
                    );
                    wheels.revealed = true;
                    state.events.push(wheels);
                    console.log(`Wheels spawned at ${Math.floor(wheels.worldX)}, ${Math.floor(wheels.worldY)}`);
                });
            } else if (bossId === 'hive' || bossId === 'swarm') {
                // Event-based boss: the whole swarm encounter (hive + mother +
                // locust brood manifest on approach; fight starts near/on hit).
                import('../entities/swarm.js').then(({ Hive }) => {
                    const angle = Math.random() * Math.PI * 2;
                    const dist = 2400;
                    const hive = new Hive(
                        this.game,
                        state.player.worldX + Math.cos(angle) * dist,
                        state.player.worldY + Math.sin(angle) * dist
                    );
                    hive.revealed = true;
                    state.events.push(hive);
                    console.log(`Hive spawned at ${Math.floor(hive.worldX)}, ${Math.floor(hive.worldY)}`);
                });
            }
        }
    }

    _cmdHP() {
        this.game.showHealth = !this.game.showHealth;
        console.log(`Health indicators ${this.game.showHealth ? 'ENABLED' : 'DISABLED'}`);
    }

    _cmdRecord(args) {
        this.game.recordingEnabled = !this.game.recordingEnabled;
        console.log(`Recording feature ${this.game.recordingEnabled ? 'ENABLED' : 'DISABLED'}`);
    }

    _cmdEncounter(args) {
        const state = this.game.currentState;
        if (!state || !state._spawnEncounter) {
            console.log('Not in playing state');
            return;
        }
        const type = args.length > 0 ? args.join('_') : null;
        const validTypes = ['cargo_trader', 'civilian', 'colony', 'engineer', 'explorer', 'junker', 'law_enforcement', 'black_market', 'tuner'];
        if (type && !validTypes.includes(type)) {
            console.log(`Unknown type. Valid: ${validTypes.join(', ')}`);
            return;
        }
        state._spawnEncounter(type);
        console.log(`Spawned encounter: ${type || 'random'}`);
    }

    _cmdDev() {
        this.game.devMode = !this.game.devMode;
        console.log(`Developer mode ${this.game.devMode ? 'ENABLED' : 'DISABLED'}`);
    }

    _cmdFPSUncap() {
        console.log("FPS uncapping is currently handled by potential FPS monitoring. Logic simulation remains locked to 120Hz for stability.");
    }

    _cmdPerf() {
        this.game.devMode = !this.game.devMode;
        if (this.game.devMode) {
            console.log(`Performance monitoring ENABLED. Potential FPS: ${this.game.potentialFps}`);
        } else {
            console.log("Performance monitoring DISABLED.");
        }
    }

    _cmdCache(args) {
        const state = this.game.currentState;
        if (!state || !state.player || !state.cacheSpawner) {
            console.log('Not in playing state');
            return;
        }
        // Optional: "cache luck 2.5" sets player luck
        if (args.length >= 2 && args[0].toLowerCase() === 'luck') {
            const val = parseFloat(args[1]);
            if (!isNaN(val)) {
                state.player.luck = val;
                console.log(`Player luck set to ${val}`);
            }
            return;
        }
        const cache = state.cacheSpawner.spawnNear(state.player.worldX, state.player.worldY, 200, 400);
        state.caches.push(cache);
        console.log(`Spawned cache at ${Math.floor(cache.worldX)}, ${Math.floor(cache.worldY)}`);
    }

    // /seed                — print both the world (background) and run seeds
    // /seed <n>             — set the gameplay run seed (0 = randomize)
    // /seed world <n>       — set the background world seed (0 = randomize)
    // Seeds display as 8 digits, zero-padded; smaller inputs are accepted.
    _cmdSeed(args) {
        const state = this.game.currentState;

        // No args: report both.
        if (args.length < 1) {
            const world = this.game.worldSeed != null ? formatSeed(this.game.worldSeed) : '(unset)';
            const run = state && state.runSeed != null ? formatSeed(state.runSeed) : '(no run)';
            console.log(`Seeds — World: ${world}  Run: ${run}`);
            return;
        }

        // /seed world [n]
        if (args[0].toLowerCase() === 'world') {
            let val;
            if (args.length < 2) {
                console.log(`World seed: ${formatSeed(this.game.worldSeed ?? randomSeed())}`);
                return;
            }
            const parsed = parseSeed(args[1]);
            if (parsed === null) {
                console.log(`Invalid seed: ${args[1]}`);
                return;
            }
            val = parsed === 0 ? randomSeed() : parsed;
            this.game.worldSeed = val;
            // Rebuild the starfield immediately if we're on the title screen.
            if (state && typeof state.rebuildWorld === 'function') {
                state.rebuildWorld();
                console.log(`World seed set to ${formatSeed(val)} (starfield rebuilt)`);
            } else {
                console.log(`World seed set to ${formatSeed(val)} (applies to next title screen)`);
            }
            return;
        }

        // /seed <n> — run seed
        const parsed = parseSeed(args[0]);
        if (parsed === null) {
            console.log(`Invalid seed: ${args[0]}`);
            return;
        }
        const val = parsed === 0 ? randomSeed() : parsed;
        if (!state || typeof state.reseedRun !== 'function') {
            console.log('Not in a run — start a flight first, or use "/seed world <n>".');
            return;
        }
        // Rebuild the procedural world (events/shops/asteroids/spawners) from
        // the new seed and snap the player to spawn, so the same seed always
        // produces the same layout.
        state.reseedRun(val);
        console.log(`Run seed set to ${formatSeed(val)} (world rebuilt)`);
    }

    // Local split-screen co-op: `coop <n>` (alias `split <n>`) sets the local
    // pilot count 1–8. Spawns real Player bodies on a ring and fans the render
    // into one pane per pilot. 1 = normal single view.
    _cmdSplit(args) {
        const state = this.game.currentState;
        if (!state || !state.setCoopCount) {
            console.log('coop: only available during a run');
            return;
        }
        const n = args.length ? parseInt(args[0], 10) : 1;
        if (isNaN(n)) { console.log('usage: coop <1-8>'); return; }
        const applied = state.setCoopCount(n);
        console.log(`coop: ${applied} pilot(s)`);
    }

    _cmdHelp() {
        console.log("Available commands: time, spawn, stat, wave, scrap, exp, locate, save, load, record, boss, hp, encounter, cache, seed, dev, perf, split, help");
    }

    draw(ctx) {
        if (!this.active) return;

        ctx.save();

        const cw = this.game.width;
        const ch = this.game.height;
        const h = 40 * this.game.uiScale;

        ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.fillRect(0, ch - h, cw, h);

        ctx.strokeStyle = '#00ff00';
        ctx.lineWidth = 2;
        ctx.strokeRect(0, ch - h, cw, h);

        ctx.fillStyle = '#00ff00';
        ctx.font = `${12 * this.game.uiScale}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        let text = '> ' + this.inputBuffer;
        if (this.showCursor) text += '_';

        ctx.fillText(text, 20, ch - h / 2);

        ctx.restore();
    }
}
