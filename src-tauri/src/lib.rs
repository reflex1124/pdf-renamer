mod naming;
mod services;
mod types;

use std::path::PathBuf;

use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

use crate::services::{
    document_controller::DocumentController,
    settings::SettingsStore,
};
use crate::types::{AppSettings, Diagnostics, DocumentItem, SUPPORTED_DOCUMENT_EXTENSIONS};

// ──────────────────────────────────────────────────────────────────
// Application state
// ──────────────────────────────────────────────────────────────────

pub struct AppState {
    pub controller: Mutex<DocumentController>,
    pub diagnostics: Diagnostics,
}

// ──────────────────────────────────────────────────────────────────
// Tauri commands
// ──────────────────────────────────────────────────────────────────

#[tauri::command]
async fn settings_get(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let ctrl = state.controller.lock().await;
    ctrl.load_settings().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn settings_save(
    naming_template: String,
    openai_model: String,
    state: State<'_, AppState>,
) -> Result<AppSettings, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.save_settings(naming_template, openai_model)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn models_list(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let ctrl = state.controller.lock().await;
    ctrl.list_models().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_pick(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    let extensions: Vec<&str> = SUPPORTED_DOCUMENT_EXTENSIONS
        .iter()
        .map(|e| e.trim_start_matches('.'))
        .collect();

    let (tx, rx) = oneshot::channel::<Option<Vec<tauri_plugin_dialog::FilePath>>>();
    app.dialog()
        .file()
        .add_filter("Documents", &extensions)
        .pick_files(move |files| {
            let _ = tx.send(files);
        });

    let files = rx.await.unwrap_or(None).unwrap_or_default();
    if files.is_empty() {
        return Ok(state.controller.lock().await.list_documents());
    }

    let paths: Vec<String> = files
        .into_iter()
        .filter_map(|f| match f {
            tauri_plugin_dialog::FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();

    let mut ctrl = state.controller.lock().await;
    ctrl.add_documents(paths).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_add(
    paths: Vec<String>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.add_documents(paths).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_list(state: State<'_, AppState>) -> Result<Vec<DocumentItem>, String> {
    Ok(state.controller.lock().await.list_documents())
}

#[tauri::command]
async fn documents_clear(state: State<'_, AppState>) -> Result<Vec<DocumentItem>, String> {
    Ok(state.controller.lock().await.clear_documents())
}

#[tauri::command]
async fn documents_analyze(
    keys: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.analyze_documents(keys, false).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_retry(
    keys: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.retry_documents(keys).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_rename(
    keys: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.rename_documents(keys).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_skip(
    keys: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<Vec<DocumentItem>, String> {
    let mut ctrl = state.controller.lock().await;
    ctrl.skip_documents(keys).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_update_proposed_name(
    key: String,
    proposed_name: String,
    state: State<'_, AppState>,
) -> Result<DocumentItem, String> {
    state
        .controller
        .lock()
        .await
        .update_proposed_name(&key, &proposed_name)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_open(key: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let current_path = {
        state
            .controller
            .lock()
            .await
            .store
            .get(&key)
            .ok_or_else(|| "対象ドキュメントが見つかりません。".to_string())?
            .current_path
    };
    app.opener()
        .open_path(&current_path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn documents_reveal(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let current_path = {
        state
            .controller
            .lock()
            .await
            .store
            .get(&key)
            .ok_or_else(|| "対象ドキュメントが見つかりません。".to_string())?
            .current_path
    };
    reveal_in_dir(&current_path).map_err(|e| e.to_string())
}

fn reveal_in_dir(path: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", path])
            .spawn()?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = std::path::Path::new(path)
            .parent()
            .unwrap_or(std::path::Path::new("."));
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()?;
    }
    Ok(())
}

#[tauri::command]
async fn app_get_diagnostics(state: State<'_, AppState>) -> Result<Diagnostics, String> {
    Ok(state.diagnostics.clone())
}

// ──────────────────────────────────────────────────────────────────
// App setup
// ──────────────────────────────────────────────────────────────────

fn load_env(exe_path: &std::path::Path, cwd: &std::path::Path) -> Option<String> {
    let candidates = [
        exe_path.parent().map(|d| d.join(".env")),
        Some(cwd.join(".env")),
    ];
    for candidate in candidates.iter().flatten() {
        if candidate.exists() {
            dotenvy::from_path(candidate).ok();
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let exe_path = std::env::current_exe().unwrap_or_default();
            let cwd = std::env::current_dir().unwrap_or_default();
            let env_path = load_env(&exe_path, &cwd);

            let app_data_dir = app.path().app_data_dir().unwrap_or_else(|_| PathBuf::from("."));
            let settings_path = app_data_dir.join("settings.json");
            let log_path = app_data_dir.join("logs").join("app.log");

            let api_key_configured = std::env::var("OPENAI_API_KEY")
                .map(|k| !k.is_empty())
                .unwrap_or(false);

            let diagnostics = Diagnostics {
                api_key_configured,
                cwd: cwd.to_string_lossy().to_string(),
                env_path,
                executable_path: exe_path.to_string_lossy().to_string(),
                log_path: log_path.to_string_lossy().to_string(),
                settings_path: settings_path.to_string_lossy().to_string(),
                supported_extensions: SUPPORTED_DOCUMENT_EXTENSIONS
                    .iter()
                    .map(|s| s.to_string())
                    .collect(),
            };

            let settings_store = SettingsStore::new(settings_path);
            let controller = DocumentController::new(settings_store);

            app.manage(AppState {
                controller: Mutex::new(controller),
                diagnostics,
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_save,
            models_list,
            documents_pick,
            documents_add,
            documents_list,
            documents_clear,
            documents_analyze,
            documents_retry,
            documents_rename,
            documents_skip,
            documents_update_proposed_name,
            documents_open,
            documents_reveal,
            app_get_diagnostics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
