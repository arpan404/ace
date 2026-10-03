import { decodePortableFileFrame } from "./frame-portable.ts";
import { FilesServerMessage } from "@ace/protocol";
import type { ClientMessage, ServerMessage } from "@ace/protocol";

export interface ArtifactChannel {
  open(events: {
    ready(): void;
    message(frame: ServerMessage | Uint8Array): void | Promise<void>;
    close(): void;
  }): void;
  send(message: ClientMessage): Promise<void>;
  close(): void;
}

export interface ArtifactSink {
  write(bytes: Uint8Array): void | Promise<void>;
  finish(): void | Promise<void>;
  abort(): void | Promise<void>;
}
/** Downloads one registered artifact with one 64 KiB credit after each awaited sink write. */
export async function downloadArtifact(
  options: {
    requestId: string;
    artifactId: string;
    channel: ArtifactChannel;
    schedule(callback: () => void, delayMs: number): () => void;
  },
  sink: ArtifactSink,
): Promise<void> {
  const channel = options.channel;
  let stream: number | undefined;
  let offset = 0;
  let size = 0;
  let settled = false;
  let cancelDeadline: (() => void) | undefined;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cancelDeadline?.();
      channel.close();
      void Promise.resolve(sink.abort()).catch(() => {});
      reject(error);
    };
    const touch = () => {
      cancelDeadline?.();
      cancelDeadline = options.schedule(
        () => fail(new Error("Artifact download timed out")),
        60000,
      );
    };
    touch();
    channel.open({
      ready() {
        void channel
          .send({
            type: "files.request",
            requestId: options.requestId,
            operation: { op: "artifact.download", artifactId: options.artifactId, offset: 0 },
          })
          .catch((failure: unknown) =>
            fail(failure instanceof Error ? failure : new Error("Artifact download failed")),
          );
      },
      async message(frame) {
        if (settled) return;
        try {
          touch();
          if (frame instanceof Uint8Array) {
            const decoded = decodePortableFileFrame(frame);
            if (decoded.channel !== stream || decoded.offset !== offset)
              throw new Error("Invalid artifact chunk");
            const chunk = decoded.bytes;
            if (offset + chunk.length > size) throw new Error("Artifact exceeds announced size");
            await sink.write(chunk);
            if (settled) return;
            offset += chunk.length;
            if (stream !== undefined)
              await channel.send({ type: "files.credit", channel: stream, credits: 1 });
            return;
          }
          const message = FilesServerMessage.parse(frame);
          if (message.type === "files.error") throw new Error(message.message);
          if (message.type === "files.ready") {
            if (
              stream !== undefined ||
              message.requestId !== options.requestId ||
              message.offset !== 0 ||
              message.size == null ||
              message.size > 50 * 1024 * 1024
            )
              throw new Error("Invalid artifact download response");
            stream = message.channel;
            size = message.size;
            await channel.send({ type: "files.credit", channel: stream, credits: 1 });
          } else if (message.type === "files.end") {
            if (message.channel !== stream || message.offset !== offset || offset !== size)
              throw new Error("Incomplete artifact download");
            await sink.finish();
            if (settled) return;
            settled = true;
            cancelDeadline?.();
            channel.close();
            resolve();
          } else throw new Error("Unexpected artifact response");
        } catch (failure) {
          fail(failure instanceof Error ? failure : new Error("Invalid artifact download"));
        }
      },
      close() {
        fail(new Error("Artifact channel disconnected"));
      },
    });
  });
}
