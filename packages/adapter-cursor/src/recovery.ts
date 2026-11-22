import type { LocalAgentStore } from "@cursor/sdk";
import type { SdkModule } from "./host-runtime.ts";
import type { OpenOptions } from "./contracts.ts";
import { z } from "zod";

const AgentIdentity = z.object({ agentId: z.string().min(1).max(512), cwd: z.string().max(4096) });
const AgentRuns = z.object({ activeRunId: z.string().min(1).max(512).nullish() });
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

/** The run an attempted send created, if the SDK has one created at or after the attempt. */
async function attemptedRun(
  store: LocalAgentStore,
  agentId: string,
  at: number,
  limits: Limits,
): Promise<z.infer<typeof RunRecord> | undefined> {
  // Rare: only a crash between framing the attempt and framing its admission reaches here.
  let cursor: string | undefined;
  let found: z.infer<typeof RunRecord> | undefined;
  let count = 0;
  do {
    const page = await store.runs.list({
      filter: { agentIds: [agentId], limit: limits.historyPageSize, ...(cursor ? { cursor } : {}) },
    });
    for (const raw of page.items) {
      if (++count > limits.maxIdentities)
        throw new Error("SDK recovery run inventory exceeds budget");
      const run = RunRecord.parse(raw);
      if (
        run.agentId === agentId &&
        run.createdAt >= at &&
        (!found || run.createdAt < found.createdAt)
      )
        found = run;
    }
    if (page.nextCursor !== undefined && page.nextCursor === cursor)
      throw new Error("SDK recovery catalog cursor did not advance");
    cursor = page.nextCursor;
  } while (cursor);
  return found;
}

/** The run's stored messages after the daemon's last committed `streamSeq`. */
async function tail(
  store: LocalAgentStore,
  runId: string,
  through: number,
  limits: Limits,
  push: (message: unknown) => void,
): Promise<void> {
  let afterOffset: string | undefined;
  let events = 0;
  let lastSeq = 0;
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
      push(stored.success ? stored.data.message : event.payload);
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
  const through = new Map(recover.runs.map((run) => [run.runId, run.through]));
  const active = AgentRuns.catch({}).parse(document).activeRunId;
  if (active && !through.has(active)) through.set(active, 0);
  const runs = new Map<string, z.infer<typeof RunRecord>>();
  if (recover.attempt && recover.runs.length === 0) {
    const attempt = recover.attempt;
    const run = await attemptedRun(store, agentId, attempt.at, options.limits);
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
      if (!through.has(run.runId)) through.set(run.runId, 0);
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
