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
        check: (m) => m.lifetime.enemiesKilled >= 100
    },
    {
        id: 'thousand_cuts',
        name: 'Death by a Thousand Cuts',
        description: 'Destroy 1000 enemy ships across all runs.',
        flavor: 'You stopped counting somewhere around three hundred.',
        icon: 'ach_thousand_cuts',
        check: (m) => m.lifetime.enemiesKilled >= 1000
    },

    // ── Combat: single run ─────────────────────────────────────────────────
    {
        id: 'butcher',
        name: 'Butcher',
        description: 'Destroy 100 enemy ships in a single run.',
        flavor: "All in one go, nice.",
        icon: 'ach_butcher',
        check: (m) => m.run.enemiesKilled >= 100
    },
    {
        id: 'blitz',
        name: 'Blitz',
        description: 'Destroy 10 enemies within 10 seconds.',
        flavor: 'Just try holding down the trigger and spinning around.',
        icon: 'ach_blitz',
        check: (m) => m.run.maxKillStreak >= 10
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
        check: (m) => m.lifetime.wavesCleared >= 50
    },
    {
        id: 'untouched',
        name: 'Untouched',
        description: 'Clear 4 waves in a single run without taking any damage.',
        flavor: 'Their lasers are fast, but you\'re faster.',
        icon: 'ach_untouched',
        check: (m) => m.run.wavesCleared >= 4 && m.run.damageless
    },

    // ── Bosses (each major boss + composite achievements) ───────────────────
    {
        id: 'starcore_slain',
        name: 'Dying Star',
        description: 'Defeat the Starcore.',
        flavor: 'He\'s got so many guns please make it stop.',
        icon: 'ach_starcore_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Starcore']
    },
    {
        id: 'crusher_slain',
        name: 'Rubble',
        description: 'Defeat the Asteroid Crusher.',
        flavor: 'All he does is throw rocks, it can\'t be that hard.',
        icon: 'ach_crusher_slain',
        check: (m) => !!m.lifetime.bossesDefeated['AsteroidCrusher']
    },
    {
        id: 'horizon_slain',
        name: 'Outpaced',
        description: 'Defeat the Event Horizon.',
        flavor: "It thought it was the fastest thing out here.",
        icon: 'ach_horizon_slain',
        check: (m) => !!m.lifetime.bossesDefeated['EventHorizon']
    },
    {
        id: 'trifecta',
        name: 'Hat Trick',
        description: 'Defeat all three major bosses across your runs.',
        flavor: 'The difficult one is my favorite.',
        icon: 'ach_trifecta',
        check: (m) => !!m.lifetime.bossesDefeated['Starcore']
            && !!m.lifetime.bossesDefeated['AsteroidCrusher']
            && !!m.lifetime.bossesDefeated['EventHorizon']
    },
    {
        id: 'single_run_trifecta',
        name: 'Three for One',
        description: 'Defeat all three major bosses in a single run.',
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
        flavor: 'YELLOW YELLOW YELLOW YELLOW YELLOW YELLOW',
        hidden: true,
        icon: 'ach_yellow_one_slain',
        check: (m) => !!m.lifetime.bossesDefeated['YellowOne']
    },

    // ── Asteroids ───────────────────────────────────────────────────────────
    {
        id: 'asteroid_taste',
        name: 'Tastes Like Rocks',
        description: 'Destroy 5 asteroids in a single run.',
        flavor: 'Minerals. Yum.',
        icon: 'ach_asteroid_taste',
        check: (m) => m.run.asteroidsDestroyed >= 5
    },
    {
        id: 'asteroid_hundred',
        name: 'Pebble Hunter',
        description: 'Destroy 100 asteroids across all runs.',
        flavor: 'Easy pickings.',
        icon: 'ach_asteroid_hundred',
        check: (m) => m.lifetime.asteroidsDestroyed >= 100
    },
    {
        id: 'asteroid_thousand',
        name: 'Belt Wrecker',
        description: 'Destroy 1000 asteroids across all runs.',
        flavor: 'Somewhere, a geologist is weeping.',
        icon: 'ach_asteroid_thousand',
        check: (m) => m.lifetime.asteroidsDestroyed >= 1000
    },
    {
        id: 'single_run_asteroid_hundred',
        name: 'Field Day',
        description: 'Destroy 100 asteroids in a single run.',
        flavor: 'Give me all the scrap.',
        icon: 'ach_single_run_asteroid_hundred',
        check: (m) => m.run.asteroidsDestroyed >= 100
    },
    {
        id: 'boulder_smasher',
        name: 'Boulder Smasher',
        description: 'Destroy 50 large asteroids across all runs.',
        flavor: 'Big rocks give big rewards.',
        icon: 'ach_boulder_smasher',
        check: (m) => m.lifetime.asteroidsByType.big >= 50
    },
    {
        id: 'dust_devil',
        name: 'Dust Devil',
        description: 'Destroy 500 tiny asteroids across all runs.',
        flavor: 'They really start to add up.',
        icon: 'ach_dust_devil',
        check: (m) => m.lifetime.asteroidsByType.tiny >= 500
    },

    // ── Events / Encounters ─────────────────────────────────────────────────
    {
        id: 'cartographer',
        name: 'Cartographer of the Black',
        description: 'Discover three different event types in a single run.',
        flavor: 'They call it space because its mostly empty.',
        icon: 'ach_cartographer',
        check: (m) => m.run.eventsDiscovered.size >= 3
    },
    {
        id: 'true_explorer',
        name: 'True Explorer',
        description: 'Discover every standard event type in a single run.',
        flavor: 'You did it, you found some of the things!',
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
        check: (m) => (m.lifetime.eventTypes['CargoShipEvent'] || 0) >= 5
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
        description: 'Defeat the Frozen God after waking him.',
        flavor: "Some things sleep for a reason.",
        hidden: true,
        icon: 'ach_frozen_god',
        // CthulhuEvent summons three waves of CthulhuEnemy cultists; clearing
        // the event reliably requires putting down ~15 of them.
        check: (m) => (m.lifetime.enemyKillsByClass['CthulhuEnemy'] || 0) >= 15
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
        check: (m) => m.lifetime.cachesOpened >= 25
    },
    {
        id: 'hoarder',
        name: 'Hoarder',
        description: 'Open 5 space caches in a single run.',
        flavor: 'Isn\'t your cargo full yet?',
        icon: 'ach_hoarder',
        check: (m) => m.run.cachesOpened >= 5
    },

    // ── Shops ───────────────────────────────────────────────────────────────
    {
        id: 'window_shopping',
        name: 'Window Shopping',
        description: 'Dock at your first shop.',
        flavor: 'They\'re not happy you didn\'t buy anything.',
        icon: null,
        check: (m) => m.lifetime.shopsVisited >= 1
    },
    {
        id: 'mall_crawl',
        name: 'Mall Crawl',
        description: 'Visit 3 different shops in a single run.',
        flavor: 'Comparison shopping is a virtue.',
        icon: null,
        check: (m) => m.run.shopsVisited >= 3
    },
    {
        id: 'loyalty_card',
        name: 'Loyalty Card',
        description: 'Visit 25 shops across all runs.',
        flavor: 'They know your order before you say it.',
        icon: null,
        check: (m) => m.lifetime.shopsVisited >= 25
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
        description: 'Install 100 upgrades across all runs.',
        flavor: 'You have a whole shelf of these things now.',
        icon: 'ach_collector',
        check: (m) => m.lifetime.upgradesCollected >= 100
    },
    {
        id: 'armory',
        name: 'Armory',
        description: 'Install 25 upgrades in a single run.',
        flavor: 'The ship is more upgrades than original parts at this point.',
        icon: 'ach_armory',
        check: (m) => m.run.upgradesCollected >= 25
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
        ) >= 4
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
        check: (m) => m.run.peakSpeedMult >= 5
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
        check: (m) => m.run.peakFireRateMult >= 2.5
    },
    {
        id: 'cannonade',
        name: 'Cannonade',
        description: 'Accumulate +100 permanent damage in a run.',
        flavor: 'Your lasers might as well be solid objects.',
        icon: 'ach_cannonade',
        check: (m) => m.run.peakDamageBonus >= 100
    },
    {
        id: 'wide_angle',
        name: 'Wide Angle',
        description: 'Reach 200% FOV in a single run.',
        flavor: 'Can you see enough stuff yet?',
        icon: 'ach_wide_angle',
        check: (m) => m.run.peakFovMult >= 2.0
    },
    {
        id: 'magnetic_personality',
        name: 'Magnetic Personality',
        description: 'Reach 3x scrap vacuum range in a single run.',
        flavor: 'The scrap comes to you now. Less work for everyone.',
        icon: 'ach_magnetic_personality',
        check: (m) => m.run.peakVacuumRangeMult >= 3.0
    },
    {
        id: 'spread_shot',
        name: 'Spread Shot',
        description: 'Fire 4 or more extra projectiles per volley in a run.',
        flavor: 'More lasers is more better.',
        icon: 'ach_spread_shot',
        check: (m) => m.run.peakExtraProjectiles >= 4
    },
    {
        id: 'fortunate_son',
        name: 'Fortunate Son',
        description: 'Reach 1.5x luck in a single run.',
        flavor: 'Things just keep going your way. Suspicious.',
        icon: 'ach_fortunate_son',
        check: (m) => m.run.peakLuck >= 1.5
    },

    // ── Levels / progression ────────────────────────────────────────────────
    {
        id: 'ascendant',
        name: 'Ascendant',
        description: 'Reach level 10 in a single run.',
        flavor: 'You\'re getting the hang of things now.',
        icon: null,
        check: (m) => m.run.peakLevel >= 10
    },
    {
        id: 'apex',
        name: 'Apex',
        description: 'Reach level 25 in a single run.',
        flavor: 'I am the ship, and the ship is me.',
        hidden: true,
        icon: null,
        check: (m) => m.run.peakLevel >= 25
    },

    // ── Scrap ───────────────────────────────────────────────────────────────
    {
        id: 'salvage_king',
        name: 'Salvage King',
        description: 'Collect 1000 scrap in a single run.',
        flavor: 'Why is there so much trash out here?',
        icon: null,
        check: (m) => m.run.scrapCollected >= 1000
    },

    // ── Ship Encounters ─────────────────────────────────────────────────────
    {
        id: 'first_handshake',
        name: 'First Handshake',
        description: 'Talk to any passing ship.',
        flavor: 'There are other people out here. Who knew.',
        icon: null,
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
        icon: null,
        check: (m) => (m.lifetime.encounterTypes['black_market'] || 0) >= 1
    },
    {
        id: 'on_the_record',
        name: 'On The Record',
        description: 'Get stopped by a Patrol.',
        flavor: 'They have so many forms.',
        icon: null,
        check: (m) => (m.lifetime.encounterTypes['law_enforcement'] || 0) >= 1
    },
    {
        id: 'local_celebrity',
        name: 'Local Celebrity',
        description: 'Meet every kind of ship out there.',
        flavor: 'Everyone has stopped to chat at least once.',
        icon: null,
        check: (m) => {
            const types = [
                'cargo_trader', 'civilian', 'colony', 'engineer', 'explorer',
                'junker', 'law_enforcement', 'black_market', 'tuner'
            ];
            for (const t of types) {
                if (!(m.lifetime.encounterTypes[t] > 0)) return false;
            }
            return true;
        }
    },
    {
        id: 'diplomat',
        name: 'Diplomat',
        description: 'Complete 25 ship encounters across all runs.',
        flavor: 'Mostly you just nod a lot.',
        icon: null,
        check: (m) => {
            let total = 0;
            for (const k in m.lifetime.encounterTypes) total += m.lifetime.encounterTypes[k];
            return total >= 25;
        }
    },
    {
        id: 'shoot_the_messenger',
        name: 'Shoot The Messenger',
        description: 'Provoke a ship encounter into a fight.',
        flavor: 'Diplomacy is overrated anyway.',
        icon: null,
        check: (m) => m.lifetime.hostilesConverted >= 1
    },
    {
        id: 'provoker',
        name: 'Provoker',
        description: 'Turn 10 ship encounters hostile across all runs.',
        flavor: 'You really cannot help yourself.',
        icon: null,
        check: (m) => m.lifetime.hostilesConverted >= 10
    },
    {
        id: 'see_through',
        name: 'See Through',
        description: 'See through the sealed container scam without losing anything.',
        flavor: "Scammers left and right these days.",
        hidden: true,
        icon: null,
        check: (m) => (m.lifetime.optimalChoices['void_gamble'] || 0) >= 1
    },
    {
        id: 'calibration_skeptic',
        name: 'Calibration Skeptic',
        description: 'Refuse a "free" tune-up before it touches your ship.',
        flavor: 'Free is the most expensive price out here.',
        hidden: true,
        icon: null,
        check: (m) => (m.lifetime.optimalChoices['saboteur_tune'] || 0) >= 1
    },

    // ── Lifetime persistence ────────────────────────────────────────────────
    {
        id: 'veteran_pilot',
        name: 'Veteran Pilot',
        description: 'Complete 10 runs.',
        flavor: 'You know these ships are expensive right?',
        icon: null,
        unlock: { type: 'starter_item', id: 'small_battery' },
        check: (m) => m.lifetime.runsCompleted >= 10
    },
    {
        id: 'tenured',
        name: 'Tenured',
        description: 'Complete 50 runs.',
        flavor: 'Just keep mashing the start button.',
        icon: null,
        check: (m) => m.lifetime.runsCompleted >= 50
    }
];
