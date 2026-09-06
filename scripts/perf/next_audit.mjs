// Source/data probe for PERFORMANCE_AUDIT_2.md. No browser timings or allocations.
// node --no-warnings --loader ./.autotest/hooks.mjs scripts/perf/next_audit.mjs
import fs from 'node:fs';
import { AssetLoader } from '../../src/engine/assetLoader.js';
import { effectBounds, unionRect } from '../../src/engine/screenFxBounds.js';
import { computeSplitLayout } from '../../src/world/splitScreen.js';
const atlas = JSON.parse(fs.readFileSync(new URL('../../Assets/atlas/atlas.json', import.meta.url)));
const mib = 1048576;
const animations = Object.entries(atlas.animations).map(([key, a]) => ({ key, frames: a.frames.length,
    rgbaMiB: a.frames.reduce((s, f) => s + f.w * f.h * 4 * (atlas.prescale || 4) ** 2, 0) / mib
})).sort((a, b) => b.rgbaMiB - a.rgbaMiB);
console.log('ATLAS', JSON.stringify({ sourceRGBA_MiB: atlas.pages.reduce((s, p) => s + p.w * p.h * 4, 0) / mib,
    allAnimationRGBA_MiB: animations.reduce((s, a) => s + a.rgbaMiB, 0), largest: animations.slice(0, 7) }));
// Stub raster allocation only; execute the real loader's scheduling/accounting.
globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }) }) };
const loader = new AssetLoader();
loader.atlasAnims = Object.fromEntries(['seraph_idle_closed', 'seraph_idle_opened'].map(key =>
    [key, { frames: atlas.animations[key].frames.map(f => ({ ...f, img: {} })) }]));
const a = loader.get('seraph_idle_closed');
void a[0].canvas;
const afterRead = loader._animBytes / mib;
for (let i = 1; i <= 8; i++) loader.tick(i * 16);
console.log('PREFETCH', JSON.stringify({ afterOneReadMiB: afterRead, afterEightTicksMiB: loader._animBytes / mib,
    materializedFrames: a.filter(f => f._canvas).length }));
loader.animBudgetBytes = 96 * mib;
const b = loader.get('seraph_idle_opened');
for (let i = 9; i <= 640; i++) { void a[0].canvas; void b[0].canvas; loader.tick(i * 16); }
console.log('ACTIVE_BUDGET', JSON.stringify({ budgetMiB: 96, accountedMiB: loader._animBytes / mib }));
for (const n of [2, 4, 8]) {
    const panes = computeSplitLayout(n, 2560, 1440);
    const rects = panes.map(p => effectBounds({ ripple: { cx: p.x + p.w / 2, cy: p.y + p.h / 2, r: 70, strength: 1 } }, p, 2560, 1440).source);
    const union = rects.reduce(unionRect, null);
    const separate = rects.reduce((s, r) => s + r.w * r.h, 0);
    console.log('SPARSE_UPLOAD', JSON.stringify({ panes: n, unionPixels: union.w * union.h,
        separatePixels: separate, pixelReductionFactor: union.w * union.h / separate }));
}
