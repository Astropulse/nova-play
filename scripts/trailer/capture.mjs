// Frame capture for the NOVA trailer (scripts/trailer/).
//
// Drives scripts/trailer/trailer.html — the real game stepped on a virtual
// clock by director.js — and screenshots every RECORDED frame at 1920x1080/30.
// Preroll frames (boss warm-ups, cinematic lead-ins) are stepped without
// screenshots, so they cost sim time only. The scene → frame mapping is written
// to frames/timeline.json for the narration/audio sync doc.
//
//   node scripts/trailer/capture.mjs                 full render → frames/
//   node scripts/trailer/capture.mjs --fresh         ignore the scene cache
//   node scripts/trailer/capture.mjs --from bones    re-render bones and everything after
//   node scripts/trailer/capture.mjs spot drift:2 dragon:8 …
//       → one PNG per scene:localTime (seconds into the scene, preroll
//         included) into spot/ — steps the whole timeline, screenshots only
//         at the asked moments. ALWAYS spot-check every scene before a full
//         render (ads-pipeline rule).
//
// THE SCENE CACHE. Drawing + screenshotting is what costs (SwiftShader):
// simulating alone runs ~20x faster. Every scene's frames are kept under
// cache/<scene>-<key>/, where <key> hashes the scene's own definition (setup,
// tick, beats, record, index — see director.js sceneKey). On the next run a
// scene whose key is unchanged is only simulated (draw off) and its frames are
// copied from the cache; only changed scenes (and anything after a changed
// timing, via index) render. Spot mode gates draw the same way: scenes with
// no requested spot are simulated only. Caveat: sim state flows forward, so a
// changed scene can in principle nudge the RNG of a later cached scene;
// `--fresh` (or `--from`) is the honest render when it matters.
//
// Requires the static server: node scripts/perf/server.mjs 8123
// Uses the playwright-core install from the ads pipeline (no npm install here).
import { mkdirSync, readdirSync, writeFileSync, existsSync, copyFileSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import('playwright-core')); }
catch {
    // No node_modules in this repo — use the ads pipeline's copy.
    const adsPw = 'D:/Art/Astropulse/RetroDiffusion/Ads pipeline/showcase-ad/node_modules/playwright-core/index.mjs';
    ({ chromium } = await import('file:///' + adsPw));
}

const SERVER = process.env.TRAILER_URL || 'http://127.0.0.1:8123';
const argv = process.argv.slice(2);
const fresh = argv.includes('--fresh');
const fromIdx = argv.indexOf('--from');
const fromScene = fromIdx >= 0 ? argv[fromIdx + 1] : null;
const args = argv.filter((a, i) => !a.startsWith('--') && !(fromIdx >= 0 && i === fromIdx + 1));
const spotMode = args[0] === 'spot';
const spots = spotMode ? args.slice(1).map(s => { const [n, t] = s.split(':'); return { scene: n, t: parseFloat(t || '0') }; }) : [];

const outDir = join(here, spotMode ? 'spot' : 'frames');
const cacheRoot = join(here, 'cache');
mkdirSync(outDir, { recursive: true });
mkdirSync(cacheRoot, { recursive: true });

const pwCache = join(process.env.LOCALAPPDATA, 'ms-playwright');
const shellDir = readdirSync(pwCache).filter(d => d.startsWith('chromium_headless_shell-')).sort().pop();
const exe = join(pwCache, shellDir, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');

const browser = await chromium.launch({
    executablePath: exe,
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('console', m => { const t = m.text(); if (t.startsWith('TRAILER') || t.startsWith('AUTOTEST')) console.log('[page]', t.slice(0, 220)); });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

await page.goto(SERVER + '/scripts/trailer/trailer.html');
await page.waitForFunction(() => window.TRAILER && window.TRAILER.ready, null, { timeout: 120000 });
const scenes = await page.evaluate(() => window.TRAILER.scenes);
const keys = await page.evaluate(() => window.TRAILER.sceneKeys || []);
console.log('scenes:', scenes.map(s => `${s.name}(${s.preroll}+${s.record})`).join(' '));

// Expected recorded frames per scene — the director cuts on the planned
// cumulative record time (recFrames/30 >= cumEnd - 1e-6).
const FPS = 30;
const expected = [];
{ let cum = 0, prev = 0; for (const s of scenes) { cum += s.record; const n = Math.ceil((cum - 1e-6) * FPS); expected.push(n - prev); prev = n; } }

const t0 = Date.now();
let outFrame = 0;
const timeline = [];   // { scene, firstFrame, lastFrame, firstT, lastT }
let drawOn = true;
const setDraw = async (on) => { if (on !== drawOn) { drawOn = on; await page.evaluate(o => window.TRAILER.setDraw(o), on); } };

if (spotMode) {
    // Step everything; draw only inside scenes that have a spot; screenshot
    // only at the requested moments.
    const want = spots.map(sp => ({ ...sp, done: false }));
    const wantScenes = new Set(want.map(w => w.scene));
    let curScene = null;
    for (;;) {
        const st = await page.evaluate(() => window.TRAILER.step());
        if (!st || st.done) break;
        if (st.scene !== curScene) { curScene = st.scene; await setDraw(wantScenes.has(curScene)); }
        for (const w of want) {
            if (!w.done && st.scene === w.scene && st.t >= w.t) {
                w.done = true;
                const p = join(outDir, `${w.scene}_t${w.t.toFixed(1).replace('.', '_')}.png`);
                await page.screenshot({ path: p });
                console.log('spot', w.scene, w.t.toFixed(1), `(${((Date.now() - t0) / 1000).toFixed(0)}s)`);
            }
        }
        if (want.every(w => w.done)) break;
    }
    const missed = want.filter(w => !w.done).map(w => w.scene + ':' + w.t);
    if (missed.length) console.log('MISSED (scene never reached that time):', missed.join(' '));
} else {
    // Cache plan: which scenes can be copied.
    const fromI = fromScene ? scenes.findIndex(s => s.name === fromScene) : -1;
    if (fromScene && fromI < 0) console.log('--from: no scene named', fromScene, '(rendering everything)');
    const cacheDir = (i) => join(cacheRoot, `${scenes[i].name}-${(keys[i] || 'nokey').slice(0, 8)}`);
    const cached = scenes.map((s, i) => {
        if (fresh || (fromI >= 0 && i >= fromI) || !keys[i]) return false;
        const d = cacheDir(i);
        try {
            const meta = JSON.parse(readFileSync(join(d, 'done.json'), 'utf8'));
            if (meta.frames !== expected[i]) return false;
            for (let k = 0; k < expected[i]; k++) if (!existsSync(join(d, `f${String(k).padStart(5, '0')}.png`))) return false;
            return true;
        } catch { return false; }
    });
    // Prune stale cache dirs (other keys for the same scene names).
    const keep = new Set(scenes.map((s, i) => `${s.name}-${(keys[i] || 'nokey').slice(0, 8)}`));
    for (const d of readdirSync(cacheRoot)) if (!keep.has(d)) { try { rmSync(join(cacheRoot, d), { recursive: true, force: true }); } catch {} }
    console.log('cache:', scenes.map((s, i) => (cached[i] ? '=' : '*') + s.name).join(' '), `(${cached.filter(Boolean).length}/${scenes.length} cached)`);

    let curIdx = -1, localK = 0;
    for (;;) {
        const st = await page.evaluate(() => window.TRAILER.step());
        if (!st) break;
        if (st.done) break;
        if (st.sceneIdx !== curIdx) {
            curIdx = st.sceneIdx; localK = 0;
            await setDraw(!cached[curIdx]);
            if (!cached[curIdx]) mkdirSync(cacheDir(curIdx), { recursive: true });
        }
        if (st.recording) {
            const dst = join(outDir, `f${String(outFrame).padStart(5, '0')}.png`);
            const cf = join(cacheDir(curIdx), `f${String(localK).padStart(5, '0')}.png`);
            if (cached[curIdx]) copyFileSync(cf, dst);
            else { await page.screenshot({ path: dst }); try { copyFileSync(dst, cf); } catch {} }
            const cur = timeline[timeline.length - 1];
            if (!cur || cur.scene !== st.scene) {
                timeline.push({ scene: st.scene, firstFrame: outFrame, lastFrame: outFrame, firstT: +(outFrame / 30).toFixed(2) });
            } else cur.lastFrame = outFrame;
            outFrame++; localK++;
            if (outFrame % 150 === 0) console.log(`${outFrame} frames · ${st.scene}${cached[curIdx] ? ' (cached)' : ''} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        }
    }
    // Mark freshly rendered scenes complete.
    for (const t of timeline) {
        const i = scenes.findIndex(s => s.name === t.scene);
        const n = t.lastFrame - t.firstFrame + 1;
        if (i >= 0 && !cached[i]) writeFileSync(join(cacheDir(i), 'done.json'), JSON.stringify({ frames: n, key: keys[i], when: new Date().toISOString() }));
        t.lastT = +((t.lastFrame + 1) / 30).toFixed(2); t.firstT = +(t.firstFrame / 30).toFixed(2);
    }
    writeFileSync(join(outDir, 'timeline.json'), JSON.stringify({ fps: 30, frames: outFrame, scenes: timeline }, null, 2));
    const sfxLog = await page.evaluate(() => window.TRAILER.sfxLog || []);
    writeFileSync(join(outDir, 'sfxlog.json'), JSON.stringify(sfxLog));
    console.log('sfx events logged:', sfxLog.length);
    console.log(`done: ${outFrame} frames (${(outFrame / 30).toFixed(1)}s) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    console.log('timeline:', timeline.map(t => `${t.scene}@${t.firstT}s`).join(' '));
}
await browser.close();
