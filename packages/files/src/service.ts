import { fileCapability } from "./access.ts";
import { createExclusiveRename, type ExclusiveRename } from "./exclusive-rename.ts";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { SafeRoot } from "@ace/workspace";
import { FileOperation, type WorkspaceFileChange } from "@ace/protocol";
import { ArtifactRecord, Catalog, TrashRecord, UploadRecord } from "./catalog.ts";
import { ArchivePreviews } from "./archive-previews.ts";
import { FileRequestLifetime } from "./request-lifetime.ts";
import { openDownload } from "./download.ts";
import { newId, observed } from "./filesystem.ts";
import type { FilesIo } from "./io.ts";
import { localFilesIo } from "./local-io.ts";
import { Mutations } from "./mutations.ts";
import { readPart } from "./read.ts";
import { PathReservations } from "./reservations.ts";
import { Uploads } from "./uploads.ts";
import { FileError, type FilesOptions, type Download } from "./types.ts";

/** The paths one mutation can change, which is what another mutation's proof must not cross. */
function affectedPaths(operation: Parameters<Mutations["apply"]>[0]): string[] {
  return operation.op === "rename" || operation.op === "move"
    ? [operation.path, operation.destination]
    : [operation.path];
}

export class FilesService {
  private readonly safe: SafeRoot;
  private readonly options: FilesOptions;
  private readonly catalog: Catalog;
  private readonly mutations: Mutations;
  private readonly exclusive: ExclusiveRename;
  private readonly uploads: Uploads;
  private readonly safes: Map<string, SafeRoot>;
  private readonly local: FilesIo;
  private readonly workspaceIo: FilesIo;
  private readonly previews: ArchivePreviews;
  private readonly listeners = new Set<(change: WorkspaceFileChange) => void>();
  private readonly lifetime: FileRequestLifetime;
  private readonly reservations = new PathReservations();
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
  private constructor(
    safe: SafeRoot,
    options: FilesOptions,
    safes: Map<string, SafeRoot>,
    exclusive: ExclusiveRename,
  ) {
    this.safe = safe;
    this.options = options;
    this.safes = safes;
    this.exclusive = exclusive;
    this.lifetime = new FileRequestLifetime(options.scheduleTimeout);
    this.local = localFilesIo((root) => this.safeRoot(root), exclusive);
    this.workspaceIo = options.workspaceIo ?? this.local;
    this.previews = new ArchivePreviews(this.workspaceIo, safe.root, options, this.lifetime);
    this.catalog = new Catalog(join(options.dataDir, "files.sqlite"));
    this.mutations = new Mutations(this.workspaceIo, safe, this.catalog, options, exclusive);
    this.uploads = new Uploads(safe, this.catalog, options, exclusive);
  }
  static async create(options: FilesOptions): Promise<FilesService> {
    await mkdir(join(options.dataDir, "trash"), { recursive: true, mode: 0o700 });
    const safes = new Map<string, SafeRoot>();
    for (const root of options.artifactRoots ?? []) {
      const safe = await SafeRoot.create(root, options.workspaceRuntime);
      safes.set(safe.root, safe);
    }
    const service = new FilesService(
      await SafeRoot.create(options.workspace, options.workspaceRuntime),
      options,
      safes,
      options.exclusiveRename ?? createExclusiveRename(),
    );
    safes.set(service.safe.root, service.safe);
    try {
      await service.mutations.reconcile();
      await service.uploads.reconcile();
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  /** The port a root's I/O goes through: ace-files for the checkout, the local one elsewhere. */
  private ioFor(root: string): FilesIo {
    return root === this.safe.root ? this.workspaceIo : this.local;
  }
  /** A confined root handle, made on first use and shared by every caller of the same folder. */
  private async safeRoot(root: string): Promise<SafeRoot> {
    const known = this.safes.get(root);
    if (known) return known;
    const safe = await SafeRoot.create(root, this.options.workspaceRuntime);
    this.safes.set(safe.root, safe);
    return safe;
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
  /**
   * Records a commit: the revision moves while the mutation still holds the queue, so a request
   * that prepared against an older observation retries instead of landing on top of this one.
   */
  private committed(): void {
    this.revision++;
  }
  subscribe(listener: (change: WorkspaceFileChange) => void): () => void {
    if (this.listeners.size >= 1024) throw new FileError("BUSY", "File subscriber limit reached");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(change: WorkspaceFileChange): void {
    // The commit already advanced the revision inside the queue; notifying is what is left, and
    // a UI or engine consumer failure cannot roll back a completed filesystem mutation.
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
    const capability = fileCapability(operation);
    this.authorize(device, capability);
    if (operation.op === "list") {
      const listing = await this.workspaceIo.paths(this.safe.root, operation.path, operation.limit);
      guard();
      return listing;
    }
    if (operation.op === "read") return readPart(this.workspaceIo, this.safe.root, operation);
    if (operation.op === "stat") {
      const description = await this.lifetime.walk((signal) =>
        this.workspaceIo.describe(this.safe.root, operation.path, { signal }),
      );
      if (description === null) return { path: operation.path, version: null };
      return {
        path: operation.path,
        version: description.version,
        size: description.size,
        type: description.kind,
      };
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
      this.authorize(device, capability);
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
          this.committed();
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
    const reserved = affectedPaths(operation);
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision;
      const prepared = await this.lifetime.walk((signal) =>
        this.mutations.prepare(operation, signal),
      );
      // Failed queued I/O emits no change event; refresh its old observation too.
      if (this.pending > 0 || !this.reservations.idle) {
        await this.tail;
        await this.reservations.settled(reserved);
        continue;
      }
      // The move's guard is verified after it lands, and verifying a folder walks its whole tree.
      // That happens outside the queue, under a reservation on the paths this mutation touched, so
      // an unrelated write is never held up by it and no write lands on a path still being proven.
      const release = await this.reservations.reserve(reserved);
      try {
        const applied = await this.serial(async () => {
          guard();
          this.authorize(device, "files.write");
          if (revision !== this.revision) return undefined;
          if (operation.op === "delete" || operation.op === "rename" || operation.op === "move")
            this.uploads.assertUnoccupied(operation.path);
          const outcome = await this.mutations.apply(operation, prepared);
          this.committed();
          return outcome;
        });
        if (!applied) continue;
        // The version and the broadcast come after the queue, and a failure to read the version
        // cannot turn a committed change into an error: the caller is told what landed.
        const change = await this.mutations.change(applied);
        this.emit(change);
        return change;
      } finally {
        release();
      }
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
    return this.prepareDownload(device, input);
  }
  /** Bytes remain valid until the next read; transports must await writes before advancing. */
  downloadForTransport(device: string, input: unknown): Promise<Download> {
    return this.prepareDownload(device, input);
  }
  private async prepareDownload(device: string, input: unknown): Promise<Download> {
    this.authorize(device, "files.read");
    const operation = FileOperation.parse(input);
    const release = this.reserve();
    try {
      let download: Download;
      switch (operation.op) {
        case "download":
          download = await openDownload(
            this.workspaceIo,
            this.safe.root,
            operation.path,
            operation.offset,
            operation.validator,
          );
          break;
        case "artifact.download": {
          const record = ArtifactRecord.parse(this.catalog.get(operation.artifactId));
          const root = this.safes.get(record.root);
          if (!root) throw new FileError("FORBIDDEN", "Artifact root is no longer configured");
          download = await openDownload(
            this.ioFor(root.root),
            root.root,
            record.path,
            operation.offset,
            operation.validator,
          );
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
  /** Durable provenance lets the daemon authorize the source again on every download. */
  artifactSource(artifactId: string): ArtifactRecord["sourceThread"] {
    const record = ArtifactRecord.parse(this.catalog.get(artifactId));
    if (record.category === "output" && !record.sourceThread)
      throw new FileError("FORBIDDEN", "Export has no source provenance");
    return record.sourceThread;
  }
  /** Trusted local producers register paths; clients can only address opaque IDs. */
  async registerArtifact(input: {
    root: string;
    path: string;
    name: string;
    category: ArtifactRecord["category"];
    sourceThread?: ArtifactRecord["sourceThread"];
    id?: string;
  }): Promise<string> {
    return this.serial(async () => {
      input = { ...input, root: await realpath(input.root) };
      const root = this.safes.get(input.root);
      if (!root) throw new FileError("FORBIDDEN", "Unknown artifact root");
      const identifier =
        input.id === undefined ? newId(this.options.id) : ArtifactRecord.shape.id.parse(input.id);
      let replacing = false;
      try {
        const existing = ArtifactRecord.parse(this.catalog.get(identifier));
        if (
          existing.root !== input.root ||
          existing.path !== input.path ||
          existing.category !== input.category ||
          existing.sourceThread !== input.sourceThread
        )
          throw new FileError("CONFLICT", "Artifact identity already belongs to another producer");
        replacing = true;
      } catch (error) {
        if (!(error instanceof FileError && error.code === "NOT_FOUND")) throw error;
      }
      if (!replacing && this.catalog.total("artifact").count >= 1024)
        throw new FileError("QUOTA", "Artifact registry is full");
      const description = await this.local.describe(root.root, input.path);
      if (description === null) throw new FileError("NOT_FOUND", "Artifact file not found");
      if (description.kind !== "file")
        throw new FileError("NOT_FILE", "Artifact must be a regular file");
      const record = ArtifactRecord.parse({
        ...input,
        id: identifier,
        kind: "artifact",
        expires: Number.MAX_SAFE_INTEGER,
        bytes: description.size,
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
  /** Trusted owner reconciliation. Source bytes remain owned by their producer. */
  reconcileArtifacts(retain: (id: string) => boolean): Promise<void> {
    return this.serial(async () => {
      for (const record of this.catalog.list("artifact"))
        if (!retain(record.id)) this.catalog.delete(record.id);
    });
  }
  /** Called by the daemon's maintenance owner with its injected clock. */
  sweep(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      await this.uploads.reconcile();
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
        const trash = TrashRecord.parse(record);
        // A receipt whose move is still unknown, or whose entry was located but never verified,
        // never expires: the bytes it names may be the only copy, and the next start reconciles
        // the pending one back into an ordinary entry.
        if (trash.pending || trash.stranded) continue;
        if (trash.expires <= this.options.now()) await this.mutations.expire(trash);
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
