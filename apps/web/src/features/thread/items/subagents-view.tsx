import type { AgentFacts } from "@/lib/agent-facts.ts";
import { subagentStatusLine, subagentTerminal } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useId, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import { readSubagentGroup, subagentEntriesEqual } from "../lib/subagent-group.ts";
import { SubagentAvatar, SubagentElapsed, SubagentRow, subagentTones } from "./subagent-row.tsx";

/** One disclosure at the first launch of a batch, with flat rows for its direct children. */
export function Subagents(props: { threadId: string; itemIds: readonly string[] }) {
  const read = useCallback(
    (facts: AgentFacts) => readSubagentGroup(facts.reader, props.itemIds, facts),
    [props.itemIds],
  );
  const entries = useAgentFacts(props.threadId, read, subagentEntriesEqual) ?? [];
  const [open, setOpen] = useState(false);
  const body = useId();
  const live = useThreadLiveState(props.threadId);
  if (!entries.length) return null;
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const startedAt = Math.min(...entries.map((entry) => entry.startedAt));
  const ends = entries.flatMap((entry) => (entry.endedAt === undefined ? [] : [entry.endedAt]));
  const endedAt = !running && ends.length === entries.length ? Math.max(...ends) : undefined;
  const title = `${entries.length} ${entries.length === 1 ? "subagent" : "subagents"}`;
  const line = subagentStatusLine(states);
  const tone = states.includes("human")
    ? subagentTones.human
    : states.includes("failed") || states.includes("unresponsive")
      ? subagentTones.failed
      : running
        ? subagentTones.working
        : "text-muted-foreground";
  return (
    <section aria-label={title} className="py-1">
      <button
        type="button"
        aria-label={title}
        aria-expanded={open}
        aria-controls={body}
        aria-describedby={`${body}-status`}
        onClick={() => setOpen(!open)}
        className="flex min-h-(--row-height) pointer-coarse:min-h-11 w-full min-w-0 items-center gap-(--surface-gap) rounded-md px-(--surface-inset) py-[calc(var(--setting-row-padding)/2)] text-left transition-colors duration-(--motion-fast) hover:bg-accent focus-ring"
      >
        <span aria-hidden className="flex shrink-0 items-center -space-x-2">
          {entries.slice(0, 3).map((entry) => (
            <SubagentAvatar key={entry.id} provider={entry.provider} model={entry.model} />
          ))}
          {entries.length > 3 && (
            <span className="pl-3 text-xs text-subtle-foreground">+{entries.length - 3}</span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium">{title}</span>
          <span id={`${body}-status`} role="status" className={cn("block text-xs", tone)}>
            {live.fresh || !running ? line : `Last seen: ${line}`}
          </span>
        </span>
        <SubagentElapsed
          startedAt={startedAt}
          endedAt={endedAt}
          running={running}
          fresh={live.fresh}
        />
        <CaretDownIcon
          aria-hidden
          size={16}
          className={cn(
            "shrink-0 text-subtle-foreground transition-transform duration-(--motion-base)",
            open && "rotate-180",
          )}
        />
      </button>
      <div id={body} hidden={!open}>
        {open && (
          <>
            <ul aria-label="Subagents" className="mt-1 overflow-hidden rounded-card border">
              {entries.map((entry) => (
                <SubagentRow
                  key={entry.id}
                  threadId={props.threadId}
                  entry={entry}
                  fresh={live.fresh}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
