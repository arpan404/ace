import type { LinkedPullRequest, Thread, TurnSummary } from "@ace/protocol";
import {
  effortLabel,
  formatAgo,
  formatCount,
  formatSpan,
  modelLabel,
  optionEffort,
  threadStatusLabel,
  threadStatusMark,
} from "@ace/ui-core";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { threadGlyph } from "@/components/status-glyph-state.ts";
import { hairlineGrid } from "@/components/ui/rules.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useNow } from "@/lib/time.ts";

const live = new Set<Thread["status"]["state"]>(["working", "waiting", "needs_you", "limited"]);

/**
 * The thread in one line: its live glyph and state, how many agents run and for how long, or
 * when it finished; the model it runs on, quiet at the right. The agent count is the live line's
 * (`subagentBranchStates`), so the two always agree.
 */
export function StatusLine(props: {
  thread: Pick<Thread, "status" | "updatedAt" | "execution">;
  running: number;
  turn: TurnSummary | undefined;
}) {
  const now = useNow();
  const fresh = useLiveConnection().fresh;
  const { status } = props.thread;
  const { label, tone } = threadStatusLabel(status);
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
  const effort = optionEffort(selection?.options);
  const model = [selection?.model && modelLabel(selection.model), effort && effortLabel(effort)]
    .filter(Boolean)
    .join(" · ");
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
      {model && (
        <span className="max-w-[40%] shrink truncate text-xs text-subtle-foreground" title={model}>
          {model}
        </span>
      )}
    </div>
  );
}

/** One figure of the stats strip. */
interface Stat {
  label: string;
  value: string;
  sub?: string | undefined;
}

/**
 * The thread's work in figures: pull requests merged and in review, agents (total and live).
 * Only figures with something to count show; with none, there is no strip.
 */
export function StatsStrip(props: {
  prs: readonly LinkedPullRequest[];
  agents: number;
  live: number;
}) {
  const merged = props.prs.filter((pr) => pr.state === "merged").length;
  const open = props.prs.filter((pr) => pr.state === "open" || pr.state === "draft").length;
  const stats: Stat[] = [];
  if (merged) stats.push({ label: "PRs merged", value: formatCount(merged) });
  if (open) stats.push({ label: "In review", value: formatCount(open) });
  if (props.agents)
    stats.push({
      label: "Agents",
      value: formatCount(props.agents),
      sub: props.live ? `${formatCount(props.live)} live` : undefined,
    });
  if (stats.length < 2) return null;
  const odd = stats.length % 2 === 1;
  return (
    <div className="@container px-1">
      <dl
        aria-label="Thread figures"
        className={`${hairlineGrid} grid-cols-2 overflow-hidden rounded-md border border-border-soft ${wide[stats.length] ?? ""}`}
      >
        {stats.map((stat, index) => (
          <div
            key={stat.label}
            className={`flex min-w-0 flex-col gap-0.5 bg-panel px-2.5 py-2 ${odd && index === stats.length - 1 ? "col-span-2 @[520px]:col-span-1" : ""}`}
          >
            <dt className="truncate text-xs text-muted-foreground">{stat.label}</dt>
            <dd className="flex min-w-0 items-baseline gap-1.5">
              <span className="text-base font-medium text-foreground tabular-nums">
                {stat.value}
              </span>
              {stat.sub && (
                <span className="truncate text-xs text-subtle-foreground tabular-nums">
                  {stat.sub}
                </span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** At 520px and wider the figures sit in one row. */
const wide: Record<number, string> = {
  2: "@[520px]:grid-cols-2",
  3: "@[520px]:grid-cols-3",
  4: "@[520px]:grid-cols-4",
};
