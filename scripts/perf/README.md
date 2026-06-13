# Nova performance test suite (`scripts/perf/`)

A bot-driven, browser-based performance harness. A command bot flies the **real
ship with real input** through a full gameplay arc while the harness measures
**true per-frame compute time, fully decomposed**, and reports it **per phase**.
Built to find real frame-budget drains (it found the cache-roll `ctx.filter`
lag, the exp-bar bloom, projectile draw cost, and enemy-AI O(n²) scaling).

> **Test in a REAL browser window, not Electron and not headless.** Electron's
> Chromium is GPU-accelerated + unthrottled and hides problems; headless changes
> raster paths. Launch actual Chrome.

## Files

| File | What it is |
|------|-----------|
| `server.mjs` | Static HTTP server (serves the repo root) + `POST /perflog` which prints each body to stdout. Node built-ins only. |
| `stress.html` | Test page. Has `<base href="/">` so the game's relative asset `fetch`es resolve from the repo root. Loads `/src/main.js` then `/scripts/perf/harness.js`. |
| `harness.js` | Boots a solo `PlayingState`, installs full-frame instrumentation, runs the bot scenario, POSTs per-phase results. URL param: `?nolowperf=1` forces `lowPerfMode` off (measure full bloom as an A/B baseline). |
| `bot.js` | `Bot` class — drives the ship with real `game.input` (keys + mouse). |
| `throttle.mjs` | Connects to Chrome's DevTools Protocol and applies CPU throttling to simulate weak hardware. |

## How to run (Windows / PowerShell)

```powershell
# 1. Start the server, appending stdout to a log you can read.
node scripts\perf\server.mjs 8123  *>> "$env:TEMP\nova_perf.log"   # (run hidden/background)

# 2. Launch a REAL Chrome window at the stress page (add --remote-debugging-port
#    ONLY if you also want to throttle). Use a throwaway --user-data-dir.
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --new-window --window-size=1600,900 `
  --no-first-run --no-default-browser-check `
  --disable-background-timer-throttling --disable-renderer-backgrounding `
  --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required `
  --user-data-dir="$env:TEMP\nova_perf_profile" `
  "http://127.0.0.1:8123/scripts/perf/stress.html"

# 3. (optional) Simulate a weak CPU — run AFTER Chrome's page is up (~1s):
node scripts\perf\throttle.mjs 6 125     # rate=6x, hold 125s

# 4. Read results from the server log (the [perf] {...} lines).
```

The whole arc takes ~120s. The bot is made invulnerable and given 3× damage so
combat resolves quickly.

### Simulating weak hardware — two different knobs
- **`throttle.mjs <rate>`** = CPU throttle. Scales **CPU/JS** work (draw-call
  submission, AI, allocations). Does **NOT** scale GPU work — `ctx.filter`
  (blur/color), WebGL, and canvas raster stay GPU-accelerated. So CPU throttle
  *under-reports* filter/blur/post-fx costs.
- **`--disable-gpu`** (Chrome flag) = software raster. Makes `ctx.filter`, the
  WebGL starfield, etc. software → reveals their true weak-hardware cost. (This
  is how the cache-`ctx.filter` and exp-bar-bloom costs were proven.)
Use both depending on what you're profiling.

## Reading the output

Each line is `[perf] {json}`. Tags:
- `PHASE_START {phase}` — a phase began.
- `PHASE {...}` — averaged metrics for a phase (flushed when the phase changes,
  so brief phases like `CACHE_ROLL` get clean numbers). Fields:
  - `frameMean` / `frameMax` — **true per-frame compute time (ms), uncapped** (NOT vsync fps).
  - `potentialFps` / `potFps` — `1000/frameMean` and the game's own running value.
  - `upd`, `draw`, `sfx`, `overhead` — top-level split; **they sum to `frameMean`**.
  - `updSect` / `drawSect` — profiler sections (`enemies`, `projectiles`,
    `world`, `particles`, `collisions`, `boss`, `player`, `asteroids`) split into
    update-side vs draw-side (by diffing `perf._current` around update/draw).
  - `methods` — wrapped **untracked** draw sub-methods: `hud`, `hudExpBar`,
    `hudRadar`, `EnemyIndicators`, `CacheOverlay`, `ShopOverlay`, `streakOv`,
    `ambience`, `sparks`, `explosions`, … (the profiler does NOT cover these
    natively).
  - `ai` — enemy-AI compute split summed across all live enemies, in ms/frame:
    `avoid` (`_avoidObstacles`), `aiState` (`_updateAIState`), `target`. Pure
    `performance.now()` brackets, so **accurate regardless of raster pipeline**.
  - `avoidSplit` — `_avoidObstacles` broken into `ast` (asteroid avoidance),
    `sep` (enemy separation), `dodge` (projectile dodge). Enabled by the harness
    setting `Enemy._PROF = true`.
  - `counts` — live particle populations: `spk` sparks, `rub` rubble, `ft`
    floating texts, `orb` exp orbs, `scr` scrap, `exp` explosions. Use these to
    see when a phase is dominated by the *number* of entities, not per-entity cost.
  - `en`/`ast`/`proj`/`canvases`/`lowPerf` — context counts + adaptive flag.

> **Update vs draw, and the deferred-raster trap.** Canvas-2D draw calls are
> *deferred*: `drawImage`/fills/composites only queue work that rasterizes at a
> later flush (a canvas readback, certain composite ops, or frame end). So
> `drawSect`/`methods` timings capture JS **submission**, and whichever section
> first reads the canvas back (e.g. the exp bar's offscreen compositing) absorbs
> the *entire frame's* pending raster — making an innocent section look like the
> bottleneck. The fix is NOT to force a `getImageData` flush per section (a full
> pipeline sync per call tanks the whole run to single-digit fps). Instead trust
> the **update-side** numbers (`updSect`, `ai`, `avoidSplit` — pure JS, no
> raster) as the honest compute signal, and read `draw` as a whole.
> Also: a 10× **CPU** throttle does NOT disable the GPU. Confirm Canvas2D is
> actually GPU-accelerated (`scripts/perf/gpucheck.mjs`) — after a renderer/GPU
> crash Chrome can silently fall back to **software raster**, which inflates and
> destabilizes every `draw` number (the same arc can swing 13→24ms run to run)
> and is *not* the hardware a real player has. Relaunch Chrome fresh if so.
- `BOT {msg}` — bot progress notes. `DONE` — arc finished. `SUITE_ERR {err}` — scenario threw.

**Key idea:** the in-game `PerfProfiler` under-reports by ~2× because it only
brackets the entity sections — HUD, indicators, overlays, post-fx, and loop
overhead are invisible to it. This harness captures all of it.

## The scenario (phases, in order)

`SETUP` (give upgrades + 3× dmg + invuln) → `STAY` → `FLY_OUT` (into open space →
natural asteroid spawns) → `ASTEROID_FIELD` (dense field) → `CLEAR_ASTEROIDS`
(bot destroys them) → `SHOP` (fly to, open, buy, close) → `CACHE_ROLL` (open,
slot-machine roll) → `CACHE_IDLE` → `FLY_AWAY` → `ENCOUNTER` (fly to, dialog,
turn hostile, kill) → `WAVE` (high-difficulty, fight to the end) → `BOSS` (drive
to phase 2, then kill) → `KNOWLEDGE` (fly to the event, fight it) → `DONE`.

## The bot API (`bot.js`)

Low-level (held until changed): `_aimWorld(wx,wy)` (points the mouse at a world
point so the ship auto-rotates toward it), `_thrust(on)` (KeyW), `_fire(on)`
(mouse btn 0), `_boostTap()` (Space), `_idle()`.

High-level (async, poll each frame until done/timeout):
- `flyTo(wx, wy, arrive=140, timeout=20000)` — thrust+boost to a point.
- `flyOut(dist, angle=null, timeout)` — fly a distance along a heading.
- `stayPut(ms, fire=false)` — hold position, optionally firing at the nearest target.
- `destroy(listName, targetRemaining=0, timeout, {filter})` — aim+fire at the
  nearest of `this.s[listName]` until ≤N remain.
- `approachAndOpen(entity, openFn, isOpenFn, timeout)` — fly to an entity then
  invoke an open handler and wait for it.

## Extending it

- **New phase:** in `harness.js`, call `setPhase('NAME')` then issue bot commands
  / spawns. The per-phase flush captures it automatically.
- **Attribute a new draw sub-method:** add `wrapDraw(S.someObj, '_drawThing',
  'label')` near the other `wrapDraw` calls; it appears in `methods`.
- **Spawn content** (the game's own APIs, verified): `enemySpawner.spawnWave(x,y,
  diff,qty)` / `enemySpawner.forceBoss(x,y,diff)`, `cacheSpawner.spawnNear(x,y)`,
  `_spawnEncounter()`, `new Shop(g,x,y)` + `shops.push`, `new KnowledgeEvent(g,x,y)`
  + `events.push`. Open UIs: `_openShop`, `_openCacheUI`, `_openEncounterDialog`
  (these set `isShopOpen`/`isCacheOpen`/`isEncounterOpen` + `paused`). Give
  upgrades: `player.inventory.autoAdd(UPGRADES.find(id))` + `_onInventoryChanged()`.

## Gotchas (read before debugging)

- **Log file accumulates** across runs (append). Read the **tail**; each run
  restarts at phase `STAY`.
- **The log is UTF-16** (PowerShell redirect). Parse with PowerShell
  `ConvertFrom-Json`; in bash strip nulls (`tr -d '\000'`) first.
- **Adaptive flags persist per Chrome profile** via `localStorage`:
  `nova_screenfx_off` and `nova_lowperf`. Reuse a profile and they stay set
  (so the bloom/ScreenFX start disabled). Use a **fresh `--user-data-dir`** to
  reset, or `?nolowperf=1` to force the bloom on.
- **Don't use `Remove-Item`** on temp files in scripts that also reference the
  Chrome path — the sandbox guard misfires. Use unique filenames or `Clear-Content`.
- `lowPerfMode` only trips after ~4 sustained seconds under 80 fps-potential; a
  6× CPU throttle on a fast machine may stay above that (correctly — it's not
  "weak enough"). Use a heavier throttle (~20×) or `--disable-gpu` to trip it.
- Adaptive perf knobs live in `game.js`: `screenFxDisabled` (post-fx self-disable)
  and `lowPerfMode` (gates post-fx + exp-bar bloom). Both persisted.
