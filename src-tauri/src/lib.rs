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

/// Decide whether a link is safe to hand to the OS.
///
/// The scheme check is the point, not a formality: these URLs come out of
/// bookmark data, which is content a stranger wrote. `file://` would hand a
/// hostile bookmark a way to open local files, and macOS will happily launch a
/// registered handler for schemes like `ms-msdt:` or `shortcuts://`. Only http
/// and https get through.
fn vet_external_url(url: &str) -> Result<String, String> {
    let parsed = url::Url::parse(url).map_err(|_| "not a valid URL".to_string())?;

    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("refusing to open a {other}: link")),
    }

    match parsed.host_str() {
        Some(host) if !host.is_empty() => {}
        _ => return Err("link has no host".to_string()),
    }

    Ok(parsed.to_string())
}

/// Open a link in the user's real browser.
///
/// `target="_blank"` does nothing in a webview — there is no tab to open into,
/// and the app's CSP blocks navigating away from the bundle. So every external
/// link has to come through here.
#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let safe = vet_external_url(&url)?;
    app.opener()
        .open_url(safe, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn server_log() -> String {
    std::fs::read_to_string(data_dir().join(LOG_FILE_NAME))
        .unwrap_or_else(|_| "No server log yet.".to_string())
}

/// The two shapes this window is meant to take.
///
/// Expanded is the reading posture: three columns, room for the feed. Popup is
/// the glanceable one — a single column you keep beside your work, sized so the
/// sidebar and right panel drop away rather than being crushed. The CSS
/// breakpoint and these widths are deliberately set together; resizing by hand
/// across the boundary switches layout just the same.
const EXPANDED: (f64, f64) = (1_280.0, 860.0);
const POPUP: (f64, f64) = (460.0, 720.0);

#[tauri::command]
fn set_view_mode(window: tauri::WebviewWindow, mode: String) -> Result<(), String> {
    let (width, height) = if mode == "popup" { POPUP } else { EXPANDED };

    // Below the popup width the layout has nowhere left to go, so the floor
    // travels with the mode rather than being fixed at build time.
    window
        .set_min_size(Some(tauri::LogicalSize::new(
            if mode == "popup" { 380.0 } else { 880.0 },
            520.0,
        )))
        .map_err(|e| e.to_string())?;

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    // Popup is a companion window; keeping it above the app you're reading
    // alongside is the entire point of the mode.
    window
        .set_always_on_top(mode == "popup")
        .map_err(|e| e.to_string())?;

    Ok(())
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
            // Cmd+, is where every Mac user looks for this first.
            &MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?,
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
        &[
            &MenuItem::with_id(app, "view-expanded", "Expanded", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "view-popup", "Popup", true, Some("CmdOrCtrl+2"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
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
            let token = sidecar.as_ref().map(|s| s.token.clone());

            app.manage(AppState {
                sidecar: sidecar.clone(),
                startup_error,
            });

            // Port and token both have to be in place before the first fetch,
            // so they go in as an initialization script rather than an async
            // command. The token is hex from our own generator, so it needs no
            // escaping, but it is quoted rather than interpolated bare.
            let init = format!(
                "window.__TSB_API_PORT__ = {};\nwindow.__TSB_API_TOKEN__ = {};\nwindow.__TSB_GLASS__ = {};",
                port.map(|p| p.to_string())
                    .unwrap_or_else(|| "null".to_string()),
                token
                    .map(|t| format!("\"{t}\""))
                    .unwrap_or_else(|| "null".to_string()),
                // Declared up front so the first paint is already glass — a
                // class added after load would flash opaque first. Retracted
                // below if the material turns out to be unavailable.
                cfg!(target_os = "macos")
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
            .transparent(true)
            // Explicit: a transparent window that also loses its decorations is
            // a window with no close button.
            .decorations(true)
            .initialization_script(&init)
            .build()?;

            // Glass. An NSVisualEffectView sits behind the transparent webview,
            // so the translucent regions in the CSS — sidebar and right panel —
            // sample the desktop the way native chrome does. A backdrop-filter
            // alone can only blur what the page itself drew, which is why the
            // edges would otherwise look grey rather than alive.
            #[cfg(target_os = "macos")]
            {
                use window_vibrancy::{apply_vibrancy, NSVisualEffectMaterial};
                // UnderWindowBackground is the material AppKit intends for
                // "the whole window is glass" — it composites beneath the
                // window's own chrome. HudWindow is a borderless-panel
                // material, and using it here cost the traffic lights.
                if let Err(error) = apply_vibrancy(
                    &window,
                    NSVisualEffectMaterial::UnderWindowBackground,
                    None,
                    Some(12.0),
                ) {
                    // Not fatal: the app is fully usable opaque, and this fails
                    // on macOS versions that lack the material.
                    eprintln!("vibrancy unavailable, falling back to opaque: {error}");
                    let _ = window.eval(
                        "window.__TSB_GLASS__ = false; \
                         document.documentElement.classList.remove('tsb-glass');",
                    );
                }
            }

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
                "settings" => {
                    // The menu lives in Rust and has no handle on the React
                    // tree; an event is the seam between them.
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.eval(
                            "window.dispatchEvent(new CustomEvent('tsb:open-settings'))",
                        );
                    }
                }
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
                mode @ ("view-expanded" | "view-popup") => {
                    if let Some(window) = app.get_webview_window("main") {
                        let name = if mode == "view-popup" { "popup" } else { "expanded" };
                        let _ = set_view_mode(window, name.to_string());
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            api_port,
            startup_error,
            server_log,
            set_view_mode,
            open_external
        ])
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

#[cfg(test)]
mod tests {
    use super::vet_external_url;

    #[test]
    fn allows_ordinary_web_links() {
        for url in [
            "https://x.com/sama/status/123",
            "http://example.com/path?q=1#frag",
            "https://xn--80ak6aa92e.com/",
        ] {
            assert!(vet_external_url(url).is_ok(), "should allow {url}");
        }
    }

    #[test]
    fn refuses_schemes_that_can_reach_the_machine() {
        // Bookmark data is written by strangers. These are the shapes that turn
        // "open a link" into "touch the local system".
        for url in [
            "file:///etc/passwd",
            "file:///Users/someone/.ssh/id_ed25519",
            "javascript:alert(1)",
            "data:text/html,<script>alert(1)</script>",
            "shortcuts://run-shortcut?name=wipe",
            "ms-msdt:/id",
            "vscode://file/etc/hosts",
            "ftp://example.com/x",
        ] {
            assert!(vet_external_url(url).is_err(), "should refuse {url}");
        }
    }

    #[test]
    fn refuses_malformed_and_hostless_links() {
        for url in ["", "not a url", "https://", "http://"] {
            assert!(vet_external_url(url).is_err(), "should refuse {url:?}");
        }
    }
}
