"""Make the vision test suite runnable from either the repo or vision root."""

from pathlib import Path
import sys


VISION_ROOT = str(Path(__file__).resolve().parents[1])
if VISION_ROOT not in sys.path:
    sys.path.insert(0, VISION_ROOT)
