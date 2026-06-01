import { makeItem, itemTier, MAX_COMBINE_TIER } from '../data/upgrades.js';

/**
 * Manages a grid-based inventory.
 */
export class Inventory {
    constructor(cols, rows) {
        this.cols = cols;
        this.rows = rows;
        this.grid = Array(rows).fill(null).map(() => Array(cols).fill(null));
        this.items = []; // List of { item, x, y, rotated }
    }

    /**
     * Checks if an item can fit at the given coordinates.
     */
    canFit(item, x, y) {
        const w = item.width;
        const h = item.height;

        if (x < 0 || y < 0 || x + w > this.cols || y + h > this.rows) {
            return false;
        }

        for (let r = y; r < y + h; r++) {
            for (let c = x; c < x + w; c++) {
                if (this.grid[r][c] !== null) {
                    return false;
                }
            }
        }

        return true;
    }

    /**
     * Places an item in the inventory.
     */
    addItem(item, x, y) {
        if (!this.canFit(item, x, y)) return false;

        const entry = { item, x, y };
        this.items.push(entry);

        const w = item.width;
        const h = item.height;

        for (let r = y; r < y + h; r++) {
            for (let c = x; c < x + w; c++) {
                this.grid[r][c] = entry;
            }
        }

        return true;
    }

    /**
     * Removes an item at the given grid coordinates.
     */
    removeItemAt(x, y) {
        const entry = this.grid[y][x];
        if (!entry) return null;

        const { item } = entry;
        const w = item.width;
        const h = item.height;

        for (let r = entry.y; r < entry.y + h; r++) {
            for (let c = entry.x; c < entry.x + w; c++) {
                this.grid[r][c] = null;
            }
        }

        this.items = this.items.filter(i => i !== entry);
        return entry;
    }

    getItemAt(x, y) {
        return this.grid[y] ? this.grid[y][x] : null;
    }

    clear() {
        this.grid = Array(this.rows).fill(null).map(() => Array(this.cols).fill(null));
        this.items = [];
    }

    /**
     * Resizes the inventory grid, preserving existing items.
     */
    resize(newCols, newRows) {
        const newGrid = Array(newRows).fill(null).map(() => Array(newCols).fill(null));
        const ejectedItems = [];
        const keptItems = [];

        // Re-place existing items into the new grid
        for (const entry of this.items) {
            const { item, x, y } = entry;
            
            if (x + item.width > newCols || y + item.height > newRows) {
                ejectedItems.push(item);
            } else {
                keptItems.push(entry);
                for (let r = y; r < y + item.height; r++) {
                    for (let c = x; c < x + item.width; c++) {
                        newGrid[r][c] = entry;
                    }
                }
            }
        }

        this.cols = newCols;
        this.rows = newRows;
        this.grid = newGrid;
        this.items = keptItems;
        
        return ejectedItems;
    }

    /**
     * Swaps a dragged item with the single item it overlaps at the drop position.
     * The displaced item must fit exactly at (originX, originY) — otherwise the
     * swap is rejected and the inventory is left untouched (caller can bounce
     * the dragged item back to its origin). Returns true on success.
     */
    trySwap(draggedItem, dropX, dropY, originX, originY) {
        const dw = draggedItem.width;
        const dh = draggedItem.height;

        if (dropX < 0 || dropY < 0 || dropX + dw > this.cols || dropY + dh > this.rows) {
            return false;
        }

        const overlapping = new Set();
        for (let r = dropY; r < dropY + dh; r++) {
            for (let c = dropX; c < dropX + dw; c++) {
                const entry = this.grid[r][c];
                if (entry) overlapping.add(entry);
            }
        }
        if (overlapping.size !== 1) return false;

        const otherEntry = overlapping.values().next().value;
        const otherItem = otherEntry.item;
        const otherX = otherEntry.x;
        const otherY = otherEntry.y;

        this.removeItemAt(otherX, otherY);

        if (!this.canFit(draggedItem, dropX, dropY)) {
            this.addItem(otherItem, otherX, otherY);
            return false;
        }
        this.addItem(draggedItem, dropX, dropY);

        if (!this.canFit(otherItem, originX, originY)) {
            this.removeItemAt(dropX, dropY);
            this.addItem(otherItem, otherX, otherY);
            return false;
        }
        this.addItem(otherItem, originX, originY);
        return true;
    }

    /**
     * Attempts to combine the dragged item into a matching item it overlaps at
     * the drop position. Both must be combinable, share the same id and tier,
     * and not already be at max tier. On success the overlapped item is replaced
     * in place by the next tier up, the dragged item is consumed, and true is
     * returned. Returns false (leaving the inventory untouched) otherwise, so
     * the caller can fall through to trySwap.
     */
    /**
     * Non-mutating check: returns the entry the dragged item would combine into
     * at the drop position, or null if no valid combine. Combine requires the
     * footprint to overlap exactly one entry of the same id and tier, both
     * combinable, below max tier.
     */
    combineTargetAt(draggedItem, dropX, dropY) {
        if (!draggedItem.combine) return null;

        const dw = draggedItem.width;
        const dh = draggedItem.height;
        if (dropX < 0 || dropY < 0 || dropX + dw > this.cols || dropY + dh > this.rows) {
            return null;
        }

        const overlapping = new Set();
        for (let r = dropY; r < dropY + dh; r++) {
            for (let c = dropX; c < dropX + dw; c++) {
                const entry = this.grid[r][c];
                if (entry) overlapping.add(entry);
            }
        }
        if (overlapping.size !== 1) return null;

        // Note: tier-0 items share one definition object, so identity equality
        // can't distinguish entries — the dragged item is already removed from
        // the grid on pickup, so the overlapped entry is never the dragged one.
        const target = overlapping.values().next().value;
        const other = target.item;
        if (other.id !== draggedItem.id || !other.combine) return null;

        const tier = itemTier(draggedItem);
        if (itemTier(other) !== tier) return null;
        if (tier >= MAX_COMBINE_TIER) return null;

        return target;
    }

    tryCombine(draggedItem, dropX, dropY) {
        const target = this.combineTargetAt(draggedItem, dropX, dropY);
        if (!target) return false;

        const { x, y } = target;
        const tier = itemTier(target.item);
        this.removeItemAt(x, y);
        this.addItem(makeItem(draggedItem.id, tier + 1), x, y);
        return true;
    }

    /**
     * Non-mutating feasibility check for trySwap.
     */
    canSwap(draggedItem, dropX, dropY, originX, originY) {
        const gridSnap = this.grid.map(row => row.slice());
        const itemsSnap = this.items.slice();
        const ok = this.trySwap(draggedItem, dropX, dropY, originX, originY);
        this.grid = gridSnap;
        this.items = itemsSnap;
        return ok;
    }

    /**
     * Finds the first available spot for an item and adds it.
     */
    autoAdd(item) {
        for (let y = 0; y <= this.rows - item.height; y++) {
            for (let x = 0; x <= this.cols - item.width; x++) {
                if (this.addItem(item, x, y)) {
                    return true;
                }
            }
        }
        return false;
    }

    serialize() {
        return {
            cols: this.cols,
            rows: this.rows,
            items: this.items.map(entry => ({
                id: entry.item.id,
                tier: entry.item.tier || 0,
                x: entry.x,
                y: entry.y
            }))
        };
    }

    deserialize(data) {
        this.cols = data.cols;
        this.rows = data.rows;
        this.clear();

        for (const itemData of data.items) {
            const upgrade = makeItem(itemData.id, itemData.tier || 0);
            if (upgrade) {
                this.addItem(upgrade, itemData.x, itemData.y);
            }
        }

        // Only recalculate stats if this is the player inventory
        if (this.isPlayerInventory && this.playingState) {
            this.playingState._onInventoryChanged();
        }
    }
}
