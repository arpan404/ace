import { useCallback, useEffect, useRef, useState } from "react";
import { draftStanding } from "@ace/ui-core";
import { usePrDetail, usePrReview } from "./pr-review-context.tsx";

/**
 * After a push, moves the pending drafts written on earlier commits to the new head, once per
 * head: those whose lines no commit changed follow them; the daemon keeps the rest, outdated.
 * A failed move waits for the person to try again.
 */
export function useDraftsFollowHead(): { failed: boolean; retry(): void } {
  const review = usePrReview();
  const head = usePrDetail()?.status.headSha;
  const state = review?.state;
  const tried = useRef<string | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  // Only once the review was read at the PR's own head: moves name the head they go to.
  const due =
    !!head &&
    state?.headSha === head &&
    state.drafts.some((d) => draftStanding(d, head) === "moving");
  const run = review?.run;
  const idle = !!review?.ready && !review.pending;
  const move = useCallback(() => {
    if (!run || !head) return;
    tried.current = head;
    setFailed(undefined);
    void run({ kind: "drafts.move", headSha: head }).then((ok) => {
      if (!ok) setFailed(head);
    });
  }, [run, head]);
  useEffect(() => {
    if (due && idle && tried.current !== head) move();
  }, [due, idle, head, move]);
  return { failed: due && failed === head, retry: move };
}
