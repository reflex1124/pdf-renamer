from __future__ import annotations

import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

from .logging_utils import setup_logging
from .main_window import run_app


def main() -> int:
    load_dotenv(Path.cwd() / ".env")
    log_path = setup_logging()
    logging.getLogger(__name__).info("Application starting. Logs: %s", log_path)
    return run_app()


if __name__ == "__main__":
    raise SystemExit(main())
