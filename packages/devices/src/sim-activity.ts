import type { DeviceActivity } from "@ace/protocol/devices";
import type { SimElement } from "./sim-refs.ts";
import type { z } from "zod";
import type { simSchemas } from "./sim-schemas.ts";

type SimAct = z.output<typeof simSchemas.sim_act>;

/** What a viewer is told about one agent action, before the session numbers it. */
export type AgentActivity = Omit<DeviceActivity, "sequence">;

const actionNames: Partial<Record<SimAct["action"], string>> = {
  tap: "tap",
  long_press: "longPress",
  swipe: "swipe",
  type: "type",
  key: "key",
};

const centre = ({ bounds }: Pick<SimElement, "bounds">) => ({
  x: bounds.x + bounds.w / 2,
  y: bounds.y + bounds.h / 2,
});

/**
 * The activity a successful sim_act shows a viewer. App-level actions (opening apps or URLs,
 * installs, recordings) show nothing. Typed text is never included: it may be a password.
 */
export function simActivity(args: SimAct, element?: SimElement): AgentActivity | undefined {
  if (element && args.ref !== undefined) {
    const action = args.action === "ui" ? (args.uiAction ?? "press") : actionNames[args.action];
    if (!action) return undefined;
    return {
      action: action.slice(0, 32),
      point: centre(element),
      ref: args.ref.replace(/^@/, "").slice(0, 64),
      ...(element.name ? { label: element.name.slice(0, 128) } : {}),
    };
  }
  switch (args.action) {
    case "tap":
    case "long_press":
      return args.x === undefined || args.y === undefined
        ? undefined
        : { action: actionNames[args.action] ?? args.action, point: { x: args.x, y: args.y } };
    case "swipe":
      if (args.x === undefined || args.y === undefined) return undefined;
      return {
        action: "swipe",
        point: { x: args.x, y: args.y },
        ...(args.toX !== undefined && args.toY !== undefined
          ? { to: { x: args.toX, y: args.toY } }
          : {}),
      };
    case "type":
      return { action: "type" };
    case "key":
      return args.key === undefined ? undefined : { action: "key", key: args.key };
    default:
      return undefined;
  }
}
