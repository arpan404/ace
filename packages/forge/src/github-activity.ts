import { z } from "zod";
import type { ForgeActivity } from "@ace/protocol/forge-browser";

const name = z.string().max(256);
/** The fields ace reads from a timeline record; everything else rides along in `raw`. */
const TimelineRecord = z.looseObject({
  id: z.union([z.string().max(200), z.number()]).optional(),
  node_id: z.string().max(200).optional(),
  event: name,
  actor: z
    .looseObject({ login: name, avatar_url: z.string().max(4096).optional() })
    .nullable()
    .optional(),
  created_at: z.string().max(64).nullable().optional(),
  sha: z.string().optional(),
  submitted_at: z.string().max(64).nullable().optional(),
  label: z.looseObject({ name: name }).optional(),
  requested_reviewer: z.looseObject({ login: name }).nullable().optional(),
  milestone: z.looseObject({ title: name }).optional(),
  lock_reason: name.nullable().optional(),
});
/** The timeline page is a list; its records are judged one by one. */
export const TimelinePage = z.array(z.unknown()).max(100);

/**
 * Maps one GitHub timeline record to an activity entry. A record ace cannot read
 * is kept whole as raw data under its own event name, so it never fails the page.
 */
export function timelineActivity(record: unknown, page: number, index: number): ForgeActivity {
  const fallbackId = `${page}:${index}`;
  const parsed = TimelineRecord.safeParse(record);
  if (!parsed.success) {
    const event =
      record && typeof record === "object" && "event" in record ? record.event : undefined;
    return {
      id: fallbackId,
      event: typeof event === "string" && event.length <= 256 ? event : "unknown",
      actor: "GitHub",
      at: null,
      raw: record,
    };
  }
  const value = parsed.data;
  const subject =
    value.label?.name ??
    value.requested_reviewer?.login ??
    value.milestone?.title ??
    value.lock_reason ??
    undefined;
  return {
    id: String(value.id ?? value.node_id ?? fallbackId),
    event: value.event,
    actor: value.actor?.login ?? "GitHub",
    at: value.created_at ?? value.submitted_at ?? null,
    ...(value.actor?.avatar_url ? { actorAvatarUrl: value.actor.avatar_url } : {}),
    ...(subject === undefined ? {} : { subject }),
    ...(value.sha && /^[a-fA-F0-9]{40,64}$/.test(value.sha) ? { commitSha: value.sha } : {}),
    raw: value,
  };
}
