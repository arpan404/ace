import type { AgentFacts } from "@/lib/agent-facts.ts";
import { subagentStatusLine, subagentTerminal } from "@ace/ui-core";
import { CaretDownIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useId, useState } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import { readSubagentGroup, subagentEntriesEqual } from "../lib/subagent-group.ts";
import { SubagentElapsed, SubagentRow, subagentTones } from "./subagent-row.tsx";

/**
 * A launch's subagents in the transcript, in the transcript's plain row style (no card). One
 * subagent is just its row. Several get a one-line disclosure ("3 subagents · 2 done · 1
 * working") over their rows. A status shows once: the header's counts, then each row's dot, or
 * its words only when it needs attention.
 */
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
  const title = `${entries.length} ${entries.length === 1 ? "subagent" : "subagents"}`;
  const rows = (
    <ul aria-label="Subagents">
      {entries.map((entry) => (
        <SubagentRow key={entry.id} threadId={props.threadId} entry={entry} fresh={live.fresh} />
      ))}
    </ul>
  );
  if (entries.length === 1)
    return (
      <section aria-label={title} className="py-1">
        {rows}
      </section>
    );
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const startedAt = Math.min(...entries.map((entry) => entry.startedAt));
  const ends = entries.flatMap((entry) => (entry.endedAt === undefined ? [] : [entry.endedAt]));
  const endedAt = !running && ends.length === entries.length ? Math.max(...ends) : undefined;
  const line = subagentStatusLine(states);
  const tone = states.includes("human")
    ? subagentTones.human
    : states.includes("failed") || states.includes("unresponsive")
      ? subagentTones.failed
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
        className="flex min-h-(--row-height) pointer-coarse:min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-(--surface-inset) text-left text-ui transition-colors duration-(--motion-fast) hover:bg-accent focus-ring-inset"
      >
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{title}</span>
          <span aria-hidden className="text-subtle-foreground">
            {" · "}
          </span>
          <span id={`${body}-status`} role="status" className={tone}>
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
        {open && rows}
      </div>
    </section>
  );
}
