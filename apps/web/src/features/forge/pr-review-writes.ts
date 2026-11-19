import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ClientApi } from "@ace/client";
import { ForgeHostedReviewCommand, type ForgePrRef, type ForgeReviewAction } from "@ace/protocol";
import { actionErrorText, lockedKinds, lockedText, reviewLostText } from "@ace/ui-core";
import { runCommand, CommandRefused } from "@/lib/daemon-command.ts";

/** How a review write ended: done, or refused with the sentence to show where it was made. */
export type ReviewWriteResult = { ok: true } | { ok: false; message: string };

/**
 * What a review write changes, and so what is read again after it: the review state alone
 * (Viewed marks, pending comments), the threads too (they come with the PR), or everything the
 * PR shows except its changed files, which no review write touches.
 */
export type ReviewReread = "review" | "threads" | "all";

export function rereadAfter(kind: ForgeReviewAction["kind"]): ReviewReread {
  switch (kind) {
    case "file.view":
    case "file.unview":
    case "draft.save":
    case "draft.delete":
      return "review";
    case "line.comment":
    case "reply":
    case "comment.edit":
    case "comment.delete":
    case "comment.hide":
    case "comment.unhide":
    case "thread.resolve":
    case "thread.unresolve":
    case "reaction.add":
    case "reaction.remove":
    case "conversation":
      return "threads";
    default:
      return "all";
  }
}

/**
 * Review writes, one at a time in the order they were asked for: a write asked while another
 * is on its way waits its turn instead of being dropped. Each answers its caller with its own
 * result; `onSettled` reads again what it changed.
 */
export function useReviewWrites(options: {
  client: ClientApi;
  workspaceId: string;
  pr: ForgePrRef;
  ready: boolean;
  disabled: boolean;
  commentsLocked: boolean;
  onSettled(reread: ReviewReread, ok: boolean): Promise<unknown> | void;
}) {
  const [inFlight, setInFlight] = useState(0);
  const tail = useRef<Promise<unknown>>(Promise.resolve());
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const perform = useCallback(async (action: ForgeReviewAction): Promise<ReviewWriteResult> => {
    const { client, workspaceId, pr, onSettled } = latest.current;
    try {
      await runCommand(
        client,
        ForgeHostedReviewCommand.parse({ type: "forge.hosted.review", workspaceId, pr, action }),
      );
    } catch (error) {
      void Promise.resolve(onSettled("review", false)).catch(() => {});
      return {
        ok: false,
        message: error instanceof CommandRefused ? actionErrorText(error.code) : reviewLostText,
      };
    }
    // The write landed. A failed read afterwards is the read's own failure, shown where the
    // read is; reporting it as the write's would keep a composer's text and invite a repost.
    try {
      await onSettled(rereadAfter(action.kind), true);
    } catch {
      /* The page keeps its last read and its read error. */
    }
    return { ok: true };
  }, []);
  const write = useCallback(
    (action: ForgeReviewAction): Promise<ReviewWriteResult> => {
      const { ready, disabled, commentsLocked } = latest.current;
      if (action.kind !== "reconcile" && !ready)
        return Promise.resolve({
          ok: false,
          message: "Not connected. Try again once ace reconnects.",
        });
      if (action.kind !== "reconcile" && disabled)
        return Promise.resolve({
          ok: false,
          message: "The pull request is being read again. Try again in a moment.",
        });
      if (commentsLocked && lockedKinds.has(action.kind))
        return Promise.resolve({ ok: false, message: lockedText });
      setInFlight((count) => count + 1);
      const turn = tail.current.then(() => perform(action));
      tail.current = turn.catch(() => {});
      return turn.finally(() => setInFlight((count) => count - 1));
    },
    [perform],
  );
  return { write, inFlight };
}

/**
 * Writes reported in the status line under the header: "Waiting for GitHub…" while one is on
 * its way, then GitHub's refusal, if any. `pending` counts the ones on their way.
 */
export function useReportedWrites(
  write: (action: ForgeReviewAction) => Promise<ReviewWriteResult>,
) {
  const [pending, setPending] = useState(0);
  const [message, setMessage] = useState("");
  const run = useCallback(
    (action: ForgeReviewAction) => {
      setPending((count) => count + 1);
      setMessage("Waiting for GitHub…");
      // A write never throws: it answers with its result.
      return write(action).then((result) => {
        // The result shows where it was made (the new comment, the resolved thread).
        setMessage(result.ok ? "" : result.message);
        setPending((count) => count - 1);
        return result.ok;
      });
    },
    [write],
  );
  return { run, pending, message };
}
