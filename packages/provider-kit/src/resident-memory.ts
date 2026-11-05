import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type koffiModule from "koffi";

/** A process's resident memory in bytes, or undefined once it is gone or can't be read. */
export type ResidentSampler = (pid: number) => Promise<number | undefined>;

/**
 * Reads another process's resident set size, the memory it holds in RAM. Each read is a single
 * system call (Linux: one small procfs file), cheap enough to poll several times a second.
 * macOS's physical footprint would leave out Bun's JavaScript heap, so this is RSS everywhere.
 */
export function residentSampler(platform: NodeJS.Platform = process.platform): ResidentSampler {
  if (platform === "linux") return linuxResident;
  if (platform === "darwin") return darwinResident();
  if (platform === "win32") return windowsResident();
  return async () => undefined;
}

async function linuxResident(pid: number): Promise<number | undefined> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const kib = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1];
    return kib === undefined ? undefined : Number(kib) * 1024;
  } catch {
    return undefined;
  }
}

// Required lazily, as in process-owner: bundles without native packages never load koffi.
const loadKoffi = (): typeof koffiModule => createRequire(import.meta.url)("koffi");

function darwinResident(): ResidentSampler {
  let read: ((pid: number, flavor: number, buffer: Buffer) => number) | undefined;
  // rusage_info_v2 is 160 bytes; ri_resident_size is the uint64 at offset 64.
  const buffer = Buffer.alloc(256);
  return async (pid) => {
    read ??= loadKoffi()
      .load("/usr/lib/libproc.dylib")
      .func("int proc_pid_rusage(int pid, int flavor, _Out_ uint8_t *buffer)");
    if (read(pid, 2, buffer) !== 0) return undefined;
    return Number(buffer.readBigUInt64LE(64));
  };
}

function windowsResident(): ResidentSampler {
  let api:
    | {
        open: (access: number, inherit: boolean, pid: number) => unknown;
        memory: (process: unknown, counters: Buffer, size: number) => boolean;
        close: (handle: unknown) => boolean;
      }
    | undefined;
  // PROCESS_MEMORY_COUNTERS on 64-bit Windows: 72 bytes, WorkingSetSize at offset 16.
  const counters = Buffer.alloc(72);
  return async (pid) => {
    if (!api) {
      const kernel = loadKoffi().load("kernel32.dll");
      api = {
        open: kernel.func("void* __stdcall OpenProcess(uint access, bool inherit, uint pid)"),
        memory: kernel.func(
          "bool __stdcall K32GetProcessMemoryInfo(void* process, _Out_ uint8_t* counters, uint size)",
        ),
        close: kernel.func("bool __stdcall CloseHandle(void* handle)"),
      };
    }
    // PROCESS_QUERY_LIMITED_INFORMATION is enough for memory counters.
    const handle = api.open(0x1000, false, pid);
    if (!handle) return undefined;
    try {
      counters.writeUInt32LE(counters.length, 0);
      if (!api.memory(handle, counters, counters.length)) return undefined;
      return Number(counters.readBigUInt64LE(16));
    } finally {
      api.close(handle);
    }
  };
}
