import type { CliConfigEntry } from "@ace/protocol/cli-outputs";
import type { SettingsKey } from "@ace/protocol";
import { formatConfigValue, resolveConfigKey } from "../config-keys.ts";

/** Words for `ace config` (ADR 0178 §3). Pure: entries → lines. */

const sourceWords: Readonly<Record<CliConfigEntry["source"], string>> = {
  default: "",
  saved: "",
  environment: " (from the environment)",
};

function keyOf(entry: CliConfigEntry): SettingsKey {
  return resolveConfigKey(entry.setting).key;
}

/** Every setting, one per line: key, value, and a mark for what isn't the default. */
export function configListLines(entries: readonly CliConfigEntry[]): string[] {
  const width = Math.min(36, Math.max(0, ...entries.map((entry) => entry.setting.length)));
  const lines = entries.map((entry) => {
    const value = formatConfigValue(keyOf(entry), entry.value);
    const mark = entry.source === "default" ? "" : entry.source === "saved" ? "  (set)" : "  (env)";
    return `${entry.setting.padEnd(width)}  ${value}${mark}`.trimEnd();
  });
  if (entries.length && !entries.some((entry) => entry.live)) lines.push("", notRunning);
  lines.push("", "See one with ace config get KEY; change it with ace config set KEY VALUE.");
  return lines;
}

const notRunning = "The daemon is not running; it applies saved values when it starts.";

/** One setting: its value, what it is, what it takes, and where the value came from. */
export function configEntryLines(entry: CliConfigEntry, saved?: unknown): string[] {
  const key = resolveConfigKey(entry.setting);
  const format = (value: unknown) => formatConfigValue(key.key, value);
  const name = entry.setting === entry.key ? entry.key : `${entry.setting} (${entry.key})`;
  const lines = [
    `${name}: ${format(entry.value)}${entry.source === "default" ? " (default)" : sourceWords[entry.source]}`,
    `${key.summary}. Takes ${key.takes}.`,
  ];
  if (entry.overriddenBy)
    lines.push(
      `${entry.overriddenBy} overrides the saved value${saved === undefined ? "" : ` (${format(saved)} saved)`}. Unset it to use the saved value.`,
    );
  if (!entry.live) lines.push(notRunning);
  return lines;
}

/** After `set` or `unset`: what it is now. */
export function configChangedLines(entry: CliConfigEntry, saved: unknown): string[] {
  const key = resolveConfigKey(entry.setting);
  const lines = [`${entry.setting} is ${formatConfigValue(key.key, entry.value)}.`];
  if (entry.overriddenBy)
    lines.push(
      `${entry.overriddenBy} overrides it (${formatConfigValue(key.key, saved)} saved). Unset it to use the saved value.`,
    );
  if (!entry.live) lines.push(notRunning);
  return lines;
}
