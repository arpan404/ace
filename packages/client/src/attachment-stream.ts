import { FilesServerMessage, ThreadId } from "@ace/protocol";
import { decodePortableFileFrame } from "@ace/files/client";
import type { ArtifactChannel } from "@ace/files/client";
import { ClientError, defaultLimits, type RequestOptions } from "./types.ts";
import type { AttachmentInput, AttachmentFrame } from "./attachment-types.ts";

/** One consumer pull grants one 64 KiB credit; the per-transfer channel owns cleanup. */
export async function* binaryAttachment(
  input: AttachmentInput & { maxBytes: number },
  channel: ArtifactChannel,
  requestId: string,
  schedule: (callback: () => void, delay: number) => () => void,
  options: RequestOptions,
): AsyncGenerator<AttachmentFrame> {
  const timeout = options.timeoutMs ?? defaultLimits.requestMs;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new ClientError("limit");
  let stream: number | undefined;
  let size = 0;
  let offset = 0;
  let failure: Error | undefined;
  let ended = false;
  let pending: ReturnType<typeof Promise.withResolvers<AttachmentFrame | undefined>> | undefined;
  let cancelDeadline: (() => void) | undefined;
  const fail = (error: Error) => {
    if (failure || ended) return;
    failure = error;
    cancelDeadline?.();
    pending?.reject(error);
    channel.close();
  };
  const abort = () => fail(new ClientError("aborted"));
  const wait = () => {
    if (failure) throw failure;
    pending = Promise.withResolvers<AttachmentFrame | undefined>();
    cancelDeadline = schedule(() => fail(new ClientError("timeout")), timeout);
    return pending.promise;
  };
  const deliver = (value: AttachmentFrame | undefined) => {
    if (!pending) throw new ClientError("protocol", "Uncredited attachment data");
    cancelDeadline?.();
    pending.resolve(value);
    pending = undefined;
  };
  try {
    if (options.signal?.aborted) throw new ClientError("aborted");
    options.signal?.addEventListener("abort", abort, { once: true });
    let next = wait();
    channel.open({
      ready() {
        void channel
          .send({
            type: "files.request",
            requestId,
            threadId: ThreadId.parse(input.threadId),
            operation: {
              op: "attachment.download",
              sha256: input.sha256,
              maxBytes: input.maxBytes,
            },
          })
          .catch((error: unknown) =>
            fail(error instanceof Error ? error : new ClientError("offline")),
          );
      },
      message(frame) {
        if (ended || failure) return;
        try {
          if (frame instanceof Uint8Array) {
            const chunk = decodePortableFileFrame(frame);
            if (
              stream === undefined ||
              chunk.channel !== stream ||
              chunk.offset !== offset ||
              !chunk.bytes.length ||
              offset + chunk.bytes.length > size
            )
              throw new ClientError("protocol");
            offset += chunk.bytes.length;
            // Own the buffer before the transport reuses it or a worker transfers it.
            deliver(chunk.bytes.slice());
            return;
          }
          const message = FilesServerMessage.parse(frame);
          if (message.type === "files.changed") return;
          if (message.type === "files.error") throw new ClientError("daemon", message.code);
          if (message.type === "files.ready") {
            if (
              stream !== undefined ||
              !Number.isInteger(message.channel) ||
              message.channel <= 0x40000000 ||
              message.channel > 0x7fffffff ||
              message.requestId !== requestId ||
              message.offset !== 0 ||
              message.size === null ||
              message.size > input.maxBytes ||
              message.validator !== input.sha256 ||
              !message.mimeType
            )
              throw new ClientError("protocol");
            stream = message.channel;
            size = message.size;
            deliver({ bytes: size, mimeType: message.mimeType });
          } else if (message.type === "files.end") {
            if (
              message.channel !== stream ||
              message.offset !== offset ||
              offset !== size ||
              message.sha256 !== input.sha256
            )
              throw new ClientError("protocol", "Incomplete attachment download");
            deliver(undefined);
            ended = true;
          } else throw new ClientError("protocol");
        } catch (error) {
          fail(error instanceof Error ? error : new ClientError("protocol"));
        }
      },
      close() {
        fail(new ClientError("offline", "Attachment channel disconnected"));
      },
    });
    for (;;) {
      const value = await next;
      if (value === undefined) return;
      yield value;
      next = wait();
      if (stream === undefined) throw new ClientError("protocol");
      void channel
        .send({ type: "files.credit", channel: stream, credits: 1 })
        .catch((error: unknown) =>
          fail(error instanceof Error ? error : new ClientError("offline")),
        );
    }
  } finally {
    cancelDeadline?.();
    options.signal?.removeEventListener("abort", abort);
    channel.close();
  }
}
