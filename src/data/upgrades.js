/**
 * Upgrade item definitions.
 * Size is [width, height] in grid cells.
 */
export const UPGRADES = [
    {
        id: 'blink_engine',
        name: 'Blink Engine',
        description: 'Adds teleport ability. If already present, reduces cooldown.',
        assetKey: 'blink_engine_3x2',
        width: 3,
        height: 2,
        cost: 60,
        rarity: 'rare'
    },
    {
        id: 'small_battery',
        name: 'Small Battery',
        description: 'Restores 20% health. Consumed on use (Right-click in cargo).',
        assetKey: 'small_battery_1x1',
        width: 1,
        height: 1,
        cost: 20,
        rarity: 'common',
        consumable: true,
        combine: {
            stat: 'heal',
            base: 0.20,
            legendary: 8.00,
            descTemplate: 'Restores {bonus} health. Consumed on use (Right-click in cargo).'
        }
    },
    {
        id: 'firing_coordinator',
        name: 'Firing Coordinator',
        description: 'Increases shooting speed by 10%.',
        assetKey: 'firing_coordinator_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'common',
        combine: {
            stat: 'fireRate',
            base: 0.10,
            legendary: 2.00,
            descTemplate: 'Increases shooting speed by {bonus}.'
        }
    },
    {
        id: 'energy_canisters',
        name: 'Energy Canisters',
        description: 'Increases max health by 60%.',
        assetKey: 'energy_canisters_2x2',
        width: 2,
        height: 2,
        cost: 80,
        rarity: 'uncommon',
        combine: {
            stat: 'maxHealth',
            base: 0.60,
            legendary: 1.40,
            descTemplate: 'Increases max health by {bonus}.'
        }
    },
    {
        id: 'pulse_boosters',
        name: 'Pulse Boosters',
        description: 'Increases boost range and reduces cooldown.',
        assetKey: 'pulse_boosters_2x2',
        width: 2,
        height: 2,
        cost: 40,
        rarity: 'rare',
        combine: {
            stat: 'pulseBoost',
            base: 0.40,
            legendary: 0.85,
            descTemplate: 'Increases boost range by {bonus} and reduces cooldown.'
        }
    },
    {
        id: 'field_array',
        name: 'Field Array',
        description: 'Reduces shield energy drain.',
        assetKey: 'field_array_2x2',
        width: 2,
        height: 2,
        cost: 50,
        rarity: 'uncommon',
        combine: {
            stat: 'shieldDrain',
            base: 0.30,
            legendary: 0.55,
            descTemplate: 'Reduces shield energy drain by {bonus}.'
        }
    },
    {
        id: 'auto_turret',
        name: 'Auto Turret',
        description: 'Automatically shoots at enemies in a 50° cone in front of you.',
        assetKey: 'auto_turret_3x2',
        width: 3,
        height: 2,
        cost: 60,
        rarity: 'rare'
    },
    {
        id: 'scrap_drone',
        name: 'Scrap Drone',
        description: 'Increases the vacuum range for pulling in scrap from further away.',
        assetKey: 'scrap_drone_1x1',
        width: 1,
        height: 1,
        cost: 30,
        rarity: 'uncommon',
        combine: {
            stat: 'scrapRange',
            base: 3.0,
            legendary: 8.0,
            descTemplate: 'Increases the vacuum range for pulling in scrap (by {bonus}).'
        }
    },
    {
        id: 'mechanical_claw',
        name: 'Mechanical Claw',
        description: 'Freezes nearby enemies in place for 3 seconds.',
        assetKey: 'mechnaical_claw_2x1',
        width: 2,
        height: 1,
        cost: 70,
        rarity: 'rare'
    },
    {
        id: 'shop_map',
        name: 'Shop Map',
        description: 'Reveals the next nearest shop on your radar. Consumed on use (Right-click in cargo).',
        assetKey: 'shop_map_1x1',
        width: 1,
        height: 1,
        cost: 50,
        rarity: 'common',
        consumable: true
    },
    {
        id: 'railgun',
        name: 'Railgun',
        description: 'Slow firing but high damage beam. Overrides standard lasers.',
        assetKey: 'railgun_4x1',
        width: 4,
        height: 1,
        cost: 60,
        rarity: 'rare',
        combine: {
            stat: 'railgunDmg',
            curve: 'linear',
            base: 0,
            legendary: 1.00,
            descTemplate: 'Slow firing but high damage beam. Overrides standard lasers. Deals {bonus} more damage.'
        }
    },
    {
        id: 'energy_blaster',
        name: 'Energy Blaster',
        description: 'Converts shots into a shotgun blast of 3-5 lower damage shots. Reduces fire rate.',
        assetKey: 'energy_blaster_3x1',
        width: 3,
        height: 1,
        cost: 70,
        rarity: 'rare',
        combine: {
            stat: 'blasterShots',
            format: 'int',
            base: 0,
            legendary: 5,
            descTemplate: 'Converts shots into a shotgun blast of lower damage shots ({bonus} extra). Reduces fire rate.'
        }
    },
    {
        id: 'repeater',
        name: 'Repeater',
        description: 'Massively increases fire rate but reduces damage slightly.',
        assetKey: 'repeater_4x1',
        width: 4,
        height: 1,
        cost: 80,
        rarity: 'rare',
        combine: {
            stat: 'repeaterRate',
            curve: 'linear',
            base: 0,
            legendary: 0.60,
            descTemplate: 'Massively increases fire rate (+{bonus} more) but reduces damage slightly.'
        }
    },
    {
        id: 'laser_override',
        name: 'Laser Override',
        description: 'Converts all projectiles into massive versions that deal 30% more damage.',
        assetKey: 'laser_override_2x2',
        width: 2,
        height: 2,
        cost: 80,
        rarity: 'rare',
        combine: {
            stat: 'overrideDmg',
            base: 0.30,
            legendary: 1.00,
            descTemplate: 'Converts all projectiles into massive versions that deal {bonus} more damage.'
        }
    },
    {
        id: 'warning_system',
        name: 'Warning System',
        description: 'Displays indicators for incoming off-screen asteroids.',
        assetKey: 'warning_system_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'uncommon'
    },
    {
        id: 'pulse_jet',
        name: 'Pulse Jet',
        description: 'Increases ship speed by 15%.',
        assetKey: 'pulse_jet_2x1',
        width: 2,
        height: 1,
        cost: 30,
        rarity: 'uncommon',
        combine: {
            stat: 'pulseJet',
            base: 0.15,
            legendary: 0.45,
            descTemplate: 'Increases ship speed by {bonus}.'
        }
    },
    {
        id: 'shield_booster',
        name: 'Shield Booster',
        description: 'Increases maximum shields by 20%.',
        assetKey: 'shield_booster_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'common',
        combine: {
            stat: 'shieldBooster',
            base: 0.20,
            legendary: 2.50,
            descTemplate: 'Increases maximum shields by {bonus}.'
        }
    },
    {
        id: 'targeting_module',
        name: 'Targeting Module',
        description: 'Standard shots slightly seek towards enemies in front of you.',
        assetKey: 'targeting_module_2x2',
        width: 2,
        height: 2,
        cost: 50,
        rarity: 'rare',
        combine: {
            stat: 'aimCone',
            format: 'int',
            base: 10,
            legendary: 60,
            descTemplate: 'Standard shots seek towards enemies within a {bonus}° cone in front of you.'
        }
    },
    {
        id: 'control_module',
        name: 'Control Module',
        description: 'Increases projectile speed and reduces railgun charge time.',
        assetKey: 'control_module_1x2',
        width: 1,
        height: 2,
        cost: 40,
        rarity: 'rare',
        combine: {
            stat: 'projSpeed',
            base: 0.20,
            legendary: 0.60,
            descTemplate: 'Increases projectile speed by {bonus} and reduces railgun charge time.'
        }
    },
    {
        id: 'mechanical_engines',
        name: 'Mechanical Engines',
        description: 'Makes ship turning faster and increases speed by 25%.',
        assetKey: 'mechanical_engines_2x2',
        width: 2,
        height: 2,
        cost: 70,
        rarity: 'rare',
        combine: {
            stat: 'mechEngine',
            base: 0.25,
            legendary: 0.50,
            descTemplate: 'Makes ship turning faster and increases speed by {bonus}.'
        }
    },
    {
        id: 'multishot_guns',
        name: 'Multishot Guns',
        description: 'Fires two parallel shots. Reduces individual shot damage by 30%.',
        assetKey: 'multishot_guns_2x1',
        width: 2,
        height: 1,
        cost: 60,
        rarity: 'epic',
        combine: {
            stat: 'multishotPenalty',
            base: 0.30,
            legendary: 0.15,
            descTemplate: 'Fires two parallel shots. Reduces individual shot damage by {bonus}.'
        }
    },
    {
        id: 'high_density_capacitor',
        name: 'High Density Capacitor',
        description: 'Reduces the boost cooldown by 50%.',
        assetKey: 'high_density_capacitor_1x2',
        width: 1,
        height: 2,
        cost: 80,
        rarity: 'rare',
        combine: {
            stat: 'boostCooldown',
            base: 0.50,
            legendary: 0.70,
            descTemplate: 'Reduces the boost cooldown by {bonus}.'
        }
    },
    {
        id: 'energy_cell',
        name: 'Energy Cell',
        description: 'Increases shield recharge speed by 30%.',
        assetKey: 'energy_cell_1x2',
        width: 1,
        height: 2,
        cost: 50,
        rarity: 'uncommon',
        combine: {
            stat: 'shieldRegen',
            base: 0.30,
            legendary: 1.10,
            descTemplate: 'Increases shield recharge speed by {bonus}.'
        }
    },
    {
        id: 'explosives_unit',
        name: 'Explosives Unit',
        description: 'Makes all hits explode, dealing extra damage.',
        assetKey: 'explosives_unit_3x2',
        width: 3,
        height: 2,
        cost: 100,
        rarity: 'epic'
    },
    {
        id: 'small_boosters',
        name: 'Small Boosters',
        description: 'Gives a 10% speed increase for the ship\'s boost.',
        assetKey: 'small_boosters_1x2',
        width: 1,
        height: 2,
        cost: 30,
        rarity: 'uncommon',
        combine: {
            stat: 'boostSpeed',
            base: 0.10,
            legendary: 0.35,
            descTemplate: 'Gives a {bonus} speed increase for the ship\'s boost.'
        }
    },
    {
        id: 'rockets',
        name: 'Rockets',
        description: 'Every 3 seconds shoots a rocket that explodes on impact.',
        assetKey: 'rockets_2x1',
        width: 2,
        height: 1,
        cost: 50,
        rarity: 'epic',
        combine: {
            stat: 'rocketInterval',
            format: 'number',
            base: 3.0,
            legendary: 1.5,
            descTemplate: 'Every {bonus} seconds shoots a rocket that explodes on impact.'
        }
    },
    {
        id: 'advanced_locator',
        name: 'Advanced Locator',
        description: 'Identifies the nearest event on your radar. Consumed on use (Right-click in cargo).',
        assetKey: 'advanced_locator_2x2',
        width: 2,
        height: 2,
        cost: 60,
        rarity: 'rare',
        consumable: true
    },
    {
        id: 'ancient_curse',
        name: 'Ancient Curse',
        description: 'Enables WASD free movement. Disables dodging.',
        assetKey: 'ancient_curse_2x2',
        width: 2,
        height: 2,
        cost: 0,
        rarity: 'unique'
    },
    {
        id: 'boost_drive',
        name: 'Boost Drive',
        description: 'Ship boost is slower, but constant while the button is held down.',
        assetKey: 'boost_drive_2x1',
        width: 2,
        height: 1,
        cost: 50,
        rarity: 'rare',
        combine: {
            stat: 'boostDriveSpeed',
            curve: 'linear',
            base: 0,
            legendary: 0.50,
            descTemplate: 'Ship boost is slower, but constant while held ({bonus} faster).'
        }
    },
    {
        id: 'obedience',
        name: 'Obedience',
        description: 'Increases all base stats by 20%.',
        assetKey: 'obedience_1x1',
        width: 1,
        height: 1,
        cost: 0,
        rarity: 'unique'
    },
    {
        id: 'sacrifice',
        name: 'Sacrifice',
        description: 'Grants an extra life. Consumed on use.',
        assetKey: 'sacrifice_1x2',
        width: 1,
        height: 2,
        cost: 0,
        rarity: 'unique'
    },
    {
        id: 'knowledge',
        name: 'Knowledge',
        description: 'Enables a radar minimap in the HUD.',
        assetKey: 'knowledge_1x1',
        width: 1,
        height: 1,
        cost: 0,
        rarity: 'unique'
    },
    {
        id: 'momentum_module',
        name: 'Momentum Module',
        description: 'Reduces friction, allowing the ship to drift.',
        assetKey: 'momentum_module_1x1',
        width: 1,
        height: 1,
        cost: 45,
        rarity: 'rare'
    },
    {
        id: 'sensor_accelerator',
        name: 'Sensor Accelerator',
        description: 'Increases field of view by 10%.',
        assetKey: 'sensor_accelerator_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'common',
        combine: {
            stat: 'fov',
            base: 0.10,
            legendary: 0.90,
            descTemplate: 'Increases field of view by {bonus}.'
        }
    },
    {
        id: 'nanite_tank',
        name: 'Nanite Tank',
        description: 'Slowly regenerates ship health.',
        assetKey: 'nanite_tank_2x2',
        width: 2,
        height: 2,
        cost: 100,
        rarity: 'epic',
        combine: {
            stat: 'naniteRegen',
            format: 'number',
            base: 0.6,
            legendary: 1.20,
            descTemplate: 'Regenerates ship health ({bonus}/s).'
        }
    },
    {
        id: 'shield_capacitor',
        name: 'Shield Capacitor',
        description: 'Increases damage dealt to enemies on shield impact.',
        assetKey: 'shield_capacitor_1x2',
        width: 1,
        height: 2,
        cost: 60,
        rarity: 'rare',
        combine: {
            stat: 'shieldCapacitor',
            format: 'int',
            base: 1,
            legendary: 4,
            descTemplate: 'Increases damage dealt to enemies on shield impact (tier {bonus}).'
        }
    },
    {
        id: 'asteroid_accumulator',
        name: 'Asteroid Accumulator',
        description: 'Increases the frequency of asteroids.',
        assetKey: 'asteroid_accumulator_2x2',
        width: 2,
        height: 2,
        cost: 80,
        rarity: 'rare',
        combine: {
            stat: 'asteroidSpawn',
            base: 0.50,
            legendary: 2.00,
            descTemplate: 'Increases the frequency of asteroids by {bonus}.'
        }
    },
    {
        id: 'cargo_expansion',
        name: 'Cargo Expansion',
        description: 'Expands the ship\'s cargo by one row.',
        assetKey: 'cargo_expansion_3x1',
        width: 3,
        height: 1,
        cost: 100,
        rarity: 'rare'
    },
    {
        id: 'experience_condenser',
        name: 'Experience Condenser',
        description: 'Increases the value of experience orbs by 20%.',
        assetKey: 'experience_condenser_1x2',
        width: 1,
        height: 2,
        cost: 70,
        rarity: 'uncommon',
        combine: {
            stat: 'xp',
            base: 0.20,
            legendary: 0.85,
            descTemplate: 'Increases the value of experience orbs by {bonus}.'
        }
    },
    {
        id: 'asteroid_drill',
        name: 'Asteroid Drill',
        description: 'Increases scrap drop chance from asteroids by 50%.',
        assetKey: 'asteroid_drill_3x2',
        width: 3,
        height: 2,
        cost: 60,
        rarity: 'rare',
        combine: {
            stat: 'asteroidDrill',
            base: 0.50,
            legendary: 0.95,
            descTemplate: 'Increases scrap drop chance from asteroids by {bonus}.'
        }
    },
    {
        id: 'laser_cartridge',
        name: 'Laser Cartridge',
        description: 'Increases damage by 10%.',
        assetKey: 'laser_cartridge_1x1',
        width: 1,
        height: 1,
        cost: 30,
        rarity: 'common',
        combine: {
            stat: 'damage',
            base: 0.10,
            legendary: 2.00,
            descTemplate: 'Increases damage by {bonus}.'
        }
    },
    {
        id: 'cosmos_engine',
        name: 'Cosmos Engine',
        description: 'A divine engine. Boosts HP, shield, speed, fire rate, and damage by 10%, and luck by 20%. Emits a guiding glow.',
        assetKey: 'cosmos_engine_1x1',
        width: 1,
        height: 1,
        cost: 0,
        rarity: 'unique'
    }
];

export const RARITY_WEIGHTS = {
    common: 100,
    uncommon: 50,
    rare: 20,
    epic: 5,
    legendary: 1,
    unique: 0
};

export const RARITY_COLORS = {
    common: '#00ff00',
    uncommon: '#0078ff',
    rare: '#b400ff',
    epic: '#ff0000',
    legendary: '#ffff00',
    unique: '#ffffff'
};

// ─── Combine / upgrade tiers ────────────────────────────────────────────
// Combinable upgrades climb a shared ladder of tiers. Even tiers are named
// rarities; odd tiers are half-steps whose color is the midpoint of the two
// adjacent named rarities. An item STARTS at the tier matching its own listed
// rarity (common=0, uncommon=2, rare=4, epic=6, legendary=8) and can only
// climb upward from there toward legendary — never below its native rarity.
export const COMBINE_RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];
export const MAX_COMBINE_TIER = (COMBINE_RARITY_ORDER.length - 1) * 2; // 8 = legendary

/** Ladder tier an item of the given rarity starts at (common=0 ... legendary=8). */
export function rarityToTier(rarity) {
    const i = COMBINE_RARITY_ORDER.indexOf(rarity);
    return i < 0 ? 0 : i * 2;
}

/** Effective ladder tier of an item instance. Base items have no `.tier` and
 *  sit at the tier matching their listed rarity. */
export function itemTier(item) {
    return item.tier ?? rarityToTier(item.rarity);
}

function _mixHex(a, b) {
    const pa = parseInt(a.slice(1), 16);
    const pb = parseInt(b.slice(1), 16);
    const mix = (sa, sb) => Math.round((sa + sb) / 2);
    const r  = mix((pa >> 16) & 255, (pb >> 16) & 255);
    const g  = mix((pa >> 8) & 255,  (pb >> 8) & 255);
    const bl = mix(pa & 255,          pb & 255);
    return '#' + [r, g, bl].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Color for a combine tier: named rarity on even tiers, blended midpoint on odd. */
export function tierColor(tier) {
    const i = Math.floor(tier / 2);
    if (tier % 2 === 0) return RARITY_COLORS[COMBINE_RARITY_ORDER[i]] || '#ffffff';
    return _mixHex(RARITY_COLORS[COMBINE_RARITY_ORDER[i]], RARITY_COLORS[COMBINE_RARITY_ORDER[i + 1]]);
}

/** Display label for a combine tier, e.g. "COMMON / UNCOMMON". */
export function tierLabel(tier) {
    const i = Math.floor(tier / 2);
    if (tier % 2 === 0) return COMBINE_RARITY_ORDER[i].toUpperCase();
    return `${COMBINE_RARITY_ORDER[i].toUpperCase()} / ${COMBINE_RARITY_ORDER[i + 1].toUpperCase()}`;
}

/** Highest combine tier an upgrade definition supports (0 if not combinable). */
export function maxTierFor(def) {
    return (def && def.combine) ? MAX_COMBINE_TIER : 0;
}

/**
 * Resolves the bonus value for a combinable upgrade at a given ladder tier.
 * `base` is the value at the item's native rarity; `legendary` is the value at
 * tier 8. Intermediate tiers interpolate geometrically (linearly for integer
 * stats) between the two, so a higher-rarity item climbs the same endpoints in
 * fewer, larger steps.
 */
function _bonusAtTier(def, tier) {
    const { base, legendary, format = 'percent' } = def.combine;
    const baseTier = rarityToTier(def.rarity);
    const span = MAX_COMBINE_TIER - baseTier;
    const frac = span > 0 ? (tier - baseTier) / span : 0;
    // Linear when integer, explicitly requested, or anchored at 0 (geometric
    // can't grow from 0). Geometric otherwise — including decreasing curves
    // (e.g. a shrinking penalty) where legendary < base.
    const linear = format === 'int' || def.combine.curve === 'linear' || base <= 0;
    if (linear) {
        const v = base + (legendary - base) * frac;
        return format === 'int' ? Math.round(v) : v;
    }
    return base * Math.pow(legendary / base, frac);
}

/**
 * Builds an inventory item for an upgrade id at a given ladder tier.
 * At (or below) the item's native rarity tier it returns the shared base
 * definition unchanged, so world / shop / cache spawns are untouched. Higher
 * tiers return a fresh per-instance object carrying its own tier, bonus,
 * blended color, label and templated description.
 */
export function makeItem(id, tier) {
    const def = UPGRADES.find(u => u.id === id);
    if (!def) return null;
    const baseTier = rarityToTier(def.rarity);
    if (!def.combine || tier == null || tier <= baseTier) return def;

    const t = Math.min(tier, MAX_COMBINE_TIER);
    const bonus = _bonusAtTier(def, t);

    // How the {bonus} token renders in the description.
    const fmt = def.combine.format || 'percent';
    const round2 = (v) => Math.round(v * 100) / 100;
    let bonusText;
    if (fmt === 'int')         bonusText = String(bonus);
    else if (fmt === 'number') bonusText = String(round2(bonus));
    else if (fmt === 'x')      bonusText = round2(bonus) + 'x';
    else                       bonusText = Math.round(bonus * 100) + '%';

    return {
        ...def,
        tier: t,
        bonus,
        color: tierColor(t),
        rarityLabel: tierLabel(t),
        description: (def.combine.descTemplate || def.description).replace('{bonus}', bonusText)
    };
}
