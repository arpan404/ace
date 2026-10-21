/*
 * The graphical session a Linux screen helper must reach. The systemd user service can start
 * before the person logs in, so its own environment may lack DISPLAY and WAYLAND_DISPLAY. Each
 * time a helper starts, a daemon without a display asks the user manager for the session's
 * variables, which the desktop session imports there once someone is logged in (ADR 0093).
 */
import { execFile } from "node:child_process";

/** The variables a helper needs to reach the person's desktop, accessibility bus and portals. */
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
  return !!(env.DISPLAY || env.WAYLAND_DISPLAY);
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
  "No graphical session: this Linux machine has no desktop session ace can reach (DISPLAY and WAYLAND_DISPLAY are unset for the ace service and in the systemd user manager). Someone must be logged in to a desktop for computer use; ask the person to log in, then try again.";
