import {
  activateTab,
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
  type WorkspaceTab,
} from "./model.ts";
import type { ClosingTab } from "./registry.ts";
import type { WorkspaceStore } from "./store.ts";

/** A request from a feature: the dock defaults to the kind's preferred one. */
export type OpenTab = Omit<OpenRequest, "dock"> & { dock?: Dock | undefined };

/** Everything a feature or the shell does to one scope's workspace. */
export interface WorkspaceActions {
  /** Open (or show, if already open) a resource. */
  open(request: OpenTab): void;
  /** A tool's shortcut: show it, or hide its dock if it is already showing. */
  toggleKind(kind: string): void;
  /** A tool's shortcut as the tool defines it (`onShortcut`), else `toggleKind`. */
  shortcut(kind: string): void;
  /** A new launcher tab in `dock` (default right). */
  newTab(dock?: Dock): void;
  activate(key: string): void;
  /**
   * Close a tab. One whose kind warns (a terminal's running shell) asks first; resolves whether
   * it closed. Tabs that don't ask close before this returns.
   */
  close(key: string): Promise<boolean>;
  /** Close the dock's other unpinned tabs, asking once if any of them warn. */
  closeOthers(key: string): Promise<boolean>;
  /** Bring back the tab closed most recently, where it was. Returns whether one came back. */
  reopen(): boolean;
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
  /** After a tab closed: release what it alone held, and keep it for Reopen closed tab. */
  const closed = (tab: WorkspaceTab, dock: Dock, index: number) => {
    store.rememberClosed(scope, { tab, dock, index });
    definition()?.kind(tab.kind)?.onClose?.(scope, tab);
  };
  /** What closing these tabs (present now) would stop, if any kind warns (asked once). */
  const warningFor = (keys: readonly string[]) => {
    const current = definition();
    const workspace = store.get(scope);
    const byKind = new Map<string, ClosingTab[]>();
    for (const key of keys) {
      const where = findTab(workspace, key);
      if (!where) continue;
      const { tab } = where;
      const list = byKind.get(tab.kind) ?? [];
      list.push({ tab, dock: where.dock, title: current?.title(tab) ?? tab.title ?? tab.kind });
      byKind.set(tab.kind, list);
    }
    for (const [kind, closing] of byKind) {
      const warning = current?.kind(kind)?.closeWarning?.(scope, closing);
      if (warning) return warning;
    }
    return undefined;
  };
  /**
   * Close exactly the tabs `keys` names that are still open, then show `focus` if given. Tabs
   * opened or replaced meanwhile (a waiting terminal that became a shell) are other resources:
   * a yes given for these never closes those.
   */
  const closeNow = (keys: readonly string[], focus?: string) => {
    const before = store.get(scope);
    const gone = keys.flatMap((key) => {
      const found = findTab(before, key);
      return found ? [found] : [];
    });
    if (!gone.length) return false;
    change((workspace) => {
      const next = gone.reduce((each, { tab }) => closeTab(each, tab.key), workspace);
      return focus && findTab(next, focus) ? activateTab(next, focus) : next;
    });
    for (const { tab, dock, index } of gone) closed(tab, dock, index);
    return true;
  };
  /**
   * Close `keys`, asking first when a kind warns what that would stop. Waits for the kinds when
   * they haven't loaded (a shortcut pressed as the screen opens): an unknown kind is never
   * taken to mean "nothing to lose". If they can't load, the tabs stay. Tabs that don't ask
   * close before this returns.
   */
  const guardedClose = (keys: readonly string[], focus?: string): Promise<boolean> => {
    const attempt = (): boolean | Promise<boolean> => {
      const present = keys.filter((key) => findTab(store.get(scope), key));
      if (!present.length) return false;
      const warning = warningFor(present);
      if (!warning) return closeNow(present, focus);
      return store.confirmClose(warning).then((agreed) => agreed && closeNow(present, focus));
    };
    const current = definition();
    if (!current || current.loaded()) return Promise.resolve(attempt());
    return current.load().then(attempt, () => false);
  };
  const actions: WorkspaceActions = {
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
    shortcut: (kind) =>
      withKinds(() => {
        const handler = definition()?.kind(kind)?.onShortcut;
        if (handler) handler(scope);
        else actions.toggleKind(kind);
      }),
    newTab: (dock = "right") =>
      change((workspace) => {
        const fresh = launcher(workspace, dock);
        return fresh ? openTab(workspace, fresh) : workspace;
      }),
    activate: (key) => change((workspace) => activateTab(workspace, key)),
    close: (key) => guardedClose([key]),
    closeOthers: (key) => {
      const found = findTab(store.get(scope), key);
      if (!found) return Promise.resolve(false);
      // Exactly the tabs beside it now; what opens while the question is asked stays.
      const dockTabs = store.get(scope)[found.dock].tabs;
      const others = dockTabs.filter((tab) => !tab.pinned && tab.key !== key).map((tab) => tab.key);
      return guardedClose(others, key);
    },
    reopen: () => {
      const current = definition();
      const back = store.takeClosed(scope, ({ tab }) => {
        const kind = current?.kind(tab.kind);
        if (current && !kind) return false;
        if (findTab(store.get(scope), tab.key)) return false;
        return kind?.reopenable?.(scope, tab) ?? true;
      });
      if (!back) return false;
      const { tab, dock, index } = back;
      change((workspace) => {
        const opened = openTab(workspace, {
          kind: tab.kind,
          id: tab.id,
          title: tab.title,
          data: tab.data,
          pinned: tab.pinned,
          dock,
        });
        const at = Math.min(index, opened[dock].tabs.length - 1);
        return moveTab(opened, tab.key, at);
      });
      return true;
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
  return actions;
}
