import * as z from "zod/mini";
import type { WorkspaceTab } from "../workspace-tabs.ts";
import { emptyLayout } from "./tree.ts";
import { defaultExplorer, type EditorLayout, type EditorTab, type ExplorerState } from "./types.ts";

/*
 * Spec 55: the one-time move of a thread's stored Files tab and per-file panel tabs
 * (`files:file:<path>`) into the Deck. A pure transform of stored UI state, run on the client.
 */

/** The Files kind's key; per-file tabs are `files:file:<path>`. */
const filesKind = "files";
const fileIdPrefix = "file:";

/** What an old file tab stored, read leniently: a bad field is dropped, not the tab. */
const OldFileTab = z.object({
  path: z.catch(z.optional(z.string().check(z.minLength(1), z.maxLength(4096))), undefined),
  preview: z.catch(z.optional(z.boolean()), undefined),
  draft: z.catch(
    z.optional(z.object({ text: z.string(), original: z.string(), version: z.string() })),
    undefined,
  ),
  side: z.catch(z.optional(z.enum(["files", "search"])), undefined),
  query: z.catch(z.optional(z.string().check(z.maxLength(4096))), undefined),
  expanded: z.catch(z.optional(z.array(z.string())), undefined),
  treeScroll: z.catch(z.optional(z.number().check(z.gte(0), z.lte(10_000_000))), undefined),
});
type OldFileTab = z.infer<typeof OldFileTab>;

/** Unsaved text a per-file tab carried; it moves to the draft store. */
export interface MigratedDraft {
  path: string;
  text: string;
  /** The text the person started from. */
  original: string;
  /** The file version the edit is based on. */
  version: string;
}

export interface PanelTabMigration {
  layout: EditorLayout;
  drafts: readonly MigratedDraft[];
  /** Panel tab keys the Deck replaces (the Files tab and every per-file tab). */
  replaced: readonly string[];
  /** Where the Deck goes among the panel tabs that remain: the first replaced tab's place. */
  index: number;
  /** One of the replaced tabs was the active panel tab. */
  wasActive: boolean;
}

interface OldTab {
  tab: WorkspaceTab;
  data: OldFileTab;
}

function explorerFrom(data: OldFileTab | undefined): ExplorerState {
  if (!data) return defaultExplorer;
  return {
    ...defaultExplorer,
    ...(data.side === undefined ? {} : { side: data.side }),
    ...(data.query === undefined ? {} : { query: data.query }),
    ...(data.expanded === undefined ? {} : { expanded: data.expanded }),
    ...(data.treeScroll === undefined ? {} : { scroll: data.treeScroll }),
  };
}

/**
 * Move a thread's stored Files and per-file panel tabs into one Deck group, in their order, with
 * their preview flags (one preview per group: the showing one, else the last). Unsaved drafts
 * come back for the draft store. Undefined when there is nothing to move.
 */
export function migratePanelTabs(
  workspace: { tabs: readonly WorkspaceTab[]; active: string | undefined },
  groupId: string,
): PanelTabMigration | undefined {
  const old: OldTab[] = workspace.tabs
    .filter((tab) => tab.kind === filesKind)
    .map((tab) => ({ tab, data: OldFileTab.safeParse(tab.data ?? {}).data ?? {} }));
  if (old.length === 0) return undefined;
  const files = old.filter(
    (each): each is OldTab & { data: { path: string } } =>
      each.tab.id.startsWith(fileIdPrefix) && each.data.path !== undefined,
  );
  const activeOld = old.find((each) => each.tab.key === workspace.active);
  const activeFile = files.find((each) => each.tab.key === workspace.active);
  const previews = files.filter((each) => each.data.preview === true);
  const preview = activeFile?.data.preview === true ? activeFile : previews.at(-1);

  const seen = new Set<string>();
  const read: EditorTab[] = [];
  for (const each of files) {
    if (seen.has(each.data.path)) continue;
    seen.add(each.data.path);
    read.push({ path: each.data.path, preview: each === preview, pinned: each.tab.pinned });
  }
  const tabs = [...read.filter((tab) => tab.pinned), ...read.filter((tab) => !tab.pinned)].map(
    (tab) => (tab.pinned && tab.preview ? { ...tab, preview: false } : tab),
  );
  const active = activeFile?.data.path ?? tabs[0]?.path;
  const mru =
    active === undefined
      ? []
      : [active, ...tabs.map((tab) => tab.path).filter((p) => p !== active)];

  const base = emptyLayout(groupId);
  const layout: EditorLayout = {
    ...base,
    root: { kind: "group", id: groupId, tabs, active, mru },
    explorer: explorerFrom(activeOld?.data ?? files.at(-1)?.data ?? old[0]?.data),
  };
  const drafts = files.flatMap(({ data }) =>
    data.draft && data.draft.text !== data.draft.original
      ? [{ path: data.path, ...data.draft }]
      : [],
  );
  const replaced = new Set(old.map((each) => each.tab.key));
  const first = workspace.tabs.findIndex((tab) => replaced.has(tab.key));
  return {
    layout,
    drafts,
    replaced: [...replaced],
    index: workspace.tabs.slice(0, first).filter((tab) => !replaced.has(tab.key)).length,
    wasActive: activeOld !== undefined,
  };
}
