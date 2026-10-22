import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { FileError, FilesService } from "@ace/files";
import type { FileOperation } from "@ace/protocol";
import { forgeMediaRoot } from "./media-cache.ts";
import { ForgeMediaGrants } from "./media-grants.ts";

type MediaDownload = Extract<FileOperation, { op: "forge.media.download" }>;

/**
 * Read-only downloads of forge media from the daemon's cache (ADR 0096), by hash. A request
 * names a registered project and the hash a resolve returned; it becomes a plain download of
 * that one file from a files service rooted at the cache folder, so it streams through the
 * same pull channel, relays included, as every other download.
 */
export class ForgeMediaFiles {
  /** Which project may download which hash; written by the media service's resolves. */
  readonly grants = new ForgeMediaGrants();
  private readonly context: { dataDir: string; now(): number; id(): string };
  private service: Promise<FilesService> | undefined;
  private closed = false;
  constructor(context: { dataDir: string; now(): number; id(): string }) {
    this.context = context;
  }
  /**
   * `readable` is the caller's live read grant and that the project is still registered. Only a
   * hash a resolve under this project answered with is served.
   */
  async bind(
    workspaceId: string,
    operation: MediaDownload,
    readable: () => boolean,
  ): Promise<{
    service: FilesService;
    allowed(access: "read" | "operate"): boolean;
    operation: FileOperation;
  }> {
    if (!readable()) throw new FileError("FORBIDDEN", "File access denied");
    // As for media that isn't there: the page resolves again, through this project's access.
    if (!this.grants.allows(workspaceId, operation.sha256))
      throw new FileError("NOT_FOUND", "Media unavailable");
    return {
      service: await this.files(),
      allowed: (access) => access === "read" && readable(),
      operation: { op: "download", path: operation.sha256, offset: operation.offset },
    };
  }
  private files(): Promise<FilesService> {
    if (this.closed) return Promise.reject(new FileError("CLOSED", "Forge media closed"));
    const { dataDir, now, id } = this.context;
    this.service ??= (async () => {
      const root = forgeMediaRoot(dataDir);
      await mkdir(root, { recursive: true, mode: 0o700 });
      return FilesService.create({
        workspace: root,
        dataDir: join(dataDir, "forge-media-files"),
        now,
        id,
        authorize: (_device, capability) => capability === "files.read",
      });
    })().catch((error: unknown) => {
      this.service = undefined;
      throw error;
    });
    return this.service;
  }
  async close(): Promise<void> {
    this.closed = true;
    const service = await this.service?.catch(() => undefined);
    await service?.close();
  }
}
