from __future__ import annotations

import logging
from pathlib import Path

from PySide6.QtCore import QObject, QRunnable, Signal

from .file_utils import build_proposed_filename
from .models import AnalysisResult
from .openai_client import OpenAIPdfAnalyzer

logger = logging.getLogger(__name__)


class AnalysisWorkerSignals(QObject):
    result = Signal(str, object, str)
    error = Signal(str, str)
    finished = Signal(str)


class AnalysisWorker(QRunnable):
    def __init__(
        self,
        analyzer: OpenAIPdfAnalyzer,
        pdf_path: Path,
        naming_template: str,
    ) -> None:
        super().__init__()
        self.analyzer = analyzer
        self.pdf_path = pdf_path
        self.naming_template = naming_template
        self.signals = AnalysisWorkerSignals()

    def run(self) -> None:
        try:
            analysis = self.analyzer.analyze_pdf(str(self.pdf_path))
            proposed_name = build_proposed_filename(analysis, self.naming_template)
            self.signals.result.emit(str(self.pdf_path), analysis, proposed_name)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Analysis failed for %s", self.pdf_path)
            self.signals.error.emit(str(self.pdf_path), str(exc))
        finally:
            self.signals.finished.emit(str(self.pdf_path))
