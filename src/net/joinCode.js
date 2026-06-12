// Join codes — a friendlier way to share "ip:port".
//
// Format: 6 bytes (IPv4 + uint16 port) → Crockford base32 → 10 chars shown as
// XXXXX-XXXXX. Decoding accepts the dash-less form, lowercase, the easily
// confused glyphs (O→0, I/L→1), and raw "ip:port" strings as a fallback.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

export function encodeJoinCode(ip, port) {
    const parts = String(ip).split('.').map(n => parseInt(n, 10));
    if (parts.length !== 4 || parts.some(n => isNaN(n) || n < 0 || n > 255)) return null;
    const p = port | 0;
    if (p <= 0 || p > 65535) return null;

    // 48-bit value: ip4 bytes then port. Use BigInt-free math (48 bits > 32).
    let hi = (parts[0] << 8) | parts[1];          // 16 bits
    let lo = ((parts[2] << 24) >>> 0) + ((parts[3] << 16) >>> 0) + p; // 32 bits

    // Emit 10 base32 chars from the 48-bit (hi:16, lo:32) value, LSB first.
    const chars = [];
    for (let i = 0; i < 10; i++) {
        const digit = lo % 32;
        chars.push(ALPHABET[digit]);
        // 48-bit right shift by 5: lo gets the low 5 bits of hi shifted in.
        lo = Math.floor(lo / 32) + (hi % 32) * Math.pow(2, 27);
        hi = Math.floor(hi / 32);
    }
    const code = chars.reverse().join('');
    return `${code.slice(0, 5)}-${code.slice(5)}`;
}

export function decodeJoinCode(input) {
    if (!input) return null;
    const raw = String(input).trim();

    // Raw ip:port fallback ("192.168.1.5:27777")
    const m = raw.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})$/);
    if (m) {
        const port = parseInt(m[2], 10);
        if (port > 0 && port <= 65535) return { ip: m[1], port };
        return null;
    }

    // Normalize: strip separators, uppercase, fix confusable glyphs.
    const cleaned = raw.toUpperCase().replace(/[\s-]/g, '')
        .replace(/O/g, '0').replace(/[IL]/g, '1');
    if (cleaned.length !== 10) return null;

    let hi = 0, lo = 0; // 48-bit accumulator (hi:16, lo:32)
    for (const ch of cleaned) {
        const digit = ALPHABET.indexOf(ch);
        if (digit < 0) return null;
        // 48-bit left shift by 5, then add digit.
        hi = (hi * 32 + Math.floor(lo / Math.pow(2, 27))) % Math.pow(2, 16);
        lo = (lo % Math.pow(2, 27)) * 32 + digit;
    }

    const b0 = Math.floor(hi / 256) & 0xff;
    const b1 = hi & 0xff;
    const b2 = Math.floor(lo / Math.pow(2, 24)) & 0xff;
    const b3 = Math.floor(lo / Math.pow(2, 16)) & 0xff;
    const port = lo % 65536;
    if (port <= 0) return null;
    return { ip: `${b0}.${b1}.${b2}.${b3}`, port };
}
