import type { ForestNode, ThreadWork } from "@ace/ui-core";
import type { Interaction } from "@ace/protocol";
import { useMemo, useState, type KeyboardEvent } from "react";
import { useScopeWorkspace, useWorkspaceActions } from "@/lib/workspace/index.ts";
import { AgentLine, CommandLine, guideLeft } from "./summary-rows.tsx";

/** The key a person's fold of a row is kept under, with the Summary tab. */
const foldKey = (row: string) => `fold:${row}`;

/**
 * The tree's keys: one Tab stop; ↑/↓ move, →/← unfold, fold or step in and out, Home/End jump,
 * Enter opens the row, Delete or S moves to a running row's Stop.
 */
function treeKeys(setActive: (key: string) => void, fold: (key: string, open: boolean) => void) {
  return (event: KeyboardEvent<HTMLUListElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
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

interface TreeContext {
  viewed: string;
  active: string | undefined;
  setActive(key: string): void;
  isOpen(node: ForestNode, depth: number): boolean;
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
  const active = selected ?? props.roots[0]?.key;
  const context: TreeContext = {
    viewed: props.threadId,
    active,
    setActive,
    // The main agent's row stays open: it is the tree itself, not a branch of it.
    isOpen: (node, depth) => sections?.[foldKey(node.key)] ?? (node.live || depth === 0),
    fold: (key, open) =>
      actions.updateUi("work", { sections: { ...sections, [foldKey(key)]: open } }),
    requests,
  };
  return (
    <ul
      role="tree"
      aria-label="Agent tree"
      onKeyDown={treeKeys(setActive, context.fold)}
      className="-mx-1"
    >
      <Branch nodes={props.roots} depth={0} context={context} />
    </ul>
  );
}

function Branch(props: { nodes: readonly ForestNode[]; depth: number; context: TreeContext }) {
  return props.nodes.map((node) => (
    <BranchNode key={node.key} node={node} depth={props.depth} context={props.context} />
  ));
}

function BranchNode(props: { node: ForestNode; depth: number; context: TreeContext }) {
  const { node, depth, context } = props;
  const parent = node.children.length > 0;
  const open = parent ? context.isOpen(node, depth) : undefined;
  const row = {
    depth,
    expanded: open,
    active: context.active === node.key,
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
    <li role="none">
      {node.kind === "agent" ? (
        <AgentLine {...row} node={node} viewed={context.viewed} request={request} />
      ) : (
        <CommandLine {...row} node={node} viewed={context.viewed} />
      )}
      {open && (
        <ul role="group" className="relative">
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-2 w-px bg-border"
            style={{ left: guideLeft(depth) }}
          />
          <Branch nodes={node.children} depth={depth + 1} context={context} />
        </ul>
      )}
    </li>
  );
}
