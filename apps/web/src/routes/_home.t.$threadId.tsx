import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { ThreadView } from "@/features/thread/index.ts";
import { loadMarkdown } from "@/components/markdown/load.ts";

/**
 * `/t/<id>?item=<id>` opens a canonical item or pending interaction.
 * `?seq=1234&q=words` keeps search-hit links working.
 * The router reads `seq=1234` as a number; the thread view ignores one that isn't a sequence.
 */
const ThreadSearch = z.object({
  item: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
  seq: z.catch(z.optional(z.number()), undefined),
  q: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/_home/t/$threadId")({
  validateSearch: ThreadSearch,
  // The transcript renders markdown on its first paint: start its code with the route's, not
  // once the first message mounts. Not awaited, so the thread never waits on it.
  loader: () => void loadMarkdown().catch(() => {}),
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { seq, q, item } = Route.useSearch();
  return (
    <ThreadView
      key={threadId}
      threadId={threadId}
      target={
        item !== undefined
          ? { itemId: item }
          : seq !== undefined && Number.isSafeInteger(seq) && seq >= 0
            ? { seq, query: q?.slice(0, 512) }
            : undefined
      }
    />
  );
}
