import { Suspense, useCallback, useMemo, type ComponentProps } from "react";
import type { ThreadNav } from "../long/nav.tsx";
import { DeferredHeldSend } from "../composer/deferred-parts.tsx";
import { DeferredTurnKeys, DeferredTurnRail } from "../deferred.ts";
import { useDropTurnSteps } from "../lib/turn-steps.ts";
import { StoppedPill } from "../long/stopped-pill.tsx";
import { AgentPageReveal } from "./agent-page-reveal.tsx";
import type { Block } from "./blocks.ts";
import { FeedView, type FeedKeys, type FeedProps } from "./feed-view.tsx";
import { useRunOrdinals } from "./run-ordinals.ts";
import { useReadMarker } from "./seen.ts";
import { SettledLine } from "./settled-line.tsx";
import { useBlocks } from "./use-blocks.ts";
import { useTurnActivity } from "./use-turn-activity.ts";

export type { FeedProps } from "./feed-view.tsx";

const tailLive: Block = { kind: "live", key: "live:tail", askId: undefined };

/**
 * The thread's transcript: its rows with the turn's live line, the turn rail and keys, what is
 * on its way, and how the last turn settled.
 */
export function Feed(props: FeedProps) {
  const { threadId, nav, jump } = props;
  useReadMarker(threadId, nav);
  const detached = !!jump.window && !jump.joined;
  // Only the daemon's items: a message still on its way is in the composer's strip.
  const built = useBlocks(threadId);
  const activity = useTurnActivity(threadId);
  useDropTurnSteps(threadId);
  // The live turn's one status line heads its flow, under its ask; a turn with no block in view
  // yet (its ask still on its way, older than the window) keeps it at the end of the rows. Either way it is
  // one row, which moves rather than flashing out and back in.
  const working = !detached && !!activity && activity.tone !== "paused";
  const blocks = useMemo(
    () => (working && !built.some((block) => block.kind === "live") ? [...built, tailLive] : built),
    [built, working],
  );
  const runOrdinals = useRunOrdinals(threadId);
  const { seqTurns } = props;
  const ordinalOf = useCallback(
    (id: string) => runOrdinals.get(id) ?? seqTurns?.get(id),
    [runOrdinals, seqTurns],
  );
  return (
    <FeedView
      {...props}
      scrollKey={threadId}
      blocks={blocks}
      ordinalOf={ordinalOf}
      Rail={ThreadRail}
      end={
        <>
          <Suspense fallback={null}>
            <DeferredHeldSend.Component threadId={threadId} />
            <AgentPageReveal threadId={threadId} />
          </Suspense>
          {!working && <SettledLine threadId={threadId} />}
        </>
      }
      Keys={ThreadKeys}
      Pill={StoppedPill}
    />
  );
}

function ThreadRail(props: ComponentProps<typeof DeferredTurnRail.Component>) {
  return (
    <Suspense fallback={null}>
      <DeferredTurnRail.Component {...props} />
    </Suspense>
  );
}

function ThreadKeys(props: FeedKeys & { nav: ThreadNav }) {
  return (
    <Suspense fallback={null}>
      <DeferredTurnKeys.Component {...props} />
    </Suspense>
  );
}
