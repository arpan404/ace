import type { ThreadReader } from "@ace/client";
import { useAgent, useItem, useThread } from "@ace/client-react";
import { formatClock } from "@ace/ui-core";
import { GitForkIcon } from "@phosphor-icons/react";
import { lazy, Suspense, useCallback } from "react";
import { Button } from "@/components/ui/button.tsx";
import { useAnswerText } from "./answer-text.ts";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { DeferredCopyAnswer } from "./deferred-review.ts";
import { forkPointOf } from "../transitions/fork-point.ts";
import { useForkOpener } from "../transitions/fork-opener.ts";
import { useStreaming } from "../transcript/use-streaming.ts";

const RewindControl = lazy(() =>
  import("../transitions/rewind-control.tsx").then((module) => ({ default: module.RewindControl })),
);

const CopyAnswer = DeferredCopyAnswer.Component;

/**
 * Agent prose. A subagent's message carries its name, as the design's "reconnect-audit found…".
 * What the agent says between its steps reads as plain prose in the work log (`between`): no
 * time or actions under it.
 */
export function AssistantMessage(props: {
  threadId: string;
  itemId: string;
  between?: boolean;
  /** Its turn's "Worked for" row already says when it ended. */
  timed?: boolean | undefined;
}) {
  const item = useItem(props.threadId, props.itemId);
  const agent = useAgent(props.threadId, item?.agentId ?? "");
  // Text left incomplete by a turn that stopped or failed no longer streams.
  const streaming = useStreaming(props.threadId, item);
  const answer = useAnswerText(item);
  if (item?.type !== "message") return null;
  const text = answer.text;
  const name = agent && agent.origin !== "root" ? (agent.name ?? "Subagent") : undefined;
  return (
    <div className="group/answer text-prose leading-[1.6] tracking-[-0.005em]">
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
          <p>Showing a preview of this answer.</p>
          {streaming ? (
            <p>Full text can be loaded once streaming stops.</p>
          ) : answer.status === "loading" ? (
            <p role="status">Loading full answer…</p>
          ) : (
            <Button size="sm" onClick={answer.load}>
              {answer.status === "failed" ? "Try again" : "Show full answer"}
            </Button>
          )}
          {answer.problem && <p role="alert">{answer.problem}</p>}
        </div>
      )}
      {!props.between && (item.complete || (answer.truncated && !streaming)) && (
        <div className="mt-1 flex min-h-6 items-center gap-2">
          {props.timed !== false && (
            <span className="text-xs text-subtle-foreground">{formatClock(item.createdAt)}</span>
          )}
          <div className="flex opacity-0 transition-opacity duration-(--motion-fast) group-focus-within/answer:opacity-100 group-hover/answer:opacity-100">
            <Suspense fallback={null}>
              <CopyAnswer
                key={answer.partial ? "preview" : "answer"}
                text={text}
                label={answer.partial ? "Copy preview" : "Copy answer"}
              />
            </Suspense>
            {item.complete &&
              !name &&
              item.nativeId &&
              (item.executionSource?.selection.provider ?? agent?.native.provider) === "pi" && (
                <Suspense fallback={null}>
                  <RewindControl threadId={props.threadId} entryId={item.nativeId} />
                </Suspense>
              )}
            {item.complete && !name && <ForkHere threadId={props.threadId} itemId={props.itemId} />}
          </div>
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
  const point = useThread(props.threadId, keys, read, samePoint);
  if (!open || !point) return null;
  return (
    <IconButton icon={GitForkIcon} label="Fork from here" size="sm" onClick={() => open(point)} />
  );
}

const samePoint = (a: ReturnType<typeof forkPointOf>, b: ReturnType<typeof forkPointOf>) =>
  JSON.stringify(a) === JSON.stringify(b);
