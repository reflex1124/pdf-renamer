from __future__ import annotations

import base64
import logging
import os
import re
import json
from pathlib import Path

from openai import OpenAI
from pydantic import BaseModel, Field
from pypdf import PdfReader

from .models import AnalysisResult

logger = logging.getLogger(__name__)
SNAPSHOT_SUFFIX = re.compile(r"-\d{4}-\d{2}-\d{2}$")
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
PDF_EXTENSION = ".pdf"


class AnalysisSchema(BaseModel):
    document_type: str = Field(description="日本語の文書種別。例: 請求書、領収書、見積書、納品書、契約書、注文書、明細書、その他。")
    issuer_name: str | None = Field(default=None, description="Issuer, vendor, sender, or company name.")
    date: str | None = Field(
        default=None,
        description="Document date in YYYY-MM-DD when possible. Use YYYY-MM-01 if only year-month is known.",
    )
    amount: str | None = Field(default=None, description="Primary monetary amount mentioned in the document if available.")
    title: str | None = Field(default=None, description="Short descriptive title for the document.")
    description: str | None = Field(
        default=None,
        description="Main item, description, contents, line item summary, or service/product summary found in the document.",
    )
    confidence: float = Field(description="Confidence score from 0.0 to 1.0.")


class BatchAnalysisItem(BaseModel):
    document_id: str = Field(description="The exact document_id provided in the request.")
    analysis: AnalysisSchema


class BatchAnalysisResponse(BaseModel):
    documents: list[BatchAnalysisItem]


class OpenAIPdfAnalyzer:
    def __init__(self, model: str = "gpt-4.1-mini") -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("環境変数 OPENAI_API_KEY が設定されていません。")

        self.client = OpenAI(api_key=api_key)
        self.model = model

    def set_model(self, model: str) -> None:
        self.model = model.strip() or self.model

    def supported_extensions(self) -> set[str]:
        return set(IMAGE_EXTENSIONS) | {PDF_EXTENSION}

    def list_models(self) -> list[str]:
        response = self.client.models.list()
        preferred_models: list[str] = []
        for model in response.data:
            model_id = getattr(model, "id", "")
            if not model_id.startswith("gpt-"):
                continue
            if SNAPSHOT_SUFFIX.search(model_id):
                continue
            if any(token in model_id for token in ("realtime", "audio", "transcribe", "tts", "search")):
                continue
            preferred_models.append(model_id)

        def sort_key(model_id: str) -> tuple[int, str]:
            priority = {
                "gpt-5": 0,
                "gpt-5-mini": 1,
                "gpt-5-nano": 2,
                "gpt-4.1": 3,
                "gpt-4.1-mini": 4,
                "gpt-4.1-nano": 5,
                "gpt-4o": 6,
                "gpt-4o-mini": 7,
            }
            return (priority.get(model_id, 99), model_id)

        unique_models = sorted(set(preferred_models), key=sort_key)
        return unique_models

    def extract_text(self, pdf_path: str, max_chars: int = 12000) -> str:
        reader = PdfReader(pdf_path)
        chunks: list[str] = []
        total_chars = 0
        for page in reader.pages:
            text = page.extract_text() or ""
            stripped = text.strip()
            if stripped:
                chunks.append(stripped)
                total_chars += len(stripped)
            if total_chars >= max_chars:
                break

        extracted = "\n\n".join(chunks).strip()
        if not extracted:
            raise RuntimeError("PDF からテキストを抽出できませんでした。画像PDFはOCRが必要です。")

        return extracted[:max_chars]

    def has_extractable_text(self, pdf_path: str, threshold: int = 20) -> bool:
        try:
            return len(self.extract_text(pdf_path, max_chars=2000).strip()) >= threshold
        except Exception:  # noqa: BLE001
            return False

    def _single_document_prompt(self) -> list[dict[str, object]]:
        return [
            {
                "role": "system",
                "content": (
                    "You extract structured metadata from business documents. "
                    "The document_type must always be written in Japanese. "
                    "Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. "
                    "Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. "
                    "description should be a short summary of what the charge or document is for. "
                    "For missing values, use null. "
                    "Preserve the original currency in amount values and normalize it to ISO currency codes. "
                    "For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. "
                    "Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. "
                    "Confidence must be a number between 0.0 and 1.0."
                ),
            },
        ]

    def _parse_single_response(self, response) -> AnalysisResult:
        parsed = response.output_parsed
        return AnalysisResult(
            document_type=parsed.document_type,
            issuer_name=parsed.issuer_name,
            date=parsed.date,
            amount=parsed.amount,
            title=parsed.title,
            description=parsed.description,
            confidence=max(0.0, min(1.0, parsed.confidence)),
        )

    def _analyze_text_content(self, text: str, filename: str) -> AnalysisResult:
        response = self.client.responses.parse(
            model=self.model,
            input=[
                *self._single_document_prompt(),
                {
                    "role": "user",
                    "content": (
                        f"Analyze this business document text extracted from '{filename}'. "
                        "Return the structured result.\n\n"
                        f"{text}"
                    ),
                },
            ],
            text_format=AnalysisSchema,
        )
        return self._parse_single_response(response)

    def _upload_file(self, path: Path) -> str:
        with path.open("rb") as handle:
            uploaded = self.client.files.create(file=handle, purpose="user_data")
        return uploaded.id

    def _analyze_pdf_with_file_input(self, pdf_path: str) -> AnalysisResult:
        path = Path(pdf_path)
        file_id = self._upload_file(path)
        response = self.client.responses.parse(
            model=self.model,
            input=[
                *self._single_document_prompt(),
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_file",
                            "file_id": file_id,
                        },
                        {
                            "type": "input_text",
                            "text": (
                                f"Analyze this PDF file named '{path.name}'. "
                                "Use OCR if needed and return the structured result."
                            ),
                        },
                    ],
                },
            ],
            text_format=AnalysisSchema,
        )
        return self._parse_single_response(response)

    def _analyze_image_file(self, image_path: str) -> AnalysisResult:
        path = Path(image_path)
        suffix = path.suffix.lower().lstrip(".") or "png"
        encoded = base64.b64encode(path.read_bytes()).decode("ascii")
        response = self.client.responses.parse(
            model=self.model,
            input=[
                *self._single_document_prompt(),
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": (
                                f"Analyze this document image named '{path.name}'. "
                                "Read the image directly and return the structured result."
                            ),
                        },
                        {
                            "type": "input_image",
                            "image_url": f"data:image/{suffix};base64,{encoded}",
                        },
                    ],
                },
            ],
            text_format=AnalysisSchema,
        )
        return self._parse_single_response(response)

    def _build_batch_input(self, pdf_paths: list[str], max_chars_per_pdf: int = 6000) -> list[dict[str, str]]:
        documents: list[dict[str, str]] = []
        for index, pdf_path in enumerate(pdf_paths, start=1):
            text = self.extract_text(pdf_path, max_chars=max_chars_per_pdf)
            documents.append(
                {
                    "document_id": str(index),
                    "filename": Path(pdf_path).name,
                    "text": text,
                }
            )
        return documents

    def analyze_pdfs(self, pdf_paths: list[str]) -> dict[str, AnalysisResult]:
        if not pdf_paths:
            return {}

        logger.info("Analyzing %s PDF(s) in a single request", len(pdf_paths))
        documents = self._build_batch_input(pdf_paths)
        response = self.client.responses.parse(
            model=self.model,
            input=[
                {
                    "role": "system",
                    "content": (
                        "You extract structured metadata from PDF text. "
                        "Multiple documents are included in one request. "
                        "Treat each document independently, but use the full batch for consistency of naming and categorization. "
                        "Return every provided document_id exactly once. "
                        "The document_type must always be written in Japanese. "
                        "Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. "
                        "Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. "
                        "description should be a short summary of what the charge or document is for. "
                        "For missing values, use null. "
                        "Preserve the original currency in amount values and normalize it to ISO currency codes. "
                        "For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10' instead of symbols or converted currencies. "
                        "Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. "
                        "Confidence must be a number between 0.0 and 1.0."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "Analyze the following PDF texts and return structured results for all documents.\n\n"
                        f"{json.dumps(documents, ensure_ascii=False, indent=2)}"
                    ),
                },
            ],
            text_format=BatchAnalysisResponse,
        )

        parsed = response.output_parsed
        results_by_id: dict[str, AnalysisResult] = {}
        for item in parsed.documents:
            results_by_id[item.document_id] = AnalysisResult(
                document_type=item.analysis.document_type,
                issuer_name=item.analysis.issuer_name,
                date=item.analysis.date,
                amount=item.analysis.amount,
                title=item.analysis.title,
                description=item.analysis.description,
                confidence=max(0.0, min(1.0, item.analysis.confidence)),
            )

        missing_ids = [doc["document_id"] for doc in documents if doc["document_id"] not in results_by_id]
        if missing_ids:
            raise RuntimeError(f"解析結果が不足しています: {', '.join(missing_ids)}")

        return {
            pdf_path: results_by_id[document["document_id"]]
            for pdf_path, document in zip(pdf_paths, documents, strict=True)
        }

    def analyze_pdf(self, pdf_path: str) -> AnalysisResult:
        return self.analyze_pdfs([pdf_path])[pdf_path]

    def analyze_document(self, document_path: str) -> AnalysisResult:
        path = Path(document_path)
        suffix = path.suffix.lower()
        if suffix in IMAGE_EXTENSIONS:
            logger.info("Analyzing image document via vision input: %s", document_path)
            return self._analyze_image_file(document_path)
        if suffix == PDF_EXTENSION:
            if self.has_extractable_text(document_path):
                logger.info("Analyzing text-extractable PDF: %s", document_path)
                return self.analyze_pdf(document_path)
            logger.info("Analyzing OCR fallback PDF via file input: %s", document_path)
            return self._analyze_pdf_with_file_input(document_path)
        raise RuntimeError(f"未対応のファイル形式です: {path.suffix}")
