import {
  createKillOnCloseJob,
  type ProcessJob,
  type ProcessJobFactory,
} from "./process-containment.ts";
import { killGroup, stopRetainedGroup, type GroupPorts } from "./process-owner.ts";

/** Platform seams for an owned tree. Tests inject "win32" and fake edges without a Windows host. */
export type TreePorts = GroupPorts & {
  /** Kernel containment where process groups do not exist; an unavailable job keeps the tree stop. */
  jobFactory?: ProcessJobFactory;
};

/** Quote for the target argv parser: always wrap, escape `"` and edge backslashes. */
function msvcrtQuote(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const char of value) {
    if (char === "\\") {
      backslashes++;
      continue;
    }
    if (char === '"') quoted += "\\".repeat(backslashes * 2 + 1) + '"';
    else quoted += "\\".repeat(backslashes) + char;
    backslashes = 0;
  }
  return quoted + "\\".repeat(backslashes * 2) + '"';
}

/** Hide one cmd.exe parse behind `^`; a second pass survives the shim's `%*` reparse. */
function caretEscape(text: string): string {
  return text.replace(/([()%!^"<>&|])/g, "^$1");
}

/**
 * Batch entrypoints cannot spawn directly (CVE-2024-27980), so they run as
 * `cmd.exe /d /s /c "..."`. The program path rides in plain quotes so a space cannot split it;
 * a quote or % in the path is refused instead of misquoted. Other commands pass through.
 */
function windowsTarget(command: string, args: readonly string[]) {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (!/\.(?:cmd|bat)$/i.test(base)) return { command, args: [...args], verbatim: false };
  if (command.includes('"') || command.includes("%"))
    throw new Error("Windows batch command path cannot contain a quote or %");
  const quoted = args.map((arg) => caretEscape(caretEscape(msvcrtQuote(arg))));
  const line = [`"${command}"`, ...quoted].join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}

/**
 * How one supervised child and its descendants are spawned, contained and stopped. POSIX puts the
 * child in its own process group and signals the group. Windows has no process groups: the tree
 * joins a kill-on-close Job Object and stops through taskkill.
 */
export function ownedTree(command: string, args: readonly string[], ports: TreePorts = {}) {
  const platform = ports.platform ?? process.platform;
  const windows = platform === "win32";
  const target = windows
    ? windowsTarget(command, args)
    : { command, args: [...args], verbatim: false };
  return {
    platform,
    command: target.command,
    args: target.args,
    spawnOptions: windows
      ? { detached: false, windowsHide: true, windowsVerbatimArguments: target.verbatim }
      : { detached: true },
    terminate: (pid: number) => killGroup(pid, "SIGTERM", ports),
    destroy: (pid: number) => killGroup(pid, "SIGKILL", ports),
    stopRetained: (pid: number, graceMs: number) => stopRetainedGroup(pid, graceMs, ports),
    /** Joins the tree to its job where one is needed; dispose the result when ownership ends. */
    contain(pid: number | undefined): ProcessJob | undefined {
      if (!windows || pid === undefined) return undefined;
      const job = (ports.jobFactory ?? createKillOnCloseJob)();
      job?.assign(pid);
      return job;
    },
  };
}
