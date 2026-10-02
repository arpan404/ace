import { createHash, type Hash } from "node:crypto";
import type { BinaryUploadDestination, FilesTransport } from "./transport.ts";
import { z } from "zod";
import { FilesClientMessage, type FilesServerMessage } from "@ace/protocol";
import { decodeFileFrame, fillFileFrame } from "./frame.ts";
import { FilesService } from "./service.ts";
import { CHUNK_SIZE, codeOf, FileError, MAX_CREDITS, type Download } from "./types.ts";

interface Outgoing {
  download: Download;
  credits: number;
  pumping: boolean;
  cancelled: boolean;
  offset: number;
  digest: Hash;
  frame: Buffer;
}
interface Incoming {
  id: string;
  offset: number;
  size: number;
  busy: boolean;
  release(): void;
  append(
    offset: number,
    bytes: Buffer,
  ): Promise<{ uploadId: string; offset: number; size: number }>;
}
const Upload = z.object({
  uploadId: z.string().min(1).max(128),
  offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/** Socket lifetime owns all active channels; durable upload state belongs to the service. */
export function attachFilesChannel(
  service: FilesService,
  transport: FilesTransport,
  device: string,
  scopedAuthorization: (capability: "files.read" | "files.write") => boolean = () => true,
) {
  const authorize = (capability: "files.read" | "files.write") => {
    if (closed) throw new FileError("CLOSED", "Socket closed");
    service.authorize(device, capability);
    if (!scopedAuthorization(capability))
      throw new FileError("FORBIDDEN", "Device scope denies this operation");
  };
  const outgoing = new Map<number, Outgoing>();
  const opening = new Set<number>();
  const incoming = new Map<number, Incoming>();
  let channel = 0;
  let closed = false;
  let pending = 0;
  const send = (message: FilesServerMessage) => {
    if (closed || !transport.isOpen) return;
    if (transport.bufferedBytes > 1024 * 1024) {
      transport.close();
      return;
    }
    void transport.sendControl(message).catch(() => transport.close());
  };
  const failure = (error: unknown, fields: { requestId?: string; channel?: number }) =>
    send({
      type: "files.error",
      ...fields,
      code: codeOf(error),
      message: error instanceof Error ? error.message : "File operation failed",
      ...(error instanceof FileError && error.current !== undefined
        ? { current: error.current }
        : {}),
    });
  const stop = async (id: number) => {
    const state = outgoing.get(id);
    if (state) {
      state.cancelled = true;
      outgoing.delete(id);
      await state.download.close();
    }
    incoming.get(id)?.release();
    incoming.delete(id);
  };
  const pump = async (id: number, state: Outgoing) => {
    if (state.pumping || state.cancelled) return;
    state.pumping = true;
    try {
      while (state.credits > 0 && !state.cancelled) {
        if (closed) break;
        authorize("files.read");
        const next = await state.download.chunks.next();
        if (state.cancelled || closed) break;
        if (next.done) {
          send({
            type: "files.end",
            channel: id,
            offset: state.offset,
            sha256: state.digest.digest("hex"),
          });
          await stop(id);
          break;
        }
        state.credits--;
        const frame = fillFileFrame(state.frame, id, state.offset, next.value);
        state.digest.update(next.value);
        state.offset += next.value.length;
        await transport.sendBinary(frame);
        // A known-size file needs no extra credit to validate and send its trailer.
        if (state.download.size !== null && state.offset === state.download.size)
          state.credits = Math.max(1, state.credits);
      }
    } catch (error) {
      if (!state.cancelled && !closed) failure(error, { channel: id });
      await stop(id);
    } finally {
      state.pumping = false;
    }
  };
  const allocate = () => {
    if (outgoing.size + incoming.size + opening.size >= 4 || channel >= 0xffffffff)
      throw new FileError("BUSY", "Socket channel limit reached");
    opening.add(++channel);
    return channel;
  };
  const control = async (input: unknown): Promise<void> => {
    const message = FilesClientMessage.parse(input);
    if (message.type === "files.cancel") {
      await stop(message.channel);
      send({ type: "files.cancelled", channel: message.channel });
      return;
    }
    if (message.type === "files.credit") {
      authorize("files.read");
      const state = outgoing.get(message.channel);
      if (!state) throw new FileError("NOT_FOUND", "Unknown download channel");
      if (state.credits + message.credits > MAX_CREDITS)
        throw new FileError("QUOTA", "Credit window exceeded");
      state.credits += message.credits;
      void pump(message.channel, state);
      return;
    }
    const operation = message.operation;
    authorize(
      [
        "stat",
        "download",
        "artifact.download",
        "archive.preview",
        "archive.download",
        "artifacts.list",
      ].includes(operation.op)
        ? "files.read"
        : "files.write",
    );
    if (["download", "artifact.download", "archive.download"].includes(operation.op)) {
      const id = allocate();
      let download: Download;
      try {
        download = await service.download(device, operation);
      } finally {
        opening.delete(id);
      }
      if (closed) {
        await download.close();
        return;
      }
      const state: Outgoing = {
        download,
        credits: 0,
        pumping: false,
        cancelled: false,
        offset: download.offset,
        digest: createHash("sha256"),
        frame: Buffer.allocUnsafe(CHUNK_SIZE + 16),
      };
      outgoing.set(id, state);
      send({
        type: "files.ready",
        requestId: message.requestId,
        channel: id,
        offset: download.offset,
        size: download.size,
        validator: download.validator,
      });
      void pump(id, state);
      return;
    }
    if (operation.op === "upload.begin" || operation.op === "upload.resume") {
      const id = allocate();
      let release: (() => void) | undefined;
      try {
        release = service.reserve();
        const upload = Upload.parse(
          await service.request(device, operation, () =>
            authorize(
              ["stat", "archive.preview", "artifacts.list"].includes(operation.op)
                ? "files.read"
                : "files.write",
            ),
          ),
        );
        if (closed) {
          release();
          return;
        }
        // Resuming a channel on this socket replaces its old binding.
        for (const [old, state] of incoming)
          if (state.id === upload.uploadId) {
            state.release();
            incoming.delete(old);
          }
        incoming.set(id, {
          id: upload.uploadId,
          offset: upload.offset,
          size: upload.size,
          busy: false,
          release,
          append: (offset, bytes) =>
            service.append(device, upload.uploadId, offset, bytes, () => authorize("files.write")),
        });
        send({ type: "files.upload", requestId: message.requestId, channel: id, ...upload });
      } catch (error) {
        release?.();
        throw error;
      } finally {
        opening.delete(id);
      }
      return;
    }
    const value = await service.request(device, operation, () =>
      authorize(
        ["stat", "archive.preview", "artifacts.list"].includes(operation.op)
          ? "files.read"
          : "files.write",
      ),
    );
    if (operation.op === "upload.commit" || operation.op === "upload.cancel")
      for (const [id, state] of incoming)
        if (state.id === operation.uploadId) {
          state.release();
          incoming.delete(id);
        }
    send({ type: "files.result", requestId: message.requestId, value });
  };
  const unsubscribe = service.subscribe((change) => {
    try {
      authorize("files.read");
      send({ type: "files.changed", change });
    } catch {
      /* revoked clients cannot receive mutation data */
    }
  });
  let stopClose: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    stopClose?.();
    for (const id of outgoing.keys()) void stop(id);
    for (const state of incoming.values()) state.release();
    incoming.clear();
  };
  stopClose = transport.onClose(close);
  if (closed) stopClose();
  return {
    close,
    bindUpload(destination: BinaryUploadDestination) {
      authorize("files.write");
      const upload = Upload.parse(destination);
      const id = allocate();
      try {
        const release = service.reserve();
        incoming.set(id, {
          id: upload.uploadId,
          offset: upload.offset,
          size: upload.size,
          busy: false,
          release,
          append: (offset, bytes) =>
            destination.append(offset, bytes, () => authorize("files.write")),
        });
        return { channel: id, ...upload };
      } finally {
        opening.delete(id);
      }
    },
    accept(input: unknown) {
      if (closed) return;
      const parsed = FilesClientMessage.safeParse(input);
      if (!parsed.success) {
        failure(new FileError("INVALID_MESSAGE", "Invalid file request"), {});
        return;
      }
      const fields =
        parsed.data.type === "files.request"
          ? { requestId: parsed.data.requestId }
          : { channel: parsed.data.channel };
      if (pending >= 16) {
        failure(new FileError("BUSY", "Socket request queue is full"), fields);
        return;
      }
      pending++;
      void control(parsed.data)
        .catch((error: unknown) => failure(error, fields))
        .finally(() => {
          pending--;
        });
    },
    binary(frame: Buffer) {
      if (closed) return;
      let id: number | undefined;
      try {
        const decoded = decodeFileFrame(frame);
        id = decoded.channel;
        authorize("files.write");
        const state = incoming.get(id);
        if (!state) throw new FileError("NOT_FOUND", "Unknown upload channel");
        if (state.busy) throw new FileError("QUOTA", "Wait for an upload acknowledgement");
        if (decoded.offset + decoded.bytes.length > state.size)
          throw new FileError("QUOTA", "Upload exceeds declared size");
        if (decoded.offset !== state.offset)
          throw new FileError("OFFSET", "Resume from acknowledged offset");
        state.busy = true;
        void state
          .append(decoded.offset, decoded.bytes)
          .then((result) => {
            const upload = Upload.parse(result);
            if (
              upload.uploadId !== state.id ||
              upload.size !== state.size ||
              upload.offset !== decoded.offset + decoded.bytes.length
            )
              throw new FileError("IO_ERROR", "Invalid destination acknowledgement");
            state.offset = upload.offset;
            send({ type: "files.upload", channel: decoded.channel, ...upload });
          })
          .catch((error: unknown) => failure(error, { channel: decoded.channel }))
          .finally(() => {
            state.busy = false;
          });
      } catch (error) {
        failure(error, id === undefined ? {} : { channel: id });
      }
    },
  };
}
