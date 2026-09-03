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
//   goal:        optional short imperative form of the objective (e.g.
//                "Survive 20 min as Looper"). Shown where space is tight —
//                the upgrade codex cards and the combine-lock tooltip. Gate
//                achievements (unlock set) should always define one.
//   check(mgr):  predicate run against AchievementManager state. Return true
//                to unlock. Stat sources:
//                  mgr.lifetime.*  totals across all runs (persisted)
//                  mgr.run.*       counters reset every run
//                Sets in run.* expose `.size` for "all-of" style checks.

// ── Progression-gate helpers ─────────────────────────────────────────────
// "Every boss" for the legendary combine gate. The Dragon counts either as
// the full seven-headed fight ('Dragon') or by hunting all seven heads as
// lone wave fragments ('Head:<key>', recorded by Dragon solo-mode kills).
const ALL_BOSS_IDS = ['Starcore', 'AsteroidCrusher', 'EventHorizon', 'YellowOne',
    'Seraph', 'Wheels', 'Swarm', 'Carcosa'];
const DRAGON_HEAD_IDS = ['Head:deception', 'Head:accusation', 'Head:murder',
    'Head:blasphemy', 'Head:economic_control', 'Head:false_worship', 'Head:persecution'];
const dragonDone = (m) => !!m.lifetime.bossesDefeated['Dragon']
    || DRAGON_HEAD_IDS.every(id => !!m.lifetime.bossesDefeated[id]);
const allBossProgress = (m) => {
    let n = 0;
    for (const id of ALL_BOSS_IDS) if (m.lifetime.bossesDefeated[id]) n++;
    if (dragonDone(m)) n++;
    return n / (ALL_BOSS_IDS.length + 1);
};
// The core four — the combine-ladder gate (Cross-Platform) and Hangar Tour
// stay pinned to these so adding ships never retroactively raises them.
const SHIP_IDS = ['fighter', 'cruiser', 'bruiser', 'looper'];
// Encounter dialogs opened across all runs (every type summed).
const _encountersMet = (m) => Object.values(m.lifetime.encounterTypes || {}).reduce((a, b) => a + b, 0);

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

    // ── Bosses: the path the Yellow One opens ───────────────────────────────
    {
        id: 'seraph_slain',
        name: 'Be Not Afraid',
        description: 'Defeat the Burning Seraph.',
        flavor: 'It kept saying that. You were, in fact, afraid.',
        hidden: true,
        icon: 'ach_seraph_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Seraph']
    },
    {
        id: 'wheels_slain',
        name: 'Wheel Within a Wheel',
        description: 'Defeat the Wheels.',
        flavor: 'Covered in eyes, and it still never saw this coming.',
        hidden: true,
        icon: 'ach_wheels_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Wheels']
    },
    {
        id: 'swarm_mother_slain',
        name: 'Regicide',
        description: 'Kill the Swarm Mother.',
        flavor: 'No queen, no eggs. The math is on your side now.',
        hidden: true,
        icon: 'ach_swarm_mother_slain',
        check: (m) => !!m.lifetime.bossesDefeated['SwarmMother']
    },
    {
        id: 'swarm_slain',
        name: 'Exterminator',
        description: 'Destroy the Hive and wipe out the Swarm.',
        flavor: 'Should have called sooner. There was a whole nest in there.',
        hidden: true,
        icon: 'ach_swarm_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Swarm']
    },
    {
        id: 'carcosa_slain',
        name: 'Dim Carcosa',
        description: 'Defeat Carcosa.',
        flavor: 'The city was already dead. Now it can rest.',
        hidden: true,
        icon: 'ach_carcosa_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Carcosa']
    },
    {
        id: 'dragon_slain',
        name: 'Seven Heads, Seven Crowns',
        description: 'Shatter all seven heads of the Dragon.',
        flavor: 'The stars come back. All of them.',
        hidden: true,
        icon: 'ach_dragon_slain',
        check: (m) => !!m.lifetime.bossesDefeated['Dragon']
    },
    {
        id: 'the_tribulation',
        name: 'The Tribulation',
        description: 'Defeat every horror on the path the Yellow One opens, across all your runs.',
        flavor: 'It was all written down. You just hadn\'t read that far.',
        icon: 'ach_the_tribulation',
        check: (m) => !!m.lifetime.bossesDefeated['Seraph']
            && !!m.lifetime.bossesDefeated['Wheels']
            && !!m.lifetime.bossesDefeated['Swarm']
            && !!m.lifetime.bossesDefeated['Carcosa']
            && !!m.lifetime.bossesDefeated['Dragon'],
        progress: (m) => (
            (m.lifetime.bossesDefeated['Seraph'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['Wheels'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['Swarm'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['Carcosa'] ? 1 : 0)
            + (m.lifetime.bossesDefeated['Dragon'] ? 1 : 0)
        ) / 5
    },
    {
        id: 'revelation',
        name: 'Revelation',
        description: 'Defeat the Yellow One and everything that follows him in a single run.',
        flavor: 'And it is finished.',
        hidden: true,
        icon: 'ach_revelation',
        check: (m) => m.run.bossesDefeated.has('YellowOne')
            && m.run.bossesDefeated.has('Seraph')
            && m.run.bossesDefeated.has('Wheels')
            && m.run.bossesDefeated.has('Swarm')
            && m.run.bossesDefeated.has('Carcosa')
            && m.run.bossesDefeated.has('Dragon')
    },

    // ── Special enemies ─────────────────────────────────────────────────────
    {
        id: 'pest_control',
        name: 'Pest Control',
        description: 'Destroy at least one of every special enemy type.',
        flavor: 'Every problem out here has a specialist. So do you.',
        icon: 'ach_pest_control',
        check: (m) => {
            const classes = ['NaniteEnemy', 'ShieldEnemy', 'MissileEnemy',
                'BlinkEnemy', 'BerserkEnemy', 'ScavengerEnemy'];
            for (const c of classes) {
                if (!(m.lifetime.enemyKillsByClass[c] > 0)) return false;
            }
            return true;
        },
        progress: (m) => {
            const classes = ['NaniteEnemy', 'ShieldEnemy', 'MissileEnemy',
                'BlinkEnemy', 'BerserkEnemy', 'ScavengerEnemy'];
            let n = 0;
            for (const c of classes) if (m.lifetime.enemyKillsByClass[c] > 0) n++;
            return n / classes.length;
        }
    },
    {
        id: 'grey_goo',
        name: 'Grey Goo',
        description: 'Destroy 500 nanite ships and drones across all runs.',
        flavor: 'They multiply. You subtract.',
        icon: 'ach_grey_goo',
        check: (m) => ((m.lifetime.enemyKillsByClass['NaniteEnemy'] || 0)
            + (m.lifetime.enemyKillsByClass['NaniteDrone'] || 0)) >= 500,
        progress: (m) => ((m.lifetime.enemyKillsByClass['NaniteEnemy'] || 0)
            + (m.lifetime.enemyKillsByClass['NaniteDrone'] || 0)) / 500
    },
    {
        id: 'can_opener',
        name: 'Can Opener',
        description: 'Destroy 25 shielded ships across all runs.',
        flavor: 'Shake well before opening.',
        icon: 'ach_can_opener',
        check: (m) => (m.lifetime.enemyKillsByClass['ShieldEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['ShieldEnemy'] || 0) / 25
    },
    {
        id: 'return_to_sender',
        name: 'Return to Sender',
        description: 'Destroy 25 missile ships across all runs.',
        flavor: 'Postage due.',
        icon: 'ach_return_to_sender',
        check: (m) => (m.lifetime.enemyKillsByClass['MissileEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['MissileEnemy'] || 0) / 25
    },
    {
        id: 'whack_a_mole',
        name: 'Whack-a-Mole',
        description: 'Destroy 25 blink ships across all runs.',
        flavor: 'Eventually they run out of places to be.',
        icon: 'ach_whack_a_mole',
        check: (m) => (m.lifetime.enemyKillsByClass['BlinkEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['BlinkEnemy'] || 0) / 25
    },
    {
        id: 'anger_management',
        name: 'Anger Management',
        description: 'Destroy 25 berserkers across all runs.',
        flavor: 'They had a lot of feelings. Now they have none.',
        icon: 'ach_anger_management',
        check: (m) => (m.lifetime.enemyKillsByClass['BerserkEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['BerserkEnemy'] || 0) / 25
    },
    {
        id: 'claim_jumper',
        name: 'Claim Jumper',
        description: 'Destroy 25 scavengers across all runs.',
        flavor: 'That scrap was yours. It\'s yours again.',
        icon: 'ach_claim_jumper',
        check: (m) => (m.lifetime.enemyKillsByClass['ScavengerEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['ScavengerEnemy'] || 0) / 25
    },
    {
        id: 'bomb_squad',
        name: 'Bomb Squad',
        description: 'Destroy 15 kamikazes in a single run.',
        flavor: 'The trick is to not be there when they arrive.',
        icon: 'ach_bomb_squad',
        check: (m) => m.run.kamikazesKilled >= 15,
        progressScope: 'run',
        progress: (m) => m.run.kamikazesKilled / 15
    },
    {
        id: 'plague_doctor',
        name: 'Plague Doctor',
        description: 'Destroy 250 locusts across all runs.',
        flavor: 'The sky itself darkened with them.',
        hidden: true,
        icon: 'ach_plague_doctor',
        check: (m) => (m.lifetime.enemyKillsByClass['LocustEnemy'] || 0) >= 250
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
    {
        id: 'living_dangerously',
        name: 'Living Dangerously',
        description: 'Destroy 100 asteroids while your shield is broken, in a single run.',
        flavor: 'No shield, no problem. Mostly no problem.',
        icon: 'ach_living_dangerously',
        check: (m) => m.run.asteroidsBrokenShield >= 100,
        progressScope: 'run',
        progress: (m) => m.run.asteroidsBrokenShield / 100
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
    {
        id: 'one_of_everything',
        name: 'One of Everything',
        description: 'Install 15 different upgrade types in a single run.',
        flavor: 'The ship is a museum of questionable decisions.',
        icon: 'ach_one_of_everything',
        check: (m) => m.run.uniqueUpgradeIds.size >= 15,
        progressScope: 'run',
        progress: (m) => m.run.uniqueUpgradeIds.size / 15
    },

    // ── Combining & consumables ─────────────────────────────────────────────
    {
        id: 'first_fusion',
        name: 'Greater Than the Sum',
        description: 'Combine two matching upgrades for the first time.',
        flavor: 'Two wrongs don\'t make a right, but two rights make a bigger right.',
        icon: 'ach_first_fusion',
        check: (m) => m.lifetime.combines >= 1
    },
    {
        id: 'perfect_alloy',
        name: 'Perfect Alloy',
        description: 'Forge an upgrade to its maximum tier.',
        flavor: 'No seams. No flaws. No further.',
        icon: 'ach_perfect_alloy',
        check: (m) => m.lifetime.maxTierCombines >= 1
    },
    {
        id: 'assembly_line',
        name: 'Assembly Line',
        description: 'Combine upgrades 50 times across all runs.',
        flavor: 'Fuse, install, repeat.',
        icon: 'ach_assembly_line',
        check: (m) => m.lifetime.combines >= 50,
        progress: (m) => m.lifetime.combines / 50
    },
    {
        id: 'break_glass',
        name: 'Break Glass',
        description: 'Use your first consumable.',
        flavor: 'In case of emergency. This counts.',
        icon: 'ach_break_glass',
        check: (m) => m.lifetime.consumablesUsed >= 1
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
        description: 'Reach a 4x fire rate multiplier in a single run.',
        flavor: 'It\'s always overheating and that\'s okay.',
        icon: 'ach_trigger_discipline',
        check: (m) => m.run.peakFireRateMult >= 4,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakFireRateMult - 1) / 3.0
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
    {
        id: 'juggernaut',
        name: 'Juggernaut',
        description: 'Reach 500 max hull in a single run.',
        flavor: 'More hull than ship.',
        icon: 'ach_juggernaut',
        check: (m) => m.run.peakMaxHealth >= 500,
        progressScope: 'run',
        progress: (m) => m.run.peakMaxHealth / 500
    },
    {
        id: 'bulwark',
        name: 'Bulwark',
        description: 'Reach 3x max shield in a single run.',
        flavor: 'They can shoot as much as they like.',
        icon: 'ach_bulwark',
        check: (m) => m.run.peakShieldMult >= 3,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakShieldMult - 1) / 2
    },
    {
        id: 'ship_of_theseus',
        name: 'Ship of Theseus',
        description: 'Reach 5 hull regeneration per second in a single run.',
        flavor: 'Every part replaced twice. Still your ship. Probably.',
        icon: 'ach_ship_of_theseus',
        check: (m) => m.run.peakHpRegen >= 5,
        progressScope: 'run',
        progress: (m) => m.run.peakHpRegen / 5
    },
    {
        id: 'honor_student',
        name: 'Honor Student',
        description: 'Reach 3x experience gain in a single run.',
        flavor: 'Straight A\'s in applied violence.',
        icon: 'ach_honor_student',
        check: (m) => m.run.peakExpGainMult >= 3,
        progressScope: 'run',
        // Baseline 1x — see ludicrous_speed.
        progress: (m) => (m.run.peakExpGainMult - 1) / 2
    },
    {
        id: 'quantum_leap',
        name: 'Quantum Leap',
        description: 'Cover 2000 units in a single blink.',
        flavor: 'Technically you were never in between.',
        icon: 'ach_quantum_leap',
        check: (m) => m.run.peakBlinkDistance >= 2000,
        progressScope: 'run',
        progress: (m) => m.run.peakBlinkDistance / 2000
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
    {
        id: 'busy_airspace',
        name: 'Busy Airspace',
        description: 'Meet 5 different kinds of ship in a single run.',
        flavor: 'Everyone out here wants a word with you.',
        icon: 'ach_busy_airspace',
        check: (m) => m.run.encounterTypesMet.size >= 5,
        progressScope: 'run',
        progress: (m) => m.run.encounterTypesMet.size / 5
    },

    // ── Multiplayer ─────────────────────────────────────────────────────────
    {
        id: 'wingman',
        name: 'Wingman',
        description: 'Complete a multiplayer run with at least one other pilot.',
        flavor: 'Space is less empty with a friend in it.',
        icon: 'ach_wingman',
        check: (m) => m.lifetime.multiplayerRunsCompleted >= 1
    },
    {
        id: 'fair_trade',
        name: 'Fair Trade',
        description: 'Complete a trade with another pilot.',
        flavor: 'Both of you are sure you won.',
        icon: 'ach_fair_trade',
        check: (m) => m.lifetime.tradesCompleted >= 1
    },
    {
        id: 'shared_glory',
        name: 'Shared Glory',
        description: 'Defeat a boss in a multiplayer run.',
        flavor: 'You\'ll both claim the killing blow forever.',
        icon: 'ach_shared_glory',
        check: (m) => m.lifetime.multiplayerBossKills >= 1
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
    },

    // ── Unlocks: gated upgrades ─────────────────────────────────────────────
    // Each of these grants an `unlock: { type: 'upgrade', id }` — until it's
    // earned, that upgrade never rolls in shops, caches, loot, or encounters
    // (AchievementManager.isUpgradeUnlocked). Objectives are themed to the
    // upgrade they grant. Icons reuse the upgrade's own sprite so the card
    // shows what you're working toward.
    {
        id: 'unlock_warning_system',
        name: 'Collision Course',
        description: 'Take 1000 total damage across all runs.',
        goal: 'Take 1000 damage',
        flavor: 'Maybe some advance notice would help.',
        icon: 'warning_system_1x1',
        unlock: { type: 'upgrade', id: 'warning_system' },
        check: (m) => m.lifetime.damageTaken >= 1000,
        progress: (m) => m.lifetime.damageTaken / 1000
    },
    {
        id: 'unlock_auto_turret',
        name: 'Trigger Discipline',
        description: 'Destroy 500 enemy ships across all runs.',
        goal: 'Destroy 500 ships',
        flavor: 'You\'ve earned the right to stop aiming.',
        icon: 'auto_turret_3x2',
        unlock: { type: 'upgrade', id: 'auto_turret' },
        check: (m) => m.lifetime.enemiesKilled >= 500,
        progress: (m) => m.lifetime.enemiesKilled / 500
    },
    {
        id: 'unlock_railgun',
        name: 'Big Game',
        description: 'Defeat any wave boss.',
        goal: 'Defeat a wave boss',
        flavor: 'Some targets deserve a bigger gun.',
        icon: 'railgun_4x1',
        unlock: { type: 'upgrade', id: 'railgun' },
        check: (m) => !!m.lifetime.bossesDefeated['Starcore']
            || !!m.lifetime.bossesDefeated['AsteroidCrusher']
            || !!m.lifetime.bossesDefeated['EventHorizon']
    },
    {
        id: 'unlock_energy_blaster',
        name: 'Scattershot',
        description: 'Destroy 8 enemies within 10 seconds.',
        goal: '8 kills in 10 seconds',
        flavor: 'Why aim at one thing when you can aim at everything?',
        icon: 'energy_blaster_3x1',
        unlock: { type: 'upgrade', id: 'energy_blaster' },
        check: (m) => m.lifetime.maxKillStreak >= 8,
        progress: (m) => m.lifetime.maxKillStreak / 8
    },
    {
        id: 'unlock_repeater',
        name: 'Rate of Fire',
        description: 'Collect 10 Firing Coordinators across all runs.',
        goal: 'Collect 10 Firing Coordinators',
        flavor: 'Eventually the coordinators start coordinating each other.',
        icon: 'repeater_4x1',
        unlock: { type: 'upgrade', id: 'repeater' },
        check: (m) => (m.lifetime.upgradesById['firing_coordinator'] || 0) >= 10,
        progress: (m) => (m.lifetime.upgradesById['firing_coordinator'] || 0) / 10
    },
    {
        id: 'unlock_laser_override',
        name: 'Overcharged',
        description: 'Collect 10 Laser Cartridges across all runs.',
        goal: 'Collect 10 Laser Cartridges',
        flavor: 'The safety sticker peeled right off.',
        icon: 'laser_override_2x2',
        unlock: { type: 'upgrade', id: 'laser_override' },
        check: (m) => (m.lifetime.upgradesById['laser_cartridge'] || 0) >= 10,
        progress: (m) => (m.lifetime.upgradesById['laser_cartridge'] || 0) / 10
    },
    {
        id: 'unlock_mechanical_claw',
        name: 'Cold Grip',
        description: 'Destroy 25 Kamikaze ships across all runs.',
        goal: 'Destroy 25 Kamikazes',
        flavor: 'If they insist on coming to you, hold them still.',
        icon: 'mechnaical_claw_2x1',
        unlock: { type: 'upgrade', id: 'mechanical_claw' },
        check: (m) => (m.lifetime.enemyKillsByClass['KamikazeEnemy'] || 0) >= 25,
        progress: (m) => (m.lifetime.enemyKillsByClass['KamikazeEnemy'] || 0) / 25
    },
    {
        id: 'unlock_targeting_module',
        name: 'Sharpshooter',
        description: 'Destroy 400 tiny asteroids across all runs.',
        goal: 'Destroy 400 tiny asteroids',
        flavor: 'Hit the small ones by hand, earn the machine that does it for you.',
        icon: 'targeting_module_2x2',
        unlock: { type: 'upgrade', id: 'targeting_module' },
        check: (m) => (m.lifetime.asteroidsByType.tiny || 0) >= 400,
        progress: (m) => (m.lifetime.asteroidsByType.tiny || 0) / 400
    },
    {
        id: 'unlock_pulse_boosters',
        name: 'Evasive Maneuvers',
        description: 'Perform 100 boost dodges across all runs.',
        goal: '100 boost dodges',
        flavor: 'Not getting hit is a skill. Now it\'s hardware.',
        icon: 'pulse_boosters_2x2',
        unlock: { type: 'upgrade', id: 'pulse_boosters' },
        check: (m) => m.lifetime.dodgesPerformed >= 100,
        progress: (m) => m.lifetime.dodgesPerformed / 100
    },
    {
        id: 'unlock_high_density_capacitor',
        name: 'Long Haul',
        description: 'Travel 2,000,000 units across all runs.',
        goal: 'Travel 2,000,000 units',
        flavor: 'The odometer rolled over. Twice.',
        icon: 'high_density_capacitor_1x2',
        unlock: { type: 'upgrade', id: 'high_density_capacitor' },
        check: (m) => m.lifetime.distanceTraveled + m.run.distanceTraveled >= 2000000,
        progress: (m) => (m.lifetime.distanceTraveled + m.run.distanceTraveled) / 2000000
    },
    {
        id: 'unlock_explosives_unit',
        name: 'Ordnance License',
        description: 'Defeat all three wave bosses across your runs.',
        goal: 'Defeat all 3 wave bosses',
        flavor: 'Cleared for demolition.',
        icon: 'explosives_unit_3x2',
        unlock: { type: 'upgrade', id: 'explosives_unit' },
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
        id: 'unlock_rockets',
        name: 'Fire and Forget',
        description: 'Destroy 1000 asteroids across all runs.',
        goal: 'Destroy 1000 asteroids',
        flavor: 'The rocks stopped being a challenge, so here\'s a bigger boom.',
        icon: 'rockets_2x1',
        unlock: { type: 'upgrade', id: 'rockets' },
        check: (m) => m.lifetime.asteroidsDestroyed >= 1000,
        progress: (m) => m.lifetime.asteroidsDestroyed / 1000
    },
    {
        id: 'unlock_asteroid_accumulator',
        name: 'Never Enough Rocks',
        description: 'Destroy 2500 asteroids across all runs.',
        goal: 'Destroy 2500 asteroids',
        flavor: 'You want MORE of them? Fine.',
        icon: 'asteroid_accumulator_2x2',
        unlock: { type: 'upgrade', id: 'asteroid_accumulator' },
        check: (m) => m.lifetime.asteroidsDestroyed >= 2500,
        progress: (m) => m.lifetime.asteroidsDestroyed / 2500
    },
    {
        id: 'unlock_asteroid_drill',
        name: 'Prospector',
        description: 'Collect 5000 scrap across all runs.',
        goal: 'Collect 5000 scrap',
        flavor: 'Digging pays better with the right tools.',
        icon: 'asteroid_drill_3x2',
        unlock: { type: 'upgrade', id: 'asteroid_drill' },
        check: (m) => m.lifetime.scrapCollected >= 5000,
        progress: (m) => m.lifetime.scrapCollected / 5000
    },
    {
        id: 'unlock_cargo_expansion',
        name: 'Pack Rat',
        description: 'Collect 100 upgrades across all runs.',
        goal: 'Collect 100 upgrades',
        flavor: 'Fine. We\'ll add a shelf.',
        icon: 'cargo_expansion_3x1',
        unlock: { type: 'upgrade', id: 'cargo_expansion' },
        check: (m) => m.lifetime.upgradesCollected >= 100,
        progress: (m) => m.lifetime.upgradesCollected / 100
    },
    {
        id: 'unlock_shield_capacitor',
        name: 'Battering Ram',
        description: 'Destroy 50 asteroids by ramming them.',
        goal: 'Ram 50 asteroids',
        flavor: 'The shield generator filed a complaint.',
        icon: 'shield_capacitor_1x2',
        unlock: { type: 'upgrade', id: 'shield_capacitor' },
        check: (m) => m.lifetime.asteroidsRammed >= 50,
        progress: (m) => m.lifetime.asteroidsRammed / 50
    },
    {
        id: 'unlock_blink_engine',
        name: 'Out of Phase',
        description: 'Survive 20 minutes in a single run as the Looper.',
        goal: 'Survive 20 min as Looper',
        flavor: 'Twenty minutes in that thing and you stop trusting doors.',
        icon: 'blink_engine_3x2',
        unlock: { type: 'upgrade', id: 'blink_engine' },
        check: (m) => (m.lifetime.peakRunTimeByShip['looper'] || 0) >= 1200,
        progress: (m) => (m.lifetime.peakRunTimeByShip['looper'] || 0) / 1200
    },
    {
        id: 'unlock_momentum_module',
        name: 'Coasting',
        description: 'Survive 15 minutes in a single run as the Cruiser.',
        goal: 'Survive 15 min as Cruiser',
        flavor: 'Speed is easy. Not braking is a lifestyle.',
        icon: 'momentum_module_1x1',
        unlock: { type: 'upgrade', id: 'momentum_module' },
        check: (m) => (m.lifetime.peakRunTimeByShip['cruiser'] || 0) >= 900,
        progress: (m) => (m.lifetime.peakRunTimeByShip['cruiser'] || 0) / 900
    },
    {
        id: 'unlock_nanite_tank',
        name: 'Built to Last',
        description: 'Survive 20 minutes in a single run as the Bruiser.',
        goal: 'Survive 20 min as Bruiser',
        flavor: 'The hull remembers every hit. Now it heals them.',
        icon: 'nanite_tank_2x2',
        unlock: { type: 'upgrade', id: 'nanite_tank' },
        check: (m) => (m.lifetime.peakRunTimeByShip['bruiser'] || 0) >= 1200,
        progress: (m) => (m.lifetime.peakRunTimeByShip['bruiser'] || 0) / 1200
    },
    {
        id: 'unlock_multishot_guns',
        name: 'Twin Barrels',
        description: 'Survive 20 minutes in a single run as the Fighter.',
        goal: 'Survive 20 min as Fighter',
        flavor: 'One gun was never going to be enough.',
        icon: 'multishot_guns_2x1',
        unlock: { type: 'upgrade', id: 'multishot_guns' },
        check: (m) => (m.lifetime.peakRunTimeByShip['fighter'] || 0) >= 1200,
        progress: (m) => (m.lifetime.peakRunTimeByShip['fighter'] || 0) / 1200
    },

    // ── Unlocks: ships ──────────────────────────────────────────────────────
    // Only the Fighter is flyable from the start. Each other ship unlocks via
    // an objective themed to its fantasy — earnable within a few runs of
    // normal play, faster if chased deliberately. `shipsUsed` grandfathers
    // profiles that already completed a run with the ship before ship gating
    // existed. Icons reuse the ship's own still sprite.
    {
        id: 'unlock_cruiser',
        name: 'Outrunner',
        description: 'Travel 150,000 units across all runs.',
        goal: 'Travel 150,000 units',
        flavor: 'You clearly want to be somewhere else. Faster.',
        icon: 'cruiser_still',
        unlock: { type: 'ship', id: 'cruiser' },
        check: (m) => !!m.lifetime.shipsUsed['cruiser']
            || m.lifetime.distanceTraveled + m.run.distanceTraveled >= 150000,
        progress: (m) => m.lifetime.shipsUsed['cruiser'] ? 1
            : (m.lifetime.distanceTraveled + m.run.distanceTraveled) / 150000
    },
    {
        id: 'unlock_bruiser',
        name: 'Glutton for Punishment',
        description: 'Take 2500 total damage across all runs.',
        goal: 'Take 2500 damage',
        flavor: 'You keep getting hit. Here\'s a ship that doesn\'t mind.',
        icon: 'bruiser_still',
        unlock: { type: 'ship', id: 'bruiser' },
        check: (m) => !!m.lifetime.shipsUsed['bruiser'] || m.lifetime.damageTaken >= 2500,
        progress: (m) => m.lifetime.shipsUsed['bruiser'] ? 1 : m.lifetime.damageTaken / 2500
    },
    {
        id: 'unlock_looper',
        name: 'Untouchable',
        description: 'Perform 50 boost dodges across all runs.',
        goal: '50 boost dodges',
        flavor: 'Dodging is already your lifestyle. This is its ship.',
        icon: 'looper_still',
        unlock: { type: 'ship', id: 'looper' },
        check: (m) => !!m.lifetime.shipsUsed['looper'] || m.lifetime.dodgesPerformed >= 50,
        progress: (m) => m.lifetime.shipsUsed['looper'] ? 1 : m.lifetime.dodgesPerformed / 50
    },
    {
        id: 'unlock_vanisher',
        name: 'Ghost',
        description: 'Perform 200 boost dodges across all runs.',
        goal: '200 boost dodges',
        flavor: 'They keep missing. Time to stop being there at all.',
        icon: 'vanisher_still',
        unlock: { type: 'ship', id: 'vanisher' },
        check: (m) => !!m.lifetime.shipsUsed['vanisher'] || m.lifetime.dodgesPerformed >= 200,
        progress: (m) => m.lifetime.shipsUsed['vanisher'] ? 1 : m.lifetime.dodgesPerformed / 200
    },
    {
        id: 'unlock_blaster',
        name: 'Gun Platform',
        description: 'Destroy 1500 enemy ships across all runs.',
        goal: 'Destroy 1500 ships',
        flavor: 'You have the aim. Here is something with more barrels.',
        icon: 'blaster_still',
        unlock: { type: 'ship', id: 'blaster' },
        check: (m) => !!m.lifetime.shipsUsed['blaster'] || m.lifetime.enemiesKilled >= 1500,
        progress: (m) => m.lifetime.shipsUsed['blaster'] ? 1 : m.lifetime.enemiesKilled / 1500
    },

    // ── Upgrade gates: the Vanisher/Blaster batch + the legendary trio ──────
    // Same rules as the gates above: icon = the upgrade's own sprite, every
    // entry defines `goal`, objective themed to the item.
    {
        id: 'unlock_gravity_distortion',
        name: 'Now You See Me',
        description: 'Survive 20 minutes in a single run as the Vanisher.',
        goal: 'Survive 20 min as Vanisher',
        flavor: 'Twenty minutes of not being there. The trick is portable now.',
        icon: 'gravity_distortion_2x2',
        unlock: { type: 'upgrade', id: 'gravity_distortion' },
        check: (m) => (m.lifetime.peakRunTimeByShip['vanisher'] || 0) >= 1200,
        progress: (m) => (m.lifetime.peakRunTimeByShip['vanisher'] || 0) / 1200
    },
    {
        id: 'unlock_crossed_wiring',
        name: 'Broadside',
        description: 'Reach level 20 in a single run as the Blaster.',
        goal: 'Level 20 as Blaster',
        flavor: 'Sideways stopped feeling wrong. Bottle that.',
        icon: 'crossed_wiring_2x2',
        unlock: { type: 'upgrade', id: 'crossed_wiring' },
        check: (m) => (m.lifetime.peakLevelByShip['blaster'] || 0) >= 20,
        progress: (m) => (m.lifetime.peakLevelByShip['blaster'] || 0) / 20
    },
    {
        id: 'unlock_bomb_fabricator',
        name: 'Scorched Trail',
        description: 'Travel 500,000 units across all runs.',
        goal: 'Travel 500,000 units',
        flavor: 'You cover a lot of ground. Start leaving something behind.',
        icon: 'bomb_fabricator_2x2',
        unlock: { type: 'upgrade', id: 'bomb_fabricator' },
        check: (m) => m.lifetime.distanceTraveled + m.run.distanceTraveled >= 500000,
        progress: (m) => (m.lifetime.distanceTraveled + m.run.distanceTraveled) / 500000
    },
    {
        id: 'unlock_communications_array',
        name: 'Open Channel',
        description: 'Talk to 75 ships across all runs.',
        goal: 'Talk to 75 ships',
        flavor: 'Word gets around. Now they come looking for you.',
        icon: 'communications_array_2x2',
        unlock: { type: 'upgrade', id: 'communications_array' },
        check: (m) => _encountersMet(m) >= 75,
        progress: (m) => _encountersMet(m) / 75
    },
    {
        id: 'unlock_probability_manipulator',
        name: 'House Edge',
        description: 'Open 100 space caches across all runs.',
        goal: 'Open 100 caches',
        flavor: 'A hundred pulls teaches you the odds. This one rewrites them.',
        icon: 'probability_manipulator_2x1',
        unlock: { type: 'upgrade', id: 'probability_manipulator' },
        check: (m) => m.lifetime.cachesOpened >= 100,
        progress: (m) => m.lifetime.cachesOpened / 100
    },
    {
        // The Carcosa tribute always drops one regardless of this gate (the
        // drop in bones.js is the intended first source); the gate governs
        // shop / cache / encounter stock afterwards.
        id: 'unlock_experience_reshaper',
        name: 'Second Draft',
        description: 'Rebuild the starfield of bones. Its tribute carries the first one.',
        goal: 'Defeat Carcosa',
        flavor: 'The city was rebuilt from nothing. So can you be.',
        icon: 'experience_reshaper_2x2',
        unlock: { type: 'upgrade', id: 'experience_reshaper' },
        check: (m) => !!m.lifetime.bossesDefeated['Carcosa'],
        progress: (m) => m.lifetime.bossesDefeated['Carcosa'] ? 1 : 0
    },

    // ── Unlocks: combine tiers ──────────────────────────────────────────────
    // The fuse ladder is gated: with none of these earned the player can't
    // combine at all. Each grant raises the result-tier cap
    // (AchievementManager.combineTierCap): uncommon → rare → epic → legendary.
    {
        id: 'combine_tier_uncommon',
        name: 'Field Fusion',
        description: 'Reach level 10 in a single run. Unlocks combining upgrades up to Uncommon.',
        goal: 'Reach level 10',
        flavor: 'Two of the same part, one socket. It was only a matter of time.',
        icon: 'ach_combine_tier_uncommon',
        unlock: { type: 'combine', id: 'uncommon' },
        check: (m) => m.lifetime.peakLevel >= 10,
        progress: (m) => m.lifetime.peakLevel / 10
    },
    {
        id: 'combine_tier_rare',
        name: 'Cross-Platform',
        description: 'Reach level 20 with every ship. Unlocks combining upgrades up to Rare.',
        goal: 'Level 20 with every ship',
        flavor: 'Every hull, same trick. The trick got better.',
        icon: 'ach_combine_tier_rare',
        unlock: { type: 'combine', id: 'rare' },
        check: (m) => SHIP_IDS.every(s => (m.lifetime.peakLevelByShip[s] || 0) >= 20),
        progress: (m) => SHIP_IDS.filter(s => (m.lifetime.peakLevelByShip[s] || 0) >= 20).length / SHIP_IDS.length
    },
    {
        id: 'combine_tier_epic',
        name: 'Forbidden Engineering',
        description: 'Defeat The Yellow One. Unlocks combining upgrades up to Epic.',
        goal: 'Defeat The Yellow One',
        flavor: 'His crown melts down into something useful.',
        icon: 'ach_combine_tier_epic',
        unlock: { type: 'combine', id: 'epic' },
        check: (m) => !!m.lifetime.bossesDefeated['YellowOne']
    },
    {
        id: 'combine_tier_legendary',
        name: 'Master of the Forge',
        description: 'Defeat every boss at least once — the Dragon counts whole, or one head at a time. Unlocks combining upgrades up to Legendary.',
        goal: 'Defeat every boss',
        flavor: 'Nothing left to fight. Plenty left to build.',
        icon: 'ach_combine_tier_legendary',
        unlock: { type: 'combine', id: 'legendary' },
        check: (m) => ALL_BOSS_IDS.every(id => !!m.lifetime.bossesDefeated[id]) && dragonDone(m),
        progress: allBossProgress
    }
];
