use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::types::AnalysisResult;

// ──────────────────────────────────────────────────────────────────
// JSON schema definitions for OpenAI structured output
// ──────────────────────────────────────────────────────────────────

fn analysis_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "documentType": { "type": "string" },
            "issuerName":   { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "date":         { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "amount":       { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "title":        { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "description":  { "anyOf": [{ "type": "string" }, { "type": "null" }] },
            "confidence":   { "type": "number" }
        },
        "required": ["documentType", "issuerName", "date", "amount", "title", "description", "confidence"],
        "additionalProperties": false
    })
}

fn batch_analysis_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "documents": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "document_id": { "type": "string" },
                        "analysis": analysis_schema()
                    },
                    "required": ["document_id", "analysis"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["documents"],
        "additionalProperties": false
    })
}

// ──────────────────────────────────────────────────────────────────
// Response deserialization
// ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct OpenAiResponseBody {
    output: Vec<OpenAiOutputItem>,
}

#[derive(Deserialize)]
struct OpenAiOutputItem {
    #[serde(rename = "type")]
    item_type: String,
    content: Option<Vec<OpenAiContentItem>>,
}

#[derive(Deserialize)]
struct OpenAiContentItem {
    #[serde(rename = "type")]
    content_type: String,
    text: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    data: Vec<OpenAiModel>,
}

#[derive(Deserialize)]
struct OpenAiModel {
    id: String,
}

#[derive(Deserialize)]
struct OpenAiFileResponse {
    id: String,
}

#[derive(Deserialize)]
struct RawAnalysis {
    #[serde(rename = "documentType")]
    document_type: String,
    #[serde(rename = "issuerName")]
    issuer_name: Option<String>,
    date: Option<String>,
    amount: Option<String>,
    title: Option<String>,
    description: Option<String>,
    confidence: f64,
}

#[derive(Deserialize)]
struct BatchAnalysisResponse {
    documents: Vec<BatchAnalysisItem>,
}

#[derive(Deserialize)]
struct BatchAnalysisItem {
    document_id: String,
    analysis: RawAnalysis,
}

// ──────────────────────────────────────────────────────────────────
// Analyzer
// ──────────────────────────────────────────────────────────────────

pub struct OpenAiDocumentAnalyzer {
    client: reqwest::Client,
}

impl OpenAiDocumentAnalyzer {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }

    fn api_key() -> Result<String> {
        std::env::var("OPENAI_API_KEY")
            .map_err(|_| anyhow!("環境変数 OPENAI_API_KEY が設定されていません。"))
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        let api_key = Self::api_key()?;
        let response = self
            .client
            .get("https://api.openai.com/v1/models")
            .bearer_auth(&api_key)
            .send()
            .await?
            .error_for_status()?
            .json::<OpenAiModelsResponse>()
            .await?;

        let snapshot_re = regex::Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap();
        let exclude_tokens = ["realtime", "audio", "transcribe", "tts", "search"];

        let mut models: Vec<String> = response
            .data
            .into_iter()
            .map(|m| m.id)
            .filter(|id| id.starts_with("gpt-"))
            .filter(|id| !snapshot_re.is_match(id))
            .filter(|id| !exclude_tokens.iter().any(|t| id.contains(t)))
            .collect();

        models.sort_by(|a, b| {
            let priority = |s: &str| -> u32 {
                match s {
                    "gpt-5" => 0,
                    "gpt-5-mini" => 1,
                    "gpt-5-nano" => 2,
                    "gpt-4.1" => 3,
                    "gpt-4.1-mini" => 4,
                    "gpt-4.1-nano" => 5,
                    "gpt-4o" => 6,
                    "gpt-4o-mini" => 7,
                    _ => 99,
                }
            };
            priority(a).cmp(&priority(b)).then_with(|| a.cmp(b))
        });
        models.dedup();
        Ok(models)
    }

    pub fn extract_pdf_text(bytes: &[u8], max_chars: usize) -> Result<String> {
        let doc = lopdf::Document::load_mem(bytes)
            .map_err(|e| anyhow!("PDFの読み込みに失敗しました: {}", e))?;

        let pages = doc.get_pages();
        let mut text = String::new();

        let mut page_ids: Vec<u32> = pages.keys().cloned().collect();
        page_ids.sort();

        for page_id in page_ids {
            if let Ok(page_text) = doc.extract_text(&[page_id]) {
                text.push_str(&page_text);
                text.push('\n');
            }
            if text.len() >= max_chars * 2 {
                break;
            }
        }

        let trimmed = text.trim().to_string();
        if trimmed.is_empty() {
            Err(anyhow!(
                "PDF からテキストを抽出できませんでした。画像PDFはOCRが必要です。"
            ))
        } else {
            Ok(trimmed.chars().take(max_chars).collect())
        }
    }

    pub async fn has_extractable_text(&self, path: &str, threshold: usize) -> bool {
        let Ok(bytes) = tokio::fs::read(path).await else {
            return false;
        };
        match Self::extract_pdf_text(&bytes, 2_000) {
            Ok(text) => text.trim().len() >= threshold,
            Err(_) => false,
        }
    }

    pub async fn analyze_pdfs(&self, pdf_paths: &[String], model: &str) -> Result<HashMap<String, AnalysisResult>> {
        if pdf_paths.is_empty() {
            return Ok(HashMap::new());
        }

        let api_key = Self::api_key()?;

        #[derive(Serialize)]
        struct DocEntry {
            document_id: String,
            filename: String,
            text: String,
        }

        let mut docs = Vec::new();
        for (i, path) in pdf_paths.iter().enumerate() {
            let bytes = tokio::fs::read(path)
                .await
                .with_context(|| format!("ファイルの読み込みに失敗しました: {}", path))?;
            let text = Self::extract_pdf_text(&bytes, 6_000)?;
            let filename = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            docs.push(DocEntry {
                document_id: (i + 1).to_string(),
                filename,
                text,
            });
        }

        let system_prompt = "You extract structured metadata from PDF text. Multiple documents are included in one request. Treat each document independently, but use the full batch for consistency of naming and categorization. Return every provided document_id exactly once. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0.";

        let user_text = format!(
            "Analyze the following PDF texts and return structured results for all documents.\n\n{}",
            serde_json::to_string_pretty(&docs)?
        );

        let body = json!({
            "model": model,
            "input": [
                {
                    "id": "msg_system_batch",
                    "role": "system",
                    "content": [{ "type": "input_text", "text": system_prompt }]
                },
                {
                    "id": "msg_user_batch",
                    "role": "user",
                    "content": [{ "type": "input_text", "text": user_text }]
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "batch_document_analysis",
                    "schema": batch_analysis_schema(),
                    "strict": true
                }
            }
        });

        let response_text = self
            .client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        let parsed_text = extract_output_text(&response_text)?;
        let batch: BatchAnalysisResponse = serde_json::from_str(&parsed_text)
            .map_err(|e| anyhow!("バッチ解析結果のパースに失敗しました: {}", e))?;

        let results_by_id: HashMap<String, AnalysisResult> = batch
            .documents
            .into_iter()
            .map(|item| (item.document_id, clamp_confidence(item.analysis)))
            .collect();

        let mut output = HashMap::new();
        for (i, path) in pdf_paths.iter().enumerate() {
            let id = (i + 1).to_string();
            let result = results_by_id
                .get(&id)
                .cloned()
                .ok_or_else(|| anyhow!("解析結果が不足しています: {}", id))?;
            output.insert(path.clone(), result);
        }
        Ok(output)
    }

    pub async fn analyze_document(&self, path: &str, model: &str) -> Result<AnalysisResult> {
        let extension = std::path::Path::new(path)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
            .unwrap_or_default();

        let image_extensions = [".png", ".jpg", ".jpeg", ".webp", ".gif"];
        if image_extensions.contains(&extension.as_str()) {
            return self.analyze_image(path, model).await;
        }
        if extension == ".pdf" {
            if self.has_extractable_text(path, 20).await {
                let results = self.analyze_pdfs(&[path.to_string()], model).await?;
                return results
                    .into_values()
                    .next()
                    .ok_or_else(|| anyhow!("解析結果が空です。"));
            }
            return self.analyze_pdf_with_file_input(path, model).await;
        }
        Err(anyhow!("未対応のファイル形式です: {}", extension))
    }

    async fn analyze_pdf_with_file_input(&self, path: &str, model: &str) -> Result<AnalysisResult> {
        let api_key = Self::api_key()?;
        let bytes = tokio::fs::read(path).await?;
        let filename = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "document.pdf".to_string());

        let part = reqwest::multipart::Part::bytes(bytes)
            .file_name(filename.clone())
            .mime_str("application/pdf")?;
        let form = reqwest::multipart::Form::new()
            .text("purpose", "user_data")
            .part("file", part);

        let upload_resp = self
            .client
            .post("https://api.openai.com/v1/files")
            .bearer_auth(&api_key)
            .multipart(form)
            .send()
            .await?
            .error_for_status()?
            .json::<OpenAiFileResponse>()
            .await?;

        let file_id = upload_resp.id;

        let body = json!({
            "model": model,
            "input": [
                single_document_system_message(),
                {
                    "id": format!("msg_user_{}", uuid::Uuid::new_v4()),
                    "role": "user",
                    "content": [
                        { "type": "input_file", "file_id": file_id },
                        {
                            "type": "input_text",
                            "text": format!("Analyze this PDF file named '{}'. Use OCR if needed and return the structured result.", filename)
                        }
                    ]
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "document_analysis",
                    "schema": analysis_schema(),
                    "strict": true
                }
            }
        });

        let response_text = self
            .client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        let parsed_text = extract_output_text(&response_text)?;
        let raw: RawAnalysis = serde_json::from_str(&parsed_text)
            .map_err(|e| anyhow!("PDF解析結果のパースに失敗しました: {}", e))?;

        Ok(clamp_confidence(raw))
    }

    async fn analyze_image(&self, path: &str, model: &str) -> Result<AnalysisResult> {
        let api_key = Self::api_key()?;
        let bytes = tokio::fs::read(path).await?;
        let encoded = BASE64.encode(&bytes);
        let suffix = std::path::Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "png".into());
        let filename = std::path::Path::new(path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        let body = json!({
            "model": model,
            "input": [
                single_document_system_message(),
                {
                    "id": format!("msg_user_{}", uuid::Uuid::new_v4()),
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": format!("Analyze this document image named '{}'. Read the image directly and return the structured result.", filename)
                        },
                        {
                            "type": "input_image",
                            "detail": "auto",
                            "image_url": format!("data:image/{};base64,{}", suffix, encoded)
                        }
                    ]
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "document_analysis",
                    "schema": analysis_schema(),
                    "strict": true
                }
            }
        });

        let response_text = self
            .client
            .post("https://api.openai.com/v1/responses")
            .bearer_auth(&api_key)
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .text()
            .await?;

        let parsed_text = extract_output_text(&response_text)?;
        let raw: RawAnalysis = serde_json::from_str(&parsed_text)
            .map_err(|e| anyhow!("画像解析結果のパースに失敗しました: {}", e))?;

        Ok(clamp_confidence(raw))
    }
}

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

/// Extract the output_text from the OpenAI Responses API response body.
fn extract_output_text(response_body: &str) -> Result<String> {
    let parsed: OpenAiResponseBody = serde_json::from_str(response_body)
        .map_err(|e| anyhow!("OpenAI レスポンスのパースに失敗しました: {}\n{}", e, &response_body[..response_body.len().min(500)]))?;

    for item in &parsed.output {
        if item.item_type == "message" {
            if let Some(contents) = &item.content {
                for content in contents {
                    if content.content_type == "output_text" {
                        if let Some(text) = &content.text {
                            return Ok(text.clone());
                        }
                    }
                }
            }
        }
    }

    Err(anyhow!("OpenAI から解析結果を取得できませんでした。"))
}

fn single_document_system_message() -> Value {
    json!({
        "id": "msg_system_single",
        "role": "system",
        "content": [{
            "type": "input_text",
            "text": "You extract structured metadata from business documents. The documentType must always be written in Japanese. Use labels such as '請求書', '領収書', '見積書', '納品書', '契約書', '注文書', '明細書', or 'その他'. Extract description from fields such as 内容, 内訳, Description, Item, Details, or similar. description should be a short summary of what the charge or document is for. For missing values, use null. Preserve the original currency in amount values and normalize it to ISO currency codes. For example use 'USD 12.34', 'JPY 1200', 'EUR 9.99', or 'GBP 72.10'. Dates must be normalized to YYYY-MM-DD when possible, or YYYY-MM-01 if only year and month are known. Confidence must be a number between 0.0 and 1.0."
        }]
    })
}

fn clamp_confidence(raw: RawAnalysis) -> AnalysisResult {
    AnalysisResult {
        document_type: raw.document_type,
        issuer_name: raw.issuer_name,
        date: raw.date,
        amount: raw.amount,
        title: raw.title,
        description: raw.description,
        confidence: raw.confidence.clamp(0.0, 1.0),
    }
}

