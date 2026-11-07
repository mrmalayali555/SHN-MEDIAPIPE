"""Eye-gaze tracking: webcam capture + MediaPipe FaceLandmarker in a worker thread.

The heavy work (capture, inference, landmark math) happens off the Tk main
thread; the UI simply polls ``tracker.latest()``.

Per frame we derive:

  * u, v  - a head-normalised gaze vector: where the iris sits inside each
            eye socket, expressed in eye-width units and averaged over eyes.
            Calibration later maps (u, v) to screen coordinates.
  * blink - a quick both-eyes blink event (used as a "click" gesture).
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

MODEL_PATH = Path(__file__).resolve().parent.parent / "models" / "face_landmarker.task"

# MediaPipe face mesh indices ------------------------------------------------
LEFT_EYE = {"outer": 33, "inner": 133, "top": (160, 158), "bot": (153, 144),
            "iris": (468, 469, 470, 471, 472)}
RIGHT_EYE = {"outer": 362, "inner": 263, "top": (385, 387), "bot": (373, 380),
             "iris": (473, 474, 475, 476, 477)}
LEFT_CONTOUR = [33, 160, 158, 133, 153, 144]
RIGHT_CONTOUR = [362, 385, 387, 263, 373, 380]

ACCENT_BGR = (240, 201, 76)     # theme.ACCENT in BGR
GOOD_BGR = (151, 220, 61)       # theme.GOOD in BGR


# ------------------------------------------------------------ smoothing ---
class _OneEuro:
    """One Euro filter - smooth when still, responsive when moving."""

    def __init__(self, min_cutoff: float = 1.2, beta: float = 0.02,
                 d_cutoff: float = 1.0) -> None:
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self._x: float | None = None
        self._dx = 0.0
        self._t: float | None = None

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x: float, t: float) -> float:
        if self._t is None or self._x is None:
            self._x, self._t = x, t
            return x
        dt = max(1e-3, t - self._t)
        dx = (x - self._x) / dt
        a_d = self._alpha(self.d_cutoff, dt)
        self._dx = a_d * dx + (1 - a_d) * self._dx
        cutoff = self.min_cutoff + self.beta * abs(self._dx)
        a = self._alpha(cutoff, dt)
        self._x = a * x + (1 - a) * self._x
        self._t = t
        return self._x

    def reset(self) -> None:
        self._x = self._dx = self._t = None


# -------------------------------------------------------------- samples ---
@dataclass
class GazeFrame:
    t: float
    found: bool = False
    u: float = 0.0                 # gaze vector, eye-width units
    v: float = 0.0
    blink: bool = False            # quick-blink event on this frame
    ear: float = 0.0               # eye aspect ratio (openness)
    fps: float = 0.0
    preview: bytes | None = field(default=None, repr=False)   # PNG bytes


# --------------------------------------------------------------- tracker ---
class GazeTracker(threading.Thread):
    """Captures frames, runs FaceLandmarker and publishes gaze samples."""

    def __init__(self, camera: int = 0, frame_size: tuple[int, int] = (640, 480),
                 preview_width: int = 260, model_path: Path = MODEL_PATH) -> None:
        super().__init__(daemon=True, name="gaze-tracker")
        self.camera = camera
        self.frame_size = frame_size
        self.preview_width = preview_width
        self.model_path = model_path
        self._lock = threading.Lock()
        self._latest: GazeFrame | None = None
        self._stop = threading.Event()
        self.error: str | None = None

        # blink detection state
        self._ear_baseline = 0.0
        self._closed_frames = 0
        self._closed_since: float | None = None
        self._armed = False

        self._fx = _OneEuro()
        self._fy = _OneEuro()

    # ------------------------------------------------------------ public --
    def latest(self) -> GazeFrame | None:
        with self._lock:
            return self._latest

    def stop(self) -> None:
        self._stop.set()

    # ------------------------------------------------------------- worker --
    def run(self) -> None:  # noqa: C901 - linear pipeline, kept readable
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core import base_options as bo

        cap = cv2.VideoCapture(self.camera, cv2.CAP_V4L2)
        if not cap.isOpened():
            cap = cv2.VideoCapture(self.camera)
        if not cap.isOpened():
            self.error = f"Cannot open camera {self.camera}"
            self._publish(GazeFrame(t=time.time(), found=False))
            return
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_size[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_size[1])

        try:
            landmarker = vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(
                    base_options=bo.BaseOptions(model_asset_path=str(self.model_path)),
                    running_mode=vision.RunningMode.VIDEO,
                    num_faces=1,
                    min_face_detection_confidence=0.5,
                    min_tracking_confidence=0.5,
                )
            )
        except Exception as exc:  # model missing / unreadable
            self.error = f"FaceLandmarker init failed: {exc}"
            cap.release()
            self._publish(GazeFrame(t=time.time(), found=False))
            return

        last_ts = 0
        frame_i = 0
        fps_ema = 0.0
        infer_start = time.perf_counter()

        while not self._stop.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                time.sleep(0.05)
                continue
            frame = cv2.flip(frame, 1)  # mirror: feels natural for aiming
            h, w = frame.shape[:2]

            now = time.perf_counter()
            ts_ms = max(last_ts + 1, int(now * 1000))
            last_ts = ts_ms

            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), ts_ms
            )

            sample = GazeFrame(t=time.time())
            pts = results.face_landmarks[0] if results.face_landmarks else None
            if pts is not None:
                u, v = self._gaze_vector(pts)
                t = time.time()
                sample.found = True
                sample.u = self._fx(u, t)
                sample.v = self._fy(v, t)
                sample.ear = self._ear(pts)
                sample.blink = self._update_blink(sample.ear, t)
                frame_i += 1
                if frame_i % 4 == 0:
                    sample.preview = self._preview(frame, pts)
            else:
                self._fx.reset()
                self._fy.reset()
                self._closed_frames = 0
                self._armed = False

            dt = now - infer_start
            infer_start = now
            if dt > 0:
                inst = 1.0 / dt
                fps_ema = inst if fps_ema == 0 else 0.9 * fps_ema + 0.1 * inst
            sample.fps = fps_ema
            self._publish(sample)

        cap.release()
        landmarker.close()

    # ------------------------------------------------------------ geometry --
    @staticmethod
    def _pt(pts, idx: int) -> np.ndarray:
        p = pts[idx]
        return np.array([p.x, p.y], dtype=np.float64)

    @classmethod
    def _gaze_vector(cls, pts) -> tuple[float, float]:
        """Iris position inside the eye socket, in eye-width units."""
        acc_u = acc_v = 0.0
        weight_sum = 0.0
        for eye in (LEFT_EYE, RIGHT_EYE):
            outer = cls._pt(pts, eye["outer"])
            inner = cls._pt(pts, eye["inner"])
            center = (outer + inner) / 2.0
            width = float(np.linalg.norm(inner - outer))
            if width < 1e-6:
                continue
            iris = np.mean([cls._pt(pts, i) for i in eye["iris"]], axis=0)
            w = width  # closer/larger eye counts a bit more
            acc_u += ((iris[0] - center[0]) / width) * w
            acc_v += ((iris[1] - center[1]) / width) * w
            weight_sum += w
        if weight_sum == 0:
            return 0.0, 0.0
        return acc_u / weight_sum, acc_v / weight_sum

    @classmethod
    def _ear(cls, pts) -> float:
        """Eye aspect ratio: ~0.25+ open, drops well below on closure."""
        values = []
        for eye in (LEFT_EYE, RIGHT_EYE):
            outer = cls._pt(pts, eye["outer"])
            inner = cls._pt(pts, eye["inner"])
            width = float(np.linalg.norm(inner - outer))
            if width < 1e-6:
                continue
            t1, t2 = (cls._pt(pts, i) for i in eye["top"])
            b1, b2 = (cls._pt(pts, i) for i in eye["bot"])
            vertical = float(np.linalg.norm(t1 - b1) + np.linalg.norm(t2 - b2))
            values.append(vertical / (2.0 * width))
        return float(np.mean(values)) if values else 0.0

    def _update_blink(self, ear: float, t: float) -> bool:
        """Return True once per quick both-eyes blink."""
        if self._ear_baseline == 0.0:
            self._ear_baseline = ear
            return False
        low = 0.72 * self._ear_baseline
        high = 0.9 * self._ear_baseline

        if ear < low:
            if self._closed_frames == 0:
                self._closed_since = t
            self._closed_frames += 1
            # long closure = looking away / resting eyes, not a click
            if self._closed_since and t - self._closed_since > 0.6:
                self._armed = False
                self._closed_frames = 0
            elif self._closed_frames >= 2:
                self._armed = True
        elif ear > high:
            fired = self._armed and self._closed_frames >= 2
            self._armed = False
            self._closed_frames = 0
            if fired:
                return True
            # adapt baseline slowly while eyes are open
            self._ear_baseline += 0.05 * (ear - self._ear_baseline)
        return False

    # ------------------------------------------------------------- preview --
    def _preview(self, frame: np.ndarray, pts) -> bytes | None:
        h, w = frame.shape[:2]
        scale = self.preview_width / w
        vis = cv2.resize(frame, (self.preview_width, int(h * scale)))

        def pix(idx: int) -> tuple[int, int]:
            p = pts[idx]
            return int(p.x * vis.shape[1]), int(p.y * vis.shape[0])

        for contour in (LEFT_CONTOUR, RIGHT_CONTOUR):
            poly = np.array([pix(i) for i in contour], dtype=np.int32)
            cv2.polylines(vis, [poly], True, ACCENT_BGR, 1, cv2.LINE_AA)
        for eye in (LEFT_EYE, RIGHT_EYE):
            c = pix(eye["iris"][0])
            cv2.circle(vis, c, 4, GOOD_BGR, -1, cv2.LINE_AA)
        cv2.rectangle(vis, (0, 0), (vis.shape[1] - 1, vis.shape[0] - 1),
                      ACCENT_BGR, 1)
        # PNG: Tk's photo image handles it everywhere (JPEG support varies)
        ok, buf = cv2.imencode(".png", vis, [cv2.IMWRITE_PNG_COMPRESSION, 3])
        return buf.tobytes() if ok else None

    def _publish(self, sample: GazeFrame) -> None:
        with self._lock:
            self._latest = sample


# ------------------------------------------------------------- utilities --
def auto_center(samples: list[tuple[float, float]]) -> tuple[float, float]:
    """Robust centre of a cluster of raw gaze samples (used before calibration)."""
    if not samples:
        return 0.0, 0.0
    arr = np.array(samples, dtype=np.float64)
    return float(np.median(arr[:, 0])), float(np.median(arr[:, 1]))
