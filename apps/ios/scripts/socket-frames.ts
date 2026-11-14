import { z } from "zod";

/** The daemon's fragment size (`apps/daemon/src/outbox.ts`): one part's `data`, in characters. */
const partChars = 131072;

const Fragmentable = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), subscriptionId: z.string().min(1), seq: z.number() }),
  z.object({
    type: z.literal("entities.page"),
    requestId: z.string().min(1),
    page: z.object({ threadId: z.string().min(1), seq: z.number() }),
  }),
]);

/**
 * The frames the fixture's socket sends for one fake-daemon message. Large snapshots and entity
 * pages go as `snapshot.part` / `entities.page.part`, as the daemon's outbox sends them, so no
 * frame passes the SDK's or the phone's 2 MiB frame limit.
 */
export function* socketFrames(text: string): Generator<string> {
  if (text.length <= partChars) {
    yield text;
    return;
  }
  const parsed = Fragmentable.safeParse(JSON.parse(text));
  if (!parsed.success) {
    yield text;
    return;
  }
  const message = parsed.data;
  const header =
    message.type === "snapshot"
      ? { type: "snapshot.part", subscriptionId: message.subscriptionId, seq: message.seq }
      : {
          type: "entities.page.part",
          requestId: message.requestId,
          threadId: message.page.threadId,
          seq: message.page.seq,
        };
  let index = 0;
  for (let offset = 0; offset < text.length; offset += partChars) {
    const end = Math.min(text.length, offset + partChars);
    yield JSON.stringify({
      ...header,
      index: index++,
      done: end === text.length,
      data: text.slice(offset, end),
    });
  }
}
