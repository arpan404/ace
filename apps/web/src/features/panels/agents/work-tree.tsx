import { useStopIntent } from "./use-stop-intent.ts";
import { agentName, backgroundCommand, agentWorkState, formatSpan, taskState } from "@ace/ui-core";
import {
  useAgent,
  useAgentTree,
  useItem,
  useTask,
  useThreadMeta,
  type AgentTreeNode,
} from "@ace/client-react";
import { CaretDownIcon, CaretRightIcon, ClockIcon, RobotIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/cn.ts";
import { createContext, use, useCallback, useId, useMemo, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { sectionRule } from "@/components/ui/rules.ts";
import { useLiveConnection } from "@/lib/live-connection.ts";
import { useTreeWork } from "./use-tree-work.ts";
import { TreeWorkContext } from "./tree-work-context.ts";
import { useNow } from "@/lib/time.ts";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { useServerQueue } from "@/lib/server-queue.ts";
import { ProviderIconTip } from "@/components/ui/provider-icons.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { useOpenSubagent } from "@/lib/subagent-link.tsx";
import { agentMark } from "./agent-status.tsx";
import {
  badgeWords,
  capsule,
  CapsuleBadge,
  CapsuleGlyph,
  CapsuleMeta,
  type CapsuleState,
} from "./task-capsule.tsx";
import { StopAgent } from "./stop-agent.tsx";
import { subagentCounts } from "./subagents.ts";
import { AgentCounts } from "./tree-extras.tsx";

const heading = "flex h-7 items-center px-2.5 pt-1 text-xs text-muted-foreground";

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

/**
 * Work's Agents section: the whole agent tree with what each agent is doing and for how long (a row opens
 * that agent as its own tab), the background work still running with Stop, queued input,
 * and queued input. Every row subscribes to its own entity.
 */
export function WorkTree(props: { threadId: string }) {
  const tree = useAgentTree(props.threadId) ?? [];
  const facts = useTreeWork(props.threadId);
  const tasks = facts.tasks.filter(
    (task) => task.status === "running" || task.status === "unknown",
  );
  const thread = useThreadMeta(props.threadId);
  const queuedCount = useServerQueue(props.threadId).page?.total ?? 0;
  const queueWaiting = thread?.status.state === "waiting" && thread.status.on === "queue";
  return (
    <TreeWorkContext value={facts.work}>
      <ArrivalScope>
        <div className="pb-1">
          <AgentCounts agents={facts.agents} work={facts.work} />
          {tree.length ? (
            <AgentTree threadId={props.threadId} nodes={tree} />
          ) : (
            <EmptyState icon={RobotIcon} title="No agents yet" className="h-auto py-4" />
          )}
          {(tasks.length > 0 || queuedCount > 0 || queueWaiting) && (
            <section aria-labelledby="agents-background" className={cn("mt-2 pt-1", sectionRule)}>
              <h3 id="agents-background" className={heading}>
                Background
              </h3>
              <ul>
                {tasks.map((task) => (
                  <TaskRow key={task.id} threadId={props.threadId} taskId={task.id} />
                ))}
                {(queuedCount > 0 || queueWaiting) && <QueueRow count={queuedCount} />}
              </ul>
            </section>
          )}
        </div>
      </ArrivalScope>
    </TreeWorkContext>
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
      className={cn("mb-1 flex h-9 items-center gap-2 px-2.5 text-ui", capsule, arrival)}
    >
      <span className="grid size-[18px] shrink-0 place-items-center text-muted-foreground">
        <ClockIcon aria-hidden size={15} />
      </span>
      <span className="font-medium">{label}</span>
      <CapsuleMeta>{props.count > 1 ? "send" : "sends"} when the agent is free</CapsuleMeta>
    </li>
  );
}

/** The agent tree: a tree widget, one Tab stop, with folding branches. */
function AgentTree(props: { threadId: string; nodes: readonly AgentTreeNode[] }) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const ui = workspace.tabs.find((tab) => tab.key === "work")?.ui;
  const active = ui?.selected;
  const setActive = useCallback(
    (selected: string | undefined) => actions.updateUi("work", { selected }),
    [actions],
  );
  const collapsed = useMemo(() => new Set(ui?.collapsed), [ui?.collapsed]);
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
      fold: (id, open) => {
        const next = new Set(collapsed);
        if (open) next.delete(id);
        else next.add(id);
        actions.updateUi("work", { collapsed: [...next] });
      },
    }),
    [treeId, subagents, active, first, collapsed, setActive, actions],
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
  const openSubagent = useOpenSubagent();
  const work = use(TreeWorkContext);
  const live = useLiveConnection();
  const status = agent?.status;
  const tool = useItem(
    props.threadId,
    status?.state === "working" && status.itemId ? status.itemId : "",
  );
  const now = useNow();
  if (!agent || !status) return null;
  const root = agent.origin === "root";
  const name = agentName(agent);
  const { running, needsYou, label, activity } = agentWorkState(agent, work, {
    fresh: live.fresh,
    toolTitle: tool?.type === "tool_call" ? tool.call.title : undefined,
  });
  const end = agent.endedAt ?? (running ? Math.max(now, agent.createdAt) : agent.createdAt);
  const mark = agentMark(status, running, needsYou);
  const state: CapsuleState = mark === "spinner" ? "working" : mark;
  const badge = needsYou ? "Needs you" : badgeWords[state];
  const body = (
    <>
      <CapsuleGlyph state={state} count={running ? props.subagents : undefined} />
      <span className="shrink-0 font-medium whitespace-nowrap">{name}</span>
      {/* A row says its status once: the badge when there is one, else what it is doing. */}
      <CapsuleMeta className="flex-1">{badge ? null : activity}</CapsuleMeta>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {end - agent.createdAt >= 1000 ? formatSpan(agent.createdAt, end) : ""}
      </span>
      {badge && <CapsuleBadge state={state}>{badge}</CapsuleBadge>}
      <ProviderIconTip
        provider={agent.native.provider}
        acpAgentId={agent.native.acpAgentId}
        className="shrink-0"
      />
    </>
  );
  const open = () => {
    if (!root)
      openSubagent({
        threadId: props.threadId,
        agentId: agent.id,
        childThreadId: agent.childThreadId,
      });
  };
  return (
    <div
      style={{ marginLeft: props.depth * 16 }}
      className={cn("group/agent mb-1 flex flex-wrap items-center gap-1", capsule)}
    >
      {/* The row is the tree item: Enter or a click opens the agent as the whole chat; a click on
          its chevron, or anywhere on the main agent (which opens nothing), folds its subagents. */}
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
        onClick={(event) => {
          const onChevron =
            event.target instanceof Element && event.target.closest("[data-capsule-fold]");
          if (props.expanded !== undefined && (root || onChevron))
            return tree.fold(agent.id, !props.expanded);
          open();
        }}
        className={cn(
          "focus-ring-inset relative flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md pr-1 pl-2.5 text-left text-ui",
          (!root || props.expanded !== undefined) && "cursor-pointer",
        )}
      >
        {body}
        <CapsuleChevron expanded={props.expanded} opens={!root} />
      </div>
      {running && !root && thread && (
        <StopAgent
          threadId={props.threadId}
          agent={agent}
          subagents={props.subagents}
          pending={running}
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
  const stop = useStopIntent();
  const workspace = useWorkspaceActions(props.threadId);
  const item = useItem(props.threadId, task?.toolCallId ?? "");
  if (!task || (task.status !== "running" && task.status !== "unknown")) return null;
  const stopping = stop.busy;
  const end = Math.max(now, task.startedAt);
  return (
    <li
      aria-label={`${task.title}: ${taskState(task)}`}
      className={cn(
        "mb-1 flex min-h-9 flex-wrap items-center gap-2 pr-1 pl-2.5 text-ui",
        capsule,
        arrival,
      )}
    >
      <CapsuleGlyph state="working" />
      <button
        type="button"
        className="focus-ring min-w-0 shrink truncate rounded-sm font-mono text-xs"
        onClick={() => workspace.open({ kind: "shell", id: task.id })}
        aria-label={`Show ${backgroundCommand(task, item)} output`}
      >
        {backgroundCommand(task, item)}
      </button>
      <CapsuleMeta className="flex-1">
        {end - task.startedAt >= 1000 ? `${formatSpan(task.startedAt, end)} · ` : ""}
        {taskState(task)}
      </CapsuleMeta>
      {task.stoppable && (
        <Button
          size="sm"
          variant="secondary"
          disabled={stopping}
          onClick={() => void stop.send({ type: "background_task.stop", taskId: task.id })}
        >
          {stopping ? "Stopping…" : "Stop"}
        </Button>
      )}
      {stop.failed && (
        <span role="alert" className="w-full text-xs text-status-failed">
          Couldn't stop this command. Try again.
        </span>
      )}
    </li>
  );
}

/**
 * A capsule's chevron, drawn inside its tree item, whose click handles it: ⌄ on an agent with
 * subagents folds them (as ← → do), › on one that opens as its own tab.
 */
function CapsuleChevron(props: { expanded: boolean | undefined; opens: boolean }) {
  if (props.expanded === undefined && !props.opens) return null;
  const Glyph = props.expanded === undefined ? CaretRightIcon : CaretDownIcon;
  return (
    <span
      aria-hidden
      data-capsule-fold={props.expanded === undefined ? undefined : ""}
      className="mr-1 grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground"
    >
      <Glyph
        size={14}
        className={cn(
          "transition-transform duration-(--motion-base) ease-spring",
          props.expanded === false && "-rotate-90",
        )}
      />
    </span>
  );
}
