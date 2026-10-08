import type { Fact } from "@ace/core";
import { ItemId, type ProviderKind, type ToolResult } from "@ace/protocol";
import type { Scenario } from "../scenario.ts";
import { fixtureImage } from "../attachment-fixture.ts";
import { rootAgent, turn, endTurn, message } from "./facts.ts";

const providers = ["claude", "codex", "opencode", "pi", "cursor", "acp"] as const;
export const aceToolThreadIds = providers.map((provider) => `thread-ace-tools-${provider}`);
const target = { bundleId: "com.apple.TextEdit", windowId: 7, displayName: "TextEdit" };
const screenshot: ToolResult["content"][number] = {
  type: "image",
  attachment: {
    sha256: fixtureImage.sha256,
    name: "screen.png",
    mimeType: "image/png",
    bytes:
      Math.floor((fixtureImage.data.length * 3) / 4) -
      (fixtureImage.data.endsWith("==") ? 2 : fixtureImage.data.endsWith("=") ? 1 : 0),
    width: 120,
    height: 80,
    thumbnailAvailable: true,
  },
};
function call(
  provider: ProviderKind,
  key: string,
  name: string,
  args: Record<string, unknown>,
  result: ToolResult,
): Fact {
  const nativeName =
    provider === "claude" ? `mcp__ace__${name}` : provider === "opencode" ? `ace_${name}` : name;
  const custom = ["opencode", "pi", "acp"].includes(provider);
  const native =
    provider === "claude"
      ? { type: "tool_use", name: nativeName, input: args }
      : provider === "opencode"
        ? { type: "session.tool.called", data: { name: nativeName, input: args } }
        : provider === "pi"
          ? { type: "tool_execution_start", toolName: name, args }
          : provider === "acp"
            ? { title: name, rawInput: args }
            : provider === "cursor"
              ? { toolCall: { type: "mcp", args: { server: "ace", tool: name, arguments: args } } }
              : { type: "mcpToolCall", server: "ace", tool: name, arguments: args };
  return {
    type: "item.upsert",
    agent: "root",
    item: key,
    draft: {
      type: "tool_call",
      complete: true,
      call: {
        kind: custom ? "custom" : "mcp",
        title: nativeName,
        status: result.isError ? "failed" : "succeeded",
        detail: custom
          ? { kind: "custom" }
          : { kind: "mcp", server: "ace", tool: name, arguments: args },
        result,
        ...(result.isError ? { error: "Background action changed focus or cursor" } : {}),
        raw: [{ type: `${provider}.tool`, name: nativeName, data: native }],
      },
    },
  };
}
function notice(key: string, action: string, result: ToolResult): Fact {
  return {
    type: "item.upsert",
    agent: "root",
    item: `notice-${key}`,
    draft: {
      type: "notice",
      complete: true,
      level: result.isError ? "warning" : "info",
      code: "screen.step",
      toolCallId: ItemId.parse(key),
      text: `${action} · TextEdit · ${result.mode} · ${result.isError ? "focus_changed" : "completed"}`,
      raw: [
        {
          type: "ace.screen.step",
          data: {
            toolCallId: key,
            action,
            ...target,
            mode: result.mode,
            outcome: result.isError ? "focus_changed" : "completed",
          },
        },
      ],
    },
  };
}
/** Provider-shaped calls converge to the same rows, with daemon evidence and linked notices. */
export function aceToolRows(): Scenario[] {
  return providers.map((provider) => {
    const image: ToolResult = {
      isError: false,
      content: [screenshot, { type: "text", text: "Captured the selected window" }],
      durationMs: 42,
      target,
      mode: "background",
      scale: 1,
      size: { width: 120, height: 80 },
    };
    const failure: ToolResult = {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            code: "focus_changed",
            message: "Background action changed focus or cursor",
            hint: "Refresh the UI tree before retrying.",
            detail: "Text destination changed",
          }),
        },
      ],
      durationMs: 18,
      target,
      mode: "background",
    };
    const foreground: ToolResult = {
      isError: false,
      content: [{ type: "text", text: "Foreground control approved" }],
      structuredContent: { mode: "foreground" },
      durationMs: 1200,
      target,
      mode: "foreground",
    };
    return {
      thread: {
        id: `thread-ace-tools-${provider}`,
        workspaceId: "acme",
        title: `Capture the document window · ${provider}`,
        provider,
      },
      steps: [
        {
          kind: "facts",
          facts: [
            rootAgent(provider),
            turn("root"),
            message("root", "ask", "user", "Capture the document and check the text field."),
            call(provider, "capture", "screen_screenshot", {}, image),
            notice("capture", "screen_screenshot", image),
            call(provider, "click", "screen_click", { x: 24, y: 16 }, failure),
            notice("click", "screen_click", failure),
            call(
              provider,
              "foreground",
              "screen_request_foreground",
              { reason: "Confirm the text destination" },
              foreground,
            ),
            notice("foreground", "screen_request_foreground", foreground),
            call(
              provider,
              "device",
              "device_screenshot",
              { deviceId: "android:fixture" },
              { ...image, target: undefined },
            ),
            call(
              provider,
              "browser",
              "ace_browser_screenshot",
              {},
              { ...image, target: undefined },
            ),
            message(
              "root",
              "done",
              "assistant",
              "Captured the window. The text destination changed before input, so I refreshed it.",
            ),
            endTurn("root"),
          ],
        },
      ],
    };
  });
}
