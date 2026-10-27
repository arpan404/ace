import type { AutomationRun } from "@ace/protocol";
import { runTurn, workingFor } from "@ace/ui-core/automations";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Prose } from "@/components/markdown/prose.tsx";
import { SkeletonText } from "@/components/ui/skeleton.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow, useSeconds } from "@/lib/time.ts";
import { useAutomationHistory } from "@/features/automation-data/index.ts";
import type { AutomationSource } from "@ace/protocol";

/*
 * An automation's runs as the turns of its conversation, oldest first: a date divider, how long
 * it worked, its answer, and a link to the run's own thread. A run still going shows the live
 * "Working for" line; a failed one says what happened in a sentence with text actions.
 */

/** The transcript's answer prose: reading size and line height. */
export const answer =
  "min-w-0 font-prose text-prose leading-[1.6] tracking-[-0.005em] wrap-break-word";

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

/** A status turn's head (trigger stopped, GitHub check failing): the same row as a run's. */
export function TurnDivider(props: { status?: { tone: string; word: string }; when: string }) {
  return <TurnHead when={props.when} status={props.status} />;
}

/** The turn's head, like the thread's "Worked for" row: date, how it went, a hairline under it. */
function TurnHead(props: {
  when: string;
  status?: { tone: string; word: string } | undefined;
  detail?: string | undefined;
  threadId?: string | undefined;
  live?: boolean;
}) {
  const words = (
    <>
      {props.status && (
        <span data-tone={props.status.tone} className="font-medium text-(--tone-text)">
          {props.status.word}
          {dot}
        </span>
      )}
      <span className="tabular-nums">{props.when}</span>
      {props.detail && (
        <>
          {dot}
          {props.detail}
        </>
      )}
    </>
  );
  // Flush with the column, so its hairline lines up with the bubble and the composer.
  const shape =
    "flex min-h-8 items-center gap-1 border-b border-border py-1 text-ui text-muted-foreground pointer-coarse:min-h-11";
  return props.threadId ? (
    <Link
      to="/t/$threadId"
      params={{ threadId: props.threadId }}
      aria-label={`Open run, ${props.when}`}
      className={cn(
        shape,
        "transition-colors duration-(--motion-fast) hover:text-foreground focus-ring-inset",
      )}
    >
      {words}
      <CaretRightIcon aria-hidden size={12} className="text-faint-foreground" />
    </Link>
  ) : (
    <div role={props.live ? "status" : undefined} className={shape}>
      {words}
    </div>
  );
}

function Working(props: { run: AutomationRun }) {
  const now = useSeconds(true);
  return <>{workingFor(props.run, now)}</>;
}

function RunTurn(props: {
  run: AutomationRun;
  timezone: string | undefined;
  onRunAgain(): void;
  runDisabled: boolean;
}) {
  const { run } = props;
  const now = useNow();
  const turn = runTurn(run, now, props.timezone);
  return (
    <article aria-label={`Run, ${turn.when}`} className="mt-10 flex flex-col gap-3">
      <TurnHead
        when={turn.when}
        status={turn.status}
        detail={turn.detail}
        live={turn.live}
        threadId={run.threadId}
      />
      {(turn.note || turn.live) && (
        <p role="status" className="text-ui text-muted-foreground">
          {turn.live ? <Working run={run} /> : turn.note}
        </p>
      )}
      {turn.body !== undefined && (
        <div className={cn(answer, turn.muted && "text-muted-foreground")}>
          <Prose text={turn.body} />
        </div>
      )}
      {turn.runAgain && (
        <div className="text-ui">
          <TextAction strong onClick={props.onRunAgain} disabled={props.runDisabled}>
            Run again
          </TextAction>
        </div>
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
