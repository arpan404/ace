import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ContextMeter as Meter } from "@ace/protocol";
import { contextUsage } from "@ace/ui-core";
import { useCallback } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";

/** The root agent's latest sample, or the thread's live summary when no sample has arrived. */
function useRootMeter(threadId: string): Meter | undefined {
  const read = useCallback((reader: ThreadReader): Meter | undefined => {
    if (reader.context) return reader.context;
    const summary = reader.thread?.live?.contextMeter;
    const root = reader.thread?.rootAgentId;
    return summary && root
      ? {
          agentId: root,
          epoch: 0,
          usedTokens: summary.used,
          windowTokens: summary.limit,
          source: "provider",
        }
      : undefined;
  }, []);
  const root = useThread(threadId, ["thread"], rootOf);
  return useThread(threadId, ["thread", ...(root ? [`context:${root}` as const] : [])], read);
}
const rootOf = (reader: ThreadReader) => reader.thread?.rootAgentId;

const size = 16;
const radius = 6;
const circumference = 2 * Math.PI * radius;

/**
 * How full the main agent's context window is: a small ring beside the model, the numbers on
 * hover. Nothing until the provider has reported a sample; compaction resets it.
 */
export function ContextMeter(props: { threadId: string }) {
  const usage = contextUsage(useRootMeter(props.threadId));
  if (!usage) return null;
  const share = (usage.percent ?? 0) / 100;
  return (
    <Tip label={usage.high ? `${usage.long}. It may compact soon.` : usage.long}>
      <span
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent}
        aria-valuetext={usage.long}
        tabIndex={0}
        className={cn(
          "inline-flex h-[30px] items-center gap-1 rounded-[9px] px-1.5 text-xs tabular-nums outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]",
          usage.high ? "text-foreground" : "text-subtle-foreground",
        )}
      >
        {usage.percent !== undefined && (
          <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={2}
              className="stroke-border"
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              stroke="currentColor"
              strokeDasharray={`${share * circumference} ${circumference}`}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              className="transition-[stroke-dasharray] duration-(--dur-3)"
            />
          </svg>
        )}
        {usage.short}
      </span>
    </Tip>
  );
}
