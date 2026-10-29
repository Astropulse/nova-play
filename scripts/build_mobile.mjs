// Stages the web build into www-mobile/ for the Capacitor Android wrapper.
// Usage: node scripts/build_mobile.mjs   (then: npx cap sync android)
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www-mobile');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Only what the runtime actually loads goes into the APK. Sprites come from
// the packed atlas (Assets/atlas — the runtime source of truth); the loose
// PNG/GIF source art under Assets/Ships, Events, VFX, ... is only read by the
// per-file fallback in Game.init when atlas.json is missing, so it stays out
// (the atlas is required below instead). Sounds (SFX + lazily loaded music),
// tutorial videos (tutorialState.js) and fonts (style.css) are loaded by path.
// If you add a new runtime-loaded asset folder, add it here.
const copies = [
  ['index.html', 'index.html'],
  ['style.css', 'style.css'],
  ['src', 'src'],
  ['Assets/atlas', 'Assets/atlas'],
  ['Assets/Fonts', 'Assets/Fonts'],
  ['Assets/Sounds', 'Assets/Sounds'],
  ['Assets/Tutorials', 'Assets/Tutorials'],
];

// Without the atlas the game would fall back to the loose files we skip.
for (const f of ['Assets/atlas/atlas.json', 'Assets/atlas/atlas_boot.json']) {
  if (!existsSync(path.join(root, f))) {
    console.error(`missing ${f} — run \`npm run pack-assets\` first`);
    process.exit(1);
  }
}

for (const [from, to] of copies) {
  const src = path.join(root, from);
  if (!existsSync(src)) {
    console.error(`missing: ${from}`);
    process.exit(1);
  }
  cpSync(src, path.join(out, to), { recursive: true });
  console.log(`copied ${from}`);
}

console.log(`staged web build at ${out}`);
