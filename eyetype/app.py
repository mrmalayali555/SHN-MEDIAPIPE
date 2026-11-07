"""EyeType - main Tk application.

Layout
------
  header      title, status chips, control buttons
  display     the text you are composing
  suggestions next-word / completion buttons
  keyboard    gaze-typed on-screen keyboard (canvas)
  side panel  live camera preview + hints

Interaction
-----------
* dwell   - rest your gaze on a target for ~0.7 s to select it
* blink   - quick both-eyes blink to click the target immediately
* mouse   - everything is also clickable for setup / fallback
"""

from __future__ import annotations

import argparse
import time
import tkinter as tk
from dataclasses import dataclass

from . import theme
from .calibration import (SETTLE_SECONDS, STABILITY_RADIUS, STABILITY_TIMEOUT,
                          STABILITY_WINDOW, Calibration, CalibrationSession)
from .gaze import GazeFrame, GazeTracker, auto_center
from .keyboard import Key, KeyboardView
from .language import LanguageModel

DWELL_MIN = 0.3
DWELL_MAX = 1.5
DWELL_STEP = 0.05
REPEAT_SECONDS = 0.28          # dwell time for hold-to-repeat keys (space, backspace)
RETRIGGER_DISTANCE = 45        # px the gaze may wander before dwell restarts
COOLDOWN_SECONDS = 0.15        # brief pause after a selection
CURSOR_SMOOTHING = 0.35        # EMA factor for the mapped gaze cursor


@dataclass
class Target:
    kind: str                  # "key" | "suggest" | "button"
    ref: object
    rect: tuple[float, float, float, float]

    @property
    def id(self) -> tuple[str, object]:
        return (self.kind, self.ref)


class FlatButton:
    """Rounded button drawn on its own small canvas; mouse + dwell friendly."""

    def __init__(self, parent: tk.Misc, label: str, action, width: int, height: int = 34,
                 font=None, fg: str = theme.TEXT,
                 bg: str = theme.PANEL_ALT, hover_bg: str = theme.KEY_HOVER,
                 accent: bool = False) -> None:
        self.label_text = label
        self.action = action
        self.accent = accent
        self.bg = bg
        self.hover_bg = hover_bg
        self.font = font or theme.FONT_SMALL
        self.fg = fg
        self._hovered = False
        self._progress = -1.0
        self.canvas = tk.Canvas(parent, width=width, height=height, bg=bg,
                                highlightthickness=0, bd=0, cursor="hand2")
        self._w = width
        self._h = height
        self._items: dict[str, int] = {}
        self._draw()
        self.canvas.bind("<Button-1>", lambda _e: self.action())

    # ------------------------------------------------------------ drawing --
    def _draw(self) -> None:
        c = self.canvas
        c.delete("all")
        fill = self.hover_bg if self._hovered else self.bg
        if self.accent and not self._hovered:
            fill = theme.ACCENT_DIM
        self._items["bg"] = theme.round_rect(c, 1, 1, self._w - 1, self._h - 1,
                                             radius=9, fill=fill, outline="")
        color = theme.ACCENT if self.accent else self.fg
        self._items["text"] = c.create_text(self._w / 2, self._h / 2 - 1,
                                            text=self.label_text, font=self.font,
                                            fill=color)
        self._items["bar"] = c.create_rectangle(6, self._h - 5, 6, self._h - 5,
                                                fill=theme.GOOD, outline="")

    def set_label(self, label: str) -> None:
        if label != self.label_text:
            self.label_text = label
            if "text" in self._items:
                self.canvas.itemconfigure(self._items["text"], text=label)

    def set_hover(self, on: bool) -> None:
        if on != self._hovered:
            self._hovered = on
            self._draw()
            self.set_progress(self._progress, force=True)

    def set_progress(self, progress: float, force: bool = False) -> None:
        progress = max(0.0, min(1.0, progress))
        if not force and abs(progress - self._progress) < 0.005:
            return
        self._progress = progress
        if progress <= 0:
            self.canvas.coords(self._items["bar"], -20, -20, -20, -20)
            return
        x1 = 6 + (self._w - 12) * progress
        self.canvas.coords(self._items["bar"], 6, self._h - 5, x1, self._h - 5)

    def flash(self) -> None:
        self.canvas.itemconfigure(self._items["bg"], fill=theme.KEY_FLASH)
        self.canvas.after(130, self._redraw_bg)

    def _redraw_bg(self) -> None:
        fill = self.hover_bg if self._hovered else self.bg
        if self.accent and not self._hovered:
            fill = theme.ACCENT_DIM
        self.canvas.itemconfigure(self._items["bg"], fill=fill)


class EyeTypeApp:
    def __init__(self, root: tk.Tk, args: argparse.Namespace) -> None:
        self.root = root
        self.args = args
        self.demo = args.demo
        self.dwell_seconds = args.dwell
        self.blink_enabled = not args.no_blink
        self.text = ""
        self.tracker: GazeTracker | None = None

        self.calibration = Calibration.load()
        self.cal_session = CalibrationSession(self.calibration)
        self.lang = LanguageModel()

        # interaction state
        self.dwell_target: tuple[str, object] | None = None
        self.dwell_anchor: tuple[float, float] = (0.0, 0.0)
        self.dwell_start = 0.0
        self.dwell_fired = False
        self.fired_on: tuple[str, object] | None = None
        self.cooldown_until = 0.0
        self.hovered: tuple[str, object] | None = None
        self.auto_centre: tuple[float, float] = (0.0, 0.0)
        self.centre_samples: list[tuple[float, float]] = []
        self._cursor: tuple[float, float] | None = None   # smoothed gaze cursor
        self.mouse_pos: tuple[float, float] | None = None
        self._last_fed = 0.0            # timestamp of last calibration sample
        self._cal_buffer: list[tuple[float, float]] = []   # recent gaze samples
        self._cal_point_seen = -1       # calibration dot index we last saw
        self._cal_point_at = 0.0        # when the current dot appeared
        self._cal_settle_at = 0.0       # ignore gaze samples before this time
        self._last_preview: bytes | None = None
        self._last_preview_at = 0.0
        self._photo = None
        self._toast_job = None

        root.title("EyeType - gaze typing")
        root.configure(bg=theme.BG)
        root.protocol("WM_DELETE_WINDOW", self.quit)

        screen_w, screen_h = root.winfo_screenwidth(), root.winfo_screenheight()
        w = min(1340, screen_w - 60)
        h = min(880, screen_h - 110)
        root.geometry(f"{w}x{h}+{(screen_w - w) // 2}+{(screen_h - h) // 2}")
        root.minsize(980, 640)

        self._build_ui()
        self._bind_keys()

        if self.demo:
            root.bind("<Motion>", self._on_motion)
            self.preview_label.configure(text="demo mode \u00b7 mouse gaze",
                                         fg=theme.ACCENT)
        else:
            self.tracker = GazeTracker(camera=args.camera)
            self.tracker.start()

        root.after(16, self.tick)
        root.after(400, self._update_status)

        if not self.calibration.is_calibrated and not args.no_auto_calibrate:
            root.after(1000, self.start_calibration)

    # ================================================================ UI ===
    def _build_ui(self) -> None:
        root = self.root
        root.rowconfigure(3, weight=1)
        root.columnconfigure(0, weight=1)

        # ------------------------------------------------------- header --
        header = tk.Frame(root, bg=theme.PANEL, height=58)
        header.grid(row=0, column=0, sticky="ew")
        header.pack_propagate(False)

        tk.Label(header, text="\U0001f441 EyeType", bg=theme.PANEL,
                 fg=theme.ACCENT, font=theme.FONT_TITLE).pack(
            side="left", padx=(16, 18), pady=12)

        self.chips: dict[str, tk.Label] = {}
        for key, text in (("face", "NO FACE"), ("fps", "-- FPS"),
                          ("calib", "CALIBRATING"), ("mode", "DWELL 0.70s")):
            chip = tk.Label(header, text="\u25cf " + text, bg=theme.PANEL_ALT,
                            fg=theme.MUTED, font=theme.FONT_CHIP, padx=9, pady=4)
            chip.pack(side="left", padx=3, pady=12)
            self.chips[key] = chip

        btn_bar = tk.Frame(header, bg=theme.PANEL)
        btn_bar.pack(side="right", padx=14, pady=12)

        self.btn_minus = FlatButton(btn_bar, "\u2212",
                                    lambda: self._adjust_dwell(-DWELL_STEP), 30)
        self.btn_plus = FlatButton(btn_bar, "+",
                                   lambda: self._adjust_dwell(DWELL_STEP), 30)
        self.btn_blink = FlatButton(btn_bar, "Blink: on", self._toggle_blink, 80)
        self.btn_calibrate = FlatButton(btn_bar, "Calibrate",
                                        self.start_calibration, 94)
        self.btn_copy = FlatButton(btn_bar, "Copy", self.copy_text, 68)
        self.btn_clear = FlatButton(btn_bar, "Clear", self.clear_text, 68)
        self.btn_back = FlatButton(btn_bar, "\u2b05 Exit / Back", self.quit, 110, accent=True)
        for b in (self.btn_minus, self.btn_plus, self.btn_blink, self.btn_calibrate,
                  self.btn_copy, self.btn_clear, self.btn_back):
            b.canvas.pack(side="left", padx=3)
        self.header_buttons = [self.btn_minus, self.btn_plus, self.btn_blink,
                               self.btn_calibrate, self.btn_copy, self.btn_clear, self.btn_back]

        # ----------------------------------------------------- display --
        self.display = tk.Text(root, height=4, wrap="word", font=theme.FONT_DISPLAY,
                               bg=theme.PANEL_ALT, fg=theme.TEXT,
                               insertbackground=theme.ACCENT, relief="flat",
                               padx=18, pady=14, highlightthickness=1,
                               highlightbackground="#1e2740", state="disabled")
        self.display.grid(row=1, column=0, sticky="ew", padx=14, pady=(12, 6))

        # ------------------------------------------------- suggestions --
        sug_bar = tk.Frame(root, bg=theme.BG)
        sug_bar.grid(row=2, column=0, sticky="ew", padx=14, pady=(0, 6))
        for col in range(3):
            sug_bar.columnconfigure(col, weight=1)
        self.suggest_buttons: list[FlatButton] = []
        for i in range(3):
            btn = FlatButton(sug_bar, "", lambda idx=i: self.apply_suggestion(idx),
                             width=200, height=44, font=theme.FONT_SUGGEST,
                             fg=theme.ACCENT, bg=theme.SUGGEST_BG,
                             hover_bg=theme.SUGGEST_BG_ALT)
            btn.canvas.grid(row=0, column=i, sticky="ew",
                            padx=(0 if i == 0 else 6, 0))
            self.suggest_buttons.append(btn)

        # --------------------------------------------------- main area --
        main = tk.Frame(root, bg=theme.BG)
        main.grid(row=3, column=0, sticky="nsew", padx=14, pady=(0, 14))
        main.columnconfigure(0, weight=1)
        main.rowconfigure(0, weight=1)

        self.keyboard_canvas = tk.Canvas(main, bg=theme.BG, highlightthickness=0, bd=0)
        self.keyboard_canvas.grid(row=0, column=0, sticky="nsew")
        self.keyboard = KeyboardView(self.keyboard_canvas)
        self.keyboard_canvas.bind("<Button-1>", self._on_canvas_click)

        side = tk.Frame(main, bg=theme.PANEL, width=272)
        side.grid(row=0, column=1, sticky="nsew", padx=(14, 0))
        side.pack_propagate(False)
        self.preview_canvas = tk.Canvas(side, width=244, height=184, bg="#05070c",
                                        highlightthickness=0, bd=0)
        self.preview_canvas.pack(padx=14, pady=(14, 6))

        self.preview_label = tk.Label(side, text="starting camera...", bg=theme.PANEL,
                                      fg=theme.MUTED, font=theme.FONT_SMALL)
        self.preview_label.pack(pady=(0, 10))

        hints = [
            ("HOW TO TYPE", theme.ACCENT, theme.FONT_CHIP),
            ("\u25b6 gaze at a key \u2192 ring fills", theme.MUTED, theme.FONT_HINT),
            ("\u25b6 quick blink \u2192 click", theme.MUTED, theme.FONT_HINT),
            ("\u25b6 \u21e7 uppercases next letter", theme.MUTED, theme.FONT_HINT),
            ("\u25b6 Copy \u2192 paste anywhere", theme.MUTED, theme.FONT_HINT),
            ("KEYS", theme.ACCENT, theme.FONT_CHIP),
            ("C  recalibrate \u00b7 Esc cancel", theme.MUTED, theme.FONT_HINT),
            ("Ctrl+L clear \u00b7 Ctrl+C copy", theme.MUTED, theme.FONT_HINT),
        ]
        for text, color, font in hints:
            tk.Label(side, text=text, bg=theme.PANEL, fg=color, font=font,
                     justify="left", anchor="w", wraplength=238).pack(
                fill="x", padx=16, pady=1)

        # ---------------------------------------------- calibration UI --
        self.overlay = tk.Canvas(root, bg=theme.BG, highlightthickness=0, bd=0)
        self.toast_label = tk.Label(root, text="", bg=theme.PANEL, fg=theme.GOOD,
                                    font=theme.FONT_BODY, padx=18, pady=10)

        self._refresh_text()
        self._update_chips()

    def _bind_keys(self) -> None:
        r = self.root
        r.bind("<Escape>", lambda _e: self.cancel_calibration())
        r.bind("c", lambda _e: self.start_calibration())
        r.bind("<Control-l>", lambda _e: self.clear_text())
        r.bind("<Control-c>", lambda _e: self.copy_text())

    # =========================================================== actions ===
    def _adjust_dwell(self, delta: float) -> None:
        self.dwell_seconds = round(min(DWELL_MAX, max(DWELL_MIN,
                                                       self.dwell_seconds + delta)), 2)
        self._update_chips()

    def _toggle_blink(self) -> None:
        self.blink_enabled = not self.blink_enabled
        self.btn_blink.set_label(f"Blink: {'on' if self.blink_enabled else 'off'}")
        self._update_chips()

    def on_key(self, key: Key) -> None:
        if key.action == "char":
            self.text += key.value.upper() if self.keyboard.shift else key.value
            if self.keyboard.shift:
                self.keyboard.toggle_shift()
        elif key.action == "space":
            self.text += " "
        elif key.action == "backspace":
            self.text = self.text[:-1]
        elif key.action == "enter":
            self.text += "\n"
        elif key.action == "shift":
            self.keyboard.toggle_shift()
        elif key.action == "page":
            self.keyboard.set_page(key.value)
        self._refresh_text()

    def apply_suggestion(self, index: int) -> None:
        word = self.suggest_buttons[index].label_text
        if not word:
            return
        self.text = self.lang.apply(self.text, word)
        self._refresh_text()

    def clear_text(self) -> None:
        self.text = ""
        self._refresh_text()
        self.toast("Cleared", color=theme.MUTED)

    def copy_text(self) -> None:
        if not self.text:
            self.toast("Nothing to copy", color=theme.MUTED)
            return
        self.root.clipboard_clear()
        self.root.clipboard_append(self.text)
        self.root.update_idletasks()
        self.toast("Copied to clipboard \u2713")

    def _refresh_text(self) -> None:
        self.display.configure(state="normal")
        self.display.delete("1.0", "end")
        self.display.insert("1.0", self.text)
        self.display.configure(state="disabled")
        self._refresh_suggestions()

    def _refresh_suggestions(self) -> None:
        words = self.lang.suggest(self.text)
        for i, btn in enumerate(self.suggest_buttons):
            btn.set_label(words[i] if i < len(words) else "")

    # ======================================================= calibration ===
    def start_calibration(self) -> None:
        if self.cal_session.collecting:
            return
        self.cal_session.start()
        # reset the settle/stability gate for the new session
        self._cal_buffer.clear()
        self._cal_point_seen = -1
        self._cal_point_at = 0.0
        self._cal_settle_at = 0.0
        self._last_fed = 0.0
        self.overlay.place(relx=0, rely=0, relwidth=1, relheight=1)
        # NB: Canvas overrides Tk's `raise` subcommand, so widget.lift() with no
        # args raises TclError here - call the window command directly instead.
        self.overlay.tk.call("raise", self.overlay._w)
        self._draw_calibration_overlay()
        self.toast("Calibration: follow the dot with your eyes", color=theme.ACCENT)
        self._update_chips()

    def cancel_calibration(self) -> None:
        if not self.cal_session.collecting:
            return
        self.cal_session.cancel()
        self.overlay.place_forget()
        self.toast("Calibration cancelled", color=theme.WARN)
        self._update_chips()

    def _draw_calibration_overlay(self) -> None:
        c = self.overlay
        c.delete("all")
        w = c.winfo_width() or self.root.winfo_width()
        h = c.winfo_height() or self.root.winfo_height()
        if w <= 1 or h <= 1:
            return
        c.create_text(w / 2, 46, text="CALIBRATION", font=theme.FONT_TITLE,
                      fill=theme.ACCENT)
        c.create_text(w / 2, 76,
                      text="Keep your head still and follow the dot with your eyes",
                      font=theme.FONT_BODY, fill=theme.MUTED)
        if not getattr(self, "_cal_face_ok", True):
            c.create_text(w / 2, 104,
                          text="No face detected - look straight at the camera",
                          font=theme.FONT_BODY, fill=theme.WARN)

        # live camera preview - larger during calibration so the user can
        # position themselves and see the directional guidance arrows
        if self._photo is not None:
            pw = self._photo.width()
            ph = self._photo.height()
            # place it centred-right with extra padding for visibility
            x0, y0 = w - pw - 24, 16
            # background panel behind the preview
            c.create_rectangle(x0 - 6, y0 - 6, x0 + pw + 6, y0 + ph + 24,
                               fill=theme.PANEL, outline=theme.ACCENT_DIM,
                               width=1, tags="cam")
            c.create_image(x0, y0, image=self._photo, anchor="nw", tags="cam")
            c.create_text(x0 + pw / 2, y0 + ph + 12,
                          text="camera \u00b7 position yourself using the arrows",
                          font=theme.FONT_SMALL, fill=theme.ACCENT, tags="cam")
        else:
            # no preview yet - show a placeholder to tell the user the camera
            # is still starting up
            pw, ph = 244, 184
            x0, y0 = w - pw - 24, 16
            c.create_rectangle(x0 - 6, y0 - 6, x0 + pw + 6, y0 + ph + 24,
                               fill="#05070c", outline=theme.ACCENT_DIM,
                               width=1, tags="cam")
            c.create_text(x0 + pw / 2, y0 + ph / 2,
                          text="Starting camera\u2026",
                          font=theme.FONT_BODY, fill=theme.MUTED, tags="cam")

        point = self.cal_session.current_point
        if point:
            x, y = point[0] * w, point[1] * h
            r = 34
            c.create_oval(x - r, y - r, x + r, y + r, outline=theme.ACCENT_DIM,
                          width=2)
            progress = self.cal_session.progress
            if progress > 0:
                c.create_arc(x - r, y - r, x + r, y + r, start=90,
                             extent=max(0.1, progress * 359.9), style="arc",
                             outline=theme.GOOD, width=5)
            c.create_oval(x - 7, y - 7, x + 7, y + 7, fill=theme.ACCENT, outline="")
            c.create_text(x, y + 62,
                          text=f"point {self.cal_session.index + 1} of "
                               f"{len(self.cal_session.points)}",
                          font=theme.FONT_SMALL, fill=theme.MUTED)
        c.create_text(w / 2, h - 34, text="Esc to cancel \u00b7 C to restart",
                      font=theme.FONT_SMALL, fill=theme.MUTED)

    def _finish_calibration(self) -> None:
        self.overlay.place_forget()
        if self.calibration.is_calibrated:
            quality = self.calibration.quality
            message = "Calibration saved \u2713"
            if quality is not None:
                message += f" \u00b7 avg error {quality * 100:.0f}% of screen"
            self.toast(message, color=theme.GOOD)
        elif self.calibration.samples:
            self.toast("Calibration too rough - keep your head still and press C",
                       color=theme.DANGER)
        else:
            self.toast("No face detected - try again", color=theme.DANGER)
        self._update_chips()

    # ============================================================= toast ===
    def toast(self, message: str, color: str = theme.GOOD) -> None:
        label = self.toast_label
        label.configure(text=message, fg=color)
        label.place(relx=0.5, rely=1.0, anchor="s", x=0, y=-16)
        label.lift()
        if self._toast_job:
            self.root.after_cancel(self._toast_job)
        self._toast_job = self.root.after(2400, label.place_forget)

    # ========================================================== interaction ==
    def _on_motion(self, event) -> None:
        self.mouse_pos = (event.x, event.y)

    def _on_canvas_click(self, event) -> None:
        """Direct mouse click on a key (setup / fallback / demo)."""
        key = self.keyboard.hit(event.x, event.y)
        if key:
            self._fire(Target("key", key, (0, 0, 0, 0)))

    @staticmethod
    def _rect_of(widget: tk.Misc) -> tuple[float, float, float, float]:
        x0, y0 = widget.winfo_rootx(), widget.winfo_rooty()
        return (x0, y0, x0 + widget.winfo_width(), y0 + widget.winfo_height())

    @staticmethod
    def _contains(rect, x: float, y: float) -> bool:
        return rect[0] <= x <= rect[2] and rect[1] <= y <= rect[3]

    def _target_at(self, gx: float, gy: float) -> Target | None:
        for btn in self.header_buttons:
            if not btn.canvas.winfo_ismapped():
                continue
            rect = self._rect_of(btn.canvas)
            if self._contains(rect, gx, gy):
                return Target("button", btn, rect)

        for btn in self.suggest_buttons:
            if not btn.label_text or not btn.canvas.winfo_ismapped():
                continue
            rect = self._rect_of(btn.canvas)
            if self._contains(rect, gx, gy):
                return Target("suggest", btn, rect)

        c = self.keyboard_canvas
        kx, ky = c.winfo_rootx(), c.winfo_rooty()
        if kx <= gx < kx + c.winfo_width() and ky <= gy < ky + c.winfo_height():
            key = self.keyboard.hit(gx - kx, gy - ky)
            if key:
                rect = self.keyboard.rect_of(key) or (0, 0, 0, 0)
                return Target("key", key,
                              (kx + rect[0], ky + rect[1], kx + rect[2], ky + rect[3]))
        return None

    @staticmethod
    def _distance(a: tuple[float, float], b: tuple[float, float]) -> float:
        return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5

    def _set_hover(self, target: Target | None) -> None:
        tid = target.id if target else None
        if tid == self.hovered:
            # refresh anyway: the keyboard canvas may have redrawn underneath us
            if target is not None and target.kind == "key":
                self.keyboard.set_hover(target.ref)
            return
        old, self.hovered = self.hovered, tid

        if old is not None and old[0] in ("button", "suggest") and old != tid:
            old[1].set_hover(False)
        if target is not None and target.kind in ("button", "suggest") and old != tid:
            target.ref.set_hover(True)

        # keyboard keys are handled internally (and survive canvas redraws)
        if target is not None and target.kind == "key":
            self.keyboard.set_hover(target.ref)
        else:
            self.keyboard.set_hover(None)

    def _fire(self, target: Target) -> None:
        if target.kind == "key":
            self.keyboard.flash(target.ref)
            self.on_key(target.ref)
        elif target.kind == "suggest":
            for i, btn in enumerate(self.suggest_buttons):
                if btn is target.ref:
                    self.apply_suggestion(i)
                    btn.flash()
                    break
        elif target.kind == "button":
            target.ref.flash()
            target.ref.action()

    # ================================================================= tick ==
    def tick(self) -> None:
        now = time.perf_counter()
        sample = self.tracker.latest() if self.tracker else None

        if self.cal_session.collecting:
            self._cal_face_ok = bool(sample and sample.found)
            # a new dot appeared: drop everything gathered for the old one
            if self.cal_session.index != self._cal_point_seen:
                self._cal_point_seen = self.cal_session.index
                self._cal_buffer.clear()
                self._cal_point_at = now
                self._cal_settle_at = now + SETTLE_SECONDS
            # feed once per *new* camera frame, and only once the gaze has
            # arrived at the dot: polling at 60 Hz would count the same gaze
            # sample several times, and travel samples point at the *previous*
            # dot (they triple the fit residual)
            if sample and sample.found and sample.t != self._last_fed:
                self._last_fed = sample.t
                self._cal_buffer.append((sample.u, sample.v))
                del self._cal_buffer[:-STABILITY_WINDOW]
                if self._gaze_settled(now):
                    self.cal_session.feed(sample.u, sample.v, sample.yaw,
                                          sample.pitch, sample.scale)
            self._draw_calibration_overlay()
            if self.cal_session.done:
                self._finish_calibration()
        else:
            self._interaction_tick(sample, now)

        self._maybe_update_preview(sample, now)
        self.root.after(16, self.tick)

    def _gaze_settled(self, now: float) -> bool:
        """True when the gaze has stopped travelling towards the current dot."""
        if now < self._cal_settle_at:
            return False
        buf = self._cal_buffer
        if len(buf) < 3:
            return False
        xs = [p[0] for p in buf]
        ys = [p[1] for p in buf]
        if max(max(xs) - min(xs), max(ys) - min(ys)) <= STABILITY_RADIUS:
            return True
        # never stall: if the gaze refuses to settle, count it anyway
        return now - self._cal_point_at > STABILITY_TIMEOUT

    def _smooth_cursor(self, gx: float, gy: float) -> tuple[float, float]:
        """EMA the mapped gaze so dwell is not restarted by eye jitter.

        Raw mapped positions jump by a few percent of the window between
        frames; without this the dwell ring resets before it can fill
        (RETRIGGER_DISTANCE is only 45 px).
        """
        if self._cursor is None:
            self._cursor = (gx, gy)
            return self._cursor
        cx, cy = self._cursor
        a = CURSOR_SMOOTHING
        self._cursor = (cx + a * (gx - cx), cy + a * (gy - cy))
        return self._cursor

    def _interaction_tick(self, sample: GazeFrame | None, now: float) -> None:
        gx = gy = None
        found = False

        if self.demo:
            if self.mouse_pos:
                gx, gy = self.mouse_pos
                found = True
        elif sample is not None and sample.found:
            found = True
            if self.calibration.is_calibrated:
                nx, ny = self.calibration.map_gaze(
                    sample.u, sample.v, sample.yaw, sample.pitch, sample.scale)
            else:
                if len(self.centre_samples) < 40:
                    self.centre_samples.append((sample.u, sample.v))
                    if len(self.centre_samples) >= 40:
                        self.auto_centre = auto_center(self.centre_samples)
                nx, ny = self.calibration.map_gaze(
                    sample.u, sample.v, sample.yaw, sample.pitch, sample.scale,
                    auto_centre=self.auto_centre)
            gx = nx * self.root.winfo_width()
            gy = ny * self.root.winfo_height()

        if not found or gx is None:
            self._cursor = None
            self._set_hover(None)
            self._reset_dwell()
            self._clear_progress()
            self.keyboard.draw_cursor(0, 0, visible=False)
            return

        gx, gy = self._smooth_cursor(gx, gy)
        point = (gx, gy)
        target = self._target_at(gx, gy)
        self._set_hover(target)

        # re-arm once the gaze has left the target that already fired
        if self.fired_on is not None and (target is None or target.id != self.fired_on):
            self.fired_on = None

        # --- blink = instant click ---------------------------------------
        if (target is not None and sample is not None and sample.blink
                and self.blink_enabled and self.fired_on != target.id
                and now >= self.cooldown_until):
            self._fire(target)
            self._after_fire(target, now, instant=True)
            self._clear_progress()
            self._draw_cursor_at(gx, gy)
            return

        # --- dwell --------------------------------------------------------
        if target is None or now < self.cooldown_until:
            self._reset_dwell()
            self._clear_progress()
            self._draw_cursor_at(gx, gy)
            return

        if (self.dwell_target != target.id
                or self._distance(point, self.dwell_anchor) > RETRIGGER_DISTANCE):
            self.dwell_target = target.id
            self.dwell_anchor = point
            self.dwell_start = now
            self.dwell_fired = False

        if self.fired_on == target.id:
            # already selected here - the gaze must leave before it can fire again
            self._clear_progress()
            self._draw_cursor_at(gx, gy)
            return

        repeatable = target.kind == "key" and target.ref.repeat
        needed = REPEAT_SECONDS if (repeatable and self.dwell_fired) else self.dwell_seconds
        progress = min(1.0, (now - self.dwell_start) / needed)
        self._draw_progress(target, progress)
        self._draw_cursor_at(gx, gy)

        if progress >= 1.0:
            self._fire(target)
            self._after_fire(target, now, instant=False)

    def _after_fire(self, target: Target, now: float, instant: bool) -> None:
        repeatable = target.kind == "key" and target.ref.repeat
        if instant or not repeatable:
            self.fired_on = target.id
            self.dwell_target = None
            self.dwell_fired = False
            self.cooldown_until = now + COOLDOWN_SECONDS
        else:
            # hold-to-repeat keys keep going while the gaze stays put
            self.dwell_start = now
            self.dwell_fired = True

    def _reset_dwell(self) -> None:
        self.dwell_target = None
        self.dwell_fired = False

    def _clear_progress(self) -> None:
        self.keyboard.draw_dwell_ring(None, 0)
        for btn in self.header_buttons + self.suggest_buttons:
            btn.set_progress(0)

    def _draw_progress(self, target: Target, progress: float) -> None:
        if target.kind == "key":
            self.keyboard.draw_dwell_ring(target.ref, progress)
            for btn in self.header_buttons + self.suggest_buttons:
                btn.set_progress(0)
        else:
            self.keyboard.draw_dwell_ring(None, 0)
            for btn in self.header_buttons + self.suggest_buttons:
                btn.set_progress(progress if btn is target.ref else 0)

    def _draw_cursor_at(self, gx: float, gy: float) -> None:
        c = self.keyboard_canvas
        self.keyboard.draw_cursor(gx - c.winfo_rootx(), gy - c.winfo_rooty(),
                                  visible=True)

    # ============================================================ preview ===
    def _set_preview_status(self, text: str, color: str) -> None:
        current = self.preview_label.cget("text")
        if current != text or self.preview_label.cget("fg") != color:
            self.preview_label.configure(text=text, fg=color)

    def _maybe_update_preview(self, sample: GazeFrame | None, now: float) -> None:
        if sample is None or not sample.preview:
            return
        if sample.preview is self._last_preview or now - self._last_preview_at < 0.15:
            return
        self._last_preview = sample.preview
        self._last_preview_at = now
        try:
            photo = tk.PhotoImage(data=sample.preview)
        except tk.TclError:
            return
        self._photo = photo
        self.preview_canvas.delete("img")
        self.preview_canvas.create_image(
            self.preview_canvas.winfo_width() / 2,
            self.preview_canvas.winfo_height() / 2,
            image=photo, anchor="center", tags="img")
        if not self.cal_session.collecting:
            if sample.found:
                self._set_preview_status("eyes detected \u25b8 live", theme.GOOD)
            else:
                self._set_preview_status("camera live \u00b7 no face yet", theme.WARN)

    # ============================================================= status ===
    def _update_chips(self) -> None:
        if self.demo:
            self.chips["face"].configure(text="\u25cf DEMO", fg=theme.ACCENT)
        elif self.tracker and self.tracker.error:
            self.chips["face"].configure(text="\u25cf NO CAMERA", fg=theme.DANGER)

        if self.cal_session.collecting:
            self.chips["calib"].configure(text="\u25cf CALIBRATING", fg=theme.ACCENT)
        elif self.calibration.is_calibrated:
            self.chips["calib"].configure(text="\u25cf CALIBRATED", fg=theme.GOOD)
        else:
            self.chips["calib"].configure(text="\u25cf UNCALIBRATED", fg=theme.WARN)

        blink = "on" if self.blink_enabled else "off"
        self.chips["mode"].configure(
            text=f"DWELL {self.dwell_seconds:.2f}s \u00b7 BLINK {blink}".upper(),
            fg=theme.MUTED)

    def _update_status(self) -> None:
        sample = self.tracker.latest() if self.tracker else None
        if self.demo:
            self.chips["face"].configure(text="\u25cf DEMO", fg=theme.ACCENT)
            self.chips["fps"].configure(text="MOUSE GAZE", fg=theme.ACCENT)
            self._set_preview_status("demo mode \u00b7 mouse gaze", theme.ACCENT)
        elif self.tracker and self.tracker.error:
            self.chips["face"].configure(text="\u25cf NO CAMERA", fg=theme.DANGER)
            self.chips["fps"].configure(text="-- FPS", fg=theme.MUTED)
            self._set_preview_status(self.tracker.error, theme.DANGER)
        elif sample is not None:
            state = "\u25cf FACE OK" if sample.found else "\u25cf NO FACE"
            color = theme.GOOD if sample.found else theme.WARN
            self.chips["face"].configure(text=state, fg=color)
            cam = self.tracker.active_camera if self.tracker else None
            fps = f"{sample.fps:.0f} FPS"
            self.chips["fps"].configure(
                text=f"{fps} \u00b7 CAM {cam}" if cam is not None else fps,
                fg=theme.MUTED)
            if not self.cal_session.collecting:
                if self.tracker is not None and self.tracker.frames_seen == 0:
                    self._set_preview_status("camera open \u00b7 waiting for frames\u2026",
                                             theme.WARN)
                elif sample.found:
                    self._set_preview_status("eyes detected \u25b8 live", theme.GOOD)
                else:
                    self._set_preview_status("camera live \u00b7 look at the camera",
                                             theme.WARN)
        elif self.tracker is not None:
            # tracker thread started but has not published a frame yet
            self.chips["face"].configure(text="\u25cf STARTING", fg=theme.MUTED)
            self.chips["fps"].configure(text="-- FPS", fg=theme.MUTED)
            self._set_preview_status("starting camera\u2026", theme.MUTED)
        self._update_chips()
        self.root.after(400, self._update_status)

    # ============================================================== exit ===
    def quit(self) -> None:
        if self.tracker:
            self.tracker.stop()
            self.tracker.join(timeout=1.5)   # let the worker release the camera
        self.root.destroy()


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="eyetype",
        description="Type with your eyes using MediaPipe gaze tracking.")
    p.add_argument("--camera", type=int, default=0, help="camera index (default 0)")
    p.add_argument("--dwell", type=float, default=0.7,
                   help="dwell time in seconds before a target fires (default 0.7)")
    p.add_argument("--no-blink", action="store_true",
                   help="disable blink-to-click")
    p.add_argument("--demo", action="store_true",
                   help="no camera: gaze follows the mouse (for testing)")
    p.add_argument("--no-auto-calibrate", action="store_true",
                   help="don't auto-start calibration on first run")
    return p


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    root = tk.Tk()
    EyeTypeApp(root, args)
    root.mainloop()
