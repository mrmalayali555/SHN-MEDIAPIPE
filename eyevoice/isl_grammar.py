"""Indian Sign Language (ISL) Linguistic Grammar Interpretation Engine.

Translates sequences of Indian Sign Language signs (glosses) into fluent,
grammatically correct spoken English based on peer-reviewed ISL linguistic research:
- Indian Sign Language Research and Training Centre (ISLRTC)
- Samar Sinha (2018), "Indian Sign Language: A Linguistic Analysis of Its Grammar"

Key ISL Grammar Features Handled:
1. SOV (Subject-Object-Verb) and Topic-Comment sentence structures.
2. Time-Topic-Comment ordering (Time adverbials at sentence-initial position).
3. Sentence-final Wh-question placement with non-manual markers (furrowed brow).
4. Polar (Yes/No) interrogatives marked non-manually (raised eyebrows).
5. Post-verbal and sentence-final negation accompanied by headshake.
6. Directional and spatial verbs (GIVE-ME, HELP-ME, TELL-ME).
7. Aspectual markers (FINISH for completion, NOT-YET for incompleted action).
8. Complex compound expressions of inner thoughts, feelings, and symptoms.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
SIGNS_FILE = ROOT / "data" / "isl_signs.json"


@dataclass
class InterpretationResult:
    sentence: str
    isl_gloss: str
    syntax_type: str
    semantic_roles: dict[str, Any] = field(default_factory=dict)
    confidence: float = 0.95
    alternatives: list[str] = field(default_factory=list)
    clarification_prompt: str | None = None
    is_question: bool = False
    is_negated: bool = False
    is_emergency: bool = False


class ISLGrammarInterpreter:
    def __init__(self, data_file: Path | None = None):
        self.data_file = data_file or SIGNS_FILE
        self.signs_map: dict[str, dict] = {}
        self._load_signs()

    def _load_signs(self) -> None:
        if self.data_file.exists():
            with open(self.data_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                for s in data.get("signs", []):
                    self.signs_map[s["id"]] = s
                    # also map gloss uppercase
                    gloss_key = s["gloss"].split()[0].upper()
                    self.signs_map[gloss_key] = s

    def get_sign(self, token: str) -> dict | None:
        clean = token.strip().upper()
        if clean in self.signs_map:
            return self.signs_map[clean]
        # try removing parens
        if "(" in clean:
            base = clean.split("(")[0].strip()
            if base in self.signs_map:
                return self.signs_map[base]
        return None

    def interpret(self, tokens: list[str]) -> InterpretationResult:
        """Interpret a sequence of ISL sign tokens into natural English."""
        if not tokens:
            return InterpretationResult(
                sentence="",
                isl_gloss="",
                syntax_type="Empty",
                confidence=1.0,
            )

        # Normalize tokens
        clean_tokens = [t.strip().upper() for t in tokens if t.strip()]
        isl_gloss = " ".join(clean_tokens)

        # 1. Check for idiomatic / high-priority conversational patterns
        idiom_res = self._match_idiomatic_patterns(clean_tokens)
        if idiom_res:
            return idiom_res

        # 2. Deconstruct sequence into semantic and grammatical roles
        roles = self._parse_semantic_roles(clean_tokens)

        # 3. Apply ISL syntactic transformation rules
        return self._synthesize_natural_english(clean_tokens, roles)

    def _parse_semantic_roles(self, tokens: list[str]) -> dict[str, list[str]]:
        roles = {
            "time": [],
            "subject": [],
            "object": [],
            "body_part": [],
            "verb": [],
            "modal": [],
            "aspect": [],
            "descriptor": [],
            "question": [],
            "negation": [],
            "politeness": [],
            "other": [],
        }

        for tok in tokens:
            sign = self.get_sign(tok)
            role = sign.get("role", "") if sign else ""
            cat = sign.get("category", "") if sign else ""

            if "time" in role or cat == "time_aspect" and tok not in ("FINISH", "NOT-YET"):
                roles["time"].append(tok)
            elif tok in ("FINISH", "NOT-YET") or "aspect" in role:
                roles["aspect"].append(tok)
            elif "subject_pronoun" in role or tok in ("PRO-1", "PRO-2", "FAMILY", "CAREGIVER", "CHILD", "DOCTOR", "NURSE"):
                roles["subject"].append(tok)
            elif "body_part" in role or tok in ("HEAD", "CHEST", "STOMACH", "BREATH", "BACK"):
                roles["body_part"].append(tok)
            elif cat == "needs_medical" and "body_part" not in role:
                roles["object"].append(tok)
            elif cat == "questions" or "question" in role:
                roles["question"].append(tok)
            elif cat == "negation" or "negation" in role:
                roles["negation"].append(tok)
            elif tok in ("WANT", "NEED", "CANNOT", "DON'T-WANT"):
                roles["modal"].append(tok)
            elif "verb" in role or cat == "actions_verbs":
                roles["verb"].append(tok)
            elif cat == "feelings_thoughts" or "descriptor" in role:
                roles["descriptor"].append(tok)
            elif cat == "social" or "politeness" in role:
                roles["politeness"].append(tok)
            else:
                roles["other"].append(tok)

        return roles

    def _match_idiomatic_patterns(self, tokens: list[str]) -> InterpretationResult | None:
        """Handles specialized ISL communicative combinations."""
        tset = set(tokens)
        ts = tokens

        # Single greetings / social signs
        if len(ts) == 1:
            tok = ts[0]
            if tok in ("HELLO",):
                return InterpretationResult("Hello! Good to see you.", tok, "Social Formula")
            if tok in ("GOODBYE",):
                return InterpretationResult("Goodbye! Have a safe journey.", tok, "Social Formula")
            if tok in ("THANK-YOU",):
                return InterpretationResult("Thank you very much.", tok, "Social Formula")
            if tok in ("SORRY",):
                return InterpretationResult("I am sorry.", tok, "Social Formula")
            if tok in ("PLEASE",):
                return InterpretationResult("Please.", tok, "Social Formula")
            if tok in ("AGREE",):
                return InterpretationResult("I agree with you.", tok, "Affirmation")
            if tok in ("DISAGREE",):
                return InterpretationResult("I disagree with that.", tok, "Negation", is_negated=True)
            if tok in ("WATER",):
                return InterpretationResult("I would like some water, please.", tok, "Direct Need Request")
            if tok in ("FOOD",):
                return InterpretationResult("I am hungry and would like some food, please.", tok, "Direct Need Request")
            if tok in ("MEDICINE",):
                return InterpretationResult("I need my medicine, please.", tok, "Direct Need Request")
            if tok in ("PAIN",):
                return InterpretationResult("I am experiencing pain. Please help me.", tok, "Medical Alert", is_emergency=True)
            if tok in ("HELP-ME",):
                return InterpretationResult("Please help me right now.", tok, "Urgent Request", is_emergency=True)

        # Emergency & Urgent Symptoms
        if "BREATH" in tset and ("CANNOT" in tset or "NOT" in tset or "DIFFICULT" in tset):
            return InterpretationResult(
                sentence="I cannot breathe comfortably! Please help me immediately!",
                isl_gloss=" ".join(tokens),
                syntax_type="Urgent Medical Topic-Comment",
                confidence=0.99,
                is_emergency=True,
                is_negated=True,
            )

        # Pain Combinations (ISL: [BODY-PART] + PAIN + [SCALE/NEGATION])
        if "PAIN" in tset:
            body = None
            for b in ("HEAD", "CHEST", "STOMACH", "BACK"):
                if b in tset:
                    body = b
                    break
            
            body_name = body.lower() if body else "my body"
            if body == "HEAD":
                body_name = "head"
            elif body == "CHEST":
                body_name = "chest"
            elif body == "STOMACH":
                body_name = "stomach"
            elif body == "BACK":
                body_name = "back"

            if "NOT" in tset or "CANNOT" in tset or "STOP" in tset:
                return InterpretationResult(
                    sentence=f"The pain in my {body_name} is severe and not stopping. Please call the doctor.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Medical Topic-Comment with Negation",
                    confidence=0.98,
                    is_emergency=True,
                    is_negated=True,
                )
            if "HOW-MUCH" in tset:
                return InterpretationResult(
                    sentence=f"I have intense pain in my {body_name}.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Medical Pain Scale",
                    confidence=0.95,
                    is_emergency=True,
                )
            if body:
                return InterpretationResult(
                    sentence=f"I have a painful ache in my {body_name}. Please check on me.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Medical Topic-Comment",
                    confidence=0.97,
                    is_emergency=True,
                )

        # Question: Where is my family / doctor / nurse?
        if "WHERE" in tset:
            if "FAMILY" in tset:
                return InterpretationResult(
                    sentence="Where is my family right now?",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Wh-Interrogative (Sentence-Final Wh)",
                    is_question=True,
                    confidence=0.98,
                )
            if "DOCTOR" in tset or "PRO-3-DOCTOR" in tset:
                return InterpretationResult(
                    sentence="Where is the doctor? I need to see them.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Wh-Interrogative (Sentence-Final Wh)",
                    is_question=True,
                    confidence=0.98,
                )
            if "NURSE" in tset or "PRO-3-NURSE" in tset:
                return InterpretationResult(
                    sentence="Where is the nurse? Please call them.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Wh-Interrogative (Sentence-Final Wh)",
                    is_question=True,
                    confidence=0.98,
                )
            if "MEDICINE" in tset:
                return InterpretationResult(
                    sentence="Where is my medicine?",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Wh-Interrogative (Sentence-Final Wh)",
                    is_question=True,
                    confidence=0.98,
                )

        # Question: When will the doctor / family come?
        if "WHEN" in tset:
            person = "the doctor" if ("DOCTOR" in tset or "PRO-3-DOCTOR" in tset) else ("my family" if "FAMILY" in tset else ("the nurse" if "NURSE" in tset else "someone"))
            action = "come" if "COME" in tset else ("give me medicine" if "MEDICINE" in tset else "arrive")
            return InterpretationResult(
                sentence=f"When will {person} {action}?",
                isl_gloss=" ".join(tokens),
                syntax_type="ISL Wh-Interrogative (Sentence-Final Wh)",
                is_question=True,
                confidence=0.98,
            )

        # Polar question with QUESTION-POLAR
        if "QUESTION-POLAR" in tset:
            if "DOCTOR" in tset and "COME" in tset:
                return InterpretationResult(
                    sentence="Is the doctor coming to see me?",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Polar Interrogative (Non-Manual Eyebrow Raise)",
                    is_question=True,
                    confidence=0.98,
                )
            if "FAMILY" in tset and "COME" in tset:
                return InterpretationResult(
                    sentence="Is my family coming to visit today?",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Polar Interrogative (Non-Manual Eyebrow Raise)",
                    is_question=True,
                    confidence=0.98,
                )
            if "MEDICINE" in tset and ("TIME" in tset or "NOW" in tset):
                return InterpretationResult(
                    sentence="Is it time for my medicine now?",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Polar Interrogative",
                    is_question=True,
                    confidence=0.97,
                )

        # Position change request
        if "CHANGE-POSITION" in tset:
            reason = ""
            if "BACK" in tset:
                reason = " because my back is hurting"
            elif "TIRED" in tset:
                reason = " because I am uncomfortable and tired"
            polite = "Please " if "PLEASE" in tset or True else ""
            return InterpretationResult(
                sentence=f"{polite}help me change my position in bed{reason}.",
                isl_gloss=" ".join(tokens),
                syntax_type="Directional Need Expression",
                confidence=0.96,
            )

        # Sleep / Rest requests
        if "SLEEP" in tset or "REST" in tset:
            if "WANT" in tset or "NEED" in tset:
                if "NOT" in tset or "CANNOT" in tset or "DON'T-WANT" in tset:
                    return InterpretationResult(
                        sentence="I cannot sleep right now, I am feeling uncomfortable.",
                        isl_gloss=" ".join(tokens),
                        syntax_type="Negated Modal Statement",
                        is_negated=True,
                        confidence=0.95,
                    )
                return InterpretationResult(
                    sentence="I am very tired and I would like to sleep and rest now.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="SOV Intention Statement",
                    confidence=0.96,
                )

        # Food & Drink completion (Aspect: FINISH / NOT-YET)
        if "FINISH" in tset:
            if "FOOD" in tset or "EAT" in tset:
                return InterpretationResult(
                    sentence="I have finished my meal.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Completive Aspect (FINISH Marker)",
                    confidence=0.97,
                )
            if "MEDICINE" in tset:
                return InterpretationResult(
                    sentence="I have already taken my medicine.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Completive Aspect",
                    confidence=0.97,
                )

        if "NOT-YET" in tset:
            if "FOOD" in tset or "EAT" in tset:
                return InterpretationResult(
                    sentence="I have not eaten my food yet.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Incompletive Aspect (NOT-YET Marker)",
                    confidence=0.97,
                )
            if "MEDICINE" in tset:
                return InterpretationResult(
                    sentence="I have not received my medicine yet.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="ISL Incompletive Aspect",
                    confidence=0.97,
                )

        # Direct directional verb requests (GIVE-ME, HELP-ME, TELL-ME)
        if "GIVE-ME" in tset:
            obj = "something"
            for o in ("WATER", "FOOD", "MEDICINE", "BLANKET"):
                if o in tset:
                    obj = o.lower()
                    break
            polite = "Please " if ("PLEASE" in tset or True) else ""
            return InterpretationResult(
                sentence=f"{polite}give me some {obj}.",
                isl_gloss=" ".join(tokens),
                syntax_type="ISL Directional Verb Agreement (2nd -> 1st Person)",
                confidence=0.98,
            )

        if "TELL-ME" in tset:
            return InterpretationResult(
                sentence="Please tell me what is happening.",
                isl_gloss=" ".join(tokens),
                syntax_type="ISL Directional Communication",
                confidence=0.95,
            )

        # Environment controls (Light / Fan / Blanket)
        if "LIGHT" in tset:
            if "STOP" in tset or "NOT" in tset or "DON'T-WANT" in tset:
                return InterpretationResult(
                    sentence="Please turn off the room light.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Topic-Comment Negative Imperative",
                    is_negated=True,
                    confidence=0.96,
                )
            return InterpretationResult(
                sentence="Please turn on the room light for me.",
                isl_gloss=" ".join(tokens),
                syntax_type="Topic-Comment Request",
                confidence=0.96,
            )

        if "FAN" in tset:
            if "STOP" in tset or "NOT" in tset or "DON'T-WANT" in tset or "COLD" in tset:
                return InterpretationResult(
                    sentence="Please turn off the ceiling fan, I am feeling chilly.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Topic-Comment Request",
                    confidence=0.96,
                )
            return InterpretationResult(
                sentence="Please turn on the ceiling fan.",
                isl_gloss=" ".join(tokens),
                syntax_type="Topic-Comment Request",
                confidence=0.96,
            )

        if "BLANKET" in tset:
            return InterpretationResult(
                sentence="Please cover me with a blanket, I am feeling cold.",
                isl_gloss=" ".join(tokens),
                syntax_type="Topic-Comment Need Expression",
                confidence=0.96,
            )

        if "TOILET" in tset:
            return InterpretationResult(
                sentence="I urgently need assistance to use the washroom.",
                isl_gloss=" ".join(tokens),
                syntax_type="Urgent Need Statement",
                confidence=0.98,
            )

        # Thoughts and Opinions (THINK, AGREE, DISAGREE, UNDERSTAND, HOPE)
        if "THINK" in tset:
            subj = "I think " if "PRO-1" in tset or True else ""
            if "DOCTOR" in tset and ("COME" in tset or "NEED" in tset):
                return InterpretationResult(
                    sentence=f"{subj}we need to call the doctor.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Cognitive Opinion Clause",
                    confidence=0.95,
                )
            if "GOOD" in tset or "HAPPY" in tset:
                return InterpretationResult(
                    sentence=f"{subj}everything is going to be okay.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Cognitive Opinion Clause",
                    confidence=0.95,
                )

        if "UNDERSTAND" in tset:
            if "NOT" in tset or "CANNOT" in tset or "NONE" in tset:
                return InterpretationResult(
                    sentence="I do not understand what you mean. Please explain again.",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Cognitive Negation Statement",
                    is_negated=True,
                    confidence=0.97,
                )
            return InterpretationResult(
                sentence="I understand you clearly.",
                isl_gloss=" ".join(tokens),
                syntax_type="Cognitive Affirmation",
                confidence=0.97,
            )

        # Feelings & Internal States
        if "FEEL" in tset:
            feelings = []
            for f in ("TIRED", "DIZZY", "COLD", "HOT", "ANXIOUS", "HAPPY", "SAD"):
                if f in tset:
                    feelings.append(f.lower())
            if feelings:
                feeling_str = " and ".join(feelings)
                polite_help = ", please stay with me." if "HELP-ME" in tset or "ANXIOUS" in tset else "."
                return InterpretationResult(
                    sentence=f"I am feeling {feeling_str}{polite_help}",
                    isl_gloss=" ".join(tokens),
                    syntax_type="Sensory State Expression",
                    confidence=0.97,
                )

        return None

    def _synthesize_natural_english(
        self, tokens: list[str], roles: dict[str, list[str]]
    ) -> InterpretationResult:
        """Synthesizes a fluent English sentence from parsed ISL roles using SOV grammar."""
        isl_gloss = " ".join(tokens)
        # 1. Extract Time (ISL Time-First principle)
        time_phrase = ""
        if roles["time"]:
            t_tok = roles["time"][0]
            if t_tok == "TODAY":
                time_phrase = "Today, "
            elif t_tok == "TOMORROW":
                time_phrase = "Tomorrow, "
            elif t_tok == "YESTERDAY":
                time_phrase = "Yesterday, "
            elif t_tok == "NOW":
                time_phrase = "Right now, "
            elif t_tok == "MORNING":
                time_phrase = "This morning, "
            elif t_tok == "NIGHT":
                time_phrase = "Tonight, "
            elif t_tok == "LATER":
                time_phrase = "Later, "

        # 2. Extract Subject
        subject = "I"
        subject_is_first_person = True
        if roles["subject"]:
            s_tok = roles["subject"][0]
            if s_tok in ("PRO-2",):
                subject = "You"
                subject_is_first_person = False
            elif s_tok in ("DOCTOR", "PRO-3-DOCTOR"):
                subject = "The doctor"
                subject_is_first_person = False
            elif s_tok in ("NURSE", "PRO-3-NURSE"):
                subject = "The nurse"
                subject_is_first_person = False
            elif s_tok in ("FAMILY", "PRO-3-FAMILY"):
                subject = "My family"
                subject_is_first_person = False
            elif s_tok in ("CAREGIVER",):
                subject = "My caregiver"
                subject_is_first_person = False
            elif s_tok in ("CHILD",):
                subject = "My child"
                subject_is_first_person = False

        # 3. Check for Negation
        is_negated = bool(roles["negation"])
        neg_tok = roles["negation"][0] if roles["negation"] else ""

        # 4. Check for Question
        is_question = bool(roles["question"])
        q_tok = roles["question"][0] if roles["question"] else ""

        # 5. Extract Objects & Body parts
        obj_names = []
        for o in roles["object"] + roles["body_part"]:
            s = self.get_sign(o)
            if s:
                obj_names.append(s["meaning_en"].lower())
            else:
                obj_names.append(o.lower())
        obj_phrase = " and ".join(obj_names)

        # 6. Extract Verbs & Modals
        has_want = "WANT" in tokens or "DON'T-WANT" in tokens
        has_need = "NEED" in tokens
        has_give = "GIVE-ME" in tokens
        has_help = "HELP-ME" in tokens
        has_come = "COME" in tokens
        has_go = "GO" in tokens
        has_eat = "EAT" in tokens
        has_drink = "DRINK" in tokens
        has_sleep = "SLEEP" in tokens
        has_rest = "REST" in tokens

        # Build natural sentence
        sentence = ""

        # Question synthesis
        if is_question:
            wh_word = q_tok
            if wh_word == "WHAT":
                sentence = f"What is {obj_phrase or 'this'}?"
            elif wh_word == "WHERE":
                sentence = f"Where is {obj_phrase or subject.lower()}?"
            elif wh_word == "WHEN":
                v = "coming" if has_come else ("available" if obj_phrase else "happening")
                target = subject if subject != "I" else (obj_phrase or "the doctor")
                sentence = f"When will {target} {v}?"
            elif wh_word == "WHO":
                sentence = f"Who is {obj_phrase or 'there'}?"
            elif wh_word == "WHY":
                sentence = f"Why is {obj_phrase or 'this happening'}?"
            elif wh_word == "HOW":
                sentence = f"How can we do this?"
            elif wh_word == "HOW-MUCH":
                sentence = f"How much {obj_phrase or 'is needed'}?"
            elif wh_word == "QUESTION-POLAR":
                sentence = f"Is {obj_phrase or subject} ready?"
            else:
                sentence = f"Could you tell me about {obj_phrase or 'this'}?"
        
        # Negated statement synthesis
        elif is_negated:
            if neg_tok in ("DON'T-WANT",) or has_want:
                sentence = f"I do not want {obj_phrase or 'to do that'}."
            elif neg_tok in ("CANNOT",):
                action = "breathe" if "BREATH" in tokens else ("sleep" if has_sleep else "move")
                sentence = f"I cannot {action} right now."
            else:
                sentence = f"{subject} do not {obj_phrase or 'agree'}."

        # Request / Modal synthesis
        elif has_give:
            sentence = f"Please give me some {obj_phrase or 'water'}."
        elif has_help:
            sentence = f"Please help me with {obj_phrase or 'my care'}."
        elif has_want:
            sentence = f"I would like some {obj_phrase or 'assistance'}, please."
        elif has_need:
            sentence = f"I need {obj_phrase or 'help'} right now."
        elif has_come:
            sentence = f"{subject} is coming."
        elif has_go:
            sentence = f"Please let me go to {obj_phrase or 'rest'}."
        elif has_eat:
            sentence = f"I want to eat {obj_phrase or 'food'}."
        elif has_drink:
            sentence = f"I want to drink some {obj_phrase or 'water'}."
        else:
            # Fallback to fluent combination of descriptors and objects
            desc_names = [self.get_sign(d)["meaning_en"].lower() for d in roles["descriptor"] if self.get_sign(d)]
            if desc_names:
                sentence = f"I am feeling {' and '.join(desc_names)}."
            elif obj_names:
                sentence = f"I am referring to {obj_phrase}."
            else:
                # Direct meaningful translation of the gloss tokens
                meanings = [self.get_sign(t)["meaning_en"] if self.get_sign(t) else t for t in tokens]
                joined = " ".join(meanings)
                sentence = joined.capitalize() + "."

        if time_phrase and not sentence.lower().startswith(time_phrase.lower()):
            sentence = time_phrase + sentence[0].lower() + sentence[1:]

        # Capitalize and ensure punctuation
        sentence = sentence.strip()
        if sentence and not sentence.endswith((".", "?", "!")):
            sentence += "."

        return InterpretationResult(
            sentence=sentence,
            isl_gloss=isl_gloss,
            syntax_type="ISL SOV Linguistic Synthesis",
            semantic_roles=roles,
            confidence=0.92,
            is_question=is_question,
            is_negated=is_negated,
        )


# Singleton interpreter instance
_interpreter_instance: ISLGrammarInterpreter | None = None


def get_interpreter() -> ISLGrammarInterpreter:
    global _interpreter_instance
    if _interpreter_instance is None:
        _interpreter_instance = ISLGrammarInterpreter()
    return _interpreter_instance


def interpret_sign_sequence(tokens: list[str]) -> dict[str, Any]:
    """Convenience functional wrapper returning a serializable dictionary."""
    interp = get_interpreter()
    res = interp.interpret(tokens)
    return {
        "sentence": res.sentence,
        "isl_gloss": res.isl_gloss,
        "syntax_type": res.syntax_type,
        "confidence": res.confidence,
        "is_question": res.is_question,
        "is_negated": res.is_negated,
        "is_emergency": res.is_emergency,
        "alternatives": res.alternatives,
        "clarification_prompt": res.clarification_prompt,
    }


if __name__ == "__main__":
    # Test cases representing genuine ISL grammatical structures
    interp = ISLGrammarInterpreter()
    test_cases = [
        ["PRO-1", "WATER", "WANT"],
        ["WATER", "GIVE-ME", "PLEASE"],
        ["HEAD", "PAIN"],
        ["BREATH", "CANNOT"],
        ["DOCTOR", "COME", "WHEN"],
        ["FAMILY", "WHERE"],
        ["TOMORROW", "DOCTOR", "COME"],
        ["FOOD", "EAT", "FINISH"],
        ["CHANGE-POSITION", "BACK", "PAIN"],
        ["LIGHT", "STOP"],
        ["PRO-1", "FEEL", "TIRED", "ANXIOUS"],
        ["DOCTOR", "COME", "QUESTION-POLAR"],
        ["THANK-YOU"],
    ]

    print("--- ISL Linguistic Grammar Interpreter Verification ---")
    for tc in test_cases:
        res = interp.interpret(tc)
        print(f"ISL Gloss:  {' '.join(tc)}")
        print(f"Spoken:     {res.sentence}")
        print(f"Syntax:     {res.syntax_type} (conf={res.confidence})")
        print("-" * 50)
