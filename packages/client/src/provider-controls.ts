import type { Capabilities } from "@ace/protocol";
/** Older providers retain their existing capability booleans when policy fields are absent. */
export function rootProviderControls(capabilities: Capabilities) {
  return {
    steer: capabilities.steer,
    steeringMode: capabilities.steeringMode ?? (capabilities.steer ? "native" : "queue"),
    fork: capabilities.fork,
    forkMode: capabilities.forkMode ?? (capabilities.fork ? "native" : "none"),
    interrupt: true,
    resume: capabilities.resume,
    interactiveApproval:
      capabilities.approvals === undefined || capabilities.approvals === "interactive",
    sandboxOnly: capabilities.approvals === "sandbox-only",
    planReview: capabilities.planMode && capabilities.approvals !== "sandbox-only",
    stopTask: capabilities.backgroundTaskControl,
  };
}
export function childProviderControls(capabilities: Capabilities) {
  if (capabilities.childControls === "read-only")
    return {
      send: false,
      interrupt: false,
      resume: false,
      fork: false,
      stopTask: false,
      fidelity: capabilities.childFidelity ?? "placeholder",
    };
  return {
    send: capabilities.steer,
    interrupt: true,
    resume: capabilities.resume,
    fork: capabilities.fork,
    stopTask: capabilities.backgroundTaskControl,
    fidelity: capabilities.childFidelity ?? "full",
  };
}
