import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { createRedactor } from "@ace/redaction";

export interface Failure {
  code: string;
  message: string;
  step: string;
  screenshot: string;
}
export interface Step {
  name: string;
  durationMs: number;
  screenshot: string;
}
export interface Report {
  activeStep?: { name: string; screenshot: string };
  mode: "real" | "fixture";
  sha: string;
  failures: Failure[];
  steps: Step[];
  timings: Record<string, number>;
  copied: string[];
  threadsVisited: number;
  daemonRssMiB?: number;
  completed: boolean;
}
export function scrubber(token = "") {
  const redact = createRedactor({});
  return (text: string) =>
    redact(token ? text.replaceAll(token, "[REDACTED]") : text)
      .replace(/\b[0-9a-f]{64}\b/gi, "[REDACTED]")
      .replace(/([?&#]token=)[^\s&#]+/gi, "$1[REDACTED]");
}
async function artifact(path: string, text: string) {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(text);
  } finally {
    await file.close();
  }
}
export async function writeReport(out: string, report: Report, scrub: (text: string) => string) {
  await artifact(join(out, "report.json"), scrub(JSON.stringify(report, null, 2)) + "\n");
  const groups = new Map<string, Failure[]>();
  for (const failure of report.failures) {
    const key = `${failure.code}: ${failure.message.split("\n")[0] ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(failure);
    groups.set(key, group);
  }
  const summary = [
    `# ace ${report.mode} smoke`,
    "",
    `Commit: ${report.sha}`,
    `Result: ${report.completed && !report.failures.length ? "PASS" : "FAIL"}`,
    `Steps: ${report.steps.length}; threads: ${report.threadsVisited}; failures: ${report.failures.length}`,
    ...(report.daemonRssMiB === undefined
      ? []
      : [`Daemon idle RSS: ${report.daemonRssMiB.toFixed(1)} MiB / 256 MiB`]),
    "",
    "## Timings",
    "",
    ...Object.entries(report.timings)
      .filter(([name]) => !name.startsWith("thread-"))
      .map(([name, ms]) => `- ${name}: ${Math.round(ms)} ms`),
    "",
    "## Failures",
    "",
    ...[...groups].map(([message, group]) => {
      const paths = [...new Set(group.map((failure) => failure.screenshot).filter(Boolean))];
      const links = paths
        .slice(0, 3)
        .map((path) => `[Screenshot](${path})`)
        .join(", ");
      return `- ${message} (${group.length} occurrence${group.length === 1 ? "" : "s"}). ${links}${paths.length > 3 ? `; ${paths.length - 3} more in report.json` : ""}`;
    }),
    ...(!report.failures.length ? ["None."] : []),
    "",
    "Screenshots contain private conversation data. Keep this directory local.",
    "",
  ].join("\n");
  await artifact(join(out, "summary.md"), scrub(summary));
  return summary;
}
