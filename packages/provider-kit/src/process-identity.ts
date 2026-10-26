import { readFileSync } from "node:fs";
import koffi from "koffi";
import { z } from "zod";

// Windows identity: creation FILETIME (wall-clock, so callers still prove absence via ESRCH)
// plus the token-user SID string. Windows has no pgid, so group stays the pid.
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER = 1;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const windowsSid = z
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
      open: (pid) => openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid),
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
        return { start, owner: windowsSid.parse(api.decodeSid(text)) };
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

export const ProcessIdentity = z.strictObject({
  pid: z.number().int().positive(),
  start: z.string().min(1).max(128),
  uid: z.union([z.number().int().nonnegative(), windowsSid]),
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
  if (process.platform === "win32")
    throw new Error("Process-group inspection is unavailable on Windows");
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
