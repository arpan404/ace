import type { ClientApi } from "@ace/client";
import { ThreadId, WorkspaceFileChange, type FileOperation } from "@ace/protocol";
import { z } from "zod";
import { checkoutError, fromCode } from "./checkout-source.ts";

const listing = z.object({ paths: z.array(z.string()), truncated: z.boolean() });
const trash = z.object({
  entries: z.array(
    z.object({ id: z.string(), path: z.string(), size: z.number(), expires: z.number() }),
  ),
  nextCursor: z.string().nullable(),
});
const preview = z.object({ previewId: z.string(), entries: z.number(), bytes: z.number() });
export type TrashEntry = z.infer<typeof trash>["entries"][number];
export type ArchivePreview = z.infer<typeof preview>;
export type FileMutation = Extract<
  FileOperation,
  { op: "write" | "create" | "mkdir" | "rename" | "move" | "delete" | "restore" }
>;

function decode<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Couldn't read the file details. Update ace and try again.");
  return parsed.data;
}

/** All management requests keep the owning thread and validate the untyped result. */
export function fileManagement(client: ClientApi, threadId: string) {
  const request = async (operation: FileOperation, signal?: AbortSignal) => {
    const reply = await client
      .request(
        {
          type: "files.request",
          threadId: ThreadId.parse(threadId),
          operation,
        },
        signal ? { signal } : {},
      )
      .catch((error: unknown) => {
        throw checkoutError(error);
      });
    if (reply.type === "files.error") throw fromCode(reply.code);
    if (reply.type !== "files.result") throw new Error("Couldn't read the reply. Try again.");
    return reply.value;
  };
  return {
    async list(signal?: AbortSignal) {
      return decode(listing, await request({ op: "list", path: "", limit: 1000 }, signal));
    },
    async mutate(operation: FileMutation) {
      return decode(WorkspaceFileChange, await request(operation));
    },
    async trash(after?: string, signal?: AbortSignal) {
      return decode(
        trash,
        await request({ op: "trash.list", limit: 64, ...(after ? { after } : {}) }, signal),
      );
    },
    async preview(path: string, includeIgnored: boolean, signal?: AbortSignal) {
      return decode(
        preview,
        await request({ op: "archive.preview", path, includeIgnored }, signal),
      );
    },
  };
}
