import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { OnMachine } from "@/features/home/index.ts";
import { ThreadView } from "@/features/thread/index.ts";
import { loadMarkdown } from "@/components/markdown/load.ts";
import { scheduleMathWarmup } from "@/components/markdown/math-warm.ts";
import { warmThread } from "@/lib/thread-warmer.ts";

/**
 * `/t/<id>?item=<id>` opens a canonical item or pending interaction.
 * `?seq=1234&q=words` keeps search-hit links working.
 * The router reads `seq=1234` as a number; the thread view ignores one that isn't a sequence.
 * `?machine=<hostId>` opens a thread on another of the person's machines (ADR 0100).
 */
const ThreadSearch = z.object({
  item: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
  seq: z.catch(z.optional(z.number()), undefined),
  q: z.catch(z.optional(z.string()), undefined),
  machine: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
});

export const Route = createFileRoute("/_home/t/$threadId")({
  validateSearch: ThreadSearch,
  // The transcript renders markdown on its first paint: start its code with the route's, not
  // once the first message mounts. The KaTeX chunk starts alongside at idle, so the two
  // downloads overlap instead of running one after the other. Not awaited, so the thread
  // never waits on either.
  // Preloaded when a link to the thread is pointed at, focused or touched: follow the thread
  // from then, so opening it paints its messages rather than waiting for the daemon's answer.
  loaderDeps: ({ search }) => ({ machine: search.machine }),
  loader: ({ context, params, preload, deps }) => {
    void loadMarkdown().catch(() => {});
    scheduleMathWarmup();
    // A thread being started has no daemon id yet (`pending:<command>`): nothing to follow.
    // Another machine's thread is followed by its own client once the view mounts.
    if (preload && !deps.machine && !params.threadId.startsWith("pending:"))
      warmThread(context.client, params.threadId);
  },
  component: ThreadRoute,
});

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const { seq, q, item, machine } = Route.useSearch();
  return (
    <OnMachine machine={machine} title="Thread">
      <ThreadView
        key={`${machine ?? ""}:${threadId}`}
        threadId={threadId}
        target={
          item !== undefined
            ? { itemId: item }
            : seq !== undefined && Number.isSafeInteger(seq) && seq >= 0
              ? { seq, query: q?.slice(0, 512) }
              : undefined
        }
      />
    </OnMachine>
  );
}
