// `npm run juice [beat]` — launch Electron straight into a solo run and play
// the scripted juice-effects preview tour (src/ui/juicePreview.js). The
// window quits on its own after the tour. Optional first arg = starting beat.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('electron');
const beat = parseInt(process.argv[2] || '1', 10) || 1;

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // VSCode shells export this; it breaks Electron
env.NOVA_AUTOTEST = 'solo';
env.NOVA_AUTOTEST_JUICE = '2500';
env.NOVA_AUTOTEST_JUICE_BEAT = String(beat);
env.NOVA_AUTOTEST_QUIT = '600000';

spawn(electron, ['.'], { stdio: 'inherit', env });
