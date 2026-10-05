import { z } from "zod";
import {
  AgentId,
  BackgroundTaskId,
  InteractionId,
  ThreadId,
  Timestamp,
  EventSequence,
} from "@ace/protocol/ids";
import { AgentStatus } from "@ace/protocol/agent-status";
import { BackgroundTask } from "@ace/protocol/background";
import { ThreadStatus } from "@ace/protocol/thread-status";
import type { Event } from "@ace/protocol";
import { InteractionLink, interactionLink } from "./model.ts";

const idBound = z.string().max(200);
export const OwnerState = z
  .object({ state: z.enum(AgentStatus.options.map((option) => option.shape.state.value)) })
  .strict();
const interaction = z
  .object({
    id: InteractionId.and(idBound),
    agentId: AgentId.and(idBound),
    blocking: z.boolean(),
    state: z.literal("pending"),
    actions: InteractionLink.shape.actions,
  })
  .strict();
const Payload = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("thread.created"),
      thread: z
        .object({
          title: z.string().max(200),
          status: ThreadStatus,
          archivedAt: Timestamp.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("thread.updated"),
      title: z.string().max(200).optional(),
      status: ThreadStatus.optional(),
      archivedAt: Timestamp.nullable().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("agent.created"),
      agent: z.object({ id: AgentId.and(idBound), status: OwnerState }).strict(),
    })
    .strict(),
  z
    .object({ type: z.literal("agent.status"), agentId: AgentId.and(idBound), status: OwnerState })
    .strict(),
  z.object({ type: z.literal("interaction.opened"), interaction }).strict(),
  z
    .object({ type: z.literal("interaction.closed"), interactionId: InteractionId.and(idBound) })
    .strict(),
  z
    .object({
      type: z.literal("background_task.started"),
      task: z
        .object({
          id: BackgroundTaskId.and(idBound),
          status: BackgroundTask.shape.status,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("background_task.updated"),
      taskId: BackgroundTaskId.and(idBound),
      status: BackgroundTask.shape.status,
    })
    .strict(),
]);
export const MetadataEvent = z
  .object({
    seq: EventSequence,
    at: Timestamp,
    threadId: ThreadId.and(idBound),
    payload: Payload,
  })
  .strict();
export type MetadataEvent = z.infer<typeof MetadataEvent>;

/** Bounded projection, before serialization or structured cloning. Oversized routing ids are skipped. */
export function metadata(event: Event): MetadataEvent | undefined {
  if (event.threadId.length > 200) return undefined;
  const p = event.payload;
  let payload: unknown;
  switch (p.type) {
    case "thread.created":
      payload = {
        type: p.type,
        thread: {
          title: p.thread.title.slice(0, 200),
          status: p.thread.status,
          archivedAt: p.thread.archivedAt,
        },
      };
      break;
    case "thread.updated":
      payload = {
        type: p.type,
        title: p.title?.slice(0, 200),
        status: p.status,
        archivedAt: p.archivedAt,
      };
      break;
    case "agent.created":
      payload = {
        type: p.type,
        agent: { id: p.agent.id, status: { state: p.agent.status.state } },
      };
      break;
    case "agent.status":
      payload = { type: p.type, agentId: p.agentId, status: { state: p.status.state } };
      break;
    case "interaction.opened": {
      if (
        p.interaction.state !== "pending" ||
        p.interaction.id.length > 200 ||
        p.interaction.agentId.length > 200
      )
        return undefined;
      const link = interactionLink(p.interaction);
      payload = {
        type: p.type,
        interaction: {
          id: link.id,
          actions: link.actions,
          agentId: p.interaction.agentId,
          blocking: p.interaction.blocking,
          state: p.interaction.state,
        },
      };
      break;
    }
    case "interaction.closed":
      payload = { type: p.type, interactionId: p.interactionId };
      break;
    case "background_task.started":
      payload = { type: p.type, task: { id: p.task.id, status: p.task.status } };
      break;
    case "background_task.updated":
      payload = { type: p.type, taskId: p.taskId, status: p.status };
      break;
    default:
      return undefined;
  }
  const parsed = MetadataEvent.safeParse({
    seq: event.seq,
    at: event.at,
    threadId: event.threadId,
    payload,
  });
  return parsed.success ? parsed.data : undefined;
}
