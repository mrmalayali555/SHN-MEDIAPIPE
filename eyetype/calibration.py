"""Calibration: maps the raw gaze vector (u, v) to normalised screen coords.

A 2x3 affine transform is fitted with least squares from samples collected
while the user looks at a grid of points. The result is stored as JSON next
to the project so it survives restarts.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

CALIBRATION_FILE = Path(__file__).resolve().parent.parent / "calibration.json"

# Points used during calibration, as fractions of the window.
GRID = [(x, y) for y in (0.18, 0.5, 0.82) for x in (0.16, 0.5, 0.84)]
SAMPLES_PER_POINT = 25  # gaze samples needed before the target advances
DEFAULT_GAIN = 2.6      # used when no calibration exists yet


@dataclass
class Calibration:
    matrix: np.ndarray | None = None
    path: Path = CALIBRATION_FILE
    samples: list[tuple[float, float, float, float]] = field(default_factory=list)
    # adaptive centre for the uncalibrated fallback mapping
    centre: tuple[float, float] = (0.0, 0.0)

    # ---------------------------------------------------------- persist --
    @classmethod
    def load(cls, path: Path = CALIBRATION_FILE) -> "Calibration":
        cal = cls(path=path)
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                cal.matrix = np.array(data["matrix"], dtype=np.float64)
                cal.centre = tuple(data.get("centre", (0.0, 0.0)))
            except (ValueError, KeyError, TypeError, OSError):
                cal.matrix = None
        return cal

    def save(self) -> None:
        payload = {
            "matrix": self.matrix.tolist() if self.matrix is not None else None,
            "centre": list(self.centre),
            "saved_at": time.time(),
        }
        self.path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    @property
    def is_calibrated(self) -> bool:
        return self.matrix is not None

    # ------------------------------------------------------------- fitting --
    def reset(self) -> None:
        self.matrix = None
        self.samples.clear()

    def add_sample(self, u: float, v: float, nx: float, ny: float) -> None:
        self.samples.append((u, v, nx, ny))

    def fit(self) -> bool:
        if len(self.samples) < 12:
            return False
        data = np.array(self.samples, dtype=np.float64)
        a = np.column_stack([data[:, 0], data[:, 1], np.ones(len(data))])
        b = data[:, 2:]
        sol, *_ = np.linalg.lstsq(a, b, rcond=None)
        # Quality gate: reject fits that can't reproduce the calibration points
        # (happens when the tracker saw no real eye movement, e.g. a false face).
        residual = float(np.mean(np.abs(a @ sol - b)))
        spread = np.std(data[:, :2], axis=0)  # per-axis eye movement
        if residual > 0.10 or float(spread.min()) < 0.004:
            self.matrix = None
            return False
        self.matrix = sol.T  # 2x3
        self.save()
        return True

    # -------------------------------------------------------------- mapping --
    def map_gaze(self, u: float, v: float, auto_centre: tuple[float, float] | None = None
                 ) -> tuple[float, float]:
        """Return normalised screen coordinates (0..1, 0..1)."""
        if self.matrix is not None:
            nx = self.matrix[0, 0] * u + self.matrix[0, 1] * v + self.matrix[0, 2]
            ny = self.matrix[1, 0] * u + self.matrix[1, 1] * v + self.matrix[1, 2]
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

    def feed(self, u: float, v: float) -> None:
        """Feed a gaze sample while a point is being shown."""
        if not self.collecting or self.done:
            return
        nx, ny = self.points[self.index]
        self.calibration.add_sample(u, v, nx, ny)
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
