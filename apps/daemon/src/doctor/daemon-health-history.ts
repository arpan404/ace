import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { RUN_MARKER_FILE, parseRunMarker } from "../run-marker.ts";
import { ShutdownReceipt } from "../shutdown-receipt.ts";
import { readLogTail } from "../triage-context.ts";

/** What `daemon-run.json` says about the newest run; `running` with a dead pid is a crash. */
export type LastRun =
  | { kind: "none" }
  | { kind: "unreadable" }
  | { kind: "running"; pid: number; startedAt: number }
  | {
      kind: "stopped";
      pid: number;
      startedAt: number;
      stoppedAt: number;
      source: string;
      signal?: string;
      overran?: string[];
    };

/** The newest daemon lifecycle records in the log tail. */
export type DaemonLogHistory = {
  lastStart?: { at: number; pid?: number; version?: string };
  lastStartFailure?: { at: number; error: string; refused: boolean };
  lastFatal?: { at: number; error: string };
};

export type DaemonHistory = {
  run: LastRun;
  receipt?: z.infer<typeof ShutdownReceipt>;
  log: DaemonLogHistory;
};

const LogRecord = z.object({
  at: z.number(),
  level: z.string(),
  message: z.string(),
  data: z.unknown().optional(),
});
const RecordData = z
  .object({
    pid: z.number().optional().catch(undefined),
    version: z.string().max(64).optional().catch(undefined),
    storedFormat: z.unknown().optional(),
    message: z.string().optional().catch(undefined),
    error: z.object({ message: z.string() }).loose().optional().catch(undefined),
  })
  .loose()
  .catch({});

const ERROR_TEXT_MAX = 400;

/** Reads the run file, the shutdown receipt and the log tail; a missing or bad file is a fact, never a throw. */
export async function readDaemonHistory(dataDir: string): Promise<DaemonHistory> {
  const [run, receipt, lines] = await Promise.all([
    readJson(join(dataDir, RUN_MARKER_FILE)).then(parseRun),
    readJson(join(dataDir, "daemon-shutdown.json")).then((json) => {
      if (json.kind !== "value") return undefined;
      const parsed = ShutdownReceipt.safeParse(json.value);
      return parsed.success ? parsed.data : undefined;
    }),
    readLogTail(join(dataDir, "logs", "ace.jsonl")).catch(() => []),
  ]);
  return { run, ...(receipt ? { receipt } : {}), log: daemonLogHistory(lines) };
}

type Json = { kind: "missing" } | { kind: "unreadable" } | { kind: "value"; value: unknown };

async function readJson(path: string): Promise<Json> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT"
      ? { kind: "missing" }
      : { kind: "unreadable" };
  }
  try {
    return { kind: "value", value: JSON.parse(text) };
  } catch {
    return { kind: "unreadable" };
  }
}

function parseRun(json: Json): LastRun {
  if (json.kind !== "value") return { kind: json.kind === "missing" ? "none" : "unreadable" };
  const value = parseRunMarker(json.value);
  if (!value) return { kind: "unreadable" };
  if (value.state === "running")
    return { kind: "running", pid: value.pid, startedAt: value.startedAt };
  return {
    kind: "stopped",
    pid: value.pid,
    startedAt: value.startedAt,
    stoppedAt: value.stoppedAt,
    source: value.source,
    ...(value.signal ? { signal: value.signal } : {}),
    ...(value.overran ? { overran: value.overran } : {}),
  };
}

/**
 * The newest start, failed start (including a refusal of newer data) and fatal error among
 * the daemon's log lines. Malformed lines are skipped.
 */
export function daemonLogHistory(lines: Iterable<string>): DaemonLogHistory {
  const history: DaemonLogHistory = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const record = LogRecord.safeParse(parsed);
    if (!record.success) continue;
    const { at, level, message } = record.data;
    const data = RecordData.parse(record.data.data ?? {});
    const error = shorten(data.error?.message ?? data.message ?? message);
    if (message === "Daemon listening") {
      if (at >= (history.lastStart?.at ?? -Infinity))
        history.lastStart = {
          at,
          ...(data.pid === undefined ? {} : { pid: data.pid }),
          ...(data.version ? { version: data.version } : {}),
        };
    } else if (message === "Daemon startup failed" || (level === "error" && data.storedFormat)) {
      if (at >= (history.lastStartFailure?.at ?? -Infinity))
        history.lastStartFailure = {
          at,
          // A refusal's own message says what to do; a failed start carries its error.
          error: message === "Daemon startup failed" ? error : shorten(message),
          refused: message !== "Daemon startup failed",
        };
    } else if (message === "Fatal error") {
      if (at >= (history.lastFatal?.at ?? -Infinity)) history.lastFatal = { at, error };
    }
  }
  return history;
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ERROR_TEXT_MAX ? `${flat.slice(0, ERROR_TEXT_MAX - 1)}…` : flat;
}
