import { z } from "zod";
import {
  BrowserMeasurementOptions,
  InteractionMeasurement,
  browserWaitLimitMs,
  type ApprovalTarget,
  type BrowserState,
} from "@ace/protocol";
import { validateMeasurementBudget } from "@ace/interaction";
import type { Toolkit, ToolContext } from "@ace/mcp-server";
import {
  browserActShape,
  browserEvaluateShape,
  browserFindShape,
  browserHistoryShape,
  browserLogsShape,
  browserMeasureShape,
  browserOpenShape,
  browserSettingsShape,
  browserSnapshotShape,
  browserWaitShape,
  checkAct,
  checkSettings,
} from "./mcp-schemas.ts";
import {
  findText,
  json,
  pageSummary,
  pendingDialog,
  snapshotText,
  type ToolResult,
} from "./mcp-results.ts";

/** What the tools need from the daemon: the thread's browser, opened on first use. */
export interface BrowserToolPort {
  /** Opens or joins the thread's page; refuses while a person holds it privately. */
  open(threadId: string, signal: AbortSignal): Promise<BrowserState>;
  execute(
    threadId: string,
    command: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  screenshot(threadId: string, signal: AbortSignal): Promise<Uint8Array>;
  close(threadId: string, signal: AbortSignal): Promise<void>;
}

/**
 * Sends a browser tool to another paired machine's browser (ADR 0078). That machine runs it
 * with its own origin consent; this side passes the tool, its arguments and whether it reads.
 */
export type BrowserMachineRoute = (
  call: { machine: string; tool: string; args: Record<string, unknown>; timeoutMs: number },
  context: ToolContext,
) => Promise<unknown>;
/** The optional `machine` argument every browser tool takes when routing is available. */
export const browserMachineInput = {
  machine: z
    .string()
    .regex(/^[a-zA-Z0-9_.-]{1,64}$/)
    .optional()
    .describe("Another paired machine's browser (ace_machines); omit for this machine."),
};

type Risk = NonNullable<ApprovalTarget["riskClass"]>;
interface Tool {
  name: string;
  title: string;
  description: string;
  riskClass: Risk;
  input: z.ZodRawShape;
  /** Cross-field rules, applied after `machine` is added (refined objects cannot be extended). */
  refine?: (input: Record<string, unknown>, context: z.RefinementCtx) => void;
  timeoutMs: number;
  run(args: Record<string, unknown>, threadId: string, signal: AbortSignal): Promise<ToolResult>;
}
// The longest wait, its approval reserve, and headroom to report the result.
const waitTimeoutMs = Math.min(300_000, 200_000 + browserWaitLimitMs + 70_000);
const command = (action: string, args: Record<string, unknown> = {}) => ({ ...args, action });

function tools(port: BrowserToolPort): Tool[] {
  /** Runs one command, turning a pending dialog into instructions instead of a bare object. */
  const run = async (
    threadId: string,
    signal: AbortSignal,
    action: string,
    args: Record<string, unknown>,
    format: (result: unknown) => ToolResult = json,
  ) => {
    const result = await port.execute(threadId, command(action, args), signal);
    signal.throwIfAborted();
    return pendingDialog(result) ?? format(result);
  };
  return [
    {
      name: "browser_open",
      title: "Open browser page",
      description:
        "Open or join this thread's ace browser: a real Chromium page the person watches live in ace and can take over. Pass url (http/https, localhost included) to load it; omit it to report the current page and tabs; pass tabId to switch tabs. Prefer it to web fetch when you need to verify UI, test a dev server, show the person a page, or read console and network. Next: browser_snapshot. Guide: ace_guide ace-browser.",
      riskClass: "external-effect",
      input: browserOpenShape,
      timeoutMs: 300_000,
      async run(args, threadId, signal) {
        await port.open(threadId, signal);
        if (typeof args["tabId"] === "string")
          await port.execute(
            threadId,
            command("tabs", { operation: "switch", tabId: args["tabId"] }),
            signal,
          );
        if (typeof args["url"] === "string") {
          const result = await port.execute(
            threadId,
            command("navigate", { url: args["url"], timeout: args["timeout"] }),
            signal,
          );
          const pending = pendingDialog(result);
          if (pending) return pending;
        }
        signal.throwIfAborted();
        return json(pageSummary(await port.open(threadId, signal)));
      },
    },
    {
      name: "browser_snapshot",
      title: "Read page structure",
      description:
        'Read the page as compact indented text: one line per meaningful element, e.g. `- button "Save" [ref=e3-41]`. Refs feed browser_act and stay valid until the page navigates. At the default size it costs fewer tokens than a screenshot. Large pages are cut at maxNodes: narrow with ref (a container), interactiveOnly or browser_find.',
      riskClass: "read-only",
      input: browserSnapshotShape,
      timeoutMs: 60_000,
      run: (args, threadId, signal) =>
        run(threadId, signal, "snapshot", args, (result) =>
          snapshotText(result, typeof args["ref"] === "string"),
        ),
    },
    {
      name: "browser_act",
      title: "Act on page element",
      description:
        "Click, type, press a key, hover, select, check, uncheck, drag, focus, upload, scroll or answer a dialog, using refs from browser_snapshot or browser_find. After an action that navigates, call browser_wait_for, then browser_snapshot for new refs.",
      riskClass: "external-effect",
      input: browserActShape,
      refine: checkAct,
      timeoutMs: waitTimeoutMs,
      async run(args, threadId, signal) {
        const { action, ...rest } = args;
        if (action === "dialog") return run(threadId, signal, "dialog", rest);
        const input = action === "scroll" ? { x: rest["x"] ?? 0, y: rest["y"] ?? 0 } : rest;
        const before = (await port.open(threadId, signal)).url;
        const result = await port.execute(threadId, command(String(action), input), signal);
        const pending = pendingDialog(result);
        if (pending) return pending;
        const after = (await port.open(threadId, signal)).url;
        return json({
          ok: true,
          url: after,
          ...(after !== before ? { note: "Page navigated; old refs expired." } : {}),
        });
      },
    },
    {
      name: "browser_wait_for",
      title: "Wait for page",
      description:
        "Wait until the page reaches url (loaded through DOMContentLoaded), shows text, or ref reaches state visible/hidden. Pass exactly one of url, text or ref. Safe to call after the change already happened.",
      riskClass: "read-only",
      input: browserWaitShape,
      timeoutMs: waitTimeoutMs,
      run: (args, threadId, signal) => run(threadId, signal, "wait_for", args),
    },
    {
      name: "browser_find",
      title: "Find page elements",
      description:
        "Find elements by accessible role and/or name (substring, case-insensitive) in every frame and return their snapshot lines with refs, without reading the whole page. With text instead, report whether that visible text is on the page.",
      riskClass: "read-only",
      input: browserFindShape,
      timeoutMs: 60_000,
      run: (args, threadId, signal) => {
        const { text, ...query } = args;
        if (typeof text === "string")
          return run(threadId, signal, "find_text", { text, forward: true });
        return run(threadId, signal, "find", query, findText);
      },
    },
    {
      name: "browser_screenshot",
      title: "Screenshot page",
      description:
        "See the visible viewport as an image (JPEG, at most 1536 px). Use it to check layout and visuals; use browser_snapshot to read structure and get refs.",
      riskClass: "read-only",
      input: {},
      timeoutMs: 60_000,
      async run(_args, threadId, signal) {
        const bytes = await port.screenshot(threadId, signal);
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
      },
    },
    {
      name: "browser_logs",
      title: "Read console and network",
      description:
        "Read recent console messages and network requests, filtered by kind, level, url or status. Pass requestId from a network entry to read that response's body (bounded, secrets redacted).",
      riskClass: "read-only",
      input: browserLogsShape,
      timeoutMs: 60_000,
      run: (args, threadId, signal) =>
        typeof args["requestId"] === "string"
          ? run(threadId, signal, "network_body", { requestId: args["requestId"] })
          : run(threadId, signal, "logs", args),
    },
    {
      name: "browser_evaluate",
      title: "Run page script",
      description:
        "Evaluate a JavaScript expression in the page and return its JSON value. Use mode read-only for reads. Prefer browser_snapshot or browser_find for reading content.",
      riskClass: "external-effect",
      input: browserEvaluateShape,
      timeoutMs: waitTimeoutMs,
      run: (args, threadId, signal) => run(threadId, signal, "evaluate", args),
    },
    {
      name: "browser_history",
      title: "Page history",
      description:
        "Without direction, list the page's recent history entries and whether back/forward work. With direction, go back, forward, reload or stop loading.",
      riskClass: "external-effect",
      input: browserHistoryShape,
      timeoutMs: waitTimeoutMs,
      async run(args, threadId, signal) {
        if (args["direction"] === undefined) return run(threadId, signal, "navigation_history", {});
        const result = await port.execute(threadId, command("history", args), signal);
        return pendingDialog(result) ?? json(pageSummary(await port.open(threadId, signal)));
      },
    },
    {
      name: "browser_settings",
      title: "Browser settings",
      description:
        "Resize the viewport, emulate a device (scale, mobile, touch, colour scheme), start or stop a recording attached to the thread, or close the browser.",
      riskClass: "external-effect",
      input: browserSettingsShape,
      refine: checkSettings,
      timeoutMs: 180_000,
      async run(args, threadId, signal) {
        const { action, ...rest } = args;
        if (action === "close") {
          await port.close(threadId, signal);
          return json({ closed: true });
        }
        if (action === "resize")
          return run(threadId, signal, "resize", { width: rest["width"], height: rest["height"] });
        return run(threadId, signal, String(action), action === "emulate" ? rest : {});
      },
    },
    {
      name: "browser_measure",
      title: "Measure page smoothness",
      description:
        "Measure frame timing while observing, or while performing one browser_act-style interaction.\nLatency is input to next visual update; settle needs 250 ms of stillness.\nHitch time per second: below 5 ms smooth, 5-10 minor, above 10 janky.\nLow confidence means few frames, host load or capture overhead; read notes.\nRepeat returns median/worst metrics plus one timestamped filmstrip.",
      riskClass: "external-effect",
      input: browserMeasureShape,
      timeoutMs: waitTimeoutMs,
      async run(args, threadId, signal) {
        validateMeasurementBudget(BrowserMeasurementOptions.parse(args));
        const result = await port.execute(threadId, command("measure_interaction", args), signal);
        signal.throwIfAborted();
        const pending = pendingDialog(result);
        if (pending) return pending;
        const { filmstrip, ...metrics } = InteractionMeasurement.parse(result);
        return {
          content: [
            { type: "text", text: JSON.stringify(metrics) },
            ...(filmstrip ? [filmstrip] : []),
          ],
        };
      },
    },
  ];
}

/** Agents act in the thread's browser; a person's takeover still pauses them until handback. */
export function browserToolkit(port: BrowserToolPort, route?: BrowserMachineRoute): Toolkit {
  return {
    register(registry) {
      for (const tool of tools(port)) {
        const shape = z.strictObject({ ...tool.input, ...(route ? browserMachineInput : {}) });
        const input = tool.refine ? shape.superRefine(tool.refine) : shape;
        registry.registerContent({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          riskClass: tool.riskClass,
          input,
          capability: "browser",
          timeoutMs: tool.timeoutMs,
          async run(raw, context) {
            const { caller, signal } = context;
            signal.throwIfAborted();
            const { machine, ...args } = z.record(z.string(), z.unknown()).parse(raw);
            if (route && typeof machine === "string")
              return route(
                { machine, tool: tool.name, args, timeoutMs: tool.timeoutMs - 5_000 },
                context,
              );
            return tool.run(args, caller.threadId, signal);
          },
        });
      }
    },
  };
}
