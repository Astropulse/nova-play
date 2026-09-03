// EDL-driven trailer cutter for the recorded run (scripts/trailer/).
//
// The edit lives in cuts.json — a list of segments cut from the source
// recording (real game audio kept), plus black beats and still cards. This
// script encodes each segment uniformly (1920x1080/60, h264+aac), then concats
// them into the final cut. Iterating on the edit = editing numbers in
// cuts.json and re-running; already-encoded segments are reused when their
// spec hasn't changed (hash in the filename).
//
//   node scripts/trailer/edit.mjs               full quality
//   node scripts/trailer/edit.mjs --draft       fast encode for review
//
// cuts.json format:
//   {
//     "src": "2026-08-27_10-23-12.mp4",
//     "out": "nova-trailer-cut.mp4",
//     "cuts": [
//       {"label":"drift","in":"12:40","dur":5.0},          // source cut (in = M:SS(.s) or seconds)
//       {"type":"black","dur":1.6},                        // black + silence
//       {"type":"card","image":"path.png","dur":6,"fadeIn":1.0},  // still + silence
//       {"label":"x","in":"1:23:45.5","dur":4,"gain":1.2,  // optional audio gain,
//        "vfadeIn":0.5,"vfadeOut":0.5,"speed":1.0}         // video fades, speed
//     ]
//   }
// Every segment gets a 40ms audio fade in/out so concat never pops.
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const DRAFT = process.argv.includes('--draft');
const edl = JSON.parse(readFileSync(join(here, 'cuts.json'), 'utf8'));
const segDir = join(here, 'segments');
mkdirSync(segDir, { recursive: true });

// Source geometry: 2528x1440 window capture -> exact 16:9 center crop -> 1080p.
const VCHAIN = 'crop=2528:1422:0:9,scale=1920:1080:flags=lanczos';
const FPS = 60;
const VOPTS = DRAFT
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']
    : ['-c:v', 'libx264', '-preset', 'slow', '-crf', '17'];
const AOPTS = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const COMMON = ['-pix_fmt', 'yuv420p', '-r', String(FPS), '-video_track_timescale', '60000'];

function parseTime(t) {
    if (typeof t === 'number') return t;
    const parts = String(t).split(':').map(Number);
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s;
}
const ff = (args) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });

const segFiles = [];
let cursor = 0;
const timeline = [];

for (let i = 0; i < edl.cuts.length; i++) {
    const c = edl.cuts[i];
    const dur = c.dur;
    const spec = JSON.stringify({ ...c, draft: DRAFT, v: 3 });
    const hash = createHash('md5').update(spec).digest('hex').slice(0, 10);
    const name = `seg${String(i).padStart(2, '0')}_${(c.label || c.type)}_${hash}.mp4`;
    const out = join(segDir, name);
    timeline.push({ i, label: c.label || c.type, at: +cursor.toFixed(2), dur });
    cursor += dur;
    segFiles.push(out);
    if (existsSync(out)) { console.log('reuse ', name); continue; }
    console.log('encode', name);

    const afades = `afade=t=in:d=0.04,afade=t=out:st=${(dur - 0.04).toFixed(3)}:d=0.04`;

    if (c.type === 'black') {
        ff(['-f', 'lavfi', '-i', `color=c=black:s=1920x1080:r=${FPS}`,
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            ...VOPTS, ...AOPTS, ...COMMON, '-t', String(dur), out]);
        continue;
    }
    if (c.type === 'card') {
        const vf = [];
        if (c.fadeIn) vf.push(`fade=t=in:d=${c.fadeIn}`);
        if (c.fadeOut) vf.push(`fade=t=out:st=${(dur - c.fadeOut).toFixed(3)}:d=${c.fadeOut}`);
        vf.push('scale=1920:1080', 'format=yuv420p');
        ff(['-loop', '1', '-t', String(dur), '-i', join(root, c.image),
            '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
            '-vf', vf.join(','), ...VOPTS, ...AOPTS, ...COMMON, '-t', String(dur), out]);
        continue;
    }

    // Source cut.
    const inT = parseTime(c.in);
    const vf = [VCHAIN];
    if (c.speed && c.speed !== 1) vf.push(`setpts=PTS/${c.speed}`);
    if (c.vfadeIn) vf.push(`fade=t=in:d=${c.vfadeIn}`);
    if (c.vfadeOut) vf.push(`fade=t=out:st=${(dur - c.vfadeOut).toFixed(3)}:d=${c.vfadeOut}`);
    const af = [];
    if (c.speed && c.speed !== 1) af.push(`atempo=${c.speed}`);
    if (c.gain && c.gain !== 1) af.push(`volume=${c.gain}`);
    af.push(afades);
    // Read speed*dur seconds of source to yield `dur` seconds of output.
    const srcDur = (c.speed && c.speed !== 1) ? dur * c.speed : dur;
    ff(['-ss', String(inT), '-t', String(srcDur + 0.05), '-i', join(root, edl.src),
        '-map', '0:v:0', '-map', '0:a:0',
        '-vf', vf.join(','), '-af', af.join(','),
        ...VOPTS, ...AOPTS, ...COMMON, '-t', String(dur), out]);
}

// Concat.
const listFile = join(segDir, 'concat.txt');
writeFileSync(listFile, segFiles.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
const outFile = join(root, edl.out);
ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', outFile]);
console.log('\nfinal:', outFile, `(${cursor.toFixed(1)}s)`);
console.log('\ntimeline:');
for (const t of timeline) {
    const m = Math.floor(t.at / 60), s = (t.at % 60).toFixed(1).padStart(4, '0');
    console.log(`  ${m}:${s}  ${t.label} (${t.dur}s)`);
}
writeFileSync(join(here, 'cut-timeline.json'), JSON.stringify({ total: +cursor.toFixed(2), timeline }, null, 2));
