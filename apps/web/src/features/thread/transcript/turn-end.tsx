import type { ThreadReader } from "@ace/client";
import { useClient, useItem, useThread, useThreadMeta } from "@ace/client-react";
import { ThreadId, type AgentStatus, type ContentPart, type Item } from "@ace/protocol";
import { formatElapsed, providerNames, rootRunOf } from "@ace/ui-core";
import { StopIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { useCallback, useId, useMemo, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { useToast } from "@/components/ui/toast.tsx";

type Failure = Extract<AgentStatus, { state: "failed" }>["error"];

/** How a turn that didn't complete ended, as the transcript shows it. */
interface Ending {
  state: "failed" | "interrupted";
  /** The failure, while it is the agent's latest (older turns keep only that they failed). */
  error: Failure | undefined;
  /** The turn's newest: it can be retried. */
  latest: boolean;
  /** How long it ran, when known. */
  ranMs: number | undefined;
  /** Something other than the person stopped it (a restart picked up where it left off). */
  automatic: boolean;
}

/** The root turn of the newest loaded item that has one. */
function newestTurn(reader: ThreadReader): string | undefined {
  for (let index = reader.order.length - 1; index >= 0; index--) {
    const item = reader.item(reader.order[index] ?? "");
    const run = rootRunOf(reader, item?.runId);
    if (run) return run.id;
  }
  return undefined;
}

/** The trigger of the root turn after `ordinal`, if it is loaded. */
function nextTrigger(reader: ThreadReader, ordinal: number | undefined): string | undefined {
  if (ordinal === undefined) return undefined;
  for (const id of reader.order) {
    const run = rootRunOf(reader, reader.item(id)?.runId);
    if (run?.ordinal === ordinal + 1) return run.trigger;
  }
  return undefined;
}

function readEnding(reader: ThreadReader, runId: string | undefined): Ending | undefined {
  const rootId = reader.thread?.rootAgentId;
  const status = rootId ? reader.agent(rootId)?.status : undefined;
  const run = runId ? reader.run(runId) : undefined;
  const latest = runId === undefined || newestTurn(reader) === runId;
  const state = run
    ? run.state
    : status?.state === "failed" || status?.state === "interrupted"
      ? status.state
      : undefined;
  if (state !== "failed" && state !== "interrupted") return undefined;
  const trigger = state === "interrupted" ? nextTrigger(reader, run?.ordinal) : undefined;
  return {
    state,
    error: latest && status?.state === "failed" ? status.error : undefined,
    latest,
    ranMs: run?.endedAt === undefined ? undefined : run.endedAt - run.startedAt,
    automatic: trigger === "restart" || trigger === "limit_resume",
  };
}

const sameEnding = (a: Ending | undefined, b: Ending | undefined) =>
  a === b ||
  (!!a &&
    !!b &&
    a.state === b.state &&
    a.error?.kind === b.error?.kind &&
    a.error?.message === b.error?.message &&
    a.latest === b.latest &&
    a.ranMs === b.ranMs &&
    a.automatic === b.automatic);

/** The person's message again, as input: its text, images and files. */
function resend(item: Item | undefined): ContentPart[] {
  if (item?.type !== "message") return [];
  return item.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : part,
  );
}

/**
 * How a turn that didn't complete ended, kept in the transcript under its last block (UX audit
 * TS-4, TS-5): a failed turn's reason with Retry and Details, or a quiet "Stopped by you".
 */
export function TurnEnd(props: {
  threadId: string;
  runId: string | undefined;
  askId: string | undefined;
}) {
  const rootId = useThreadMeta(props.threadId)?.rootAgentId ?? "";
  const { runId } = props;
  const keys = useMemo(
    () =>
      ["order", "agents", `agent:${rootId}`, ...(runId ? [`run:${runId}` as const] : [])] as const,
    [rootId, runId],
  );
  const read = useCallback((reader: ThreadReader) => readEnding(reader, runId), [runId]);
  const ending = useThread(props.threadId, keys, read, sameEnding);
  if (!ending) return null;
  if (ending.state === "interrupted") {
    const after =
      ending.ranMs !== undefined && ending.ranMs >= 1000
        ? ` · after ${formatElapsed(ending.ranMs)}`
        : "";
    const text = `${ending.automatic ? "Stopped" : "Stopped by you"}${after}`;
    return (
      <Marker role="note" aria-label={text} variant="separator" className="text-xs">
        <MarkerContent className="flex items-center gap-1.5">
          <StopIcon aria-hidden size={12} weight="fill" />
          {text}
        </MarkerContent>
      </Marker>
    );
  }
  return <FailedTurn threadId={props.threadId} askId={props.askId} ending={ending} />;
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

function FailedTurn(props: { threadId: string; askId: string | undefined; ending: Ending }) {
  const { error, latest } = props.ending;
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
