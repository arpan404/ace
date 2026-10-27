import { BrowserDownloadRead, ThreadId } from "@ace/protocol";
import { downloadBusy } from "@ace/browser/stream";
import type { ClientApi } from "./api.ts";
import { ClientError } from "./errors.ts";
import {
  ChunkedFile,
  fetchChunked,
  type ChunkAsk,
  type ChunkReply,
  type TransferIo,
} from "./download-transfer.ts";

/** The largest download this device takes in (it is held in memory until saved). */
export const deviceDownloadMax = 256 * 1024 * 1024;
/** Bytes asked for per read: a few socket messages, so frames still get through between. */
const chunkBytes = 256 * 1024;

/** The chunk's binary stream message never arrived (the connection had no room): read again. */
class MissingChunk extends Error {}

const passing = new Set<ClientError["code"]>(["offline", "timeout", "busy", "not_dispatched"]);

/**
 * Fetches a finished download of a thread's browser to this device: each chunk's bytes arrive
 * as a binary stream message, its reply says how many. A dropped connection or a busy daemon is
 * waited out and the transfer resumes where it stopped.
 */
export async function fetchBrowserDownload(
  client: Pick<ClientApi, "request" | "onStream">,
  threadId: string,
  downloadId: string,
  options: {
    signal?: AbortSignal;
    onProgress?(received: number, size: number): void;
    /** Defaults to timers; tests pass their own. */
    wait?(ms: number, signal?: AbortSignal): Promise<void>;
    limit?: number;
    /**
     * Each verified chunk as it arrives, in order: the file is written as it comes and only one
     * chunk is held; the returned bytes are then empty. Without it, the whole file is returned.
     */
    onChunk?(chunk: {
      bytes: Uint8Array;
      offset: number;
      size: number;
      done: boolean;
    }): void | Promise<void>;
  } = {},
): Promise<Uint8Array> {
  const onStream = client.onStream?.bind(client);
  if (!onStream) throw new ClientError("protocol", "This connection can't fetch files");
  const thread = ThreadId.parse(threadId);
  const read = async (ask: ChunkAsk, signal?: AbortSignal): Promise<ChunkReply> => {
    let bytes: Uint8Array | undefined;
    const stop = onStream((message) => {
      if (
        message.kind === "browser.download.chunk" &&
        message.threadId === thread &&
        message.downloadId === downloadId &&
        message.offset === ask.offset
      )
        bytes = message.bytes;
    });
    try {
      const response = await client.request(
        { type: "browser.download.read", threadId: thread, downloadId, ...ask },
        signal ? { signal } : undefined,
      );
      if (!response.ok) throw new ClientError("daemon", response.error ?? "Couldn't read the file");
      const reply = BrowserDownloadRead.safeParse(response.result);
      if (!reply.success) throw new ClientError("protocol", "Invalid download chunk");
      if (!bytes || bytes.length !== reply.data.bytes) throw new MissingChunk();
      return { ...reply.data, bytes };
    } finally {
      stop();
    }
  };
  const io: TransferIo = {
    read,
    retryable: (error) =>
      error instanceof MissingChunk ||
      (error instanceof ClientError &&
        (passing.has(error.code) || (error.code === "daemon" && error.message === downloadBusy))),
    wait: options.wait ?? sleep,
  };
  const file = new ChunkedFile(options.limit ?? deviceDownloadMax, chunkBytes, {
    keep: !options.onChunk,
  });
  return fetchChunked(io, file, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    ...(options.onChunk ? { onChunk: options.onChunk } : {}),
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
