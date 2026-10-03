import type { ProviderMcpControl } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";

/** Live control handles belong to the existing MCP service, never to persisted server settings. */
export class McpProviderSessions {
  private readonly live = new Map<ThreadId, ProviderMcpControl>();
  bind(thread: ThreadId, control: ProviderMcpControl, signal: AbortSignal): () => void {
    signal.throwIfAborted();
    if (this.live.has(thread)) throw new Error("MCP provider session already bound");
    if (this.live.size >= 256) throw new Error("MCP provider session capacity reached");
    const end = () => {
      if (this.live.get(thread) === control) this.live.delete(thread);
      signal.removeEventListener("abort", end);
    };
    this.live.set(thread, control);
    signal.addEventListener("abort", end, { once: true });
    return end;
  }
  require(thread: ThreadId): ProviderMcpControl {
    const control = this.live.get(thread);
    if (!control) throw new Error("Provider MCP session is not live");
    return control;
  }
}
