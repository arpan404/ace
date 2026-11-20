import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { memoryLevelOf, parsePsi, type Psi, type SystemPressure } from "./pressure.ts";

async function psi(resource: "cpu" | "memory" | "io"): Promise<Psi | undefined> {
  try {
    return parsePsi(await readFile(`/proc/pressure/${resource}`, "utf8"));
  } catch {
    // Kernels without PSI (or with it off) leave load average to say it.
    return undefined;
  }
}

function sysctl(name: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/sysctl", ["-n", name], { timeout: 1_000 }, (error, stdout) =>
      resolve(error ? undefined : stdout),
    );
  });
}

/**
 * Reads how loaded the machine is now: load average everywhere it exists, PSI on Linux, the
 * memory pressure level on macOS (one `sysctl`), free memory on Windows. Never throws; read only
 * when a decision needs it (a missed health check, a start), never on a timer.
 */
export async function readSystemPressure(
  platform: NodeJS.Platform = process.platform,
): Promise<SystemPressure> {
  const base: SystemPressure = {
    cpus: availableParallelism(),
    load1: Math.round((loadavg()[0] ?? 0) * 10) / 10,
  };
  if (platform === "linux") {
    const [cpu, memory, io] = await Promise.all([psi("cpu"), psi("memory"), psi("io")]);
    return { ...base, cpu, memory, io };
  }
  if (platform === "darwin") {
    const level = await sysctl("kern.memorystatus_vm_pressure_level");
    return { ...base, memoryLevel: level === undefined ? undefined : memoryLevelOf(level) };
  }
  if (platform === "win32") return { ...base, freeMemory: freemem() / Math.max(1, totalmem()) };
  return base;
}
