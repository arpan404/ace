import {
  ScreenAction,
  ScreenUITreeInput,
  ScreenUIFindInput,
  ScreenUIActInput,
  ScreenNamedKey,
} from "@ace/protocol";
import { z } from "zod";
import type { ScreenManager } from "./manager.ts";
const Screenshot = z.object({});
const Click = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  button: z.enum(["left", "right"]).default("left"),
});
const Type = z.object({ text: z.string().max(4096) });
const LegacyKey = z.object({
  keyCode: z.number().int().min(0).max(127),
  modifiers: z
    .array(z.enum(["command", "shift", "option", "control"]))
    .max(4)
    .default([]),
});
const Key = z.union([ScreenNamedKey, LegacyKey]);
const Scroll = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  deltaX: z.number().int().min(-1000).max(1000),
  deltaY: z.number().int().min(-1000).max(1000),
});
export const computerUseTools = [
  {
    name: "screen_ui_tree",
    description:
      "Inspect the approved application's accessibility tree first, before screenshots or coordinate clicks. Stable refs allow reliable semantic actions.",
    inputSchema: z.toJSONSchema(ScreenUITreeInput),
  },
  {
    name: "screen_ui_find",
    description:
      "Find accessible controls by role, name or text without sending the whole tree. Use returned refs with screen_ui_act.",
    inputSchema: z.toJSONSchema(ScreenUIFindInput),
  },
  {
    name: "screen_ui_act",
    description:
      "Act on a stable accessibility ref. Prefer semantic press, focus and setValue over pixel clicks. Reports when pointer fallback was needed.",
    inputSchema: z.toJSONSchema(ScreenUIActInput),
  },
  {
    name: "screen_screenshot",
    description:
      "Use screen_ui_tree first. Read the latest approved application screenshot for visual checks",
    inputSchema: z.toJSONSchema(Screenshot),
  },
  {
    name: "screen_click",
    description:
      "Use screen_ui_act first. Click at screenshot pixel coordinates only for visual controls",
    inputSchema: z.toJSONSchema(Click),
  },
  {
    name: "screen_type",
    description: "Type text in the approved application",
    inputSchema: z.toJSONSchema(Type),
  },
  {
    name: "screen_key",
    description: "Press a named key with modifiers; legacy macOS helpers accept keyCode",
    inputSchema: z.toJSONSchema(Key),
  },
  {
    name: "screen_scroll",
    description: "Scroll at screenshot pixel coordinates",
    inputSchema: z.toJSONSchema(Scroll),
  },
];
/** The MCP host supplies a session and owner from its scoped credential, never tool arguments. */
export function computerUseHandler(manager: ScreenManager, sessionId: string, owner: string) {
  return async (
    name: string,
    input: unknown,
  ): Promise<{
    content: (
      | { type: "image"; data: string; mimeType: "image/jpeg" }
      | { type: "text"; text: string }
    )[];
  }> => {
    if (name === "screen_screenshot") {
      Screenshot.parse(input);
      return {
        content: [
          {
            type: "image",
            data: manager.screenshot(sessionId).payload.toString("base64"),
            mimeType: "image/jpeg",
          },
        ],
      };
    }
    const uiOperation =
      name === "screen_ui_tree"
        ? "ui.tree"
        : name === "screen_ui_find"
          ? "ui.find"
          : name === "screen_ui_act"
            ? "ui.act"
            : undefined;
    if (uiOperation) {
      let result: unknown;
      if (uiOperation === "ui.tree")
        result = await manager.ui(
          sessionId,
          { op: uiOperation, ...ScreenUITreeInput.parse(input) },
          "agent",
          owner,
        );
      else if (uiOperation === "ui.find")
        result = await manager.ui(
          sessionId,
          { op: uiOperation, ...ScreenUIFindInput.parse(input) },
          "agent",
          owner,
        );
      else
        result = await manager.ui(
          sessionId,
          { op: uiOperation, ...ScreenUIActInput.parse(input) },
          "agent",
          owner,
        );
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (name === "screen_key") {
      const key = Key.parse(input);
      if ("key" in key) {
        await manager.namedKey(sessionId, key, owner);
        return { content: [{ type: "text", text: "Action completed" }] };
      }
    }
    let action: unknown;
    switch (name) {
      case "screen_click":
        action = { kind: "click", ...Click.parse(input) };
        break;
      case "screen_type":
        action = { kind: "type", ...Type.parse(input) };
        break;
      case "screen_key":
        action = { kind: "key", ...LegacyKey.parse(input) };
        break;
      case "screen_scroll":
        action = { kind: "scroll", ...Scroll.parse(input) };
        break;
      default:
        throw new Error("Unknown computer-use tool");
    }
    await manager.action(sessionId, "agent", ScreenAction.parse(action), owner);
    return { content: [{ type: "text", text: "Action completed" }] };
  };
}
