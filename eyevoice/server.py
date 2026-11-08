"""EyeVoice – Flask server for the patient communication dashboard.

Serves the web UI and provides a JSON API for categories, customisation
and message history.  Runs alongside (not inside) the teammate's Tkinter
``eyetype`` application.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

DATA_FILE = ROOT / "data" / "categories.json"
ISL_DATA_FILE = ROOT / "data" / "isl_signs.json"

Calibration: Any = None
GazeTracker: Any = None
auto_center: Any = None
_calibration: Any = None

app = Flask(
    __name__,
    template_folder=str(ROOT / "templates"),
    static_folder=str(ROOT / "static"),
)

# In-memory caches to guarantee 100% uptime on read-only serverless filesystems
_memory_data: dict | None = None
_memory_isl_data: dict | None = None

# ------------------------------------------------------------- eye tracker ---
_tracker: Any = None
_tracker_lock = threading.Lock()
_centre_samples: list[tuple[float, float]] = []
_auto_centre: tuple[float, float] = (0.0, 0.0)


def get_tracker() -> Any:
    global _tracker, Calibration, GazeTracker, auto_center, _calibration
    with _tracker_lock:
        if _tracker is None:
            try:
                from eyetype.calibration import Calibration as _Calib
                from eyetype.gaze import GazeTracker as _Gaze, auto_center as _AutoC
                Calibration = _Calib
                GazeTracker = _Gaze
                auto_center = _AutoC
                _calibration = Calibration.load()
                _tracker = GazeTracker(camera=0)
                _tracker.start()
            except Exception as e:
                print(f"Webcam tracker offline / serverless cloud mode: {e}")
                return None
        return _tracker


# ----------------------------------------------------------------- helpers ---
def _find_file(rel_path: str) -> Path | None:
    for base in [ROOT, PROJECT_ROOT / "eyevoice", PROJECT_ROOT, Path(".")]:
        p = base / rel_path
        if p.exists():
            return p
    return None


def _load_data() -> dict:
    global _memory_data
    if _memory_data is not None:
        return _memory_data
    p = _find_file("data/categories.json")
    if p and p.exists():
        try:
            with open(p, "r", encoding="utf-8") as f:
                _memory_data = json.load(f)
                return _memory_data
        except Exception as e:
            print(f"Error loading categories: {e}")
    # Minimal fallback structure
    return {
        "categories": [
            {
                "id": "quick",
                "name": "Quick Needs",
                "icon": "⚡",
                "options": [
                    {"id": "yes", "label": "YES", "message": "Yes, definitely.", "icon": "✅"},
                    {"id": "no", "label": "NO", "message": "No, thank you.", "icon": "❌"},
                    {"id": "water", "label": "WATER", "message": "I need water please.", "icon": "💧"},
                    {"id": "help", "label": "HELP", "message": "I need assistance right now.", "icon": "🆘", "emergency": True}
                ]
            }
        ],
        "message_history": []
    }


def _save_data(data: dict) -> None:
    global _memory_data
    _memory_data = data
    p = _find_file("data/categories.json")
    if p:
        try:
            with open(p, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except OSError:
            # Read-only filesystem on cloud/Vercel serverless functions
            pass


def _load_isl_data() -> dict:
    global _memory_isl_data
    if _memory_isl_data is not None:
        return _memory_isl_data
    p = _find_file("data/isl_signs.json")
    if p and p.exists():
        try:
            with open(p, "r", encoding="utf-8") as f:
                _memory_isl_data = json.load(f)
                return _memory_isl_data
        except Exception as e:
            print(f"Error loading ISL signs: {e}")
    return {"meta": {}, "categories": [], "signs": []}


_memory_sign_vocab: dict | None = None


def _load_sign_vocabulary(force_reload: bool = False) -> dict:
    """Load the sign_vocabulary.json for the Sign-to-Speech webcam recognition feature."""
    global _memory_sign_vocab
    if _memory_sign_vocab is not None and not force_reload:
        return _memory_sign_vocab
    p = _find_file("data/sign_vocabulary.json")
    if p and p.exists():
        try:
            with open(p, "r", encoding="utf-8") as f:
                _memory_sign_vocab = json.load(f)
                return _memory_sign_vocab
        except Exception as e:
            print(f"Error loading sign vocabulary: {e}")
    return {"metadata": {}, "signs": []}


# ------------------------------------------------------------- error handler ---
@app.errorhandler(500)
@app.errorhandler(Exception)
def handle_server_error(e):
    if isinstance(e, HTTPException):
        return e
    tb = traceback.format_exc()
    print(f"Unhandled Exception: {tb}")
    return f"""
    <!DOCTYPE html>
    <html>
    <head><title>EyeVoice Server Error</title></head>
    <body style="background:#0f172a; color:#f8fafc; font-family:sans-serif; padding:40px; line-height:1.6;">
        <h2 style="color:#ef4444;">👁️ EyeVoice — Application Diagnostic</h2>
        <p>An unexpected exception occurred:</p>
        <pre style="background:#1e293b; padding:20px; border-radius:8px; color:#fca5a5; overflow:auto; font-size:14px;">{tb}</pre>
    </body>
    </html>
    """, 500


# ------------------------------------------------------------------ routes ---
@app.route("/")
def index():
    p = _find_file("templates/index.html")
    if p and p.exists():
        return p.read_text(encoding="utf-8"), 200, {"Content-Type": "text/html; charset=utf-8"}
    return render_template("index.html")


@app.route("/caregiver")
def caregiver():
    p = _find_file("templates/caregiver.html")
    if p and p.exists():
        return p.read_text(encoding="utf-8"), 200, {"Content-Type": "text/html; charset=utf-8"}
    return render_template("caregiver.html")


# ---- categories API ----
@app.route("/api/categories", methods=["GET"])
def get_categories():
    data = _load_data()
    return jsonify(data)


@app.route("/api/categories", methods=["PUT"])
def save_categories():
    data = request.get_json(force=True)
    _save_data(data)
    return jsonify({"status": "ok"})


# ---- add / edit / delete a single option inside a category ----
@app.route("/api/categories/<cat_id>/options", methods=["POST"])
def add_option(cat_id: str):
    """Add a new custom option to a category."""
    payload = request.get_json(force=True)
    data = _load_data()
    for cat in data["categories"]:
        if cat["id"] == cat_id:
            new_option = {
                "id": payload.get("id", f"custom_{int(time.time())}"),
                "label": payload["label"],
                "message": payload["message"],
                "icon": payload.get("icon", "💬"),
                "custom": True,
            }
            cat["options"].append(new_option)
            _save_data(data)
            return jsonify(new_option), 201
    return jsonify({"error": "category not found"}), 404


@app.route("/api/categories/<cat_id>/options/<opt_id>", methods=["PUT"])
def edit_option(cat_id: str, opt_id: str):
    payload = request.get_json(force=True)
    data = _load_data()
    for cat in data["categories"]:
        if cat["id"] == cat_id:
            for opt in cat["options"]:
                if opt["id"] == opt_id:
                    opt["label"] = payload.get("label", opt["label"])
                    opt["message"] = payload.get("message", opt["message"])
                    opt["icon"] = payload.get("icon", opt["icon"])
                    _save_data(data)
                    return jsonify(opt)
    return jsonify({"error": "not found"}), 404


@app.route("/api/categories/<cat_id>/options/<opt_id>", methods=["DELETE"])
def delete_option(cat_id: str, opt_id: str):
    data = _load_data()
    for cat in data["categories"]:
        if cat["id"] == cat_id:
            cat["options"] = [o for o in cat["options"] if o["id"] != opt_id]
            _save_data(data)
            return jsonify({"status": "deleted"})
    return jsonify({"error": "not found"}), 404


# ---- Indian Sign Language (ISL) API ----
@app.route("/api/isl/signs", methods=["GET"])
def get_isl_signs():
    """Retrieve verified Indian Sign Language signs with parameter metadata."""
    category = request.args.get("category")
    data = _load_isl_data()
    signs = data.get("signs", [])
    if category and category != "all":
        signs = [s for s in signs if s.get("category") == category]
    return jsonify({
        "meta": data.get("meta", {}),
        "total": len(signs),
        "signs": signs,
    })


@app.route("/api/isl/categories", methods=["GET"])
def get_isl_categories():
    """Retrieve available categories for ISL sign filtering."""
    data = _load_isl_data()
    return jsonify(data.get("categories", []))


@app.route("/api/isl/interpret", methods=["POST"])
def interpret_isl_sequence():
    """Interpret a sequence of ISL signs into fluent English using grammar rules."""
    from eyevoice.isl_grammar import interpret_sign_sequence
    payload = request.get_json(force=True) or {}
    signs = payload.get("signs", [])
    result = interpret_sign_sequence(signs)
    return jsonify(result)


# ---- Sign-to-Speech (Webcam ISL Recognition) API ----
@app.route("/api/sign-vocabulary", methods=["GET"])
def get_sign_vocabulary():
    """Return the verified ISL sign vocabulary for webcam-based recognition."""
    data = _load_sign_vocabulary()
    return jsonify({
        "metadata": data.get("metadata", {}),
        "total": len(data.get("signs", [])),
        "signs": data.get("signs", []),
    })


# ---- ISL Research Datasets Management & Remote Streaming API ----
@app.route("/api/isl/datasets", methods=["GET"])
def get_isl_datasets():
    """Return overview of all 9 Indian Sign Language datasets with live status."""
    from eyevoice.hf_datasets_manager import get_isl_datasets_summary
    return jsonify(get_isl_datasets_summary())


@app.route("/api/isl/datasets/<dataset_id>/inspect", methods=["GET"])
def inspect_isl_dataset(dataset_id: str):
    """Remotely inspect sample rows and features of an ISL dataset from Hugging Face Hub."""
    from eyevoice.hf_datasets_manager import inspect_remote_hf_dataset, _load_isl_catalog
    catalog = _load_isl_catalog()
    ds = next((d for d in catalog.get("datasets", []) if d.get("id") == dataset_id), None)
    if not ds:
        return jsonify({"error": f"Dataset {dataset_id} not found"}), 404

    hf_repo_id = ds.get("hf_repo_id")
    if not hf_repo_id:
        return jsonify({
            "success": True,
            "source": "remote_reference",
            "name": ds.get("name"),
            "url": ds.get("url"),
            "samples": ds.get("samples"),
            "classes": ds.get("classes"),
            "description": ds.get("description"),
            "rows_preview": [
                {"note": "This dataset is cataloged via its research/institutional portal.", "url": ds.get("url")}
            ]
        })

    split = request.args.get("split", "train")
    config = request.args.get("config", None)
    result = inspect_remote_hf_dataset(hf_repo_id, config=config, split=split, max_rows=5)
    return jsonify(result)


@app.route("/api/isl/catalog", methods=["GET"])
def get_isl_catalog_file():
    """Return the raw JSON catalog of Indian Sign Language datasets."""
    from eyevoice.hf_datasets_manager import _load_isl_catalog
    return jsonify(_load_isl_catalog())


@app.route("/api/isl/full-lexicon", methods=["GET"])
def get_isl_full_lexicon():
    """Return the full-scale ISLRTC National Standard Lexicon Database."""
    p = _find_file("data/isl_full_lexicon.json")
    if p and p.exists():
        try:
            with open(p, "r", encoding="utf-8") as f:
                return jsonify(json.load(f))
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    return jsonify({"categories": []})


@app.route("/api/isl/connectivity", methods=["GET"])
def get_isl_connectivity():
    """Test connection latency to Hugging Face, Mendeley, and Govt ISL Portal."""
    from eyevoice.hf_datasets_manager import test_hf_connectivity
    return jsonify(test_hf_connectivity())


@app.route("/api/sign-translate", methods=["POST"])
def sign_translate():
    """Translate a sequence of recognized sign glosses into a natural English sentence.

    Specifically recognizes fingerspelling sequences (e.g. LETTER_I + LETTER_L + LETTER_Y)
    as well as simultaneous whole-sign gestures, with ISL grammar awareness and Gemini polishing.
    """
    payload = request.get_json(force=True) or {}
    glosses = payload.get("glosses", [])
    if not glosses:
        return jsonify({"sentence": "", "method": "empty"})

    # Check for fingerspelled sequences (e.g. I -> L -> Y sequence)
    is_fingerspelled_ily = False
    for i in range(len(glosses) - 2):
        if glosses[i] == "LETTER_I" and glosses[i+1] == "LETTER_L" and glosses[i+2] == "LETTER_Y":
            is_fingerspelled_ily = True
            break

    if is_fingerspelled_ily and len(glosses) == 3:
        return jsonify({
            "sentence": "I love you (fingerspelled: I-L-Y).",
            "method": "fingerspelling_rules",
            "type": "fingerspelling_sequence"
        })

    # Try Gemini for natural language generation and ISL grammar polishing
    try:
        from eyevoice.gemini_service import call_gemini
        prompt = (
            "You are an Indian Sign Language (ISL) interpreter. "
            "ISL uses SOV (Subject-Object-Verb) word order, topic-comment structure, "
            "and sentence-final negation/questions. "
            "Given these recognized ISL sign glosses or fingerspelled letters in sequence order, "
            "translate them into a single natural, fluent English sentence. "
            "If the sequence contains consecutive letters (e.g. LETTER_C, LETTER_A, LETTER_T), "
            "combine them into fingerspelled words. "
            "Only output the translated sentence, nothing else.\n\n"
            f"Sign glosses: {' → '.join(glosses)}"
        )
        result = call_gemini(prompt, json_mode=False, timeout=6)
        if result and isinstance(result, str) and len(result.strip()) > 0:
            return jsonify({"sentence": result.strip(), "method": "gemini_polish"})
    except Exception as e:
        print(f"Gemini sign-translate fallback: {e}")

    # Deterministic fallback: assemble letters and signs
    words = []
    current_letters = []
    for g in glosses:
        if g.startswith("LETTER_"):
            current_letters.append(g.replace("LETTER_", ""))
        else:
            if current_letters:
                words.append("".join(current_letters))
                current_letters = []
            clean_word = g.replace("NUM_", "").replace("_", " ").title()
            words.append(clean_word)
    if current_letters:
        words.append("".join(current_letters))

    sentence = " ".join(words) + "."
    return jsonify({"sentence": sentence, "method": "fallback"})


@app.route("/api/sign-interpret-frame", methods=["POST"])
def sign_interpret_frame():
    """Use Gemini Vision AI to interpret any sign language gesture from a webcam frame."""
    payload = request.get_json(force=True) or {}
    image_b64 = payload.get("image", "")
    if not image_b64:
        return jsonify({"error": "no image provided"}), 400

    # Strip data URL prefix if present
    if "," in image_b64:
        image_b64 = image_b64.split(",", 1)[1]

    try:
        from eyevoice.gemini_service import interpret_sign_frame
        result = interpret_sign_frame(image_b64)
        if result:
            return jsonify(result)
        return jsonify({"detected": False, "meaning_en": "", "error": "AI service unavailable"})
    except Exception as e:
        print(f"Sign interpret error: {e}")
        return jsonify({"detected": False, "meaning_en": "", "error": str(e)}), 500


# ---- Gemini AI Open-Ended Communicator API ----
@app.route("/api/gemini/generate", methods=["POST"])
def gemini_generate_endpoint():
    """Dynamically generate personalized, open-ended sentences using Gemini AI."""
    from eyevoice.gemini_service import generate_open_speech
    payload = request.get_json(force=True) or {}
    cue = payload.get("cue", "").strip()
    context = payload.get("context", "")
    data = _load_data()
    recent = [m.get("text", "") for m in data.get("message_history", [])][-5:]
    result = generate_open_speech(cue, context, recent)
    return jsonify(result)


@app.route("/api/gemini/followups", methods=["POST"])
def gemini_followups_endpoint():
    """Predict natural conversational follow-ups after speaking a sentence."""
    from eyevoice.gemini_service import generate_conversation_followups
    payload = request.get_json(force=True) or {}
    sentence = payload.get("sentence", "").strip()
    followups = generate_conversation_followups(sentence)
    return jsonify({"followups": followups})


# ---- message history ----
@app.route("/api/messages", methods=["GET"])
def get_messages():
    data = _load_data()
    return jsonify(data.get("message_history", []))


@app.route("/api/messages", methods=["POST"])
def add_message():
    payload = request.get_json(force=True)
    data = _load_data()
    entry = {
        "text": payload["text"],
        "category": payload.get("category", ""),
        "emergency": payload.get("emergency", False),
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    data.setdefault("message_history", []).append(entry)
    # keep the last 200 messages
    data["message_history"] = data["message_history"][-200:]
    _save_data(data)
    return jsonify(entry), 201


# ---- text-to-speech endpoint ----
@app.route("/api/speak", methods=["POST"])
def speak_endpoint():
    """Speak text aloud using laptop native audio (pyttsx3 / Windows SAPI)."""
    payload = request.get_json(force=True)
    text = payload.get("text", "").strip()
    if not text:
        return jsonify({"error": "no text provided"}), 400

    def _worker():
        try:
            try:
                import pythoncom
                pythoncom.CoInitialize()
            except ImportError:
                pass
            import pyttsx3
            engine = pyttsx3.init()
            engine.setProperty("rate", 165)
            engine.say(text)
            engine.runAndWait()
        except Exception as exc:
            print(f"Speech error: {exc}")

    import threading
    threading.Thread(target=_worker, daemon=True).start()
    return jsonify({"status": "speaking", "text": text})


def _map_gaze_enhanced(u: float, v: float, cu: float, cv: float) -> tuple[float, float]:
    """Accurate, calibrated mapping with non-linear edge reach to prevent eye strain."""
    du = (u - cu) * 3.4
    dv = (v - cv) * 4.0
    # Gentle non-linear expansion towards edges so cards are reached effortlessly
    nx = 0.5 + du * (1.0 + 0.25 * abs(du))
    ny = 0.5 + dv * (1.0 + 0.25 * abs(dv))
    return float(max(0.02, min(0.98, nx))), float(max(0.02, min(0.98, ny)))


# ---- real-time MediaPipe eye gaze stream ----
@app.route("/api/gaze-stream")
def gaze_stream():
    """Server-Sent Events streaming live eye coordinates, blinks, and camera PIP."""
    tracker = get_tracker()
    if tracker is None:
        def generate_mock():
            payload = {
                "found": False,
                "x": 0.5,
                "y": 0.5,
                "blink": False,
                "ear": 0.3,
                "fps": 0,
                "camera_open": False,
                "error": "Webcam stream active in local app",
                "preview": None,
            }
            yield f"data: {json.dumps(payload)}\n\n"
        return Response(generate_mock(), mimetype="text/event-stream")

    def generate():
        global _auto_centre, _centre_samples
        last_t = 0.0
        while True:
            sample = tracker.latest()
            if sample is not None and sample.t != last_t:
                last_t = sample.t
                preview_b64 = None
                if sample.preview:
                    preview_b64 = "data:image/png;base64," + base64.b64encode(sample.preview).decode("ascii")

                nx, ny = 0.5, 0.5
                if sample.found:
                    if len(_centre_samples) < 30:
                        _centre_samples.append((sample.u, sample.v))
                        if len(_centre_samples) >= 30 and auto_center:
                            _auto_centre = auto_center(_centre_samples)

                    if _calibration and _calibration.is_calibrated:
                        nx, ny = _calibration.map_gaze(sample.u, sample.v)
                    else:
                        cu, cv = _auto_centre
                        nx, ny = _map_gaze_enhanced(sample.u, sample.v, cu, cv)

                payload = {
                    "found": bool(sample.found),
                    "x": float(nx),
                    "y": float(ny),
                    "blink": bool(sample.blink),
                    "ear": float(sample.ear),
                    "fps": round(sample.fps, 1),
                    "camera_open": getattr(tracker, "active_camera", None) is not None,
                    "error": getattr(tracker, "error", None),
                    "preview": preview_b64,
                }
                yield f"data: {json.dumps(payload)}\n\n"
            time.sleep(0.03)

    return Response(generate(), mimetype="text/event-stream")


@app.route("/api/recenter-gaze", methods=["POST"])
def recenter_gaze():
    """Recenter gaze so looking straight at the screen maps to (0.5, 0.5)."""
    global _auto_centre, _centre_samples
    tracker = get_tracker()
    if tracker is None:
        return jsonify({"status": "centered", "centre": [0.0, 0.0]})
    sample = tracker.latest()
    if sample and sample.found:
        _auto_centre = (sample.u, sample.v)
        _centre_samples = [(sample.u, sample.v)]
        return jsonify({"status": "recentered", "centre": _auto_centre})
    return jsonify({"error": "no face found"}), 400


# ---- launch teammate's eye-tracking keyboard ----
@app.route("/api/launch-keyboard", methods=["POST"])
def launch_keyboard():
    """Launch the teammate's Tkinter EyeType app in a separate process."""
    project_root = ROOT.parent
    venv_python = project_root / ".venv" / "Scripts" / "python.exe"
    if not venv_python.exists():
        venv_python = project_root / ".venv" / "bin" / "python"
    try:
        subprocess.Popen(
            [str(venv_python), "-m", "eyetype"],
            cwd=str(project_root),
            creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
        )
        return jsonify({"status": "launched"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# -------------------------------------------------------------------- main ---
def main():
    import webbrowser

    port = int(os.environ.get("EYEVOICE_PORT", 5000))
    host = os.environ.get("EYEVOICE_HOST", "0.0.0.0")
    url = f"http://localhost:{port}"
    print(f"\n  👁️  EyeVoice is running at {url}")
    print(f"  📱  Caregiver dashboard: {url}/caregiver")
    print(f"  Press Ctrl+C to stop.\n")
    webbrowser.open(url)
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()

