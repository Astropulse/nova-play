import json, sys
from faster_whisper import WhisperModel

SRC = r"D:\Art\Astropulse\RetroDiffusion\Examples\Game\Nova\scripts\trailer\Narration.wav"
OUT = r"D:\Art\Astropulse\RetroDiffusion\Examples\Game\Nova\scripts\trailer\review\narration_transcript.json"

model = WhisperModel("small.en", device="cpu", compute_type="int8")
segments, info = model.transcribe(SRC, word_timestamps=True, beam_size=5)

out = []
for seg in segments:
    words = [{"w": w.word, "s": round(w.start, 3), "e": round(w.end, 3)} for w in (seg.words or [])]
    out.append({"s": round(seg.start, 3), "e": round(seg.end, 3), "text": seg.text.strip(), "words": words})
    print(f"[{seg.start:7.2f} - {seg.end:7.2f}] {seg.text.strip()}")

json.dump(out, open(OUT, "w", encoding="utf-8"), indent=1)
print("\nsaved", OUT, "duration", round(info.duration, 2))
