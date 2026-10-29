// Codex entries for the bosses and world events (BestiaryState). `id` is the
// key the AchievementManager records under: lifetime.bossesDefeated[id] for
// bosses, lifetime.eventTypes[id] for events, and lifetime.bossesEncountered
// [id] for first sightings (notify('boss_encountered') from StateFX).
//   sprite: atlas key for the portrait (silhouetted until sighted)
//   color:  accent for the card

export const CODEX_BOSSES = [
    { id: 'Starcore', name: 'STARCORE', sprite: 'starcore', color: '#ffd24a',
        lore: 'A captive sun in an iron cage. It rams like a falling star and dies as a supernova.' },
    { id: 'AsteroidCrusher', name: 'ASTEROID CRUSHER', sprite: 'asteroid_crusher', color: '#ff5a3a',
        lore: 'A mining rig that forgot its crew. Red lightning drags the rocks in to be ground to scrap.' },
    { id: 'EventHorizon', name: 'EVENT HORIZON', sprite: 'event_horizon', color: '#b070ff',
        lore: 'A wound in space that eats light. Everything near it falls inward, eventually.' },
    { id: 'YellowOne', name: 'THE YELLOW ONE', sprite: 'yellow_one_idle', color: '#ffff44',
        lore: 'It holds a deed. It says the deed is to you.' },
    { id: 'Seraph', name: 'SERAPH', sprite: 'seraph_base_closed', color: '#fff3b0',
        lore: 'Six wings and one eye. When the eye opens, do not be where it looks.' },
    { id: 'Wheels', name: 'WHEELS', sprite: 'wheels_base', color: '#9fe8ff',
        lore: 'Wheels within wheels, rimmed with eyes. It turns, and the turning is the attack.' },
    { id: 'Swarm', name: 'THE HIVE', sprite: 'hive', color: '#c8e04a',
        lore: 'A nest the size of a station. Kill the brood and the Mother comes to see why.' },
    { id: 'SwarmMother', name: 'SWARM MOTHER', sprite: 'mother_idle', color: '#9ac24a',
        lore: 'She births as she fights. Starve her of children and she is only flesh.' },
    { id: 'Carcosa', name: 'CARCOSA', sprite: 'carcosa', color: '#e8d27a',
        lore: 'A city of bone adrift. Its dead still march, and the husks still twitch.' },
    { id: 'Dragon', name: 'THE DRAGON', sprite: 'dragon_deception', color: '#ff3a3a',
        lore: 'Seven heads, each a sin with a name. Cut one off and it remembers.' },
];

export const CODEX_EVENTS = [
    { id: 'CargoShipEvent', name: 'CARGO HAULER', sprite: 'cargo_ship', color: '#ffb04a',
        lore: 'A crippled freighter venting into the dark. Its holds are full. Its crew is not.' },
    { id: 'FracturedStationEvent', name: 'FRACTURED STATION', sprite: 'fractured_station_0', color: '#9fb8d8',
        lore: 'Half a station, sparking. Something on board is still running.' },
    { id: 'KnowledgeEvent', name: 'STRANGE GALAXY', sprite: 'knowledge', color: '#b070ff',
        lore: 'It watches. Feed it, lure it, or fight it. Each answer has a price.' },
    { id: 'CthulhuEvent', name: 'THE SLEEPER', sprite: 'cthulhu', color: '#4ad8a0',
        lore: 'It is dreaming. Its dreams have teeth.' },
];
