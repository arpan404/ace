import { z } from "zod";
import {
  BrowserCommand,
  BrowserMeasurementOptions,
  InteractionMeasurement,
  BrowserDialog,
  browserWaitLimitMs,
} from "@ace/protocol";
import type { ApprovalTarget } from "@ace/protocol";
import { validateMeasurementBudget } from "@ace/interaction";
import type { BrowserToolkit } from "@ace/mcp-server";
import type { BrowserService } from "./service.ts";
/** Browser actions only a person drives (ADR 0082). */
type AgentAction = Exclude<BrowserCommand["action"], "annotate" | "annotate_capture">;
function agentAction(action: BrowserCommand["action"]): action is AgentAction {
  return action !== "annotate" && action !== "annotate_capture";
}
const actions = {
  measure_interaction: {
    riskClass: "external-effect",
    description:
      "Measure frame timing while observing or performing one existing browser input action.\nLatency measures input to the next visual update; settle requires 250 ms of stillness.\nHitches are update gaps above 1.5 display intervals during animation.\nHitch time per second: below 5 ms is smooth, 5–10 minor, above 10 janky.\nLow confidence means few frames, host load or capture overhead; read notes.\nRepeat returns median/worst metrics; one timestamped filmstrip illustrates the run.",
  },
  navigate: {
    riskClass: "external-effect",
    description:
      "Navigate a tab of this thread's ace browser to a URL (your current tab, or tabId).",
  },
  click: {
    riskClass: "external-effect",
    description:
      "Click a ref from ace_browser_snapshot, or a point x, y in CSS pixels (with button, clickCount, modifiers). After a navigation-triggering click, wait_for url or text, then snapshot again. Old document refs expire.",
  },
  fill_form: {
    riskClass: "external-effect",
    description:
      "Fill several text fields in one call: fields is a list of {ref, value} from the latest snapshot; each value replaces the field's text. Use select or check for other controls.",
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
    description:
      "Read a screenshot of one tab without changing what the person sees: the viewport, fullPage for the whole page, or ref for one element.",
  },
  pdf: {
    riskClass: "read-only",
    description: "Print a tab to a PDF file and return its path.",
  },
  downloads: {
    riskClass: "read-only",
    description:
      "List what this thread's tabs downloaded (with tabId, only that tab's), or operation wait to wait until downloads finish.",
  },
  extensions: {
    riskClass: "read-only",
    description: "List the browser extensions installed in ace's browser. Read-only.",
  },
  evaluate: {
    riskClass: "external-effect",
    description: "Execute JavaScript in this thread's ace browser page.",
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
      "Tabs of this thread's ace browser. list: every tab with tabId, url, title, label, openedBy, drivenBy, lease, lifecycle, loading, pending_dialog; current marks yours. open: a new tab (optional url and label) that becomes your current tab. select: make tabId your current tab. close: close tabId. Parallel agents: each open a labelled tab and pass its tabId to every browser tool.",
  },
  upload: {
    riskClass: "external-effect",
    description:
      "Set a file input ref with files from the workspace, thread artifacts or other local paths.",
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
      "Start recording the tab the person is viewing, using the artifact pipeline. Private takeover excludes frames.",
  },
  record_stop: {
    riskClass: "external-effect",
    description: "Stop recording and announce a thread artifact.",
  },
} satisfies Record<
  AgentAction,
  { riskClass: NonNullable<ApprovalTarget["riskClass"]>; description: string }
>;

/**
 * Sends a browser tool to another paired machine's browser (ADR 0078). That machine runs it
 * with its own origin consent; this side passes the tool, its arguments and whether it reads.
 */
export type BrowserMachineRoute = (
  call: {
    machine: string;
    tool: string;
    args: Record<string, unknown>;
    timeoutMs: number;
  },
  context: import("@ace/mcp-server").ToolContext,
) => Promise<unknown>;
/** The optional `machine` argument every browser tool takes when routing is available. */
export const browserMachineInput = {
  machine: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
    .optional()
    .describe("Another paired machine's browser (ace_machines); omit for this machine."),
};

/** Agents act in the thread's browser; a person's takeover still pauses them until handback. */
export function browserToolkit(
  service: Pick<BrowserService, "execute" | "screenshot">,
  startupReserveMs = 0,
  route?: BrowserMachineRoute,
): BrowserToolkit {
  return {
    capability: "browser",
    register(registry) {
      for (const command of BrowserCommand.options) {
        // Annotate mode is the person's (ADR 0082); agents get no tool for it.
        if (!("shape" in command)) continue;
        const action = command.shape.action.value;
        if (!agentAction(action)) continue;
        // The longest wait, its 65 s approval reserve, and headroom to report the result.
        const timeoutMs = Math.min(300_000, startupReserveMs + browserWaitLimitMs + 70_000);
        const name = `ace_browser_${action}`;
        registry.registerContent({
          name,
          // The ace_browser_ name already says which browser; the action says what it does.
          description: actions[action].description,
          riskClass: actions[action].riskClass,
          input: z.strictObject<Record<string, z.ZodType>>({
            ...Object.fromEntries(
              Object.entries(command.shape).filter(([key]) => key !== "action"),
            ),
            ...(route ? browserMachineInput : {}),
          }),
          capability: "browser",
          timeoutMs,
          async run(input, context) {
            const { caller, signal } = context;
            signal.throwIfAborted();
            const { machine, ...args } = input;
            if (route && typeof machine === "string")
              return route(
                {
                  machine,
                  tool: name,
                  args,
                  timeoutMs: timeoutMs - 5_000,
                },
                context,
              );
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
            const actor = { kind: "agent" as const, agentId: caller.agentId };
            if (action === "screenshot") {
              const bytes = await service.screenshot(
                caller.threadId,
                signal,
                typeof args["tabId"] === "string" ? args["tabId"] : undefined,
                {
                  fullPage: args["fullPage"] === true,
                  ...(typeof args["ref"] === "string" ? { ref: args["ref"] } : {}),
                },
                actor,
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
              actor,
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
