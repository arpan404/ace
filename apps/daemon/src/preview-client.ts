import { PreviewPort, type PreviewLink, type ThreadId } from "@ace/protocol";
import type { DaemonPreview } from "./preview.ts";
/** A trusted host registers ownership; clients never inherit another thread's listener. */
export class PreviewClient {
  private gateway: DaemonPreview | undefined;
  private entries = new Map<
    number,
    { threadId: ThreadId; origin: string; source: "listener" | "terminal" | "launch" }
  >();
  private readonly threadAvailable: (id: ThreadId) => boolean;
  constructor(threadAvailable: (id: ThreadId) => boolean = () => true) {
    this.threadAvailable = threadAvailable;
  }
  releaseThread(threadId: ThreadId): void {
    for (const [port, entry] of this.entries)
      if (entry.threadId === threadId) {
        this.gateway?.unregister(port);
        this.entries.delete(port);
      }
  }
  private reconcile(): void {
    for (const entry of this.entries.values())
      if (!this.threadAvailable(entry.threadId)) this.releaseThread(entry.threadId);
  }
  bind(gateway: DaemonPreview): void {
    this.gateway = gateway;
  }
  register(threadId: ThreadId, port: number, source: "listener" | "terminal" | "launch"): void {
    this.reconcile();
    PreviewPort.parse(port);
    const previous = this.entries.get(port);
    if (previous && previous.threadId !== threadId)
      throw new Error("preview_owned_by_another_thread");
    if (!this.gateway) throw new Error("preview_unavailable");
    if (!previous && this.entries.size >= 64) throw new Error("preview_limit");
    this.entries.set(port, { threadId, origin: this.gateway.register({ port }), source });
  }
  list(threadId: ThreadId) {
    this.reconcile();
    return [...this.entries]
      .filter(([, entry]) => entry.threadId === threadId)
      .map(([port, entry]) => ({ port, origin: entry.origin, source: entry.source }));
  }
  /**
   * A sign-in link for a port this thread previews, bound to `identity` (a paired device id or
   * the host identity). Another thread's port is not found, just like an unforwarded one.
   */
  async link(threadId: ThreadId, port: number, identity: string): Promise<PreviewLink> {
    this.reconcile();
    if (this.entries.get(port)?.threadId !== threadId) throw new Error("preview_not_found");
    if (!this.gateway) throw new Error("preview_unavailable");
    try {
      const url = await this.gateway.mintDeviceLink({ port, device: identity });
      return { url, sessionMs: this.gateway.sessionMs };
    } catch {
      throw new Error("preview_link_refused");
    }
  }
  remove(threadId: ThreadId, port: number): void {
    this.reconcile();
    if (this.entries.get(port)?.threadId !== threadId) throw new Error("preview_not_found");
    this.gateway?.unregister(port);
    this.entries.delete(port);
  }
  get available(): boolean {
    return this.gateway !== undefined;
  }
  close(): void {
    this.entries.clear();
    this.gateway = undefined;
  }
}
