import type { ThreadKey, ThreadReader } from "@ace/client";
import { useClient, useItem, useThreadMeta } from "@ace/client-react";
import { ThreadId, type AgentStatus, type ContentPart, type Item, type Run } from "@ace/protocol";
import { describeProviderError, formatElapsed, pauseLabel, providerNames } from "@ace/ui-core";
import { HourglassMediumIcon, StopIcon } from "@phosphor-icons/react";
import { useCallback, useMemo, useState } from "react";
import { Marker, MarkerContent } from "@/components/ui/marker.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { ErrorRow, noticeError } from "../items/error-row.tsx";
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
      errorId={block.errorId}
      error={ending.error}
      latest={block.latest ?? false}
    />
  );
}

/** The person's message again, as input: its text, images and files. */
function resend(item: Item | undefined): ContentPart[] {
  if (item?.type !== "message") return [];
  return item.parts.map((part) =>
    part.type === "text" ? { type: "text", text: part.text } : part,
  );
}

/** Actions that fix the failure where it is; Retry would only fail again. */
const fixes = new Set(["sign_in", "switch_account", "change_model"]);

/**
 * A failed turn as one row: the failure in words from the notice that reported it, else from the
 * run, else from the agent while the turn was its latest; the action that fixes it (sign in,
 * another account, another model), or Retry on the newest turn; the provider's text in Details.
 */
function FailedTurn(props: {
  threadId: string;
  askId: string | undefined;
  errorId: string | undefined;
  error: Failure | undefined;
  latest: boolean;
}) {
  const { error, latest } = props;
  const provider = useThreadMeta(props.threadId)?.provider;
  const ask = useItem(props.threadId, props.askId ?? "");
  const notice = useItem(props.threadId, props.errorId ?? "");
  const client = useClient();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const input = resend(ask);
  const reported = notice?.type === "notice" ? noticeError(notice) : undefined;
  const view = describeProviderError(
    reported
      ? { ...reported, provider: reported.provider ?? provider }
      : {
          text: error?.message ?? "",
          kind: error?.kind,
          provider,
          // Details names the failure's kind as the daemon reported it.
          detail: error ? `${error.kind}: ${error.message}` : undefined,
        },
  );
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
  const fixable = latest && view.action !== undefined && fixes.has(view.action);
  // Nothing said why: "Turn failed" alone. A fix names the failure itself ("Not signed in").
  const known = reported !== undefined || error !== undefined;
  const failed = known ? view : { title: "Turn failed" };
  return (
    <ErrorRow
      error={fixable ? failed : { ...failed, action: undefined }}
      heading={fixable || !known ? undefined : "Turn failed"}
      onRetry={latest && input.length > 0 && !fixable ? () => void retry() : undefined}
      retrying={sending}
    />
  );
}
