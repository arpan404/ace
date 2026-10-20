import type { AgentTreeNode } from "@ace/client-react";
import { use, useCallback, useId, useMemo, type KeyboardEvent } from "react";
import { ArrivalScope, useArrival } from "@/lib/arrival.tsx";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentRow } from "./agent-row.tsx";
import { subagentCounts } from "./subagents.ts";
import {
  historyKey,
  noRowFacts,
  RowFacts,
  Tree,
  type AgentRowFacts,
  type TreeState,
} from "./tree-state.ts";

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
 * A tree of agents with what each is doing (a subagent's row opens it as the whole chat). Every
 * row subscribes to its own entity. Rows that join while the tab is open rise in.
 */
export function WorkTree(props: {
  threadId: string;
  nodes: readonly AgentTreeNode[];
  /** The tree's accessible name. */
  label?: string | undefined;
  facts?: AgentRowFacts | undefined;
}) {
  return (
    <ArrivalScope>
      <RowFacts value={props.facts ?? noRowFacts}>
        <AgentTree
          threadId={props.threadId}
          nodes={props.nodes}
          label={props.label ?? "Agent tree"}
        />
      </RowFacts>
    </ArrivalScope>
  );
}

/** Every agent id a tree shows, at any depth. */
function shows(
  nodes: readonly AgentTreeNode[],
  earlier: ReadonlyMap<string, readonly { id: string }[]>,
  id: string,
): boolean {
  return nodes.some(
    (node) =>
      node.id === id ||
      earlier.get(node.id)?.some((run) => run.id === id) === true ||
      shows(node.children, earlier, id),
  );
}

/** The agent tree: a tree widget, one Tab stop, with folding branches. */
function AgentTree(props: { threadId: string; nodes: readonly AgentTreeNode[]; label: string }) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const facts = use(RowFacts);
  const ui = workspace.tabs.find((tab) => tab.key === "work")?.ui;
  const selected = ui?.selected;
  const setActive = useCallback(
    (id: string | undefined) => actions.updateUi("work", { selected: id }),
    [actions],
  );
  const folded = ui?.collapsed;
  const collapsed = useMemo(() => new Set(folded), [folded]);
  const sections = ui?.sections;
  const history = useMemo(
    () =>
      new Set(
        Object.entries(sections ?? {}).flatMap(([key, open]) =>
          key.startsWith("history:") && open ? [key.slice("history:".length)] : [],
        ),
      ),
    [sections],
  );
  const treeId = useId();
  const subagents = useMemo(() => subagentCounts(props.nodes), [props.nodes]);
  // The Summary holds more than one tree: the selected row keeps the Tab stop in its own tree,
  // and every other tree's first row holds one.
  const active = useMemo(
    () => (selected && shows(props.nodes, facts.earlier, selected) ? selected : props.nodes[0]?.id),
    [selected, props.nodes, facts.earlier],
  );
  const state = useMemo<TreeState>(
    () => ({
      id: treeId,
      subagents,
      active,
      setActive,
      collapsed,
      history,
      fold: (id, open) => {
        // A row with subagents folds them; a lone agent folds its earlier runs.
        if (!subagents.get(id)) {
          actions.updateUi("work", { sections: { ...sections, [historyKey(id)]: open } });
          return;
        }
        const next = new Set(collapsed);
        if (open) next.delete(id);
        else next.add(id);
        actions.updateUi("work", { collapsed: [...next] });
      },
    }),
    [treeId, subagents, active, collapsed, history, sections, setActive, actions],
  );
  return (
    <Tree value={state}>
      <ul role="tree" aria-label={props.label} onKeyDown={treeKeys(state)}>
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

/** The rail a row's subagents hang on, under their parent's glyph. */
const rail = "ml-4 border-l border-border-soft pl-1.5";

/**
 * One agent and its subtree; a subagent spawned while the tab is open rises in. An agent a
 * provider ran again keeps its earlier runs under it, folded until the person opens them.
 */
function BranchNode(props: { threadId: string; node: AgentTreeNode; depth: number }) {
  const { node } = props;
  const tree = use(Tree);
  const facts = use(RowFacts);
  const earlier = facts.earlier.get(node.id) ?? [];
  const parent = node.children.length > 0;
  const open = parent ? !tree.collapsed.has(node.id) : tree.history.has(node.id);
  const folds = parent || earlier.length > 0;
  const group = `${tree.id}-${node.id}`;
  return (
    <li role="none" className={useArrival()}>
      <AgentRow
        threadId={props.threadId}
        agentId={node.id}
        depth={props.depth}
        expanded={folds ? open : undefined}
        owns={folds && open ? group : undefined}
        subagents={tree.subagents.get(node.id) ?? 0}
      />
      {folds && open && (
        // Owned by the row above (aria-owns): the tree item's children, in tree terms.
        <ul role="group" id={group} className={rail}>
          <Branch threadId={props.threadId} nodes={node.children} depth={props.depth + 1} />
          {earlier.map((run) => (
            <li role="none" key={run.id}>
              <AgentRow
                threadId={props.threadId}
                agentId={run.id}
                depth={props.depth + 1}
                expanded={undefined}
                owns={undefined}
                subagents={0}
                earlierRun
              />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
