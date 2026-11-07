#!/usr/bin/env bash
# Downloads and extracts Tk (python3-tk + Tk 8.6 + BLT) into vendor/ so the
# app can run without root privileges. Only needed when the system Python has
# no tkinter. Alternative: sudo apt install python3-tk
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEBS="$ROOT/vendor/debs"
OUT="$ROOT/vendor/tk"

mkdir -p "$DEBS" "$OUT"
cd "$DEBS"

echo "Downloading Tk packages (python3-tk, tk8.6, libtk8.6, tk8.6-blt2.5)..."
apt-get download python3-tk tk8.6 libtk8.6 tk8.6-blt2.5

echo "Extracting into $OUT ..."
for deb in *.deb; do
    dpkg -x "$deb" "$OUT"
done

# The _tkinter extension normally lives in lib-dynload/, which is not on
# sys.path - copy it next to the tkinter package so `import _tkinter` finds it.
cp -f "$OUT/usr/lib/python3.12/lib-dynload/"_tkinter*.so "$OUT/usr/lib/python3.12/"

echo "Done. Verify with:  . scripts/env.sh && .venv/bin/python -c 'import tkinter; print(tkinter.TkVersion)'"
