import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, type ComponentProps } from "react";
import { useMachineSearch } from "./machine-routes.ts";

/**
 * A subagent of thread `threadId`. One ace delegated (`childThreadId`) is a thread of its own;
 * a provider's own subagent lives in its parent's thread and opens at its agent route. One ace
 * delegated to another machine (`childMachine`, its host id) opens at its parent's agent route
 * too, its thread read from that machine, so it shows as the parent's subagent.
 */
export interface SubagentTarget {
  threadId: string;
  agentId: string;
  childThreadId?: string | undefined;
  childMachine?: string | undefined;
}

type AnchorProps = Omit<ComponentProps<"a">, "href" | "target">;

/** Link or `navigate` options that open a subagent, keeping the parent's machine. */
function subagentRoute(target: SubagentTarget, search: { machine?: string }) {
  if (target.childThreadId && target.childMachine)
    return {
      to: "/t/$threadId/agents/$agentId",
      params: { threadId: target.threadId, agentId: target.childThreadId },
      search: { ...search, on: target.childMachine },
    } as const;
  if (target.childThreadId)
    return { to: "/t/$threadId", params: { threadId: target.childThreadId }, search } as const;
  return {
    to: "/t/$threadId/agents/$agentId",
    params: { threadId: target.threadId, agentId: target.agentId },
    search,
  } as const;
}

/** A link that opens a subagent as the whole chat, a new history entry, so Back returns. */
export function SubagentLink(props: AnchorProps & { subagent: SubagentTarget }) {
  const { subagent, ...rest } = props;
  const search = useMachineSearch();
  return <Link {...rest} {...subagentRoute(subagent, search)} />;
}

/** Opens a subagent from a control that isn't a link (a tree row's Enter), as a link would. */
export function useOpenSubagent(): (target: SubagentTarget) => void {
  const navigate = useNavigate();
  const search = useMachineSearch();
  return useCallback(
    (target: SubagentTarget) => void navigate(subagentRoute(target, search)),
    [navigate, search],
  );
}
