import { createFileRoute } from "@tanstack/react-router";
// Route search schemas load with the route tree on first paint: zod/mini keeps classic Zod out.
import * as z from "zod/mini";
import { OnMachine } from "@/features/home/index.ts";
import { DelegatedElsewhereView, SubagentView } from "@/features/thread/index.ts";

const host = z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(256))), undefined);
/**
 * `?machine=<hostId>`: the thread is on another of the person's machines (ADR 0102).
 * `?on=<hostId>`: the subagent is a thread ace delegated to that machine (ADR 0078).
 */
const SubagentSearch = z.object({ machine: host, on: host });

/**
 * `/t/<thread>/agents/<agent>`: a provider's own subagent as the whole chat, its transcript
 * from its parent's thread. A subagent ace delegated is a thread of its own, at `/t/<child>`;
 * one delegated to another machine opens here, `<agent>` its thread id, read from that machine.
 */
export const Route = createFileRoute("/_home/t/$threadId_/agents/$agentId")({
  validateSearch: SubagentSearch,
  component: SubagentRoute,
});

function SubagentRoute() {
  const { threadId, agentId } = Route.useParams();
  const { machine, on } = Route.useSearch();
  return (
    <OnMachine machine={machine} title="Subagent">
      {on ? (
        <DelegatedElsewhereView
          key={`${machine ?? ""}:${threadId}:${on}:${agentId}`}
          parentThreadId={threadId}
          threadId={agentId}
          machine={on}
        />
      ) : (
        <SubagentView
          key={`${machine ?? ""}:${threadId}:${agentId}`}
          threadId={threadId}
          agentId={agentId}
        />
      )}
    </OnMachine>
  );
}
