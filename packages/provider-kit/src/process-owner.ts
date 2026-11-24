import { spawn } from "node:child_process";
import type { ProcessJournal } from "./process-inventory.ts";
import { setTimeout as delay } from "node:timers/promises";
import { win32 } from "node:path";
import { openLibrary, runsOnBun } from "./bun-ffi.ts";
import { loadKoffi } from "./koffi.ts";
import type { WindowsJob } from "./process-containment.ts";
import {
  captureTree,
  signalTreeMember,
  systemTreeIo,
  type TreeIo,
  type TreeMember,
} from "./process-tree.ts";
import { supervisorBackend } from "./native-switches.ts";
import {
  NativeChildProcess,
  nativeGroup,
  nativeKillWindowsTree,
  onHoldLimit,
  supervisorAddon,
  warnSafely,
} from "./native-process.ts";
import { processIdentity } from "./process-identity.ts";

// The native hold limit's kill goes through the same guard as every other group signal.
onHoldLimit((child) => {
  if (child.pid === undefined) return;
  try {
    killGroup(child.pid, "SIGKILL", child);
  } catch (error) {
    // EPERM (a member running as another user) and the like: reported, never thrown.
    warnSafely(`Process group ${child.pid} could not be killed: ${String(error)}`);
  }
});

/** Process-global ownership is separate from application-selected shutdown policy. */
const owned = new Map<
  number,
  {
    stop: (graceMs: number) => Promise<unknown>;
    destroy: () => void;
    /** The leader's kernel start, under the native supervisor: its group's identity. */
    start?: string;
  }
>();
/** Processes requested from another thread whose pid has not arrived yet. */
const admitting = new Set<{ stop: (graceMs: number) => Promise<unknown>; destroy: () => void }>();
let shutdownInstalled = false;
const journals = new Set<ProcessJournal>();
export function observeProcessGroups(journal: ProcessJournal): () => void {
  journals.add(journal);
  return () => journals.delete(journal);
}

/**
 * What a group signal may reach. Given a group, the daemon's guard answers "whole" when no
 * member is protected (another home's daemon or what is below it, a kept process, a stop's
 * caller), or else the members that may be signalled, each to be signalled on its own.
 */
export type GroupGuard = (group: number) => "whole" | readonly { pid: number; start: string }[];
/** The same rules for members signalled one by one: the ones that may be signalled. */
export type MemberGuard = (members: readonly TreeMember[]) => readonly TreeMember[];
let groupGuard: GroupGuard | undefined;
let memberGuard: MemberGuard | undefined;
/** Whether this isolate has rules of its own (else a worker relays its signals). */
export function locallyGuarded(): boolean {
  return groupGuard !== undefined;
}
/**
 * Install this isolate's guards; returns their removal. `guardGroupSignals` (leader-group.ts)
 * also serves the signals workers relay here.
 */
export function installGroupGuards(guard: GroupGuard, members?: MemberGuard): () => void {
  groupGuard = guard;
  memberGuard = members;
  return () => {
    if (groupGuard !== guard) return;
    groupGuard = undefined;
    memberGuard = undefined;
  };
}

/** Signal owned members one by one, each checked against its start just before it goes. */
export function signalOwnedMembers(
  members: readonly TreeMember[],
  signal: NodeJS.Signals,
  io: TreeIo = systemTreeIo,
): void {
  let allowed: readonly TreeMember[] = members;
  if (memberGuard)
    try {
      allowed = memberGuard(members);
    } catch (error) {
      // Who is protected is unknown, so no one is signalled; later sweeps report survivors.
      process.emitWarning(`Process members could not be checked: ${String(error)}`);
      allowed = [];
    }
  for (const member of allowed) signalTreeMember(member, signal, io);
}

/**
 * A process group as the native supervisor knows it, by its leader's identity. The invariant:
 * its number is signalled only while `hold()` holds, that is while ace holds the leader
 * unreaped, which pins the group id. The leader is reaped only once the group is confirmed
 * empty, so once `hold()` fails there is nothing left to signal by group, and nothing is.
 */
export interface GroupHandle {
  hold(): boolean;
  unhold(): void;
  signalGroup(signal: NodeJS.Signals): void;
  /** Gone only once confirmed empty while held. */
  groupGone(): boolean;
  /** The owner gave the group up: the native hold limit starts. */
  disown(): void;
  /** The leader's kernel start: the identity ownership is keyed by. */
  leaderStart(): string | undefined;
  /** Whether this supervisor spawned (and holds or held) the leader. */
  readonly spawned: boolean;
}
/** The child's own group handle, when the native supervisor spawned it. */
export function groupOf(child: unknown): GroupHandle | undefined {
  return child instanceof NativeChildProcess ? child : undefined;
}

/** A group a tree stop delivers to without a handle: its leader, and how it signals. */
export type SignalableGroup = {
  readonly leader: number;
  /** Resolves once delivered; a refusal rejects, and the leader is signalled on its own. */
  signal(signal: NodeJS.Signals): Promise<void>;
};

/**
 * The native handle for a group known by its leader's identity, which the caller itself
 * recorded. A pid alone is never enough: it may name whoever holds that pid now.
 */
function nativeHandle(pid: number, start: string | undefined): GroupHandle | undefined {
  if (supervisorBackend() !== "native" || start === undefined) return undefined;
  return nativeGroup(pid, start);
}

/**
 * A live leader with this start, and its tree by proven parent links, one by one. The capture is
 * bound to the root's identity: read only between two checks that the root still has `start`, and
 * discarded if it changed (a reused pid would make the capture someone else's tree).
 */
function signalVerifiedTree(pid: number, start: string, signal: NodeJS.Signals): void {
  let members: TreeMember[] = [];
  try {
    if (processIdentity(pid)?.start !== start) return;
    const captured = captureTree([pid]).members.map((m) => ({ pid: m.pid, start: m.start }));
    if (processIdentity(pid)?.start !== start) return;
    members = [{ pid, start }, ...captured];
  } catch (error) {
    process.emitWarning(`Process tree ${pid} could not be read: ${String(error)}`);
    return;
  }
  signalOwnedMembers(members, signal);
}

/** The guard, then the group by number: callers hold the group first. */
function signalHeldGroup(pid: number, signal: NodeJS.Signals, send: () => void): void {
  if (groupGuard) {
    let allowed: ReturnType<GroupGuard>;
    try {
      allowed = groupGuard(pid);
    } catch (error) {
      // Who is in the group is unknown, so no one in it is signalled; later sweeps report it.
      process.emitWarning(`Process group ${pid} could not be checked: ${String(error)}`);
      allowed = [];
    }
    if (allowed !== "whole") {
      for (const member of allowed) signalTreeMember(member, signal);
      return;
    }
  }
  send();
}

/**
 * Signals a process group. Under the native supervisor the group's handle is asked first: only
 * while it holds is the group listed by number (the guard) and signalled by number; otherwise
 * only its recorded members, one by one. A group with no known identity is never signalled.
 * `start` is its leader's kernel start, when the caller knows it (recovery).
 */
export function killGroup(
  pid: number,
  signal: NodeJS.Signals,
  group?: GroupHandle,
  start?: string,
): void {
  // No process groups exist on Windows: every stop there is the tree stop `killGroupWhile` runs.
  if (process.platform === "win32") {
    killGroupWhile(pid, signal, () => true);
    return;
  }
  const handle = group ?? nativeHandle(pid, start);
  if (handle) {
    if (!handle.hold()) {
      // Never by number. A group this supervisor did not spawn (a previous run's, recovered by
      // its leader's identity) gets its leader and the tree its parent links prove, each by
      // verified identity; one it spawned and released was confirmed empty.
      if (!handle.spawned && start !== undefined) signalVerifiedTree(pid, start, signal);
      return;
    }
    try {
      signalHeldGroup(pid, signal, () => handle.signalGroup(signal));
    } finally {
      handle.unhold();
    }
    return;
  }
  if (supervisorBackend() === "native") {
    // A pid-only caller: the native supervisor never signals a group it cannot prove.
    process.emitWarning(`Process group ${pid} has no recorded identity, so it is not signalled`);
    return;
  }
  // The TypeScript backend: the number goes only while the caller's pin holds. This caller holds
  // nothing, so the group goes by number as it did before a pin could be asked for.
  killGroupWhile(pid, signal, () => true);
}
/**
 * `killGroup`, with the evidence that the number is still the group's checked last, after the
 * guard's scan and immediately before kill(-pid). "unpinned": nothing was sent by number.
 *
 * Residual window, not closed here: the check and kill(-pid) are two calls, and Node and Bun
 * reap a child on their own, so the leader can be reaped between them, and its group id reused
 * if the group also emptied. That takes the pid range cycling in that instant, but nothing in
 * TypeScript can rule it out. The real fix is the Rust supervisor (ACE_SUPERVISOR), which keeps
 * the leader unreaped until its group is empty, so the id stays ace's while anything signals it.
 */
export function killGroupWhile(
  pid: number,
  signal: NodeJS.Signals,
  pinned: () => boolean,
): "sent" | "members" | "unpinned" {
  if (process.platform === "win32") {
    // No process groups exist; reap the tree like every other Windows stop. Exit cleanup must
    // still reach every other owner, so a failure here is reported, not thrown.
    try {
      killWindowsTree(pid, true);
    } catch (error) {
      process.emitWarning(`Could not stop Windows process tree ${pid}: ${String(error)}`);
    }
    return "sent";
  }
  if (groupGuard) {
    let allowed: ReturnType<GroupGuard>;
    try {
      allowed = groupGuard(pid);
    } catch (error) {
      // Who is in the group is unknown, so no one in it is signalled; later sweeps report it.
      process.emitWarning(`Process group ${pid} could not be checked: ${String(error)}`);
      allowed = [];
    }
    // The scan read the group by number: it counts only if the number was still the group's.
    if (!pinned()) return "unpinned";
    if (allowed !== "whole") {
      for (const member of allowed) signalTreeMember(member, signal);
      return "members";
    }
  }
  if (!pinned()) return "unpinned";
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Darwin can report EPERM for groups containing only zombies before reaping.
    if (code !== "ESRCH" && !(process.platform === "darwin" && code === "EPERM")) throw error;
  }
  return "sent";
}
/**
 * Signals a spawned process's tree from code where a throw would end the daemon: timers, exit
 * listeners and voided stop() calls. Resolves once the signal was delivered (or refused and the
 * leader signalled through its handle instead); it never rejects. A group signal refused (EPERM
 * when every member left runs as another user, or a Windows tree stop that cannot run) is
 * reported, and the leader is still signalled through its own handle, which never reaches a
 * reused pid once it has exited.
 *
 * `group` is the TypeScript leader group, when the TypeScript backend spawned the process;
 * without one the native supervisor's handle behind `leader` is signalled.
 */
export function signalTree(
  pid: number,
  force: boolean,
  windows: boolean,
  killTree: WindowsKillTree,
  leader: { kill(signal: NodeJS.Signals): boolean },
  group?: SignalableGroup,
): Promise<void> {
  const signal = force ? "SIGKILL" : "SIGTERM";
  const refused = (error: unknown) => {
    process.emitWarning(`Could not signal process tree ${pid}: ${String(error)}`);
    try {
      leader.kill(signal);
    } catch {
      /* Already gone. */
    }
  };
  try {
    if (windows) killTree(pid, force);
    else if (group) return group.signal(signal).catch(refused);
    else killGroup(pid, signal, groupOf(leader));
  } catch (error) {
    refused(error);
  }
  return Promise.resolve();
}
/** Whether nothing of the group runs: ESRCH, or darwin's EPERM for a group of zombies. */
function groupGone(pid: number, group: GroupHandle | undefined, start?: string): boolean {
  const handle = group ?? nativeHandle(pid, start);
  if (handle) return handle.groupGone();
  // The native supervisor answers by the kernel's probe for a group it knows no identity of.
  // The native supervisor never probes a group by number: with no identity there is nothing
  // it can wait for.
  if (supervisorBackend() === "native") return true;
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || (process.platform === "darwin" && code === "EPERM")) return true;
    throw error;
  }
}
/** A retained group's lifetime is independent of its leader and inherited pipes. */
export async function stopRetainedGroup(
  pid: number,
  graceMs: number,
  group?: GroupHandle,
  start?: string,
): Promise<void> {
  if (supervisorBackend() === "native" && process.platform !== "win32" && !group && !start) {
    // Under the native supervisor a pid alone proves nothing: nothing is signalled, and the
    // pid's current owner, whoever it is, keeps its registration.
    process.emitWarning(`Process group ${pid} has no recorded identity, so it is not stopped`);
    return;
  }
  killGroup(pid, "SIGTERM", group, start);
  const deadline = performance.now() + graceMs;
  while (true) {
    // Cheap for a native group: its release loop scans, the poll reads the result.
    if (groupGone(pid, group, start)) break;
    const remaining = deadline - performance.now();
    if (remaining <= 0) {
      killGroup(pid, "SIGKILL", group, start);
      break;
    }
    await delay(Math.min(25, remaining));
  }
  unregisterGroup(pid, group, start);
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
/**
 * Heard each time a process group becomes owned: its leader's pid and, when whoever started it
 * read one (a probe's worker does, before the probe can exit), its macOS unique id.
 */
type OwnershipListener = (pid: number, unique?: string) => void;
const ownershipListeners = new Set<OwnershipListener>();
/** Hear when a process group becomes owned (a watch starts then); returns the unsubscribe. */
export function onGroupOwned(listener: OwnershipListener): () => void {
  ownershipListeners.add(listener);
  return () => ownershipListeners.delete(listener);
}
/** Under the native supervisor, the leader's start: the identity its group is signalled by. */
function nativeStart(pid: number): { start?: string } {
  if (supervisorBackend() !== "native" || process.platform === "win32") return {};
  try {
    const start = processIdentity(pid)?.start;
    return start === undefined ? {} : { start };
  } catch {
    return {};
  }
}
export function registerGroup(
  pid: number,
  stop: (graceMs: number) => Promise<unknown>,
  metadata: { name: string; cwd?: string; unique?: string },
  /** Ends the tree synchronously at process exit, through its leader group, never by number. */
  end: () => void,
): void {
  // The identity recorded now is this caller's: its group is signalled by that identity, never
  // by whoever holds the pid later.
  const recorded = nativeStart(pid);
  try {
    for (const journal of journals) journal.add(pid, metadata);
  } catch (error) {
    end();
    throw error;
  }
  if (ownersSize() === 0) process.on("exit", cleanup);
  owned.set(pid, { stop, destroy: end, ...recorded });
  for (const listener of ownershipListeners)
    try {
      listener(pid, metadata.unique);
    } catch (error) {
      process.emitWarning(`A process ownership listener failed: ${String(error)}`);
    }
}
/**
 * Ownership ends even when a journal cannot record it. This runs in exit listeners, where a
 * throw would be uncaught and end the daemon (a full disk did, through the inventory's delete).
 */
export function unregisterGroup(pid: number, group?: GroupHandle, start?: string): void {
  // Keyed by identity where the caller has one: a stale caller never ends a later owner's
  // registration of the same pid.
  const caller = group?.leaderStart() ?? start;
  const registered = owned.get(pid)?.start;
  if (caller !== undefined && registered !== undefined && caller !== registered) {
    group?.disown();
    return;
  }
  owned.delete(pid);
  // The owner gives its group up through its own handle, never by number.
  group?.disown();
  for (const journal of journals)
    try {
      journal.remove(pid);
    } catch (error) {
      process.emitWarning(`Could not record that process ${pid} exited: ${String(error)}`);
    }
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
    void Promise.allSettled(stoppers().map((entry) => entry.stop(graceMs)))
      .then(() => {
        dispose();
        // Incoming application handlers have run; restore default signal termination.
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
      })
      .catch((error: unknown) =>
        process.emitWarning(`Could not restore signal ${signal} termination: ${String(error)}`),
      );
  };
  const onInt = () => terminate("SIGINT");
  const onTerm = () => terminate("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return dispose;
}

/** The leaders of every process group this process owns now. */
export function ownedGroupLeaders(): number[] {
  return [...owned.keys()];
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
  if (supervisorBackend() === "native") {
    nativeKillWindowsTree(pid, force);
    return;
  }
  // A missing System32 or a failed spawn throws: the caller's stop then fails instead of
  // waiting on a kill that never ran.
  const killer = spawn(
    windowsSystemExecutable("taskkill.exe"),
    force ? ["/pid", String(pid), "/T", "/F"] : ["/pid", String(pid), "/T"],
    {
      stdio: "ignore",
      windowsHide: true,
    },
  );
  killer.once("error", (error) => {
    process.emitWarning(`taskkill could not run for process ${pid}: ${error.message}`);
  });
  killer.unref();
}

/** GetSystemDirectoryW: the characters written to a 1,024-character buffer, or 0. */
type SystemDirectoryReader = { read(buffer: Buffer, size: number): unknown; unload(): void };

// The daemon runs on Bun and binds kernel32 with bun:ffi. Other runtimes take koffi: the desktop
// app ships it for its main process and probe worker, so their Windows tree stops find
// taskkill there; the daemon ships none. macOS and Linux load neither.
function systemDirectoryReader(): SystemDirectoryReader {
  if (runsOnBun()) {
    const kernel = openLibrary("kernel32.dll", {
      GetSystemDirectoryW: { args: ["ptr", "u32"], returns: "u32" },
    });
    return {
      read: (buffer, size) => kernel.symbols.GetSystemDirectoryW(buffer, size),
      unload: () => kernel.close(),
    };
  }
  const kernel = loadKoffi().load("kernel32.dll");
  try {
    const read = kernel.func("uint __stdcall GetSystemDirectoryW(void* buffer, uint size)");
    return { read: (buffer, size) => read(buffer, size), unload: () => kernel.unload() };
  } catch (error) {
    kernel.unload();
    throw error;
  }
}

let systemDirectory: string | undefined;
/** A file in Windows' own System32, located by the kernel rather than the environment. */
export function windowsSystemExecutable(name: string): string {
  if (supervisorBackend() === "native")
    return supervisorAddon().supervisorWindowsSystemExecutable(name);
  if (systemDirectory === undefined) {
    const reader = systemDirectoryReader();
    try {
      const buffer = Buffer.alloc(1024 * 2);
      const length = Number(reader.read(buffer, 1024));
      if (length <= 0 || length >= 1024) throw new Error("Windows system directory unavailable");
      const directory = buffer.toString("utf16le", 0, length * 2);
      if (!win32.isAbsolute(directory)) throw new Error("Windows system directory is not absolute");
      systemDirectory = directory;
    } finally {
      reader.unload();
    }
  }
  return win32.join(systemDirectory, name);
}

/** How long a forced Windows tree stop may take before the stop fails instead of completing. */
const forcedTreeStopMs = 5_000;

/** A Windows tree is alive while its joined job has members, else while its leader runs. */
export function windowsTreeRunning(pid: number, job?: Pick<WindowsJob, "running">): boolean {
  return job?.running?.() ?? leaderRunning(pid);
}
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
  const running = () => windowsTreeRunning(pid, job);
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
  if (supervisorBackend() === "native") {
    const mapped = JSON.parse(
      supervisorAddon().supervisorToWindowsCommand(command, [...args]),
    ) as WindowsCommand;
    return { command: mapped.command, args: [...mapped.args], verbatim: mapped.verbatim };
  }
  const base = command.split(/[\\/]/).pop() ?? command;
  if (!/\.(?:cmd|bat)$/i.test(base)) return { command, args: [...args], verbatim: false };
  const line = [escapeCommand(command), ...args.map(escapeArgument)].join(" ");
  return { command: "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
