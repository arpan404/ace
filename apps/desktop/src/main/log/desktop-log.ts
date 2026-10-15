import type { FileLog } from "./file-log.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogData = Record<string, unknown>;
/** One structured log record: what happened, and the facts behind it. */
export type Log = (level: LogLevel, message: string, data?: LogData) => void;

const MAX_MESSAGE = 4_096;
const MAX_DATA = 8_192;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

const bigints = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

/** The record's data as it is written: redacted, then the fields or a clipped text of them. */
function fields(
  data: LogData | undefined,
  redact: (text: string) => string,
): { value: unknown; text: string } | undefined {
  if (data === undefined) return undefined;
  let text: string;
  try {
    // Redacted as one serialized text, before clipping, so a cut never leaves half a secret.
    text = redact(JSON.stringify(data, bigints));
  } catch {
    return { value: { unserializable: true }, text: '{"unserializable":true}' };
  }
  if (text.length > MAX_DATA) return { value: clip(text, MAX_DATA), text };
  try {
    return { value: JSON.parse(text) as unknown, text };
  } catch {
    return { value: text, text };
  }
}

export interface DesktopLogOptions {
  /** The persisted sink; without one, records only reach the console. */
  file?: FileLog | undefined;
  now(): number;
  console(level: LogLevel, text: string): void;
  /**
   * The daemon's diagnostic redactor (`@ace/redaction/diagnostic`). Every message and field
   * passes through it before anything reaches the console or is queued for the file.
   */
  redact(text: string): string;
}

/**
 * The desktop main process's log: each record goes to the console (development, a terminal
 * launch) and, as one JSON line, to the persisted file, so a Finder-launched app keeps them.
 * The daemon child's output arrives here too, so it gets the same redaction as `ace.jsonl`.
 * Returns a logger per component (`desktop`, `supervisor`, `daemon` …).
 */
export function createDesktopLog(options: DesktopLogOptions): (component: string) => Log {
  return (component) => (level, message, data) => {
    const text = clip(options.redact(message), MAX_MESSAGE);
    const extra = fields(data, options.redact);
    try {
      options.console(
        level,
        `[${level}] ${component}: ${text}${extra ? ` ${clip(extra.text, MAX_DATA)}` : ""}`,
      );
    } catch {
      // A closed stdout (EPIPE) must not take the app down.
    }
    if (!options.file) return;
    const record = { at: options.now(), level, component, message: text };
    try {
      options.file.append(
        JSON.stringify(extra ? { ...record, data: extra.value } : record, bigints),
      );
    } catch {
      options.file.append(JSON.stringify(record));
    }
  };
}
