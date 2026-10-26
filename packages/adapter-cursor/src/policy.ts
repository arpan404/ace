import { accessModeOffers } from "@ace/provider-kit/access-modes";
import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { Capabilities } from "@ace/protocol";

const baseCapabilities: Capabilities = {
  approvals: "sandbox-only",
  permissionModes: nativePermissionModes("cursor"),
  accessModes: accessModeOffers({ provider: "cursor" }),
  permissions: {
    modes: nativePermissionModes("cursor").map((mode) => mode.id),
    permissionModes: nativePermissionModes("cursor"),
    nativeAutoReview: true,
    toolGate: false,
  },
  steeringMode: "interrupt-restart",
  forkMode: "context-handoff",
  childControls: "read-only",
  childFidelity: "summary",
  steer: true,
  sessionOptions: true,
  launchOptions: ["effort", "serviceTier"],
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: false,
  backgroundTaskControl: false,
  backgroundVisibility: "partial",
  planMode: false,
  tokenUsage: true,
  imageInput: true,
  attachmentInput: {
    format: "acp",
    documents: [],
    embeddedContext: false,
    maxInlineBytes: 128 * 1024,
  },
  rewindFiles: false,
};
/** Cursor's SDK has no file sandbox on Windows, so its sandboxed Auto review is never offered. */
const windowsCapabilities: Capabilities = {
  ...baseCapabilities,
  accessModes: baseCapabilities.accessModes?.filter((offer) => offer.mode !== "auto-review"),
};
export function cursorCapabilitiesForSandbox(_supported: boolean): Capabilities {
  if (process.platform === "win32") return windowsCapabilities;
  return baseCapabilities;
}
export const cursorCapabilities = baseCapabilities;
