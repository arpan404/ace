import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { StopReason } from "./stop-reason.ts";

/**
 * `ACE_HOME/daemon-run.json` says how the last daemon run ended. A run writes `running` once
 * it holds the lock and `stopped` as the last step of an orderly shutdown, so the next start
 * can tell an expected restart (an app quit, an update, `ace stop`) from a crash, SIGKILL or
 * power loss, which leave `running` behind.
 */
export const RUN_MARKER_FILE = "daemon-run.json";

const Running = z.object({
  state: z.literal("running"),
  pid: z.number().int(),
  startedAt: z.number(),
});
const Stopped = z.object({
  state: z.literal("stopped"),
  pid: z.number().int(),
  startedAt: z.number(),
  stoppedAt: z.number(),
  source: z.string(),
  signal: z.string().optional(),
  /** Resources still closing when the shutdown deadline hit; absent for a complete stop. */
  overran: z.array(z.string()).optional(),
});
const Marker = z.discriminatedUnion("state", [Running, Stopped]);

export type PreviousRun =
  | { kind: "none" }
  | {
      kind: "stopped";
      pid: number;
      stoppedAt: number;
      source: string;
      signal?: string;
      overran?: string[];
    }
  | { kind: "crashed"; pid: number; startedAt: number }
  | { kind: "unreadable" };

function readMarker(home: string): PreviousRun {
  let text: string;
  try {
    text = readFileSync(join(home, RUN_MARKER_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "none" };
    return { kind: "unreadable" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "unreadable" };
  }
  const marker = Marker.safeParse(parsed);
  if (!marker.success) return { kind: "unreadable" };
  const value = marker.data;
  if (value.state === "running")
    return { kind: "crashed", pid: value.pid, startedAt: value.startedAt };
  return {
    kind: "stopped",
    pid: value.pid,
    stoppedAt: value.stoppedAt,
    source: value.source,
    ...(value.signal ? { signal: value.signal } : {}),
    ...(value.overran ? { overran: value.overran } : {}),
  };
}

function writeMarker(home: string, marker: z.infer<typeof Marker>): void {
  const path = join(home, RUN_MARKER_FILE);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export interface DaemonRun {
  /** How the run before this one ended. */
  readonly previous: PreviousRun;
  /**
   * Record an orderly stop. Call it last, while still holding the daemon lock. `overran`
   * names what was still closing when the shutdown deadline hit.
   */
  stopped(reason: StopReason, overran?: readonly string[]): void;
}

/** Call while holding the daemon lock: reads the last run's ending, then marks this one live. */
export function beginRun(home: string, pid: number, now: () => number): DaemonRun {
  const previous = readMarker(home);
  const startedAt = now();
  writeMarker(home, { state: "running", pid, startedAt });
  return {
    previous,
    stopped(reason, overran) {
      writeMarker(home, {
        state: "stopped",
        pid,
        startedAt,
        stoppedAt: now(),
        source: reason.source,
        ...(reason.signal ? { signal: reason.signal } : {}),
        ...(overran ? { overran: [...overran] } : {}),
      });
    },
  };
}

/** The startup log line naming how the previous run ended. */
export function previousRunRecord(previous: PreviousRun): {
  level: "info" | "warn";
  message: string;
  fields: [string, string | number][];
} {
  switch (previous.kind) {
    case "none":
      return { level: "info", message: "No previous daemon run recorded", fields: [] };
    case "stopped":
      return {
        level: previous.overran ? "warn" : "info",
        message: previous.overran
          ? "Previous daemon run stopped after its shutdown deadline; some resources had not closed"
          : "Previous daemon run stopped in order",
        fields: [
          ["previousPid", previous.pid],
          ["previousSource", previous.source],
          ...(previous.signal ? [["previousSignal", previous.signal] as [string, string]] : []),
          ["previousStoppedAt", new Date(previous.stoppedAt).toISOString()],
          ...(previous.overran
            ? [["previousPending", previous.overran.join(", ").slice(0, 1000)] as [string, string]]
            : []),
        ],
      };
    case "crashed":
      return {
        level: "warn",
        message: "Previous daemon run ended without stopping: it crashed or was killed",
        fields: [
          ["previousPid", previous.pid],
          ["previousStartedAt", new Date(previous.startedAt).toISOString()],
        ],
      };
    case "unreadable":
      return {
        level: "warn",
        message: "Previous daemon run marker is unreadable; its ending is unknown",
        fields: [],
      };
  }
}
