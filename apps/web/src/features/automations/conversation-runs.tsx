import type { AutomationRun } from "@ace/protocol";
import { formatElapsed } from "@ace/ui-core";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow, useSeconds } from "@/lib/time.ts";
import { formatWhen } from "@/features/automation-schedule/index.ts";
import { useAutomationHistory } from "@/features/automation-data/index.ts";
import type { AutomationSource } from "@ace/protocol";

/*
 * An automation's runs as the turns of its conversation, oldest first: a date divider, how long
 * it worked, its answer, and a link to the run's own thread. A run still going shows the live
 * "Working for" line; a failed one says what happened in a sentence with text actions.
 */

/** The transcript's answer prose: reading size and line height. */
const answer = "min-w-0 font-prose text-prose leading-[1.6] tracking-[-0.005em] wrap-break-word";
/** The transcript's one-line rows ("Worked for 3m 40s"), flush with the column. */
const row =
  "-mx-2 flex min-h-8 w-[calc(100%+--spacing(4))] items-center gap-1 rounded-md px-2 py-1 text-ui text-muted-foreground pointer-coarse:min-h-11";

/** A plain text action inside a sentence: "Run again", "Open run". */
export function TextAction(props: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  disabled?: boolean | undefined;
  strong?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        "rounded-xs focus-ring hover:underline disabled:pointer-events-none disabled:opacity-50",
        props.strong ? "font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      {props.children}
    </button>
  );
}

const dot = (
  <span aria-hidden className="text-faint-foreground">
    {" · "}
  </span>
);

/** "Failed · Today 2:00 AM ────": the turn's date, a status word when it needs one, a hairline. */
export function TurnDivider(props: { status?: { tone: string; word: string }; when: string }) {
  return (
    <div className="flex items-center gap-3 text-xs text-subtle-foreground">
      <span className="shrink-0 tabular-nums">
        {props.status && (
          <>
            <span data-tone={props.status.tone} className="font-medium text-(--tone-text)">
              {props.status.word}
            </span>
            {" · "}
          </>
        )}
        {props.when}
      </span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

function OpenRun(props: { threadId: string; children: ReactNode; className?: string }) {
  return (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      className={cn(
        "rounded-xs text-muted-foreground focus-ring hover:text-foreground",
        props.className,
      )}
    >
      {props.children}
    </Link>
  );
}

function WorkingLine(props: { startedAt: number }) {
  const now = useSeconds(true);
  return (
    <div role="status" className={row}>
      Working for {formatElapsed(now - props.startedAt)}
    </div>
  );
}

function WorkedLine(props: { run: AutomationRun & { finishedAt: number } }) {
  const label = `Worked for ${formatElapsed(props.run.finishedAt - props.run.startedAt)}`;
  const threadId = props.run.threadId;
  return threadId ? (
    <Link
      to="/t/$threadId"
      params={{ threadId }}
      className={cn(
        row,
        "transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground focus-ring-inset",
      )}
    >
      {label}
      <CaretRightIcon aria-hidden size={12} className="text-faint-foreground" />
    </Link>
  ) : (
    <div className={row}>{label}</div>
  );
}

function RunTurn(props: {
  run: AutomationRun;
  timezone: string | undefined;
  onRunAgain(): void;
  runDisabled: boolean;
}) {
  const { run } = props;
  const now = useNow();
  const when = formatWhen(run.startedAt, now, props.timezone);
  const status =
    run.status === "failed"
      ? { tone: "failed", word: "Failed" }
      : run.status === "skipped"
        ? { tone: "idle", word: "Skipped" }
        : undefined;
  return (
    <article aria-label={`Run, ${when}`} className="mt-8 flex flex-col gap-3">
      <TurnDivider when={when} {...(status ? { status } : {})} />
      {run.status === "running" && <WorkingLine startedAt={run.startedAt} />}
      {run.status === "succeeded" && run.finishedAt !== undefined && (
        <WorkedLine run={{ ...run, finishedAt: run.finishedAt }} />
      )}
      {run.status === "succeeded" && run.result && (
        <div className={answer}>
          <Prose text={run.result} />
        </div>
      )}
      {run.status === "failed" && (
        <p className="text-ui">
          {run.result ?? "The run stopped before it finished."}{" "}
          <TextAction strong onClick={props.onRunAgain} disabled={props.runDisabled}>
            Run again
          </TextAction>
          {run.threadId && (
            <>
              {dot}
              <OpenRun threadId={run.threadId} className="hover:underline">
                Open run
              </OpenRun>
            </>
          )}
        </p>
      )}
      {run.status === "skipped" && (
        <p className="text-ui text-muted-foreground">{run.result ?? "Nothing to do this time."}</p>
      )}
      {run.status === "succeeded" && run.threadId && (
        <OpenRun threadId={run.threadId} className="inline-flex w-fit items-center gap-1 text-ui">
          Open run
          <CaretRightIcon aria-hidden size={12} className="text-faint-foreground" />
        </OpenRun>
      )}
    </article>
  );
}

/** Every run of this automation as a turn, oldest first, with older pages on demand. */
export function ConversationRuns(props: {
  automationId: string;
  source: AutomationSource;
  timezone: string | undefined;
  onRunAgain(): void;
  runDisabled: boolean;
}) {
  const history = useAutomationHistory(props.automationId, props.source);
  if (history.runs === undefined)
    return history.isError ? (
      <p className="mt-8 text-ui text-muted-foreground">
        Couldn't load this automation's runs.{" "}
        <TextAction strong onClick={() => void history.refetch()}>
          Try again
        </TextAction>
      </p>
    ) : (
      <SkeletonText lines={3} className="mt-8" />
    );
  const runs = history.runs.toReversed();
  return (
    <section aria-label="Runs">
      {history.hasNextPage && (
        <div className="mt-6 flex justify-center">
          <TextAction
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? "Loading older runs…" : "Show older runs"}
          </TextAction>
        </div>
      )}
      {runs.map((run) => (
        <RunTurn
          key={run.id}
          run={run}
          timezone={props.timezone}
          onRunAgain={props.onRunAgain}
          runDisabled={props.runDisabled}
        />
      ))}
      {history.isError && (
        <p className="mt-6 text-ui text-muted-foreground">
          Couldn't refresh the runs.{" "}
          <TextAction strong onClick={() => void history.refetch()}>
            Try again
          </TextAction>
        </p>
      )}
    </section>
  );
}
