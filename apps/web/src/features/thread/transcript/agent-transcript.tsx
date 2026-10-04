import { useHistoryPager } from "@ace/client-react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { BlockView } from "../items/block-view.tsx";
import type { Block } from "./blocks.ts";
import { useAgentBlocks, useBlocks } from "./use-blocks.ts";

/**
 * A read-only transcript beside the conversation: one subagent's own work from the thread's
 * loaded window, or (`agentId` left out) a delegated child thread whole. Blocks render as they
 * do in the main column; older history pages in on request.
 */
export function AgentTranscript(props: { threadId: string; agentId?: string | undefined }) {
  return props.agentId === undefined ? (
    <ThreadBlocks threadId={props.threadId} />
  ) : (
    <OneAgent threadId={props.threadId} agentId={props.agentId} />
  );
}

function OneAgent(props: { threadId: string; agentId: string }) {
  const blocks = useAgentBlocks(props.threadId, props.agentId);
  return <Blocks threadId={props.threadId} blocks={blocks} />;
}

function ThreadBlocks(props: { threadId: string }) {
  const blocks = useBlocks(props.threadId);
  return <Blocks threadId={props.threadId} blocks={blocks} />;
}

function Blocks(props: { threadId: string; blocks: readonly Block[] }) {
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
      {props.blocks.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          {pager.hasOlder
            ? "Nothing from this agent in the part of the thread loaded so far."
            : "This agent hasn't written anything yet."}
        </p>
      ) : (
        <div role="feed" aria-label="Agent transcript" className="flex flex-col gap-3">
          {props.blocks.map((block, index) => (
            <article key={block.key} aria-posinset={index + 1} aria-setsize={-1}>
              <BlockView threadId={props.threadId} block={block} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
