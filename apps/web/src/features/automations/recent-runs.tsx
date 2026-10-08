import type { AutomationRun } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useNow } from "@/lib/time.ts";
import { runKey } from "@/lib/activity-item-keys.ts";
import { runSummary, runTone, runDurationMinutes } from "./labels.ts";
import { formatWhen } from "./schedule.ts";
import { useAutomationRuns } from "./use-automations.ts";

/** An automation's recent runs, newest first; each opens its thread, or its details. */
export function RecentRuns(props: { automationId: string }) {
  const runs = useAutomationRuns();
  const mine = useMemo(
    () => (runs.data ?? []).filter((run) => run.automationId === props.automationId),
    [runs.data, props.automationId],
  );
  return (
    <SettingSection label="Recent runs">
      {runs.data === undefined ? (
        runs.isError ? (
          <p className="border-t py-3.5 text-sm text-muted-foreground">
            Couldn't load recent runs.
          </p>
        ) : (
          <ListSkeleton label="recent runs" shape="row" rows={3} />
        )
      ) : mine.length ? (
        <ul aria-label="Recent runs">
          {mine.map((run) => (
            <RunItem key={run.id} run={run} />
          ))}
        </ul>
      ) : (
        <p className="border-t py-3.5 text-sm text-muted-foreground">
          No runs yet. Run it now to see what it does.
        </p>
      )}
    </SettingSection>
  );
}

const triggerShort: Record<AutomationRun["trigger"], string> = {
  schedule: "Scheduled",
  github: "GitHub event",
  file: "File change",
  manual: "By hand",
};

/** How long a finished run took, "4 min"; undefined while it runs. */
function took(run: AutomationRun): string | undefined {
  const minutes = runDurationMinutes(run);
  return minutes === undefined ? undefined : `${minutes} min`;
}

const fullDate = (at: number) =>
  new Date(at).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });

/** "Today 02:00 · 4 min · Scheduled". */
function runLine(run: AutomationRun, now: number): string {
  return [formatWhen(run.startedAt, now), took(run), triggerShort[run.trigger]]
    .filter(Boolean)
    .join(" · ");
}

function RunItem(props: { run: AutomationRun }) {
  const { run } = props;
  const now = useNow();
  const summary = runSummary(run);
  return (
    <li className="flex items-center gap-4 border-t py-3.5 last:border-b">
      {run.status === "running" ? <Spinner /> : <Dot tone={runTone(run)} label={run.status} />}
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium">{summary}</div>
        <div title={fullDate(run.startedAt)} className="mt-0.5 text-sm text-muted-foreground">
          {runLine(run, now)}
        </div>
      </div>
      <Link
        to="/activity"
        search={{ item: runKey(run.id) }}
        aria-label={`Open the run ${summary}`}
        className={buttonVariants({ variant: "ghost", size: "sm" })}
      >
        Open
      </Link>
    </li>
  );
}
