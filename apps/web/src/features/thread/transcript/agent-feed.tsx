import { useAgent } from "@ace/client-react";
import { Suspense, useMemo, type ReactNode } from "react";
import { DeferredFailedTurn } from "../items/deferred-review.ts";
import { FeedView, type FeedProps } from "./feed-view.tsx";
import { useAgentBlocks } from "./use-blocks.ts";

const FailedTurn = DeferredFailedTurn.Component;
const noTurn = () => undefined;

/**
 * A provider subagent's own transcript as a feed: its lane of the thread, without its parent's
 * work, read the way the thread's transcript is (older work pages in as the reader scrolls up,
 * the view follows its live end). Its prompt and live line lead it, since a thread's live line
 * reads the whole tree. One that failed before its work showed a turn ending still
 * shows why.
 */
export function AgentFeed(
  props: FeedProps & { agentId: string; prompt?: ReactNode; live?: ReactNode },
) {
  const { threadId, agentId, pager } = props;
  const built = useAgentBlocks(threadId, agentId);
  const blocks = useMemo(() => built.filter((block) => block.kind !== "live"), [built]);
  const status = useAgent(threadId, agentId)?.status;
  const failure =
    status?.state === "failed" && !blocks.some((block) => block.kind === "end")
      ? status.error
      : undefined;
  const empty = blocks.length === 0 && !failure;
  return (
    <FeedView
      {...props}
      scrollKey={`${threadId}/agents/${agentId}`}
      blocks={blocks}
      ordinalOf={noTurn}
      lead={
        <div className="pb-3 empty:hidden">
          {/* The prompt starts its lane: it shows once older work is all loaded. */}
          {!pager.hasOlder && props.prompt}
          {props.live}
        </div>
      }
      end={
        <>
          {empty && (
            <p className="text-ui text-muted-foreground">
              {pager.hasOlder
                ? "Nothing from this subagent in the part of the thread loaded so far."
                : "This subagent hasn't written anything yet."}
            </p>
          )}
          {failure && (
            <Suspense fallback={null}>
              <FailedTurn
                threadId={threadId}
                askId={undefined}
                errorId={undefined}
                error={failure}
                latest={false}
              />
            </Suspense>
          )}
        </>
      }
    />
  );
}
