import type { ComponentType } from "react";
import type { KeymapId } from "@/lib/keymap.ts";
import type { Dock, OpenRequest, ScopeWorkspace, WorkspaceTab } from "./model.ts";
import type { TabKind } from "./registry.ts";

/*
 * A screen's workspace: its docks, the tabs a scope starts with, the tools' shortcuts and,
 * loaded after first paint, the tab kinds. The eager part is a few strings, so a screen's first
 * chunk carries no tool code, icons or badges (ADR 0056 budgets).
 */

export interface WorkspaceDefinitionOptions {
  /** The right dock's accessible name ("Thread panel"). */
  label: string;
  /** The docks this screen has. */
  docks: readonly Dock[];
  /** The kind the + button opens; picking a tool from it replaces it. */
  launcher: string;
  /** The tabs a scope starts with, the first of each dock showing. */
  initial: readonly OpenRequest[];
  /** Tools' shortcuts (kind → keymap id): bound from first paint, shown on launcher cards. */
  shortcuts?: Readonly<Record<string, KeymapId>>;
  /**
   * What a dock's + opens instead of the launcher (the bottom panel's New terminal); ⌥-click
   * still opens the launcher there.
   */
  plus?: Partial<Record<Dock, DockPlus>>;
  /**
   * A dock's own controls, drawn in its strip after the showing tab's actions whatever tab
   * shows (the bottom panel's terminal sessions). Pass lazy components: they load with the dock.
   */
  dockActions?: Partial<Record<Dock, ComponentType<{ scope: string; dock: Dock }>>>;
  /** The tab kinds, as a lazy module's default export. */
  kinds(): Promise<{ default: readonly TabKind[] }>;
}

/** What a dock's + may do to the scope: open a tab, or turn one into another. */
export interface PlusActions {
  open(request: Omit<OpenRequest, "dock"> & { dock?: Dock | undefined }): void;
  replace(key: string, request: Omit<OpenRequest, "dock">): void;
}

/** A dock's own + action. */
export interface DockPlus {
  label: string;
  shortcut?: KeymapId;
  open(actions: PlusActions, workspace: ScopeWorkspace, dock: Dock): void;
}

export interface WorkspaceDefinition extends Omit<WorkspaceDefinitionOptions, "kinds"> {
  /** Load the kinds (once; a failed load is tried again on the next call). */
  load(): Promise<readonly TabKind[]>;
  /** The kinds have loaded. */
  loaded(): boolean;
  /** The kinds once loaded, else empty. */
  kinds(): readonly TabKind[];
  kind(kind: string): TabKind | undefined;
  shortcut(kind: string): KeymapId | undefined;
  /** Fill in a request's dock, pin and identity from its kind (call once kinds have loaded). */
  request(request: Omit<OpenRequest, "dock"> & { dock?: Dock | undefined }): OpenRequest;
  /** A tab's title: the kind's rule, the view's last report, or the kind's label. */
  title(tab: WorkspaceTab): string;
}

export function defineWorkspace(options: WorkspaceDefinitionOptions): WorkspaceDefinition {
  let loading: Promise<readonly TabKind[]> | undefined;
  let byKind = new Map<string, TabKind>();
  let ready = false;
  const load = () =>
    (loading ??= options.kinds().then(
      (module) => {
        byKind = new Map(module.default.map((kind) => [kind.kind, kind]));
        ready = true;
        return module.default;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    ));
  return {
    label: options.label,
    docks: options.docks,
    launcher: options.launcher,
    initial: options.initial,
    ...(options.shortcuts ? { shortcuts: options.shortcuts } : {}),
    ...(options.plus ? { plus: options.plus } : {}),
    ...(options.dockActions ? { dockActions: options.dockActions } : {}),
    load,
    loaded: () => ready,
    kinds: () => [...byKind.values()],
    kind: (kind) => byKind.get(kind),
    shortcut: (kind) => options.shortcuts?.[kind],
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
      return kind?.title?.(tab) ?? tab.title ?? kind?.label ?? "Tool";
    },
  };
}
