import { spawn } from "node:child_process";
import type { ProcessJournal } from "./process-inventory.ts";
import { setTimeout as delay } from "node:timers/promises";
import { win32 } from "node:path";
import type { WindowsJob } from "./process-containment.ts";

/** Process-global ownership is separate from application-selected shutdown policy. */
const owned = new Map<
  number,
  { stop: (graceMs: number) => Promise<unknown>; destroy: () => void }
>();
/** Processes requested from another thread whose pid has not arrived yet. */
const admitting = new Set<{ stop: (graceMs: number) => Promise<unknown>; destroy: () => void }>();
let shutdownInstalled = false;
const journals = new Set<ProcessJournal>();
export function observeProcessGroups(journal: ProcessJournal): () => void {
  journals.add(journal);
  return () => journals.delete(journal);
}

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    // No process groups exist; reap the tree like every other Windows stop.
    killWindowsTree(pid, true);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Darwin can report EPERM for groups containing only zombies before reaping.
    if (code !== "ESRCH" && !(process.platform === "darwin" && code === "EPERM")) throw error;
  }
}
/** A retained group's lifetime is independent of its leader and inherited pipes. */
export async function stopRetainedGroup(pid: number, graceMs: number): Promise<void> {
  killGroup(pid, "SIGTERM");
  const deadline = performance.now() + graceMs;
  while (true) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) break;
      throw error;
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      killGroup(pid, "SIGKILL");
      break;
    }
    await delay(Math.min(25, remaining));
  }
  unregisterGroup(pid);
}
function cleanup(): void {
  // Negative-pid signals are invalid on Windows; each owner registers the
  // synchronous destroy its platform actually uses to end the tree.
  for (const entry of owned.values()) entry.destroy();
  for (const entry of admitting) entry.destroy();
}
const ownersSize = () => owned.size + admitting.size;
const stoppers = () => [...owned.values(), ...admitting];
/**
 * Own a process another thread is starting, before its pid is known: a global stop waits for it
 * and process exit destroys it. Dispose once the pid is registered or the request has settled.
 */
export function admitProcess(
  stop: (graceMs: number) => Promise<unknown>,
  destroy: () => void,
): () => void {
  const entry = { stop, destroy };
  if (ownersSize() === 0) process.on("exit", cleanup);
  admitting.add(entry);
  return () => {
    if (!admitting.delete(entry)) return;
    if (ownersSize() === 0) process.removeListener("exit", cleanup);
  };
}
export function registerGroup(
  pid: number,
  stop: (graceMs: number) => Promise<unknown>,
  metadata: { name: string; cwd?: string } = { name: "ace-process" },
  destroy?: () => void,
): void {
  const end = destroy ?? (() => killGroup(pid, "SIGKILL"));
  try {
    for (const journal of journals) journal.add(pid, metadata);
  } catch (error) {
    end();
    throw error;
  }
  if (ownersSize() === 0) process.on("exit", cleanup);
  owned.set(pid, { stop, destroy: end });
}
export function unregisterGroup(pid: number): void {
  owned.delete(pid);
  for (const journal of journals) journal.remove(pid);
  if (ownersSize() === 0) process.removeListener("exit", cleanup);
}

/** Opt into graceful process termination. Dispose to restore application ownership. */
export function installShutdownHandlers({
  graceMs = 5_000,
}: { graceMs?: number } = {}): () => void {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new RangeError("Invalid graceMs");
  if (shutdownInstalled) throw new Error("Shutdown handlers are already installed");
  shutdownInstalled = true;
  let terminating = false;
  const dispose = () => {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    shutdownInstalled = false;
  };
  const terminate = (signal: NodeJS.Signals) => {
    if (terminating) return;
    terminating = true;
    void Promise.allSettled(stoppers().map((entry) => entry.stop(graceMs))).then(() => {
      dispose();
      // Incoming application handlers have run; restore default signal termination.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  };
  const onInt = () => terminate("SIGINT");
  const onTerm = () => terminate("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return dispose;
}

export async function stopOwnedGroups(graceMs = 500): Promise<void> {
  const results = await Promise.allSettled(stoppers().map((entry) => entry.stop(graceMs)));
  if (results.some((result) => result.status === "rejected"))
    throw new Error("Some owned process groups could not be stopped");
}

// Windows: no process groups exist, so trees stop through taskkill and batch entrypoints
// run through cmd.exe.

/** Whole-tree stop on Windows, where process groups do not exist. */
export type WindowsKillTree = (pid: number, force: boolean) => void;

/** taskkill /T stops the tree the way a Job Object would; /F forces it. Never uses a shell. */
export function killWindowsTree(pid: number, force: boolean): void {
  try {
    const killer = spawn(
      // From System32, never PATH: a daemon started with a bare PATH still stops its trees.
      win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"],
      {
        stdio: "ignore",
        windowsHide: true,
      },
    );
    killer.once("error", () => {});
    killer.unref();
  } catch {
    /* Exit polling still reaps a survivor; the next stop escalates. */
  }
}

/** How long a forced Windows tree stop may take before the stop fails instead of completing. */
const forcedTreeStopMs = 5_000;

function leaderRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

/**
 * Graceful tree stop that escalates after the grace, mirroring stopRetainedGroup. A joined job
 * is the liveness source, so members that outlive the leader keep the stop open. It completes
 * only once the tree is gone; a tree that survives the forced stop fails it.
 */
export async function stopRetainedWindowsTree(
  pid: number,
  graceMs: number,
  killTree: WindowsKillTree = killWindowsTree,
  job?: Pick<WindowsJob, "running" | "terminate">,
): Promise<void> {
  const running = () => job?.running?.() ?? leaderRunning(pid);
  killTree(pid, false);
  const deadline = performance.now() + graceMs;
  while (running()) {
    if (performance.now() >= deadline) break;
    await delay(25);
  }
  if (!running()) return;
  // taskkill runs asynchronously, so the stop waits until the tree is really gone.
  killTree(pid, true);
  job?.terminate?.();
  const forcedBy = performance.now() + forcedTreeStopMs;
  while (running()) {
    if (performance.now() >= forcedBy)
      throw new Error("Windows process tree survived its forced stop");
    await delay(25);
  }
}

/** Batch entrypoints cannot spawn directly (CVE-2024-27980); route them through cmd.exe. */
export type WindowsCommand = { command: string; args: string[]; verbatim: boolean };

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

/** The program path rides in plain quotes so a space cannot split it; a quote
 * or % in the path is refused instead of misquoted. */
function escapeCommand(value: string): string {
  if (value.includes('"') || value.includes("%"))
    throw new Error("Windows batch command path cannot contain a quote or %");
  return `"${value}"`;
}

function escapeArgument(value: string): string {
  return caretEscape(caretEscape(msvcrtQuote(value)));
}

/**
 * One program inside a `cmd.exe /c` line the caller already owns: the path in plain quotes, a
 * batch target's arguments escaped twice for its `%*` reparse, any other program's once.
 */
export function windowsCmdLine(command: string, args: readonly string[]): string {
  const base = command.split(/[\\/]/).pop() ?? command;
  const escape = /\.(?:cmd|bat)$/i.test(base)
    ? escapeArgument
    : (value: string) => caretEscape(msvcrtQuote(value));
  return [escapeCommand(command), ...args.map(escape)].join(" ");
}

/** Wrap a batch entrypoint as `cmd.exe /d /s /c "..."`; other commands pass through. */
export function toWindowsCommand(command: string, args: readonly string[]): WindowsCommand {
  const base = command.split(/[\\/]/).pop() ?? command;
  if (!/\.(?:cmd|bat)$/i.test(base)) return { command, args: [...args], verbatim: false };
  const line = [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
