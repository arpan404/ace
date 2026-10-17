import {
  ThreadWindowProvider,
  useAgent,
  useClient,
  useItemOrder,
  useThread,
  useThreadStore,
} from "@ace/client-react";
import { Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { BlockView } from "../items/block-view.tsx";
import { DeferredFailedTurn } from "../items/deferred-review.ts";
import { Jump } from "../long/jump.ts";
import { useAgentBlocks } from "./use-blocks.ts";

const FailedTurn = DeferredFailedTurn.Component;

/**
 * A provider subagent's own transcript, as its whole chat: its work from the thread's loaded
 * window, without its parent's. Blocks render as they do in the main column. Earlier work reads
 * through a bounded history window beside the live tail, as the thread's own feed does (ADR
 * 0062), so paging back never evicts the live items still streaming in. Work in progress stays
 * behind the view's live line, as in a thread. A subagent that failed before its work showed a
 * turn ending still shows why, in the body.
 */
export function AgentTranscript(props: { threadId: string; agentId: string }) {
  const client = useClient();
  const live = useThreadStore(props.threadId);
  const [jump] = useState(() => new Jump(client, props.threadId));
  useEffect(
    () =>
      jump.setTail(() => ({
        order: live?.order ?? [],
        before: live?.itemsBefore,
        firstItemOf: () => undefined,
      })),
    [jump, live],
  );
  useEffect(() => () => jump.dispose(), [jump]);
  const state = useSyncExternalStore(jump.subscribe, jump.snapshot, jump.snapshot);
  // A joined window stops overlapping once the tail moves past it.
  const tailEnd = useItemOrder(props.threadId)?.at(-1);
  useEffect(() => {
    if (tailEnd !== undefined) jump.tailMoved();
  }, [jump, tailEnd]);
  const before = useThread(props.threadId, ["history"], (reader) => reader.itemsBefore);
  const window = state.window;
  const source = useMemo(
    () => (live && window ? jump.source(live, window, state.joined) : undefined),
    [jump, live, window, state.joined],
  );
  const loading = state.loading !== undefined;
  return (
    <ThreadWindowProvider threadId={props.threadId} source={source}>
      <AgentWork
        threadId={props.threadId}
        agentId={props.agentId}
        hasOlder={window ? window.before !== null : typeof before === "number"}
        loading={state.loading === "older"}
        onOlder={() => void jump.older()}
      />
      {window && !state.joined && (
        <div className="flex justify-center gap-2 pt-3">
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void jump.newer()}>
            {state.loading === "newer" && <Spinner />}
            Show later work
          </Button>
          <Button size="sm" variant="ghost" onClick={() => jump.live()}>
            Back to latest
          </Button>
        </div>
      )}
      {state.failed && <p className="text-ui text-muted-foreground pt-3">{state.failed}</p>}
    </ThreadWindowProvider>
  );
}

function AgentWork(props: {
  threadId: string;
  agentId: string;
  hasOlder: boolean;
  loading: boolean;
  onOlder: () => void;
}) {
  const built = useAgentBlocks(props.threadId, props.agentId);
  // A thread's live head and tail read the whole tree; the subagent's own live line replaces them.
  const blocks = useMemo(
    () => built.filter((block) => block.kind !== "live" && block.kind !== "thinking"),
    [built],
  );
  const status = useAgent(props.threadId, props.agentId)?.status;
  const failure =
    status?.state === "failed" && !blocks.some((block) => block.kind === "end")
      ? status.error
      : undefined;
  return (
    <div>
      {props.hasOlder && (
        <div className="flex justify-center pb-3">
          <Button size="sm" variant="ghost" disabled={props.loading} onClick={props.onOlder}>
            {props.loading && <Spinner />}
            Show earlier work
          </Button>
        </div>
      )}
      {blocks.length === 0 && !failure ? (
        <p className="text-ui text-muted-foreground">
          {props.hasOlder
            ? "Nothing from this subagent in the part of the thread loaded so far."
            : "This subagent hasn't written anything yet."}
        </p>
      ) : (
        <div role="feed" aria-label="Transcript" className="flex flex-col gap-3">
          {blocks.map((block, index) => (
            <article key={block.key} aria-posinset={index + 1} aria-setsize={-1}>
              <BlockView threadId={props.threadId} block={block} />
            </article>
          ))}
          {failure && (
            <article aria-posinset={blocks.length + 1} aria-setsize={-1}>
              <Suspense fallback={null}>
                <FailedTurn
                  threadId={props.threadId}
                  askId={undefined}
                  errorId={undefined}
                  error={failure}
                  latest={false}
                />
              </Suspense>
            </article>
          )}
        </div>
      )}
    </div>
  );
}
