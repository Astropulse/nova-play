// Connect to a running Chrome (launched with --remote-debugging-port=9222) and
// throttle the renderer's CPU via the DevTools Protocol so the perf benchmark
// runs as if on weak hardware — which is where the real CPU-bound render-budget
// drains become visible. Node 22 globals (fetch, WebSocket) only.
//
// Usage: node scripts/perf/throttle.mjs [rate] [seconds]
const PORT = 9222;
const RATE = parseFloat(process.argv[2] || '6');
const SECONDS = parseInt(process.argv[3] || '80', 10);

async function findPage() {
    for (let i = 0; i < 40; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/json`);
            const targets = await r.json();
            const page = targets.find(t => t.type === 'page' && /stress\.html/.test(t.url))
                || targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page && page.webSocketDebuggerUrl) return page;
        } catch (e) { /* chrome not up yet */ }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

const page = await findPage();
if (!page) { console.log('[throttle] no page target found'); process.exit(1); }
console.log('[throttle] target:', page.url);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
ws.addEventListener('open', () => {
    send('Emulation.setCPUThrottlingRate', { rate: RATE });
    console.log(`[throttle] CPU throttling x${RATE} applied`);
});
ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id === 1) console.log('[throttle] ack', JSON.stringify(m.result || m.error || {}));
});
ws.addEventListener('error', (e) => console.log('[throttle] ws error', e.message || e));

// Hold the connection so the throttle stays applied for the whole run.
setTimeout(() => { try { ws.close(); } catch (e) {} console.log('[throttle] done'); process.exit(0); }, SECONDS * 1000);
