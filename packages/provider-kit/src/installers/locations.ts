/** Official per-user script destinations, shared by discovery and the reviewed manifest. */
export const scriptExecutablePaths = {
  codex: ".local/bin/codex",
  claude: ".local/bin/claude",
  opencode: ".opencode/bin/opencode",
} as const;

/** A Windows directory as an environment base (USERPROFILE, LOCALAPPDATA, ...) and a relative path. */
export type WindowsDirectory = readonly [base: string, path: string];

/**
 * Per-user Windows directories each vendor's own installer writes to, checked after PATH:
 * claude.ai/install.ps1 (`claude install` → %USERPROFILE%\.local\bin\claude.exe),
 * chatgpt.com/codex/install.ps1 (default %LOCALAPPDATA%\Programs\OpenAI\Codex\bin),
 * opencode.ai/v2/install under Git Bash ($HOME/.opencode/bin/opencode.exe),
 * cursor.com/install?win32=true (%LOCALAPPDATA%\cursor-agent\cursor-agent.cmd),
 * astral.sh/uv/install.ps1 ($HOME/.local/bin/uv.exe), and the Node.js MSI (%ProgramFiles%\nodejs).
 */
export const windowsInstallDirectories: Readonly<Record<string, readonly WindowsDirectory[]>> = {
  claude: [["USERPROFILE", ".local\\bin"]],
  codex: [["LOCALAPPDATA", "Programs\\OpenAI\\Codex\\bin"]],
  opencode: [["USERPROFILE", ".opencode\\bin"]],
  "cursor-agent": [["LOCALAPPDATA", "cursor-agent"]],
  uv: [["USERPROFILE", ".local\\bin"]],
  node: [["PROGRAMFILES", "nodejs"]],
  npm: [["PROGRAMFILES", "nodejs"]],
};

/**
 * Shim directories of the Windows package managers people install agent CLIs with: npm's global
 * prefix (%APPDATA%\npm), `bun install -g` (%USERPROFILE%\.bun\bin), WinGet portable links and
 * Scoop shims ($env:SCOOP, default %USERPROFILE%\scoop).
 */
export const windowsShimDirectories: readonly WindowsDirectory[] = [
  ["APPDATA", "npm"],
  ["USERPROFILE", ".bun\\bin"],
  ["LOCALAPPDATA", "Microsoft\\WinGet\\Links"],
  ["SCOOP", "shims"],
  ["USERPROFILE", "scoop\\shims"],
];

/** Agent CLIs and package managers whose lookup may fall back to the shim directories. */
export const windowsShimCommands: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
  "cursor-agent",
  "agy_acp_server",
  "gemini",
  "qwen",
  "claude-agent-acp",
  "codex-acp",
  "goose",
  "auggie",
  "uv",
]);
