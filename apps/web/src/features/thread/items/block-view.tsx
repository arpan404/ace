import { useItem } from "@ace/client-react";
import { ArchiveIcon, InfoIcon, WarningIcon } from "@phosphor-icons/react";
import { memo } from "react";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import type { Block } from "../transcript/blocks.ts";
import { BackgroundTaskLine } from "./background-task.tsx";
import { ChangedFiles } from "./changed-files.tsx";
import { AssistantMessage, UserMessage } from "./messages.tsx";
import { Subagents } from "./subagents.tsx";
import { WorkLog } from "./work-log.tsx";

/**
 * One transcript block. Each child subscribes to its own items, so streaming stays local, and
 * the block itself skips re-rendering when the virtualizer re-measures its neighbours.
 */
export const BlockView = memo(function BlockView(props: { threadId: string; block: Block }) {
  const { threadId, block } = props;
  switch (block.kind) {
    case "user":
      return <UserMessage threadId={threadId} itemId={block.itemId} />;
    case "message":
      return <AssistantMessage threadId={threadId} itemId={block.itemId} />;
    case "work":
      return <WorkLog threadId={threadId} itemIds={block.itemIds} />;
    case "subagents":
      return <Subagents threadId={threadId} itemIds={block.itemIds} />;
    case "background":
      return <BackgroundTaskLine threadId={threadId} itemId={block.itemId} taskId={block.taskId} />;
    case "files":
      return <ChangedFiles threadId={threadId} itemIds={block.itemIds} />;
    case "item":
      return <QuietItem threadId={threadId} itemId={block.itemId} />;
  }
});

/** Notices, compaction, artifacts and messages ace did not send: one quiet line each. */
function QuietItem(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  if (!item) return null;
  switch (item.type) {
    case "notice":
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
    case "compaction":
      return (
        <Marker variant="separator" className="text-xs">
          <MarkerContent>Context compacted</MarkerContent>
        </Marker>
      );
    case "artifact":
      return (
        <p className="flex items-center gap-2 text-ui text-muted-foreground">
          <ArchiveIcon aria-hidden size={16} className="text-subtle-foreground" />
          Saved <code className="font-mono text-[12.5px] text-foreground">{item.path}</code>
        </p>
      );
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
