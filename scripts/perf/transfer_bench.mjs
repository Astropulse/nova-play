// Hidden Electron transfer benchmark. Isolated, nonpersistent game session.
// Clear ELECTRON_RUN_AS_NODE; electron scripts/perf/transfer_bench.mjs
// NOVA_TRANSFER_TRACE=1 additionally captures a (large) Chromium GPU/raster trace.
import { app, BrowserWindow, contentTracing } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const output = path.resolve(here, '../../.autotest-renderer');
const traceEnabled = process.env.NOVA_TRANSFER_TRACE === '1';
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
if (process.env.NOVA_TRANSFER_SOFTWARE === '1') app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.whenReady().then(async () => {
    fs.mkdirSync(output, { recursive: true });
    const win = new BrowserWindow({ show: false, width: 1280, height: 720,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'nova-transfer-bench' } });
    win.webContents.on('console-message', (_e, _level, msg) => console.log(msg));
    if (traceEnabled) await contentTracing.startRecording({
        included_categories: ['gpu', 'viz', 'blink', 'blink.user_timing', 'cc', 'disabled-by-default-gpu.service'],
    });
    const timeout = setTimeout(() => { console.error('TIMEOUT'); app.exit(1); }, 120000);
    await win.loadFile(path.join(here, 'transfer_bench.html'));
    const result = await win.webContents.executeJavaScript('window.runTransferBench()');
    console.log('RESULT renderer=' + result.renderer + ' cases=' + result.rows.length);
    fs.writeFileSync(path.join(output, 'bench.json'), JSON.stringify(result, null, 2));
    if (traceEnabled) {
        const trace = await contentTracing.stopRecording(path.join(output, 'trace.json'));
        console.log('TRACE ' + trace);
    }
    clearTimeout(timeout);
    app.exit(0);
}).catch(e => { console.error(e); app.exit(1); });
