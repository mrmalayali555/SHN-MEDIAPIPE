"""Word suggestions: prefix completion + next-word prediction.

Lightweight by design - two flat data files, no model runtime:

  assets/words.txt        frequency-ordered English words (for completions)
  assets/next_words.json  small transition table learned from public-domain books
"""

from __future__ import annotations

import bisect
import json
import re
from pathlib import Path

ASSETS = Path(__file__).resolve().parent.parent / "assets"

WORD_END_RE = re.compile(r"([A-Za-z']+)$")
STRIP_PUNCT = ".,!?;:\"'()-"


class LanguageModel:
    def __init__(self, assets: Path = ASSETS) -> None:
        words = [
            w.strip().lower()
            for w in (assets / "words.txt").read_text(encoding="utf-8").splitlines()
            if w.strip()
        ]
        # rank: lower is more frequent
        self.rank = {w: i for i, w in enumerate(words)}
        self.sorted_words = sorted(set(words))
        self.freq_order = sorted(set(words), key=lambda w: self.rank.get(w, 10**9))

        try:
            data = json.loads((assets / "next_words.json").read_text(encoding="utf-8"))
        except FileNotFoundError:
            data = {}
        self.start: list[str] = data.get("start", [])[:3]
        self.next: dict[str, list[str]] = data.get("next", {})

    # -------------------------------------------------------- completions --
    def completions(self, prefix: str, limit: int = 3) -> list[str]:
        prefix = prefix.lower()
        if not prefix:
            return []
        lo = bisect.bisect_left(self.sorted_words, prefix)
        hi = bisect.bisect_right(self.sorted_words, prefix + "\uffff")
        candidates = self.sorted_words[lo:hi]
        if not candidates:
            return []
        candidates.sort(key=lambda w: self.rank.get(w, 10**9))
        return candidates[:limit]

    def suggest(self, text: str, limit: int = 3) -> list[str]:
        """Suggestions for the current caret position inside *text*."""
        if text == "" or text.endswith((" ", "\n", "\t")):
            return self.next_word(text, limit)
        match = WORD_END_RE.search(text)
        if not match:
            return []
        return self.completions(match.group(1), limit)

    def next_word(self, text: str, limit: int = 3) -> list[str]:
        previous = text.split()
        if not previous:
            return self.start[:limit]
        last = previous[-1].lower().strip(STRIP_PUNCT)
        if last in self.next:
            return self.next[last][:limit]
        return self.start[:limit]

    # ----------------------------------------------------------- applying --
    @staticmethod
    def apply(text: str, word: str) -> str:
        """Replace the partial word at the caret with *word* plus a space."""
        match = WORD_END_RE.search(text)
        if match:
            text = text[: match.start()]
        return text + word + " "
