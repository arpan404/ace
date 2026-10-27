import {
  activateTab,
  closeTab,
  cycleTab,
  moveTab,
  openTab,
  restoreClosed,
  setExpanded,
  setPanelOpen,
  setPanelSize,
  setTabPinned,
  shownTab,
  updateTab,
  type OpenRequest,
  type ScopeWorkspace,
  type WorkspaceTab,
  type TabUiState,
} from "./model.ts";
import {
  atKey,
  bottomOf,
  locateTab,
  moveToPlace,
  openIn,
  placeOf,
  replaceAt,
  setBottomOpen,
  type PanelPlace,
} from "./places.ts";
import type { ClosingTab } from "./registry.ts";
import type { WorkspaceStore } from "./store.ts";

/** A request from a feature: the kind fills in whether it is pinned and a singleton. */
export type OpenTab = OpenRequest;

/** Everything a feature or the shell does to one scope's side panel. */
export interface WorkspaceActions {
  /**
   * Open (or show, if already open) a resource. `reveal: false` adds it without showing it or
   * the panel (a page an agent opened in the background).
   */
  open(request: OpenTab, options?: { reveal?: boolean }): void;
  /**
   * A tool's shortcut: show it, or hide the panel if it is already showing. A tool not open yet
   * takes the place of the new tab showing, as picking it from that tab would.
   */
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
  updateUi(key: string, patch: Partial<TabUiState>): void;
  cycle(delta: 1 | -1): void;
  setOpen(open: boolean): void;
  toggle(): void;
  setExpanded(expanded: boolean): void;
  setDock(dock: "side" | "bottom"): void;
  setBottomSize(size: number, persist: boolean): void;
  /** Live while dragging; `persist` when the gesture ends. Also becomes the preferred width. */
  setSize(size: number, persist: boolean): void;
  /** Show or hide the bottom panel. Showing an empty one opens its first kind (a terminal). */
  setBottomOpen(open: boolean): void;
  toggleBottom(): void;
  /** Move a tab to the other panel and show it there; what it shows carries on. */
  moveTo(key: string, place: PanelPlace): void;
  /** Where `toggleKind(kind)` acts now. */
  placeFor(kind: string): PanelPlace;
  /** The bottom panel's height on this device: live while dragging, `persist` at the end. */
  setBottomHeight(size: number, persist: boolean): void;
}

/**
 * One scope's actions. `here` is the panel asking (its own views and buttons): a new tab of a
 * kind the bottom panel holds opens in that panel. Elsewhere ("auto": the header, palette,
 * shortcuts) it opens where the person chose in Settings, while the screen has room for it.
 * Actions on an open tab act wherever that tab is.
 */
export function workspaceActions(
  store: WorkspaceStore,
  scope: string,
  here: PanelPlace | "auto" = "auto",
): WorkspaceActions {
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
  const holdsBottom = (kind: string) =>
    store.bottomFits && (definition()?.bottom?.kinds.includes(kind) ?? false);
  /** Where a new tab of `kind` opens. */
  const placeForNew = (kind: string): PanelPlace => {
    if (!holdsBottom(kind)) return "side";
    return here === "auto" ? store.preferredPlace : here;
  };
  /** What an empty bottom panel opens when shown. */
  const bottomFill = () => {
    const kind = definition()?.bottom?.kinds[0];
    return kind ? request({ kind }) : undefined;
  };
  const placeFor = (kind: string): PanelPlace => {
    if (placeForNew(kind) === "bottom") return "bottom";
    // They open beside, but the bottom panel holds some and the side panel none: go there.
    const workspace = store.get(scope);
    const beside = workspace.tabs.some((tab) => tab.kind === kind);
    return holdsBottom(kind) && !beside && bottomOf(workspace).tabs.length ? "bottom" : "side";
  };
  const toggleBottom = () =>
    withKinds(() =>
      change((workspace) => setBottomOpen(workspace, !bottomOf(workspace).open, bottomFill())),
    );
  /** Showing an empty panel opens something to show: the initial tabs, or the launcher. */
  const show = () =>
    change((workspace) => {
      if (workspace.tabs.length) return setPanelOpen(workspace, true);
      const initial = definition()?.initial ?? [];
      if (initial.length) {
        const seeded = initial.reduce(
          (next, each) => openTab(next, each, { reveal: false }),
          workspace,
        );
        const first = shownTab(seeded)?.key;
        return first ? activateTab(seeded, first) : seeded;
      }
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
      const where = locateTab(workspace, key);
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
      const found = locateTab(before, key);
      if (!found || definition()?.kind(found.tab.kind)?.prepareClose?.(scope, found.tab) === false)
        return [];
      return [found];
    });
    if (!gone.length) return false;
    change((workspace) => {
      const next = gone.reduce(
        (each, { tab }) => atKey(each, tab.key, (group) => closeTab(group, tab.key)),
        workspace,
      );
      return focus && placeOf(next, focus)
        ? atKey(next, focus, (group) => activateTab(group, focus))
        : next;
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
      const present = keys.filter((key) => placeOf(store.get(scope), key));
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
    open: (open, options) =>
      withKinds(() =>
        change((workspace) => openIn(workspace, placeForNew(open.kind), request(open), options)),
      ),
    toggleKind: (kind) =>
      withKinds(() => {
        if (placeFor(kind) === "bottom") return toggleBottom();
        change((workspace) => {
          const existing = workspace.tabs.find((tab) => tab.kind === kind);
          const shown = workspace.open ? shownTab(workspace) : undefined;
          if (!existing && shown && shown.kind === definition()?.launcher)
            return replaceAt(workspace, shown.key, request({ kind }));
          if (!existing) return openIn(workspace, "side", request({ kind }));
          const showing = workspace.open && shownTab(workspace)?.key === existing.key;
          return showing ? setPanelOpen(workspace, false) : activateTab(workspace, existing.key);
        });
      }),
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
    activate: (key) =>
      change((workspace) => atKey(workspace, key, (group) => activateTab(group, key))),
    close: (key) => guardedClose([key]),
    closeOthers: (key) => {
      const workspace = store.get(scope);
      const place = placeOf(workspace, key);
      if (!place) return Promise.resolve(false);
      // Exactly the tabs beside it now; what opens while the question is asked stays.
      const group = place === "side" ? workspace : bottomOf(workspace);
      const others = group.tabs
        .filter((tab) => !tab.pinned && tab.key !== key)
        .map((tab) => tab.key);
      return guardedClose(others, key);
    },
    reopen: () => {
      const current = definition();
      const back = store.takeClosed(scope, ({ tab }) => {
        const kind = current?.kind(tab.kind);
        if (current && !kind) return false;
        if (placeOf(store.get(scope), tab.key)) return false;
        return kind?.reopenable?.(scope, tab) ?? true;
      });
      if (!back) return false;
      change((workspace) => restoreClosed(workspace, back));
      return true;
    },
    move: (key, toIndex) =>
      change((workspace) => atKey(workspace, key, (group) => moveTab(group, key, toIndex))),
    setPinned: (key, pinned) =>
      change((workspace) => atKey(workspace, key, (group) => setTabPinned(group, key, pinned))),
    replace: (key, next) =>
      withKinds(() => change((workspace) => replaceAt(workspace, key, request(next)))),
    update: (key, patch) =>
      change((workspace) => atKey(workspace, key, (group) => updateTab(group, key, patch))),
    updateUi: (key, patch) =>
      change((workspace) => {
        const tab = locateTab(workspace, key)?.tab;
        if (!tab) return workspace;
        const ui = { ...tab.ui, ...patch };
        return atKey(workspace, key, (group) => updateTab(group, key, { ui }));
      }),
    cycle: (delta) => change((workspace) => cycleTab(workspace, delta)),
    setOpen: (open) => (open ? show() : change((workspace) => setPanelOpen(workspace, false))),
    toggle: () => {
      if (store.get(scope).open) change((workspace) => setPanelOpen(workspace, false));
      else show();
    },
    setDock: (dock) =>
      change((workspace) => (workspace.dock === dock ? workspace : { ...workspace, dock })),
    setBottomSize: (bottomSize, persist) =>
      change(
        (workspace) =>
          workspace.bottomSize === bottomSize ? workspace : { ...workspace, bottomSize },
        persist,
      ),
    setExpanded: (expanded) => {
      if (expanded && !store.get(scope).tabs.length) show();
      change((workspace) => setExpanded(workspace, expanded));
    },
    setSize: (size, persist) => {
      change((workspace) => setPanelSize(workspace, size), persist);
      store.setPreferred(size, persist);
    },
    setBottomOpen: (open) =>
      withKinds(() => change((workspace) => setBottomOpen(workspace, open, bottomFill()))),
    toggleBottom,
    moveTo: (key, place) => change((workspace) => moveToPlace(workspace, key, place)),
    placeFor,
    setBottomHeight: (size, persist) => store.setPreferredBottom(size, persist),
  };
  return actions;
}
