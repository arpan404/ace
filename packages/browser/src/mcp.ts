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
    description:
      "Read bounded console and network entries inline, filtered by kind, level, URL or status.",
  },
  resize: {
    riskClass: "external-effect",
    description: "Change the approved browser viewport dimensions.",
  },
  emulate: {
    riskClass: "external-effect",
    description: "Change the approved browser's device emulation settings.",
  },
  tabs: {
    riskClass: "external-effect",
    description:
      "List, open, switch or close this thread's background tabs. Use operation and tabId. Tab ids are stable; take a fresh snapshot after switching.",
  },
  upload: {
    riskClass: "external-effect",
    description:
      "Set a file input ref with workspace or thread artifact files. Outside paths require human approval.",
  },
  dialog: {
    riskClass: "external-effect",
    description:
      "Answer a pending dialog by dialogId: accept or dismiss, with optional promptText.",
  },
  hover: { riskClass: "external-effect", description: "Move the pointer over a snapshot ref." },
  drag: { riskClass: "external-effect", description: "Drag a snapshot ref to toRef." },
  select: {
    riskClass: "external-effect",
    description: "Select option values in a native select element.",
  },
  check: {
    riskClass: "external-effect",
    description: "Check a checkbox or radio from a snapshot ref.",
  },
  uncheck: { riskClass: "external-effect", description: "Uncheck a checkbox from a snapshot ref." },
  focus: { riskClass: "external-effect", description: "Focus a snapshot ref." },
  find: {
    riskClass: "read-only",
    description:
      "Find elements by accessible role and name in all frames. Returns current snapshot refs.",
  },
  network_body: {
    riskClass: "read-only",
    description: "Read one bounded, redacted text response body by requestId from logs.",
  },
  record_start: {
    riskClass: "external-effect",
    description:
      "Start recording this thread's browser using the artifact pipeline. Private takeover excludes frames.",
  },
  record_stop: {
    riskClass: "external-effect",
    description: "Stop recording and announce a thread artifact.",
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
          timeoutMs: Math.min(300_000, startupReserveMs + 100_000),
          async run(args, { caller, signal }) {
            signal.throwIfAborted();
            if (action === "screenshot") {
              const bytes = await service.screenshot(
                caller.threadId,
                signal,
                typeof args["tabId"] === "string" ? args["tabId"] : undefined,
              );
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
