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

        // Re-place existing items into the new grid
        for (const entry of this.items) {
            const { item, x, y } = entry;
            for (let r = y; r < y + item.height && r < newRows; r++) {
                for (let c = x; c < x + item.width && c < newCols; c++) {
                    newGrid[r][c] = entry;
                }
            }
        }

        this.cols = newCols;
        this.rows = newRows;
        this.grid = newGrid;
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
}
