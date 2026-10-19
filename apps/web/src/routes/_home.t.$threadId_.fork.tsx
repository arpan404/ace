import { createFileRoute, Navigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { ForkDraftView } from "@/features/thread/index.ts";

const id = z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(128))), undefined);
/** `?run=<run>` forks after a finished turn; `?item=<item>` after one finished answer. */
const ForkSearch = z.object({ run: id, item: id });

/**
 * `/t/<thread>/fork`: a fork of the thread, ready for its first message. The fork is created
 * when that message is sent, as New thread creates a thread.
 */
export const Route = createFileRoute("/_home/t/$threadId_/fork")({
  validateSearch: ForkSearch,
  component: ForkRoute,
});

function ForkRoute() {
  const { threadId } = Route.useParams();
  const { run, item } = Route.useSearch();
  if (!run && !item) return <Navigate to="/t/$threadId" params={{ threadId }} replace />;
  return (
    <ForkDraftView key={`${threadId}:${run ?? item}`} threadId={threadId} at={{ run, item }} />
  );
}
