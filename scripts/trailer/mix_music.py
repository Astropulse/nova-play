# -*- coding: utf-8 -*-
# Music pre-mix for THE CALL (v4 clock, 125.4 s) — STEM-BASED.
#
# One song per act. Nothing crossfades into a different song: dynamics are
# shaped by riding each song's own stems, so key/tempo never jump. The only
# hard changes sit on the narrative's own cuts (the tear, the black, the shout
# picture, the button click) and land on real drum hits measured from the
# stems. Music is side-chain ducked under the narration.
#
#   TWO SONGS. The liturgy (Liturgy of Horrors, ~89 bpm) is the spine; the
#   eruption (Apocalyptic Boss Scream) is the climax. Nothing else.
#
#   ACT 1   4.92 → 35.06   the liturgy from its top: the pad creeps in under
#                          "your route is charted"; the song's own first drum
#                          hit (13.14 s) lands ON the 42 UPGRADES card; its
#                          beat locks in at 24 s = "past regulation"; the tear
#                          stops it dead.
#   ACT 2  39.05 → 69.40   the SAME song resumes where it would have been (the
#                          transmission re-keys, the music comes back): pad
#                          only under "come back" + the omen; drums return on
#                          a downbeat ON the FIGHT GODS card; the song's own
#                          choir enters (56 s) under "the king in yellow";
#                          stops with "its name." into the black.
#   ACT 3  72.20 → 95.40   the eruption, entering on a downbeat with the
#                          picture; its own 2 s break falls UNDER the scream
#                          and the drop answers it; drums/guitar/bass thin
#                          over the king's whisper; synth+FX carry it, gone
#                          before the breathing.
#   ACT 4 111.84 → end     the liturgy's second half on the button click —
#                          pad, bass, choir (no drums): the same music that
#                          followed the gods now under the sign-off.
#
# Outputs (repo root): music-premix.wav, narration-music-premix.wav/.mp3,
# scripts/trailer/review/music_edl.json
import os, wave, json, subprocess, glob
import numpy as np

ROOT = r"D:\Art\Astropulse\RetroDiffusion\Examples\Game\Nova"
MUS = os.path.join(ROOT, "scripts", "trailer", "music")
SR = 44100
T0 = 2.5        # the cold open
DUR = 141.5

def rd_any(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-ac", "2", "-ar", str(SR), "-f", "s16le", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.int16).astype(np.float64).reshape(-1, 2) / 32768.0

def db(x): return 10 ** (x / 20)

def stems_of(song):
    out = {}
    for f in glob.glob(os.path.join(MUS, "stems", song, "*.wav")):
        out[f.split("(")[-1].split(")")[0]] = f
    return out

# ── the arrangement ──────────────────────────────────────────────────────────
# ACT = (song, src_in, dst_in, dst_out, act_gain_db, stems)
#   stems: {stem: [(t, level 0..1), ...]} — a level envelope on the trailer
#   clock, linearly interpolated; stems not listed are silent. Every act starts
#   its stems at the same source offset, so they stay locked to each other.
ACTS = [
    ("the liturgy", 0.0, 4.92, 35.06, -1.0, {                 # 13.14 s hit -> card 18.06
        "Synth": [(4.92, 0.0), (9.0, 1.0)],
        "Drums": [(4.92, 1.0)],                                # the song's own entry
    }),
    ("the liturgy", 34.13, 39.05, 69.40, -1.0, {               # resumes where it left off
        "Synth":          [(39.05, 0.0), (41.0, 0.9), (47.73, 1.0)],
        "Drums":          [(47.72, 0.0), (47.73, 1.0)],        # downbeat 42.76 s = the card
        "Backing Vocals": [(39.05, 1.0)],                      # the song brings them at 56 s = the king
        "Bass": [(39.05, 1.0)], "FX": [(39.05, 1.0)],
    }),
    ("the eruption", 27.896, 72.20, 105.82, +0.0, {            # downbeat; break 30.0-32.36 under the scream;
        "Drums":  [(72.20, 1.0), (90.17, 1.0), (92.9, 0.0)],        # the drop (76.58) carries the montage to the bar at 90.17
        "Guitar": [(72.20, 1.0), (90.17, 1.0), (92.9, 0.0)],
        "Bass":   [(72.20, 1.0), (90.17, 1.0), (93.9, 0.0)],
        "Synth":  [(72.20, 1.0), (90.17, 1.0), (96.4, 0.7), (102.4, 0.6), (105.82, 0.0)],
        "FX":     [(72.20, 1.0), (96.4, 0.8), (102.4, 0.6), (105.82, 0.0)],
    }),
    ("the liturgy", 158.0, 122.26, 139.0, -2.0, {
        "Synth":          [(122.26, 0.0), (123.0, 1.0)],
        "Bass":           [(122.26, 0.0), (123.0, 0.6)],
        "Backing Vocals": [(122.26, 1.0)],
        "FX":             [(122.26, 0.7)],
    }),
]
END_FADE = [0.04, 0.25, 0.5, 3.0]   # per act: fade length at dst_out (a 'stop', not a click)

buf = np.zeros((int(SR * DUR), 2))
t_axis = np.arange(len(buf)) / SR
edl = []
for ai, (song, sin, din, dout, gain, stems) in enumerate(ACTS):
    files = stems_of(song)
    din += T0; dout += T0; stems = {k: [(t + T0, v) for (t, v) in pts] for k, pts in stems.items()}
    n = int((dout - din) * SR); j0 = int(din * SR); j1 = min(len(buf), j0 + n)
    i0 = int(sin * SR)
    seg_t = t_axis[j0:j1]
    fo = END_FADE[ai]
    edge = np.clip((dout - seg_t) / fo, 0, 1)
    for stem, pts in stems.items():
        if stem not in files:
            print("  (no stem %s in %s)" % (stem, song)); continue
        x = rd_any(files[stem])[i0:i0 + (j1 - j0)]
        if len(x) < j1 - j0: x = np.vstack([x, np.zeros((j1 - j0 - len(x), 2))])
        T = [p[0] for p in pts]; V = [p[1] for p in pts]
        lev = np.interp(seg_t, T, V) * edge
        buf[j0:j1] += x * (lev * db(gain))[:, None]
    edl.append(dict(song=song, src_in=sin, dst_in=din, dst_out=dout, gain_db=gain,
                    stems={k: v for k, v in stems.items()}))
    print("%-13s src %6.2f -> %6.2f..%6.2f  stems: %s" % (song, sin, din, dout, ", ".join(stems)))

# ── side-chain duck under the narration ──────────────────────────────────────
def rd_wav(path):
    with wave.open(path) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float64) / 32768.0
        return x.reshape(-1, w.getnchannels())

nar = rd_wav(os.path.join(ROOT, "narration-fx-demo.wav"))
mono = np.abs(nar).mean(axis=1)
blk = 64
m2 = mono[:len(mono) // blk * blk].reshape(-1, blk).max(axis=1)
a_att = np.exp(-blk / (0.015 * SR)); a_rel = np.exp(-blk / (0.40 * SR))
env_b = np.zeros(len(m2)); e = 0.0
for i, v in enumerate(m2):
    e = v + (a_att if v > e else a_rel) * (e - v)
    env_b[i] = e
env = np.repeat(env_b, blk)
env = np.concatenate([env, np.full(max(0, len(mono) - len(env)), env[-1] if len(env) else 0)])
duck_db = -6.0 * np.clip((20 * np.log10(env + 1e-6) + 30) / 12, 0, 1)
n = min(len(buf), len(duck_db))
buf[:n] *= db(duck_db[:n])[:, None]

MUSIC_DB = -7.0    # bed level under the read (VO RMS ~-19 dBFS)
buf *= db(MUSIC_DB)
pk = np.max(np.abs(buf))
pcm = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
out = os.path.join(ROOT, "music-premix.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.flatten().tobytes())

mix = np.zeros((max(len(buf), len(nar)), 2))
mix[:len(nar)] += nar
mix[:len(buf)] += buf
mix = np.tanh(mix * 1.05) / np.tanh(1.05) * 0.97
pcm = (np.clip(mix, -1, 1) * 32767).astype(np.int16)
out2 = os.path.join(ROOT, "narration-music-premix.wav")
with wave.open(out2, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.flatten().tobytes())
subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", out2, "-c:a", "libmp3lame", "-q:a", "2",
                os.path.join(ROOT, "narration-music-premix.mp3")], check=True)
json.dump(edl, open(os.path.join(ROOT, "scripts", "trailer", "review", "music_edl.json"), "w"), indent=1)
print("music-premix.wav peak %.2f (music at %+.0f dB, ducked up to 6 dB under speech)" % (pk, MUSIC_DB))
print("wrote narration-music-premix.wav/.mp3")
