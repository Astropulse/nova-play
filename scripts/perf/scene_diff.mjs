// GPU foreground layer (spriteBatch.js) vs Canvas 2D — tolerance pixel diff
// + microbench in a hidden GPU-accelerated Electron window (scene_diff.html).
// Writes .autotest-renderer/scene_diff.json and scene_<case>_{canvas,gpu,diff}.png.
// Clear ELECTRON_RUN_AS_NODE first; npx electron scripts/perf/scene_diff.mjs
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1300, height: 760,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'nova-scene-diff' } });
    const timeout = setTimeout(() => { console.error('TIMEOUT'); app.exit(1); }, 180000);
    win.webContents.on('console-message', (_e, _level, msg) => console.log(msg));
    await win.loadFile(path.join(here, 'scene_diff.html'));
    const result = await win.webContents.executeJavaScript('window.runSceneDiff()');
    const out = path.join(root, '.autotest-renderer');
    fs.mkdirSync(out, { recursive: true });
    for (const [label, dataUrl] of Object.entries(result.images)) {
        const file = 'scene_' + label.replace(/[^a-z0-9]+/gi, '_') + '.png';
        fs.writeFileSync(path.join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
    delete result.images;
    fs.writeFileSync(path.join(out, 'scene_diff.json'), JSON.stringify(result, null, 2));
    // Near-identical gate: no more than 0.5% of lit pixels differ by > 24
    // levels in any case, and the mean per-pixel delta stays under 1 level.
    const worst = result.results.reduce((w, r) => Math.max(w, r.over24Pct), 0);
    const mean = result.results.reduce((w, r) => Math.max(w, r.meanDelta), 0);
    console.log('RESULT ' + JSON.stringify({ cases: result.results.length, worstOver24Pct: worst, worstMeanDelta: mean, bench: result.bench }));
    clearTimeout(timeout);
    app.exit(worst <= 0.5 && mean < 1 ? 0 : 1);
}).catch(e => { console.error(e); app.exit(1); });
