import {
  ScreenAction,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
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
const PortableKey = z.object({
  key: z.string().min(1).max(64),
  modifiers: z
    .array(z.enum(["control", "shift", "alt", "meta"]))
    .max(4)
    .default([]),
});
const Key = z.union([PortableKey, LegacyKey]);
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
      "Use this first to inspect the approved window. Prefer semantic refs and actions to pixel clicks. Screenshots are for visual checks.",
    inputSchema: z.toJSONSchema(ScreenUITreeOptions),
  },
  {
    name: "screen_ui_find",
    description:
      "Find controls by role, name or text without sending the whole UI tree. Use returned refs for semantic actions.",
    inputSchema: z.toJSONSchema(ScreenUIFindOptions),
  },
  {
    name: "screen_ui_act",
    description:
      "Act on a UI ref using its supported semantic action. The reply reports any input fallback.",
    inputSchema: z.toJSONSchema(ScreenUIActOptions),
  },
  {
    name: "screen_screenshot",
    description: "Check the approved window visually. Use screen_ui_tree first to inspect controls",
    inputSchema: z.toJSONSchema(Screenshot),
  },
  {
    name: "screen_click",
    description:
      "Prefer screen_ui_act with a UI ref. Click target-local points on v2 or screenshot pixels on legacy macOS",
    inputSchema: z.toJSONSchema(Click),
  },
  {
    name: "screen_type",
    description: "Type text in the approved application",
    inputSchema: z.toJSONSchema(Type),
  },
  {
    name: "screen_key",
    description:
      "Press a portable named key with modifiers on v2. Legacy macOS keyCode is supported on v1",
    inputSchema: z.toJSONSchema(Key),
  },
  {
    name: "screen_scroll",
    description: "Scroll at target-local points on v2 or screenshot pixels on legacy macOS",
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
    if (name === "screen_ui_tree" || name === "screen_ui_find" || name === "screen_ui_act") {
      const result =
        name === "screen_ui_tree"
          ? await manager.uiTree(sessionId, input, owner)
          : name === "screen_ui_find"
            ? await manager.uiFind(sessionId, input, owner)
            : await manager.uiAct(sessionId, input, owner);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    if (name === "screen_screenshot") {
      Screenshot.parse(input);
      const frame = await manager.screenshotFresh(sessionId);
      return {
        content: [
          {
            type: "image",
            data: frame.payload.toString("base64"),
            mimeType: "image/jpeg",
          },
          ...(frame.header.scale === undefined
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Screenshot scale: ${frame.header.scale} pixels per target point. Divide screenshot coordinates by this scale for input; prefer UI refs.`,
                },
              ]),
        ],
      };
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
        {
          const key = Key.parse(input);
          if ("key" in key) {
            await manager.keyPress(sessionId, key.key, key.modifiers, owner);
            return { content: [{ type: "text", text: "Action completed" }] };
          }
          action = { kind: "key", ...key };
        }
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
