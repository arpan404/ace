import { useAgent, useAgentTree, useTask, useTaskIds, type AgentTreeNode } from "@ace/client-react";
import { StatusPill } from "@/components/status-pill.tsx";
import { agentStatusLabel, type Tone } from "@/lib/status.ts";
import type { BackgroundTask } from "@ace/protocol";

/** The thread's agent tree and its background work. Each row subscribes to its own entity. */
export function AgentPanel(props: { threadId: string }) {
  const tree = useAgentTree(props.threadId) ?? [];
  const tasks = useTaskIds(props.threadId) ?? [];
  return (
    <div className="flex flex-col gap-4 p-3">
      <section aria-labelledby="agents-heading">
        <h2 id="agents-heading" className="pb-2 text-xs font-medium text-muted-foreground">
          Agents
        </h2>
        {tree.length ? (
          <AgentList threadId={props.threadId} nodes={tree} />
        ) : (
          <p className="text-sm text-muted-foreground">No agents yet.</p>
        )}
      </section>
      {tasks.length > 0 && (
        <section aria-labelledby="tasks-heading">
          <h2 id="tasks-heading" className="pb-2 text-xs font-medium text-muted-foreground">
            Background tasks
          </h2>
          <ul className="flex flex-col gap-1">
            {tasks.map((id) => (
              <TaskRow key={id} threadId={props.threadId} taskId={id} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AgentList(props: { threadId: string; nodes: readonly AgentTreeNode[] }) {
  return (
    <ul className="flex flex-col gap-1 [&_ul]:mt-1 [&_ul]:ml-3 [&_ul]:border-l [&_ul]:pl-2">
      {props.nodes.map((node) => (
        <li key={node.id}>
          <AgentRow threadId={props.threadId} agentId={node.id} />
          {node.children.length > 0 && (
            <AgentList threadId={props.threadId} nodes={node.children} />
          )}
        </li>
      ))}
    </ul>
  );
}

function AgentRow(props: { threadId: string; agentId: string }) {
  const agent = useAgent(props.threadId, props.agentId);
  if (!agent) return null;
  const status = agentStatusLabel(agent.status);
  const name = agent.origin === "root" ? "Main agent" : (agent.name ?? agent.role ?? "Subagent");
  return (
    <div className="flex flex-col gap-0.5" aria-label={`${name}: ${status.label}`} role="group">
      <div className="flex items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <StatusPill tone={status.tone} label={status.label} />
      </div>
      {agent.status.state === "failed" && (
        <p className="text-xs text-status-failed">{agent.status.error.message}</p>
      )}
    </div>
  );
}

const taskTones: Record<BackgroundTask["status"], { label: string; tone: Tone }> = {
  running: { label: "Running", tone: "working" },
  completed: { label: "Completed", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  stopped: { label: "Stopped", tone: "idle" },
  unknown: { label: "Possibly running", tone: "waiting" },
};
function TaskRow(props: { threadId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  if (!task || task.ambient) return null;
  const status = taskTones[task.status];
  return (
    <li className="flex items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
      <StatusPill tone={status.tone} label={status.label} />
    </li>
  );
}
