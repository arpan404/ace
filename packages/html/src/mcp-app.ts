import {
  McpAppMessage,
  McpAppModelContext,
  McpAppOpenLink,
  McpAppPageMessage,
  McpAppToolCall,
  mcpAppsVersion,
  PanelPageMessage,
  type McpAppHostMessage,
} from "@ace/protocol";
import { themeMessage, type HtmlTheme } from "./document.ts";
import type { PanelConfirm } from "./panel.ts";
import { panelText } from "./scripts.ts";

/*
 * The host's half of an MCP app's page shown as a Spade panel (ADR 0202 §4, MCP Apps
 * 2026-01-26), mapped onto the panel channel: every message is JSON text within the panel bound,
 * then JSON-RPC 2.0, then one of the few methods the host takes. A page's `tools/call` (only for
 * a tool its app offers to pages), `ui/message` and `ui/update-model-context` go to the bot as the
 * page's requests, never the person's; `ui/open-link` waits on ace's own line outside the page,
 * where only the person's real press opens it, https only; display modes stay inline; every other
 * request is refused. Pure: the caller sends and delivers.
 */

/** The page bridge's own text: the watchdog's answer and a fault. */
export type McpAppOwnMessage = { type: "ace.panel.pong"; n: number } | { type: "ace.panel.fault" };

/** A page message the host reads: JSON text within the bound, JSON-RPC or the bridge's own. */
export function readMcpAppMessage(raw: unknown): McpAppPageMessage | McpAppOwnMessage | undefined {
  const text = panelText(raw);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (parsed && typeof parsed === "object" && "type" in parsed) {
    const own = PanelPageMessage.safeParse(parsed);
    if (!own.success) return undefined;
    if (own.data.type === "ace.panel.fault" || own.data.type === "ace.panel.pong") return own.data;
    return undefined;
  }
  const read = McpAppPageMessage.safeParse(parsed);
  return read.success ? read.data : undefined;
}

/** What the host knows of the page's app. */
export interface McpAppFacts {
  /** The app's name, shown on ace's line. */
  title: string;
  /** The app's tools and whether each is offered to its page. */
  tools: readonly { name: string; app: boolean }[];
}

/** A request the page sends that reaches the bot as the page's. */
export type McpAppDelivery = "tools/call" | "ui/message" | "ui/update-model-context";

/** What the host does with one message from the page. */
export type McpAppStep =
  | { kind: "answer"; message: McpAppHostMessage }
  | { kind: "initialize"; id: string | number }
  | { kind: "initialized" }
  | {
      kind: "deliver";
      id: string | number;
      action: McpAppDelivery;
      value: unknown;
      answer: McpAppHostMessage;
    }
  | { kind: "open-link"; id: string | number; url: string }
  | { kind: "pong"; n: number }
  | { kind: "fault" }
  | { kind: "ignore" };

const error = (id: string | number, code: number, message: string): McpAppHostMessage => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});
const result = (id: string | number, value: unknown): McpAppHostMessage => ({
  jsonrpc: "2.0",
  id,
  result: value,
});
const texts = (content: { text: string } | readonly { text: string }[] | undefined) =>
  content === undefined
    ? undefined
    : (Array.isArray(content) ? content : [content]).map((block) => block.text).join("\n");

/** What the host does with `message` from the page of `facts`' app. */
export function mcpAppStep(
  message: McpAppPageMessage | McpAppOwnMessage,
  facts: McpAppFacts,
): McpAppStep {
  if ("type" in message)
    return message.type === "ace.panel.pong" ? { kind: "pong", n: message.n } : { kind: "fault" };
  if (!("method" in message)) return { kind: "ignore" };
  if (!("id" in message))
    return message.method === "ui/notifications/initialized"
      ? { kind: "initialized" }
      : { kind: "ignore" };
  const { id, method, params } = message;
  switch (method) {
    case "ui/initialize":
      return { kind: "initialize", id };
    case "ping":
      return { kind: "answer", message: result(id, {}) };
    case "ui/request-display-mode":
      // Within panel bounds: always inline, never full screen or picture in picture.
      return { kind: "answer", message: result(id, { mode: "inline" }) };
    case "tools/call": {
      const call = McpAppToolCall.safeParse(params);
      if (!call.success) return { kind: "answer", message: error(id, -32602, "Invalid params") };
      const offered = facts.tools.some((tool) => tool.name === call.data.name && tool.app);
      if (!offered)
        return {
          kind: "answer",
          message: error(id, -32602, `${call.data.name} isn't offered to this page.`),
        };
      return {
        kind: "deliver",
        id,
        action: "tools/call",
        value: { name: call.data.name, arguments: call.data.arguments ?? {} },
        answer: result(id, {
          content: [
            {
              type: "text",
              text: "Sent to the bot as this page's request. It decides; if the tool runs, its result comes back here.",
            },
          ],
        }),
      };
    }
    case "ui/message": {
      const sent = McpAppMessage.safeParse(params);
      if (!sent.success)
        return { kind: "answer", message: error(id, -32000, "Invalid message format") };
      return {
        kind: "deliver",
        id,
        action: "ui/message",
        value: { text: texts(sent.data.content) },
        answer: result(id, {}),
      };
    }
    case "ui/update-model-context": {
      const context = McpAppModelContext.safeParse(params);
      if (!context.success)
        return { kind: "answer", message: error(id, -32000, "Invalid context format") };
      const text = texts(context.data.content);
      return {
        kind: "deliver",
        id,
        action: "ui/update-model-context",
        value: {
          ...(text === undefined ? {} : { text }),
          ...(context.data.structuredContent === undefined
            ? {}
            : { structured: context.data.structuredContent }),
        },
        answer: result(id, {}),
      };
    }
    case "ui/open-link": {
      const link = McpAppOpenLink.safeParse(params);
      let url: URL | undefined;
      try {
        url = link.success ? new URL(link.data.url) : undefined;
      } catch {
        url = undefined;
      }
      if (url?.protocol !== "https:")
        return { kind: "answer", message: error(id, -32000, "Only https links open from a page.") };
      return { kind: "open-link", id, url: url.href };
    }
    default:
      return {
        kind: "answer",
        message: error(id, -32601, `${method} isn't offered to pages here.`),
      };
  }
}

/** Where the page is drawn, for its host context. */
export interface McpAppPlace {
  theme: HtmlTheme;
  size: { width: number; height: number };
  platform: "web" | "desktop";
}

function hostContext(place: McpAppPlace) {
  const tokens = themeMessage(place.theme).tokens;
  return {
    theme: place.theme.colorScheme ?? "dark",
    styles: {
      variables: Object.fromEntries(
        Object.entries(tokens).flatMap(([name, value]) =>
          value === undefined ? [] : [[`--${name}`, value]],
        ),
      ),
    },
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: {
      width: Math.round(place.size.width),
      maxHeight: Math.round(place.size.height),
    },
    platform: place.platform,
  };
}

/** The answer to the page's `ui/initialize`: what ace offers it, and where it is drawn. */
export function mcpAppInitialized(id: string | number, place: McpAppPlace): McpAppHostMessage {
  return result(id, {
    protocolVersion: mcpAppsVersion,
    hostInfo: { name: "ace", version: "1" },
    hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
    hostContext: hostContext(place),
  });
}

export function mcpAppContextChanged(place: McpAppPlace): McpAppHostMessage {
  return {
    jsonrpc: "2.0",
    method: "ui/notifications/host-context-changed",
    params: hostContext(place),
  };
}

export function mcpAppToolInput(input: unknown): McpAppHostMessage {
  const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: args } };
}

export function mcpAppToolResult(output: unknown): McpAppHostMessage {
  return { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: output ?? {} };
}

/** The answer to a link the person opened, or didn't. */
/** What the page hears when the panel's budget for its requests is spent. */
export function mcpAppBusy(id: string | number): McpAppHostMessage {
  return error(id, -32000, "Too many requests from the page; wait a moment.");
}

export function mcpAppLinkAnswer(id: string | number, opened: boolean): McpAppHostMessage {
  return opened ? result(id, {}) : error(id, -32000, "Link opening denied by user");
}

/** ace's line for a link the page asks to open: the app, the link's host, the whole link. */
export function mcpAppLinkConfirm(title: string, url: string, shownAt: number): PanelConfirm {
  const host = new URL(url).host;
  const shown = url.length > 80 ? `${url.slice(0, 79)}…` : url;
  return {
    name: "ui/open-link",
    value: url,
    words: `${title} asks to open ${host} (${shown}).`,
    shownAt,
  };
}
