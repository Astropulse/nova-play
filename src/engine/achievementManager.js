import { ACHIEVEMENTS } from '../data/achievements.js';
import { MAX_COMBINE_TIER } from '../data/upgrades.js';

// Sliding-window length used by "N kills in K seconds" checks.
const KILL_WINDOW_SECONDS = 10;

// Reverse lookups for gated content, built once from the ACHIEVEMENTS table:
// upgrade/ship id -> the achievement whose unlock grants it, and combine
// rarity -> its gate achievement. Anything absent from these maps is ungated.
const UPGRADE_GATES = new Map();
const COMBINE_GATES = new Map();
const SHIP_GATES = new Map();
for (const ach of ACHIEVEMENTS) {
    if (!ach.unlock) continue;
    if (ach.unlock.type === 'upgrade') UPGRADE_GATES.set(ach.unlock.id, ach);
    else if (ach.unlock.type === 'combine') COMBINE_GATES.set(ach.unlock.id, ach);
    else if (ach.unlock.type === 'ship') SHIP_GATES.set(ach.unlock.id, ach);
}

// Combine ladder caps in unlock order: each entry is the result-tier ceiling
// granted by that combine unlock. With none unlocked the cap is 0 — no fusing
// at all (every fuse produces tier >= 1).
const COMBINE_CAP_LADDER = [
    { id: 'uncommon', cap: 2 },
    { id: 'rare', cap: 4 },
    { id: 'epic', cap: 6 },
    { id: 'legendary', cap: MAX_COMBINE_TIER }
];

export class AchievementManager {
    static STORAGE_KEY = 'nova_achievements';

    constructor(game) {
        this.game = game;

        this.lifetime = this._newLifetimeState();
        this.run = this._newRunState();
        this.unlocked = new Set();

        // Achievement ids unlocked during the live run vs. the most recently
        // finished run. The achievements menu marks these "NEW" — runUnlocked
        // while a run is in progress, lastRunUnlocked once back on the title.
        // Both persist so the markers survive a save/resume or a reload at the
        // title screen.
        this.runUnlocked = new Set();
        this.lastRunUnlocked = new Set();

        // Player-pinned achievements rendered on the in-game HUD. Persisted
        // alongside unlocks. Cleared automatically when the achievement is
        // unlocked (see _unlock).
        this.tracked = new Set();
        this.MAX_TRACKED = 5;

        // Toast display state — HUD pulls one off at a time and runs the
        // slide/fade animation. We keep a small queue so back-to-back unlocks
        // don't get dropped.
        this.toastQueue = [];
        this.currentToast = null;
        this.currentToastTime = 0;
        this.TOAST_DURATION = 4.5;

        this._load();

        // Retroactive reconcile: achievements added after this profile's stats
        // already satisfied them (e.g. the progression-gate batch landing on a
        // veteran save) unlock silently at boot — no toast, no sound, no "NEW"
        // marker. Without this they'd all fire as a fanfare burst on the first
        // notify of the next run, and unlock-gated pools would read as locked
        // until then.
        let reconciled = false;
        for (const ach of ACHIEVEMENTS) {
            if (this.unlocked.has(ach.id)) continue;
            try {
                if (ach.check && ach.check(this)) {
                    this.unlocked.add(ach.id);
                    this.tracked.delete(ach.id);
                    reconciled = true;
                }
            } catch (err) { /* stat shape from an older save — skip */ }
        }
        if (reconciled) this._save();
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
            optimalChoices: {},     // scenarioId -> count of times the optimal path was taken
            combines: 0,            // successful upgrade fuses
            maxTierCombines: 0,     // fuses that produced a max-tier item
            consumablesUsed: 0,
            maxKillStreak: 0,           // best "kills within 10s" window ever
            dodgesPerformed: 0,         // lifetime boost/teleport dodges
            cloaksUsed: 0,              // gravity-distortion cloak activations
            cloakTime: 0,               // seconds spent cloaked
            asteroidsRammed: 0,         // lifetime ram-kills on asteroids
            distanceTraveled: 0,        // world-units flown, summed at run end
            peakLevelByShip: {},        // {shipId: best level reached in a run}
            peakRunTimeByShip: {},      // {shipId: longest single run, seconds}
            tradesCompleted: 0,          // multiplayer trades
            multiplayerRunsCompleted: 0, // runs finished with ≥1 other live pilot
            multiplayerBossKills: 0,     // bosses recorded during such runs
            engagementGifts: {}          // one-shot onboarding gifts consumed (see consumeEngagementGift)
        };
    }

    // One-shot new-player onboarding gifts (e.g. the first-ever level-up's
    // boosted roll). Returns true exactly once per key and persists the
    // consumption immediately so it can never fire twice.
    consumeEngagementGift(key) {
        if (!this.lifetime.engagementGifts) this.lifetime.engagementGifts = {};
        if (this.lifetime.engagementGifts[key]) return false;
        this.lifetime.engagementGifts[key] = true;
        this._save();
        return true;
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
            peakDamageMult: 0,
            peakFovMult: 0,
            peakMaxHealth: 0,
            peakMaxShield: 0,
            peakShieldMult: 0,           // maxShieldEnergy / stock (shipData.shield * 150)
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
            cloaksUsed: 0,               // gravity-distortion cloak activations this run
            cloakTime: 0,                // seconds cloaked this run
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
            multiplayer: false,          // true once ≥1 remote pilot shares the run
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
                // Fresh run — clear the "unlocked this run" markers. Anything
                // earned in the run just finishing already moved to
                // lastRunUnlocked on 'run_ended'.
                this.runUnlocked = new Set();
                break;

            case 'run_ended': {
                this.lifetime.runsCompleted++;
                if (this.run.multiplayer) this.lifetime.multiplayerRunsCompleted++;
                // Snapshot this run's unlocks as the "last run" set so the
                // title-screen menu can mark them after we leave the run.
                this.lastRunUnlocked = new Set(this.runUnlocked);
                const payloadTime = (payload && typeof payload.time === 'number') ? payload.time : 0;
                if (payloadTime > 0) {
                    this.lifetime.timeAlive += payloadTime;
                }
                // Longest single run — true in-game seconds, not wall time.
                // Prefer payload.time (the run's trueTotalTime), which is
                // serialized across save/resume; this.run.timeAlive resets to 0
                // on load and would undercount any run that spanned a save.
                const runTime = Math.max(this.run.timeAlive, payloadTime);
                if (runTime > this.lifetime.peakRunTime) {
                    this.lifetime.peakRunTime = runTime;
                }
                // Distance only folds into the lifetime total when the run
                // ends — run.distanceTraveled is a running max, not a delta.
                this.lifetime.distanceTraveled += this.run.distanceTraveled;
                // Mark this run's ship as used (Hangar Tour) and fold the
                // per-ship longest-run record (upgrade unlock gates).
                if (this.run.shipId) {
                    this.lifetime.shipsUsed[this.run.shipId] = true;
                    const prev = this.lifetime.peakRunTimeByShip[this.run.shipId] || 0;
                    if (runTime > prev) this.lifetime.peakRunTimeByShip[this.run.shipId] = runTime;
                }
                break;
            }

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

            case 'multiplayer_run':
                // PlayingState fires this once a remote pilot is actually in
                // the run (not merely a hosted-but-empty lobby).
                this.run.multiplayer = true;
                break;

            case 'trade_completed':
                this.lifetime.tradesCompleted++;
                break;

            case 'item_combined':
                // Payload: { id, tier, isMaxTier } from the combine fanfare.
                this.lifetime.combines++;
                if (payload && payload.isMaxTier) this.lifetime.maxTierCombines++;
                break;

            case 'consumable_used':
                this.lifetime.consumablesUsed++;
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
                this.lifetime.asteroidsRammed++;
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
                this.lifetime.dodgesPerformed++;
                break;

            case 'cloak_used':
                this.run.cloaksUsed++;
                this.lifetime.cloaksUsed++;
                break;

            case 'cloak_ended': {
                const d = (payload && payload.duration) || 0;
                if (d > 0) {
                    this.run.cloakTime += d;
                    this.lifetime.cloakTime += d;
                }
                break;
            }

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
                this._recordShipLevel(lvl);
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
                    // fireRateMult is a cooldown multiplier (<1 = faster), so the
                    // fire-rate the player feels is its reciprocal. Compose every
                    // source the way _onInventoryChanged does (firing_coordinator,
                    // repeater, cosmos, level-ups all fold into fireRateMult).
                    const fireRate = (p.fireRateMult > 0) ? (1 / p.fireRateMult) : 0;
                    r.peakFireRateMult = Math.max(r.peakFireRateMult, fireRate);
                    r.peakDamageMult = Math.max(r.peakDamageMult, this._effectiveDamageMult(p));
                    // FOV composes the upgrade mult (sensor_accelerator) with the
                    // level-up mult; playingState bundles them into payload.fovMult.
                    const fov = (payload.fovMult != null) ? payload.fovMult : (p.lvlFovMult || 0);
                    r.peakFovMult = Math.max(r.peakFovMult, fov);
                    r.peakMaxHealth = Math.max(r.peakMaxHealth, p.maxHealth || 0);
                    r.peakMaxShield = Math.max(r.peakMaxShield, p.maxShieldEnergy || 0);
                    // Shield as a multiple of the hull's stock capacity
                    // (Player scales shipData.shield by 150 into energy units),
                    // so 3.0 means triple the printed shield — ship-fair the
                    // way the speed/damage multiplier achievements are.
                    const stockShield = (p.shipData && p.shipData.shield) ? p.shipData.shield * 150 : 0;
                    if (stockShield > 0) {
                        r.peakShieldMult = Math.max(r.peakShieldMult, (p.maxShieldEnergy || 0) / stockShield);
                    }
                    // Vacuum range composes the inventory mult (scrapRangeMult,
                    // e.g. from scrap_drone) with the level-up mult, so track
                    // their product to match what the player actually feels.
                    const vac = (p.scrapRangeMult || 1) * (p.lvlVacuumRangeMult || 1);
                    r.peakVacuumRangeMult = Math.max(r.peakVacuumRangeMult, vac);
                    r.peakExtraProjectiles = Math.max(r.peakExtraProjectiles, this._extraProjectilesPerVolley(p));
                    r.peakLuck = Math.max(r.peakLuck, p.luck || 0);
                    // HP regen sums the level-up regen and the nanite_tank upgrade.
                    const hpRegen = (p.lvlHpRegen || 0) + (p.naniteRegen || 0);
                    r.peakHpRegen = Math.max(r.peakHpRegen, hpRegen);
                    // Exp gain composes the level-up mult with experience_condenser.
                    const expMult = (p.lvlExpGainMult || 0) * (p.experienceCondenserMult || 1);
                    r.peakExpGainMult = Math.max(r.peakExpGainMult, expMult);
                    if (!r.shipId && p.shipData && p.shipData.id) {
                        r.shipId = p.shipData.id;
                    }
                    if (typeof p.level === 'number' && p.level > r.peakLevel) {
                        r.peakLevel = p.level;
                        if (p.level > this.lifetime.peakLevel) this.lifetime.peakLevel = p.level;
                        this._recordShipLevel(p.level);
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
        // Keep the longest-run stat current while the run is live so time-based
        // achievements (Personal Best) can unlock the moment the player crosses
        // the threshold and their `progress` bar fills in real time — not only
        // when the run finally ends. run_ended still does its own max() so a run
        // spanning a save/resume (where run.timeAlive resets to 0 on load) is
        // backstopped by the serialized trueTotalTime in its payload.
        if (this.run.timeAlive > this.lifetime.peakRunTime) {
            this.lifetime.peakRunTime = this.run.timeAlive;
        }
        // Per-ship longest run ticks live too, so "survive N minutes as X"
        // unlock gates fire the moment the threshold is crossed.
        if (this.run.shipId) {
            const prev = this.lifetime.peakRunTimeByShip[this.run.shipId] || 0;
            if (this.run.timeAlive > prev) {
                this.lifetime.peakRunTimeByShip[this.run.shipId] = this.run.timeAlive;
            }
        }
        // Re-evaluate at most once per second: enough to catch a time milestone
        // promptly, cheap enough to avoid per-frame check + save churn.
        this._timeCheckAccum = (this._timeCheckAccum || 0) + dt;
        if (this._timeCheckAccum >= 1.0) {
            this._timeCheckAccum = 0;
            this._checkAchievements();
            this._scheduleSave();
        }
    }

    _recordBoss(bossId) {
        if (!bossId) return;
        this.lifetime.bossesDefeated[bossId] = (this.lifetime.bossesDefeated[bossId] || 0) + 1;
        this.run.bossesDefeated.add(bossId);
        // Shared Glory: any boss recorded while other pilots share the run.
        if (this.run.multiplayer) this.lifetime.multiplayerBossKills++;
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
        if (ks.length > this.lifetime.maxKillStreak) this.lifetime.maxKillStreak = ks.length;
    }

    // Best level reached with the current run's ship, persisted per ship id.
    // Feeds the combine-tier and upgrade unlock gates.
    _recordShipLevel(lvl) {
        const shipId = this.run.shipId;
        if (!shipId || !lvl) return;
        if (lvl > (this.lifetime.peakLevelByShip[shipId] || 0)) {
            this.lifetime.peakLevelByShip[shipId] = lvl;
        }
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

    // Dev-console shortcut (`unlockall`): grant every achievement at once,
    // which by extension opens every gated upgrade, ship, and combine rung.
    // Silent on purpose — no toast burst, no chime, no "NEW" markers — so it
    // reads as a profile edit rather than a fanfare. Returns how many were
    // newly granted.
    unlockAll() {
        let granted = 0;
        for (const ach of ACHIEVEMENTS) {
            if (this.unlocked.has(ach.id)) continue;
            this.unlocked.add(ach.id);
            this.tracked.delete(ach.id);
            granted++;
        }
        if (granted > 0) this._save();
        return granted;
    }

    _unlock(ach) {
        if (this.unlocked.has(ach.id)) return;
        this.unlocked.add(ach.id);
        // Tag it as unlocked during the current run so the menu can mark it
        // "NEW" (in-run now, last-run once the run ends).
        this.runUnlocked.add(ach.id);
        // Auto-untrack: once it's earned, the HUD shouldn't keep promoting it.
        this.tracked.delete(ach.id);
        this.toastQueue.push(ach);
        this._save();
        if (this.game && this.game.sounds) {
            this.game.sounds.play('achievement', 0.8);
        }
        console.log(`Achievement unlocked: ${ach.name}`);
    }

    // Tracking API — UI surfaces (achievements menu, HUD) call these. We
    // refuse to track unlocked achievements because they wouldn't render
    // (HUD filter skips them) and a stale tracked id would silently linger
    // in localStorage.
    track(id) {
        if (this.unlocked.has(id)) return false;
        if (this.tracked.has(id)) return true;
        if (this.tracked.size >= this.MAX_TRACKED) return false;
        this.tracked.add(id);
        this._scheduleSave();
        return true;
    }

    untrack(id) {
        if (!this.tracked.has(id)) return;
        this.tracked.delete(id);
        this._scheduleSave();
    }

    toggleTrack(id) {
        if (this.tracked.has(id)) { this.untrack(id); return false; }
        return this.track(id);
    }

    isTracked(id) {
        return this.tracked.has(id);
    }

    // Returns tracked achievements in their ACHIEVEMENTS-array order so the
    // HUD stack is stable across frames. Filters out anything that's been
    // unlocked since the set was last persisted (defensive — _unlock should
    // already prune it).
    getTrackedAchievements() {
        if (this.tracked.size === 0) return [];
        const out = [];
        for (const ach of ACHIEVEMENTS) {
            if (this.tracked.has(ach.id) && !this.unlocked.has(ach.id)) out.push(ach);
        }
        return out;
    }

    // Set of achievement ids the menu should flag "NEW": the live run's
    // unlocks while a run is in progress, otherwise the most recent run's.
    getRecentUnlocks(inRun) {
        return inRun ? this.runUnlocked : this.lastRunUnlocked;
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

    // ── Progression gates ──────────────────────────────────────────────────
    // Upgrades and combine tiers are gated behind achievements that carry an
    // `unlock: { type: 'upgrade'|'combine', id }`. An upgrade with no gate
    // achievement is available from the start.

    /** True when the upgrade may appear in shops/caches/loot/encounters. */
    isUpgradeUnlocked(id) {
        const gate = UPGRADE_GATES.get(id);
        return !gate || this.unlocked.has(gate.id);
    }

    /** The achievement gating an upgrade, or null when it's ungated. */
    getUpgradeGate(id) {
        return UPGRADE_GATES.get(id) || null;
    }

    /** True when the ship is selectable (ungated ships — the Fighter — always are). */
    isShipUnlocked(id) {
        const gate = SHIP_GATES.get(id);
        return !gate || this.unlocked.has(gate.id);
    }

    /** The achievement gating a ship, or null when it's ungated. */
    getShipGate(id) {
        return SHIP_GATES.get(id) || null;
    }

    /** Highest combine-result tier the player has unlocked (0 = no combining). */
    combineTierCap() {
        let cap = 0;
        for (const step of COMBINE_CAP_LADDER) {
            const gate = COMBINE_GATES.get(step.id);
            // A missing gate achievement means that rung isn't gated — treat
            // it (and its cap) as granted so removing a gate can't brick fusing.
            if (!gate || this.unlocked.has(gate.id)) cap = step.cap;
            else break;
        }
        return cap;
    }

    /** Gate achievement blocking a fuse to `tier`, or null when the current
     *  cap already allows it. Rungs unlock strictly in order, so the blocker
     *  is always the first locked gate. Used by the combine-preview tooltip. */
    combineGateFor(tier) {
        if (tier <= this.combineTierCap()) return null;
        return this.nextCombineGate();
    }

    /** The next locked combine-tier gate on the ladder (null when maxed). */
    nextCombineGate() {
        for (const step of COMBINE_CAP_LADDER) {
            const gate = COMBINE_GATES.get(step.id);
            if (gate && !this.unlocked.has(gate.id)) return gate;
        }
        return null;
    }

    // Aggregate getter used by achievement check() functions and the menu.
    getStats() {
        return { lifetime: this.lifetime, run: this.run, unlocked: this.unlocked };
    }

    _bossId(entity) {
        if (!entity) return null;
        return entity.bossId || (entity.constructor && entity.constructor.name);
    }

    // Effective per-projectile damage as a multiple of the ship's stock
    // baseDamage, counting every source the firing code does:
    //   (baseDamage*obedience + permDamageBonus) * laserCartridgeMult
    // i.e. flat shop/encounter damage, obedience, level-up damage and Laser
    // Cartridge (both fold into laserCartridgeMult), and cosmos. So a 7-damage
    // ship hitting for 140 reads as 20.0.
    _effectiveDamageMult(p) {
        if (!p || !p.shipData) return 0;
        const base = p.shipData.baseDamage || 0;
        if (base <= 0) return 0;
        const effective = (base * (p.obedienceMult || 1) + (p.permDamageBonus || 0)) * (p.laserCartridgeMult || 1);
        return effective / base;
    }

    // Extra projectiles fired per volley, beyond the single baseline shot,
    // composing every multishot source the way the firing code does:
    //   - Multishot Guns upgrade doubles the firing origins.
    //   - Energy Blaster replaces the single shot with a 3-5 (+2 per extra
    //     blaster) spread, plus the level-up extra-projectile stat.
    //   - Otherwise the level-up stat adds projectiles per origin.
    // We count the guaranteed (minimum) projectiles so the achievement reflects
    // a reliable build capability rather than a lucky Energy Blaster roll.
    _extraProjectilesPerVolley(p) {
        if (!p) return 0;
        // Crossed Wiring fires from both wings like Multishot; stacked copies
        // (and Multishot on top) add shots per wing.
        const origins = (p.hasMultishotGuns || p.hasCrossedWiring) ? 2 : 1;
        const crossExtra = p.hasCrossedWiring
            ? Math.max(0, (p.crossShots || 1) - 1) + (p.hasMultishotGuns ? 1 : 0) : 0;
        let perOrigin;
        if (p.hasEnergyBlaster) {
            perOrigin = 3 + Math.max(0, (p.energyBlasterCount || 1) - 1) * 2 + (p.lvlExtraProjectiles || 0) + crossExtra;
        } else {
            perOrigin = 1 + (p.lvlExtraProjectiles || 0) + crossExtra;
        }
        return origins * perOrigin - 1;
    }

    _eventType(ev) {
        if (!ev) return null;
        return ev.eventType || (ev.constructor && ev.constructor.name);
    }

    // Effective speed = the player's actual top speed / ship's stock baseSpeed,
    // so a result of 5.0 means they're moving 5x the ship's printed speed.
    // baseSpeed already folds in obedience/momentum/cosmos/encounter/level-ups,
    // but Player.update multiplies the pulse_jet and mechanical_engines upgrades
    // (and the momentum drift cap) on top when computing max speed — mirror that
    // here so those upgrades count toward the speed achievements.
    _effectiveSpeedMult(p) {
        if (!p || !p.shipData) return 0;
        const stockBase = p.shipData.speed * 100;
        if (stockBase <= 0) return 0;
        const topSpeed = (p.baseSpeed || 0)
            * (p.pulseJetMult || 1)
            * (p.mechanicalEngineSpeedMult || 1)
            * (p.momentumMaxSpeedMult || 1);
        return topSpeed / stockBase;
    }

    _save() {
        try {
            const data = {
                lifetime: this.lifetime,
                unlocked: [...this.unlocked],
                tracked: [...this.tracked],
                runUnlocked: [...this.runUnlocked],
                lastRunUnlocked: [...this.lastRunUnlocked]
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
            if (Array.isArray(data.tracked)) {
                // Drop anything that's already unlocked — the player has no
                // use for tracking it any more.
                this.tracked = new Set(data.tracked.filter(id => !this.unlocked.has(id)));
            }
            // Recent-unlock markers. Filter against the unlocked set so a
            // hand-edited or stale save can't flag something as "NEW" that
            // isn't actually earned.
            if (Array.isArray(data.runUnlocked)) {
                this.runUnlocked = new Set(data.runUnlocked.filter(id => this.unlocked.has(id)));
            }
            if (Array.isArray(data.lastRunUnlocked)) {
                this.lastRunUnlocked = new Set(data.lastRunUnlocked.filter(id => this.unlocked.has(id)));
            }
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
        this.runUnlocked = new Set();
        this.lastRunUnlocked = new Set();
        this.tracked = new Set();
        this.toastQueue = [];
        this.currentToast = null;
        this._save();
    }
}
