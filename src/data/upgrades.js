/**
 * Upgrade item definitions.
 * Size is [width, height] in grid cells.
 */
export const UPGRADES = [
    {
        id: 'blink_engine',
        name: 'Blink Engine',
        description: 'Adds dodge ability. If already present, reduces cooldown.',
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
        consumable: true
    },
    {
        id: 'firing_coordinator',
        name: 'Firing Coordinator',
        description: 'Increases shooting speed by 10%.',
        assetKey: 'firing_coordinator_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'common'
    },
    {
        id: 'energy_canisters',
        name: 'Energy Canisters',
        description: 'Increases max health by 1.6x.',
        assetKey: 'energy_canisters_2x2',
        width: 2,
        height: 2,
        cost: 80,
        rarity: 'uncommon'
    },
    {
        id: 'pulse_boosters',
        name: 'Pulse Boosters',
        description: 'Increases boost range and reduces cooldown.',
        assetKey: 'pulse_boosters_2x2',
        width: 2,
        height: 2,
        cost: 40,
        rarity: 'rare'
    },
    {
        id: 'field_array',
        name: 'Field Array',
        description: 'Reduces shield energy drain.',
        assetKey: 'field_array_2x2',
        width: 2,
        height: 2,
        cost: 50,
        rarity: 'uncommon'
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
        rarity: 'uncommon'
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
        rarity: 'rare'
    },
    {
        id: 'energy_blaster',
        name: 'Energy Blaster',
        description: 'Converts shots into a shotgun blast of 3-5 lower damage shots. Reduces fire rate.',
        assetKey: 'energy_blaster_3x1',
        width: 3,
        height: 1,
        cost: 70,
        rarity: 'rare'
    },
    {
        id: 'repeater',
        name: 'Repeater',
        description: 'Massively increases fire rate but reduces damage slightly.',
        assetKey: 'repeater_4x1',
        width: 4,
        height: 1,
        cost: 80,
        rarity: 'rare'
    },
    {
        id: 'laser_override',
        name: 'Laser Override',
        description: 'Converts all projectiles into massive versions that deal 1.3x damage.',
        assetKey: 'laser_override_2x2',
        width: 2,
        height: 2,
        cost: 80,
        rarity: 'rare'
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
        rarity: 'uncommon'
    },
    {
        id: 'shield_booster',
        name: 'Shield Booster',
        description: 'Increases maximum shields by 20%.',
        assetKey: 'shield_booster_1x1',
        width: 1,
        height: 1,
        cost: 40,
        rarity: 'common'
    },
    {
        id: 'targeting_module',
        name: 'Targeting Module',
        description: 'Standard shots slightly seek towards enemies in front of you.',
        assetKey: 'targeting_module_2x2',
        width: 2,
        height: 2,
        cost: 50,
        rarity: 'rare'
    },
    {
        id: 'control_module',
        name: 'Control Module',
        description: 'Increases projectile speed and reduces railgun charge time.',
        assetKey: 'control_module_1x2',
        width: 1,
        height: 2,
        cost: 40,
        rarity: 'rare'
    },
    {
        id: 'mechanical_engines',
        name: 'Mechanical Engines',
        description: 'Makes ship turning faster and increases speed by 25%.',
        assetKey: 'mechanical_engines_2x2',
        width: 2,
        height: 2,
        cost: 70,
        rarity: 'rare'
    },
    {
        id: 'multishot_guns',
        name: 'Multishot Guns',
        description: 'Fires two parallel shots. Reduces individual shot damage by 30%.',
        assetKey: 'multishot_guns_2x1',
        width: 2,
        height: 1,
        cost: 60,
        rarity: 'epic'
    },
    {
        id: 'high_density_capacitor',
        name: 'High Density Capacitor',
        description: 'Reduces the boost cooldown by 50%.',
        assetKey: 'high_density_capacitor_1x2',
        width: 1,
        height: 2,
        cost: 80,
        rarity: 'rare'
    },
    {
        id: 'energy_cell',
        name: 'Energy Cell',
        description: 'Increases shield recharge speed by 30%.',
        assetKey: 'energy_cell_1x2',
        width: 1,
        height: 2,
        cost: 50,
        rarity: 'uncommon'
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
        rarity: 'uncommon'
    },
    {
        id: 'rockets',
        name: 'Rockets',
        description: 'Every 3 seconds shoots a rocket that explodes on impact.',
        assetKey: 'rockets_2x1',
        width: 2,
        height: 1,
        cost: 50,
        rarity: 'rare'
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
        rarity: 'rare'
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
