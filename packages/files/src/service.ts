import { createExclusiveRename, type ExclusiveRename } from "./exclusive-rename.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SafeRoot, GitIgnore, listWorkspace } from "@ace/workspace";
import { FileOperation, type WorkspaceFileChange } from "@ace/protocol";
import { ArtifactRecord, Catalog, TrashRecord, UploadRecord } from "./catalog.ts";
import { ArchivePreviews } from "./archive-previews.ts";
import { FileRequestLifetime } from "./request-lifetime.ts";
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
  private readonly previews: ArchivePreviews;
  private readonly listeners = new Set<(change: WorkspaceFileChange) => void>();
  private readonly lifetime: FileRequestLifetime;
  get idle(): boolean {
    return (
      !this.closed &&
      this.active === 0 &&
      this.owners === 0 &&
      this.pending === 0 &&
      this.artifactBytes === 0 &&
      this.lifetime.idle &&
      this.listeners.size === 0
    );
  }
  private owners = 0;
  private revision = 0;
  private artifactBytes = 0;
  private active = 0;
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private constructor(safe: SafeRoot, options: FilesOptions, roots: Map<string, SafeRoot>) {
    this.safe = safe;
    this.options = options;
    this.lifetime = new FileRequestLifetime(options.scheduleTimeout);
    this.previews = new ArchivePreviews(safe, options, this.lifetime);
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
      const safe = await SafeRoot.create(root, options.workspaceRuntime);
      roots.set(safe.root, safe);
    }
    return new FilesService(
      await SafeRoot.create(options.workspace, options.workspaceRuntime),
      options,
      roots,
    );
  }
  authorize(device: string, capability: "files.read" | "files.write"): void {
    if (this.closed) throw new FileError("CLOSED", "File service closed");
    if (!this.options.authorize(device, capability))
      throw new FileError("FORBIDDEN", "Device scope denies this operation");
  }
  scheduleTransferTimeout(callback: () => void): () => void {
    const milliseconds = this.options.transferIdleMs ?? 60_000;
    if (this.options.scheduleTimeout) return this.options.scheduleTimeout(callback, milliseconds);
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  }
  retain(): () => void {
    if (this.closed) throw new FileError("CLOSED", "File service closed");
    this.owners++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.owners--;
      }
    };
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
    if (this.closed) return Promise.reject(new FileError("CLOSED", "File service closed"));
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
    this.revision++;
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
  request(device: string, input: unknown, guard: () => void = () => {}): Promise<unknown> {
    return this.lifetime.run(() => this.performRequest(device, input, guard));
  }
  private async performRequest(
    device: string,
    input: unknown,
    guard: () => void,
  ): Promise<unknown> {
    guard();
    const operation = FileOperation.parse(input);
    const reading = [
      "list",
      "stat",
      "archive.preview",
      "artifacts.list",
      "trash.list",
      "artifact.output",
      "artifact.raw",
      "artifact.support",
    ].includes(operation.op);
    this.authorize(device, reading ? "files.read" : "files.write");
    if (operation.op === "list") {
      const page = await listWorkspace(this.safe, await GitIgnore.create(this.safe), {
        dir: operation.path,
        depth: 100,
        limit: operation.limit,
      });
      guard();
      return {
        paths: page.entries
          .filter((entry) => entry.type === "file" || entry.type === "directory")
          .map((entry) => entry.path + (entry.type === "directory" ? "/" : "")),
        truncated: page.truncated,
      };
    }
    if (operation.op === "stat") {
      const current = await this.lifetime.walk((signal) =>
        observed(this.safe, operation.path, signal),
      );
      if (current === null) return { path: operation.path, version: null };
      const { info, type } = await this.safe.metadata(operation.path);
      return { path: operation.path, version: current, size: info.size, type };
    }
    if (operation.op === "artifact.support") {
      if (!this.options.exportSupport)
        throw new FileError("UNSUPPORTED", "Support producer unavailable");
      return {
        artifactId: await this.options.exportSupport(device, guard, operation.includeThreads),
      };
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
    if (operation.op === "archive.preview") {
      const result = await this.previews.preview(operation);
      guard();
      this.authorize(device, "files.read");
      return result;
    }
    switch (operation.op) {
      case "write":
      case "create":
      case "mkdir":
      case "rename":
      case "move":
      case "delete":
      case "restore":
        return this.mutate(device, operation, guard);
    }
    return this.serial(async () => {
      guard();
      this.authorize(device, reading ? "files.read" : "files.write");
      switch (operation.op) {
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
        default:
          throw new FileError("INVALID_OPERATION", "Use the binary transfer channel");
      }
    });
  }
  private async mutate(
    device: string,
    operation: Parameters<Mutations["apply"]>[0],
    guard: () => void,
  ): Promise<WorkspaceFileChange> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision;
      const prepared = await this.lifetime.walk((signal) =>
        this.mutations.prepare(operation, signal),
      );
      // Failed queued I/O emits no change event; refresh its old observation too.
      if (this.pending > 0) {
        await this.tail;
        continue;
      }
      const result = await this.serial(async () => {
        guard();
        this.authorize(device, "files.write");
        if (revision !== this.revision) return undefined;
        if (operation.op === "delete" || operation.op === "rename" || operation.op === "move")
          this.uploads.assertUnoccupied(operation.path);
        const change = await this.mutations.apply(operation, prepared);
        this.emit(change);
        return change;
      });
      if (result) return result;
    }
    throw new FileError("BUSY", "Workspace changed during preparation; try again");
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
          download = this.previews.download(operation.previewId);
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
  sweep(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      await this.uploads.removeMany(
        this.catalog
          .list("upload")
          .filter(
            (record) => record.expires <= this.options.now() || UploadRecord.parse(record).cleanup,
          )
          .map((record) => UploadRecord.parse(record)),
        signal,
      );
      for (const record of this.catalog.list("trash")) {
        signal?.throwIfAborted();
        if (record.expires <= this.options.now())
          await this.mutations.expire(TrashRecord.parse(record));
      }
      this.previews.sweep();
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.lifetime.close();
    await this.tail;
    this.listeners.clear();
    this.previews.close();
    this.catalog.close();
    await this.exclusive.close();
  }
}
