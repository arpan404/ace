// The daemon's context service (`context.request`) as both the composer and the browser use
// it: its failures in plain words, and the resumable upload sequence (begin, chunks at the
// acknowledged offset, commit) that turns a file into a thread attachment.
import type { ClientApi } from "@ace/client";
import {
  ThreadId,
  type Attachment,
  type ContextOperation,
  type ContextResult,
} from "@ace/protocol";

type Result = ContextResult["result"];

const messages: Partial<Record<Extract<Result, { kind: "error" }>["code"], string>> = {
  busy: "Files are still in use. Wait for current work to finish, then try again.",
  invalid_image: "That image can't be read.",
  forbidden: "This device may not add files to the thread.",
  not_found: "This thread or attachment is no longer available.",
  quota:
    "Attachment limit reached. Open Attachments from the thread menu and remove files you no longer need.",
  unsupported: "This attachment operation is unavailable. Update ace and try again.",
  invalid_request: "Couldn't manage the attachment. Try again.",
};

/** Base64 of up to 48 KiB, which stays under the protocol's chunk size limit. */
export const chunkBytes = 48 * 1024;

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

const is = <K extends Result["kind"]>(
  result: Result,
  kind: K,
): result is Extract<Result, { kind: K }> => result.kind === kind;

export function expect<K extends Result["kind"]>(
  result: Result,
  kind: K,
): Extract<Result, { kind: K }> {
  if (result.kind === "error") throw new ContextError(messages[result.code] ?? result.message);
  if (!is(result, kind)) throw new ContextError("ace answered something unexpected.");
  return result;
}

export async function sha256(file: File): Promise<string> {
  const { sha256: createHash } = await import("@noble/hashes/sha2.js");
  const hash = createHash.create();
  for (let offset = 0; offset < file.size; offset += chunkBytes)
    hash.update(new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer()));
  return [...hash.digest()].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

export const askContext =
  (client: ClientApi) => async (operation: ContextOperation, signal?: AbortSignal) =>
    (await client.request({ type: "context.request", operation }, signal ? { signal } : {})).result;

/** Where an upload begins: a thread's attachments, or a draft scope before the thread exists. */
export type UploadScope = { threadId: string } | { draftId: string };

/** Uploads a file into the scope's attachments; `progress` is 0..1. */
export async function uploadContextFile(
  client: ClientApi,
  scope: UploadScope,
  file: File,
  progress: (fraction: number) => void,
): Promise<Attachment> {
  const ask = askContext(client);
  const target = {
    sha256: await sha256(file),
    bytes: file.size,
    mimeType: file.type || undefined,
    name: file.name.slice(0, 255) || "file",
  };
  const begun = expect(
    await ask(
      "draftId" in scope
        ? { op: "draft.upload.begin", draftId: scope.draftId, ...target }
        : { op: "upload.begin", threadId: ThreadId.parse(scope.threadId), ...target },
    ),
    "upload",
  );
  let offset = begun.offset;
  while (offset < file.size) {
    const chunk = new Uint8Array(await file.slice(offset, offset + chunkBytes).arrayBuffer());
    const next = expect(
      await ask({ op: "upload.chunk", uploadId: begun.uploadId, offset, data: base64(chunk) }),
      "upload",
    );
    if (next.offset <= offset) throw new ContextError("The upload stopped making progress.");
    offset = next.offset;
    progress(Math.min(0.99, offset / file.size));
  }
  const committed = expect(
    await ask({ op: "upload.commit", uploadId: begun.uploadId }),
    "attachment",
  );
  progress(1);
  return committed.attachment;
}
