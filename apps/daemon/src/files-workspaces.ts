import { createHash } from "node:crypto";
import { FilesService } from "@ace/files";
import type { ThreadId } from "@ace/protocol";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { ServiceContext } from "./services/types.ts";

/** Shared persistent upload/mutation owner per execution root, independent of ACE_WORKSPACE_ROOT. */
export class FilesWorkspaces {
  private pinned = new Set<string>();
  private services = new Map<string, Promise<FilesService>>();
  private context: Pick<ServiceContext, "store" | "config" | "options" | "now" | "id">;
  private closed = false;
  constructor(context: Pick<ServiceContext, "store" | "config" | "options" | "now" | "id">) {
    this.context = context;
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
  /** The legacy API registers its canonical service before sockets are admitted. */
  register(root: string, service: FilesService): void {
    if (this.closed || this.services.has(root)) throw new Error("Files root already owned");
    this.pinned.add(root);
    this.services.set(root, Promise.resolve(service));
  }
  get(threadId: ThreadId): Promise<FilesService> {
    return this.resolve(threadId, (service) => service);
  }
  acquire(threadId: ThreadId): Promise<{ service: FilesService; release(): void }> {
    return this.resolve(threadId, (service) => ({ service, release: service.retain() }));
  }
  private async resolve<T>(threadId: ThreadId, claim: (service: FilesService) => T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Files closed"));
    const root = await realpath(this.root(threadId));
    if (this.closed) throw new Error("Files closed");
    const existing = this.services.get(root);
    if (existing) {
      const service = await existing;
      if (this.closed) throw new Error("Files closed");
      if (this.services.get(root) !== existing) return this.resolve(threadId, claim);
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
    if (raced) return this.resolve(threadId, claim);
    const thread = this.context.store.getThread(threadId);
    if (!thread) return Promise.reject(new Error("Thread unavailable"));
    const key = createHash("sha256").update(root).digest("hex");
    const { config, options, now, id, store } = this.context;
    const service = FilesService.create({
      ...options.files,
      workspace: root,
      dataDir: join(config.dataDir, "workspace-files", key),
      now,
      id,
      authorize: () => !store.workspaceReservations.reserved(root),
      onChange: (change) => store.recordWorkspaceFileChange(thread.workspaceId, change),
    }).catch((error: unknown) => {
      this.services.delete(root);
      throw error;
    });
    this.services.set(root, service);
    const ready = await service;
    if (this.closed) throw new Error("Files closed");
    if (this.services.get(root) !== service) return this.resolve(threadId, claim);
    return claim(ready);
  }
  async sweep(signal: AbortSignal): Promise<void> {
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
  }
}
