import type { Event } from "@ace/protocol";

/** Engine notice codes that mean an accepted message did not go in as sent. */
const codes = ["input_requeued", "input_queued", "delivery_uncertain", "delivery_failed"] as const;
type NoticeCode = (typeof codes)[number];

/** A failed or kept-back delivery, read from a thread's notice item. */
export interface DeliveryNotice {
  commandId: string;
  code: NoticeCode;
  detail: string;
}

/** The delivery notice an event carries, if it carries one. */
export function deliveryNotice(event: Event): DeliveryNotice | undefined {
  const payload = event.payload;
  if (payload.type !== "item.created" && payload.type !== "item.updated") return undefined;
  const item = payload.item;
  if (item.type !== "notice" || !item.commandId) return undefined;
  const code = codes.find((known) => known === item.code);
  if (!code) return undefined;
  return { commandId: item.commandId, code, detail: (item.detail ?? item.text).slice(0, 240) };
}

/** What the parent agent is told about its message to child `role` (`childId`). */
export function noticeText(notice: DeliveryNotice, role: string, childId: string): string {
  const to = `Your message to ${role} (${childId})`;
  const why = notice.detail ? ` (${notice.detail})` : "";
  switch (notice.code) {
    case "input_requeued":
      return `${to} couldn't join its running turn${why}. ace kept it: it runs when that turn ends.`;
    case "input_queued":
      return `${to} wasn't sent${why}. It waits in that thread's queue for the person to retry; send it again with delivery restart to retry yourself.`;
    case "delivery_uncertain":
      return `${to} may or may not have reached it${why}. ace won't send it again; check with thread_read before resending.`;
    case "delivery_failed":
      return `${to} failed and won't be sent${why}. Send it again if it still applies.`;
  }
}
