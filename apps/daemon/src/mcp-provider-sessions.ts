import type { ProviderMcpControl } from "@ace/engine-api";
import type { ProviderKind, ThreadId } from "@ace/protocol";

/** Live control handles belong to the existing MCP service, never to persisted server settings. */
export class McpProviderSessions {
  private readonly live = new Map<
    ThreadId,
    { control: ProviderMcpControl; provider: ProviderKind }
  >();
  bind(
    thread: ThreadId,
    provider: ProviderKind,
    control: ProviderMcpControl,
    signal: AbortSignal,
  ): () => void {
    signal.throwIfAborted();
    if (this.live.has(thread)) throw new Error("MCP provider session already bound");
    if (this.live.size >= 256) throw new Error("MCP provider session capacity reached");
    const end = () => {
      if (this.live.get(thread)?.control === control) this.live.delete(thread);
      signal.removeEventListener("abort", end);
    };
    this.live.set(thread, { control, provider });
    signal.addEventListener("abort", end, { once: true });
    return end;
  }
  require(thread: ThreadId): ProviderMcpControl {
    const bound = this.live.get(thread);
    if (!bound) throw new Error("Provider MCP session is not live");
    return bound.control;
  }
  /** The provider's most recently bound live session among the threads `readable` admits. */
  latest(provider: ProviderKind, readable: (thread: ThreadId) => boolean) {
    let found: ProviderMcpControl | undefined;
    for (const [thread, bound] of this.live)
      if (bound.provider === provider && readable(thread)) found = bound.control;
    return found;
  }
}
