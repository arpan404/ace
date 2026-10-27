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
  logsText,
  pageSummary,
  pendingDialog,
  snapshotText,
  tabDevice,
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
const machineName = z
  .string()
  .regex(/^[\w.-]{1,64}$/)
  .optional();
/** The optional `machine` argument every browser tool takes when routing is available. */
export const browserMachineInput = {
  machine: machineName.describe("A paired machine's browser (machines)."),
};
/**
 * The optional `browser` argument every browser tool takes when "Use my Chrome" is available
 * (ADR 0084): ace's own browser, or the person's own Chrome.
 */
const browserName = z.enum(["ace", "user"]).optional();
export const browserChoiceInput = {
  browser: browserName.describe(
    '"user": the person\'s own Chrome, only when the work needs their session; then pass it on every call.',
  ),
};
/**
 * The routing fields are explained once, on the tools where an agent picks its browser and
 * machine; every other tool takes the same fields bare.
 */
const explainedRouting = new Set(["browser_open", "browser_tabs"]);
const routing = (name: string, route: boolean, user: boolean) =>
  explainedRouting.has(name)
    ? { ...(route ? browserMachineInput : {}), ...(user ? browserChoiceInput : {}) }
    : { ...(route ? { machine: machineName } : {}), ...(user ? { browser: browserName } : {}) };

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
      "Load a URL in your tab of the thread's browser, which the person watches; omit url to report your page. Prefer it to web fetch for UI checks, dev servers, console and network. Guide: ace-browser.",
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
      "List, open, select, keep or close this thread's browser tabs; tabs you open close after your turn unless kept.",
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
      'Read the page as lines with refs for browser_act, e.g. `- button "Save" [ref=e3-41]`; refs last until it navigates. Cheaper than a screenshot.',
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
      "Act on the page by ref from browser_snapshot or browser_find. covered or not_hittable: nothing was clicked. After a navigation, browser_wait_for then a new snapshot.",
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
    description: "Wait for exactly one condition; safe after it already happened.",
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
      "Find elements by role and/or name, returning snapshot lines with refs; text instead reports whether it is on the page.",
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
      "See a tab as a JPEG without changing what the person sees. To click image pixel (px, py): x = origin.x + px * scale, y = origin.y + py * scale.",
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
      // The device the tab emulates, so the agent knows the picture is a phone's (ADR 0104).
      const own = await port.tab(caller, tabId, signal);
      signal.throwIfAborted();
      const shown = port.state(caller).tabs?.find((each) => each.tabId === own.tabId);
      const device = shown && !shown.private ? tabDevice(shown.emulation) : {};
      return {
        content: [
          {
            type: "image",
            mimeType: "image/jpeg",
            data: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64"),
          },
          ...(geometry || device.device
            ? [{ type: "text", text: JSON.stringify({ ...geometry, ...device }) }]
            : []),
        ],
      };
    },
  },
  {
    name: "browser_logs",
    title: "Read console and network",
    description:
      "Read recent console and network entries. requestId reads one response body; kind downloads lists downloaded files.",
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
      return run(port, caller, signal, "logs", args, logsText);
    },
  },
  {
    name: "browser_evaluate",
    title: "Run page script",
    description:
      "Evaluate a JavaScript expression in the page and return its JSON value; read-only refuses side effects.",
    riskClass: "external-effect",
    input: browserEvaluateShape,
    timeoutMs: waitTimeoutMs,
    run: (args, caller, port, signal) => run(port, caller, signal, "evaluate", args),
  },
  {
    name: "browser_history",
    title: "Page history",
    description:
      "Go back, forward, reload or stop (direction); without direction, list the tab's history.",
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
      "Resize or emulate a tab, record one to a thread artifact, list extensions, or close the whole browser.",
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
      "Measure frame timing while observing or during one interaction. Hitch ms per second: under 5 smooth, over 10 janky.",
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
          ...routing(tool.name, route !== undefined, user !== undefined),
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
