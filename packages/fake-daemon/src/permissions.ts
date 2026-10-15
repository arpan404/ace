import { nativePermissionModes } from "@ace/provider-kit/permission-modes";
import { accessModeOffers } from "@ace/provider-kit/access-modes";
import type {
  AccessModeOffer,
  Capabilities,
  PermissionCapabilities,
  ProviderKind,
} from "@ace/protocol";

/** Scripted facts are fully gated in memory; these are not native provider guarantees. */
export const fakePermissionCapabilities: Capabilities = {
  steer: true,
  interruptCascades: true,
  resume: true,
  fork: true,
  subagentTranscripts: true,
  backgroundTaskControl: true,
  backgroundVisibility: "full",
  planMode: false,
  tokenUsage: false,
  imageInput: true,
  rewindFiles: false,
  // Effort and other launch options change on a live thread through a queued switch.
  sessionOptions: true,
  launchOptions: ["effort", "serviceTier"],
  permissions: { modes: [], permissionModes: [], nativeAutoReview: false, toolGate: true },
};
/** The ace modes each fake provider supports, from the same table the daemon uses. */
export function fakeAccessModes(provider: ProviderKind): AccessModeOffer[] {
  // A fake ACP agent stands for a profiled one (Gemini) so its partial set shows.
  return accessModeOffers(provider === "acp" ? { provider, profile: "gemini-043" } : { provider });
}
export function fakeProviderPermissions(provider: ProviderKind): PermissionCapabilities {
  const permissionModes = nativePermissionModes(provider);
  return {
    modes: permissionModes.map((mode) => mode.id),
    permissionModes,
    nativeAutoReview: ["claude", "codex", "cursor"].includes(provider),
    toolGate: provider !== "pi" && provider !== "cursor",
  };
}
