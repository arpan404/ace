import { ProviderStatus, type ProviderKind } from "@ace/protocol";

/** A provider installed, enabled and signed in, as provider status reports it. */
export function readyStatus(provider: ProviderKind): ProviderStatus {
  return ProviderStatus.parse({
    provider,
    runtime: "cli",
    installed: true,
    auth: "logged_in",
    loginHint: "",
    readiness: "signed_in",
    stale: false,
    refreshing: false,
  });
}
