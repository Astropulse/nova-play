// Achievement definitions.
//
// Fields:
//   id:          stable string used as a key in localStorage + unlock lookups.
//                Never rename — change name/description/flavor freely instead.
//   name:        short title. Always visible in the menu.
//   description: how to earn it. Hidden in the menu when `hidden: true` and
//                the achievement is still locked.
//   flavor:      lore line — always visible. For hidden achievements this is
//                the only hint the player gets.
//   hidden:      defaults to false. When true, description is masked until
//                unlocked but name + flavor still show through.
//   icon:        optional asset key for the achievement art (e.g. 'ach_first_blood').
//                When unset, the menu draws an empty placeholder box. Locked
//                achievements should still render the icon — desaturate it
//                in the renderer rather than blanking it.
//   unlock:      optional { type, id } granted on unlock. Consumers query
//                game.achievements.hasUnlock(type, id).
//   check(mgr):  predicate run against AchievementManager state. Return true
//                to unlock. Stat sources:
//                  mgr.lifetime.*  totals across all runs (persisted)
//                  mgr.run.*       counters reset every run
//                Sets in run.* expose `.size` for "all-of" style checks.

export const ACHIEVEMENTS = [
    // ── Combat: lifetime milestones ─────────────────────────────────────────
    {
        id: 'first_blood',
        name: 'First Blood',
        description: 'Destroy your first enemy ship.',
        flavor: 'Yes good job, that is how you use your lasers.',
        icon: 'ach_first_blood',
        check: (m) => m.lifetime.enemiesKilled >= 1
    },
    {
        id: 'centurion',
        name: 'Centurion',
        description: 'Destroy 100 enemy ships across all runs.',
        flavor: 'Barely a dent.',
        icon: 'ach_centurion',
        check: (m) => m.lifetime.enemiesKilled >= 100,
        progress: (m) => m.lifetime.enemiesKilled / 100
    },
    {
        id: 'thousand_cuts',
        name: 'Death by a Thousand Cuts',
        description: 'Destroy 1000 enemy ships across all runs.',
        flavor: 'You stopped counting somewhere around three hundred.',
        icon: 'ach_thousand_cuts',
        check: (m) => m.lifetime.enemiesKilled >= 1000,
        progress: (m) => m.lifetime.enemiesKilled / 1000
    },

    // ── Combat: single run ─────────────────────────────────────────────────
    {
        id: 'butcher',
        name: 'Butcher',
        description: 'Destroy 200 enemy ships in a single run.',
        flavor: "All in one go, nice.",
        icon: 'ach_butcher',
        check: (m) => m.run.enemiesKilled >= 200,
        progressScope: 'run',
        progress: (m) => m.run.enemiesKilled / 200
    },
    {
        id: 'blitz',
        name: 'Blitz',
        description: 'Destroy 10 enemies within 10 seconds.',
        flavor: 'Just try holding down the trigger and spinning around.',
        icon: 'ach_blitz',
        check: (m) => m.run.maxKillStreak >= 10,
        progressScope: 'run',
        progress: (m) => m.run.maxKillStreak / 10
    },
    {
        id: 'storm_front',
        name: 'Storm Front',
        description: 'Destroy 30 enemies within 10 seconds.',
        flavor: 'Going to have to kill a lot of ships real fast.',
        hidden: true,
        icon: 'ach_storm_front',
        check: (m) => m.run.maxKillStreak >= 30
    },

    // ── Waves ───────────────────────────────────────────────────────────────
    {
        id: 'first_wave',
        name: 'Baby\'s First Wave',
        description: 'Clear your first wave.',
        flavor: 'The first of many.',
        icon: 'ach_first_wave',
        check: (m) => m.run.wavesCleared >= 1
    },
    {
        id: 'wave_breaker',
        name: 'Wave Breaker',
        description: 'Clear 50 enemy waves across all runs.',
        flavor: 'Wave after unending wave.',
        icon: 'ach_wave_breaker',
        check: (m) => m.lifetime.wavesCleared >= 50,
        progress: (m) => m.lifetime.wavesCleared / 50
    },
    {
        id: 'untouched',
        name: 'Untouched',
        description: 'Clear 4 waves in a single run without taking any damage.',
        flavor: 'Their lasers are fast, but you\'re faster.',
        icon: 'ach_untouched',
        check: (m) => m.run.wavesCleared >= 4 && m.run.damageless,
        progressScope: 'run',
        // Empties the moment a hull hit lands — the run can no longer earn it.
        progress: (m) => m.run.damageless ? m.run.wavesCleared / 4 : 0
    },

    // ── Bosses (each major boss + composite achievements) ───────────────────
    {
        id: 'starcore_slain',
        name: 'Dying Star',
        description: 'Defeat the Starcore.',
        flavor: 'He\'s got so many guns please make it stop.',
        hidden: true,
        icon: 'ach_starcore_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Starcore']
    },
    {
        id: 'crusher_slain',
        name: 'Rubble',
        description: 'Defeat the Asteroid Crusher.',
        flavor: 'All he does is throw rocks, it can\'t be that hard.',
        hidden: true,
        icon: 'ach_crusher_slain',
        check: (m) => !!m.lifetime.bossesDefeated['AsteroidCrusher']
    },
    {
        id: 'horizon_slain',
        name: 'Outpaced',
        description: 'Defeat the Event Horizon.',
        flavor: "It thought it was the fastest thing out here.",
        hidden: true,
        icon: 'ach_horizon_slain',
        check: (m) => !!m.lifetime.bossesDefeated['EventHorizon']
    },
    {
        id: 'trifecta',
        name: 'Hat Trick',
        description: 'Defeat all three wave bosses across your runs.',
        flavor: 'The difficult one is my favorite.',
        icon: 'ach_trifecta',
        check: (m) => !!m.lifetime.bossesDefeated['Starcore']
            && !!m.lifetime.bossesDefeated['AsteroidCrusher']
            && !!m.lifetime.bossesDefeated['EventHorizon'],
        progress: (m) => (
            (m.lifetime.bossesDefeated['Starcore'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['AsteroidCrusher'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['EventHorizon'] ? 1 : 0)
        ) / 3
    },
    {
        id: 'single_run_trifecta',
        name: 'Three for One',
        description: 'Defeat all three wave bosses in a single run.',
        flavor: 'Nice killstreak bro.',
        hidden: true,
        icon: 'ach_single_run_trifecta',
        check: (m) => m.run.bossesDefeated.has('Starcore')
            && m.run.bossesDefeated.has('AsteroidCrusher')
            && m.run.bossesDefeated.has('EventHorizon')
    },
    {
        id: 'yellow_one_slain',
        name: 'The Yellow Crown',
        description: 'Defeat The Yellow One.',
        flavor: 'Where black stars rise. Where moons circle through the skies.',
        hidden: true,
        icon: 'ach_yellow_one_slain',
        check: (m) => !!m.lifetime.bossesDefeated['YellowOne']
    },

    // ── Asteroids ───────────────────────────────────────────────────────────
    {
        id: 'asteroid_taste',
        name: 'Tastes Like Rocks',
        description: 'Destroy 60 asteroids in a single run.',
        flavor: 'Minerals. Yum.',
        icon: 'ach_asteroid_taste',
        check: (m) => m.run.asteroidsDestroyed >= 60,
        progressScope: 'run',
        progress: (m) => m.run.asteroidsDestroyed / 60
    },
    {
        id: 'asteroid_10000',
        name: 'Pebble Hunter',
        description: 'Destroy 10000 asteroids across all runs.',
        flavor: 'Easy pickings.',
        icon: 'ach_asteroid_10000',
        check: (m) => m.lifetime.asteroidsDestroyed >= 10000,
        progress: (m) => m.lifetime.asteroidsDestroyed / 10000
    },
    {
        id: 'asteroid_100000',
        name: 'Belt Wrecker',
        description: 'Destroy 100000 asteroids across all runs.',
        flavor: 'Somewhere, a geologist is weeping.',
        icon: 'ach_asteroid_100000',
        check: (m) => m.lifetime.asteroidsDestroyed >= 100000,
        progress: (m) => m.lifetime.asteroidsDestroyed / 100000
    },
    {
        id: 'single_run_asteroid_600',
        name: 'Field Day',
        description: 'Destroy 600 asteroids in a single run.',
        flavor: 'Give me all the scrap.',
        icon: 'ach_single_run_asteroid_600',
        check: (m) => m.run.asteroidsDestroyed >= 600,
        progressScope: 'run',
        progress: (m) => m.run.asteroidsDestroyed / 600
    },
    {
        id: 'boulder_smasher',
        name: 'Boulder Smasher',
        description: 'Destroy 1000 large asteroids across all runs.',
        flavor: 'Big rocks give big rewards.',
        icon: 'ach_boulder_smasher',
        check: (m) => m.lifetime.asteroidsByType.big >= 1000,
        progress: (m) => m.lifetime.asteroidsByType.big / 1000
    },
    {
        id: 'dust_devil',
        name: 'Dust Devil',
        description: 'Destroy 10000 tiny asteroids across all runs.',
        flavor: 'They really start to add up.',
        icon: 'ach_dust_devil',
        check: (m) => m.lifetime.asteroidsByType.tiny >= 10000,
        progress: (m) => m.lifetime.asteroidsByType.tiny / 10000
    },

    // ── Events / Encounters ─────────────────────────────────────────────────
    {
        id: 'cartographer',
        name: 'Cartographer of the Black',
        description: 'Discover three different event types in a single run.',
        flavor: 'They call it space because its mostly empty.',
        icon: 'ach_cartographer',
        check: (m) => m.run.eventsDiscovered.size >= 3,
        progressScope: 'run',
        progress: (m) => m.run.eventsDiscovered.size / 3
    },
    {
        id: 'true_explorer',
        name: 'True Explorer',
        description: 'Discover every standard event type in a single run.',
        flavor: 'You did it, you found most of the things!',
        hidden: true,
        icon: 'ach_true_explorer',
        check: (m) =>
            m.run.eventsDiscovered.has('CargoShipEvent')
            && m.run.eventsDiscovered.has('SpaceCache')
            && m.run.eventsDiscovered.has('KnowledgeEvent')
            && m.run.eventsDiscovered.has('FracturedStationEvent')
            && m.run.eventsDiscovered.has('CthulhuEvent')
    },
    {
        id: 'salvager',
        name: 'Salvager',
        description: 'Loot 5 abandoned cargo ships across all runs.',
        flavor: 'Empty hulls keep the lights on.',
        icon: 'ach_salvager',
        check: (m) => (m.lifetime.eventTypes['CargoShipEvent'] || 0) >= 5,
        progress: (m) => (m.lifetime.eventTypes['CargoShipEvent'] || 0) / 5
    },
    {
        id: 'strange_galaxy',
        name: 'Strange Galaxy',
        description: 'Approach the lidless thing above the void.',
        flavor: 'It stares back. It always stares back.',
        hidden: true,
        icon: 'ach_strange_galaxy',
        check: (m) => (m.lifetime.eventTypes['KnowledgeEvent'] || 0) >= 1
    },
    {
        id: 'gift_to_the_void',
        name: 'Gift to the Void',
        description: 'Feed an item to Knowledge.',
        flavor: 'It calls to you, asking, demanding.',
        hidden: true,
        icon: 'ach_gift_to_the_void',
        check: (m) => (m.lifetime.knowledgeEventResolutions?.item || 0) >= 1
    },
    {
        id: 'offering_to_the_void',
        name: 'Offering to the Void',
        description: 'Lure an enemy ship into Knowledge.',
        flavor: 'It consumes indescriminantly.',
        hidden: true,
        icon: 'ach_offering_to_the_void',
        check: (m) => (m.lifetime.knowledgeEventResolutions?.enemy || 0) >= 1
    },
    {
        id: 'lidless_sleeping',
        name: 'Lidless Sleeping',
        description: 'Defeat Knowledge in combat.',
        flavor: 'It\'s gaze goes blank.',
        hidden: true,
        icon: 'ach_lidless_sleeping',
        check: (m) => (m.lifetime.knowledgeEventResolutions?.combat || 0) >= 1
    },
    {
        id: 'derelict_orbit',
        name: 'Derelict Orbit',
        description: 'Investigate a Fractured Station.',
        flavor: 'Three signals, three abandoned outposts.',
        icon: 'ach_derelict_orbit',
        check: (m) => (m.lifetime.eventTypes['FracturedStationEvent'] || 0) >= 1
    },
    {
        id: 'frozen_god',
        name: 'The Frozen God',
        description: 'Find the Frozen God in the dark.',
        flavor: "Some things sleep for a reason.",
        hidden: true,
        icon: 'ach_frozen_god',
        check: (m) => (m.lifetime.eventTypes['CthulhuEvent'] || 0) >= 1
    },

    // ── Caches ──────────────────────────────────────────────────────────────
    {
        id: 'lockbreaker',
        name: 'Lockbreaker',
        description: 'Open your first space cache.',
        flavor: 'Locks out here are mostly suggestions.',
        icon: 'ach_lockbreaker',
        check: (m) => m.lifetime.cachesOpened >= 1
    },
    {
        id: 'treasure_hunter',
        name: 'Treasure Hunter',
        description: 'Open 25 space caches across all runs.',
        flavor: 'Chests are awesome. The more the better.',
        icon: 'ach_treasure_hunter',
        check: (m) => m.lifetime.cachesOpened >= 25,
        progress: (m) => m.lifetime.cachesOpened / 25
    },
    {
        id: 'hoarder',
        name: 'Hoarder',
        description: 'Open 5 space caches in a single run.',
        flavor: 'Isn\'t your cargo full yet?',
        icon: 'ach_hoarder',
        check: (m) => m.run.cachesOpened >= 5,
        progressScope: 'run',
        progress: (m) => m.run.cachesOpened / 5
    },

    // ── Shops ───────────────────────────────────────────────────────────────
    {
        id: 'bargain_hunter',
        name: 'Bargain Hunter',
        description: 'Visit 3 different shops in a single run.',
        flavor: 'Deals you can\'t pass up.',
        icon: 'ach_bargain_hunter',
        check: (m) => m.run.shopsVisited >= 3,
        progressScope: 'run',
        progress: (m) => m.run.shopsVisited / 3
    },
    {
        id: 'chasing_the_dragon',
        name: 'Chasing the Dragon',
        description: 'Visit 25 shops across all runs.',
        flavor: 'Do legendary upgrades even exist?',
        icon: 'ach_chasing_the_dragon',
        check: (m) => m.lifetime.shopsVisited >= 25,
        progress: (m) => m.lifetime.shopsVisited / 25
    },

    // ── Upgrades: progress & variety ────────────────────────────────────────
    {
        id: 'tinkerer',
        name: 'Tinkerer',
        description: 'Install your first upgrade.',
        flavor: 'It\'s like putting fake carbon fiber on your car, but it does something.',
        icon: 'ach_tinkerer',
        check: (m) => m.lifetime.upgradesCollected >= 1
    },
    {
        id: 'collector',
        name: 'Collector',
        description: 'Install 1000 upgrades across all runs.',
        flavor: 'You have a whole shelf of these things now.',
        icon: 'ach_collector',
        check: (m) => m.lifetime.upgradesCollected >= 1000,
        progress: (m) => m.lifetime.upgradesCollected / 1000
    },
    {
        id: 'armory',
        name: 'Armory',
        description: 'Install 25 upgrades in a single run.',
        flavor: 'The ship is more upgrades than original parts at this point.',
        icon: 'ach_armory',
        check: (m) => m.run.upgradesCollected >= 25,
        progressScope: 'run',
        progress: (m) => m.run.upgradesCollected / 25
    },
    {
        id: 'connoisseur',
        name: 'Connoisseur',
        description: 'Install 4 epic-or-better upgrades in a single run.',
        flavor: 'Italian space ship levels of taste.',
        icon: 'ach_connoisseur',
        check: (m) => (
            m.run.upgradesByRarity.epic
            + m.run.upgradesByRarity.legendary
            + m.run.upgradesByRarity.unique
        ) >= 4,
        progressScope: 'run',
        progress: (m) => (
            m.run.upgradesByRarity.epic
            + m.run.upgradesByRarity.legendary
            + m.run.upgradesByRarity.unique
        ) / 4
    },

    // ── Upgrades: specific finds (hidden lore) ──────────────────────────────
    {
        id: 'ancient_bargain',
        name: 'Ancient Bargain',
        description: 'Find the Ancient Curse.',
        flavor: 'You feel the ship answer your hands differently now.',
        hidden: true,
        icon: 'ach_ancient_bargain',
        check: (m) => (m.lifetime.upgradesById['ancient_curse'] || 0) >= 1
    },
    {
        id: 'obedience',
        name: 'Obedience',
        description: 'Find the Obedience module.',
        flavor: 'A reward for your gift to the Void.',
        hidden: true,
        icon: 'ach_obedience',
        check: (m) => (m.lifetime.upgradesById['obedience'] || 0) >= 1
    },
    {
        id: 'sacrifice',
        name: 'Sacrifice',
        description: 'Find the Sacrifice.',
        flavor: 'The Void is hungry. Feed it.',
        hidden: true,
        icon: 'ach_sacrifice',
        check: (m) => (m.lifetime.upgradesById['sacrifice'] || 0) >= 1
    },
    {
        id: 'knowledge',
        name: 'Knowledge',
        description: 'Find Knowledge.',
        flavor: "You can finally see what\'s out there.",
        hidden: true,
        icon: 'ach_knowledge',
        check: (m) => (m.lifetime.upgradesById['knowledge'] || 0) >= 1
    },
    {
        id: 'cosmos_engine',
        name: 'Cosmos Engine',
        description: 'Find the Cosmos Engine.',
        flavor: 'He guards it with his life.',
        hidden: true,
        icon: 'ach_cosmos_engine',
        check: (m) => (m.lifetime.upgradesById['cosmos_engine'] || 0) >= 1
    },

    // ── Stat extremes ───────────────────────────────────────────────────────
    {
        id: 'ludicrous_speed',
        name: 'Ludicrous Speed',
        description: 'Reach a 5x effective speed multiplier in one run.',
        flavor: 'Watch out for asteroids.',
        icon: 'ach_ludicrous_speed',
        check: (m) => m.run.peakSpeedMult >= 5,
        progressScope: 'run',
        // Multiplier baseline is 1x (a stock ship is already at 1x), so measure
        // progress from 1 → target, not 0 → target. Otherwise a fresh ship with
        // no upgrades reads 1/5 = 20% before doing anything. Negative pre-notify
        // values (peak defaults to 0) clamp to 0 in the renderer.
        progress: (m) => (m.run.peakSpeedMult - 1) / 4
    },
    {
        id: 'plaid',
        name: 'Plaid',
        description: 'Reach an 8x effective speed multiplier in one run.',
        flavor: 'Can you even steer that thing?',
        hidden: true,
        icon: 'ach_plaid',
        check: (m) => m.run.peakSpeedMult >= 8
    },
    {
        id: 'trigger_discipline',
        name: 'Trigger Discipline',
        description: 'Reach a 2.5x fire rate multiplier in a single run.',
        flavor: 'It\'s always overheating and that\'s okay.',
        icon: 'ach_trigger_discipline',
        check: (m) => m.run.peakFireRateMult >= 2.5,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakFireRateMult - 1) / 1.5
    },
    {
        id: 'cannonade',
        name: 'Cannonade',
        description: 'Accumulate 20x damage in a single run.',
        flavor: 'Your lasers might as well be solid objects.',
        icon: 'ach_cannonade',
        check: (m) => m.run.peakDamageMult >= 20.0,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakDamageMult - 1) / 19.0
    },
    {
        id: 'wide_angle',
        name: 'Wide Angle',
        description: 'Reach 200% FOV in a single run.',
        flavor: 'Can you see enough stuff yet?',
        icon: 'ach_wide_angle',
        check: (m) => m.run.peakFovMult >= 2.0,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakFovMult - 1) / 1.0
    },
    {
        id: 'magnetic_personality',
        name: 'Magnetic Personality',
        description: 'Reach 10x scrap vacuum range in a single run.',
        flavor: 'The scrap comes to you now. Less work for everyone.',
        icon: 'ach_magnetic_personality',
        check: (m) => m.run.peakVacuumRangeMult >= 10.0,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakVacuumRangeMult - 1) / 9.0
    },
    {
        id: 'spread_shot',
        name: 'Spread Shot',
        description: 'Fire 4 or more extra projectiles per volley in a run.',
        flavor: 'More lasers is more better.',
        icon: 'ach_spread_shot',
        check: (m) => m.run.peakExtraProjectiles >= 4,
        progressScope: 'run',
        progress: (m) => m.run.peakExtraProjectiles / 4
    },
    {
        id: 'fortunate_son',
        name: 'Fortunate Son',
        description: 'Reach 1.5x luck in a single run.',
        flavor: 'Things just keep going your way. Suspicious.',
        icon: 'ach_fortunate_son',
        check: (m) => m.run.peakLuck >= 1.5,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakLuck - 1) / 0.5
    },

    // ── Levels / progression ────────────────────────────────────────────────
    {
        id: 'ascendant',
        name: 'Ascendant',
        description: 'Reach level 10 in a single run.',
        flavor: 'You\'re getting the hang of things now.',
        icon: 'ach_ascendant',
        check: (m) => m.run.peakLevel >= 10,
        progressScope: 'run',
        progress: (m) => m.run.peakLevel / 10
    },
    {
        id: 'apex',
        name: 'Apex',
        description: 'Reach level 50 in a single run.',
        flavor: 'I am the ship, and the ship is me.',
        hidden: true,
        icon: 'ach_apex',
        check: (m) => m.run.peakLevel >= 50
    },
    {
        id: 'skip_artist',
        name: 'Skip Artist',
        description: 'Skip 5 level ups in a single run.',
        flavor: 'Holding out for the good stuff, are we?',
        icon: 'ach_skip_artist',
        check: (m) => m.run.levelUpsSkipped >= 5,
        progressScope: 'run',
        progress: (m) => m.run.levelUpsSkipped / 5
    },
    {
        id: 'one_trick_pony',
        name: 'One Trick Pony',
        description: 'Pick the same stat 3 level ups in a row.',
        flavor: 'You sure committed to that one.',
        icon: 'ach_one_trick_pony',
        check: (m) => m.run.maxSameStatStreak >= 3,
        progressScope: 'run',
        progress: (m) => m.run.maxSameStatStreak / 3
    },
    {
        id: 'legendary_roll',
        name: 'Legendary Roll',
        description: 'Take a natural legendary stat bonus on level up.',
        flavor: 'One in a hundred. You\'ll never feel that again.',
        hidden: true,
        icon: 'ach_legendary_roll',
        check: (m) => m.run.naturalLegendaryPicked >= 1
    },

    // ── Scrap ───────────────────────────────────────────────────────────────
    {
        id: 'salvage_king',
        name: 'Salvage King',
        description: 'Collect 1000 scrap in a single run.',
        flavor: 'Why is there so much trash out here?',
        icon: 'ach_salvage_king',
        check: (m) => m.run.scrapCollected >= 1000,
        progressScope: 'run',
        progress: (m) => m.run.scrapCollected / 1000
    },
    {
        id: 'hoard',
        name: 'Hoard',
        description: 'Collect 5000 scrap in a single run.',
        flavor: 'Drowning in it, are we?',
        hidden: true,
        icon: 'ach_hoard',
        check: (m) => m.run.scrapCollected >= 5000
    },
    {
        id: 'magnate',
        name: 'Magnate',
        description: 'Collect 20000 scrap across all runs.',
        flavor: 'You could buy a small moon by now.',
        icon: 'ach_magnate',
        check: (m) => m.lifetime.scrapCollected >= 20000,
        progress: (m) => m.lifetime.scrapCollected / 20000
    },
    {
        id: 'empire',
        name: 'Empire',
        description: 'Collect 100000 scrap across all runs.',
        flavor: 'Six figures of bolts and broken glass.',
        icon: 'ach_empire',
        check: (m) => m.lifetime.scrapCollected >= 100000,
        progress: (m) => m.lifetime.scrapCollected / 100000
    },
    {
        id: 'scrap_storm',
        name: 'Scrap Storm',
        description: 'Collect 100 scrap within 3 seconds.',
        flavor: 'Right place. Right time. Very greedy.',
        icon: 'ach_scrap_storm',
        check: (m) => m.run.scrapBurstPeak >= 100,
        progressScope: 'run',
        progress: (m) => m.run.scrapBurstPeak / 100
    },

    // ── Ship Encounters ─────────────────────────────────────────────────────
    {
        id: 'first_handshake',
        name: 'First Handshake',
        description: 'Talk to any passing ship.',
        flavor: 'There are other people out here. Who knew.',
        icon: 'ach_first_handshake',
        check: (m) => {
            for (const k in m.lifetime.encounterTypes) {
                if (m.lifetime.encounterTypes[k] > 0) return true;
            }
            return false;
        }
    },
    {
        id: 'unknown_vessel',
        name: 'Unknown Vessel',
        description: 'Meet a Black Market trader.',
        flavor: 'They don\'t paint a name on the hull for a reason.',
        hidden: true,
        icon: 'ach_unknown_vessel',
        check: (m) => (m.lifetime.encounterTypes['black_market'] || 0) >= 1
    },
    {
        id: 'on_the_record',
        name: 'On The Record',
        description: 'Get stopped by a Patrol.',
        flavor: 'They have so many forms.',
        icon: 'ach_on_the_record',
        check: (m) => (m.lifetime.encounterTypes['law_enforcement'] || 0) >= 1
    },
    {
        id: 'local_celebrity',
        name: 'Local Celebrity',
        description: 'Meet every kind of ship out there.',
        flavor: 'Everyone has stopped to chat at least once.',
        icon: 'ach_local_celebrity',
        check: (m) => {
            const types = [
                'cargo_trader', 'civilian', 'colony', 'engineer', 'explorer',
                'junker', 'law_enforcement', 'black_market', 'tuner'
            ];
            for (const t of types) {
                if (!(m.lifetime.encounterTypes[t] > 0)) return false;
            }
            return true;
        },
        progress: (m) => {
            const types = [
                'cargo_trader', 'civilian', 'colony', 'engineer', 'explorer',
                'junker', 'law_enforcement', 'black_market', 'tuner'
            ];
            let n = 0;
            for (const t of types) if (m.lifetime.encounterTypes[t] > 0) n++;
            return n / types.length;
        }
    },
    {
        id: 'diplomat',
        name: 'Diplomat',
        description: 'Complete 25 ship encounters across all runs.',
        flavor: 'Mostly you just nod a lot.',
        icon: 'ach_diplomat',
        check: (m) => {
            let total = 0;
            for (const k in m.lifetime.encounterTypes) total += m.lifetime.encounterTypes[k];
            return total >= 25;
        },
        progress: (m) => {
            let total = 0;
            for (const k in m.lifetime.encounterTypes) total += m.lifetime.encounterTypes[k];
            return total / 25;
        }
    },
    {
        id: 'shoot_the_messenger',
        name: 'Shoot The Messenger',
        description: 'Provoke a ship encounter into a fight.',
        flavor: 'Diplomacy is overrated anyway.',
        icon: 'ach_shoot_the_messenger',
        check: (m) => m.lifetime.hostilesConverted >= 1
    },
    {
        id: 'provoker',
        name: 'Provoker',
        description: 'Turn 10 ship encounters hostile across all runs.',
        flavor: 'You really cannot help yourself.',
        icon: 'ach_provoker',
        check: (m) => m.lifetime.hostilesConverted >= 10,
        progress: (m) => m.lifetime.hostilesConverted / 10
    },
    {
        id: 'see_through',
        name: 'See Through',
        description: 'See through the sealed container scam without losing anything.',
        flavor: "Scammers left and right these days.",
        hidden: true,
        icon: 'ach_see_through',
        check: (m) => (m.lifetime.optimalChoices['void_gamble'] || 0) >= 1
    },
    {
        id: 'calibration_skeptic',
        name: 'Calibration Skeptic',
        description: 'Refuse a "free" tune-up before it touches your ship.',
        flavor: 'Free is the most expensive price out here.',
        hidden: true,
        icon: 'ach_calibration_skeptic',
        check: (m) => (m.lifetime.optimalChoices['saboteur_tune'] || 0) >= 1
    },

    // ── Ship-specific ───────────────────────────────────────────────────────
    {
        id: 'workhorse',
        name: 'Workhorse',
        description: 'Reach level 40 in a single run with the Fighter.',
        flavor: 'Nothing fancy. Just consistent.',
        icon: 'ach_workhorse',
        check: (m) => m.run.shipId === 'fighter' && m.run.peakLevel >= 40,
        progressScope: 'run',
        // Ship-specific: only fills while flying the matching hull.
        progress: (m) => m.run.shipId === 'fighter' ? m.run.peakLevel / 40 : 0
    },
    {
        id: 'hauler',
        name: 'Hauler',
        description: 'Expand cargo to 24 slots in a single run with the Cruiser.',
        flavor: 'Speed AND space? Someone\'s getting greedy.',
        icon: 'ach_hauler',
        check: (m) => m.run.shipId === 'cruiser' && m.run.peakCargoSlots >= 24,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'cruiser' ? m.run.peakCargoSlots / 24 : 0
    },
    {
        id: 'heavy_hitter',
        name: 'Heavy Hitter',
        description: 'Take 800 damage in a single run with the Bruiser.',
        flavor: 'Hit me again. I dare you.',
        icon: 'ach_heavy_hitter',
        check: (m) => m.run.shipId === 'bruiser' && m.run.damageTaken >= 800,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'bruiser' ? m.run.damageTaken / 800 : 0
    },
    {
        id: 'blink_and_miss',
        name: 'Blink And You\'ll Miss It',
        description: 'Dodge 50 enemy shots in a single run with the Looper.',
        flavor: 'They keep shooting where you were.',
        icon: 'ach_blink_and_miss',
        check: (m) => m.run.shipId === 'looper' && m.run.dodgesPerformed >= 50,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'looper' ? m.run.dodgesPerformed / 50 : 0
    },
    {
        id: 'photo_finish',
        name: 'Photo Finish',
        description: 'Defeat the Event Horizon with the Cruiser.',
        flavor: "You found out who was faster.",
        icon: 'ach_photo_finish',
        check: (m) => m.run.shipId === 'cruiser' && m.run.bossesDefeated.has('EventHorizon')
    },
    {
        id: 'lightyears',
        name: 'Lightyears',
        description: 'Cover 25000 units of blink distance in a single run with the Looper.',
        flavor: 'Frequent flyer miles add up.',
        icon: 'ach_lightyears',
        check: (m) => m.run.shipId === 'looper' && m.run.blinkDistanceTotal >= 25000,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'looper' ? m.run.blinkDistanceTotal / 25000 : 0
    },
    {
        id: 'battering_ram',
        name: 'Battering Ram',
        description: 'Destroy 150 asteroids by ramming them in a single run with the Bruiser.',
        flavor: 'Lasers are for cowards.',
        icon: 'ach_battering_ram',
        check: (m) => m.run.shipId === 'bruiser' && m.run.asteroidsRammed >= 150,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'bruiser' ? m.run.asteroidsRammed / 150 : 0
    },
    {
        id: 'frequent_flyer',
        name: 'Frequent Flyer',
        description: 'Travel 1000000 world units in a single run with the Cruiser.',
        flavor: 'You stopped to look at the scenery exactly never.',
        icon: 'ach_frequent_flyer',
        check: (m) => m.run.shipId === 'cruiser' && m.run.distanceTraveled >= 1000000,
        progressScope: 'run',
        progress: (m) => m.run.shipId === 'cruiser' ? m.run.distanceTraveled / 1000000 : 0
    },
    {
        id: 'variety_pack',
        name: 'Variety Pack',
        description: 'Pick from all five stat categories in a single run with the Fighter.',
        flavor: 'Perfectly balanced, as all things should be.',
        hidden: true,
        icon: 'ach_variety_pack',
        check: (m) => m.run.shipId === 'fighter' && m.run.distinctStatTypesPicked.size >= 5
    },
    {
        id: 'belly_flop',
        name: 'Belly Flop',
        description: 'Die by blinking directly into an asteroid with the Looper.',
        flavor: 'Crater. Not a metaphor this time.',
        hidden: true,
        icon: 'ach_belly_flop',
        check: (m) => m.run.shipId === 'looper' && m.run.bellyFlopDeaths >= 1
    },

    // ── Lifetime persistence ────────────────────────────────────────────────
    {
        id: 'veteran_pilot',
        name: 'Veteran Pilot',
        description: 'Complete 10 runs.',
        flavor: 'You know these ships are expensive right?',
        icon: 'ach_veteran_pilot',
        unlock: { type: 'starter_item', id: 'small_battery' },
        check: (m) => m.lifetime.runsCompleted >= 10,
        progress: (m) => m.lifetime.runsCompleted / 10
    },
    {
        id: 'tenured',
        name: 'Tenured',
        description: 'Complete 50 runs.',
        flavor: 'Just keep mashing the start button.',
        icon: 'ach_tenured',
        check: (m) => m.lifetime.runsCompleted >= 50,
        progress: (m) => m.lifetime.runsCompleted / 50
    },
    {
        id: 'career_pilot',
        name: 'Career Pilot',
        description: 'Complete 100 runs.',
        flavor: 'At what point do you stop blaming the ship?',
        hidden: true,
        icon: 'ach_career_pilot',
        check: (m) => m.lifetime.runsCompleted >= 100
    },
    {
        id: 'clock_watcher',
        name: 'Clock Watcher',
        description: 'Spend 1 hour in the cockpit across all runs.',
        flavor: '60 minutes you\'ll never get back.',
        icon: 'ach_clock_watcher',
        check: (m) => m.lifetime.timeAlive >= 3600,
        progress: (m) => m.lifetime.timeAlive / 3600
    },
    {
        id: 'personal_best',
        name: 'Personal Best',
        description: 'Survive a single run for 50 minutes.',
        flavor: 'You could have ended it at any time. You didn\'t.',
        icon: 'ach_personal_best',
        check: (m) => m.lifetime.peakRunTime >= 3000,
        progress: (m) => m.lifetime.peakRunTime / 3000
    },
    {
        id: 'hangar_tour',
        name: 'Hangar Tour',
        description: 'Complete a run with every ship.',
        flavor: 'You tried all four flavors. The middle ones are best.',
        icon: 'ach_hangar_tour',
        check: (m) => m.lifetime.shipsUsed
            && m.lifetime.shipsUsed.fighter
            && m.lifetime.shipsUsed.cruiser
            && m.lifetime.shipsUsed.bruiser
            && m.lifetime.shipsUsed.looper,
        progress: (m) => {
            const s = m.lifetime.shipsUsed || {};
            return ((s.fighter ? 1 : 0) + (s.cruiser ? 1 : 0)
                + (s.bruiser ? 1 : 0) + (s.looper ? 1 : 0)) / 4;
        }
    },
    {
        id: 'punching_bag',
        name: 'Punching Bag',
        description: 'Take 10000 damage across all runs.',
        flavor: 'Most of it was your fault.',
        icon: 'ach_punching_bag',
        check: (m) => m.lifetime.damageTaken >= 10000,
        progress: (m) => m.lifetime.damageTaken / 10000
    },
    {
        id: 'catalog',
        name: 'Catalog',
        description: 'Find 25 different upgrades across all runs.',
        flavor: 'Almost a complete set. Almost.',
        icon: 'ach_catalog',
        check: (m) => m.lifetime.upgradesById && Object.keys(m.lifetime.upgradesById).length >= 25,
        progress: (m) => Object.keys(m.lifetime.upgradesById || {}).length / 25
    },
    {
        id: 'boss_hunter',
        name: 'Boss Hunter',
        description: 'Defeat 25 bosses across all runs.',
        flavor: 'They get very predictable at this point.',
        icon: 'ach_boss_hunter',
        check: (m) => {
            let total = 0;
            for (const k in m.lifetime.bossesDefeated) total += m.lifetime.bossesDefeated[k];
            return total >= 25;
        },
        progress: (m) => {
            let total = 0;
            for (const k in m.lifetime.bossesDefeated) total += m.lifetime.bossesDefeated[k];
            return total / 25;
        }
    }
];
