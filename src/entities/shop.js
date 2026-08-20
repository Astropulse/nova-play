import { Inventory } from '../engine/inventory.js';
import { UPGRADES, RARITY_WEIGHTS, isUpgradeUnlocked } from '../data/upgrades.js';

// The first shop a player EVER sees is a showroom (see _generateInventory):
// one guaranteed centerpiece — a big weapon when the profile has one unlocked,
// otherwise the flashiest UNGATED gear below. The progression gates are never
// bypassed: a fresh profile has every big weapon locked, so it gets a
// really-good unlocked item instead.
const BIG_WEAPON_IDS = ['railgun', 'repeater', 'auto_turret', 'energy_blaster', 'laser_override', 'explosives_unit'];
const SHOWROOM_FALLBACK_IDS = ['energy_canisters', 'mechanical_engines', 'boost_drive', 'control_module'];

export class Shop {
    // opts.firstEverShop — ENGAGEMENT: guarantees one big weapon + two rare
    // upgrades in stock. Set by PlayingState._spawnInitialShops when the
    // profile has never visited a shop (lifetime.shopsVisited === 0).
    constructor(game, worldX, worldY, opts = {}) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.revealed = false; // For radar
        this.isFirstEverShop = !!opts.firstEverShop;

        // Shops don't rotate
        this.angle = 0;

        // Spawn-time content RNG (from the seeded shops stream) so stock is
        // reproducible. Falls back outside a run. Shop inventory is fully
        // serialized, so this seed itself isn't persisted.
        if (game.rng) {
            const d = game.rng.deriveEntity('shops');
            this.contentRng = d.rng;
            this.contentSeed = d.seed;
        } else {
            this.contentRng = null;
            this.contentSeed = null;
        }

        // Shop sprite variant — derived from the content seed (decorrelated so
        // the stock rolls are untouched) so every machine in multiplayer shows
        // the same building. Falls back to Math.random() outside a run.
        let spriteRoll;
        if (this.contentSeed != null) {
            let s = (this.contentSeed ^ 0x5f3759df) | 0;
            s = (s + 0x6D2B79F5) | 0;
            let t = Math.imul(s ^ s >>> 15, 1 | s);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            spriteRoll = ((t ^ t >>> 14) >>> 0) / 4294967296;
        } else {
            spriteRoll = Math.random();
        }
        const shopIdx = Math.floor(spriteRoll * 3);
        this.assetKey = `shop_${shopIdx}`;
        this.img = game.assets.get(this.assetKey);

        // Shop inventory is 6x4
        this.inventory = new Inventory(6, 4);
        this._generateInventory();

        // Interaction radius
        this.interactRange = 150;

        // Permanent upgrade stock per shop
        this.permUpgrades = {
            health: { stock: 2 },
            shield: { stock: 2 },
            damage: { stock: 2 },
            inventory: { stock: 1 }
        };
    }

    _generateInventory() {
        // Seeded stock selection + placement for reproducibility.
        const rand = () => this.contentRng ? this.contentRng.next() : Math.random();
        // At least 4 random upgrades + 1 map = 5 total minimum
        // Up to 7 random upgrades + 1 map = 8 total maximum
        const count = 3 + Math.floor(rand() * 4);

        // Filter upgrades that can actually fit in 6x4, excluding the map from random rolls
        // Locators are dropped from the stock list once every signal in the
        // sector has been found — there'd be nothing left for them to point at.
        const signalsLeft = this.game.currentState?.hasUndiscoveredSignals?.() ?? true;
        const possibleUpgrades = UPGRADES.filter(u =>
            u.id !== 'shop_map' &&
            (signalsLeft || u.id !== 'advanced_locator') &&
            u.rarity !== 'unique' &&
            isUpgradeUnlocked(this.game, u.id) &&
            (u.width <= this.inventory.cols && u.height <= this.inventory.rows)
        );

        if (possibleUpgrades.length === 0) return;

        // 1. Selection Phase: Pick 'count' items based on weight
        const selected = [];
        const guaranteed = new Set(); // placed with priority — never squeezed out
        // ALWAYS include a shop map
        const shopMap = UPGRADES.find(u => u.id === 'shop_map');
        if (shopMap) { selected.push(shopMap); guaranteed.add(shopMap); }

        // ENGAGEMENT — first-ever shop is a showroom: one guaranteed
        // centerpiece plus two rare upgrades on top of the normal roll,
        // everything strictly within the unlock gates. The centerpiece is a
        // big weapon when the profile has one unlocked; a fresh profile (all
        // big weapons gate-locked) gets a really-good ungated item from
        // SHOWROOM_FALLBACK_IDS instead.
        if (this.isFirstEverShop) {
            let pool = UPGRADES.filter(u =>
                BIG_WEAPON_IDS.includes(u.id) && isUpgradeUnlocked(this.game, u.id));
            if (pool.length === 0) {
                pool = UPGRADES.filter(u =>
                    SHOWROOM_FALLBACK_IDS.includes(u.id) && isUpgradeUnlocked(this.game, u.id));
            }
            if (pool.length === 0) {
                // Both lists gated away (future data drift) — the rarest,
                // largest unlocked gear stands in.
                const tier = { rare: 3, uncommon: 2, common: 1 };
                pool = possibleUpgrades
                    .filter(u => !u.consumable)
                    .sort((a, b) => (tier[b.rarity] || 0) - (tier[a.rarity] || 0)
                        || (b.width * b.height) - (a.width * a.height))
                    .slice(0, 3);
            }
            if (pool.length) {
                const centerpiece = pool[Math.floor(rand() * pool.length)];
                selected.push(centerpiece);
                guaranteed.add(centerpiece);
            }
            const rares = possibleUpgrades.filter(u => u.rarity === 'rare' && !selected.includes(u));
            for (let i = 0; i < 2 && rares.length > 0; i++) {
                const pick = rares.splice(Math.floor(rand() * rares.length), 1)[0];
                selected.push(pick);
                guaranteed.add(pick);
            }
        }

        for (let i = 0; i < count; i++) {
            // Filter pool to avoid duplicates
            const pool = possibleUpgrades.filter(u => !selected.includes(u));
            if (pool.length === 0) break;

            selected.push(this._rollUpgrade(pool));
        }

        // 2. Placement Phase: Try to fit them, larger items first to avoid
        // fragmentation — but guaranteed items (map + showroom stock) place
        // before everything else so a crowded roll can't squeeze them out.
        selected.sort((a, b) => {
            const ga = guaranteed.has(a) ? 1 : 0, gb = guaranteed.has(b) ? 1 : 0;
            if (ga !== gb) return gb - ga;
            return (b.width * b.height) - (a.width * a.height);
        });

        for (const upgrade of selected) {
            let placed = false;
            // Guaranteed multi-cell items (the showroom stock) skip the random
            // scatter and pack via the exhaustive scan: two randomly-placed
            // 2x2s can fragment the grid so a third finds no hole anywhere.
            // 1x1s (the map) and random stock keep the natural scattered look.
            const randomTries = (guaranteed.has(upgrade) && upgrade.width * upgrade.height > 1) ? 0 : 15;
            // Try random spots first for natural look
            for (let attempt = 0; attempt < randomTries; attempt++) {
                const rx = Math.floor(rand() * (this.inventory.cols - upgrade.width + 1));
                const ry = Math.floor(rand() * (this.inventory.rows - upgrade.height + 1));

                if (this.inventory.addItem(upgrade, rx, ry)) {
                    placed = true;
                    break;
                }
            }

            // If random failed, try exhaustive scan
            if (!placed) {
                outer: for (let y = 0; y <= this.inventory.rows - upgrade.height; y++) {
                    for (let x = 0; x <= this.inventory.cols - upgrade.width; x++) {
                        if (this.inventory.addItem(upgrade, x, y)) {
                            placed = true;
                            break outer;
                        }
                    }
                }
            }
        }
    }

    _rollUpgrade(pool) {
        let totalWeight = 0;
        const weights = pool.map(u => {
            const w = RARITY_WEIGHTS[u.rarity] || 10;
            totalWeight += w;
            return w;
        });

        let roll = (this.contentRng ? this.contentRng.next() : Math.random()) * totalWeight;
        for (let i = 0; i < pool.length; i++) {
            roll -= weights[i];
            if (roll <= 0) return pool[i];
        }
        return pool[0];
    }

    update(dt) {
        // Shops are static but could have animations
    }

    draw(ctx, camera) {
        if (!this.img) return;
        const screen = camera.worldToScreen(this.worldX, this.worldY, this.game.width, this.game.height);
        const w = (this.img.width || this.img.canvas.width) * this.game.worldScale;
        const h = (this.img.height || this.img.canvas.height) * this.game.worldScale;

        // Simple culling
        if (screen.x + w < -100 || screen.x - w > this.game.width + 100 ||
            screen.y + h < -100 || screen.y - h > this.game.height + 100) return;

        ctx.save();
        ctx.translate(screen.x, screen.y);
        // Shops don't rotate, always upright
        ctx.drawImage(this.img.canvas || this.img, -w / 2, -h / 2, w, h);
        ctx.restore();
    }

    get radius() {
        return (this.img ? Math.max(this.img.width, this.img.height) / 2 : 32);
    }

    serialize() {
        return {
            worldX: this.worldX,
            worldY: this.worldY,
            revealed: this.revealed,
            assetKey: this.assetKey,
            permUpgrades: { ...this.permUpgrades },
            inventory: this.inventory.serialize()
        };
    }

    async deserialize(data) {
        this.worldX = data.worldX;
        this.worldY = data.worldY;
        this.revealed = data.revealed;
        this.assetKey = data.assetKey;
        this.img = this.game.assets.get(this.assetKey);
        this.permUpgrades = { ...data.permUpgrades };
        if (data.inventory) {
            await this.inventory.deserialize(data.inventory);
        }
    }
}
