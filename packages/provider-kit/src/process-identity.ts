import { readFileSync } from "node:fs";
import koffi from "koffi";
import { z } from "zod";

export const ProcessIdentity = z.strictObject({
  pid: z.number().int().positive(),
  start: z.string().min(1).max(128),
  uid: z.number().int().nonnegative(),
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
    throw new Error("Kernel process identity requires Linux or macOS");
  } catch (error) {
    // Native/procfs failure is not absence unless the kernel also proves the PID is gone.
    if (gone(pid)) return undefined;
    throw error;
  }
}
