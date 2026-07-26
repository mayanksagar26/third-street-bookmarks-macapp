mod sidecar;

use std::path::PathBuf;
use std::sync::Arc;

use sidecar::{Sidecar, LOG_FILE_NAME};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WindowEvent};
use tauri_plugin_opener::OpenerExt;

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

/// Build the application menu.
///
/// Setting a custom menu replaces the default wholesale, so the standard macOS
/// submenus have to be reconstructed here — without an Edit menu, Cmd+C/V/A
/// silently stop working in the webview.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        app,
        "Third Street Bookmarks",
        true,
        &[
            &PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let view_menu = Submenu::with_items(
        app,
        "View",
        true,
        &[&PredefinedMenuItem::fullscreen(app, None)?],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    let help_menu = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &MenuItem::with_id(app, "show-log", "Show Server Log", true, None::<&str>)?,
            &MenuItem::with_id(app, "show-data", "Show Data Folder", true, None::<&str>)?,
        ],
    )?;

    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            let data = data_dir();
            std::fs::create_dir_all(&data)?;

            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

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
        .on_menu_event(|app, event| {
            let data = data_dir();
            match event.id().as_ref() {
                "show-log" => {
                    let log = data.join(LOG_FILE_NAME);
                    // Opening a path that doesn't exist fails silently, which
                    // reads as a broken menu item. Touch it first.
                    if !log.exists() {
                        let _ = std::fs::write(&log, "");
                    }
                    let _ = app.opener().open_path(log.to_string_lossy(), None::<&str>);
                }
                "show-data" => {
                    let _ = app
                        .opener()
                        .open_path(data.to_string_lossy(), None::<&str>);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![api_port, startup_error, server_log])
        .build(tauri::generate_context!())
        .expect("error while building Third Street Bookmarks")
        // `RunEvent::Exit` is the only hook that reliably fires on every quit
        // path. Cmd+Q and the Quit menu item end in `std::process::exit`, which
        // skips `Drop` — so relying on the Sidecar's destructor, or on
        // `WindowEvent::Destroyed`, leaks the server process to launchd.
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Some(sidecar) = &state.sidecar {
                        sidecar.shutdown();
                    }
                }
            }
        });
}
