import type { ClientCore } from "@ace/client";
import { ItemId, ThreadId, WorkspaceId } from "@ace/protocol";
import { checkoutEditLimit } from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";

/*
 * What the Files screen may ask (`native.files`, through the native service API) and the
 * daemon replies it reads, as schemas; and the patch that tells its screens to read again.
 */

const path = z.string().min(1).max(4096);
const reference = z.string().min(1).max(4096);
export const FilesScope = z.union([
  z.strictObject({ threadId: ThreadId }),
  z.strictObject({ workspaceId: WorkspaceId }),
]);
export type FilesScope = z.infer<typeof FilesScope>;
export const FilesOperation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("tree") }),
  z.object({ op: z.literal("search"), query: z.string().max(128) }),
  z.object({ op: z.literal("read"), path }),
  z.object({ op: z.literal("download"), path }),
  z.object({
    op: z.literal("write"),
    path,
    text: z.string().max(checkoutEditLimit),
    expected: z.string().min(1).max(256),
  }),
  z.object({ op: z.enum(["create", "mkdir", "delete"]), path }),
  z.object({ op: z.enum(["rename", "move"]), path, destination: path }),
  z.object({ op: z.literal("restore"), trashId: z.string().min(1).max(128), path }),
  z.object({ op: z.literal("trash"), after: z.string().min(1).max(128).optional() }),
  z.object({ op: z.enum(["link", "linked"]), itemId: ItemId, reference }),
]);
export type FilesOperation = z.infer<typeof FilesOperation>;
export const NativeFilesRequest = z.object({
  type: z.literal("native.files"),
  scope: FilesScope,
  operation: FilesOperation,
});
export type NativeFilesRequest = z.infer<typeof NativeFilesRequest>;

export const Listing = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
export const Stat = z.object({
  version: z.string().nullable().optional(),
  size: z.number().optional(),
  type: z.string().optional(),
});
export const Trash = z.object({
  entries: z.array(
    z.object({ id: z.string(), path: z.string(), size: z.number(), expires: z.number() }),
  ),
  nextCursor: z.string().nullable(),
});

/**
 * Tell the Files screens to read again whenever any checkout's files change on the host (a
 * create, a save, a delete from any device), as the web drops its checkout reads then.
 */
export function followFileChanges(
  owner: Pick<ClientCore, "onMessage">,
  sink: Pick<PatchSink, "put">,
): () => void {
  let seq = 0;
  return owner.onMessage((message) => {
    const changed =
      message.type === "files.changed" ||
      (message.type === "events" &&
        message.events.some((event) => event.payload.type === "workspace.files_changed"));
    if (!changed) return;
    seq++;
    sink.put("files:changed", () => ({ type: "files.changed", seq }));
  });
}
