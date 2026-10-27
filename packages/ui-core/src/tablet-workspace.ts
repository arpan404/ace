import * as z from "zod/mini";
import { readJson, writeJson, type KeyValueStorage } from "./storage.ts";
import { clampToBounds, panelBounds, type PanelLimits } from "./workspace-bounds.ts";
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  cycleTab,
  findTab,
  moveTab,
  openTab,
  rememberClosed,
  restoreClosed,
  sanitize,
  ScopeWorkspaceSchema,
  setPanelOpen,
  setPanelSize,
  setTabPinned,
  shownTab,
  takeClosed,
  emptyWorkspace,
  type ClosedTab,
  type ScopeWorkspace,
} from "./workspace-tabs.ts";

/*
 * A thread's side panel on a tablet (an iPad, an Android tablet, a wide window): the thread
 * beside one panel of tabs, each an existing screen of the app (Changes, Files, Terminal, …).
 * The tab rules are the web's own (`workspace-tabs.ts`); this module adds what a tablet decides:
 * which tools it offers, what a thread starts with, when the panel fits beside the thread, and
 * what each thread remembers across launches. The native app draws `TabletPanelView` and sends
 * `TabletPanelOp`s; it decides nothing itself.
 */

/** The tools a tablet panel can hold, in the order the + menu lists them. */
export const tabletTools = [
  { kind: "changes", label: "Changes" },
  { kind: "files", label: "Files" },
  { kind: "terminal", label: "Terminal" },
  { kind: "browser", label: "Browser" },
  { kind: "agents", label: "Agents" },
  { kind: "preview", label: "Run and preview" },
] as const;
export type TabletTool = (typeof tabletTools)[number]["kind"];

/** A thread's panel the first time it opens: Changes and Files, pinned, as on the web. */
const initial = ["changes", "files"] as const;

/**
 * Sizes in points. The thread keeps a readable column beside the panel; below `min + keep` the
 * panel does not fit and its tools open over the thread as they do on a phone.
 */
export const tabletPanelLimits: PanelLimits = { min: 320, keep: 440, overlayStrip: 0 };
/** The panel's width until the person drags its edge. */
export const tabletDefaultSize = 400;

/**
 * Where the panel goes in a window: `beside` the thread; `yield` beside it once the thread list
 * steps aside (the list and the panel don't both fit); `none` when even the whole window is too
 * narrow, so tools open over the thread. `width` is the thread's column now, `sidebar` the list
 * beside it (0 when hidden).
 */
export type TabletPanelPlace = "beside" | "yield" | "none";
export function tabletPanelPlace(input: {
  regular: boolean;
  width: number;
  sidebar: number;
}): TabletPanelPlace {
  if (!input.regular) return "none";
  const needed = tabletPanelLimits.min + tabletPanelLimits.keep;
  if (input.width >= needed) return "beside";
  return input.width + input.sidebar >= needed ? "yield" : "none";
}

/** The panel's width in a thread column `width` wide: its size, kept inside the bounds. */
export function tabletPanelWidth(size: number, width: number): number {
  return clampToBounds(size, panelBounds(width, false, tabletPanelLimits));
}

export interface TabletPanelTab {
  key: string;
  kind: string;
  title: string;
  pinned: boolean;
}

/** What the native panel draws for one thread. */
export interface TabletPanelView {
  scope: string;
  open: boolean;
  /** The tab showing; undefined with no tabs. */
  active: string | undefined;
  tabs: TabletPanelTab[];
  /** The width the person last gave this thread's panel (or any panel), unclamped. */
  size: number;
  /** Reopen closed tab has something to bring back. */
  canReopen: boolean;
  /** The + menu: every tool this app can show, and whether it is open already. */
  tools: { kind: string; label: string; open: boolean }[];
}

export const TabletPanelOp = z.discriminatedUnion("op", [
  /** Show this tool, opening its tab if needed (the ⋯ menu, a link, the + menu). */
  z.object({ op: z.literal("open"), kind: z.string() }),
  /** A tool's shortcut: show it, or hide the panel when it is the tab showing. */
  z.object({ op: z.literal("toggle"), kind: z.string() }),
  z.object({ op: z.literal("activate"), key: z.string() }),
  z.object({ op: z.literal("close"), key: z.string() }),
  z.object({ op: z.literal("closeOthers"), key: z.string() }),
  z.object({ op: z.literal("reopen") }),
  z.object({ op: z.literal("move"), key: z.string(), to: z.number().check(z.int()) }),
  z.object({ op: z.literal("pin"), key: z.string(), pinned: z.boolean() }),
  z.object({ op: z.literal("cycle"), delta: z.union([z.literal(1), z.literal(-1)]) }),
  /** Show or hide the panel; showing an empty one opens the first tabs. */
  z.object({ op: z.literal("panel"), open: z.boolean() }),
  z.object({ op: z.literal("togglePanel") }),
  /** The width the person dragged to, once the drag ends. */
  z.object({ op: z.literal("size"), size: z.number().check(z.gte(0), z.lte(10_000)) }),
]);
export type TabletPanelOp = z.infer<typeof TabletPanelOp>;

const storageKey = "ace.tablet-workspace";
const Persisted = z.object({
  preferred: z.catch(z.optional(z.number().check(z.gte(0), z.lte(10_000))), undefined),
  scopes: z.array(z.tuple([z.string(), ScopeWorkspaceSchema])),
});

const label = (kind: string) => tabletTools.find((tool) => tool.kind === kind)?.label ?? kind;

/**
 * Every thread's panel on one machine, persisted to the injected storage. Bounded: the threads
 * changed most recently are kept (`capacity`), the rest start again from the first tabs.
 * Closed tabs are kept in memory for Reopen closed tab.
 */
export class TabletWorkspaces {
  readonly #storage: KeyValueStorage | undefined;
  readonly #capacity: number;
  /** The tools the app can draw; others are never offered and never opened. */
  #available: ReadonlySet<string>;
  /** Insertion order is recency. */
  readonly #scopes = new Map<string, ScopeWorkspace>();
  readonly #closed = new Map<string, ClosedTab[]>();
  #preferred: number;

  constructor(
    options: { storage?: KeyValueStorage; capacity?: number; available?: readonly string[] } = {},
  ) {
    this.#storage = options.storage;
    this.#capacity = options.capacity ?? 64;
    this.#available = new Set(options.available ?? tabletTools.map((tool) => tool.kind));
    const stored = readJson(this.#storage, storageKey, Persisted, undefined);
    this.#preferred = stored?.preferred ?? tabletDefaultSize;
    for (const [scope, workspace] of stored?.scopes.slice(-this.#capacity) ?? [])
      this.#scopes.set(scope, this.#only(sanitize(workspace)));
  }

  /** The app learned which tools it can draw (a newer build, a screen arriving). */
  setAvailable(kinds: readonly string[]): void {
    this.#available = new Set(kinds);
    for (const [scope, workspace] of this.#scopes) this.#scopes.set(scope, this.#only(workspace));
  }

  view(scope: string): TabletPanelView {
    const workspace = this.#scopes.get(scope) ?? emptyWorkspace;
    const open = new Set(workspace.tabs.map((tab) => tab.kind));
    return {
      scope,
      open: workspace.open,
      active: shownTab(workspace)?.key,
      tabs: workspace.tabs.map((tab) => ({
        key: tab.key,
        kind: tab.kind,
        title: label(tab.kind),
        pinned: tab.pinned,
      })),
      size: workspace.size ?? this.#preferred,
      canReopen: (this.#closed.get(scope) ?? []).some((closed) =>
        this.#reopenable(workspace, closed),
      ),
      tools: tabletTools
        .filter((tool) => this.#available.has(tool.kind))
        .map((tool) => ({ kind: tool.kind, label: tool.label, open: open.has(tool.kind) })),
    };
  }

  /** Apply one op; whether the thread's panel changed. */
  apply(scope: string, op: TabletPanelOp): boolean {
    const before = this.#scopes.get(scope) ?? emptyWorkspace;
    const after = this.#next(scope, before, op);
    if (op.op === "size") this.#preferred = Math.round(op.size);
    if (after === before && op.op !== "size") return false;
    this.#scopes.delete(scope);
    this.#scopes.set(scope, after);
    this.#trim(scope);
    this.#save();
    return true;
  }

  #next(scope: string, workspace: ScopeWorkspace, op: TabletPanelOp): ScopeWorkspace {
    switch (op.op) {
      case "open":
        return this.#available.has(op.kind) ? openTab(workspace, { kind: op.kind }) : workspace;
      case "toggle": {
        if (!this.#available.has(op.kind)) return workspace;
        const existing = workspace.tabs.find((tab) => tab.kind === op.kind);
        if (!existing) return openTab(workspace, { kind: op.kind });
        const showing = workspace.open && shownTab(workspace)?.key === existing.key;
        return showing ? setPanelOpen(workspace, false) : activateTab(workspace, existing.key);
      }
      case "activate":
        return activateTab(workspace, op.key);
      case "close":
        return this.#close(scope, workspace, [op.key]);
      case "closeOthers": {
        if (!findTab(workspace, op.key)) return workspace;
        const others = workspace.tabs.filter((tab) => !tab.pinned && tab.key !== op.key);
        return closeOtherTabs(
          this.#close(
            scope,
            workspace,
            others.map((tab) => tab.key),
          ),
          op.key,
        );
      }
      case "reopen": {
        const back = takeClosed(this.#closed.get(scope) ?? [], (closed) =>
          this.#reopenable(workspace, closed),
        );
        return back ? restoreClosed(workspace, back) : workspace;
      }
      case "move":
        return moveTab(workspace, op.key, op.to);
      case "pin":
        return setTabPinned(workspace, op.key, op.pinned);
      case "cycle":
        return cycleTab(workspace, op.delta);
      case "panel":
        return op.open ? this.#show(workspace) : setPanelOpen(workspace, false);
      case "togglePanel":
        return workspace.open ? setPanelOpen(workspace, false) : this.#show(workspace);
      case "size":
        return setPanelSize(workspace, op.size);
    }
  }

  /** Showing an empty panel opens the first tabs, the first of them showing. */
  #show(workspace: ScopeWorkspace): ScopeWorkspace {
    if (workspace.tabs.length) return setPanelOpen(workspace, true);
    const seeded = initial
      .filter((kind) => this.#available.has(kind))
      .reduce((next, kind) => openTab(next, { kind, pinned: true }, { reveal: false }), workspace);
    const first = seeded.tabs[0]?.key;
    return first ? activateTab(seeded, first) : seeded;
  }

  /** Close these tabs, keeping each for Reopen closed tab where it stood. */
  #close(scope: string, workspace: ScopeWorkspace, keys: readonly string[]): ScopeWorkspace {
    const list = this.#closed.get(scope) ?? [];
    let next = workspace;
    for (const key of keys) {
      const found = findTab(next, key);
      if (!found) continue;
      rememberClosed(list, { tab: found.tab, index: found.index });
      next = closeTab(next, key);
    }
    this.#closed.set(scope, list);
    return next;
  }

  #reopenable(workspace: ScopeWorkspace, closed: ClosedTab): boolean {
    return this.#available.has(closed.tab.kind) && !findTab(workspace, closed.tab.key);
  }

  /** Drop tabs of tools this app can't draw (stored by a build that could). */
  #only(workspace: ScopeWorkspace): ScopeWorkspace {
    const tabs = workspace.tabs.filter((tab) => this.#available.has(tab.kind));
    if (tabs.length === workspace.tabs.length) return workspace;
    const active = tabs.some((tab) => tab.key === workspace.active)
      ? workspace.active
      : tabs[0]?.key;
    return { ...workspace, tabs, active, open: workspace.open && tabs.length > 0 };
  }

  #trim(keep: string): void {
    for (const scope of this.#scopes.keys()) {
      if (this.#scopes.size <= this.#capacity) break;
      if (scope === keep) continue;
      this.#scopes.delete(scope);
      this.#closed.delete(scope);
    }
  }

  #save(): void {
    const scopes = [...this.#scopes].map(([scope, workspace]) => [
      scope,
      {
        tabs: workspace.tabs.map(({ key, kind, id, pinned }) => ({ key, kind, id, pinned })),
        active: workspace.active,
        open: workspace.open,
        size: workspace.size,
        expanded: false,
      },
    ]);
    writeJson(this.#storage, storageKey, { preferred: this.#preferred, scopes });
  }
}
