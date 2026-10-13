import type { DesktopDaemonStatus, DiagnosticCheck } from "@/boot/desktop.ts";

/** A cause the desktop reported by the daemon's exit code, in plain words. */
export function startupCause(cause: DesktopDaemonStatus["cause"]): string | undefined {
  if (cause === "port-in-use") return "Another app is using ace's port. Quit it, then try again.";
  return undefined;
}

/** Startup failures cross the desktop bridge; keep technical details in Show logs. */
export function startupFailure(reason: string, cause?: DesktopDaemonStatus["cause"]): string {
  const known = startupCause(cause);
  if (known) return known;
  if (/legacy|older (?:ace|data)/i.test(reason))
    return "ace found data from an older installation. Choose a separate data folder, then try again.";
  if (/permission|not writable|EACCES/i.test(reason))
    return "ace cannot use its data folder. Check that you can read and write it, then try again.";
  return "Try again. If ace still doesn't start, open the logs for details.";
}

const checks: Record<string, { label: string; fix: string }> = {
  node: { label: "Node runtime", fix: "Install Node 24 or newer, then restart ace." },
  home: { label: "Data folder", fix: "Check that you can read and write the ace data folder." },
  disk: { label: "Storage", fix: "Check the ace data folder's permissions and free disk space." },
  sqlite: {
    label: "Saved data",
    fix: "Close ace and preserve its data before restoring a backup.",
  },
  git: { label: "Git", fix: "Install Git and check that it works in a terminal." },
  "node-pty": { label: "Terminal support", fix: "Reinstall ace, then try opening a terminal." },
  chromium: { label: "Browser support", fix: "Install Chrome or Chromium, then restart ace." },
  port: { label: "Local connection", fix: "Quit the app using ace's port, then try again." },
  "remote.openssl": { label: "Secure connections", fix: "Install OpenSSL, then restart ace." },
  "desktop.cli": {
    label: "ace command",
    fix: "Move aside the file at ~/.ace/bin/ace (ace.cmd on Windows), then restart ace.",
  },
  "desktop.cli-path": {
    label: "ace command",
    fix: "Add ~/.ace/bin to PATH in your shell profile to run ace from a terminal.",
  },
  "provider.claude": {
    label: "Claude Code",
    fix: "Check its installation and sign in from a terminal.",
  },
  "provider.codex": { label: "Codex", fix: "Check its installation and sign in from a terminal." },
  "provider.opencode": {
    label: "OpenCode",
    fix: "Check its installation and sign in from a terminal.",
  },
  "provider.cursor": {
    label: "Cursor",
    fix: "Check its installation and sign in from a terminal.",
  },
  "provider.antigravity": {
    label: "Antigravity",
    fix: "Check its installation and sign in from a terminal.",
  },
};

export function startupCheck(check: DiagnosticCheck) {
  return (
    checks[check.id] ?? {
      label: "Another check",
      fix: "Open the logs for details, then try again.",
    }
  );
}
