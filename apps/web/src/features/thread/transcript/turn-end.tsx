import type { ThreadKey, ThreadReader } from "@ace/client";
import type { Run } from "@ace/protocol";
import { formatElapsed } from "@ace/ui-core";
import { Suspense, useCallback, useMemo } from "react";
import { StopCircleIcon } from "@phosphor-icons/react";
import { GroupedSteps } from "../items/step-groups-view.tsx";
import { SystemRow } from "../items/system-row.tsx";
import { DeferredFailedTurn } from "../items/deferred-review.ts";
import type { Block } from "./blocks.ts";
import type { Failure } from "./failure.ts";
import { useWatched, type Watched } from "@/lib/use-watched.ts";

const FailedTurn = DeferredFailedTurn.Component;

type EndBlock = Extract<Block, { kind: "end" }>;

/**
 * Failures seen on an agent's status while their turn was its latest, by run: a retry starts a
 * new turn and clears the status, but the failed turn keeps its reason. Until the daemon
 * reports failures on the run itself (C-A's `Run.error`), this lasts the session.
 */
const failures = new Map<string, Failure>();
const failureLimit = 256;
function remember(runId: string, failure: Failure) {
  if (failures.get(runId) === failure) return;
  failures.delete(runId);
  failures.set(runId, failure);
  if (failures.size > failureLimit) failures.delete(failures.keys().next().value ?? "");
}

function isFailure(value: unknown): value is Failure {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    typeof value.message === "string"
  );
}

/** The run's own failure, once the daemon reports it on the run. */
function runFailure(run: Run | undefined): Failure | undefined {
  const error: unknown = run && "error" in run ? run.error : undefined;
  return isFailure(error) ? error : undefined;
}

interface Ending {
  /** How long it ran, when known. */
  ranMs: number | undefined;
  /** Why it failed: the run's own reason, else the one seen on its agent while it was latest. */
  error: Failure | undefined;
  /** A usage-limit hold still in effect, with its reset time when known. */
  held: { until: number | undefined } | undefined;
}

const sameEnding = (a: Ending, b: Ending) =>
  a.ranMs === b.ranMs &&
  a.error === b.error &&
  a.held?.until === b.held?.until &&
  !a.held === !b.held;

function readEnding(reader: ThreadReader, block: EndBlock): Watched<Ending> {
  const run = block.runId ? reader.run(block.runId) : undefined;
  const agentId = run?.agentId ?? reader.thread?.rootAgentId;
  const status = agentId ? reader.agent(agentId)?.status : undefined;
  let error = runFailure(run) ?? (block.runId ? failures.get(block.runId) : undefined);
  if (!error && block.latest && status?.state === "failed") {
    error = status.error;
    if (block.runId) remember(block.runId, error);
  }
  const thread = reader.thread?.status;
  const held =
    block.ending === "paused" &&
    block.latest &&
    status?.state === "blocked" &&
    status.on === "rate_limit"
      ? { until: status.until ?? (thread?.state === "limited" ? thread.until : undefined) }
      : undefined;
  return {
    value: {
      ranMs: run?.endedAt === undefined ? undefined : run.endedAt - run.startedAt,
      error,
      held,
    },
    watch: agentId ? [`agent:${agentId}`] : [],
  };
}

/**
 * How a turn that didn't simply complete ended, kept in the transcript under its last block
 * (UX audit TS-4, TS-5, IR-15): a failed turn's reason with Retry and Details, a quiet
 * "Stopped by you", or where a usage limit paused it.
 */
export function TurnEnd(props: { threadId: string; block: EndBlock }) {
  const { block } = props;
  const keys = useMemo<readonly ThreadKey[]>(
    () => ["thread", ...(block.runId ? [`run:${block.runId}` as const] : [])],
    [block.runId],
  );
  const read = useCallback((reader: ThreadReader) => readEnding(reader, block), [block]);
  const ending = useWatched(props.threadId, keys, read, sameEnding);
  if (!ending) return null;
  if (block.ending === "paused") {
    // The limit itself is said in the composer's strip; history keeps only the work.
    const text =
      ending.ranMs !== undefined && ending.ranMs >= 1000
        ? `Worked for ${formatElapsed(ending.ranMs)}`
        : "Worked";
    return (
      <details
        role="note"
        aria-label={text}
        className="border-t border-border pt-2 text-xs text-muted-foreground"
      >
        <summary role="button" className="cursor-pointer py-1 focus-ring">
          {text}
        </summary>
        <GroupedSteps threadId={props.threadId} itemIds={block.itemIds ?? []} id={block.key} />
      </details>
    );
  }
  if (block.ending === "interrupted" && !block.automatic)
    // The person's Stop: a thin break, and their next message starts a new turn below it.
    return (
      <div
        role="note"
        aria-label="Interrupted by you"
        className="flex items-center justify-center gap-2 text-[11px] leading-4 text-subtle-foreground"
      >
        <span aria-hidden className="h-px w-6 bg-border" />
        Interrupted by you
        <span aria-hidden className="h-px w-6 bg-border" />
      </div>
    );
  if (block.ending === "interrupted") {
    const after =
      ending.ranMs !== undefined && ending.ranMs >= 1000
        ? ` · after ${formatElapsed(ending.ranMs)}`
        : "";
    // A restart (the app quit, the daemon restarted) is no stop the person made.
    const text = `Interrupted${after}`;
    return <SystemRow text={text} icon={<StopCircleIcon aria-hidden size={14} />} />;
  }
  return (
    <Suspense fallback={null}>
      <FailedTurn
        threadId={props.threadId}
        askId={block.askId}
        errorId={block.errorId}
        error={ending.error}
        latest={block.latest ?? false}
      />
    </Suspense>
  );
}
