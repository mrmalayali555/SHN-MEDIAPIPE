"""EyeVoice – Flask server for the patient communication dashboard.

Serves the web UI and provides a JSON API for categories, customisation
and message history.  Runs alongside (not inside) the teammate's Tkinter
``eyetype`` application.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "data" / "categories.json"

app = Flask(
    __name__,
    template_folder=str(ROOT / "templates"),
    static_folder=str(ROOT / "static"),
)


# ----------------------------------------------------------------- helpers ---
def _load_data() -> dict:
    with open(DATA_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_data(data: dict) -> None:
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


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

