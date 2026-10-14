import {
  effortLabel,
  modelName,
  nearLimitPercent,
  optionEffort,
  type TurnActivity,
} from "@ace/ui-core";
import type { Thread } from "@ace/protocol";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";
import { StatusGlyph } from "@/components/status-glyph.tsx";
import { WorkingIndicator } from "@/components/working-indicator.tsx";

/*
 * The Summary's first line: where the thread stands right now, in the live head's and the
 * sidebar's words. `[grid] Working for 12s` while an agent is in a turn; `● Waiting for your
 * answer` with Show while a request waits on the person; `Background · 1` once only commands
 * run; a hold as it is; otherwise "Nothing running". While something is live, the model and
 * effort follow, muted, with the context window when it is nearly full.
 */

export function SummaryHead(props: {
  activity: TurnActivity | undefined;
  /** Background commands still running. */
  background: number;
  thread: Pick<Thread, "provider" | "execution" | "live">;
  showRequest?: (() => void) | undefined;
}) {
  const { activity, background } = props;
  const state: ReactNode =
    activity?.tone === "working" ? (
      <WorkingIndicator
        label={activity.label}
        from={activity.elapsedFrom}
        className="shrink-0 text-foreground"
      />
    ) : activity?.tone === "needs-you" ? (
      <span className="flex min-w-0 items-center gap-2 text-foreground">
        <StatusGlyph state="needs-you" />
        <span className="min-w-0 truncate">{activity.label}</span>
      </span>
    ) : background > 0 ? (
      <span className="flex shrink-0 items-center gap-2 text-foreground">
        <StatusGlyph state="background" />
        <span>Background · {background}</span>
      </span>
    ) : activity ? (
      <span className="flex min-w-0 items-center gap-2">
        <StatusGlyph state="paused" />
        <span className="min-w-0 truncate">{activity.label}</span>
      </span>
    ) : (
      <span>Nothing running</span>
    );
  const live = activity?.tone === "working" || activity?.tone === "needs-you" || background > 0;
  const facts = live ? runFacts(props.thread) : [];
  return (
    <div
      data-summary-head
      className="flex min-h-8 min-w-0 items-center gap-2 px-2 text-ui text-muted-foreground"
    >
      {state}
      {facts.length > 0 && (
        <span className="ml-auto min-w-0 truncate text-xs text-subtle-foreground">
          {facts.join(" · ")}
        </span>
      )}
      {activity?.tone === "needs-you" && props.showRequest && (
        <Button
          size="sm"
          variant="secondary"
          className={facts.length ? "shrink-0" : "ml-auto shrink-0"}
          aria-label="Show the request"
          onClick={props.showRequest}
        >
          Show
        </Button>
      )}
    </div>
  );
}

/** "Opus 5.5 · High · Context 86%": the model and effort the turn runs on, its window if full. */
function runFacts(thread: Pick<Thread, "provider" | "execution" | "live">): string[] {
  const execution = thread.execution;
  const model = execution?.model ?? thread.live?.model;
  const effort = optionEffort(execution?.options ?? thread.live?.options);
  const meter = thread.live?.contextMeter;
  const used = meter?.limit ? Math.round((meter.used / meter.limit) * 100) : 0;
  return [
    model && modelName(execution?.provider ?? thread.provider, model, model),
    effort && effortLabel(effort),
    used >= nearLimitPercent ? `Context ${Math.min(used, 100)}%` : undefined,
  ].filter((part): part is string => !!part);
}
