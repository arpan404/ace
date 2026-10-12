import { readFileSync } from "node:fs";
import koffi from "koffi";
export interface ProcessIdentity {
  pid: number;
  start: string;
  uid: number;
  group: number;
}
/** Kernel start identity prevents a recycled PID from becoming ace's authority. No argv/env reads. */
export function processIdentity(pid: number): ProcessIdentity | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      const uid = readFileSync(`/proc/${pid}/status`, "utf8").match(/^Uid:\s+(\d+)/m)?.[1];
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const start = fields[19];
      const group = Number(fields[2]);
      if (!start || !uid || !Number.isSafeInteger(group))
        throw new Error("Unverifiable process identity");
      const actualPid = Number(stat.slice(0, stat.indexOf(" ")));
      if (actualPid !== pid) throw new Error("Process identity mismatch");
      return { pid: actualPid, start: `${boot}:${start}`, uid: Number(uid), group };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }
  if (process.platform === "darwin") {
    // Apple's public proc_bsdinfo ABI: kernel start timeval, uid and process group.
    const library = koffi.load("/usr/lib/libproc.dylib");
    try {
      const info = library.func(
        "int proc_pidinfo(int pid, int flavor, uint64_t arg, _Out_ void *buffer, int size)",
      );
      const buffer = Buffer.alloc(136);
      if (info(pid, 3, 0, buffer, buffer.length) !== buffer.length) return undefined;
      return {
        pid: buffer.readUInt32LE(12),
        start: `${buffer.readBigUInt64LE(120)}:${buffer.readBigUInt64LE(128)}`,
        uid: buffer.readUInt32LE(20),
        group: buffer.readUInt32LE(100),
      };
    } finally {
      library.unload();
    }
  }
  throw new Error("Durable process identity requires Linux or macOS");
}
