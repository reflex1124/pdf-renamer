use std::path::PathBuf;

use anyhow::Result;

use crate::types::{AppSettings, DEFAULT_TEMPLATE};

pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-mini";

pub struct SettingsStore {
    pub file_path: PathBuf,
}

impl SettingsStore {
    pub fn new(file_path: impl Into<PathBuf>) -> Self {
        Self {
            file_path: file_path.into(),
        }
    }

    pub async fn load(&self) -> Result<AppSettings> {
        match tokio::fs::read_to_string(&self.file_path).await {
            Ok(raw) => {
                let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
                Ok(AppSettings {
                    naming_template: parsed["namingTemplate"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(DEFAULT_TEMPLATE)
                        .to_string(),
                    openai_model: parsed["openaiModel"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or(DEFAULT_OPENAI_MODEL)
                        .to_string(),
                })
            }
            Err(_) => Ok(Self::defaults()),
        }
    }

    pub async fn save(&self, settings: &AppSettings) -> Result<AppSettings> {
        if let Some(parent) = self.file_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let json = serde_json::to_string_pretty(settings)?;
        tokio::fs::write(&self.file_path, format!("{}\n", json)).await?;
        Ok(settings.clone())
    }

    pub fn defaults() -> AppSettings {
        AppSettings {
            naming_template: DEFAULT_TEMPLATE.to_string(),
            openai_model: DEFAULT_OPENAI_MODEL.to_string(),
        }
    }
}
