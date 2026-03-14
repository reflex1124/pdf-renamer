use std::path::Path;

use crate::types::{AnalysisResult, DocumentItem, ItemStatus};

pub struct DocumentStore {
    items: indexmap::IndexMap<String, DocumentItem>,
}

impl DocumentStore {
    pub fn new() -> Self {
        Self {
            items: indexmap::IndexMap::new(),
        }
    }

    pub fn list(&self) -> Vec<DocumentItem> {
        self.items.values().cloned().collect()
    }

    pub fn add(&mut self, paths: Vec<String>) -> Vec<DocumentItem> {
        for path in paths {
            if self.items.contains_key(&path) {
                continue;
            }
            let display_name = Path::new(&path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            self.items.insert(
                path.clone(),
                DocumentItem {
                    key: path.clone(),
                    source_path: path.clone(),
                    current_path: path,
                    display_name,
                    status: ItemStatus::Pending,
                    analysis: None,
                    proposed_name: String::new(),
                    error_message: String::new(),
                    skipped: false,
                    history: vec![],
                },
            );
        }
        self.list()
    }

    pub fn clear(&mut self) -> Vec<DocumentItem> {
        self.items.clear();
        vec![]
    }

    pub fn get(&self, key: &str) -> Option<DocumentItem> {
        self.items.get(key).cloned()
    }

    pub fn get_many(&self, keys: Option<&[String]>) -> Vec<DocumentItem> {
        match keys {
            None => self.list(),
            Some(ks) if ks.is_empty() => self.list(),
            Some(ks) => ks.iter().filter_map(|k| self.get(k)).collect(),
        }
    }

    pub fn update_analysis(
        &mut self,
        key: &str,
        analysis: AnalysisResult,
        proposed_name: String,
    ) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        item.status = if analysis.confidence >= 0.8 {
            ItemStatus::Ready
        } else {
            ItemStatus::NeedsReview
        };
        item.error_message.clear();
        item.skipped = false;
        item.history
            .push(format!("analyzed:{}", serde_json::to_string(&analysis).unwrap_or_default()));
        item.analysis = Some(analysis);
        item.proposed_name = proposed_name;
        Some(item.clone())
    }

    pub fn mark_analyzing(&mut self, key: &str) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        item.status = ItemStatus::Analyzing;
        item.error_message.clear();
        item.skipped = false;
        Some(item.clone())
    }

    pub fn mark_error(&mut self, key: &str, message: String) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        item.status = ItemStatus::Error;
        item.error_message = message.clone();
        item.history.push(format!("error:{}", message));
        Some(item.clone())
    }

    pub fn mark_skipped(&mut self, key: &str) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        item.status = ItemStatus::Skipped;
        item.skipped = true;
        item.history.push("skipped".to_string());
        Some(item.clone())
    }

    pub fn mark_renamed(&mut self, key: &str, next_path: String) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        let base = Path::new(&next_path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| next_path.clone());
        item.history.push(format!("renamed:{}", base));
        item.current_path = next_path.clone();
        item.display_name = base;
        item.status = ItemStatus::Renamed;
        Some(item.clone())
    }

    pub fn update_proposed_name(&mut self, key: &str, proposed_name: String) -> Option<DocumentItem> {
        let item = self.items.get_mut(key)?;
        item.proposed_name = proposed_name;
        Some(item.clone())
    }
}
