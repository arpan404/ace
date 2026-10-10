import { decodePortableFileFrame } from "@ace/files/client";
import { ThreadId } from "@ace/protocol";
import type { AttachmentInput, AttachmentFrame } from "./attachment-types.ts";
import type { AttachmentOwner } from "./attachment-owner.ts";
import { ClientError, type RequestOptions, type Scheduler } from "./types.ts";
import { Requests } from "./requests.ts";

type Read = {
  request: string;
  stream?: number;
  waiting: boolean;
  announced: boolean;
  offset: number;
  size: number;
  value?: Uint8Array | undefined;
  error?: ClientError;
  cleanup?(): void;
};
const owns = (id: number) => Number.isInteger(id) && id > 0x40000000 && id <= 0x7fffffff;

/** Original pulls share the authenticated connection and its bounded request machinery. */
export class AttachmentStreams {
  #reads = new Set<Read>();
  #streams = new Map<number, Read>();
  #client: AttachmentOwner;
  #requests: Requests;
  #id: () => string;
  constructor(client: AttachmentOwner, scheduler: Scheduler, timeout: number, id: () => string) {
    this.#client = client;
    this.#requests = new Requests(scheduler, 4, timeout);
    this.#id = id;
  }
  #fail(read: Read, error: ClientError): void {
    read.error ??= error;
    this.#requests.reject(read.request, read.error);
    this.#cancel(read);
  }
  #cancel(read: Read): void {
    if (!this.#reads.delete(read)) return;
    read.cleanup?.();
    delete read.cleanup;
    if (read.stream === undefined) return;
    if (this.#streams.get(read.stream) !== read) return;
    this.#streams.delete(read.stream);
    try {
      this.#client.send({ type: "files.cancel", channel: read.stream });
    } catch {
      /* Disconnect owns server cleanup. */
    }
  }
  receive(frame: Uint8Array): void {
    const chunk = decodePortableFileFrame(frame);
    if (!owns(chunk.channel)) throw new ClientError("protocol");
    // Removed canceled owners cannot receive late credited frames.
    const read = this.#streams.get(chunk.channel);
    if (!read) return;
    if (
      !read.waiting ||
      chunk.offset !== read.offset ||
      !chunk.bytes.length ||
      read.offset + chunk.bytes.length > read.size
    ) {
      this.#fail(read, new ClientError("protocol"));
      return;
    }
    read.offset += chunk.bytes.length;
    read.value = chunk.bytes.slice();
    read.waiting = false;
    this.#requests.resolve(read.request, undefined);
  }
  async *chunks(
    input: AttachmentInput & { maxBytes: number },
    options: RequestOptions,
  ): AsyncGenerator<AttachmentFrame> {
    if (this.#reads.size >= 4) throw new ClientError("limit");
    const request = this.#id();
    for (const active of this.#reads)
      if (active.request === request) throw new ClientError("limit");
    const read: Read = { request, announced: false, waiting: false, offset: 0, size: 0 };
    const abort = () => this.#fail(read, new ClientError("aborted"));
    const stop = this.#client.onMessage((message) => {
      if (message.type === "files.ready" && message.requestId === request) {
        if (read.announced || !owns(message.channel) || this.#streams.has(message.channel))
          this.#fail(read, new ClientError("protocol"));
        else {
          read.stream = message.channel;
          this.#streams.set(message.channel, read);
        }
        read.announced = true;
      } else if (message.type === "files.error" && message.requestId === request)
        this.#fail(read, new ClientError("daemon", message.code));
      else if (
        message.type !== "files.ready" &&
        read.stream !== undefined &&
        "channel" in message &&
        message.channel === read.stream
      ) {
        if (message.type === "files.error")
          this.#fail(read, new ClientError("daemon", message.code));
        else if (message.type === "files.end") {
          if (
            !read.waiting ||
            message.offset !== read.offset ||
            read.offset !== read.size ||
            message.sha256 !== input.sha256
          )
            this.#fail(read, new ClientError("protocol"));
          else {
            read.waiting = false;
            read.value = undefined;
            this.#requests.resolve(request, undefined);
          }
        } else this.#fail(read, new ClientError("protocol"));
      }
    });
    this.#reads.add(read);
    read.cleanup = () => {
      stop();
      options.signal?.removeEventListener("abort", abort);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    let opened = false;
    try {
      if (options.signal?.aborted) throw new ClientError("aborted");
      const reply = await this.#client.request(
        {
          type: "files.request",
          threadId: ThreadId.parse(input.threadId),
          operation: { op: "attachment.download", sha256: input.sha256, maxBytes: input.maxBytes },
        },
        { ...options, requestId: request },
      );
      opened = reply.type === "files.ready";
      if (read.error) throw read.error;
      if (reply.type !== "files.ready")
        throw new ClientError(
          "daemon",
          reply.type === "files.error" ? reply.code : "Invalid attachment response",
        );
      if (
        !owns(reply.channel) ||
        this.#streams.get(reply.channel) !== read ||
        reply.offset !== 0 ||
        reply.size === null ||
        reply.size > input.maxBytes ||
        reply.validator !== input.sha256 ||
        !reply.mimeType
      )
        throw new ClientError("protocol");
      read.stream = reply.channel;
      read.size = reply.size;
      yield { bytes: reply.size, mimeType: reply.mimeType };
      for (;;) {
        if (read.error) throw read.error;
        read.waiting = true;
        const value = await this.#requests.wait(
          request,
          () => read.value,
          options,
          () => {
            this.#client.send({ type: "files.credit", channel: reply.channel, credits: 1 });
          },
        );
        if (value === undefined) return;
        yield value;
      }
    } finally {
      this.#cancel(read);
      if (opened && read.stream === undefined) {
        try {
          this.#client.send({ type: "files.abort", sourceRequestId: request });
        } catch {
          /* Disconnect owns opening cleanup. */
        }
      }
    }
  }
}
