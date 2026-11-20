import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readSystemPressure } from "@ace/diagnostics/pressure-read";
import { readStallReport } from "@ace/diagnostics/stall";
import type { StallReading } from "./grace.ts";
import type { SupervisorPorts } from "./supervisor-config.ts";

/** Size and change time of a file, or "-" when there is none. */
async function fingerprint(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${info.size}@${Math.round(info.mtimeMs)}`;
  } catch {
    return "-";
  }
}

/**
 * The real machine's load, and the files a home's daemon writes as it starts and stalls
 * (`logs/ace.jsonl`, `startup-attempts.json`, `logs/stall-<pid>.json`), for the supervisor to
 * tell a starved or still-starting daemon from a hung one (ADR 0195).
 */
export function loadPorts(
  home: string,
  platform: NodeJS.Platform,
  now: () => number = Date.now,
): Pick<SupervisorPorts, "pressure" | "stall" | "startupProgress"> {
  const logs = join(home, "logs");
  return {
    pressure: () => readSystemPressure(platform),
    async stall(pid): Promise<StallReading | undefined> {
      const report = readStallReport(logs, pid);
      if (!report || report.ended || report.kind !== "main") return undefined;
      return {
        silentMs: report.silentMs,
        cpuMs: report.cpuMs,
        watchdogLateMs: report.watchdogLateMs,
        ageMs: Math.max(0, now() - (report.silentSince + report.silentMs)),
      };
    },
    async startupProgress(pid) {
      const marks = await Promise.all([
        fingerprint(join(logs, "ace.jsonl")),
        fingerprint(join(home, "startup-attempts.json")),
        fingerprint(join(logs, `stall-${pid}.json`)),
      ]);
      return marks.join(" ");
    },
  };
}
