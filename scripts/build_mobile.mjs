// Stages the web build into www-mobile/ for the Capacitor Android wrapper.
// Usage: node scripts/build_mobile.mjs   (then: npx cap sync android)
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www-mobile');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const copies = [
  ['index.html', 'index.html'],
  ['style.css', 'style.css'],
  ['src', 'src'],
  ['Assets', 'Assets'],
];

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
