import { useItem } from "@ace/client-react";
import { formatClock } from "@ace/ui-core";
import { BubbleText } from "../items/bubble-text.tsx";
import { userBubble } from "../items/user-bubble.ts";

/**
 * What the parent asked this subagent, from the call that started it, where a thread starts
 * with the person's message. A long prompt folds as the person's long messages do.
 */
export function SubagentPrompt(props: { threadId: string; spawnedBy: string }) {
  const spawn = useItem(props.threadId, props.spawnedBy);
  const call = spawn?.type === "tool_call" ? spawn.call : undefined;
  const detail = call?.detail.kind === "agent.spawn" ? call.detail : undefined;
  const text = detail?.prompt ?? detail?.description ?? call?.title;
  if (!spawn || !text) return null;
  return (
    <div className="mb-6 flex flex-col items-end">
      <div className={userBubble}>
        <BubbleText text={text} />
      </div>
      <div className="mt-1 flex min-h-6 items-center gap-2">
        <span className="pr-1 text-xs text-subtle-foreground">{formatClock(spawn.createdAt)}</span>
      </div>
    </div>
  );
}
