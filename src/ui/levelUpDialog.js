/**
 * LevelUpDialog — modal stat-upgrade picker shown on each level-up.
 *
 * 4 choices are rolled per level; player must pick one.
 * Multiple level-ups queue additional dialogs that open in sequence.
 *
 * Bonus % ranges (also determine the highlight colour):
 *   Common    0.5 – 1.5 %
 *   Uncommon  1.5 – 3.0 %
 *   Rare      3.0 – 6.0 %
 *   Epic      6.0 – 10.0 %
 *   Legendary 10.0 – 20.0 %
 *
 * Luck (player.luck) shifts rolls toward rarer tiers.
 * Cursed choices are extremely rare and reverse every effect.
 */

import { RARITY_COLORS } from '../data/upgrades.js';

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
};

// Build stat-id → category lookup
const STAT_CAT = {};
for (const [cat, defs] of Object.entries(STAT_DEFS)) {
    for (const def of defs) STAT_CAT[def.id] = cat;
}

// ─── Bonus tier ranges [min%, max%] ──────────────────────────────────────────
const BONUS_TIERS = {
    common:    { min: 0.5,  max: 1.5  },
    uncommon:  { min: 1.5,  max: 3.0  },
    rare:      { min: 3.0,  max: 6.0  },
    epic:      { min: 6.0,  max: 10.0 },
    legendary: { min: 10.0, max: 20.0 },
};

// ─── Base weights ─────────────────────────────────────────────────────────────
const CAT_BASE_W   = { common: 60, uncommon: 25, rare: 12, cursed: 3 };
const BONUS_BASE_W = { common: 67, uncommon: 20, rare: 8, epic: 4, legendary: 1 };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _wrand(weights) {
    const entries = Object.entries(weights);
    let total = 0;
    for (const [, w] of entries) total += w;
    let r = Math.random() * total;
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

// ─── Choice generation ────────────────────────────────────────────────────────
function rollChoices(luck) {
    const lk = Math.max(0.1, luck);

    const catW = {
        common:   Math.max(5, CAT_BASE_W.common / lk),
        uncommon: CAT_BASE_W.uncommon * Math.sqrt(lk),
        rare:     CAT_BASE_W.rare     * lk,
        cursed:   CAT_BASE_W.cursed   / (lk * lk),
    };
    const bonusW = {
        common:    Math.max(5, BONUS_BASE_W.common / lk),
        uncommon:  BONUS_BASE_W.uncommon * Math.sqrt(lk),
        rare:      BONUS_BASE_W.rare     * lk,
        epic:      BONUS_BASE_W.epic     * lk * lk,
        legendary: BONUS_BASE_W.legendary * lk * lk,
    };

    const used = new Set();
    const allDefs = [
        ...STAT_DEFS.common,
        ...STAT_DEFS.uncommon,
        ...STAT_DEFS.rare,
    ];
    const choices = [];

    for (let i = 0; i < 4; i++) {
        let cat = _wrand(catW);
        const isCursed = cat === 'cursed';
        if (isCursed) cat = _wrand({ common: 60, uncommon: 25, rare: 15 });

        let pool = STAT_DEFS[cat].filter(s => !used.has(s.id));
        if (pool.length === 0) pool = allDefs.filter(s => !used.has(s.id));
        if (pool.length === 0) break;

        const stat = pool[Math.floor(Math.random() * pool.length)];
        used.add(stat.id);
        choices.push(_makeChoice(stat, isCursed, bonusW));
    }
    return choices;
}

function _makeChoice(stat, isCursed, bonusW) {
    if (stat.flat) {
        let flatDisplay = stat.flat;
        if (isCursed) {
            flatDisplay = stat.id === 'extra_projectile' ? '-1 SHOT' : '-0.1 HP/S';
        }
        return {
            stat, isCursed,
            pct: 0,
            flatDisplay,
            bonusRarity: 'rare',
            bonusColor: isCursed ? '#664433' : RARITY_COLORS.rare,
            category: STAT_CAT[stat.id] || 'rare',
        };
    }

    const tierName   = _wrand(bonusW);
    const tier       = BONUS_TIERS[tierName];
    const pct        = tier.min + Math.random() * (tier.max - tier.min);
    const bonusRarity = _bonusRarity(pct);

    return {
        stat, isCursed,
        pct: isCursed ? -pct : pct,
        flatDisplay: null,
        bonusRarity,
        bonusColor: isCursed ? '#664433' : RARITY_COLORS[bonusRarity],
        category: STAT_CAT[stat.id] || 'common',
    };
}

// ─── Apply a chosen upgrade to the player ────────────────────────────────────
export function applyLevelUpChoice(choice, player, playingState) {
    const { stat, isCursed, pct } = choice;
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
        case 'extra_projectile':
            player.lvlExtraProjectiles = Math.max(0, player.lvlExtraProjectiles + (isCursed ? -1 : 1)); break;
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
        case 'hp_regen':
            player.lvlHpRegen += isCursed ? -0.1 : 0.1; break;
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
        this.choices     = rollChoices(player.luck);
        this.appearTimer = 0;
        this.appearDuration = 0.25;
        this._cardRects  = [];
    }

    update(dt) {
        if (this.closed) return;
        this.appearTimer = Math.min(this.appearDuration, this.appearTimer + dt);

        const input = this.game.input;

        // Number key shortcuts 1–4
        for (let i = 0; i < this.choices.length; i++) {
            if (input.isKeyJustPressed(`Digit${i + 1}`)) {
                this._selectChoice(i);
                return;
            }
        }

        // Mouse click (hit-test uses rects from previous draw)
        if (input.isMouseJustPressed(0) && this.hoveredChoice >= 0) {
            this._selectChoice(this.hoveredChoice);
        }
    }

    _selectChoice(index) {
        if (index < 0 || index >= this.choices.length) return;
        applyLevelUpChoice(this.choices[index], this.player, this.playingState);
        this.game.sounds.play('select', 0.7);
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

        const panelW  = Math.min(cw * 0.65, Math.floor(180 * us));
        const cardH   = Math.floor(40 * us);
        const cardGap = Math.floor(3  * us);
        const headerH = titleSize + subSize + pad * 2;
        const panelH  = headerH + this.choices.length * (cardH + cardGap) + pad;
        const panelX  = Math.floor((cw - panelW) / 2);
        const panelY  = Math.floor((ch - panelH) / 2);

        // ── Panel ──────────────────────────────────────────────────────────
        ctx.fillStyle   = '#0a101a';
        ctx.strokeStyle = '#223344';
        ctx.lineWidth   = 2;
        ctx.fillRect(panelX, panelY, panelW, panelH);
        ctx.strokeRect(panelX, panelY, panelW, panelH);

        // ── Title ──────────────────────────────────────────────────────────
        ctx.font         = `${titleSize}px Astro5x`;
        ctx.fillStyle    = '#ffff44';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('LEVEL UP!', cw / 2, panelY + pad);

        ctx.font      = `${subSize}px Astro4x`;
        ctx.fillStyle = '#778899';
        ctx.fillText(
            `LEVEL ${this.level}  —  CHOOSE A STAT UPGRADE`,
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

        for (let i = 0; i < this.choices.length; i++) {
            const ch2    = this.choices[i];
            const cardX  = panelX + pad;
            const cardW  = panelW - pad * 2;
            const cardY  = panelY + headerH + i * (cardH + cardGap);
            this._cardRects.push({ x: cardX, y: cardY, w: cardW, h: cardH });

            const hovered = mouse.x >= cardX && mouse.x <= cardX + cardW &&
                            mouse.y >= cardY && mouse.y <= cardY + cardH;
            if (hovered) this.hoveredChoice = i;

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

            // Bonus value — right-aligned, rarity-coloured
            const bonusStr = ch2.flatDisplay
                ? ch2.flatDisplay
                : `${ch2.pct >= 0 ? '+' : ''}${ch2.pct.toFixed(1)}%`;
            ctx.font      = `${fontSize}px Astro5x`;
            ctx.textAlign = 'right';
            ctx.fillStyle = ch2.bonusColor;
            ctx.fillText(bonusStr, cardX + cardW - ip, topLineY);

            // Description
            ctx.font         = `${descSize}px Astro4x`;
            ctx.textAlign    = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle    = hovered ? '#7799aa' : '#445566';
            const descStr = ch2.isCursed
                ? `CURSED: ${ch2.stat.desc.toLowerCase()}`
                : ch2.stat.desc;
            ctx.fillText(descStr, nameX, botLineY);

            // Category label — right-aligned, very subtle
            ctx.font      = `${descSize}px Astro4x`;
            ctx.textAlign = 'right';
            ctx.fillStyle = ch2.isCursed ? '#664433' : (hovered ? '#445566' : '#1e2e3e');
            ctx.fillText(
                (ch2.isCursed ? 'CURSED' : ch2.category).toUpperCase(),
                cardX + cardW - ip, botLineY
            );
        }

        ctx.restore();
    }
}
