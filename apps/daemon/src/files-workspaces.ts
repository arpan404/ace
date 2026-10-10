import { BrowserArtifactFiles } from "./browser-artifact-files.ts";
import { createHash } from "node:crypto";
import { FilesService } from "@ace/files";
import type { ThreadId } from "@ace/protocol";
import { join } from "node:path";
import { realpath } from "node:fs/promises";
import type { ServiceContext } from "./services/types.ts";

/** Shared persistent upload/mutation owner per execution root, independent of ACE_WORKSPACE_ROOT. */
export class FilesWorkspaces {
  readonly browserArtifacts: BrowserArtifactFiles;
  private services = new Map<string, Promise<FilesService>>();
  private context: ServiceContext;
  private closed = false;
  constructor(context: ServiceContext) {
    this.context = context;
    this.browserArtifacts = new BrowserArtifactFiles(context);
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
    this.services.set(root, Promise.resolve(service));
  }
  async get(threadId: ThreadId): Promise<FilesService> {
    if (this.closed) return Promise.reject(new Error("Files closed"));
    const root = await realpath(this.root(threadId));
    if (this.closed) throw new Error("Files closed");
    const existing = this.services.get(root);
    if (existing) return existing;
    if (this.services.size >= 64) return Promise.reject(new Error("Files workspace limit"));
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
    return service;
  }
  async sweep(signal: AbortSignal): Promise<void> {
    await this.browserArtifacts.sweep(signal);
    for (const service of this.services.values()) {
      signal.throwIfAborted();
      await (await service).sweep(signal);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    const all = await Promise.allSettled(this.services.values());
    for (const result of all) if (result.status === "fulfilled") await result.value.close();
    this.services.clear();
    await this.browserArtifacts.close();
  }
}
