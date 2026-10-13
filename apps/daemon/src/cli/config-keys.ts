import { LogMaxBytes, RetentionDays, type SettingsEntry } from "@ace/protocol";
import { parseByteSize } from "@ace/diagnostics/log-policy";
import { CliFailure } from "./output.ts";

/** CLI names for host settings, the saved key behind each and its overriding variable. */
export const configKeys = {
  "retention-days": {
    key: "storage.retentionDays",
    env: "ACE_RETENTION_DAYS",
    parse: (raw: string) => RetentionDays.safeParse(/^\d+$/.test(raw) ? Number(raw) : NaN),
    format: (value: number) => `${value} days`,
    hint: "a whole number of days from 1 to 3650",
  },
  "log-cap": {
    key: "logs.maxBytes",
    env: "ACE_LOG_MAX_BYTES",
    parse: (raw: string) => LogMaxBytes.safeParse(parseByteSize(raw) ?? NaN),
    format: (value: number) => formatBytes(value),
    hint: "a size from 1m to 64g, such as 512m or 1g",
  },
} as const;
export type ConfigName = keyof typeof configKeys;
export const configNames: readonly ConfigName[] = ["retention-days", "log-cap"];

export function configName(raw: string | undefined): ConfigName {
  if (raw === "retention-days" || raw === "log-cap") return raw;
  throw new CliFailure("refused", "Use a setting name: retention-days or log-cap");
}
/** Validate before any effect; the daemon validates again with the same schema. */
export function configValue(name: ConfigName, raw: string | undefined): number {
  const parsed = raw === undefined ? undefined : configKeys[name].parse(raw);
  if (!parsed?.success) throw new CliFailure("refused", `${name} must be ${configKeys[name].hint}`);
  return parsed.data;
}
function formatBytes(bytes: number): string {
  for (const [unit, scale] of [
    ["GiB", 1024 ** 3],
    ["MiB", 1024 ** 2],
    ["KiB", 1024],
  ] as const)
    if (bytes >= scale && bytes % scale === 0) return `${bytes / scale} ${unit}`;
  return `${bytes} bytes`;
}

export interface ConfigReport {
  setting: ConfigName;
  key: string;
  /** The value the daemon enforces. */
  value: number;
  source: "default" | "saved" | "environment";
  /** Set when an environment variable overrides the saved value. */
  overriddenBy?: string;
  /** False when no daemon was reachable: the saved value applies when it next starts. */
  live: boolean;
}
export function configReport(name: ConfigName, entry: SettingsEntry, live: boolean): ConfigReport {
  const value = entry.value;
  if (typeof value !== "number") throw new CliFailure("uncertain", "The daemon returned no value");
  return {
    setting: name,
    key: configKeys[name].key,
    value,
    source:
      entry.provenance === "environment"
        ? "environment"
        : entry.provenance === "defaults"
          ? "default"
          : "saved",
    ...(entry.provenance === "environment" ? { overriddenBy: configKeys[name].env } : {}),
    live,
  };
}
export function describeConfig(report: ConfigReport, saved?: number): string {
  const format = (value: number) => configKeys[report.setting].format(value);
  const lines = [`${report.setting}: ${format(report.value)} (${report.source})`];
  if (report.overriddenBy)
    lines.push(
      `${report.overriddenBy} overrides the saved value${saved === undefined ? "" : ` (${format(saved)} saved)`}. Unset it to use the saved value.`,
    );
  if (!report.live) lines.push("The daemon is not running; it applies this when it starts.");
  return lines.join("\n");
}
