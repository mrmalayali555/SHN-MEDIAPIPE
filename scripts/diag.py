#!/usr/bin/env python3
"""Camera + face-tracking diagnostic for EyeType.

Runs the real GazeTracker for a few seconds and reports what it sees:
which camera opened, how many frames it read, how often a face was found
and whether the preview is being produced.  Exits non-zero if no face was
ever detected, so it can be used in scripts:

    .venv/bin/python scripts/diag.py [--seconds 8] [--camera 0] [--save out.png]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import cv2                     # noqa: E402
import numpy as np             # noqa: E402

from eyetype.gaze import GazeTracker  # noqa: E402


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--seconds", type=float, default=8.0,
                   help="how long to watch the camera (default 8)")
    p.add_argument("--camera", type=int, default=0, help="camera index (default 0)")
    p.add_argument("--save", type=Path, default=None,
                   help="write the last preview frame here (e.g. preview.png)")
    args = p.parse_args()

    tracker = GazeTracker(camera=args.camera)
    tracker.start()

    t0 = time.time()
    frames = face_frames = previews = 0
    last = None
    while time.time() - t0 < args.seconds:
        sample = tracker.latest()
        if sample is not None and sample is not last:
            last = sample
            frames += 1
            if sample.found:
                face_frames += 1
            if sample.preview:
                previews += 1
        time.sleep(0.02)

    alive = tracker.is_alive()
    tracker.stop()
    tracker.join(timeout=2.0)

    print(f"camera index tried : {args.camera}")
    print(f"camera opened at   : {tracker.active_camera}")
    print(f"frames read        : {tracker.frames_seen}")
    print(f"samples published  : {frames}")
    print(f"face found in      : {face_frames}/{frames} samples")
    print(f"previews produced  : {previews}")
    print(f"fps                : {last.fps:.1f}" if last else "fps : -")
    print(f"tracker thread     : {'alive' if alive else 'STOPPED'}")
    print(f"error              : {tracker.error or 'none'}")

    if args.save and last and last.preview:
        img = cv2.imdecode(np.frombuffer(last.preview, np.uint8), cv2.IMREAD_COLOR)
        if img is not None:
            cv2.imwrite(str(args.save), img)
            print(f"preview saved to   : {args.save}")

    if tracker.error:
        print("\nFAIL: the camera or model could not be used.", file=sys.stderr)
        return 2
    if face_frames == 0:
        print("\nFAIL: camera works, but no face was detected.", file=sys.stderr)
        print("      Sit ~60 cm from the camera, face it, and ensure your "
              "face is lit.", file=sys.stderr)
        return 1
    print("\nOK: camera is live and your face is being tracked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
