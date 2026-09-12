# -*- coding: utf-8 -*-
# Mix the REAL game SFX for the previs: reads frames/sfxlog.json (every
# sounds.play() the muted capture logged, with recorded-time stamps and
# effective volumes), decodes the actual game audio files (registration list
# parsed straight out of src/engine/game.js), and places them on the trailer
# clock. Output: previs-gamesfx.wav + previs-audio.wav (narration + SFX mixed,
# NO music — that's added by hand later).
import json, os, re, subprocess, wave, hashlib
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SR = 44100

# ── key -> file list, parsed from the registration calls ─────────────────────
gjs = open(os.path.join(ROOT, 'src', 'engine', 'game.js'), encoding='utf-8').read()
REG = {}
for m in re.finditer(r"sounds\.register\(\s*'([^']+)'\s*,\s*\[(.*?)\]", gjs, re.S):
    key = m.group(1)
    paths = re.findall(r"'([^']+)'", m.group(2))
    REG[key] = paths
print('registrations:', len(REG))

CACHE = os.path.join(HERE, 'vo', 'sfxcache')
os.makedirs(CACHE, exist_ok=True)

def decode(path):
    tag = hashlib.md5(path.encode()).hexdigest()[:12] + '.wav'
    out = os.path.join(CACHE, tag)
    if not os.path.exists(out):
        subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', os.path.join(ROOT, path),
                        '-ar', str(SR), '-ac', '2', out], check=True)
    with wave.open(out) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
        return x.reshape(-1, 2)

log = json.load(open(os.path.join(HERE, 'frames', 'sfxlog.json'), encoding='utf-8'))
print('events:', len(log))

DUR = 150.0
buf = np.zeros((int(SR * DUR), 2))
rng = np.random.default_rng(7)
missing = {}
loaded = {}
placed = 0
# never in the trailer: the boss heralds' trumpets (a stray horn in the montage),
# achievement stings; the level-up sting only where the level-up is on camera
def skip(tms, key):
    if key.startswith('trumpet') or key == 'achievement': return True
    if key == 'level' and not (21.9 <= tms / 1000 <= 23.9): return True
    return False
for (tms, key, vol, pitch) in log:
    if skip(tms, key): continue
    paths = REG.get(key)
    if not paths:
        missing[key] = missing.get(key, 0) + 1
        continue
    path = paths[int(rng.integers(0, len(paths)))]
    if path not in loaded:
        try: loaded[path] = decode(path)
        except Exception as e:
            missing[key] = missing.get(key, 0) + 1
            loaded[path] = None
            continue
    x = loaded[path]
    if x is None: continue
    if pitch and abs(pitch - 1) > 0.02:
        n2 = int(len(x) / pitch)
        idx = np.linspace(0, len(x) - 1.001, n2)
        i0 = idx.astype(np.int64); fr = (idx - i0)[:, None]
        x = x[i0] * (1 - fr) + x[i0 + 1] * fr
    i = int(tms / 1000 * SR)
    j = min(i + len(x), len(buf))
    if j <= i: continue
    buf[i:j] += x[:j - i] * vol
    placed += 1

print('placed:', placed, ' skipped keys:', missing)

# the trailer's sacred silences: game audio bows out entirely for the stop
# after the liturgy and for the dragon's breathing (through the black)
t_axis = np.arange(len(buf)) / SR
duck = np.ones(len(buf))
for (d0, d1) in [(110.20, 124.71), (132.33, 150.0)]:   # the breathing/black, and the end card (no game sounds under the logo)
    duck *= 1 - np.clip((t_axis - (d0 - 0.4)) / 0.4, 0, 1) * np.clip(((d1) - t_axis) / 0.4, 0, 1).clip(0, 1)
buf *= duck[:, None]

# soft-clip the sum, keep headroom for the narration mix
buf = np.tanh(buf * 0.9) / np.tanh(0.9) * 0.9
pcm = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
sfx_out = os.path.join(ROOT, 'previs-gamesfx.wav')
with wave.open(sfx_out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.flatten().tobytes())
print('wrote', sfx_out)

# ── narration + game SFX (SFX ducked; no music) ──────────────────────────────
def rd(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
        return x.reshape(-1, w.getnchannels())

nar = rd(os.path.join(ROOT, 'narration-fx-demo.wav'))
n = max(len(nar), len(buf))
mix = np.zeros((n, 2))
mix[:len(nar)] += nar
GAME_DB = -8.0
mix[:len(buf)] += buf * (10 ** (GAME_DB / 20))
# the music pre-mix (mix_music.py) rides in already leveled against the read
mus_path = os.path.join(ROOT, 'music-premix.wav')
if os.path.exists(mus_path):
    mus = rd(mus_path)
    k = min(len(mus), len(mix)); mix[:k] += mus[:k]
    print('music-premix.wav mixed in')
mix = np.tanh(mix * 1.05) / np.tanh(1.05) * 0.97
pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
mix_out = os.path.join(ROOT, 'previs-audio.wav')
with wave.open(mix_out, 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.flatten().tobytes())
print('wrote', mix_out, '(game sfx at %+.0f dB under narration)' % GAME_DB)
