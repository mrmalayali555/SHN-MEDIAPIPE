"""Regenerate language assets used for gaze-typing suggestions.

Produces:
  assets/words.txt        - top English words, frequency ordered (prefix completion)
  assets/next_words.json  - small next-word model (after typing a word + space)

Usage:
  python scripts/build_language_assets.py
"""

from __future__ import annotations

import json
import re
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

WORDS_URL = (
    "https://raw.githubusercontent.com/first20hours/"
    "google-10000-english/master/google-10000-english-usa.txt"
)
# Public-domain text used to learn word transitions.
BOOK_URLS = [
    "https://www.gutenberg.org/cache/epub/1342/pg1342.txt",   # Pride and Prejudice
    "https://www.gutenberg.org/cache/epub/11/pg11.txt",       # Alice in Wonderland
    "https://www.gutenberg.org/cache/epub/84/pg84.txt",       # Frankenstein
    "https://www.gutenberg.org/cache/epub/1661/pg1661.txt",   # A Study in Scarlet
    "https://www.gutenberg.org/cache/epub/345/pg345.txt",     # Dracula
    "https://www.gutenberg.org/cache/epub/2701/pg2701.txt",   # Moby Dick
]

MIN_WORD_COUNT = 3      # only keep transitions for words seen at least this often
MAX_NEXT = 4            # successors kept per word
MAX_VOCAB = 6000        # how many words get a next-word table

TOKEN_RE = re.compile(r"[a-z']+")


def fetch(url: str) -> str:
    print(f"  fetching {url}")
    with urllib.request.urlopen(url, timeout=60) as resp:
        return resp.read().decode("utf-8", errors="replace")


def download_word_list() -> None:
    dest = ASSETS / "words.txt"
    if dest.exists() and len(dest.read_text().split()) > 5000:
        print("  words.txt already present, skipping")
        return
    print("  downloading word frequency list")
    dest.write_text(fetch(WORDS_URL))


def build_next_words() -> None:
    transitions: dict[str, Counter] = defaultdict(Counter)
    starts: Counter = Counter()

    for url in BOOK_URLS:
        text = fetch(url).lower()
        # Strip Gutenberg header/footer (keep only the book body).
        start = text.find("*** start")
        end = text.find("*** end")
        if start != -1 and end != -1:
            text = text[start:end]
            text = text.split("\n", 1)[1] if "\n" in text else ""  # drop the marker line
        words = TOKEN_RE.findall(text)
        # Sentence starters: words that follow sentence-ending punctuation.
        for w in re.findall(r"[.!?]\s+([a-z][a-z']*)", text):
            starts[w] += 1
        for a, b in zip(words, words[1:]):
            transitions[a][b] += 1

    model: dict[str, list[str]] = {}
    ranked = sorted(
        (w for w, c in transitions.items() if c.total() >= MIN_WORD_COUNT),
        key=lambda w: transitions[w].total(),
        reverse=True,
    )[:MAX_VOCAB]
    for word in ranked:
        top = [w for w, _ in transitions[word].most_common(MAX_NEXT) if w != word]
        if top:
            model[word] = top

    payload = {
        "start": [w for w, _ in starts.most_common(MAX_NEXT)],
        "next": model,
    }
    dest = ASSETS / "next_words.json"
    dest.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"  wrote {dest} ({dest.stat().st_size // 1024} KB, {len(model)} words)")


def main() -> None:
    ASSETS.mkdir(exist_ok=True)
    print("Building language assets...")
    download_word_list()
    build_next_words()
    print("Done.")


if __name__ == "__main__":
    main()
