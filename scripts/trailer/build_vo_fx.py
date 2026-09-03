# -*- coding: utf-8 -*-
# NOVA trailer VO kit: cut Narration.wav into lines, synthesize radio FX,
# process each line through its descent-stage radio chain, then apply the
# GAME'S OWN corruption (a numpy port of soundManager.js's master corruption
# bus + dread warble) with time-varying envelopes on the leak moments.
#
# The corruption is intentionally identical to src/engine/soundManager.js:
#   * wet path = waveshaper y=(1+8)x/(1+8|x|) -> darkening lowpass
#   * blend = a^2 ; dry gain 1-0.62*blend ; wet gain 0.34*blend
#   * lowpass cutoff 4500 - 2900*blend Hz
#   * static bed fades in past a>0.75 (white noise lowpassed 3.2 kHz, *0.045)
#   * dread warble: 28ms delay wobbled +/-11ms @0.31 Hz sine, mixed under the
#     dry (dry 1-0.45w / wet 0.55w)
# Everything is processed identically on both channels — corruption never
# shifts the stereo image.
import os, subprocess, wave, math
import numpy as np

ROOT = r"D:\Art\Astropulse\RetroDiffusion\Examples\Game\Nova"
SRC = os.path.join(ROOT, "scripts", "trailer", "Narration.wav")
VO = os.path.join(ROOT, "scripts", "trailer", "vo")
RAW = os.path.join(VO, "raw"); FXD = os.path.join(VO, "fx"); SFX = os.path.join(VO, "sfx")
for d in (VO, RAW, FXD, SFX): os.makedirs(d, exist_ok=True)
SR = 44100

def ff(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)

def wwrite(path, data):  # (n,) mono or (n,2) float -> 16bit stereo wav
    if data.ndim == 1:
        data = np.repeat(data[:, None], 2, axis=1)
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(pcm.flatten().tobytes())

def rd_wav(path):
    with wave.open(path, "rb") as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768.0
        return x.reshape(-1, w.getnchannels())

rng = np.random.default_rng(20260901)

# ── FX synthesis (clicks / beds / burst / whine) ─────────────────────────────
def bandpass_noise(n, lo, hi, seed_noise=None):
    x = seed_noise if seed_noise is not None else rng.standard_normal(n)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1 / SR)
    m = np.zeros_like(f)
    band = (f >= lo) & (f <= hi)
    m[band] = 1.0
    edge = (f > lo * 0.6) & (f < lo); m[edge] = (f[edge] - lo * 0.6) / (lo * 0.4)
    edge = (f > hi) & (f < hi * 1.6); m[edge] = 1 - (f[edge] - hi) / (hi * 0.6)
    return np.fft.irfft(X * m, n)

def norm(x, peak=1.0):
    mx = np.max(np.abs(x)) or 1.0
    return x / mx * peak

def make_click(path, open_click=True):
    # A radio key click is NOT a drum hit: no tone, just a crisp band-limited
    # noise snap. On = 6 ms "tk". Off = the snap + a ~35 ms squelch tail that
    # dies into the closed channel.
    if open_click:
        n = int(SR * 0.006)
        x = bandpass_noise(n, 1000, 3200)
        x *= np.exp(-np.arange(n) / SR * 350)
    else:
        n1 = int(SR * 0.005)
        snap = bandpass_noise(n1, 800, 2800) * np.exp(-np.arange(n1) / SR * 380)
        n2 = int(SR * 0.035)
        tail = bandpass_noise(n2, 700, 2600) * np.exp(-np.arange(n2) / SR * 90) * 0.5
        x = np.concatenate([snap, tail])
    wwrite(path, norm(x, 0.8))

make_click(os.path.join(SFX, "click_on.wav"), True)
make_click(os.path.join(SFX, "click_off.wav"), False)

n = SR * 20
t = np.arange(n) / SR
bed = bandpass_noise(n, 280, 3200)
wob = 1 + 0.25 * np.sin(2 * np.pi * 0.37 * t) + 0.12 * np.sin(2 * np.pi * 1.31 * t + 1.7)
wwrite(os.path.join(SFX, "static_bed.wav"), norm(bed * wob, 0.9))

n = SR * 20
imp = np.zeros(n)
idx = rng.integers(0, n - 80, int(20 * 16))
for i in idx:
    L = rng.integers(8, 60)
    imp[i:i+L] += rng.standard_normal(L) * rng.uniform(0.4, 1.0)
wwrite(os.path.join(SFX, "crackle.wav"), norm(bandpass_noise(n, 500, 4200, imp), 0.9))

# the transmission tearing: gated noise pulses, each louder, then a hard cut
n = int(SR * 0.85)
t = np.arange(n) / SR
noise = bandpass_noise(n, 500, 3400)
env = np.zeros(n)
tp = 0.0
for dur_p, gap, amp in [(0.055, 0.05, 0.4), (0.05, 0.04, 0.6), (0.075, 0.06, 0.8), (0.13, 0.0, 1.0)]:
    i0, i1 = int(tp * SR), int((tp + dur_p) * SR)
    seg = np.linspace(1, 0.55, i1 - i0)
    seg[:min(40, len(seg))] *= np.linspace(0.2, 1, min(40, len(seg)))  # sharp-ish attack
    env[i0:i1] = seg * amp
    tp += dur_p + gap
wwrite(os.path.join(SFX, "burst.wav"), norm(noise * env, 0.9))

n = SR * 14
t = np.arange(n) / SR
f1 = 1150 + 220 * np.sin(2 * np.pi * 0.055 * t)
f2 = 1900 + 300 * np.sin(2 * np.pi * 0.031 * t + 2.0)
x = 0.7 * np.sin(2 * np.pi * np.cumsum(f1) / SR) + 0.35 * np.sin(2 * np.pi * np.cumsum(f2) / SR)
x *= (0.6 + 0.4 * np.sin(2 * np.pi * 0.21 * t))
wwrite(os.path.join(SFX, "whine.wav"), norm(x, 0.8))
print("sfx synthesized")

# ── The game's corruption, ported (see soundManager.js) ──────────────────────
def one_pole_lp(x, cutoff):
    # cutoff may be scalar or per-sample array; two cascaded poles ~ biquad slope
    k = 1 - np.exp(-2 * np.pi * np.asarray(cutoff, dtype=np.float64) / SR)
    y = np.zeros_like(x)
    z1 = z2 = 0.0
    if np.isscalar(cutoff) or np.ndim(cutoff) == 0:
        kk = float(k)
        for i in range(len(x)):
            z1 += kk * (x[i] - z1)
            z2 += kk * (z1 - z2)
            y[i] = z2
    else:
        for i in range(len(x)):
            z1 += k[i] * (x[i] - z1)
            z2 += k[i] * (z1 - z2)
            y[i] = z2
    return y

def demon_layer(x_mono, ratio=0.78, grain_s=0.045):
    """Granular pitch-down (same duration) — the CRAWL demon-double."""
    n = len(x_mono)
    g = int(grain_s * SR)
    hop = g // 2
    win = np.hanning(g)
    out = np.zeros(n)
    norm_w = np.zeros(n)
    idx = np.arange(g) * ratio
    i0 = np.clip(idx.astype(np.int64), 0, g - 2)
    fr = idx - i0
    for start in range(0, n - g, hop):
        seg = x_mono[start:start + g]
        rs = seg[i0] * (1 - fr) + seg[i0 + 1] * fr
        out[start:start + g] += rs * win
        norm_w[start:start + g] += win
    out /= np.maximum(norm_w, 1e-6)
    return one_pole_lp(out, 1900.0)   # keep it dark, under the voice

def game_corrupt(stereo, a_env, warble_env, seed=7):
    """The game's corruption bus, tuned for VO clarity, hybridized with the
    crush/flutter/doubling character (all mono-symmetric — the image never
    moves). Static is voice-reactive fry, not a constant bed."""
    n = len(stereo)
    a = np.clip(a_env, 0, 1)
    w = np.clip(warble_env, 0, 1)
    blend = a * a
    dry_g = 1 - 0.45 * blend          # gentler duck than the game — clarity first
    wet_g = 0.42 * blend              # the crunch carries the corruption
    cutoff = 4500 - 2200 * blend      # floor ~2300 Hz — presence survives
    r = np.random.default_rng(seed)
    t = np.arange(n) / SR

    # voice-follower: the fry rides the speech, so static never feels pasted-on
    mono = np.abs(stereo.mean(axis=1))
    k = 1 - math.exp(-2 * math.pi * 8.0 / SR)   # ~30ms follower
    lvl = np.empty(n); z = 0.0
    for i in range(n):
        z += k * (mono[i] - z); lvl[i] = z
    ref = np.percentile(lvl, 95) or 1.0
    lvl = np.clip(lvl / ref, 0, 1)
    fry = bandpass_noise(n, 700, 4200, r.standard_normal(n))
    fry = fry / (np.max(np.abs(fry)) or 1.0)
    st_amt = np.maximum(0, (a - 0.6) / 0.4) * 0.05
    static = fry * (0.2 + 0.8 * lvl)

    phase = r.uniform(0, 2 * np.pi)
    d_samp = (0.028 + 0.011 * np.sin(2 * np.pi * 0.31 * t + phase)) * SR
    flut = 1 - 0.25 * a * 0.5 * (1 + np.sin(2 * np.pi * 9.3 * t + r.uniform(0, 6.28)))
    q = 2 ** (np.maximum(4.0, 8.0 - 2.0 * a) - 1)
    dd = int(0.012 * SR)

    out = np.empty_like(stereo)
    for ch in range(stereo.shape[1]):
        x = stereo[:, ch]
        shaped = 9 * x / (1 + 8 * np.abs(x))
        crushed = np.round(shaped * q) / q          # the seeshim grit
        wet = one_pole_lp(crushed, cutoff)
        wet = wet * flut                            # broken-transmission flutter
        doubled = np.concatenate([np.zeros(dd), wet[:-dd]])
        dem = demon_layer(x)
        core = x * dry_g + (wet + doubled * 0.35 * a) * wet_g + static * st_amt + dem * (0.38 * a)
        idxf = np.arange(n) - d_samp
        i0 = np.clip(np.floor(idxf).astype(np.int64), 0, n - 1)
        i1 = np.clip(i0 + 1, 0, n - 1)
        fr = np.clip(idxf - i0, 0, 1)
        delayed = core[i0] * (1 - fr) + core[i1] * fr
        out[:, ch] = (core * (1 - 0.45 * w) + delayed * (0.55 * w)) * (1 + 0.3 * blend)
    return out

def smoothstep_env(n, T, W):
    e = np.interp(np.arange(n) / SR, T, W)
    return e * e * (3 - 2 * e)

# ── Line cuts + base radio chains ────────────────────────────────────────────
LINES = [
    (0.00, 5.60,  "01_briefing",  "A"),
    (5.65, 10.15, "02_contract",  "A"),
    (10.20, 13.55, "03_generous", "A"),
    (13.60, 20.30, "04_instruct", "A2"),
    (20.35, 22.45, "05_die",      "B"),
    (22.70, 24.35, "06_comeback", "B"),
    (24.40, 28.30, "07_deep",     "C1"),
    (28.35, 36.90, "08_liturgy1", "C2"),
    (36.95, 43.60, "09_liturgy2", "A"),    # CLEAR plain radio after the peak
    (45.45, 47.70, "10_answer1",  "A"),    # clear, plain
    (47.80, 49.80, "11_answer2",  "E2"),   # broken, a little too loud
    (49.90, 56.16, "12_seeshim",  "F"),    # + game corruption below
    (56.20, 59.30, "13_others",   "F"),    # + game corruption below
    (59.45, 64.90, "14_dontname", "F"),    # CLEAR close-dry
    (65.30, 76.40, "15_breathing","BR"),   # + game corruption below
    (76.45, 87.20, "16_button",   "A"),
]

CHAINS = {
    "A":  "highpass=f=300,highpass=f=300,lowpass=f=3000,lowpass=f=3000,"
          "equalizer=f=1800:t=q:w=1.0:g=5,acompressor=threshold=-22dB:ratio=4:attack=4:release=90:makeup=4,"
          "acrusher=bits=9:mode=log:mix=0.3",
    "A2": "highpass=f=320,highpass=f=320,lowpass=f=2800,lowpass=f=2800,"
          "equalizer=f=1800:t=q:w=1.0:g=5,acompressor=threshold=-22dB:ratio=4:attack=4:release=90:makeup=4,"
          "acrusher=bits=9:mode=log:mix=0.35",
    "B":  "highpass=f=340,highpass=f=340,lowpass=f=2600,lowpass=f=2600,"
          "equalizer=f=1700:t=q:w=1.0:g=6,acompressor=threshold=-22dB:ratio=5:attack=4:release=80:makeup=5,"
          "acrusher=bits=8:mode=log:mix=0.4",
    "C1": "highpass=f=360,highpass=f=360,lowpass=f=2500,lowpass=f=2500,"
          "equalizer=f=1700:t=q:w=1.1:g=6,acompressor=threshold=-22dB:ratio=5:makeup=5,"
          "acrusher=bits=8:mode=log:mix=0.45",
    "C2": "highpass=f=380,highpass=f=380,lowpass=f=2400,lowpass=f=2400,"
          "equalizer=f=1600:t=q:w=1.2:g=7,acompressor=threshold=-22dB:ratio=6:makeup=6,"
          "acrusher=bits=7:mode=log:mix=0.5",
    # E2: the shout — broken transmission, a little too loud (tremolo is
    # mono-symmetric; no stereo trickery)
    "E2": "volume=13dB,aresample=9000,aresample=44100,"
          "acrusher=bits=4:mode=log:mix=0.8,tremolo=f=13:d=0.5,"
          "highpass=f=280,highpass=f=280,lowpass=f=3200,lowpass=f=3200,"
          "equalizer=f=1500:t=q:w=1.0:g=7,alimiter=limit=0.95",
    # F/BR: the SAME radio as everything else — whispered into the same mic.
    # Intimacy comes from the performance; only the compression/honk relax.
    "F":  "highpass=f=300,highpass=f=300,lowpass=f=3000,lowpass=f=3000,"
          "equalizer=f=1800:t=q:w=1.0:g=5,acompressor=threshold=-28dB:ratio=4:attack=6:release=150:makeup=6,"
          "acrusher=bits=9:mode=log:mix=0.3,volume=1dB",
    # BR: NOT the transmission. The dragon, breathing. Pitched down a fourth
    # and slowed (asetrate trick), full low end kept, a big dark close space.
    "BR": "asetrate=35280,aresample=44100,lowpass=f=4200,"
          "acompressor=threshold=-32dB:ratio=2:makeup=6,"
          "aecho=0.6:0.4:38|61:0.25|0.18,volume=5dB",
}

for (s, e, lid, stage) in LINES:
    raw = os.path.join(RAW, lid + ".wav")
    fx = os.path.join(FXD, lid + ".wav")
    dur = e - s
    ff("-ss", str(s), "-t", str(dur), "-i", SRC,
       "-af", "afade=t=in:d=0.05,afade=t=out:st=%.3f:d=0.12" % (dur - 0.12), raw)
    ff("-i", raw, "-af", CHAINS[stage], fx)

# ── Corruption envelopes (clip-relative seconds → corruption amount a) ───────
# Rendered ON TOP of the base chain, exactly like the game raising its live
# corruption level. warble rides at 0.9× the corruption unless noted.
CORRUPT = {
    # Performance first — corruption colors the read, it never takes over.
    # (blend = a^2, so these read gentler than the numbers look)
    "02_contract":  ([0, 2.2, 3.3, 4.1, 5.2, 99],               [0, 0, 0.35, 0.4, 0, 0]),
    "04_instruct":  ([0, 2.2, 3.4, 4.4, 5.0, 6.1, 6.7, 99],     [0, 0, 0.15, 0.35, 0.65, 0.65, 0.25, 0]),
    "07_deep":      ([0, 1.3, 2.3, 3.2, 4.2, 99],               [0, 0, 0.3, 0.3, 0, 0]),
    "08_liturgy1":  ([0, 1.0, 3.0, 4.3, 5.9, 7.4, 99],          [0, 0.1, 0.35, 0.7, 0.7, 0, 0]),
    "11_answer2":   ([0, 0.15, 1.85, 2.0, 99],                  [0.35, 0.7, 0.7, 0.35, 0.35]),
    "12_seeshim":   ([0, 0.8, 2.5, 4.0, 5.6, 6.3, 99],          [0.1, 0.4, 0.28, 0.5, 0.4, 0.35, 0.35]),
    "13_others":    ([0, 1.0, 2.4, 3.1, 99],                    [0.3, 0.45, 0.5, 0.35, 0.35]),
    "16_button":    ([0, 4.2, 4.9, 6.4, 7.3, 99],               [0, 0, 0.45, 0.45, 0, 0]),
}
for i, (lid, (T, W)) in enumerate(CORRUPT.items()):
    fxp = os.path.join(FXD, lid + ".wav")
    x = rd_wav(fxp)
    a = smoothstep_env(len(x), T, W)
    y = game_corrupt(x, a, a * 0.9, seed=100 + i)
    mx = np.max(np.abs(y))
    if mx > 0.97: y *= 0.97 / mx
    wwrite(fxp, y)
print("lines cut + processed (game-corruption on: %s)" % ", ".join(CORRUPT))
