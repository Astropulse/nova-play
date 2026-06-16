// ============================================================================
// png.mjs — zero-dependency PNG decode/encode (8-bit).
// ----------------------------------------------------------------------------
// Extracted so the asset packer, the hitbox fitter, and test scripts can all
// share one canvas-free PNG codec (Node `zlib` only). Decode handles color
// types 0/2/3/4/6, all scanline filters, non-interlaced. Encode writes 8-bit
// RGBA, filter 0, single IDAT — enough for atlas pages and debug overlays.
// ============================================================================
import { deflateSync, inflateSync } from 'node:zlib';

export function decodePNG(buf) {
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
    const bpp = channels;
    const stride = width * bpp;
    const pixels = Buffer.alloc(height * stride);

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

    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const s = i * bpp, d = i * 4;
        if (colorType === 6) {
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = pixels[s + 3];
        } else if (colorType === 2) {
            rgba[d] = pixels[s]; rgba[d + 1] = pixels[s + 1]; rgba[d + 2] = pixels[s + 2]; rgba[d + 3] = 255;
        } else if (colorType === 0) {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = 255;
        } else if (colorType === 4) {
            rgba[d] = rgba[d + 1] = rgba[d + 2] = pixels[s]; rgba[d + 3] = pixels[s + 1];
        } else if (colorType === 3) {
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

export function encodePNG(width, height, rgba) {
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
