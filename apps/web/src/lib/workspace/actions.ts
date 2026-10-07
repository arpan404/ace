import {
  activateTab,
  closeTab,
  cycleTab,
  findTab,
  moveTab,
  openTab,
  replaceTab,
  setExpanded,
  setPanelOpen,
  setPanelSize,
  setTabPinned,
  shownTab,
  updateTab,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
} from "./model.ts";
import type { ClosingTab } from "./registry.ts";
import type { WorkspaceStore } from "./store.ts";

/** A request from a feature: the kind fills in whether it is pinned and a singleton. */
export type OpenTab = OpenRequest;

/** Everything a feature or the shell does to one scope's side panel. */
export interface WorkspaceActions {
  /** Open (or show, if already open) a resource. */
  open(request: OpenTab): void;
  /** A tool's shortcut: show it, or hide the panel if it is already showing. */
  toggleKind(kind: string): void;
  /** A tool's shortcut as the tool defines it (`onShortcut`), else `toggleKind`. */
  shortcut(kind: string): void;
  /** A new launcher tab. */
  newTab(): void;
  activate(key: string): void;
  /**
   * Close a tab. One whose kind warns (a terminal's running shell) asks first; resolves whether
   * it closed. Tabs that don't ask close before this returns.
   */
  close(key: string): Promise<boolean>;
  /** Close the other unpinned tabs, asking once if any of them warn. */
  closeOthers(key: string): Promise<boolean>;
  /** Bring back the tab closed most recently, where it was. Returns whether one came back. */
  reopen(): boolean;
  move(key: string, toIndex: number): void;
  setPinned(key: string, pinned: boolean): void;
  /** Turn one tab into another resource in place (the launcher into the tool picked). */
  replace(key: string, request: OpenRequest): void;
  update(key: string, patch: { title?: string; data?: unknown }): void;
  cycle(delta: 1 | -1): void;
  setOpen(open: boolean): void;
  toggle(): void;
  setExpanded(expanded: boolean): void;
  /** Live while dragging; `persist` when the gesture ends. Also becomes the preferred width. */
  setSize(size: number, persist: boolean): void;
}

export function workspaceActions(store: WorkspaceStore, scope: string): WorkspaceActions {
  const change = (fn: (workspace: ScopeWorkspace) => ScopeWorkspace, persist = true) =>
    store.update(scope, fn, { persist });
  const definition = () => store.definition(scope);
  const request = (open: OpenTab): OpenRequest => definition()?.request(open) ?? open;
  /**
   * Run something that needs the kinds (whether a tool is a singleton or pinned): now if they
   * have loaded, else as soon as they have. They load right after first paint, so only a
   * shortcut pressed in that moment waits.
   */
  const withKinds = (run: () => void) => {
    const current = definition();
    if (!current || current.loaded()) run();
    else void current.load().then(run, () => undefined);
  };
  /** A new launcher tab; several can be open at once, like a browser's new tabs. */
  const launcher = (workspace: ScopeWorkspace): OpenRequest | undefined => {
    const kind = definition()?.launcher;
    if (!kind) return undefined;
    const taken = workspace.tabs
      .filter((tab) => tab.kind === kind)
      .map((tab) => Number(tab.id) || 0);
    return { kind, id: String(Math.max(0, ...taken) + 1) };
  };
  /** Showing an empty panel opens something to show: the initial tabs, or the launcher. */
  const show = () =>
    change((workspace) => {
      if (workspace.tabs.length) return setPanelOpen(workspace, true);
      const initial = definition()?.initial ?? [];
      if (initial.length) return initial.reduce((next, each) => openTab(next, each), workspace);
      const fresh = launcher(workspace);
      return fresh ? openTab(workspace, fresh) : workspace;
    });
  /** After a tab closed: release what it alone held, and keep it for Reopen closed tab. */
  const closed = (tab: WorkspaceTab, index: number) => {
    store.rememberClosed(scope, { tab, index });
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
      list.push({ tab, title: current?.title(tab) ?? tab.title ?? tab.kind });
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
    for (const { tab, index } of gone) closed(tab, index);
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
          const existing = workspace.tabs.find((tab) => tab.kind === kind);
          if (!existing) return openTab(workspace, request({ kind }));
          const showing = workspace.open && shownTab(workspace)?.key === existing.key;
          return showing ? setPanelOpen(workspace, false) : activateTab(workspace, existing.key);
        }),
      ),
    shortcut: (kind) =>
      withKinds(() => {
        const handler = definition()?.kind(kind)?.onShortcut;
        if (handler) handler(scope);
        else actions.toggleKind(kind);
      }),
    newTab: () =>
      change((workspace) => {
        const fresh = launcher(workspace);
        return fresh ? openTab(workspace, fresh) : workspace;
      }),
    activate: (key) => change((workspace) => activateTab(workspace, key)),
    close: (key) => guardedClose([key]),
    closeOthers: (key) => {
      if (!findTab(store.get(scope), key)) return Promise.resolve(false);
      // Exactly the tabs beside it now; what opens while the question is asked stays.
      const others = store
        .get(scope)
        .tabs.filter((tab) => !tab.pinned && tab.key !== key)
        .map((tab) => tab.key);
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
      const { tab, index } = back;
      change((workspace) => {
        const opened = openTab(workspace, {
          kind: tab.kind,
          id: tab.id,
          title: tab.title,
          data: tab.data,
          pinned: tab.pinned,
        });
        return moveTab(opened, tab.key, Math.min(index, opened.tabs.length - 1));
      });
      return true;
    },
    move: (key, toIndex) => change((workspace) => moveTab(workspace, key, toIndex)),
    setPinned: (key, pinned) => change((workspace) => setTabPinned(workspace, key, pinned)),
    replace: (key, next) =>
      withKinds(() => change((workspace) => replaceTab(workspace, key, request(next)))),
    update: (key, patch) => change((workspace) => updateTab(workspace, key, patch)),
    cycle: (delta) => change((workspace) => cycleTab(workspace, delta)),
    setOpen: (open) => (open ? show() : change((workspace) => setPanelOpen(workspace, false))),
    toggle: () => {
      if (store.get(scope).open) change((workspace) => setPanelOpen(workspace, false));
      else show();
    },
    setExpanded: (expanded) => {
      if (expanded && !store.get(scope).tabs.length) show();
      change((workspace) => setExpanded(workspace, expanded));
    },
    setSize: (size, persist) => {
      change((workspace) => setPanelSize(workspace, size), persist);
      store.setPreferred(size, persist);
    },
  };
  return actions;
}
