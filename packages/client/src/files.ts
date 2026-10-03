import { fileConnection, type FileClient } from "./file-connection.ts";
import type { FileDownloadInput, FileUploadInput } from "./files-types.ts";
import type { ClientApi } from "./api.ts";
import { decodeBase64, encodeBase64 } from "./base64.ts";
import { ClientError, type RequestOptions } from "./types.ts";

/** Each pull completes before yielding; no download bytes are read ahead of the consumer. */
async function* downloadChunks(
  client: FileClient,
  input: FileDownloadInput,
  options: RequestOptions,
): AsyncGenerator<Uint8Array> {
  const { threadId, ...operation } = input;
  const ready = await client.request({ type: "files.request", threadId, operation }, options);
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
/** The source is pulled only after the preceding chunk has reached durable upload storage. */
async function uploadChunks(
  client: FileClient,
  input: FileUploadInput,
  source: AsyncIterable<Uint8Array>,
  options: RequestOptions,
): Promise<unknown> {
  const ready = await client.request(
    {
      type: "files.request",
      threadId: input.threadId,
      operation: {
        op: "upload.begin",
        path: input.path,
        expected: input.expected,
        size: input.size,
      },
    },
    options,
  );
  if (ready.type !== "files.upload")
    throw new ClientError(
      "daemon",
      ready.type === "files.error" ? ready.code : "Invalid upload response",
    );
  let offset = ready.offset;
  let committed = false;
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
    committed = true;
    return result.value;
  } finally {
    try {
      client.send({ type: "files.cancel", channel: ready.channel });
    } catch {
      /* Disconnect owns channels. */
    }
    if (!committed)
      await client
        .request(
          {
            type: "files.request",
            threadId: input.threadId,
            operation: { op: "upload.cancel", uploadId: ready.uploadId },
          },
          options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
        )
        .catch(() => {});
  }
}

export async function* downloadFile(
  client: ClientApi,
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
    return await uploadChunks(lifetime.client, input, source, options);
  } finally {
    lifetime.close();
  }
}
