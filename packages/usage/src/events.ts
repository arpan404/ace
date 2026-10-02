import { z } from "zod";
import { UsageUpdated, type Event } from "@ace/protocol";
// Canonical ace identifiers and agent models have no length cap. Replay bounds bytes separately.
const id = z.string().min(1);
export const UsageEvent = z.object({
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  at: z.number().int().nonnegative().max(8.64e15),
  threadId: id,
  payload: z.discriminatedUnion("type", [
    z.object({ type: z.literal("thread.created"), workspace: z.string(), provider: id }),
    z.object({
      type: z.literal("agent.created"),
      id,
      parent: id.nullable(),
      model: z.string().nullable(),
      provider: id,
    }),
    z.object({
      type: z.literal("agent.updated"),
      id,
      parent: id.nullable().optional(),
      model: z.string().nullable().optional(),
      provider: id.optional(),
    }),
    z.object({ type: z.literal("run.started"), agent: id, run: id }),
    z.object({ type: z.literal("thread.deleted") }),
    z.object({ type: z.literal("usage.skipped") }),
    UsageUpdated.extend({ agentId: id, model: z.string().nullable().optional() }),
  ]),
});
export type UsageEvent = z.infer<typeof UsageEvent>;
const fits = (value: string) => Buffer.byteLength(value) <= 8192;
export function compactEvent(event: Event): UsageEvent | undefined {
  const omitted = (): UsageEvent => ({
    seq: event.seq,
    at: 0,
    threadId: "omitted",
    payload: { type: "usage.skipped" },
  });
  const model = (value: string | undefined) => (value !== undefined && fits(value) ? value : null);
  const parent = (value: string | null) => (value !== null && fits(value) ? value : null);
  const p = event.payload;
  let payload: UsageEvent["payload"];
  switch (p.type) {
    case "thread.created":
      payload = {
        type: p.type,
        workspace: fits(p.thread.workspaceId) ? p.thread.workspaceId : "",
        provider: p.thread.provider,
      };
      break;
    case "agent.created":
      if (!fits(p.agent.id)) return omitted();
      payload = {
        type: p.type,
        id: p.agent.id,
        parent: parent(p.agent.parentId),
        model: model(p.agent.model),
        provider: p.agent.native.provider,
      };
      break;
    case "agent.updated":
      if (!fits(p.agentId)) return omitted();
      payload = {
        type: p.type,
        id: p.agentId,
        ...(p.parentId === undefined ? {} : { parent: parent(p.parentId) }),
        ...(p.model === undefined ? {} : { model: model(p.model) }),
        ...(p.native === undefined ? {} : { provider: p.native.provider }),
      };
      break;
    case "run.started":
      if (!fits(p.run.agentId)) return omitted();
      payload = {
        type: p.type,
        agent: p.run.agentId,
        run: fits(p.run.id) ? p.run.id : `omitted-run:${event.seq}`,
      };
      break;
    case "usage.updated":
      if (!fits(p.agentId)) return omitted();
      payload = { ...p, ...(p.model === undefined ? {} : { model: model(p.model) }) };
      break;
    default:
      return undefined;
  }
  if (!fits(event.threadId)) return omitted();
  const parsed = UsageEvent.safeParse({
    seq: event.seq,
    at: event.at,
    threadId: event.threadId,
    payload,
  });
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 64 * 1024)
    return omitted();
  return parsed.data;
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
