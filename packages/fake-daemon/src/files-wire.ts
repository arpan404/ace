import { fakeMediaBytes } from "./catalog/forge-media.ts";
import {
  type FileOperation,
  type ReviewComment,
  FilesClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "@ace/protocol";
import type { FakeServiceContext } from "./service-context.ts";
import { FakeCheckout, type CheckoutFile } from "./fake-checkout.ts";
import { UploadReceipts } from "./upload-receipts.ts";

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
const linkedKey = (threadId: string, itemId: string, reference: string) =>
  `linked:${threadId}:${itemId}:${reference}`;

export class FakeFilesWire {
  registerArtifact(threadId: string, artifactId: string, bytes: Uint8Array) {
    if (bytes.length > 16 * 1024 * 1024) throw new Error("Artifact fixture too large");
    this.files.set(this.key(threadId, `artifacts/${artifactId}`), { bytes, version: artifactId });
  }
  private checkout: FakeCheckout;
  private files: Map<string, File>;
  private uploads = new Map<string, Upload>();
  private receipts: UploadReceipts;
  private sequence = 0;
  private host: FakeServiceContext;
  private registered: (workspaceId: string) => boolean;
  /** `registered` says whether a project is still in the catalog, for project-scoped reads. */
  constructor(
    host: FakeServiceContext,
    registered: (workspaceId: string) => boolean = () => false,
  ) {
    this.host = host;
    this.registered = registered;
    this.checkout = new FakeCheckout(host);
    this.receipts = new UploadReceipts(() => host.now());
    this.files = this.checkout.files;
  }
  /** Put a text file (and its folders) in a thread's checkout, as a scenario's agent would. */
  seed(threadId: string, path: string, text: string): void {
    const parts = path.split("/");
    for (let depth = 1; depth < parts.length; depth++) {
      const folder = parts.slice(0, depth).join("/");
      if (!this.files.has(this.key(threadId, folder)))
        this.checkout.apply(threadId, { op: "mkdir", path: folder, expected: null });
    }
    this.checkout.apply(threadId, { op: "create", path, expected: null, text });
  }
  /**
   * Put a file of raw bytes (and its folders) in a thread's checkout: images, or noise that
   * doesn't compress, so a folder's archive comes out as big as its files.
   */
  seedBytes(threadId: string, path: string, bytes: Uint8Array): void {
    this.seed(threadId, path, "");
    const key = this.key(threadId, path);
    const file = this.files.get(key);
    if (file) this.files.set(key, { ...file, bytes, version: `seed-${++this.sequence}` });
  }
  /**
   * A file outside the checkout that one assistant message links to, served by `link.download`
   * only for that message and that exact link target, as the daemon does.
   */
  seedLinked(threadId: string, itemId: string, reference: string, text: string): void {
    this.files.set(linkedKey(threadId, itemId, reference), {
      bytes: new TextEncoder().encode(text),
      version: `linked-${++this.sequence}`,
    });
  }
  /** Put a text file (and its folders) in a project's own folder, which New thread browses. */
  seedProject(workspaceId: string, path: string, text: string): void {
    this.checkout.seedProject(workspaceId, path, text);
  }
  paths(threadId: string): string[] {
    return this.checkout.paths(threadId);
  }
  projectPaths(workspaceId: string): string[] {
    return this.checkout.projectPaths(workspaceId);
  }
  private key(threadId: string, path: string): string {
    return this.checkout.key(threadId, path);
  }
  private file(_threadId: string, _path: string, key: string): File | undefined {
    return this.files.get(key);
  }
  reviewTarget(threadId: string): { workspaceId: string; worktree: string } | undefined {
    const thread = this.host.thread(threadId)?.thread;
    if (
      !thread ||
      thread.deletedAt !== undefined ||
      thread.details?.workspaceChange?.state === "preparing" ||
      thread.details?.workspaceChange?.uncertain
    )
      return undefined;
    return {
      workspaceId: thread.workspaceId,
      worktree: thread.details?.worktree ?? `/fake/${thread.workspaceId}`,
    };
  }
  /** Lines `start`..`end` of a checkout file; undefined when the fake holds no text for it. */
  reviewLines(threadId: string, path: string, start: number, end: number): string[] | undefined {
    const file = this.file(threadId, path, this.key(threadId, path));
    if (!file || file.bytes.length > 1024 * 1024) return undefined;
    if (end < start) return [];
    // A final newline ends the last line; it does not start another.
    return new TextDecoder()
      .decode(file.bytes)
      .replace(/\n$/, "")
      .split("\n")
      .slice(start - 1, end);
  }
  applyReviewSuggestion(threadId: string, comment: ReviewComment): boolean {
    const p = comment.anchor.position;
    const key = this.key(threadId, p.file);
    const file = this.file(threadId, p.file, key);
    if (!file || file.bytes.length > 1024 * 1024 || comment.suggestion === undefined) return false;
    const text = new TextDecoder().decode(file.bytes);
    const lines = text.replace(/\n$/, "").split("\n");
    if (
      JSON.stringify(lines.slice(p.start - 1, p.end)) !==
      JSON.stringify(comment.anchor.fingerprint.lines)
    )
      return false;
    const replacement =
      comment.suggestion === "" ? [] : comment.suggestion.replace(/\n$/, "").split("\n");
    lines.splice(p.start - 1, p.end - p.start + 1, ...replacement);
    const bytes = new TextEncoder().encode(
      lines.join("\n") + (text.endsWith("\n") || comment.suggestion.endsWith("\n") ? "\n" : ""),
    );
    const total =
      [...this.files.values()].reduce((sum, value) => sum + value.bytes.length, 0) +
      [...this.uploads.values()].reduce((sum, value) => sum + value.size, 0);
    if (total - file.bytes.length + bytes.length > 16 * 1024 * 1024) return false;
    this.files.set(key, { bytes, version: `file-${++this.sequence}` });
    return true;
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
    /** Stat or open a download of one file, by its key in the fixture's checkouts. */
    const read = (
      op: Extract<
        FileOperation,
        { op: "download" | "link.download" | "stat" | "artifact.download" }
      >,
      threadId: string,
      key: string,
      requestId: string,
    ) => {
      const file = this.files.get(key);
      if (!file && op.op === "stat") {
        // As the daemon: an absent path is a result with no version, not an error.
        emit({
          type: "files.result",
          requestId,
          value: { path: op.path, version: null },
        });
        return;
      }
      if (!file) throw new Error("NOT_FOUND");
      if (op.op === "stat") {
        emit({
          type: "files.result",
          requestId,
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
        requestId,
        file,
        offset: op.offset,
      });
      emit({
        type: "files.ready",
        requestId,
        channel,
        offset: op.offset,
        size: file.bytes.length,
        validator: file.version,
      });
      return;
    };
    /** A `read`: the file's details and one part of its bytes, never compressed. */
    const readPart = (
      op: Extract<FileOperation, { op: "read" }>,
      key: string,
      requestId: string,
    ) => {
      const file = this.files.get(key);
      const reply = (value: unknown) => emit({ type: "files.result", requestId, value });
      if (!file) return reply({ path: op.path, version: null });
      if (file.folder) return reply({ path: op.path, version: file.version, type: "directory" });
      if (op.validator !== undefined && op.validator !== file.version) throw new Error("CONFLICT");
      const size = file.bytes.length;
      const base = { path: op.path, version: file.version, type: "file", size };
      if (op.maxSize !== undefined && size > op.maxSize) return reply(base);
      if (op.offset > size) throw new Error("CONFLICT");
      const bytes = file.bytes.subarray(op.offset, op.offset + op.length);
      return reply({ ...base, offset: op.offset, encoding: "identity", data: encode(bytes) });
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
            if (channel.threadId && this.key(channel.threadId, path) !== channel.key)
              throw new Error("FORBIDDEN");
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
          if (message.scope === "support" && op.op === "artifact.support") {
            const artifactId = `support-${++this.sequence}`;
            const bytes = new TextEncoder().encode(
              op.includeThreads
                ? "Redacted support fixture with conversations"
                : "Redacted support fixture without conversations",
            );
            this.files.set(artifactId, { bytes, version: artifactId });
            emit({ type: "files.result", requestId: message.requestId, value: { artifactId } });
            return;
          }
          if (message.scope === "support" && op.op === "artifact.download") {
            const file = this.files.get(op.artifactId);
            if (!file) throw new Error("NOT_FOUND");
            const channel = allocate();
            channels.set(channel, {
              kind: "read",
              key: op.artifactId,
              threadId: "",
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
          if (message.workspaceId !== undefined) {
            // As the daemon: a project's own folder is read-only and needs a registered project.
            const workspaceId = message.workspaceId;
            if (message.threadId || message.scope) throw new Error("INVALID_MESSAGE");
            if (op.op === "forge.media.download") {
              // As the daemon: media fetched for forge text, read by hash.
              const bytes = fakeMediaBytes(op.sha256);
              if (!bytes || !this.registered(workspaceId)) throw new Error("NOT_FOUND");
              const key = `forge-media:${op.sha256}`;
              if (!this.files.has(key)) this.files.set(key, { bytes, version: op.sha256 });
              read(
                { op: "download", path: op.sha256, offset: op.offset },
                "",
                key,
                message.requestId,
              );
              return;
            }
            if (op.op !== "list" && op.op !== "stat" && op.op !== "read" && op.op !== "download")
              throw new Error("FORBIDDEN");
            if (!this.registered(workspaceId)) throw new Error("NOT_FOUND");
            if (op.op === "list") {
              const value = this.checkout.list(this.checkout.projectKey(workspaceId, ""), op);
              emit({ type: "files.result", requestId: message.requestId, value });
              return;
            }
            const key = this.checkout.projectKey(workspaceId, op.path);
            if (op.op === "read") readPart(op, key, message.requestId);
            else read(op, "", key, message.requestId);
            return;
          }
          if (!message.threadId) throw new Error("INVALID_MESSAGE");
          const threadId = message.threadId;
          if (op.op === "link.download") {
            // Not a checkout path, so pulls skip the checkout re-check (as support reads do).
            read(op, "", linkedKey(threadId, op.itemId, op.reference), message.requestId);
            return;
          }
          if (op.op === "read") {
            readPart(op, this.key(threadId, op.path), message.requestId);
            return;
          }
          if (op.op === "download" || op.op === "stat" || op.op === "artifact.download") {
            const path = op.op === "artifact.download" ? `artifacts/${op.artifactId}` : op.path;
            read(op, threadId, this.key(threadId, path), message.requestId);
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
                this.checkout.retainedBytes() +
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
              const receipt = this.receipts.get(uploadId);
              if (receipt) {
                if (receipt.device !== device || receipt.threadId !== threadId)
                  throw new Error("FORBIDDEN");
                // As the daemon: already published; committing again returns its result.
                throw new Error("COMMITTED");
              }
              const existing = this.uploads.get(uploadId);
              if (!existing) throw new Error("NOT_FOUND");
              if (existing.device !== device || existing.threadId !== threadId)
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
            const receipt = op.op === "upload.commit" ? this.receipts.get(op.uploadId) : undefined;
            if (receipt) {
              if (receipt.device !== device || receipt.threadId !== threadId)
                throw new Error("FORBIDDEN");
              if (receipt.sha256 !== op.sha256) throw new Error("HASH_MISMATCH");
              emit({ type: "files.result", requestId: message.requestId, value: receipt.value });
              return;
            }
            const upload = this.uploads.get(op.uploadId);
            if (!upload) throw new Error("NOT_FOUND");
            if (upload.device !== device || upload.threadId !== threadId)
              throw new Error("FORBIDDEN");
            const path = upload.key.slice(upload.key.indexOf("\0") + 1);
            if (this.key(threadId, path) !== upload.key) throw new Error("FORBIDDEN");
            let value: unknown = { ok: true };
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
              const version = `file-${++this.sequence}`;
              this.files.set(upload.key, { bytes, version });
              value = { ok: true, path, version };
              this.receipts.add(op.uploadId, { device, threadId, sha256: op.sha256, value });
            }
            this.uploads.delete(op.uploadId);
            for (const [id, channel] of channels)
              if (channel.kind === "write" && channel.uploadId === op.uploadId) channels.delete(id);
            emit({ type: "files.result", requestId: message.requestId, value });
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
          if (op.op === "create" || op.op === "write") {
            const key = this.key(threadId, op.path);
            const reserved =
              this.checkout.retainedBytes() +
              [...this.uploads.values()].reduce((size, upload) => size + upload.size, 0);
            if (
              reserved +
                new TextEncoder().encode(op.text).length -
                (this.files.get(key)?.bytes.length ?? 0) >
              16 * 1024 * 1024
            )
              throw new Error("QUOTA");
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
