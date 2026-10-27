/*
 * Fetching a file to this device in chunks, resuming where it stopped. Pure: the reads, the
 * waits between attempts and which failures are worth another attempt are passed in.
 */

/** One chunk as the daemon sent it, with what the whole file is. */
export interface ChunkReply {
  offset: number;
  bytes: Uint8Array;
  size: number;
  validator: string;
  done: boolean;
}

/** What a transfer asks for next. */
export interface ChunkAsk {
  offset: number;
  length: number;
  validator?: string;
}

export class TransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferError";
  }
}

/**
 * The bytes received so far, in order. A chunk that isn't the next one, a file whose size or
 * validator changed, or a file over `limit` is refused: a resumed transfer never splices two
 * versions of a file or keeps more than it may.
 */
export class ChunkedFile {
  #chunks: Uint8Array[] = [];
  #received = 0;
  #size: number | undefined;
  #validator: string | undefined;
  #done = false;
  readonly limit: number;
  readonly chunkBytes: number;
  /** Keep the bytes for `bytes()`; false when each chunk is handed on as it arrives. */
  readonly #keep: boolean;
  constructor(limit: number, chunkBytes: number, options: { keep?: boolean } = {}) {
    this.limit = limit;
    this.chunkBytes = chunkBytes;
    this.#keep = options.keep ?? true;
  }
  get received(): number {
    return this.#received;
  }
  /** The file's size, once the first chunk said. */
  get size(): number | undefined {
    return this.#size;
  }
  get done(): boolean {
    return this.#done;
  }
  next(): ChunkAsk {
    const remaining = this.#size === undefined ? this.chunkBytes : this.#size - this.#received;
    return {
      offset: this.#received,
      length: Math.max(1, Math.min(this.chunkBytes, remaining)),
      ...(this.#validator === undefined ? {} : { validator: this.#validator }),
    };
  }
  accept(reply: ChunkReply): void {
    if (this.#done) throw new TransferError("The file already arrived");
    if (reply.size > this.limit) throw new TransferError("The file is too large for this device");
    if (this.#size !== undefined && reply.size !== this.#size)
      throw new TransferError("The file changed while it was fetched");
    if (this.#validator !== undefined && reply.validator !== this.#validator)
      throw new TransferError("The file changed while it was fetched");
    if (reply.offset !== this.#received) throw new TransferError("A chunk arrived out of order");
    const end = reply.offset + reply.bytes.length;
    if (end > reply.size) throw new TransferError("A chunk ran past the file's end");
    if (!reply.bytes.length && end < reply.size) throw new TransferError("An empty chunk");
    if (reply.done !== (end === reply.size)) throw new TransferError("The file's end is unclear");
    this.#size = reply.size;
    this.#validator = reply.validator;
    if (this.#keep && reply.bytes.length) this.#chunks.push(reply.bytes);
    this.#received = end;
    this.#done = reply.done;
  }
  /** The whole file, once done; empty when the chunks weren't kept. */
  bytes(): Uint8Array {
    if (!this.#done) throw new TransferError("The file hasn't fully arrived");
    if (!this.#keep) return new Uint8Array(0);
    const whole = new Uint8Array(this.#received);
    let at = 0;
    for (const chunk of this.#chunks) {
      whole.set(chunk, at);
      at += chunk.length;
    }
    return whole;
  }
}

/** Waits before the `attempt`th retry in a row: doubling from 250 ms, at most 5 s. */
export function retryDelay(attempt: number): number {
  return Math.min(5_000, 250 * 2 ** Math.max(0, attempt - 1));
}

export interface TransferIo {
  read(ask: ChunkAsk, signal?: AbortSignal): Promise<ChunkReply>;
  /** Whether a failed read may succeed if asked again (a dropped connection, a busy daemon). */
  retryable(error: unknown): boolean;
  wait(ms: number, signal?: AbortSignal): Promise<void>;
}

/**
 * Reads a whole file chunk by chunk. A read that fails for a passing reason (the connection
 * dropped, the daemon was busy) is asked again from where the file stopped, after a growing
 * wait; `maxRetries` failures in a row, or any other failure, end the transfer.
 */
export async function fetchChunked(
  io: TransferIo,
  file: ChunkedFile,
  options: {
    maxRetries?: number;
    signal?: AbortSignal;
    onProgress?(received: number, size: number): void;
    /**
     * Each chunk once verified, in order, before the next is asked for (`done` on the last).
     * Its failure ends the transfer. With it, the file is best made with `keep: false`, so only
     * one chunk is ever held.
     */
    onChunk?(chunk: {
      bytes: Uint8Array;
      offset: number;
      size: number;
      done: boolean;
    }): void | Promise<void>;
  } = {},
): Promise<Uint8Array> {
  const maxRetries = options.maxRetries ?? 40;
  let failures = 0;
  while (!file.done) {
    options.signal?.throwIfAborted();
    let reply: ChunkReply;
    try {
      reply = await io.read(file.next(), options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (!io.retryable(error) || ++failures > maxRetries) throw error;
      await io.wait(retryDelay(failures), options.signal);
      continue;
    }
    failures = 0;
    file.accept(reply);
    await options.onChunk?.({
      bytes: reply.bytes,
      offset: reply.offset,
      size: reply.size,
      done: reply.done,
    });
    options.onProgress?.(file.received, file.size ?? file.received);
  }
  return file.bytes();
}
