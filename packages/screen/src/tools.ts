import { modelImage } from "@ace/mcp-server";
import {
  ScreenAction,
  ScreenInput,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
} from "@ace/protocol";
import { z } from "zod";
import type { ScreenManager } from "./manager.ts";
const Screenshot = z.strictObject({});
const [ClickAction, TypeAction, KeyAction, ScrollAction] = ScreenAction.options;
const Click = ClickAction.omit({ kind: true }).strict();
const Type = TypeAction.omit({ kind: true }).strict();
const [, , , PointKey, , PointScroll] = ScreenInput.options;
const Key = z.union([
  KeyAction.omit({ kind: true }).strict(),
  PointKey.omit({ kind: true }).strict(),
]);
const Scroll = z.union([
  ScrollAction.omit({ kind: true }).strict(),
  PointScroll.omit({ kind: true }).strict(),
]);
export const computerUseSchemas = {
  screen_ui_tree: ScreenUITreeOptions.strict(),
  screen_ui_find: ScreenUIFindOptions.strict(),
  screen_ui_act: ScreenUIActOptions.strict(),
  screen_screenshot: Screenshot,
  screen_click: Click,
  screen_type: Type,
  screen_key: Key,
  screen_scroll: Scroll,
};
export const computerUseTools = [
  {
    name: "screen_ui_tree",
    description:
      "Use first: inspect the approved app's bounded accessibility tree with stable refs. Prefer semantic actions to pixel clicks.",
    inputSchema: z.toJSONSchema(computerUseSchemas.screen_ui_tree),
  },
  {
    name: "screen_ui_find",
    description:
      "Find accessible elements by role, name or text without requesting the entire tree. Use before screenshot searches.",
    inputSchema: z.toJSONSchema(computerUseSchemas.screen_ui_find),
  },
  {
    name: "screen_ui_act",
    description:
      "Act on a stable element ref using the OS accessibility API. Reply states whether synthesized input was needed.",
    inputSchema: z.toJSONSchema(computerUseSchemas.screen_ui_act),
  },
  {
    name: "screen_screenshot",
    description:
      "Visual check only: inspect the approved app. Use screen_ui_tree or screen_ui_find first; screenshots cost more tokens.",
    inputSchema: z.toJSONSchema(Screenshot),
  },
  {
    name: "screen_click",
    description:
      "Prefer screen_ui_act. Click at target-window points with v2, or screenshot pixels with v1.",
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
      "Press a named key with v2 (for example Enter), or a legacy macOS keyCode, with modifiers.",
    inputSchema: z.toJSONSchema(Key),
  },
  {
    name: "screen_scroll",
    description:
      "Scroll with v2 dx/dy at optional target-window points, or legacy pixel coordinates and deltaX/deltaY.",
    inputSchema: z.toJSONSchema(Scroll),
  },
];
/** The MCP host supplies a session and owner from its scoped credential, never tool arguments. */
export function computerUseHandler(
  manager: ScreenManager,
  sessionId: string,
  owner: string,
  signal: AbortSignal = new AbortController().signal,
) {
  return async (
    name: string,
    input: unknown,
  ): Promise<{
    content: (
      | { type: "image"; data: string; mimeType: "image/jpeg" }
      | { type: "text"; text: string }
    )[];
  }> => {
    signal.throwIfAborted();
    if (name === "screen_screenshot") {
      Screenshot.parse(input);
      const frame = await manager.captureScreenshot(sessionId);
      const image = await modelImage({ payload: frame.payload, ...frame.header }, signal);
      return {
        content: [
          {
            type: "image",
            data: image.payload.toString("base64"),
            mimeType: "image/jpeg",
          },
          ...(image.scale === undefined
            ? []
            : [
                {
                  type: "text" as const,
                  text: `Screenshot scale: ${image.scale} pixels per target point. Divide screenshot coordinates by this scale for input; prefer UI refs.`,
                },
              ]),
        ],
      };
    }
    if (name === "screen_ui_tree" || name === "screen_ui_find" || name === "screen_ui_act") {
      const data =
        name === "screen_ui_tree"
          ? await manager.uiTree(sessionId, input, owner)
          : name === "screen_ui_find"
            ? await manager.uiFind(sessionId, input, owner)
            : await manager.uiAct(sessionId, "agent", input, owner, () => signal.throwIfAborted());
      return { content: [{ type: "text", text: JSON.stringify(data) }] };
    }
    let action: unknown;
    let v2: unknown;
    const negotiated = manager.state(sessionId).capabilities !== undefined;
    switch (name) {
      case "screen_click":
        action = { kind: "click", ...Click.parse(input) };
        if (negotiated) v2 = { kind: "pointer.click", ...Click.parse(input) };
        break;
      case "screen_type":
        action = { kind: "type", ...Type.parse(input) };
        if (negotiated) v2 = { kind: "text.type", ...Type.parse(input) };
        break;
      case "screen_key":
        {
          const key = Key.parse(input);
          if ("key" in key) v2 = { kind: "key.press", ...key };
          else action = { kind: "key", ...key };
        }
        break;
      case "screen_scroll":
        {
          const scroll = Scroll.parse(input);
          if ("dx" in scroll) v2 = { kind: "scroll", ...scroll };
          else if (negotiated)
            v2 = { kind: "scroll", x: scroll.x, y: scroll.y, dx: scroll.deltaX, dy: scroll.deltaY };
          else action = { kind: "scroll", ...scroll };
        }
        break;
      default:
        throw new Error("Unknown computer-use tool");
    }
    if (v2) await manager.input(sessionId, "agent", v2, owner, () => signal.throwIfAborted());
    else
      await manager.action(sessionId, "agent", ScreenAction.parse(action), owner, () =>
        signal.throwIfAborted(),
      );
    return { content: [{ type: "text", text: "Action completed" }] };
  };
}
