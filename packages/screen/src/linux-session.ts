/*
 * The graphical session a Linux screen helper must reach: a Wayland desktop (ADR 0093; X11
 * sessions are not supported). The systemd user service can start before the person logs in,
 * so its own environment may lack WAYLAND_DISPLAY. Each time a helper starts, a daemon without
 * one asks the user manager for the session's variables, which the desktop session imports
 * there once someone is logged in.
 */
import { execFile } from "node:child_process";

/**
 * The variables a helper needs to reach the person's desktop, accessibility bus and portals.
 * DISPLAY and XAUTHORITY reach XWayland, for apps computer use launches that still use X.
 */
export const sessionVariables = [
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "XAUTHORITY",
] as const;

export function hasGraphicalSession(env: NodeJS.ProcessEnv): boolean {
  return !!env.WAYLAND_DISPLAY;
}

/** Why there is no usable session, for a message the model and the person can act on. */
export function noSessionMessage(env: NodeJS.ProcessEnv): string {
  return env.DISPLAY ? x11SessionMessage : noGraphicalSessionMessage;
}

/**
 * `systemctl --user show-environment` output: one `KEY=value` per line, values with special
 * characters in `$'…'` quoting. Lines that are not assignments are skipped, never fatal.
 */
export function parseManagerEnvironment(text: string): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trimEnd());
    if (!match?.[1]) continue;
    variables[match[1]] = unquote(match[2] ?? "");
  }
  return variables;
}

const escapes: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  "'": "'",
  '"': '"',
};

function unquote(value: string): string {
  if (value.length >= 3 && value.startsWith("$'") && value.endsWith("'"))
    return value
      .slice(2, -1)
      .replace(/\\x([0-9a-fA-F]{2})|\\(.)/g, (whole, hex: string | undefined, char: string) =>
        hex ? String.fromCharCode(Number.parseInt(hex, 16)) : (escapes[char] ?? whole),
      );
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

/**
 * The environment for a helper: the daemon's own when it has a display; otherwise the daemon's
 * with the session variables the user manager holds, which describe the live session.
 */
export function withManagerSession(
  env: NodeJS.ProcessEnv,
  manager: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  if (hasGraphicalSession(env)) return env;
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of sessionVariables) {
    const value = manager[key];
    if (value) merged[key] = value;
  }
  return merged;
}

/** Runs a command and resolves its standard output; rejects on failure or after `timeoutMs`. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export const runCommand: CommandRunner = (command, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });

/**
 * Reads the graphical session environment at use time. A missing or failing `systemctl` leaves
 * the daemon's environment as it is: the helper then reports that there is no session.
 */
export function graphicalSessionEnvironment(options: {
  env: NodeJS.ProcessEnv;
  run?: CommandRunner;
  timeoutMs?: number;
}): () => Promise<NodeJS.ProcessEnv> {
  return async () => {
    if (hasGraphicalSession(options.env)) return options.env;
    let output: string;
    try {
      output = await (options.run ?? runCommand)(
        "systemctl",
        ["--user", "show-environment"],
        options.timeoutMs ?? 2_000,
      );
    } catch {
      return options.env;
    }
    return withManagerSession(options.env, parseManagerEnvironment(output));
  };
}

export const noGraphicalSessionMessage =
  "No graphical session: this Linux machine has no desktop session ace can reach (WAYLAND_DISPLAY is unset for the ace service and in the systemd user manager). Someone must be logged in to a Wayland desktop for computer use; ask the person to log in, then try again.";

export const x11SessionMessage =
  'This Linux desktop runs an X11 session. ace\'s computer use and live view work on Wayland desktops only; ask the person to log out and choose a Wayland session at login (on Ubuntu, "Ubuntu" rather than "Ubuntu on Xorg"), then try again.';
