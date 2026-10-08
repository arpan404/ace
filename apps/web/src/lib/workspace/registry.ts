import { lazy, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { OpenRequest, ScopeWorkspace, WorkspaceTab } from "./model.ts";

/*
 * The tab-kind registry: how a feature plugs a resource into the side panel without touching
 * the shell. A kind says what its tabs are called, which icon they wear and how to draw one;
 * the shell owns the strip, order, persistence, motion, keyboard and sizes. See apps/web/README.md, "Workspace tabs".
 *
 * Kinds live in a module the workspace definition (`definition.ts`) loads after first paint, so
 * their icons, badges and loaders stay off the screen's first chunk.
 */

/** What a tab's view gets. Views read live state from `@ace/client-react` like any screen. */
export interface TabViewProps {
  /** The scope the tab belongs to: the thread id on a thread screen. */
  scope: string;
  tab: WorkspaceTab;
}

/** A kind's code, loaded the first time one of its tabs shows (ADR 0056 route budget). */
export interface TabModule {
  default: ComponentType<TabViewProps>;
  /** Buttons at the end of the panel's strip while one of these tabs is showing. */
  Actions?: ComponentType<TabViewProps>;
}

export interface TabKindOptions {
  /** Stable id, persisted with every tab: never rename one that has shipped. */
  kind: string;
  /** The tool's name: launcher card, default tab title, tooltips. */
  label: string;
  icon: IconGlyph;
  /**
   * The icon of one tab, where it differs by resource (an agent's provider mark). Drawn in the
   * strip and the open-tabs list instead of `icon`, at 14px in the text colour; `icon` stays for
   * the launcher and while this hasn't loaded.
   */
  TabIcon?: ComponentType<{ scope: string; tab: WorkspaceTab; className?: string }>;
  /** One tab per scope (Changes, Agents). Others open one tab per `id`. */
  singleton?: boolean;
  /** Opens as a pinned tool tab: first in the strip, no close button. */
  pinned?: boolean;
  /** Position among the launcher's Tools; leave out to keep the kind off the launcher. */
  launcher?: number;
  /**
   * The tool is listed but can't work yet ("Not available yet"): the launcher says so in place
   * of its shortcut.
   */
  unavailable?: string;
  /**
   * Small live text after the title (the diff stat on Changes). Loaded with the screen. With
   * `folded` the tab shows only its icon: draw at most a 6px mark (a dot in the badge's colour),
   * or nothing.
   */
  Badge?: ComponentType<{ scope: string; tab: WorkspaceTab; folded?: boolean }>;
  /** The tab title; default: the title the view last reported, else `label`. */
  title?(tab: WorkspaceTab): string;
  load(): Promise<TabModule>;
  /** The tab's shape while its code loads (a toolbar and rows); default: a spinner. */
  Skeleton?: ComponentType;
  /** Called after a tab of this kind closed (release a session it alone held). */
  onClose?(scope: string, tab: WorkspaceTab): void;
  /**
   * What closing these tabs would stop (a terminal's running shell), so the shell asks before
   * closing them; undefined closes them at once. Called with every tab of this kind that one
   * close would remove: Close other tabs asks once for all of them.
   */
  closeWarning?(scope: string, tabs: readonly ClosingTab[]): CloseWarning | undefined;
  /** The close button's tooltip ("End session"); default "Close <title>". */
  closeLabel?: string;
  /**
   * Whether a closed tab can come back with Reopen closed tab (a terminal whose shell ended
   * can't). Default: yes.
   */
  reopenable?(scope: string, tab: WorkspaceTab): boolean;
  /** How the launcher's Suggested opens a file with this kind, when it can. */
  fromFile?(path: string): OpenRequest;
  /**
   * How the launcher's address bar and Suggested open an address with this kind, when it can.
   * `workspace` is the scope's current one, for picking a fresh id.
   */
  fromUrl?(url: string, workspace: ScopeWorkspace): OpenRequest;
  /**
   * What the tool's shortcut does, instead of showing or hiding its tab (Files' ⌘P opens a
   * quick-open palette). Called once the kinds have loaded.
   */
  onShortcut?(scope: string): void;
  /**
   * Drawn once per screen while it shows, outside the panel (a palette the shortcut opens).
   * Loaded with the kinds, so keep it small and load its body on demand.
   */
  Overlay?: ComponentType<{ scope: string }>;
}

/** A tab about to close, as `closeWarning` sees it. */
export interface ClosingTab {
  tab: WorkspaceTab;
  title: string;
}

/** The question the shell asks before closing tabs that would stop something. */
export interface CloseWarning {
  title: string;
  description: ReactNode;
  /** The danger button's label ("End"). */
  confirm: string;
}

type LazyView = LazyExoticComponent<ComponentType<TabViewProps>>;

export interface TabKind extends TabKindOptions {
  /** The tab's view, loaded on first render. After a failed load, a fresh one that retries. */
  view(): LazyView;
  /** Its strip actions, from the same chunk. */
  actions(): LazyView;
  /** Start loading the kind's code (hovering its launcher card, say). */
  preload(): void;
}

const Nothing: ComponentType<TabViewProps> = () => null;

/** Declare a kind. Call once at module level, in the module a workspace's `kinds` loads. */
export function defineTabKind(options: TabKindOptions): TabKind {
  let loading: Promise<TabModule> | undefined;
  let failed = false;
  const load = () =>
    (loading ??= options.load().catch((error: unknown) => {
      // Offline, or a new build replaced the chunk: the next render tries again.
      loading = undefined;
      failed = true;
      throw error;
    }));
  const make = () => ({
    View: lazy(() => load()),
    Actions: lazy(() => load().then((module) => ({ default: module.Actions ?? Nothing }))),
  });
  let current = make();
  const fresh = () => {
    if (failed) {
      failed = false;
      current = make();
    }
    return current;
  };
  return {
    ...options,
    load,
    view: () => fresh().View,
    actions: () => fresh().Actions,
    preload: () => void load().catch(() => undefined),
  };
}
