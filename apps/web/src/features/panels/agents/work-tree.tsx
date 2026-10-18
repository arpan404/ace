import type { AgentTreeNode } from "@ace/client-react";
import { use, useCallback, useId, useMemo, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentRow, CapsuleChevron } from "./agent-row.tsx";
import { subagentCounts } from "./subagents.ts";
import { capsule, CapsuleGlyph } from "./task-capsule.tsx";
import { doneGroupId, RowFacts, Tree, type AgentRowFacts, type TreeState } from "./tree-state.ts";

const noFacts: AgentRowFacts = { requests: new Map(), files: new Map() };
const noneDone: ReadonlySet<string> = new Set();

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
 * Summary's agents: the whole agent tree with what each agent is doing (a subagent's row opens
 * it as the whole chat). The main agent's subagents that completed fold into one "N done" row.
 * Every row subscribes to its own entity. Rows that join while the tab is open rise in.
 */
export function WorkTree(props: {
  threadId: string;
  nodes: readonly AgentTreeNode[];
  /** Agents whose whole branch completed: they fold under their parent's "N done" row. */
  done?: ReadonlySet<string> | undefined;
  facts?: AgentRowFacts | undefined;
}) {
  return (
    <ArrivalScope>
      <RowFacts value={props.facts ?? noFacts}>
        <AgentTree threadId={props.threadId} nodes={props.nodes} done={props.done ?? noneDone} />
      </RowFacts>
    </ArrivalScope>
  );
}

/** The agent tree: a tree widget, one Tab stop, with folding branches. */
function AgentTree(props: {
  threadId: string;
  nodes: readonly AgentTreeNode[];
  done: ReadonlySet<string>;
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const ui = workspace.tabs.find((tab) => tab.key === "work")?.ui;
  const active = ui?.selected;
  const setActive = useCallback(
    (selected: string | undefined) => actions.updateUi("work", { selected }),
    [actions],
  );
  const collapsed = useMemo(() => new Set(ui?.collapsed), [ui?.collapsed]);
  const sections = ui?.sections;
  const doneOpen = useMemo(
    () =>
      new Set(
        Object.entries(sections ?? {}).flatMap(([key, open]) =>
          key.startsWith("done:") && open ? [key] : [],
        ),
      ),
    [sections],
  );
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
      doneOpen,
      fold: (id, open) => {
        if (id.startsWith("done:")) {
          actions.updateUi("work", { sections: { ...sections, [id]: open } });
          return;
        }
        const next = new Set(collapsed);
        if (open) next.delete(id);
        else next.add(id);
        actions.updateUi("work", { collapsed: [...next] });
      },
    }),
    [treeId, subagents, active, first, collapsed, doneOpen, sections, setActive, actions],
  );
  return (
    <Tree value={state}>
      <ul role="tree" aria-label="Agent tree" onKeyDown={treeKeys(state)}>
        <Branch threadId={props.threadId} nodes={props.nodes} depth={0} done={props.done} />
      </ul>
    </Tree>
  );
}

function Branch(props: {
  threadId: string;
  nodes: readonly AgentTreeNode[];
  depth: number;
  done: ReadonlySet<string>;
}) {
  return props.nodes.map((node) => (
    <BranchNode
      key={node.id}
      threadId={props.threadId}
      node={node}
      depth={props.depth}
      done={props.done}
    />
  ));
}

/** The rail a row's subagents hang on, under their parent's glyph. */
const rail = "ml-4.5 border-l border-border-soft pl-1.5";

/**
 * One agent and its subtree; a subagent spawned while the tab is open rises in. Under the main
 * agent, completed subagents gather in one folded "N done" row after the ones still going.
 */
function BranchNode(props: {
  threadId: string;
  node: AgentTreeNode;
  depth: number;
  done: ReadonlySet<string>;
}) {
  const { node } = props;
  const tree = use(Tree);
  const parent = node.children.length > 0;
  const open = parent && !tree.collapsed.has(node.id);
  const group = `${tree.id}-${node.id}`;
  const finished =
    props.depth === 0 ? node.children.filter((child) => props.done.has(child.id)) : [];
  const going = finished.length
    ? node.children.filter((child) => !props.done.has(child.id))
    : node.children;
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
        <ul role="group" id={group} className={rail}>
          <Branch
            threadId={props.threadId}
            nodes={going}
            depth={props.depth + 1}
            done={props.done}
          />
          {finished.length > 0 && (
            <DoneGroup
              threadId={props.threadId}
              parent={node.id}
              nodes={finished}
              depth={props.depth + 1}
              done={props.done}
            />
          )}
        </ul>
      )}
    </li>
  );
}

/** "3 done": completed subagents, folded until opened; ← → and Enter fold it like a branch. */
function DoneGroup(props: {
  threadId: string;
  parent: string;
  nodes: readonly AgentTreeNode[];
  depth: number;
  done: ReadonlySet<string>;
}) {
  const tree = use(Tree);
  const id = doneGroupId(props.parent);
  const open = tree.doneOpen.has(id);
  const group = `${tree.id}-${id}`;
  const label = `${props.nodes.length} done`;
  return (
    <li role="none">
      <div className={cn("group/agent flex items-center", capsule)}>
        {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Enter folds it through the tree's key handler (treeKeys) */}
        <div
          role="treeitem"
          data-agent={id}
          aria-level={props.depth + 1}
          aria-expanded={open}
          aria-owns={open ? group : undefined}
          aria-label={label}
          tabIndex={tree.active === id ? 0 : -1}
          onFocus={() => tree.setActive(id)}
          onClick={() => tree.fold(id, !open)}
          className="focus-ring-inset flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pr-0.5 pl-2 text-ui text-muted-foreground"
        >
          <CapsuleGlyph state="done" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <CapsuleChevron expanded={open} opens={false} />
        </div>
      </div>
      {open && (
        <ul role="group" id={group} className={rail}>
          <Branch
            threadId={props.threadId}
            nodes={props.nodes}
            depth={props.depth + 1}
            done={props.done}
          />
        </ul>
      )}
    </li>
  );
}
