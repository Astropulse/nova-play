/**
 * LevelUpDialog — modal stat-upgrade picker shown on each level-up.
 *
 * 4 choices are rolled per level. The player either picks one, or skips
 * to bank a stacking bonus multiplier (LEVELUP_SKIP_MULT_STEP, default
 * 1.8x per skip) applied to the *next* roll's % and flat values. Picking
 * cashes in the banked multiplier. The skip budget (LEVELUP_MAX_SKIPS,
 * default 2) is a per-run pool — skips persist across level-ups and only
 * refill on new game.
 *
 * Roll diversity:
 *   • Max 2 choices of the same TYPE (offense/defense/mobility/utility/
 *     difficulty) per roll, when the pool can support it.
 *   • Each pick is softly biased away from types the player has already
 *     invested in (weight = 1 / (1 + BIAS_K * typeCount)).
 *
 * Bonus % ranges (also determine the highlight colour):
 *   Common    0.5 – 1.5 %
 *   Uncommon  1.5 – 3.0 %
 *   Rare      3.0 – 6.0 %
 *   Epic      6.0 – 10.0 %
 *   Legendary 10.0 – 20.0 %
 *
 * Luck (player.luck) biases the within-tier % roll toward the high end of each
 * band (see _luckyUnit). It does NOT change which bonus tier is selected.
 * The Luck stat itself is an epic-tier upgrade with small, hard-capped rolls
 * (never above LUCK_MAX_PCT) that compound player.luck via lvlLuckMult.
 * Cursed choices are extremely rare and reverse every effect.
 */

import { RARITY_COLORS } from '../data/upgrades.js';
import { GP } from '../engine/inputManager.js';

// ─── Stat definitions by category ────────────────────────────────────────────
const STAT_DEFS = {
    common: [
        { id: 'damage',           name: 'Damage',           desc: 'Increases laser damage output' },
        { id: 'max_hp',           name: 'Max Hull',          desc: 'Increases maximum hull integrity' },
        { id: 'max_shield',       name: 'Max Shield',        desc: 'Increases maximum shield capacity' },
        { id: 'shield_drain',     name: 'Shield Efficiency', desc: 'Reduces shield energy drain rate' },
        { id: 'ship_speed',       name: 'Ship Speed',        desc: 'Increases ship movement speed' },
        { id: 'projectile_speed', name: 'Projectile Speed',  desc: 'Increases projectile velocity' },
        { id: 'boost_recharge',   name: 'Boost Recharge',    desc: 'Reduces boost cooldown time' },
        { id: 'firerate',         name: 'Fire Rate',         desc: 'Increases rate of fire' },
    ],
    uncommon: [
        { id: 'shield_recharge',     name: 'Shield Recharge',  desc: 'Increases shield recharge speed' },
        { id: 'exp_gain',            name: 'Experience Gain',  desc: 'Increases experience point gain' },
        { id: 'boost_speed',         name: 'Boost Speed',      desc: 'Increases boost velocity' },
        { id: 'boost_duration',      name: 'Boost Duration',   desc: 'Extends boost active duration' },
        { id: 'asteroid_resistance', name: 'Asteroid Resist',  desc: 'Reduces asteroid collision damage' },
        { id: 'asteroid_spawn',      name: 'Asteroid Density', desc: 'Increases asteroid spawn rate' },
        { id: 'vacuum_range',        name: 'Vacuum Range',     desc: 'Extends scrap collection range' },
        { id: 'turn_speed',          name: 'Turn Speed',       desc: 'Increases ship rotation speed' },
        { id: 'shield_damage',       name: 'Shield Impact',    desc: 'Boosts shield collision damage' },
        { id: 'fov',                 name: 'Field of View',    desc: 'Expands your view of space' },
    ],
    rare: [
        { id: 'extra_projectile', name: 'Multi-Shot',       desc: 'Fires an additional projectile',      flat: '+1 SHOT' },
        { id: 'scrap_chance',     name: 'Scrap Fortune',    desc: 'Increases scrap drop chance' },
        { id: 'cache_freq',       name: 'Cache Frequency',  desc: 'Increases space cache spawn rate' },
        { id: 'encounter_freq',   name: 'Encounter Rate',   desc: 'Increases encounter frequency' },
        { id: 'enemy_spawn',      name: 'Enemy Density',    desc: 'Increases enemy spawn rate' },
        { id: 'difficulty_gain',  name: 'Challenge Rate',   desc: 'Scales difficulty faster' },
        { id: 'wave_countdown',   name: 'Wave Urgency',     desc: 'Reduces wave countdown duration' },
        { id: 'hp_regen',         name: 'Hull Repair',      desc: 'Slowly regenerates hull integrity',   flat: '+0.1 HP/S' },
    ],
    epic: [
        { id: 'luck',             name: 'Luck',             desc: 'Improves the odds on every random roll' },
    ],
};

// Build stat-id → category lookup
const STAT_CAT = {};
for (const [cat, defs] of Object.entries(STAT_DEFS)) {
    for (const def of defs) STAT_CAT[def.id] = cat;
}

// ─── Stat TYPE grouping (independent of rarity tier) ─────────────────────────
// Used to enforce per-roll diversity and to softly bias future rolls away from
// over-picked types. Every stat must appear exactly once below.
export const STAT_TYPE = {
    // Offense
    damage:           'offense',
    firerate:         'offense',
    extra_projectile: 'offense',
    projectile_speed: 'offense',
    shield_damage:    'offense',
    // Defense
    max_hp:              'defense',
    max_shield:          'defense',
    shield_drain:        'defense',
    shield_recharge:     'defense',
    asteroid_resistance: 'defense',
    hp_regen:            'defense',
    // Mobility
    ship_speed:     'mobility',
    boost_recharge: 'mobility',
    boost_speed:    'mobility',
    boost_duration: 'mobility',
    turn_speed:     'mobility',
    // Utility / economy / vision
    exp_gain:       'utility',
    vacuum_range:   'utility',
    fov:            'utility',
    scrap_chance:   'utility',
    cache_freq:     'utility',
    encounter_freq: 'utility',
    luck:           'utility',
    // Difficulty / world-density
    asteroid_spawn:  'difficulty',
    enemy_spawn:     'difficulty',
    difficulty_gain: 'difficulty',
    wave_countdown:  'difficulty',
};

const MAX_PER_TYPE_PER_ROLL = 2;
// Per-pick bias strength: weight = 1 / (1 + BIAS_K * typeCount).
// At BIAS_K=0.12, 5 picks of one type drops its relative weight to ~0.625x.
const BIAS_K = 0.12;

// ─── Bonus tier ranges [min%, max%] ──────────────────────────────────────────
const BONUS_TIERS = {
    common:    { min: 0.5,  max: 1.5  },
    uncommon:  { min: 1.5,  max: 3.0  },
    rare:      { min: 3.0,  max: 6.0  },
    epic:      { min: 6.0,  max: 10.0 },
    legendary: { min: 10.0, max: 20.0 },
};

// Luck is an epic-tier stat with deliberately small rolls and a hard ceiling,
// so it never spikes the way other %-bonus stats can. Its base roll is low and
// the result is clamped to LUCK_MAX_PCT even after the skip-stacking multiplier.
const LUCK_TIER    = { min: 1.0, max: 3.0 };
const LUCK_MAX_PCT = 5.0;

// ─── Base weights ─────────────────────────────────────────────────────────────
// epic is the rarest non-cursed category — luck is its only member.
const CAT_BASE_W   = { common: 60, uncommon: 25, rare: 12, epic: 2, cursed: 3 };
const BONUS_BASE_W = { common: 67, uncommon: 20, rare: 8, epic: 4, legendary: 1 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
// `rng` (the seeded levelup stream) is optional — falls back to Math.random()
// outside a run so the menu/tutorial still work.
function _wrand(weights, rng = null) {
    const entries = Object.entries(weights);
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = (rng ? rng.next() : Math.random()) * total;
    for (const [key, w] of entries) {
        r -= w;
        if (r <= 0) return key;
    }
    return entries[entries.length - 1][0];
}

function _bonusRarity(pct) {
    if (pct <= 1.5)  return 'common';
    if (pct <= 3.0)  return 'uncommon';
    if (pct <= 6.0)  return 'rare';
    if (pct <= 10.0) return 'epic';
    return 'legendary';
}

// Luck-skewed unit roll in [0, 1). Used to bias a within-tier % roll toward the
// high end of its band: u^(1/luck). At luck = 1 it's uniform; luck > 1 pushes
// the result toward 1 (higher %), luck < 1 toward 0 (lower %). This stacks on
// top of luck's existing influence over which tier gets rolled.
function _luckyUnit(luck, rng = null) {
    return Math.pow(rng ? rng.next() : Math.random(), 1 / Math.max(0.1, luck));
}

// ─── Choice generation ────────────────────────────────────────────────────────
// typePickCounts: { offense: n, defense: n, ... } — accumulated across the run.
// bonusMult: scalar applied to the rolled %/flat (from the skip-stacking system).
function rollChoices(luck, typePickCounts = {}, bonusMult = 1, rng = null) {
    const lk = Math.max(0.1, luck);

    // Neither stat-category nor bonus-tier selection is influenced by luck —
    // luck only biases the within-tier % roll toward the high end (via
    // _luckyUnit in _makeChoice).
    const catW   = { ...CAT_BASE_W };
    const bonusW = { ...BONUS_BASE_W };

    const used = new Set();
    const allDefs = [
        ...STAT_DEFS.common,
        ...STAT_DEFS.uncommon,
        ...STAT_DEFS.rare,
        ...STAT_DEFS.epic,
    ];
    const rollTypeCounts = {}; // types already represented in THIS roll
    const choices = [];

    const _filterByDiversity = (pool) =>
        pool.filter(s => (rollTypeCounts[STAT_TYPE[s.id]] || 0) < MAX_PER_TYPE_PER_ROLL);

    const _pickFromPool = (pool) => {
        // Weight each stat by 1 / (1 + BIAS_K * accumulated picks of its type).
        // Soft bias: heavily-picked types are less likely but never excluded.
        const weights = pool.map(s => {
            const t = STAT_TYPE[s.id];
            const c = (typePickCounts[t] || 0);
            return 1 / (1 + BIAS_K * c);
        });
        let total = 0;
        for (const w of weights) total += w;
        let r = (rng ? rng.next() : Math.random()) * total;
        for (let i = 0; i < pool.length; i++) {
            r -= weights[i];
            if (r <= 0) return pool[i];
        }
        return pool[pool.length - 1];
    };

    for (let i = 0; i < 4; i++) {
        let cat = _wrand(catW, rng);
        const isCursed = cat === 'cursed';
        if (isCursed) cat = _wrand({ common: 60, uncommon: 25, rare: 15, epic: 2 }, rng);

        // Prefer pool that satisfies diversity cap; fall back to broader pools.
        let pool = _filterByDiversity(STAT_DEFS[cat].filter(s => !used.has(s.id)));
        if (pool.length === 0) {
            pool = _filterByDiversity(allDefs.filter(s => !used.has(s.id)));
        }
        if (pool.length === 0) {
            // Cap saturated — relax diversity so we can still fill slots.
            pool = allDefs.filter(s => !used.has(s.id));
        }
        if (pool.length === 0) break;

        const stat = _pickFromPool(pool);
        used.add(stat.id);
        rollTypeCounts[STAT_TYPE[stat.id]] = (rollTypeCounts[STAT_TYPE[stat.id]] || 0) + 1;
        choices.push(_makeChoice(stat, isCursed, bonusW, bonusMult, lk, rng));
    }
    return choices;
}

function _makeChoice(stat, isCursed, bonusW, bonusMult = 1, luck = 1, rng = null) {
    if (stat.flat) {
        // Flat upgrades: scale the count by bonusMult.
        // extra_projectile is integer (round), hp_regen is float (0.1 * mult).
        const baseFlatStr = stat.flat;
        let flatMag, flatUnit, flatBase;
        if (stat.id === 'extra_projectile') {
            flatBase = 1;
            flatMag  = Math.max(1, Math.round(flatBase * bonusMult));
            flatUnit = 'SHOT' + (flatMag === 1 ? '' : 'S');
        } else { // hp_regen
            flatBase = 0.1;
            flatMag  = flatBase * bonusMult;
            flatUnit = 'HP/S';
        }
        const sign = isCursed ? '-' : '+';
        const flatDisplay = stat.id === 'extra_projectile'
            ? `${sign}${flatMag} ${flatUnit}`
            : `${sign}${flatMag.toFixed(2)} ${flatUnit}`;
        // baseFlatDisplay: what it would have been at 1x — used for the strikethrough UI.
        const baseFlatDisplay = bonusMult > 1.00001 ? (isCursed ? baseFlatStr.replace('+', '-') : baseFlatStr) : null;

        return {
            stat, isCursed,
            pct: 0,
            flatDisplay,
            baseFlatDisplay,
            flatValue: flatMag,
            bonusMult,
            bonusRarity: 'rare',
            bonusColor: isCursed ? '#664433' : RARITY_COLORS.rare,
            category: STAT_CAT[stat.id] || 'rare',
            type: STAT_TYPE[stat.id] || 'utility',
        };
    }

    // Luck rolls low and is hard-capped — it's always displayed as epic tier
    // regardless of the (small) rolled value.
    if (stat.id === 'luck') {
        // Non-cursed luck rolls lean high with luck; cursed stays uniform so
        // good luck never deepens a curse.
        const luckUnit    = isCursed ? (rng ? rng.next() : Math.random()) : _luckyUnit(luck, rng);
        const baseLuckPct = LUCK_TIER.min + luckUnit * (LUCK_TIER.max - LUCK_TIER.min);
        const luckPct     = Math.min(LUCK_MAX_PCT, baseLuckPct * bonusMult);
        return {
            stat, isCursed,
            pct: isCursed ? -luckPct : luckPct,
            basePct: isCursed ? -baseLuckPct : baseLuckPct,
            bonusMult,
            flatDisplay: null,
            baseFlatDisplay: null,
            bonusRarity: 'epic',
            bonusColor: isCursed ? '#664433' : RARITY_COLORS.epic,
            category: 'epic',
            type: STAT_TYPE[stat.id] || 'utility',
        };
    }

    const tierName   = _wrand(bonusW, rng);
    const tier       = BONUS_TIERS[tierName];
    // Luck biases the roll toward the top of the chosen tier's band (cursed
    // rolls stay uniform so luck doesn't make the penalty worse).
    const tierUnit   = isCursed ? (rng ? rng.next() : Math.random()) : _luckyUnit(luck, rng);
    const basePct    = tier.min + tierUnit * (tier.max - tier.min);
    const pct        = basePct * bonusMult;
    const bonusRarity = _bonusRarity(pct);

    return {
        stat, isCursed,
        pct: isCursed ? -pct : pct,
        basePct: isCursed ? -basePct : basePct,
        bonusMult,
        flatDisplay: null,
        baseFlatDisplay: null,
        bonusRarity,
        bonusColor: isCursed ? '#664433' : RARITY_COLORS[bonusRarity],
        category: STAT_CAT[stat.id] || 'common',
        type: STAT_TYPE[stat.id] || 'utility',
    };
}

// ─── Apply a chosen upgrade to the player ────────────────────────────────────
export function applyLevelUpChoice(choice, player, playingState) {
    const { stat, isCursed, pct, flatValue } = choice;
    const absPct = Math.abs(pct) / 100;

    switch (stat.id) {
        // ── Common ──────────────────────────────────────────────────────────
        case 'damage':
            player.lvlDamageMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'max_hp':
            player.lvlMaxHpMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'max_shield':
            player.lvlMaxShieldMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'shield_drain':
            // Positive: reduces drain  →  mult goes DOWN
            player.lvlShieldDrainMult *= isCursed ? (1 + absPct) : (1 - absPct); break;
        case 'ship_speed':
            player.lvlSpeedMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'projectile_speed':
            player.lvlProjectileSpeedMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'boost_recharge':
            // Positive: reduces cooldown  →  mult goes DOWN
            player.lvlBoostCooldownMult *= isCursed ? (1 + absPct) : (1 - absPct); break;
        case 'firerate':
            // Positive: reduces shootCooldown  →  mult goes DOWN
            player.lvlFireRateMult *= isCursed ? (1 + absPct) : (1 - absPct); break;

        // ── Uncommon ────────────────────────────────────────────────────────
        case 'shield_recharge':
            player.lvlShieldRechargeMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'exp_gain':
            player.lvlExpGainMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'boost_speed':
            player.lvlBoostSpeedMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'boost_duration':
            player.lvlBoostDurationMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'asteroid_resistance':
            // Positive: less damage  →  mult goes DOWN
            player.lvlAsteroidResistanceMult *= isCursed ? (1 + absPct) : (1 - absPct); break;
        case 'asteroid_spawn':
            player.lvlAsteroidSpawnMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'vacuum_range':
            player.lvlVacuumRangeMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'turn_speed':
            player.lvlTurnSpeedMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'shield_damage':
            player.lvlShieldDamageMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'fov':
            player.lvlFovMult *= isCursed ? (1 - absPct) : (1 + absPct); break;

        // ── Rare ────────────────────────────────────────────────────────────
        case 'extra_projectile': {
            const delta = (flatValue != null ? flatValue : 1) * (isCursed ? -1 : 1);
            player.lvlExtraProjectiles = Math.max(0, player.lvlExtraProjectiles + delta);
            break;
        }
        case 'scrap_chance':
            player.lvlScrapChanceMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'cache_freq':
            player.lvlCacheFreqMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'encounter_freq':
            player.lvlEncounterFreqMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'enemy_spawn':
            player.lvlEnemySpawnMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'difficulty_gain':
            player.lvlDifficultyMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
        case 'wave_countdown':
            // Positive: shorter wave timer  →  mult goes DOWN
            player.lvlWaveCountdownMult *= isCursed ? (1 + absPct) : (1 - absPct); break;
        case 'hp_regen': {
            const delta = (flatValue != null ? flatValue : 0.1) * (isCursed ? -1 : 1);
            player.lvlHpRegen += delta;
            break;
        }

        // ── Epic ────────────────────────────────────────────────────────────
        case 'luck':
            player.lvlLuckMult *= isCursed ? (1 - absPct) : (1 + absPct); break;
    }

    // Resync inventory-derived stats (max hp, speed, fire rate, etc.)
    if (playingState && playingState._onInventoryChanged) {
        playingState._onInventoryChanged();
    }
}

// ─── Dialog class ─────────────────────────────────────────────────────────────
export class LevelUpDialog {
    constructor(game, player, playingState, level) {
        this.game        = game;
        this.player      = player;
        this.playingState = playingState;
        this.level       = level;
        this.closed      = false;
        this.hoveredChoice = -1;
        this.bonusMult   = playingState ? (playingState.pendingLevelUpMult || 1) : 1;
        // Level-up choices use the seeded levelup stream (reproducible).
        this.choices     = rollChoices(player.luck, player.upgradeTypeCounts || {}, this.bonusMult, game.rng ? game.rng.levelup : null);
        this.skipsRemaining = playingState ? (playingState.levelUpSkipsRemaining || 0) : 0;
        this.canSkip     = this.skipsRemaining > 0;
        this.appearTimer = 0;
        this.appearDuration = 0.25;
        this._cardRects  = [];
        this._skipRect   = null;
        // Gamepad/keyboard-driven selection, independent of mouse hover.
        // Index range: [0, choices.length) for stat cards, choices.length for skip.
        this.keyboardSelected = 0;
        this._stickLatched = false;
    }

    _selectableCount() {
        return this.choices.length + (this.canSkip ? 1 : 0);
    }

    _stepSelection(dir) {
        const n = this._selectableCount();
        if (n === 0) return;
        this.keyboardSelected = ((this.keyboardSelected + dir) % n + n) % n;
        this.game.sounds.play('click', 0.4);
    }

    update(dt) {
        if (this.closed) return;
        this.appearTimer = Math.min(this.appearDuration, this.appearTimer + dt);

        const input = this.game.input;

        // Number key shortcuts 1–4 (choices), 5 (skip)
        for (let i = 0; i < this.choices.length; i++) {
            if (input.isKeyJustPressed(`Digit${i + 1}`)) {
                this._selectChoice(i);
                return;
            }
        }
        if (this.canSkip && input.isKeyJustPressed(`Digit${this.choices.length + 1}`)) {
            this._skipChoice();
            return;
        }

        // Mouse click (hit-test uses rects from previous draw)
        if (input.isMouseJustPressed(0) && this.hoveredChoice >= 0) {
            if (this.hoveredChoice === this.choices.length) {
                if (this.canSkip) this._skipChoice();
            } else {
                this._selectChoice(this.hoveredChoice);
            }
            return;
        }

        // Keyboard navigation
        if (input.isKeyJustPressed('ArrowUp')   || input.isKeyJustPressed('KeyW')) this._stepSelection(-1);
        if (input.isKeyJustPressed('ArrowDown') || input.isKeyJustPressed('KeyS')) this._stepSelection(1);

        // Gamepad navigation
        if (input.isGamepadJustPressed(GP.DUP))   this._stepSelection(-1);
        if (input.isGamepadJustPressed(GP.DDOWN)) this._stepSelection(1);
        const stickY = input.leftStickY;
        if (Math.abs(stickY) > 0.55) {
            if (!this._stickLatched) {
                this._stickLatched = true;
                this._stepSelection(stickY < 0 ? -1 : 1);
            }
        } else if (Math.abs(stickY) < 0.25) {
            this._stickLatched = false;
        }

        if (input.isGamepadJustPressed(GP.A) || input.isKeyJustPressed('Enter')) {
            const idx = this.keyboardSelected;
            if (idx >= 0 && idx < this.choices.length) {
                this._selectChoice(idx);
            } else if (this.canSkip && idx === this.choices.length) {
                this._skipChoice();
            }
        }
    }

    _selectChoice(index) {
        if (index < 0 || index >= this.choices.length) return;
        const choice = this.choices[index];
        applyLevelUpChoice(choice, this.player, this.playingState);

        // Track per-type pick history (positive picks only — cursed picks were
        // chosen too, so they still count as the player "investing" in that type).
        const t = STAT_TYPE[choice.stat.id];
        if (t && this.player.upgradeTypeCounts) {
            this.player.upgradeTypeCounts[t] = (this.player.upgradeTypeCounts[t] || 0) + 1;
        }

        // Picking cashes in the banked multiplier. The skip budget is a
        // per-run pool — it persists across picks and only refills on new game.
        if (this.playingState) {
            this.playingState.pendingLevelUpMult = 1;
        }
        this.game.sounds.play('select', 0.7);

        if (this.game.achievements) {
            // "Natural legendary" = base roll landed in the legendary tier
            // (basePct >= 10) BEFORE any skip-stacking multiplier. Cursed
            // picks aren't a "bonus" — exclude them.
            const naturalLegendary = !choice.isCursed
                && typeof choice.basePct === 'number'
                && choice.basePct >= 10;
            this.game.achievements.notify('level_up_chosen', {
                statId: choice.stat.id,
                statType: STAT_TYPE[choice.stat.id] || 'utility',
                naturalLegendary
            });
        }

        this.closed = true;
    }

    _skipChoice() {
        if (!this.canSkip || !this.playingState) return;
        // Decrement skips and bank the next-roll multiplier.
        this.playingState.levelUpSkipsRemaining = Math.max(0, this.playingState.levelUpSkipsRemaining - 1);
        this.playingState.pendingLevelUpMult    = (this.playingState.pendingLevelUpMult || 1)
            * (this.playingState.LEVELUP_SKIP_MULT_STEP || 1.8);
        this.game.sounds.play('click', 0.6);

        if (this.game.achievements) {
            this.game.achievements.notify('level_skipped');
        }

        this.closed = true;
    }

    draw(ctx) {
        if (this.closed) return;

        const cw      = this.game.width;
        const ch      = this.game.height;
        const us      = this.game.uiScale;
        const t       = this.appearTimer / this.appearDuration;
        const eased   = 1 - Math.pow(1 - Math.min(1, t), 3);

        // Dim backdrop
        ctx.fillStyle = `rgba(0,0,0,${0.85 * eased})`;
        ctx.fillRect(0, 0, cw, ch);
        if (eased < 0.01) return;

        ctx.save();
        ctx.globalAlpha = eased;

        const pad       = Math.floor(7  * us);
        const titleSize = Math.floor(9  * us);
        const subSize   = Math.floor(5  * us);
        const fontSize  = Math.floor(6  * us);
        const descSize  = Math.floor(5  * us);
        const lh        = Math.floor(fontSize * 1.55);

        const panelW   = Math.min(cw * 0.65, Math.floor(180 * us));
        const cardH    = Math.floor(40 * us);
        const cardGap  = Math.floor(3  * us);
        const skipCardH = Math.floor(18 * us);
        const headerH  = titleSize + subSize + pad * 2;
        const skipBlockH = this.canSkip ? (skipCardH + cardGap) : 0;
        const panelH   = headerH + this.choices.length * (cardH + cardGap) + skipBlockH + pad;
        const panelX   = Math.floor((cw - panelW) / 2);
        const panelY   = Math.floor((ch - panelH) / 2);

        // ── Panel ──────────────────────────────────────────────────────────
        ctx.fillStyle   = '#0a101a';
        ctx.strokeStyle = '#223344';
        ctx.lineWidth   = 2;
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeRect(panelX, panelY, panelW, panelH);

        // ── Title ──────────────────────────────────────────────────────────
        const hasMult = this.bonusMult > 1.00001;
        ctx.font         = `${titleSize}px Astro5x`;
        ctx.fillStyle    = hasMult ? '#ffd866' : '#ffff44';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        const titleStr = hasMult
            ? `LEVEL UP!  x${this.bonusMult.toFixed(2)}`
            : 'LEVEL UP!';
        ctx.fillText(titleStr, cw / 2, panelY + pad);

        ctx.font      = `${subSize}px Astro4x`;
        ctx.fillStyle = hasMult ? '#aa8844' : '#778899';
        const subStr = hasMult
            ? `LEVEL ${this.level}  -  BONUS FROM SKIPS`
            : `LEVEL ${this.level}  -  CHOOSE A STAT UPGRADE`;
        ctx.fillText(
            subStr,
            cw / 2,
            panelY + pad + titleSize + Math.floor(2 * us)
        );

        // Divider
        const divY = panelY + headerH - Math.floor(2 * us);
        ctx.strokeStyle = '#1a2d3e';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(panelX + pad, divY);
        ctx.lineTo(panelX + panelW - pad, divY);
        ctx.stroke();

        // ── Cards ─────────────────────────────────────────────────────────
        const mouse = this.game.getMousePos();
        this.hoveredChoice = -1;
        this._cardRects    = [];

        const gamepadActive = this.game.input.isGamepadActive();

        for (let i = 0; i < this.choices.length; i++) {
            const ch2    = this.choices[i];
            const cardX  = panelX + pad;
            const cardW  = panelW - pad * 2;
            const cardY  = panelY + headerH + i * (cardH + cardGap);
            this._cardRects.push({ x: cardX, y: cardY, w: cardW, h: cardH });

            const mouseHover = mouse.x >= cardX && mouse.x <= cardX + cardW &&
                               mouse.y >= cardY && mouse.y <= cardY + cardH;
            if (mouseHover) this.hoveredChoice = i;
            const hovered = gamepadActive ? (this.keyboardSelected === i) : mouseHover;

            // Card background
            ctx.fillStyle   = hovered ? '#12202e' : '#0d1820';
            ctx.strokeStyle = hovered ? '#445566' : '#1a2d3e';
            ctx.lineWidth   = 1;
            ctx.fillRect(cardX, cardY, cardW, cardH);
            ctx.strokeRect(cardX, cardY, cardW, cardH);

            const ip      = Math.floor(pad * 0.7);
            const topLineY = cardY + Math.floor(cardH * 0.35);
            const botLineY = cardY + Math.floor(cardH * 0.7);

            // Number
            ctx.font         = `${fontSize}px Astro5x`;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = hovered ? '#aabbcc' : '#556677';
            const numStr = `[${i + 1}]`;
            const numW   = ctx.measureText(numStr + ' ').width;
            ctx.fillText(numStr, cardX + ip, topLineY);

            // Stat name
            const nameX = cardX + ip + numW;
            ctx.font      = `${fontSize}px Astro5x`;
            ctx.fillStyle = ch2.isCursed ? '#cc7744' : (hovered ? '#ffffff' : '#ccddee');
            const displayName = ch2.isCursed
                ? `[CURSED] ${ch2.stat.name.toUpperCase()}`
                : ch2.stat.name.toUpperCase();
            ctx.fillText(displayName, nameX, topLineY);

            // Bonus value — right-aligned, rarity-coloured.
            // When a skip multiplier is banked, draw the un-multiplied value
            // crossed out before the boosted value (e.g. "+1.4%  +2.5%").
            const bonusStr = ch2.flatDisplay
                ? ch2.flatDisplay
                : `${ch2.pct >= 0 ? '+' : ''}${ch2.pct.toFixed(1)}%`;
            ctx.font      = `${fontSize}px Astro5x`;
            ctx.textAlign = 'right';
            const bonusRightX = cardX + cardW - ip;

            const showBase = hasMult && !ch2.isCursed && (
                (ch2.baseFlatDisplay != null) ||
                (ch2.basePct != null && Math.abs(ch2.basePct) > 0.001)
            );

            if (showBase) {
                const baseStr = ch2.baseFlatDisplay
                    ? ch2.baseFlatDisplay
                    : `${ch2.basePct >= 0 ? '+' : ''}${ch2.basePct.toFixed(1)}%`;
                const gap = Math.floor(4 * us);
                const bonusW = ctx.measureText(bonusStr).width;
                // Draw boosted value (right-aligned).
                ctx.fillStyle = ch2.bonusColor;
                ctx.fillText(bonusStr, bonusRightX, topLineY);
                // Draw base value to the left, dimmer, with strikethrough.
                const baseRightX = bonusRightX - bonusW - gap;
                ctx.fillStyle = hovered ? '#667788' : '#445566';
                ctx.fillText(baseStr, baseRightX, topLineY);
                const baseW = ctx.measureText(baseStr).width;
                ctx.strokeStyle = ctx.fillStyle;
                ctx.lineWidth = Math.max(1, Math.floor(us));
                const strikeY = topLineY;
                ctx.beginPath();
                ctx.moveTo(baseRightX - baseW, strikeY);
                ctx.lineTo(baseRightX,         strikeY);
                ctx.stroke();
            } else {
                ctx.fillStyle = ch2.bonusColor;
                ctx.fillText(bonusStr, bonusRightX, topLineY);
            }

            // Description
            ctx.font         = `${descSize}px Astro4x`;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = hovered ? '#7799aa' : '#445566';
            const descStr = ch2.isCursed
                ? `CURSED: ${ch2.stat.desc.toLowerCase()}`
                : ch2.stat.desc;
            ctx.fillText(descStr, nameX, botLineY);

            // Type label — right-aligned, very subtle (offense/defense/...)
            ctx.font      = `${descSize}px Astro4x`;
            ctx.textAlign = 'right';
            ctx.fillStyle = ch2.isCursed ? '#664433' : (hovered ? '#445566' : '#1e2e3e');
            ctx.fillText(
                (ch2.isCursed ? 'CURSED' : ch2.type).toUpperCase(),
                cardX + cardW - ip, botLineY
            );
        }

        // ── Skip card ─────────────────────────────────────────────────────
        this._skipRect = null;
        if (this.canSkip) {
            const skipIdx = this.choices.length;
            const skipX = panelX + pad;
            const skipW = panelW - pad * 2;
            const skipY = panelY + headerH + this.choices.length * (cardH + cardGap);
            this._skipRect = { x: skipX, y: skipY, w: skipW, h: skipCardH };

            const skipMouseHover = mouse.x >= skipX && mouse.x <= skipX + skipW &&
                                   mouse.y >= skipY && mouse.y <= skipY + skipCardH;
            if (skipMouseHover) this.hoveredChoice = skipIdx;
            const skipHovered = gamepadActive ? (this.keyboardSelected === skipIdx) : skipMouseHover;

            ctx.fillStyle   = skipHovered ? '#22281a' : '#161a10';
            ctx.strokeStyle = skipHovered ? '#998844' : '#3e4422';
            ctx.lineWidth   = 1;
            ctx.fillRect(skipX, skipY, skipW, skipCardH);
            ctx.strokeRect(skipX, skipY, skipW, skipCardH);

            const ip = Math.floor(pad * 0.7);
            const midY = skipY + Math.floor(skipCardH / 2);

            ctx.font         = `${fontSize}px Astro5x`;
            ctx.textBaseline = 'middle';

            ctx.textAlign = 'left';
            ctx.fillStyle = skipHovered ? '#aabbcc' : '#556677';
            const skipNum = `[${skipIdx + 1}]`;
            const skipNumW = ctx.measureText(skipNum + ' ').width;
            ctx.fillText(skipNum, skipX + ip, midY);

            ctx.fillStyle = skipHovered ? '#ffe088' : '#bba844';
            const nextMult = (this.bonusMult || 1) * (this.playingState
                ? (this.playingState.LEVELUP_SKIP_MULT_STEP || 1.8)
                : 1.8);
            const skipLabel = `SKIP  -  x${nextMult.toFixed(2)} ON NEXT ROLL`;
            ctx.fillText(skipLabel, skipX + ip + skipNumW, midY);

            ctx.textAlign = 'right';
            ctx.fillStyle = skipHovered ? '#bbaa66' : '#776633';
            ctx.fillText(
                `${this.skipsRemaining} SKIP${this.skipsRemaining === 1 ? '' : 'S'} LEFT`,
                skipX + skipW - ip, midY
            );
        }

        // Draw selection corners around the gamepad-focused card so the
        // highlight matches the rest of the inventory UI.
        if (gamepadActive && this.keyboardSelected >= 0) {
            if (this.keyboardSelected < this._cardRects.length) {
                const card = this._cardRects[this.keyboardSelected];
                this._drawCorners(ctx, card.x, card.y, card.w, card.h);
            } else if (this._skipRect && this.keyboardSelected === this.choices.length) {
                const sr = this._skipRect;
                this._drawCorners(ctx, sr.x, sr.y, sr.w, sr.h);
            }
        }

        ctx.restore();
    }

    _drawCorners(ctx, x, y, w, h) {
        const uiScale = this.game.uiScale;
        const tl = this.game.assets.get('corner_tl');
        const tr = this.game.assets.get('corner_tr');
        const bl = this.game.assets.get('corner_bl');
        const br = this.game.assets.get('corner_br');
        if (!tl || !tr || !bl || !br) return;
        const cw = Math.round((tl.width  || tl.canvas.width)  * uiScale);
        const ch = Math.round((tl.height || tl.canvas.height) * uiScale);
        const prev = ctx.imageSmoothingEnabled;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tl.canvas || tl, Math.round(x),          Math.round(y),          cw, ch);
        ctx.drawImage(tr.canvas || tr, Math.round(x + w - cw), Math.round(y),          cw, ch);
        ctx.drawImage(bl.canvas || bl, Math.round(x),          Math.round(y + h - ch), cw, ch);
        ctx.drawImage(br.canvas || br, Math.round(x + w - cw), Math.round(y + h - ch), cw, ch);
        ctx.imageSmoothingEnabled = prev;
    }
}
