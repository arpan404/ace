import type { ThreadKey, ThreadReader } from "@ace/client";
import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { ThreadId, type AgentStatus, type ContentPart, type Item, type Run } from "@ace/protocol";
import { formatElapsed, pauseLabel, providerNames } from "@ace/ui-core";
import { HourglassMediumIcon, StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import type { Block } from "./blocks.ts";
import { useWatched, type Watched } from "./use-watched.ts";

type Failure = Extract<AgentStatus, { state: "failed" }>["error"];
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
  const provider = useThreadMeta(props.threadId)?.provider;
  if (!ending) return null;
  if (block.ending === "paused") {
    const text = pauseLabel(provider ? providerNames[provider] : undefined, ending.held);
    return (
      <Marker role="note" aria-label={text} variant="separator" className="text-xs">
        <MarkerContent className="flex items-center gap-1.5">
          <HourglassMediumIcon aria-hidden size={12} />
          {text}
        </MarkerContent>
      </Marker>
    );
  }
  if (block.ending === "interrupted") {
    const after =
      ending.ranMs !== undefined && ending.ranMs >= 1000
        ? ` · after ${formatElapsed(ending.ranMs)}`
        : "";
    const text = `${block.automatic ? "Stopped" : "Stopped by you"}${after}`;
    return (
      <Marker role="note" aria-label={text} variant="separator" className="text-xs">
        <MarkerContent className="flex items-center gap-1.5">
          <StopIcon aria-hidden size={12} weight="fill" />
          {text}
        </MarkerContent>
      </Marker>
    );
  }
  return (
    <FailedTurn
      threadId={props.threadId}
      askId={block.askId}
      error={ending.error}
      latest={block.latest ?? false}
    />
  );
}

/** "Not signed in to Claude Code", "Usage limit reached", or plainly "Turn failed". */
function failureTitle(error: Failure | undefined, provider: string | undefined): string {
  switch (error?.kind) {
    case "auth":
      return provider ? `Not signed in to ${provider}` : "Not signed in";
    case "quota":
      return "Usage limit reached";
    case "network":
      return "Network trouble";
    default:
      return "Turn failed";
  }
}

/** The person's message again, as input: its text, images and files. */
function resend(item: Item | undefined): ContentPart[] {
  if (item?.type !== "message") return [];
  return item.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : part,
  );
}

function FailedTurn(props: {
  threadId: string;
  askId: string | undefined;
  error: Failure | undefined;
  latest: boolean;
}) {
  const { error, latest } = props;
  const meta = useThreadMeta(props.threadId);
  const provider = meta ? providerNames[meta.provider] : undefined;
  const ask = useItem(props.threadId, props.askId ?? "");
  const client = useClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const [details, setDetails] = useState(false);
  const panel = useId();
  const title = failureTitle(error, provider);
  const input = resend(ask);
  const retry = async () => {
    setSending(true);
    try {
      await client.enqueue({
        type: "thread.send",
        threadId: ThreadId.parse(props.threadId),
        input,
        trigger: "user",
      });
    } catch {
      toast.add({ title: "Couldn't retry the turn" });
    } finally {
      setSending(false);
    }
  };
  const action =
    !latest || !error ? undefined : error.kind === "auth" ? (
      <Link to="/settings/providers" className={buttonVariants({ size: "sm" })}>
        Sign in
      </Link>
    ) : error.kind === "quota" ? (
      <Link to="/more/accounts" className={buttonVariants({ size: "sm" })}>
        Move to another account
      </Link>
    ) : undefined;
  return (
    <div role="group" aria-label={title} className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui">
        <WarningCircleIcon aria-hidden size={16} className="shrink-0 text-status-failed" />
        <span className="font-medium text-foreground">{title}</span>
        {error && error.kind !== "auth" && error.kind !== "quota" && (
          <span className="min-w-0 truncate text-muted-foreground">· {error.message}</span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {action}
          {latest && input.length > 0 && !action && (
            <Button size="sm" disabled={sending} onClick={() => void retry()}>
              Retry
            </Button>
          )}
          {error && (
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={details}
              aria-controls={panel}
              onClick={() => setDetails(!details)}
            >
              Details
            </Button>
          )}
        </span>
      </div>
      {details && error && (
        <pre
          id={panel}
          className="ml-6 overflow-x-auto rounded-md bg-secondary px-3 py-2 font-mono text-[12px] whitespace-pre-wrap text-muted-foreground"
        >
          {`${error.kind}: ${error.message}`}
        </pre>
      )}
    </div>
  );
}
