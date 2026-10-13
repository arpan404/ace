import { useItem } from "@ace/client-react";
import { formatClock } from "@ace/ui-core";
import { useState } from "react";
import { cn } from "@/lib/cn.ts";
import { userBubble } from "../items/user-bubble.ts";

/**
 * What the parent asked this subagent, from the call that started it, where a thread starts
 * with the person's message. Long prompts clamp until asked for in full.
 */
export function SubagentPrompt(props: { threadId: string; spawnedBy: string }) {
  const spawn = useItem(props.threadId, props.spawnedBy);
  const [open, setOpen] = useState(false);
  const call = spawn?.type === "tool_call" ? spawn.call : undefined;
  const detail = call?.detail.kind === "agent.spawn" ? call.detail : undefined;
  const text = detail?.prompt ?? detail?.description ?? call?.title;
  if (!spawn || !text) return null;
  const long = text.length > 600 || text.split("\n").length > 10;
  return (
    <div className="mb-6 flex flex-col items-end">
      <div className={userBubble}>
        <p className={cn("whitespace-pre-wrap", long && !open && "line-clamp-[10]")}>{text}</p>
      </div>
      <div className="mt-1 flex min-h-6 items-center gap-2">
        {long && (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="rounded-xs text-xs text-subtle-foreground outline-none hover:text-foreground focus-ring"
          >
            {open ? "Show less" : "Show the whole prompt"}
          </button>
        )}
        <span className="pr-1 text-xs text-subtle-foreground">{formatClock(spawn.createdAt)}</span>
      </div>
    </div>
  );
}
