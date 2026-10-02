import { ScreenAction } from "@ace/protocol";
import { z } from "zod";
import type { ScreenManager } from "./manager.ts";
const Screenshot = z.object({});
const Click = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  button: z.enum(["left", "right"]).default("left"),
});
const Type = z.object({ text: z.string().max(4096) });
const Key = z.object({
  keyCode: z.number().int().min(0).max(127),
  modifiers: z
    .array(z.enum(["command", "shift", "option", "control"]))
    .max(4)
    .default([]),
});
const Scroll = z.object({
  x: z.number().finite().nonnegative(),
  y: z.number().finite().nonnegative(),
  deltaX: z.number().int().min(-1000).max(1000),
  deltaY: z.number().int().min(-1000).max(1000),
});
export const computerUseTools = [
  {
    name: "screen_screenshot",
    description: "Read the latest approved application screenshot",
    inputSchema: z.toJSONSchema(Screenshot),
  },
  {
    name: "screen_click",
    description: "Click at screenshot pixel coordinates in the approved application",
    inputSchema: z.toJSONSchema(Click),
  },
  {
    name: "screen_type",
    description: "Type text in the approved application",
    inputSchema: z.toJSONSchema(Type),
  },
  {
    name: "screen_key",
    description: "Press a macOS virtual key code with modifiers",
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
    let action: unknown;
    switch (name) {
      case "screen_click":
        action = { kind: "click", ...Click.parse(input) };
        break;
      case "screen_type":
        action = { kind: "type", ...Type.parse(input) };
        break;
      case "screen_key":
        action = { kind: "key", ...Key.parse(input) };
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
