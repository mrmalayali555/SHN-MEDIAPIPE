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
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

ROOT = Path(__file__).resolve().parent
PROJECT_ROOT = ROOT.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

DATA_FILE = ROOT / "data" / "categories.json"
ISL_DATA_FILE = ROOT / "data" / "isl_signs.json"

from eyetype.calibration import Calibration
from eyetype.gaze import GazeTracker, auto_center

app = Flask(
    __name__,
    template_folder=str(ROOT / "templates"),
    static_folder=str(ROOT / "static"),
)

# ------------------------------------------------------------- eye tracker ---
_tracker: GazeTracker | None = None
_tracker_lock = threading.Lock()
_calibration: Calibration = Calibration.load()
_centre_samples: list[tuple[float, float]] = []
_auto_centre: tuple[float, float] = (0.0, 0.0)


def get_tracker() -> GazeTracker:
    global _tracker
    with _tracker_lock:
        if _tracker is None:
            _tracker = GazeTracker(camera=0)
            _tracker.start()
        return _tracker


# ----------------------------------------------------------------- helpers ---
def _load_data() -> dict:
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_data(data: dict) -> None:
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _load_isl_data() -> dict:
    if ISL_DATA_FILE.exists():
        with open(ISL_DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {"meta": {}, "categories": [], "signs": []}


# ------------------------------------------------------------------ routes ---
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/caregiver")
def caregiver():
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
                        if len(_centre_samples) >= 30:
                            _auto_centre = auto_center(_centre_samples)

                    if _calibration.is_calibrated:
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
                    "camera_open": tracker.active_camera is not None,
                    "error": tracker.error,
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

