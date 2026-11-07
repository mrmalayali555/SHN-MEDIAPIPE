"""Calibration: maps the raw gaze vector (u, v) to normalised screen coords.

A 2x3 affine transform is fitted with least squares from samples collected
while the user looks at a grid of points. The result is stored as JSON next
to the project so it survives restarts.

Head pose (yaw, pitch, scale) can be added as extra features: people track
the moving dot with their head as well as their eyes, and that head motion
shows up in (u, v) as noise the eye-only model cannot explain.  Which
feature set is used is decided by leave-one-point-out cross-validation, so
the head model is only ever selected when it genuinely predicts better.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

CALIBRATION_FILE = Path(__file__).resolve().parent.parent / "calibration.json"
DEBUG_FILE = Path(__file__).resolve().parent.parent / "calibration_debug.json"

# Points used during calibration, as fractions of the window.
# Slightly wider than the typing area so the outer keys are inside the
# fitted region instead of being extrapolated.
GRID = [(x, y) for y in (0.16, 0.5, 0.86) for x in (0.12, 0.5, 0.88)]
SAMPLES_PER_POINT = 25  # gaze samples needed before the target advances
DEFAULT_GAIN = 2.6      # used when no calibration exists yet

# Sampling: after the dot moves the gaze is still travelling for a few
# frames.  Those samples point at the *previous* dot and are the single
# biggest source of calibration error (they triple the fit residual), so
# we wait for the gaze to settle before counting anything.
SETTLE_SECONDS = 0.30      # ignore samples right after the dot moves
STABILITY_WINDOW = 5       # recent samples used to judge "gaze is steady"
STABILITY_RADIUS = 0.02    # eye-width units the gaze may wander while steady
STABILITY_TIMEOUT = 1.2    # feed anyway if the gaze never looks steady

# Fit quality gate (normalised screen units: 0.05 = 5% of the window).
MAX_RESIDUAL = 0.08
MIN_SPREAD = 0.004         # per-axis eye movement required for a real fit
OUTLIER_FLOOR = 0.05       # never trim below this residual (keeps corners)

# Sample layout: (u, v, yaw, pitch, scale, nx, ny)
FEATURE_INDEX = {"u": 0, "v": 1, "yaw": 2, "pitch": 3, "scale": 4}
POSE_FEATURES = ("yaw", "pitch", "scale")
TARGET_INDEX = 5           # nx sits here, ny at 6

# Candidate feature sets, cheapest first.  Selection is by cross-validation.
FEATURE_SETS: tuple[tuple[str, ...], ...] = (
    ("u", "v"),
    ("u", "v", "yaw", "pitch"),
    ("u", "v", "yaw", "pitch", "scale"),
)
BASE_FEATURES = ("u", "v")
CV_MARGIN = 0.97        # head model must beat the eye-only model by 3%
MIN_CV_TARGETS = 6      # leave-one-out needs at least this many points
MIN_POSE_SPREAD = 1e-4  # pose features must actually vary to be considered


# --------------------------------------------------------------- fitting --
def _design(rows: np.ndarray, features: tuple[str, ...],
            centre: dict[str, float]) -> np.ndarray:
    """Build the least-squares design matrix for one feature set.

    Pose features are centred on the session mean so the intercept means
    "average head pose"; a sample with no pose information (zeros) then
    predicts at the average head position instead of shifting everything.
    """
    cols = [rows[:, FEATURE_INDEX[name]] for name in features]
    for i, name in enumerate(features):
        if name in POSE_FEATURES:
            cols[i] = cols[i] - centre[name]
    return np.column_stack([*cols, np.ones(len(rows))])


def _trimmed_fit(a: np.ndarray, b: np.ndarray, rounds: int = 3
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Least squares that drops clear outliers, returning (sol, keep mask).

    A sample is trimmed only if it is far off-model AND far above the
    median residual; the floor (OUTLIER_FLOOR) keeps the corner samples of
    a mildly nonlinear eye while still removing travel/blink junk.
    """
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    keep = np.ones(len(a), dtype=bool)
    for _ in range(rounds):
        r = np.abs(a @ sol - b).max(axis=1)
        trial = r <= max(3.0 * float(np.median(r)), OUTLIER_FLOOR)
        if trial.sum() < 12 or trial.all() or np.array_equal(trial, keep):
            break
        keep = trial
        sol, *_ = np.linalg.lstsq(a[keep], b[keep], rcond=None)
    return sol, keep


def _loo_error(data: np.ndarray, features: tuple[str, ...],
               centre: dict[str, float]) -> float | None:
    """Leave-one-target-out mean |error| for a feature set.

    Fit on 8 of the 9 calibration points, predict the 9th, repeat.  This
    measures how well the model generalises to a screen position it has
    never seen - the honest way to decide whether extra features (head
    pose) help or just overfit.  None when there is not enough data.
    """
    targets = np.unique(np.round(data[:, TARGET_INDEX:TARGET_INDEX + 2], 3),
                        axis=0)
    if len(targets) < MIN_CV_TARGETS:
        return None
    errors = []
    for held in targets:
        mask = ~np.all(
            np.isclose(data[:, TARGET_INDEX:TARGET_INDEX + 2], held), axis=1)
        if mask.sum() < 12 or (~mask).sum() == 0:
            return None
        b = data[:, TARGET_INDEX:]
        sol, *_ = np.linalg.lstsq(_design(data[mask], features, centre),
                                  b[mask], rcond=None)
        pred = _design(data[~mask], features, centre) @ sol
        errors.append(float(np.abs(pred - b[~mask]).mean()))
    return float(np.mean(errors))


@dataclass
class Calibration:
    matrix: np.ndarray | None = None
    path: Path = CALIBRATION_FILE
    samples: list[tuple[float, ...]] = field(default_factory=list)
    # feature set the matrix was built from: ("u","v") or + head pose
    features: tuple[str, ...] = BASE_FEATURES
    # session means of the pose features (centring applied at fit time)
    pose_centre: dict[str, float] = field(
        default_factory=lambda: {n: 0.0 for n in POSE_FEATURES})
    # leave-one-out error of the chosen model (screen fractions)
    cv_error: float | None = None
    # adaptive centre for the uncalibrated fallback mapping
    centre: tuple[float, float] = (0.0, 0.0)
    # mean |error| of the fit in screen fractions (0.03 = ~3% of the window)
    quality: float | None = None

    # ---------------------------------------------------------- persist --
    @classmethod
    def load(cls, path: Path = CALIBRATION_FILE) -> "Calibration":
        cal = cls(path=path)
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                cal.matrix = np.array(data["matrix"], dtype=np.float64)
                cal.centre = tuple(data.get("centre", (0.0, 0.0)))
                cal.quality = data.get("quality")
                cal.features = tuple(data.get("features", BASE_FEATURES))
                # an old calibration.json has a 2x3 matrix and no features
                if cal.matrix is not None and \
                        cal.matrix.shape[0] != len(cal.features) + 1:
                    cal.matrix = None
                cal.pose_centre = {
                    n: float(data.get("pose_centre", {}).get(n, 0.0))
                    for n in POSE_FEATURES}
                cal.cv_error = data.get("cv_error")
            except (ValueError, KeyError, TypeError, OSError):
                cal.matrix = None
        return cal

    def save(self) -> None:
        payload = {
            "matrix": self.matrix.tolist() if self.matrix is not None else None,
            "features": list(self.features),
            "pose_centre": self.pose_centre,
            "cv_error": self.cv_error,
            "centre": list(self.centre),
            "quality": self.quality,
            "saved_at": time.time(),
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    @property
    def is_calibrated(self) -> bool:
        return self.matrix is not None

    # ------------------------------------------------------------- fitting --
    def reset(self) -> None:
        self.matrix = None
        self.quality = None
        self.cv_error = None
        self.features = BASE_FEATURES
        self.pose_centre = {n: 0.0 for n in POSE_FEATURES}
        self.samples.clear()

    def add_sample(self, u: float, v: float, nx: float, ny: float,
                   yaw: float = 0.0, pitch: float = 0.0,
                   scale: float = 0.0) -> None:
        self.samples.append((u, v, yaw, pitch, scale, nx, ny))

    def fit(self) -> bool:
        """Fit the mapping, choose features by cross-validation, dump debug.

        1. try each candidate feature set (eye-only, +head pose, +scale)
        2. score them with leave-one-point-out cross-validation - a model
           only wins if it predicts an unseen point better, so extra
           features can never overfit their way into the calibration
        3. trim clear outliers and refit the winner
        4. reject the whole fit if it still cannot reproduce the points
        """
        if len(self.samples) < 12:
            self._write_debug(False, reason="not enough samples")
            return False

        data = np.array(self.samples, dtype=np.float64)
        centre = {n: float(data[:, FEATURE_INDEX[n]].mean())
                  for n in POSE_FEATURES}
        b = data[:, TARGET_INDEX:]
        spread = np.std(data[:, :2], axis=0)  # per-axis eye movement

        candidates: dict[tuple[str, ...], dict] = {}
        for feats in FEATURE_SETS:
            if any(data[:, FEATURE_INDEX[n]].ptp() < MIN_POSE_SPREAD
                   for n in feats if n in POSE_FEATURES):
                continue  # pose features are constant - design is singular
            a = _design(data, feats, centre)
            sol, keep = _trimmed_fit(a, b)
            residual = float(np.mean(np.abs(a[keep] @ sol - b[keep])))
            if residual > MAX_RESIDUAL or float(spread.min()) < MIN_SPREAD:
                continue  # fails the quality gate
            candidates[feats] = {
                "sol": sol, "keep": keep, "residual": residual,
                "cv": _loo_error(data, feats, centre),
            }

        base = candidates.get(BASE_FEATURES)
        chosen = BASE_FEATURES
        if base is not None:
            # prefer a richer model only when it predicts unseen points
            # better by a clear margin (CV_MARGIN)
            scored = [(f, c) for f, c in candidates.items()
                      if f != BASE_FEATURES and c["cv"] is not None
                      and c["cv"] < (base["cv"] or 1.0) * CV_MARGIN]
            if scored:
                chosen = min(scored, key=lambda fc: fc[1]["cv"])[0]
        entry = candidates.get(chosen)
        if entry is None:
            self.features = BASE_FEATURES
            self.matrix = None
            self.quality = None
            self._write_debug(False, spread=spread,
                              reason="no candidate fit passed the gate",
                              candidates={list(f): c["residual"]
                                          for f, c in candidates.items()})
            return False

        self.features = chosen
        self.pose_centre = centre
        self.quality = entry["residual"]
        self.cv_error = entry["cv"]
        self.matrix = entry["sol"].T          # (n_features+1) x 2
        self.save()

        self._write_debug(True, spread=spread, keep=entry["keep"],
                          dropped=int((~entry["keep"]).sum()),
                          sol=entry["sol"],
                          features=list(chosen),
                          cv_error=entry["cv"],
                          model_selection={
                              list(f): {"residual": c["residual"],
                                        "cv_error": c["cv"]}
                              for f, c in candidates.items()})
        return True

    def _write_debug(self, ok: bool, sol: np.ndarray | None = None, **extra) -> None:
        """Dump the raw session so calibration can be inspected afterwards."""
        try:
            per_point: dict[tuple[float, float], list[tuple[float, ...]]] = {}
            for row in self.samples:
                key = (row[TARGET_INDEX], row[TARGET_INDEX + 1])
                per_point.setdefault(key, []).append(row)
            points = []
            for (nx, ny), rows in per_point.items():
                arr = np.array(rows)
                entry = {
                    "target": [nx, ny],
                    "n": len(rows),
                    "mean_u": float(arr[:, 0].mean()),
                    "mean_v": float(arr[:, 1].mean()),
                    "spread_u": float(arr[:, 0].std()),
                    "spread_v": float(arr[:, 1].std()),
                    "mean_yaw": float(arr[:, 2].mean()),
                    "mean_pitch": float(arr[:, 3].mean()),
                }
                if sol is not None:
                    feats = self.features
                    a = _design(arr, feats, self.pose_centre)
                    pred = a @ sol
                    entry["mean_error"] = float(np.abs(pred - [nx, ny]).mean())
                points.append(entry)

            payload = {
                "ok": ok,
                "quality": self.quality,
                "features": list(self.features),
                "pose_centre": self.pose_centre,
                "cv_error": self.cv_error,
                "samples_collected": len(self.samples),
                "grid": [list(p) for p in GRID],
                "matrix": self.matrix.tolist() if self.matrix is not None else None,
                "per_point": points,
                "samples": [list(s) for s in self.samples],
                "saved_at": time.time(),
            }
            for key, value in extra.items():
                payload[key] = value.tolist() if isinstance(value, np.ndarray) else value
            DEBUG_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except (OSError, ValueError, TypeError):
            pass  # diagnostics must never break calibration

    # -------------------------------------------------------------- mapping --
    def map_gaze(self, u: float, v: float, yaw: float = 0.0,
                 pitch: float = 0.0, scale: float = 0.0,
                 auto_centre: tuple[float, float] | None = None
                 ) -> tuple[float, float]:
        """Return normalised screen coordinates (0..1, 0..1)."""
        if self.matrix is not None:
            values = {"u": u, "v": v, "yaw": yaw, "pitch": pitch, "scale": scale}
            vec = np.array([
                values[name] - (self.pose_centre.get(name, 0.0)
                                if name in POSE_FEATURES else 0.0)
                for name in self.features] + [1.0])
            nx, ny = vec @ self.matrix
        else:
            cu, cv = auto_centre if auto_centre is not None else self.centre
            nx = 0.5 + (u - cu) * DEFAULT_GAIN
            ny = 0.5 + (v - cv) * DEFAULT_GAIN
        return float(np.clip(nx, 0.0, 1.0)), float(np.clip(ny, 0.0, 1.0))


@dataclass
class CalibrationSession:
    """Drives the interactive point-by-point calibration overlay."""

    calibration: Calibration
    points: list[tuple[float, float]] = field(default_factory=lambda: list(GRID))
    index: int = 0
    point_samples: int = 0
    collecting: bool = False

    def start(self) -> None:
        self.index = 0
        self.point_samples = 0
        self.collecting = True
        self.calibration.reset()

    @property
    def done(self) -> bool:
        return self.index >= len(self.points)

    @property
    def current_point(self) -> tuple[float, float] | None:
        if self.done:
            return None
        return self.points[self.index]

    @property
    def progress(self) -> float:
        """0..1 progress of the current point (drives the on-screen ring)."""
        if not self.collecting or self.done:
            return 0.0
        return min(1.0, self.point_samples / SAMPLES_PER_POINT)

    def feed(self, u: float, v: float, yaw: float = 0.0, pitch: float = 0.0,
             scale: float = 0.0) -> None:
        """Feed a gaze sample while a point is being shown."""
        if not self.collecting or self.done:
            return
        nx, ny = self.points[self.index]
        self.calibration.add_sample(u, v, nx, ny, yaw, pitch, scale)
        self.point_samples += 1
        if self.point_samples >= SAMPLES_PER_POINT:
            self.index += 1
            self.point_samples = 0
            if self.done:
                self.collecting = False
                self.calibration.fit()

    def cancel(self) -> None:
        self.collecting = False
        self.index = len(self.points)
        self.calibration.samples.clear()
