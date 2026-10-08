import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import type { Capabilities } from "@ace/protocol";

const baseCapabilities: Capabilities = {
  approvals: "sandbox-only",
  permissionModes: nativePermissionModes("cursor"),
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
export function cursorCapabilitiesForSandbox(_supported: boolean): Capabilities {
  return baseCapabilities;
}
export const cursorCapabilities = baseCapabilities;
