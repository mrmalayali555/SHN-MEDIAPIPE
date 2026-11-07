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
WARN_BGR = (84, 180, 255)       # theme.WARN in BGR


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
            self._x, self._t, self._dx = x, t, 0.0
            return x
        if self._dx is None:
            self._dx = 0.0
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
        # _dx must be a number again: after a face loss the next sample would
        # otherwise crash with "float * NoneType" and kill the tracker thread.
        self._x = None
        self._t = None
        self._dx = 0.0


# -------------------------------------------------------------- samples ---
@dataclass
class GazeFrame:
    t: float
    found: bool = False
    u: float = 0.0                 # gaze vector, eye-width units
    v: float = 0.0
    # head pose: yaw/pitch as a fraction of inter-eye distance, scale =
    # inter-eye distance (head size/distance).  Used by calibration to
    # separate "eyes moved" from "head moved".
    yaw: float = 0.0
    pitch: float = 0.0
    scale: float = 0.0
    blink: bool = False            # quick-blink event on this frame
    ear: float = 0.0               # eye aspect ratio (openness)
    fps: float = 0.0
    preview: bytes | None = field(default=None, repr=False)   # PNG bytes


# --------------------------------------------------------------- tracker ---
class GazeTracker(threading.Thread):
    """Captures frames, runs FaceLandmarker and publishes gaze samples."""

    def __init__(self, camera: int = 0, frame_size: tuple[int, int] = (640, 480),
                 preview_width: int = 244, model_path: Path = MODEL_PATH,
                 preview_interval: float = 0.15) -> None:
        super().__init__(daemon=True, name="gaze-tracker")
        self.camera = camera
        self.frame_size = frame_size
        self.preview_width = preview_width
        self.model_path = model_path
        self.preview_interval = preview_interval
        self.active_camera: int | None = None   # index that actually opened
        self.frames_seen = 0                    # frames read since start
        self._lock = threading.Lock()
        self._latest: GazeFrame | None = None
        # NB: must NOT be called `_stop` - that shadows Thread._stop() and
        # makes Thread.join() raise "TypeError: 'Event' object is not callable".
        self._stop_event = threading.Event()
        self.error: str | None = None
        self._preview_at = 0.0

        # blink detection state
        self._ear_baseline = 0.0
        self._closed_frames = 0
        self._closed_since: float | None = None
        self._armed = False

        self._fx = _OneEuro()
        self._fy = _OneEuro()
        self._fyaw = _OneEuro(min_cutoff=0.8)
        self._fpitch = _OneEuro(min_cutoff=0.8)
        self._fscale = _OneEuro(min_cutoff=0.8)

    # ------------------------------------------------------------ public --
    def latest(self) -> GazeFrame | None:
        with self._lock:
            return self._latest

    def stop(self) -> None:
        self._stop_event.set()

    # ------------------------------------------------------------- camera --
    def _open_camera(self) -> tuple[cv2.VideoCapture | None, int]:
        """Try the requested index first, then the other common ones.

        A camera can be missing, busy or exposed under another index, so we
        probe 0-2 and require a real frame before accepting it.
        """
        import sys
        wanted = self.camera
        candidates = [wanted] + [i for i in (0, 1, 2) if i != wanted]
        # V4L2 is Linux-only; use DSHOW on Windows, CAP_ANY as fallback
        if sys.platform == "win32":
            backends = (cv2.CAP_DSHOW, cv2.CAP_ANY)
        else:
            backends = (cv2.CAP_V4L2, cv2.CAP_ANY)
        for idx in candidates:
            for backend in backends:
                cap = cv2.VideoCapture(idx, backend)
                if not cap.isOpened():
                    cap.release()
                    continue
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_size[0])
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_size[1])
                ok, frame = cap.read()
                if ok and frame is not None and frame.size:
                    return cap, idx
                cap.release()
        return None, wanted

    # ------------------------------------------------------------- worker --
    def run(self) -> None:  # noqa: C901 - linear pipeline, kept readable
        import mediapipe as mp
        from mediapipe.tasks.python import vision
        from mediapipe.tasks.python.core import base_options as bo

        cap, cam_idx = self._open_camera()
        if cap is None:
            self.error = f"Cannot open camera {self.camera} (or 0-2)"
            self._publish(GazeFrame(t=time.time(), found=False))
            return
        self.active_camera = cam_idx
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.frame_size[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.frame_size[1])

        try:
            landmarker = vision.FaceLandmarker.create_from_options(
                vision.FaceLandmarkerOptions(
                    base_options=bo.BaseOptions(model_asset_path=str(self.model_path)),
                    running_mode=vision.RunningMode.VIDEO,
                    num_faces=1,
                    min_face_detection_confidence=0.4,
                    min_tracking_confidence=0.4,
                )
            )
        except Exception as exc:  # model missing / unreadable
            self.error = f"FaceLandmarker init failed: {exc}"
            cap.release()
            self._publish(GazeFrame(t=time.time(), found=False))
            return

        self._last_ts = 0
        self._frame_i = 0
        self._fps_ema = 0.0
        self._infer_start = time.perf_counter()

        while not self._stop_event.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                time.sleep(0.05)
                continue
            frame = cv2.flip(frame, 1)  # mirror: feels natural for aiming
            self.frames_seen += 1
            try:
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                self._process(frame, image, landmarker)
            except Exception as exc:  # never die silently: show it in the UI
                self.error = f"Tracking error: {exc}"
                self._publish(GazeFrame(t=time.time(), found=False))
                break

        cap.release()
        landmarker.close()

    def _process(self, frame: np.ndarray, image, landmarker) -> None:
        """Detect a face in one frame, derive gaze + preview, publish it."""
        now = time.perf_counter()
        ts_ms = max(self._last_ts + 1, int(now * 1000))
        self._last_ts = ts_ms

        results = landmarker.detect_for_video(image, ts_ms)

        sample = GazeFrame(t=time.time())
        pts = results.face_landmarks[0] if results.face_landmarks else None
        if pts is not None:
            u, v = self._gaze_vector(pts)
            yaw, pitch, scale = self._head_pose(pts)
            t = time.time()
            sample.found = True
            sample.u = self._fx(u, t)
            sample.v = self._fy(v, t)
            sample.yaw = self._fyaw(yaw, t)
            sample.pitch = self._fpitch(pitch, t)
            sample.scale = self._fscale(scale, t)
            sample.ear = self._ear(pts)
            sample.blink = self._update_blink(sample.ear, t)
            self._frame_i += 1
        else:
            self._fx.reset()
            self._fy.reset()
            self._fyaw.reset()
            self._fpitch.reset()
            self._fscale.reset()
            self._closed_frames = 0
            self._armed = False

        # Preview is published whether or not a face is in frame, so the
        # user can always see what the camera sees (and position themself).
        if now - self._preview_at >= self.preview_interval:
            self._preview_at = now
            sample.preview = self._preview(frame, pts)

        dt = now - self._infer_start
        self._infer_start = now
        if dt > 0:
            inst = 1.0 / dt
            self._fps_ema = inst if self._fps_ema == 0 else 0.9 * self._fps_ema + 0.1 * inst
        sample.fps = self._fps_ema
        self._publish(sample)

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
    def _head_pose(cls, pts) -> tuple[float, float, float]:
        """Coarse head pose from landmarks.

        yaw/pitch = nose-tip offset from the eye midpoint, in units of the
        inter-eye distance (so it is scale- and distance-independent);
        scale = the inter-eye distance itself (grows as the head comes
        closer to the camera).
        """
        left = cls._pt(pts, 33)      # outer corner, left eye
        right = cls._pt(pts, 263)    # outer corner, right eye
        nose = cls._pt(pts, 1)       # nose tip
        d = float(np.linalg.norm(right - left))
        if d < 1e-6:
            return 0.0, 0.0, 0.0
        mid = (left + right) / 2.0
        return (float((nose[0] - mid[0]) / d),
                float((nose[1] - mid[1]) / d),
                d)

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
        """Thumbnail of the live frame, drawn with or without a face.

        Published on every throttle tick so the panel always shows the real
        camera output - a blank preview is what makes people think the
        camera is dead.
        """
        h, w = frame.shape[:2]
        scale = self.preview_width / w
        vis = cv2.resize(frame, (self.preview_width, max(1, int(h * scale))))
        vh, vw = vis.shape[:2]

        if pts is None:
            colour = WARN_BGR
            banner = "NO FACE - look at the camera"
            # Draw a guide box in the centre so the user knows where to aim
            gw, gh = int(vw * 0.45), int(vh * 0.55)
            gx0, gy0 = (vw - gw) // 2, (vh - gh) // 2
            cv2.rectangle(vis, (gx0, gy0), (gx0 + gw, gy0 + gh),
                          WARN_BGR, 1, cv2.LINE_AA)
            cv2.putText(vis, "Place face here", (gx0 + 4, gy0 - 6),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.35, WARN_BGR, 1, cv2.LINE_AA)
        else:
            colour = GOOD_BGR

            def pix(idx: int) -> tuple[int, int]:
                p = pts[idx]
                return int(p.x * vis.shape[1]), int(p.y * vis.shape[0])

            # face bounding box
            xs = [p.x for p in pts]
            ys = [p.y for p in pts]
            x0, x1 = int(min(xs) * vw), int(max(xs) * vw)
            y0, y1 = int(min(ys) * vh), int(max(ys) * vh)
            fw, fh = x1 - x0, y1 - y0
            cx, cy = (x0 + x1) // 2, (y0 + y1) // 2

            cv2.rectangle(vis, (x0, y0), (x1, y1), colour, 1)

            for contour in (LEFT_CONTOUR, RIGHT_CONTOUR):
                poly = np.array([pix(i) for i in contour], dtype=np.int32)
                cv2.polylines(vis, [poly], True, ACCENT_BGR, 1, cv2.LINE_AA)
            for eye in (LEFT_EYE, RIGHT_EYE):
                c = pix(eye["iris"][0])
                cv2.circle(vis, c, 4, GOOD_BGR, -1, cv2.LINE_AA)

            # --- camera position guidance arrows and text ---
            hints: list[str] = []
            arrow_col = WARN_BGR
            margin_x, margin_y = vw * 0.15, vh * 0.15

            # horizontal guidance
            if cx < vw * 0.35:
                hints.append("Move RIGHT")
                # draw right arrow on right side
                ax = vw - 15
                cv2.arrowedLine(vis, (ax - 20, vh // 2), (ax, vh // 2),
                                arrow_col, 2, cv2.LINE_AA, tipLength=0.4)
            elif cx > vw * 0.65:
                hints.append("Move LEFT")
                ax = 15
                cv2.arrowedLine(vis, (ax + 20, vh // 2), (ax, vh // 2),
                                arrow_col, 2, cv2.LINE_AA, tipLength=0.4)

            # vertical guidance
            if cy < vh * 0.30:
                hints.append("Move DOWN")
                ay = vh - 20
                cv2.arrowedLine(vis, (vw // 2, ay - 20), (vw // 2, ay),
                                arrow_col, 2, cv2.LINE_AA, tipLength=0.4)
            elif cy > vh * 0.70:
                hints.append("Move UP")
                ay = 20
                cv2.arrowedLine(vis, (vw // 2, ay + 20), (vw // 2, ay),
                                arrow_col, 2, cv2.LINE_AA, tipLength=0.4)

            # distance guidance (face size relative to frame)
            face_ratio = max(fw / vw, fh / vh)
            if face_ratio < 0.25:
                hints.append("Move CLOSER")
            elif face_ratio > 0.70:
                hints.append("Move BACK")

            if hints:
                banner = " | ".join(hints)
                colour = WARN_BGR
            else:
                banner = "FACE OK - position good!"

        # banner strip: keeps the status legible over any background
        cv2.rectangle(vis, (0, vh - 18), (vw, vh), (10, 14, 22), -1)
        cv2.putText(vis, banner, (4, vh - 5),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.34, colour, 1, cv2.LINE_AA)
        cv2.rectangle(vis, (0, 0), (vw - 1, vh - 1), colour, 1)
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
