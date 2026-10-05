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
    description:
      "Click a ref from ace_browser_snapshot. After a navigation-triggering click, wait_for url or text, then snapshot again. Old document refs expire.",
  },
  type: {
    riskClass: "external-effect",
    description:
      "Replace all text in an editable element using a snapshot ref. For focused keyboard input use press. Snapshot again after navigation.",
  },
  press: {
    riskClass: "external-effect",
    description:
      "Press a Playwright key such as Enter, Tab, Escape or Control+a. Optionally focus ref first. For a submitting key, wait_for url or text afterward.",
  },
  scroll: {
    riskClass: "external-effect",
    description:
      "Scroll by x horizontal and y vertical pixel deltas; these are distances, not a target point.",
  },
  snapshot: {
    riskClass: "read-only",
    description:
      "Read the current page accessibility tree. Use node refs for click/type/press. Refs stay stable within a document and expire on navigation; only the latest snapshot grants actionable refs.",
  },
  screenshot: { riskClass: "read-only", description: "Read a screenshot of the approved browser." },
  evaluate: {
    riskClass: "external-effect",
    description: "Execute JavaScript in the approved browser page under its evaluate policy.",
  },
  wait_for: {
    riskClass: "read-only",
    description:
      "Wait after click/press: pass url for an exact destination loaded through DOMContentLoaded, text for visible page text, or ref plus state (visible/hidden) for an existing element. Choose exactly one of url, text or ref. Safe when navigation already finished; take a fresh snapshot afterward.",
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
  startupReserveMs = 0,
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
          timeoutMs: Math.min(
            300_000,
            startupReserveMs + (action === "navigate" || action === "wait_for" ? 100_000 : 35_000),
          ),
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
