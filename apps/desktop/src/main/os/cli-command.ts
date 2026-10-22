import type { TerminalCommand } from "../../shared/contract.ts";
import type { DoctorReport } from "../../shared/onboarding.ts";
import { putCliOnPath, takeCliOffPath, type CliPathTarget } from "./cli-path-install.ts";
import type { CliShimResult } from "./cli-shim.ts";

export interface TerminalCommandOptions {
  /** The launch's shim install; undefined when this build writes none (development). */
  shim: Promise<CliShimResult> | undefined;
  /** Whether Settings has the command on PATH, and saving a change to that. */
  enabled(): boolean;
  save(on: boolean): Promise<void>;
  target: Omit<CliPathTarget, "directory" | "file">;
  /** The login shell's PATH from launch, and a fresh read after this app changed it. */
  launchPath(): Promise<string>;
  freshPath(): Promise<string>;
  log(line: string): void;
}

export interface TerminalCommandControl {
  /** Where the command stands; waits for the launch's install. */
  status(): Promise<TerminalCommand>;
  /** Turns the command on PATH on or off and saves the choice. */
  set(on: boolean): Promise<TerminalCommand>;
}

/**
 * The `ace` command for terminals: on launch, once the shim is written, it goes on PATH unless
 * the person turned that off. Changes run one at a time.
 */
export function terminalCommand(options: TerminalCommandOptions): TerminalCommandControl {
  const shimTarget = async (): Promise<CliPathTarget | TerminalCommand> => {
    const shim = await options.shim;
    if (!shim) return { state: "unavailable", reason: "Development builds don't install it." };
    if (shim.state === "skipped") return { state: "unavailable", reason: `${shim.reason}.` };
    if (shim.state === "foreign")
      return { state: "unavailable", reason: `${shim.file} is not ace's command.` };
    if (shim.state === "failed") return { state: "unavailable", reason: shim.message };
    return { ...options.target, directory: shim.directory, file: shim.file };
  };
  const apply = async (path: () => Promise<string>): Promise<TerminalCommand> => {
    const target = await shimTarget();
    if ("state" in target) return target;
    if (!options.enabled()) return { state: "off", command: target.file };
    const status = await putCliOnPath(target, await path());
    const line = statusLog(status);
    if (line) options.log(line);
    return status;
  };
  let current = apply(options.launchPath);
  return {
    status: () => current,
    set(on) {
      const previous = current;
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await options.save(on);
          if (on) return apply(options.freshPath);
          const target = await shimTarget();
          if ("state" in target) return target;
          return takeCliOffPath(target);
        });
      current = next.catch(() => previous);
      return next;
    },
  };
}

function statusLog(status: TerminalCommand): string | undefined {
  switch (status.state) {
    case "added":
      return `Added the ace command's folder to PATH in ${status.files.join(", ")}`;
    case "manual":
      return `Could not put the ace command on PATH${status.reason ? `: ${status.reason}` : ""}`;
    case "other":
      return `Terminals run another ace at ${status.command}; left PATH unchanged`;
    default:
      return undefined;
  }
}

/** A diagnostics entry when terminals can't run `ace` and the person has to act. */
export function terminalCommandCheck(
  status: TerminalCommand | undefined,
): DoctorReport["checks"][number] | undefined {
  if (status?.state !== "manual") return undefined;
  return {
    id: "desktop.cli-path",
    status: "warn",
    message: `The ace command is installed, but its folder is not on PATH${status.reason ? ` (${status.reason})` : ""}.`,
    fix: `Add ${status.directory} to PATH in your shell profile.`,
  };
}
