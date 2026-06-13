// Tiny static file server + perf-log sink for browser performance testing.
//
// Serves the repo over HTTP (so the game's fetch() of atlas.json / assets works
// in a real browser, which file:// blocks) and accepts POST /perflog, printing
// each body to stdout. The in-page stress harness (scripts/perf/harness.js)
// POSTs its per-section profiler readouts here, so driving a headless browser
// at /scripts/perf/stress.html streams real browser numbers to this console.
//
// Node built-ins only. Usage: node scripts/perf/server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = parseInt(process.argv[2] || '8123', 10);

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.json': 'application/json', '.css': 'text/css', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/perflog') {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            process.stdout.write('[perf] ' + body + '\n');
            res.writeHead(204).end();
        });
        return;
    }

    // Static file serving, constrained to ROOT.
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404).end('not found: ' + urlPath); return; }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[perfserver] serving ${ROOT} at http://127.0.0.1:${PORT}`);
    console.log(`[perfserver] stress page: http://127.0.0.1:${PORT}/scripts/perf/stress.html`);
});
