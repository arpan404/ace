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
import { createContext, use, useId, useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useNow } from "@/lib/time.ts";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentStatusMark } from "./agent-status.tsx";
import { StopAgent } from "./stop-agent.tsx";
import { subagentCounts } from "./subagents.ts";
import { AgentCounts, ThreadDeck } from "./tree-extras.tsx";

const heading = "px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground";

/** The tree's roving focus and folded branches, shared by its rows. */
interface TreeState {
  /** Prefix of the tree's element ids. */
  id: string;
  /** Subagents under each agent, counted once for the whole tree. */
  subagents: ReadonlyMap<string, number>;
  active: string | undefined;
  setActive(id: string): void;
  collapsed: ReadonlySet<string>;
  fold(id: string, open: boolean): void;
}
const Tree = createContext<TreeState>({
  id: "agent-tree",
  subagents: new Map(),
  active: undefined,
  setActive: () => {},
  collapsed: new Set(),
  fold: () => {},
});

/**
 * The tree's keys, as the Changes and Files trees have them: one Tab stop; ↑/↓ move, →/←
 * expand, collapse or step in and out, Home/End jump, Enter opens the agent, Delete or S moves
 * to a running agent's Stop.
 */
function treeKeys(tree: TreeState) {
  return (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const item = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const at = item ? items.indexOf(item) : -1;
    if (!item || at < 0 || event.target !== item) return;
    const id = item.dataset.agent ?? "";
    const level = Number(item.getAttribute("aria-level"));
    const expanded = item.getAttribute("aria-expanded");
    const focus = (index: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, index))];
      if (!next) return;
      tree.setActive(next.dataset.agent ?? "");
      next.focus();
    };
    const moves: Record<string, number> = {
      ArrowDown: at + 1,
      ArrowUp: at - 1,
      Home: 0,
      End: items.length - 1,
    };
    const target = moves[event.key];
    if (target !== undefined) focus(target);
    else if (event.key === "ArrowRight") {
      if (expanded === "false") tree.fold(id, true);
      else if (expanded === "true") focus(at + 1);
      else return;
    } else if (event.key === "ArrowLeft") {
      if (expanded === "true") tree.fold(id, false);
      else
        focus(
          items.findLastIndex(
            (other, index) => index < at && Number(other.getAttribute("aria-level")) < level,
          ),
        );
    } else if (event.key === "Enter" || event.key === " ") item.click();
    else if (event.key === "Delete" || event.key === "s" || event.key === "S") {
      const stop = item.parentElement?.querySelector<HTMLElement>("[data-stop]");
      if (!stop) return;
      stop.focus();
    } else return;
    event.preventDefault();
  };
}

/** Background work still running (helpers that never hold the thread open left out). */
const readRunning = (reader: ThreadReader) =>
  reader.taskIds().filter((id) => {
    const task = reader.task(id);
    return task?.status === "running" && !task.ambient;
  });

/**
 * The thread's background work still running, oldest first. Finished work is not kept here:
 * its transcript row ("Finished `bun run build`") opens its output.
 */
function useRunningTasks(threadId: string): readonly string[] {
  const ids = useTaskIds(threadId) ?? none;
  const keys = useMemo<ThreadKey[]>(
    () => ["tasks", ...ids.map((id): ThreadKey => `task:${id}`)],
    [ids],
  );
  return useThread(threadId, keys, readRunning, arrayEqual) ?? none;
}

/**
 * Agents tab: the whole agent tree with what each agent is doing and for how long (a row opens
 * that agent as its own tab), the background work still running with Stop, queued input, the
 * deck the thread works for with its lanes, and a plain answer to "why isn't this done?". Every
 * row subscribes to its own entity.
 */
export function AgentsTab(props: { threadId: string }) {
  const tree = useAgentTree(props.threadId) ?? [];
  const tasks = useRunningTasks(props.threadId);
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
        <AgentTree threadId={props.threadId} nodes={tree} />
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
      <span className="truncate text-xs text-muted-foreground">
        {props.count > 1 ? "send" : "sends"} when the agent is free
      </span>
    </li>
  );
}

/** The agent tree: a tree widget, one Tab stop, with folding branches. */
function AgentTree(props: { threadId: string; nodes: readonly AgentTreeNode[] }) {
  const [active, setActive] = useState<string>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const first = props.nodes[0]?.id;
  const treeId = useId();
  const subagents = useMemo(() => subagentCounts(props.nodes), [props.nodes]);
  const state = useMemo<TreeState>(
    () => ({
      id: treeId,
      subagents,
      // The root holds the Tab stop until another row has had focus.
      active: active ?? first,
      setActive,
      collapsed,
      fold: (id, open) =>
        setCollapsed((previous) => {
          const next = new Set(previous);
          if (open) next.delete(id);
          else next.add(id);
          return next;
        }),
    }),
    [treeId, subagents, active, first, collapsed],
  );
  return (
    <Tree value={state}>
      <ul role="tree" aria-label="Agent tree" onKeyDown={treeKeys(state)}>
        <Branch threadId={props.threadId} nodes={props.nodes} depth={0} />
      </ul>
    </Tree>
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
  const tree = use(Tree);
  const parent = node.children.length > 0;
  const open = parent && !tree.collapsed.has(node.id);
  const group = `${tree.id}-${node.id}`;
  return (
    <li role="none" className={useArrival()}>
      <AgentRow
        threadId={props.threadId}
        agentId={node.id}
        depth={props.depth}
        expanded={parent ? open : undefined}
        owns={open ? group : undefined}
        subagents={tree.subagents.get(node.id) ?? 0}
      />
      {open && (
        // Owned by the row above (aria-owns): the tree item's children, in tree terms.
        <ul role="group" id={group}>
          <Branch threadId={props.threadId} nodes={node.children} depth={props.depth + 1} />
        </ul>
      )}
    </li>
  );
}

function AgentRow(props: {
  threadId: string;
  agentId: string;
  depth: number;
  /** Has subagents: whether they show. */
  expanded: boolean | undefined;
  /** The id of the group of subagents it shows. */
  owns: string | undefined;
  subagents: number;
}) {
  const tree = use(Tree);
  const agent = useAgent(props.threadId, props.agentId);
  const thread = useThreadMeta(props.threadId);
  const workspace = useWorkspaceActions(props.threadId);
  const status = agent?.status;
  const tool = useItem(
    props.threadId,
    status?.state === "working" && status.itemId ? status.itemId : "",
  );
  const now = useNow();
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
          "min-w-0 flex-1 truncate text-xs text-muted-foreground",
          status.state === "failed" && "text-status-failed",
        )}
      >
        {activity}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatSpan(agent.createdAt, end)}
      </span>
      <ProviderIconTip
        provider={agent.native.provider}
        acpAgentId={agent.native.acpAgentId}
        className="shrink-0"
      />
    </>
  );
  const open = () => {
    if (!root) workspace.open({ kind: "agent", id: agent.id, title: name });
  };
  return (
    <div className="group/agent flex items-center gap-1 rounded-lg hover:bg-accent">
      {/* The row is the tree item: Enter or a click opens the agent as its own tab. */}
      <div
        role="treeitem"
        data-agent={agent.id}
        aria-level={props.depth + 1}
        aria-expanded={props.expanded}
        aria-owns={props.owns}
        aria-label={`${root ? "Main agent" : name}: ${label}`}
        aria-description={root ? undefined : `Opens ${name}`}
        tabIndex={tree.active === agent.id ? 0 : -1}
        onFocus={() => tree.setActive(agent.id)}
        onClick={open}
        style={{ paddingLeft: 8 + props.depth * 22 }}
        className={cn(
          "focus-ring-inset relative flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg pr-2 text-left text-ui",
          !root && "cursor-pointer",
        )}
      >
        {body}
      </div>
      {running && !root && thread && (
        <StopAgent
          threadId={props.threadId}
          agent={agent}
          subagents={props.subagents}
          inTree
          className="mr-1 hidden group-focus-within/agent:inline-flex group-hover/agent:inline-flex pointer-coarse:inline-flex"
          onKeyDown={(event) => {
            // Back to the row it belongs to.
            if (event.key === "Escape" || event.key === "ArrowLeft") {
              event.preventDefault();
              event.currentTarget.parentElement
                ?.querySelector<HTMLElement>('[role="treeitem"]')
                ?.focus();
            }
          }}
        />
      )}
    </div>
  );
}

/** One background task still running: its command, how long it has run, and Stop. */
function TaskRow(props: { threadId: string; taskId: string }) {
  const task = useTask(props.threadId, props.taskId);
  const arrival = useArrival();
  const now = useNow();
  const stop = useIntentSender();
  if (!task || task.ambient || task.status !== "running") return null;
  const stopping = stop.intent?.state === "pending";
  const end = Math.max(now, task.startedAt);
  return (
    <li
      aria-label={`${task.title}: ${taskState(task)}`}
      className={cn("flex h-8 items-center gap-2 rounded-lg px-2 text-ui hover:bg-accent", arrival)}
    >
      <TerminalIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
      <span
        className={cn(
          "min-w-0 shrink truncate",
          task.kind === "shell" ? "font-mono text-sm" : "font-medium",
        )}
      >
        {task.title}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
        {formatSpan(task.startedAt, end)} · {taskState(task)}
      </span>
      {task.stoppable && (
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
