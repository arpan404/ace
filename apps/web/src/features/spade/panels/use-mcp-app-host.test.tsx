import { panelConfirmArmMs } from "@ace/html";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { useMcpAppHost } from "./use-mcp-app-host.ts";

/*
 * An MCP app's page as an open panel (ADR 0202 §4): after it initializes it gets its tool's
 * input and result; its tool calls (its page tools only), messages and context go on as the
 * page's; a link it asks to open waits on ace's own line and opens only on a real press after the
 * line arms; anything the channel lacks is refused to the page. jsdom can't make a real press, so
 * the test stands in for the browser's word on it at that one boundary, as it does for the clock.
 */

function host() {
  let now = 1000;
  const delivered: [string, unknown][] = [];
  const opened: string[] = [];
  const toPage: unknown[] = [];
  const real = new WeakSet<Event>();
  const view = renderHook(() =>
    useMcpAppHost({
      facts: {
        title: "Fake",
        tools: [
          { name: "move_card", app: true },
          { name: "archive_board", app: false },
        ],
      },
      state: {
        input: { say: "sprint 4" },
        result: { content: [{ type: "text", text: "3 cards" }] },
      },
      theme: { colorScheme: "dark" },
      size: { width: 360, height: 640 },
      platform: "web",
      onDeliver: (action, value) => delivered.push([action, value]),
      onOpenLink: (url) => opened.push(url),
      now: () => now,
      trusted: (event) => real.has(event),
    }),
  );
  act(() => view.result.current.channel.onReady((message) => toPage.push(message)));
  return {
    view,
    delivered,
    opened,
    toPage,
    later: (ms: number) => (now += ms),
    sent: (message: unknown) =>
      act(() => view.result.current.channel.onMessage(JSON.stringify(message))),
    realPress: () => {
      const event = new MouseEvent("click");
      real.add(event);
      return event;
    },
  };
}

const request = (id: number, method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});

test("an initialized page gets its tool's input and result, after the host's answer", () => {
  const h = host();
  h.sent(request(1, "ui/initialize", { protocolVersion: "2026-01-26" }));
  expect(h.toPage).toMatchObject([{ id: 1, result: { protocolVersion: "2026-01-26" } }]);
  // Nothing more until the page says it's ready.
  expect(h.toPage).toHaveLength(1);
  h.sent({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
  expect(h.toPage.slice(1)).toEqual([
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-input",
      params: { arguments: { say: "sprint 4" } },
    },
    {
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { content: [{ type: "text", text: "3 cards" }] },
    },
  ]);
});

test("what the page asks goes on as the page's, its page tools only", () => {
  const h = host();
  h.sent(request(2, "tools/call", { name: "move_card", arguments: { card: 3 } }));
  h.sent(request(3, "tools/call", { name: "archive_board" }));
  h.sent(request(4, "ui/message", { role: "user", content: { type: "text", text: "Book it" } }));
  h.sent(request(5, "resources/read", { uri: "ui://other" }));
  expect(h.delivered).toEqual([
    ["tools/call", { name: "move_card", arguments: { card: 3 } }],
    ["ui/message", { text: "Book it" }],
  ]);
  expect(h.toPage).toMatchObject([
    { id: 2, result: {} },
    { id: 3, error: { code: -32602 } },
    { id: 4, result: {} },
    { id: 5, error: { code: -32601 } },
  ]);
});

test("a link opens only on a real press of ace's line once it has shown", () => {
  const h = host();
  h.sent(request(6, "ui/open-link", { url: "https://tickets.example.com/t/1" }));
  const line = () => h.view.result.current.confirm;
  expect(line()?.words).toBe(
    "Fake asks to open tickets.example.com (https://tickets.example.com/t/1).",
  );
  // Another link while one waits is refused, and doesn't replace it.
  h.sent(request(7, "ui/open-link", { url: "https://elsewhere.example.com/" }));
  expect(h.toPage).toMatchObject([{ id: 7, error: { message: "Link opening denied by user" } }]);
  h.later(panelConfirmArmMs - 1);
  act(() => line()?.press(h.realPress()));
  h.later(panelConfirmArmMs);
  act(() => line()?.press(new MouseEvent("click")));
  expect(h.opened).toEqual([]);
  act(() => line()?.press(h.realPress()));
  expect(h.opened).toEqual(["https://tickets.example.com/t/1"]);
  expect(h.toPage).toMatchObject([{ id: 7 }, { id: 6, result: {} }]);
  expect(line()).toBeUndefined();
});

test("a link the person cancels never opens and the page hears it was denied", () => {
  const h = host();
  h.sent(request(8, "ui/open-link", { url: "https://tickets.example.com/" }));
  act(() => h.view.result.current.confirm?.cancel());
  expect(h.opened).toEqual([]);
  expect(h.toPage).toMatchObject([{ id: 8, error: { message: "Link opening denied by user" } }]);
});
