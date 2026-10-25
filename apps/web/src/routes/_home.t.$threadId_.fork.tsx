import { createFileRoute, Navigate } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { OnMachine } from "@/features/home/index.ts";
import { ForkDraftView } from "@/features/thread/index.ts";

const id = z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(128))), undefined);
/**
 * `?run=<run>` forks after a finished turn; `?item=<item>` after one finished answer.
 * `?machine=<hostId>` forks a thread on another of the person's machines, there (ADR 0102).
 */
const ForkSearch = z.object({
  run: id,
  item: id,
  machine: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined),
});

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
  const { run, item, machine } = Route.useSearch();
  if (!run && !item)
    return (
      <Navigate
        to="/t/$threadId"
        params={{ threadId }}
        search={machine ? { machine } : {}}
        replace
      />
    );
  return (
    <OnMachine machine={machine} title="Fork">
      <ForkDraftView
        key={`${machine ?? ""}:${threadId}:${run ?? item}`}
        threadId={threadId}
        at={{ run, item }}
      />
    </OnMachine>
  );
}
