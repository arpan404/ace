import { z } from "zod";
import type { Notification, ThreadId } from "@ace/protocol";

/*
 * Spade's notices (ADR 0165, ADR 0195) as ace's alerts. Spade decides whether each notice
 * reaches the person now (do not disturb, quiet hours, the interruption budget); only those it
 * sends with `reach: "now"` become alerts. Read leniently: an unknown kind or category still
 * alerts with Spade's own sentence, and a notice that doesn't read alerts no one.
 */

const words = (most: number) => z.string().transform((text) => text.slice(0, most));
const SpadeNotice = z.looseObject({
  id: z.string().min(1).max(160),
  kind: z.string().max(40),
  category: z.string().min(1).max(40),
  reach: z.string(),
  agent: z.string().min(1).max(200),
  name: words(80).catch(""),
  conversation: z.string().min(1).max(200).optional().catch(undefined),
  request: z.string().min(1).max(200).optional().catch(undefined),
  digest: z.number().int().nonnegative().optional().catch(undefined),
  text: words(300).catch(""),
});

/** The alert's title by what the notice is about; the bot's name for the rest. */
const titles: Record<string, string> = {
  brief: "Morning brief",
  summary: "Spade",
};

/**
 * The alert for one notice from `GET /v1/notices/live`, or undefined when it doesn't reach
 * the person now. `threadId` is Spade's host thread: the worker files alerts by thread, and the
 * client opens `spade` instead.
 */
export function alertFromSpadeNotice(data: string, threadId: ThreadId): Notification | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = SpadeNotice.safeParse(raw);
  if (!parsed.success || parsed.data.reach !== "now") return undefined;
  const notice = parsed.data;
  const title = titles[notice.category] ?? (notice.name || "Spade");
  const message = notice.category === "digest" ? `Digest: ${notice.text}` : notice.text;
  return {
    id: `spade:${notice.id}`,
    threadId,
    title,
    status: "spade",
    message: message.slice(0, 300),
    backgroundCount: 0,
    actions: [],
    spade: {
      agent: notice.agent,
      ...(notice.conversation ? { conversation: notice.conversation } : {}),
      ...(notice.request ? { request: notice.request } : {}),
      ...(notice.digest === undefined ? {} : { digest: notice.digest }),
      category: notice.category,
    },
  };
}
