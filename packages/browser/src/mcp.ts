import { z } from "zod";
import { BrowserCommand } from "@ace/protocol";
import type { ApprovalTarget } from "@ace/protocol";
import type { BrowserToolkit } from "@ace/mcp-server";
import type { BrowserService } from "./service.ts";
const actions = {
  navigate: {
    riskClass: "external-effect",
    description: "Navigate the approved browser to a URL.",
  },
  click: {
    riskClass: "external-effect",
    description: "Click the approved browser element identified by its semantic ref.",
  },
  type: {
    riskClass: "external-effect",
    description: "Type text into the approved browser element.",
  },
  press: { riskClass: "external-effect", description: "Press a key in the approved browser." },
  scroll: {
    riskClass: "external-effect",
    description: "Scroll the approved browser by the requested coordinates.",
  },
  snapshot: {
    riskClass: "read-only",
    description: "Read the approved browser's bounded page snapshot and semantic refs.",
  },
  screenshot: { riskClass: "read-only", description: "Read a screenshot of the approved browser." },
  evaluate: {
    riskClass: "external-effect",
    description: "Execute JavaScript in the approved browser page under its evaluate policy.",
  },
  wait_for: {
    riskClass: "read-only",
    description: "Wait for an approved browser element to become visible or hidden.",
  },
  logs: {
    riskClass: "read-only",
    description: "Read the approved browser's retained console logs.",
  },
  resize: {
    riskClass: "external-effect",
    description: "Change the approved browser viewport dimensions.",
  },
  emulate: {
    riskClass: "external-effect",
    description: "Change the approved browser's device emulation settings.",
  },
} satisfies Record<
  BrowserCommand["action"],
  { riskClass: NonNullable<ApprovalTarget["riskClass"]>; description: string }
>;

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
          description: actions[action].description,
          riskClass: actions[action].riskClass,
          input: z.strictObject(
            Object.fromEntries(Object.entries(command.shape).filter(([key]) => key !== "action")),
          ),
          capability: "browser",
          timeoutMs: action === "navigate" ? 100_000 : 35_000,
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
