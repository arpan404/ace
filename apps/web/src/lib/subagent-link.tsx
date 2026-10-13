import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, type ComponentProps } from "react";

/**
 * A subagent of thread `threadId`. One ace delegated (`childThreadId`) is a thread of its own;
 * a provider's own subagent lives in its parent's thread and opens at its agent route.
 */
export interface SubagentTarget {
  threadId: string;
  agentId: string;
  childThreadId?: string | undefined;
}

type AnchorProps = Omit<ComponentProps<"a">, "href" | "target">;

/** A link that opens a subagent as the whole chat, a new history entry, so Back returns. */
export function SubagentLink(props: AnchorProps & { subagent: SubagentTarget }) {
  const { subagent, ...rest } = props;
  return subagent.childThreadId ? (
    <Link {...rest} to="/t/$threadId" params={{ threadId: subagent.childThreadId }} />
  ) : (
    <Link
      {...rest}
      to="/t/$threadId/agents/$agentId"
      params={{ threadId: subagent.threadId, agentId: subagent.agentId }}
    />
  );
}

/** Opens a subagent from a control that isn't a link (a tree row's Enter), as a link would. */
export function useOpenSubagent(): (target: SubagentTarget) => void {
  const navigate = useNavigate();
  return useCallback(
    (target: SubagentTarget) =>
      void (target.childThreadId
        ? navigate({ to: "/t/$threadId", params: { threadId: target.childThreadId } })
        : navigate({
            to: "/t/$threadId/agents/$agentId",
            params: { threadId: target.threadId, agentId: target.agentId },
          })),
    [navigate],
  );
}
