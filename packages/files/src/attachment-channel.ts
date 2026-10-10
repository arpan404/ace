import { createHash } from "node:crypto";
import { FilesClientMessage, type FilesServerMessage, type ThreadId } from "@ace/protocol";
import { encodeFileFrame } from "./frame.ts";
import { codeOf, FileError, type Download } from "./types.ts";

type Stream = {
  requestId: string;
  download: Download & { mimeType: string };
  authorized(): boolean;
  hash: ReturnType<typeof createHash>;
  offset: number;
  credits: number;
  pumping: boolean;
};
const owns = (id: number) => id > 0x40000000 && id <= 0x7fffffff;
/** Separate namespace from legacy file streams and scoped pull channels. */
export function attachmentChannel(options: {
  resolve(
    thread: ThreadId,
    hash: string,
    maxBytes: number,
  ): Promise<{
    download: Download & { mimeType: string };
    authorized(): boolean;
  }>;
  send(message: FilesServerMessage): Promise<void>;
  binary(bytes: Uint8Array): Promise<void>;
}) {
  let sequence = 0x40000000;
  let closed = false;
  const streams = new Map<number, Stream>();
  const openings = new Map<string, { cancelled: boolean }>();
  const jobs = new Set<Promise<void>>();
  const closings = new Map<number, Promise<void>>();
  const stop = async (id: number) => {
    const stream = streams.get(id);
    streams.delete(id);
    if (!stream) return closings.get(id);
    const closing = stream.download.close().finally(() => closings.delete(id));
    closings.set(id, closing);
    await closing;
  };
  const failure = async (error: unknown, fields: { requestId?: string; channel?: number }) => {
    if (!closed)
      await options.send({
        type: "files.error",
        ...fields,
        code: codeOf(error),
        message: "Attachment download failed",
      });
  };
  const assert = (id: number, stream: Stream) => {
    if (closed || streams.get(id) !== stream || !stream.authorized())
      throw new FileError("FORBIDDEN", "Attachment read permission revoked");
  };
  const pump = async (id: number, stream: Stream) => {
    if (stream.pumping) return;
    stream.pumping = true;
    try {
      while (stream.credits > 0) {
        assert(id, stream);
        stream.credits--;
        const next = await stream.download.chunks.next();
        assert(id, stream);
        if (next.done) {
          if (stream.offset !== stream.download.size)
            throw new FileError("IO_ERROR", "Truncated attachment");
          await options.send({
            type: "files.end",
            channel: id,
            offset: stream.offset,
            sha256: stream.hash.digest("hex"),
          });
          await stop(id);
          return;
        }
        if (
          !next.value.length ||
          next.value.length > 65536 ||
          stream.download.size === null ||
          stream.offset + next.value.length > stream.download.size
        )
          throw new FileError("QUOTA", "Invalid attachment chunk");
        const frame = encodeFileFrame(id, stream.offset, next.value);
        stream.hash.update(next.value);
        stream.offset += next.value.length;
        await options.binary(frame);
      }
    } catch (error) {
      if (streams.get(id) === stream) {
        await stop(id);
        await failure(error, { channel: id });
      }
    } finally {
      stream.pumping = false;
    }
  };
  const open = async (
    requestId: string,
    thread: ThreadId,
    hash: string,
    maxBytes: number,
    opening: { cancelled: boolean },
  ) => {
    let download: Stream["download"] | undefined;
    let admitted = false;
    try {
      const binding = await options.resolve(thread, hash, maxBytes);
      download = binding.download;
      if (closed || opening.cancelled || !binding.authorized())
        throw new FileError("FORBIDDEN", "Attachment opening cancelled");
      if (
        download.size === null ||
        download.size > maxBytes ||
        download.offset !== 0 ||
        download.validator !== hash
      )
        throw new FileError("QUOTA", "Attachment exceeds caller budget");
      const id = ++sequence;
      streams.set(id, {
        requestId,
        download,
        authorized: binding.authorized,
        hash: createHash("sha256"),
        offset: 0,
        credits: 0,
        pumping: false,
      });
      admitted = true;
      await options.send({
        type: "files.ready",
        requestId,
        channel: id,
        offset: 0,
        size: download.size,
        validator: download.validator,
        mimeType: download.mimeType,
      });
    } catch (error) {
      if (!admitted) await download?.close();
      else for (const [id, stream] of streams) if (stream.requestId === requestId) await stop(id);
      await failure(error, { requestId });
    } finally {
      openings.delete(requestId);
    }
  };
  return {
    accept(input: unknown): boolean {
      const parsed = FilesClientMessage.safeParse(input);
      if (!parsed.success) return false;
      const message = parsed.data;
      if (message.type === "files.request" && message.operation.op === "attachment.download") {
        if (closed) return true;
        if (
          !message.threadId ||
          streams.size + openings.size + closings.size >= 4 ||
          openings.has(message.requestId) ||
          sequence >= 0x7fffffff
        ) {
          void failure(new FileError("BUSY", "Attachment opening unavailable"), {
            requestId: message.requestId,
          }).catch(() => {});
          return true;
        }
        const opening = { cancelled: false };
        openings.set(message.requestId, opening);
        const job = open(
          message.requestId,
          message.threadId,
          message.operation.sha256,
          message.operation.maxBytes,
          opening,
        ).catch(() => {});
        jobs.add(job);
        void job.finally(() => jobs.delete(job));
        return true;
      }
      if (message.type === "files.abort") {
        const opening = openings.get(message.sourceRequestId);
        if (!opening && ![...streams.values()].some((s) => s.requestId === message.sourceRequestId))
          return false;
        if (opening) opening.cancelled = true;
        for (const [id, stream] of streams)
          if (stream.requestId === message.sourceRequestId) void stop(id).catch(() => {});
        return true;
      }
      if (!("channel" in message) || !owns(message.channel)) return false;
      if (message.type === "files.cancel") {
        void stop(message.channel).catch(() => {});
        return true;
      }
      if (message.type !== "files.credit") return true;
      const stream = streams.get(message.channel);
      if (!stream || closed) return true;
      if (message.credits !== 1 || stream.credits !== 0) {
        void stop(message.channel)
          .then(() =>
            failure(new FileError("QUOTA", "Attachment credit window exceeded"), {
              channel: message.channel,
            }),
          )
          .catch(() => {});
        return true;
      }
      stream.credits++;
      void pump(message.channel, stream).catch(() => {});
      return true;
    },
    async close() {
      closed = true;
      for (const opening of openings.values()) opening.cancelled = true;
      const settled = await Promise.allSettled([
        ...[...streams.keys()].map(stop),
        ...jobs,
        ...closings.values(),
      ]);
      const failures = settled
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, "Attachment cleanup failed");
    },
  };
}
