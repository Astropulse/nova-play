# NOVA trailer pipeline — `scripts/trailer/`

Produces the Steam trailer. Three products live here:

1. **THE CALL** — the narration + its radio sound design (approved).
2. **The previs** — the trailer staged inside the real game on a virtual clock
   (a goal-driven pilot on the game's own controls, comms-panel subtitles,
   info cards, real game SFX).
3. **The footage edit** — cuts from a recorded human run (`cuts.json` +
   `edit.mjs`), the source for the final live-play material.

Everything is data-driven from one clock: retime the audio and every other
layer (scenes, subtitles, SFX ducks, flashes, music) is re-derived, never
re-tuned by hand.

**Media is not in git.** The narration takes, the cut voice clips (`vo/`), the
Suno library (`music/`), every mix/render (`*.wav`, `*.mp3`, `*.mp4` here and
at the repo root) are ignored — only the scripts and the small data files
(`subtitles.json`, `breath.json`, `cuts.json`, the dragon art) are tracked.
Keep the media alongside the checkout; `build_vo_fx.py` regenerates `vo/` from
the takes.

## 1. THE CALL — narration + radio FX

| File | Role |
| --- | --- |
| `Narration.wav`, `narration2.wav` | The first take (one continuous read) and the second take (the script-v3 replacement lines; `Narration2_leveled.wav` = level-matched copy) — `LINES` entries tagged `'N2'` cut from the second |
| `transcribe_vo.py` | faster-whisper (`small.en`, word timestamps) → `review/narration_transcript.json` |
| `build_vo_fx.py` | Cuts the take into clips (`LINES`), synthesizes the radio SFX (noise-snap clicks, keyed static beds, crackle, whine, burst) and renders each clip through its radio chain; `CORRUPT` holds the per-clip corruption envelopes (a mono-symmetric port of the game's corruption bus + granular demon double) → `vo/fx/*.wav`, `vo/sfx/*.wav` |
| `assemble_demo.py` | Places the clips on the trailer clock (`PLACE`), keys the clicks/beds, breathing off-radio → `narration-fx-demo.wav/.mp3` |
| `gen_subtitles.py` | Word-level subtitle track on the same clock (stage per clip, corruption weight per word) → `subtitles.json` |
| `TRAILER-SCRIPT.md` | The clean lines-only script (v3) + line→mechanic map + the clip map for re-records |

Rules the mix obeys (user-directed): one radio identity for every line, static
only while the channel is keyed, distortion follows the performance (smooth
ebb/flow, never a stereo shift), the breathing is the dragon (pitched down,
off-radio), clicks are noise snaps.

## 2. The previs — `trailer.html` + `director.js` + `capture.mjs`

Boots the real game on a virtual clock (`performance.now` + rAF replaced) and
steps it 1/30 s per call; `capture.mjs` screenshots every recorded frame.
`director.js` holds `SCENES` — each with `preroll` (stepped, not recorded),
`record`, a `setup`, timed `beats` and a per-frame `tick`. Staging tools in
the file: the PILOT (`pilot.js`) — the ship is FLOWN through the game's own
CONTROLLER path (a `FakePad` assigned as `player.input`: right stick aim, an
analog left stick as a proportional throttle — never a key toggled on/off —
triggers for fire/boost, bumper shield), never moved. Scenes set goals:
`goto` (waypoints, rock avoidance, shoot rocks/enemies en route, ease to a
stop), `cruise`, `hold` (stop, face, optionally back off on S), `hunt` (joust
passes, bursts, dodge + shield reflex), `strike` (boss standoff band), `mine`
(stop, crack a rock, scoop the scrap), `follow` (a wingman on a FakePad flying
toward a wandering slot in the lead's frame); `pilot.forceShield` for scripted
shield beats; railgun builds HOLD the trigger. The old kinematic `rig` is
retired (no scene uses it). `loadout()`
(writes the ship's weapon stats directly — the trailer build is not derived
from inventory; note the railgun OVERRIDES the guns and must be HELD to fire),
`give()`, `ringOfEnemies`, `asteroidField`, `densestNebula`, the dread
triggers, `setOverlay`/`setVignette`/`fxSet`, `cardScene()` (CRAWL-style
full-frame info cards: hard cut, two lines, the second slams in with a UI
click), the comms panel (fixed DISPATCH window, text appends and never moves;
signal meter shows the descent; hidden while a black card is up unless
`flags.subsOverCard`), and the SFX logger (`g.sounds.play` is replaced; every
call is logged with its recorded-time stamp → `frames/sfxlog.json`).

| File | Role |
| --- | --- |
| (montage) | After the scream, 16 `shot()` scenes cut on the eruption's beat grid (`BEAT` = 0.56616 s, drop at 76.58, back on the bar at 90.17): `swapShip()` swaps the hull, `ringOf(Cls…)` spawns the special enemies / bosses, `loadout()` sets the build per shot |
| `retime.py` | THE CLOCK. Old cut points + per-scene lead/tail air + inserted cards → prints every number the other files carry (PLACE, clicks, beds, flashes, duck zones, scene records). Change the timing here first. |
| `capture.mjs` | `node scripts/trailer/capture.mjs` full render → `frames/` + `timeline.json` + `sfxlog.json`; `... spot scene:t …` for spot frames (ALWAYS spot before a full render) |
| `mix_gamesfx.py` | Real game SFX from the log (registrations parsed from `src/engine/game.js`), ducked for the sacred silences → `previs-gamesfx.wav`, `previs-audio.wav` (narration + SFX, no music) |
| `mix_music.py` | Music pre-mix from the Suno library (`music/`, stems in `music/stems/`): TWO songs (the liturgy = spine, the eruption = climax), each act shaped by riding that song's own stems, side-chain-ducked under the narration → `music-premix.wav`, `narration-music-premix.wav/.mp3`, `review/music_edl.json` |
| `cardart/` | Sprite frames (PNG per gif frame, extracted with PIL) for the info cards and the dragon; stepped on the virtual clock by `animSprites()` / the dragon tick, preloaded before `TRAILER.ready` |
| `breath.json` | 30 fps envelope of the placed dragon breathing (from `vo/fx/15_breathing.wav` at its `assemble_demo.py` placement) — lights and tears the dragon head in sync with each breath |
| `dragon.gif/.png` | The dragon head art (12 frames: eyes shut → open) used by the `dragoneyes` scene |
| `pilot.js` | THE PILOT — goal-driven controller driver (see above); every pilot (lead + wingmen) holds a `FakePad` (a GamepadInputSource look-alike); the lead's aim is mirrored into the mouse cursor so the crosshair follows |
| `cinebot.js` | The first autopilot (retired; the Pilot supersedes it) |

Render chain (≈40 min at 1080p30; the monster-arsenal scenes run ~0.5 fps):

```sh
node scripts/perf/server.mjs 8123          # static server, once
node scripts/trailer/capture.mjs           # frames/
sh scripts/trailer/finish.sh                 # encode + SFX/narration/music mux + proxy (the four lines below, in one)
ffmpeg -y -framerate 30 -i scripts/trailer/frames/f%05d.png -c:v libx264 -pix_fmt yuv420p -crf 18 -preset medium -movflags +faststart previs-silent.mp4
python scripts/trailer/mix_gamesfx.py
ffmpeg -y -i previs-silent.mp4 -i previs-audio.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart nova-trailer-previs.mp4
```

**Scene cache (don't re-render what didn't change).** `capture.mjs` keeps every
scene's frames under `cache/<scene>-<key>/`, keyed by a hash of the scene's own
definition (setup/tick/beats/record + index; generated scenes carry `_src`).
On the next run unchanged scenes are only *simulated* (draw gated off via
`TRAILER.setDraw`, ~20× faster) and their frames copied in; only changed
scenes render. `--fresh` ignores the cache, `--from <scene>` re-renders that
scene and everything after it. Spot mode gates draw the same way, so a spot
of a late scene no longer takes 25 minutes. Bump `RENDER_CORE` in director.js
when a shared helper changes the picture without touching scene source.
Caveat: sim state flows forward, so a changed scene can nudge the RNG of a
later cached one — use `--fresh` for the final render.

Requires playwright-core borrowed from the Ads pipeline's `node_modules` and
`chrome-headless-shell` from `%LOCALAPPDATA%\ms-playwright`
(`--enable-unsafe-swiftshader`). The spot check of a late scene steps the whole
timeline first — anything past `answer` takes >10 min.

### Retiming the trailer

1. Edit `retime.py` (cut points, `AIR`, `CARDS`) and run it.
2. Carry its numbers into `assemble_demo.py` (PLACE/clicks/beds), `director.js`
   (records, beat times, path `dur`s, `FLASHES`), `mix_gamesfx.py` (duck
   zones), `mix_music.py` (landmarks).
3. `python assemble_demo.py && python gen_subtitles.py`, spot-check, render.

## 3. The footage edit — `cuts.json` + `edit.mjs`

Cuts a real recorded run (OBS capture at the repo root, e.g.
`2026-08-27_10-23-12.mp4` — 2528×1440/60, game audio on both tracks).

| File | Role |
| --- | --- |
| `cuts.json` | THE EDIT — ordered segments `{label, in (source secs), dur}` + black beats + the logo card |
| `edit.mjs` | Renders it: per-segment encode (center-crop → 1920×1080/60, h264 crf 17 + aac, 40 ms audio fades) → concat → `nova-trailer-cut.mp4` |
| `cut-timeline.json` | Rendered per-cut timecodes (written by edit.mjs) |
| `review/` | Contact sheets, zoom sheets, frame checks |
| `spot/title_t6_0.png` | The end card (game logo + tagline) |

```sh
node scripts/trailer/edit.mjs --draft    # fast encodes for review
node scripts/trailer/edit.mjs           # full quality
```

Reviewing footage without watching it: timestamped contact sheets —

```sh
ffmpeg -i RUN.mp4 -vf "fps=1/15,scale=400:-1,\
drawtext=fontfile='C\:/Windows/Fonts/consolab.ttf':text='%{pts\:hms}':x=8:y=8:\
fontsize=30:fontcolor=yellow:box=1:boxcolor=black@0.6,tile=8x5" -q:v 3 review/sheet_%02d.jpg
```

then denser passes over candidate windows. Gotcha: the pilot opens the
inventory constantly — check a cut's head and tail for panels.
