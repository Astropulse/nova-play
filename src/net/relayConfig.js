// Relay configuration — the one constant that ships in the public web build.
//
// ── ONE-TIME SETUP ───────────────────────────────────────────────────────────
// After the relay's first deploy (push anything under relay/, or run
// `npx wrangler deploy` in relay/), Cloudflare prints its URL — something like
//   https://nova-relay.<your-account>.workers.dev
// Paste it below. That's it: every future relay change redeploys on push and
// nothing here needs to change again.
//
// Leave RELAY_URL empty to disable relay play (the desktop LAN/direct modes
// keep working without it).

export const RELAY_URL = 'https://nova-relay.astropulse.workers.dev';

// Must match the RELAY_KEY secret on the worker IF you set one
// (`npx wrangler secret put RELAY_KEY` in relay/). Empty = no key required.
export const RELAY_KEY = '';

// Resolved at call time so tests (and power users) can override per session
// via `window.NOVA_RELAY_URL` without touching the deployed file.
export function getRelayUrl() {
    if (typeof window !== 'undefined' && window.NOVA_RELAY_URL) {
        return String(window.NOVA_RELAY_URL).replace(/\/+$/, '');
    }
    return (RELAY_URL || '').replace(/\/+$/, '');
}

export function getRelayKey() {
    if (typeof window !== 'undefined' && window.NOVA_RELAY_KEY != null) {
        return String(window.NOVA_RELAY_KEY);
    }
    return RELAY_KEY || '';
}

export function relayAvailable() {
    return !!getRelayUrl();
}

// Relay room codes are 8 base32 chars (shown as XXXX-XXXX) — visually distinct
// from the 10-char LAN/direct ip codes (XXXXX-XXXXX).
export function looksLikeRelayCode(input) {
    if (!input) return false;
    const cleaned = String(input).trim().toUpperCase().replace(/[\s-]/g, '')
        .replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-Z]{8}$/.test(cleaned);
}

export function normalizeRelayCode(input) {
    return String(input).trim().toUpperCase().replace(/[\s-]/g, '')
        .replace(/O/g, '0').replace(/[IL]/g, '1');
}

export function formatRelayCode(code) {
    const c = normalizeRelayCode(code);
    return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}
