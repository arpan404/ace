import type { ScreenState, ScreenTarget } from "@ace/protocol";
/** Whether computer use is on. The epoch fences captures started before a change. */
export class ScreenPolicy {
  enabled = false;
  epoch = 0;
  enable(enabled: boolean): void {
    this.enabled = enabled;
    this.epoch++;
  }
}
export function bundles(target: ScreenTarget): string[] {
  return target.kind === "display" ? target.bundleIds : [target.bundleId];
}
export type Control = { state: ScreenState; epoch: number; owner: string | undefined };
/** A capture still starting reserves its app until startup cleanup finishes. */
export function replaceableSession(control: Pick<Control, "state" | "owner">): boolean {
  return (
    ["stopping", "failed", "stopped"].includes(control.state.lifecycle) ||
    (control.state.lifecycle === "live" && control.owner === undefined)
  );
}
export function takeControl(
  control: Control,
  controller: ScreenState["controller"],
  owner: string,
): Control {
  return {
    state: { ...control.state, controller },
    epoch: control.epoch + 1,
    owner: controller === "none" ? undefined : owner,
  };
}
export function authorizeInput(control: Control, actor: "human" | "agent", owner: string): void {
  if (control.state.target.kind === "display") throw new Error("Display capture is view-only");
  if (control.state.controller !== actor || control.owner !== owner)
    throw new Error("Controller ownership required");
}
export function stopping(state: ScreenState): ScreenState {
  return { ...state, lifecycle: "stopping", controller: "none" };
}
export function terminated(state: ScreenState): ScreenState {
  return {
    ...state,
    lifecycle: state.error === undefined ? "stopped" : "failed",
    indicator: false,
    controller: "none",
  };
}
