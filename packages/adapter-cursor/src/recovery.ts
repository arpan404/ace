import type { LocalAgentStore } from "@cursor/sdk";
import type { SdkModule } from "./host-runtime.ts";
import type { OpenOptions } from "./contracts.ts";
import { z } from "zod";

const AgentIdentity = z.object({ agentId: z.string().min(1).max(512), cwd: z.string().max(4096) });
const RunIdentity = z.object({
  runId: z.string().min(1).max(512),
  agentId: z.string().min(1).max(512),
  status: z.enum(["queued", "running", "finished", "error", "cancelled", "expired"]),
});
const DurableEvent = z.object({
  runId: z.string().max(512),
  seq: z.number().int().positive(),
  offset: z.string().min(1).max(512),
  eventType: z.string().max(128),
  payload: z.unknown(),
});

/** Only local SDK store records establish native identity/status. No prompt is sent here. */
export async function recoverCursorCheckpoint(
  sdk: { Agent: Pick<SdkModule["Agent"], "cancelRun"> },
  store: LocalAgentStore,
  options: OpenOptions,
  emit: (kind: string, body: unknown, runId?: string, observeOffset?: string) => Promise<void>,
  afterObserve: (runId: string) => string | undefined = () => undefined,
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
  const agent = AgentIdentity.parse(await store.agents.get({ agentId }));
  if (agent.agentId !== agentId || agent.cwd !== options.cwd)
    throw new Error("SDK checkpoint belongs to another workspace/agent");
  let cursor: string | undefined;
  let count = 0;
  do {
    const page = await store.runs.list({
      filter: {
        agentIds: [agentId],
        limit: options.limits.historyPageSize,
        ...(cursor ? { cursor } : {}),
      },
    });
    for (const raw of page.items) {
      if (++count > options.limits.maxIdentities)
        throw new Error("SDK recovery run inventory exceeds budget");
      const run = RunIdentity.parse(raw);
      if (run.agentId !== agentId) throw new Error("SDK recovery run identity conflict");
      // This offset is read only from durable runEvents, never from Send callbacks.
      let afterOffset: string | undefined = afterObserve(run.runId);
      let events = 0;
      let lastSeq = 0;
      do {
        const history = await store.runEvents.list({
          runId: run.runId,
          limit: options.limits.historyPageSize,
          ...(afterOffset ? { afterOffset } : {}),
        });
        for (const value of history.items) {
          if (++events > options.limits.maxIdentities * 16)
            throw new Error("SDK durable event inventory exceeds budget");
          const event = DurableEvent.parse(value);
          if (event.runId !== run.runId) throw new Error("SDK observe run identity conflict");
          if (event.seq <= lastSeq || event.offset === afterOffset)
            throw new Error("SDK observe cursor did not advance");
          lastSeq = event.seq;
          // Retain durable provenance; callback journal is the sole canonical content owner.
          // SDK messages have no common stable ID with onDelta/history UUIDs.
          await emit(
            "observe",
            { eventType: event.eventType, eventSeq: event.seq, payload: event.payload },
            run.runId,
            event.offset,
          );
          afterOffset = event.offset;
        }
        if (!history.nextOffset) break;
        if (history.items.length === 0 || history.nextOffset !== afterOffset)
          throw new Error("SDK observe cursor did not advance");
      } while (afterOffset !== undefined);
      const interrupted = run.status === "running" || run.status === "queued";
      if (interrupted)
        await sdk.Agent.cancelRun(run.runId, { runtime: "local", store, cwd: options.cwd });
      await emit(
        "recovery",
        {
          nativeStatus: run.status,
          interrupted,
          outcome: interrupted ? "interrupted_by_daemon_restart" : run.status,
          fidelity: "callback-journal",
          text: interrupted
            ? "Daemon restart interrupted this SDK run. The last checkpoint is retained; delivery is not automatically retried. Inspect history before sending a new input."
            : "Native SDK run outcome reconciled; callbacks already committed to ace were not appended again.",
        },
        run.runId,
        afterOffset,
      );
    }
    if (page.nextCursor === cursor && page.nextCursor !== undefined)
      throw new Error("SDK recovery catalog cursor did not advance");
    cursor = page.nextCursor;
  } while (cursor);
  return agentId;
}
