import { useItem } from "@ace/client-react";
import { InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { memo, Suspense } from "react";
import { DeferredReviewNote } from "./deferred-review.ts";
import { ArtifactLine } from "@/components/attachment-artifact.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { DeferredInteractionCard } from "../interactions/deferred-card.ts";
import type { Block } from "../transcript/blocks.ts";
import { TurnEnd } from "../transcript/turn-end.tsx";
import { BackgroundTaskLine } from "./background-task.tsx";
import { ChangedFiles } from "./changed-files.tsx";
import { AssistantMessage } from "./messages.tsx";
import { UserMessage } from "./user-message.tsx";
import { Subagents } from "./subagents.tsx";
import { WorkLog } from "./work-log.tsx";

/**
 * One transcript block. Each child subscribes to its own items, so streaming stays local, and
 * the block itself skips re-rendering when the virtualizer re-measures its neighbours.
 */
export const BlockView = memo(function BlockView(props: {
  threadId: string;
  block: Block;
  /** The last block of a turn still in progress. */
  live?: boolean;
}) {
  const { threadId, block } = props;
  switch (block.kind) {
    case "user":
      return <UserMessage threadId={threadId} itemId={block.itemId} />;
    case "message":
      return <AssistantMessage threadId={threadId} itemId={block.itemId} />;
    case "work":
      return <WorkLog threadId={threadId} itemIds={block.itemIds} live={props.live ?? false} />;
    case "subagents":
      return <Subagents threadId={threadId} itemIds={block.itemIds} />;
    case "background":
      return <BackgroundTaskLine threadId={threadId} itemId={block.itemId} taskId={block.taskId} />;
    case "files":
      return <ChangedFiles threadId={threadId} itemIds={block.itemIds} />;
    case "item":
      return <QuietItem threadId={threadId} itemId={block.itemId} />;
    case "question":
      // Placeholder (contract C-B): the pending card where the question was asked.
      return (
        <Suspense fallback={null}>
          <DeferredInteractionCard.Component
            threadId={threadId}
            interactionId={block.interactionId}
          />
        </Suspense>
      );
    case "event":
      // Placeholder (contract C-B): the injected text as a quiet line.
      return <QuietItem threadId={threadId} itemId={block.itemId} />;
    case "end":
      return <TurnEnd threadId={threadId} runId={block.runId} askId={block.askId} />;
  }
});

/** Notices, compaction, artifacts and messages ace did not send: one quiet line each. */
function QuietItem(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (!item) return null;
  switch (item.type) {
    case "notice": {
      // ace's risk policy decided an approval: the decision, its reason and the exact target.
      if (item.raw.some((raw) => raw.type === "permission.reviewed"))
        return (
          <Suspense fallback={<p className="text-ui text-muted-foreground">{item.text}</p>}>
            <DeferredReviewNote.Component threadId={props.threadId} item={item} />
          </Suspense>
        );
      return (
        <p className="flex items-start gap-2 text-ui text-muted-foreground">
          {item.level === "info" ? (
            <InfoIcon aria-hidden size={16} className="mt-px shrink-0 text-subtle-foreground" />
          ) : (
            <WarningIcon
              aria-hidden
              size={16}
              className={
                item.level === "error"
                  ? "mt-px shrink-0 text-status-failed"
                  : "mt-px shrink-0 text-subtle-foreground"
              }
            />
          )}
          <span className="whitespace-pre-wrap">{item.text}</span>
        </p>
      );
    }
    case "compaction":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerContent>Context compacted</MarkerContent>
        </Marker>
      );
    case "artifact":
      return <ArtifactLine threadId={props.threadId} path={item.path} mimeType={item.mimeType} />;
    case "message":
      return (
        <p className="text-ui whitespace-pre-wrap text-muted-foreground">
          {item.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")}
        </p>
      );
    default:
      return null;
  }
}
