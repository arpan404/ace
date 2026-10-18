import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createTextRedactor } from "@ace/redaction";
import { imageToolkit, PublicToolError, type ImagePublicationPort } from "@ace/mcp-server";
import {
  ItemId,
  SharedImageType,
  maxSharedImageBytes,
  maxSharedImageDataBytes,
  type McpAttribution,
} from "@ace/protocol";
import { sniffMime, type ContextService } from "@ace/context";
import type { Store } from "./store.ts";
import { toolAttachment } from "./tool-result-content.ts";
import { agentDirectory, readImageFile } from "./image-files.ts";

const extensions: Record<SharedImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * The file an agent named. Its folders may be links (macOS `/tmp` is one); the file itself
 * never is, and it is read without following links. Any failure is one public error.
 */
async function readNamedImage(store: Store, caller: McpAttribution, path: string) {
  const directory = isAbsolute(path)
    ? undefined
    : agentDirectory(store, caller.threadId, caller.agentId);
  if (!isAbsolute(path) && !directory) throw new PublicToolError("image_unavailable");
  const named = directory ? resolve(directory, path) : resolve(path);
  try {
    const file = join(await realpath(dirname(named)), basename(named));
    return await readImageFile(file, maxSharedImageBytes);
  } catch {
    throw new PublicToolError("image_unavailable");
  }
}

export function imagePublication(runtime: {
  store: Store;
  context(): ContextService | undefined;
  now(): number;
  id(): string;
  redactText?: (text: string) => string;
}) {
  // The reference is indexed independently of the windowed in-memory transcript.
  runtime.store
    .statement(`CREATE INDEX IF NOT EXISTS image_attachment ON items(
    thread_id,json_extract(item,'$.image.attachment.sha256'))
    WHERE json_extract(item,'$.type')='image'`)
    .run();
  const redact = runtime.redactText ?? createTextRedactor({});
  const port: ImagePublicationPort = {
    async publish(caller, input, signal) {
      signal.throwIfAborted();
      const context = runtime.context();
      if (!context || !runtime.store.hasLiveThread(caller.threadId))
        throw new Error("Image publication unavailable");
      const bytes =
        input.path === undefined
          ? Buffer.from(input.data ?? "", "base64")
          : await readNamedImage(runtime.store, caller, input.path);
      signal.throwIfAborted();
      // The bytes decide the type; a file name or a claimed mimeType never does.
      const sniffed = SharedImageType.safeParse(sniffMime(bytes.subarray(0, 64)));
      if (
        !sniffed.success ||
        bytes.length > (input.path === undefined ? maxSharedImageDataBytes : maxSharedImageBytes)
      )
        throw new PublicToolError("invalid_image");
      const mimeType = sniffed.data;
      const named = input.path === undefined ? "" : basename(input.path).slice(-120);
      const attachment = await toolAttachment(context, caller, bytes, {
        name: named.includes(".") ? named : `image.${extensions[mimeType]}`,
        mimeType,
      });
      // Bytes another item still holds stay retained; the store refuses that release.
      const release = () =>
        context.uploads
          .handle("daemon-tool-result", {
            op: "attachment.release",
            threadId: caller.threadId,
            sha256: attachment.sha256,
          })
          .catch(() => undefined);
      // The upload validates the whole container; a truncated or unsafe image stays unshown.
      if (attachment.kind !== "image") {
        await release();
        throw new PublicToolError("invalid_image");
      }
      if (signal.aborted || !runtime.store.hasLiveThread(caller.threadId)) {
        await release();
        signal.throwIfAborted();
        throw new Error("Thread deleted");
      }
      const caption = input.caption === undefined ? "" : redact(input.caption.trim()).slice(0, 500);
      const itemId = ItemId.parse(runtime.id());
      const at = runtime.now();
      runtime.store.appendEvents(
        caller.threadId,
        [
          {
            type: "item.created",
            item: {
              type: "image",
              id: itemId,
              agentId: caller.agentId,
              createdAt: at,
              complete: true,
              raw: [],
              image: {
                attachment,
                alt: redact(input.alt.trim()).slice(0, 300) || "Image",
                ...(caption ? { caption } : {}),
              },
            },
          },
        ],
        at,
      );
      return { itemId };
    },
  };
  return imageToolkit(port);
}

export function retainsImage(store: Store, thread: string, hash: string): boolean {
  return Boolean(
    store
      .statement(`SELECT 1 FROM items WHERE thread_id=?
    AND json_extract(item,'$.type')='image'
    AND json_extract(item,'$.image.attachment.sha256')=? LIMIT 1`)
      .get(thread, hash),
  );
}
