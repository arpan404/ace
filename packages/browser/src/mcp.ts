import { z } from "zod";
import { BrowserCommand } from "@ace/protocol";
import type { BrowserToolkit } from "@ace/mcp-server";
import type { BrowserService } from "./service.ts";

/** Agents use the human-opened browser and its existing origin/evaluate policy. */
export function browserToolkit(
  service: Pick<BrowserService, "execute" | "screenshot">,
): BrowserToolkit {
  return {
    capability: "browser",
    register(registry) {
      for (const command of BrowserCommand.options) {
        const action = command.shape.action.value;
        registry.registerContent({
          name: `ace_browser_${action}`,
          description: `Run ${action} in this thread's approved ace browser. Element refs come from snapshot.`,
          input: z.strictObject(
            Object.fromEntries(Object.entries(command.shape).filter(([key]) => key !== "action")),
          ),
          capability: "browser",
          timeoutMs: 35_000,
          async run(args, { caller, signal }) {
            signal.throwIfAborted();
            if (action === "screenshot") {
              const bytes = await service.screenshot(caller.threadId, signal);
              signal.throwIfAborted();
              return {
                content: [
                  {
                    type: "image",
                    mimeType: "image/jpeg",
                    data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
                      "base64",
                    ),
                  },
                ],
              };
            }
            const result = await service.execute(
              caller.threadId,
              { ...args, action },
              { kind: "agent" },
              signal,
            );
            signal.throwIfAborted();
            return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
          },
        });
      }
    },
  };
}
