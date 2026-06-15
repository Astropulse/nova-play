// Orchestrates the live two-instance client auto-reconnect test:
//   1. spawn an Electron HOST bot, read its relay code,
//   2. spawn an Electron JOIN bot with NOVA_AUTOTEST_CLIENTBLIP set,
//   3. watch the join bot for the AUTOTEST CLIENTBLIP PASS/FAIL line,
//   4. tear both down and exit non-zero on failure/timeout.
//
// Run from the repo root:  node .autotest/clientblip_run.mjs
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const BLIP_MS = 2500;     // sever the join socket 2.5s after it confirms it's in-run
const QUIT_MS = 40000;    // each instance self-quits as a backstop
const OVERALL_TIMEOUT = 55000;

function launch(label, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE; // memory: must be cleared or Electron runs as plain node
  const child = spawn('npx', ['electron', '.'], { cwd: ROOT, env, shell: true });
  const onLine = [];
  const pump = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      console.log(`[${label}] ${line}`);
      onLine.forEach(fn => fn(line));
    }
  };
  child.stdout.on('data', pump);
  child.stderr.on('data', pump);
  return { child, addLine: (fn) => onLine.push(fn) };
}

const waitForLine = (proc, re, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('timeout waiting for ' + re)), ms);
  proc.addLine((line) => { const m = line.match(re); if (m) { clearTimeout(t); res(m); } });
});

let host, join, verdict = null;
const cleanup = () => { try { host?.child.kill(); } catch {} try { join?.child.kill(); } catch {} };
const overall = setTimeout(() => { console.log('RESULT: FAIL (overall timeout)'); cleanup(); process.exit(1); }, OVERALL_TIMEOUT);

try {
  console.log('# launching HOST bot…');
  host = launch('host', { NOVA_AUTOTEST: 'host', NOVA_AUTOTEST_QUIT: String(QUIT_MS) });
  const codeMatch = await waitForLine(host, /AUTOTEST RELAYCODE (\S+)/, 25000);
  const code = codeMatch[1];
  console.log('# host relay code: ' + code + ' — launching JOIN bot…');

  join = launch('join', {
    NOVA_AUTOTEST: 'join:' + code,
    NOVA_AUTOTEST_CLIENTBLIP: String(BLIP_MS),
    NOVA_AUTOTEST_QUIT: String(QUIT_MS),
  });

  const result = await waitForLine(join, /AUTOTEST CLIENTBLIP (PASS|FAIL)(.*)/, 45000);
  verdict = result[1];
  console.log('\nRESULT: ' + verdict + (result[2] || ''));
} catch (e) {
  console.log('\nRESULT: FAIL (' + e.message + ')');
} finally {
  clearTimeout(overall);
  cleanup();
  setTimeout(() => process.exit(verdict === 'PASS' ? 0 : 1), 500);
}
