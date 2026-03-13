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
    "description",
)

_ALPHA_CURRENCY_MARKERS = (
    ("USD", "USD"),
    ("US$", "USD"),
    ("AUD", "AUD"),
    ("CAD", "CAD"),
    ("SGD", "SGD"),
    ("HKD", "HKD"),
    ("JPY", "JPY"),
    ("EUR", "EUR"),
    ("GBP", "GBP"),
    ("CNY", "CNY"),
    ("RMB", "CNY"),
    ("CHF", "CHF"),
    ("KRW", "KRW"),
    ("INR", "INR"),
    ("THB", "THB"),
    ("TWD", "TWD"),
    ("NT$", "TWD"),
)

_SYMBOL_CURRENCY_MARKERS = (
    ("¥", "JPY"),
    ("円", "JPY"),
    ("€", "EUR"),
    ("£", "GBP"),
    ("₩", "KRW"),
    ("₹", "INR"),
    ("฿", "THB"),
    ("$", "USD"),
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


def detect_currency(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value)
    upper = normalized.upper()

    for marker, code in _ALPHA_CURRENCY_MARKERS:
        if marker.upper() in upper:
            return code

    for marker, code in _SYMBOL_CURRENCY_MARKERS:
        if marker in normalized:
            return code

    return ""


def format_amount(value: str | None) -> str:
    if not value:
        return "unknown-amount"

    normalized = unicodedata.normalize("NFKC", value).replace(",", "").strip()
    currency = detect_currency(normalized)
    match = re.search(r"\d+(?:\.\d+)?", normalized)
    if not match:
        return sanitize_filename_component(normalized, "unknown-amount")
    amount = match.group(0)

    if currency:
        return f"{currency}{amount}"
    return sanitize_filename_component(amount, "unknown-amount")


def analysis_tokens(analysis: AnalysisResult) -> dict[str, str]:
    return {
        "date": normalize_date(analysis.date),
        "issuer_name": sanitize_filename_component(analysis.issuer_name, "unknown-issuer"),
        "document_type": sanitize_filename_component(analysis.document_type, "other"),
        "amount": format_amount(analysis.amount),
        "title": sanitize_filename_component(analysis.title, "untitled"),
        "description": sanitize_filename_component(analysis.description, "no-description"),
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
