import { cpus } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { probeOutput } from "@ace/provider-kit/process";
import { z } from "zod";
import type { Activity } from "./usage-schedule.ts";

const nonnegative = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/)])
  .transform(Number)
  .pipe(z.number().finite().nonnegative());
const windowsDisk = z.object({ DiskBytesPersec: nonnegative });
export type CpuTimes = { idle: number; total: number }[];
export function cpuActivity(before: CpuTimes, after: CpuTimes): number | null {
  if (!before.length || before.length !== after.length) return null;
  let total = 0,
    idle = 0;
  for (const [index, current] of after.entries()) {
    const previous = before[index];
    if (!previous || current.total < previous.total || current.idle < previous.idle) return null;
    total += current.total - previous.total;
    idle += current.idle - previous.idle;
  }
  return total > 0 && idle <= total ? 1 - idle / total : null;
}
/** The last iostat row is the interval sample; its first row is a boot average. */
export function macDiskActivity(output: string): number | null {
  const lines = output.trim().split(/\r?\n/);
  const header = lines.find((line) => line.includes("MB/s"));
  const rows = lines.filter((line) => /^\s*\d/.test(line));
  if (!header || rows.length < 2) return null;
  const columns = header.trim().split(/\s+/);
  if (
    columns.length % 3 !== 0 ||
    columns.some((value, index) => value !== ["KB/t", "tps", "MB/s"][index % 3])
  )
    return null;
  const values = z.array(nonnegative).safeParse(rows.at(-1)?.trim().split(/\s+/));
  if (!values.success || values.data.length !== columns.length) return null;
  return values.data.reduce(
    (sum, value, index) => sum + (index % 3 === 2 ? value * 1024 ** 2 : 0),
    0,
  );
}
/** Partitions and layered devices may be counted twice. This conservatively defers scans. */
export function linuxDiskBytes(output: string): number | null {
  let bytes = 0,
    count = 0;
  for (const line of output.trim().split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 14) return null;
    const values = z.array(nonnegative).safeParse(fields.slice(3));
    if (!values.success) return null;
    const read = values.data[2],
      written = values.data[6];
    if (read === undefined || written === undefined) return null;
    bytes += (read + written) * 512;
    count++;
  }
  return count && Number.isSafeInteger(bytes) ? bytes : null;
}
export function windowsDiskActivity(output: string): number | null {
  try {
    const value: unknown = JSON.parse(output);
    const parsed = windowsDisk.safeParse(value);
    return parsed.success ? parsed.data.DiskBytesPersec : null;
  } catch {
    return null;
  }
}
export type ActivityRuntime = {
  platform: string;
  now(): number;
  cpu(): CpuTimes;
  pause(signal: AbortSignal): Promise<void>;
  command(command: string, args: string[], signal: AbortSignal): Promise<string>;
};
const system: ActivityRuntime = {
  platform: process.platform,
  now: () => performance.now(),
  cpu: () =>
    cpus().map(({ times }) => ({
      idle: times.idle,
      total: Object.values(times).reduce((a, b) => a + b, 0),
    })),
  pause: async (signal) => {
    await pause(1000, undefined, { signal });
  },
  command: async (command, args, signal) => {
    const result = await probeOutput(command, args, {
      signal,
      timeoutMs: 5000,
      maxBytes: 256 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
    if (result.code !== 0) throw new Error("storage_activity_unavailable");
    return result.stdout;
  },
};
async function diskActivity(runtime: ActivityRuntime, signal: AbortSignal): Promise<number | null> {
  try {
    switch (runtime.platform) {
      case "darwin":
        return macDiskActivity(
          await runtime.command(
            "/usr/sbin/iostat",
            ["-d", "-n", "1024", "-w", "1", "-c", "2"],
            signal,
          ),
        );
      case "win32":
        return windowsDiskActivity(
          await runtime.command(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" | Select-Object DiskBytesPersec | ConvertTo-Json -Compress",
            ],
            signal,
          ),
        );
      case "linux": {
        const before = linuxDiskBytes(await runtime.command("cat", ["/proc/diskstats"], signal));
        const start = runtime.now();
        await runtime.pause(signal);
        const after = linuxDiskBytes(await runtime.command("cat", ["/proc/diskstats"], signal));
        const elapsed = runtime.now() - start;
        return before !== null && after !== null && after >= before && elapsed > 0
          ? ((after - before) * 1000) / elapsed
          : null;
      }
      default:
        return null;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
/** Called only when due. No periodic probes run while a snapshot is fresh. */
export async function sampleUsageActivity(
  signal: AbortSignal,
  runtime = system,
): Promise<Activity> {
  const before = runtime.cpu();
  const [disk] = await Promise.all([diskActivity(runtime, signal), runtime.pause(signal)]);
  return { cpu: cpuActivity(before, runtime.cpu()), disk };
}
