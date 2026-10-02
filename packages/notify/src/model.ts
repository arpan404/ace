import { z } from "zod";
import {
  ThreadStatus,
  InteractionId,
  Notification,
  type Event,
  type Interaction,
} from "@ace/protocol";
import type { MetadataEvent } from "./metadata.ts";
import { alertStatus } from "./policy.ts";

export const InteractionLink = z.object({
  id: InteractionId.and(z.string().max(200)),
  actions: Notification.shape.actions,
});
export const CompactThread = z.object({
  archived: z.boolean().default(false),
  generation: z.number().int().nonnegative().default(0),
  title: z.string().max(200),
  status: ThreadStatus,
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

export function interactionLink(interaction: Interaction): z.infer<typeof InteractionLink> {
  const actions: Notification["actions"] = [];
  if (interaction.request.kind === "approval") {
    const allow = interaction.request.options.find(
      (option) => option.kind === "allow_once" && option.id.length <= 200,
    );
    const deny = interaction.request.options.find(
      (option) => option.kind === "deny" && option.id.length <= 200,
    );
    if (allow && allow.id.length <= 200) actions.push({ action: "approve", optionId: allow.id });
    if (deny && deny.id.length <= 200) actions.push({ action: "deny", optionId: deny.id });
  }
  return InteractionLink.parse({ id: interaction.id, actions });
}
/** Only canonical event-log entities are observed. No provider data or transcript folding. */
export function advance(
  state: CompactThread,
  pending: Pending | undefined,
  event: MetadataEvent,
  now: number,
  windowMs: number,
  changes: { interactionChanged: boolean; backgroundCompleted: boolean },
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
  }
  changed ||= changes.interactionChanged && state.status.state === "needs_you";
  background = changes.backgroundCompleted ? 1 : 0;
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
  link: z.infer<typeof InteractionLink> | undefined,
): Notification {
  const status = pending.status ?? "background_done";
  const interaction = status === "needs_you" ? link : undefined;
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
