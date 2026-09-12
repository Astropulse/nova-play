# -*- coding: utf-8 -*-
# Build the kinetic-subtitle track for the previs: per-word display times on
# the assembled-narration clock, with a style stage per clip and a corruption
# weight per word (sampled from the same CORRUPT envelopes as the audio).
# Output: scripts/trailer/subtitles.json  [{t,end,w,stage,fx,hl}]
import ast, json, re, os

HERE = os.path.dirname(os.path.abspath(__file__))

def extract_block(src, name):
    i = src.index(name + ' = ')
    j = src.index('[' if src[i + len(name) + 3] == '[' else '{', i)
    depth = 0
    for k in range(j, len(src)):
        if src[k] in '[{': depth += 1
        elif src[k] in ']}':
            depth -= 1
            if depth == 0:
                block = src[j:k+1]
                block = re.sub(r'#.*', '', block)
                return eval(block, {"__builtins__": {}}, {})
    raise ValueError(name)

bfx = open(os.path.join(HERE, 'build_vo_fx.py'), encoding='utf-8').read()
asm = open(os.path.join(HERE, 'assemble_demo.py'), encoding='utf-8').read()
LINES = extract_block(bfx, 'LINES')
CORRUPT = extract_block(bfx, 'CORRUPT')
PLACE = dict((lid, at) for at, lid in extract_block(asm, 'PLACE'))
PLACE['15_breathing'] = 65.72  # placed separately (the dragon)
T0 = 2.5   # the cold open (assemble_demo.py T0)

STAGE = {
    '01_briefing': 'radio', '02_contract': 'radio', '03_generous': 'radio',
    '04_instruct': 'radio', '05_die': 'radio', '06_comeback': 'radio',
    '07_deep': 'omen', '08_liturgy1': 'liturgy', '09_liturgy2': 'liturgy',
    '10_answer1': 'quiet', '11_answer2': 'shout',
    '12_seeshim': 'whisper', '13_others': 'whisper', '14_dontname': 'whisper',
    '16_button': 'radio',
    # v3 clip ids (TRAILER-SCRIPT.md clip map)
    '07_stars': 'omen', '10_keep1': 'quiet', '11_keep2': 'shout',
    '12_sees': 'whisper', '14_dontstop': 'whisper',
}
HL = {'wheels', 'fire,', 'fire', 'angel,', 'angel', 'swarm,', 'swarm', 'dead',
      'king', 'yellow', 'spark', 'name.', 'heads,', 'heads.', 'seven',
      'flying.', 'flying', 'others.', 'work', 'friends.', 'friends,', 'watching'}

def env_at(lid, t_clip):
    if lid not in CORRUPT: return 0.0
    T, W = CORRUPT[lid]
    # linear interp
    for i in range(1, len(T)):
        if t_clip <= T[i]:
            f = (t_clip - T[i-1]) / max(1e-6, T[i] - T[i-1])
            return W[i-1] + (W[i] - W[i-1]) * max(0, min(1, f))
    return W[-1]

def load_words(name):
    tr = json.load(open(os.path.join(HERE, 'review', name), encoding='utf-8'))
    out = []
    for seg in tr:
        for w in seg['words']:
            out.append((w['s'], w['e'], w['w'].strip().replace('Pilate', 'Pilot')))   # whisper's ear
    return out
WORDS1 = load_words('narration_transcript.json')
WORDS2 = load_words('narration2_transcript.json')

out = []
for entry in LINES:
    cin, cout, lid, stage_chain = entry[:4]
    words = WORDS2 if (len(entry) > 4 and entry[4] == 'N2') else WORDS1
    if lid not in PLACE or lid == '15_breathing':
        continue
    at = PLACE[lid] + T0
    for (ws, we, txt) in words:
        if ws >= cin - 0.05 and ws < cout - 0.1:
            t = round(at + (ws - cin), 3)
            end = round(at + (we - cin), 3)
            mid = (ws + we) / 2 - cin
            out.append({
                't': t, 'end': max(end, t + 0.12), 'w': txt,
                'stage': STAGE.get(lid, 'radio'),
                'fx': round(env_at(lid, mid), 2),
                'hl': 1 if txt.lower().strip('.,!?') in {h.strip('.,') for h in HL} else 0,
                'clip': lid,
            })
out.sort(key=lambda x: x['t'])
json.dump(out, open(os.path.join(HERE, 'subtitles.json'), 'w', encoding='utf-8'))
print('subtitles.json:', len(out), 'words;',
      'stages:', sorted(set(o['stage'] for o in out)))
print('sample:', out[0], out[-1])
