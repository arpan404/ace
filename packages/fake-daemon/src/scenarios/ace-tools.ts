import type { Fact, Key } from "@ace/core";
import type { Scenario } from "../scenario.ts";
import { phoneShot, pageShot, safariShot } from "./ace-tool-shots.ts";
import { endTurn, message, rootAgent, turn } from "./facts.ts";

/*
 * Agents using ace's own tools, as Codex stores them: computer use on Safari (the owner's
 * failures included, with the daemon's `screen.step` audits beside each call), the browser on a
 * sign-in page, and a simulator. Results carry ace's real answer shapes: JSON text parts,
 * `{ code, message, hint }` failures and base64 screenshots.
 */

type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

const failure = (code: string, text: string, hint: string): Content[] => [
  { type: "text", text: JSON.stringify({ code, message: text, hint }) },
];
const json = (value: unknown): Content[] => [{ type: "text", text: JSON.stringify(value) }];
const shot = (data: string, note: string): Content[] => [
  { type: "image", mimeType: "image/png", data },
  { type: "text", text: note },
];

/** One finished call of an ace MCP tool, as Codex's `mcpToolCall` item records it. */
export function aceCall(
  agent: Key,
  item: Key,
  tool: string,
  args: Record<string, unknown>,
  content: Content[],
  failed = false,
): Fact {
  return {
    type: "item.upsert",
    agent,
    item,
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: "mcp",
        title: "mcpToolCall",
        status: failed ? "failed" : "succeeded",
        detail: { kind: "mcp", server: "ace", tool, arguments: args },
        raw: [
          {
            type: "mcpToolCall",
            name: tool,
            data: {
              type: "mcpToolCall",
              id: item,
              server: "ace",
              tool,
              status: failed ? "failed" : "completed",
              arguments: args,
              result: { content },
              error: null,
            },
          },
        ],
      },
    },
  };
}

/** The daemon's audit of one computer-use action (apps/daemon/src/services/screen.ts). */
export function screenAudit(
  agent: Key,
  item: Key,
  action: string,
  bundleId: string,
  mode: "background" | "foreground",
  outcome: string,
): Fact {
  return {
    type: "item.upsert",
    agent,
    item,
    draft: {
      type: "notice",
      complete: true,
      level: outcome === "completed" ? "info" : "warning",
      code: "screen.step",
      text: `${action} · ${bundleId} · ${mode} · ${outcome}`,
      raw: [
        {
          type: "ace.screen.step",
          data: { sessionId: "screen-safari", action, mode, outcome },
        },
      ],
    },
  };
}

const safari = "com.apple.Safari";
const signInTree = {
  mode: "background",
  nodes: [
    {
      ref: "w1",
      role: "window",
      name: "Gmail",
      bounds: { x: 0, y: 0, w: 1280, h: 800 },
      states: [],
      actions: [],
      children: [
        {
          ref: "b7",
          role: "button",
          name: "Sign in",
          bounds: { x: 600, y: 420, w: 80, h: 28 },
          states: [],
          actions: ["press"],
          children: [],
        },
      ],
    },
  ],
  truncated: false,
  root: null,
};

/** The owner's 2026-10-07 thread: Safari refusing background keys, typing losing focus. */
export function aceToolsComputerUse(): Scenario {
  const offscreen = failure(
    "window_offscreen",
    "Target window is outside display bounds",
    "Ask the human to reposition the window.",
  );
  return {
    thread: {
      id: "thread-ace-tools-safari",
      workspaceId: "ace",
      title: "Open Gmail in Safari",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "used-safari",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Open Gmail in Safari and sign me in."),
          aceCall(
            "root",
            "request",
            "screen_request_app",
            {
              bundleId: safari,
              reason: "Open Gmail for you",
            },
            json({ approved: true, bundleId: safari, mode: "background" }),
          ),
          aceCall(
            "root",
            "open",
            "screen_open_app",
            { bundleId: safari },
            json({
              sessionId: "screen-safari",
              target: { kind: "window", bundleId: safari, windowId: 41 },
              mode: "background",
            }),
          ),
          aceCall(
            "root",
            "look",
            "screen_screenshot",
            {},
            shot(safariShot, "Mode: background. Screenshot scale: 2 pixels per target point."),
          ),
          aceCall(
            "root",
            "address",
            "screen_key",
            { key: "l", modifiers: ["command"] },
            failure(
              "not_supported",
              "The installed device or helper does not support this operation",
              "Use an advertised semantic action or check installed helper tools.",
            ),
            true,
          ),
          screenAudit("root", "address-audit", "key.press", safari, "background", "not_supported"),
          aceCall(
            "root",
            "type",
            "screen_type",
            { text: "gmail.com" },
            failure(
              "focus_changed",
              "Background action changed focus or cursor",
              "Restoration is attempted when no human input was observed.",
            ),
            true,
          ),
          screenAudit("root", "type-audit", "text.type", safari, "background", "focus_changed"),
          aceCall("root", "tree", "screen_ui_tree", {}, json(signInTree)),
          aceCall(
            "root",
            "sign-in",
            "screen_ui_act",
            { ref: "b7", action: "press" },
            json({
              mode: "background",
              fallback: false,
            }),
          ),
          screenAudit("root", "sign-in-audit", "press", safari, "background", "completed"),
          aceCall("root", "click", "screen_click", { x: 640, y: 432 }, offscreen, true),
          screenAudit(
            "root",
            "click-audit",
            "pointer.click",
            safari,
            "background",
            "window_offscreen",
          ),
          message(
            "root",
            "answer",
            "assistant",
            "Safari's window is off-screen, so I can't finish signing in. Move it onto a display and I'll continue.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}

/** A sign-in page in ace's browser: refs named by the snapshot, a screenshot, and a refusal. */
export function aceToolsBrowser(): Scenario {
  const snapshot = {
    nodes: [
      {
        id: "1",
        ignored: false,
        role: "RootWebArea",
        name: "Sign in to GitHub",
        children: ["2", "3"],
      },
      {
        id: "2",
        ignored: false,
        role: "textbox",
        name: "Username or email address",
        ref: "e1-12",
        children: [],
      },
      { id: "3", ignored: false, role: "button", name: "Sign in", ref: "e1-13", children: [] },
    ],
    truncated: false,
  };
  return {
    thread: {
      id: "thread-ace-tools-browser",
      workspaceId: "ace",
      title: "Check the GitHub sign-in",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "browsed",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message("root", "ask", "user", "Check that the GitHub sign-in page still works."),
          aceCall(
            "root",
            "open",
            "ace_browser_open",
            { url: "https://github.com/login" },
            json({
              tabId: "tab-1",
              url: "https://github.com/login",
            }),
          ),
          aceCall("root", "snapshot", "ace_browser_snapshot", {}, json(snapshot)),
          aceCall(
            "root",
            "type",
            "ace_browser_type",
            { ref: "e1-12", text: "octocat" },
            json(null),
          ),
          aceCall("root", "click", "ace_browser_click", { ref: "e1-13" }, json(null)),
          aceCall(
            "root",
            "wait",
            "ace_browser_wait_for",
            { url: "https://github.com/sessions/two-factor" },
            json(null),
          ),
          aceCall("root", "shot", "ace_browser_screenshot", {}, [
            { type: "image", mimeType: "image/png", data: pageShot },
          ]),
          aceCall(
            "root",
            "press",
            "ace_browser_press",
            { key: "Meta+L" },
            failure(
              "human_controlled",
              "Browser controlled by human",
              "Wait for handback before input or closing.",
            ),
            true,
          ),
          aceCall(
            "root",
            "notify",
            "ace_notify_user",
            {
              text: "Sign-in reached two-factor; it needs your code.",
            },
            json({ intentId: "notice-1", accepted: true }),
          ),
          message("root", "answer", "assistant", "The sign-in page works up to two-factor."),
          endTurn("root"),
        ],
      },
    ],
  };
}

/** A simulator: listed, booted, an app installed and opened, tapped, and a lost lease. */
export function aceToolsDevices(): Scenario {
  const device = "ios:8A1F3C2E-4B5D-4E6F-9A0B-1C2D3E4F5A6B";
  const on = { deviceId: device };
  return {
    thread: {
      id: "thread-ace-tools-devices",
      workspaceId: "ace",
      title: "Try the Shop app's sign-in",
      provider: "codex",
    },
    steps: [
      {
        kind: "facts",
        label: "used-device",
        facts: [
          rootAgent("codex"),
          turn("root"),
          message(
            "root",
            "ask",
            "user",
            "Install the Shop build on the simulator and try signing in.",
          ),
          aceCall(
            "root",
            "list",
            "device_list",
            {},
            json({
              devices: [
                {
                  id: device,
                  platform: "ios",
                  name: "iPhone 16 Pro",
                  state: "shutdown",
                  runtime: "iOS 26.0",
                },
              ],
            }),
          ),
          aceCall("root", "boot", "device_boot", on, json({ ok: true })),
          aceCall(
            "root",
            "install",
            "device_install",
            {
              ...on,
              path: "/Users/dev/acme/build/Shop.app",
            },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "launch",
            "device_open_app",
            { ...on, appId: "com.acme.Shop" },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "shot",
            "device_screenshot",
            on,
            shot(phoneShot, "Frame 12, 120x240. Input uses target points; frame scale 1."),
          ),
          aceCall(
            "root",
            "find",
            "device_find",
            { ...on, query: { name: "Log in" } },
            json({
              nodes: [
                {
                  ref: "d4",
                  role: "button",
                  name: "Log in",
                  bounds: { x: 30, y: 140, w: 60, h: 16 },
                  states: [],
                  actions: ["press"],
                  children: [],
                },
              ],
              truncated: false,
            }),
          ),
          aceCall(
            "root",
            "tap",
            "device_act",
            { ...on, ref: "d4", action: "press" },
            json({ fallback: false }),
          ),
          aceCall(
            "root",
            "email",
            "device_type",
            { ...on, text: "dev@acme.test" },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "home",
            "device_key",
            { ...on, key: "home" },
            failure(
              "lease_required",
              "Device controller lease required",
              "Ask the user to delegate the device controller again after expiry or takeover.",
            ),
            true,
          ),
          aceCall(
            "root",
            "delegate",
            "delegate_task",
            {
              requestId: "review-1",
              task: "Review the Shop sign-in screen for accessibility labels",
              role: "reviewer",
              provider: "claude",
            },
            json({ intentId: "delegation-1", accepted: true }),
          ),
          message(
            "root",
            "answer",
            "assistant",
            "Signed in up to the password step; the simulator was taken back before I pressed Home.",
          ),
          endTurn("root"),
        ],
      },
    ],
  };
}

/** Every ace-tools thread. */
export function aceTools(): Scenario[] {
  return [aceToolsComputerUse(), aceToolsBrowser(), aceToolsDevices()];
}
