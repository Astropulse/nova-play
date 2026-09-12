# NOVA — Trailer Narration Script · "THE CALL" (v3)

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
> use the v1 wording; the previs is cut to it. On re-record (v3 below), the
> pipeline re-derives all cuts, FX and timings — see the clip map.

## Line → mechanic

| Line | The game truth behind it |
| --- | --- |
| "Salvage, survey, self-defense." | the core loop |
| "Take everything." | mining, the scrap economy |
| "Learn. Bargain. Arm yourself." | level-ups · encounters/shops · uncapped builds |
| "If you die out there — come back." | death → FLY AGAIN |
| "If the stars start watching you back" | the dread system — the Eye is a real event |
| "wheels of fire / an angel / the swarm / raise the dead" | the boss chain; the armada is risen ships |
| "they'll send the king in yellow" | the apex boss — you're the next salvage |
| "Keep flying." | motion is life; the run never ends |
| "Don't stop. You have far too much work to do." | same truth, whispered — the run never ends |
| "Your first wave arrives in two minutes." | waveTimer = 120 — literally true |
| "Bring friends." | co-op for eight |

## The descent

Procedure → the smile on "past reason" → the line dies mid-sentence → the
denial protocol → the liturgy → the scream → the whisper that contradicts it →
procedure again, with a schedule.

---

## The script (v3 — 2026-09-11)

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
> If the stars start watching you back, ignore them.
>
> They'll send wheels of fire. They'll send an angel. They'll send the swarm.
> They'll raise the dead. And when nothing comes home, they'll send the king
> in yellow.
>
> Keep flying.
>
> KEEP FLYING. *(the shout)*
>
> He sees you. He's been on the line this whole time. This is how we lost the
> others.
>
> Pilot, listen to me. Don't stop. You have far too much work to do.
>
> *(the breathing)*
>
> A word of advice? Bring friends. Your first wave arrives in two minutes. Good
> luck, pilot.

## Clip map for the re-record (what the pipeline expects)

| clip id | line | stage | corruption |
| --- | --- | --- | --- |
| `01_briefing` | Good morning … is quiet. | radio | clean |
| `02_contract` | Standard contract … self-defense. | radio | tinge on "self-defense" |
| `03_generous` | The dead worlds … Take everything. | radio | clean |
| `04_instruct` | Learn. Bargain. Arm yourself. Past regulation. Past reason. | radio | builds slowly from "past regulation" into "past reason" |
| `05_die` | If you die out there — | radio | clean, cut by the tear |
| `06_comeback` | — come back. | radio (re-keyed) | clean |
| `07_stars` | If the stars start watching you back, ignore them. | omen | a tinge |
| `08_liturgy1` | They'll send wheels … They'll raise the dead. | liturgy | builds to "raise the dead" |
| `09_liturgy2` | And when nothing comes home, they'll send the king in yellow. | liturgy | settles by "home", clear on the king |
| `10_keep1` | Keep flying. | quiet | clear |
| `11_keep2` | KEEP FLYING. | shout | heavy, broken |
| `12_sees` | He sees you. He's been on the line this whole time. | whisper | waves |
| `13_others` | This is how we lost the others. | whisper | waves |
| `14_dontstop` | Pilot, listen to me. Don't stop. You have far too much work to do. | whisper | clear |
| `15_breathing` | (the dragon) | off-radio, pitched down | none |
| `16_button` | A word of advice? Bring friends. Your first wave … Good luck, pilot. | radio | clean |

Picture beats that move with v3: the king's face-to-face hold is now wordless
(the stop lands after "king in yellow"); "Keep flying." / "KEEP FLYING." sit
over the king's last phase; "He sees you … lost the others" over the dragon
approach and arrival; "Don't stop … work to do" over the stillness and the
pulse; the 1–8 PLAYERS beat stays on "Bring friends".

## Alternates

- "ignore them" → "If an eye opens out there — you didn't see it."
- "Your first wave arrives in two minutes." → "First wave in two minutes."

## Delivery notes

The filter decay is the descent: clean radio → static → bare voice → clean
again. The liturgy stays level. The shout distorts the mic. The previs shot
map holds; the king's face-to-face hold is wordless in v3 — the stop lands
right after "king in yellow".

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
reason", the liturgy build into "raise the dead", the KEEP FLYING shout, and
the whisper waves (see the clip map).
