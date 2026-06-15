// ESM loader hook: force the project's src/*.js (authored as ES modules but in a
// CommonJS package) to load as ES modules so a headless Node test can import the
// real game logic without mutating package.json.
export async function load(url, context, nextLoad) {
  if (url.endsWith('.js') && url.includes('/src/')) {
    return nextLoad(url, { ...context, format: 'module' });
  }
  return nextLoad(url, context);
}
