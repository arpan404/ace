import type { AutomationRun } from "@ace/protocol";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SettingSection } from "@/components/setting-row.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useNow } from "@/lib/time.ts";
import { runSummary } from "./labels.ts";
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
  if (run.finishedAt === undefined) return undefined;
  return `${Math.max(1, Math.round((run.finishedAt - run.startedAt) / 60_000))} min`;
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
      {run.status === "running" ? (
        <Spinner />
      ) : (
        <Dot
          tone={run.status === "failed" ? "failed" : run.status === "skipped" ? "idle" : "done"}
          label={run.status}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium">{summary}</div>
        <div title={fullDate(run.startedAt)} className="mt-0.5 text-sm text-muted-foreground">
          {runLine(run, now)}
        </div>
      </div>
      {run.threadId ? (
        <Link
          to="/t/$threadId"
          params={{ threadId: run.threadId }}
          aria-label={`Open the thread for ${summary}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          Open
        </Link>
      ) : (
        <RunDetails run={run} summary={summary} />
      )}
    </li>
  );
}

const triggerWords: Record<AutomationRun["trigger"], string> = {
  schedule: "On its schedule",
  github: "A pull request event",
  file: "A file change",
  manual: "Run by hand",
};

/** A run that left no thread: what started it, when, and what it found. */
function RunDetails(props: { run: AutomationRun; summary: string }) {
  const { run } = props;
  const [open, setOpen] = useState(false);
  const now = useNow();
  const duration = took(run);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Open the run ${props.summary}`}
        onClick={() => setOpen(true)}
      >
        Open
      </Button>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{run.title}</DialogTitle>
          <DialogDescription>{props.summary}</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-ui">
          <dt className="text-muted-foreground">Started</dt>
          <dd title={fullDate(run.startedAt)}>{formatWhen(run.startedAt, now)}</dd>
          <dt className="text-muted-foreground">Took</dt>
          <dd>{duration ?? "Still running"}</dd>
          <dt className="text-muted-foreground">Trigger</dt>
          <dd>{triggerWords[run.trigger]}</dd>
        </dl>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
