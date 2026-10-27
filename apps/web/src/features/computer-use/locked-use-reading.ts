import type { LockedUseStatus } from "@ace/protocol";
import type { Tone } from "@ace/ui-core";

/** This Mac's locked-use state in words, as the row shows it. */
export function lockedUseLabel(status: LockedUseStatus): { label: string; tone: Tone } {
  switch (status.state) {
    case "on":
      return { label: "On", tone: "done" };
    case "off":
      return { label: "Off", tone: "idle" };
    case "installing":
    case "needsApproval":
      return { label: "Needs approval", tone: "needs-you" };
    case "installFailed":
      return { label: "Install failed", tone: "failed" };
    case "driftRepairNeeded":
      return { label: "Needs repair", tone: "failed" };
  }
}

/** Whether the switch reads on: the component is installed, or on its way. */
export function lockedUseSwitchOn(status: LockedUseStatus): boolean {
  return status.state !== "off" && status.state !== "installFailed";
}

/** A refused install, removal or repair in one sentence. */
export function lockedUseRefusal(code: string | undefined, reason: string | undefined): string {
  switch (code) {
    case "forbidden":
      return "Only this Mac's owner can change this.";
    case "busy":
      return "Another change is still running. Try again when it finishes.";
    case "unavailable":
      return "This Mac can't run agents while locked.";
    default:
      return reason?.trim() || "Something went wrong. Try again.";
  }
}

/**
 * Whether the row belongs on the page: the screen helper is there, the daemon has answered, and
 * the daemon is a Mac. A state other than off only comes from a Mac; off counts only when the
 * app itself runs on one.
 */
export function lockedUseShown(facts: {
  screenUnavailable: boolean;
  status: LockedUseStatus | undefined;
  hostIsMac: boolean;
}): boolean {
  if (facts.screenUnavailable || !facts.status) return false;
  return facts.status.state !== "off" || facts.hostIsMac;
}
