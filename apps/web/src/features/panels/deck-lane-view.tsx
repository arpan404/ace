import { EmptyState } from "@/components/ui/empty.tsx";
import { CardsIcon } from "@phosphor-icons/react";
import { useThreadParts } from "./agents/thread-parts.ts";
import type { TabViewProps } from "@/lib/workspace/index.ts";

/** Which lane a tab shows: its data, else its id (`run/card`), as the strip persisted it. */
function laneOf(props: TabViewProps): { runId: string; cardId: string } | undefined {
  const data = props.tab.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "runId" in data &&
    "cardId" in data &&
    typeof data.runId === "string" &&
    typeof data.cardId === "string"
  )
    return { runId: data.runId, cardId: data.cardId };
  const [runId, cardId] = props.tab.id.split("/");
  return runId && cardId ? { runId, cardId } : undefined;
}

/** A deck lane as a workspace tab; Deck's view loads with the tab, not the thread screen. */
export function DeckLaneView(props: TabViewProps) {
  const { DeckLane } = useThreadParts();
  const lane = laneOf(props);
  if (!lane || !DeckLane)
    return (
      <EmptyState
        icon={CardsIcon}
        title="This lane can't show here"
        description="Deck lanes open beside a thread. Open the deck from the Deck view instead."
      />
    );
  return <DeckLane runId={lane.runId} cardId={lane.cardId} />;
}
