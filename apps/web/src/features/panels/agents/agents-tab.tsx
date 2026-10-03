import { providerNames } from "@/components/ui/provider-glyph.tsx";
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
import { CheckIcon, ClockIcon, RobotIcon, TerminalIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { useMemo } from "react";
import { Button } from "@/components/ui/button.tsx";
import { Dot } from "@/components/ui/dot.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { agentStatusLabel } from "@/lib/status.ts";
import { useNow } from "@/lib/time.ts";
import { describeActivity, formatDuration, glyphOf, isRunning, taskState } from "./describe.ts";
import { whyNotDone } from "./why.ts";

const heading = "px-2.5 pt-3 pb-1 text-xs font-medium text-subtle-foreground";

/**
 * Agents tab (⌘J): the whole agent tree with what each agent is doing and for how long, the
 * thread's background work with Stop, queued input, and a plain answer to "why isn't this
 * done?". Every row subscribes to its own entity.
 */
export function AgentsTab(props: { threadId: string }) {
  const tree = useAgentTree(props.threadId) ?? [];
  const tasks = useTaskIds(props.threadId) ?? [];
  const thread = useThreadMeta(props.threadId);
  if (!tree.length)
    return (
      <EmptyState
        icon={RobotIcon}
        title="No agents yet"
        description="The thread's agent and any subagents it starts appear here."
      />
    );
  return (
    <div className="px-2.5 pt-2 pb-5">
      <ul aria-label="Agent tree">
        <Branch threadId={props.threadId} nodes={tree} depth={0} />
      </ul>
      {(tasks.length > 0 || thread?.status.state === "waiting") && (
        <section aria-labelledby="agents-background">
          <h3 id="agents-background" className={heading}>
            Background
          </h3>
          <ul>
            {tasks.map((id) => (
              <TaskRow key={id} threadId={props.threadId} taskId={id} />
            ))}
            {thread?.status.state === "waiting" && thread.status.on === "queue" && (
              <li className="flex h-8 items-center gap-2 rounded-lg px-2 text-ui">
                <ClockIcon aria-hidden size={14} className="text-subtle-foreground" />
                <span className="font-medium">Queued messages</span>
                <span className="truncate text-xs text-subtle-foreground">
                  send when the agent is free
                </span>
              </li>
            )}
          </ul>
        </section>
      )}
      <h3 className={heading}>Status</h3>
      <Why threadId={props.threadId} />
    </div>
  );
}

function Branch(props: { threadId: string; nodes: readonly AgentTreeNode[]; depth: number }) {
  return props.nodes.map((node) => (
    <li key={node.id}>
      <AgentRow threadId={props.threadId} agentId={node.id} depth={props.depth} />
      {node.children.length > 0 && (
        <ul>
          <Branch threadId={props.threadId} nodes={node.children} depth={props.depth + 1} />
        </ul>
      )}
    </li>
  ));
}

function AgentRow(props: { threadId: string; agentId: string; depth: number }) {
  const agent = useAgent(props.threadId, props.agentId);
  const thread = useThreadMeta(props.threadId);
  const status = agent?.status;
  const tool = useItem(
    props.threadId,
    status?.state === "working" && status.itemId ? status.itemId : "",
  );
  const now = useNow();
  const stop = useIntentSender();
  if (!agent || !status) return null;
  const root = agent.origin === "root";
  const name = root
    ? providerNames[agent.native.provider]
    : (agent.name ?? agent.role ?? "Subagent");
  const label = agentStatusLabel(status).label;
  const activity = describeActivity(
    status,
    tool?.type === "tool_call" ? tool.call.title : undefined,
  );
  const glyph = glyphOf(status);
  const running = isRunning(agent);
  const end = agent.endedAt ?? (running ? Math.max(now, agent.createdAt) : agent.createdAt);
  return (
    <div
      role="group"
      aria-label={`${root ? "Main agent" : name}: ${label}`}
      style={{ paddingLeft: 8 + props.depth * 22 }}
      className="group/agent relative flex h-8 items-center gap-2 rounded-lg pr-2 text-ui hover:bg-accent"
    >
      {props.depth > 0 && (
        <span
          aria-hidden
          style={{ left: props.depth * 22 - 7 }}
          className="absolute -top-1.5 bottom-1/2 w-2.5 rounded-bl-md border-b-[1.5px] border-l-[1.5px]"
        />
      )}
      <StatusGlyph glyph={glyph} label={label} />
      <span className="shrink-0 font-medium whitespace-nowrap">{name}</span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs text-subtle-foreground",
          status.state === "failed" && "text-status-failed",
        )}
      >
        {activity}
      </span>
      {running && !root && thread && (
        <Button
          size="sm"
          variant="ghost"
          className="hidden group-hover/agent:inline-flex focus-visible:inline-flex"
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
      <span className="shrink-0 text-xs text-subtle-foreground tabular-nums">
        {formatDuration(agent.createdAt, end)}
      </span>
    </div>
  );
}

function StatusGlyph(props: { glyph: ReturnType<typeof glyphOf>; label: string }) {
  switch (props.glyph) {
    case "spinner":
      return <Spinner className="text-status-working" />;
    case "waiting":
      return <Spinner className="text-status-waiting" />;
    case "needs-you":
      return <Dot tone="needs-you" className="mx-[2.5px]" />;
    case "failed":
      return <Dot tone="failed" className="mx-[2.5px]" />;
    case "stopped":
      return <Dot tone="idle" className="mx-[2.5px]" />;
    case "done":
      return <CheckIcon aria-hidden size={11} className="text-subtle-foreground" />;
  }
}

function TaskRow(props: { threadId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  const now = useNow();
  const stop = useIntentSender();
  if (!task || task.ambient) return null;
  const running = task.status === "running";
  const stopping = stop.intent?.state === "pending";
  const end = task.endedAt ?? (running ? Math.max(now, task.startedAt) : task.startedAt);
  return (
    <li
      aria-label={`${task.title}: ${taskState(task)}`}
      className="flex h-8 items-center gap-2 rounded-lg px-2 text-ui hover:bg-accent"
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
        {formatDuration(task.startedAt, end)} · {taskState(task)}
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

function Why(props: { threadId: string }) {
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
