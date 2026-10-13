import { useHistoryPager } from "@ace/client-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { BlockView } from "../items/block-view.tsx";
import { useAgentBlocks } from "./use-blocks.ts";

/**
 * A provider subagent's own transcript, as its whole chat: its work from the thread's loaded
 * window, without its parent's. Blocks render as they do in the main column; older history
 * pages in on request. Work in progress stays behind the view's live line, as in a thread.
 */
export function AgentTranscript(props: { threadId: string; agentId: string }) {
  const built = useAgentBlocks(props.threadId, props.agentId);
  // A thread's live head and tail read the whole tree; the subagent's own live line replaces them.
  const blocks = useMemo(
    () => built.filter((block) => block.kind !== "live" && block.kind !== "thinking"),
    [built],
  );
  const pager = useHistoryPager(props.threadId);
  return (
    <div>
      {pager.hasOlder && (
        <div className="flex justify-center pb-3">
          <Button
            size="sm"
            variant="ghost"
            disabled={pager.loading}
            onClick={() => void pager.loadOlder()}
          >
            {pager.loading && <Spinner />}
            Show earlier work
          </Button>
        </div>
      )}
      {blocks.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          {pager.hasOlder
            ? "Nothing from this subagent in the part of the thread loaded so far."
            : "This subagent hasn't written anything yet."}
        </p>
      ) : (
        <div role="feed" aria-label="Transcript" className="flex flex-col gap-3">
          {blocks.map((block, index) => (
            <article key={block.key} aria-posinset={index + 1} aria-setsize={-1}>
              <BlockView threadId={props.threadId} block={block} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
