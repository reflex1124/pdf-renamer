from __future__ import annotations

import json
import logging
from pathlib import Path

from .models import AppSettings

logger = logging.getLogger(__name__)

SETTINGS_PATH = Path("config") / "settings.json"


def load_settings() -> AppSettings:
    if not SETTINGS_PATH.exists():
        return AppSettings()

    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
        return AppSettings(
            naming_template=str(
                data.get("naming_template", AppSettings().naming_template),
            ),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to load settings: %s", exc)
        return AppSettings()


def save_settings(settings: AppSettings) -> None:
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(settings.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
