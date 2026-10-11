import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
const UnifiedLog = z.object({
  eventMessage: z.string(),
  timestamp: z.string().optional(),
  processImagePath: z.string().optional(),
});

/** Render simctl's structured envelope as a readable log line. Android stays plain text. */
export function deviceLogLine(line: string): string {
  const clean = stripVTControlCharacters(line).slice(0, 65536);
  if (!clean.trimStart().startsWith("{")) return clean.slice(0, 4096);
  try {
    const entry = UnifiedLog.parse(JSON.parse(clean));
    const time = /\d{2}:\d{2}:\d{2}/.exec(entry.timestamp ?? "")?.[0];
    const process = entry.processImagePath?.split("/").at(-1);
    return [time, process, stripVTControlCharacters(entry.eventMessage)]
      .filter(Boolean)
      .join(" ")
      .slice(0, 4096);
  } catch {
    return "Couldn't read a device log entry.";
  }
}
