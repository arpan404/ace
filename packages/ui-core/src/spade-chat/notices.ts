import { z } from "zod";

/*
 * A bot's own notices (`notify`, ADR 0200 §4.2): stored as `notice_sent` with how Spade's reach
 * decided it (ADR 0195), and shown in the bot's chat as one row where it was sent, with what
 * became of it. Its title and body are the bot's words, drawn as plain text.
 */

/** How a notice reached the person: sent now, held for the brief, or not sent. */
export type SpadeNoticeReach = "now" | "held" | "none";

/** A notice as the chat shows it. */
export interface SpadeNoticeRow {
  title: string;
  body: string;
  reach: SpadeNoticeReach;
  /** Why it waited or didn't go: `dnd`, `quiet`, `budget`, `rate`, `off`, `bot_off`. */
  why: string | undefined;
}

/** The stored event `wire.ts` reads for notices, `spade_core` as it writes it. */
export const spadeNoticeEvents = [
  z.object({
    type: z.literal("notice_sent"),
    call_id: z.string().catch(""),
    id: z.string().catch(""),
    title: z.string().catch(""),
    body: z.string().catch("").default(""),
    // A reach this client doesn't know reads as one that went nowhere yet.
    reach: z.enum(["now", "held", "none"]).catch("held"),
    why: z.string().nullish().catch(undefined),
  }),
] as const;

export function spadeNoticeSent(event: {
  title: string;
  body: string;
  reach: SpadeNoticeReach;
  why?: string | null | undefined;
}): SpadeNoticeRow | undefined {
  const title = event.title.trim();
  if (!title) return undefined;
  return { title, body: event.body.trim(), reach: event.reach, why: event.why || undefined };
}

/** The quiet words under a notice: where it went, in a few words. */
export function spadeNoticeWords(row: Pick<SpadeNoticeRow, "reach" | "why">): string {
  if (row.reach === "now") return "Sent as a notification";
  if (row.reach === "held")
    switch (row.why) {
      case "dnd":
        return "Held for your morning brief: do not disturb was on";
      case "quiet":
        return "Held for your morning brief: quiet hours";
      case "rate":
        return "Held for your morning brief: it had sent 3 this hour";
      default:
        return "Held for your morning brief";
    }
  return row.why === "bot_off"
    ? "Not sent: its notifications are off"
    : "Not sent: Spade's notifications are off";
}
