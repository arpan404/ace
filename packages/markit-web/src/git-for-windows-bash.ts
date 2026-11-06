import { win32 } from "node:path";

/**
 * Git for Windows' exec path: `<root>\<mingw32|mingw64|clangarm64|ucrt64>\libexec\git-core` on a
 * drive, under at least one folder. Anything else (an MSYS2 or Cygwin git's `/usr/lib/git-core`,
 * a relative path, a drive root install) is not a layout ace trusts to find bash in.
 */
const gitForWindowsExecPath =
  /^[a-z]:[\\/](?:[^\\/]+[\\/])+(?:mingw32|mingw64|clangarm64|ucrt64)[\\/]libexec[\\/]git-core[\\/]?$/i;

/** The environment for asking git where it lives: an inherited GIT_EXEC_PATH would answer instead. */
export function withoutGitExecPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => name.toUpperCase() !== "GIT_EXEC_PATH"),
  );
}

export type GitBashLookup = {
  env: NodeJS.ProcessEnv;
  /** Runs `git --exec-path` with `env` and answers its trimmed output. */
  execPath: (env: NodeJS.ProcessEnv) => string;
  exists: (path: string) => boolean;
};

export type GitBash = { ok: true; bash: string } | { ok: false; error: string };

/**
 * Git for Windows' own `bin\bash.exe`, the launcher that puts its `usr\bin` tools on PATH. The
 * install root comes from the git first on PATH, asked without any GIT_EXEC_PATH override, and
 * counts only when it has Git for Windows' layout and both its bash files.
 */
export function gitForWindowsBash({ env, execPath, exists }: GitBashLookup): GitBash {
  const found = execPath(withoutGitExecPath(env)).trim();
  const refuse = {
    ok: false as const,
    error: `found git at ${found}, which is not Git for Windows; install Git for Windows or put its git first on PATH`,
  };
  if (!gitForWindowsExecPath.test(found)) return refuse;
  const root = win32.resolve(found, "..", "..", "..");
  const bash = win32.join(root, "bin", "bash.exe");
  if (!exists(bash) || !exists(win32.join(root, "usr", "bin", "bash.exe"))) return refuse;
  return { ok: true, bash };
}
