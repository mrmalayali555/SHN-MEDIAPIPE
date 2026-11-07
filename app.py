"""Root entrypoint for Vercel and production WSGI servers."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from eyevoice.server import app

if __name__ == "__main__":
    app.run()

