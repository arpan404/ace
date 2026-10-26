import type { z } from "zod";
import { DeviceOperation } from "@ace/protocol/devices";
import { ScreenUITreeResult, type ScreenUINode } from "@ace/protocol";
import type { DevicesService } from "./service.ts";
import { DeviceError } from "./sdk.ts";
import type { SimAgentState } from "./sim-state.ts";
import { simActivity } from "./sim-activity.ts";
import type { SimElement } from "./sim-refs.ts";
import type { simSchemas } from "./sim-schemas.ts";

type Actor = Parameters<DevicesService["request"]>[1] & { owner: string };
export type SimAct = z.output<typeof simSchemas.sim_act>;
/** The deepest, widest read the platforms allow, so a ref is never lost to a read budget. */
const fullRead = { maxDepth: 16, maxNodes: 512 };

/** The device operation one coordinate or app-level sim_act call performs. */
function directOperation(args: SimAct): unknown {
  const deviceId = args.simId;
  switch (args.action) {
    case "ui":
      throw new DeviceError(
        "not_supported",
        "ui needs a ref",
        "Read sim_ui and pass one of its refs.",
      );
    case "tap":
      return { op: "input", deviceId, input: { kind: "tap", x: args.x, y: args.y } };
    case "long_press":
      return {
        op: "input",
        deviceId,
        input: { kind: "longPress", x: args.x, y: args.y, durationMs: args.durationMs },
      };
    case "swipe":
      return {
        op: "input",
        deviceId,
        input: {
          kind: "swipe",
          x: args.x,
          y: args.y,
          toX: args.toX,
          toY: args.toY,
          durationMs: args.durationMs,
        },
      };
    case "type":
      return { op: "input", deviceId, input: { kind: "type", text: args.text } };
    case "key":
      return { op: "input", deviceId, input: { kind: "key", key: args.key } };
    case "open_app":
      return { op: "open_app", deviceId, appId: args.appId };
    case "open_url":
      return { op: "open_url", deviceId, url: args.url };
    case "install":
      return { op: "install", deviceId, path: args.path };
    case "record_start":
      return { op: "record.start", deviceId };
    case "record_stop":
      return { op: "record.stop", deviceId };
    case "clipboard_get":
      return { op: "clipboard.get", deviceId };
    case "clipboard_set":
      return { op: "clipboard.set", deviceId, text: args.text };
    case "posture":
      return { op: "posture", deviceId, posture: args.posture };
  }
}

const label = (ref: string, element: Pick<SimElement, "role" | "name">) =>
  `@${ref.replace(/^@/, "")} (${element.role}${element.name ? ` ${JSON.stringify(element.name.slice(0, 60))}` : ""})`;
const centre = ({ bounds }: SimElement) => ({
  x: Math.max(0, Math.round(bounds.x + bounds.w / 2)),
  y: Math.max(0, Math.round(bounds.y + bounds.h / 2)),
});

/**
 * One sim_act call. A ref is re-validated against a fresh read of the screen before anything is
 * sent: an element that has gone fails with stale_ref and nothing reaches the device.
 */
export async function simAct(
  service: DevicesService,
  state: SimAgentState,
  args: SimAct,
  actor: Actor,
): Promise<unknown> {
  const request = (operation: unknown) => service.request(DeviceOperation.parse(operation), actor);
  const noteActivity = (element?: SimElement) => {
    const activity = simActivity(args, element);
    if (activity) service.noteAgentActivity(args.simId, activity);
  };
  if (args.ref === undefined) {
    const result = await request(directOperation(args));
    noteActivity();
    return result;
  }
  const deviceId = args.simId;
  const known = state.refs.element(actor.owner, deviceId, args.ref);
  if (!known)
    throw new DeviceError(
      "stale_ref",
      `${args.ref} is not a ref from your sim_ui reads of ${deviceId}`,
      "Read sim_ui and act on one of the refs it returns.",
    );
  const tree = ScreenUITreeResult.parse(await request({ op: "ui.tree", deviceId, ...fullRead }));
  const element = state.refs
    .label(actor.owner, deviceId, tree.nodes)
    .seen.get(args.ref.replace(/^@/, ""));
  if (!element)
    throw new DeviceError(
      "stale_ref",
      `${label(args.ref, known)} is no longer on screen`,
      "Read sim_ui again and act on a current ref.",
    );
  const ui = (
    action: ScreenUINode["actions"][number],
    extra: { value?: unknown; name?: string } = {},
  ) => request({ op: "ui.act", deviceId, ref: element.ref, action, ...extra });
  const tap = () =>
    element.actions.includes("press")
      ? ui("press")
      : request({ op: "input", deviceId, input: { kind: "tap", ...centre(element) } });
  let result: unknown;
  switch (args.action) {
    case "ui": {
      const action = args.uiAction ?? "press";
      if (!element.actions.includes(action))
        throw new DeviceError(
          "not_supported",
          `${label(args.ref, element)} supports ${element.actions.join(", ")}, not ${action}`,
          "Use one of the element's actions, or tap it.",
        );
      result = await ui(action, {
        ...(args.value !== undefined ? { value: args.value } : {}),
        ...(args.name !== undefined ? { name: args.name } : {}),
      });
      break;
    }
    case "tap":
      result = await tap();
      break;
    case "long_press":
      result = await request({
        op: "input",
        deviceId,
        input: { kind: "longPress", ...centre(element), durationMs: args.durationMs },
      });
      break;
    case "type":
      await tap();
      result = await request({ op: "input", deviceId, input: { kind: "type", text: args.text } });
      break;
    default:
      throw new DeviceError(
        "not_supported",
        `${args.action} does not take a ref`,
        "Pass coordinates or the action's own fields.",
      );
  }
  noteActivity(element);
  return { ref: `@${args.ref.replace(/^@/, "")}`, role: element.role, name: element.name, result };
}
