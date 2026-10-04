import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { deckLaneParts } from "@/features/deck/index.ts";
import { ThreadPartsProvider } from "@/features/panels/index.ts";
import { ThreadView } from "@/features/thread/index.ts";

/** `/t/<id>?seq=1234&q=words`: both optional; a link into the thread at an item (a search hit). */
const ThreadSearch = z.object({
  seq: z.catch(z.optional(z.coerce.number().check(z.int(), z.nonnegative())), undefined),
  q: z.catch(z.optional(z.string().check(z.maxLength(512))), undefined),
});

export const Route = createFileRoute("/_home/t/$threadId")({
  validateSearch: ThreadSearch,
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { seq, q } = Route.useSearch();
  // Deck's lane views for the thread's workspace tabs; their code loads when a lane first shows.
  return (
    <ThreadPartsProvider value={deckLaneParts}>
      <ThreadView
        key={threadId}
        threadId={threadId}
        target={seq === undefined ? undefined : { seq, query: q }}
      />
    </ThreadPartsProvider>
  );
}
