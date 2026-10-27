import { readFileSync } from "node:fs";
import koffi from "koffi";
import { z } from "zod";

// Windows identity: creation FILETIME (wall-clock, so callers still prove absence via ESRCH)
// plus the token-user SID string. Windows has no pgid, so group stays the pid.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x00100000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
export const WindowsSid = z
  .string()
  .regex(/^S-\d+(-\d+)+$/)
  .max(256);
const nativeInt = z.number().int();
const dword = z.number().int().nonnegative().max(0xffffffff);

/** NULL from Win32 arrives as null, undefined, 0, or 0n through koffi BigInt pointers. */
function isNullHandle(handle: unknown): boolean {
  return handle === null || handle === undefined || handle === 0 || handle === 0n;
}
function expectNative(ok: boolean): void {
  if (!ok) throw new Error("Kernel process identity unavailable");
}

/** Raw Win32 surface behind the identity. Tests inject a fake; production uses koffi. */
export type WindowsProcessIdentityApi = {
  open: (pid: number) => unknown;
  /** True once the process has exited, even while a handle still keeps its object alive. */
  exited: (handle: unknown) => boolean;
  times: (handle: unknown, creation: Buffer, exit: Buffer, kernel: Buffer, user: Buffer) => number;
  openToken: (processHandle: unknown, outToken: unknown[]) => number;
  tokenInfo: (token: unknown, info: Buffer | null, length: number, needed: number[]) => number;
  sidToString: (sid: unknown, outString: unknown[]) => number;
  decodeSid: (ptr: unknown) => string;
  free: (ptr: unknown) => void;
  close: (handle: unknown) => void;
  lastError: () => number;
  unload: () => void;
};

function loadWindowsProcessIdentityApi(): WindowsProcessIdentityApi {
  const kernel = koffi.load("kernel32.dll");
  let advapi: ReturnType<typeof koffi.load> | undefined;
  const unload = (): void => {
    try {
      kernel.unload();
    } finally {
      advapi?.unload();
    }
  };
  try {
    advapi = koffi.load("Advapi32.dll");
    const openProcess = kernel.func(
      "void* __stdcall OpenProcess(uint access, int inherit, uint pid)",
    );
    const times = kernel.func(
      "int __stdcall GetProcessTimes(void* process, void* creation, void* exit, void* kernel, void* user)",
    );
    const lastError = kernel.func("uint __stdcall GetLastError()");
    const closeHandle = kernel.func("int __stdcall CloseHandle(void* handle)");
    const wait = kernel.func("uint __stdcall WaitForSingleObject(void* handle, uint milliseconds)");
    const localFree = kernel.func("void* __stdcall LocalFree(void* memory)");
    const openToken = advapi.func(
      "int __stdcall OpenProcessToken(void* process, uint access, _Out_ void** token)",
    );
    const tokenInfo = advapi.func(
      "int __stdcall GetTokenInformation(void* token, int infoClass, void* info, uint length, _Out_ uint* needed)",
    );
    const sidToString = advapi.func(
      "int __stdcall ConvertSidToStringSidW(void* sid, _Out_ void** text)",
    );
    return {
      open: (pid) => openProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid),
      exited(handle) {
        const state = nativeInt.parse(wait(handle, 0));
        expectNative(state === WAIT_OBJECT_0 || state === WAIT_TIMEOUT);
        return state === WAIT_OBJECT_0;
      },
      times,
      openToken: (handle, out) => openToken(handle, TOKEN_QUERY, out),
      tokenInfo: (token, info, length, needed) =>
        tokenInfo(token, TOKEN_USER, info, length, needed),
      sidToString,
      decodeSid: (ptr) =>
        z
          .string()
          .min(1)
          .parse(koffi.decode.string16(z.bigint().parse(ptr))),
      free: (ptr) => void localFree(ptr),
      lastError,
      close: (handle) => void closeHandle(handle),
      unload,
    };
  } catch (error) {
    try {
      unload();
    } catch {
      // Keep the binding failure.
    }
    throw error;
  }
}

/**
 * Creation start and token-user SID for one PID, or undefined when no such process exists. Other
 * native failures throw; every handle and buffer is released before returning.
 */
export function readWindowsProcessIdentity(
  pid: number,
  api: WindowsProcessIdentityApi,
): { start: string; owner: string } | undefined {
  z.number().int().positive().parse(pid);
  const handle = api.open(pid);
  if (isNullHandle(handle)) {
    expectNative(nativeInt.parse(api.lastError()) === ERROR_INVALID_PARAMETER);
    return undefined;
  }
  try {
    // Any open handle, the console host's included, keeps an exited process openable.
    if (api.exited(handle)) return undefined;
    // GetProcessTimes takes four FILETIME out-pointers and allows no NULL.
    const creation = Buffer.alloc(8);
    expectNative(
      nativeInt.parse(
        api.times(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)),
      ) !== 0,
    );
    const low = dword.parse(creation.readUInt32LE(0));
    const high = dword.parse(creation.readUInt32LE(4));
    const start = ((BigInt(high) << 32n) | BigInt(low)).toString();
    const tokenOut: unknown[] = [null];
    expectNative(nativeInt.parse(api.openToken(handle, tokenOut)) !== 0);
    const token = tokenOut[0];
    expectNative(!isNullHandle(token));
    try {
      // The first call with no buffer reports the size TOKEN_USER needs.
      const needed: number[] = [0];
      expectNative(nativeInt.parse(api.tokenInfo(token, null, 0, needed)) === 0);
      expectNative(nativeInt.parse(api.lastError()) === ERROR_INSUFFICIENT_BUFFER);
      const info = Buffer.alloc(z.number().int().positive().max(4096).parse(needed[0]));
      expectNative(nativeInt.parse(api.tokenInfo(token, info, info.length, [0])) !== 0);
      const sid = process.arch === "ia32" ? BigInt(info.readUInt32LE(0)) : info.readBigUInt64LE(0);
      expectNative(sid !== 0n);
      const stringOut: unknown[] = [null];
      expectNative(nativeInt.parse(api.sidToString(sid, stringOut)) !== 0);
      const text = stringOut[0];
      expectNative(!isNullHandle(text));
      try {
        return { start, owner: WindowsSid.parse(api.decodeSid(text)) };
      } finally {
        api.free(text);
      }
    } finally {
      api.close(token);
    }
  } finally {
    api.close(handle);
  }
}

/** POSIX owners stay numeric uids; only Windows owners are token-user SID strings. */
const processOwner = process.platform === "win32" ? WindowsSid : z.number().int().nonnegative();
export const ProcessIdentity = z.strictObject({
  pid: z.number().int().positive(),
  start: z.string().min(1).max(128),
  uid: processOwner,
  group: z.number().int().positive(),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;
const missingProcess = z.object({ code: z.literal("ESRCH") });

/** ESRCH proves absence. Permission errors and surviving group members must retain resources. */
function gone(target: number): boolean {
  try {
    process.kill(target, 0);
    return false;
  } catch (error) {
    if (missingProcess.safeParse(error).success) return true;
    throw error;
  }
}
export function processGroupIsGone(group: number): boolean {
  return gone(-z.number().int().positive().parse(group));
}
function linuxStat(text: string): { pid: number; ticks: string; group: number } {
  const end = text.lastIndexOf(")");
  if (end < 1) throw new Error("Invalid kernel process stat");
  const fields = text
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  return {
    pid: z.coerce
      .number()
      .int()
      .positive()
      .parse(text.slice(0, text.indexOf(" "))),
    ticks: z.string().regex(/^\d+$/).parse(fields[19]),
    group: z.coerce.number().int().positive().parse(fields[2]),
  };
}

/** Kernel start identity and uid, without inspecting arguments, environment or credentials. */
export function processIdentity(pid: number): ProcessIdentity | undefined {
  z.number().int().positive().parse(pid);
  try {
    if (process.platform === "linux") {
      const path = `/proc/${pid}/stat`;
      const stat = linuxStat(readFileSync(path, "utf8"));
      const uid = readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      // Identity must not change while assembling fields from separate kernel files.
      const confirmed = linuxStat(readFileSync(path, "utf8"));
      if (
        confirmed.pid !== stat.pid ||
        confirmed.ticks !== stat.ticks ||
        confirmed.group !== stat.group
      )
        throw new Error("Process changed during inspection");
      const identity = ProcessIdentity.parse({
        pid: stat.pid,
        start: `${z.uuid().parse(boot)}:${stat.ticks}`,
        uid: z.coerce.number().int().nonnegative().parse(uid),
        group: stat.group,
      });
      if (identity.pid !== pid) throw new Error("Process identity mismatch");
      return identity;
    }
    if (process.platform === "darwin") {
      // Apple's proc_bsdinfo ABI includes pid, uid, pgid and the kernel start timeval.
      const library = koffi.load("/usr/lib/libproc.dylib");
      try {
        const info = library.func(
          "int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int size)",
        );
        const buffer = Buffer.alloc(136);
        if (info(pid, 3, 0, buffer, buffer.length) !== buffer.length)
          throw new Error("Kernel process identity unavailable");
        const identity = ProcessIdentity.parse({
          pid: buffer.readUInt32LE(12),
          uid: buffer.readUInt32LE(20),
          group: buffer.readUInt32LE(100),
          start: `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`,
        });
        if (identity.pid !== pid) throw new Error("Process identity mismatch");
        return identity;
      } finally {
        library.unload();
      }
    }
    if (process.platform === "win32") {
      const api = loadWindowsProcessIdentityApi();
      try {
        const found = readWindowsProcessIdentity(pid, api);
        return (
          found && ProcessIdentity.parse({ pid, start: found.start, uid: found.owner, group: pid })
        );
      } finally {
        api.unload();
      }
    }
    throw new Error("Kernel process identity requires Linux or macOS");
  } catch (error) {
    // Native/procfs failure is not absence unless the kernel also proves the PID is gone.
    if (gone(pid)) return undefined;
    throw error;
  }
}

// Windows trees: no process group exists. A process belongs to a recorded tree only by proof:
// its own recorded PID, creation time and SID still match, or its parent is a live proven member
// and it was created after that parent. Windows never reparents, so a live process naming a dead
// member's PID may be that member's orphan or the child of a later process that reused the PID;
// such a process is never ended and never lets the tree count as gone.

export type WindowsProcessRecord = { pid: number; start: string; uid: string };
export type WindowsTreeMember = { pid: number; start: string };
/** One Toolhelp pass; `taken` is the system FILETIME read just before it. */
export type WindowsProcessSnapshot = {
  taken: string;
  processes: readonly { pid: number; parent: number }[];
};
/** A PID's creation time and owner, undefined once it is proven gone, "unknown" if unreadable. */
export type WindowsIdentify = (
  pid: number,
) => { start: string; uid: string } | undefined | "unknown";
export type WindowsTreeState = {
  /** Proven members alive now, recorded or newly found. Only these may be ended. */
  live: WindowsProcessRecord[];
  /** Newly proven members, to record while their ancestry can still be checked. */
  discovered: WindowsProcessRecord[];
  /** Recorded members that are gone, or whose PID now names another process. */
  gone: WindowsProcessRecord[];
  /** Live PIDs that may belong to the tree but cannot be proven to. */
  ambiguous: number[];
};

const after = (a: string, b: string): boolean => BigInt(a) > BigInt(b);

export function windowsTreeState(
  recorded: readonly WindowsProcessRecord[],
  snapshot: WindowsProcessSnapshot,
  identify: WindowsIdentify,
): WindowsTreeState {
  const children = new Map<number, number[]>();
  for (const entry of snapshot.processes)
    if (entry.pid !== entry.parent)
      children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry.pid]);
  const read = new Map<number, ReturnType<WindowsIdentify>>();
  const look = (pid: number) => {
    if (!read.has(pid)) read.set(pid, identify(pid));
    return read.get(pid);
  };
  const state: WindowsTreeState = { live: [], discovered: [], gone: [], ambiguous: [] };
  const seen = new Set(recorded.map((member) => member.pid));
  for (const member of recorded) {
    const current = look(member.pid);
    if (current === "unknown") state.ambiguous.push(member.pid);
    else if (current?.start === member.start && current.uid === member.uid) state.live.push(member);
    else state.gone.push(member);
  }
  // A child listed under a live proven parent and created after it, before the snapshot, was
  // made by that parent: no other process held the PID in that interval.
  for (let index = 0; index < state.live.length; index++) {
    const parent = state.live[index];
    if (!parent) continue;
    for (const pid of children.get(parent.pid) ?? []) {
      if (seen.has(pid)) continue;
      const found = look(pid);
      if (found === undefined) continue;
      seen.add(pid);
      if (found === "unknown") {
        state.ambiguous.push(pid);
        continue;
      }
      if (found.uid !== parent.uid || after(parent.start, found.start)) continue;
      if (after(found.start, snapshot.taken)) continue;
      const member = { pid, start: found.start, uid: found.uid };
      state.live.push(member);
      state.discovered.push(member);
    }
  }
  for (const member of state.gone) {
    const holder = look(member.pid);
    for (const pid of children.get(member.pid) ?? []) {
      if (seen.has(pid)) continue;
      const found = look(pid);
      if (found === undefined) continue;
      if (found !== "unknown") {
        // Started before the member: an earlier holder's child.
        if (found.uid !== member.uid || !after(found.start, member.start)) continue;
        // A live holder of the reused PID made every child started after it.
        if (holder && holder !== "unknown" && !after(holder.start, found.start)) continue;
      }
      seen.add(pid);
      state.ambiguous.push(pid);
    }
  }
  return state;
}

/** Native surface for recorded Windows trees. Tests inject a fake; production uses koffi. */
export interface WindowsTreeRuntime {
  state(recorded: readonly WindowsProcessRecord[]): WindowsTreeState;
  /**
   * Ends one member only while it still carries its recorded creation time. Returns whether it
   * was ended or already gone; an unreadable or protected process throws.
   */
  terminate(member: WindowsTreeMember): "ended" | "gone";
}

// PROCESSENTRY32W: th32ProcessID at 8; th32ParentProcessID follows a pointer-sized heap ID.
const pointer64 = process.arch !== "ia32" && process.arch !== "arm";
const processEntrySize = pointer64 ? 568 : 556;
const parentOffset = pointer64 ? 32 : 24;
const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_TERMINATE = 0x0001;
const ERROR_NO_MORE_FILES = 18;

function loadWindowsTreeApi() {
  const kernel = koffi.load("kernel32.dll");
  try {
    return {
      kernel,
      // Precise: the coarse clock lags by up to a tick, so a child created just before the
      // snapshot would look created after it and be left out of the tree.
      now: kernel.func("void __stdcall GetSystemTimePreciseAsFileTime(void* time)"),
      snapshot: kernel.func("intptr_t __stdcall CreateToolhelp32Snapshot(uint flags, uint pid)"),
      first: kernel.func("int __stdcall Process32FirstW(intptr_t snapshot, void* entry)"),
      next: kernel.func("int __stdcall Process32NextW(intptr_t snapshot, void* entry)"),
      closeSnapshot: kernel.func("int __stdcall CloseHandle(intptr_t handle)"),
      open: kernel.func("void* __stdcall OpenProcess(uint access, int inherit, uint pid)"),
      times: kernel.func(
        "int __stdcall GetProcessTimes(void* process, void* creation, void* exit, void* kernel, void* user)",
      ),
      wait: kernel.func("uint __stdcall WaitForSingleObject(void* handle, uint milliseconds)"),
      terminate: kernel.func("int __stdcall TerminateProcess(void* process, uint code)"),
      close: kernel.func("int __stdcall CloseHandle(void* handle)"),
      lastError: kernel.func("uint __stdcall GetLastError()"),
    };
  } catch (error) {
    kernel.unload();
    throw error;
  }
}

function snapshotWindowsProcesses(
  api: ReturnType<typeof loadWindowsTreeApi>,
): WindowsProcessSnapshot {
  const clock = Buffer.alloc(8);
  api.now(clock);
  const taken = clock.readBigUInt64LE(0).toString();
  const handle = nativeInt.parse(Number(api.snapshot(TH32CS_SNAPPROCESS, 0)));
  expectNative(handle !== -1 && handle !== 0);
  try {
    const entry = Buffer.alloc(processEntrySize);
    entry.writeUInt32LE(processEntrySize, 0);
    const found: { pid: number; parent: number }[] = [];
    let ok = nativeInt.parse(api.first(handle, entry));
    while (ok !== 0) {
      found.push({ pid: entry.readUInt32LE(8), parent: entry.readUInt32LE(parentOffset) });
      ok = nativeInt.parse(api.next(handle, entry));
    }
    expectNative(nativeInt.parse(api.lastError()) === ERROR_NO_MORE_FILES);
    return { taken, processes: found };
  } finally {
    api.closeSnapshot(handle);
  }
}

/** The real Windows tree runtime: one Toolhelp snapshot, then per-PID identity reads. */
export const windowsTreeRuntime: WindowsTreeRuntime = {
  state(recorded) {
    const tree = loadWindowsTreeApi();
    const identityApi = loadWindowsProcessIdentityApi();
    try {
      return windowsTreeState(recorded, snapshotWindowsProcesses(tree), (pid) => {
        try {
          const found = readWindowsProcessIdentity(pid, identityApi);
          return found && { start: found.start, uid: found.owner };
        } catch {
          // Unreadable is not absent: a protected process stays unproven either way.
          return "unknown";
        }
      });
    } finally {
      try {
        identityApi.unload();
      } finally {
        tree.kernel.unload();
      }
    }
  },
  terminate(member) {
    const api = loadWindowsTreeApi();
    try {
      const handle = api.open(
        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
        0,
        member.pid,
      );
      if (isNullHandle(handle)) {
        expectNative(nativeInt.parse(api.lastError()) === ERROR_INVALID_PARAMETER);
        return "gone";
      }
      try {
        if (nativeInt.parse(api.wait(handle, 0)) === WAIT_OBJECT_0) return "gone";
        const creation = Buffer.alloc(8);
        const times = api.times(
          handle,
          creation,
          Buffer.alloc(8),
          Buffer.alloc(8),
          Buffer.alloc(8),
        );
        expectNative(nativeInt.parse(times) !== 0);
        // The PID now names another process: the member itself is gone.
        if (creation.readBigUInt64LE(0).toString() !== member.start) return "gone";
        if (nativeInt.parse(api.terminate(handle, 1)) !== 0) return "ended";
        // A process already exiting refuses termination; wait briefly for it to finish.
        expectNative(nativeInt.parse(api.wait(handle, 2_000)) === WAIT_OBJECT_0);
        return "gone";
      } finally {
        api.close(handle);
      }
    } finally {
      api.kernel.unload();
    }
  },
};
