// Uniform spatial hash for broad-phase neighbour queries.
//
// Built fresh each frame from a list of entities (anything with worldX/worldY),
// then queried by radius. Turns the O(n²) "every entity checks every other"
// scans (enemy separation, projectile-dodge, proximity collision) into
// O(n + hits): each query only visits the handful of grid cells its radius
// overlaps instead of the whole population.
//
// Allocation-discipline: cell arrays are pooled and reused across frames (clear
// sets length 0 and returns them to a freelist), and queries write candidates
// into a caller-supplied scratch array, so a steady-state frame allocates
// nothing here. Single-threaded sequential use only (the scratch contract
// assumes one query is consumed before the next overwrites shared state — but
// each query targets a caller-owned array, so independent callers are safe).

export class SpatialHash {
    constructor(cellSize = 128) {
        this.cellSize = cellSize;
        this.inv = 1 / cellSize;
        this.cells = new Map(); // packed cell key -> entity[]
        this._pool = [];        // reusable cell arrays
        this._stamp = 0;        // queryBoxInto dedupe counter
    }

    // Pack a signed cell coordinate pair into one integer key. The 16-bit mask
    // wraps cells ~65k apart (≈ cellSize × 65k world units) to the same bucket —
    // astronomically far in practice, and a stray far-field neighbour is
    // harmless for every consumer (they all re-test exact distance).
    _key(cx, cy) {
        return ((cx & 0xFFFF) << 16) | (cy & 0xFFFF);
    }

    // Drop all entries but keep the backing arrays for reuse next frame.
    clear() {
        const pool = this._pool;
        for (const arr of this.cells.values()) {
            arr.length = 0;
            pool.push(arr);
        }
        this.cells.clear();
    }

    // Rebuild from scratch for this frame. `filter` (optional) skips entities
    // (e.g. dead ones) so queries never see them.
    rebuild(items, filter) {
        this.clear();
        const inv = this.inv;
        const cells = this.cells;
        const pool = this._pool;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            if (filter && !filter(it)) continue;
            const cx = Math.floor(it.worldX * inv);
            const cy = Math.floor(it.worldY * inv);
            const k = ((cx & 0xFFFF) << 16) | (cy & 0xFFFF);
            let arr = cells.get(k);
            if (arr === undefined) {
                arr = pool.length ? pool.pop() : [];
                cells.set(k, arr);
            }
            arr.push(it);
        }
    }

    // Insert one entity into every cell its axis-aligned box overlaps. Use this
    // (after clear()) instead of rebuild() when entities have real extents
    // (asteroid radius, enemy hull ellipse): a big body then lands in each
    // cell it touches, so a queryBoxInto() of any size finds it without the
    // caller having to pad every query by the largest body in the world.
    // `_shStamp` is reserved on the item for queryBoxInto's dedupe.
    insertBox(item, minX, minY, maxX, maxY) {
        const inv = this.inv;
        const cells = this.cells;
        const pool = this._pool;
        const minCx = Math.floor(minX * inv), maxCx = Math.floor(maxX * inv);
        const minCy = Math.floor(minY * inv), maxCy = Math.floor(maxY * inv);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const k = ((cx & 0xFFFF) << 16) | (cy & 0xFFFF);
                let arr = cells.get(k);
                if (arr === undefined) {
                    arr = pool.length ? pool.pop() : [];
                    cells.set(k, arr);
                }
                arr.push(item);
            }
        }
    }

    // Append every entity registered (via insertBox) in a cell that overlaps
    // the query box into `out` (cleared first) and return it. An entity that
    // spans several of the visited cells is appended ONCE (per-query stamp on
    // `item._shStamp`). Broad-phase only: the caller runs the exact test.
    queryBoxInto(minX, minY, maxX, maxY, out) {
        out.length = 0;
        const inv = this.inv;
        const cells = this.cells;
        const stamp = ++this._stamp;
        const minCx = Math.floor(minX * inv), maxCx = Math.floor(maxX * inv);
        const minCy = Math.floor(minY * inv), maxCy = Math.floor(maxY * inv);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const arr = cells.get(((cx & 0xFFFF) << 16) | (cy & 0xFFFF));
                if (arr === undefined) continue;
                for (let i = 0; i < arr.length; i++) {
                    const it = arr[i];
                    if (it._shStamp === stamp) continue;
                    it._shStamp = stamp;
                    out.push(it);
                }
            }
        }
        return out;
    }

    // Append every entity whose cell overlaps the query box [x±r, y±r] into
    // `out` (which is cleared first) and return it. Callers then do the exact
    // distance test themselves — this is broad-phase only. No allocation when
    // `out` is reused across calls.
    queryInto(x, y, r, out) {
        out.length = 0;
        const inv = this.inv;
        const cells = this.cells;
        const minCx = Math.floor((x - r) * inv);
        const maxCx = Math.floor((x + r) * inv);
        const minCy = Math.floor((y - r) * inv);
        const maxCy = Math.floor((y + r) * inv);
        for (let cx = minCx; cx <= maxCx; cx++) {
            for (let cy = minCy; cy <= maxCy; cy++) {
                const arr = cells.get(((cx & 0xFFFF) << 16) | (cy & 0xFFFF));
                if (arr === undefined) continue;
                for (let i = 0; i < arr.length; i++) out.push(arr[i]);
            }
        }
        return out;
    }
}
