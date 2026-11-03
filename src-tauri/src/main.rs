#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod canvas;
mod mcp;
mod net;
mod secrets;
mod storage;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use storage::NativeError;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

const MAX_IMPORT_BYTES: u64 = 50 * 1024 * 1024;

/// Serializes all your.data operations so saves never interleave.
struct DataFile {
    path: PathBuf,
    lock: Mutex<()>,
}

impl DataFile {
    fn locked<T>(
        &self,
        f: impl FnOnce(&PathBuf) -> Result<T, NativeError>,
    ) -> Result<T, NativeError> {
        let _guard = self.lock.lock().map_err(|_| {
            NativeError::new(
                "unavailable",
                "Opslag is vergrendeld door een eerdere fout.",
            )
        })?;
        f(&self.path)
    }
}

#[tauri::command]
fn data_path(state: State<'_, DataFile>) -> String {
    state.path.display().to_string()
}

#[tauri::command]
fn data_load(state: State<'_, DataFile>) -> Result<Option<String>, NativeError> {
    state.locked(|p| storage::load(p))
}

#[tauri::command]
fn data_save(state: State<'_, DataFile>, contents: String) -> Result<(), NativeError> {
    state.locked(|p| storage::write_atomic(p, &contents))
}

#[tauri::command]
fn data_clear(state: State<'_, DataFile>) -> Result<(), NativeError> {
    state.locked(|p| storage::clear(p))
}

#[tauri::command]
fn data_quarantine(state: State<'_, DataFile>) -> Result<String, NativeError> {
    state
        .locked(|p| storage::quarantine(p))
        .map(|p| p.display().to_string())
}

#[tauri::command]
async fn export_json(
    app: AppHandle,
    suggested_name: String,
    contents: String,
) -> Result<bool, NativeError> {
    let picked = app
        .dialog()
        .file()
        .set_title("PLuMS-gegevens exporteren")
        .set_file_name(&suggested_name)
        .add_filter("JSON", &["json"])
        .blocking_save_file();
    let Some(picked) = picked else {
        return Ok(false);
    };
    let path = picked
        .into_path()
        .map_err(|e| NativeError::new("write", format!("Ongeldige bestandslocatie: {e}")))?;
    storage::write_atomic(&path, &contents)?;
    Ok(true)
}

#[tauri::command]
async fn import_json(app: AppHandle) -> Result<Option<String>, NativeError> {
    let picked = app
        .dialog()
        .file()
        .set_title("PLuMS-gegevens importeren")
        .add_filter("JSON", &["json"])
        .blocking_pick_file();
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked
        .into_path()
        .map_err(|e| NativeError::new("read", format!("Ongeldige bestandslocatie: {e}")))?;
    let size = fs::metadata(&path)
        .map_err(|e| {
            NativeError::new("read", format!("Lezen van {} mislukt: {e}", path.display()))
        })?
        .len();
    if size > MAX_IMPORT_BYTES {
        return Err(NativeError::new(
            "read",
            "Het importbestand is groter dan 50 MB.",
        ));
    }
    storage::load(&path)?
        .map(Some)
        .ok_or_else(|| NativeError::new("read", format!("{} bestaat niet.", path.display())))
}

#[tauri::command]
async fn secret_status(endpoint: String) -> Result<bool, NativeError> {
    secrets::has(&endpoint)
}

#[tauri::command]
async fn secret_save(endpoint: String, secret: String) -> Result<(), NativeError> {
    secrets::save(&endpoint, &secret)
}

#[tauri::command]
async fn secret_remove(endpoint: String) -> Result<(), NativeError> {
    secrets::remove(&endpoint)
}

#[tauri::command]
async fn http_start(
    http: State<'_, net::Http>,
    id: String,
    request: net::HttpRequestSpec,
    on_event: Channel<net::HttpEvent>,
) -> Result<(), NativeError> {
    net::start(&http, id, request, on_event)
}

#[tauri::command]
fn http_cancel(http: State<'_, net::Http>, id: String) {
    net::cancel(&http, &id);
}

#[tauri::command]
async fn mcp_discover(
    mcp: State<'_, mcp::McpManager>,
    call_id: String,
    target: mcp::McpTargetSpec,
) -> Result<mcp::McpDiscoveryDto, NativeError> {
    mcp.discover(call_id, target).await
}

#[tauri::command]
async fn mcp_call_tool(
    mcp: State<'_, mcp::McpManager>,
    call_id: String,
    target: mcp::McpTargetSpec,
    tool_name: String,
    args: serde_json::Map<String, serde_json::Value>,
) -> Result<mcp::McpToolCallDto, NativeError> {
    mcp.call_tool(call_id, target, tool_name, args).await
}

#[tauri::command]
fn mcp_cancel(mcp: State<'_, mcp::McpManager>, call_id: String) {
    mcp.cancel(&call_id);
}

#[tauri::command]
fn mcp_disconnect(mcp: State<'_, mcp::McpManager>) {
    mcp.cancel_all();
}

/// Exists only in `canvas-test-mode` builds; reports whether this binary was built with a test-mode frontend.
#[cfg(feature = "canvas-test-mode")]
#[tauri::command]
fn canvas_test_mode_status() -> serde_json::Value {
    serde_json::json!({
        "featureCompiled": true,
        "frontendAgrees": canvas::test_student::FRONTEND_AGREES,
    })
}

macro_rules! app_handler {
    ($($extra:ident),*) => {
        tauri::generate_handler![
            data_path,
            data_load,
            data_save,
            data_clear,
            data_quarantine,
            export_json,
            import_json,
            secret_status,
            secret_save,
            secret_remove,
            http_start,
            http_cancel,
            mcp_discover,
            mcp_call_tool,
            mcp_cancel,
            mcp_disconnect
            $(, $extra)*
        ]
    };
}

fn main() {
    let path = match storage::data_file() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("PLuMS: {}", e.message);
            std::process::exit(1);
        }
    };
    let http = match net::Http::new() {
        Ok(http) => http,
        Err(e) => {
            eprintln!("PLuMS: HTTP-client kon niet starten: {e}");
            std::process::exit(1);
        }
    };

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DataFile {
            path,
            lock: Mutex::new(()),
        })
        .manage(http)
        .manage(mcp::McpManager::new());
    #[cfg(not(feature = "canvas-test-mode"))]
    let builder = builder.invoke_handler(app_handler!());
    #[cfg(feature = "canvas-test-mode")]
    let builder = builder.invoke_handler(app_handler!(canvas_test_mode_status));
    builder
        .run(tauri::generate_context!())
        .expect("PLuMS kon niet starten");
}
