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
type Binding = {
  service: FilesService;
  release?(): void;
  allowed(access: "read" | "operate"): boolean;
};
type Channel = {
  binding: Binding;
  cancelIdle?: () => void;
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
    channel?.cancelIdle?.();
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
  const armIdle = (id: number, channel: Channel) => {
    channel.cancelIdle?.();
    channel.cancelIdle = channel.binding.service.scheduleTransferTimeout(() => {
      send({
        type: "files.error",
        channel: id,
        code: "EXPIRED",
        message: "Download paused too long; start it again",
      });
      void stop(id).then(
        () => send({ type: "files.cancelled", channel: id }),
        () => {},
      );
    });
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
      if (channel.kind === "download") armIdle(message.channel, channel);
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
