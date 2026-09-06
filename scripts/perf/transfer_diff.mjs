// Pixel/transfer regression for task 4. Hidden GPU-accelerated Electron window.
// Clear ELECTRON_RUN_AS_NODE; electron scripts/perf/transfer_diff.mjs [reference-rev]
// Reference revision must precede the task-4 renderer changes.
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const rev = process.argv.find((a, i) => i >= 2 && !a.startsWith('-')) || 'HEAD';
const reference = Object.fromEntries(['src/engine/screenFx.js', 'src/world/world.js', 'src/ui/hud.js'].map(p =>
    [p, execFileSync('git', ['show', rev + ':' + p], { cwd: root, encoding: 'utf8' })]));
app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1280, height: 720,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false, partition: 'nova-transfer-diff' } });
    const timeout = setTimeout(() => { console.error('TIMEOUT'); app.exit(1); }, 180000);
    win.webContents.on('console-message', (_e, _level, msg) => console.log(msg));
    await win.loadFile(path.join(here, 'transfer_diff.html'));
    const result = await win.webContents.executeJavaScript('window.runTransferDiff(' + JSON.stringify(reference) + ')');
    console.log('RESULT ' + JSON.stringify({renderer:result.renderer,cases:result.cases,failures:result.failures,maxDelta:result.maxDelta,multiUpload:result.multiUpload}));
    fs.mkdirSync(path.join(root, '.autotest-renderer'), { recursive: true });
    fs.writeFileSync(path.join(root, '.autotest-renderer', 'diff.json'), JSON.stringify({ reference: rev, ...result }, null, 2));
    clearTimeout(timeout);
    app.exit(result.failures === 0 && result.cases > 0 ? 0 : 1);
}).catch(e => { console.error(e); app.exit(1); });
