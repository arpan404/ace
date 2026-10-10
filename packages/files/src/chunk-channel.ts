import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import {
  FilesClientMessage,
  type FilesServerMessage,
  type FileOperation,
  type ThreadId,
} from "@ace/protocol";
import type { FilesService } from "./service.ts";
import { codeOf, FileError, type Download } from "./types.ts";
import { drainUpload } from "./upload-lifetime.ts";

const Upload = z.object({
  uploadId: z.string(),
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});
type Binding = { service: FilesService; allowed(access: "read" | "operate"): boolean };
type Channel = {
  binding: Binding;
  threadId: ThreadId | undefined;
  busy: boolean;
  requestId: string;
} & (
  | { kind: "download"; value: Download; hash: Hash; offset: number }
  | {
      kind: "upload";
      uploadId: string;
      offset: number;
      size: number;
      pending?: Promise<unknown>;
      release(): void;
    }
);
/** Pull/ACK frames bound memory to one 64 KiB chunk per channel, even through a shared worker. */
export function chunkFilesChannel(options: {
  device: string;
  resolve(
    threadId: ThreadId | undefined,
    scope?: "support",
    operation?: FileOperation,
  ): Promise<Binding>;
  send(message: FilesServerMessage): void;
}) {
  const channels = new Map<number, Channel>();
  const closing = new Map<number, Promise<void>>();
  let sequence = 0x80000000;
  let pending = 0;
  const openings = new Map<string, { cancelled: boolean }>();
  let closed = false;
  const send = (message: FilesServerMessage) => {
    if (!closed) options.send(message);
  };
  const stop = (id: number): Promise<void> => {
    const existing = closing.get(id);
    if (existing) return existing;
    const channel = channels.get(id);
    channels.delete(id);
    if (!channel) return Promise.resolve();
    const stopped = Promise.resolve()
      .then(async () => {
        if (channel.kind === "download") await channel.value.close();
        else await drainUpload(channel);
      })
      .finally(() => {
        closing.delete(id);
      });
    closing.set(id, stopped);
    return stopped;
  };
  const assert = (binding: Binding, access: "read" | "operate") => {
    if (closed || !binding.allowed(access)) throw new FileError("FORBIDDEN", "File access denied");
  };
  const allocate = () => {
    if (channels.size + closing.size >= 4 || sequence >= 0xffffffff)
      throw new FileError("BUSY", "File channel limit");
    return ++sequence;
  };
  const handle = async (
    message: Exclude<FilesClientMessage, { type: "files.abort" | "files.cancel" }>,
    opening?: { cancelled: boolean },
  ) => {
    const assertOpening = () => {
      if (closed || opening?.cancelled) throw new FileError("ABORTED", "File opening cancelled");
    };
    assertOpening();
    if (message.type === "files.credit")
      throw new FileError("INVALID_MESSAGE", "Use files.pull for chunk channels");
    if (message.type === "files.pull" || message.type === "files.chunk") {
      const channel = channels.get(message.channel);
      if (!channel) throw new FileError("NOT_FOUND", "File channel unavailable");
      assert(channel.binding, message.type === "files.pull" ? "read" : "operate");
      if (channel.busy) throw new FileError("BUSY", "Wait for the previous chunk");
      channel.busy = true;
      try {
        if (message.type === "files.pull") {
          if (channel.kind !== "download") throw new FileError("INVALID_MESSAGE", "Not a download");
          const next = await channel.value.chunks.next();
          assert(channel.binding, "read");
          if (channels.get(message.channel) !== channel)
            throw new FileError("ABORTED", "File channel cancelled");
          const offset = channel.offset;
          if (next.done) {
            const sha256 = channel.hash.digest("hex");
            await stop(message.channel);
            send({
              type: "files.data",
              requestId: message.requestId,
              channel: message.channel,
              offset,
              data: "",
              eof: true,
              sha256,
            });
          } else {
            if (next.value.length > 65536) throw new FileError("QUOTA", "Chunk too large");
            channel.hash.update(next.value);
            channel.offset += next.value.length;
            send({
              type: "files.data",
              requestId: message.requestId,
              channel: message.channel,
              offset,
              data: next.value.toString("base64"),
              eof: false,
            });
          }
        } else {
          if (channel.kind !== "upload") throw new FileError("INVALID_MESSAGE", "Not an upload");
          const bytes = Buffer.from(message.data, "base64");
          if (
            !bytes.length ||
            bytes.length > 65536 ||
            bytes.toString("base64") !== message.data ||
            message.offset !== channel.offset
          )
            throw new FileError("OFFSET", "Invalid upload chunk or offset");
          channel.pending = channel.binding.service.append(
            options.device,
            channel.uploadId,
            message.offset,
            bytes,
            () => {
              assert(channel.binding, "operate");
              if (channels.get(message.channel) !== channel)
                throw new FileError("ABORTED", "File channel cancelled");
            },
          );
          const result = Upload.parse(await channel.pending);
          assert(channel.binding, "operate");
          if (channels.get(message.channel) !== channel)
            throw new FileError("ABORTED", "File channel cancelled");
          channel.offset = result.offset;
          send({
            type: "files.upload",
            requestId: message.requestId,
            channel: message.channel,
            ...result,
          });
        }
      } finally {
        channel.busy = false;
      }
      return;
    }
    const threadId = message.threadId;
    if (!threadId && message.scope !== "support")
      throw new FileError("INVALID_MESSAGE", "Thread scope required");
    const binding = await options.resolve(threadId, message.scope, message.operation);
    assertOpening();
    const op = message.operation;
    const access = [
      "list",
      "stat",
      "download",
      "artifact.download",
      "artifact.support",
      "archive.download",
      "archive.preview",
      "artifacts.list",
      "trash.list",
    ].includes(op.op)
      ? "read"
      : "operate";
    assert(binding, access);
    if (op.op === "download" || op.op === "artifact.download" || op.op === "archive.download") {
      const id = allocate();
      const download = await binding.service.downloadForTransport(options.device, op);
      try {
        assert(binding, "read");
        assertOpening();
      } catch (error) {
        await download.close();
        throw error;
      }
      channels.set(id, {
        binding,
        requestId: message.requestId,
        threadId,
        busy: false,
        kind: "download",
        value: download,
        hash: createHash("sha256"),
        offset: download.offset,
      });
      send({
        type: "files.ready",
        requestId: message.requestId,
        channel: id,
        offset: download.offset,
        size: download.size,
        validator: download.validator,
      });
      return;
    }
    if (op.op === "upload.begin" || op.op === "upload.resume") {
      const id = allocate();
      const release = binding.service.reserve();
      try {
        const upload = Upload.parse(
          await binding.service.request(options.device, op, () => assert(binding, "operate")),
        );
        assert(binding, "operate");
        assertOpening();
        for (const [old, channel] of channels)
          if (
            channel.kind === "upload" &&
            channel.uploadId === upload.uploadId &&
            channel.binding.service === binding.service
          )
            await stop(old);
        channels.set(id, {
          binding,
          threadId,
          requestId: message.requestId,
          busy: false,
          kind: "upload",
          ...upload,
          release,
        });
        send({ type: "files.upload", requestId: message.requestId, channel: id, ...upload });
      } catch (error) {
        release();
        throw error;
      }
      return;
    }
    if (op.op === "upload.commit" || op.op === "upload.cancel") {
      for (const channel of channels.values())
        if (
          channel.kind === "upload" &&
          channel.uploadId === op.uploadId &&
          channel.binding.service === binding.service &&
          channel.busy
        )
          throw new FileError("BUSY", "Wait for upload acknowledgement");
    }
    const value = await binding.service.request(options.device, op, () => assert(binding, access));
    assert(binding, access);
    if (op.op === "upload.commit" || op.op === "upload.cancel")
      for (const [id, channel] of channels)
        if (
          channel.kind === "upload" &&
          channel.uploadId === op.uploadId &&
          channel.binding.service === binding.service
        )
          await stop(id);
    send({ type: "files.result", requestId: message.requestId, value });
  };
  // Serialize control requests. Binary chunks still flow one at a time and never buffer a file.
  let serial = Promise.resolve();
  return {
    accept(input: unknown) {
      const parsed = FilesClientMessage.safeParse(input);
      if (!parsed.success || closed) return;
      const message = parsed.data;
      const fail = (error: unknown) =>
        send({
          type: "files.error",
          ...("requestId" in message ? { requestId: message.requestId } : {}),
          ...("channel" in message ? { channel: message.channel } : {}),
          code: codeOf(error),
          message: "File operation failed",
        });
      // Cleanup is bounded by the admitted openings/channels, not the normal control queue.
      // Invalidate synchronously so an in-flight resolve cannot subsequently publish a channel.
      if (message.type === "files.abort") {
        const opening = openings.get(message.sourceRequestId);
        if (opening) opening.cancelled = true;
        for (const [id, channel] of channels)
          if (channel.requestId === message.sourceRequestId) void stop(id).catch(fail);
        return;
      }
      if (message.type === "files.cancel") {
        if (closing.has(message.channel)) return;
        if (!channels.has(message.channel)) {
          send({ type: "files.cancelled", channel: message.channel });
          return;
        }
        void stop(message.channel)
          .then(() => send({ type: "files.cancelled", channel: message.channel }))
          .catch(fail);
        return;
      }
      if (pending >= 8) {
        fail(new FileError("BUSY", "File request limit"));
        return;
      }
      const opening =
        message.type === "files.request" &&
        [
          "download",
          "artifact.download",
          "archive.download",
          "upload.begin",
          "upload.resume",
        ].includes(message.operation.op)
          ? { cancelled: false }
          : undefined;
      if (opening && "requestId" in message) {
        if (openings.has(message.requestId)) {
          fail(new FileError("BUSY", "Duplicate opening"));
          return;
        }
        openings.set(message.requestId, opening);
      }
      pending++;
      serial = serial
        .then(() => handle(message, opening))
        .catch(fail)
        .finally(() => {
          pending--;
          if (opening && "requestId" in message) openings.delete(message.requestId);
        });
    },
    close() {
      closed = true;
      for (const opening of openings.values()) opening.cancelled = true;
      for (const id of channels.keys()) void stop(id).catch(() => {});
    },
  };
}
