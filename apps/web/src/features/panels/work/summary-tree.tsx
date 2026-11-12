import { foldFinished, type ForestNode, type ForestRow, type ThreadWork } from "@ace/ui-core";
import type { Interaction } from "@ace/protocol";
import { useCallback, useMemo, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/cn.ts";
import { rowMotion, useListMotion, usePresence } from "@/lib/motion.ts";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentLine, CommandLine, FinishedLine, guideLeft } from "./summary-rows.tsx";
import { treeItems, useKeptFocus } from "./summary-tree-focus.ts";

/** The key a person's fold of a row is kept under, with the Summary tab. */
const foldKey = (row: string) => `fold:${row}`;

/**
 * The tree's keys: one Tab stop; ↑/↓ move, →/← unfold, fold or step in and out, Home/End jump,
 * Enter opens the row, Delete or S moves to a running row's Stop.
 */
function treeKeys(setActive: (key: string) => void, fold: (key: string, open: boolean) => void) {
  return (event: KeyboardEvent<HTMLUListElement>) => {
    const items = treeItems(event.currentTarget);
    const item = event.target instanceof HTMLElement ? event.target : undefined;
    const at = item ? items.indexOf(item) : -1;
    if (!item || at < 0) return;
    const key = item.dataset.row ?? "";
    const level = Number(item.getAttribute("aria-level"));
    const expanded = item.getAttribute("aria-expanded");
    const focus = (index: number) => {
      const next = items[Math.max(0, Math.min(items.length - 1, index))];
      if (!next) return;
      setActive(next.dataset.row ?? "");
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
      if (expanded === "false") fold(key, true);
      else if (expanded === "true") focus(at + 1);
      else return;
    } else if (event.key === "ArrowLeft") {
      if (expanded === "true") fold(key, false);
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
 * For every row of the tree, the row on screen that stands for it: itself when shown, the
 * "N done" line it folded into, or the row of the folded branch it sits in. Mirrors `Branch`.
 */
function standIns(
  roots: readonly ForestNode[],
  isOpen: (node: ForestNode, depth: number) => boolean,
  isShown: (key: string) => boolean,
): Map<string, string> {
  const stand = new Map<string, string>();
  const hide = (nodes: readonly ForestNode[], by: string) => {
    for (const node of nodes) {
      stand.set(node.key, by);
      hide(node.children, by);
    }
  };
  const visit = (node: ForestNode, depth: number) => {
    stand.set(node.key, node.key);
    if (!node.children.length) return;
    if (isOpen(node, depth)) walk(node.children, depth + 1, node.key);
    else hide(node.children, node.key);
  };
  const walk = (nodes: readonly ForestNode[], depth: number, parent?: string) => {
    if (parent === undefined) {
      for (const node of nodes) visit(node, depth);
      return;
    }
    for (const row of foldFinished(parent, nodes)) {
      if (row.kind === "node") {
        visit(row.node, depth);
        continue;
      }
      stand.set(row.key, row.key);
      if (isShown(row.key)) for (const node of row.nodes) visit(node, depth);
      else hide(row.nodes, row.key);
    }
  };
  walk(roots, 0);
  return stand;
}

interface TreeContext {
  viewed: string;
  active: string | undefined;
  setActive(key: string): void;
  isOpen(node: ForestNode, depth: number): boolean;
  /** Whether a run of finished siblings shows its rows; folded until the person opens it. */
  isShown(key: string): boolean;
  fold(key: string, open: boolean): void;
  requests: ReadonlyMap<string, Interaction>;
}

/**
 * Every agent of the thread and of the threads it delegated, at every depth, each level 18px in
 * on a hairline guide. A live branch is open and a finished one folded until the person folds or
 * opens it; their choice is kept with the thread's Summary tab.
 */
export function SummaryTree(props: {
  threadId: string;
  roots: readonly ForestNode[];
  works: ReadonlyMap<string, ThreadWork>;
}) {
  const workspace = useScopeWorkspace(props.threadId);
  const actions = useWorkspaceActions(props.threadId);
  const sections = workspace.tabs.find((tab) => tab.key === "work")?.ui?.sections;
  const [selected, setActive] = useState<string>();
  const requests = useMemo(() => {
    const map = new Map<string, Interaction>();
    for (const [threadId, work] of props.works)
      for (const interaction of work.interactions) {
        const key = `${threadId}/${interaction.agentId}`;
        if (!map.has(key)) map.set(key, interaction);
      }
    return map;
  }, [props.works]);
  // The main agent's row stays open: it is the tree itself, not a branch of it.
  const isOpen = useCallback(
    (node: ForestNode, depth: number) =>
      sections?.[foldKey(node.key)] ?? (node.live || depth === 0),
    [sections],
  );
  const isShown = useCallback((key: string) => sections?.[foldKey(key)] ?? false, [sections]);
  const stand = useMemo(
    () => standIns(props.roots, isOpen, isShown),
    [props.roots, isOpen, isShown],
  );
  // The selected row may have folded away (an agent finished into "N done"): the row standing
  // for it takes the tree's Tab stop, so the tree is never left without one.
  const active = (selected === undefined ? undefined : stand.get(selected)) ?? props.roots[0]?.key;
  const { tree, onFocus, onBlur } = useKeptFocus(active);
  const context: TreeContext = {
    viewed: props.threadId,
    active,
    setActive,
    isOpen,
    isShown,
    fold: (key, open) =>
      actions.updateUi("work", { sections: { ...sections, [foldKey(key)]: open } }),
    requests,
  };
  return (
    <ul
      ref={tree}
      role="tree"
      aria-label="Agent tree"
      onKeyDown={treeKeys(setActive, context.fold)}
      onFocus={onFocus}
      onBlur={onBlur}
      className="-mx-1"
    >
      <Branch nodes={props.roots} depth={0} context={context} />
    </ul>
  );
}

/** A row of one level: an agent or command, or a run of finished siblings folded into one. */
type LevelRow = ForestRow;
const levelKey = (row: LevelRow) => (row.kind === "node" ? row.node.key : row.key);
/** Agents finishing together leave one after another, this far apart. */
const foldStagger = 40;

/**
 * One level of the tree. Under a parent, finished siblings fold into one "N done" row that opens
 * in place; the tree's own roots always show. Rows that leave fade out where they were, one
 * after another, before the level closes up; rows that arrive rise in.
 */
function Branch(props: {
  nodes: readonly ForestNode[];
  depth: number;
  context: TreeContext;
  parent?: string | undefined;
}) {
  const { depth, context, parent, nodes } = props;
  const level = useMemo(
    (): LevelRow[] =>
      parent === undefined
        ? nodes.map((node) => ({ kind: "node", node }))
        : foldFinished(parent, nodes),
    [parent, nodes],
  );
  // However many agents a sync finishes at once, each fold plays: the stagger bounds the time.
  const { rows } = useListMotion(level, levelKey, {
    exitStagger: foldStagger,
    bulkAt: Number.POSITIVE_INFINITY,
  });
  // A leaving row is drawn from its latest state, so an agent that just finished doesn't pulse
  // on its way out.
  const latest = useMemo(() => {
    const map = new Map<string, ForestNode>();
    for (const row of level)
      if (row.kind === "node") map.set(row.node.key, row.node);
      else for (const node of row.nodes) map.set(node.key, node);
    return map;
  }, [level]);
  return rows.map(({ key, item: row, phase, delay }) => {
    const exiting = phase === "exit";
    const motion = {
      className: rowMotion(phase),
      inert: exiting,
      "aria-hidden": exiting || undefined,
      style: delay ? { animationDelay: `${delay}ms` } : undefined,
    };
    if (row.kind === "node") {
      const node = latest.get(key) ?? row.node;
      return <BranchNode key={key} node={node} depth={depth} context={context} motion={motion} />;
    }
    const shown = context.isShown(row.key);
    return (
      <li key={key} role="none" {...motion}>
        <FinishedLine
          rowKey={row.key}
          count={row.nodes.length}
          depth={depth}
          expanded={shown}
          active={!exiting && context.active === row.key}
          onFocus={() => context.setActive(row.key)}
          onFold={() => context.fold(row.key, !shown)}
        />
        {shown && (
          <ul role="group">
            {row.nodes.map((node) => (
              <BranchNode key={node.key} node={node} depth={depth} context={context} />
            ))}
          </ul>
        )}
      </li>
    );
  });
}

interface RowMotionProps {
  className: string | undefined;
  inert: boolean;
  "aria-hidden": true | undefined;
  style: { animationDelay: string } | undefined;
}

function BranchNode(props: {
  node: ForestNode;
  depth: number;
  context: TreeContext;
  motion?: RowMotionProps;
}) {
  const { node, depth, context, motion } = props;
  const parent = node.children.length > 0;
  const open = parent ? context.isOpen(node, depth) : undefined;
  // A branch that closes, by hand or because its agents finished, fades its rows out first.
  const children = usePresence(open === true);
  const row = {
    depth,
    expanded: open,
    active: !motion?.inert && context.active === node.key,
    onFocus: () => context.setActive(node.key),
    onFold: () => context.fold(node.key, !open),
  };
  // A delegate speaks for its thread's main agent: that agent's request is its own.
  const request =
    node.kind === "agent"
      ? (context.requests.get(node.key) ??
        (node.childThread && node.childRoot
          ? context.requests.get(`${node.childThread}/${node.childRoot.id}`)
          : undefined))
      : undefined;
  return (
    <li role="none" {...motion}>
      {node.kind === "agent" ? (
        <AgentLine {...row} node={node} viewed={context.viewed} request={request} />
      ) : (
        <CommandLine {...row} node={node} viewed={context.viewed} />
      )}
      {children.mounted && (
        <ul
          role="group"
          inert={!open}
          aria-hidden={!open || undefined}
          className={cn("relative", children.toggled && rowMotion(children.phase))}
        >
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-2 w-px bg-border"
            style={{ left: guideLeft(depth) }}
          />
          <Branch nodes={node.children} depth={depth + 1} context={context} parent={node.key} />
        </ul>
      )}
    </li>
  );
}
