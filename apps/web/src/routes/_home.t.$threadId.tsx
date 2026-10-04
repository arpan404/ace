import { createFileRoute } from "@tanstack/react-router";
import { lazy } from "react";
import { ThreadPartsProvider, type ThreadParts } from "@/features/panels/index.ts";
import { ThreadView } from "@/features/thread/index.ts";

export const Route = createFileRoute("/_home/t/$threadId")({ component: ThreadRoute });

/** Deck's lane views for the thread's workspace tabs, loaded when a lane tab first shows. */
const deck = () => import("@/features/deck/index.ts");
const parts: ThreadParts = {
  DeckLane: lazy(() => deck().then((m) => ({ default: m.DeckLaneTab }))),
  DeckOfThread: lazy(() => deck().then((m) => ({ default: m.DeckOfThread }))),
};

function ThreadRoute() {
  const { threadId } = Route.useParams();
  return (
    <ThreadPartsProvider value={parts}>
      <ThreadView key={threadId} threadId={threadId} />
    </ThreadPartsProvider>
  );
}
