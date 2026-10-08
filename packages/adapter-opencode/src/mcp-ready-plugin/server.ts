import { mcpReadyRpc } from "../mcp-ready-contract.ts";

// The installed OpenCode host supplies these public Promise plugin interfaces.
// Keep this entry dependency-free; it runs in the CLI, not the daemon.
type Tool = { id: string; description: string; options?: { namespace?: string } };
type Context = {
  tool: {
    transform(read: (editor: { list(): readonly Tool[] }) => void): Promise<unknown>;
    list(): Promise<readonly Tool[]>;
  };
  rpc: {
    register(
      definition: typeof mcpReadyRpc,
      handlers: {
        ready(
          input: unknown,
          context: { signal: AbortSignal },
        ): Promise<{
          tools: { name: string; description: string }[];
        }>;
      },
    ): Promise<unknown>;
  };
};

export default {
  id: mcpReadyRpc.id,
  async setup(context: Context): Promise<void> {
    const settled = Promise.withResolvers<void>();
    // MCP connection status precedes OpenCode's debounced native tool reload.
    // Observe the tool transform instead of assuming a connection means readiness.
    await context.tool.transform((editor) => {
      if (editor.list().some((tool) => tool.id === "ace_ace_status")) settled.resolve();
    });
    await context.rpc.register(mcpReadyRpc, {
      async ready(_, { signal }) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => reject(new Error("ace MCP readiness cancelled"));
          signal.addEventListener("abort", abort, { once: true });
          void settled.promise
            .then(resolve)
            .finally(() => signal.removeEventListener("abort", abort));
          if (signal.aborted) abort();
        });
        signal.throwIfAborted();
        const tools = (await context.tool.list())
          .filter((tool) => tool.options?.namespace === "ace")
          .map((tool) => ({ name: tool.id, description: tool.description }));
        if (tools.length > 256 || !tools.some((tool) => tool.name === "ace_ace_status"))
          throw new Error("ace MCP native tools unavailable");
        return { tools };
      },
    });
  },
};
