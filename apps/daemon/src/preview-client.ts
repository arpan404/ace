import { PreviewPort, type ThreadId } from "@ace/protocol";
import type { DaemonPreview } from "./preview.ts";
/** A trusted host registers ownership; clients never inherit another thread's listener. */
export class PreviewClient {
  private gateway: DaemonPreview | undefined;
  private entries = new Map<
    number,
    { threadId: ThreadId; origin: string; source: "listener" | "terminal" | "launch" }
  >();
  bind(gateway: DaemonPreview): void {
    this.gateway = gateway;
  }
  register(threadId: ThreadId, port: number, source: "listener" | "terminal" | "launch"): void {
    PreviewPort.parse(port);
    const previous = this.entries.get(port);
    if (previous && previous.threadId !== threadId)
      throw new Error("preview_owned_by_another_thread");
    if (!this.gateway) throw new Error("preview_unavailable");
    if (!previous && this.entries.size >= 64) throw new Error("preview_limit");
    this.entries.set(port, { threadId, origin: this.gateway.register({ port }), source });
  }
  list(threadId: ThreadId) {
    return [...this.entries]
      .filter(([, entry]) => entry.threadId === threadId)
      .map(([port, entry]) => ({ port, origin: entry.origin, source: entry.source }));
  }
  remove(threadId: ThreadId, port: number): void {
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
