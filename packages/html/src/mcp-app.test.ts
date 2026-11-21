import { expect, test } from "vitest";
import {
  mcpAppInitialized,
  mcpAppLinkConfirm,
  mcpAppPanelUrl,
  mcpAppStep,
  panelConfirmArmMs,
  panelConfirmPressed,
  readMcpAppMessage,
  type McpAppFacts,
} from "./index.ts";

/*
 * An MCP app's page on the host (ADR 0202 §4): only JSON-RPC within the panel bound is read; a
 * page may ask for its app's page tools only; its message and context go to the bot as the
 * page's; a link waits on ace's own line, https only; display modes stay inline; anything else is
 * refused. The page runs in a package panel's sandbox.
 */

const facts: McpAppFacts = {
  title: "Fake",
  tools: [
    { name: "move_card", app: true },
    { name: "archive_board", app: false },
  ],
};
const step = (message: unknown) => {
  const read = readMcpAppMessage(JSON.stringify(message));
  return read && mcpAppStep(read, facts);
};
const request = (method: string, params?: unknown) => ({ jsonrpc: "2.0", id: 4, method, params });

test("only JSON-RPC as text within the bound, or the bridge's own text, is read", () => {
  expect(readMcpAppMessage(request("ping"))).toBeUndefined();
  expect(readMcpAppMessage(JSON.stringify({ method: "ping", id: 1 }))).toBeUndefined();
  expect(
    readMcpAppMessage(JSON.stringify({ type: "ace.panel.action", name: "x" })),
  ).toBeUndefined();
  expect(readMcpAppMessage(JSON.stringify({ type: "ace.panel.pong", n: 3 }))).toEqual({
    type: "ace.panel.pong",
    n: 3,
  });
  const big = JSON.stringify(
    request("ui/message", { role: "user", content: { type: "text", text: "€".repeat(6000) } }),
  );
  expect(readMcpAppMessage(big)).toBeUndefined();
});

test("a page may ask for its app's page tools only, and that goes to the bot as its request", () => {
  expect(step(request("tools/call", { name: "move_card", arguments: { card: 3 } }))).toMatchObject({
    kind: "deliver",
    action: "tools/call",
    value: { name: "move_card", arguments: { card: 3 } },
    answer: { id: 4, result: { content: [{ type: "text" }] } },
  });
  for (const name of ["archive_board", "send_mail"])
    expect(step(request("tools/call", { name }))).toMatchObject({
      kind: "answer",
      message: { id: 4, error: { code: -32602 } },
    });
});

test("a page's message and context go to the bot; links wait on ace's line, https only", () => {
  expect(
    step(request("ui/message", { role: "user", content: { type: "text", text: "Yes, book it" } })),
  ).toMatchObject({ kind: "deliver", action: "ui/message", value: { text: "Yes, book it" } });
  expect(
    step(
      request("ui/update-model-context", {
        content: [{ type: "text", text: "3 cards" }],
        structuredContent: { cards: 3 },
      }),
    ),
  ).toMatchObject({ kind: "deliver", value: { text: "3 cards", structured: { cards: 3 } } });
  expect(step(request("ui/open-link", { url: "https://example.com/a" }))).toEqual({
    kind: "open-link",
    id: 4,
    url: "https://example.com/a",
  });
  for (const url of ["http://example.com/", "javascript:alert(1)", "not a url"])
    expect(step(request("ui/open-link", { url }))).toMatchObject({
      kind: "answer",
      message: { error: { code: -32000 } },
    });
});

test("display modes stay inline and anything the channel lacks is refused", () => {
  expect(step(request("ui/request-display-mode", { mode: "fullscreen" }))).toEqual({
    kind: "answer",
    message: { jsonrpc: "2.0", id: 4, result: { mode: "inline" } },
  });
  for (const method of ["resources/read", "sampling/createMessage", "ui/anything"])
    expect(step(request(method))).toMatchObject({
      kind: "answer",
      message: { error: { code: -32601 } },
    });
  expect(step({ jsonrpc: "2.0", method: "ui/notifications/initialized" })).toEqual({
    kind: "initialized",
  });
  expect(step({ jsonrpc: "2.0", id: 9, result: {} })).toEqual({ kind: "ignore" });
});

test("initialize offers links, server tools and logging, inline only, at MCP Apps 2026-01-26", () => {
  const answer = mcpAppInitialized(1, {
    theme: { colorScheme: "light", foreground: "#111" },
    size: { width: 400.4, height: 600 },
    platform: "web",
  });
  expect(answer).toMatchObject({
    id: 1,
    result: {
      protocolVersion: "2026-01-26",
      hostCapabilities: { openLinks: {}, serverTools: {}, logging: {} },
      hostContext: {
        theme: "light",
        styles: { variables: { "--foreground": "#111" } },
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        containerDimensions: { width: 400, maxHeight: 600 },
      },
    },
  });
});

test("a link opens only on the person's real press after the line arms", () => {
  const line = mcpAppLinkConfirm("Fake", "https://tickets.example.com/x", 1000);
  expect(line.words).toBe("Fake asks to open tickets.example.com (https://tickets.example.com/x).");
  expect(panelConfirmPressed({ trusted: false, at: 5000 }, line)).toBe(false);
  expect(panelConfirmPressed({ trusted: true, at: 1000 + panelConfirmArmMs - 1 }, line)).toBe(
    false,
  );
  expect(panelConfirmPressed({ trusted: true, at: 1000 + panelConfirmArmMs }, line)).toBe(true);
});

test("an app's page is built in the panel sandbox with no network, whatever it declares", () => {
  const url = mcpAppPanelUrl("<!doctype html><html><head></head><body>Board</body></html>", {});
  const outer = decodeURIComponent(url.slice(url.indexOf(",") + 1));
  expect(outer).toContain('sandbox="allow-scripts"');
  expect(outer).toContain("default-src 'none'");
  expect(outer).toContain("connect-src 'none'");
  expect(outer).not.toContain("allow-same-origin");
});
