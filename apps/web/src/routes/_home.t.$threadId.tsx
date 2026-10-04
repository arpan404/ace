import { createFileRoute } from "@tanstack/react-router";
import { deckLaneParts } from "@/features/deck/index.ts";
import { ThreadPartsProvider } from "@/features/panels/index.ts";
import { ThreadView } from "@/features/thread/index.ts";

export const Route = createFileRoute("/_home/t/$threadId")({ component: ThreadRoute });

function ThreadRoute() {
  const { threadId } = Route.useParams();
  // Deck's lane views for the thread's workspace tabs; their code loads when a lane first shows.
  return (
    <ThreadPartsProvider value={deckLaneParts}>
      <ThreadView key={threadId} threadId={threadId} />
    </ThreadPartsProvider>
  );
}
