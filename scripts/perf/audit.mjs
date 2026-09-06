// Read-only operation counts and RGBA pixel budgets; this does not measure GPU time.
// Run: node --no-warnings --loader ./.autotest/hooks.mjs scripts/perf/audit.mjs
import fs from 'node:fs';
import { World } from '../../src/world/world.js';

const atlas = JSON.parse(fs.readFileSync(new URL('../../Assets/atlas/atlas.json', import.meta.url), 'utf8'));
const prescale = atlas.prescale || 4;
const mib = bytes => Math.round(bytes / 1048576 * 100) / 100;
const animations = Object.entries(atlas.animations).map(([key, anim]) => ({
    key,
    frames: anim.frames.length,
    bytes: anim.frames.reduce((n, f) => n + f.w * f.h * prescale * prescale * 4, 0),
})).sort((a, b) => b.bytes - a.bytes);
const animationBytes = animations.reduce((n, a) => n + a.bytes, 0);
const seraphBytes = animations.filter(a => a.key.startsWith('seraph_')).reduce((n, a) => n + a.bytes, 0);

// Exercise the real seeded layer generation and draw loops. The fake GL counts
// submissions only; no shaders execute and no pixels are rasterized.
const noop = () => {};
let calls = 0, instances = 0;
const gl = new Proxy({
    isContextLost: () => false,
    createBuffer: () => ({}),
    drawArraysInstanced: (mode, first, count, n) => { calls++; instances += n; },
}, { get: (o, k) => k in o ? o[k] : noop });
const world = Object.create(World.prototype);
Object.assign(world, {
    game: { worldScale: 2, currentState: {} },
    virtualSize: 4096, seed: 42, layers: [], gl,
    glCanvas: { width: 2560, height: 1440 },
    uvMap: new Map(), locs: {}, starCull: 0,
});
const asset = () => {
    const a = {};
    world.uvMap.set(a, { u: 0, v: 0, uWidth: 0.1, vHeight: 0.1, w: 32, h: 32 });
    return a;
};
world.starImages = Array.from({ length: 8 }, asset);
world.singleStars = Array.from({ length: 11 }, asset);
world.rareImages = Array.from({ length: 6 }, asset);
world.blackHoleImage = asset();
world._initLayers();
const ctx = new Proxy({ canvas: { width: 2560, height: 1440 } }, {
    get: (o, k) => k in o ? o[k] : noop,
});
const draws = [];
for (const boostIntensity of [0, 1]) {
    calls = instances = 0;
    world.draw(ctx, { x: 0, y: 0 }, { boostIntensity, vx: 600, vy: 0 }, 10);
    draws.push({ boostIntensity, drawCalls: calls, instances, vertices: instances * 6 });
}
console.log(JSON.stringify({
    note: 'Analytical RGBA pixel budgets and actual JS operation counts, not resident memory or FPS.',
    atlasPageMiB: mib(atlas.pages.reduce((n, p) => n + p.w * p.h * 4, 0)),
    allMaterializedAnimationsMiB: mib(animationBytes),
    allMaterializedSeraphAnimationsMiB: mib(seraphBytes),
    largestAnimations: animations.slice(0, 12).map(a => ({ key: a.key, frames: a.frames, MiB: mib(a.bytes) })),
    starfield: { seed: 42, resolution: [2560, 1440], worldScale: 2, draws },
}, null, 2));
