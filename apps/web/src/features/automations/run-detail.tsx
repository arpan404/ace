import type { AutomationRun } from "@ace/protocol";
import { Link, useNavigate } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { useHotkey } from "@/lib/hotkeys.ts";
import { runSummary, runTone, runDurationMinutes } from "./labels.ts";

const triggers: Record<AutomationRun["trigger"], string> = {
  schedule: "On its schedule",
  github: "A GitHub event",
  file: "A file change",
  manual: "Run by hand",
};

/** The run's recorded outcome and the conversation it produced. */
export function AutomationRunDetail(props: { run: AutomationRun }) {
  const { run } = props;
  const navigate = useNavigate();
  useHotkey("o", () => {
    if (run.threadId) void navigate({ to: "/t/$threadId", params: { threadId: run.threadId } });
    else
      void navigate({
        to: "/automations/$automationId",
        params: { automationId: run.automationId },
      });
  });
  const duration = runDurationMinutes(run);
  return (
    <article aria-label={run.title}>
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Dot tone={runTone(run)} />
        Automation run
      </p>
      <h2 className="mt-2 text-xl leading-snug font-semibold tracking-title">{run.title}</h2>
      <p className="mt-3 whitespace-pre-wrap break-words text-ui">{runSummary(run)}</p>
      {run.status === "failed" && (
        <p className="mt-2 text-sm text-muted-foreground">
          Open the automation to check its settings and try again.
        </p>
      )}
      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-ui">
        <dt className="text-muted-foreground">Started</dt>
        <dd>
          {new Date(run.startedAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </dd>
        <dt className="text-muted-foreground">Took</dt>
        <dd>{duration === undefined ? "Still running" : `${duration} min`}</dd>
        <dt className="text-muted-foreground">Trigger</dt>
        <dd>{triggers[run.trigger]}</dd>
      </dl>
      <div className="mt-5 flex flex-wrap gap-2">
        {run.threadId && (
          <Link
            to="/t/$threadId"
            params={{ threadId: run.threadId }}
            className={buttonVariants({ variant: "primary" })}
          >
            Open thread
          </Link>
        )}
        <Link
          to="/automations/$automationId"
          params={{ automationId: run.automationId }}
          className={buttonVariants({ variant: run.threadId ? "ghost" : "primary" })}
        >
          Open automation
        </Link>
      </div>
    </article>
  );
}
