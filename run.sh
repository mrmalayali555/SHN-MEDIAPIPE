#!/usr/bin/env bash
# Launch EyeType:  ./run.sh [--demo] [--camera 0] [--dwell 0.7] ...
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/env.sh
source "$ROOT/scripts/env.sh"
exec "$ROOT/.venv/bin/python" -m eyetype "$@"
