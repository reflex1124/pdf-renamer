from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from .models import AnalysisResult

INVALID_FILENAME_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]+')
MULTISPACE = re.compile(r"\s+")
TOKEN_PATTERN = re.compile(r"{([a-z_]+)}")
DEFAULT_TEMPLATE = "{date}_{issuer_name}_{document_type}_{amount}"
AVAILABLE_TOKENS = (
    "date",
    "issuer_name",
    "document_type",
    "amount",
    "title",
)


def normalize_date(value: str | None) -> str:
    if not value:
        return "unknown-date"
    normalized = unicodedata.normalize("NFKC", value).strip()
    parts = [part for part in re.split(r"[^\d]+", normalized) if part]
    if len(parts) >= 3:
        first, second, third = parts[0], parts[1], parts[2]
        if len(first) == 4:
            return f"{first}-{second.zfill(2)}-{third.zfill(2)}"
        if len(third) == 4:
            year = third
            if int(first) > 12:
                day, month = first, second
            else:
                month, day = first, second
            return f"{year}-{month.zfill(2)}-{day.zfill(2)}"
    if len(parts) == 2:
        first, second = parts[0], parts[1]
        if len(first) == 4:
            return f"{first}-{second.zfill(2)}-01"
        if len(second) == 4:
            return f"{second}-{first.zfill(2)}-01"

    digits = re.sub(r"[^\d]", "-", normalized).strip("-")
    digits = re.sub(r"-{2,}", "-", digits)
    return digits or "unknown-date"


def sanitize_filename_component(value: str | None, fallback: str = "unknown") -> str:
    text = (value or "").strip()
    if not text:
        text = fallback
    text = unicodedata.normalize("NFKC", text)
    text = INVALID_FILENAME_CHARS.sub("_", text)
    text = MULTISPACE.sub(" ", text)
    text = text.strip(" ._")
    return text[:60] or fallback


def format_amount(value: str | None) -> str:
    if not value:
        return "unknown-amount"
    normalized = unicodedata.normalize("NFKC", value).replace(",", "").strip()
    digits = re.sub(r"[^\d.]", "", normalized)
    if not digits:
        return sanitize_filename_component(normalized, "unknown-amount")
    if "." in digits:
        return f"{digits.rstrip('0').rstrip('.')}円"
    return f"{digits}円"


def analysis_tokens(analysis: AnalysisResult) -> dict[str, str]:
    return {
        "date": normalize_date(analysis.date),
        "issuer_name": sanitize_filename_component(analysis.issuer_name, "unknown-issuer"),
        "document_type": sanitize_filename_component(analysis.document_type, "other"),
        "amount": format_amount(analysis.amount),
        "title": sanitize_filename_component(analysis.title, "untitled"),
    }


def normalize_template(template: str) -> str:
    text = unicodedata.normalize("NFKC", template or "").strip()
    return text or DEFAULT_TEMPLATE


def validate_template(template: str) -> tuple[bool, str]:
    normalized = normalize_template(template)
    tokens = TOKEN_PATTERN.findall(normalized)
    if not tokens:
        return False, "トークンを1つ以上含めてください。例: {date}_{issuer_name}_{document_type}_{amount}"
    invalid = sorted(set(token for token in tokens if token not in AVAILABLE_TOKENS))
    if invalid:
        return False, f"未対応トークンがあります: {', '.join(invalid)}"
    return True, ""


def build_proposed_filename(
    analysis: AnalysisResult,
    template: str = DEFAULT_TEMPLATE,
) -> str:
    normalized_template = normalize_template(template)
    token_map = analysis_tokens(analysis)
    def replace_token(match: re.Match[str]) -> str:
        return token_map.get(match.group(1), "unknown")

    rendered = TOKEN_PATTERN.sub(replace_token, normalized_template)
    parts = [
        sanitize_filename_component(part, "")
        for part in rendered.split("_")
    ]
    parts = [part for part in parts if part]

    if not parts:
        parts = [token_map["date"], token_map["issuer_name"], token_map["document_type"]]
    return "_".join(parts) + ".pdf"


def ensure_pdf_extension(name: str) -> str:
    return name if name.lower().endswith(".pdf") else f"{name}.pdf"


def resolve_collision(directory: Path, target_name: str) -> Path:
    safe_name = ensure_pdf_extension(target_name)
    candidate = directory / safe_name
    if not candidate.exists():
        return candidate

    stem = candidate.stem
    suffix = candidate.suffix
    index = 1
    while True:
        next_candidate = directory / f"{stem} ({index}){suffix}"
        if not next_candidate.exists():
            return next_candidate
        index += 1
