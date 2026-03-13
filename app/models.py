from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path


class ItemStatus(str, Enum):
    PENDING = "未解析"
    ANALYZING = "解析中"
    READY = "確認待ち"
    NEEDS_REVIEW = "要確認"
    SKIPPED = "スキップ"
    RENAMED = "リネーム済み"
    ERROR = "エラー"


@dataclass
class AnalysisResult:
    document_type: str
    issuer_name: str | None
    date: str | None
    amount: str | None
    title: str | None
    description: str | None
    confidence: float

    def to_dict(self) -> dict[str, object]:
        return {
            "document_type": self.document_type,
            "issuer_name": self.issuer_name,
            "date": self.date,
            "amount": self.amount,
            "title": self.title,
            "description": self.description,
            "confidence": self.confidence,
        }


@dataclass
class AppSettings:
    naming_template: str = "{date}_{issuer_name}_{document_type}_{amount}"
    openai_model: str = "gpt-4.1-mini"

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass
class PdfItem:
    source_path: Path
    current_path: Path
    status: ItemStatus = ItemStatus.PENDING
    analysis: AnalysisResult | None = None
    proposed_name: str = ""
    error_message: str = ""
    skipped: bool = False
    checked: bool = False
    history: list[str] = field(default_factory=list)

    @property
    def display_name(self) -> str:
        return self.current_path.name
