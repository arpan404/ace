import { z } from "zod";
import type { PatchSink, Preview } from "./agents.ts";
import type { ChangesSession } from "./changes.ts";

/*
 * The Changes sheet's actions beyond opening it (CHANGES-CONTRACT.md): scopes, open files and
 * their pages, layout, viewed marks, and local review. Review actions answer on
 * `changes:notice` with their request id once the daemon has.
 */

const path = z.string().min(1).max(4096);
const key = z.string().min(1).max(8192);
const requestId = z.string().min(1).max(64);
const line = z.number().int().positive().max(10_000_000);

export const ChangesAction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("changes.scope"), scope: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("changes.open"), path, open: z.boolean() }),
  z.object({ kind: z.literal("changes.expand"), open: z.boolean() }),
  z.object({ kind: z.literal("changes.more"), path }),
  z.object({ kind: z.literal("changes.line"), path, index: z.number().int().min(0) }),
  z.object({ kind: z.literal("changes.layout"), layout: z.enum(["unified", "split"]) }),
  z.object({ kind: z.literal("changes.viewed"), path, viewed: z.boolean() }),
  z.object({
    kind: z.literal("review.draft"),
    requestId,
    key: key.optional(),
    path,
    side: z.enum(["old", "new"]),
    start: line,
    end: line,
    text: z.string().min(1).max(4096),
    suggestion: z.string().max(8192).optional(),
  }),
  z.object({ kind: z.literal("review.discard"), key }),
  z.object({ kind: z.literal("review.send"), requestId, keys: z.array(key).max(400).optional() }),
  z.object({ kind: z.literal("review.resolve"), requestId, key, resolved: z.boolean() }),
  z.object({ kind: z.literal("review.apply"), requestId, key }),
  z.object({ kind: z.literal("review.reply"), requestId, key, text: z.string().min(1).max(4096) }),
  z.object({ kind: z.literal("review.replies"), key }),
  z.object({
    kind: z.literal("review.status"),
    requestId,
    status: z.enum(["approved", "changes-requested"]),
  }),
  z.object({ kind: z.literal("review.refresh") }),
]);
export type ChangesAction = z.infer<typeof ChangesAction>;

/** The outcome of a review action, for the phone to settle its button. */
function notice(
  sink: PatchSink,
  preview: Preview,
  session: ChangesSession,
  action: string,
  id: string,
  refusal: string | undefined,
) {
  sink.put("changes:notice", () => ({
    type: "changes.notice",
    threadId: session.threadId,
    epoch: session.epoch,
    requestId: id,
    action,
    ok: refusal === undefined,
    message: refusal === undefined ? "" : preview(refusal, 512),
  }));
}

/** Run one action on the open sheet; false when it names nothing the sheet holds. */
export function changesAction(
  session: ChangesSession,
  action: ChangesAction,
  sink: PatchSink,
  preview: Preview,
): boolean {
  const review = session.review;
  /** A draft's own error carries a send's or resolve's failure; the notice says it finished. */
  const settle = (id: string, work: Promise<string | undefined | void>) =>
    void work.then(
      (refusal) => notice(sink, preview, session, action.kind, id, refusal ?? undefined),
      () => notice(sink, preview, session, action.kind, id, "Something went wrong: try again."),
    );
  switch (action.kind) {
    case "changes.scope":
      session.scope(action.scope);
      return true;
    case "changes.open":
      return session.open(action.path, action.open);
    case "changes.expand":
      session.expand(action.open);
      return true;
    case "changes.more":
      return session.more(action.path);
    case "changes.line":
      return session.line(action.path, action.index);
    case "changes.layout":
      session.layout(action.layout);
      return true;
    case "changes.viewed":
      return session.viewed(action.path, action.viewed);
    case "review.draft":
      notice(sink, preview, session, action.kind, action.requestId, review.draft(action));
      return true;
    case "review.discard":
      review.discard(action.key);
      return true;
    case "review.send":
      settle(action.requestId, review.send(action.keys));
      return true;
    case "review.resolve":
      settle(action.requestId, review.resolve(action.key, action.resolved));
      return true;
    case "review.apply":
      settle(action.requestId, review.apply(action.key));
      return true;
    case "review.reply":
      settle(action.requestId, review.reply(action.key, action.text));
      return true;
    case "review.replies":
      void review.replies(action.key);
      return true;
    case "review.status":
      settle(action.requestId, review.status(action.status));
      return true;
    case "review.refresh":
      void review.refresh();
      return true;
  }
}
