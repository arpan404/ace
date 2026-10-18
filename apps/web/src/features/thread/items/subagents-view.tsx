import type { AgentFacts } from "@/lib/agent-facts.ts";
import {
  subagentGroupStatus,
  subagentStatusCounts,
  subagentTerminal,
  type SubagentGroupStatus,
} from "@ace/ui-core";
import { cardEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useAgentFacts } from "@/lib/use-agent-facts.ts";
import { useCallback, useId, useState, type CSSProperties } from "react";
import { useThreadLiveState } from "../lib/live-state.ts";
import {
  readSubagentGroup,
  subagentEntriesEqual,
  type SubagentEntry,
} from "../lib/subagent-group.ts";
import { SubagentAvatar, SubagentElapsed, SubagentRow, subagentTones } from "./subagent-row.tsx";
import { TranscriptRow, cardRowClass } from "./transcript-row.tsx";

const groupTones: Record<SubagentGroupStatus, string> = {
  human: "needs-you",
  failed: "failed",
  working: "working",
  done: "done",
};

/**
 * A launch's subagents in the transcript. One subagent is just its row. Several fold into one
 * two-line row (their stacked avatars, "3 subagents", then each status count in its tone),
 * opening to a hairline card of their rows. The group reads as its worst child: needs you,
 * failed, working, done, so it never reads done while any child works or waits.
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
  const [only] = entries;
  if (entries.length === 1 && only)
    return (
      <section aria-label={title}>
        <ul aria-label="Subagents">
          <SubagentRow threadId={props.threadId} entry={only} fresh={live.fresh} />
        </ul>
      </section>
    );
  const states = entries.map((entry) => entry.state);
  const running = states.some((state) => !subagentTerminal(state));
  const startedAt = Math.min(...entries.map((entry) => entry.startedAt));
  const ends = entries.flatMap((entry) => (entry.endedAt === undefined ? [] : [entry.endedAt]));
  const endedAt = !running && ends.length === entries.length ? Math.max(...ends) : undefined;
  const status = subagentGroupStatus(states);
  return (
    <section aria-label={title} data-group-status={status}>
      <TranscriptRow
        expanded={open}
        controls={body}
        onToggle={() => setOpen(!open)}
        label={title}
        tone="strong"
        lead={<AvatarStack entries={entries} />}
        title={title}
        subtitle={
          <span id={`${body}-status`} role="status" data-tone={groupTones[status]}>
            {!live.fresh && running && "Last seen: "}
            {subagentStatusCounts(states).map((part, index) => (
              <span key={part.state}>
                {index > 0 && <span className="text-subtle-foreground"> · </span>}
                <span data-tone={subagentTones[part.state]} className="text-(--tone-text)">
                  {part.count} {part.word}
                </span>
              </span>
            ))}
          </span>
        }
        meta={
          <SubagentElapsed
            startedAt={startedAt}
            endedAt={endedAt}
            running={running}
            fresh={live.fresh}
          />
        }
      />
      <div id={body} hidden={!open}>
        {open && (
          <ul aria-label="Subagents" className={cn("mt-1 rounded-card p-1", cardEdge)}>
            {entries.map((entry) => (
              <SubagentRow
                key={entry.id}
                threadId={props.threadId}
                entry={entry}
                fresh={live.fresh}
                className={cardRowClass}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** How far each avatar overlaps the one before it, and the gap its cut-out leaves. */
const overlap = 6;
const avatar = 20;

/** Every avatar but the last has the next one's circle cut out of it, so no ring is drawn. */
const stackCut: CSSProperties = {
  maskImage: `radial-gradient(circle at ${avatar * 1.5 - overlap}px 50%, transparent ${avatar / 2 + 1.5}px, #000 ${avatar / 2 + 2}px)`,
};

/** Up to three 20px provider avatars, overlapping by 6px. */
function AvatarStack(props: { entries: readonly SubagentEntry[] }) {
  const shown = props.entries.slice(0, 3);
  return (
    <span aria-hidden className="flex items-center">
      {shown.map((entry, index) => (
        <SubagentAvatar
          key={entry.id}
          size={20}
          provider={entry.provider}
          model={entry.model}
          className={index > 0 ? "-ml-1.5" : undefined}
          style={index < shown.length - 1 ? stackCut : undefined}
        />
      ))}
    </span>
  );
}
