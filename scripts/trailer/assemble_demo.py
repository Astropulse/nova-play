# -*- coding: utf-8 -*-
# Assemble the narration FX demo — DRAMATIC timing, one continuous channel.
#
# Placement is no longer the take's raw spacing: gaps are directed. The
# briefing keeps a procedural rhythm; the line dying mid-sentence earns real
# dead air; "its name." gets a full stop; the whisper section drifts apart as
# he unravels. A faint carrier hiss runs the ENTIRE track so the channel never
# closes — even the "dry" sections live inside the same transmission.
import os, wave, subprocess, math
import numpy as np

ROOT = r"D:\Art\Astropulse\RetroDiffusion\Examples\Game\Nova"
VO = os.path.join(ROOT, "scripts", "trailer", "vo")
FXD = os.path.join(VO, "fx"); SFX = os.path.join(VO, "sfx")
SR = 44100

def rd(path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == SR, path
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
        ch = w.getnchannels()
        return raw.reshape(-1, 2) if ch == 2 else np.repeat(raw[:, None], 2, axis=1)

def db(x): return 10 ** (x / 20)

T0 = 2.5        # the cold open: the whole read starts 2.5 s later
DUR = 141.5  # v4d clock (montage +10.42 after the scream) — see retime.py (air + info cards)
buf = np.zeros((int(SR * DUR), 2))

def place(path, at, vol_db=0.0, fade_in=0.0, fade_out=0.0, trim=None, env=None):
    x = rd(path)
    if trim is not None: x = x[:int(trim * SR)]
    x = x * db(vol_db)
    if env is not None:
        T, W = env
        x = x * np.interp(np.arange(len(x)) / SR, T, W)[:, None]
    if fade_in > 0:
        n = int(fade_in * SR); x[:n] *= np.linspace(0, 1, n)[:, None]
    if fade_out > 0:
        n = int(fade_out * SR); x[-n:] *= np.linspace(1, 0, n)[:, None]
    i = int(at * SR); j = min(i + len(x), len(buf))
    if i < 0: x, i = x[-i:], 0
    buf[i:j] += x[:j - i]

L = lambda n: os.path.join(FXD, n + ".wav")
S = lambda n: os.path.join(SFX, n + ".wav")

# ── The directed timeline — anchored to MEASURED speech onsets ───────────────
# (clip placements = wanted speech time - measured audible onset; the gaps
# below are true speech-to-speech gaps, and every click keys ~0.35s before
# the voice it carries)
PLACE = [           # v4d clock; the v3 clips sit on the same word onsets the picture was cut to
    (  0.92, "01_briefing"),
    (  8.10, "02_contract"),
    ( 13.35, "03_generous"),
    ( 20.26, "04_instruct"),
    ( 33.73, "05_die"),
    ( 39.63, "06_comeback"),
    ( 42.74, "07_stars"),      # "If the stars..." on the old omen onset (43.00)
    ( 49.84, "08_liturgy1"),
    ( 61.90, "09_liturgy2"),   # "They'll send the king in yellow." — "they'll" at 62.13, then the hold is wordless
    ( 71.57, "10_keep1"),      # "Keep flying." on the old "Answer it." onset (71.83)
    ( 74.99, "11_keep2"),      # "KEEP FLYING!" — the shout at 75.29 (the flash)
    ( 90.22, "12_sees"),       # "He sees you..." after the montage (90.47)
    ( 96.85, "13_others"),     # "This is how we lost the others." (97.09)
    (100.20, "14_dontstop"),   # ends before the breathing (106.44)
    (122.14, "16_button"),     # "A word of advice?" right after the click (122.26); "Bring" at 123.86
]
# per-clip trims: the second take's king line and the quiet "Keep flying." came in low
TRIM_DB = {"09_liturgy2": 3.0, "10_keep1": 4.5}
for at, lid in PLACE:
    place(L(lid), at + T0, TRIM_DB.get(lid, 0.0))
# the dragon: 1s more space in front, first breath rides in quieter
place(L("15_breathing"), 106.44 + T0, env=([0.0, 5.2, 99], [0.5, 1.0, 1.0]))

# ── transmission clicks + the tear (keyed to SPEECH) ─────────────────────────
place(S("click_on"), 0.55 + T0, -14)
place(S("click_off"), 35.06 + T0, -15)   # the line dies mid-sentence...
place(S("burst"), 35.08 + T0, -13)   # ...tearing as it goes
place(S("click_on"), 39.55 + T0, -15)   # re-key
place(S("click_off"), 40.95 + T0, -17)
place(S("click_on"), 44.35 + T0, -16)   # the liturgy transmission
place(S("click_off"), 69.00 + T0, -15)
place(S("click_on"), 73.00 + T0, -16)   # answer1 keys in
place(S("click_on"), 122.26 + T0, -14)   # the button: clean comms return
place(S("click_off"), 131.52 + T0, -14)

# ── static beds — ONLY while the radio transmits, keyed with the clicks ──────
# (beds longer than the 20 s source are tiled with a 0.25 s crossfade)
def bed(name, t0, t1, vol_db, fade_in=0.03, fade_out=0.06):
    x = rd(S(name)) * db(vol_db)
    need = int((t1 - t0) * SR); xf = int(0.25 * SR)
    out = np.zeros((need, 2)); pos = 0
    while pos < need:
        seg = x.copy()
        if pos > 0: seg[:xf] *= np.linspace(0, 1, xf)[:, None]
        n = min(len(seg), need - pos)
        out[pos:pos + n] += seg[:n]
        if pos + len(seg) < need:
            out[pos + len(seg) - xf:pos + len(seg)] *= np.linspace(1, 0, xf)[:, None]
        pos += len(seg) - xf
    n = int(fade_in * SR); out[:n] *= np.linspace(0, 1, n)[:, None]
    n = int(fade_out * SR); out[-n:] *= np.linspace(1, 0, n)[:, None]
    i = int(t0 * SR); j = min(i + need, len(buf)); buf[i:j] += out[:j - i]

bed("static_bed", 0.56 + T0, 35.06 + T0, -36)                              # briefing -> dies at the tear
bed("static_bed", 39.56 + T0, 41.00 + T0, -36)                              # re-key
bed("static_bed", 44.36 + T0, 69.00 + T0, -31, fade_out=0.08)               # liturgy
bed("crackle", 49.70 + T0, 62.40 + T0, -27, fade_in=0.5, fade_out=0.9)   # under the swell
bed("whine", 51.40 + T0, 62.00 + T0, -33, fade_in=1.3, fade_out=1.2)   # the heterodyne
bed("static_bed", 73.01 + T0, 76.21 + T0, -36, fade_out=0.4)                # the answers
bed("static_bed", 122.27 + T0, 131.57 + T0, -36)                              # the button

# soft-clip, not global rescale: loud moments saturate, the rest keeps level
peak = np.max(np.abs(buf))
buf = np.tanh(buf * 1.1) / np.tanh(1.1) * 0.97
pcm = (np.clip(buf, -1, 1) * 32767).astype(np.int16)
out = os.path.join(ROOT, "narration-fx-demo.wav")
with wave.open(out, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes(pcm.flatten().tobytes())
subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", out, "-c:a", "libmp3lame", "-q:a", "2",
                os.path.join(ROOT, "narration-fx-demo.mp3")], check=True)
print("assembled: narration-fx-demo.wav / .mp3  (%.1fs, peak was %.2f)" % (DUR, peak))
