import type { DeviceActivity } from "@ace/protocol";

/*
 * An agent's action on a device as the stage shows it: a short caption ("tap @e7 “Sign in”")
 * and where its ripple goes on the shown screen. Pure.
 */

const verbs: Record<string, string> = {
  tap: "tap",
  press: "tap",
  longPress: "long press",
  swipe: "swipe",
  type: "type",
  key: "press",
  setValue: "set",
  selectText: "select text in",
  performSecondaryAction: "act on",
};

/** "tap @e7 “Sign in”", "swipe", "press home": the caption for one agent action. */
export function activityCaption(activity: Omit<DeviceActivity, "sequence">): string {
  const verb =
    verbs[activity.action] ?? activity.action.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return [
    verb,
    activity.action === "key" && activity.key ? activity.key : undefined,
    activity.ref ? `@${activity.ref.replace(/^@/, "")}` : undefined,
    activity.label ? `“${activity.label}”` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Where a point in device points falls on the shown screen, as fractions of its size. */
export function screenFraction(
  point: { x: number; y: number },
  screen: { width: number; height: number },
): { x: number; y: number } | undefined {
  if (screen.width <= 0 || screen.height <= 0) return undefined;
  return { x: unit(point.x / screen.width), y: unit(point.y / screen.height) };
}
