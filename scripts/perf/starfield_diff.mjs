// Starfield differential harness — Electron main script.
//
// Renders the seeded WebGL starfield through the working-tree world.js AND a
// reference world.js extracted from git (default: HEAD), for a matrix of
// cameras / boosts / world scales / star culls / split-screen / black-hole
// seeds, and pixel-compares them in a hidden window (starfield_diff.html).
// Exit code 0 = every case byte-identical.
//
// Run (PowerShell; clear the VSCode-injected var first or Electron boots as Node):
//   Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
//   npx electron scripts/perf/starfield_diff.mjs [git-rev]
import { app, BrowserWindow } from 'electron';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const rev = process.argv.find((a, i) => i >= 2 && !a.startsWith('-')) || 'HEAD';
const refPath = path.join(root, 'src', 'world', '.world_ref.tmp.js');

// Reference implementation lives next to world.js so its relative imports resolve.
fs.writeFileSync(refPath, execFileSync('git', ['show', `${rev}:src/world/world.js`], { cwd: root }));
const cleanup = () => { try { fs.unlinkSync(refPath); } catch { /* already gone */ } };

app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.whenReady().then(() => {
    const win = new BrowserWindow({
        show: false, width: 1300, height: 760,
        webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });
    let failed = 1;
    win.webContents.on('console-message', (_e, _level, msg) => {
        console.log(msg);
        const m = /^DONE cases=(\d+) failures=(\d+)/.exec(msg);
        if (m) {
            failed = Number(m[2]) > 0 || Number(m[1]) === 0 ? 1 : 0;
            cleanup();
            app.exit(failed);
        }
    });
    win.loadFile(path.join(here, 'starfield_diff.html'));
    setTimeout(() => { console.log('TIMEOUT'); cleanup(); app.exit(1); }, 180000);
});
app.on('will-quit', cleanup);
