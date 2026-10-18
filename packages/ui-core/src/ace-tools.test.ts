import type { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import { aceStep } from "./tool-labels.ts";
import { aceToolLog } from "./ace-tool-log.ts";

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

test("key presses read as the keys a Mac shows, from either way agents name them", () => {
  const app = { app: { bundleId: "com.apple.Safari" } };
  expect(
    aceStep(mcp("screen_input", { action: "key", key: "l", modifiers: ["command"] }), app)?.words
      .past,
  ).toBe("Pressed ⌘L in Safari");
  expect(aceStep(mcp("browser_act", { action: "press", key: "Meta+Shift+T" }))?.words.past).toBe(
    "Pressed ⇧⌘T",
  );
});

const past = (tool: string, args: Record<string, unknown>) => aceStep(mcp(tool, args))?.words.past;
test("a merged browser, screen or simulator tool reads by the action it was asked for", () => {
  expect(past("browser_act", { action: "type", text: "Ada" })).toBe("Typed “Ada”");
  expect(past("browser_act", { action: "uncheck", ref: "e1-2" })).toBe("Unchecked a box");
  expect(past("browser_act", { action: "dialog", dialogId: "d", accept: false })).toBe(
    "Dismissed a dialog",
  );
  expect(past("browser_history", {})).toBe("Checked the page history");
  expect(past("browser_history", { direction: "back" })).toBe("Went back");
  expect(past("browser_settings", { action: "resize", width: 390, height: 844 })).toBe(
    "Resized the browser to 390×844",
  );
  expect(past("browser_logs", { requestId: "r1" })).toBe("Read a network response");
  expect(past("browser_find", { text: "Sign in" })).toBe("Searched the page for “Sign in”");
  expect(past("screen_input", { action: "paste", text: "hello" })).toBe("Pasted “hello”");
  expect(past("screen_ui_act", { menu: ["File", "New Window"] })).toBe(
    "Clicked “File › New Window”",
  );
  expect(past("screen_ui_tree", { name: "Save" })).toBe("Looked for “Save”");
  expect(past("sim_act", { action: "swipe", x: 1, y: 2, toX: 3, toY: 4 })).toBe(
    "Swiped on the simulator",
  );
  expect(past("sim_act", { action: "key", key: "home" })).toBe("Pressed Home on the simulator");
});

test("a later browser action names the element a text snapshot listed for its ref", () => {
  const snapshot = mcp(
    "browser_snapshot",
    {},
    {
      content: [{ type: "text", text: '- document "Drafts"\n  - button "Save draft" [ref=e3-41]' }],
    },
  );
  const click = mcp("browser_act", { action: "click", ref: "e3-41" });
  const items = [snapshot, click];
  const log = aceToolLog(
    items.map((item) => item.id),
    items,
  );
  expect(aceStep(click, log.contexts[click.id])?.words.past).toBe("Clicked “Save draft”");
});

test("the daemon's audit names the app and the code a call's failure reads by", () => {
  const items = [
    mcp(
      "screen_input",
      { action: "type", text: "gmail.com" },
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
  const call = mcp("screen_input", { action: "key", key: "k" }, { status: "failed" });
  const other = mcp("screen_input", { action: "key", key: "j" });
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
    mcp("browser_open", { url: "https://example.com/a" }),
  ];
  const log = aceToolLog(
    items.map((item) => item.id),
    items,
  );
  const [group, after] = log.rows;
  expect(group).toMatchObject({ kind: "group", label: "Used Notes", actions: 3, failed: 1 });
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
      title: "ace_browser_open",
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
  const item = mcp("sim_start", { simId: "ios:8A1F3C2E-4B5D-4E6F-9A0B-1C2D3E4F5A6B" });
  if (item.type === "tool_call")
    Object.assign(item.call, { result: { isError: true, content: failure("sdk_missing") } });
  expect(aceStep(item)?.problem?.title).toBe("Xcode or the Android SDK isn't set up");
});

test("other servers' tools are not ace's, and unknown ace tools fall back to their name", () => {
  expect(aceStep(mcp("sim_list", {}, { server: "github" }))).toBeUndefined();
  // Playwright's MCP also names its tools browser_*; only ace's server makes them ace's.
  expect(aceStep(mcp("browser_snapshot", {}, { server: "playwright" }))).toBeUndefined();
  expect(aceStep(mcp("ace_frobnicate", {}))?.words).toMatchObject({
    past: "Used ace",
    target: "frobnicate",
  });
});

test("a call made on another paired machine names that machine on its row", () => {
  const opened = aceStep(
    mcp("browser_open", { url: "https://docs.example.test/start", machine: "studio" }),
  )?.words;
  expect(opened?.past).toMatch(/^On studio, /);
  expect(opened?.target).toContain("docs.example.test");
  expect(
    aceStep(
      mcp("delegate", {
        tasks: [
          { requestId: "r1", task: "Review the release notes", role: "w", machine: "studio" },
        ],
      }),
    )?.words.past,
  ).toBe("Delegated “Review the release notes” on studio");
  expect(aceStep(mcp("browser_snapshot", {}))?.words.past).not.toContain("studio");
});

const controlWords = (args: Record<string, unknown>) =>
  aceStep(mcp("mcp__ace__thread_control", args, { server: "claude" }))?.words.past;

test("a Claude-spelled thread_control call reads as the action it took", () => {
  const words = controlWords;
  expect(words({ action: "rename", title: "Login flow" })).toBe(
    "Renamed the thread to “Login flow”",
  );
  expect(words({ action: "rename" })).toBe("Retitled the thread");
  expect(words({ action: "fork", requestId: "r" })).toBe("Forked a thread");
  expect(words({ action: "interrupt", requestId: "r" })).toBe("Stopped a thread");
  expect(words({ action: "snooze", until: null })).toBe("Unmuted a thread");
  expect(words({ action: "rename_project", name: "Billing" })).toBe(
    "Renamed the project to “Billing”",
  );
});

test("delegating several tasks counts them; one task quotes its words", () => {
  const tasks = [
    { requestId: "a", task: "Write the parser", role: "parser" },
    { requestId: "b", task: "Write the tests", role: "tests" },
  ];
  expect(aceStep(mcp("delegate", { tasks }))?.words.past).toBe("Delegated 2 tasks");
  expect(aceStep(mcp("delegate", { tasks: tasks.slice(0, 1) }))?.words.past).toBe(
    "Delegated “Write the parser”",
  );
});

const messageWords = (delivery: string) =>
  aceStep(mcp("agent_message", { threadId: "t", requestId: "r", text: "Use v2", delivery }))?.words;

test("a message to a subagent reads by how it is delivered", () => {
  const message = messageWords;
  expect(message("queue")).toMatchObject({ past: "Messaged a subagent", target: "Use v2" });
  expect(message("steer")?.past).toBe("Steered a subagent");
  expect(message("restart")?.past).toBe("Restarted a subagent");
});

test("linking and unlinking a PR read from the one link tool and its answer", () => {
  expect(aceStep(mcp("thread_link_pr", { number: 12 }))?.words.past).toBe("Linked PR #12");
  expect(aceStep(mcp("thread_link_pr", { unlink: true, all: true }))?.words.past).toBe(
    "Unlinked all PRs",
  );
  const answered = mcp("thread_link_pr", { unlink: true, url: "https://x.test/o/r/pull/7" });
  if (answered.type === "tool_call")
    Object.assign(answered.call, {
      result: { structuredContent: { ok: true, data: { number: 7 } }, content: [] },
    });
  expect(aceStep(answered)).toMatchObject({
    words: { past: "Unlinked PR #7" },
    mark: { glyph: "pr" },
  });
});

test("an old ace_-prefixed browser tool and its bare name read alike", () => {
  const url = { url: "https://github.com/" };
  expect(aceStep(mcp("ace_browser_open", url))?.words).toEqual(
    aceStep(mcp("browser_open", url))?.words,
  );
  expect(aceStep(mcp("browser_open", url))?.words).toMatchObject({ target: "github.com" });
});
