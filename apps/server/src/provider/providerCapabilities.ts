import type { ProviderIntegrationCapabilities, ProviderKind } from "@ace/contracts";

import type { ProviderAdapterCapabilities } from "./Services/ProviderAdapter.ts";

const PROVIDER_INTEGRATION_CAPABILITIES: Record<ProviderKind, ProviderIntegrationCapabilities> = {
  codex: {
    sessionModelSwitch: "in-session",
    sessionModelOptionsSwitch: "in-session",
    liveTurnDiffMode: "native",
    reviewChangesMode: "provider",
    reviewSurface: "turn-native",
    approvalRequestsMode: "native",
    turnSteeringMode: "native",
    transcriptAuthority: "provider",
    historyAuthority: "provider-session",
    sessionResumeMode: "native",
  },
  claudeAgent: {
    sessionModelSwitch: "in-session",
    sessionModelOptionsSwitch: "restart-session",
    liveTurnDiffMode: "reconstructed",
    reviewChangesMode: "provider",
    reviewSurface: "git-worktree",
    approvalRequestsMode: "native",
    turnSteeringMode: "queued-message",
    transcriptAuthority: "provider",
    historyAuthority: "provider-session",
    sessionResumeMode: "native",
  },
  gemini: {
    sessionModelSwitch: "in-session",
    sessionModelOptionsSwitch: "in-session",
    liveTurnDiffMode: "reconstructed",
    reviewChangesMode: "provider",
    reviewSurface: "editor-native",
    approvalRequestsMode: "native",
    turnSteeringMode: "queued-message",
    transcriptAuthority: "local",
    historyAuthority: "project-local",
    sessionResumeMode: "local-replay",
  },
  cursor: {
    sessionModelSwitch: "restart-session",
    sessionModelOptionsSwitch: "restart-session",
    liveTurnDiffMode: "workspace",
    reviewChangesMode: "git",
    reviewSurface: "pending-changes",
    approvalRequestsMode: "native",
    turnSteeringMode: "queued-message",
    transcriptAuthority: "local",
    historyAuthority: "project-local",
    sessionResumeMode: "local-replay",
  },
  pi: {
    sessionModelSwitch: "in-session",
    sessionModelOptionsSwitch: "in-session",
    liveTurnDiffMode: "workspace",
    reviewChangesMode: "git",
    reviewSurface: "git-worktree",
    approvalRequestsMode: "none",
    turnSteeringMode: "native",
    transcriptAuthority: "local",
    historyAuthority: "local-server-session",
    sessionResumeMode: "local-replay",
  },
  githubCopilot: {
    sessionModelSwitch: "restart-session",
    sessionModelOptionsSwitch: "restart-session",
    liveTurnDiffMode: "workspace",
    reviewChangesMode: "git",
    reviewSurface: "editor-native",
    approvalRequestsMode: "native",
    turnSteeringMode: "queued-message",
    transcriptAuthority: "local",
    historyAuthority: "local-server-session",
    sessionResumeMode: "local-replay",
  },
  opencode: {
    sessionModelSwitch: "in-session",
    sessionModelOptionsSwitch: "in-session",
    liveTurnDiffMode: "workspace",
    reviewChangesMode: "git",
    reviewSurface: "git-worktree",
    approvalRequestsMode: "native",
    turnSteeringMode: "queued-message",
    transcriptAuthority: "local",
    historyAuthority: "local-server-session",
    sessionResumeMode: "local-replay",
  },
};

export function defaultProviderIntegrationCapabilities(
  provider: ProviderKind,
): ProviderIntegrationCapabilities {
  return PROVIDER_INTEGRATION_CAPABILITIES[provider];
}

export function resolveProviderIntegrationCapabilities(
  provider: ProviderKind,
  capabilities?: ProviderAdapterCapabilities | ProviderIntegrationCapabilities | null,
): ProviderIntegrationCapabilities {
  const defaults = defaultProviderIntegrationCapabilities(provider);
  if (!capabilities) {
    return defaults;
  }
  return {
    ...defaults,
    ...capabilities,
    sessionModelSwitch: capabilities.sessionModelSwitch ?? defaults.sessionModelSwitch,
    sessionModelOptionsSwitch:
      capabilities.sessionModelOptionsSwitch ?? defaults.sessionModelOptionsSwitch,
  };
}
