import { PublicToolError, PublicToolCode, type Toolkit } from "@ace/mcp-server";
import type { ScreenManager } from "./manager.ts";
import type { ApprovalTarget } from "@ace/protocol";
import { HelperCommandError } from "./helper.ts";
import { agentOwner } from "./agent-binding.ts";
import { computerUseTools, computerUseSchemas, computerUseHandler } from "./tools.ts";
const risks = new Map(
  Object.entries({
    screen_ui_tree: "read-only",
    screen_ui_find: "read-only",
    screen_screenshot: "read-only",
    screen_ui_act: "external-effect",
    screen_click: "external-effect",
    screen_type: "external-effect",
    screen_key: "external-effect",
    screen_scroll: "external-effect",
  } satisfies Record<keyof typeof computerUseSchemas, NonNullable<ApprovalTarget["riskClass"]>>),
);
export function screenToolkit(manager: ScreenManager): Toolkit {
  return {
    register(registry) {
      for (const [name, input] of Object.entries(computerUseSchemas)) {
        const description = computerUseTools.find((tool) => tool.name === name)?.description;
        if (!description) throw new Error("Screen tool description missing");
        const riskClass = risks.get(name);
        if (!riskClass) throw new Error("Screen action metadata missing");
        registry.registerContent({
          name,
          description,
          riskClass,
          input,
          capability: "screen",
          timeoutMs: name === "screen_screenshot" ? 30_000 : 15_000,
          async run(args, { caller, signal }) {
            signal.throwIfAborted();
            const sessionId = manager.agentSession(caller);
            let result;
            try {
              result = await computerUseHandler(
                manager,
                sessionId,
                agentOwner(caller),
                signal,
              )(name, args);
            } catch (error) {
              if (error instanceof HelperCommandError) {
                const code = PublicToolCode.safeParse(error.code);
                if (code.success) throw new PublicToolError(code.data);
              }
              throw error;
            }
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
