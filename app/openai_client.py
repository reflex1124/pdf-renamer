from __future__ import annotations

import logging
import os
from typing import Literal

from openai import OpenAI
from pydantic import BaseModel, Field
from pypdf import PdfReader

from .models import AnalysisResult

logger = logging.getLogger(__name__)


class AnalysisSchema(BaseModel):
    document_type: Literal["請求書", "領収書", "契約書", "その他"] = Field(
        description="文書の種別",
    )
    issuer_name: str | None = Field(default=None, description="発行元名または会社名")
    date: str | None = Field(
        default=None,
        description="文書上の代表日付。分かる場合は必ず YYYY-MM-DD 形式で返す",
    )
    amount: str | None = Field(default=None, description="金額")
    title: str | None = Field(default=None, description="文書タイトル")
    confidence: float = Field(description="0.0から1.0の信頼度")


class OpenAIPdfAnalyzer:
    def __init__(self, model: str = "gpt-4.1-mini") -> None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise RuntimeError("環境変数 OPENAI_API_KEY が設定されていません。")

        self.client = OpenAI(api_key=api_key)
        self.model = model

    def extract_text(self, pdf_path: str, max_chars: int = 12000) -> str:
        reader = PdfReader(pdf_path)
        chunks: list[str] = []
        for page in reader.pages:
            text = page.extract_text() or ""
            if text.strip():
                chunks.append(text.strip())
            if sum(len(chunk) for chunk in chunks) >= max_chars:
                break

        extracted = "\n\n".join(chunks).strip()
        if not extracted:
            raise RuntimeError("PDF からテキストを抽出できませんでした。スキャン画像のみのPDFは別途OCRが必要です。")

        return extracted[:max_chars]

    def analyze_pdf(self, pdf_path: str) -> AnalysisResult:
        logger.info("Analyzing PDF: %s", pdf_path)
        text = self.extract_text(pdf_path)

        response = self.client.responses.parse(
            model=self.model,
            input=[
                {
                    "role": "system",
                    "content": (
                        "あなたは文書分類アシスタントです。"
                        "渡されたPDF抽出テキストを読み、必ず指定スキーマで情報抽出してください。"
                        "日付は分かる場合、必ず YYYY-MM-DD 形式で返してください。"
                        "月名を使う表記や locale 依存の表記は使わないでください。"
                        "日まで不明で年月までしか分からない場合は YYYY-MM-01 を返してください。"
                        "不明な項目は null とし、confidence は 0.0 から 1.0 の間で返してください。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        "次のPDFテキストから情報を抽出してください。"
                        "date は必ず YYYY-MM-DD 形式で返してください。\n\n"
                        f"{text}"
                    ),
                },
            ],
            text_format=AnalysisSchema,
        )
        parsed = response.output_parsed
        return AnalysisResult(
            document_type=parsed.document_type,
            issuer_name=parsed.issuer_name,
            date=parsed.date,
            amount=parsed.amount,
            title=parsed.title,
            confidence=max(0.0, min(1.0, parsed.confidence)),
        )
