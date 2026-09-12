# -*- coding: utf-8 -*-
# v4 timeline planner: maps every event on the v3 clock (98.5 s) onto the v4
# clock — per-scene LEAD (air before the line) and TAIL (air after it), plus
# CRAWL-style info cards inserted between sequences. Prints the numbers that
# assemble_demo.py / director.js / mix_gamesfx.py were patched with, so the
# whole chain is re-derivable from this one table.
#
#   python scripts/trailer/retime.py
#
# OLD is the v3 cut: (scene, old cut point). A scene's old span runs to the
# next cut point. Cut points were moved where a line started a hair before
# its picture (omen, seraph, hive, skirmish) so the word lives in its scene.
OLD = [
    ('black',      0.00),
    ('drift',      0.35),
    ('salvage',    6.29),
    ('skirmish',   9.30),   # was 10.79 — "self defense" now cuts to the skirmish
    ('learn',     15.66),
    ('bargain',   16.60),
    ('arm',       17.64),
    ('dies',      25.14),
    ('return',    28.75),
    ('omen',      32.00),   # was 32.32 — "You hear it" lives in the omen
    ('wheels',    35.23),
    ('seraph',    37.30),   # was 37.55
    ('hive',      38.55),   # was 38.87
    ('bones',     39.65),
    ('kingcomes', 44.85),
    ('kingface',  46.33),
    ('blackhold', 49.40),
    ('answer',    51.70),
    ('seeshim',   57.25),
    ('others',    62.13),
    ('dontname',  65.73),
    ('dragoneyes',72.78),
    ('black2',    85.30),
    ('button',    87.29),   # split off the old title: black + panel + the co-op card
    ('title',     90.40),
    ('END',       98.50),
]
# lead / tail air per scene (seconds), and cards inserted AFTER a scene
AIR = {
    'drift':     (0.0, 0.6),
    'salvage':   (1.0, 0.5),
    'skirmish':  (0.3, 0.0),
    'learn':     (0.5, 0.4),
    'bargain':   (0.5, 0.5),
    'arm':       (0.3, 1.7),
    'dies':      (0.6, 0.4),
    'return':    (0.5, 0.6),
    'omen':      (0.6, 0.5),
    'wheels':    (0.4, 0.9),
    'seraph':    (0.3, 1.0),
    'hive':      (0.3, 1.2),
    'bones':     (0.4, 0.0),
    'kingcomes': (0.0, 0.9),
    'kingface':  (0.3, 0.3),
    'blackhold': (0.0, 0.5),
    'answer':    (0.8, 1.2),
    'seeshim':   (0.7, 0.3),
    'others':    (0.3, 0.4),
    'dontname':  (0.3, 0.0),
    'button':    (0.0, 0.9),
    'title':     (0.0, 1.5),
}
CARDS = {   # after-scene -> (card scene name, length)
    'skirmish': ('card_upgrades', 1.5),
    'dies':     ('card_die', 1.5),
    'omen':     ('card_gods', 1.5),
}

# build the new timeline
scenes = []   # (name, new_start, new_len, old_start, old_len, lead)
t = 0.0
for i in range(len(OLD) - 1):
    name, c0 = OLD[i]; c1 = OLD[i + 1][1]
    lead, tail = AIR.get(name, (0.0, 0.0))
    ln = lead + (c1 - c0) + tail
    scenes.append((name, t, ln, c0, c1 - c0, lead))
    t += ln
    if name in CARDS:
        cn, cl = CARDS[name]
        scenes.append((cn, t, cl, None, 0, 0))
        t += cl
TOTAL = t

def m(told):
    """old clock -> new clock"""
    for (name, ns, nl, os_, ol, lead) in scenes:
        if os_ is None: continue
        if os_ <= told < os_ + ol or (told == os_ + ol and told == 98.5):
            return ns + lead + (told - os_)
    raise ValueError(told)

# ── v4b re-cut (director.js is the source of truth for these) ────────────────
# The per-scene AIR model above is only exact for lines that live inside ONE
# scene. A clip that spans several scenes (04_instruct over learn/bargain/arm,
# 08_liturgy1 over wheels/seraph/hive/bones) can't stretch, so those scenes
# were re-cut to the v4 WORD times (subtitles.json) with a ~0.3 s picture lead,
# keeping each group's total. The death now happens inside the arm fight
# (no 'dies' scene). Resulting records (sum still 125.40):
RECUT = {   # v4c
    'skirmish': 6.16, 'card_upgrades': 2.00,                      # 11.40 / 17.56 → learn 19.56
    'learn': 1.54, 'bargain': 1.00, 'arm': 16.95,                 # 19.56 / 21.10 / 22.10 → return 39.05 (death 35.0, real death screen from 36.6)
    'wheels': 2.27, 'seraph': 1.25, 'hive': 1.25,                 # 49.23 / 51.50 / 52.75
    'bones': 11.00,                                               # 54.00: raise the dead 54.47 → stillness 55.4 → the king enters 59.0
    'kingface': 4.40,                                             # 65.00 → 69.40
    'answer': 7.18,                                               # 69.40: the king's last phase (no black) → the drop 76.58
    'montage': 24 * 0.56616,                                      # 76.58: 16 shots on the eruption's beat (106 bpm) → the bar at 90.17
    'dragoncomes': 17.53,                                         # 90.17: approach; the dragon's cinematic starts 96.72 → pentagram at the cut 107.70
}
# v4d: everything after the scream sits +10.42 s later than the v4 table above
# (narration PLACE for 12/13/14/breathing/16, clicks, the button bed, the SFX
# duck, breath.json t0, the music's ACT 3/4). TOTAL = 135.82.

if __name__ == '__main__':
    print('TOTAL %.2f s' % TOTAL)
    print('\nSCENES (name, record, new start):')
    for (name, ns, nl, os_, ol, lead) in scenes:
        print('  %-14s record %5.2f  @ %6.2f   (old %s len %.2f lead %.1f)' % (name, nl, ns, os_, ol, lead))
    PLACE = [(0.92, '01_briefing'), (6.50, '02_contract'), (10.95, '03_generous'), (15.86, '04_instruct'),
             (25.33, '05_die'), (28.83, '06_comeback'), (31.94, '07_deep'), (35.44, '08_liturgy1'),
             (43.40, '09_liturgy2'), (51.52, '10_answer1'), (53.73, '11_answer2'), (56.99, '12_seeshim'),
             (62.61, '13_others'), (65.84, '14_dontname'), (85.99, '16_button')]
    print('\nPLACE:')
    for at, lid in PLACE: print('    (%6.2f, "%s"),' % (m(at), lid))
    print('  breathing 71.52 ->', '%.2f' % m(71.52))
    print('\nCLICKS:')
    for nm, at in [('on', 0.55), ('off', 26.66), ('burst', 26.68), ('on', 28.75), ('off', 30.15), ('on', 32.35),
                   ('off', 49.30), ('on', 51.70), ('on', 87.34), ('off', 95.70)]:
        print('    %-5s %6.2f -> %6.2f' % (nm, at, m(at)))
    print('\nBEDS (start,end):')
    for nm, a, b in [('briefing', 0.56, 26.66), ('rekey', 28.76, 30.20), ('liturgy', 32.36, 49.30),
                     ('crackle', 35.30, 43.90), ('whine', 37.00, 43.50), ('answers', 51.71, 54.91), ('button', 87.35, 95.75)]:
        print('    %-9s %6.2f-%6.2f -> %6.2f-%6.2f' % (nm, a, b, m(a), m(b)))
    print('\nFLASHES: tear %.2f  shout %.2f' % (m(26.60), m(53.99)))
    print('DUCK: (%.2f, %.2f) (%.2f, %.2f)' % (m(49.40), m(51.70), m(72.78), m(87.29)))
    print('WORDS: bring %.2f  beast %.2f  luck %.2f  self %.2f  Learn %.2f  You(omen) %.2f  Do(seeshim) %.2f' % (
        m(89.02), m(90.70), m(92.66), m(9.69), m(16.04), m(32.20), m(57.25)))
# v5 (2026-09-11): a 2.5 s cold open (T0) shifts the whole clock; the black card is gone (drift = the
# opener, record 9.39); the wing holds 7.60 s until the narrator is done, the end card 9.19. TOTAL = 141.5.
