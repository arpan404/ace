import { LocalBoundary } from "@/components/ui/local-boundary.tsx";
import { useItem } from "@ace/client-react";
import { mayBeSystemInput } from "@ace/ui-core";
import { memo, Suspense } from "react";
import { DeferredEvent } from "./deferred-review.ts";
import type { Block } from "../transcript/blocks.ts";
import { TurnEnd } from "../transcript/turn-end.tsx";
import { BackgroundTaskLine } from "./background-task.tsx";
import { ChangedFiles } from "./changed-files.tsx";
import { AssistantMessage } from "./messages.tsx";
import { QuestionBlock } from "./question-block.tsx";
import { UserMessage } from "./user-message.tsx";
import { WorktreeNote } from "../worktree/worktree-note.tsx";
import { Subagents } from "./subagents.tsx";
import { WorkLog } from "./work-log.tsx";

const EventView = DeferredEvent.Component;

/**
 * One transcript block. Each child subscribes to its own items, so streaming stays local, and
 * the block itself skips re-rendering when the virtualizer re-measures its neighbours.
 */
const BlockContent = memo(function BlockContent(props: {
  threadId: string;
  block: Block;
  /** The last block of a turn still in progress. */
  live?: boolean;
}) {
  const { threadId, block } = props;
  switch (block.kind) {
    case "user":
      return <PersonMessage threadId={threadId} itemId={block.itemId} />;
    case "message":
      return <AssistantMessage threadId={threadId} itemId={block.itemId} />;
    case "work":
      return (
        <WorkLog
          threadId={threadId}
          itemIds={block.itemIds}
          live={props.live ?? false}
          ongoing={block.ongoing}
          until={block.until}
          idle={block.idle}
        />
      );
    case "subagents":
      return <Subagents threadId={threadId} itemIds={block.itemIds} />;
    case "background":
      return <BackgroundTaskLine threadId={threadId} itemId={block.itemId} taskId={block.taskId} />;
    case "files":
      return <ChangedFiles threadId={threadId} itemIds={block.itemIds} />;
    case "question":
      return <QuestionBlock threadId={threadId} interactionId={block.interactionId} />;
    case "item":
    case "event":
      return <Event threadId={threadId} itemId={block.itemId} />;
    case "end":
      return <TurnEnd threadId={threadId} block={block} />;
  }
});

function Event(props: { threadId: string; itemId: string }) {
  return (
    <Suspense fallback={null}>
      <EventView threadId={props.threadId} itemId={props.itemId} />
    </Suspense>
  );
}

/**
 * A user message: the person's bubble, unless ace sent it on their behalf (a resume, a
 * delegation result, an answer, a handoff), which reads as an event instead (A3). Only a
 * candidate goes to the event view, which decides exactly and shows the bubble otherwise. The
 * message that started a thread in a worktree keeps how that worktree was made under it.
 */
function PersonMessage(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (mayBeSystemInput(item)) return <Event threadId={props.threadId} itemId={props.itemId} />;
  return (
    <>
      <UserMessage threadId={props.threadId} itemId={props.itemId} />
      <WorktreeNote threadId={props.threadId} itemId={props.itemId} />
    </>
  );
}

export const BlockView = memo(function BlockView(props: React.ComponentProps<typeof BlockContent>) {
  return (
    <LocalBoundary key={props.block.key} label="this message">
      <BlockContent {...props} />
    </LocalBoundary>
  );
});
