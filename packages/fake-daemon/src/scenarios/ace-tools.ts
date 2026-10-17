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
  const facts: Fact[] = [
    rootAgent("codex"),
    turn("root"),
    message("root", "ask", "user", "Open Gmail in Safari and sign me in."),
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
      "screen_input",
      { action: "key", key: "l", modifiers: ["command"] },
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
      "screen_input",
      { action: "type", text: "gmail.com" },
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
    aceCall("root", "click", "screen_input", { action: "click", x: 640, y: 432 }, offscreen, true),
    screenAudit("root", "click-audit", "pointer.click", safari, "background", "window_offscreen"),
    message(
      "root",
      "answer",
      "assistant",
      "Safari's window is off-screen, so I can't finish signing in. Move it onto a display and I'll continue.",
    ),
  ];
  return {
    thread: {
      id: "thread-ace-tools-safari",
      workspaceId: "ace",
      title: "Open Gmail in Safari",
      provider: "codex",
    },
    steps: [
      ...facts.map((fact, index) => ({
        kind: "facts" as const,
        facts: [fact],
        agoMs: Math.round((45_000 * (facts.length - index)) / facts.length),
      })),
      { kind: "facts", label: "used-safari", facts: [endTurn("root")] },
    ],
  };
}

/** A sign-in page in ace's browser: refs named by the snapshot, a screenshot, and a refusal. */
export function aceToolsBrowser(): Scenario {
  // As browser_snapshot answers: one line per meaningful node, refs for the action tools.
  const snapshot = [
    '- document "Sign in to GitHub"',
    '  - textbox "Username or email address" [ref=e1-12]',
    '  - button "Sign in" [ref=e1-13]',
  ].join("\n");
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
            "browser_open",
            { url: "https://github.com/login" },
            json({
              tabId: "tab-1",
              url: "https://github.com/login",
            }),
          ),
          aceCall("root", "snapshot", "browser_snapshot", {}, [{ type: "text", text: snapshot }]),
          aceCall(
            "root",
            "type",
            "browser_act",
            { action: "type", ref: "e1-12", text: "octocat" },
            json(null),
          ),
          aceCall(
            "root",
            "click",
            "browser_act",
            { action: "click", ref: "e1-13" },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "wait",
            "browser_wait_for",
            { url: "https://github.com/sessions/two-factor" },
            json(null),
          ),
          aceCall("root", "shot", "browser_screenshot", {}, [
            { type: "image", mimeType: "image/png", data: pageShot },
          ]),
          aceCall(
            "root",
            "press",
            "browser_act",
            { action: "press", key: "Meta+L" },
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
  const on = { simId: device };
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
            "sim_list",
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
          aceCall("root", "boot", "sim_start", on, json({ ok: true })),
          aceCall(
            "root",
            "install",
            "sim_act",
            {
              ...on,
              action: "install",
              path: "/Users/dev/acme/build/Shop.app",
            },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "launch",
            "sim_act",
            { ...on, action: "open_app", appId: "com.acme.Shop" },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "shot",
            "sim_screenshot",
            on,
            shot(phoneShot, "Frame 12, 120x240. Input uses target points; frame scale 1."),
          ),
          aceCall(
            "root",
            "find",
            "sim_ui",
            { ...on, name: "Log in" },
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
            "sim_act",
            { ...on, action: "ui", ref: "d4", uiAction: "press" },
            json({ fallback: false }),
          ),
          aceCall(
            "root",
            "email",
            "sim_act",
            { ...on, action: "type", text: "dev@acme.test" },
            json({ ok: true }),
          ),
          aceCall(
            "root",
            "home",
            "sim_act",
            { ...on, action: "key", key: "home" },
            failure(
              "lease_required",
              "Device controller lease required",
              "Call sim_start to take the simulator for this thread, then retry.",
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
              role: "review-signin-screen",
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
