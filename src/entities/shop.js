import { Inventory } from '../engine/inventory.js';
import { UPGRADES, RARITY_WEIGHTS } from '../data/upgrades.js';

export class Shop {
    constructor(game, worldX, worldY) {
        this.game = game;
        this.worldX = worldX;
        this.worldY = worldY;
        this.alive = true;
        this.revealed = false; // For radar

        // Shops don't rotate
        this.angle = 0;

        // Random shop sprite
        const shopIdx = Math.floor(Math.random() * 3);
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
        // At least 4 random upgrades + 1 map = 5 total minimum
        // Up to 7 random upgrades + 1 map = 8 total maximum
        const count = 4 + Math.floor(Math.random() * 4);

        // Filter upgrades that can actually fit in 6x4, excluding the map from random rolls
        const possibleUpgrades = UPGRADES.filter(u =>
            u.id !== 'shop_map' &&
            u.rarity !== 'unique' &&
            (u.width <= this.inventory.cols && u.height <= this.inventory.rows)
        );

        if (possibleUpgrades.length === 0) return;

        // 1. Selection Phase: Pick 'count' items based on weight
        const selected = [];
        // ALWAYS include a shop map
        const shopMap = UPGRADES.find(u => u.id === 'shop_map');
        if (shopMap) selected.push(shopMap);

        for (let i = 0; i < count; i++) {
            // Filter pool to avoid duplicates
            const pool = possibleUpgrades.filter(u => !selected.includes(u));
            if (pool.length === 0) break;

            selected.push(this._rollUpgrade(pool));
        }

        // 2. Placement Phase: Try to fit them, larger items first to avoid fragmentation
        selected.sort((a, b) => (b.width * b.height) - (a.width * a.height));

        for (const upgrade of selected) {
            let placed = false;
            // Try random spots first for natural look
            for (let attempt = 0; attempt < 15; attempt++) {
                const rx = Math.floor(Math.random() * (this.inventory.cols - upgrade.width + 1));
                const ry = Math.floor(Math.random() * (this.inventory.rows - upgrade.height + 1));

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

        let roll = Math.random() * totalWeight;
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
        const w = this.img.width * this.game.worldScale;
        const h = this.img.height * this.game.worldScale;

        // Simple culling
        if (screen.x + w < -100 || screen.x - w > this.game.width + 100 ||
            screen.y + h < -100 || screen.y - h > this.game.height + 100) return;

        ctx.save();
        ctx.translate(Math.floor(screen.x), Math.floor(screen.y));
        // Shops don't rotate, always upright
        ctx.drawImage(this.img, -Math.floor(w / 2), -Math.floor(h / 2), w, h);
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
