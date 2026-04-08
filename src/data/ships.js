// Ship definitions
export const SHIPS = [
    {
        id: 'fighter',
        name: 'Fighter',
        description: 'A well-rounded ship that\ncan handle most situations.',
        health: 120,
        speed: 7,
        shield: 30,
        storage: { cols: 4, rows: 4 },
        baseDamage: 7.0,
        special: null,
        assets: {
            still: 'fighter_still', jets: 'fighter_jets', flying: 'fighter_flying',
            broken: ['fighter_broken_0', 'fighter_broken_1', 'fighter_broken_2', 'fighter_broken_3', 'fighter_broken_4']
        }
    },
    {
        id: 'cruiser',
        name: 'Cruiser',
        description: 'Pure speed. Built for\noutrunning everything.',
        health: 80,
        speed: 10,
        shield: 20,
        storage: { cols: 4, rows: 3 },
        baseDamage: 12.0,
        special: null,
        assets: {
            still: 'cruiser_still', jets: 'cruiser_jets', flying: 'cruiser_flying',
            broken: ['cruiser_broken_0', 'cruiser_broken_1', 'cruiser_broken_2', 'cruiser_broken_3', 'cruiser_broken_4']
        }
    },
    {
        id: 'bruiser',
        name: 'Bruiser',
        description: 'Heavy armor and massive\ncargo. Slow but unstoppable.',
        health: 200,
        speed: 4,
        shield: 40,
        storage: { cols: 4, rows: 5 },
        baseDamage: 7.0,
        special: null,
        assets: {
            still: 'bruiser_still', jets: 'bruiser_jets', flying: 'bruiser_flying',
            broken: ['bruiser_broken_0', 'bruiser_broken_1', 'bruiser_broken_2', 'bruiser_broken_3', 'bruiser_broken_4']
        }
    },
    {
        id: 'looper',
        name: 'Looper',
        description: 'Ultra mobile. Dodge is\nunlocked by default.',
        health: 80,
        speed: 8,
        shield: 20,
        storage: { cols: 4, rows: 4 },
        baseDamage: 10.0,
        special: 'dodge',
        assets: {
            still: 'looper_still', jets: 'looper_jets', flying: 'looper_flying',
            broken: ['looper_broken_0', 'looper_broken_1', 'looper_broken_2', 'looper_broken_3', 'looper_broken_4']
        }
    }
];
