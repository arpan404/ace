import type { LinkedPullRequest, Thread, TurnSummary } from "@ace/protocol";
import {
  formatAgo,
  formatCount,
  formatSpan,
  optionEffort,
  pluralCount,
  providerNames,
  threadStatusLabel,
  threadStatusMark,
} from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { ProviderAccountIcon } from "@/components/ui/provider-account-icon.tsx";
import { threadGlyph } from "@ace/ui-core";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useNow } from "@/lib/time.ts";
import { agentModelLine } from "../agents/agent-details.ts";

const live = new Set<Thread["status"]["state"]>(["working", "waiting", "needs_you", "limited"]);

/**
 * The thread in one line: its live glyph and state, how many agents run and for how long, or
 * when it finished; the provider, model and effort it runs on, quiet at the right. The agent count is the live line's
 * (`subagentBranchStates`), so the two always agree.
 */
export function StatusLine(props: {
  thread: Pick<Thread, "status" | "updatedAt" | "execution" | "provider" | "acpAgentId">;
  running: number;
  turn: TurnSummary | undefined;
}) {
  const now = useNow();
  const fresh = useLiveConnection().fresh;
  const status =
    props.thread.status.state === "working" && props.running === 0
      ? { state: "waiting" as const, on: "background_task" as const }
      : props.thread.status;
  const { label, tone } =
    props.thread.status.state === "working" && props.running === 0
      ? { label: "Waiting", tone: "waiting" as const }
      : threadStatusLabel(status);
  const going = live.has(status.state);
  const facts = [label];
  if (going && props.running)
    facts.push(`${formatCount(props.running)} ${props.running === 1 ? "agent" : "agents"} running`);
  if (going && props.turn && props.turn.endedAt === undefined)
    facts.push(formatSpan(props.turn.startedAt, Math.max(now, props.turn.startedAt)));
  if (!going && status.state !== "new")
    facts.push(
      `${status.state === "done" ? "finished " : ""}${formatAgo(props.turn?.endedAt ?? props.thread.updatedAt, now)}`,
    );
  const selection = props.thread.execution;
  const provider = selection?.provider ?? props.thread.provider;
  const model = agentModelLine(selection?.model, optionEffort(selection?.options));
  const runsOn = [providerNames[provider], model].filter(Boolean).join(" · ");
  const line = facts.join(" · ");
  return (
    <div className="flex h-8 min-w-0 items-center gap-2 px-2 text-ui">
      <StatusGlyph
        state={threadGlyph({ tone, mark: threadStatusMark(status) })}
        tone={tone}
        size={14}
        still={!fresh}
      />
      <p
        role="status"
        aria-label={`Thread status: ${line}`}
        className="min-w-0 flex-1 truncate tabular-nums"
        title={line}
      >
        <span data-tone={tone} className="font-medium text-(--tone-text)">
          {label}
        </span>
        {facts.length > 1 && (
          <span className="text-muted-foreground"> · {facts.slice(1).join(" · ")}</span>
        )}
      </p>
      <span
        className="flex max-w-[45%] min-w-0 shrink items-center gap-1.5 text-xs text-subtle-foreground"
        title={runsOn}
      >
        <ProviderAccountIcon
          provider={provider}
          acpAgentId={props.thread.acpAgentId}
          instance={selection?.instanceId}
          size={14}
          tooltip={false}
          decorative
        />
        <span className="min-w-0 truncate">
          {/* In a narrow panel the mark names the provider; the model keeps the room. */}
          <span className={model ? "hidden @[30rem]/summary:inline" : undefined}>
            {providerNames[provider]}
            {model ? " · " : ""}
          </span>
          {model}
        </span>
      </span>
    </div>
  );
}

/**
 * The thread's work in figures, one quiet line under the status: pull requests merged and in
 * review, agents (total and live). Only figures with something to count show, always in the same
 * order, so live updates change numbers in place instead of reflowing a grid.
 */
export function StatsStrip(props: {
  prs: readonly LinkedPullRequest[];
  agents: number;
  live: number;
}) {
  const merged = props.prs.filter((pr) => pr.state === "merged").length;
  const open = props.prs.filter((pr) => pr.state === "open" || pr.state === "draft").length;
  const figures: string[] = [];
  if (merged) figures.push(`${pluralCount(merged, "PR")} merged`);
  if (open) figures.push(`${pluralCount(open, "PR")} in review`);
  if (props.agents)
    figures.push(
      `${pluralCount(props.agents, "agent")}${props.live ? ` (${formatCount(props.live)} live)` : ""}`,
    );
  if (!figures.length) return null;
  const line = figures.join(" · ");
  return (
    <p aria-label="Thread figures" className="px-2 text-xs text-muted-foreground tabular-nums">
      {line}
    </p>
  );
}
