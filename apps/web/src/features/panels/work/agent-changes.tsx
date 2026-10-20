import { useAgent } from "@ace/client-react";
import type { ChangesByAgent } from "@ace/ui-core";
import { WarningIcon } from "@phosphor-icons/react";
import { useAgentIdentity } from "../agents/agent-identity.ts";
import { FileRow } from "./file-row.tsx";

const tail = (path: string) => path.split("/").filter(Boolean).slice(-2).join("/") || path;

/** An agent by the name its tree row uses (an unnamed subagent by its task). */
function AgentName(props: { threadId: string; agentId: string; fallback?: string | undefined }) {
  const agent = useAgent(props.threadId, props.agentId);
  const { name } = useAgentIdentity(props.threadId, agent);
  return <>{agent ? name : (props.fallback ?? "An agent")}</>;
}

/**
 * The turn's changed files by the agent that changed them, under each checkout when agents work
 * in more than one, with a warning first when two agents changed the same file in one checkout.
 */
export function AgentChanges(props: {
  threadId: string;
  changes: ChangesByAgent;
  /** Names the turn index knows for agents outside the loaded tree. */
  names: ReadonlyMap<string, string>;
}) {
  const { worktrees, conflicts } = props.changes;
  const several = worktrees.length > 1;
  const name = (id: string) => (
    <AgentName threadId={props.threadId} agentId={id} fallback={props.names.get(id)} />
  );
  return (
    <div className="min-w-0">
      {conflicts.map((conflict) => (
        <p
          key={`${conflict.worktree}:${conflict.path}`}
          role="alert"
          data-tone="needs-you"
          className="flex min-w-0 items-start gap-2 px-2 py-1 text-xs text-(--tone-text)"
        >
          <WarningIcon aria-hidden size={14} className="mt-px shrink-0" />
          <span className="min-w-0">
            <span className="font-mono">{conflict.path}</span> was changed by{" "}
            {conflict.agents.flatMap((id, index) => [
              index === 0 ? "" : index === conflict.agents.length - 1 ? " and " : ", ",
              <span key={id}>{name(id)}</span>,
            ])}{" "}
            in the same checkout
          </span>
        </p>
      ))}
      {worktrees.map((worktree) => (
        <div key={worktree.worktree} className="min-w-0">
          {several && (
            <p
              className="truncate px-2 pt-1 font-mono text-xs text-subtle-foreground"
              title={worktree.worktree}
            >
              {tail(worktree.worktree)}
            </p>
          )}
          {worktree.agents.map((agent) => (
            <div key={agent.agentId} className="pt-1">
              <p className="flex min-w-0 items-center gap-2 px-2 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">
                  {name(agent.agentId)}
                </span>
                <span className="shrink-0 text-subtle-foreground tabular-nums">
                  {agent.truncated ? `${agent.files.length}+` : agent.files.length}
                </span>
              </p>
              <ul>
                {agent.files.map((file) => (
                  <FileRow
                    key={file.path}
                    threadId={props.threadId}
                    path={file.path}
                    added={file.added}
                    removed={file.removed}
                    shared={file.shared}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
