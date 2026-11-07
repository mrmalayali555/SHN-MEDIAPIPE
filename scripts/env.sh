#!/usr/bin/env bash
# Sets up the environment for EyeType.  SOURCE this file:  . scripts/env.sh
#
# Preference order:
#   1. a Tk that can actually see system fonts (system python3-tk, Xft enabled)
#   2. the locally extracted Tk in vendor/ (scripts/bootstrap_tk.sh, no root)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="$ROOT/.venv/bin/python"

if [ ! -x "$PY" ]; then
    echo "Missing virtualenv at $PY" >&2
    echo "Create it with:  uv venv --python 3.12 && uv pip install -r requirements.txt" >&2
    return 1 2>/dev/null || exit 1
fi

# A usable Tk must (a) import and (b) enumerate a normal amount of system
# fonts - a font-less stub build only knows ~47 legacy bitmap families.
tk_works() {
    "$PY" - <<'EOF' >/dev/null 2>&1
import tkinter, tkinter.font as tkfont
root = tkinter.Tk(); root.withdraw()
count = len(tkfont.families())
root.destroy()
raise SystemExit(0 if count >= 100 else 1)
EOF
}

if tk_works; then
    return 0 2>/dev/null || exit 0
fi

TK_ROOT="$ROOT/vendor/tk"
if [ -d "$TK_ROOT/usr/lib/python3.12/tkinter" ]; then
    export PYTHONPATH="$TK_ROOT/usr/lib/python3.12${PYTHONPATH:+:$PYTHONPATH}"
    export LD_LIBRARY_PATH="$TK_ROOT/usr/lib:$TK_ROOT/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export TK_LIBRARY="$TK_ROOT/usr/share/tcltk/tk8.6"
    export TCL_LIBRARY="${TCL_LIBRARY:-/usr/share/tcltk/tcl8.6}"
    if tk_works; then
        return 0 2>/dev/null || exit 0
    fi
fi

echo "No usable Tk found. Install one with:" >&2
echo "  sudo apt install python3-tk        (recommended)" >&2
echo "  scripts/bootstrap_tk.sh            (no root needed)" >&2
return 1 2>/dev/null || exit 1
