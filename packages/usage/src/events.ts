import { z } from "zod";
import { UsageUpdated, type Event } from "@ace/protocol";
const id = z.string().min(1).max(512);
export const UsageEvent = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.number().int().nonnegative().max(8.64e15),
  threadId: id,
  payload: z.discriminatedUnion("type", [
    z.object({ type: z.literal("thread.created"), workspace: id, provider: id }),
    z.object({
      type: z.literal("agent.created"),
      id,
      parent: id.nullable(),
      model: id.nullable(),
      provider: id,
    }),
    z.object({
      type: z.literal("agent.updated"),
      id,
      parent: id.nullable().optional(),
      model: id.optional(),
      provider: id.optional(),
    }),
    z.object({ type: z.literal("run.started"), agent: id, run: id }),
    UsageUpdated.extend({ agentId: id }),
  ]),
});
export type UsageEvent = z.infer<typeof UsageEvent>;
export function compactEvent(event: Event): UsageEvent | undefined {
  const p = event.payload;
  let payload: UsageEvent["payload"];
  switch (p.type) {
    case "thread.created":
      payload = { type: p.type, workspace: p.thread.workspaceId, provider: p.thread.provider };
      break;
    case "agent.created":
      payload = {
        type: p.type,
        id: p.agent.id,
        parent: p.agent.parentId,
        model: p.agent.model ?? null,
        provider: p.agent.native.provider,
      };
      break;
    case "agent.updated":
      payload = {
        type: p.type,
        id: p.agentId,
        ...(p.parentId === undefined ? {} : { parent: p.parentId }),
        ...(p.model === undefined ? {} : { model: p.model }),
        ...(p.native === undefined ? {} : { provider: p.native.provider }),
      };
      break;
    case "run.started":
      payload = { type: p.type, agent: p.run.agentId, run: p.run.id };
      break;
    case "usage.updated":
      payload = p;
      break;
    default:
      return undefined;
  }
  return UsageEvent.parse({ seq: event.seq, at: event.at, threadId: event.threadId, payload });
}
export const UsageBatch = z
  .object({
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    events: z.array(UsageEvent).max(256),
  })
  .refine((b) => {
    let previous = b.afterSeq;
    for (const e of b.events) {
      if (e.seq <= previous || e.seq > b.throughSeq) return false;
      previous = e.seq;
    }
    return b.throughSeq >= previous;
  });
export type UsageBatch = z.infer<typeof UsageBatch>;
