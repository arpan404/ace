import type { ThreadReader } from "@ace/client";
import { useThread } from "@ace/client-react";
import type { ContextMeter as Meter } from "@ace/protocol";
import { contextUsage, modelLabel } from "@ace/ui-core";
import { Suspense, useCallback } from "react";
import { Tip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/cn.ts";
import { useComposerCompact } from "./composer-compact.ts";
import { DeferredThreadUsage } from "./deferred-parts.tsx";

/**
 * The root agent's latest sample, or the thread's live summary when no sample has arrived, with
 * the model the provider confirmed (else the one the thread runs on).
 */
function useRootMeter(threadId: string): Meter | undefined {
  const read = useCallback((reader: ThreadReader): Meter | undefined => {
    const thread = reader.thread;
    const model = reader.context?.model ?? thread?.live?.model ?? thread?.execution?.model;
    const named = (meter: Meter): Meter => (model ? { ...meter, model } : meter);
    if (reader.context) return named(reader.context);
    const summary = thread?.live?.contextMeter;
    const root = thread?.rootAgentId;
    return summary && root
      ? named({
          agentId: root,
          epoch: 0,
          usedTokens: summary.used,
          windowTokens: summary.limit,
          source: "provider",
        })
      : undefined;
  }, []);
  const root = useThread(threadId, ["thread"], rootOf);
  return useThread(
    threadId,
    ["thread", ...(root ? [`context:${root}` as const] : [])],
    read,
    sameMeter,
  );
}
const rootOf = (reader: ThreadReader) => reader.thread?.rootAgentId;
/** The summary is rebuilt on each read; an unchanged one must not re-render. */
const sameMeter = (a: Meter | undefined, b: Meter | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.agentId === b.agentId &&
    a.epoch === b.epoch &&
    a.usedTokens === b.usedTokens &&
    a.windowTokens === b.windowTokens &&
    a.model === b.model &&
    a.source === b.source);

const size = 16;
const radius = 6;
const circumference = 2 * Math.PI * radius;

/**
 * How full the main agent's context window is: a small ring beside the model, the numbers on
 * hover with the model and what the thread has cost so far. Nothing until the provider has
 * reported a sample; compaction resets it. A narrow composer shows the ring alone.
 */
export function ContextMeter(props: { threadId: string }) {
  const meter = useRootMeter(props.threadId);
  const usage = contextUsage(meter);
  const compact = useComposerCompact();
  if (!usage) return null;
  const ring = usage.percent !== undefined;
  const share = (usage.percent ?? 0) / 100;
  const context = usage.high ? `${usage.long}. It may compact soon.` : usage.long;
  return (
    <Tip
      label={
        <span className="flex flex-col gap-0.5">
          <span>{meter?.model ? `${modelLabel(meter.model)} · ${context}` : context}</span>
          <Suspense>
            <DeferredThreadUsage.Component threadId={props.threadId} />
          </Suspense>
        </span>
      }
    >
      <span
        role="meter"
        aria-label="Context used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={usage.percent}
        aria-valuetext={usage.long}
        tabIndex={0}
        className={cn(
          "inline-flex h-(--composer-control) shrink-0 items-center gap-1 rounded-full px-2 text-xs tabular-nums outline-none focus-visible:shadow-[0_0_0_2px_var(--ring)]",
          usage.high ? "text-foreground" : "text-subtle-foreground",
        )}
      >
        {ring && (
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
        {!(compact && ring) && usage.short}
      </span>
    </Tip>
  );
}
