import type { ProviderIntegrationCapabilities, ProviderKind } from "@ace/contracts";
import { isProviderSideConversationAlias } from "@ace/shared/providerSlashCommands";

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
    sessionForkMode: "native",
    sideConversationMode: "native-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "native",
    goalControlMode: "native",
    multiAgentMode: "native",
    multiAgentInvocationPrefixes: [],
    multiAgentDefinitionPaths: [],
    hookMode: "native",
    extensionMode: "native",
    mcpMode: "native",
    remoteAgentMode: "native",
    webAccessMode: "native",
    hostedSessionMode: "native",
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
    sessionForkMode: "native",
    sideConversationMode: "native-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "unsupported",
    goalControlMode: "unsupported",
    multiAgentMode: "native",
    multiAgentInvocationPrefixes: ["@", "@agent-"],
    multiAgentDefinitionPaths: [".claude/agents", "~/.claude/agents"],
    hookMode: "native",
    extensionMode: "native",
    mcpMode: "native",
    remoteAgentMode: "unsupported",
    webAccessMode: "native",
    hostedSessionMode: "native",
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
    sessionForkMode: "local-replay",
    sideConversationMode: "replay-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "unsupported",
    goalControlMode: "unsupported",
    multiAgentMode: "native",
    multiAgentInvocationPrefixes: ["@"],
    multiAgentDefinitionPaths: [".gemini/agents", "~/.gemini/agents"],
    hookMode: "native",
    extensionMode: "native",
    mcpMode: "native",
    remoteAgentMode: "native",
    webAccessMode: "native",
    hostedSessionMode: "unsupported",
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
    sessionForkMode: "local-replay",
    sideConversationMode: "replay-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "unsupported",
    goalControlMode: "unsupported",
    multiAgentMode: "agent-command",
    multiAgentInvocationPrefixes: ["/"],
    multiAgentDefinitionPaths: [
      ".cursor/agents",
      ".claude/agents",
      ".codex/agents",
      "~/.cursor/agents",
      "~/.claude/agents",
      "~/.codex/agents",
    ],
    hookMode: "unsupported",
    extensionMode: "local-discovery",
    mcpMode: "native",
    remoteAgentMode: "unsupported",
    webAccessMode: "native",
    hostedSessionMode: "native",
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
    sessionForkMode: "local-replay",
    sideConversationMode: "replay-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "unsupported",
    goalControlMode: "unsupported",
    multiAgentMode: "agent-command",
    multiAgentInvocationPrefixes: [],
    multiAgentDefinitionPaths: [],
    hookMode: "unsupported",
    extensionMode: "native",
    mcpMode: "unsupported",
    remoteAgentMode: "unsupported",
    webAccessMode: "unsupported",
    hostedSessionMode: "unsupported",
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
    sessionResumeMode: "native",
    sessionForkMode: "local-replay",
    sideConversationMode: "replay-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "unsupported",
    goalControlMode: "unsupported",
    multiAgentMode: "native",
    multiAgentInvocationPrefixes: ["@"],
    multiAgentDefinitionPaths: [
      ".github/agents/*.agent.md",
      ".github/agents/*.md",
      ".github/chatmodes/*.chatmode.md",
      ".claude/agents",
      "~/.copilot/agents/*.agent.md",
      "~/.copilot/agents/*.md",
      "~/.copilot/chatmodes/*.chatmode.md",
      "~/.github-copilot/agents/*.agent.md",
      "~/.github-copilot/agents/*.md",
      "~/.github-copilot/chatmodes/*.chatmode.md",
      "configured chat.agentFilesLocations",
    ],
    hookMode: "native",
    extensionMode: "native",
    mcpMode: "native",
    remoteAgentMode: "native",
    webAccessMode: "agent-command",
    hostedSessionMode: "native",
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
    sessionForkMode: "local-replay",
    sideConversationMode: "replay-fork",
    sideConversationCommands: [],
    providerThreadTargetingMode: "native",
    goalControlMode: "unsupported",
    multiAgentMode: "native",
    multiAgentInvocationPrefixes: ["@"],
    multiAgentDefinitionPaths: [
      "opencode.json agent",
      "~/.config/opencode/opencode.json agent",
      ".opencode/agent/*.md",
      ".opencode/agents/*.md",
      "~/.config/opencode/agent/*.md",
      "~/.config/opencode/agents/*.md",
    ],
    hookMode: "native",
    extensionMode: "native",
    mcpMode: "native",
    remoteAgentMode: "unsupported",
    webAccessMode: "mcp-or-shell",
    hostedSessionMode: "unsupported",
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
    sideConversationCommands: normalizedProviderSideConversationCommands(
      capabilities.sideConversationCommands ?? defaults.sideConversationCommands,
    ),
    multiAgentInvocationPrefixes: normalizedProviderCapabilityStringList(
      capabilities.multiAgentInvocationPrefixes ?? defaults.multiAgentInvocationPrefixes,
    ),
    multiAgentDefinitionPaths: normalizedProviderCapabilityStringList(
      capabilities.multiAgentDefinitionPaths ?? defaults.multiAgentDefinitionPaths,
    ),
  };
}

function normalizedProviderSideConversationCommands(
  commands: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return normalizedProviderCapabilityStringList(commands).filter(
    (command) => !isProviderSideConversationAlias(command),
  );
}

function normalizedProviderCapabilityStringList(
  values: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}
