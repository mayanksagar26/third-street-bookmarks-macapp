//! Supervises the Express server that backs the app.
//!
//! The UI is a webview; all its data comes from the Node server that ships
//! inside the bundle. This module owns that process end to end: find an
//! interpreter, pick a port, spawn it, tee its output to a log, and make sure
//! it dies when the app does.
//!
//! The orphan problem is the reason this isn't three lines of `Command::new`.
//! The server itself spawns grandchildren — `claude`, `codex`, `python3` — and
//! killing only the direct child leaves those running with the port held. On
//! Unix we put the server in its own process group at spawn and signal the
//! whole group on shutdown.

use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Where the server writes; surfaced in the UI when startup fails.
pub const LOG_FILE_NAME: &str = "server.log";

#[derive(Debug)]
pub enum SidecarError {
    NodeNotFound,
    NoFreePort(std::io::Error),
    Spawn(std::io::Error),
}

impl std::fmt::Display for SidecarError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NodeNotFound => write!(
                f,
                "Node.js 20+ was not found. Install it from https://nodejs.org and reopen the app."
            ),
            Self::NoFreePort(e) => write!(f, "Could not reserve a local port: {e}"),
            Self::Spawn(e) => write!(f, "Could not start the local server: {e}"),
        }
    }
}

impl std::error::Error for SidecarError {}

/// A running server process and the port it answers on.
pub struct Sidecar {
    child: Mutex<Option<Child>>,
    pub port: u16,
}

impl Sidecar {
    /// Spawn the server.
    ///
    /// `resource_dir` holds the bundled `server/` and `python/` trees (read-only
    /// inside the .app). `data_dir` is writable and receives bookmarks.json,
    /// settings.json and the log.
    pub fn start(resource_dir: &Path, data_dir: &Path) -> Result<Self, SidecarError> {
        let node = find_node().ok_or(SidecarError::NodeNotFound)?;
        let port = free_port().map_err(SidecarError::NoFreePort)?;

        let entry = resource_dir.join("server").join("index.js");
        let script_dir = resource_dir.join("python");

        let mut command = Command::new(&node);
        command
            .arg(&entry)
            .env("PORT", port.to_string())
            .env("TSB_DATA_DIR", data_dir)
            .env("TSB_SCRIPT_DIR", &script_dir)
            .env("NODE_ENV", "production")
            // A GUI-launched app inherits a bare PATH, so the server's own
            // lookups for `claude`, `codex`, `ft`, `python3` would all miss.
            // Hand it the paths a login shell would have had.
            .env("PATH", augmented_path(&node))
            // The server exits when this pipe reaches EOF. We never write to
            // it; its only job is to die with us. A SIGKILL'd app never runs
            // RunEvent::Exit, but the kernel still closes its fds, so the pipe
            // is what stops the server outliving a crash.
            .env("TSB_SUPERVISED", "1")
            .current_dir(resource_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // Own process group, so shutdown reaches the CLIs the server spawns.
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }

        let mut child = command.spawn().map_err(SidecarError::Spawn)?;

        // Deliberately not taken from `child`: holding the write end open for
        // the lifetime of the process is the whole point of the pipe above.
        debug_assert!(child.stdin.is_some());

        let log_path = data_dir.join(LOG_FILE_NAME);
        if let Some(stdout) = child.stdout.take() {
            tee(stdout, log_path.clone(), "out");
        }
        if let Some(stderr) = child.stderr.take() {
            tee(stderr, log_path, "err");
        }

        Ok(Self {
            child: Mutex::new(Some(child)),
            port,
        })
    }

    /// Terminate the server and everything it spawned. Idempotent.
    pub fn shutdown(&self) {
        let Ok(mut guard) = self.child.lock() else {
            return;
        };
        let Some(mut child) = guard.take() else {
            return;
        };

        #[cfg(unix)]
        {
            // Negative pid targets the group. SIGTERM first so the server can
            // close its SQLite handles cleanly.
            let pgid = child.id() as i32;
            unsafe { libc::kill(-pgid, libc::SIGTERM) };

            for _ in 0..40 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
        }

        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Drop for Sidecar {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Forward a child stream to the log file, tagged by which stream it came from.
fn tee<R: std::io::Read + Send + 'static>(stream: R, log_path: PathBuf, tag: &'static str) {
    std::thread::spawn(move || {
        use std::io::Write;
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = writeln!(file, "[{tag}] {line}");
            }
        }
    });
}

/// Ask the OS for an unused port, then release it.
///
/// This is a race — something could claim the port before the server binds it.
/// In practice the window is sub-millisecond on a loopback interface and the
/// alternative (passing a bound socket through to Node) needs fd inheritance
/// the server isn't written for. A failed bind shows up as a startup error.
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    drop(listener);
    Ok(port)
}

/// Locate a Node interpreter.
///
/// Checked in order of how likely they are to be the one the user actually
/// installed. `PATH` goes first because when the app is launched from a
/// terminal it carries the developer's real environment.
fn find_node() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node");
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }

    let home = dirs_home();
    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/node"), // Homebrew, Apple silicon
        PathBuf::from("/usr/local/bin/node"),    // Homebrew Intel, nodejs.org pkg
        PathBuf::from("/usr/bin/node"),
    ];

    if let Some(home) = home.as_ref() {
        candidates.push(home.join(".volta/bin/node"));
        candidates.push(home.join(".local/bin/node"));
        // nvm and fnm keep one directory per installed version.
        for base in [".nvm/versions/node", ".local/share/fnm/node-versions"] {
            if let Ok(entries) = std::fs::read_dir(home.join(base)) {
                let mut versions: Vec<PathBuf> = entries
                    .flatten()
                    .map(|entry| entry.path())
                    .filter(|path| path.is_dir())
                    .collect();
                // Lexical sort approximates version order well enough to prefer
                // a newer install; every candidate is probed regardless.
                versions.sort();
                for version in versions.into_iter().rev() {
                    candidates.push(version.join("bin/node"));
                    candidates.push(version.join("installation/bin/node"));
                }
            }
        }
    }

    candidates.into_iter().find(|path| is_executable(path))
}

/// Build the PATH the server should see: the directory Node lives in, plus the
/// usual homes of the CLIs it shells out to.
fn augmented_path(node: &Path) -> String {
    let mut dirs: Vec<PathBuf> = Vec::new();

    if let Some(parent) = node.parent() {
        dirs.push(parent.to_path_buf());
    }

    if let Some(home) = dirs_home() {
        dirs.push(home.join(".local/bin")); // claude
        dirs.push(home.join(".npm-global/bin")); // codex, ft
        dirs.push(home.join(".cargo/bin"));
        dirs.push(home.join(".volta/bin"));
    }

    dirs.extend(
        ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
            .iter()
            .map(PathBuf::from),
    );

    if let Some(existing) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&existing));
    }

    // Preserve first-seen order while dropping duplicates.
    let mut seen = std::collections::HashSet::new();
    dirs.retain(|dir| seen.insert(dir.clone()));

    std::env::join_paths(dirs)
        .map(|joined| joined.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".to_string())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false);
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}
