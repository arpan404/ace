import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import { Suspense } from "react";
import { deferredComponent } from "@/lib/deferred-component.tsx";

/** The folded line's code loads only for a thread that was made in a worktree. */
const DeferredReadyLine = deferredComponent(() =>
  import("./creation-card.tsx").then((module) => module.WorktreeReadyLine),
);

const readCreation = (reader: ThreadReader) => reader.thread?.details?.worktreeCreation;
const readBranch = (reader: ThreadReader) => reader.thread?.details?.branch;

/**
 * Under the message that started a thread in a worktree: how its worktree was made, folded to
 * "Worktree ready · branch · 4.2s" (or "Using the local checkout" when the person fell back),
 * from the progress the daemon kept on the thread. Nothing under any other message.
 */
export function WorktreeNote(props: { threadId: string; itemId: string }) {
  const progress = useThread(props.threadId, ["thread"], readCreation);
  const branch = useThread(props.threadId, ["thread"], readBranch);
  if (!progress || props.itemId !== `input:${progress.commandId}`) return null;
  if (progress.state !== "done" && progress.state !== "local") return null;
  return (
    <div className="pt-4">
      <Suspense fallback={null}>
        <DeferredReadyLine.Component progress={progress} branch={branch} />
      </Suspense>
    </div>
  );
}
