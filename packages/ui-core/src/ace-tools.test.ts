import type { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { aceStep } from "./tool-labels.ts";
import { aceToolLog, groupLine } from "./ace-tool-log.ts";

let ids = 0;
const base = (agentId = "root") => ({
  id: `item-${++ids}`,
  threadId: "thread-1",
  agentId,
  createdAt: ids,
  complete: true,
});

function mcp(
  tool: string,
  args: Record<string, unknown>,
  options: { status?: "succeeded" | "failed"; content?: unknown[]; server?: string } = {},
): Item {
  return {
    ...base(),
    type: "tool_call",
    call: {
      id: `call-${ids}`,
      agentId: "root",
      kind: "mcp",
      title: "mcpToolCall",
      status: options.status ?? "succeeded",
      detail: { kind: "mcp", server: options.server ?? "ace", tool, arguments: args },
      startedAt: ids,
      raw: options.content
        ? [{ type: "mcpToolCall", data: { tool, result: { content: options.content } } }]
        : [],
    },
  } as unknown as Item;
}

function audit(text: string, data: Record<string, unknown> = {}): Item {
  const [action, , mode, outcome] = text.split(" · ");
  return {
    ...base(),
    type: "notice",
    level: outcome === "completed" ? "info" : "warning",
    code: "screen.step",
    text,
    raw: [{ type: "ace.screen.step", data: { sessionId: "s1", action, mode, outcome, ...data } }],
  } as unknown as Item;
}

const failure = (code: string) => [{ type: "text", text: JSON.stringify({ code, message: "x" }) }];

test("key presses read as the keys a Mac shows, from any of the three ways agents name them", () => {
  const app = { app: { bundleId: "com.apple.Safari" } };
  expect(aceStep(mcp("screen_key", { key: "l", modifiers: ["command"] }), app)?.words.past).toBe(
    "Pressed ⌘L in Safari",
  );
  expect(aceStep(mcp("screen_key", { keyCode: 36, modifiers: [] }), app)?.words.past).toBe(
    "Pressed Return in Safari",
  );
  expect(aceStep(mcp("ace_browser_press", { key: "Meta+Shift+T" }))?.words.past).toBe(
    "Pressed ⇧⌘T",
  );
});

test("the daemon's audit names the app and the code a call's failure reads by", () => {
  const items = [
    mcp(
      "screen_type",
      { text: "gmail.com" },
      { status: "failed", content: failure("execution_failed") },
    ),
    audit("text.type · com.apple.Safari · background · focus_changed"),
  ];
  const log = aceToolLog(
    items.map((item) => item.id),
    items,
  );
  // The audit is folded into its call: one row.
  expect(log.rows).toEqual([{ kind: "step", id: items[0]!.id }]);
  const view = aceStep(items[0]!, log.contexts[items[0]!.id]);
  expect(view?.problem).toMatchObject({
    title: "Safari's focus changed while typing; try again",
    code: "focus_changed",
  });
  expect(view?.mark).toEqual({ kind: "app", bundleId: "com.apple.Safari", name: "Safari" });
});

test("a newer daemon's audit links its call and names the app in its data", () => {
  const call = mcp("screen_key", { key: "k" }, { status: "failed" });
  const other = mcp("screen_key", { key: "j" });
  const linked = audit("key.press · display · foreground · not_supported", {
    toolCallId: call.id,
    bundleId: "com.apple.TextEdit",
  });
  const items = [call, other, linked];
  const log = aceToolLog(
    items.map((item) => item.id),
    items,
  );
  expect(aceStep(call, log.contexts[call.id])?.problem?.title).toBe(
    "TextEdit didn't accept that key",
  );
});

test("an audit with no call reads as its own row, and an app's steps group", () => {
  const lone = audit("text.paste · com.apple.Notes · background · clipboard_changed");
  expect(aceStep(lone)?.problem?.title).toBe("The clipboard changed while pasting into Notes");
  const items = [
    mcp("screen_open_app", { bundleId: "com.apple.Notes" }),
    mcp("screen_screenshot", {}),
    lone,
    mcp("ace_browser_navigate", { url: "https://example.com/a" }),
  ];
  const log = aceToolLog(
    items.map((item) => item.id),
    items,
  );
  const [group, after] = log.rows;
  expect(group?.kind === "group" && groupLine(group)).toBe("Used Notes · 3 actions · 1 failed");
  expect(after).toEqual({ kind: "step", id: items[3]!.id });
});

test("ace tools a provider reports as custom, with prefixed names, read the same", () => {
  const custom = {
    ...base(),
    type: "tool_call",
    call: {
      id: "c",
      agentId: "root",
      kind: "custom",
      title: "ace_ace_browser_open",
      status: "succeeded",
      detail: { kind: "custom" },
      startedAt: 1,
      raw: [{ type: "tool", data: { state: { input: { url: "https://github.com/" } } } }],
    },
  } as unknown as Item;
  expect(aceStep(custom)).toMatchObject({
    words: { past: "Opened", target: "github.com" },
    mark: { kind: "site", host: "github.com" },
  });
});

test("a typed error result counts as a failure even when the provider said it succeeded", () => {
  const item = mcp("device_boot", { deviceId: "ios:8A1F3C2E-4B5D-4E6F-9A0B-1C2D3E4F5A6B" });
  if (item.type === "tool_call")
    Object.assign(item.call, { result: { isError: true, content: failure("sdk_missing") } });
  expect(aceStep(item)?.problem?.title).toBe("Xcode or the Android SDK isn't set up");
});

test("other servers' tools are not ace's, and unknown ace tools fall back to their name", () => {
  expect(aceStep(mcp("device_list", {}, { server: "github" }))).toBeUndefined();
  expect(aceStep(mcp("ace_frobnicate", {}))?.words).toMatchObject({
    past: "Used ace",
    target: "frobnicate",
  });
});
