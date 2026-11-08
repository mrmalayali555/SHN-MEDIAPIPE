"""EyeVoice Gemini AI Service.

Enables open-ended, infinite communication for paralyzed/non-verbal patients.
Uses Google Gemini API to translate minimal eye cues, body anchors, or sign concepts
into fluent, natural, first-person speech and dynamic predictive conversation trees.
"""

from __future__ import annotations

import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from typing import Any


def _get_gemini_api_key() -> str:
    key = os.environ.get("GEMINI_API_KEY", "")
    if key:
        return key

    # Check uncommitted local_config.json
    local_cfg = Path(__file__).resolve().parent / "local_config.json"
    if local_cfg.exists():
        try:
            with open(local_cfg, "r", encoding="utf-8") as f:
                data = json.load(f)
                if data.get("GEMINI_API_KEY"):
                    return data["GEMINI_API_KEY"]
        except Exception:
            pass

    # Check uncommitted project .env
    env_file = Path(__file__).resolve().parent.parent / ".env"
    if env_file.exists():
        try:
            with open(env_file, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("GEMINI_API_KEY="):
                        return line.split("=", 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass

    return ""


# Preferred fast models
MODELS = ["gemini-flash-lite-latest", "gemini-2.5-flash", "gemini-flash-latest"]


def call_gemini(prompt: str, json_mode: bool = True, timeout: int = 8) -> dict[str, Any] | str | None:
    """Call Google Gemini API with fallback across fast models."""
    api_key = _get_gemini_api_key()
    if not api_key:
        return None

    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": api_key,
    }

    body: dict[str, Any] = {
        "contents": [{"parts": [{"text": prompt}]}],
    }
    if json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json"}

    payload = json.dumps(body).encode("utf-8")

    for model in MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        req = urllib.request.Request(url, data=payload, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candidates = data.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    if parts:
                        text = parts[0].get("text", "").strip()
                        if json_mode:
                            try:
                                return json.loads(text)
                            except json.JSONDecodeError:
                                return {"raw": text}
                        return text
        except urllib.error.HTTPError as he:
            # Try next model if 404 or rate-limited
            continue
        except Exception:
            continue

    return None


def generate_open_speech(cue: str, context: str = "", recent_messages: list[str] | None = None) -> dict[str, Any]:
    """Generate 6 rich conversational speech choices from any eye-selected cue or topic."""
    recent_str = "; ".join(recent_messages[-3:]) if recent_messages else "None"

    prompt = f"""You are the AI voice for an adult patient using an eye-tracking assistive system (EyeVoice).
The patient cannot speak physically and is communicating through their eyes.
They selected the topic or cue: "{cue}".
Context / Category: "{context}".
Recently spoken messages: {recent_str}.

Your task is to generate 6 natural, distinct, practical, first-person sentences they might want to say right now.
Include a variety of speech acts (e.g. polite request, inquiry/question, personal feeling, explanation, casual thought).
Keep each sentence natural, clear, empathetic, and ready to speak aloud.

Return ONLY a JSON object in this exact schema:
{{
  "topic": "{cue}",
  "options": [
    {{
      "id": "opt_1",
      "icon": "emoji",
      "gesture": "Short physical/sign gesture cue (e.g. Touch Forehead, Point to Chest)",
      "sentence": "Exact words to speak aloud",
      "meaning": "Brief explanation of intent",
      "urgent": false
    }},
    ... (total 6 options)
  ]
}}
"""
    result = call_gemini(prompt, json_mode=True, timeout=8)
    if isinstance(result, dict) and "options" in result and len(result["options"]) > 0:
        return result

    # Fallback to local expansion if offline
    return _local_fallback_options(cue, context)


def generate_conversation_followups(spoken_sentence: str) -> list[dict[str, Any]]:
    """Predict the next 4-6 things the patient might want to say after having spoken a sentence."""
    prompt = f"""An eye-tracking patient just said: "{spoken_sentence}".
Generate 4 natural, immediate follow-up sentences they are most likely to want to say next in the ongoing conversation.

Return ONLY a JSON object:
{{
  "followups": [
    {{
      "id": "f_1",
      "icon": "emoji",
      "sentence": "Follow-up sentence",
      "gesture": "Body cue",
      "meaning": "Why they are saying this"
    }},
    ... (4 items)
  ]
}}
"""
    res = call_gemini(prompt, json_mode=True, timeout=6)
    if isinstance(res, dict) and "followups" in res:
        return res["followups"]

    # Fallback
    return [
      {"id": "f_1", "icon": "🙏", "sentence": "Thank you for listening to me.", "gesture": "Nod", "meaning": "Gratitude"},
      {"id": "f_2", "icon": "❓", "sentence": "What do you think about that?", "gesture": "Raised brows", "meaning": "Inquiry"},
      {"id": "f_3", "icon": "⏳", "sentence": "Please give me a moment.", "gesture": "Wait gesture", "meaning": "Pause"},
      {"id": "f_4", "icon": "👍", "sentence": "I agree with what you said.", "gesture": "Affirmation", "meaning": "Agreement"},
    ]


def _local_fallback_options(cue: str, context: str) -> dict[str, Any]:
    """Graceful local offline fallback if network/API fails."""
    clean = cue.strip()
    return {
        "topic": clean,
        "options": [
            {
                "id": "fb_1",
                "icon": "💬",
                "gesture": "Touch Forehead",
                "sentence": f"I would like to talk about {clean}.",
                "meaning": "Direct topic introduction",
                "urgent": False,
            },
            {
                "id": "fb_2",
                "icon": "❓",
                "gesture": "Raised Eyebrows",
                "sentence": f"Could you help me with {clean}?",
                "meaning": "Polite question",
                "urgent": False,
            },
            {
                "id": "fb_3",
                "icon": "🤲",
                "gesture": "Open Palms",
                "sentence": f"I need assistance regarding {clean}.",
                "meaning": "Request for assistance",
                "urgent": False,
            },
            {
                "id": "fb_4",
                "icon": "💭",
                "gesture": "Touch Temple",
                "sentence": f"I am thinking about {clean}.",
                "meaning": "Personal thought",
                "urgent": False,
            },
            {
                "id": "fb_5",
                "icon": "👍",
                "gesture": "Affirmative Nod",
                "sentence": f"That sounds good regarding {clean}.",
                "meaning": "Positive confirmation",
                "urgent": False,
            },
            {
                "id": "fb_6",
                "icon": "🙏",
                "gesture": "Hands at Chest",
                "sentence": f"Thank you for understanding my thoughts on {clean}.",
                "meaning": "Appreciation",
                "urgent": False,
            },
        ],
    }


# Vision-capable models (flash-lite does NOT support images well)
VISION_MODELS = ["gemini-2.5-flash", "gemini-flash-latest"]


def call_gemini_vision(
    image_base64: str,
    prompt: str,
    json_mode: bool = True,
    timeout: int = 12,
) -> dict[str, Any] | str | None:
    """Call Google Gemini Vision API with a base64-encoded JPEG image and text prompt."""
    api_key = _get_gemini_api_key()
    if not api_key:
        return None

    headers = {
        "Content-Type": "application/json",
        "X-goog-api-key": api_key,
    }

    body: dict[str, Any] = {
        "contents": [
            {
                "parts": [
                    {
                        "inlineData": {
                            "mimeType": "image/jpeg",
                            "data": image_base64,
                        }
                    },
                    {"text": prompt},
                ]
            }
        ],
    }
    if json_mode:
        body["generationConfig"] = {"responseMimeType": "application/json"}

    payload = json.dumps(body).encode("utf-8")

    for model in VISION_MODELS:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        req = urllib.request.Request(url, data=payload, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                candidates = data.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    if parts:
                        text = parts[0].get("text", "").strip()
                        if json_mode:
                            try:
                                return json.loads(text)
                            except json.JSONDecodeError:
                                return {"raw": text}
                        return text
        except urllib.error.HTTPError:
            # Try next model if 404 or rate-limited
            continue
        except Exception:
            continue

    return None


_SIGN_INTERPRET_PROMPT = """You are an expert sign language interpreter with knowledge of ISL (Indian Sign Language), ASL (American Sign Language), BSL (British Sign Language), and international sign systems.

Analyze this webcam frame showing a person making hand signs/gestures. Look at:
1. Hand shape (which fingers are extended/folded, thumb position)
2. Hand orientation (palm facing direction)
3. Hand location relative to body (face, chest, waist)
4. Both hands if visible (are they mirroring, interacting, or independent?)
5. Facial expression (eyebrow raise = question, head shake = negation)

Based on your analysis, determine:
- What sign or gesture is being performed
- The most likely meaning in English
- Confidence level (high/medium/low)

Return ONLY a JSON object:
{
  "detected": true,
  "sign_name": "Name of the sign (e.g. HELLO, THANK_YOU, I_WANT_WATER)",
  "meaning_en": "English translation of what the person is saying",
  "sign_language": "ISL/ASL/BSL/Universal",
  "confidence": "high/medium/low",
  "hand_description": "Brief description of hand configuration seen",
  "is_signing": true
}

If no clear sign is detected (hands not visible, ambiguous gesture, or person is just resting):
{
  "detected": false,
  "sign_name": null,
  "meaning_en": "",
  "confidence": "low",
  "hand_description": "Description of what you see",
  "is_signing": false
}"""


def interpret_sign_frame(image_base64: str) -> dict[str, Any] | None:
    """Convenience wrapper: interpret a webcam frame for sign language gestures."""
    return call_gemini_vision(image_base64, _SIGN_INTERPRET_PROMPT, json_mode=True, timeout=12)


if __name__ == "__main__":
    print("Testing EyeVoice Gemini Service...")
    res = generate_open_speech("What is your name and how are you?")
    print("Generated topic:", res.get("topic"))
    for opt in res.get("options", []):
        print(f" - [{opt.get('icon')}] {opt.get('sentence')} (Gesture: {opt.get('gesture')})")

