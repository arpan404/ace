import { useAgent, useItem } from "@ace/client-react";
import {
  ArtifactItemView,
  CompactionItemView,
  NoticeItemView,
  ReasoningItemView,
} from "./other-items.tsx";
import { MessageItemView } from "./message-item.tsx";
import { ToolCallItemView } from "./tool-call-item.tsx";

/** One transcript row. It subscribes to its own item, so a streaming neighbour never re-renders it. */
export function TranscriptItem(props: { threadId: string; itemId: string }) {
  const item = useItem(props.threadId, props.itemId);
  const agent = useAgent(props.threadId, item?.agentId ?? "");
  if (!item) return null;
  switch (item.type) {
    case "message":
      return (
        <MessageItemView
          item={item}
          agentName={agent && agent.origin !== "root" ? (agent.name ?? "Subagent") : undefined}
        />
      );
    case "tool_call":
      return <ToolCallItemView item={item} />;
    case "reasoning":
      return <ReasoningItemView item={item} />;
    case "notice":
      return <NoticeItemView item={item} />;
    case "compaction":
      return <CompactionItemView />;
    case "artifact":
      return <ArtifactItemView item={item} />;
  }
}
