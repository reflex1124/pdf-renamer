use serde::{Deserialize, Serialize};

pub const SUPPORTED_DOCUMENT_EXTENSIONS: &[&str] =
    &[".pdf", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
pub const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[".png", ".jpg", ".jpeg", ".webp", ".gif"];
pub const DEFAULT_TEMPLATE: &str = "{date}_{issuer_name}_{document_type}_{amount}";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisResult {
    pub document_type: String,
    pub issuer_name: Option<String>,
    pub date: Option<String>,
    pub amount: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    Pending,
    Analyzing,
    Ready,
    NeedsReview,
    Skipped,
    Renamed,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentItem {
    pub key: String,
    pub source_path: String,
    pub current_path: String,
    pub display_name: String,
    pub status: ItemStatus,
    pub analysis: Option<AnalysisResult>,
    pub proposed_name: String,
    pub error_message: String,
    pub skipped: bool,
    pub history: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub naming_template: String,
    pub openai_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    pub api_key_configured: bool,
    pub cwd: String,
    pub env_path: Option<String>,
    pub executable_path: String,
    pub log_path: String,
    pub settings_path: String,
    pub supported_extensions: Vec<String>,
}
