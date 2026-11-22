import type { LocalAgentStore } from "@cursor/sdk";
import type { SdkModule } from "./host-runtime.ts";
import type { OpenOptions } from "./contracts.ts";
import { z } from "zod";
import { storedIdentity } from "./event-identity.ts";

const AgentIdentity = z.object({ agentId: z.string().min(1).max(512), cwd: z.string().max(4096) });
const AgentRuns = z.object({
  activeRunId: z.string().min(1).max(512).nullish(),
  updatedAt: z.number().finite().nonnegative().catch(Number.POSITIVE_INFINITY),
});
const RunStatus = z.enum(["queued", "running", "finished", "error", "cancelled", "expired"]);
const RunRecord = z.object({
  runId: z.string().min(1).max(512),
  agentId: z.string().min(1).max(512),
  status: RunStatus,
  result: z.string().max(1_048_576).nullish().catch(undefined),
  error: z.string().max(65536).nullish().catch(undefined),
  createdAt: z.number().finite().nonnegative().catch(0),
});
const DurableEvent = z.object({
  runId: z.string().max(512),
  seq: z.number().int().positive(),
  offset: z.string().min(1).max(512),
  payload: z.unknown(),
});
/** What the SDK stores per streamed message: `{ type: "sdk_message", message }` (1.0.35). */
const StreamEvent = z.object({ type: z.literal("sdk_message"), message: z.unknown() });

/** One thing recovery found, in the order the host publishes it after its open frame. */
export type Recovered =
  | { kind: "admission"; body: Record<string, unknown>; runId?: string }
  | { kind: "recovered"; body: unknown; runId: string }
  | { kind: "recovery"; body: Record<string, unknown>; runId: string };

type Recover = OpenOptions["recover"];
type Limits = OpenOptions["limits"];

/** How far a catalog search for an attempt's run may go before its answer is "unknown". */
const maxCatalogRuns = 100_000;

/**
 * The run an attempted send created, found from the agent record, not the run history: the SDK
 * creates a run by pointing the agent's `activeRunId` at it and stamping the agent's
 * `updatedAt` (1.0.35, both stores). So an agent untouched since the attempt has no run for it,
 * and a run still going is the active one. Only a run that both started and ended after the
 * attempt needs the catalog, which lists oldest first; the first run created after the attempt
 * is the one, and the search stops there. `undefined` means none; `"unknown"` means the store
 * could not say, and the send stays uncertain.
 */
async function attemptedRun(
  store: LocalAgentStore,
  agentId: string,
  agent: { activeRunId?: string | null | undefined; updatedAt: number },
  at: number,
  limits: Limits,
): Promise<z.infer<typeof RunRecord> | undefined | "unknown"> {
  if (agent.updatedAt < at) return undefined;
  if (agent.activeRunId) {
    const active = RunRecord.nullable().parse(
      await store.runs.get({ agentId, runId: agent.activeRunId }),
    );
    if (active && active.createdAt >= at) return active;
  }
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await store.runs.list({
      filter: { agentIds: [agentId], limit: limits.historyPageSize, ...(cursor ? { cursor } : {}) },
    });
    for (const raw of page.items) {
      if (++count > maxCatalogRuns) return "unknown";
      const run = RunRecord.parse(raw);
      if (run.agentId === agentId && run.createdAt >= at) return run;
    }
    if (page.nextCursor !== undefined && page.nextCursor === cursor) return "unknown";
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

/**
 * The run's stored messages ace's record lacks: those after the last event its frames cover,
 * less the one right after it when ace committed that event's update too (event-identity.ts).
 */
async function tail(
  store: LocalAgentStore,
  runId: string,
  { through, next }: { through: number; next?: string | undefined },
  limits: Limits,
  push: (message: unknown) => void,
): Promise<void> {
  let afterOffset: string | undefined;
  let events = 0;
  let lastSeq = 0;
  let seamChecked = next === undefined;
  for (;;) {
    const page = await store.runEvents.list({
      runId,
      limit: limits.historyPageSize,
      ...(afterOffset ? { afterOffset } : {}),
    });
    for (const value of page.items) {
      if (++events > limits.maxIdentities * 16)
        throw new Error("SDK durable event inventory exceeds budget");
      const event = DurableEvent.parse(value);
      if (event.runId !== runId) throw new Error("SDK run event identity conflict");
      if (event.seq <= lastSeq) throw new Error("SDK run event order did not advance");
      lastSeq = event.seq;
      afterOffset = event.offset;
      if (event.seq <= through) continue;
      const stored = StreamEvent.safeParse(event.payload);
      // Unknown event shapes are kept as raw data, never dropped.
      const message = stored.success ? stored.data.message : event.payload;
      if (!seamChecked) {
        seamChecked = true;
        if (storedIdentity(message) === next) continue;
      }
      push(message);
    }
    if (!page.nextOffset || page.items.length === 0) return;
    if (page.nextOffset !== afterOffset) throw new Error("SDK run event cursor did not advance");
  }
}

/**
 * Reads back, from the SDK's own store, what the daemon's record of the open turn lacks (ADR
 * 0043, amendment of 2026-11-22). Only the runs the daemon names, the agent's active run and,
 * after a crash mid-send, the run that send created are read: never the thread's run history.
 * No prompt is sent here.
 */
export async function recoverCursorCheckpoint(
  sdk: { Agent: Pick<SdkModule["Agent"], "cancelRun"> },
  store: LocalAgentStore,
  options: Omit<OpenOptions, "readOnly" | "recover"> & { readOnly?: boolean; recover?: Recover },
  push: (recovered: Recovered) => void,
): Promise<string | undefined> {
  let agentId = options.nativeSessionId;
  if (!agentId) {
    const roots = await store.agents.list({ filter: { cwd: options.cwd, limit: 2 } });
    if (roots.items.length === 0) {
      const agents = await store.agents.list({ filter: { limit: 1 } });
      const runs = await store.runs.list({ filter: { limit: 1 } });
      const checkpoints = await store.checkpoints.list({ filter: { limit: 1 } });
      if (agents.items.length || runs.items.length || checkpoints.items.length)
        throw new Error(
          "Unclaimed SDK checkpoint has orphaned or conflicting identity; use context handoff",
        );
      return undefined;
    }
    if (roots.items.length !== 1 || roots.nextCursor)
      throw new Error("Unclaimed SDK checkpoint identity is ambiguous");
    agentId = AgentIdentity.parse(roots.items[0]).agentId;
  }
  const document = await store.agents.get({ agentId });
  const agent = AgentIdentity.parse(document);
  if (agent.agentId !== agentId || agent.cwd !== options.cwd)
    throw new Error("SDK checkpoint belongs to another workspace/agent");
  const recover = options.recover ?? { runs: [] };
  const through = new Map<string, { through: number; next?: string | undefined }>(
    recover.runs.map((run) => [run.runId, { through: run.through, next: run.next }]),
  );
  // Unreadable, the agent counts as touched since any attempt: the catalog decides.
  const agentRuns = AgentRuns.catch({ updatedAt: Number.POSITIVE_INFINITY }).parse(document);
  const active = agentRuns.activeRunId;
  if (active && !through.has(active)) through.set(active, { through: 0 });
  const runs = new Map<string, z.infer<typeof RunRecord>>();
  if (recover.attempt && recover.runs.length === 0) {
    const attempt = recover.attempt;
    const found = await attemptedRun(store, agentId, agentRuns, attempt.at, options.limits);
    // Undetermined: nothing is published, so the daemon keeps the send uncertain.
    const run = found === "unknown" ? undefined : found;
    if (found !== "unknown")
      push({
        kind: "admission",
        body: {
          operationId: attempt.operationId,
          ...(attempt.commandId ? { commandId: attempt.commandId } : {}),
          segment: attempt.segment,
          admitted: run !== undefined,
          ...(run ? { nativeRunId: run.runId } : {}),
        },
        ...(run ? { runId: run.runId } : {}),
      });
    if (run) {
      runs.set(run.runId, run);
      if (!through.has(run.runId)) through.set(run.runId, { through: 0 });
    }
  }
  for (const [runId, seen] of through) {
    const run: z.infer<typeof RunRecord> | null =
      runs.get(runId) ?? RunRecord.nullable().parse(await store.runs.get({ agentId, runId }));
    if (!run) continue;
    if (run.agentId !== agentId) throw new Error("SDK recovery run identity conflict");
    const interrupted = run.status === "running" || run.status === "queued";
    // Stopped first, so the tail read after it is the whole of what the run will ever write.
    if (interrupted)
      await sdk.Agent.cancelRun(run.runId, { runtime: "local", store, cwd: options.cwd });
    await tail(store, run.runId, seen, options.limits, (message) =>
      push({ kind: "recovered", body: message, runId: run.runId }),
    );
    push({
      kind: "recovery",
      runId: run.runId,
      body: {
        nativeStatus: run.status,
        interrupted,
        outcome: interrupted ? "interrupted_by_daemon_restart" : run.status,
        ...(run.status === "finished" && run.result ? { result: run.result } : {}),
        ...(run.status === "error" && run.error ? { error: run.error } : {}),
      },
    });
  }
  return agentId;
}
