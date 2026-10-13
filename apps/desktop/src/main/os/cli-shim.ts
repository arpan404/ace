import { posix, win32 } from "node:path";
import type { DoctorReport } from "../../shared/onboarding.ts";

type DoctorCheck = DoctorReport["checks"][number];

/**
 * The `ace` command in `~/.ace/bin`: a tiny script that runs the daemon CLI bundled in the
 * installed app on the app's own Node runtime. Pure: content, the overwrite decision and the
 * PATH check. `cli-shim-install.ts` is the file system shell around it.
 */

/** Every shim ace writes carries this line, so a later launch knows the file is its own. */
export const cliShimMarker = "ace-cli-shim: written by the ace desktop app on launch";

export interface CliShimLocation {
  directory: string;
  file: string;
}

export function cliShimLocation(home: string, platform: NodeJS.Platform): CliShimLocation {
  const path = platform === "win32" ? win32 : posix;
  const directory = path.join(home, ".ace", "bin");
  return { directory, file: path.join(directory, platform === "win32" ? "ace.cmd" : "ace") };
}

export interface CliShimTarget {
  /** The bundled Node runtime, at the running app's real path. */
  node: string;
  /** The bundled daemon CLI (`daemon/ace.mjs`). */
  entry: string;
}

const sh = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** The shim's full content, or an error for a path the script language can't hold safely. */
export function renderCliShim(target: CliShimTarget, platform: NodeJS.Platform): string {
  for (const path of [target.node, target.entry]) {
    if (/[\r\n\0]/.test(path)) throw new Error(`Unsupported path for the ace command: ${path}`);
    // cmd expands `%` even inside quotes, and a `"` would end the quoted path.
    if (platform === "win32" && /["%]/.test(path))
      throw new Error(`Unsupported path for the ace command: ${path}`);
  }
  if (platform === "win32")
    return [
      "@echo off",
      `REM ${cliShimMarker}`,
      `"${target.node}" --disable-warning=ExperimentalWarning "${target.entry}" %*`,
      "",
    ].join("\r\n");
  return [
    "#!/bin/sh",
    `# ${cliShimMarker}`,
    `exec ${sh(target.node)} --disable-warning=ExperimentalWarning ${sh(target.entry)} "$@"`,
    "",
  ].join("\n");
}

/**
 * What is at the shim's path now. `kind: "other"` is anything ace never writes there: a
 * directory, a symlink, a device or a file too large to be a shim.
 */
export type ExistingShim =
  | { kind: "missing" }
  | { kind: "other" }
  | { kind: "file"; content: string; executable: boolean };

export type CliShimPlan = "create" | "replace" | "unchanged" | "foreign";

/**
 * Whether to write the shim. Only a file ace wrote (its marker) or an earlier ace launcher is
 * ever replaced; anything else at that path belongs to the person and stays untouched.
 */
export function planCliShim(existing: ExistingShim, desired: string): CliShimPlan {
  if (existing.kind === "missing") return "create";
  if (existing.kind === "other") return "foreign";
  if (existing.content === desired && existing.executable) return "unchanged";
  return ownedShim(existing.content) ? "replace" : "foreign";
}

/**
 * An earlier ace launcher without the marker: a short `sh` script whose only command execs
 * ace's own daemon CLI (`…/daemon/ace.mjs`) or the older app's server (`…/apps/server/dist/
 * bin.mjs`), passing the arguments through. Never executed to find out.
 */
const earlierLauncher =
  /^exec\s+.*\/(?:daemon\/ace\.mjs|apps\/server\/dist\/bin\.mjs)["']?\s+"\$@"\s*$/;
const harmlessLine = /^(?:#.*|set\s+-[eu]+|[A-Z_][A-Z0-9_]*="[^"`$]*"|)$/;

function ownedShim(content: string): boolean {
  if (content.length > 4096) return false;
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.some((line) => line.endsWith(cliShimMarker))) return true;
  if (!/^#!\s*\/bin\/(?:ba)?sh\b/.test(lines[0] ?? "")) return false;
  const commands = lines.slice(1).filter((line) => !harmlessLine.test(line));
  return commands.length === 1 && earlierLauncher.test(commands[0] ?? "");
}

/**
 * macOS runs a quarantined app from a randomised read-only copy until the person moves it;
 * a shim pointing there breaks as soon as the app quits. A disk image is ejected the same way.
 */
export function transientAppPath(resources: string, platform: NodeJS.Platform): boolean {
  return platform === "darwin" && /\/AppTranslocation\/|^\/Volumes\//.test(resources);
}

/** Whether `directory` is an entry of the login shell's PATH. */
export function onPath(directory: string, path: string, platform: NodeJS.Platform): boolean {
  const separator = platform === "win32" ? ";" : ":";
  const normalise = (entry: string) => {
    const trimmed = entry.length > 1 ? entry.replace(/[\\/]+$/, "") : entry;
    return platform === "win32" ? trimmed.toLowerCase() : trimmed;
  };
  const wanted = normalise(directory);
  return path.split(separator).some((entry) => entry !== "" && normalise(entry) === wanted);
}

export type CliShimResult =
  | {
      state: "created" | "replaced" | "unchanged";
      file: string;
      directory: string;
      /** Whether a terminal finds `ace` without the full path. */
      onPath: boolean;
    }
  | { state: "foreign"; file: string }
  | { state: "skipped"; reason: string }
  | { state: "failed"; file: string; message: string };

/** A line for the log, or undefined when there is nothing to say. */
export function cliShimLog(result: CliShimResult): string | undefined {
  switch (result.state) {
    case "created":
    case "replaced":
      return `ace command ${result.state} at ${result.file}`;
    case "unchanged":
      return undefined;
    case "foreign":
      return `${result.file} is not an ace command; left it unchanged`;
    case "skipped":
      return `ace command not installed: ${result.reason}`;
    case "failed":
      return `Could not install the ace command at ${result.file}: ${result.message}`;
  }
}

/** The desktop's own check for the diagnostics list, or undefined when nothing needs doing. */
export function cliShimCheck(result: CliShimResult): DoctorCheck | undefined {
  switch (result.state) {
    case "created":
    case "replaced":
    case "unchanged":
      if (result.onPath) return undefined;
      return {
        id: "desktop.cli-path",
        status: "warn",
        message: `The ace command is installed at ${result.file}, but its folder is not on PATH.`,
        fix: `Add ${result.directory} to PATH in your shell profile.`,
      };
    case "foreign":
      return {
        id: "desktop.cli",
        status: "warn",
        message: `${result.file} is not ace's command, so ace left it unchanged.`,
        fix: `Remove or rename ${result.file}, then restart ace.`,
      };
    case "failed":
      return {
        id: "desktop.cli",
        status: "warn",
        message: `Could not install the ace command: ${result.message}`,
        fix: `Check that you can write ${result.file}, then restart ace.`,
      };
    case "skipped":
      return undefined;
  }
}
