// `npm run cine kv` / `npm run cine dragon` — launch Electron straight into a
// solo run and play one of the game's big cinematics for real, through the
// existing autotest hooks in main.js:
//   kv      → NOVA_AUTOTEST_KV: the Yellow One's death / King's Victory
//             (forced death screen, fade, the full ceremony) — ~35 s.
//   dragon  → NOVA_AUTOTEST_DRAGON: the Dragon's arrival cinematic, the
//             fight (a head shatters + reforms), then every head shattered
//             for the victory — ~60 s.
// The window quits on its own afterwards.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const which = (process.argv[2] || 'kv').toLowerCase();

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // VSCode shells export this; it breaks Electron
env.NOVA_AUTOTEST = 'solo';
if (which.startsWith('d')) {
    env.NOVA_AUTOTEST_DRAGON = '3000';
    env.NOVA_AUTOTEST_QUIT = '62000';
} else {
    env.NOVA_AUTOTEST_KV = '3000';
    env.NOVA_AUTOTEST_QUIT = '42000';
}
spawn(electron, ['.'], { stdio: 'inherit', env });
