import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { ThreadView } from "@/features/thread/index.ts";

/**
 * `/t/<id>?seq=1234&q=words`: both optional; a link into the thread at an item (a search hit).
 * The router reads `seq=1234` as a number; the thread view ignores one that isn't a sequence.
 */
const ThreadSearch = z.object({
  seq: z.catch(z.optional(z.number()), undefined),
  q: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/_home/t/$threadId")({
  validateSearch: ThreadSearch,
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { seq, q } = Route.useSearch();
  return (
    <ThreadView
      key={threadId}
      threadId={threadId}
      target={
        seq !== undefined && Number.isSafeInteger(seq) && seq >= 0
          ? { seq, query: q?.slice(0, 512) }
          : undefined
      }
    />
  );
}
