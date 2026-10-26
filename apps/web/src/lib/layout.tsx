import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "@ace/ui-core";
import type { WorkspaceStore } from "./workspace/store.ts";

/**
 * Shell layout: the sidebar, the palette and search dialogs, and whether a screen's side panel
 * is showing.
 * Local UI state, persisted to storage. The side panel's tabs and width are per scope (thread) in the
 * workspace store (`lib/workspace`), which reads the same storage.
 */
/** How narrow and wide the sidebar may be dragged, and where a double-click puts it back. */
export const sidebarWidths = { min: 220, max: 480, preferred: 336 };

export const ShellLayout = z.object({
  /** The sidebar is on screen (⌘\ hides it). */
  sidebarOpen: z.catch(z.boolean(), true),
  /** The sidebar's width beside the content, as last dragged. Clamped to `sidebarWidths` on use. */
  sidebarWidth: z.catch(z.number(), () => sidebarWidths.preferred),
});
export type ShellLayout = z.infer<typeof ShellLayout>;

const defaultLayout: ShellLayout = { sidebarOpen: true, sidebarWidth: sidebarWidths.preferred };
const storageKey = "ace.layout";

export interface ScreenActions {
  scope: string;
  rename(): void;
  fork?: (() => void) | undefined;
  merge?: (() => void) | undefined;
  attachments(): void;
  find(): void;
}

/**
 * What the showing thread's composer can do when asked from elsewhere (the palette's Stop,
 * Switch model and Effort). Registered by the composer while it shows.
 */
export interface ComposerActions {
  /** The thread it belongs to. */
  scope: string;
  /** Stop the agent tree, as the composer's Stop does; undefined while there is nothing to stop. */
  stop?: (() => void) | undefined;
  /** Open the model list on the composer's model chip. */
  chooseModel(): void;
  /** Open the model chip's effort slider. */
  tuneEffort(): void;
}

/** A step of the palette it can open on, instead of its search. */
export type PalettePage =
  | "add-project"
  | "add-local"
  | "add-create"
  | "add-clone"
  | "add-github"
  | "new-thread-in";

/**
 * How the palette opened: on its search (no page) or on a step. A new object for every opening,
 * so the palette starts over each time. `attempt` is a folder that couldn't be added, shown in
 * the Local folder step with why.
 */
export interface PaletteStart {
  page?: PalettePage | undefined;
  attempt?: { path: string; problem: string; canAllow?: boolean | undefined } | undefined;
}

interface LayoutValue {
  screenActions: ScreenActions | undefined;
  setScreenActions(actions: ScreenActions | undefined): void;
  composerActions: ComposerActions | undefined;
  setComposerActions(actions: ComposerActions | undefined): void;
  layout: ShellLayout;
  setSidebarOpen(open: boolean): void;
  /** Remember the sidebar's width (once a drag or key press settles on it). */
  setSidebarWidth(width: number): void;
  shortcutsOpen: boolean;
  setShortcutsOpen(open: boolean): void;
  paletteOpen: boolean;
  setPaletteOpen(open: boolean): void;
  /** How the open palette started. */
  paletteStart: PaletteStart;
  /** Open the palette on one of its steps (Add project, New thread in…). */
  openPalette(start: PaletteStart): void;
  /** The search dialog, open with the words it starts from; undefined while it is closed. */
  search: { query: string } | undefined;
  /** Open the search dialog over the current screen, optionally with words already in it. */
  openSearch(query?: string): void;
  closeSearch(): void;
  /** A screen is showing its side panel now (not just remembered open), so a crowded window
   * can give it the sidebar's room. Set by the panel itself. */
  rightPanelShown: boolean;
  /** Put the showing side panel away (asking for the sidebar back on a crowded window). */
  hideRightPanel(): void;
  /** The panel registers how to hide itself while it shows; undefined when it hides. */
  setRightPanel(hide: (() => void) | undefined): void;
  /** The injected key-value storage, for features that persist their own local UI state. */
  storage: KeyValueStorage | undefined;
  /** This app's workspace store, made by `create` on first use (`lib/workspace` loads lazily). */
  workspaceStore(create: () => WorkspaceStore): WorkspaceStore;
  /** A value this app keeps for its life (in memory), made by `create` on first use of `key`. */
  sessionValue<T>(key: SessionKey<T>, create: () => T): T;
}

/** Names one `sessionValue`; its type ties the key to what it holds. */
export interface SessionKey<T> {
  readonly name: string;
  /** Never set: carries `T` for the compiler. */
  readonly holds?: T;
}
const LayoutContext = createContext<LayoutValue | undefined>(undefined);

export function LayoutProvider(props: {
  storage?: KeyValueStorage | undefined;
  children: ReactNode;
}) {
  const { storage } = props;
  const [layout, setLayout] = useState(() =>
    readJson(storage, storageKey, ShellLayout, defaultLayout),
  );
  const [screenActions, setScreenActions] = useState<ScreenActions>();
  const [composerActions, setComposerActions] = useState<ComposerActions>();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [paletteOpen, setPaletteState] = useState(false);
  const [paletteStart, setPaletteStart] = useState<PaletteStart>({});
  const [search, setSearch] = useState<{ query: string }>();
  const setPaletteOpen = useCallback((open: boolean) => {
    if (open) {
      setSearch(undefined);
      setPaletteStart({});
    }
    setPaletteState(open);
  }, []);
  const openPalette = useCallback((start: PaletteStart) => {
    setSearch(undefined);
    setPaletteStart({ ...start });
    setPaletteState(true);
  }, []);
  // Stable, so a screen that opens search from an effect runs it once.
  const openSearch = useCallback(
    (query = "") => {
      setPaletteOpen(false);
      setSearch({ query });
    },
    [setPaletteOpen],
  );
  const closeSearch = useCallback(() => setSearch(undefined), []);
  const [rightPanel, setRightPanelState] = useState<{ hide(): void }>();
  // Stable, so the panel registering itself doesn't re-run on every layout change.
  const setRightPanel = useCallback(
    (hide: (() => void) | undefined) => setRightPanelState(hide ? { hide } : undefined),
    [],
  );
  const [workspaceStore] = useState(() => {
    let store: WorkspaceStore | undefined;
    return (create: () => WorkspaceStore) => (store ??= create());
  });
  const [sessionValue] = useState(() => {
    const values = new Map<SessionKey<unknown>, unknown>();
    return <T,>(key: SessionKey<T>, create: () => T): T => {
      if (!values.has(key)) values.set(key, create());
      // Set under this key above, by the `create` its type names.
      return values.get(key) as T;
    };
  });
  const change = useCallback(
    (next: (previous: ShellLayout) => ShellLayout) =>
      setLayout((previous) => {
        const value = next(previous);
        writeJson(storage, storageKey, value);
        return value;
      }),
    [storage],
  );
  const value = useMemo<LayoutValue>(
    () => ({
      layout,
      screenActions,
      setScreenActions,
      composerActions,
      setComposerActions,
      shortcutsOpen,
      setShortcutsOpen,
      paletteOpen,
      setPaletteOpen,
      paletteStart,
      openPalette,
      search,
      openSearch,
      closeSearch,
      rightPanelShown: rightPanel !== undefined,
      hideRightPanel: () => rightPanel?.hide(),
      setRightPanel,
      storage,
      workspaceStore,
      sessionValue,
      setSidebarOpen: (open) => change((p) => ({ ...p, sidebarOpen: open })),
      setSidebarWidth: (width) => change((p) => ({ ...p, sidebarWidth: width })),
    }),
    [
      layout,
      screenActions,
      setScreenActions,
      composerActions,
      shortcutsOpen,
      setShortcutsOpen,
      paletteOpen,
      setPaletteOpen,
      paletteStart,
      openPalette,
      search,
      openSearch,
      closeSearch,
      rightPanel,
      setRightPanel,
      change,
      storage,
      workspaceStore,
      sessionValue,
    ],
  );
  return <LayoutContext.Provider value={value}>{props.children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutValue {
  const value = useContext(LayoutContext);
  if (!value) throw new Error("useLayout needs a <LayoutProvider>");
  return value;
}

/**
 * The injected storage where there is one. Pieces also rendered outside the shell (a PR's
 * workspace on its own) keep their state in memory there instead.
 */
export function useOptionalStorage(): KeyValueStorage | undefined {
  return useContext(LayoutContext)?.storage;
}
