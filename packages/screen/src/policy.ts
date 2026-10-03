import type { ScreenState, ScreenTarget } from "@ace/protocol";
/** Pure approval decisions. The manager executes the resulting shutdown effects. */
export class ScreenPolicy {
  enabled = false;
  epoch = 0;
  private readonly allowed = new Set<string>();
  enable(enabled: boolean): void {
    this.enabled = enabled;
    this.epoch++;
  }
  approve(bundleId: string, allowed: boolean): void {
    this.epoch++;
    if (allowed) {
      if (this.allowed.size >= 64 && !this.allowed.has(bundleId)) throw new Error("Approval limit");
      this.allowed.add(bundleId);
    } else this.allowed.delete(bundleId);
  }
  authorize(bundleIds: readonly string[]): void {
    if (!this.enabled) throw new Error("Screen access is disabled");
    if (!bundleIds.every((bundle) => this.allowed.has(bundle)))
      throw new Error("Application approval required");
  }
  allowlist(): string[] {
    return [...this.allowed];
  }
}
export function bundles(target: ScreenTarget): string[] {
  return target.kind === "display" ? target.bundleIds : [target.bundleId];
}
export type Control = { state: ScreenState; epoch: number; owner: string | undefined };
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
