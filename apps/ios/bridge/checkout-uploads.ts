import { connectionLost, decodeBase64, sendResumableUpload } from "@ace/client";
import { ThreadId } from "@ace/protocol";
import {
  CheckoutError,
  checkoutError,
  fromCode,
  isCheckoutPath,
  keepBothPaths,
} from "@ace/ui-core";
import { z } from "zod";
import type { PatchSink } from "./agents.ts";
import type { FilesOwner } from "./checkout-files.ts";
import { Stat } from "./checkout-request.ts";
import { chunkBytes, Picked, type ChunkReader } from "./thread-attachments.ts";

/*
 * Files picked on the phone sent into a folder of a thread's checkout (`files.upload`), one
 * after another. Each is read from Swift's staged copy a chunk at a time. A file already at the
 * path waits for the person: replace it, keep both (a numbered name beside it), or skip it, for
 * this file or every one left. A lost connection doesn't lose the upload: the daemon keeps what
 * it stored and the file goes on from there once the connection is back. The batch's state is
 * one `files.upload` patch.
 */

const id = z.string().min(1).max(64);
const Choice = z.enum(["replace", "keepBoth", "skip"]);
type Choice = z.infer<typeof Choice>;
export const NativeUploadAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("files.upload"),
    id,
    threadId: ThreadId,
    /** The folder the files go in: "" for the checkout's root, else "src" or "src/". */
    folder: z.string().max(4096),
    files: z.array(Picked).min(1).max(32),
  }),
  /** The answer to the file waiting on a conflict; `all` answers every later one the same. */
  z.object({
    type: z.literal("files.upload.resolve"),
    id,
    choice: Choice,
    all: z.boolean().optional(),
  }),
  z.object({ type: z.literal("files.upload.cancel"), id }),
  /** Swift dropped the batch's row; a running batch stops. */
  z.object({ type: z.literal("files.upload.dismiss"), id }),
]);
export type NativeUploadAction = z.infer<typeof NativeUploadAction>;

type ItemState =
  | "queued"
  | "sending"
  | "conflict"
  | "waiting"
  | "done"
  | "skipped"
  | "failed"
  | "stopped";
interface Item {
  file: Picked;
  path: string;
  state: ItemState;
  sent: number;
  message?: string | undefined;
  uploadId?: string | undefined;
}
interface Batch {
  id: string;
  threadId: ThreadId;
  folder: string;
  items: Item[];
  running: boolean;
  controller: AbortController;
  all?: Choice | undefined;
  answer?: ((choice: Choice) => void) | undefined;
}
const batchLimit = 8;
/** How far keep both looks for a free numbered name. */
const keepBothTries = 64;

export class CheckoutUploads {
  readonly #owner: FilesOwner;
  readonly #sink: Pick<PatchSink, "put">;
  readonly #read: ChunkReader;
  readonly #batches = new Map<string, Batch>();
  constructor(owner: FilesOwner, sink: Pick<PatchSink, "put">, read: ChunkReader) {
    this.#owner = owner;
    this.#sink = sink;
    this.#read = read;
  }

  handle(action: NativeUploadAction): void {
    if (action.type === "files.upload") {
      if (this.#batches.has(action.id)) return;
      const folder = action.folder.replace(/^\/+|\/+$/g, "");
      const batch: Batch = {
        id: action.id,
        threadId: action.threadId,
        folder,
        items: action.files.map((file) => ({
          file,
          path: folder ? `${folder}/${file.name}` : file.name,
          state: "queued",
          sent: 0,
        })),
        running: true,
        controller: new AbortController(),
      };
      this.#batches.set(action.id, batch);
      if ([...this.#batches.values()].filter((each) => each.running).length > batchLimit) {
        for (const item of batch.items) {
          item.state = "failed";
          item.message = "Too many uploads at once. Try again when one finishes.";
        }
        batch.running = false;
        this.#show(batch);
        return;
      }
      void this.#run(batch);
      return;
    }
    const batch = this.#batches.get(action.id);
    if (!batch) return;
    if (action.type === "files.upload.resolve") {
      if (action.all) batch.all = action.choice;
      const answer = batch.answer;
      batch.answer = undefined;
      answer?.(action.choice);
      return;
    }
    batch.controller.abort();
    batch.answer?.("skip");
    if (action.type === "files.upload.dismiss") this.#batches.delete(action.id);
  }

  async #run(batch: Batch): Promise<void> {
    this.#show(batch);
    for (const item of batch.items) {
      if (batch.controller.signal.aborted) item.state = "stopped";
      else await this.#send(batch, item);
      this.#show(batch);
    }
    batch.running = false;
    this.#show(batch);
  }

  /** One file: its conflict settled, then its bytes sent, through any reconnects. */
  async #send(batch: Batch, item: Item): Promise<void> {
    const signal = batch.controller.signal;
    try {
      if (!isCheckoutPath(item.path)) throw fromCode("OUTSIDE_WORKSPACE");
      await this.#online(signal);
      let expected = await this.#version(batch, item.path);
      for (let attempt = 0; ; attempt++) {
        if (expected !== null) {
          const choice = batch.all ?? (await this.#ask(batch, item));
          if (signal.aborted) throw new DOMException("Stopped", "AbortError");
          if (choice === "skip") {
            item.state = "skipped";
            return;
          }
          if (choice === "keepBoth") {
            item.path = await this.#freePath(batch, item.path);
            expected = null;
          }
        }
        item.state = "sending";
        this.#show(batch);
        try {
          await this.#upload(batch, item, expected);
          item.state = "done";
          return;
        } catch (error) {
          if (signal.aborted) throw error;
          // The daemon keeps what it stored; the upload goes on once the connection is back.
          if (connectionLost(error) && attempt < 50) {
            item.state = "waiting";
            this.#show(batch);
            await this.#online(signal);
            continue;
          }
          const resumed = item.uploadId !== undefined;
          item.uploadId = undefined;
          const code = checkoutError(error).code;
          // Something appeared or changed at the path meanwhile: ask again about what's there now.
          if (code === "CONFLICT" && attempt < 3) {
            expected = await this.#version(batch, item.path);
            continue;
          }
          // The daemon no longer holds the upload (expired, or restarted): start it again.
          if (resumed && attempt < 3 && ["NOT_FOUND", "EXPIRED", "FORBIDDEN"].includes(code)) {
            item.sent = 0;
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (signal.aborted) item.state = "stopped";
      else {
        item.state = "failed";
        item.message = failure(error);
      }
    }
  }

  #upload(batch: Batch, item: Item, expected: string | null) {
    const { localId, bytes: size, sha256 } = item.file;
    const read = this.#read;
    return sendResumableUpload(
      this.#owner,
      {
        input: { threadId: batch.threadId, path: item.path, expected, size, sha256 },
        uploadId: item.uploadId,
        source: (from) => staged(read, localId, from, size),
        opened: (uploadId, offset) => {
          item.uploadId = uploadId;
          item.sent = offset;
          this.#show(batch);
        },
        progress: (offset) => {
          item.sent = offset;
          this.#show(batch);
        },
      },
      { signal: batch.controller.signal, timeoutMs: 60_000 },
    );
  }

  /** What is at `path` now: its version, or null when nothing is. */
  async #version(batch: Batch, path: string): Promise<string | null> {
    const reply = await this.#owner
      .request(
        { type: "files.request", threadId: batch.threadId, operation: { op: "stat", path } },
        { signal: batch.controller.signal, timeoutMs: 20_000 },
      )
      .catch((error: unknown) => {
        throw checkoutError(error);
      });
    if (reply.type === "files.error") throw fromCode(reply.code);
    if (reply.type !== "files.result")
      throw new CheckoutError("protocol", "Couldn't read the reply. Try again.");
    return Stat.parse(reply.value).version ?? null;
  }

  async #freePath(batch: Batch, path: string): Promise<string> {
    let tries = 0;
    for (const candidate of keepBothPaths(path)) {
      if ((await this.#version(batch, candidate)) === null) return candidate;
      if (++tries >= keepBothTries) break;
    }
    throw new CheckoutError("taken", "Too many copies of this file already. Rename it first.");
  }

  #ask(batch: Batch, item: Item): Promise<Choice> {
    item.state = "conflict";
    this.#show(batch);
    return new Promise((resolve) => {
      batch.answer = resolve;
    });
  }

  /** Resolves once the connection is ready again; rejects when the batch stops. */
  #online(signal: AbortSignal): Promise<void> {
    if (this.#owner.state === "ready") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stop = this.#owner.connectionState().subscribe(() => {
        if (this.#owner.state !== "ready") return;
        finish();
        resolve();
      });
      const abort = () => {
        finish();
        reject(new DOMException("Stopped", "AbortError"));
      };
      const finish = () => {
        stop();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  #show(batch: Batch) {
    if (this.#batches.get(batch.id) !== batch) return;
    const items = batch.items.map((item) => ({
      localId: item.file.localId,
      name: item.file.name,
      path: item.path,
      size: item.file.bytes,
      sent: item.sent,
      state: item.state,
      ...(item.message ? { message: item.message } : {}),
    }));
    this.#sink.put(`files.upload:${batch.id}`, () => ({
      type: "files.upload",
      id: batch.id,
      threadId: batch.threadId,
      folder: batch.folder,
      phase: phase(batch),
      sent: items.reduce((sum, item) => sum + item.sent, 0),
      size: items.reduce((sum, item) => sum + item.size, 0),
      items,
    }));
  }
}

/** The batch in one word, for its status line. */
function phase(batch: Batch): string {
  const states = new Set(batch.items.map((item) => item.state));
  if (states.has("conflict")) return "asking";
  if (states.has("waiting")) return "waiting";
  if (batch.running) return "sending";
  if (states.has("failed")) return "failed";
  if (states.has("stopped")) return "stopped";
  return "done";
}

/** A staged file's bytes from `from` on, read from Swift one chunk at a time. */
async function* staged(
  read: ChunkReader,
  localId: string,
  from: number,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = from; offset < size; ) {
    const bytes = decodeBase64(
      await read(localId, offset, Math.min(chunkBytes, size - offset)),
      chunkBytes,
    );
    if (!bytes.length) throw new CheckoutError("staged", "The picked file changed. Pick it again.");
    offset += bytes.length;
    yield bytes;
  }
}

function failure(error: unknown): string {
  if (error instanceof Error && error.name === "HostCallError")
    return "The picked file is gone from this iPhone. Pick it again.";
  return checkoutError(error).message;
}
