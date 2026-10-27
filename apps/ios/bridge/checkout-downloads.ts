import type { FileDownloadInput } from "@ace/client";
import { downloadFile } from "@ace/client/files";
import type { HostRequest } from "@ace/native-host";
import { ItemId } from "@ace/protocol";
import { archiveFailure, archiveName, checkoutError, fromCode, pathParts } from "@ace/ui-core";
import { localLinkPath } from "@ace/ui-core/file-references";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import { base64 } from "./bytes.ts";
import type { FilesOwner } from "./checkout-files.ts";
import { FilesScope } from "./checkout-request.ts";

/*
 * Files saved to the phone (`files.download`): a checkout file, a file a message links to, or a
 * folder's archive, streamed a chunk at a time into a native temporary file (`download.*`), so
 * no size cap applies and the bytes never pile up here. Progress, the saved file's path, a
 * failure's sentence, or a stop comes back as the transfer's `files.download` patch.
 */

const id = z.string().min(1).max(64);
const path = z.string().min(1).max(4096);
export const DownloadTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path }),
  z.object({ kind: z.literal("linked"), itemId: ItemId, reference: path }),
  /** `path` is the folder ("" for the checkout's root); `previewId` from the `archive` read. */
  z.object({ kind: z.literal("archive"), path: z.string().max(4096), previewId: id }),
]);
export type DownloadTarget = z.infer<typeof DownloadTarget>;
export const NativeDownloadAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("files.download"), id, scope: FilesScope, target: DownloadTarget }),
  z.object({ type: z.literal("files.download.cancel"), id }),
  /** Swift is done with the saved file (shared, saved elsewhere, or dismissed). */
  z.object({ type: z.literal("files.download.done"), id }),
]);
export type NativeDownloadAction = z.infer<typeof NativeDownloadAction>;

type Phase = "saving" | "saved" | "failed" | "stopped";
interface Transfer {
  id: string;
  name: string;
  phase: Phase;
  received: number;
  /** Known for a file; an archive's compressed size isn't known until it ends. */
  size?: number | undefined;
  filePath?: string;
  message?: string;
  /** The host's id for the temporary file. */
  fileId: string;
  controller: AbortController;
}

export interface DownloadDoor {
  call: HostRequest;
  uuid: () => string;
}

export class CheckoutDownloads {
  readonly #owner: FilesOwner;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #door: DownloadDoor;
  readonly #transfers = new Map<string, Transfer>();
  constructor(owner: FilesOwner, sink: Pick<PatchSink, "put">, door: DownloadDoor) {
    this.#owner = owner;
    this.#sink = sink;
    this.#door = door;
  }

  handle(action: NativeDownloadAction): void {
    if (action.type === "files.download") {
      if (!this.#transfers.has(action.id)) void this.#start(action.id, action.scope, action.target);
      return;
    }
    const transfer = this.#transfers.get(action.id);
    if (!transfer) return;
    if (action.type === "files.download.cancel") {
      if (transfer.phase === "saving") transfer.controller.abort();
      return;
    }
    transfer.controller.abort();
    this.#transfers.delete(action.id);
    void this.#discard(transfer.fileId);
  }

  async #start(transferId: string, scope: FilesScope, target: DownloadTarget): Promise<void> {
    const transfer: Transfer = {
      id: transferId,
      name: downloadName(target),
      phase: "saving",
      received: 0,
      fileId: this.#door.uuid(),
      controller: new AbortController(),
    };
    this.#transfers.set(transferId, transfer);
    const signal = transfer.controller.signal;
    this.#show(transfer);
    try {
      const input = this.#input(scope, target);
      if (target.kind === "file") transfer.size = await this.#size(scope, target.path, signal);
      await this.#door.call("download.open", { id: transfer.fileId, name: transfer.name });
      for await (const chunk of downloadFile(this.#owner, input, { signal, timeoutMs: 60_000 })) {
        await this.#door.call(
          "download.append",
          { id: transfer.fileId, offset: transfer.received },
          base64(chunk),
        );
        transfer.received += chunk.length;
        this.#show(transfer);
      }
      if (signal.aborted) throw new DOMException("Stopped", "AbortError");
      transfer.filePath = await this.#door.call("download.finish", { id: transfer.fileId });
      transfer.size = transfer.received;
      transfer.phase = "saved";
    } catch (error) {
      void this.#discard(transfer.fileId);
      if (signal.aborted) transfer.phase = "stopped";
      else {
        transfer.phase = "failed";
        transfer.message =
          target.kind === "archive" ? archiveFailure(error).message : failure(error);
      }
    }
    this.#show(transfer);
  }

  #input(scope: FilesScope, target: DownloadTarget): FileDownloadInput {
    if (target.kind === "file") return { ...scope, op: "download", path: target.path, offset: 0 };
    // A message's link and a folder's archive belong to a thread, never a project's folder.
    if (!("threadId" in scope)) throw fromCode("FORBIDDEN");
    if (target.kind === "linked")
      return {
        ...scope,
        op: "link.download",
        itemId: target.itemId,
        reference: target.reference,
        offset: 0,
      };
    return { ...scope, op: "archive.download", previewId: target.previewId };
  }

  async #size(scope: FilesScope, file: string, signal: AbortSignal) {
    const reply = await this.#owner
      .request(
        { type: "files.request", ...scope, operation: { op: "stat", path: file } },
        { signal, timeoutMs: 20_000 },
      )
      .catch(() => undefined);
    if (reply?.type !== "files.result") return undefined;
    const size = z.object({ size: z.number() }).safeParse(reply.value);
    return size.success ? size.data.size : undefined;
  }

  async #discard(fileId: string) {
    await this.#door.call("download.discard", { id: fileId }).catch(() => {});
  }

  /** The transfer's patch; nothing once Swift is done with it. */
  #show(transfer: Transfer) {
    if (this.#transfers.get(transfer.id) !== transfer) return;
    const { id: transferId, name, phase, received, size, filePath, message } = transfer;
    this.#sink.put(`files.download:${transferId}`, () => ({
      type: "files.download",
      id: transferId,
      name,
      phase,
      received,
      ...(size === undefined ? {} : { size }),
      ...(filePath ? { filePath } : {}),
      ...(message ? { message } : {}),
    }));
  }
}

function downloadName(target: DownloadTarget): string {
  if (target.kind === "archive") return archiveName(target.path);
  if (target.kind === "file") return pathParts(target.path).name || "download";
  return pathParts(localLinkPath(target.reference) ?? target.reference).name || "download";
}

function failure(error: unknown): string {
  if (error instanceof Error && error.name === "HostCallError")
    return "Couldn't save the file on this iPhone. Free some space and try again.";
  return checkoutError(error).message;
}
