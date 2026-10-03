import type { Toolkit } from "@ace/mcp-server";
import type { ScreenManager } from "./manager.ts";
import { agentOwner } from "./agent-binding.ts";
import { computerUseTools, computerUseSchemas, computerUseHandler } from "./tools.ts";
export function screenToolkit(manager: ScreenManager): Toolkit {
  return {
    register(registry) {
      for (const [name, input] of Object.entries(computerUseSchemas)) {
        const description = computerUseTools.find((tool) => tool.name === name)?.description;
        if (!description) throw new Error("Screen tool description missing");
        registry.registerContent({
          name,
          description,
          input,
          capability: "screen",
          timeoutMs: 15_000,
          async run(args, { caller, signal }) {
            signal.throwIfAborted();
            const sessionId = manager.agentSession(caller);
            const result = await computerUseHandler(
              manager,
              sessionId,
              agentOwner(caller),
            )(name, args);
            signal.throwIfAborted();
            if (manager.agentSession(caller) !== sessionId)
              throw new Error("Screen delegation changed");
            return result;
          },
        });
      }
    },
  };
}
