import { z } from "zod";
import {
  NativeContentSearchAction,
  type CheckoutContentSearch,
} from "./checkout-content-search.ts";
import { NativeDownloadAction, type CheckoutDownloads } from "./checkout-downloads.ts";
import { NativeMemoryAction, type CheckoutMemory } from "./checkout-memory.ts";
import { NativeTreeAction, type CheckoutTrees } from "./checkout-tree-live.ts";
import { NativeUploadAction, type CheckoutUploads } from "./checkout-uploads.ts";

/*
 * The Files screen's actions that outlive one request (`FILES-CONTRACT.md`): saving files to the
 * phone, sending files up to a checkout, the recent and open files, and the live tree whose
 * folders are listed and watched, and search in file contents. Each answers in patches.
 */

export const NativeFilesAction = z.union([
  NativeDownloadAction,
  NativeUploadAction,
  NativeMemoryAction,
  NativeTreeAction,
  NativeContentSearchAction,
]);
export type NativeFilesAction = z.infer<typeof NativeFilesAction>;

export interface FilesActions {
  downloads: CheckoutDownloads;
  uploads: CheckoutUploads;
  memory: CheckoutMemory;
  trees: CheckoutTrees;
  contents: CheckoutContentSearch;
}

export function routeFilesAction(actions: FilesActions, action: NativeFilesAction): void {
  if (action.type.startsWith("files.download")) {
    const download = NativeDownloadAction.safeParse(action);
    if (download.success) actions.downloads.handle(download.data);
    return;
  }
  if (action.type.startsWith("files.upload")) {
    const upload = NativeUploadAction.safeParse(action);
    if (upload.success) actions.uploads.handle(upload.data);
    return;
  }
  if (action.type.startsWith("files.tree")) {
    const tree = NativeTreeAction.safeParse(action);
    if (tree.success) actions.trees.handle(tree.data);
    return;
  }
  if (action.type.startsWith("files.contents")) {
    const search = NativeContentSearchAction.safeParse(action);
    if (search.success) actions.contents.handle(search.data);
    return;
  }
  const memory = NativeMemoryAction.safeParse(action);
  if (memory.success) void actions.memory.handle(memory.data);
}
