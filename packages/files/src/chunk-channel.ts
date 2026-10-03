import { createHash, type Hash } from "node:crypto";
import { z } from "zod";
import { FilesClientMessage, type FilesServerMessage, type ThreadId } from "@ace/protocol";
import type { FilesService } from "./service.ts";
import { codeOf, FileError, type Download } from "./types.ts";

const Upload = z.object({
  uploadId: z.string(),
  offset: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
});
type Binding = { service: FilesService; allowed(access: "read" | "operate"): boolean };
type Channel = { binding: Binding; threadId: ThreadId; busy: boolean; requestId: string } & (
  | { kind: "download"; value: Download; hash: Hash; offset: number }
  | { kind: "upload"; uploadId: string; offset: number; size: number; release(): void }
);
/** Pull/ACK frames bound memory to one 64 KiB chunk per channel, even through a shared worker. */
export function chunkFilesChannel(options: {
  device: string;
  resolve(threadId: ThreadId): Promise<Binding>;
  send(message: FilesServerMessage): void;
}) {
  const channels = new Map<number, Channel>();
  let sequence = 0x80000000;
  let pending = 0;
  let closed = false;
  const send = (message: FilesServerMessage) => {
    if (!closed) options.send(message);
  };
  const stop = async (id: number) => {
    const channel = channels.get(id);
    channels.delete(id);
    if (channel?.kind === "download") await channel.value.close();
    else if (channel) channel.release();
  };
  const assert = (binding: Binding, access: "read" | "operate") => {
    if (closed || !binding.allowed(access)) throw new FileError("FORBIDDEN", "File access denied");
  };
  const allocate = () => {
    if (channels.size >= 4 || sequence >= 0xffffffff)
      throw new FileError("BUSY", "File channel limit");
    return ++sequence;
  };
  const handle = async (message: FilesClientMessage) => {
    if (message.type === "files.abort") {
      for (const [id, channel] of channels)
        if (channel.requestId === message.sourceRequestId) await stop(id);
      return;
    }
    if (message.type === "files.cancel") {
      await stop(message.channel);
      send({ type: "files.cancelled", channel: message.channel });
      return;
    }
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
          const result = Upload.parse(
            await channel.binding.service.append(
              options.device,
              channel.uploadId,
              message.offset,
              bytes,
              () => {
                assert(channel.binding, "operate");
                if (channels.get(message.channel) !== channel)
                  throw new FileError("ABORTED", "File channel cancelled");
              },
            ),
          );
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
    if (!threadId) throw new FileError("INVALID_MESSAGE", "Thread scope required");
    const binding = await options.resolve(threadId);
    const op = message.operation;
    const access = [
      "stat",
      "download",
      "artifact.download",
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
      if (pending >= 8) {
        fail(new FileError("BUSY", "File request limit"));
        return;
      }
      pending++;
      serial = serial
        .then(() => handle(message))
        .catch(fail)
        .finally(() => {
          pending--;
        });
    },
    close() {
      closed = true;
      for (const id of channels.keys()) void stop(id).catch(() => {});
    },
  };
}
