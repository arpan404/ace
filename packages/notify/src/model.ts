import { z } from "zod";
import {
  ThreadStatus,
  InteractionId,
  Notification,
  type Event,
  type Interaction,
} from "@ace/protocol";
import { alertStatus } from "./policy.ts";

const Link = z.object({
  id: InteractionId.and(z.string().max(200)),
  actions: Notification.shape.actions,
});
export const CompactThread = z.object({
  archived: z.boolean().default(false),
  generation: z.number().int().nonnegative().default(0),
  title: z.string().max(200),
  status: ThreadStatus,
  interactions: z.array(Link).max(128),
  tasks: z.array(z.string().max(200)).max(128),
});
export type CompactThread = z.infer<typeof CompactThread>;
export const Pending = z.object({
  seq: z.number().int(),
  due: z.number(),
  at: z.number(),
  status: Notification.shape.status.optional(),
  backgroundCount: z.number().int().nonnegative().max(1_000_000),
});
export type Pending = z.infer<typeof Pending>;

function link(interaction: Interaction): z.infer<typeof Link> {
  const actions: Notification["actions"] = [];
  if (interaction.request.kind === "approval") {
    const allow = interaction.request.options.find((option) => option.kind === "allow_once");
    const deny = interaction.request.options.find((option) => option.kind === "deny");
    if (allow && allow.id.length <= 200) actions.push({ action: "approve", optionId: allow.id });
    if (deny && deny.id.length <= 200) actions.push({ action: "deny", optionId: deny.id });
  }
  return Link.parse({ id: interaction.id, actions });
}
/** Only canonical event-log entities are observed. No provider data or transcript folding. */
export function advance(
  state: CompactThread,
  pending: Pending | undefined,
  event: Event,
  now: number,
  windowMs: number,
): Pending | undefined {
  const p = event.payload;
  let changed = false;
  let background = 0;
  if (p.type === "thread.updated") {
    if (p.title !== undefined) state.title = p.title.slice(0, 200);
    if (p.archivedAt !== undefined) state.archived = p.archivedAt !== null;
    if (p.status) {
      changed = state.status.state !== p.status.state;
      if (changed) state.generation = event.seq;
      state.status = p.status;
      if (pending) {
        const status = alertStatus(p.status);
        if (status) pending.status = status;
        else delete pending.status;
      }
    }
  } else if (p.type === "interaction.opened" && p.interaction.state === "pending") {
    if (!state.interactions.some((value) => value.id === p.interaction.id)) {
      if (state.interactions.length >= 128) throw new Error("Interaction capacity reached");
      state.interactions.push(link(p.interaction));
      changed = state.status.state === "needs_you";
    }
  } else if (p.type === "interaction.closed") {
    state.interactions = state.interactions.filter((value) => value.id !== p.interactionId);
  } else if (p.type === "background_task.started" && p.task.status === "running") {
    if (!state.tasks.includes(p.task.id)) {
      if (state.tasks.length >= 128) throw new Error("Task capacity reached");
      state.tasks.push(p.task.id);
    }
  } else if (p.type === "background_task.updated" && p.status !== "running") {
    const index = state.tasks.indexOf(p.taskId);
    if (index >= 0) {
      state.tasks.splice(index, 1);
      background = p.status === "completed" ? 1 : 0;
    }
  }
  const status = alertStatus(state.status);
  if ((changed && status) || background) {
    pending ??= { seq: event.seq, due: now + windowMs, at: event.at, backgroundCount: 0 };
    pending.seq = event.seq;
    pending.at = event.at;
    pending.backgroundCount = Math.min(1_000_000, pending.backgroundCount + background);
    if (changed && status) pending.status = status;
  }
  return state.archived ? undefined : pending;
}
export function content(
  threadId: Event["threadId"],
  state: CompactThread,
  pending: Pending,
): Notification {
  const status = pending.status ?? "background_done";
  const interaction = status === "needs_you" ? state.interactions[0] : undefined;
  return Notification.parse({
    id: `n:${pending.seq}`,
    threadId,
    title: state.title,
    status,
    ...(interaction ? { interactionId: interaction.id } : {}),
    backgroundCount: pending.backgroundCount,
    actions: interaction?.actions ?? [],
  });
}
