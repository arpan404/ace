import { ScreenUIActResult } from "@ace/protocol";
import { PublicToolError } from "@ace/mcp-server";
import { z } from "zod";
import type { ScreenManager } from "./manager.ts";
import {
  computerUseSchemas,
  screenToolMetadata,
  uiReadRequest,
  type ScreenToolName,
} from "./tool-schemas.ts";

export { computerUseSchemas, screenToolMetadata } from "./tool-schemas.ts";

/** Name, description and JSON input schema for every screen tool. */
export const computerUseTools = Object.entries(screenToolMetadata).map(([name, metadata]) => ({
  name,
  description: metadata.description,
  get inputSchema() {
    return z.toJSONSchema(computerUseSchemas[name as ScreenToolName]);
  },
}));

type Content = (
  | { type: "image"; data: string; mimeType: "image/jpeg" }
  | { type: "text"; text: string }
)[];
const text = (value: unknown): Content => [{ type: "text", text: JSON.stringify(value) }];
const settleTree = { maxNodes: 64, maxDepth: 6 };

/** Session-bound screen tools. The MCP host supplies session and owner from its credential. */
export function computerUseHandler(
  manager: ScreenManager,
  sessionId: string,
  owner: string,
  signal: AbortSignal = new AbortController().signal,
) {
  const check = () => signal.throwIfAborted();
  const settled = (raw: unknown) => settledResult(manager, sessionId, owner, raw);
  return async (
    name: string,
    input: unknown,
  ): Promise<{ content: Content; _meta?: Record<string, unknown> }> => {
    check();
    const raw = z.record(z.string(), z.unknown()).parse(input);
    if (raw["sessionId"] !== undefined && raw["sessionId"] !== sessionId)
      throw new Error("Controller ownership required");
    switch (name) {
      case "screen_measure": {
        const { sessionId: _selected, ...options } = computerUseSchemas.screen_measure.parse(raw);
        const { filmstrip, ...metrics } = await manager.measureInteraction(
          sessionId,
          options,
          owner,
          signal,
        );
        return { content: [...text(metrics), ...(filmstrip ? [filmstrip] : [])] };
      }
      case "screen_screenshot": {
        computerUseSchemas.screen_screenshot.parse(raw);
        const image = await manager.modelScreenshot(sessionId, owner, signal);
        const mode = manager.state(sessionId).mode;
        return {
          _meta: {
            "ace/screen": {
              mode,
              scale: image.scale,
              size: { width: image.width, height: image.height },
            },
          },
          content: [
            { type: "image", data: image.payload.toString("base64"), mimeType: "image/jpeg" },
            {
              type: "text",
              text: `Session ${sessionId}, ${mode} mode, ${image.width}x${image.height}. Divide image pixels by scale ${image.scale} for screen_input points; prefer screen_ui_tree refs.`,
            },
          ],
        };
      }
      case "screen_ui_tree": {
        const request = uiReadRequest(computerUseSchemas.screen_ui_tree.parse(raw));
        const data =
          request.kind === "find"
            ? await manager.uiFind(sessionId, request.options, owner)
            : await manager.uiTree(sessionId, request.options, owner);
        return { content: text({ ...data, mode: manager.state(sessionId).mode }) };
      }
      case "screen_ui_act": {
        const { sessionId: _selected, menu, ...act } = computerUseSchemas.screen_ui_act.parse(raw);
        if (menu) {
          const result = await manager.appOperation(
            sessionId,
            { op: "menu.press", path: menu },
            owner,
            check,
          );
          return { content: text(await settled(result)) };
        }
        const data = await manager.uiAct(sessionId, "agent", act, owner, check);
        const snapshot =
          "snapshot" in data ? undefined : await manager.uiTree(sessionId, settleTree, owner);
        return {
          content: text({
            ...data,
            mode: manager.state(sessionId).mode,
            ...(snapshot ? { snapshot } : {}),
          }),
        };
      }
      case "screen_input": {
        const args = computerUseSchemas.screen_input.parse(raw);
        // Every helper ace ships negotiates protocol v2; v1 model-pixel input is gone.
        if (!manager.state(sessionId).capabilities) throw new PublicToolError("not_supported");
        const result = await manager.input(sessionId, "agent", screenInput(args), owner, check);
        return { content: text(await settled(result)) };
      }
      default:
        throw new Error("Unknown computer-use tool");
    }
  };
}

function screenInput(args: z.output<typeof computerUseSchemas.screen_input>) {
  switch (args.action) {
    case "click":
      return { kind: "pointer.click", x: args.x, y: args.y, button: args.button ?? "left" };
    case "type":
      return { kind: "text.type", text: args.text };
    case "paste":
      return { kind: "text.paste", text: args.text };
    case "key":
      return { kind: "key.press", key: args.key, modifiers: args.modifiers ?? [] };
    case "scroll":
      return { kind: "scroll", x: args.x, y: args.y, dx: args.dx, dy: args.dy };
  }
}

/** An action's outcome plus the UI it settled into, so the agent need not read the tree again. */
export async function settledResult(
  manager: ScreenManager,
  sessionId: string,
  owner: string,
  raw: unknown,
) {
  const result = ScreenUIActResult.partial().parse(raw ?? {});
  const snapshot =
    result.snapshot ??
    (manager.state(sessionId).capabilities?.uiTree
      ? await manager.uiTree(sessionId, settleTree, owner)
      : null);
  return { mode: manager.state(sessionId).mode, ...actionMetadata(raw), snapshot };
}

function actionMetadata(raw: unknown) {
  return z
    .object({
      mode: z.enum(["background", "foreground"]).optional(),
      method: z.string().max(64).optional(),
      warnings: z.array(z.string().max(1024)).max(8).optional(),
      notes: z.array(z.string().max(1024)).max(8).optional(),
    })
    .parse(raw ?? {});
}
