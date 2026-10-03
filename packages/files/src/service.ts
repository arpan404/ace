import { createExclusiveRename, type ExclusiveRename } from "./exclusive-rename.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SafeRoot } from "@ace/workspace";
import { FileOperation, type WorkspaceFileChange } from "@ace/protocol";
import { ArtifactRecord, Catalog, TrashRecord, UploadRecord } from "./catalog.ts";
import { archiveDownload, previewArchive, type Preview } from "./archive.ts";
import { openDownload, openBorrowedDownload } from "./download.ts";
import { newId, observed } from "./filesystem.ts";
import { Mutations } from "./mutations.ts";
import { Uploads } from "./uploads.ts";
import { FileError, type FilesOptions, type Download } from "./types.ts";

export class FilesService {
  private readonly safe: SafeRoot;
  private readonly options: FilesOptions;
  private readonly catalog: Catalog;
  private readonly mutations: Mutations;
  private readonly exclusive: ExclusiveRename;
  private readonly uploads: Uploads;
  private readonly roots: Map<string, SafeRoot>;
  private readonly previews = new Map<string, Preview>();
  private readonly listeners = new Set<(change: WorkspaceFileChange) => void>();
  private artifactBytes = 0;
  private active = 0;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(safe: SafeRoot, options: FilesOptions, roots: Map<string, SafeRoot>) {
    this.safe = safe;
    this.options = options;
    this.roots = roots;
    this.catalog = new Catalog(join(options.dataDir, "files.sqlite"));
    this.exclusive = options.exclusiveRename ?? createExclusiveRename();
    this.mutations = new Mutations(safe, this.catalog, options, this.exclusive);
    this.uploads = new Uploads(safe, this.catalog, options, this.exclusive);
  }
  static async create(options: FilesOptions): Promise<FilesService> {
    await mkdir(join(options.dataDir, "trash"), { recursive: true, mode: 0o700 });
    const roots = new Map<string, SafeRoot>();
    for (const root of options.artifactRoots ?? []) {
      const safe = await SafeRoot.create(root);
      roots.set(safe.root, safe);
    }
    return new FilesService(await SafeRoot.create(options.workspace), options, roots);
  }
  authorize(device: string, capability: "files.read" | "files.write"): void {
    if (this.closed) throw new FileError("CLOSED", "File service closed");
    if (!this.options.authorize(device, capability))
      throw new FileError("FORBIDDEN", "Device scope denies this operation");
  }
  reserve(): () => void {
    if (this.closed) throw new FileError("CLOSED", "File service closed");
    if (this.active >= (this.options.maxTransfers ?? 4))
      throw new FileError("BUSY", "Concurrent transfer limit reached");
    this.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.active--;
      }
    };
  }
  /** Reserve generated artifact disk space before an export; trusted source files are independent. */
  reserveArtifactExport(bytes: number): () => void {
    if (this.closed) throw new FileError("CLOSED", "File service closed");
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 0 ||
      this.artifactBytes + bytes + this.catalog.total("artifact").bytes >
        (this.options.maxArtifactBytes ?? 20 * 1024 ** 3)
    )
      throw new FileError("QUOTA", "Generated artifact quota exceeded");
    this.artifactBytes += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.artifactBytes -= bytes;
      }
    };
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.pending >= 16) return Promise.reject(new FileError("BUSY", "Mutation queue is full"));
    this.pending++;
    const next = this.tail.then(action);
    this.tail = next
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return next;
  }
  subscribe(listener: (change: WorkspaceFileChange) => void): () => void {
    if (this.listeners.size >= 1024) throw new FileError("BUSY", "File subscriber limit reached");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(change: WorkspaceFileChange): void {
    // A UI or engine consumer failure cannot roll back a completed filesystem mutation.
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        /* consumer owns recovery */
      }
    }
    try {
      this.options.onChange?.(change);
    } catch {
      /* sink owns recovery */
    }
  }
  async request(device: string, input: unknown, guard: () => void = () => {}): Promise<unknown> {
    guard();
    const operation = FileOperation.parse(input);
    const reading = [
      "stat",
      "archive.preview",
      "artifacts.list",
      "trash.list",
      "artifact.output",
      "artifact.raw",
      "artifact.support",
    ].includes(operation.op);
    this.authorize(device, reading ? "files.read" : "files.write");
    if (operation.op === "stat") {
      const current = await observed(this.safe, operation.path);
      if (current === null) return { path: operation.path, version: null };
      const { info, type } = await this.safe.metadata(operation.path);
      return { path: operation.path, version: current, size: info.size, type };
    }
    if (operation.op === "artifact.support") {
      if (!this.options.exportSupport)
        throw new FileError("UNSUPPORTED", "Support producer unavailable");
      return { artifactId: await this.options.exportSupport(device, guard) };
    }
    if (operation.op === "artifact.raw") {
      if (!this.options.exportRaw)
        throw new FileError("UNSUPPORTED", "Raw blob producer unavailable");
      return { artifactId: await this.options.exportRaw(device, operation.blobRef, guard) };
    }
    if (operation.op === "artifact.output") {
      if (!this.options.exportOutput)
        throw new FileError("UNSUPPORTED", "Output producer unavailable");
      return { artifactId: await this.options.exportOutput(device, operation.streamId, guard) };
    }
    if (operation.op === "trash.list")
      return this.catalog.listTrash(operation.after ?? "", this.options.now(), operation.limit);
    if (operation.op === "artifacts.list")
      return this.catalog.list("artifact").map((record) => {
        const artifact = ArtifactRecord.parse(record);
        return {
          id: artifact.id,
          name: artifact.name,
          category: artifact.category,
          size: artifact.bytes,
        };
      });
    return this.serial(async () => {
      guard();
      this.authorize(device, reading ? "files.read" : "files.write");
      switch (operation.op) {
        case "archive.preview": {
          for (const [id, preview] of this.previews)
            if (preview.expires <= this.options.now()) this.previews.delete(id);
          if (this.previews.size >= 4) throw new FileError("BUSY", "Archive preview limit reached");
          const preview = await previewArchive(
            this.safe,
            operation.path,
            operation.includeIgnored,
            newId(this.options.id),
            this.options.now() + 300_000,
          );
          this.previews.set(preview.id, preview);
          return {
            previewId: preview.id,
            bytes: preview.bytes,
            entries: preview.entries.length,
            format: "tar.gz",
            validator: preview.validator,
          };
        }
        case "upload.begin":
          return this.uploads.begin(device, operation.path, operation.expected, operation.size);
        case "upload.resume":
          return this.uploads.resume(device, operation.uploadId);
        case "upload.cancel":
          await this.uploads.cancel(device, operation.uploadId);
          return { cancelled: true };
        case "upload.commit": {
          const path = await this.uploads.commit(device, operation.uploadId, operation.sha256);
          const change: WorkspaceFileChange = {
            id: newId(this.options.id),
            op: "upload",
            path,
            version: await observed(this.safe, path),
          };
          this.emit(change);
          return change;
        }
        case "write":
        case "create":
        case "mkdir":
        case "rename":
        case "move":
        case "delete":
        case "restore": {
          if (operation.op === "delete" || operation.op === "rename" || operation.op === "move")
            this.uploads.assertUnoccupied(operation.path);
          const change = await this.mutations.apply(operation);
          this.emit(change);
          return change;
        }
        default:
          throw new FileError("INVALID_OPERATION", "Use the binary transfer channel");
      }
    });
  }
  append(
    device: string,
    id: string,
    offset: number,
    bytes: Buffer,
    guard: () => void = () => {},
  ): Promise<{ uploadId: string; offset: number; size: number }> {
    this.authorize(device, "files.write");
    return this.serial(() => {
      guard();
      this.authorize(device, "files.write");
      return this.uploads.append(device, id, offset, bytes);
    });
  }
  download(device: string, input: unknown): Promise<Download> {
    return this.prepareDownload(device, input, openDownload);
  }
  /** Bytes remain valid until the next read; transports must await writes before advancing. */
  downloadForTransport(device: string, input: unknown): Promise<Download> {
    return this.prepareDownload(device, input, openBorrowedDownload);
  }
  private async prepareDownload(
    device: string,
    input: unknown,
    openFile: typeof openDownload,
  ): Promise<Download> {
    this.authorize(device, "files.read");
    const operation = FileOperation.parse(input);
    const release = this.reserve();
    try {
      let download: Download;
      switch (operation.op) {
        case "download":
          download = await openFile(
            this.safe,
            operation.path,
            operation.offset,
            operation.validator,
          );
          break;
        case "artifact.download": {
          const record = ArtifactRecord.parse(this.catalog.get(operation.artifactId));
          const root = this.roots.get(record.root);
          if (!root) throw new FileError("FORBIDDEN", "Artifact root is no longer configured");
          download = await openFile(root, record.path, operation.offset, operation.validator);
          break;
        }
        case "archive.download": {
          const preview = this.previews.get(operation.previewId);
          if (!preview || preview.expires <= this.options.now())
            throw new FileError("EXPIRED", "Archive preview expired");
          download = archiveDownload(this.safe, preview);
          break;
        }
        default:
          throw new FileError("INVALID_OPERATION", "Expected download operation");
      }
      const close = async () => {
        try {
          await download.close();
        } finally {
          release();
        }
      };
      async function* chunks(): AsyncGenerator<Buffer> {
        try {
          yield* download.chunks;
        } finally {
          await close();
        }
      }
      return { ...download, chunks: chunks(), close };
    } catch (error) {
      release();
      throw error;
    }
  }
  /** Trusted local producers register paths; clients can only address opaque IDs. */
  async registerArtifact(input: {
    root: string;
    path: string;
    name: string;
    category: ArtifactRecord["category"];
    id?: string;
  }): Promise<string> {
    return this.serial(async () => {
      input = { ...input, root: await realpath(input.root) };
      const root = this.roots.get(input.root);
      if (!root) throw new FileError("FORBIDDEN", "Unknown artifact root");
      const identifier =
        input.id === undefined ? newId(this.options.id) : ArtifactRecord.shape.id.parse(input.id);
      let replacing = false;
      try {
        const existing = ArtifactRecord.parse(this.catalog.get(identifier));
        if (
          existing.root !== input.root ||
          existing.path !== input.path ||
          existing.category !== input.category
        )
          throw new FileError("CONFLICT", "Artifact identity already belongs to another producer");
        replacing = true;
      } catch (error) {
        if (!(error instanceof FileError && error.code === "NOT_FOUND")) throw error;
      }
      if (!replacing && this.catalog.total("artifact").count >= 1024)
        throw new FileError("QUOTA", "Artifact registry is full");
      const { handle, info } = await root.file(input.path);
      await handle.close();
      const record = ArtifactRecord.parse({
        ...input,
        id: identifier,
        kind: "artifact",
        expires: Number.MAX_SAFE_INTEGER,
        bytes: info.size,
      });
      if (replacing) this.catalog.replaceArtifact(record);
      else this.catalog.put(record);
      return record.id;
    });
  }
  removeArtifact(id: string): Promise<void> {
    return this.serial(async () => {
      ArtifactRecord.parse(this.catalog.get(id));
      this.catalog.delete(id);
    });
  }
  /** Called by the daemon's maintenance owner with its injected clock. */
  sweep(): Promise<void> {
    return this.serial(async () => {
      await this.uploads.removeMany(
        this.catalog
          .list("upload")
          .filter(
            (record) => record.expires <= this.options.now() || UploadRecord.parse(record).cleanup,
          )
          .map((record) => UploadRecord.parse(record)),
      );
      for (const record of this.catalog.list("trash"))
        if (record.expires <= this.options.now())
          await this.mutations.expire(TrashRecord.parse(record));
      for (const [id, preview] of this.previews)
        if (preview.expires <= this.options.now()) this.previews.delete(id);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
    this.listeners.clear();
    this.previews.clear();
    this.catalog.close();
    await this.exclusive.close();
  }
}
