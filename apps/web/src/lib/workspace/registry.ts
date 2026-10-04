import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { IconGlyph } from "@/components/icon.tsx";
import type { KeymapId } from "@/lib/keymap.ts";
import type { Dock, OpenRequest, WorkspaceTab } from "./model.ts";

/*
 * The tab-kind registry: how a feature plugs a resource into the workspace docks without
 * touching the shell. A kind says what its tabs are called, which icon they wear, which docks
 * they may sit in and how to draw one; the shell owns the strip, order, persistence, motion,
 * keyboard and sizes. See apps/web/README.md, "Workspace tabs".
 */

/** What a tab's view gets. Views read live state from `@ace/client-react` like any screen. */
export interface TabViewProps {
  /** The scope the tab belongs to: the thread id on a thread screen. */
  scope: string;
  tab: WorkspaceTab;
  dock: Dock;
}

/** A kind's code, loaded the first time one of its tabs shows (ADR 0056 route budget). */
export interface TabModule {
  default: ComponentType<TabViewProps>;
  /** Buttons at the end of the dock's strip while one of these tabs is showing. */
  Actions?: ComponentType<TabViewProps>;
}

export interface TabKindOptions {
  /** Stable id, persisted with every tab: never rename one that has shipped. */
  kind: string;
  /** The tool's name: launcher card, default tab title, tooltips. */
  label: string;
  icon: IconGlyph;
  /** One tab per scope (Changes, Agents). Others open one tab per `id`. */
  singleton?: boolean;
  /** Docks it may sit in, preferred first. Default: right only. */
  docks?: readonly Dock[];
  /** Opens as a pinned tool tab: first in the strip, no close button. */
  pinned?: boolean;
  /** Opens (and, pressed again while showing, hides) this tool. Bound on screens using it. */
  shortcut?: KeymapId;
  /** Position among the launcher's Tools; leave out to keep the kind off the launcher. */
  launcher?: number;
  /** Small live text after the title (the diff stat on Changes). Loaded with the screen. */
  Badge?: ComponentType<{ scope: string; tab: WorkspaceTab }>;
  /** The tab title; default: the title the view last reported, else `label`. */
  title?(tab: WorkspaceTab): string;
  load(): Promise<TabModule>;
  /** Called after a tab of this kind closed (release a session it alone held). */
  onClose?(scope: string, tab: WorkspaceTab): void;
  /** How the launcher's Suggested opens a file with this kind, when it can. */
  fromFile?(path: string): Omit<OpenRequest, "dock">;
  /** How the launcher's Suggested opens an address with this kind, when it can. */
  fromUrl?(url: string): Omit<OpenRequest, "dock">;
}

type LazyView = LazyExoticComponent<ComponentType<TabViewProps>>;

export interface TabKind extends TabKindOptions {
  docks: readonly Dock[];
  /** The tab's view, loaded on first render. After a failed load, a fresh one that retries. */
  view(): LazyView;
  /** Its strip actions, from the same chunk. */
  actions(): LazyView;
  /** Start loading the kind's code (hovering its launcher card, say). */
  preload(): void;
}

const Nothing: ComponentType<TabViewProps> = () => null;

/** Declare a kind. Call once at module level; the result is passed to `defineWorkspace`. */
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
    docks: options.docks?.length ? options.docks : ["right"],
    load,
    view: () => fresh().View,
    actions: () => fresh().Actions,
    preload: () => void load().catch(() => undefined),
  };
}

export interface WorkspaceDefinitionOptions {
  /** The right dock's accessible name ("Thread panel"). */
  label: string;
  kinds: readonly TabKind[];
  /** The kind the + button opens; picking a tool from it replaces it. */
  launcher: string;
  /** The tabs a scope starts with, the first of each dock showing. */
  initial: readonly OpenRequest[];
}

export interface WorkspaceDefinition extends WorkspaceDefinitionOptions {
  kind(kind: string): TabKind | undefined;
  /** The dock a request without one goes to: the kind's preferred dock. */
  request(request: Omit<OpenRequest, "dock"> & { dock?: Dock | undefined }): OpenRequest;
  /** A tab's title: the kind's rule, the view's last report, or the kind's label. */
  title(tab: WorkspaceTab): string;
}

export function defineWorkspace(options: WorkspaceDefinitionOptions): WorkspaceDefinition {
  const byKind = new Map(options.kinds.map((kind) => [kind.kind, kind]));
  return {
    ...options,
    kind: (kind) => byKind.get(kind),
    request: (request) => {
      const kind = byKind.get(request.kind);
      const allowed = kind?.docks ?? ["right"];
      const dock = request.dock && allowed.includes(request.dock) ? request.dock : allowed[0];
      return {
        ...request,
        dock: dock ?? "right",
        pinned: request.pinned ?? kind?.pinned,
        id: kind?.singleton ? undefined : request.id,
      };
    },
    title: (tab) => {
      const kind = byKind.get(tab.kind);
      return kind?.title?.(tab) ?? tab.title ?? kind?.label ?? "Unavailable tool";
    },
  };
}
