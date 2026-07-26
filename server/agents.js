// ─────────────────────────────────────────────────────────────────────────────
// AI runtime registry + detection.
//
// Modelled on the KNOWN_ACP_RUNTIMES table in block/buzz
// (desktop/src-tauri/src/managed_agents/discovery.rs). The shape is the point:
// each runtime is a row of data — where to find it, how to install it, how to
// ask whether it's logged in — so supporting another CLI is a new entry rather
// than a new branch. When this app grows a real ACP harness the same rows carry
// straight over.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOME = os.homedir();

/** Directories a GUI-launched app has to search itself — it inherits no shell PATH. */
const SEARCH_DIRS = [
  path.join(HOME, '.local/bin'),
  path.join(HOME, '.npm-global/bin'),
  path.join(HOME, '.bun/bin'),
  path.join(HOME, '.volta/bin'),
  path.join(HOME, '.cargo/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
];

const RUNTIMES = [
  {
    id: 'claude',
    label: 'Claude Code',
    vendor: 'Anthropic',
    command: 'claude',
    icon: '✳️',
    blurb: 'Runs on your Claude subscription — no API key needed.',
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
    installUrl: 'https://code.claude.com/docs/en/getting-started',
    loginHint: 'Run `claude` once in a terminal to sign in.',
    versionArgs: ['--version'],
    // Exits non-zero when signed out. Cheap enough to run on every detect.
    authProbeArgs: ['auth', 'status'],
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    command: 'codex',
    icon: '◆',
    blurb: 'Runs on your ChatGPT plan — no API key needed.',
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    installUrl: 'https://developers.openai.com/codex/cli/',
    loginHint: 'Run `codex login` to authenticate.',
    versionArgs: ['--version'],
    authProbeArgs: ['login', 'status'],
  },
];

function findBinary(command) {
  for (const dir of SEARCH_DIRS) {
    const candidate = path.join(dir, command);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Unreadable directory — just move on.
    }
  }
  return null;
}

/**
 * Run a probe with a hard deadline.
 *
 * A CLI that blocks on a prompt or a hung network call would otherwise stall
 * detection forever, and detection is the first thing onboarding waits on.
 */
function probe(binary, args, timeoutMs = 6000) {
  return new Promise(resolve => {
    const child = execFile(
      binary,
      args,
      { timeout: timeoutMs, env: { ...process.env }, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          out: `${stdout || ''}${stderr || ''}`.trim(),
        });
      },
    );
    child.on('error', () => resolve({ ok: false, out: '' }));
  });
}

/**
 * Detect every known runtime.
 *
 * Returns one entry per runtime whether or not it's present, so the UI can show
 * "install this" next to "use this" instead of silently hiding options.
 */
async function detectRuntimes() {
  return Promise.all(
    RUNTIMES.map(async runtime => {
      const binary = findBinary(runtime.command);
      const base = {
        id: runtime.id,
        label: runtime.label,
        vendor: runtime.vendor,
        icon: runtime.icon,
        blurb: runtime.blurb,
        installCommand: runtime.installCommand,
        installUrl: runtime.installUrl,
        loginHint: runtime.loginHint,
        installed: Boolean(binary),
        binary,
        version: null,
        authenticated: null, // null = unknown / not probed
      };

      if (!binary) return base;

      const version = await probe(binary, runtime.versionArgs);
      if (version.ok) base.version = version.out.split('\n')[0].slice(0, 60);

      if (runtime.authProbeArgs) {
        const auth = await probe(binary, runtime.authProbeArgs);
        base.authenticated = auth.ok;
      }

      return base;
    }),
  );
}

module.exports = { RUNTIMES, SEARCH_DIRS, detectRuntimes, findBinary };
