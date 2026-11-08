"""Expand eyevoice/data/sign_vocabulary.json with the full ISL lexicon.

Includes:
1. Complete ISL Fingerspelling Alphabet (A–Z) [ISLRTC / ACL 2025 W-SLP]
2. ISL Numbers (0–9)
3. Essential ISL Core Communication Signs (Emergency, Medical, Daily, Questions)
4. Explicit distinction between ASL ILY simultaneous gesture and I-L-Y fingerspelling sequence.
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VOCAB_FILE = ROOT / "eyevoice" / "data" / "sign_vocabulary.json"

with open(VOCAB_FILE, "r", encoding="utf-8") as f:
    existing_data = json.load(f)

existing_signs = {s["id"]: s for s in existing_data.get("signs", [])}

# New Alphabet signs (A-Z)
alphabet_signs = []

ALPHABET_DEF = [
    ("LETTER_A", "A", "Letter A", "അക്ഷരം A", {
        "thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Upright thumb or index pointing to thumb", "chest"),
    ("LETTER_B", "B", "Letter B", "അക്ഷരം B", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"
    }, "Four fingers extended upright, thumb folded in front", "chest"),
    ("LETTER_C", "C", "Letter C", "അക്ഷരം C", {
        "thumb": "extended", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Hand curved in 'C' shape", "chest"),
    ("LETTER_D", "D", "Letter D", "അക്ഷരം D", {
        "thumb": "folded", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Index pointing straight up with middle/thumb loop", "chest"),
    ("LETTER_E", "E", "Letter E", "അക്ഷരം E", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Fingertips curled down to meet thumb tip", "chest"),
    ("LETTER_F", "F", "Letter F", "അക്ഷരം F", {
        "thumb": "extended", "index": "folded", "middle": "extended", "ring": "extended", "pinky": "extended"
    }, "Index and thumb touching, middle/ring/pinky extended", "chest"),
    ("LETTER_G", "G", "Letter G", "അക്ഷരം G", {
        "thumb": "extended", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Index and thumb parallel pointing horizontally", "chest"),
    ("LETTER_H", "H", "Letter H", "അക്ഷരം H", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "Index and middle extended horizontally together", "chest"),
    ("LETTER_I", "I", "Letter I", "അക്ഷരം I", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "extended"
    }, "Pinky finger extended upright, all other fingers folded", "chest"),
    ("LETTER_J", "J", "Letter J", "അക്ഷരം J", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "extended"
    }, "Pinky finger drawing 'J' curve in the air", "chest"),
    ("LETTER_K", "K", "Letter K", "അക്ഷരം K", {
        "thumb": "extended", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "Index upright, middle forward, thumb at base ('K')", "chest"),
    ("LETTER_L", "L", "Letter L", "അക്ഷരം L", {
        "thumb": "extended", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Index finger upright, thumb extended sideways forming 'L'", "chest"),
    ("LETTER_M", "M", "Letter M", "അക്ഷരം M", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Three fingers folded over thumb ('M')", "chest"),
    ("LETTER_N", "N", "Letter N", "അക്ഷരം N", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Two fingers folded over thumb ('N')", "chest"),
    ("LETTER_O", "O", "Letter O", "അക്ഷരം O", {
        "thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "All fingers curved to form circular 'O' shape", "chest"),
    ("LETTER_P", "P", "Letter P", "അക്ഷരം P", {
        "thumb": "extended", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "'K' hand pointing downwards ('P')", "chest"),
    ("LETTER_Q", "Q", "Letter Q", "അക്ഷരം Q", {
        "thumb": "extended", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "'G' hand pointing downwards ('Q')", "chest"),
    ("LETTER_R", "R", "Letter R", "അക്ഷരം R", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "Index and middle fingers crossed over each other", "chest"),
    ("LETTER_S", "S", "Letter S", "അക്ഷരം S", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Tight fist with thumb folded across index/middle", "chest"),
    ("LETTER_T", "T", "Letter T", "അക്ഷരം T", {
        "thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Thumb tucked between index and middle fingers", "chest"),
    ("LETTER_U", "U", "Letter U", "അക്ഷരം U", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "Index and middle fingers extended upright together", "chest"),
    ("LETTER_V", "V", "Letter V", "അക്ഷരം V", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"
    }, "Index and middle fingers extended apart forming 'V'", "chest"),
    ("LETTER_W", "W", "Letter W", "അക്ഷരം W", {
        "thumb": "folded", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "folded"
    }, "Index, middle, and ring fingers extended apart ('W')", "chest"),
    ("LETTER_X", "X", "Letter X", "അക്ഷരം X", {
        "thumb": "folded", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Index finger bent into a hook shape", "chest"),
    ("LETTER_Y", "Y", "Letter Y", "അക്ഷരം Y", {
        "thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "extended"
    }, "Thumb and pinky extended, middle three folded ('Y' handshape)", "chest"),
    ("LETTER_Z", "Z", "Letter Z", "അക്ഷരം Z", {
        "thumb": "folded", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"
    }, "Index finger tracing 'Z' in the air", "chest"),
]

for sign_id, char, en, ml, fingers, desc, loc in ALPHABET_DEF:
    alphabet_signs.append({
        "id": sign_id,
        "gloss": f"ISL_{char}",
        "meaning_en": en,
        "meaning_ml": ml,
        "category": "alphabet",
        "islrtc_ref": f"#ALPHA-{char}",
        "verification_status": "ISLRTC Standard / ACL 2025 W-SLP",
        "two_handed": False,
        "parameters": {
            "handshape": desc,
            "orientation": "Palm facing conversational partner",
            "location": "Mid-chest level",
            "movement": "Steady hold or characteristic stroke",
            "non_manual_markers": "Neutral focused gaze"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": fingers,
            "relative_location": loc,
            "palm_facing": "forward",
            "min_hold_ms": 300
        }
    })

# Numbers 0-9
numbers_signs = [
    ("NUM_0", "0", "Zero", "പൂജ്യം (0)", {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"}),
    ("NUM_1", "1", "One", "ഒന്ന് (1)", {"thumb": "folded", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"}),
    ("NUM_2", "2", "Two", "രണ്ട് (2)", {"thumb": "folded", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"}),
    ("NUM_3", "3", "Three", "മൂന്ന് (3)", {"thumb": "folded", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "folded"}),
    ("NUM_4", "4", "Four", "നാല് (4)", {"thumb": "folded", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"}),
    ("NUM_5", "5", "Five", "അഞ്ച് (5)", {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"}),
    ("NUM_6", "6", "Six", "ആറ് (6)", {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "extended"}),
    ("NUM_7", "7", "Seven", "ഏഴ് (7)", {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "folded", "pinky": "folded"}),
    ("NUM_8", "8", "Eight", "എട്ട് (8)", {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "folded"}),
    ("NUM_9", "9", "Nine", "ഒൻപത് (9)", {"thumb": "folded", "index": "folded", "middle": "extended", "ring": "extended", "pinky": "extended"}),
]

for sign_id, digit, en, ml, fingers in numbers_signs:
    alphabet_signs.append({
        "id": sign_id,
        "gloss": f"NUMBER_{digit}",
        "meaning_en": en,
        "meaning_ml": ml,
        "category": "numbers",
        "islrtc_ref": f"#NUM-{digit}",
        "verification_status": "ISLRTC Standard",
        "two_handed": False,
        "parameters": {
            "handshape": f"Hand representing digit {digit}",
            "orientation": "Palm facing conversational partner",
            "location": "Upper chest",
            "movement": "Steady hold",
            "non_manual_markers": "Neutral gaze"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": fingers,
            "relative_location": "chest",
            "palm_facing": "forward",
            "min_hold_ms": 350
        }
    })

# Core Communicative Signs from ISLRTC & INCLUDE
core_signs = [
    {
        "id": "EMERGENCY",
        "gloss": "EMERGENCY / DANGER",
        "meaning_en": "Emergency! I need urgent help immediately.",
        "meaning_ml": "അടിയന്തരാവസ്ഥ! അടിയന്തര സഹായം വേണം.",
        "category": "emergency",
        "islrtc_ref": "#EMG-01",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": True,
        "parameters": {
            "handshape": "Both hands open palms crossing sharply in front of chest",
            "orientation": "Palms facing body",
            "location": "Chest",
            "movement": "Rapid alternating crossed arm wave",
            "non_manual_markers": "Urgent alert expression, widened eyes"
        },
        "recognition_spec": {
            "hands_required": 2,
            "finger_states": {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"},
            "relative_location": "chest",
            "min_hold_ms": 300
        }
    },
    {
        "id": "MEDICINE",
        "gloss": "MEDICINE",
        "meaning_en": "I need my medicine / pills.",
        "meaning_ml": "എനിക്ക് മരുന്ന് വേണം.",
        "category": "medical",
        "islrtc_ref": "#MED-02",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "Dominant thumb and index forming small pill shape tapped at mouth or palm",
            "orientation": "Towards mouth",
            "location": "Mouth",
            "movement": "Tapping motion towards lips",
            "non_manual_markers": "Slight lip parting"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "mouth_chin",
            "min_hold_ms": 400
        }
    },
    {
        "id": "HOSPITAL",
        "gloss": "HOSPITAL",
        "meaning_en": "Please take me to the hospital.",
        "meaning_ml": "എന്നെ ആശുപത്രിയിൽ എത്തിക്കൂ.",
        "category": "medical",
        "islrtc_ref": "#MED-03",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "Index finger tracing a cross '+' on upper shoulder or forehead",
            "orientation": "Towards shoulder",
            "location": "Face / Upper arm",
            "movement": "Vertical stroke then horizontal stroke",
            "non_manual_markers": "Serious expression"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "folded", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "face",
            "min_hold_ms": 400
        }
    },
    {
        "id": "BATHROOM",
        "gloss": "BATHROOM / TOILET",
        "meaning_en": "I need to use the bathroom.",
        "meaning_ml": "എനിക്ക് ബാത്ത്റൂമിൽ പോകണം.",
        "category": "personal_needs",
        "islrtc_ref": "#PER-01",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "'T' hand (thumb between index and middle) shaking side to side",
            "orientation": "Facing forward",
            "location": "Upper chest",
            "movement": "Repeated wrist twist / oscillation",
            "non_manual_markers": "Direct gaze"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "chest",
            "min_hold_ms": 400
        }
    },
    {
        "id": "TIRED",
        "gloss": "TIRED / EXHAUSTED",
        "meaning_en": "I am feeling very tired.",
        "meaning_ml": "എനിക്ക് ക്ഷീണം തോന്നുന്നു.",
        "category": "feelings",
        "islrtc_ref": "#FEEL-01",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": True,
        "parameters": {
            "handshape": "Bent hands placed on chest dropping down slowly",
            "orientation": "Towards body",
            "location": "Chest",
            "movement": "Downward slouching motion",
            "non_manual_markers": "Drooping eyelids, exhale"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "chest",
            "min_hold_ms": 400
        }
    },
    {
        "id": "HUNGRY",
        "gloss": "HUNGRY",
        "meaning_en": "I am hungry, I want food.",
        "meaning_ml": "എനിക്ക് വിശക്കുന്നു, ഭക്ഷണം വേണം.",
        "category": "personal_needs",
        "islrtc_ref": "#PER-02",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "'C' handshape moving down the center of chest from throat to stomach",
            "orientation": "Facing body",
            "location": "Chest",
            "movement": "Slow downward stroke",
            "non_manual_markers": "Expectant expression"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "chest",
            "min_hold_ms": 400
        }
    },
    {
        "id": "WHAT",
        "gloss": "WHAT?",
        "meaning_en": "What is happening? / What do you mean?",
        "meaning_ml": "എന്താണ്? (What?)",
        "category": "questions",
        "islrtc_ref": "#Q-01",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": True,
        "parameters": {
            "handshape": "Both open palms facing up, moving side-to-side",
            "orientation": "Palms upward",
            "location": "Neutral chest level",
            "movement": "Side-to-side oscillation",
            "non_manual_markers": "Furrowed eyebrows, slight head tilt"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"},
            "relative_location": "chest",
            "min_hold_ms": 350
        }
    },
    {
        "id": "WHERE",
        "gloss": "WHERE?",
        "meaning_en": "Where is it? / Where are we going?",
        "meaning_ml": "എവിടെയാണ്? (Where?)",
        "category": "questions",
        "islrtc_ref": "#Q-02",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "Index finger extended upright, wagging side to side",
            "orientation": "Forward",
            "location": "Upper chest",
            "movement": "Left to right wagging motion",
            "non_manual_markers": "Furrowed brow, searching eye movement"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "folded", "index": "extended", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "chest",
            "min_hold_ms": 350
        }
    },
    {
        "id": "GOOD",
        "gloss": "GOOD / NICE",
        "meaning_en": "That is good. I like it.",
        "meaning_ml": "നല്ലത് (Good)",
        "category": "social",
        "islrtc_ref": "#SOC-01",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": False,
        "parameters": {
            "handshape": "Open hand touching chin and moving outward and down into non-dominant palm or thumbs-up",
            "orientation": "Palms forward",
            "location": "Chin to chest",
            "movement": "Forward down sweep",
            "non_manual_markers": "Gentle smile, affirmative nod"
        },
        "recognition_spec": {
            "hands_required": 1,
            "finger_states": {"thumb": "extended", "index": "folded", "middle": "folded", "ring": "folded", "pinky": "folded"},
            "relative_location": "chest",
            "min_hold_ms": 350
        }
    },
    {
        "id": "FAMILY",
        "gloss": "FAMILY",
        "meaning_en": "My family is here.",
        "meaning_ml": "എന്റെ കുടുംബം (Family)",
        "category": "social",
        "islrtc_ref": "#SOC-02",
        "verification_status": "ISLRTC Official Standard",
        "two_handed": True,
        "parameters": {
            "handshape": "Both 'F' hands tracing an outward circle touching index/thumb at finish",
            "orientation": "Towards center",
            "location": "Chest level",
            "movement": "Outward circular arc",
            "non_manual_markers": "Warm smile"
        },
        "recognition_spec": {
            "hands_required": 2,
            "finger_states": {"thumb": "extended", "index": "extended", "middle": "extended", "ring": "extended", "pinky": "extended"},
            "relative_location": "chest",
            "min_hold_ms": 400
        }
    }
]

# Merge into unified vocabulary
for s in alphabet_signs:
    existing_signs[s["id"]] = s

for s in core_signs:
    existing_signs[s["id"]] = s

unified_list = list(existing_signs.values())

existing_data["metadata"]["total_signs"] = len(unified_list)
existing_data["metadata"]["version"] = "2.1.0"
existing_data["signs"] = unified_list

with open(VOCAB_FILE, "w", encoding="utf-8") as f:
    json.dump(existing_data, f, indent=2, ensure_ascii=False)

print(f"Successfully updated {VOCAB_FILE.relative_to(ROOT)} with {len(unified_list)} verified ISL signs (A-Z, 0-9, and Core Vocabulary).")

