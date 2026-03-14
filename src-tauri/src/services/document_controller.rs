use std::path::Path;

use anyhow::{anyhow, Result};

use crate::naming::{build_proposed_filename, ensure_extension, normalize_template, sanitize_filename_component, validate_template};
use crate::services::{
    document_store::DocumentStore,
    openai_analyzer::OpenAiDocumentAnalyzer,
    settings::SettingsStore,
};
use crate::types::{AppSettings, DocumentItem, ItemStatus, SUPPORTED_DOCUMENT_EXTENSIONS};

pub struct DocumentController {
    pub settings_store: SettingsStore,
    pub analyzer: OpenAiDocumentAnalyzer,
    pub store: DocumentStore,
}

impl DocumentController {
    pub fn new(settings_store: SettingsStore) -> Self {
        Self {
            settings_store,
            analyzer: OpenAiDocumentAnalyzer::new(),
            store: DocumentStore::new(),
        }
    }

    pub fn list_documents(&self) -> Vec<DocumentItem> {
        self.store.list()
    }

    pub async fn add_documents(&mut self, paths: Vec<String>) -> Result<Vec<DocumentItem>> {
        let mut resolved = Vec::new();
        for path in paths {
            let canonical = match tokio::fs::canonicalize(&path).await {
                Ok(p) => p.to_string_lossy().to_string(),
                Err(_) => continue,
            };
            let ext = Path::new(&canonical)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if SUPPORTED_DOCUMENT_EXTENSIONS.iter().any(|&e| e == ext) {
                resolved.push(canonical);
            }
        }
        Ok(self.store.add(resolved))
    }

    pub fn clear_documents(&mut self) -> Vec<DocumentItem> {
        self.store.clear()
    }

    pub async fn load_settings(&self) -> Result<AppSettings> {
        self.settings_store.load().await
    }

    pub async fn save_settings(&mut self, naming_template: String, openai_model: String) -> Result<AppSettings> {
        let template = normalize_template(&naming_template);
        validate_template(&template).map_err(|e| anyhow!(e))?;

        let next = AppSettings {
            naming_template: template,
            openai_model: openai_model.trim().to_string(),
        };
        let saved = self.settings_store.save(&next).await?;

        // Re-compute proposed names for analyzed documents
        for item in self.store.list() {
            if let Some(ref analysis) = item.analysis {
                let ext = Path::new(&item.current_path)
                    .extension()
                    .map(|e| format!(".{}", e.to_string_lossy()))
                    .unwrap_or_default();
                let proposed = ensure_extension(
                    &build_proposed_filename(analysis, &saved.naming_template),
                    &ext,
                );
                self.store.update_proposed_name(&item.key, proposed);
            }
        }
        Ok(saved)
    }

    pub async fn analyze_documents(&mut self, keys: Option<Vec<String>>, force: bool) -> Result<Vec<DocumentItem>> {
        let settings = self.settings_store.load().await?;
        let targets = self.get_analysis_targets(keys.as_deref(), force);

        if targets.is_empty() {
            return Ok(self.store.list());
        }

        for item in &targets {
            self.store.mark_analyzing(&item.key);
        }

        let mut batchable: Vec<DocumentItem> = Vec::new();
        let mut singles: Vec<DocumentItem> = Vec::new();

        for item in &targets {
            let ext = Path::new(&item.current_path)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy().to_lowercase()))
                .unwrap_or_default();
            if ext == ".pdf" && self.analyzer.has_extractable_text(&item.current_path, 20).await {
                batchable.push(item.clone());
            } else {
                singles.push(item.clone());
            }
        }

        if !batchable.is_empty() {
            let paths: Vec<String> = batchable.iter().map(|i| i.current_path.clone()).collect();
            match self.analyzer.analyze_pdfs(&paths, &settings.openai_model).await {
                Ok(payload) => {
                    for item in &batchable {
                        if let Some(analysis) = payload.get(&item.current_path) {
                            let ext = Path::new(&item.current_path)
                                .extension()
                                .map(|e| format!(".{}", e.to_string_lossy()))
                                .unwrap_or_default();
                            let proposed = ensure_extension(
                                &build_proposed_filename(analysis, &settings.naming_template),
                                &ext,
                            );
                            self.store.update_analysis(&item.key, analysis.clone(), proposed);
                        }
                    }
                }
                Err(e) => {
                    let msg = e.to_string();
                    for item in &batchable {
                        self.store.mark_error(&item.key, msg.clone());
                    }
                }
            }
        }

        for item in singles {
            match self.analyzer.analyze_document(&item.current_path, &settings.openai_model).await {
                Ok(analysis) => {
                    let ext = Path::new(&item.current_path)
                        .extension()
                        .map(|e| format!(".{}", e.to_string_lossy()))
                        .unwrap_or_default();
                    let proposed = ensure_extension(
                        &build_proposed_filename(&analysis, &settings.naming_template),
                        &ext,
                    );
                    self.store.update_analysis(&item.key, analysis, proposed);
                }
                Err(e) => {
                    self.store.mark_error(&item.key, e.to_string());
                }
            }
        }

        Ok(self.store.list())
    }

    pub async fn retry_documents(&mut self, keys: Option<Vec<String>>) -> Result<Vec<DocumentItem>> {
        self.analyze_documents(keys, true).await
    }

    pub async fn rename_documents(&mut self, keys: Option<Vec<String>>) -> Result<Vec<DocumentItem>> {
        let targets = self.target_documents(keys.as_deref());

        for item in targets {
            if item.proposed_name.is_empty() || item.status == ItemStatus::Renamed {
                continue;
            }
            let ext = Path::new(&item.current_path)
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let normalized_name = ensure_extension(&item.proposed_name, &ext);
            let dir = Path::new(&item.current_path)
                .parent()
                .unwrap_or(Path::new("."));
            let target_path = dir.join(&normalized_name).to_string_lossy().to_string();

            let final_path = if target_path == item.current_path {
                target_path
            } else {
                resolve_collision(dir, &normalized_name, &ext).await?
            };

            if final_path != item.current_path {
                tokio::fs::rename(&item.current_path, &final_path).await?;
            }
            self.store.mark_renamed(&item.key, final_path);
        }

        Ok(self.store.list())
    }

    pub async fn skip_documents(&mut self, keys: Option<Vec<String>>) -> Result<Vec<DocumentItem>> {
        let targets = self.target_documents(keys.as_deref());
        for item in targets {
            self.store.mark_skipped(&item.key);
        }
        Ok(self.store.list())
    }

    pub fn update_proposed_name(&mut self, key: &str, proposed_name: &str) -> Result<DocumentItem> {
        let item = self.store.get(key)
            .ok_or_else(|| anyhow!("対象ドキュメントが見つかりません。"))?;
        let edited = {
            let s = sanitize_filename_component(
                if proposed_name.is_empty() { None } else { Some(proposed_name) },
                "renamed",
            );
            if s.is_empty() { "renamed".to_string() } else { s }
        };
        let ext = Path::new(&item.current_path)
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();
        let next_name = ensure_extension(&edited, &ext);
        self.store
            .update_proposed_name(key, next_name)
            .ok_or_else(|| anyhow!("対象ドキュメントが見つかりません。"))
    }

    pub async fn list_models(&self) -> Result<Vec<String>> {
        self.analyzer.list_models().await
    }

    // ──────────────────────────────────────────────────────────────────

    fn get_analysis_targets(&self, keys: Option<&[String]>, force: bool) -> Vec<DocumentItem> {
        self.target_documents(keys)
            .into_iter()
            .filter(|item| {
                if force {
                    item.status != ItemStatus::Analyzing
                } else {
                    matches!(
                        item.status,
                        ItemStatus::Pending
                            | ItemStatus::Error
                            | ItemStatus::NeedsReview
                            | ItemStatus::Ready
                    )
                }
            })
            .collect()
    }

    fn target_documents(&self, keys: Option<&[String]>) -> Vec<DocumentItem> {
        self.store.get_many(keys)
    }
}

async fn resolve_collision(dir: &Path, name: &str, ext: &str) -> Result<String> {
    let candidate = dir.join(name).to_string_lossy().to_string();
    if !tokio::fs::try_exists(&candidate).await.unwrap_or(false) {
        return Ok(candidate);
    }
    let stem = Path::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut index = 1u32;
    loop {
        let next_name = format!("{} ({}){}", stem, index, ext);
        let next_path = dir.join(&next_name).to_string_lossy().to_string();
        if !tokio::fs::try_exists(&next_path).await.unwrap_or(false) {
            return Ok(next_path);
        }
        index += 1;
    }
}
