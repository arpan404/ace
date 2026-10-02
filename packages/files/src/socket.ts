import { createHash, type Hash } from "node:crypto";
import { WebSocket } from "ws";
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
  busy: boolean;
  release(): void;
}
const Upload = z.object({ uploadId: z.string(), offset: z.number(), size: z.number() });

/** Socket lifetime owns all active channels; durable upload state belongs to the service. */
export function attachFilesSocket(
  service: FilesService,
  socket: WebSocket,
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
    if (closed || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) {
      socket.terminate();
      return;
    }
    socket.send(JSON.stringify(message));
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
        await new Promise<void>((resolve, reject) => {
          if (socket.readyState !== WebSocket.OPEN) {
            reject(new FileError("CLOSED", "Socket closed"));
            return;
          }
          socket.send(frame, { binary: true }, (error) => (error ? reject(error) : resolve()));
        });
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
        incoming.set(id, { id: upload.uploadId, busy: false, release });
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
  const close = () => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const id of outgoing.keys()) void stop(id);
    for (const state of incoming.values()) state.release();
    incoming.clear();
  };
  socket.once("close", close);
  return {
    close,
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
        state.busy = true;
        void service
          .append(device, state.id, decoded.offset, decoded.bytes, () => authorize("files.write"))
          .then((upload) => send({ type: "files.upload", channel: decoded.channel, ...upload }))
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
