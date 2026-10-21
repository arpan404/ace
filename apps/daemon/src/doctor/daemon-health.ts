import type { Check } from "@ace/diagnostics";
import { DiagnosticsHealth } from "@ace/protocol";
import type { DoctorContext, DoctorFeature } from "./feature.ts";
import { readDaemonHistory } from "./daemon-health-history.ts";
import {
  loggingVerdict,
  memoryVerdict,
  queuesVerdict,
  responsivenessVerdict,
} from "./daemon-health-metrics.ts";
import { daemonStateVerdict, type DaemonAnswer, type Verdict } from "./daemon-health-state.ts";

/** What the app's Settings › Daemon health card waits for. */
const HEALTH_TIMEOUT_MS = 10_000;
/** Connecting (up to 10 s) plus the health request (up to 10 s), with room to spare. */
const CHECK_TIMEOUT_MS = 25_000;
/** Client error codes (read by value, so the client loads only when used) meaning no answer. */
const SILENT_CODES = new Set(["timeout", "offline"]);

/**
 * Whether ace's daemon runs and answers, and how it last stopped when it doesn't. While it
 * answers, the Settings › Daemon health numbers become checks too. Every check shares one
 * health request.
 */
export const daemonHealth: DoctorFeature = {
  id: "daemon",
  checks(context) {
    let pending: Promise<DaemonAnswer> | undefined;
    const answer = () => (pending ??= askDaemon(context));
    const metric = (id: string, verdict: (health?: DiagnosticsHealth) => Verdict): Check => ({
      id: `daemon.${id}`,
      fix: "Run ace triage to have an agent investigate.",
      timeoutMs: CHECK_TIMEOUT_MS,
      async run() {
        const reply = await answer();
        return verdict(reply.kind === "health" ? reply.health : undefined);
      },
    });
    const state: Check = {
      id: "daemon.state",
      fix: "Open ace to start it.",
      timeoutMs: CHECK_TIMEOUT_MS,
      async run() {
        const [reply, history] = await Promise.all([
          context.daemonState === "running" ? answer() : undefined,
          readDaemonHistory(context.config.dataDir),
        ]);
        return daemonStateVerdict({
          state: context.daemonState,
          ...(reply ? { answer: reply } : {}),
          history,
          now: context.now(),
          platform: context.platform,
        });
      },
    };
    // A stopped daemon has no numbers; the state check says why and how it stopped.
    if (context.daemonState !== "running") return [state];
    return [
      state,
      metric("responsiveness", responsivenessVerdict),
      metric("memory", memoryVerdict),
      metric("queues", queuesVerdict),
      metric("logging", loggingVerdict),
    ];
  },
};

async function askDaemon(context: DoctorContext): Promise<DaemonAnswer> {
  const reply = await context.daemon(async (client, signal): Promise<DaemonAnswer> => {
    try {
      const result = await client.command(
        { type: "diagnostics.health" },
        { timeoutMs: HEALTH_TIMEOUT_MS, signal },
      );
      if (!result.ok || !result.health)
        return { kind: "error", message: (result.error ?? "no health report").slice(0, 300) };
      const health = DiagnosticsHealth.safeParse(result.health);
      return health.success
        ? { kind: "health", health: health.data }
        : { kind: "error", message: "the health report didn't match this build" };
    } catch (error) {
      // Connected, then no answer in time: as stuck as one that never connected.
      if (error instanceof Error && "code" in error && SILENT_CODES.has(String(error.code)))
        return { kind: "silent" };
      return {
        kind: "error",
        message: error instanceof Error ? error.message.slice(0, 300) : "the request failed",
      };
    }
  });
  return reply ?? { kind: "silent" };
}
