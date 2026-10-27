import { fileConnection, type FileClient, type FileHost } from "./file-connection.ts";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type { ClientApi } from "./api.ts";
import { decodeBase64 } from "./base64.ts";
import { encodeBase64 } from "./base64-encode.ts";
import { ClientError, type RequestOptions } from "./types.ts";

/** Each pull completes before yielding; no download bytes are read ahead of the consumer. */
async function* downloadChunks(
  client: FileClient,
  input: FileDownloadInput,
  options: RequestOptions,
): AsyncGenerator<Uint8Array> {
  const { threadId, workspaceId, scope, ...operation } = input;
  const ready = await client.request(
    { type: "files.request", threadId, workspaceId, scope, operation },
    options,
  );
  if (ready.type !== "files.ready")
    throw new ClientError(
      "daemon",
      ready.type === "files.error" ? ready.code : "Invalid file response",
    );
  let offset = ready.offset;
  try {
    for (;;) {
      const result = await client.request({ type: "files.pull", channel: ready.channel }, options);
      if (result.type !== "files.data") throw new ClientError("daemon", result.code);
      if (result.channel !== ready.channel || result.offset !== offset)
        throw new ClientError("protocol");
      const bytes = decodeBase64(result.data, 65536);
      offset += bytes.length;
      if (ready.size !== null && offset > ready.size) throw new ClientError("protocol");
      if (result.eof) {
        if (bytes.length || !result.sha256 || (ready.size !== null && offset !== ready.size))
          throw new ClientError("protocol");
        return;
      }
      if (!bytes.length) throw new ClientError("protocol");
      yield bytes;
    }
  } finally {
    try {
      client.send({ type: "files.cancel", channel: ready.channel });
    } catch {
      /* Disconnect owns channel cleanup. */
    }
  }
}
type UploadReady = { channel: number; uploadId: string; offset: number };

/** Opens an upload (`upload.begin`) or reopens one this device began (`upload.resume`). */
async function openUpload(
  client: FileClient,
  input: FileUploadInput,
  uploadId: string | undefined,
  options: RequestOptions,
): Promise<UploadReady> {
  const ready = await client.request(
    {
      type: "files.request",
      threadId: input.threadId,
      operation: uploadId
        ? { op: "upload.resume", uploadId }
        : { op: "upload.begin", path: input.path, expected: input.expected, size: input.size },
    },
    options,
  );
  if (ready.type !== "files.upload")
    throw new ClientError(
      "daemon",
      ready.type === "files.error" ? ready.code : "Invalid upload response",
    );
  if (ready.size !== input.size) throw new ClientError("protocol");
  return ready;
}

/** The source is pulled only after the preceding chunk has reached durable upload storage. */
async function sendChunks(
  client: FileClient,
  input: FileUploadInput,
  ready: UploadReady,
  source: AsyncIterable<Uint8Array>,
  options: RequestOptions,
  progress?: (offset: number) => void,
): Promise<unknown> {
  let offset = ready.offset;
  try {
    for await (const value of source) {
      if (!(value instanceof Uint8Array) || value.length > 65536)
        throw new ClientError("limit", "Upload source must yield at most 64 KiB");
      if (!value.length) continue;
      if (offset + value.length > input.size) throw new ClientError("limit");
      const result = await client.request(
        { type: "files.chunk", channel: ready.channel, offset, data: encodeBase64(value) },
        options,
      );
      if (result.type !== "files.upload") throw new ClientError("daemon", result.code);
      if (
        result.channel !== ready.channel ||
        result.uploadId !== ready.uploadId ||
        result.offset !== offset + value.length
      )
        throw new ClientError("protocol");
      offset = result.offset;
      progress?.(offset);
    }
    if (offset !== input.size) throw new ClientError("protocol", "Incomplete upload source");
    const result = await client.request(
      {
        type: "files.request",
        threadId: input.threadId,
        operation: { op: "upload.commit", uploadId: ready.uploadId, sha256: input.sha256 },
      },
      options,
    );
    if (result.type !== "files.result")
      throw new ClientError(
        "daemon",
        result.type === "files.error" ? result.code : "Invalid commit response",
      );
    return result.value;
  } finally {
    try {
      client.send({ type: "files.cancel", channel: ready.channel });
    } catch {
      /* Disconnect owns channels. */
    }
  }
}

async function cancelUpload(
  client: FileClient,
  threadId: FileUploadInput["threadId"],
  uploadId: string,
  options: RequestOptions,
): Promise<void> {
  await client
    .request(
      { type: "files.request", threadId, operation: { op: "upload.cancel", uploadId } },
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    )
    .catch(() => {});
}

export async function* downloadFile(
  client: FileHost,
  input: FileDownloadInput,
  options: RequestOptions,
): AsyncGenerator<Uint8Array> {
  const lifetime = fileConnection(client);
  try {
    yield* downloadChunks(lifetime.client, input, options);
  } finally {
    lifetime.close();
  }
}
export async function uploadFile(
  client: ClientApi,
  input: FileUploadInput,
  source: AsyncIterable<Uint8Array>,
  options: RequestOptions,
): Promise<unknown> {
  const lifetime = fileConnection(client);
  try {
    const ready = await openUpload(lifetime.client, input, undefined, options);
    let committed = false;
    try {
      const value = await sendChunks(lifetime.client, input, ready, source, options);
      committed = true;
      return value;
    } finally {
      if (!committed) await cancelUpload(lifetime.client, input.threadId, ready.uploadId, options);
    }
  } finally {
    lifetime.close();
  }
}

/** A failure that says the connection went, not that the upload is wrong. */
export function connectionLost(error: unknown): boolean {
  return (
    error instanceof ClientError &&
    (error.code === "offline" || error.code === "timeout" || error.code === "not_dispatched")
  );
}

/** One step of a resumable upload. */
export interface ResumableUpload {
  input: FileUploadInput;
  /** An upload this device began before a lost connection; the daemon keeps what it received. */
  uploadId?: string | undefined;
  /** The bytes from `offset` to the end, at most 64 KiB a chunk. */
  source(offset: number): AsyncIterable<Uint8Array>;
  /** The daemon holds the upload: its id (to resume with) and how much it already has. */
  opened?(uploadId: string, offset: number): void;
  /** Bytes the daemon has stored so far. */
  progress?(offset: number): void;
}

/**
 * Send a file that may outlive one connection. A connection lost midway (`connectionLost`)
 * leaves the daemon's upload in place, so a later call with `uploadId` continues from
 * the bytes it already stored. Any other failure, or an abort, cancels the upload.
 */
export async function sendResumableUpload(
  client: FileHost,
  upload: ResumableUpload,
  options: RequestOptions,
): Promise<unknown> {
  const lifetime = fileConnection(client);
  try {
    const ready = await openUpload(lifetime.client, upload.input, upload.uploadId, options);
    upload.opened?.(ready.uploadId, ready.offset);
    let keep = false;
    try {
      const value = await sendChunks(
        lifetime.client,
        upload.input,
        ready,
        upload.source(ready.offset),
        options,
        upload.progress,
      );
      keep = true;
      return value;
    } catch (error) {
      keep = connectionLost(error) && !options.signal?.aborted;
      throw error;
    } finally {
      if (!keep) await cancelUpload(lifetime.client, upload.input.threadId, ready.uploadId, options);
    }
  } finally {
    lifetime.close();
  }
}
