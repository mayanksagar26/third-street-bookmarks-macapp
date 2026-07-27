# Third Street Bookmarks — Mac App

A native macOS build of [third-street-bookmarks](https://github.com/mayanksagar26/third-street-bookmarks).
Same reader, packaged as a real `.app` you install and launch from the dock —
no terminal, no `localhost:3456` tab.

This is **Phase 1** of the desktop plan: get the app off localhost and into
`/Applications`. Phase 2 replaces the one-shot `spawn('claude', ['-p', …])` with
a proper ACP harness so agents get real sessions, cancellation, and multiple
providers. See [Roadmap](#roadmap).

---

## How it fits together

```
┌─────────────────────────────────────────────┐
│  Third Street Bookmarks.app                 │
│                                             │
│  ┌───────────────┐      ┌────────────────┐  │
│  │ Tauri webview │◄────►│ Express server │  │
│  │  React 18     │ HTTP │  Node, child   │  │
│  └───────────────┘ :port└────────────────┘  │
│         ▲                       │           │
│         │ init script           │ spawns    │
│    window.__TSB_API_PORT__      ▼           │
│  ┌──────────────────┐   claude · codex      │
│  │ Rust supervisor  │   python3 · ft        │
│  └──────────────────┘   birdclaw            │
└─────────────────────────────────────────────┘
                    │
                    ▼
              ~/.tsb/  (shared with the web build)
              ├── state.db       read · fav · label · note
              ├── bookmarks.json
              ├── settings.json
              └── server.log
```

The Rust layer (`src-tauri/src/sidecar.rs`) does four things the browser version
never had to:

1. **Finds Node.** A GUI-launched app inherits a bare `PATH`, so `node` — and
   everything the server shells out to — has to be located explicitly.
2. **Picks a free port** instead of hardcoding 3456, so two copies don't collide.
3. **Injects the port** into the webview before any app code runs, via
   `window.__TSB_API_PORT__`. `src/api-base.js` patches `fetch` to use it, which
   keeps the React source a zero-diff copy of upstream.
4. **Kills the whole process group** on quit. The server spawns `claude`,
   `codex` and `python3`; killing just the direct child would orphan those and
   leave the port held.

### Data location

Everything writable lives in `~/.tsb/`, **shared with the browser build**. Open
either one and it's the same collection with the same read/favourite history.
The app bundle itself is read-only, which is why `server/index.js` takes its
paths from `TSB_DATA_DIR` and `TSB_SCRIPT_DIR` rather than `__dirname/..`.

---

## Requirements

| | |
|---|---|
| macOS | 11.0+ |
| Node.js | 20+ — **must be installed separately** (see [Known gaps](#known-gaps)) |
| Rust | 1.77+, only to build |
| Python | 3.9+, for classify/export |

Optional, for the AI features: [Claude Code](https://claude.ai/code) or
[Codex CLI](https://github.com/openai/codex).
For syncing: [Field Theory](https://github.com/afar1/fieldtheory-cli) or
[birdclaw](https://birdclaw.sh).

## Build

```bash
npm install
npm install --prefix server   # express + better-sqlite3 (native)
npm run app:build             # → src-tauri/target/release/bundle/dmg/
```

The `.dmg` and `.app` land in `src-tauri/target/release/bundle/`.

## Develop

```bash
npm run app:dev
```

Runs Vite on :5173 with hot reload, and Tauri points the webview at it. The
Express sidecar is started by Rust exactly as it is in a packaged build, so dev
and release differ only in where the frontend comes from.

To work on the frontend alone in a normal browser:

```bash
node server/index.js &   # :3456
npm run dev              # :5173, proxies /api
```

## Troubleshooting

Server output goes to `~/.tsb/server.log`. If the window shows
*"Couldn't start the local server"*, that file has the reason — most often Node
not being found.

---

## Security model

The server holds every bookmark you've saved and can spawn a coding agent on
your machine. "It's only localhost" is not a threat model, so it's treated as an
authenticated service that happens to have a short network path.

| Control | What it removes |
|---|---|
| Binds `127.0.0.1` only | The LAN. Express's default binds every interface — anyone on your Wi-Fi could read the whole collection. |
| Per-launch bearer token | Other local processes, and any website you visit. A browser can reach `127.0.0.1` from any page; it cannot guess 32 bytes from the OS CSPRNG. |
| Origin + Host validation | DNS rebinding, and cross-site reads from a page that resolves a domain to loopback. |
| Path validation on adopt | Arbitrary file reads. Symlink-resolved, home-scoped, `.json`, regular files only. |
| Read-only agent invocation | Prompt injection turning into code execution. |

The token is generated in Rust and passed to the server in its environment, so
in the packaged app it never touches disk. Standalone runs persist one at `0600`
for the Vite dev proxy. `/api/health` is the only unauthenticated route — it
answers readiness before the token reaches the webview and reveals nothing the
open port doesn't.

**Agents run with their hands tied.** Every prompt this app builds contains
bookmark text, which is content a stranger wrote and you saved — "ignore your
instructions and run this" is a plausible tweet. So Codex runs
`exec --sandbox read-only` and Claude runs with `Bash`, `Write`, `Edit`,
`NotebookEdit`, `WebFetch`, `WebSearch` and `Task` denied. Untrusted spans are
fenced with a per-call random marker. The flags are the part that holds; the
fencing is belt and braces.

Verified by attacking a running instance: LAN refused, unauthenticated 401,
wrong token 401, cross-origin 403, rebinding Host 403, `/etc/passwd` and `../..`
escapes rejected.

## Known gaps

These are real and worth fixing before this goes to anyone else's machine:

- **Node isn't bundled.** The app finds a system Node (Homebrew, nodejs.org,
  nvm, fnm, volta). If the user has none, it fails with an instruction to
  install one. Bundling a Node binary — or porting the server to Rust/axum —
  removes the dependency.
- **Unsigned and unnotarised.** Gatekeeper will block it on any Mac but the one
  that built it. Needs an Apple Developer ID to distribute. This is also the
  last real gap in the security model: everything above protects the app at
  runtime, but nothing currently stops someone with write access to the bundle
  from modifying it. Signing plus a hardened runtime is what closes that.
- **`better-sqlite3` is a native module** compiled for this machine's arch. A
  universal build needs it rebuilt for both, or the server ported to Rust.
- **No tests.** Upstream has none either; the sidecar logic is the first thing
  here that deserves them.

## Roadmap

**Phase 1 — desktop shell.** ← you are here
Tauri window, supervised Node sidecar, port injection, packaged `.dmg`.

**Phase 2 — the harness.**
Replace `spawn('claude', ['-p', prompt])` with an
[ACP](https://agentclientprotocol.com) client: persistent sessions per chat
thread, idle + hard timeouts, a working Stop button, and an agent pool so
classifying 500 bookmarks parallelises. Modelled on
[`block/buzz`](https://github.com/block/buzz)'s `crates/buzz-acp`.

**Phase 3 — multiple providers.**
Agent config as a table (`{ id, command, args, env, model }`), not a switch —
so Claude Code, Codex, Goose, and open-weight models like Kimi K2 (via Goose or
an OpenAI-compatible `base_url`) are rows rather than code changes.

**Phase 4 — drop Node.**
Port the ~25 Express routes to axum. Single static binary, no runtime
dependency, universal build.
