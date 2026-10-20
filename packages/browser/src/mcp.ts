import { z } from "zod";
import {
  BrowserMeasurementOptions,
  BrowserScreenshotSet,
  BrowserTab,
  InteractionMeasurement,
  browserWaitLimitMs,
  type ApprovalTarget,
  type BrowserState,
} from "@ace/protocol";
import { validateMeasurementBudget } from "@ace/interaction";
import type { Toolkit, ToolContext } from "@ace/mcp-server";
import { PublicToolError } from "@ace/mcp-server/errors";
import {
  browserActShape,
  browserEvaluateShape,
  browserFindShape,
  browserHistoryShape,
  browserLogsShape,
  browserMeasureShape,
  browserOpenShape,
  browserScreenshotShape,
  browserSettingsShape,
  browserSnapshotShape,
  browserTabsShape,
  browserWaitShape,
  checkAct,
  checkScreenshot,
  checkSettings,
  checkTabs,
  checkWait,
} from "./mcp-schemas.ts";
import { agentBrowserError } from "./agent-errors.ts";
import type { AgentScreenshot } from "./session-images.ts";
import {
  findText,
  json,
  pageSummary,
  pendingDialog,
  snapshotText,
  tabEntry,
  type ToolResult,
} from "./mcp-results.ts";

/** The thread an MCP call acts for and, when the provider names one, the calling agent. */
export interface BrowserCaller {
  threadId: string;
  agentId?: string | undefined;
}
export interface BrowserTabRef {
  tabId: string;
  url: string;
  title: string;
}
/**
 * What the tools need from one browser (ace's, or the person's own Chrome): the thread's
 * browser, opened on first use. Commands without `tabId` run in the caller's current tab.
 */
export interface BrowserToolPort {
  /**
   * Opens or joins the thread's browser and returns the caller's own tab: a new one when the
   * tab the person views belongs to another agent. Refuses a tab a person holds privately.
   */
  open(caller: BrowserCaller, signal: AbortSignal): Promise<BrowserTabRef>;
  /** The tab a call runs in, `tabId` or the caller's current tab, opening the browser first. */
  tab(
    caller: BrowserCaller,
    tabId: string | undefined,
    signal: AbortSignal,
  ): Promise<BrowserTabRef>;
  /** The open browser's state; call it after `open` or `tab`. */
  state(caller: BrowserCaller): BrowserState;
  execute(
    caller: BrowserCaller,
    command: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
  /** A model screenshot, with where its pixels lie on the page when the engine can say. */
  screenshot(
    caller: BrowserCaller,
    options: { tabId?: string; fullPage: boolean; ref?: string },
    signal: AbortSignal,
  ): Promise<AgentScreenshot>;
  /** Closes the whole browser and every tab in it. */
  close(caller: BrowserCaller, signal: AbortSignal): Promise<void>;
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
    .describe("Another paired machine's browser (machines); omit for this machine."),
};
/**
 * The optional `browser` argument every browser tool takes when "Use my Chrome" is available
 * (ADR 0084): ace's own browser, or the person's own Chrome.
 */
export const browserChoiceInput = {
  browser: z
    .enum(["ace", "user"])
    .optional()
    .describe(
      'Omit (or "ace") for ace\'s browser, which the person watches in ace. "user": the person\'s own Chrome (Use my Chrome), signed in as them, only for work that needs their session; pass it on every call for that page. Tabs they shared are in browser_tabs list with openedBy human. Not with machine.',
    ),
};

type Risk = NonNullable<ApprovalTarget["riskClass"]>;
type Args = Record<string, unknown>;
interface Tool {
  name: string;
  title: string;
  description: string;
  riskClass: Risk;
  input: z.ZodRawShape;
  /** Cross-field rules, applied after routing fields are added (refined objects cannot be extended). */
  refine?: (input: Args, context: z.RefinementCtx) => void;
  timeoutMs: number;
  run(
    args: Args,
    caller: BrowserCaller,
    port: BrowserToolPort,
    signal: AbortSignal,
  ): Promise<ToolResult>;
}
// The longest wait, its approval reserve, and headroom to report the result.
const waitTimeoutMs = Math.min(300_000, 200_000 + browserWaitLimitMs + 70_000);
const command = (action: string, args: Args = {}) => ({ ...args, action });
const tabOf = (args: Args) => (typeof args["tabId"] === "string" ? args["tabId"] : undefined);
/** Only the fields a command uses: undefined optional fields stay off the wire. */
const defined = (args: Args): Args =>
  Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));

/** Runs one command, turning a pending dialog into instructions instead of a bare object. */
async function run(
  port: BrowserToolPort,
  caller: BrowserCaller,
  signal: AbortSignal,
  action: string,
  args: Args,
  format: (result: unknown) => ToolResult = json,
): Promise<ToolResult> {
  const result = await port.execute(caller, command(action, defined(args)), signal);
  signal.throwIfAborted();
  return pendingDialog(result) ?? format(result);
}
/** The calling agent's view of a tab after a call: its address and the other tabs. */
async function summary(
  port: BrowserToolPort,
  caller: BrowserCaller,
  tabId: string | undefined,
  signal: AbortSignal,
): Promise<ToolResult> {
  const tab = await port.tab(caller, tabId, signal);
  return json(pageSummary(port.state(caller), tab));
}

/** A tab command's answer; `current` marks the caller's own tab. */
const TabsResult = z.object({
  tabs: z.array(BrowserTab.extend({ current: z.boolean().optional() })),
  tabId: z.string().optional(),
});

const tabTools: Tool[] = [
  {
    name: "browser_open",
    title: "Open browser page",
    description:
      "Navigate to a URL or report the current page in this thread's ace browser, a real Chromium the person watches and can take over. Pass url to load it in your tab; omit it to report where you are. Prefer it to web fetch to verify UI, test a dev server, show the person a page, or read console and network. Next: browser_snapshot. How-to: guide ace-browser.",
    riskClass: "external-effect",
    input: browserOpenShape,
    timeoutMs: 300_000,
    async run(args, caller, port, signal) {
      const own = await port.open(caller, signal);
      const tabId = tabOf(args) ?? own.tabId;
      if (typeof args["url"] === "string") {
        const result = await port.execute(
          caller,
          command(
            "navigate",
            defined({
              url: args["url"],
              timeout: args["timeout"],
              waitUntil: args["waitUntil"],
              tabId,
            }),
          ),
          signal,
        );
        const pending = pendingDialog(result);
        if (pending) return pending;
      }
      signal.throwIfAborted();
      return summary(port, caller, tabId, signal);
    },
  },
  {
    name: "browser_tabs",
    title: "Open, switch or close browser tabs",
    description:
      "List, open, select, keep or close tabs in this thread's browser. list shows who opened and drives each tab, which agent works there (inUse), tabs the person keeps agents out of (private), and what waits on the person (pending_auth, certificate_error); current marks yours. open gives you a new labelled tab that becomes your current tab. Tabs you open are temporary and close when your turn ends: pass keep true on open, or action keep with tabId, for a tab the person should still find (a deliverable or handoff). Parallel agents each work in a tab of their own: commands in different tabs run at the same time. Closing the last tab closes the browser.",
    riskClass: "external-effect",
    input: browserTabsShape,
    refine: checkTabs,
    timeoutMs: waitTimeoutMs,
    async run(args, caller, port, signal) {
      const { action, ...rest } = args;
      const result = await port.execute(
        caller,
        command("tabs", defined({ ...rest, operation: action })),
        signal,
      );
      signal.throwIfAborted();
      const pending = pendingDialog(result);
      if (pending) return pending;
      const parsed = TabsResult.safeParse(result);
      // Closing the last tab closes the browser and lists nothing.
      if (!parsed.success)
        return json(action === "close" ? { closed: true, browserClosed: true } : result);
      const { tabs: listed, tabId } = parsed.data;
      const tabs = listed.map(tabEntry);
      if (action === "list") return json({ tabs });
      if (action === "keep") return json({ kept: args["keep"] !== false, tabId: args["tabId"] });
      if (action === "close")
        return json({ closed: true, tabId: args["tabId"], open: tabs.length });
      return json(tabs.find((tab) => tab.tabId === tabId) ?? { tabs });
    },
  },
];

const pageTools: Tool[] = [
  {
    name: "browser_snapshot",
    title: "Read page structure",
    description:
      'Read the page as compact indented text: one line per meaningful element, e.g. `- button "Save" [ref=e3-41]`. Refs feed browser_act and stay valid until the page navigates. At the default size it costs fewer tokens than a screenshot. Large pages are cut at maxNodes: narrow with ref (a container), depth, interactiveOnly or browser_find. A very large page comes back as an outline of landmarks and headings to scope with ref.',
    riskClass: "read-only",
    input: browserSnapshotShape,
    timeoutMs: 60_000,
    run: (args, caller, port, signal) =>
      run(port, caller, signal, "snapshot", args, (result) =>
        snapshotText(result, typeof args["ref"] === "string"),
      ),
  },
  {
    name: "browser_act",
    title: "Act on page element",
    description:
      "Click, type, fill a form, press a key, hover, select, check, uncheck, drag, focus, upload, scroll or answer a dialog, using refs from browser_snapshot or browser_find. A ref is clicked once it holds still and only where it takes the click itself: covered or not_hittable means nothing was clicked. While the person works in the tab, type and fill_form add after their text and leave their caret alone (kept_text), and your input waits while they are busy. Accepting a leave-page dialog on a page the person used fails with unsaved_changes. After an action that navigates, call browser_wait_for, then browser_snapshot for new refs.",
    riskClass: "external-effect",
    input: browserActShape,
    refine: checkAct,
    timeoutMs: waitTimeoutMs,
    async run(args, caller, port, signal) {
      const { action, ...rest } = args;
      if (action === "dialog") return run(port, caller, signal, "dialog", rest);
      const input =
        action === "scroll"
          ? defined({ ...rest, x: rest["x"] ?? 0, y: rest["y"] ?? 0 })
          : defined(rest);
      const before = await port.tab(caller, tabOf(args), signal);
      const result = await port.execute(caller, command(String(action), input), signal);
      const pending = pendingDialog(result);
      if (pending) return pending;
      const after = await port.tab(caller, before.tabId, signal);
      // The command's own facts (kept_text, popups it opened) come with the page's.
      const facts =
        typeof result === "object" && result !== null && !Array.isArray(result)
          ? Object.fromEntries(Object.entries(result).filter(([key]) => key !== "ok"))
          : {};
      return json({
        ok: true,
        ...facts,
        tabId: after.tabId,
        url: after.url,
        ...(after.url !== before.url ? { note: "Page navigated; old refs expired." } : {}),
      });
    },
  },
  {
    name: "browser_wait_for",
    title: "Wait for page",
    description:
      "Wait for a page condition: url, text, an element state, network idle, a fixed time or downloads. url is exact or a glob with * (through DOMContentLoaded); ref takes state visible or hidden; networkIdle means no request in flight for 500 ms; downloads waits for the tab's downloads. Pass exactly one of url, text, ref, networkIdle, timeMs or downloads. Safe to call after the change already happened.",
    riskClass: "read-only",
    input: browserWaitShape,
    refine: checkWait,
    timeoutMs: waitTimeoutMs,
    run: (args, caller, port, signal) => {
      const { downloads, ...rest } = args;
      if (downloads === true)
        return run(port, caller, signal, "downloads", {
          operation: "wait",
          timeout: rest["timeout"],
          tabId: rest["tabId"],
        });
      return run(port, caller, signal, "wait_for", rest);
    },
  },
  {
    name: "browser_find",
    title: "Find page elements",
    description:
      "Find elements by accessible role and/or name (substring, case-insensitive) in every frame and return their snapshot lines with refs, without reading the whole page. With text instead, report whether that visible text is on the page.",
    riskClass: "read-only",
    input: browserFindShape,
    timeoutMs: 60_000,
    run: (args, caller, port, signal) => {
      const { text, query: words, ...named } = args;
      // `query` is how every other *_find tool names its search words; here it is the name.
      const query =
        named["name"] === undefined && words !== undefined ? { ...named, name: words } : named;
      if (typeof text === "string")
        return run(port, caller, signal, "find_text", {
          text,
          forward: true,
          tabId: query["tabId"],
        });
      return run(port, caller, signal, "find", query, findText);
    },
  },
  {
    name: "browser_screenshot",
    title: "Screenshot page",
    description:
      "See one tab as an image (JPEG, at most 1536 px): the viewport, fullPage for the whole page, or ref for one element. It never changes the tab the person sees. Beside the image: its width, height, scale (CSS pixels per image pixel) and origin; to click image pixel (px, py) pass x = origin.x + px * scale, y = origin.y + py * scale. sizes checks a responsive layout instead: one image per size (phone, tablet, desktop), then the tab's own size comes back. format pdf prints the tab to a PDF file and returns its path. Use browser_snapshot to read structure and get refs.",
    riskClass: "read-only",
    input: browserScreenshotShape,
    refine: checkScreenshot,
    timeoutMs: 60_000,
    async run(args, caller, port, signal) {
      const tabId = tabOf(args);
      if (args["format"] === "pdf")
        return run(port, caller, signal, "pdf", {
          tabId,
          landscape: args["landscape"],
          printBackground: args["printBackground"],
        });
      if (Array.isArray(args["sizes"])) {
        const result = await port.execute(
          caller,
          command(
            "screenshot",
            defined({ tabId, sizes: args["sizes"], fullPage: args["fullPage"] }),
          ),
          signal,
        );
        signal.throwIfAborted();
        const set = BrowserScreenshotSet.parse(result);
        return {
          content: set.images.flatMap((image) => [
            { type: "text", text: `${image.size}: ${image.width}×${image.height} CSS px` },
            { type: "image", mimeType: image.mimeType, data: image.data },
          ]),
        };
      }
      const { bytes, geometry } = await port.screenshot(
        caller,
        {
          ...(tabId ? { tabId } : {}),
          fullPage: args["fullPage"] === true,
          ...(typeof args["ref"] === "string" ? { ref: args["ref"] } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
      return {
        content: [
          {
            type: "image",
            mimeType: "image/jpeg",
            data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
          },
          ...(geometry ? [{ type: "text", text: JSON.stringify(geometry) }] : []),
        ],
      };
    },
  },
  {
    name: "browser_logs",
    title: "Read console and network",
    description:
      "Read recent console messages and network requests, filtered by kind, level, url or status. Pass requestId from a network entry to read that response's body (bounded, secrets redacted). kind downloads lists the files the thread's tabs downloaded.",
    riskClass: "read-only",
    input: browserLogsShape,
    timeoutMs: 60_000,
    run: (args, caller, port, signal) => {
      if (typeof args["requestId"] === "string")
        return run(port, caller, signal, "network_body", {
          requestId: args["requestId"],
          tabId: args["tabId"],
        });
      if (args["kind"] === "downloads")
        return run(port, caller, signal, "downloads", {
          operation: "list",
          tabId: args["tabId"],
        });
      return run(port, caller, signal, "logs", args);
    },
  },
  {
    name: "browser_evaluate",
    title: "Run page script",
    description:
      "Evaluate a JavaScript expression in the page and return its JSON value. mode read-only runs in an isolated world and refuses anything with a side effect; use it for reads. Prefer browser_snapshot or browser_find for reading content.",
    riskClass: "external-effect",
    input: browserEvaluateShape,
    timeoutMs: waitTimeoutMs,
    run: (args, caller, port, signal) => run(port, caller, signal, "evaluate", args),
  },
  {
    name: "browser_history",
    title: "Page history",
    description:
      "Go back, forward, reload or stop loading a tab (direction). Without direction, list its recent history entries and whether back/forward work.",
    riskClass: "external-effect",
    input: browserHistoryShape,
    timeoutMs: waitTimeoutMs,
    async run(args, caller, port, signal) {
      if (args["direction"] === undefined)
        return run(port, caller, signal, "navigation_history", { tabId: args["tabId"] });
      const result = await port.execute(caller, command("history", defined(args)), signal);
      return pendingDialog(result) ?? summary(port, caller, tabOf(args), signal);
    },
  },
  {
    name: "browser_settings",
    title: "Browser settings",
    description:
      "Resize a tab, emulate a device, record a tab, list extensions or close the browser. emulate sets scale, mobile, touch, colour scheme and user agent; record_start and record_stop record one tab (yours, or tabId) to a thread artifact.",
    riskClass: "external-effect",
    input: browserSettingsShape,
    refine: checkSettings,
    timeoutMs: 180_000,
    async run(args, caller, port, signal) {
      const { action, tabId, width, height, ...rest } = args;
      if (action === "close") {
        await port.close(caller, signal);
        return json({ closed: true });
      }
      if (action === "resize") return run(port, caller, signal, "resize", { tabId, width, height });
      if (action === "emulate")
        return run(port, caller, signal, "emulate", { tabId, width, height, ...rest });
      if (action === "record_start") return run(port, caller, signal, "record_start", { tabId });
      // A recording stops wherever it runs; extensions belong to the whole browser.
      return run(port, caller, signal, String(action), {});
    },
  },
  {
    name: "browser_measure",
    title: "Measure page smoothness",
    description:
      "Measure page smoothness: frame timing while observing, or while performing one browser_act-style interaction. Latency is input to next visual update; settle needs 250 ms of stillness. Hitch time per second: below 5 ms smooth, 5-10 minor, above 10 janky. Low confidence means few frames, host load or capture overhead; read notes. Repeat returns median/worst metrics plus one timestamped filmstrip.",
    riskClass: "external-effect",
    input: browserMeasureShape,
    timeoutMs: waitTimeoutMs,
    async run(args, caller, port, signal) {
      const { tabId, ...options } = args;
      validateMeasurementBudget(BrowserMeasurementOptions.parse(defined(options)));
      const result = await port.execute(
        caller,
        command("measure_interaction", defined(args)),
        signal,
      );
      signal.throwIfAborted();
      const pending = pendingDialog(result);
      if (pending) return pending;
      const { filmstrip, ...metrics } = InteractionMeasurement.parse(result);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...(tabId ? { tabId } : {}), ...metrics }) },
          ...(filmstrip ? [filmstrip] : []),
        ],
      };
    },
  },
];

/**
 * Agents act in the thread's browser, in tabs of their own; a person's takeover of a tab pauses
 * agents there until handback. With `route`, every tool takes `machine`; with `user`, `browser`.
 */
export function browserToolkit(
  port: BrowserToolPort,
  route?: BrowserMachineRoute,
  /** The person's own Chrome (ADR 0084), for calls with `browser: "user"`. */
  user?: BrowserToolPort,
): Toolkit {
  return {
    register(registry) {
      for (const tool of [...tabTools, ...pageTools]) {
        const shape = z.strictObject({
          ...tool.input,
          ...(route ? browserMachineInput : {}),
          ...(user ? browserChoiceInput : {}),
        });
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
            const { machine, browser, ...args } = z.record(z.string(), z.unknown()).parse(raw);
            // The person's Chrome is on this machine and never stands in for ace's browser.
            if (browser === "user" && (typeof machine === "string" || !user))
              throw new PublicToolError("user_browser_unavailable");
            if (route && typeof machine === "string")
              return route(
                { machine, tool: tool.name, args, timeoutMs: tool.timeoutMs - 5_000 },
                context,
              );
            const target = browser === "user" && user ? user : port;
            try {
              return await tool.run(
                args,
                { threadId: caller.threadId, agentId: caller.agentId },
                target,
                signal,
              );
            } catch (error) {
              // Engine failures with a meaning reach the agent as their code and a next step.
              throw agentBrowserError(error);
            }
          },
        });
      }
    },
  };
}
