# NOVA — Trailer Narration Script · "THE CALL" (v2 — grounded)

**Frame:** a dispatcher's transmission to the pilot — you — that loses its mind
in stages. Same descent, same pacing scaffold as the recorded take; the
abstract mysticism is gone. **Every line now points at a real mechanic** — the
climax device is no longer a mystery ("its name") but the game's own truths:
the wave timer, the salvage economy, the endless run.

**The thesis:** everything out there that kills you was a ship like yours. The
locusts drain your loot, the dead fly again as the armada, and the King
collects what's left. There is no destination and the countdown never stops —
you fly anyway. *You are the next salvage. Keep flying.*

> The currently recorded take (`Narration.wav`) and `narration-fx-demo.wav`
> use the v1 wording. On re-record, the pipeline below re-derives all cuts,
> FX and timings automatically.

## Line → mechanic

| Line | The game truth behind it |
| --- | --- |
| "Salvage, survey, self-defense." | the core loop |
| "Take everything." | mining, the scrap economy |
| "Learn. Bargain. Arm yourself." | level-ups · encounters/shops · uncapped builds |
| "If you die out there — come back." | death → FLY AGAIN |
| "If the stars start watching you back" | the dread system — the Eye is a real event |
| "wheels of fire / an angel / the locusts / raise the dead" | the boss chain; the armada is risen ships |
| "the King in Yellow comes to collect" | the apex boss — you're the next salvage |
| "Keep flying." | motion is life; the run never ends |
| "Don't stop." | same truth, whispered |
| "Your first wave arrives in two minutes." | waveTimer = 120 — literally true |
| "The beast out there has seven heads." | the Dragon; bring friends — co-op for eight |

## The descent

Procedure → the smile on "past reason" → the line dies mid-sentence → the
denial protocol → the liturgy → the scream → the whisper that contradicts it →
procedure again, with a schedule.

---

## The script

*Radio starts clean, degrades to nothing by the whisper, comes back clean at
the end. Lines only — the read is the edit.*

> Good morning, pilot. This is Dispatch. Your route is charted. The dark out
> there is quiet.
>
> Standard contract. Salvage, survey, self-defense.
>
> The dead worlds are generous, pilot. Take everything.
>
> Learn. Bargain. Arm yourself. Past regulation. Past reason.
>
> If you die out there — *(cut by the explosion)* — come back.
>
> If the stars start watching you back, ignore them. That's normal now.
>
> They'll send wheels of fire. They'll send an angel. They'll send the locusts.
> They'll raise the dead. And when nothing comes home, the King in Yellow comes
> to collect.
>
> Keep flying.
>
> KEEP FLYING. *(the shout)*
>
> Do you see him? He sees you. He's been on the line this whole time. This is
> where the others went.
>
> Pilot, listen to me. Don't stop. Don't you dare stop.
>
> *(the breathing)*
>
> A word of advice? Bring friends. The beast out there has seven heads. Your
> first wave arrives in two minutes. Good luck, pilot.

## Alternates

- "ignore them" → "If an eye opens out there — you didn't see it."
- "comes to collect." → "comes to collect the wrecks. And the pilots."
- "Don't stop." → "Don't stop moving."
- "Your first wave arrives in two minutes." → "First wave in two minutes."

## Delivery notes

The filter decay is the descent: clean radio → static → bare voice → clean
again. The liturgy stays level. The shout distorts the mic. The previs shot
map holds; the kingface shot now lands on "comes to collect."

## Pipeline (after re-recording)

1. Drop the new take at `scripts/trailer/Narration.wav`.
2. `python scripts/trailer/transcribe_vo.py` → word timings.
3. Update `LINES` cut windows in `build_vo_fx.py` from the printed onsets
   (same clip ids — FX stages carry over; retune `CORRUPT` envelope times to
   the new word positions).
4. `python scripts/trailer/build_vo_fx.py && python scripts/trailer/assemble_demo.py`
   (retime `PLACE` to the new measured speech onsets, same directed gaps).
5. Retime via `retime.py` (the one clock: air + info cards), carry its numbers
   into `director.js` / `mix_gamesfx.py` / `mix_music.py`; re-render (README §2).

The radio dramaturgy (clicks, keyed beds, the tear, dragon breathing off-radio)
and the corruption leak map carry over 1:1 — the leaks belong on: "past
reason", the liturgy build into "raise the dead", the "collect" landing, and
"the beast out there has seven heads".
