import { BrowserArtifactFiles } from "./browser-artifact-files.ts";
import { LinkedFiles } from "./linked-files.ts";
import { ForgeMediaFiles } from "./forge-media/media-files.ts";
import { createHash } from "node:crypto";
import { FilesService } from "@ace/files";
import type { ThreadId, WorkspaceId } from "@ace/protocol";
import { ProjectStorage } from "./project-storage.ts";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { ServiceContext } from "./services/types.ts";

type Context = Pick<ServiceContext, "store" | "config" | "options" | "now" | "id"> &
  Partial<Pick<ServiceContext, "log">>;

/** Where a service's folder is, and the project its changes are recorded for. */
type Target = { root(): string; workspaceId(): WorkspaceId | undefined };

/** Shared persistent upload/mutation owner per execution root, independent of ACE_WORKSPACE_ROOT. */
export class FilesWorkspaces {
  private pinned = new Set<string>();
  readonly browserArtifacts: BrowserArtifactFiles;
  readonly linkedFiles: LinkedFiles;
  readonly forgeMedia: ForgeMediaFiles;
  private services = new Map<string, Promise<FilesService>>();
  private context: Context;
  private projects: ProjectStorage;
  private closed = false;
  constructor(context: Context) {
    this.context = context;
    this.projects = new ProjectStorage(context.store, context.now);
    this.browserArtifacts = new BrowserArtifactFiles(context);
    this.linkedFiles = new LinkedFiles(context);
    this.forgeMedia = new ForgeMediaFiles({
      dataDir: context.config.dataDir,
      now: context.now,
      id: context.id,
    });
  }
  root(threadId: ThreadId): string {
    const binding = this.context.store.executionWorkspace(threadId);
    if (!binding.ready) throw new Error("workspace_preparing");
    return binding.path;
  }
  matches(threadId: ThreadId, root: string): boolean {
    try {
      return this.root(threadId) === root;
    } catch {
      return false;
    }
  }
  /** A registered project's own folder; throws once the project is removed. */
  projectRoot(workspaceId: WorkspaceId): string {
    return this.projects.get(workspaceId).path;
  }
  matchesProject(workspaceId: WorkspaceId, root: string): boolean {
    try {
      return this.projectRoot(workspaceId) === root;
    } catch {
      return false;
    }
  }
  /** The legacy API registers its canonical service before sockets are admitted. */
  register(root: string, service: FilesService): void {
    if (this.closed || this.services.has(root)) throw new Error("Files root already owned");
    this.pinned.add(root);
    this.services.set(root, Promise.resolve(service));
  }
  get(threadId: ThreadId): Promise<FilesService> {
    return this.resolve(this.thread(threadId), (service) => service);
  }
  acquire(threadId: ThreadId): Promise<{ service: FilesService; release(): void }> {
    return this.resolve(this.thread(threadId), (service) => ({
      service,
      release: service.retain(),
    }));
  }
  /** The project folder's service: the same one its threads share when they run there. */
  acquireProject(workspaceId: WorkspaceId): Promise<{ service: FilesService; release(): void }> {
    return this.resolve(
      { root: () => this.projectRoot(workspaceId), workspaceId: () => workspaceId },
      (service) => ({ service, release: service.retain() }),
    );
  }
  private thread(threadId: ThreadId): Target {
    return {
      root: () => this.root(threadId),
      workspaceId: () => this.context.store.getThread(threadId)?.workspaceId,
    };
  }
  private async resolve<T>(target: Target, claim: (service: FilesService) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Files closed"));
    const root = await realpath(target.root());
    if (this.closed) throw new Error("Files closed");
    const existing = this.services.get(root);
    if (existing) {
      const service = await existing;
      if (this.closed) throw new Error("Files closed");
      if (this.services.get(root) !== existing) return this.resolve(target, claim);
      this.services.delete(root);
      this.services.set(root, existing);
      return claim(service);
    }
    if (this.services.size >= 64) {
      for (const [candidate, flight] of this.services) {
        const service = await flight.catch(() => undefined);
        if (
          !this.pinned.has(candidate) &&
          service?.idle &&
          this.services.get(candidate) === flight
        ) {
          this.services.delete(candidate);
          await service.close();
          break;
        }
      }
      if (this.services.size >= 64) throw new Error("Files workspace limit");
    }
    if (this.closed) throw new Error("Files closed");
    const raced = this.services.get(root);
    if (raced) return this.resolve(target, claim);
    const workspaceId = target.workspaceId();
    if (!workspaceId) return Promise.reject(new Error("Thread unavailable"));
    const key = createHash("sha256").update(root).digest("hex");
    const { config, options, now, id, store, log } = this.context;
    const service = FilesService.create({
      ...options.files,
      workspace: root,
      dataDir: join(config.dataDir, "workspace-files", key),
      now,
      id,
      authorize: () => !store.workspaceReservations.reserved(root),
      onChange: (change) => store.recordWorkspaceFileChange(workspaceId, root, change),
      onUploadRecovery: (notice) =>
        log?.log("warn", "Upload receipt settled after destination changed", notice),
    }).catch((error: unknown) => {
      this.services.delete(root);
      throw error;
    });
    this.services.set(root, service);
    const ready = await service;
    if (this.closed) throw new Error("Files closed");
    if (this.services.get(root) !== service) return this.resolve(target, claim);
    return claim(ready);
  }
  async sweep(signal: AbortSignal): Promise<void> {
    await this.browserArtifacts.sweep(signal);
    for (const [root, flight] of this.services) {
      signal.throwIfAborted();
      const service = await flight;
      if (!this.closed && this.services.get(root) === flight) await service.sweep(signal);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const all = await Promise.allSettled(this.services.values());
    await Promise.allSettled(
      all.map((result) =>
        result.status === "fulfilled" ? result.value.close() : Promise.resolve(),
      ),
    );
    this.services.clear();
    await this.browserArtifacts.close();
    await this.linkedFiles.close();
    await this.forgeMedia.close();
  }
}
