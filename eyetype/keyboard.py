"""Keyboard layout model and its canvas rendering.

The layout is a fixed 10-column grid; keys may span several columns
(the space bar spans 5). Rendering is done on a tk.Canvas so we get a
modern flat look without any heavyweight GUI toolkit.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import tkinter as tk

from . import theme

COLS = 10.0
ROWS = 4


@dataclass
class Key:
    id: str
    label: str
    action: str            # char | shift | backspace | space | enter | page | repeat helpers
    value: str = ""
    row: int = 0
    col: float = 0.0
    span: float = 1.0
    repeat: bool = False   # dwell-hold repeats (backspace / space)
    accent: bool = False   # highlighted styling


def _chars(text: str, row: int, col0: float = 0.0) -> list[Key]:
    return [
        Key(id=c, label=c, action="char", value=c, row=row, col=col0 + i)
        for i, c in enumerate(text)
    ]


def _page_abc() -> list[Key]:
    keys: list[Key] = []
    keys += _chars("qwertyuiop", 0)
    keys += _chars("asdfghjkl", 1, col0=0.5)
    keys.append(Key("shift", "\u21e7", "shift", row=2, col=0, span=1.5))
    keys += _chars("zxcvbnm", 2, col0=1.5)
    keys.append(Key("backspace", "\u232b", "backspace", row=2, col=8.5, span=1.5,
                    repeat=True))
    keys.append(Key("page123", "123", "page", value="123", row=3, col=0, span=1.5))
    keys.append(Key("comma", ",", "char", value=",", row=3, col=1.5))
    keys.append(Key("space", "space", "space", value=" ", row=3, col=2.5, span=5,
                    repeat=True, accent=True))
    keys.append(Key("period", ".", "char", value=".", row=3, col=7.5))
    keys.append(Key("enter", "\u21b5", "enter", row=3, col=8.5, span=1.5))
    return keys


def _page_123() -> list[Key]:
    keys: list[Key] = []
    keys += _chars("1234567890", 0)
    keys += _chars("@#$%&*()-+", 1)
    keys += _chars("[]{};:'\",.", 2)
    keys.append(Key("pageabc", "ABC", "page", value="abc", row=3, col=0, span=1.5))
    keys.append(Key("qmark", "?", "char", value="?", row=3, col=1.5))
    keys.append(Key("bang", "!", "char", value="!", row=3, col=2.5))
    keys.append(Key("space123", "space", "space", value=" ", row=3, col=3.5, span=4,
                    repeat=True, accent=True))
    keys.append(Key("slash", "/", "char", value="/", row=3, col=7.5))
    keys.append(Key("backspace123", "\u232b", "backspace", row=3, col=8.5, span=1.5,
                    repeat=True))
    return keys


PAGES = {"abc": _page_abc(), "123": _page_123()}


@dataclass
class KeyBox:
    key: Key
    x0: float
    y0: float
    x1: float
    y1: float


class KeyboardView:
    """Lays out and draws the on-screen keyboard on a Canvas."""

    def __init__(self, canvas: tk.Canvas) -> None:
        self.canvas = canvas
        self.page = "abc"
        self.shift = False
        self.boxes: list[KeyBox] = []
        self._items: dict[str, dict[str, int]] = {}
        self._hover: Key | None = None
        canvas.bind("<Configure>", lambda _e: self.redraw())

    # ------------------------------------------------------------- layout --
    @property
    def keys(self) -> list[Key]:
        return PAGES[self.page]

    def relayout(self) -> None:
        self.redraw()

    def set_page(self, page: str) -> None:
        if page in PAGES and page != self.page:
            self.page = page
            self._hover = None
            self.redraw()

    def toggle_shift(self) -> None:
        self.shift = not self.shift
        self.redraw()

    def key_by_id(self, key_id: str) -> Key | None:
        for key in self.keys:
            if key.id == key_id:
                return key
        return None

    def hit(self, x: float, y: float) -> Key | None:
        for box in self.boxes:
            if box.x0 <= x <= box.x1 and box.y0 <= y <= box.y1:
                return box.key
        return None

    def rect_of(self, key: Key) -> tuple[float, float, float, float] | None:
        for box in self.boxes:
            if box.key is key:
                return (box.x0, box.y0, box.x1, box.y1)
        return None

    # ------------------------------------------------------------ drawing --
    def redraw(self) -> None:
        canvas = self.canvas
        w = canvas.winfo_width()
        h = canvas.winfo_height()
        if w <= 1 or h <= 1:
            return
        canvas.delete("keys")
        canvas.delete("cursor")
        canvas.delete("dwell_ring")
        self._items.clear()
        self.boxes.clear()

        cell_w = w / COLS
        cell_h = h / ROWS
        pad_x = max(4.0, cell_w * 0.06)
        pad_y = max(4.0, cell_h * 0.14)

        for key in self.keys:
            x0 = key.col * cell_w + pad_x
            x1 = (key.col + key.span) * cell_w - pad_x
            y0 = key.row * cell_h + pad_y
            y1 = (key.row + 1) * cell_h - pad_y
            self.boxes.append(KeyBox(key, x0, y0, x1, y1))

            fill = theme.KEY_ALT if (key.accent or key.action != "char") else theme.KEY
            rect = theme.round_rect(canvas, x0, y0, x1, y1, radius=12, fill=fill,
                                    outline="", tags="keys")
            label_key = key.label
            if key.id == "shift" and self.shift:
                label_key = "\u21e7"
            font = theme.FONT_KEY if key.action == "char" else theme.FONT_KEY_SPECIAL
            fg = theme.ACCENT if (key.id == "shift" and self.shift) else theme.TEXT
            if key.accent:
                fg = theme.MUTED
            text = canvas.create_text(
                (x0 + x1) / 2, (y0 + y1) / 2, text=label_key, font=font, fill=fg,
                tags="keys",
            )
            self._items[key.id] = {"rect": rect, "text": text}

        # cursor goes on top of the keys.
        canvas.tag_lower("keys")
        self._cursor_outer = canvas.create_oval(0, 0, 0, 0, outline=theme.CURSOR,
                                                width=2, tags="cursor")
        self._cursor_inner = canvas.create_oval(0, 0, 0, 0, fill=theme.CURSOR,
                                                outline="", tags="cursor")
        canvas.tag_raise("cursor")
        self._hover = None

    # ----------------------------------------------------------- feedback --
    def set_hover(self, key: Key | None) -> None:
        if key is self._hover:
            return
        self._restore_hover()
        self._hover = key
        if key is None:
            return
        items = self._items.get(key.id)
        if items:
            self.canvas.itemconfigure(items["rect"], fill=theme.KEY_HOVER)

    def _restore_hover(self) -> None:
        if self._hover is None:
            return
        items = self._items.get(self._hover.id)
        if items:
            key = self._hover
            fill = theme.KEY_ALT if (key.accent or key.action != "char") else theme.KEY
            self.canvas.itemconfigure(items["rect"], fill=fill)
        self._hover = None

    def flash(self, key: Key) -> None:
        items = self._items.get(key.id)
        if not items:
            return
        self.canvas.itemconfigure(items["rect"], fill=theme.KEY_FLASH)
        self.canvas.after(120, lambda: self._restore(key))

    def _restore(self, key: Key) -> None:
        items = self._items.get(key.id)
        if not items:
            return
        fill = theme.KEY_ALT if (key.accent or key.action != "char") else theme.KEY
        if key is self._hover:
            fill = theme.KEY_HOVER
        self.canvas.itemconfigure(items["rect"], fill=fill)

    def draw_dwell_ring(self, key: Key | None, progress: float) -> None:
        canvas = self.canvas
        if key is None or progress <= 0:
            canvas.delete("dwell_ring")
            return
        rect = self.rect_of(key)
        if rect is None:
            return
        x0, y0, x1, y1 = rect
        if not canvas.find_withtag("dwell_ring"):
            canvas.create_arc(x0 - 5, y0 - 5, x1 + 5, y1 + 5, start=90,
                              extent=0.1, style="arc", outline=theme.GOOD, width=4,
                              tags="dwell_ring")
        canvas.coords("dwell_ring", x0 - 5, y0 - 5, x1 + 5, y1 + 5)
        canvas.itemconfigure("dwell_ring", extent=max(0.1, progress * 359.9))
        canvas.tag_raise("dwell_ring")

    def draw_cursor(self, x: float, y: float, visible: bool = True) -> None:
        if not hasattr(self, "_cursor_outer"):
            return
        if not visible:
            self.canvas.coords(self._cursor_outer, 0, 0, 0, 0)
            self.canvas.coords(self._cursor_inner, 0, 0, 0, 0)
            return
        r = 13
        self.canvas.coords(self._cursor_outer, x - r, y - r, x + r, y + r)
        self.canvas.coords(self._cursor_inner, x - 3, y - 3, x + 3, y + 3)
