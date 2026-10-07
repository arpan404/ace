import type { KeymapId } from "@/lib/keymap.ts";
import type { OpenRequest, WorkspaceTab } from "./model.ts";
import type { TabKind } from "./registry.ts";

/*
 * A screen's workspace: the side panel's tabs a scope starts with, the tools' shortcuts and,
 * loaded after first paint, the tab kinds. The eager part is a few strings, so a screen's first
 * chunk carries no tool code, icons or badges (ADR 0056 budgets).
 */

export interface WorkspaceDefinitionOptions {
  /** The side panel's accessible name ("Thread panel"). */
  label: string;
  /** The kind the + button opens; picking a tool from it replaces it. */
  launcher: string;
  /** The tabs a scope starts with, the first one showing. */
  initial: readonly OpenRequest[];
  /** Tools' shortcuts (kind → keymap id): bound from first paint, shown on launcher cards. */
  shortcuts?: Readonly<Record<string, KeymapId>>;
  /** The tab kinds, as a lazy module's default export. */
  kinds(): Promise<{ default: readonly TabKind[] }>;
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
  /** Fill in a request's pin and identity from its kind (call once kinds have loaded). */
  request(request: OpenRequest): OpenRequest;
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
    launcher: options.launcher,
    initial: options.initial,
    ...(options.shortcuts ? { shortcuts: options.shortcuts } : {}),
    load,
    loaded: () => ready,
    kinds: () => [...byKind.values()],
    kind: (kind) => byKind.get(kind),
    shortcut: (kind) => options.shortcuts?.[kind],
    request: (request) => {
      const kind = byKind.get(request.kind);
      return {
        ...request,
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
