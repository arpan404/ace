import { useEffect, useState, type ReactNode } from "react";
import {
  tabKey,
  useScopeWorkspace,
  useWorkspaceActions,
  type WorkspaceTab,
} from "@/lib/workspace/index.ts";
import { cn } from "@/lib/cn.ts";
import { LocalStore } from "../store.ts";

/** Two of a thread's browser tabs side by side in the panel, by daemon tab id. */
export interface Split {
  left: string;
  right: string;
}

/** Each thread's split view, while it has one. */
export const splits = new LocalStore<ReadonlyMap<string, Split>>(new Map());

export function openSplit(threadId: string, left: string, right: string): void {
  if (left === right) return;
  splits.set((all) => new Map(all).set(threadId, { left, right }));
}

export function endSplit(threadId: string): void {
  if (!splits.get().has(threadId)) return;
  splits.set((all) => {
    const next = new Map(all);
    next.delete(threadId);
    return next;
  });
}

/** The split a daemon tab is part of, if any. */
export function splitOf(threadId: string, tabId: string | undefined): Split | undefined {
  const split = splits.get().get(threadId);
  return split && tabId && (split.left === tabId || split.right === tabId) ? split : undefined;
}

/** What one half of a split hands the page it shows. */
export interface SplitPane {
  /** The daemon tab drawn in this half (its native view is placed by this id). */
  tabId: string;
  /** The half the person works in now: its tab is the thread's shown tab. */
  focused: boolean;
  /** Close this half; the other tab fills the panel again. */
  onLeave(): void;
}

/**
 * Split view: two browser tabs side by side, each with its own toolbar and address bar. The
 * half the person last pressed or focused is the thread's shown tab; the other keeps its page
 * (in the desktop app live, elsewhere as its last picture). Closing either half, or either tab
 * leaving, returns the panel to one tab.
 */
export function SplitBrowser(props: {
  threadId: string;
  split: Split;
  /** The panel tab that drew the split: it starts as the focused half. */
  from: string;
  render(tab: WorkspaceTab, pane: SplitPane): ReactNode;
}) {
  const { threadId, split } = props;
  const workspace = useScopeWorkspace(threadId);
  const actions = useWorkspaceActions(threadId);
  const [focused, setFocused] = useState<string>(props.from);
  const find = (id: string) => workspace.tabs.find((tab) => tab.key === tabKey("browser", id));
  const left = find(split.left);
  const right = find(split.right);
  const missing = !left || !right;
  useEffect(() => {
    if (missing) endSplit(threadId);
  }, [missing, threadId]);
  if (!left || !right) return null;
  const leave = (other: string) => {
    endSplit(threadId);
    actions.activate(tabKey("browser", other));
  };
  const half = (tab: WorkspaceTab, id: string, other: string, edge: boolean) => (
    <div
      key={id}
      data-split-half=""
      onPointerDownCapture={() => setFocused(id)}
      onFocusCapture={() => setFocused(id)}
      className={cn("relative flex min-h-0 min-w-0 flex-col", edge && "border-l border-border")}
    >
      {props.render(tab, { tabId: id, focused: focused === id, onLeave: () => leave(other) })}
    </div>
  );
  return (
    <div className="grid h-full min-h-0 grid-cols-2">
      {half(left, split.left, split.right, false)}
      {half(right, split.right, split.left, true)}
    </div>
  );
}
