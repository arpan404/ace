import { z } from "zod";
import { NativeDownloadAction, type CheckoutDownloads } from "./checkout-downloads.ts";
import { NativeMemoryAction, type CheckoutMemory } from "./checkout-memory.ts";
import { NativeUploadAction, type CheckoutUploads } from "./checkout-uploads.ts";

/*
 * The Files screen's actions that outlive one request (`FILES-CONTRACT.md`): saving files to the
 * phone, sending files up to a checkout, and the recent and open files. Each answers in patches.
 */

export const NativeFilesAction = z.union([
  NativeDownloadAction,
  NativeUploadAction,
  NativeMemoryAction,
]);
export type NativeFilesAction = z.infer<typeof NativeFilesAction>;

export interface FilesActions {
  downloads: CheckoutDownloads;
  uploads: CheckoutUploads;
  memory: CheckoutMemory;
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
  const memory = NativeMemoryAction.safeParse(action);
  if (memory.success) void actions.memory.handle(memory.data);
}
