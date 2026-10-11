import { FileError, FilesService } from "@ace/files";
import type { BrowserArtifact, ThreadId } from "@ace/protocol";
import { mkdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { ServiceContext } from "./services/types.ts";

/** Only browser producers register bytes. A socket must also prove exact thread ownership. */
export class BrowserArtifactFiles {
  private service: Promise<FilesService> | undefined;
  private readonly context: Pick<ServiceContext, "config" | "store" | "now" | "id">;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closing: Promise<void> | undefined;
  private pending = 0;
  constructor(context: Pick<ServiceContext, "config" | "store" | "now" | "id">) {
    this.context = context;
    context.store.atomic((db) =>
      db.exec(
        "CREATE INDEX IF NOT EXISTS browser_artifact_owner ON items(json_extract(item, '$.artifactId'), thread_id) WHERE json_extract(item, '$.type')='artifact' AND json_extract(item, '$.source')='browser'",
      ),
    );
  }
  owns(thread: ThreadId, artifactId: string): boolean {
    return (
      artifactId.startsWith("browser-") &&
      this.context.store
        .statement(
          "SELECT 1 FROM items JOIN threads ON threads.id=items.thread_id WHERE thread_id=? AND json_extract(item, '$.type')='artifact' AND json_extract(item, '$.source')='browser' AND json_extract(item, '$.artifactId')=? AND json_extract(threads.client, '$.deletedAt') IS NULL LIMIT 1",
        )
        .get(thread, artifactId) !== undefined
    );
  }
  get(): Promise<FilesService> {
    if (this.closed) return Promise.reject(new Error("Browser files closed"));
    return (this.service ??= this.open().catch((error: unknown) => {
      this.service = undefined;
      throw error;
    }));
  }
  private async open(): Promise<FilesService> {
    const { config, now, id } = this.context;
    const root = join(config.dataDir, "browser");
    await mkdir(root, { recursive: true, mode: 0o700 });
    const service = await FilesService.create({
      workspace: root,
      dataDir: join(config.dataDir, "browser-artifact-files"),
      artifactRoots: [root],
      now,
      id,
      authorize: () => true,
    });
    try {
      await service.reconcileArtifacts((artifactId) => this.retained(artifactId));
      return service;
    } catch (error) {
      await service.close();
      throw error;
    }
  }
  private retained(id: string): boolean {
    return (
      this.context.store
        .statement(
          "SELECT 1 FROM items JOIN threads ON threads.id=items.thread_id WHERE json_extract(item, '$.type')='artifact' AND json_extract(item, '$.source')='browser' AND json_extract(item, '$.artifactId')=? AND json_extract(threads.client, '$.deletedAt') IS NULL LIMIT 1",
        )
        .get(id) !== undefined
    );
  }
  private live(thread: ThreadId): boolean {
    const current = this.context.store.getThread(thread);
    return current !== undefined && current.deletedAt === undefined;
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser files closed"));
    if (this.pending >= 16)
      return Promise.reject(new FileError("BUSY", "Browser artifact queue is full"));
    this.pending++;
    const next = this.tail.then(action);
    this.tail = next
      .catch(() => {})
      .finally(() => {
        this.pending--;
      });
    return next;
  }
  /** Registration and synchronous durable publication share admission with reconciliation. */
  publish(
    thread: ThreadId,
    artifact: BrowserArtifact,
    append: (id: string) => void,
  ): Promise<void> {
    return this.serial(async () => {
      if (!this.live(thread)) return;
      const service = await this.get();
      let id: string;
      try {
        id = await this.register(service, artifact);
      } catch (error) {
        if (!(error instanceof FileError && error.code === "QUOTA")) throw error;
        // Reclaim deletions even before the next maintenance tick.
        await service.reconcileArtifacts((artifactId) => this.retained(artifactId));
        id = await this.register(service, artifact);
      }
      let published = false;
      try {
        // Deleted-thread recording finalization is a discard, not a teardown failure.
        if (!this.live(thread)) return;
        append(id);
        published = true;
      } finally {
        if (!published) await service.removeArtifact(id);
      }
    });
  }
  private async register(service: FilesService, artifact: BrowserArtifact): Promise<string> {
    const root = join(this.context.config.dataDir, "browser");
    // SafeRoot verifies confinement, symlinks and file identity during both registration/read.
    return service.registerArtifact({
      root,
      path: relative(root, artifact.path),
      name: artifact.filename ?? basename(artifact.path),
      category: artifact.mimeType.startsWith("image/") ? "screenshot" : "other",
      id: `browser-${this.context.id()}`,
    });
  }
  sweep(signal?: AbortSignal): Promise<void> {
    return this.serial(async () => {
      signal?.throwIfAborted();
      if (this.service) await (await this.service).reconcileArtifacts((id) => this.retained(id));
    });
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      this.closed = true;
      await this.tail;
      if (this.service) await (await this.service).close();
    })());
  }
}
