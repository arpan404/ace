import {
  ScreenMeasurementOptions,
  ScreenAction,
  ScreenId,
  ScreenBundle,
  ScreenInput,
  ScreenUITreeOptions,
  ScreenUIFindOptions,
  ScreenUIActOptions,
  ScreenUIActResult,
  ScreenAppURL,
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
const SessionSelection = { sessionId: ScreenId.optional() };
export const computerUseSchemas = {
  screen_measure_interaction: ScreenMeasurementOptions.extend(SessionSelection).strict(),
  screen_ui_tree: ScreenUITreeOptions.extend(SessionSelection).strict(),
  screen_ui_find: ScreenUIFindOptions.extend(SessionSelection).strict(),
  screen_ui_act: ScreenUIActOptions.extend(SessionSelection).strict(),
  screen_screenshot: Screenshot.extend(SessionSelection),
  screen_click: Click.extend(SessionSelection),
  screen_type: Type.extend(SessionSelection),
  screen_key: z.union(Key.options.map((schema) => schema.extend(SessionSelection))),
  screen_scroll: z.union(Scroll.options.map((schema) => schema.extend(SessionSelection))),
  screen_paste: Type.extend(SessionSelection),
  screen_request_app: z.strictObject({
    bundleId: ScreenBundle,
    reason: z.string().min(1).max(2048),
  }),
  screen_open_app: z.strictObject({
    bundleId: ScreenBundle,
    windowId: z.number().int().positive().optional(),
  }),
  screen_list_windows: z.strictObject({ bundleId: ScreenBundle }),
  screen_select_window: z.strictObject({
    ...SessionSelection,
    windowId: z.number().int().positive(),
  }),
  screen_open_url: z.strictObject({
    ...SessionSelection,
    url: ScreenAppURL,
  }),
  screen_menu: z.strictObject({
    ...SessionSelection,
    path: z.array(z.string().min(1).max(256)).min(1).max(8),
  }),
  screen_request_foreground: z.strictObject({
    ...SessionSelection,
    reason: z.string().min(1).max(2048),
  }),
};
// Read enum descriptions from the shared action schema when the expanded helper contract lands.
const enumNames = (schema: z.ZodType, fallback: readonly string[]) => {
  const result = z.object({ enum: z.array(z.string()) }).safeParse(z.toJSONSchema(schema));
  return (result.success ? result.data.enum : fallback).join(", ");
};
const namedKeys = enumNames(PointKey.shape.key, [
  "a–z",
  "0–9",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "escape",
  "delete",
  "home",
  "end",
  "pageup",
  "pagedown",
  "left",
  "right",
  "up",
  "down",
]);
const keyEnum = z
  .object({ enum: z.array(z.string()) })
  .safeParse(z.toJSONSchema(PointKey.shape.key));
const namedModifiers = keyEnum.success
  ? z
      .object({ items: z.object({ enum: z.array(z.string()) }) })
      .parse(z.toJSONSchema(PointKey.shape.modifiers))
      .items.enum.join(", ")
  : "command, shift, option, control";
export const computerUseTools = [
  {
    name: "screen_list_windows",
    description:
      "List an approved app's candidate windows, including its focused/main window. Use screen_select_window to choose a specific target.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_list_windows);
    },
  },
  {
    name: "screen_select_window",
    description:
      "Switch this app session to an exact windowId from screen_list_windows. Later actions and captures target that window.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_select_window);
    },
  },
  {
    name: "screen_open_url",
    description:
      "Open a URL or deep link in this approved native app without activating it. For website browsing use ace_browser_open.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_open_url);
    },
  },
  {
    name: "screen_menu",
    description:
      "Press an enabled app menu item by its accessibility menu path, for example [File, New Window], without synthesizing a keyboard shortcut.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_menu);
    },
  },
  {
    name: "screen_measure_interaction",
    description:
      "Measure an approved macOS window with optional background input, or observe only.\nReturns latency, settle time, active FPS, dropped intervals and a timestamped filmstrip.\nHitch ratio in ms/s: <5 smooth, 5–10 minor hitches, >10 janky.\nIdle time is excluded; few updates, high host load or capture overhead reduce confidence.\nRepeat 1–5 times; at most 10 seconds per run and 20 seconds total. Repeats perform the action again.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_measure_interaction);
    },
  },
  {
    name: "screen_request_app",
    description:
      "Ask the person to approve computer use of one native macOS app by exact bundle id, with a reason. Call only when the person asked you to operate that app. Never request a web browser to visit a website; use ace_browser_open. Browser grants must come from the person in ace's UI.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_request_app);
    },
  },
  {
    name: "screen_open_app",
    description:
      "Launch an approved app in the background and acquire an agent session. Returns candidate windows, target and sessionId. If ambiguous, supply a listed windowId; use sessionId when controlling multiple apps.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_open_app);
    },
  },
  {
    name: "screen_request_foreground",
    description:
      "Request human approval for foreground mode for this session. Include why the app requires real cursor and keyboard focus.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_request_foreground);
    },
  },
  {
    name: "screen_paste",
    description:
      "Paste text into the approved app, preserving the clipboard. Refuses secure fields without session consent.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_paste);
    },
  },
  {
    name: "screen_ui_tree",
    description:
      "Use first: inspect the approved app's bounded accessibility tree with stable refs. Prefer semantic actions to pixel clicks.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_ui_tree);
    },
  },
  {
    name: "screen_ui_find",
    description:
      "Find accessible elements by role, name or text without requesting the entire tree. Use before screenshot searches.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_ui_find);
    },
  },
  {
    name: "screen_ui_act",
    description:
      "Act on a stable element ref using the OS accessibility API. Reply states whether synthesized input was needed.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_ui_act);
    },
  },
  {
    name: "screen_screenshot",
    description:
      "Visual check only: inspect the approved app. Use screen_ui_tree or screen_ui_find first; screenshots cost more tokens.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_screenshot);
    },
  },
  {
    name: "screen_click",
    description:
      "Prefer screen_ui_act. Click at target-window points with v2, or pixels of the latest model screenshot with v1. Take a new screenshot after takeover or resizing.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_click);
    },
  },
  {
    name: "screen_type",
    description:
      "Type text in the approved native app. Use screen_key for Enter and shortcuts, or screen_ui_act to set a field's whole value.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_type);
    },
  },
  {
    name: "screen_key",
    description: `Press a key in the approved native app. Named keys: ${namedKeys}. Modifiers: ${namedModifiers}. Example: {"key":"l","modifiers":["command"]}. Legacy sessions accept macOS keyCode.`,
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_key);
    },
  },
  {
    name: "screen_scroll",
    description:
      "Scroll with v2 dx/dy at optional target-window points, or legacy model-image pixel coordinates and deltaX/deltaY.",
    get inputSchema() {
      return z.toJSONSchema(computerUseSchemas.screen_scroll);
    },
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
    _meta?: Record<string, unknown>;
  }> => {
    signal.throwIfAborted();
    const raw = z.record(z.string(), z.unknown()).parse(input);
    const { sessionId: selected, ...payload } = raw;
    if (selected !== undefined && selected !== sessionId)
      throw new Error("Controller ownership required");
    if (name === "screen_measure_interaction") {
      const result = await manager.measureInteraction(sessionId, payload, owner, signal);
      const { filmstrip, ...metrics } = result;
      return {
        content: [
          { type: "text", text: JSON.stringify(metrics) },
          ...(filmstrip ? [filmstrip] : []),
        ],
      };
    }
    const mode = manager.state(sessionId).mode;
    const observe = () =>
      manager.state(sessionId).capabilities?.uiTree
        ? manager.uiTree(sessionId, { maxNodes: 64, maxDepth: 6 }, owner)
        : Promise.resolve(null);
    if (name === "screen_paste") {
      const result = await manager.input(
        sessionId,
        "agent",
        { kind: "text.paste", ...Type.parse(payload) },
        owner,
        () => signal.throwIfAborted(),
      );
      const snapshot = await settledSnapshot(result, observe);
      return {
        content: [
          { type: "text", text: JSON.stringify({ mode, ...actionMetadata(result), snapshot }) },
        ],
      };
    }
    if (name === "screen_select_window") {
      const { windowId } = computerUseSchemas.screen_select_window
        .omit({ sessionId: true })
        .parse(payload);
      const state = await manager.selectWindow(sessionId, windowId, owner, () =>
        signal.throwIfAborted(),
      );
      return { content: [{ type: "text", text: JSON.stringify(state) }] };
    }
    if (name === "screen_open_url" || name === "screen_menu") {
      const operation =
        name === "screen_open_url"
          ? {
              op: "open.url" as const,
              ...computerUseSchemas.screen_open_url.omit({ sessionId: true }).parse(payload),
            }
          : {
              op: "menu.press" as const,
              ...computerUseSchemas.screen_menu.omit({ sessionId: true }).parse(payload),
            };
      const result = await manager.appOperation(sessionId, operation, owner, () =>
        signal.throwIfAborted(),
      );
      const snapshot = await settledSnapshot(result, observe);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              mode: manager.state(sessionId).mode,
              ...actionMetadata(result),
              snapshot,
            }),
          },
        ],
      };
    }
    if (name === "screen_screenshot") {
      Screenshot.parse(payload);
      const image = await manager.modelScreenshot(sessionId, owner, signal);
      return {
        _meta: {
          "ace/screen": {
            mode: manager.state(sessionId).mode,
            scale: image.scale,
            size: { width: image.width, height: image.height },
          },
        },
        content: [
          {
            type: "image",
            data: image.payload.toString("base64"),
            mimeType: "image/jpeg",
          },
          {
            type: "text",
            text:
              `Mode: ${mode}. ` +
              (manager.state(sessionId).capabilities
                ? `Screenshot scale: ${image.scale} pixels per target point. Divide image coordinates by this scale for v2 input; prefer UI refs.`
                : `Legacy input uses pixels in this ${image.width}x${image.height} model image. Pass its coordinates directly; ace maps them to the original capture. Refresh after control or capture geometry changes.`),
          },
        ],
      };
    }
    if (name === "screen_ui_tree" || name === "screen_ui_find" || name === "screen_ui_act") {
      const data =
        name === "screen_ui_tree"
          ? await manager.uiTree(sessionId, payload, owner)
          : name === "screen_ui_find"
            ? await manager.uiFind(sessionId, payload, owner)
            : await manager.uiAct(sessionId, "agent", payload, owner, () =>
                signal.throwIfAborted(),
              );
      const snapshot =
        name === "screen_ui_act" && !("snapshot" in data)
          ? await manager.uiTree(sessionId, { maxNodes: 64, maxDepth: 6 }, owner)
          : undefined;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...data,
              mode: manager.state(sessionId).mode,
              ...(snapshot ? { snapshot } : {}),
            }),
          },
        ],
      };
    }
    let action: unknown;
    let v2: unknown;
    const negotiated = manager.state(sessionId).capabilities !== undefined;
    switch (name) {
      case "screen_click":
        action = { kind: "click", ...Click.parse(payload) };
        if (negotiated) v2 = { kind: "pointer.click", ...Click.parse(payload) };
        break;
      case "screen_type":
        action = { kind: "type", ...Type.parse(payload) };
        if (negotiated) v2 = { kind: "text.type", ...Type.parse(payload) };
        break;
      case "screen_key":
        {
          const key = Key.parse(payload);
          if ("key" in key) v2 = { kind: "key.press", ...key };
          else action = { kind: "key", ...key };
        }
        break;
      case "screen_scroll":
        {
          const scroll = Scroll.parse(payload);
          if ("dx" in scroll) v2 = { kind: "scroll", ...scroll };
          else action = { kind: "scroll", ...scroll };
        }
        break;
      default:
        throw new Error("Unknown computer-use tool");
    }
    const result = v2
      ? await manager.input(sessionId, "agent", v2, owner, () => signal.throwIfAborted())
      : await manager.modelAction(sessionId, owner, ScreenAction.parse(action), () =>
          signal.throwIfAborted(),
        );
    const snapshot = await settledSnapshot(result, observe);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            mode: manager.state(sessionId).mode,
            ...actionMetadata(result),
            snapshot,
          }),
        },
      ],
    };
  };
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
async function settledSnapshot(raw: unknown, observe: () => Promise<unknown>) {
  const result = ScreenUIActResult.partial().parse(raw ?? {});
  return result.snapshot ?? (await observe());
}
