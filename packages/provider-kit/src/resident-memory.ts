import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  nativeHandle,
  nativePointer,
  openLibrary,
  readInt32,
  runsOnBun,
  type NativeLibrary,
} from "./bun-ffi.ts";

/** A process's resident memory in bytes, or undefined once it is gone. */
export type ResidentSampler = (pid: number) => Promise<number | undefined>;

/**
 * Whether this process can read other processes' resident memory. Linux reads procfs; macOS
 * and Windows call the system through bun:ffi, so only on Bun, which runs the daemon.
 */
export function residentSamplingAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || ((platform === "darwin" || platform === "win32") && runsOnBun());
}

/**
 * Reads another process's resident set size, the memory it holds in RAM. Each read is a single
 * system call (Linux: one small procfs file), cheap enough to poll several times a second.
 * macOS's physical footprint would leave out Bun's JavaScript heap, so this is RSS everywhere.
 * A reading that can't be taken throws, so the caller can say the limit isn't enforced.
 */
export function residentSampler(platform: NodeJS.Platform = process.platform): ResidentSampler {
  if (platform === "linux") return linuxResident;
  if (!residentSamplingAvailable(platform))
    return async () => {
      throw new Error(`Reading another process's memory on ${platform} needs Bun's bun:ffi`);
    };
  return platform === "darwin" ? darwinResident : windowsResident;
}

async function linuxResident(pid: number): Promise<number | undefined> {
  let status: string;
  try {
    status = await readFile(`/proc/${pid}/status`, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  const kib = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
  // A process that has exited but not been reaped (a zombie) has no VmRSS line.
  return kib === undefined ? undefined : Number(kib) * 1024;
}

const nativeInt = z.number().int();
const ESRCH = 3;
const ERROR_INVALID_PARAMETER = 87;

// Bound once and kept for the process: the watchdog reads every 100 ms.
let libproc: NativeLibrary<"proc_pid_rusage" | "__error"> | undefined;
// rusage_info_v2 is 160 bytes; ri_resident_size is the uint64 at offset 64.
const rusage = new Uint8Array(256);
const rusageView = new DataView(rusage.buffer);

async function darwinResident(pid: number): Promise<number | undefined> {
  libproc ??= openLibrary("/usr/lib/libSystem.B.dylib", {
    proc_pid_rusage: { args: ["i32", "i32", "ptr"], returns: "i32" },
    // The calling thread's errno, read right after the call that failed.
    __error: { args: [], returns: "ptr" },
  });
  const { proc_pid_rusage, __error } = libproc.symbols;
  const result = proc_pid_rusage(pid, 2, rusage);
  // errno is read right after the call that failed, before any other work.
  const errno = result === 0 ? 0 : readErrno(__error());
  if (nativeInt.parse(result) === 0) return Number(rusageView.getBigUint64(64, true));
  if (errno === ESRCH) return undefined;
  throw new Error(`proc_pid_rusage failed for process ${pid} (errno ${errno})`);
}

function readErrno(location: unknown): number {
  const pointer = nativePointer(location);
  if (pointer === null) throw new Error("No errno location");
  return readInt32(pointer);
}

// Bound once and kept for the process. HANDLEs are 64-bit integers (`i64_fast`).
let kernel32:
  | NativeLibrary<"OpenProcess" | "K32GetProcessMemoryInfo" | "CloseHandle" | "GetLastError">
  | undefined;
// PROCESS_MEMORY_COUNTERS on 64-bit Windows: 72 bytes, WorkingSetSize at offset 16.
const counters = new Uint8Array(72);
const countersView = new DataView(counters.buffer);
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

async function windowsResident(pid: number): Promise<number | undefined> {
  kernel32 ??= openLibrary("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "i64_fast" },
    K32GetProcessMemoryInfo: { args: ["i64_fast", "ptr", "u32"], returns: "i32" },
    CloseHandle: { args: ["i64_fast"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  });
  const k = kernel32.symbols;
  const opened = k.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  // GetLastError is read right after the call that failed, before any other work.
  const openError = opened === 0 ? k.GetLastError() : 0;
  const handle = nativeHandle(opened);
  if (handle === 0) {
    const error = nativeInt.parse(openError);
    if (error === ERROR_INVALID_PARAMETER) return undefined; // No such process.
    throw new Error(`OpenProcess failed for process ${pid} (Windows error ${error})`);
  }
  try {
    countersView.setUint32(0, counters.length, true);
    const read = k.K32GetProcessMemoryInfo(handle, counters, counters.length);
    const readError = read === 0 ? k.GetLastError() : 0;
    if (nativeInt.parse(read) === 0) {
      const error = nativeInt.parse(readError);
      throw new Error(`K32GetProcessMemoryInfo failed for process ${pid} (Windows error ${error})`);
    }
    return Number(countersView.getBigUint64(16, true));
  } finally {
    k.CloseHandle(handle);
  }
}
