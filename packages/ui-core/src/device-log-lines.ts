/*
 * The drawer's log lines: their level, for colour, and the filter. Device logs come from
 * `log stream` on iOS and `logcat` on Android, so a level shows either as a word ("Error",
 * "<Fault>", "warning:") or as logcat's single letter column ("W/Tag", " E Tag:").
 */

export type LogLevel = "error" | "warning" | "info";

const errorWord = /\b(error|fault|fatal|exception|crash(ed)?)\b/i;
const warningWord = /\bwarn(ing)?\b/i;
const logcatLevel = /(?:^|\s)([VDIWEFA])(?:\/[\w.$-]+|\s+[\w.$-]+\s*:)/;

/** The level a device log line reports. */
export function logLevel(line: string): LogLevel {
  const letter = logcatLevel.exec(line)?.[1];
  if (letter === "E" || letter === "F" || letter === "A") return "error";
  if (letter === "W") return "warning";
  if (letter) return "info";
  if (errorWord.test(line)) return "error";
  if (warningWord.test(line)) return "warning";
  return "info";
}

/** The lines that contain the filter text, ignoring case; every line for an empty filter. */
export function filterLines(lines: readonly string[], filter: string): readonly string[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return lines;
  return lines.filter((line) => line.toLowerCase().includes(needle));
}
