from __future__ import annotations

import os
import sys

# Allow running without installing the package (and for PyInstaller entry).
PROJECT_ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(PROJECT_ROOT, "src")
if SRC_DIR not in sys.path:
    sys.path.insert(0, SRC_DIR)

from ai_video_source_get.cli import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())

