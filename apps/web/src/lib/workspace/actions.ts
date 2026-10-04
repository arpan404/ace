import {
  activateTab,
  closeOtherTabs,
  closeTab,
  cycleTab,
  findTab,
  moveTab,
  moveTabToDock,
  openTab,
  replaceTab,
  setBottomMaximized,
  setSummaryPinned,
  setDockOpen,
  setDockSize,
  setExpanded,
  setTabPinned,
  shownTab,
  updateTab,
  type Dock,
  type OpenRequest,
  type ScopeWorkspace,
} from "./model.ts";
import type { WorkspaceStore } from "./store.ts";

/** A request from a feature: the dock defaults to the kind's preferred one. */
export type OpenTab = Omit<OpenRequest, "dock"> & { dock?: Dock | undefined };

/** Everything a feature or the shell does to one scope's workspace. */
export interface WorkspaceActions {
  /** Open (or show, if already open) a resource. */
  open(request: OpenTab): void;
  /** A tool's shortcut: show it, or hide its dock if it is already showing. */
  toggleKind(kind: string): void;
  /** A new launcher tab in `dock` (default right). */
  newTab(dock?: Dock): void;
  activate(key: string): void;
  close(key: string): void;
  closeOthers(key: string): void;
  move(key: string, toIndex: number): void;
  moveToDock(key: string, dock: Dock, index?: number): void;
  setPinned(key: string, pinned: boolean): void;
  /** Turn one tab into another resource in place (the launcher into the tool picked). */
  replace(key: string, request: Omit<OpenRequest, "dock">): void;
  update(key: string, patch: { title?: string; data?: unknown }): void;
  cycle(dock: Dock, delta: 1 | -1): void;
  setOpen(dock: Dock, open: boolean): void;
  toggle(dock: Dock): void;
  setExpanded(expanded: boolean): void;
  setBottomMaximized(maximized: boolean): void;
  /** Keep the summary card open for this scope (it comes back on return and after a reload). */
  setSummaryPinned(pinned: boolean): void;
  /** Live while dragging; `persist` when the gesture ends. Also becomes the preferred size. */
  setSize(dock: Dock, size: number, persist: boolean): void;
}

export function workspaceActions(store: WorkspaceStore, scope: string): WorkspaceActions {
  const change = (fn: (workspace: ScopeWorkspace) => ScopeWorkspace, persist = true) =>
    store.update(scope, fn, { persist });
  const definition = () => store.definition(scope);
  const request = (open: OpenTab): OpenRequest =>
    definition()?.request(open) ?? { ...open, dock: open.dock ?? "right" };
  /**
   * Run something that needs the kinds (which dock a tool goes to, whether it is a singleton):
   * now if they have loaded, else as soon as they have. They load right after first paint, so
   * only a shortcut pressed in that moment waits.
   */
  const withKinds = (run: () => void) => {
    const current = definition();
    if (!current || current.loaded()) run();
    else void current.load().then(run, () => undefined);
  };
  /** A new launcher tab; several can be open at once, like a browser's new tabs. */
  const launcher = (workspace: ScopeWorkspace, dock: Dock): OpenRequest | undefined => {
    const kind = definition()?.launcher;
    if (!kind) return undefined;
    const taken = [...workspace.right.tabs, ...workspace.bottom.tabs]
      .filter((tab) => tab.kind === kind)
      .map((tab) => Number(tab.id) || 0);
    return { kind, id: String(Math.max(0, ...taken) + 1), dock };
  };
  /** Showing an empty dock opens something to show: the launcher, or the initial tabs. */
  const show = (dock: Dock) =>
    change((workspace) => {
      if (workspace[dock].tabs.length) return setDockOpen(workspace, dock, true);
      const initial = (definition()?.initial ?? []).filter((each) => each.dock === dock);
      if (initial.length) return initial.reduce((next, each) => openTab(next, each), workspace);
      const fresh = launcher(workspace, dock);
      return fresh ? openTab(workspace, fresh) : workspace;
    });
  return {
    open: (open) => withKinds(() => change((workspace) => openTab(workspace, request(open)))),
    toggleKind: (kind) =>
      withKinds(() =>
        change((workspace) => {
          const resolved = request({ kind });
          const first = [...workspace.right.tabs, ...workspace.bottom.tabs].find(
            (tab) => tab.kind === kind,
          );
          const existing = first && findTab(workspace, first.key);
          if (existing) {
            const state = workspace[existing.dock];
            const showing = state.open && shownTab(state)?.key === existing.tab.key;
            return showing
              ? setDockOpen(workspace, existing.dock, false)
              : activateTab(workspace, existing.tab.key);
          }
          return openTab(workspace, resolved);
        }),
      ),
    newTab: (dock = "right") =>
      change((workspace) => {
        const fresh = launcher(workspace, dock);
        return fresh ? openTab(workspace, fresh) : workspace;
      }),
    activate: (key) => change((workspace) => activateTab(workspace, key)),
    close: (key) => {
      const tab = findTab(store.get(scope), key)?.tab;
      change((workspace) => closeTab(workspace, key));
      if (tab) definition()?.kind(tab.kind)?.onClose?.(scope, tab);
    },
    closeOthers: (key) => {
      const before = store.get(scope);
      change((workspace) => closeOtherTabs(workspace, key));
      const after = store.get(scope);
      for (const dock of ["right", "bottom"] as const)
        for (const tab of before[dock].tabs)
          if (!findTab(after, tab.key)) definition()?.kind(tab.kind)?.onClose?.(scope, tab);
    },
    move: (key, toIndex) => change((workspace) => moveTab(workspace, key, toIndex)),
    moveToDock: (key, dock, index) =>
      withKinds(() =>
        change((workspace) => {
          const found = findTab(workspace, key);
          const allowed = found && definition()?.kind(found.tab.kind)?.docks;
          if (allowed && !allowed.includes(dock)) return workspace;
          return moveTabToDock(workspace, key, dock, index);
        }),
      ),
    setPinned: (key, pinned) => change((workspace) => setTabPinned(workspace, key, pinned)),
    replace: (key, next) =>
      withKinds(() =>
        change((workspace) => {
          const resolved = request(next);
          return replaceTab(workspace, key, { ...next, id: resolved.id, pinned: resolved.pinned });
        }),
      ),
    update: (key, patch) => change((workspace) => updateTab(workspace, key, patch)),
    cycle: (dock, delta) => change((workspace) => cycleTab(workspace, dock, delta)),
    setOpen: (dock, open) =>
      open ? show(dock) : change((workspace) => setDockOpen(workspace, dock, false)),
    toggle: (dock) => {
      if (store.get(scope)[dock].open) change((workspace) => setDockOpen(workspace, dock, false));
      else show(dock);
    },
    setExpanded: (expanded) => {
      if (expanded && !store.get(scope).right.tabs.length) show("right");
      change((workspace) => setExpanded(workspace, expanded));
    },
    setBottomMaximized: (maximized) => {
      if (maximized && !store.get(scope).bottom.tabs.length) show("bottom");
      change((workspace) => setBottomMaximized(workspace, maximized));
    },
    setSummaryPinned: (pinned) => change((workspace) => setSummaryPinned(workspace, pinned)),
    setSize: (dock, size, persist) => {
      change((workspace) => setDockSize(workspace, dock, size), persist);
      store.setPreferred(dock, size, persist);
    },
  };
}
