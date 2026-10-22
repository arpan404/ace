import { join } from "node:path";
import { digestLogLines } from "@ace/diagnostics/triage";
import { readLogTail } from "../triage-context.ts";
import type { DoctorFeature } from "./feature.ts";

/** One check summarizing the last day of the daemon log, grouped like triage's facts. */
export const recentErrors: DoctorFeature = {
  id: "logs",
  checks: (context) => [
    {
      id: "logs.recent",
      fix: "Run ace triage to have an agent investigate, or read them with ace logs --limit 200.",
      async run() {
        const lines = await readLogTail(join(context.config.dataDir, "logs", "ace.jsonl"));
        const digest = digestLogLines(lines, { now: context.now(), limit: 100 });
        const total = (level: "error" | "warn") =>
          digest.reduce((sum, entry) => sum + (entry.level === level ? entry.count : 0), 0);
        const errors = total("error");
        const warnings = total("warn");
        const top = digest[0];
        return {
          status: errors ? "warn" : "ok",
          message:
            errors || warnings
              ? `${errors} ${errors === 1 ? "error" : "errors"} and ${warnings} ${warnings === 1 ? "warning" : "warnings"} in the last 24 hours` +
                (top
                  ? `. Most frequent ${top.level === "error" ? "error" : "warning"}: ${top.count}× ${top.component}: ${top.message}`
                  : "")
              : "No warnings or errors in the last 24 hours",
          fix: "Run ace triage to have an agent investigate, or read them with ace logs --limit 200.",
        };
      },
    },
  ],
};
