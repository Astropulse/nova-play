// ============================================================================
// test_hitbox_fit.mjs — visual + numeric test of the ellipse hitbox fitter.
// ----------------------------------------------------------------------------
// Runs scripts/lib/fit_hitbox.mjs on a handful of sprites (a regular enemy, a
// couple of specials, and bosses), prints the fitted radii, and writes a
// debug overlay PNG per sprite to scripts/hitbox_preview/ so the fit can be
// eyeballed:  yellow = current circle,  red = OUTER ellipse,
//             green = INNER ellipse,    cyan = blended hitbox,  + center cross.
//
// Usage:  node scripts/test_hitbox_fit.mjs
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './lib/png.mjs';
import { fitHitbox } from './lib/fit_hitbox.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT_DIR = join(__dirname, 'hitbox_preview');

const SAMPLES = [
    { label: 'regular',  path: 'Assets/Ships/Enemy/enemy_ship_0.png' },
    { label: 'regular',  path: 'Assets/Ships/Enemy/enemy_ship_2.png' },
    { label: 'special',  path: 'Assets/Ships/Enemy/Special/scavenger_0.png' },
    { label: 'special',  path: 'Assets/Ships/Enemy/Special/missile_0.png' },
    { label: 'special',  path: 'Assets/Ships/Enemy/Special/blink_0.png' },
    { label: 'boss',     path: 'Assets/Ships/Bosses/Starcore/starcore.png' },
    { label: 'boss',     path: 'Assets/Ships/Bosses/Asteroid_Crusher/asteroid_crusher.png' },
];

const BG = [32, 34, 40, 255];

// --- tiny software renderer for the overlay -------------------------------
function makeCanvas(w, h) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) { px[i*4]=BG[0]; px[i*4+1]=BG[1]; px[i*4+2]=BG[2]; px[i*4+3]=BG[3]; }
    return { w, h, px };
}
function blend(cv, x, y, col, alpha = 1) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= cv.w || y >= cv.h) return;
    const i = (y * cv.w + x) * 4;
    const a = alpha * (col[3] ?? 255) / 255;
    cv.px[i]   = cv.px[i]   * (1 - a) + col[0] * a;
    cv.px[i+1] = cv.px[i+1] * (1 - a) + col[1] * a;
    cv.px[i+2] = cv.px[i+2] * (1 - a) + col[2] * a;
    cv.px[i+3] = 255;
}
// Nearest-neighbor blit of a source sprite scaled by `s` into the canvas.
function blitSprite(cv, src, s) {
    for (let y = 0; y < cv.h; y++) {
        for (let x = 0; x < cv.w; x++) {
            const sx = Math.floor(x / s), sy = Math.floor(y / s);
            if (sx < 0 || sy < 0 || sx >= src.width || sy >= src.height) continue;
            const si = (sy * src.width + sx) * 4;
            const a = src.rgba[si + 3];
            if (a < 8) continue;
            blend(cv, x, y, [src.rgba[si], src.rgba[si+1], src.rgba[si+2], a]);
        }
    }
}
// Draw an axis-aligned ellipse outline (in source px) scaled into the canvas.
function drawEllipse(cv, cx, cy, rx, ry, s, col) {
    if (rx <= 0 || ry <= 0) return;
    const steps = Math.max(64, Math.ceil((rx + ry) * s * 0.5));
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2;
        const x = (cx + Math.cos(t) * rx) * s;
        const y = (cy + Math.sin(t) * ry) * s;
        // 2px-ish nib so the line reads at scale
        blend(cv, x, y, col); blend(cv, x + 1, y, col); blend(cv, x, y + 1, col);
    }
}
function drawCross(cv, cx, cy, s, col) {
    const x = cx * s, y = cy * s;
    for (let d = -4; d <= 4; d++) { blend(cv, x + d, y, col); blend(cv, x, y + d, col); }
}

function run() {
    if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
    console.log('Ellipse hitbox fit — test\n');
    console.log('  sprite                               WxH      circle   inner(rx,ry)   outer(rx,ry)   hit(rx,ry)');
    console.log('  ' + '-'.repeat(100));

    for (const { label, path } of SAMPLES) {
        const src = decodePNG(readFileSync(join(ROOT, path)));
        const fit = fitHitbox(src.rgba, src.width, src.height, 0.5);
        const f = (n) => n.toFixed(1).padStart(5);
        const name = basename(path).padEnd(28);
        console.log(`  [${label}] ${name} ${String(src.width)}x${src.height}` +
            `   ${f(fit.circle)}   ${f(fit.inner.rx)},${f(fit.inner.ry)}` +
            `   ${f(fit.outer.rx)},${f(fit.outer.ry)}   ${f(fit.hit.rx)},${f(fit.hit.ry)}`);

        // Render overlay (cap output near ~700px on the long side).
        const s = Math.max(2, Math.floor(700 / Math.max(src.width, src.height)));
        const cv = makeCanvas(src.width * s, src.height * s);
        blitSprite(cv, src, s);
        drawEllipse(cv, fit.cx, fit.cy, fit.circle, fit.circle, s, [255, 220, 40, 255]); // yellow circle
        drawEllipse(cv, fit.cx, fit.cy, fit.outer.rx, fit.outer.ry, s, [255, 70, 70, 255]); // red outer
        drawEllipse(cv, fit.cx, fit.cy, fit.inner.rx, fit.inner.ry, s, [70, 230, 90, 255]); // green inner
        drawEllipse(cv, fit.cx, fit.cy, fit.hit.rx, fit.hit.ry, s, [80, 210, 255, 255]);    // cyan hit
        drawCross(cv, fit.cx, fit.cy, s, [255, 255, 255, 255]);

        const out = join(OUT_DIR, basename(path).replace(/\.png$/i, '_hitbox.png'));
        writeFileSync(out, encodePNG(cv.w, cv.h, cv.px));
    }
    console.log('\n  legend:  yellow=current circle   red=outer   green=inner   cyan=blended hit');
    console.log(`  overlays written to scripts/hitbox_preview/`);
}

run();
