import { cleanPath, folderKey, revealingFolders, type FolderRow } from "@ace/ui-core";
import { useState } from "react";
import { checkoutError } from "./checkout-source.ts";
import type { RevealTarget } from "./file-tree-follow.ts";
import type { RowField } from "./file-tree-rename.tsx";
import { useCheckoutSource } from "./use-checkout.ts";
import { useFileMutations } from "./use-file-mutations.ts";

/** The row key of the field a new entry is named in: no checkout path can hold a NUL. */
export const draftKey = "\0new";

/** A new entry being named in the tree: what it will be, and the folder it goes in. */
export interface Draft {
  kind: "file" | "folder";
  /** Without a trailing slash; "" is the checkout's root. */
  folder: string;
}

/**
 * `rows` with the new entry's field at the top of its folder, once that folder's row is listed
 * (the root's field leads the tree). Until then the rows are unchanged.
 */
export function rowsWithDraft(rows: readonly FolderRow[], draft: Draft | undefined): FolderRow[] {
  if (!draft) return [...rows];
  const field = (depth: number): FolderRow => ({
    key: draftKey,
    kind: draft.kind,
    name: "",
    depth,
    expanded: false,
    busy: false,
    ignored: false,
  });
  if (!draft.folder) return [field(0), ...rows];
  const at = rows.findIndex((row) => row.key === folderKey(draft.folder));
  const parent = rows[at];
  if (!parent) return [...rows];
  return [...rows.slice(0, at + 1), field(parent.depth + 1), ...rows.slice(at + 1)];
}

/** Why a typed name can't be made, or undefined when it can. */
function badName(name: string): string | undefined {
  const parts = name.split("/");
  if (parts.some((part) => !part)) return "A name can't have an empty part between slashes.";
  if (parts.some((part) => part === "." || part === ".."))
    return "A name can't be “.” or “..”. Choose another name.";
  return undefined;
}

export interface InlineCreate {
  draft: Draft | undefined;
  /** Name a new entry in `folder` ("" or "a/b/" both work): its folders open to show the field. */
  start(kind: Draft["kind"], folder: string): void;
  /** The draft's field, for its row. */
  field: RowField | undefined;
}

/**
 * New file and New folder named in the tree (explorer polish, phase 2): the field opens at the
 * top of the folder; Enter makes the entry (and any folders a name with slashes names), Escape
 * or leaving the field gives up. A taken name is said under the field. A new file opens kept;
 * a new folder is revealed and selected.
 */
export function useInlineCreate(inputs: {
  threadId: string;
  opened: ReadonlySet<string>;
  onExpanded(folders: string[]): void;
  reveal(target: RevealTarget): void;
  onFile(path: string): void;
}): InlineCreate {
  const { threadId } = inputs;
  const [draft, setDraft] = useState<Draft>();
  const mutations = useFileMutations(threadId);
  const source = useCheckoutSource();
  const exists = async (path: string) => {
    const stat = await source.stat(threadId, path);
    return stat.version !== null || stat.folder;
  };
  const commit = async (typed: string): Promise<string | undefined> => {
    if (!draft) return undefined;
    const name = typed.trim().replace(/^\/+|\/+$/g, "");
    if (!name) {
      setDraft(undefined);
      return undefined;
    }
    const wrong = badName(name);
    if (wrong) return wrong;
    const path = draft.folder ? `${draft.folder}/${name}` : name;
    try {
      if (await exists(path)) return `${name} already exists here. Choose another name.`;
      // "drafts/2026/plan.md" makes the folders it names first.
      const parts = path.split("/");
      const start = draft.folder ? draft.folder.split("/").length + 1 : 1;
      for (let depth = start; depth < parts.length; depth++) {
        const folder = parts.slice(0, depth).join("/");
        if (!(await exists(folder))) await mutations.run({ op: "mkdir", path: folder, expected: null });
      }
      await mutations.run(
        draft.kind === "file"
          ? { op: "create", path, expected: null, text: "" }
          : { op: "mkdir", path, expected: null },
      );
    } catch (failure) {
      return checkoutError(failure).message;
    }
    setDraft(undefined);
    inputs.reveal({ path, folder: draft.kind === "folder", focus: draft.kind === "folder" });
    if (draft.kind === "file") inputs.onFile(path);
    return undefined;
  };
  return {
    draft,
    start: (kind, folder) => {
      const clean = cleanPath(folder);
      if (clean) {
        const missing = revealingFolders(inputs.opened, `${clean}/${draftKey}`);
        if (missing.length) inputs.onExpanded([...inputs.opened, ...missing]);
      }
      setDraft({ kind, folder: clean });
    },
    field: draft && {
      label: draft.kind === "file" ? "New file name" : "New folder name",
      name: "",
      refocus: draft.folder ? folderKey(draft.folder) : undefined,
      commit,
      cancel: () => setDraft(undefined),
    },
  };
}
