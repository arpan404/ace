import type { AutomationRun } from "@ace/protocol";
import { useRef, useState } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { StatusLabel } from "@/components/status-label.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/lib/time.ts";
import { runSummary } from "./labels.ts";
import { RunOutput } from "./run-output.tsx";
import { formatWhen } from "./schedule.ts";
import { useAutomationHistory } from "./use-automations.ts";

/** Runs belong to this automation, newest first, with older pages on demand. */
export function RecentRuns(props: { automationId: string; timezone?: string | undefined }) {
  const history = useAutomationHistory(props.automationId);
  return (
    <SettingSection label="Recent runs">
      {history.runs === undefined ? (
        history.isError ? (
          <p className="py-2 text-sm text-muted-foreground">Couldn't load recent runs.</p>
        ) : (
          <ListSkeleton label="recent runs" shape="row" rows={3} />
        )
      ) : history.runs.length ? (
        <ul aria-label="Recent runs">
          {history.runs.map((run) => (
            <RunItem key={run.id} run={run} timezone={props.timezone} />
          ))}
        </ul>
      ) : (
        <p className="py-2 text-sm text-muted-foreground">
          No runs yet. Run it now to see what it does.
        </p>
      )}
      {history.isError && (
        <Button variant="ghost" size="sm" onClick={() => void history.refetch()}>
          Try again
        </Button>
      )}
      {history.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? "Loading…" : "Show older"}
        </Button>
      )}
    </SettingSection>
  );
}

const statuses = {
  running: { tone: "working", label: "Running…" },
  succeeded: { tone: "done", label: "Finished" },
  failed: { tone: "failed", label: "Failed" },
  skipped: { tone: "idle", label: "Skipped" },
} as const;
const triggers: Record<AutomationRun["trigger"], string> = {
  schedule: "Scheduled",
  github: "GitHub event",
  file: "File change",
  manual: "By hand",
};

function RunItem(props: { run: AutomationRun; timezone?: string | undefined }) {
  const { run } = props;
  const now = useNow();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const summary = runSummary(run);
  const status = statuses[run.status];
  return (
    <li className="border-t last:border-b">
      <button
        ref={opener}
        type="button"
        aria-label={`Open the run ${summary}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full items-center gap-3 rounded-sm text-left focus-ring-inset hover:bg-accent"
      >
        <span className="min-w-0 flex-1 truncate text-ui">
          {open || run.status === "running" ? triggers[run.trigger] : summary}
        </span>
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          title={new Date(run.startedAt).toLocaleString(undefined, { timeZone: props.timezone })}
        >
          {formatWhen(run.startedAt, now, props.timezone)}
        </span>
        <StatusLabel {...status} />
      </button>
      {open && (
        <section aria-label={`Run details for ${run.title}`} className="pb-3">
          <p className="text-sm text-muted-foreground">
            {triggers[run.trigger]}
            {run.finishedAt !== undefined &&
              ` · ${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000))} min`}
          </p>
          <RunOutput run={run} />
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
                opener.current?.focus();
              }}
            >
              Close
            </Button>
          </div>
        </section>
      )}
    </li>
  );
}
