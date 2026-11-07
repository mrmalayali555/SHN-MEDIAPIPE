"""Color scheme, fonts and small drawing helpers for EyeType."""

from __future__ import annotations

import tkinter as tk
import tkinter.font as tkfont

# ---------------------------------------------------------------- palette ---
BG = "#0a0e16"          # app background
PANEL = "#111726"       # header / side panel
PANEL_ALT = "#0e1421"   # text display
KEY = "#1a2338"         # letter key
KEY_ALT = "#232e49"     # modifier key (shift, enter, ...)
KEY_HOVER = "#2f3f66"   # key under the gaze cursor
KEY_FLASH = "#3ddc97"   # brief flash after a key fires

ACCENT = "#4cc9f0"      # primary accent
ACCENT_DIM = "#1f5f7a"
GOOD = "#3ddc97"        # dwell ring / success
WARN = "#ffb454"        # warning, e.g. face not found
DANGER = "#ff5c7a"      # errors

TEXT = "#e8eefc"
MUTED = "#8a97b4"
CURSOR = "#ffffff"

SUGGEST_BG = "#141c2e"
SUGGEST_BG_ALT = "#182238"

# ----------------------------------------------------------------- fonts ---
def _pick(candidates: tuple[str, ...], families: set[str]) -> str:
    for name in candidates:
        if name in families:
            return name
    return "Helvetica"


_FONT_DEFAULTS = {
    "UI": "Helvetica",
    "MONO": "Courier",
    "FONT_TITLE": ("Helvetica", 15, "bold"),
    "FONT_BODY": ("Helvetica", 12),
    "FONT_SMALL": ("Helvetica", 10),
    "FONT_CHIP": ("Helvetica", 10, "bold"),
    "FONT_DISPLAY": ("Helvetica", 24),
    "FONT_KEY": ("Helvetica", 15, "bold"),
    "FONT_KEY_SPECIAL": ("Helvetica", 12, "bold"),
    "FONT_SUGGEST": ("Helvetica", 14, "bold"),
    "FONT_HINT": ("Helvetica", 11),
}
_font_cache: dict | None = None


def _fonts() -> dict:
    """Resolve fonts once a Tk root exists (falls back to generic names)."""
    global _font_cache
    if _font_cache is None:
        try:
            families = set(tkfont.families())
        except (tk.TclError, RuntimeError):
            families = set()
        ui = _pick(("Ubuntu", "Noto Sans", "DejaVu Sans", "Inter"), families)
        mono = _pick(("Ubuntu Mono", "DejaVu Sans Mono", "Noto Sans Mono"), families)
        resolved = {
            "UI": ui,
            "MONO": mono,
            "FONT_TITLE": (ui, 15, "bold"),
            "FONT_BODY": (ui, 12),
            "FONT_SMALL": (ui, 10),
            "FONT_CHIP": (ui, 10, "bold"),
            "FONT_DISPLAY": (ui, 24),
            "FONT_KEY": (ui, 15, "bold"),
            "FONT_KEY_SPECIAL": (ui, 12, "bold"),
            "FONT_SUGGEST": (ui, 14, "bold"),
            "FONT_HINT": (ui, 11),
        }
        # Only cache once a Tk root exists; otherwise retry on next access.
        if families:
            _font_cache = resolved
        return resolved
    return _font_cache


def __getattr__(name: str):
    if name in _FONT_DEFAULTS:
        return _fonts()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def round_rect(canvas: tk.Canvas, x0: float, y0: float, x1: float, y1: float,
               radius: float = 10, **kwargs) -> int:
    """Draw a rounded rectangle; kwargs go to create_polygon (fill, outline...)."""
    r = min(radius, (x1 - x0) / 2, (y1 - y0) / 2)
    points = [
        x0 + r, y0,
        x1 - r, y0,
        x1, y0,
        x1, y0 + r,
        x1, y1 - r,
        x1, y1,
        x1 - r, y1,
        x0 + r, y1,
        x0, y1,
        x0, y1 - r,
        x0, y0 + r,
        x0, y0,
    ]
    return canvas.create_polygon(points, smooth=True, splinesteps=12, **kwargs)


def clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))
