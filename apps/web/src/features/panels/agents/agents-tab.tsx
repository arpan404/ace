import {
  agentName,
  agentStatusLabel,
  describeActivity,
  formatSpan,
  isRunning,
  taskState,
  whyNotDone,
} from "@ace/ui-core";
import type { ThreadKey, ThreadReader } from "@ace/client";
import {
  arrayEqual,
  useAgent,
  useAgentTree,
  useInteractions,
  useIntentSender,
  useItem,
  useTask,
  useTaskIds,
  useThread,
  useThreadMeta,
  type AgentTreeNode,
} from "@ace/client-react";
import type { Agent, BackgroundTask } from "@ace/protocol";
import { ClockIcon, RobotIcon, TerminalIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useNow } from "@/lib/time.ts";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { ProviderMark } from "@/components/ui/provider-glyph.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentStatusMark } from "./agent-status.tsx";
import { AgentCounts, ThreadDeck } from "./tree-extras.tsx";

const heading = "px-2.5 pt-3 pb-1 text-xs font-medium text-subtle-foreground";

/**
 * Agents tab: the whole agent tree with what each agent is doing and for how long (a row opens
 * that agent as its own tab), the thread's background work with Stop, queued input, the deck
 * the thread works for with its lanes, and a plain answer to "why isn't this done?". Every row
 * subscribes to its own entity.
 */
export function AgentsTab(props: { threadId: string }) {
  const tree = useAgentTree(props.threadId) ?? [];
  const tasks = useTaskIds(props.threadId) ?? [];
  const thread = useThreadMeta(props.threadId);
  const queuedCount = useServerQueue(props.threadId).page?.total ?? 0;
  const queueWaiting = thread?.status.state === "waiting" && thread.status.on === "queue";
  if (!tree.length)
    return (
      <div className="flex h-full flex-col">
        <EmptyState
          icon={RobotIcon}
          title="No agents yet"
          description="The thread's agent and any subagents it starts appear here."
          className="h-auto flex-none pt-16 pb-4"
        />
        <div className="px-2.5 pb-5">
          <ThreadDeck threadId={props.threadId} />
        </div>
      </div>
    );
  return (
    <ArrivalScope>
      <div className="px-2.5 pt-2 pb-5">
        <AgentCounts threadId={props.threadId} />
        <ul aria-label="Agent tree">
          <Branch threadId={props.threadId} nodes={tree} depth={0} />
        </ul>
        {(tasks.length > 0 || queuedCount > 0 || queueWaiting) && (
          <section aria-labelledby="agents-background">
            <h3 id="agents-background" className={heading}>
              Background
            </h3>
            <ul>
              {tasks.map((id) => (
                <TaskRow key={id} threadId={props.threadId} taskId={id} />
              ))}
              {(queuedCount > 0 || queueWaiting) && <QueueRow count={queuedCount} />}
            </ul>
          </section>
        )}
        <ThreadDeck threadId={props.threadId} />
        <h3 className={heading}>Status</h3>
        <Why threadId={props.threadId} queued={queuedCount} />
      </div>
    </ArrivalScope>
  );
}

/** "1 queued message · sends when the agent is free", the composer's queue in one line. */
function QueueRow(props: { count: number }) {
  const arrival = useArrival();
  const label =
    props.count > 1
      ? `${props.count} queued messages`
      : props.count === 1
        ? "1 queued message"
        : "Queued messages";
  return (
    <li
      aria-label={`${label}: waiting for the agent`}
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2 text-ui", arrival)}
    >
      <ClockIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
      <span className="font-medium">{label}</span>
      <span className="truncate text-xs text-subtle-foreground">
        {props.count > 1 ? "send" : "sends"} when the agent is free
      </span>
    </li>
  );
}

function Branch(props: { threadId: string; nodes: readonly AgentTreeNode[]; depth: number }) {
  return props.nodes.map((node) => (
    <BranchNode key={node.id} threadId={props.threadId} node={node} depth={props.depth} />
  ));
}

/** One agent and its subtree; a subagent spawned while the tab is open rises in. */
function BranchNode(props: { threadId: string; node: AgentTreeNode; depth: number }) {
  const { node } = props;
  return (
    <li className={useArrival()}>
      <AgentRow threadId={props.threadId} agentId={node.id} depth={props.depth} />
      {node.children.length > 0 && (
        <ul>
          <Branch threadId={props.threadId} nodes={node.children} depth={props.depth + 1} />
        </ul>
      )}
    </li>
  );
}

function AgentRow(props: { threadId: string; agentId: string; depth: number }) {
  const agent = useAgent(props.threadId, props.agentId);
  const thread = useThreadMeta(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const status = agent?.status;
  const tool = useItem(
    props.threadId,
    status?.state === "working" && status.itemId ? status.itemId : "",
  );
  const now = useNow();
  const stop = useIntentSender();
  if (!agent || !status) return null;
  const root = agent.origin === "root";
  const name = agentName(agent);
  const label = agentStatusLabel(status).label;
  const activity = describeActivity(
    status,
    tool?.type === "tool_call" ? tool.call.title : undefined,
  );
  const running = isRunning(agent);
  const end = agent.endedAt ?? (running ? Math.max(now, agent.createdAt) : agent.createdAt);
  const body = (
    <>
      {props.depth > 0 && (
        <span
          aria-hidden
          style={{ left: props.depth * 22 - 7 }}
          className="absolute -top-1.5 bottom-1/2 w-2.5 rounded-bl-md border-b-[1.5px] border-l-[1.5px]"
        />
      )}
      <AgentStatusMark status={status} />
      <span className="shrink-0 font-medium whitespace-nowrap">{name}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs text-subtle-foreground",
          status.state === "failed" && "text-status-failed",
        )}
      >
        {activity}
      </span>
      <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
        {formatSpan(agent.createdAt, end)}
      </span>
      <ProviderMark provider={agent.native.provider} className="shrink-0" />
    </>
  );
  const row =
    "relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-ui";
  return (
    <div
      role="group"
      aria-label={`${root ? "Main agent" : name}: ${label}`}
      className="group/agent flex items-center gap-1 rounded-lg hover:bg-accent"
    >
      {root ? (
        <div style={{ paddingLeft: 8 + props.depth * 22 }} className={row}>
          {body}
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open ${name}`}
          onClick={() => workspace.open({ kind: "agent", id: agent.id, title: name })}
          style={{ paddingLeft: 8 + props.depth * 22 }}
          className={cn(row, "outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--ring)]")}
        >
          {body}
        </button>
      )}
      {running && !root && thread && (
        <Button
          size="sm"
          variant="ghost"
          className="mr-1 hidden group-focus-within/agent:inline-flex group-hover/agent:inline-flex"
          onClick={() =>
            void stop.send({
              type: "thread.interrupt",
              threadId: thread.id,
              agentId: agent.id,
              cascade: true,
            })
          }
        >
          Stop
        </Button>
      )}
    </div>
  );
}

function TaskRow(props: { threadId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  const arrival = useArrival();
  const now = useNow();
  const stop = useIntentSender();
  if (!task || task.ambient) return null;
  const running = task.status === "running";
  const stopping = stop.intent?.state === "pending";
  const end = task.endedAt ?? (running ? Math.max(now, task.startedAt) : task.startedAt);
  return (
    <li
      aria-label={`${task.title}: ${taskState(task)}`}
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2 text-ui hover:bg-accent", arrival)}
    >
      <TerminalIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 shrink truncate",
          task.kind === "shell" ? "font-mono text-[12px]" : "font-medium",
        )}
      >
        {task.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">
        {formatSpan(task.startedAt, end)} · {taskState(task)}
      </span>
      {running && task.stoppable && (
        <Button
          size="sm"
          variant="ghost"
          disabled={stopping}
          onClick={() => void stop.send({ type: "background_task.stop", taskId: task.id })}
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
      {stop.intent?.state === "failed" && (
        <span role="alert" className="text-xs text-status-failed">
          Couldn't stop: {stop.intent.error ?? "refused"}
        </span>
      )}
    </li>
  );
}

interface Facts {
  agents: Agent[];
  tasks: BackgroundTask[];
}
const factsEqual = (a: Facts, b: Facts) =>
  a.agents.length === b.agents.length &&
  a.tasks.length === b.tasks.length &&
  a.agents.every((agent, i) => agent === b.agents[i]) &&
  a.tasks.every((task, i) => task === b.tasks[i]);
const readFacts = (reader: ThreadReader): Facts => ({
  agents: reader.agentIds().flatMap((id) => reader.agent(id) ?? []),
  tasks: reader.taskIds().flatMap((id) => reader.task(id) ?? []),
});
const readAgentIds = (reader: ThreadReader) => reader.agentIds();
const none: readonly string[] = [];

function Why(props: { threadId: string; queued: number }) {
  const thread = useThreadMeta(props.threadId);
  const agentIds = useThread(props.threadId, ["agents"], readAgentIds, arrayEqual) ?? none;
  const taskIds = useTaskIds(props.threadId) ?? none;
  const keys = useMemo<ThreadKey[]>(
    () => [
      "agents",
      "tasks",
      ...agentIds.map((id): ThreadKey => `agent:${id}`),
      ...taskIds.map((id): ThreadKey => `task:${id}`),
    ],
    [agentIds, taskIds],
  );
  const facts = useThread(props.threadId, keys, readFacts, factsEqual);
  const waitingOnYou = useInteractions(props.threadId)?.length ?? 0;
  if (!thread || !facts) return null;
  const why = whyNotDone({
    status: thread.status,
    rootAgentId: thread.rootAgentId,
    agents: facts.agents,
    tasks: facts.tasks,
    waitingOnYou,
    queued: props.queued,
  });
  return (
    <section
      aria-label={why.title}
      className="mx-0.5 mt-2 rounded-card bg-muted px-3 py-2.5 text-sm leading-normal text-muted-foreground"
    >
      <b className="mb-0.5 block font-medium text-foreground">{why.title}</b>
      {why.body}
    </section>
  );
}
