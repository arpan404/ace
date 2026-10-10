import { z } from "zod";
import {
  BrowserCommand,
  BrowserMeasurementOptions,
  InteractionMeasurement,
  BrowserDialog,
} from "@ace/protocol";
import type { ApprovalTarget } from "@ace/protocol";
import { validateMeasurementBudget } from "@ace/interaction";
import type { BrowserToolkit } from "@ace/mcp-server";
import type { BrowserService } from "./service.ts";
const actions = {
  measure_interaction: {
    riskClass: "external-effect",
    description:
      "Measure frame timing while observing or performing one existing browser input action.\nLatency measures input to the next visual update; settle requires 250 ms of stillness.\nHitches are update gaps above 1.5 display intervals during animation.\nHitch time per second: below 5 ms is smooth, 5–10 minor, above 10 janky.\nLow confidence means few frames, host load or capture overhead; read notes.\nRepeat returns median/worst metrics; one timestamped filmstrip illustrates the run.",
  },
  navigate: {
    riskClass: "external-effect",
    description: "Navigate this thread's ace browser to a URL.",
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
  selection: {
    riskClass: "read-only",
    description: "Read the currently selected page text without running user-supplied scripts.",
  },
  navigation_history: {
    riskClass: "read-only",
    description: "Read whether the current page can go back or forward in Chromium history.",
  },
  history: {
    riskClass: "external-effect",
    description:
      "Go back, forward or reload the page in this thread's ace browser using its real browser history.",
  },
  find_text: {
    riskClass: "read-only",
    description:
      "Find visible text in the page in this thread's ace browser without executing user-supplied scripts.",
  },
  snapshot: {
    riskClass: "read-only",
    description:
      "Read the current page accessibility tree. Use node refs for click/type/press. Refs stay stable within a document and expire on navigation; only the latest snapshot grants actionable refs.",
  },
  screenshot: {
    riskClass: "read-only",
    description: "Read a screenshot of this thread's ace browser.",
  },
  evaluate: {
    riskClass: "external-effect",
    description: "Execute JavaScript in this thread's ace browser page under its evaluate policy.",
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
    description: "Change this thread's ace browser viewport dimensions.",
  },
  emulate: {
    riskClass: "external-effect",
    description: "Change this thread's ace browser's device emulation settings.",
  },
  tabs: {
    riskClass: "external-effect",
    description:
      "List this thread's single browser page. Legacy open reuses it; switch accepts its current id. Close the page with ace_browser_close.",
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
          description: `In this thread's ace browser: ${actions[action].description}`,
          riskClass: actions[action].riskClass,
          input: z.strictObject(
            Object.fromEntries(Object.entries(command.shape).filter(([key]) => key !== "action")),
          ),
          capability: "browser",
          timeoutMs: Math.min(300_000, startupReserveMs + 100_000),
          async run(args, { caller, signal }) {
            signal.throwIfAborted();
            if (action === "measure_interaction") {
              // Registry reconstructs the command object schema, so apply the total-time refinement here.
              validateMeasurementBudget(
                BrowserMeasurementOptions.parse({
                  interaction: args["interaction"],
                  observeMs: args["observeMs"],
                  repeat: args["repeat"],
                  filmstrip: args["filmstrip"],
                }),
              );
            }
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
            if (action === "measure_interaction") {
              const pending = z.object({ pending_dialog: BrowserDialog }).safeParse(result);
              if (pending.success)
                return { content: [{ type: "text", text: JSON.stringify(pending.data) }] };
              const measurement = InteractionMeasurement.parse(result);
              const { filmstrip, ...metrics } = measurement;
              return {
                content: [
                  { type: "text", text: JSON.stringify(metrics) },
                  ...(filmstrip ? [filmstrip] : []),
                ],
              };
            }
            return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
          },
        });
      }
    },
  };
}
