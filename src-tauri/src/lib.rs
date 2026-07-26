mod sidecar;

use std::path::PathBuf;
use std::sync::Arc;

use sidecar::{Sidecar, LOG_FILE_NAME};
use tauri::{Manager, WindowEvent};

/// Shared with the browser build of Third Street Bookmarks.
///
/// The server already keeps its state DB at `~/.tsb/state.db`, so anchoring the
/// whole data directory there means read/favourite/label history carries over
/// between the two — open either one and it's the same collection.
fn data_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".tsb")
}

struct AppState {
    sidecar: Option<Arc<Sidecar>>,
    /// Populated when the server could not be started; shown by the UI.
    startup_error: Option<String>,
}

#[tauri::command]
fn api_port(state: tauri::State<'_, AppState>) -> Option<u16> {
    state.sidecar.as_ref().map(|sidecar| sidecar.port)
}

#[tauri::command]
fn startup_error(state: tauri::State<'_, AppState>) -> Option<String> {
    state.startup_error.clone()
}

#[tauri::command]
fn server_log() -> String {
    std::fs::read_to_string(data_dir().join(LOG_FILE_NAME))
        .unwrap_or_else(|_| "No server log yet.".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data = data_dir();
            std::fs::create_dir_all(&data)?;

            // In a bundle this is Contents/Resources; in `tauri dev` it resolves
            // to the crate directory, which is why the dev-mode resource paths
            // in tauri.conf.json matter.
            let resource_dir = app.path().resource_dir()?;

            let (sidecar, startup_error) = match Sidecar::start(&resource_dir, &data) {
                Ok(started) => (Some(Arc::new(started)), None),
                Err(error) => {
                    eprintln!("sidecar failed to start: {error}");
                    (None, Some(error.to_string()))
                }
            };

            let port = sidecar.as_ref().map(|s| s.port);

            app.manage(AppState {
                sidecar: sidecar.clone(),
                startup_error,
            });

            // The frontend needs the port before its first fetch, so it goes in
            // as an initialization script rather than an async command.
            let init = format!(
                "window.__TSB_API_PORT__ = {};",
                port.map(|p| p.to_string())
                    .unwrap_or_else(|| "null".to_string())
            );

            let window = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::default(),
            )
            .title("Third Street Bookmarks")
            .inner_size(1_280.0, 860.0)
            .min_inner_size(880.0, 600.0)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .initialization_script(&init)
            .build()?;

            // Stop the server before the process goes away, so it isn't left
            // holding the port or a half-written SQLite file.
            if let Some(sidecar) = sidecar {
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        sidecar.shutdown();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_port, startup_error, server_log])
        .run(tauri::generate_context!())
        .expect("error while running Third Street Bookmarks");
}
