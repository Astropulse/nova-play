// ============================================================================
// pack_assets.mjs — Nova asset atlas packer
// ----------------------------------------------------------------------------
// Walks the Assets/ folder, decodes every PNG and GIF, and packs them — at
// NATIVE pixel resolution — into one or more atlas pages (atlas_N.png) plus a
// single atlas.json that maps every asset key to its page + rect (and, for
// animations, every frame's rect + delay).
//
// atlas.json is the runtime source of truth: the game loads the pages and the
// json, then the loader pre-scales each sprite for drawing (see atlasLoader).
//
// Design goals (per project requirements):
//   * Adaptable / not size-dependent: assets are auto-discovered. New files
//     just get packed on the next run; pages are added as needed.
//   * Bounded memory: each page's decoded RGBA footprint stays under a budget
//     (default 512 MB) and within a max texture dimension (default 8192).
//   * Key compatibility: keys used by existing game code are preserved by
//     reading them straight out of the manifests in src/engine/game.js. Files
//     not in those manifests get a deterministic slug key (logged on run).
//
// Zero external dependencies — PNG (de)coding uses Node's built-in zlib; GIF
// decoding is ported from src/engine/gifDecoder.js.
//
// Usage:  node scripts/pack_assets.mjs        (or: npm run pack-assets)
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { fitHitbox } from './lib/fit_hitbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ---- Configuration ---------------------------------------------------------
const ASSETS_DIR = join(ROOT, 'Assets');
const OUT_DIR = join(ASSETS_DIR, 'atlas');     // pages + atlas.json live here
const GAME_JS = join(ROOT, 'src', 'engine', 'game.js');

const MAX_DIM = 8192;                            // max page width/height (px)
const MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;   // max decoded RGBA per page
const PADDING = 1;                               // px gutter between sprites
const PRESCALE = 4;                              // recorded for the loader

// Ellipse hitboxes are computed only for COMBAT sprites whose source path lives
// under one of these folders — every hostile ship/boss/event. Player ships and
// non-hostile events (cache, cargo, etc.) are intentionally excluded so the
// atlas isn't bloated with hitboxes nothing reads. The runtime fits the ellipse
// to the silhouette (centered on the image) and rotates it with the entity; see
// src/engine/collision.js. Future entities (seraph/wheels/bone/swarm) already have
// their art folders here, so they get hitboxes the moment the art is packed.
const HITBOX_PREFIXES = [
    'Assets/Ships/Enemy/',
    'Assets/Ships/Bosses/',
    'Assets/Ships/Cthulhu/',
    'Assets/Ships/Encounter/',
    'Assets/Ships/Yellow Armada/',
    'Assets/Ships/Swarm/',
    'Assets/Ships/Bone/',
    'Assets/Events/yellow_one/',
    'Assets/Ships/Dragon/',
    'Assets/Events/seraph/',
    'Assets/Events/wheels/',
    'Assets/Events/cthulhu',  // the Frozen God event (cthulhu.png + cthulhu_wake.gif)
];
const HITBOX_BLEND = 0.5;   // 0 = inner ellipse, 1 = outer; 0.5 = the chosen fit
const wantsHitbox = (assetPath) => HITBOX_PREFIXES.some(p => assetPath.startsWith(p));

// A page must satisfy both the dimension cap and the memory budget.
const MAX_AREA = Math.min(MAX_DIM * MAX_DIM, Math.floor(MEMORY_BUDGET_BYTES / 4));

// Sprites the title screen draws. These are packed into a small extra "boot"
// atlas (atlas_boot.*) that the game loads first so the menu appears fast; the
// full atlas (which also contains these) streams in behind it. Keep in sync
// with what MenuState.draw renders — a missing key just means that sprite waits
// for the full atlas (brief), never a crash. Starfield/World sprites are NOT
// here on purpose: the World build is deferred, so it can wait for the full atlas.
const BOOT_KEYS = [
    'title', 'pixel_wordmark',
    'left_arrow_off', 'left_arrow_on', 'right_arrow_off', 'right_arrow_on',
    'start_flight_off', 'start_flight_on', 'tutorial_off', 'tutorial_on',
    'fighter_still', 'cruiser_still', 'bruiser_still', 'looper_still',
];

// ============================================================================
// PNG decoding (8-bit; color types 0/2/3/4/6, all filters, non-interlaced)
// ============================================================================
function decodePNG(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG');
    let pos = 8;
    let width, height, depth, colorType, interlace;
    let palette = null, trns = null;
    const idat = [];

    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos); pos += 4;
        const type = buf.toString('ascii', pos, pos + 4); pos += 4;
        const data = buf.subarray(pos, pos + len); pos += len;
        pos += 4; // CRC (ignored)

        if (type === 'IHDR') {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            depth = data[8];
            colorType = data[9];
            interlace = data[12];
        } else if (type === 'PLTE') {
            palette = data;
        } else if (type === 'tRNS') {
            trns = data;
        } else if (type === 'IDAT') {
            idat.push(data);
        } else if (type === 'IEND') {
            break;
        }
    }

    if (depth !== 8) throw new Error(`Unsupported PNG bit depth ${depth}`);
    if (interlace !== 0) throw new Error('Interlaced PNG not supported');

    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!channels) throw new Error(`Unsupported PNG color type ${colorType}`);

    const raw = inflateSync(Buffer.concat(idat));
    const bpp = channels;             // bytes per pixel (depth 8)
    const stride = width * bpp;
    const pixels = Buffer.alloc(height * stride);

    // Undo scanline filters.
    for (let y = 0; y < height; y++) {
        const filter = raw[y * (stride + 1)];
        const inRow = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
        const out = pixels.subarray(y * stride, y * stride + stride);
        const prev = y > 0 ? pixels.subarray((y - 1) * stride, (y - 1) * stride + stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= bpp ? out[x - bpp] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
            let v = inRow[x];
            switch (filter) {
                case 0: break;
                case 1: v = (v + a) & 0xff; break;
                case 2: v = (v + b) & 0xff; break;
                case 3: v = (v + ((a + b) >> 1)) & 0xff; break;
                case 4: v = (v + paeth(a, b, c)) & 0xff; break;
                default: throw new Error(`Bad PNG filter ${filter}`);
            }
            out[x] = v;
        }
    }

    // Expand to RGBA.
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * bpp, d = i * 4;
        if (colorType === 6) {            // RGBA
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = pixels[s + 3];
        } else if (colorType === 2) {     // RGB
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255;
        } else if (colorType === 0) {     // grayscale
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = 255;
        } else if (colorType === 4) {     // grayscale + alpha
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = pixels[s + 1];
        } else if (colorType === 3) {     // palette
            const idx = pixels[s];
            rgba[d] = palette[idx * 3]; rgba[d + 1] = palette[idx * 3 + 1]; rgba[d + 2] = palette[idx * 3 + 2];
            rgba[d + 3] = trns && idx < trns.length ? trns[idx] : 255;
        }
    }
    return { width, height, rgba };
}

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

// ============================================================================
// PNG encoding (8-bit RGBA, filter 0, single IDAT)
// ============================================================================
const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgba) {
    const stride = width * 4;
    const filtered = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        filtered[y * (stride + 1)] = 0; // filter: none
        Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
            .copy(filtered, y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 6;   // color type RGBA
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(filtered, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

// ============================================================================
// GIF decoding (ported from src/engine/gifDecoder.js, canvas-free)
// Produces full-logical-screen RGBA snapshots per frame, matching the runtime
// decoder so atlas frames are pixel-identical to the old path.
// ============================================================================
function decodeGIF(data) {
    const header = String.fromCharCode(...data.subarray(0, 6));
    if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('Not a GIF');
    let pos = 6;
    const width = data[pos] | (data[pos + 1] << 8); pos += 2;
    const height = data[pos] | (data[pos + 1] << 8); pos += 2;
    const packed = data[pos++];
    pos += 2; // bg color + aspect ratio

    let gct = null;
    if ((packed >> 7) & 1) {
        const gctSize = 2 << (packed & 7);
        gct = [];
        for (let i = 0; i < gctSize; i++) gct.push([data[pos++], data[pos++], data[pos++]]);
    }

    const frames = [];
    let gce = null;
    const comp = new Uint8ClampedArray(width * height * 4); // compositing buffer

    while (pos < data.length) {
        const block = data[pos++];
        if (block === 0x3B) break; // trailer
        if (block === 0x21) {      // extension
            const label = data[pos++];
            if (label === 0xF9) {  // graphic control
                pos++;
                const gcPacked = data[pos++];
                const delay = (data[pos] | (data[pos + 1] << 8)) * 10; pos += 2;
                const transparentIdx = data[pos++];
                gce = {
                    disposal: (gcPacked >> 2) & 7,
                    transparentFlag: gcPacked & 1,
                    transparentIdx,
                    delay: delay || 100,
                };
                pos++;
            } else {
                while (data[pos]) pos += data[pos] + 1;
                pos++;
            }
        } else if (block === 0x2C) { // image descriptor
            const left = data[pos] | (data[pos + 1] << 8); pos += 2;
            const top = data[pos] | (data[pos + 1] << 8); pos += 2;
            const w = data[pos] | (data[pos + 1] << 8); pos += 2;
            const h = data[pos] | (data[pos + 1] << 8); pos += 2;
            const imgPacked = data[pos++];
            const interlaced = (imgPacked >> 6) & 1;

            let lct = null;
            if ((imgPacked >> 7) & 1) {
                const lctSize = 2 << (imgPacked & 7);
                lct = [];
                for (let i = 0; i < lctSize; i++) lct.push([data[pos++], data[pos++], data[pos++]]);
            }
            const colorTable = lct || gct;

            const minCodeSize = data[pos++];
            const lzwBytes = [];
            while (data[pos]) {
                const sz = data[pos++];
                for (let i = 0; i < sz; i++) lzwBytes.push(data[pos++]);
            }
            pos++;

            const pixels = lzwDecode(minCodeSize, lzwBytes, w * h);

            const disposal = gce ? gce.disposal : 0;
            let prev = null;
            if (disposal === 3) prev = comp.slice();
            if (disposal === 2) {
                for (let yy = 0; yy < h; yy++)
                    for (let xx = 0; xx < w; xx++) {
                        const di = ((top + yy) * width + (left + xx)) * 4;
                        comp[di] = comp[di + 1] = comp[di + 2] = comp[di + 3] = 0;
                    }
            }

            const transIdx = gce && gce.transparentFlag ? gce.transparentIdx : -1;
            for (let i = 0; i < pixels.length; i++) {
                const pi = pixels[i];
                if (pi === transIdx) continue;
                const color = colorTable[pi] || [0, 0, 0];
                const col = i % w;
                const row = interlaced ? deinterlace(Math.floor(i / w), h) : Math.floor(i / w);
                const di = ((top + row) * width + (left + col)) * 4;
                comp[di] = color[0]; comp[di + 1] = color[1]; comp[di + 2] = color[2]; comp[di + 3] = 255;
            }

            frames.push({ width, height, rgba: comp.slice(), delay: gce ? gce.delay : 100 });

            if (disposal === 3 && prev) comp.set(prev);
            gce = null;
        }
    }
    return frames;
}

function deinterlace(logicalRow, height) {
    const passes = [
        { start: 0, step: 8 }, { start: 4, step: 8 },
        { start: 2, step: 4 }, { start: 1, step: 2 },
    ];
    let row = 0;
    for (const pass of passes) {
        const count = Math.ceil((height - pass.start) / pass.step);
        if (logicalRow < row + count) return pass.start + (logicalRow - row) * pass.step;
        row += count;
    }
    return logicalRow;
}

function lzwDecode(minCodeSize, data, pixelCount) {
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;
    let nextCode = eoiCode + 1;
    const table = new Array(4096);
    for (let i = 0; i <= clearCode; i++) table[i] = [i];
    const output = [];
    let bitBuf = 0, bitCount = 0, dataPos = 0, prevCode = -1;

    function readCode() {
        while (bitCount < codeSize) {
            if (dataPos >= data.length) return -1;
            bitBuf |= data[dataPos++] << bitCount;
            bitCount += 8;
        }
        const code = bitBuf & codeMask;
        bitBuf >>= codeSize;
        bitCount -= codeSize;
        return code;
    }

    while (output.length < pixelCount) {
        const code = readCode();
        if (code === -1 || code === eoiCode) break;
        if (code === clearCode) {
            codeSize = minCodeSize + 1;
            codeMask = (1 << codeSize) - 1;
            nextCode = eoiCode + 1;
            prevCode = -1;
            continue;
        }
        let entry;
        if (code < nextCode) entry = table[code];
        else if (code === nextCode && prevCode !== -1) entry = [...table[prevCode], table[prevCode][0]];
        else break;
        for (let i = 0; i < entry.length; i++) output.push(entry[i]);
        if (prevCode !== -1 && nextCode < 4096) {
            table[nextCode++] = [...table[prevCode], entry[0]];
            if (nextCode > codeMask && codeSize < 12) {
                codeSize++;
                codeMask = (1 << codeSize) - 1;
            }
        }
        prevCode = code;
    }
    return output.slice(0, pixelCount);
}

// ============================================================================
// Key map — read the authoritative key→path mappings out of game.js so the
// atlas preserves every key the game code already uses.
// ============================================================================
function buildPathToKey() {
    const src = readFileSync(GAME_JS, 'utf8');
    const pathToKey = new Map(); // normalized 'Assets/..' path -> key

    const add = (key, path) => {
        const norm = path.replace(/\\/g, '/');
        if (pathToKey.has(norm) && pathToKey.get(norm) !== key)
            console.warn(`  ! manifest maps ${norm} to both '${pathToKey.get(norm)}' and '${key}'`);
        pathToKey.set(norm, key);
    };

    // 'key': 'Assets/....png|gif'
    for (const m of src.matchAll(/'([^']+)'\s*:\s*'(Assets\/[^']+\.(?:png|gif))'/g)) add(m[1], m[2]);
    // manifest['key'] = 'Assets/....'
    for (const m of src.matchAll(/manifest\['([^']+)'\]\s*=\s*'(Assets\/[^']+\.(?:png|gif))'/g)) add(m[1], m[2]);

    // Portrait specs: { type, folder, count } -> portrait_<type>_<i>
    for (const m of src.matchAll(/\{\s*type:\s*'([^']+)',\s*folder:\s*'([^']+)',\s*count:\s*(\d+)\s*\}/g)) {
        const [, type, folder, count] = m;
        for (let i = 0; i < +count; i++)
            add(`portrait_${type}_${i}`, `Assets/Portraits/${folder}/${type}_${i}.png`);
    }

    // Achievement icons: flat list -> ach_<id>
    const achBlock = src.match(/const achievementIcons = \[([\s\S]*?)\];/);
    if (achBlock) {
        for (const m of achBlock[1].matchAll(/'([^']+)'/g))
            add(`ach_${m[1]}`, `Assets/Achievements/ach_${m[1]}.png`);
    }

    return pathToKey;
}

function slugKey(relPath) {
    return relPath.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// ============================================================================
// Discovery
// ============================================================================
function walk(dir, acc = []) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (full === OUT_DIR) continue; // never pack our own output
        if (entry.isDirectory()) walk(full, acc);
        else acc.push(full);
    }
    return acc;
}

// ============================================================================
// Shelf bin-packer (next-fit-decreasing-height across multiple pages)
// ============================================================================
function packRects(rects) {
    // Tallest first → tidy shelves.
    rects.sort((a, b) => (b.h - a.h) || (b.w - a.w));
    const pages = []; // { shelves:[{y,h,x}], bottom, maxX }

    const tryPlace = (page, r) => {
        for (const shelf of page.shelves) {
            if (r.h <= shelf.h && shelf.x + r.w + PADDING <= MAX_DIM) {
                r.x = shelf.x; r.y = shelf.y;
                shelf.x += r.w + PADDING;
                page.maxX = Math.max(page.maxX, r.x + r.w);
                return true;
            }
        }
        if (page.bottom + r.h + PADDING <= MAX_DIM && r.w + PADDING <= MAX_DIM) {
            const shelf = { y: page.bottom, h: r.h, x: 0 };
            r.x = 0; r.y = shelf.y;
            shelf.x = r.w + PADDING;
            page.bottom += r.h + PADDING;
            page.shelves.push(shelf);
            page.maxX = Math.max(page.maxX, r.w);
            return true;
        }
        return false;
    };

    for (const r of rects) {
        if (r.w > MAX_DIM || r.h > MAX_DIM)
            throw new Error(`Sprite ${r.key} (${r.w}x${r.h}) exceeds max page dim ${MAX_DIM}`);
        let placed = false;
        for (const page of pages) {
            if (tryPlace(page, r)) { r.page = pages.indexOf(page); placed = true; break; }
        }
        if (!placed) {
            const page = { shelves: [], bottom: 0, maxX: 0 };
            pages.push(page);
            tryPlace(page, r);
            r.page = pages.length - 1;
        }
    }

    // Finalize page dimensions (cropped to used area) and enforce memory budget.
    const pageDims = pages.map(p => ({ w: p.maxX, h: p.bottom }));
    for (let i = 0; i < pageDims.length; i++) {
        const { w, h } = pageDims[i];
        if (w * h * 4 > MEMORY_BUDGET_BYTES)
            throw new Error(`Page ${i} (${w}x${h}) exceeds memory budget`);
    }
    return pageDims;
}

// ============================================================================
// Main
// ============================================================================
function main() {
    console.log('Nova asset packer\n');
    const pathToKey = buildPathToKey();

    const files = walk(ASSETS_DIR).filter(f => /\.(png|gif)$/i.test(f));
    console.log(`Discovered ${files.length} image files under Assets/`);

    const images = {};      // key -> { width, height, rgba }
    const animations = {};  // key -> [ { width, height, rgba, delay } ]
    const usedKeys = new Set();
    const hitboxKeys = new Set(); // keys whose source path is a combat sprite
    const derived = [];

    for (const file of files) {
        const rel = relative(ASSETS_DIR, file).split(sep).join('/');
        const assetPath = `Assets/${rel}`;
        let key = pathToKey.get(assetPath);
        if (!key) { key = slugKey(rel); derived.push(`${assetPath}  ->  ${key}`); }
        if (usedKeys.has(key)) { console.warn(`  ! duplicate key '${key}' (${assetPath}) — skipped`); continue; }
        usedKeys.add(key);
        if (wantsHitbox(assetPath)) hitboxKeys.add(key);

        const buf = readFileSync(file);
        try {
            if (/\.gif$/i.test(file)) animations[key] = decodeGIF(buf);
            else images[key] = decodePNG(buf);
        } catch (e) {
            console.warn(`  ! failed to decode ${assetPath}: ${e.message}`);
            usedKeys.delete(key);
        }
    }

    if (derived.length) {
        console.log(`\n${derived.length} file(s) not in game.js manifest — assigned slug keys:`);
        for (const d of derived) console.log('   ' + d);
    }

    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

    // Ellipse hitboxes for combat sprites (centered on the image; blended fit).
    // Animations are fitted on their first frame — a stable representative shape
    // for collision (the silhouette barely changes frame-to-frame).
    const hitboxes = {};
    for (const key of hitboxKeys) {
        const img = images[key] || (animations[key] && animations[key][0]);
        if (!img) continue;
        const fit = fitHitbox(img.rgba, img.width, img.height, HITBOX_BLEND);
        if (fit.hit.rx > 0 && fit.hit.ry > 0) {
            hitboxes[key] = { rx: +fit.hit.rx.toFixed(2), ry: +fit.hit.ry.toFixed(2) };
        }
    }
    console.log(`\nComputed ${Object.keys(hitboxes).length} ellipse hitboxes (combat sprites).`);

    // Full atlas: every sprite + animation (self-contained).
    writeAtlas('atlas.json', 'atlas', images, animations, hitboxes);

    // Boot atlas: just the title-screen sprites, so the menu loads fast. These
    // keys are also in the full atlas; the small duplication is the cost of a
    // quick first paint.
    const bootImages = {};
    const missing = [];
    for (const key of BOOT_KEYS) {
        if (images[key]) bootImages[key] = images[key];
        else missing.push(key);
    }
    if (missing.length) console.warn(`\n  ! boot keys not found as images (skipped): ${missing.join(', ')}`);
    writeAtlas('atlas_boot.json', 'atlas_boot', bootImages, {});

    console.log('\nDone.');
}

// Pack the given images + animations into pages and write them plus a json
// manifest. Returns nothing; logs a short summary.
function writeAtlas(jsonName, pagePrefix, images, animations, hitboxes = null) {
    // Flat rect list (one rect per image, one per animation frame).
    const rects = [];
    for (const [key, img] of Object.entries(images))
        rects.push({ key, kind: 'image', w: img.width, h: img.height, src: img.rgba });
    for (const [key, frames] of Object.entries(animations))
        frames.forEach((f, i) => rects.push({ key, kind: 'frame', frame: i, w: f.width, h: f.height, src: f.rgba, delay: f.delay }));

    console.log(`\nPacking ${jsonName}: ${rects.length} rects (${Object.keys(images).length} images, ${Object.keys(animations).length} animations)...`);
    const pageDims = packRects(rects);

    // Allocate page buffers and blit every rect in.
    const pageBuffers = pageDims.map(d => new Uint8ClampedArray(d.w * d.h * 4));
    for (const r of rects) {
        const pw = pageDims[r.page].w;
        const dst = pageBuffers[r.page];
        for (let row = 0; row < r.h; row++) {
            const srcStart = row * r.w * 4;
            const dstStart = ((r.y + row) * pw + r.x) * 4;
            dst.set(r.src.subarray(srcStart, srcStart + r.w * 4), dstStart);
        }
    }

    // Write pages.
    const pageFiles = [];
    pageDims.forEach((d, i) => {
        const name = `${pagePrefix}_${i}.png`;
        writeFileSync(join(OUT_DIR, name), encodePNG(d.w, d.h, pageBuffers[i]));
        pageFiles.push({ file: name, w: d.w, h: d.h });
        console.log(`  ${name}: ${d.w}x${d.h}  (${(d.w * d.h * 4 / 1048576).toFixed(1)} MB decoded)`);
    });

    // Build manifest.
    const atlas = { version: 1, prescale: PRESCALE, pages: pageFiles, images: {}, animations: {} };
    if (hitboxes && Object.keys(hitboxes).length) atlas.hitboxes = hitboxes;
    for (const r of rects) {
        if (r.kind === 'image') {
            atlas.images[r.key] = { page: r.page, x: r.x, y: r.y, w: r.w, h: r.h };
        } else {
            (atlas.animations[r.key] ||= { frames: [] }).frames[r.frame] =
                { page: r.page, x: r.x, y: r.y, w: r.w, h: r.h, delay: r.delay };
        }
    }
    writeFileSync(join(OUT_DIR, jsonName), JSON.stringify(atlas));
}

main();
