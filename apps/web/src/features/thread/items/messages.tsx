import type { ThreadReader } from "@ace/client";
import { useAgent, useItem, useThread } from "@ace/client-react";
import { agentName, forkPointOf, formatClock, saidAt, sameForkPoint } from "@ace/ui-core";
import { GitForkIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback } from "react";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";
import { useAnswerText } from "./answer-text.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { DeferredCopyAnswer } from "./deferred-review.ts";
import { messageActions } from "./message-actions.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";
import { RetryAnswerButton, useRetryPoint } from "../transitions/message-edits.tsx";
import { useStreaming } from "../transcript/use-streaming.ts";

const RewindControl = lazy(() =>
  import("../transitions/rewind-control.tsx").then((module) => ({ default: module.RewindControl })),
);

const CopyAnswer = DeferredCopyAnswer.Component;

/**
 * Agent prose. A subagent's message carries its name, as the design's "reconnect-audit found…".
 * What the agent says between its steps reads as plain prose in the work log (`between`): no
 * time or actions under it. A finished answer's time and actions sit under it on hover or focus
 * (always on touch), laid over the room under the row, so they cost the answer no height and
 * nothing moves when it finishes.
 */
export function AssistantMessage(props: { threadId: string; itemId: string; between?: boolean }) {
  const item = useItem(props.threadId, props.itemId);
  const agent = useAgent(props.threadId, item?.agentId ?? "");
  const subagent = agent && agent.origin !== "root" ? agent : undefined;
  // The call that started a subagent names it when the agent has no name of its own.
  const spawn = useItem(props.threadId, subagent?.spawnedBy ?? "");
  // Text left incomplete by a turn that stopped or failed no longer streams.
  const streaming = useStreaming(props.threadId, item);
  const answer = useAnswerText(item);
  const retry = useRetryPoint(props.threadId, props.itemId);
  if (item?.type !== "message") return null;
  const text = answer.text;
  const name = subagent ? agentName(subagent, spawn) : undefined;
  const pi = (item.executionSource?.selection.provider ?? agent?.native.provider) === "pi";
  return (
    <div className="group/answer relative min-w-0 font-prose text-prose leading-[1.6] tracking-[-0.005em] wrap-break-word">
      <Prose
        text={text}
        thread={{
          threadId: props.threadId,
          itemId: item.id,
          ...(agent?.cwd ? { cwd: agent.cwd } : {}),
        }}
        stream={`${props.threadId}/${props.itemId}`}
        streaming={streaming}
        tail={
          streaming && (
            <span
              role="status"
              aria-label="Streaming"
              className="ml-0.5 inline-block h-[1em] w-[3px] animate-pulse rounded-full bg-current align-[-0.15em] text-muted-foreground"
            />
          )
        }
      />
      {answer.partial && (
        <div className="mt-2 text-xs text-muted-foreground">
          {answer.status === "loading" ? (
            <p role="status">Loading full answer…</p>
          ) : answer.retryable ? (
            <Button size="sm" onClick={answer.load}>
              Try again
            </Button>
          ) : null}
          {answer.problem && <p role="alert">{answer.problem}</p>}
        </div>
      )}
      {!props.between && (item.complete || (answer.truncated && !streaming)) && (
        <div className={cn(messageActions("answer"), "absolute top-full left-0")}>
          <time
            dateTime={new Date(saidAt(item)).toISOString()}
            className="text-xs text-subtle-foreground"
          >
            {formatClock(saidAt(item))}
          </time>
          <Suspense fallback={null}>
            <CopyAnswer
              key={answer.partial ? "preview" : "answer"}
              text={text}
              label={answer.partial ? "Copy preview" : "Copy answer"}
            />
          </Suspense>
          {item.complete && !name && pi && retry && (
            <RetryAnswerButton threadId={props.threadId} point={retry} />
          )}
          {item.complete && !name && item.nativeId && pi && (
            <Suspense fallback={null}>
              <RewindControl threadId={props.threadId} entryId={item.nativeId} />
            </Suspense>
          )}
          {item.complete && !name && <ForkHere threadId={props.threadId} itemId={props.itemId} />}
        </div>
      )}
    </div>
  );
}

/** Under a finished answer of the main agent, on hover: fork the thread from that turn. */
function ForkHere(props: { threadId: string; itemId: string }) {
  const open = useForkOpener();
  const read = useCallback(
    (reader: ThreadReader) => {
      const item = reader.item(props.itemId);
      return forkPointOf(item, item?.runId === undefined ? undefined : reader.run(item.runId));
    },
    [props.itemId],
  );
  const item = useItem(props.threadId, props.itemId);
  const keys = [
    `item:${props.itemId}`,
    ...(item?.runId ? [`run:${item.runId}` as const] : []),
  ] as const;
  const point = useThread(props.threadId, keys, read, sameForkPoint);
  if (!open || !point) return null;
  return (
    <IconButton icon={GitForkIcon} label="Fork from here" size="sm" onClick={() => open(point)} />
  );
}
