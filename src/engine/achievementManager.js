import { ACHIEVEMENTS } from '../data/achievements.js';

// Sliding-window length used by "N kills in K seconds" checks.
const KILL_WINDOW_SECONDS = 10;

export class AchievementManager {
    static STORAGE_KEY = 'nova_achievements';

    constructor(game) {
        this.game = game;

        this.lifetime = this._newLifetimeState();
        this.run = this._newRunState();
        this.unlocked = new Set();

        // Toast display state — HUD pulls one off at a time and runs the
        // slide/fade animation. We keep a small queue so back-to-back unlocks
        // don't get dropped.
        this.toastQueue = [];
        this.currentToast = null;
        this.currentToastTime = 0;
        this.TOAST_DURATION = 4.5;

        this._load();
    }

    // Lifetime totals — persisted to localStorage. Survive deaths and new
    // ships. Map-shaped fields (bossesDefeated, eventTypes, asteroidsByType,
    // enemyKillsByClass, upgradesById) are plain {id: count} objects so JSON
    // round-trips cleanly.
    _newLifetimeState() {
        return {
            enemiesKilled: 0,
            asteroidsDestroyed: 0,
            scrapCollected: 0,
            wavesCleared: 0,
            eventsDiscovered: 0,
            upgradesCollected: 0,
            runsCompleted: 0,
            timeAlive: 0,
            damageTaken: 0,
            cachesOpened: 0,
            shopsVisited: 0,
            levelUps: 0,
            peakLevel: 0,
            peakRunTime: 0,             // longest single-run timeAlive (seconds)
            shipsUsed: {},              // {fighter:true, cruiser:true, ...} for Hangar Tour
            hostilesConverted: 0,
            // KnowledgeEvent (Strange Galaxy) resolutions, keyed by method:
            //   'item'   — fed it an item pickup (drops Obedience)
            //   'enemy'  — lured an enemy into it (drops Sacrifice)
            //   'combat' — defeated it in boss form (drops Knowledge)
            // Each interaction is mutually exclusive per instance of the event,
            // so these counters double as "ways you've resolved this event".
            knowledgeEventResolutions: { item: 0, enemy: 0, combat: 0 },
            bossesDefeated: {},
            eventTypes: {},
            asteroidsByType: { big: 0, medium: 0, small: 0, tiny: 0 },
            enemyKillsByClass: {},
            upgradesById: {},
            encounterTypes: {},     // 'cargo_trader' -> count of times the dialog was opened
            optimalChoices: {}      // scenarioId -> count of times the optimal path was taken
        };
    }

    // Per-run state — discarded between runs. Resets on 'run_started'. Sets
    // expose `.size` for "all-of"-style checks; killTimestamps is a sliding
    // window pruned every kill to power "N kills in 10 seconds".
    _newRunState() {
        return {
            enemiesKilled: 0,
            asteroidsDestroyed: 0,
            scrapCollected: 0,
            timeAlive: 0,
            upgradesCollected: 0,
            wavesCleared: 0,
            damageTaken: 0,
            cachesOpened: 0,
            shopsVisited: 0,
            peakLevel: 0,
            peakSpeedMult: 0,
            peakFireRateMult: 0,
            peakDamageBonus: 0,
            peakFovMult: 0,
            peakMaxHealth: 0,
            peakMaxShield: 0,
            peakVacuumRangeMult: 0,
            peakExtraProjectiles: 0,
            peakLuck: 0,
            peakHpRegen: 0,
            peakExpGainMult: 0,
            maxKillStreak: 0,
            kamikazesKilled: 0,
            cthulhuKilled: 0,
            damageless: true,            // flips false the first hit that lands
            shipId: null,                // set on first player_stats — tags ship-specific achievements
            dodgesPerformed: 0,          // boost/teleport pre-position dodges (see Player.dodgeScored)
            peakCargoSlots: 0,
            blinkDistanceTotal: 0,       // sum of all teleport distances this run
            peakBlinkDistance: 0,        // longest single teleport distance this run
            asteroidsBrokenShield: 0,    // asteroids killed while shield was broken
            asteroidsRammed: 0,          // asteroids destroyed by player body collision
            distanceTraveled: 0,         // total world-units flown this run
            bellyFlopDeaths: 0,          // runs ended by blinking into an asteroid and dying to the impact
            distinctStatTypesPicked: new Set(), // 'offense'/'defense'/'mobility'/'utility'/'difficulty'
            levelUpsSkipped: 0,
            lastStatPicked: null,        // for "same stat N times in a row" streak
            currentStatStreak: 0,
            maxSameStatStreak: 0,
            naturalLegendaryPicked: 0,   // natural legendary rolls actually selected
            scrapTimestamps: [],         // {t, amt} entries within the last 3s for burst detection
            scrapBurstPeak: 0,           // peak rolling 3-second sum
            hostilesConverted: 0,
            eventsDiscovered: new Set(),
            bossesDefeated: new Set(),
            uniqueUpgradeIds: new Set(),
            encounterTypesMet: new Set(),
            optimalChoicesMade: new Set(),
            visitedShops: new Set(),     // shop refs visited this run — dedupes re-opens
            asteroidsByType: { big: 0, medium: 0, small: 0, tiny: 0 },
            upgradesByRarity: { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0, unique: 0 },
            killTimestamps: []
        };
    }

    // Single entry point for everything the game wants to record. Keep payloads
    // small — manager pulls only what it needs so callers don't have to know
    // which fields matter for which achievement.
    notify(event, payload = null) {
        switch (event) {
            case 'run_started':
                this.run = this._newRunState();
                break;

            case 'run_ended':
                this.lifetime.runsCompleted++;
                if (payload && typeof payload.time === 'number') {
                    this.lifetime.timeAlive += payload.time;
                }
                // Longest single run — true in-game seconds, not wall time.
                if (this.run.timeAlive > this.lifetime.peakRunTime) {
                    this.lifetime.peakRunTime = this.run.timeAlive;
                }
                // Mark this run's ship as used (Hangar Tour).
                if (this.run.shipId) {
                    this.lifetime.shipsUsed[this.run.shipId] = true;
                }
                break;

            case 'enemy_killed': {
                this.lifetime.enemiesKilled++;
                this.run.enemiesKilled++;

                const entity = payload && payload.entity;
                if (entity) {
                    const className = entity.constructor && entity.constructor.name;
                    if (className) {
                        this.lifetime.enemyKillsByClass[className] =
                            (this.lifetime.enemyKillsByClass[className] || 0) + 1;
                        if (className === 'KamikazeEnemy') this.run.kamikazesKilled++;
                        else if (className === 'CthulhuEnemy') this.run.cthulhuKilled++;
                    }
                    if (entity.isBoss) this._recordBoss(this._bossId(entity));
                }

                // Sliding window for kill-streak checks. Use run.timeAlive as
                // the clock — it ticks via tickRun() and pauses when the run
                // pauses, so streaks measure in-game seconds, not wall time.
                this._pushKill(this.run.timeAlive);
                break;
            }

            case 'boss_defeated':
                // Used by non-Enemy bosses (e.g. YellowOne) that don't flow
                // through the enemy_killed path. Payload: { bossId }.
                if (payload && payload.bossId) this._recordBoss(payload.bossId);
                break;

            case 'knowledge_event_resolved': {
                const method = payload && payload.method;
                if (method && this.lifetime.knowledgeEventResolutions[method] !== undefined) {
                    this.lifetime.knowledgeEventResolutions[method]++;
                }
                break;
            }

            case 'encounter_dialog_opened': {
                const t = payload && payload.type;
                if (t) {
                    this.lifetime.encounterTypes[t] = (this.lifetime.encounterTypes[t] || 0) + 1;
                    this.run.encounterTypesMet.add(t);
                }
                break;
            }

            case 'encounter_converted_hostile':
                this.lifetime.hostilesConverted++;
                this.run.hostilesConverted++;
                break;

            case 'encounter_optimal_choice': {
                const sid = payload && payload.scenarioId;
                if (sid) {
                    this.lifetime.optimalChoices[sid] = (this.lifetime.optimalChoices[sid] || 0) + 1;
                    this.run.optimalChoicesMade.add(sid);
                }
                break;
            }

            case 'asteroid_destroyed': {
                this.lifetime.asteroidsDestroyed++;
                this.run.asteroidsDestroyed++;
                const size = payload && payload.entity && payload.entity.size;
                if (size && this.lifetime.asteroidsByType[size] !== undefined) {
                    this.lifetime.asteroidsByType[size]++;
                    this.run.asteroidsByType[size]++;
                }
                if (payload && payload.playerShieldBroken) {
                    this.run.asteroidsBrokenShield++;
                }
                break;
            }

            case 'asteroid_rammed':
                this.run.asteroidsRammed++;
                break;

            case 'player_traveled':
                if (payload && typeof payload.distance === 'number') {
                    // The player sends the running total — store the max we've
                    // seen rather than incrementing, so we're robust against
                    // out-of-order notifies.
                    if (payload.distance > this.run.distanceTraveled) {
                        this.run.distanceTraveled = payload.distance;
                    }
                }
                break;

            case 'belly_flop_death':
                this.run.bellyFlopDeaths++;
                break;

            case 'scrap_collected': {
                const amt = (payload && payload.amount) || 0;
                if (amt > 0) {
                    this.lifetime.scrapCollected += amt;
                    this.run.scrapCollected += amt;
                    // Rolling 3-second window for burst-collection achievement.
                    // Use run.timeAlive as the clock so pauses don't inflate.
                    const t = this.run.timeAlive;
                    const ts = this.run.scrapTimestamps;
                    ts.push({ t, amt });
                    const cutoff = t - 3.0;
                    while (ts.length > 0 && ts[0].t < cutoff) ts.shift();
                    let sum = 0;
                    for (let i = 0; i < ts.length; i++) sum += ts[i].amt;
                    if (sum > this.run.scrapBurstPeak) this.run.scrapBurstPeak = sum;
                }
                break;
            }

            case 'level_skipped':
                this.run.levelUpsSkipped++;
                break;

            case 'level_up_chosen': {
                const statId = payload && payload.statId;
                if (statId) {
                    if (statId === this.run.lastStatPicked) {
                        this.run.currentStatStreak++;
                    } else {
                        this.run.currentStatStreak = 1;
                        this.run.lastStatPicked = statId;
                    }
                    if (this.run.currentStatStreak > this.run.maxSameStatStreak) {
                        this.run.maxSameStatStreak = this.run.currentStatStreak;
                    }
                }
                if (payload && payload.naturalLegendary) {
                    this.run.naturalLegendaryPicked++;
                }
                if (payload && payload.statType) {
                    this.run.distinctStatTypesPicked.add(payload.statType);
                }
                break;
            }

            case 'wave_cleared':
                this.lifetime.wavesCleared++;
                this.run.wavesCleared++;
                break;

            case 'event_discovered': {
                this.lifetime.eventsDiscovered++;
                const typeId = payload && payload.event ? this._eventType(payload.event) : null;
                if (typeId) {
                    this.lifetime.eventTypes[typeId] = (this.lifetime.eventTypes[typeId] || 0) + 1;
                    this.run.eventsDiscovered.add(typeId);
                }
                break;
            }

            case 'upgrade_collected': {
                this.lifetime.upgradesCollected++;
                this.run.upgradesCollected++;
                const item = payload && payload.item;
                if (item && item.id) {
                    this.lifetime.upgradesById[item.id] = (this.lifetime.upgradesById[item.id] || 0) + 1;
                    this.run.uniqueUpgradeIds.add(item.id);
                }
                if (item && item.rarity && this.run.upgradesByRarity[item.rarity] !== undefined) {
                    this.run.upgradesByRarity[item.rarity]++;
                }
                break;
            }

            case 'cache_opened':
                this.lifetime.cachesOpened++;
                this.run.cachesOpened++;
                break;

            case 'dodge_performed':
                this.run.dodgesPerformed++;
                break;

            case 'blink_used': {
                const d = (payload && payload.distance) || 0;
                if (d > 0) {
                    this.run.blinkDistanceTotal += d;
                    if (d > this.run.peakBlinkDistance) this.run.peakBlinkDistance = d;
                }
                break;
            }

            case 'shop_opened': {
                // Dedupe by shop reference within a run so a player can't pad
                // the count by closing and re-opening the same shop. Lifetime
                // total ticks once per first-time visit within each run.
                const shop = payload && payload.shop;
                if (shop && !this.run.visitedShops.has(shop)) {
                    this.run.visitedShops.add(shop);
                    this.run.shopsVisited++;
                    this.lifetime.shopsVisited++;
                }
                break;
            }

            case 'level_up': {
                this.lifetime.levelUps++;
                const lvl = payload && typeof payload.level === 'number' ? payload.level : 0;
                if (lvl > this.run.peakLevel) this.run.peakLevel = lvl;
                if (lvl > this.lifetime.peakLevel) this.lifetime.peakLevel = lvl;
                break;
            }

            case 'player_damaged': {
                const amt = (payload && payload.amount) || 0;
                const shielded = !!(payload && payload.shielded);
                if (amt > 0) {
                    this.lifetime.damageTaken += amt;
                    this.run.damageTaken += amt;
                    // "Untouched" means hull damage. Shields are the whole
                    // point of having shields — don't punish blocking a hit.
                    if (!shielded) this.run.damageless = false;
                }
                break;
            }

            case 'player_stats':
                if (payload && payload.player) {
                    const p = payload.player;
                    const r = this.run;
                    r.peakSpeedMult = Math.max(r.peakSpeedMult, this._effectiveSpeedMult(p));
                    r.peakFireRateMult = Math.max(r.peakFireRateMult, p.fireRateMult || 0);
                    r.peakDamageBonus = Math.max(r.peakDamageBonus, p.permDamageBonus || 0);
                    r.peakFovMult = Math.max(r.peakFovMult, p.lvlFovMult || 0);
                    r.peakMaxHealth = Math.max(r.peakMaxHealth, p.maxHealth || 0);
                    r.peakMaxShield = Math.max(r.peakMaxShield, p.maxShieldEnergy || 0);
                    // Vacuum range composes the inventory mult (scrapRangeMult,
                    // e.g. from scrap_drone) with the level-up mult, so track
                    // their product to match what the player actually feels.
                    const vac = (p.scrapRangeMult || 1) * (p.lvlVacuumRangeMult || 1);
                    r.peakVacuumRangeMult = Math.max(r.peakVacuumRangeMult, vac);
                    r.peakExtraProjectiles = Math.max(r.peakExtraProjectiles, p.lvlExtraProjectiles || 0);
                    r.peakLuck = Math.max(r.peakLuck, p.luck || 0);
                    r.peakHpRegen = Math.max(r.peakHpRegen, p.lvlHpRegen || 0);
                    r.peakExpGainMult = Math.max(r.peakExpGainMult, p.lvlExpGainMult || 0);
                    if (typeof p.level === 'number' && p.level > r.peakLevel) {
                        r.peakLevel = p.level;
                        if (p.level > this.lifetime.peakLevel) this.lifetime.peakLevel = p.level;
                    }
                    if (!r.shipId && p.shipData && p.shipData.id) {
                        r.shipId = p.shipData.id;
                    }
                    if (p.inventory) {
                        const slots = (p.inventory.cols || 0) * (p.inventory.rows || 0);
                        if (slots > r.peakCargoSlots) r.peakCargoSlots = slots;
                    }
                }
                break;
        }

        this._checkAchievements();

        // Persist every notify — lifetime totals (kills, scrap, runs) need to
        // survive a crash mid-run, not just unlock moments. localStorage
        // writes are cheap, but coalesce inside the same tick so a burst of
        // notifies only triggers one disk hit.
        this._scheduleSave();
    }

    // Called from PlayingState's main update so per-run time-alive accumulates
    // without notify spam. Skip when game is paused/dead — caller decides.
    tickRun(dt) {
        this.run.timeAlive += dt;
        // No achievement currently keys off raw timeAlive ticks, so don't
        // re-run all checks every frame. Time-based achievements should
        // notify('run_ended') or be re-evaluated on other event boundaries.
    }

    _recordBoss(bossId) {
        if (!bossId) return;
        this.lifetime.bossesDefeated[bossId] = (this.lifetime.bossesDefeated[bossId] || 0) + 1;
        this.run.bossesDefeated.add(bossId);
    }

    // Append a kill timestamp and prune anything older than the window. After
    // pruning, the array length IS the rolling streak count, which we fold
    // into maxKillStreak so achievement checks read a single peak value.
    _pushKill(t) {
        const ks = this.run.killTimestamps;
        ks.push(t);
        const cutoff = t - KILL_WINDOW_SECONDS;
        while (ks.length > 0 && ks[0] < cutoff) ks.shift();
        if (ks.length > this.run.maxKillStreak) this.run.maxKillStreak = ks.length;
    }

    _checkAchievements() {
        for (const ach of ACHIEVEMENTS) {
            if (this.unlocked.has(ach.id)) continue;
            try {
                if (ach.check && ach.check(this)) this._unlock(ach);
            } catch (err) {
                console.warn(`Achievement check failed for ${ach.id}:`, err);
            }
        }
    }

    _unlock(ach) {
        if (this.unlocked.has(ach.id)) return;
        this.unlocked.add(ach.id);
        this.toastQueue.push(ach);
        this._save();
        if (this.game && this.game.sounds) {
            this.game.sounds.play('achievement', 0.8);
        }
        console.log(`Achievement unlocked: ${ach.name}`);
    }

    // Microtask-debounced save — multiple notifies in the same frame all
    // collapse into one localStorage write at the end of the tick.
    _scheduleSave() {
        if (this._saveScheduled) return;
        this._saveScheduled = true;
        Promise.resolve().then(() => {
            this._saveScheduled = false;
            this._save();
        });
    }

    // HUD drives this from its draw loop. Returns the toast currently being
    // displayed (or null) plus a 0..1 progress value so the renderer can
    // animate slide-in/out without owning state.
    updateToast(dt) {
        if (!this.currentToast) {
            if (this.toastQueue.length > 0) {
                this.currentToast = this.toastQueue.shift();
                this.currentToastTime = 0;
            }
            return null;
        }
        this.currentToastTime += dt;
        if (this.currentToastTime >= this.TOAST_DURATION) {
            this.currentToast = null;
            return null;
        }
        return {
            ach: this.currentToast,
            t: this.currentToastTime / this.TOAST_DURATION
        };
    }

    // Lookup for unlock-gated content. Walks ACHIEVEMENTS rather than caching
    // a derived map so adding a new unlock is a single-file change.
    hasUnlock(type, id) {
        for (const ach of ACHIEVEMENTS) {
            if (!this.unlocked.has(ach.id) || !ach.unlock) continue;
            if (ach.unlock.type === type && ach.unlock.id === id) return true;
        }
        return false;
    }

    // Aggregate getter used by achievement check() functions and the menu.
    getStats() {
        return { lifetime: this.lifetime, run: this.run, unlocked: this.unlocked };
    }

    _bossId(entity) {
        if (!entity) return null;
        return entity.bossId || (entity.constructor && entity.constructor.name);
    }

    _eventType(ev) {
        if (!ev) return null;
        return ev.eventType || (ev.constructor && ev.constructor.name);
    }

    // Effective speed = current baseSpeed / ship's stock baseSpeed. This is
    // the same composite that `_onInventoryChanged` builds, so a result of
    // 5.0 means the player is moving 5x the ship's printed speed.
    _effectiveSpeedMult(p) {
        if (!p || !p.shipData) return 0;
        const stockBase = p.shipData.speed * 100;
        if (stockBase <= 0) return 0;
        return (p.baseSpeed || 0) / stockBase;
    }

    _save() {
        try {
            const data = {
                lifetime: this.lifetime,
                unlocked: [...this.unlocked]
            };
            localStorage.setItem(AchievementManager.STORAGE_KEY, JSON.stringify(data));
        } catch (err) {
            console.error('Failed to save achievements:', err);
        }
    }

    _load() {
        try {
            const raw = localStorage.getItem(AchievementManager.STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (data.lifetime) {
                // Merge defensively — old saves may be missing newer fields,
                // and map-shaped fields need their default keys preserved.
                for (const k of Object.keys(this.lifetime)) {
                    if (data.lifetime[k] === undefined) continue;
                    const cur = this.lifetime[k];
                    const next = data.lifetime[k];
                    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
                        this.lifetime[k] = { ...cur, ...next };
                    } else {
                        this.lifetime[k] = next;
                    }
                }
            }
            if (Array.isArray(data.unlocked)) this.unlocked = new Set(data.unlocked);
        } catch (err) {
            console.error('Failed to load achievements:', err);
        }
    }

    // Dev-only: blow away the persisted store. Exposed so the dev console
    // can rebind it without going through localStorage manually.
    reset() {
        this.lifetime = this._newLifetimeState();
        this.run = this._newRunState();
        this.unlocked = new Set();
        this.toastQueue = [];
        this.currentToast = null;
        this._save();
    }
}
