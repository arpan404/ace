import { FilesClientMessage, type ClientMessage, type ServerMessage } from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
import { FakeCheckout, type CheckoutFile } from "./fake-checkout.ts";

type File = CheckoutFile;
type Upload = {
  key: string;
  device: string;
  threadId: string;
  expected: string | null;
  size: number;
  offset: number;
  chunks: Uint8Array[];
};
type Channel = { threadId: string; key: string; requestId: string } & (
  | { kind: "read"; file: File; offset: number }
  | { kind: "write"; uploadId: string }
);
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
const decode = (data: string) => Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
/** Fixture storage is capped at 16 MiB including in-progress uploads. Wire frames remain 64 KiB. */
export class FakeFilesWire {
  private checkout: FakeCheckout;
  private files: Map<string, File>;
  private uploads = new Map<string, Upload>();
  private sequence = 0;
  private host: FakeServiceContext;
  constructor(host: FakeServiceContext) {
    this.host = host;
    this.checkout = new FakeCheckout(host);
    this.files = this.checkout.files;
  }
  paths(threadId: string): string[] {
    return this.checkout.paths(threadId);
  }
  private key(threadId: string, path: string): string {
    return this.checkout.key(threadId, path);
  }
  private file(_threadId: string, _path: string, key: string): File | undefined {
    return this.files.get(key);
  }
  session(send: (message: ServerMessage) => void) {
    const channels = new Map<number, Channel>();
    let sequence = 0x80000000;
    let closed = false;
    const emit = (message: ServerMessage) => {
      if (!closed) send(message);
    };
    const allocate = () => {
      if (channels.size >= 4) throw new Error("BUSY");
      return ++sequence;
    };
    return {
      close() {
        closed = true;
        channels.clear();
      },
      handle: async (input: ClientMessage, device: string) => {
        const message = FilesClientMessage.parse(input);
        try {
          if (message.type === "files.abort") {
            for (const [id, channel] of channels)
              if (channel.requestId === message.sourceRequestId) channels.delete(id);
            return;
          }
          if (message.type === "files.cancel") {
            channels.delete(message.channel);
            emit({ type: "files.cancelled", channel: message.channel });
            return;
          }
          if (message.type === "files.credit") throw new Error("INVALID_MESSAGE");
          if (message.type === "files.pull" || message.type === "files.chunk") {
            const channel = channels.get(message.channel);
            if (!channel) throw new Error("NOT_FOUND");
            const path = channel.key.slice(channel.key.indexOf("\0") + 1);
            if (this.key(channel.threadId, path) !== channel.key) throw new Error("FORBIDDEN");
            if (message.type === "files.pull") {
              if (channel.kind !== "read") throw new Error("INVALID_MESSAGE");
              const offset = channel.offset;
              const bytes = channel.file.bytes.slice(offset, offset + 65536);
              channel.offset += bytes.length;
              const eof = !bytes.length;
              if (eof) channels.delete(message.channel);
              emit({
                type: "files.data",
                requestId: message.requestId,
                channel: message.channel,
                offset,
                data: encode(bytes),
                eof,
                ...(eof ? { sha256: await hash(channel.file.bytes) } : {}),
              });
            } else {
              if (channel.kind !== "write") throw new Error("INVALID_MESSAGE");
              const upload = this.uploads.get(channel.uploadId);
              if (!upload || upload.device !== device) throw new Error("FORBIDDEN");
              const bytes = decode(message.data);
              if (
                message.offset !== upload.offset ||
                !bytes.length ||
                bytes.length > 65536 ||
                encode(bytes) !== message.data ||
                upload.offset + bytes.length > upload.size
              )
                throw new Error("OFFSET");
              upload.chunks.push(bytes);
              upload.offset += bytes.length;
              emit({
                type: "files.upload",
                requestId: message.requestId,
                channel: message.channel,
                uploadId: channel.uploadId,
                offset: upload.offset,
                size: upload.size,
              });
            }
            return;
          }
          const op = message.operation;
          if (!message.threadId) throw new Error("INVALID_MESSAGE");
          const threadId = message.threadId;
          if (op.op === "download" || op.op === "stat") {
            const key = this.key(threadId, op.path);
            const file = this.file(threadId, op.path, key);
            if (!file && op.op === "stat") {
              // As the daemon: an absent path is a result with no version, not an error.
              emit({
                type: "files.result",
                requestId: message.requestId,
                value: { path: op.path, version: null },
              });
              return;
            }
            if (!file) throw new Error("NOT_FOUND");
            if (op.op === "stat") {
              emit({
                type: "files.result",
                requestId: message.requestId,
                value: {
                  path: op.path,
                  size: file.bytes.length,
                  version: file.version,
                  type: file.folder ? "directory" : "file",
                },
              });
              return;
            }
            if (file.folder) throw new Error("INVALID_PATH");
            if (
              (op.offset > 0 && !op.validator) ||
              (op.validator && op.validator !== file.version) ||
              op.offset > file.bytes.length
            )
              throw new Error("CONFLICT");
            const channel = allocate();
            channels.set(channel, {
              kind: "read",
              key,
              threadId,
              requestId: message.requestId,
              file,
              offset: op.offset,
            });
            emit({
              type: "files.ready",
              requestId: message.requestId,
              channel,
              offset: op.offset,
              size: file.bytes.length,
              validator: file.version,
            });
            return;
          }
          if (op.op === "upload.begin" || op.op === "upload.resume") {
            const channel = allocate();
            let uploadId: string;
            let upload: Upload;
            if (op.op === "upload.begin") {
              const key = this.key(threadId, op.path);
              if ((this.file(threadId, op.path, key)?.version ?? null) !== op.expected)
                throw new Error("CONFLICT");
              const total =
                [...this.files.values()].reduce((n, value) => n + value.bytes.length, 0) +
                [...this.uploads.values()].reduce((n, value) => n + value.size, 0);
              if (this.uploads.size >= 64 || total + op.size > 16 * 1024 * 1024)
                throw new Error("QUOTA");
              uploadId = `upload-${++this.sequence}`;
              upload = {
                key,
                device,
                threadId,
                expected: op.expected,
                size: op.size,
                offset: 0,
                chunks: [],
              };
              this.uploads.set(uploadId, upload);
            } else {
              uploadId = op.uploadId;
              const existing = this.uploads.get(uploadId);
              if (!existing || existing.device !== device || existing.threadId !== threadId)
                throw new Error("FORBIDDEN");
              upload = existing;
            }
            channels.set(channel, {
              kind: "write",
              key: upload.key,
              threadId,
              requestId: message.requestId,
              uploadId,
            });
            emit({
              type: "files.upload",
              requestId: message.requestId,
              channel,
              uploadId,
              offset: upload.offset,
              size: upload.size,
            });
            return;
          }
          if (op.op === "upload.commit" || op.op === "upload.cancel") {
            const upload = this.uploads.get(op.uploadId);
            if (!upload || upload.device !== device || upload.threadId !== threadId)
              throw new Error("FORBIDDEN");
            const path = upload.key.slice(upload.key.indexOf("\0") + 1);
            if (this.key(threadId, path) !== upload.key) throw new Error("FORBIDDEN");
            if (op.op === "upload.commit") {
              if (upload.offset !== upload.size) throw new Error("OFFSET");
              const bytes = new Uint8Array(upload.size);
              let offset = 0;
              for (const chunk of upload.chunks) {
                bytes.set(chunk, offset);
                offset += chunk.length;
              }
              if ((await hash(bytes)) !== op.sha256) throw new Error("HASH_MISMATCH");
              if ((this.files.get(upload.key)?.version ?? null) !== upload.expected)
                throw new Error("CONFLICT");
              this.files.set(upload.key, { bytes, version: `file-${++this.sequence}` });
            }
            this.uploads.delete(op.uploadId);
            for (const [id, channel] of channels)
              if (channel.kind === "write" && channel.uploadId === op.uploadId) channels.delete(id);
            emit({ type: "files.result", requestId: message.requestId, value: { ok: true } });
            return;
          }
          if (op.op === "archive.download") {
            const preview = this.checkout.previews.get(op.previewId);
            if (!preview || preview.root !== this.key(threadId, "")) throw new Error("NOT_FOUND");
            const contents = preview.paths.map((path, index) => {
              const file = this.files.get(preview.root + path);
              if (!file || file.version !== preview.versions[index]) throw new Error("CONFLICT");
              return { path, bytes: file.bytes, folder: file.folder === true };
            });
            const { fixtureArchive } = await import("./fixture-archive.ts");
            const bytes = await fixtureArchive(contents);
            const channel = allocate();
            channels.set(channel, {
              kind: "read",
              threadId,
              key: preview.root,
              requestId: message.requestId,
              file: { bytes, version: op.previewId },
              offset: 0,
            });
            emit({
              type: "files.ready",
              requestId: message.requestId,
              channel,
              offset: 0,
              size: bytes.length,
              validator: op.previewId,
            });
            return;
          }
          const value = this.checkout.apply(threadId, op);
          emit({ type: "files.result", requestId: message.requestId, value });
        } catch (error) {
          emit({
            type: "files.error",
            ...("requestId" in message ? { requestId: message.requestId } : {}),
            code: error instanceof Error ? error.message : "IO_ERROR",
            message: "File operation failed",
          });
        }
      },
    };
  }
}
