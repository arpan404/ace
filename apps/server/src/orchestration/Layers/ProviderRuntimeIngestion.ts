import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  ApprovalRequestId,
  type AssistantDeliveryMode,
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationProposedPlanId,
  CheckpointRef,
  type ProviderIntegrationCapabilities,
  isToolLifecycleItemType,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type OrchestrationThreadActivity,
  type OrchestrationThread,
  type ProviderRuntimeEvent,
  type ProviderSessionConfigOption,
  type ProviderSlashCommand,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@ace/contracts";
import { Cache, Cause, Duration, Effect, Layer, Option, Stream } from "effect";
import { makeDrainableWorker } from "@ace/shared/DrainableWorker";
import { appendCompactedThreadActivity } from "@ace/shared/orchestrationThreadActivities";
import {
  mergeProviderSlashCommands,
  normalizeProviderSlashCommandName,
  providerFallbackSlashCommands,
} from "@ace/shared/providerSlashCommands";
import {
  isProviderSideConversationType,
  mergeProviderAgentMetadata,
  providerAgentLooseRecord,
  providerAgentRecord,
  providerAgentRecords,
} from "@ace/shared/providerAgentMetadata";
import {
  hasProviderGoalLifecycleSignal,
  parseProviderGoalLifecycle,
} from "@ace/shared/providerGoalLifecycle";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { parseTurnDiffFilesFromUnifiedDiff } from "../../checkpointing/Diffs.ts";
import { isGitRepository } from "../../git/Utils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderRuntimeIngestionService,
  type ProviderRuntimeIngestionShape,
} from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { updateProviderRuntimeIngestionCacheStats } from "../../runtimeProfile.ts";
import { resolveProviderIntegrationCapabilities } from "../../provider/providerCapabilities.ts";
import {
  hasAcpMultiAgentCapability,
  hasAcpProviderThreadTargetingCapability,
  hasAcpSideConversationCapability,
} from "../../provider/acpCapabilities.ts";
import { ServerConfig } from "../../config.ts";
import { createAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { parseBase64DataUrl } from "../../imageMime.ts";

const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;
const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asConfigValueString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  return undefined;
}

function normalizeProviderSlashCommands(
  value: unknown,
): ReadonlyArray<ProviderSlashCommand> | null {
  const commandEntries = Array.isArray(value)
    ? value
    : (asRecord(value)?.commands ??
      asRecord(value)?.availableCommands ??
      asRecord(value)?.available_commands ??
      asRecord(value)?.slash_commands ??
      asRecord(value)?.slashCommands);
  if (!Array.isArray(commandEntries)) {
    return null;
  }

  const seenNames = new Set<string>();
  const commands: ProviderSlashCommand[] = [];
  for (const entry of commandEntries) {
    const record = asRecord(entry);
    const rawName =
      typeof entry === "string"
        ? entry
        : (asNonEmptyString(record?.name) ??
          asNonEmptyString(record?.command) ??
          asNonEmptyString(record?.id));
    if (!rawName) {
      continue;
    }
    const name = normalizeProviderSlashCommandName(rawName);
    if (!name) {
      continue;
    }
    const nameKey = name.toLowerCase();
    if (seenNames.has(nameKey)) {
      continue;
    }
    seenNames.add(nameKey);

    const input = asRecord(record?.input);
    const description = asNonEmptyString(record?.description);
    const inputHint =
      asNonEmptyString(input?.hint) ??
      asNonEmptyString(record?.inputHint) ??
      asNonEmptyString(record?.argumentHint);
    const rawKind =
      asNonEmptyString(record?.kind) ??
      asNonEmptyString(record?.source) ??
      asNonEmptyString(record?.type);
    const kind =
      rawKind === "skill" || rawKind === "plugin" || rawKind === "provider" || rawKind === "agent"
        ? rawKind
        : undefined;
    const promptPrefix =
      asNonEmptyString(record?.promptPrefix) ??
      asNonEmptyString(record?.prompt_prefix) ??
      asNonEmptyString(record?.replacementPrefix);
    const metadata = normalizeProviderSlashCommandMetadata(record, input);
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(inputHint ? { inputHint } : {}),
      ...(kind ? { kind } : {}),
      ...(promptPrefix ? { promptPrefix } : {}),
      ...(metadata ? { metadata } : {}),
    });
  }

  return commands;
}

function normalizeProviderSlashCommandMetadata(
  record: Record<string, unknown> | undefined,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  const metadata: Record<string, unknown> = {
    ...(asRecord(record.metadata) ?? {}),
  };
  const aliases: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = [
    [
      "model",
      [record.model, record.modelId, record.model_id, record.defaultModel, record.modelName],
    ],
    [
      "allowedTools",
      [
        record.allowedTools,
        record.allowed_tools,
        record.tools,
        record.toolNames,
        record.tool_names,
        input?.allowedTools,
        input?.allowed_tools,
        input?.tools,
      ],
    ],
    [
      "arguments",
      [
        record.arguments,
        record.args,
        record.argumentNames,
        record.argument_names,
        record.parameters,
        input?.arguments,
        input?.args,
        input?.parameters,
      ],
    ],
    [
      "disableModelInvocation",
      [
        record.disableModelInvocation,
        record.disable_model_invocation,
        record.noModel,
        record.no_model,
        input?.disableModelInvocation,
        input?.disable_model_invocation,
      ],
    ],
  ];

  for (const [key, values] of aliases) {
    if (metadata[key] !== undefined) {
      continue;
    }
    const value = values.find((candidate) => candidate !== undefined);
    if (value !== undefined) {
      metadata[key] = value;
    }
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function providerSlashCommandsFromSessionConfigured(
  event: ProviderRuntimeEvent,
): ReadonlyArray<ProviderSlashCommand> | null {
  if (event.type !== "session.configured") {
    return null;
  }
  const config = asRecord(event.payload.config);
  if (!config) {
    return null;
  }

  const providerCommands =
    normalizeProviderSlashCommands(config.availableCommands) ??
    normalizeProviderSlashCommands(config.available_commands) ??
    normalizeProviderSlashCommands(config.slash_commands) ??
    normalizeProviderSlashCommands(config.slashCommands) ??
    normalizeProviderSlashCommands(config.commands);

  if (providerCommands === null) {
    return null;
  }

  return mergeProviderSlashCommands(
    providerCommands,
    providerFallbackSlashCommands(event.provider),
  );
}

function providerCapabilitiesFromSessionConfigured(
  event: ProviderRuntimeEvent,
): Partial<ProviderIntegrationCapabilities> | null {
  if (event.type !== "session.configured") {
    return null;
  }
  const config = asRecord(event.payload.config);
  const capabilities = asRecord(
    config?.capabilities ?? config?.providerCapabilities ?? config?.provider_capabilities,
  );
  if (!capabilities) {
    return null;
  }
  const sessionCapabilities = asRecord(capabilities.sessionCapabilities);
  const session = asRecord(capabilities.session);
  const sessions = asRecord(capabilities.sessions);
  const turn = asRecord(capabilities.turn);
  const turns = asRecord(capabilities.turns);
  const methodContainers = providerCapabilityMethodContainers({
    config,
    capabilities,
    sessionCapabilities,
    session,
    sessions,
    turn,
    turns,
  });

  const sessionForkMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.sessionForkMode,
      capabilities.session_fork_mode,
      capabilities.forkSession,
      capabilities.fork_session,
      capabilities.sessionFork,
      capabilities.session_fork,
      capabilities["session.fork"],
      capabilities["session/fork"],
      capabilities.forkMode,
      capabilities.fork_mode,
      sessionCapabilities?.fork,
      sessionCapabilities?.forkSession,
      sessionCapabilities?.sessionFork,
      sessionCapabilities?.["session.fork"],
      session?.fork,
      session?.forkSession,
      session?.sessionFork,
      session?.["session.fork"],
      sessions?.fork,
      sessions?.forkSession,
      sessions?.sessionFork,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "session-fork") ? "native" : undefined);
  const sideConversationMode =
    normalizeProviderCapabilityMode(
      "native-fork",
      capabilities.sideConversationMode,
      capabilities.side_conversation_mode,
      capabilities.sideConversationMode,
      capabilities.sideMode,
      capabilities.side_mode,
      capabilities.sideConversation,
      capabilities.side_conversation,
      capabilities.sideChat,
      capabilities.side_chat,
      capabilities.sideSession,
      capabilities.side_session,
      capabilities.sideThread,
      capabilities.side_thread,
      capabilities["side.conversation"],
      capabilities["side/chat"],
      capabilities["side.session"],
      capabilities["side/session"],
      capabilities["side.thread"],
      capabilities["side/thread"],
      sessionCapabilities?.sideConversation,
      sessionCapabilities?.sideChat,
      sessionCapabilities?.sideSession,
      sessionCapabilities?.sideThread,
      session?.sideConversation,
      session?.sideChat,
      session?.sideSession,
      session?.sideThread,
      sessions?.sideConversation,
      sessions?.sideChat,
      sessions?.sideSession,
      sessions?.sideThread,
    ) ??
    (hasAcpSideConversationCapability({ capabilities }) ||
    hasProviderCapabilityMethod(methodContainers, "side-conversation")
      ? "native-fork"
      : undefined);
  const providerThreadTargetingMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.providerThreadTargetingMode,
      capabilities.provider_thread_targeting_mode,
      capabilities.threadTargetingMode,
      capabilities.thread_targeting_mode,
      capabilities.threadTargeting,
      capabilities.thread_targeting,
      capabilities.providerThreadTargeting,
      capabilities.provider_thread_targeting,
      capabilities.providerSessionTargeting,
      capabilities.provider_session_targeting,
      capabilities.childThreadTargeting,
      capabilities.child_thread_targeting,
      capabilities.childSessionTargeting,
      capabilities.child_session_targeting,
      capabilities.childConversationTargeting,
      capabilities.child_conversation_targeting,
      capabilities.providerThread,
      capabilities.provider_thread,
      capabilities.providerSession,
      capabilities.provider_session,
      capabilities.childThread,
      capabilities.child_thread,
      capabilities.childSession,
      capabilities.child_session,
      capabilities.childConversation,
      capabilities.child_conversation,
      sessionCapabilities?.threadTargeting,
      sessionCapabilities?.providerThreadTargeting,
      sessionCapabilities?.providerSessionTargeting,
      sessionCapabilities?.childThreadTargeting,
      sessionCapabilities?.childSessionTargeting,
      session?.threadTargeting,
      session?.providerThreadTargeting,
      session?.providerSessionTargeting,
      session?.childThreadTargeting,
      session?.childSessionTargeting,
    ) ??
    (hasAcpProviderThreadTargetingCapability({ capabilities }) ||
    hasProviderCapabilityMethod(methodContainers, "provider-thread-targeting")
      ? "native"
      : undefined);
  const sessionResumeMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.sessionResumeMode,
      capabilities.session_resume_mode,
      capabilities.resumeSession,
      capabilities.resume_session,
      capabilities.sessionResume,
      capabilities.session_resume,
      capabilities.loadSession,
      capabilities.load_session,
      capabilities.resumeMode,
      capabilities.resume_mode,
      sessionCapabilities?.resume,
      sessionCapabilities?.resumeSession,
      sessionCapabilities?.loadSession,
      session?.resume,
      session?.resumeSession,
      session?.loadSession,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "session-resume") ? "native" : undefined);
  const turnSteeringMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.turnSteeringMode,
      capabilities.turn_steering_mode,
      capabilities.steerTurn,
      capabilities.steer_turn,
      capabilities.turnSteering,
      capabilities.turn_steering,
      capabilities["turn.steer"],
      capabilities["turn/steer"],
      capabilities.steeringMode,
      capabilities.steering_mode,
      turn?.steer,
      turn?.steerTurn,
      turn?.turnSteering,
      turn?.["turn.steer"],
      turns?.steer,
      turns?.steerTurn,
      turns?.turnSteering,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "turn-steer") ? "native" : undefined);
  const goalControlMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.goalControlMode,
      capabilities.goal_control_mode,
      capabilities.goalControl,
      capabilities.goal_control,
      capabilities.goalControls,
      capabilities.goal_controls,
      capabilities.threadGoal,
      capabilities.thread_goal,
      capabilities.threadGoalControl,
      capabilities.thread_goal_control,
      capabilities["thread.goal"],
      capabilities["thread/goal"],
      capabilities["thread.goal.update"],
      capabilities["thread/goal/update"],
      capabilities["thread.goal.clear"],
      capabilities["thread/goal/clear"],
      sessionCapabilities?.goalControl,
      sessionCapabilities?.goalControls,
      sessionCapabilities?.threadGoal,
      sessionCapabilities?.threadGoalControl,
      session?.goalControl,
      session?.goalControls,
      session?.threadGoal,
      session?.threadGoalControl,
      sessions?.goalControl,
      sessions?.goalControls,
      sessions?.threadGoal,
      sessions?.threadGoalControl,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "goal-control") ? "native" : undefined);
  const multiAgentMode =
    normalizeProviderMultiAgentMode(
      capabilities.multiAgentMode,
      capabilities.multi_agent_mode,
      capabilities.agentMode,
      capabilities.agent_mode,
      capabilities.multiAgent,
      capabilities.multi_agent,
      capabilities.multiAgents,
      capabilities.multi_agents,
      capabilities.subagents,
      capabilities.subAgents,
      capabilities.sub_agents,
      capabilities.agents,
      capabilities.agentTeams,
      capabilities.agent_teams,
      capabilities.teams,
      capabilities.handoffs,
      sessionCapabilities?.multiAgent,
      sessionCapabilities?.multiAgents,
      sessionCapabilities?.subagents,
      sessionCapabilities?.subAgents,
      sessionCapabilities?.agents,
      sessionCapabilities?.agentTeams,
      session?.multiAgent,
      session?.multiAgents,
      session?.subagents,
      session?.subAgents,
      session?.agents,
      session?.agentTeams,
      sessions?.multiAgent,
      sessions?.multiAgents,
      sessions?.subagents,
      sessions?.subAgents,
      sessions?.agents,
      sessions?.agentTeams,
    ) ??
    (hasAcpMultiAgentCapability({ capabilities }) ||
    hasProviderCapabilityMethod(methodContainers, "multi-agent") ||
    hasProviderCapabilityMethod(methodContainers, "agent-team") ||
    hasProviderCapabilityMethod(methodContainers, "agent-handoff") ||
    hasProviderCapabilityMethod(methodContainers, "subagent")
      ? "native"
      : undefined);
  const hookMode =
    normalizeProviderCapabilityMode(
      "native",
      capabilities.hookMode,
      capabilities.hook_mode,
      capabilities.hooksMode,
      capabilities.hooks_mode,
      capabilities.hook,
      capabilities.hooks,
      capabilities.agentHooks,
      capabilities.agent_hooks,
      capabilities.lifecycleHooks,
      capabilities.lifecycle_hooks,
      capabilities.workflowHooks,
      capabilities.workflow_hooks,
      capabilities["agent.hooks"],
      capabilities["agent/hooks"],
      capabilities["lifecycle.hooks"],
      capabilities["lifecycle/hooks"],
      sessionCapabilities?.hook,
      sessionCapabilities?.hooks,
      sessionCapabilities?.agentHooks,
      sessionCapabilities?.lifecycleHooks,
      session?.hook,
      session?.hooks,
      session?.agentHooks,
      session?.lifecycleHooks,
      sessions?.hook,
      sessions?.hooks,
      sessions?.agentHooks,
      sessions?.lifecycleHooks,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "hooks") ? "native" : undefined);
  const extensionMode =
    normalizeProviderExtensionMode(
      capabilities.extensionMode,
      capabilities.extension_mode,
      capabilities.customizationMode,
      capabilities.customization_mode,
      capabilities.extensibilityMode,
      capabilities.extensibility_mode,
      capabilities.extensions,
      capabilities.plugins,
      capabilities.skills,
      capabilities.agentSkills,
      capabilities.agent_skills,
      capabilities.customAgents,
      capabilities.custom_agents,
      capabilities.promptFiles,
      capabilities.prompt_files,
      capabilities.instructions,
      capabilities.customInstructions,
      capabilities.custom_instructions,
      capabilities["agent.skills"],
      capabilities["agent/skills"],
      capabilities["custom.agents"],
      capabilities["custom/agents"],
      sessionCapabilities?.extensions,
      sessionCapabilities?.plugins,
      sessionCapabilities?.skills,
      sessionCapabilities?.agentSkills,
      sessionCapabilities?.customAgents,
      sessionCapabilities?.promptFiles,
      sessionCapabilities?.instructions,
      session?.extensions,
      session?.plugins,
      session?.skills,
      session?.agentSkills,
      session?.customAgents,
      session?.promptFiles,
      session?.instructions,
      sessions?.extensions,
      sessions?.plugins,
      sessions?.skills,
      sessions?.agentSkills,
      sessions?.customAgents,
      sessions?.promptFiles,
      sessions?.instructions,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "extensions") ? "native" : undefined);
  const mcpMode =
    normalizeProviderMcpMode(
      capabilities.mcpMode,
      capabilities.mcp_mode,
      capabilities.mcp,
      capabilities.mcpServers,
      capabilities.mcp_servers,
      capabilities.modelContextProtocol,
      capabilities.model_context_protocol,
      capabilities.toolServers,
      capabilities.tool_servers,
      capabilities.externalTools,
      capabilities.external_tools,
      capabilities.connectors,
      capabilities["mcp.servers"],
      capabilities["mcp/servers"],
      sessionCapabilities?.mcp,
      sessionCapabilities?.mcpServers,
      sessionCapabilities?.toolServers,
      sessionCapabilities?.externalTools,
      session?.mcp,
      session?.mcpServers,
      session?.toolServers,
      session?.externalTools,
      sessions?.mcp,
      sessions?.mcpServers,
      sessions?.toolServers,
      sessions?.externalTools,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "mcp") ? "native" : undefined);
  const remoteAgentMode =
    normalizeProviderRemoteAgentMode(
      capabilities.remoteAgentMode,
      capabilities.remote_agent_mode,
      capabilities.remoteAgentsMode,
      capabilities.remote_agents_mode,
      capabilities.remoteAgent,
      capabilities.remote_agent,
      capabilities.remoteAgents,
      capabilities.remote_agents,
      capabilities.hostedAgent,
      capabilities.hosted_agent,
      capabilities.hostedAgents,
      capabilities.hosted_agents,
      capabilities.cloudAgent,
      capabilities.cloud_agent,
      capabilities.cloudAgents,
      capabilities.cloud_agents,
      capabilities.a2aAgent,
      capabilities.a2a_agent,
      capabilities.a2aAgents,
      capabilities.a2a_agents,
      capabilities.agentConnect,
      capabilities.agent_connect,
      capabilities.remoteDelegation,
      capabilities.remote_delegation,
      sessionCapabilities?.remoteAgent,
      sessionCapabilities?.remoteAgents,
      sessionCapabilities?.hostedAgent,
      sessionCapabilities?.hostedAgents,
      sessionCapabilities?.cloudAgent,
      sessionCapabilities?.cloudAgents,
      sessionCapabilities?.a2aAgent,
      sessionCapabilities?.a2aAgents,
      sessionCapabilities?.agentConnect,
      sessionCapabilities?.remoteDelegation,
      session?.remoteAgent,
      session?.remoteAgents,
      session?.hostedAgent,
      session?.hostedAgents,
      session?.cloudAgent,
      session?.cloudAgents,
      session?.a2aAgent,
      session?.a2aAgents,
      session?.agentConnect,
      session?.remoteDelegation,
      sessions?.remoteAgent,
      sessions?.remoteAgents,
      sessions?.hostedAgent,
      sessions?.hostedAgents,
      sessions?.cloudAgent,
      sessions?.cloudAgents,
      sessions?.a2aAgent,
      sessions?.a2aAgents,
      sessions?.agentConnect,
      sessions?.remoteDelegation,
    ) ?? (hasProviderCapabilityMethod(methodContainers, "remote-agent") ? "native" : undefined);
  const webAccessMode =
    normalizeProviderWebAccessMode(
      capabilities.webAccessMode,
      capabilities.web_access_mode,
      capabilities.webMode,
      capabilities.web_mode,
      capabilities.webAccess,
      capabilities.web_access,
      capabilities.webSearch,
      capabilities.web_search,
      capabilities.webFetch,
      capabilities.web_fetch,
      capabilities.webTools,
      capabilities.web_tools,
      capabilities.browser,
      capabilities.browsing,
      capabilities.research,
      capabilities.internetAccess,
      capabilities.internet_access,
      sessionCapabilities?.webAccess,
      sessionCapabilities?.webSearch,
      sessionCapabilities?.webFetch,
      sessionCapabilities?.webTools,
      sessionCapabilities?.browser,
      sessionCapabilities?.browsing,
      sessionCapabilities?.research,
      sessionCapabilities?.internetAccess,
      session?.webAccess,
      session?.webSearch,
      session?.webFetch,
      session?.webTools,
      session?.browser,
      session?.browsing,
      session?.research,
      session?.internetAccess,
      sessions?.webAccess,
      sessions?.webSearch,
      sessions?.webFetch,
      sessions?.webTools,
      sessions?.browser,
      sessions?.browsing,
      sessions?.research,
      sessions?.internetAccess,
    ) ??
    (hasProviderCapabilityMethod(methodContainers, "web-access")
      ? "native"
      : hasProviderCapabilityMethod(methodContainers, "web-agent-command")
        ? "agent-command"
        : undefined);
  const hostedSessionMode =
    normalizeProviderHostedSessionMode(
      capabilities.hostedSessionMode,
      capabilities.hosted_session_mode,
      capabilities.cloudSessionMode,
      capabilities.cloud_session_mode,
      capabilities.backgroundSessionMode,
      capabilities.background_session_mode,
      capabilities.hostedSession,
      capabilities.hosted_session,
      capabilities.hostedSessions,
      capabilities.hosted_sessions,
      capabilities.cloudSession,
      capabilities.cloud_session,
      capabilities.cloudSessions,
      capabilities.cloud_sessions,
      capabilities.cloudTask,
      capabilities.cloud_task,
      capabilities.cloudTasks,
      capabilities.cloud_tasks,
      capabilities.backgroundAgent,
      capabilities.background_agent,
      capabilities.backgroundAgents,
      capabilities.background_agents,
      capabilities.webAgent,
      capabilities.web_agent,
      capabilities.webAgents,
      capabilities.web_agents,
      capabilities.remoteSession,
      capabilities.remote_session,
      capabilities.remoteSessions,
      capabilities.remote_sessions,
      capabilities.remoteControl,
      capabilities.remote_control,
      capabilities.teleport,
      sessionCapabilities?.hostedSession,
      sessionCapabilities?.hostedSessions,
      sessionCapabilities?.cloudSession,
      sessionCapabilities?.cloudSessions,
      sessionCapabilities?.cloudTask,
      sessionCapabilities?.cloudTasks,
      sessionCapabilities?.backgroundAgent,
      sessionCapabilities?.backgroundAgents,
      sessionCapabilities?.webAgent,
      sessionCapabilities?.webAgents,
      sessionCapabilities?.remoteSession,
      sessionCapabilities?.remoteSessions,
      sessionCapabilities?.remoteControl,
      sessionCapabilities?.teleport,
      session?.hostedSession,
      session?.hostedSessions,
      session?.cloudSession,
      session?.cloudSessions,
      session?.cloudTask,
      session?.cloudTasks,
      session?.backgroundAgent,
      session?.backgroundAgents,
      session?.webAgent,
      session?.webAgents,
      session?.remoteSession,
      session?.remoteSessions,
      session?.remoteControl,
      session?.teleport,
      sessions?.hostedSession,
      sessions?.hostedSessions,
      sessions?.cloudSession,
      sessions?.cloudSessions,
      sessions?.cloudTask,
      sessions?.cloudTasks,
      sessions?.backgroundAgent,
      sessions?.backgroundAgents,
      sessions?.webAgent,
      sessions?.webAgents,
      sessions?.remoteSession,
      sessions?.remoteSessions,
      sessions?.remoteControl,
      sessions?.teleport,
    ) ??
    (hasProviderCapabilityMethod(methodContainers, "hosted-session")
      ? "native"
      : hasProviderCapabilityMethod(methodContainers, "local-session-bridge")
        ? "local-bridge"
        : undefined);
  const overrides: {
    sessionForkMode?: ProviderIntegrationCapabilities["sessionForkMode"];
    sideConversationMode?: ProviderIntegrationCapabilities["sideConversationMode"];
    providerThreadTargetingMode?: ProviderIntegrationCapabilities["providerThreadTargetingMode"];
    sessionResumeMode?: ProviderIntegrationCapabilities["sessionResumeMode"];
    turnSteeringMode?: ProviderIntegrationCapabilities["turnSteeringMode"];
    goalControlMode?: ProviderIntegrationCapabilities["goalControlMode"];
    multiAgentMode?: ProviderIntegrationCapabilities["multiAgentMode"];
    hookMode?: ProviderIntegrationCapabilities["hookMode"];
    extensionMode?: ProviderIntegrationCapabilities["extensionMode"];
    mcpMode?: ProviderIntegrationCapabilities["mcpMode"];
    remoteAgentMode?: ProviderIntegrationCapabilities["remoteAgentMode"];
    webAccessMode?: ProviderIntegrationCapabilities["webAccessMode"];
    hostedSessionMode?: ProviderIntegrationCapabilities["hostedSessionMode"];
  } = {};

  if (sessionForkMode === "native" || sessionForkMode === "local-replay") {
    overrides.sessionForkMode = sessionForkMode;
  }
  if (
    sideConversationMode === "native-fork" ||
    sideConversationMode === "replay-fork" ||
    sideConversationMode === "unsupported"
  ) {
    overrides.sideConversationMode = sideConversationMode;
  }
  if (providerThreadTargetingMode === "native" || providerThreadTargetingMode === "unsupported") {
    overrides.providerThreadTargetingMode = providerThreadTargetingMode;
  }
  if (sessionResumeMode === "native" || sessionResumeMode === "local-replay") {
    overrides.sessionResumeMode = sessionResumeMode;
  }
  if (turnSteeringMode === "native" || turnSteeringMode === "queued-message") {
    overrides.turnSteeringMode = turnSteeringMode;
  }
  if (goalControlMode === "native" || goalControlMode === "unsupported") {
    overrides.goalControlMode = goalControlMode;
  }
  if (
    multiAgentMode === "native" ||
    multiAgentMode === "agent-command" ||
    multiAgentMode === "unsupported"
  ) {
    overrides.multiAgentMode = multiAgentMode;
  }
  if (hookMode === "native" || hookMode === "unsupported") {
    overrides.hookMode = hookMode;
  }
  if (
    extensionMode === "native" ||
    extensionMode === "local-discovery" ||
    extensionMode === "unsupported"
  ) {
    overrides.extensionMode = extensionMode;
  }
  if (mcpMode === "native" || mcpMode === "local-discovery" || mcpMode === "unsupported") {
    overrides.mcpMode = mcpMode;
  }
  if (
    remoteAgentMode === "native" ||
    remoteAgentMode === "local-bridge" ||
    remoteAgentMode === "unsupported"
  ) {
    overrides.remoteAgentMode = remoteAgentMode;
  }
  if (
    webAccessMode === "native" ||
    webAccessMode === "agent-command" ||
    webAccessMode === "mcp-or-shell" ||
    webAccessMode === "unsupported"
  ) {
    overrides.webAccessMode = webAccessMode;
  }
  if (
    hostedSessionMode === "native" ||
    hostedSessionMode === "local-bridge" ||
    hostedSessionMode === "unsupported"
  ) {
    overrides.hostedSessionMode = hostedSessionMode;
  }

  return Object.keys(overrides).length > 0 ? overrides : null;
}

function providerCapabilityMethodContainers(input: {
  readonly config: Record<string, unknown> | undefined;
  readonly capabilities: Record<string, unknown>;
  readonly sessionCapabilities: Record<string, unknown> | undefined;
  readonly session: Record<string, unknown> | undefined;
  readonly sessions: Record<string, unknown> | undefined;
  readonly turn: Record<string, unknown> | undefined;
  readonly turns: Record<string, unknown> | undefined;
}): ReadonlyArray<unknown> {
  return [
    input.config?.methods,
    input.config?.availableMethods,
    input.config?.available_methods,
    input.capabilities.methods,
    input.capabilities.availableMethods,
    input.capabilities.available_methods,
    input.sessionCapabilities?.methods,
    input.sessionCapabilities?.availableMethods,
    input.sessionCapabilities?.available_methods,
    input.session?.methods,
    input.session?.availableMethods,
    input.session?.available_methods,
    input.sessions?.methods,
    input.sessions?.availableMethods,
    input.sessions?.available_methods,
    input.turn?.methods,
    input.turn?.availableMethods,
    input.turn?.available_methods,
    input.turns?.methods,
    input.turns?.availableMethods,
    input.turns?.available_methods,
    input.capabilities.tools,
    input.capabilities.availableTools,
    input.capabilities.available_tools,
    input.sessionCapabilities?.tools,
    input.sessionCapabilities?.availableTools,
    input.sessionCapabilities?.available_tools,
    input.session?.tools,
    input.session?.availableTools,
    input.session?.available_tools,
    input.sessions?.tools,
    input.sessions?.availableTools,
    input.sessions?.available_tools,
  ];
}

function normalizeProviderCapabilityMethod(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s]+/g, "-")
    .replace(/\/+/g, "-")
    .toLowerCase();
}

function providerCapabilityMethodNames(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") {
    const method = normalizeProviderCapabilityMethod(value);
    return method ? [method] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(providerCapabilityMethodNames);
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  return [
    record.name,
    record.method,
    record.id,
    record.type,
    record.command,
    record.rpc,
    record.path,
  ].flatMap(providerCapabilityMethodNames);
}

function hasProviderCapabilityMethod(
  containers: ReadonlyArray<unknown>,
  capability:
    | "session-fork"
    | "side-conversation"
    | "provider-thread-targeting"
    | "session-resume"
    | "turn-steer"
    | "goal-control"
    | "hooks"
    | "extensions"
    | "mcp"
    | "remote-agent"
    | "web-access"
    | "web-agent-command"
    | "hosted-session"
    | "local-session-bridge"
    | "multi-agent"
    | "agent-team"
    | "agent-handoff"
    | "subagent",
): boolean {
  const methods = new Set(containers.flatMap(providerCapabilityMethodNames));
  switch (capability) {
    case "session-fork":
      return ["session-fork", "thread-fork", "conversation-fork"].some((method) =>
        methods.has(method),
      );
    case "side-conversation":
      return [
        "side-chat",
        "side-conversation",
        "side-session",
        "side-thread",
        "session-side",
        "session-side-chat",
        "session-side-conversation",
        "session-side-session",
        "session-side-thread",
        "thread-side",
        "thread-side-chat",
        "thread-side-conversation",
        "thread-side-session",
        "thread-side-thread",
        "conversation-side",
        "conversation-side-chat",
        "conversation-side-conversation",
        "conversation-side-session",
        "conversation-side-thread",
      ].some((method) => methods.has(method));
    case "provider-thread-targeting":
      return [
        "session-target",
        "session-targeting",
        "thread-target",
        "thread-targeting",
        "provider-session-target",
        "provider-session-targeting",
        "provider-thread-target",
        "provider-thread-targeting",
        "provider-conversation-target",
        "provider-conversation-targeting",
        "child-thread-target",
        "child-thread-targeting",
        "child-session-target",
        "child-session-targeting",
        "child-conversation-target",
        "child-conversation-targeting",
        "session-message",
        "child-session-message",
        "child-conversation-message",
        "thread-message",
      ].some((method) => methods.has(method));
    case "session-resume":
      return ["session-resume", "session-load", "thread-resume", "conversation-resume"].some(
        (method) => methods.has(method),
      );
    case "turn-steer":
      return ["turn-steer", "turn-steering", "thread-steer", "session-steer"].some((method) =>
        methods.has(method),
      );
    case "goal-control":
      return [
        "goal-control",
        "goal-controls",
        "thread-goal",
        "thread-goal-control",
        "thread-goal-controls",
        "thread-goal-update",
        "thread-goal-clear",
        "goal-update",
        "goal-clear",
      ].some((method) => methods.has(method));
    case "hooks":
      return [
        "hook",
        "hooks",
        "agent-hook",
        "agent-hooks",
        "lifecycle-hook",
        "lifecycle-hooks",
        "workflow-hook",
        "workflow-hooks",
        "session-hook",
        "session-hooks",
        "pre-tool-use",
        "post-tool-use",
        "pre-tool-call",
        "post-tool-call",
        "permission-request",
      ].some((method) => methods.has(method));
    case "extensions":
      return [
        "extension",
        "extensions",
        "plugin",
        "plugins",
        "skill",
        "skills",
        "agent-skill",
        "agent-skills",
        "custom-agent",
        "custom-agents",
        "prompt-file",
        "prompt-files",
        "custom-prompt",
        "custom-prompts",
        "instruction",
        "instructions",
        "custom-instruction",
        "custom-instructions",
        "slash-command",
        "slash-commands",
      ].some((method) => methods.has(method));
    case "mcp":
      return [
        "mcp",
        "mcp-server",
        "mcp-servers",
        "model-context-protocol",
        "tool-server",
        "tool-servers",
        "external-tool",
        "external-tools",
        "connector",
        "connectors",
        "mcp-tool",
        "mcp-tools",
      ].some((method) => methods.has(method));
    case "remote-agent":
      return [
        "remote-agent",
        "remote-agents",
        "hosted-agent",
        "hosted-agents",
        "cloud-agent",
        "cloud-agents",
        "a2a-agent",
        "a2a-agents",
        "agent-connect",
        "agent-connection",
        "agent2agent",
        "agent-to-agent",
        "remote-delegation",
        "remote-subagent",
        "remote-subagents",
      ].some((method) => methods.has(method));
    case "web-access":
      return [
        "web",
        "web-access",
        "web-search",
        "web-searches",
        "web-fetch",
        "web-fetches",
        "web-tool",
        "web-tools",
        "websearch",
        "webfetch",
        "google-web-search",
        "google-web-searches",
        "google-search",
        "url-context",
        "url-fetch",
        "browser",
        "browsing",
        "browse",
        "internet-access",
      ].some((method) => methods.has(method));
    case "web-agent-command":
      return [
        "research",
        "deep-research",
        "web-research",
        "browser-agent",
        "browse-command",
        "web-command",
      ].some((method) => methods.has(method));
    case "hosted-session":
      return [
        "hosted-session",
        "hosted-sessions",
        "cloud-session",
        "cloud-sessions",
        "cloud-task",
        "cloud-tasks",
        "background-session",
        "background-sessions",
        "background-agent",
        "background-agents",
        "web-agent",
        "web-agents",
        "web-session",
        "web-sessions",
        "async-agent",
        "async-agents",
        "cloud-agent-session",
        "cloud-agent-sessions",
        "copilot-coding-agent",
        "coding-agent",
        "codex-cloud",
      ].some((method) => methods.has(method));
    case "local-session-bridge":
      return [
        "remote-control",
        "remote-session",
        "remote-sessions",
        "remote-tui",
        "remote-app-server",
        "local-bridge",
        "local-session-bridge",
        "teleport",
        "mobile-remote",
        "web-remote",
      ].some((method) => methods.has(method));
    case "multi-agent":
      return [
        "multi-agent",
        "multi-agents",
        "agent",
        "agents",
        "agent-delegate",
        "agent-delegation",
      ].some((method) => methods.has(method));
    case "agent-team":
      return ["agent-team", "agent-teams", "team-agent", "team-agents", "teams"].some((method) =>
        methods.has(method),
      );
    case "agent-handoff":
      return ["agent-handoff", "agent-handoffs", "handoff", "handoffs"].some((method) =>
        methods.has(method),
      );
    case "subagent":
      return ["subagent", "subagents", "sub-agent", "sub-agents", "task-agent"].some((method) =>
        methods.has(method),
      );
  }
}

function normalizeProviderMultiAgentMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["multiAgentMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "multi-agent" ||
      mode === "multi-agents" ||
      mode === "agent" ||
      mode === "agents" ||
      mode === "agent-team" ||
      mode === "agent-teams" ||
      mode === "handoff" ||
      mode === "handoffs" ||
      mode === "subagent" ||
      mode === "subagents"
    ) {
      return "native";
    }
    if (
      mode === "agent-command" ||
      mode === "command" ||
      mode === "commands" ||
      mode === "slash-command" ||
      mode === "slash-commands" ||
      mode === "mention" ||
      mode === "mentions"
    ) {
      return "agent-command";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderExtensionMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["extensionMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "extension" ||
      mode === "extensions" ||
      mode === "plugin" ||
      mode === "plugins" ||
      mode === "skill" ||
      mode === "skills" ||
      mode === "agent-skill" ||
      mode === "agent-skills" ||
      mode === "custom-agent" ||
      mode === "custom-agents" ||
      mode === "prompt-file" ||
      mode === "prompt-files" ||
      mode === "instructions" ||
      mode === "custom-instructions"
    ) {
      return "native";
    }
    if (
      mode === "local-discovery" ||
      mode === "local" ||
      mode === "discovered" ||
      mode === "local-commands" ||
      mode === "command-discovery" ||
      mode === "slash-command" ||
      mode === "slash-commands"
    ) {
      return "local-discovery";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderMcpMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["mcpMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "mcp" ||
      mode === "mcp-server" ||
      mode === "mcp-servers" ||
      mode === "model-context-protocol" ||
      mode === "tool-server" ||
      mode === "tool-servers" ||
      mode === "external-tool" ||
      mode === "external-tools" ||
      mode === "connector" ||
      mode === "connectors"
    ) {
      return "native";
    }
    if (
      mode === "local-discovery" ||
      mode === "local" ||
      mode === "discovered" ||
      mode === "local-config" ||
      mode === "config-discovery"
    ) {
      return "local-discovery";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderRemoteAgentMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["remoteAgentMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "remote-agent" ||
      mode === "remote-agents" ||
      mode === "hosted-agent" ||
      mode === "hosted-agents" ||
      mode === "cloud-agent" ||
      mode === "cloud-agents" ||
      mode === "a2a-agent" ||
      mode === "a2a-agents" ||
      mode === "agent-connect" ||
      mode === "agent-to-agent" ||
      mode === "agent2agent" ||
      mode === "remote-delegation"
    ) {
      return "native";
    }
    if (
      mode === "local-bridge" ||
      mode === "bridge" ||
      mode === "local" ||
      mode === "remote-bridge" ||
      mode === "remote-connection" ||
      mode === "remote-connection-bridge"
    ) {
      return "local-bridge";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderWebAccessMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["webAccessMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "web" ||
      mode === "web-access" ||
      mode === "web-search" ||
      mode === "web-searches" ||
      mode === "web-fetch" ||
      mode === "web-fetches" ||
      mode === "web-tool" ||
      mode === "web-tools" ||
      mode === "websearch" ||
      mode === "webfetch" ||
      mode === "google-web-search" ||
      mode === "url-context" ||
      mode === "url-fetch" ||
      mode === "browser" ||
      mode === "browsing" ||
      mode === "browse" ||
      mode === "internet" ||
      mode === "internet-access" ||
      mode === "live-search" ||
      mode === "cached-search"
    ) {
      return "native";
    }
    if (
      mode === "agent-command" ||
      mode === "command" ||
      mode === "commands" ||
      mode === "slash-command" ||
      mode === "slash-commands" ||
      mode === "research" ||
      mode === "deep-research" ||
      mode === "web-research" ||
      mode === "browser-agent"
    ) {
      return "agent-command";
    }
    if (
      mode === "mcp-or-shell" ||
      mode === "mcp" ||
      mode === "shell" ||
      mode === "terminal" ||
      mode === "local-network" ||
      mode === "network" ||
      mode === "external-tool" ||
      mode === "external-tools"
    ) {
      return "mcp-or-shell";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderHostedSessionMode(
  ...values: ReadonlyArray<unknown>
): ProviderIntegrationCapabilities["hostedSessionMode"] | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, "native");
    if (!mode) {
      continue;
    }
    if (
      mode === "native" ||
      mode === "provider-native" ||
      mode === "hosted-session" ||
      mode === "hosted-sessions" ||
      mode === "cloud-session" ||
      mode === "cloud-sessions" ||
      mode === "cloud-task" ||
      mode === "cloud-tasks" ||
      mode === "background-session" ||
      mode === "background-sessions" ||
      mode === "background-agent" ||
      mode === "background-agents" ||
      mode === "web-agent" ||
      mode === "web-agents" ||
      mode === "web-session" ||
      mode === "web-sessions" ||
      mode === "async-agent" ||
      mode === "async-agents" ||
      mode === "cloud-agent-session" ||
      mode === "cloud-agent-sessions" ||
      mode === "copilot-coding-agent" ||
      mode === "coding-agent" ||
      mode === "codex-cloud"
    ) {
      return "native";
    }
    if (
      mode === "local-bridge" ||
      mode === "bridge" ||
      mode === "local" ||
      mode === "remote-control" ||
      mode === "remote-session" ||
      mode === "remote-sessions" ||
      mode === "remote-tui" ||
      mode === "remote-app-server" ||
      mode === "local-session-bridge" ||
      mode === "teleport" ||
      mode === "mobile-remote" ||
      mode === "web-remote"
    ) {
      return "local-bridge";
    }
    if (mode === "unsupported" || mode === "none" || mode === "disabled" || mode === "false") {
      return "unsupported";
    }
  }
  return undefined;
}

function normalizeProviderCapabilityMode(
  enabledMode: string,
  ...values: ReadonlyArray<unknown>
): string | undefined {
  for (const value of values) {
    const mode = normalizeProviderCapabilityValue(value, enabledMode);
    if (mode) {
      return mode;
    }
  }
  return undefined;
}

function normalizeProviderCapabilityValue(value: unknown, enabledMode: string): string | undefined {
  const raw = asNonEmptyString(value);
  if (raw) {
    return normalizeProviderCapabilityString(raw);
  }
  if (typeof value === "boolean") {
    return value ? enabledMode : "unsupported";
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const recordMode =
    normalizeProviderCapabilityValue(record.mode, enabledMode) ??
    normalizeProviderCapabilityValue(record.kind, enabledMode) ??
    normalizeProviderCapabilityValue(record.value, enabledMode) ??
    normalizeProviderCapabilityValue(record.support, enabledMode) ??
    normalizeProviderCapabilityValue(record.supported, enabledMode) ??
    normalizeProviderCapabilityValue(record.enabled, enabledMode);
  if (recordMode) {
    return recordMode;
  }
  return enabledMode;
}

function normalizeProviderCapabilityString(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_\s]+/g, "-")
    .trim()
    .toLowerCase();
}

function normalizeProviderSessionConfigOptionValues(
  value: unknown,
): ReadonlyArray<ProviderSessionConfigOption["options"][number]> {
  const optionEntries = asArray(value);
  if (!optionEntries) {
    return [];
  }

  const options: ProviderSessionConfigOption["options"][number][] = [];
  for (const optionEntry of optionEntries) {
    const optionRecord = asRecord(optionEntry);
    const optionValue =
      asNonEmptyString(optionRecord?.value) ??
      asNonEmptyString(optionRecord?.id) ??
      asNonEmptyString(optionEntry);
    const optionName =
      asNonEmptyString(optionRecord?.name) ?? asNonEmptyString(optionRecord?.label) ?? optionValue;
    if (!optionValue || !optionName) {
      continue;
    }
    options.push({
      value: optionValue,
      name: optionName,
      ...(asNonEmptyString(optionRecord?.description)
        ? { description: asNonEmptyString(optionRecord?.description)! }
        : {}),
    });
  }

  return options;
}

function normalizeProviderSessionConfigOptionType(input: {
  readonly rawType: unknown;
  readonly normalizedValues: ReadonlyArray<ProviderSessionConfigOption["options"][number]>;
  readonly currentValue: string | undefined;
}): ProviderSessionConfigOption["type"] | undefined {
  const rawType = asNonEmptyString(input.rawType);
  if (rawType) {
    const normalized = normalizeProviderCapabilityString(rawType);
    if (
      normalized === "select" ||
      normalized === "choice" ||
      normalized === "enum" ||
      normalized === "dropdown" ||
      normalized === "radio"
    ) {
      return "select";
    }
    if (
      normalized === "boolean" ||
      normalized === "bool" ||
      normalized === "toggle" ||
      normalized === "switch" ||
      normalized === "checkbox"
    ) {
      return "boolean";
    }
    if (
      normalized === "text" ||
      normalized === "string" ||
      normalized === "input" ||
      normalized === "textarea" ||
      normalized === "freeform" ||
      normalized === "free-form"
    ) {
      return "text";
    }
    if (
      normalized === "number" ||
      normalized === "numeric" ||
      normalized === "integer" ||
      normalized === "float" ||
      normalized === "range" ||
      normalized === "slider"
    ) {
      return "number";
    }
  }

  if (input.normalizedValues.length > 0) {
    return "select";
  }
  if (input.currentValue === "on" || input.currentValue === "off") {
    return "boolean";
  }
  return undefined;
}

function defaultBooleanConfigOptionValues(): ReadonlyArray<
  ProviderSessionConfigOption["options"][number]
> {
  return [
    { value: "off", name: "Off" },
    { value: "on", name: "On" },
  ];
}

function normalizeProviderSessionConfigOptions(
  value: unknown,
): ReadonlyArray<ProviderSessionConfigOption> | null {
  const optionEntries = asArray(value);
  if (!optionEntries) {
    return null;
  }

  const options: ProviderSessionConfigOption[] = [];
  for (const optionEntry of optionEntries) {
    const optionRecord = asRecord(optionEntry);
    const id =
      asNonEmptyString(optionRecord?.id) ??
      asNonEmptyString(optionRecord?.key) ??
      asNonEmptyString(optionRecord?.setting) ??
      asNonEmptyString(optionRecord?.field);
    const name =
      asNonEmptyString(optionRecord?.name) ??
      asNonEmptyString(optionRecord?.label) ??
      asNonEmptyString(optionRecord?.title) ??
      id;
    const currentValue =
      asConfigValueString(optionRecord?.currentValue) ??
      asConfigValueString(optionRecord?.current_value) ??
      asConfigValueString(optionRecord?.selectedValue) ??
      asConfigValueString(optionRecord?.selected_value) ??
      asConfigValueString(optionRecord?.selected) ??
      asConfigValueString(optionRecord?.current) ??
      asConfigValueString(optionRecord?.activeValue) ??
      asConfigValueString(optionRecord?.active_value) ??
      asConfigValueString(optionRecord?.value);
    const normalizedValues = normalizeProviderSessionConfigOptionValues(
      optionRecord?.options ?? optionRecord?.values ?? optionRecord?.choices ?? optionRecord?.items,
    );
    const type = normalizeProviderSessionConfigOptionType({
      rawType: optionRecord?.type ?? optionRecord?.kind ?? optionRecord?.control,
      normalizedValues,
      currentValue,
    });
    if (!id || !name || currentValue === undefined || !type) {
      continue;
    }
    if (type === "select" && normalizedValues.length === 0) {
      continue;
    }
    const optionValues =
      type === "boolean" && normalizedValues.length === 0
        ? defaultBooleanConfigOptionValues()
        : normalizedValues;

    options.push({
      id,
      name,
      ...(asNonEmptyString(optionRecord?.description)
        ? { description: asNonEmptyString(optionRecord?.description)! }
        : {}),
      ...(asNonEmptyString(optionRecord?.category)
        ? { category: asNonEmptyString(optionRecord?.category)! }
        : {}),
      type,
      currentValue,
      options: optionValues,
      ...(asFiniteNumber(optionRecord?.minValue ?? optionRecord?.min_value ?? optionRecord?.min) !==
      undefined
        ? {
            minValue: asFiniteNumber(
              optionRecord?.minValue ?? optionRecord?.min_value ?? optionRecord?.min,
            )!,
          }
        : {}),
      ...(asFiniteNumber(optionRecord?.maxValue ?? optionRecord?.max_value ?? optionRecord?.max) !==
      undefined
        ? {
            maxValue: asFiniteNumber(
              optionRecord?.maxValue ?? optionRecord?.max_value ?? optionRecord?.max,
            )!,
          }
        : {}),
      ...(asFiniteNumber(
        optionRecord?.stepValue ?? optionRecord?.step_value ?? optionRecord?.step,
      ) !== undefined
        ? {
            stepValue: asFiniteNumber(
              optionRecord?.stepValue ?? optionRecord?.step_value ?? optionRecord?.step,
            )!,
          }
        : {}),
    });
  }

  return options;
}

function providerConfigOptionsFromSessionConfigured(
  event: ProviderRuntimeEvent,
): ReadonlyArray<ProviderSessionConfigOption> | null {
  if (event.type !== "session.configured") {
    return null;
  }
  const config = asRecord(event.payload.config);
  if (!config) {
    return null;
  }

  return (
    normalizeProviderSessionConfigOptions(config.configOptions) ??
    normalizeProviderSessionConfigOptions(config.config_options) ??
    normalizeProviderSessionConfigOptions(config.options)
  );
}

const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_TURN_MESSAGE_IDS_CACHE_CAPACITY ?? "2000", 10) || 2_000,
);
const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_TURN_MESSAGE_IDS_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = Math.max(
  512,
  Number.parseInt(process.env.ACE_BUFFERED_ASSISTANT_TEXT_CACHE_CAPACITY ?? "4000", 10) || 4_000,
);
const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_BUFFERED_ASSISTANT_TEXT_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_BUFFERED_PROPOSED_PLAN_CACHE_CAPACITY ?? "2000", 10) || 2_000,
);
const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(
  Math.max(
    5,
    Number.parseInt(process.env.ACE_BUFFERED_PROPOSED_PLAN_CACHE_TTL_MINUTES ?? "45", 10) || 45,
  ),
);
const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
const MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS = 96;
const MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS_CURSOR = 96;
const MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS = 96;
const MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS_CURSOR = 96;
const PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY = Math.max(
  256,
  Number.parseInt(process.env.ACE_PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY ?? "10000", 10) ||
    10_000,
);
const PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS = Math.max(
  32,
  Number.parseInt(
    process.env.ACE_PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS ?? "256",
    10,
  ) || 256,
);
const PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES = Math.max(
  512 * 1024 * 1024,
  Number.parseInt(
    process.env.ACE_PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES ?? String(1_200 * 1024 * 1024),
    10,
  ) || 1_200 * 1024 * 1024,
);
const STRICT_PROVIDER_LIFECYCLE_GUARD = process.env.ACE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";
const GENERATED_IMAGE_ATTACHMENT_NAME = "generated-image.png";

function streamingAssistantDeltaBatchLimit(provider: ProviderRuntimeEvent["provider"]): number {
  // Cursor ACP emits many token-sized chunks, so a smaller flush threshold keeps the UI live.
  return provider === "cursor"
    ? MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS_CURSOR
    : MAX_STREAMING_ASSISTANT_DELTA_BATCH_CHARS;
}

function streamingThinkingActivityBatchLimit(provider: ProviderRuntimeEvent["provider"]): number {
  return provider === "cursor"
    ? MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS_CURSOR
    : MAX_STREAMING_THINKING_ACTIVITY_BATCH_CHARS;
}

type TurnStartRequestedDomainEvent = Extract<
  OrchestrationEvent,
  { type: "thread.turn-start-requested" }
>;

type RuntimeIngestionInput =
  | {
      source: "runtime";
      event: ProviderRuntimeEvent;
    }
  | {
      source: "domain";
      event: TurnStartRequestedDomainEvent;
    };

function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.makeUnsafe(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.makeUnsafe(value);
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function runtimeProcessPidFromSessionEvent(event: ProviderRuntimeEvent): number | undefined {
  switch (event.type) {
    case "session.started":
    case "session.state.changed":
    case "session.exited":
      return event.payload.processPid;
    default:
      return undefined;
  }
}

function isRuntimeProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") {
        return true;
      }
      if (code === "ESRCH") {
        return false;
      }
    }
    return false;
  }
}

function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function truncateActivityText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

function hasRenderableReasoningText(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function normalizeProposedPlanMarkdown(planMarkdown: string | undefined): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

function assistantStreamKey(
  threadId: ThreadId,
  turnId: TurnId | undefined,
  itemId: ProviderRuntimeEvent["itemId"] | undefined,
) {
  return `${threadId}:${turnId ?? "no-turn"}:${itemId ?? "no-item"}`;
}

function imageGenerationTurnKey(threadId: ThreadId, turnId: TurnId | undefined) {
  return `${threadId}:${turnId ?? "no-turn"}:image-generation`;
}

function imageGenerationStreamKey(threadId: ThreadId, turnId: TurnId | undefined) {
  return `${threadId}:${turnId ?? "no-turn"}:image-generation`;
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens <= 0) {
    return undefined;
  }
  return event.payload.usage;
}

function activityFingerprint(activity: OrchestrationThreadActivity): string {
  const payload = (() => {
    try {
      return JSON.stringify(activity.payload);
    } catch {
      return "[unserializable]";
    }
  })();
  return `${activity.kind}|${activity.turnId ?? "none"}|${activity.summary}|${payload}`;
}

type LiveTurnDiffSource = "provider-native" | "provider-reconstructed";

type LiveTurnDiffFile = {
  path: string;
  kind: "modified";
  additions: number;
  deletions: number;
};

type LiveTurnDiffAggregate = {
  source: LiveTurnDiffSource;
  files: Map<string, LiveTurnDiffFile>;
  diff?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  const direct = asString(value)?.trim();
  return direct && direct.length > 0 ? direct : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeCommandValue(value: unknown): string | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => asTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function firstTrimmedString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function normalizeProviderItemType(value: unknown): string | undefined {
  return asString(value)
    ?.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeGeneratedImageDataUrl(value: unknown): string | undefined {
  const source = asString(value)?.trim();
  if (!source) {
    return undefined;
  }
  if (/^data:image\/[a-z0-9.+-]+;base64,/iu.test(source)) {
    return source;
  }
  const compact = source.replace(/\s+/g, "");
  if (compact.length >= 64 && /^[A-Za-z0-9+/]+={0,2}$/u.test(compact)) {
    return `data:image/png;base64,${compact}`;
  }
  return undefined;
}

type ImageGenerationDimensions = {
  width: number;
  height: number;
};

const DEFAULT_IMAGE_GENERATION_DIMENSIONS: ImageGenerationDimensions = {
  width: 1024,
  height: 1024,
};

const STRUCTURED_IMAGE_GENERATION_TOOL_NAMES = new Set([
  "image generation prehook",
  "imagegen",
  "image generation",
  "image gen",
]);

function normalizeImageGenerationDimension(value: unknown): number | undefined {
  const dimension = asFiniteNumber(value);
  if (dimension === undefined || dimension < 32 || dimension > 8192) {
    return undefined;
  }
  return Math.round(dimension);
}

function parseImageGenerationDimensionsText(value: unknown): ImageGenerationDimensions | undefined {
  const text = asString(value);
  if (!text) {
    return undefined;
  }
  const match = /(?<width>\d{2,5})\s*[x×]\s*(?<height>\d{2,5})/iu.exec(text);
  if (!match?.groups) {
    return undefined;
  }
  const width = normalizeImageGenerationDimension(match.groups.width);
  const height = normalizeImageGenerationDimension(match.groups.height);
  return width !== undefined && height !== undefined ? { width, height } : undefined;
}

function imageGenerationLifecycleSource(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): Record<string, unknown> | undefined {
  const data = asRecord(payload.data);
  return asRecord(data?.item) ?? data;
}

function normalizedStructuredToolName(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) {
    return normalizeProviderItemType(direct);
  }

  const record = asRecord(value);
  return normalizeProviderItemType(
    record?.name ?? record?.tool ?? record?.toolName ?? record?.tool_name,
  );
}

function structuredImageGenerationToolName(
  item: Record<string, unknown> | undefined,
): string | undefined {
  if (!item) {
    return undefined;
  }

  for (const candidate of [
    item.tool,
    item.name,
    item.toolName,
    item.tool_name,
    item.functionName,
    item.function_name,
  ]) {
    const normalized = normalizedStructuredToolName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  const functionRecord = asRecord(item.function);
  const toolCallRecord = asRecord(item.toolCall) ?? asRecord(item.tool_call);
  const inputRecord = asRecord(item.input);
  for (const candidate of [
    functionRecord?.name,
    functionRecord?.tool,
    toolCallRecord?.name,
    toolCallRecord?.tool,
    toolCallRecord?.toolName,
    toolCallRecord?.tool_name,
    inputRecord?.name,
    inputRecord?.tool,
    inputRecord?.toolName,
    inputRecord?.tool_name,
  ]) {
    const normalized = normalizedStructuredToolName(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function isStructuredToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): boolean {
  if (isToolLifecycleItemType(payload.itemType)) {
    return true;
  }

  const item = imageGenerationLifecycleSource(payload);
  const normalizedType = normalizeProviderItemType(item?.type ?? item?.kind);
  return (
    normalizedType === "dynamic tool call" ||
    normalizedType === "mcp tool call" ||
    normalizedType === "tool call" ||
    normalizedType === "function call" ||
    normalizedType === "custom tool call" ||
    normalizedType === "collab agent tool call"
  );
}

function isStructuredImageGenerationToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): boolean {
  if (!isStructuredToolLifecyclePayload(payload)) {
    return false;
  }
  const toolName = structuredImageGenerationToolName(imageGenerationLifecycleSource(payload));
  return toolName !== undefined && STRUCTURED_IMAGE_GENERATION_TOOL_NAMES.has(toolName);
}

function imageGenerationToolRequestSource(
  payload: Extract<ProviderRuntimeEvent, { type: "request.opened" }>["payload"],
): Record<string, unknown> | undefined {
  const args = asRecord(payload.args);
  return asRecord(args?.item) ?? args;
}

function isImageGenerationToolRequestPayload(
  payload: Extract<ProviderRuntimeEvent, { type: "request.opened" }>["payload"],
): boolean {
  if (payload.requestType !== "dynamic_tool_call") {
    return false;
  }
  const toolName = structuredImageGenerationToolName(imageGenerationToolRequestSource(payload));
  return toolName !== undefined && STRUCTURED_IMAGE_GENERATION_TOOL_NAMES.has(toolName);
}

function isImageGenerationLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): boolean {
  const item = imageGenerationLifecycleSource(payload);
  const normalizedType = normalizeProviderItemType(item?.type ?? item?.kind);
  return normalizedType?.includes("image generation") === true;
}

function isImageGenerationPlaceholderPayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): boolean {
  return (
    isImageGenerationLifecyclePayload(payload) ||
    isStructuredImageGenerationToolLifecyclePayload(payload)
  );
}

function extractGeneratedImageDataUrl(
  payload: Extract<ProviderRuntimeEvent, { type: "item.completed" }>["payload"],
): string | undefined {
  if (!isImageGenerationPlaceholderPayload(payload)) {
    return undefined;
  }

  const data = asRecord(payload.data);
  const item = imageGenerationLifecycleSource(payload);
  const result = asRecord(item?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output);
  return (
    normalizeGeneratedImageDataUrl(item?.result) ??
    normalizeGeneratedImageDataUrl(result?.data) ??
    normalizeGeneratedImageDataUrl(result?.image) ??
    normalizeGeneratedImageDataUrl(result?.base64) ??
    normalizeGeneratedImageDataUrl(result?.b64_json) ??
    normalizeGeneratedImageDataUrl(result?.base64Json) ??
    normalizeGeneratedImageDataUrl(item?.image) ??
    normalizeGeneratedImageDataUrl(output?.data) ??
    normalizeGeneratedImageDataUrl(output?.image) ??
    normalizeGeneratedImageDataUrl(output?.base64) ??
    normalizeGeneratedImageDataUrl(data?.result) ??
    normalizeGeneratedImageDataUrl(data?.image)
  );
}

function extractImageGenerationDimensionsFromSource(
  item: Record<string, unknown> | undefined,
): ImageGenerationDimensions {
  const result = asRecord(item?.result);
  const input = asRecord(item?.input);
  const argumentsRecord = asRecord(item?.arguments);
  const options = asRecord(item?.options);

  for (const record of [item, input, argumentsRecord, options, result]) {
    if (!record) {
      continue;
    }
    const width = normalizeImageGenerationDimension(record.width ?? record.w);
    const height = normalizeImageGenerationDimension(record.height ?? record.h);
    if (width !== undefined && height !== undefined) {
      return { width, height };
    }
  }

  for (const candidate of [
    item?.size,
    item?.dimensions,
    item?.imageSize,
    item?.image_size,
    input?.size,
    input?.dimensions,
    argumentsRecord?.size,
    argumentsRecord?.dimensions,
    options?.size,
    options?.dimensions,
    result?.size,
  ]) {
    const dimensions = parseImageGenerationDimensionsText(candidate);
    if (dimensions) {
      return dimensions;
    }
  }

  return DEFAULT_IMAGE_GENERATION_DIMENSIONS;
}

function imageGenerationAssistantMessageId(
  event: Extract<ProviderRuntimeEvent, { type: "item.started" | "item.completed" }>,
): MessageId {
  const item = imageGenerationLifecycleSource(event.payload);
  const dimensions = extractImageGenerationDimensionsFromSource(item);
  const sourceItemId = asNonEmptyString(item?.id);
  const suffix = event.itemId ?? sourceItemId ?? event.turnId ?? event.eventId;
  return MessageId.makeUnsafe(`assistant:image:${dimensions.width}x${dimensions.height}:${suffix}`);
}

function imageGenerationRequestAssistantMessageId(
  event: Extract<ProviderRuntimeEvent, { type: "request.opened" }>,
): MessageId {
  const source = imageGenerationToolRequestSource(event.payload);
  const dimensions = extractImageGenerationDimensionsFromSource(source);
  const sourceItemId =
    asNonEmptyString(source?.id) ??
    asNonEmptyString(source?.callId) ??
    asNonEmptyString(source?.call_id);
  const suffix = event.itemId ?? sourceItemId ?? event.requestId ?? event.turnId ?? event.eventId;
  return MessageId.makeUnsafe(`assistant:image:${dimensions.width}x${dimensions.height}:${suffix}`);
}

function lineCount(value: string | undefined): number {
  if (!value) {
    return 0;
  }
  return value.split("\n").length;
}

function countUnifiedDiffStats(diff: string): { additions: number; deletions: number } {
  return diff.split("\n").reduce(
    (acc, line) => {
      if (line.startsWith("+++ ") || line.startsWith("--- ")) {
        return acc;
      }
      if (line.startsWith("+")) {
        acc.additions += 1;
      } else if (line.startsWith("-")) {
        acc.deletions += 1;
      }
      return acc;
    },
    { additions: 0, deletions: 0 },
  );
}

function summarizeUnifiedDiffFiles(diff: string): ReadonlyArray<LiveTurnDiffFile> {
  const parsed = parseTurnDiffFilesFromUnifiedDiff(diff).map((file) => ({
    path: file.path,
    kind: "modified" as const,
    additions: file.additions,
    deletions: file.deletions,
  }));
  if (parsed.some((file) => file.additions > 0 || file.deletions > 0)) {
    return parsed;
  }

  const fallbackStats = countUnifiedDiffStats(diff);
  if (parsed.length > 0 && (fallbackStats.additions > 0 || fallbackStats.deletions > 0)) {
    return parsed.map((file, index) =>
      index === 0
        ? {
            ...file,
            additions: fallbackStats.additions,
            deletions: fallbackStats.deletions,
          }
        : file,
    );
  }

  return parsed;
}

function extractUnifiedDiffCandidate(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const candidate of [
    asString(record.unifiedDiff),
    asString(record.diff),
    asString(record.patch),
    asString(record.content),
    asString(record.text),
  ]) {
    if (candidate && /(^diff --git |^--- |^@@ )/m.test(candidate)) {
      return candidate;
    }
  }

  for (const key of ["data", "input", "arguments", "result", "rawInput", "rawOutput", "output"]) {
    const nested = extractUnifiedDiffCandidate(record[key]);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function collectPathCandidates(value: unknown, results: Set<string>) {
  const record = asRecord(value);
  if (!record) {
    return;
  }

  for (const key of [
    "path",
    "filePath",
    "relativePath",
    "filename",
    "file_name",
    "newPath",
    "oldPath",
  ]) {
    const candidate = asString(record[key])?.trim();
    if (candidate && candidate !== "/dev/null") {
      results.add(candidate);
    }
  }

  for (const key of ["data", "input", "arguments", "result", "rawInput", "rawOutput", "output"]) {
    collectPathCandidates(record[key], results);
  }

  const content = asArray(record.content);
  if (content) {
    for (const entry of content) {
      collectPathCandidates(entry, results);
    }
  }
}

function extractLiveTurnDiffFromItem(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): { files: ReadonlyArray<LiveTurnDiffFile>; diff?: string } | null {
  if (event.payload.itemType !== "file_change") {
    return null;
  }

  const payloadData = asRecord(event.payload.data);
  const unifiedDiff = extractUnifiedDiffCandidate(payloadData);
  if (unifiedDiff) {
    const files = summarizeUnifiedDiffFiles(unifiedDiff);
    if (files.length > 0) {
      return { files, diff: unifiedDiff };
    }
  }

  const content = asArray(payloadData?.content);
  if (content) {
    const diffFiles = content
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => entry.type === "diff")
      .map((entry) => {
        const path = asString(entry.path);
        if (!path) {
          return undefined;
        }
        return {
          path,
          kind: "modified" as const,
          additions: lineCount(asString(entry.newText)),
          deletions: lineCount(asString(entry.oldText)),
        };
      })
      .filter((entry): entry is LiveTurnDiffFile => entry !== undefined);
    if (diffFiles.length > 0) {
      return { files: diffFiles };
    }
  }

  const paths = new Set<string>();
  collectPathCandidates(payloadData, paths);
  if (paths.size === 0) {
    const detailPath = event.payload.detail?.trim();
    if (detailPath && !detailPath.includes("\n")) {
      paths.add(detailPath);
    }
  }
  if (paths.size === 0) {
    return null;
  }

  return {
    files: [...paths].map((path) => ({
      path,
      kind: "modified" as const,
      additions: 0,
      deletions: 0,
    })),
  };
}

function asActivityPayloadRecord(
  activity: Pick<OrchestrationThreadActivity, "payload">,
): Record<string, unknown> | null {
  return activity.payload &&
    typeof activity.payload === "object" &&
    !Array.isArray(activity.payload)
    ? (activity.payload as Record<string, unknown>)
    : null;
}

function thinkingTaskIdFromActivity(activity: OrchestrationThreadActivity): string | undefined {
  const payload = asActivityPayloadRecord(activity);
  return typeof payload?.taskId === "string" && payload.taskId.length > 0
    ? payload.taskId
    : undefined;
}

function thinkingActivityBufferKey(
  threadId: ThreadId,
  turnId: TurnId | null | undefined,
  taskId: string,
): string {
  return `${threadId}:${turnId ?? "no-turn"}:${taskId}`;
}

function thinkingActivityBufferKeyFromActivity(
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
): string | undefined {
  const taskId = thinkingTaskIdFromActivity(activity);
  return taskId ? thinkingActivityBufferKey(threadId, activity.turnId, taskId) : undefined;
}

function isBufferedThinkingActivity(activity: OrchestrationThreadActivity): boolean {
  return activity.kind === "task.progress" && thinkingTaskIdFromActivity(activity) !== undefined;
}

function thinkingActivityDeltaLength(activity: OrchestrationThreadActivity): number {
  const payload = asActivityPayloadRecord(activity);
  const detail =
    typeof payload?.detail === "string"
      ? payload.detail
      : typeof payload?.description === "string"
        ? payload.description
        : typeof payload?.summary === "string"
          ? payload.summary
          : "";
  return detail.length;
}

interface BufferedThinkingActivity {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly taskId: string;
  provider: ProviderRuntimeEvent["provider"];
  activity: OrchestrationThreadActivity;
  pendingCharsSinceFlush: number;
  dirty: boolean;
}

type ActivityStreamingSettings = {
  readonly enableToolStreaming: boolean;
  readonly enableThinkingStreaming: boolean;
};

const ALL_ACTIVITY_STREAMING_SETTINGS: ActivityStreamingSettings = {
  enableToolStreaming: true,
  enableThinkingStreaming: true,
};

function extractReasoningDetail(event: Extract<ProviderRuntimeEvent, { type: "item.completed" }>) {
  if (hasRenderableReasoningText(event.payload.detail)) {
    return event.payload.detail;
  }

  if (event.payload.data && typeof event.payload.data === "object") {
    const payloadData = event.payload.data as Record<string, unknown>;
    if (hasRenderableReasoningText(payloadData.content as string | undefined)) {
      return payloadData.content as string;
    }
  }

  return undefined;
}

const MAX_ACTIVITY_DETAIL_CHARS = 4_000;
const MAX_ACTIVITY_TERMINAL_OUTPUT_CHARS = 16_000;

function toolLifecycleData(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): {
  data: Record<string, unknown> | undefined;
  item: Record<string, unknown> | undefined;
  input: Record<string, unknown> | undefined;
  result: Record<string, unknown> | undefined;
  output: Record<string, unknown> | undefined;
} {
  const data = asRecord(payload.data);
  const item = asRecord(data?.item) ?? data;
  const input =
    asRecord(item?.input) ??
    asRecord(data?.input) ??
    asRecord(data?.arguments) ??
    asRecord(data?.args) ??
    asRecord(data?.rawInput);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output) ?? asRecord(result?.output);
  return { data, item, input, result, output };
}

function commandFromToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): string | undefined {
  const { data, item, input, result } = toolLifecycleData(payload);
  return (
    normalizeCommandValue(item?.command) ??
    normalizeCommandValue(input?.command) ??
    normalizeCommandValue(result?.command) ??
    normalizeCommandValue(data?.command) ??
    normalizeCommandValue(data?.cmd) ??
    normalizeCommandValue(data?.fullCommandText) ??
    normalizeCommandValue(input?.cmd) ??
    normalizeCommandValue(result?.cmd)
  );
}

function cwdFromToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): string | undefined {
  const { data, item, input, result } = toolLifecycleData(payload);
  return firstTrimmedString(item?.cwd, input?.cwd, result?.cwd, data?.cwd, data?.workingDirectory);
}

function exitCodeFromToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): number | undefined {
  const { data, item, result, output } = toolLifecycleData(payload);
  const exitCode = asFiniteNumber(
    item?.exitCode ??
      item?.exit_code ??
      result?.exitCode ??
      result?.exit_code ??
      output?.exitCode ??
      output?.exit_code ??
      data?.exitCode ??
      data?.exit_code,
  );
  return exitCode === undefined ? undefined : Math.trunc(exitCode);
}

function durationMsFromToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): number | undefined {
  const { data, item, result } = toolLifecycleData(payload);
  const durationMs = asFiniteNumber(
    item?.durationMs ??
      item?.duration_ms ??
      result?.durationMs ??
      result?.duration_ms ??
      data?.durationMs,
  );
  return durationMs === undefined || durationMs < 0 ? undefined : Math.round(durationMs);
}

function joinedOutputFromParts(stdout: unknown, stderr: unknown): string | undefined {
  const parts = [asString(stdout), asString(stderr)]
    .filter((entry): entry is string => entry !== undefined && entry.length > 0)
    .map((entry) => entry.replace(/\r\n?/g, "\n").trimEnd());
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function terminalOutputFromToolLifecyclePayload(
  payload: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >["payload"],
): string | undefined {
  const { data, item, result, output } = toolLifecycleData(payload);
  return firstTrimmedString(
    item?.aggregatedOutput,
    item?.aggregated_output,
    result?.aggregatedOutput,
    result?.aggregated_output,
    output?.aggregatedOutput,
    output?.aggregated_output,
    data?.aggregatedOutput,
    data?.aggregated_output,
    joinedOutputFromParts(item?.stdout, item?.stderr),
    joinedOutputFromParts(result?.stdout, result?.stderr),
    joinedOutputFromParts(output?.stdout, output?.stderr),
    joinedOutputFromParts(data?.stdout, data?.stderr),
    output?.text,
    result?.text,
    data?.output,
  );
}

function oneLineToolText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizedToolActivityTitle(input: {
  readonly itemType: string;
  readonly fallbackTitle?: string | undefined;
  readonly command?: string | undefined;
}): string | undefined {
  if (input.itemType === "command_execution" && input.command) {
    return truncateActivityText(`Ran command ${oneLineToolText(input.command)}`, 220);
  }
  if (input.fallbackTitle) {
    return input.fallbackTitle;
  }
  if (input.itemType === "command_execution") {
    return "Ran command";
  }
  return undefined;
}

function normalizedToolActivityPayload(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): Record<string, unknown> {
  const command = commandFromToolLifecyclePayload(event.payload);
  const cwd = cwdFromToolLifecyclePayload(event.payload);
  const exitCode = exitCodeFromToolLifecyclePayload(event.payload);
  const durationMs = durationMsFromToolLifecyclePayload(event.payload);
  const terminalOutput = terminalOutputFromToolLifecyclePayload(event.payload);
  const title = normalizedToolActivityTitle({
    itemType: event.payload.itemType,
    fallbackTitle: event.payload.title,
    command,
  });
  const detail = event.payload.detail?.trim();
  const detailIsCommand =
    command !== undefined &&
    detail !== undefined &&
    oneLineToolText(detail) === oneLineToolText(command);

  return {
    itemType: event.payload.itemType,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(title ? { title } : {}),
    ...(event.payload.status ? { status: event.payload.status } : {}),
    ...(detail && !detailIsCommand
      ? { detail: truncateActivityText(detail, MAX_ACTIVITY_DETAIL_CHARS) }
      : {}),
    ...(command ? { command } : {}),
    ...(cwd ? { cwd } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(terminalOutput
      ? {
          terminalOutput: truncateActivityText(terminalOutput, MAX_ACTIVITY_TERMINAL_OUTPUT_CHARS),
          terminalOutputTruncated: terminalOutput.length > MAX_ACTIVITY_TERMINAL_OUTPUT_CHARS,
        }
      : {}),
    ...subagentRuntimePayloadFields(event.payload),
  };
}

function normalizedToolOutputDeltaPayload(
  event: Extract<ProviderRuntimeEvent, { type: "content.delta" }>,
): Record<string, unknown> {
  const itemType =
    event.payload.streamKind === "file_change_output" ? "file_change" : "command_execution";
  return {
    itemType,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    status: "inProgress",
    terminalOutput: event.payload.delta,
    streamKind: event.payload.streamKind,
  };
}

function firstTrimmedArrayString(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return asTrimmedString(value);
  }
  for (const item of value) {
    const normalized = asTrimmedString(item);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function subagentThreadIdFromRuntimePayload(payload: Record<string, unknown>): string | undefined {
  const data = asRecord(payload.data);
  const ace = asRecord(data?.ace);
  const item = asRecord(data?.item);
  const subagent =
    providerAgentRecord(payload) ??
    asRecord(ace?.subagent) ??
    providerAgentRecord(data) ??
    providerAgentRecord(item);
  const metadata = mergeProviderAgentMetadata(
    subagent,
    providerAgentLooseRecord(payload),
    providerAgentLooseRecord(data),
    providerAgentLooseRecord(ace),
    providerAgentLooseRecord(item),
  );
  const childProviderThreadId =
    asTrimmedString(payload.childProviderThreadId) ??
    asTrimmedString(payload.child_provider_thread_id) ??
    asTrimmedString(ace?.childProviderThreadId) ??
    asTrimmedString(ace?.child_provider_thread_id) ??
    asTrimmedString(data?.childProviderThreadId) ??
    asTrimmedString(data?.child_provider_thread_id) ??
    asTrimmedString(item?.childProviderThreadId) ??
    asTrimmedString(item?.child_provider_thread_id) ??
    firstTrimmedArrayString(item?.receiverThreadIds);
  const providerSessionId =
    metadata.id !== undefined || subagent !== undefined
      ? (asTrimmedString(payload.sessionId) ??
        asTrimmedString(payload.sessionID) ??
        asTrimmedString(payload.session_id) ??
        asTrimmedString(data?.sessionId) ??
        asTrimmedString(data?.sessionID) ??
        asTrimmedString(data?.session_id) ??
        asTrimmedString(item?.sessionId) ??
        asTrimmedString(item?.sessionID) ??
        asTrimmedString(item?.session_id))
      : undefined;
  return childProviderThreadId ?? providerSessionId ?? metadata.id;
}

function isSubagentRuntimePayload(payload: Record<string, unknown>): boolean {
  return subagentThreadIdFromRuntimePayload(payload) !== undefined;
}

function subagentRuntimePayloadFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (payload.subagent !== undefined) {
    fields.subagent = payload.subagent;
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  const payloadAgent = providerAgentRecord(payload);
  const dataAgent = providerAgentRecord(data);
  const aceAgent = providerAgentRecord(asRecord(data?.ace));
  const itemAgent = providerAgentRecord(item);
  if (fields.subagent === undefined && payloadAgent !== undefined) {
    fields.subagent = payloadAgent;
  }
  if (fields.subagent === undefined && dataAgent !== undefined) {
    fields.subagent = dataAgent;
  }
  if (fields.subagent === undefined && aceAgent !== undefined) {
    fields.subagent = aceAgent;
  }
  if (fields.subagent === undefined && itemAgent !== undefined) {
    fields.subagent = itemAgent;
  }
  if (payload.childProviderThreadId !== undefined) {
    fields.childProviderThreadId = payload.childProviderThreadId;
  }
  if (payload.child_provider_thread_id !== undefined) {
    fields.child_provider_thread_id = payload.child_provider_thread_id;
  }
  for (const key of [
    "sessionId",
    "sessionID",
    "session_id",
    "parentId",
    "parent_id",
    "parentAgentId",
    "parent_agent_id",
    "parentSubagentId",
    "parent_subagent_id",
    "parentTaskId",
    "parentTaskID",
    "parent_task_id",
    "parentToolUseId",
    "parent_tool_use_id",
    "parentProviderThreadId",
    "parent_provider_thread_id",
    "parentProviderConversationId",
    "parent_provider_conversation_id",
    "parentThreadId",
    "parent_thread_id",
    "parentSessionId",
    "parentSessionID",
    "parent_session_id",
    "parentConversationId",
    "parent_conversation_id",
    "agentId",
    "agent_id",
    "subagentId",
    "subagent_id",
    "agentRole",
    "agent_role",
    "agentName",
    "agent_name",
    "agentDisplayName",
    "agent_display_name",
    "agentNickname",
    "agent_nickname",
    "subagentName",
    "subagent_name",
    "subagentType",
    "subagent_type",
    "model",
  ]) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  if (payload.data !== undefined) {
    fields.data = payload.data;
  }
  return fields;
}

function providerChildPayloadsFromActivity(
  activity: OrchestrationThreadActivity,
): ReadonlyArray<{ id: string; type?: string | undefined; name?: string | undefined }> {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  const ace = asRecord(data?.ace);
  const item = asRecord(data?.item);
  const candidates = [
    ...providerAgentRecords(payload),
    ...providerAgentRecords(data),
    ...providerAgentRecords(ace),
    ...providerAgentRecords(item),
  ];
  const looseCandidates = [
    providerAgentLooseRecord(payload),
    providerAgentLooseRecord(data),
    providerAgentLooseRecord(ace),
    providerAgentLooseRecord(item),
  ].filter((candidate): candidate is Record<string, unknown> => candidate !== undefined);
  const fallbackSubagent =
    providerAgentRecord(payload) ??
    asRecord(ace?.subagent) ??
    providerAgentRecord(data) ??
    providerAgentRecord(item);
  if (fallbackSubagent !== undefined && candidates.length === 0) {
    candidates.push(fallbackSubagent);
  }
  if (candidates.length === 0) {
    candidates.push(...looseCandidates);
  }

  const routes: Array<{ id: string; type?: string | undefined; name?: string | undefined }> = [];
  const seen = new Set<string>();
  for (const [candidateIndex, candidate] of candidates.entries()) {
    const metadata = mergeProviderAgentMetadata(
      candidate,
      providerAgentLooseRecord(candidate),
      providerAgentLooseRecord(payload),
      providerAgentLooseRecord(data),
      providerAgentLooseRecord(ace),
      providerAgentLooseRecord(item),
    );
    const childProviderThreadId =
      asTrimmedString(candidate.childProviderThreadId) ??
      asTrimmedString(candidate.child_provider_thread_id) ??
      asTrimmedString(payload?.childProviderThreadId) ??
      asTrimmedString(payload?.child_provider_thread_id) ??
      asTrimmedString(data?.childProviderThreadId) ??
      asTrimmedString(data?.child_provider_thread_id) ??
      asTrimmedString(ace?.childProviderThreadId) ??
      asTrimmedString(ace?.child_provider_thread_id) ??
      asTrimmedString(item?.childProviderThreadId) ??
      asTrimmedString(item?.child_provider_thread_id) ??
      firstTrimmedArrayString(candidate.receiverThreadIds) ??
      firstTrimmedArrayString(candidate.receiver_thread_ids) ??
      (candidateIndex === 0 ? firstTrimmedArrayString(item?.receiverThreadIds) : undefined);
    const subagentId = childProviderThreadId ?? metadata.id;
    if (!subagentId || seen.has(subagentId)) {
      continue;
    }
    const type = metadata.type;
    seen.add(subagentId);
    routes.push({
      id: subagentId,
      type: type ?? "subagent",
      ...(metadata.name ? { name: metadata.name } : {}),
    });
  }
  return routes;
}

function findProviderChildRuntimeRoute(
  readModel: OrchestrationReadModel,
  runtimeThreadId: ThreadId,
): {
  thread: OrchestrationThread;
  subagent: { id: string; type?: string | undefined; name?: string | undefined };
} | null {
  for (const thread of readModel.threads) {
    for (const activity of thread.activities) {
      for (const subagent of providerChildPayloadsFromActivity(activity)) {
        if (subagent.id === runtimeThreadId) {
          return { thread, subagent };
        }
      }
    }
  }
  return null;
}

function withProviderChildRuntimePayload(
  event: ProviderRuntimeEvent,
  subagent: { id: string; type?: string | undefined; name?: string | undefined },
): ProviderRuntimeEvent {
  const payload = asRecord(event.payload);
  if (!payload) {
    return event;
  }
  const data = asRecord(payload.data);
  return {
    ...event,
    payload: {
      ...payload,
      data: {
        ...data,
        childProviderThreadId: subagent.id,
        subagent: {
          id: subagent.id,
          type: subagent.type ?? "subagent",
          ...(subagent.name ? { name: subagent.name } : {}),
        },
      },
    },
  } as ProviderRuntimeEvent;
}

function subagentTaskIdFromEvent(
  event: Pick<ProviderRuntimeEvent, "eventId" | "itemId" | "turnId">,
) {
  return `subagent:${event.itemId ?? event.turnId ?? event.eventId}`;
}

function reasoningTaskIdFromEvent(
  event: Pick<ProviderRuntimeEvent, "eventId" | "itemId" | "turnId">,
) {
  return `reasoning:${event.itemId ?? event.turnId ?? event.eventId}`;
}

function normalizeRuntimeTurnState(
  value: string | undefined,
): "completed" | "failed" | "interrupted" | "cancelled" {
  switch (value) {
    case "failed":
    case "interrupted":
    case "cancelled":
    case "completed":
      return value;
    default:
      return "completed";
  }
}

function orchestrationSessionStatusFromRuntimeState(
  state: "starting" | "running" | "waiting" | "ready" | "interrupted" | "stopped" | "error",
): "starting" | "running" | "ready" | "interrupted" | "stopped" | "error" {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
    case "waiting":
      return "running";
    case "ready":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | "permission" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "dynamic_tool_call":
    case "auth_tokens_refresh":
    case "unknown":
      return "permission";
    default:
      return undefined;
  }
}

function goalLifecycleActivitiesFromLifecycleEvent(
  event: Extract<
    ProviderRuntimeEvent,
    { type: "item.started" | "item.updated" | "item.completed" }
  >,
): ReadonlyArray<OrchestrationThreadActivity> | null {
  const goal = parseProviderGoalLifecycle(event.payload);
  if (!goal) {
    return hasProviderGoalLifecycleSignal(event.payload) ? [] : null;
  }
  const maybeSequence = providerMessageSequence(event);
  if (goal.action === "cleared") {
    const payload = goal.threadId
      ? { threadId: goal.threadId, providerThreadId: goal.threadId }
      : {};
    return [
      {
        id: event.eventId,
        createdAt: event.createdAt,
        tone: "info",
        kind: "goal.cleared",
        summary: "Goal cleared",
        payload,
        turnId: toTurnId(event.turnId) ?? null,
        ...maybeSequence,
      },
    ];
  }
  return [
    {
      id: event.eventId,
      createdAt: event.createdAt,
      tone: "info",
      kind: "goal.updated",
      summary: goal.status === "paused" ? "Goal paused" : "Goal updated",
      payload: {
        threadId: goal.threadId ?? event.threadId,
        providerThreadId: goal.threadId ?? event.threadId,
        objective: goal.objective,
        status: goal.status,
        detail: goal.objective,
        ...(goal.tokenBudget !== undefined ? { tokenBudget: goal.tokenBudget } : {}),
        ...(goal.tokensUsed !== undefined ? { tokensUsed: goal.tokensUsed } : {}),
        ...(goal.timeUsedSeconds !== undefined ? { timeUsedSeconds: goal.timeUsedSeconds } : {}),
      },
      turnId: toTurnId(event.turnId) ?? null,
      ...maybeSequence,
    },
  ];
}

function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  streamingSettings: ActivityStreamingSettings,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = providerMessageSequence(event);
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      if (isImageGenerationToolRequestPayload(event.payload)) {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : requestKind === "permission"
                    ? "Permission approval requested"
                    : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: truncateDetail(event.payload.detail) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            provider: event.provider,
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          summary: "Runtime warning",
          payload: {
            provider: event.provider,
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "auth.status": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.error ? "error" : "info",
          kind: "auth.status",
          summary: "Provider auth status",
          payload: {
            provider: event.provider,
            ...(event.payload.isAuthenticating !== undefined
              ? { isAuthenticating: event.payload.isAuthenticating }
              : {}),
            ...(event.payload.status ? { status: event.payload.status } : {}),
            ...(event.payload.label ? { label: event.payload.label } : {}),
            ...(event.payload.account !== undefined ? { account: event.payload.account } : {}),
            ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
            ...(event.payload.error ? { error: truncateDetail(event.payload.error) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "account.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "account.updated",
          summary: "Provider account updated",
          payload: {
            provider: event.provider,
            account: event.payload.account,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "account.rate-limits.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "account.rate-limits.updated",
          summary: "Provider rate limits updated",
          payload: {
            provider: event.provider,
            rateLimits: event.payload.rateLimits,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "model.rerouted": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "model.rerouted",
          summary: "Model rerouted",
          payload: {
            provider: event.provider,
            fromModel: event.payload.fromModel,
            toModel: event.payload.toModel,
            reason: event.payload.reason,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "config.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "config.warning",
          summary: "Provider configuration warning",
          payload: {
            provider: event.provider,
            summary: truncateDetail(event.payload.summary),
            ...(event.payload.details ? { details: truncateDetail(event.payload.details) } : {}),
            ...(event.payload.path ? { path: event.payload.path } : {}),
            ...(event.payload.range !== undefined ? { range: event.payload.range } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "deprecation.notice": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "deprecation.notice",
          summary: "Provider deprecation notice",
          payload: {
            provider: event.provider,
            summary: truncateDetail(event.payload.summary),
            ...(event.payload.details ? { details: truncateDetail(event.payload.details) } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description ? { detail: event.payload.description } : {}),
            ...(event.payload.subagent !== undefined ? { subagent: event.payload.subagent } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      const detail = hasRenderableReasoningText(event.payload.summary)
        ? event.payload.summary
        : hasRenderableReasoningText(event.payload.description)
          ? event.payload.description
          : undefined;
      if (!detail) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning update",
          payload: {
            taskId: event.payload.taskId,
            detail,
            ...(hasRenderableReasoningText(event.payload.summary)
              ? { summary: event.payload.summary }
              : {}),
            ...(event.payload.lastToolName ? { lastToolName: event.payload.lastToolName } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.subagent !== undefined ? { subagent: event.payload.subagent } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(event.payload.summary ? { detail: event.payload.summary } : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...(event.payload.subagent !== undefined ? { subagent: event.payload.subagent } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.started": {
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "hook.started",
          summary: `Hook started: ${event.payload.hookName}`,
          payload: {
            hookId: event.payload.hookId,
            hookName: event.payload.hookName,
            hookEvent: event.payload.hookEvent,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.progress": {
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      const detail =
        asNonEmptyString(event.payload.output) ??
        asNonEmptyString(event.payload.stdout) ??
        asNonEmptyString(event.payload.stderr);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "hook.progress",
          summary: "Hook output",
          payload: {
            hookId: event.payload.hookId,
            ...(detail ? { detail } : {}),
            ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
            ...(event.payload.stdout !== undefined ? { stdout: event.payload.stdout } : {}),
            ...(event.payload.stderr !== undefined ? { stderr: event.payload.stderr } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "hook.completed": {
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      const detail =
        asNonEmptyString(event.payload.output) ??
        asNonEmptyString(event.payload.stdout) ??
        asNonEmptyString(event.payload.stderr);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.outcome === "error" ? "error" : "tool",
          kind: "hook.completed",
          summary:
            event.payload.outcome === "success"
              ? "Hook completed"
              : event.payload.outcome === "cancelled"
                ? "Hook cancelled"
                : "Hook failed",
          payload: {
            hookId: event.payload.hookId,
            outcome: event.payload.outcome,
            ...(detail ? { detail } : {}),
            ...(event.payload.output !== undefined ? { output: event.payload.output } : {}),
            ...(event.payload.stdout !== undefined ? { stdout: event.payload.stdout } : {}),
            ...(event.payload.stderr !== undefined ? { stderr: event.payload.stderr } : {}),
            ...(event.payload.exitCode !== undefined ? { exitCode: event.payload.exitCode } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary: "Context compacted",
          payload: {
            state: event.payload.state,
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.goal.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "goal.updated",
          summary: event.payload.goal.status === "paused" ? "Goal paused" : "Goal updated",
          payload: {
            ...event.payload.goal,
            detail: event.payload.goal.objective,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.goal.cleared": {
      const payload = event.payload.providerThreadId
        ? { providerThreadId: event.payload.providerThreadId }
        : {};
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "goal.cleared",
          summary: "Goal cleared",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "mcp.status.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "mcp.status.updated",
          summary: "MCP status updated",
          payload: {
            provider: event.provider,
            status: event.payload.status,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "mcp.oauth.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.success ? "info" : "error",
          kind: "mcp.oauth.completed",
          summary: event.payload.success ? "MCP OAuth completed" : "MCP OAuth failed",
          payload: {
            provider: event.provider,
            success: event.payload.success,
            ...(event.payload.name ? { name: event.payload.name } : {}),
            ...(event.payload.error ? { error: event.payload.error } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "content.delta": {
      if (
        event.payload.streamKind === "assistant_text" &&
        isSubagentRuntimePayload(event.payload)
      ) {
        const detail = event.payload.delta.trim();
        if (!detail) {
          return [];
        }
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "task.progress",
            summary: "Subagent message",
            payload: {
              taskId: subagentTaskIdFromEvent(event),
              itemType: "assistant_message",
              description: detail,
              detail,
              ...subagentRuntimePayloadFields(event.payload),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }

      if (
        event.payload.streamKind === "command_output" ||
        event.payload.streamKind === "file_change_output"
      ) {
        if (!streamingSettings.enableToolStreaming || event.payload.delta.length === 0) {
          return [];
        }
        const payload = normalizedToolOutputDeltaPayload(event);
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "tool",
            kind: "tool.updated",
            summary:
              event.payload.streamKind === "command_output" ? "Command output" : "File output",
            payload,
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }

      if (!streamingSettings.enableThinkingStreaming) {
        return [];
      }
      if (
        event.payload.streamKind !== "reasoning_text" &&
        event.payload.streamKind !== "reasoning_summary_text"
      ) {
        return [];
      }

      const detail = hasRenderableReasoningText(event.payload.delta)
        ? event.payload.delta
        : undefined;
      if (!detail) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.progress",
          summary: "Reasoning",
          payload: {
            taskId: reasoningTaskIdFromEvent(event),
            description: detail,
            detail,
            streamKind: event.payload.streamKind,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated": {
      const goalLifecycleActivities = goalLifecycleActivitiesFromLifecycleEvent(event);
      if (goalLifecycleActivities) {
        return goalLifecycleActivities;
      }
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (isImageGenerationPlaceholderPayload(event.payload)) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const payload = normalizedToolActivityPayload(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.updated",
          summary: asString(payload.title) ?? event.payload.title ?? "Tool",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.completed": {
      const goalLifecycleActivities = goalLifecycleActivitiesFromLifecycleEvent(event);
      if (goalLifecycleActivities) {
        return goalLifecycleActivities;
      }
      if (isImageGenerationPlaceholderPayload(event.payload)) {
        return [];
      }
      if (
        event.payload.itemType === "assistant_message" &&
        isSubagentRuntimePayload(event.payload)
      ) {
        const detail = event.payload.detail?.trim();
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "task.progress",
            summary: event.payload.title ?? "Subagent message",
            payload: {
              taskId: subagentTaskIdFromEvent(event),
              itemType: event.payload.itemType,
              ...(detail ? { description: detail, detail } : {}),
              ...subagentRuntimePayloadFields(event.payload),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (event.payload.itemType === "reasoning") {
        if (!streamingSettings.enableThinkingStreaming) {
          return [];
        }
        const detail = extractReasoningDetail(event);
        return [
          {
            id: event.eventId,
            createdAt: event.createdAt,
            tone: "info",
            kind: "reasoning.completed",
            summary: event.payload.title ?? "Reasoning",
            payload: {
              taskId: reasoningTaskIdFromEvent(event),
              itemType: event.payload.itemType,
              ...(detail ? { detail } : {}),
              ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
            },
            turnId: toTurnId(event.turnId) ?? null,
            ...maybeSequence,
          },
        ];
      }
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const payload = normalizedToolActivityPayload(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.completed",
          summary: asString(payload.title) ?? event.payload.title ?? "Tool",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.started": {
      const goalLifecycleActivities = goalLifecycleActivitiesFromLifecycleEvent(event);
      if (goalLifecycleActivities) {
        return goalLifecycleActivities;
      }
      if (!streamingSettings.enableToolStreaming) {
        return [];
      }
      if (isImageGenerationPlaceholderPayload(event.payload)) {
        return [];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) {
        return [];
      }
      const payload = normalizedToolActivityPayload(event);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "tool",
          kind: "tool.started",
          summary: asString(payload.title) ?? event.payload.title ?? "Tool",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    default:
      break;
  }

  return [];
}

function providerMessageSequence(event: ProviderRuntimeEvent): { sequence?: number | undefined } {
  const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
  return eventWithSequence.sessionSequence !== undefined
    ? { sequence: eventWithSequence.sessionSequence }
    : {};
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function isRenderableAssistantBoundaryActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated") {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  return !isPlanBoundaryToolActivity(activity);
}

const make = Effect.fn("make")(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const serverSettingsService = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const providerCapabilitiesByProvider = new Map<
    string,
    ReturnType<typeof resolveProviderIntegrationCapabilities>
  >();

  const resolveSessionCapabilities = (provider: ProviderRuntimeEvent["provider"]) => {
    const cached = providerCapabilitiesByProvider.get(provider);
    if (cached) {
      return Effect.succeed(cached);
    }
    return providerService.getCapabilities(provider).pipe(
      Effect.map((capabilities) => resolveProviderIntegrationCapabilities(provider, capabilities)),
      Effect.tap((capabilities) =>
        Effect.sync(() => {
          providerCapabilitiesByProvider.set(provider, capabilities);
        }),
      ),
    );
  };
  const resolveSessionCapabilitiesForEvent = (event: ProviderRuntimeEvent) =>
    resolveSessionCapabilities(event.provider).pipe(
      Effect.map((capabilities) => {
        const overrides = providerCapabilitiesFromSessionConfigured(event);
        return overrides
          ? resolveProviderIntegrationCapabilities(event.provider, {
              ...capabilities,
              ...overrides,
            })
          : capabilities;
      }),
    );

  const turnMessageIdsByTurnKey = yield* Cache.make<string, Set<MessageId>>({
    capacity: TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY,
    timeToLive: TURN_MESSAGE_IDS_BY_TURN_TTL,
    lookup: () => Effect.succeed(new Set<MessageId>()),
  });

  const bufferedAssistantTextByMessageId = yield* Cache.make<MessageId, string>({
    capacity: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL,
    lookup: () => Effect.succeed(""),
  });
  const activeAssistantMessageIdByStreamKey = new Map<string, MessageId>();
  const assistantOutputSeenByStreamKey = new Set<string>();
  const activeImageGenerationMessageIdByTurnKey = new Map<string, MessageId>();
  const pendingStreamingAssistantDeltasByStreamKey = new Map<
    string,
    {
      readonly event: ProviderRuntimeEvent;
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly turnId?: TurnId;
      readonly createdAt: string;
      readonly delta: string;
    }
  >();
  const bufferedThinkingActivityByKey = new Map<string, BufferedThinkingActivity>();
  const liveTurnDiffByTurnKey = new Map<string, LiveTurnDiffAggregate>();
  const lastActivityFingerprintByThread = new Map<ThreadId, string>();
  const sessionProcessPidByThread = new Map<ThreadId, number>();
  let runtimeEventsSinceMemoryPressureCheck = 0;

  const bufferedProposedPlanById = yield* Cache.make<string, { text: string; createdAt: string }>({
    capacity: BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY,
    timeToLive: BUFFERED_PROPOSED_PLAN_BY_ID_TTL,
    lookup: () => Effect.succeed({ text: "", createdAt: "" }),
  });

  const publishRuntimeIngestionProfileStats = () => {
    updateProviderRuntimeIngestionCacheStats({
      activeAssistantStreams: activeAssistantMessageIdByStreamKey.size,
      assistantOutputSeenStreams: assistantOutputSeenByStreamKey.size,
      pendingAssistantDeltaStreams: pendingStreamingAssistantDeltasByStreamKey.size,
      bufferedThinkingActivities: bufferedThinkingActivityByKey.size,
      lastActivityFingerprints: lastActivityFingerprintByThread.size,
      trackedSessionPids: sessionProcessPidByThread.size,
      queueCapacity: PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY,
    });
  };
  publishRuntimeIngestionProfileStats();

  const isGitRepoForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return false;
    }
    const workspaceCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!workspaceCwd) {
      return false;
    }
    return isGitRepository(workspaceCwd);
  });

  const mergeLiveTurnDiffAggregate = (
    current: LiveTurnDiffAggregate | undefined,
    next: {
      readonly source: LiveTurnDiffSource;
      readonly files: ReadonlyArray<LiveTurnDiffFile>;
      readonly diff?: string;
    },
  ): LiveTurnDiffAggregate => {
    const aggregate: LiveTurnDiffAggregate =
      current && current.source === next.source
        ? {
            source: current.source,
            files: new Map(current.files),
            ...(current.diff ? { diff: current.diff } : {}),
          }
        : {
            source: next.source,
            files: new Map<string, LiveTurnDiffFile>(),
          };

    for (const file of next.files) {
      const existing = aggregate.files.get(file.path);
      aggregate.files.set(file.path, {
        path: file.path,
        kind: "modified",
        additions: Math.max(existing?.additions ?? 0, file.additions),
        deletions: Math.max(existing?.deletions ?? 0, file.deletions),
      });
    }

    if (next.diff && next.diff.trim().length > 0) {
      aggregate.diff = next.diff;
    }

    return aggregate;
  };

  const dispatchMissingTurnDiffSummary = Effect.fnUntraced(function* (input: {
    readonly thread: {
      readonly id: ThreadId;
      readonly checkpoints: ReadonlyArray<{
        readonly turnId: TurnId;
        readonly checkpointTurnCount: number;
        readonly status: "ready" | "missing" | "error";
        readonly assistantMessageId: MessageId | null;
      }>;
    };
    readonly event: ProviderRuntimeEvent;
    readonly turnId: TurnId;
    readonly source: LiveTurnDiffSource;
    readonly files: ReadonlyArray<LiveTurnDiffFile>;
    readonly diff: string | undefined;
    readonly now: string;
  }) {
    if (!(yield* isGitRepoForThread(input.thread.id))) {
      return;
    }

    const existingCheckpoint = input.thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === input.turnId,
    );
    if (existingCheckpoint?.status !== undefined && existingCheckpoint.status !== "missing") {
      return;
    }

    const assistantMessageId =
      existingCheckpoint?.assistantMessageId ??
      MessageId.makeUnsafe(
        `assistant:${input.event.itemId ?? input.event.turnId ?? input.event.eventId}`,
      );
    const checkpointTurnCount =
      existingCheckpoint?.checkpointTurnCount ??
      input.thread.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      ) + 1;

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: providerCommandId(input.event, "thread-turn-diff-complete"),
      threadId: input.thread.id,
      turnId: input.turnId,
      completedAt: input.now,
      checkpointRef: CheckpointRef.makeUnsafe(`provider-diff:${input.event.eventId}`),
      status: "missing",
      source: input.source,
      files: [...input.files],
      ...(input.diff && input.diff.trim().length > 0 ? { diff: input.diff } : {}),
      assistantMessageId,
      checkpointTurnCount,
      createdAt: input.now,
    });
  });

  const rememberAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Cache.set(
          turnMessageIdsByTurnKey,
          providerTurnKey(threadId, turnId),
          Option.match(existingIds, {
            onNone: () => new Set([messageId]),
            onSome: (ids) => {
              const nextIds = new Set(ids);
              nextIds.add(messageId);
              return nextIds;
            },
          }),
        ),
      ),
    );

  const forgetAssistantMessageId = (threadId: ThreadId, turnId: TurnId, messageId: MessageId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.flatMap((existingIds) =>
        Option.match(existingIds, {
          onNone: () => Effect.void,
          onSome: (ids) => {
            const nextIds = new Set(ids);
            nextIds.delete(messageId);
            if (nextIds.size === 0) {
              return Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));
            }
            return Cache.set(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId), nextIds);
          },
        }),
      ),
    );

  const getAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.getOption(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId)).pipe(
      Effect.map((existingIds) =>
        Option.getOrElse(existingIds, (): Set<MessageId> => new Set<MessageId>()),
      ),
    );

  const clearAssistantMessageIdsForTurn = (threadId: ThreadId, turnId: TurnId) =>
    Cache.invalidate(turnMessageIdsByTurnKey, providerTurnKey(threadId, turnId));

  const appendBufferedAssistantText = (messageId: MessageId, delta: string) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap(
        Effect.fn("appendBufferedAssistantText")(function* (existingText) {
          const nextText = Option.match(existingText, {
            onNone: () => delta,
            onSome: (text) => `${text}${delta}`,
          });
          if (nextText.length <= MAX_BUFFERED_ASSISTANT_CHARS) {
            yield* Cache.set(bufferedAssistantTextByMessageId, messageId, nextText);
            return "";
          }

          // Safety valve: flush full buffered text as an assistant delta to cap memory.
          yield* Cache.invalidate(bufferedAssistantTextByMessageId, messageId);
          return nextText;
        }),
      ),
    );

  const takeBufferedAssistantText = (messageId: MessageId) =>
    Cache.getOption(bufferedAssistantTextByMessageId, messageId).pipe(
      Effect.flatMap((existingText) =>
        Cache.invalidate(bufferedAssistantTextByMessageId, messageId).pipe(
          Effect.as(Option.getOrElse(existingText, () => "")),
        ),
      ),
    );

  const clearBufferedAssistantText = (messageId: MessageId) =>
    Cache.invalidate(bufferedAssistantTextByMessageId, messageId);

  const appendBufferedProposedPlan = (planId: string, delta: string, createdAt: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) => {
        const existing = Option.getOrUndefined(existingEntry);
        return Cache.set(bufferedProposedPlanById, planId, {
          text: `${existing?.text ?? ""}${delta}`,
          createdAt:
            existing?.createdAt && existing.createdAt.length > 0 ? existing.createdAt : createdAt,
        });
      }),
    );

  const takeBufferedProposedPlan = (planId: string) =>
    Cache.getOption(bufferedProposedPlanById, planId).pipe(
      Effect.flatMap((existingEntry) =>
        Cache.invalidate(bufferedProposedPlanById, planId).pipe(
          Effect.as(Option.getOrUndefined(existingEntry)),
        ),
      ),
    );

  const clearBufferedProposedPlan = (planId: string) =>
    Cache.invalidate(bufferedProposedPlanById, planId);

  const clearAssistantMessageState = (messageId: MessageId) =>
    clearBufferedAssistantText(messageId);

  const clearTransientRuntimeBuffers = Effect.fn("clearTransientRuntimeBuffers")(function* () {
    yield* flushAllBufferedThinkingActivities().pipe(Effect.ignore);
    yield* flushAllPendingStreamingAssistantDeltas().pipe(Effect.ignore);

    const turnMessageIdsByTurnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const bufferedAssistantTextKeys = Array.from(
      yield* Cache.keys(bufferedAssistantTextByMessageId),
    );
    const bufferedProposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));

    yield* Effect.forEach(
      turnMessageIdsByTurnKeys,
      (key) => Cache.invalidate(turnMessageIdsByTurnKey, key),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      bufferedAssistantTextKeys,
      (messageId) => Cache.invalidate(bufferedAssistantTextByMessageId, messageId),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      bufferedProposedPlanKeys,
      (planId) => Cache.invalidate(bufferedProposedPlanById, planId),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);

    const pendingStreamingAssistantDeltas = pendingStreamingAssistantDeltasByStreamKey.size;
    const bufferedThinkingActivities = bufferedThinkingActivityByKey.size;
    const assistantStreams = activeAssistantMessageIdByStreamKey.size;
    const assistantOutputSeen = assistantOutputSeenByStreamKey.size;
    const activeImageGenerationMessages = activeImageGenerationMessageIdByTurnKey.size;
    const activityFingerprints = lastActivityFingerprintByThread.size;

    activeAssistantMessageIdByStreamKey.clear();
    assistantOutputSeenByStreamKey.clear();
    activeImageGenerationMessageIdByTurnKey.clear();
    pendingStreamingAssistantDeltasByStreamKey.clear();
    bufferedThinkingActivityByKey.clear();
    liveTurnDiffByTurnKey.clear();
    lastActivityFingerprintByThread.clear();
    publishRuntimeIngestionProfileStats();

    return {
      turnMessageIdsByTurnKeys: turnMessageIdsByTurnKeys.length,
      bufferedAssistantTextKeys: bufferedAssistantTextKeys.length,
      bufferedProposedPlanKeys: bufferedProposedPlanKeys.length,
      pendingStreamingAssistantDeltas,
      bufferedThinkingActivities,
      assistantStreams,
      assistantOutputSeen,
      activeImageGenerationMessages,
      activityFingerprints,
    };
  });

  const maybeTrimTransientRuntimeBuffers = Effect.fn("maybeTrimTransientRuntimeBuffers")(
    function* () {
      runtimeEventsSinceMemoryPressureCheck += 1;
      if (
        runtimeEventsSinceMemoryPressureCheck <
        PROVIDER_RUNTIME_CACHE_PRESSURE_CHECK_INTERVAL_EVENTS
      ) {
        return;
      }
      runtimeEventsSinceMemoryPressureCheck = 0;

      const rssBytes = process.memoryUsage().rss;
      if (rssBytes < PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES) {
        return;
      }

      const cleared = yield* clearTransientRuntimeBuffers();
      yield* Effect.logWarning("provider runtime ingestion trimmed transient buffers", {
        rssBytes,
        thresholdBytes: PROVIDER_RUNTIME_CACHE_TRIM_RSS_BYTES,
        ...cleared,
      });
    },
  );

  const dispatchThreadActivity = Effect.fn("dispatchThreadActivity")(function* (input: {
    threadId: ThreadId;
    activity: OrchestrationThreadActivity;
    commandId: CommandId;
    createdAt: string;
  }) {
    const fingerprint = activityFingerprint(input.activity);
    if (lastActivityFingerprintByThread.get(input.threadId) === fingerprint) {
      return;
    }
    lastActivityFingerprintByThread.set(input.threadId, fingerprint);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: input.commandId,
      threadId: input.threadId,
      activity: input.activity,
      createdAt: input.createdAt,
    });
  });

  const flushBufferedThinkingActivityByKey = Effect.fn("flushBufferedThinkingActivityByKey")(
    function* (key: string, options?: { readonly discard?: boolean }) {
      const buffered = bufferedThinkingActivityByKey.get(key);
      if (!buffered) {
        return;
      }

      if (buffered.dirty) {
        yield* dispatchThreadActivity({
          threadId: buffered.threadId,
          activity: buffered.activity,
          commandId: CommandId.makeUnsafe(
            `provider:${buffered.activity.id}:thread-activity-buffer-flush:${crypto.randomUUID()}`,
          ),
          createdAt: buffered.activity.createdAt,
        });
        buffered.dirty = false;
        buffered.pendingCharsSinceFlush = 0;
      }

      if (options?.discard) {
        bufferedThinkingActivityByKey.delete(key);
      }
    },
  );

  const flushBufferedThinkingActivitiesForThread = Effect.fn(
    "flushBufferedThinkingActivitiesForThread",
  )(function* (input: { threadId: ThreadId; keepKeys?: ReadonlySet<string> }) {
    for (const [key, buffered] of bufferedThinkingActivityByKey.entries()) {
      if (buffered.threadId !== input.threadId) {
        continue;
      }
      if (input.keepKeys?.has(key)) {
        continue;
      }
      yield* flushBufferedThinkingActivityByKey(key, { discard: true });
    }
  });

  const flushAllBufferedThinkingActivities = Effect.fn("flushAllBufferedThinkingActivities")(
    function* () {
      for (const key of Array.from(bufferedThinkingActivityByKey.keys())) {
        yield* flushBufferedThinkingActivityByKey(key, { discard: true });
      }
    },
  );

  const bufferThinkingActivity = Effect.fn("bufferThinkingActivity")(function* (input: {
    threadId: ThreadId;
    provider: ProviderRuntimeEvent["provider"];
    activity: OrchestrationThreadActivity;
  }) {
    const taskId = thinkingTaskIdFromActivity(input.activity);
    const bufferKey = taskId
      ? thinkingActivityBufferKey(input.threadId, input.activity.turnId, taskId)
      : undefined;
    if (!taskId || !bufferKey) {
      yield* dispatchThreadActivity({
        threadId: input.threadId,
        activity: input.activity,
        commandId: CommandId.makeUnsafe(
          `provider:${input.activity.id}:thread-activity-append:${crypto.randomUUID()}`,
        ),
        createdAt: input.activity.createdAt,
      });
      return;
    }

    const existing = bufferedThinkingActivityByKey.get(bufferKey);
    if (!existing) {
      bufferedThinkingActivityByKey.set(bufferKey, {
        threadId: input.threadId,
        ...(input.activity.turnId ? { turnId: input.activity.turnId } : {}),
        taskId,
        provider: input.provider,
        activity: input.activity,
        pendingCharsSinceFlush: 0,
        dirty: false,
      });
      yield* dispatchThreadActivity({
        threadId: input.threadId,
        activity: input.activity,
        commandId: CommandId.makeUnsafe(
          `provider:${input.activity.id}:thread-activity-append:${crypto.randomUUID()}`,
        ),
        createdAt: input.activity.createdAt,
      });
      return;
    }

    const compactedActivity = appendCompactedThreadActivity([existing.activity], input.activity, {
      maxEntries: 1,
    }).at(0);
    const mergedActivity =
      compactedActivity === undefined
        ? undefined
        : Object.assign({}, compactedActivity, { id: existing.activity.id });
    if (
      !mergedActivity ||
      activityFingerprint(existing.activity) === activityFingerprint(mergedActivity)
    ) {
      return;
    }

    existing.provider = input.provider;
    existing.activity = mergedActivity;
    existing.pendingCharsSinceFlush += thinkingActivityDeltaLength(input.activity);
    existing.dirty = true;

    if (existing.pendingCharsSinceFlush < streamingThinkingActivityBatchLimit(input.provider)) {
      return;
    }

    yield* flushBufferedThinkingActivityByKey(bufferKey);
  });

  const dispatchAssistantDeltaCommand = Effect.fn("dispatchAssistantDeltaCommand")(
    function* (input: {
      event: ProviderRuntimeEvent;
      threadId: ThreadId;
      messageId: MessageId;
      delta: string;
      turnId?: TurnId;
      createdAt: string;
      commandTag: string;
    }) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.commandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.delta,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        ...providerMessageSequence(input.event),
        createdAt: input.createdAt,
      });
    },
  );

  const flushPendingStreamingAssistantDeltaByStreamKey = Effect.fn(
    "flushPendingStreamingAssistantDeltaByStreamKey",
  )(function* (
    streamKey: string,
    options?: {
      readonly preservePending?: boolean;
    },
  ) {
    const pending = pendingStreamingAssistantDeltasByStreamKey.get(streamKey);
    if (!pending) {
      return;
    }

    if (pending.delta.length === 0) {
      if (!options?.preservePending) {
        pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
      }
      return;
    }

    yield* dispatchAssistantDeltaCommand({
      event: pending.event,
      threadId: pending.threadId,
      messageId: pending.messageId,
      delta: pending.delta,
      ...(pending.turnId ? { turnId: pending.turnId } : {}),
      createdAt: pending.createdAt,
      commandTag: "assistant-delta-coalesced",
    });

    if (options?.preservePending) {
      pendingStreamingAssistantDeltasByStreamKey.set(streamKey, {
        ...pending,
        delta: "",
      });
      return;
    }

    pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
  });

  const flushPendingStreamingAssistantDeltasForTurn = Effect.fn(
    "flushPendingStreamingAssistantDeltasForTurn",
  )(function* (threadId: ThreadId, turnId: TurnId) {
    const prefix = `${threadId}:${turnId}:`;
    for (const streamKey of pendingStreamingAssistantDeltasByStreamKey.keys()) {
      if (!streamKey.startsWith(prefix)) {
        continue;
      }
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const flushPendingStreamingAssistantDeltasForThread = Effect.fn(
    "flushPendingStreamingAssistantDeltasForThread",
  )(function* (threadId: ThreadId) {
    const prefix = `${threadId}:`;
    for (const streamKey of Array.from(pendingStreamingAssistantDeltasByStreamKey.keys())) {
      if (!streamKey.startsWith(prefix)) {
        continue;
      }
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const flushAllPendingStreamingAssistantDeltas = Effect.fn(
    "flushAllPendingStreamingAssistantDeltas",
  )(function* () {
    for (const streamKey of Array.from(pendingStreamingAssistantDeltasByStreamKey.keys())) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
    }
  });

  const clearPendingStreamingAssistantDeltasForThread = (threadId: ThreadId) => {
    const prefix = `${threadId}:`;
    for (const streamKey of pendingStreamingAssistantDeltasByStreamKey.keys()) {
      if (streamKey.startsWith(prefix)) {
        pendingStreamingAssistantDeltasByStreamKey.delete(streamKey);
      }
    }
  };

  const clearAssistantStreamStateForThread = (threadId: ThreadId) => {
    const prefix = `${threadId}:`;
    for (const streamKey of activeAssistantMessageIdByStreamKey.keys()) {
      if (streamKey.startsWith(prefix)) {
        activeAssistantMessageIdByStreamKey.delete(streamKey);
      }
    }
    for (const streamKey of assistantOutputSeenByStreamKey) {
      if (streamKey.startsWith(prefix)) {
        assistantOutputSeenByStreamKey.delete(streamKey);
      }
    }
    for (const turnKey of activeImageGenerationMessageIdByTurnKey.keys()) {
      if (turnKey.startsWith(prefix)) {
        activeImageGenerationMessageIdByTurnKey.delete(turnKey);
      }
    }
  };

  const queueStreamingAssistantDelta = Effect.fn("queueStreamingAssistantDelta")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    streamKey: string;
    messageId: MessageId;
    delta: string;
    turnId?: TurnId;
    createdAt: string;
  }) {
    const pending = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (pending && pending.messageId !== input.messageId) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey);
    }

    const latest = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (!latest) {
      // Emit the first chunk immediately to preserve live streaming UX,
      // then coalesce any subsequent chunks for this stream key.
      yield* dispatchAssistantDeltaCommand({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        delta: input.delta,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        commandTag: "assistant-delta",
      });
      pendingStreamingAssistantDeltasByStreamKey.set(input.streamKey, {
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        delta: "",
      });
      return;
    }

    pendingStreamingAssistantDeltasByStreamKey.set(input.streamKey, {
      event: input.event,
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: input.createdAt,
      delta: `${latest?.delta ?? ""}${input.delta}`,
    });

    const next = pendingStreamingAssistantDeltasByStreamKey.get(input.streamKey);
    if (!next || next.delta.length < streamingAssistantDeltaBatchLimit(input.event.provider)) {
      return;
    }
    yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey, {
      preservePending: true,
    });
  });

  const activeAssistantStreamKeysForTurn = (threadId: ThreadId, turnId: TurnId) => {
    const prefix = `${threadId}:${turnId}:`;
    return [...activeAssistantMessageIdByStreamKey.keys()].filter((key) => key.startsWith(prefix));
  };

  const clearAssistantOutputSeenForTurn = (threadId: ThreadId, turnId: TurnId) => {
    const prefix = `${threadId}:${turnId}:`;
    for (const streamKey of assistantOutputSeenByStreamKey) {
      if (streamKey.startsWith(prefix)) {
        assistantOutputSeenByStreamKey.delete(streamKey);
      }
    }
    activeImageGenerationMessageIdByTurnKey.delete(imageGenerationTurnKey(threadId, turnId));
  };

  const materializeGeneratedImageAttachment = Effect.fn("materializeGeneratedImageAttachment")(
    function* (input: { threadId: ThreadId; dataUrl: string }) {
      const parsed = parseBase64DataUrl(input.dataUrl);
      if (!parsed || !parsed.mimeType.toLowerCase().startsWith("image/")) {
        return undefined;
      }

      const bytes = Buffer.from(parsed.base64, "base64");
      if (bytes.byteLength <= 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return undefined;
      }

      const attachmentId = createAttachmentId(input.threadId);
      if (!attachmentId) {
        return undefined;
      }

      const attachment: ChatAttachment = {
        type: "image",
        id: attachmentId,
        name: GENERATED_IMAGE_ATTACHMENT_NAME,
        mimeType: parsed.mimeType,
        sizeBytes: bytes.byteLength,
      };
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return undefined;
      }

      const didWrite = yield* Effect.tryPromise({
        try: async () => {
          await mkdir(path.dirname(attachmentPath), { recursive: true });
          await writeFile(attachmentPath, bytes);
          return true;
        },
        catch: () => false,
      }).pipe(Effect.orElseSucceed(() => false));

      return didWrite ? attachment : undefined;
    },
  );

  const finalizeAssistantMessage = Effect.fn("finalizeAssistantMessage")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    messageId: MessageId;
    turnId?: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
    fallbackText?: string;
    attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const bufferedText = yield* takeBufferedAssistantText(input.messageId);
    const text =
      bufferedText.length > 0
        ? bufferedText
        : (input.fallbackText?.trim().length ?? 0) > 0
          ? input.fallbackText!
          : "";

    if (text.length > 0) {
      yield* orchestrationEngine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: providerCommandId(input.event, input.finalDeltaCommandTag),
        threadId: input.threadId,
        messageId: input.messageId,
        delta: text,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
      });
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: providerCommandId(input.event, input.commandTag),
      threadId: input.threadId,
      messageId: input.messageId,
      ...(input.attachments !== undefined ? { attachments: [...input.attachments] } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...providerMessageSequence(input.event),
      createdAt: input.createdAt,
    });
    yield* clearAssistantMessageState(input.messageId);
  });

  const finalizeAssistantMessageSegment = Effect.fn("finalizeAssistantMessageSegment")(
    function* (input: {
      event: ProviderRuntimeEvent;
      threadId: ThreadId;
      turnId?: TurnId;
      streamKey: string;
      messageId: MessageId;
      createdAt: string;
      commandTag: string;
      finalDeltaCommandTag: string;
      fallbackText?: string;
      attachments?: ReadonlyArray<ChatAttachment>;
    }) {
      yield* flushPendingStreamingAssistantDeltaByStreamKey(input.streamKey);
      yield* finalizeAssistantMessage({
        event: input.event,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
        createdAt: input.createdAt,
        commandTag: input.commandTag,
        finalDeltaCommandTag: input.finalDeltaCommandTag,
        ...(input.fallbackText !== undefined ? { fallbackText: input.fallbackText } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      });
      activeAssistantMessageIdByStreamKey.delete(input.streamKey);
      if (input.turnId) {
        yield* forgetAssistantMessageId(input.threadId, input.turnId, input.messageId);
      }
    },
  );

  const finalizeAssistantMessageSegmentsForTurn = Effect.fn(
    "finalizeAssistantMessageSegmentsForTurn",
  )(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    turnId: TurnId;
    createdAt: string;
    commandTag: string;
    finalDeltaCommandTag: string;
  }) {
    const streamKeys = activeAssistantStreamKeysForTurn(input.threadId, input.turnId);
    yield* Effect.forEach(
      streamKeys,
      (streamKey) => {
        const messageId = activeAssistantMessageIdByStreamKey.get(streamKey);
        if (!messageId) {
          return Effect.void;
        }
        return finalizeAssistantMessageSegment({
          event: input.event,
          threadId: input.threadId,
          turnId: input.turnId,
          streamKey,
          messageId,
          createdAt: input.createdAt,
          commandTag: input.commandTag,
          finalDeltaCommandTag: input.finalDeltaCommandTag,
        });
      },
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const upsertProposedPlan = Effect.fn("upsertProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    planMarkdown: string | undefined;
    createdAt: string;
    updatedAt: string;
  }) {
    const planMarkdown = normalizeProposedPlanMarkdown(input.planMarkdown);
    if (!planMarkdown) {
      return;
    }

    const existingPlan = input.threadProposedPlans.find((entry) => entry.id === input.planId);
    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: providerCommandId(input.event, "proposed-plan-upsert"),
      threadId: input.threadId,
      proposedPlan: {
        id: input.planId,
        turnId: input.turnId ?? null,
        planMarkdown,
        implementedAt: existingPlan?.implementedAt ?? null,
        implementationThreadId: existingPlan?.implementationThreadId ?? null,
        createdAt: existingPlan?.createdAt ?? input.createdAt,
        updatedAt: input.updatedAt,
      },
      createdAt: input.updatedAt,
    });
  });

  const finalizeBufferedProposedPlan = Effect.fn("finalizeBufferedProposedPlan")(function* (input: {
    event: ProviderRuntimeEvent;
    threadId: ThreadId;
    threadProposedPlans: ReadonlyArray<{
      id: string;
      createdAt: string;
      implementedAt: string | null;
      implementationThreadId: ThreadId | null;
    }>;
    planId: string;
    turnId?: TurnId;
    fallbackMarkdown?: string;
    updatedAt: string;
  }) {
    const bufferedPlan = yield* takeBufferedProposedPlan(input.planId);
    const bufferedMarkdown = normalizeProposedPlanMarkdown(bufferedPlan?.text);
    const fallbackMarkdown = normalizeProposedPlanMarkdown(input.fallbackMarkdown);
    const planMarkdown = bufferedMarkdown ?? fallbackMarkdown;
    if (!planMarkdown) {
      return;
    }

    yield* upsertProposedPlan({
      event: input.event,
      threadId: input.threadId,
      threadProposedPlans: input.threadProposedPlans,
      planId: input.planId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      planMarkdown,
      createdAt:
        bufferedPlan?.createdAt && bufferedPlan.createdAt.length > 0
          ? bufferedPlan.createdAt
          : input.updatedAt,
      updatedAt: input.updatedAt,
    });
    yield* clearBufferedProposedPlan(input.planId);
  });

  const clearTurnStateForSession = Effect.fn("clearTurnStateForSession")(function* (
    threadId: ThreadId,
  ) {
    const prefix = `${threadId}:`;
    const proposedPlanPrefix = `plan:${threadId}:`;
    const turnKeys = Array.from(yield* Cache.keys(turnMessageIdsByTurnKey));
    const proposedPlanKeys = Array.from(yield* Cache.keys(bufferedProposedPlanById));
    yield* Effect.forEach(
      turnKeys,
      Effect.fn(function* (key) {
        if (!key.startsWith(prefix)) {
          return;
        }

        const messageIds = yield* Cache.getOption(turnMessageIdsByTurnKey, key);
        if (Option.isSome(messageIds)) {
          yield* Effect.forEach(messageIds.value, clearAssistantMessageState, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
        }

        yield* Cache.invalidate(turnMessageIdsByTurnKey, key);
      }),
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(
      proposedPlanKeys,
      (key) =>
        key.startsWith(proposedPlanPrefix)
          ? Cache.invalidate(bufferedProposedPlanById, key)
          : Effect.void,
      { concurrency: 1 },
    ).pipe(Effect.asVoid);
  });

  const getSourceProposedPlanReferenceForPendingTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ) {
    const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
      threadId,
    });
    if (Option.isNone(pendingTurnStart)) {
      return null;
    }

    const sourceThreadId = pendingTurnStart.value.sourceProposedPlanThreadId;
    const sourcePlanId = pendingTurnStart.value.sourceProposedPlanId;
    if (sourceThreadId === null || sourcePlanId === null) {
      return null;
    }

    return {
      sourceThreadId,
      sourcePlanId,
    } as const;
  });

  const getExpectedProviderTurnIdForThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.activeTurnId;
  });

  const getHydratedThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const snapshot = yield* projectionSnapshotQuery.getSnapshot({
      hydrateThreadId: threadId,
    });
    return snapshot.threads.find((entry) => entry.id === threadId);
  });

  const getSourceProposedPlanReferenceForAcceptedTurnStart = Effect.fnUntraced(function* (
    threadId: ThreadId,
    eventTurnId: TurnId | undefined,
  ) {
    if (eventTurnId === undefined) {
      return null;
    }

    const expectedTurnId = yield* getExpectedProviderTurnIdForThread(threadId);
    if (!sameId(expectedTurnId, eventTurnId)) {
      return null;
    }

    return yield* getSourceProposedPlanReferenceForPendingTurnStart(threadId);
  });

  const markSourceProposedPlanImplemented = Effect.fnUntraced(function* (
    sourceThreadId: ThreadId,
    sourcePlanId: OrchestrationProposedPlanId,
    implementationThreadId: ThreadId,
    implementedAt: string,
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    let sourceThread = readModel.threads.find((entry) => entry.id === sourceThreadId);
    let sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    if (sourceThread && !sourcePlan && sourceThread.proposedPlans.length === 0) {
      sourceThread = yield* getHydratedThread(sourceThreadId);
      sourcePlan = sourceThread?.proposedPlans.find((entry) => entry.id === sourcePlanId);
    }
    if (!sourceThread || !sourcePlan || sourcePlan.implementedAt !== null) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: CommandId.makeUnsafe(
        `provider:source-proposed-plan-implemented:${implementationThreadId}:${crypto.randomUUID()}`,
      ),
      threadId: sourceThread.id,
      proposedPlan: {
        ...sourcePlan,
        implementedAt,
        implementationThreadId,
        updatedAt: implementedAt,
      },
      createdAt: implementedAt,
    });
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    rawEvent: ProviderRuntimeEvent,
  ) {
    return yield* Effect.gen(function* () {
      yield* maybeTrimTransientRuntimeBuffers();
      const readModel = yield* orchestrationEngine.getReadModel();
      const directThread = readModel.threads.find((entry) => entry.id === rawEvent.threadId);
      const providerChildRuntimeRoute =
        directThread === undefined
          ? findProviderChildRuntimeRoute(readModel, rawEvent.threadId)
          : null;
      const thread = directThread ?? providerChildRuntimeRoute?.thread;
      if (!thread) return;
      const event =
        providerChildRuntimeRoute !== null
          ? withProviderChildRuntimePayload(rawEvent, providerChildRuntimeRoute.subagent)
          : rawEvent;
      const isProviderChildRuntimeEvent = providerChildRuntimeRoute !== null;
      const isSideRuntimeEvent =
        isProviderChildRuntimeEvent &&
        isProviderSideConversationType(providerChildRuntimeRoute.subagent.type);

      const now = event.createdAt;
      const eventTurnId = toTurnId(event.turnId);
      const activeTurnId = thread.session?.activeTurnId ?? null;
      const eventProcessPid = runtimeProcessPidFromSessionEvent(event);
      const trackedSessionProcessPid = sessionProcessPidByThread.get(thread.id);
      const shouldApplySessionExitedLifecycle =
        event.type !== "session.exited" || eventProcessPid === undefined
          ? true
          : (trackedSessionProcessPid === undefined ||
              trackedSessionProcessPid === eventProcessPid) &&
            (event.payload.exitKind === "graceful" || !isRuntimeProcessAlive(eventProcessPid));

      const conflictsWithActiveTurn =
        activeTurnId !== null && eventTurnId !== undefined && !sameId(activeTurnId, eventTurnId);
      const missingTurnForActiveTurn = activeTurnId !== null && eventTurnId === undefined;

      const shouldApplyThreadLifecycle = (() => {
        if (!STRICT_PROVIDER_LIFECYCLE_GUARD) {
          return true;
        }
        switch (event.type) {
          case "session.exited":
            return shouldApplySessionExitedLifecycle;
          case "session.started":
          case "thread.started":
            return true;
          case "turn.started":
            return !conflictsWithActiveTurn;
          case "turn.completed":
          case "turn.aborted":
            if (conflictsWithActiveTurn) {
              return false;
            }
            // Some providers emit turn completion scoped to the thread but omit
            // turnId. Do not let those unscoped terminal events close a known
            // active turn: recoverable JSON-RPC/tool errors can emit unscoped
            // lifecycle noise while the agent continues working.
            if (missingTurnForActiveTurn) {
              return false;
            }
            // Only the active turn may close the lifecycle state.
            if (activeTurnId !== null && eventTurnId !== undefined) {
              return sameId(activeTurnId, eventTurnId);
            }
            // If no active turn is tracked, accept completion scoped to this thread.
            return true;
          default:
            return true;
        }
      })();
      const acceptedTurnStartedSourcePlan =
        event.type === "turn.started" && shouldApplyThreadLifecycle
          ? yield* getSourceProposedPlanReferenceForAcceptedTurnStart(thread.id, eventTurnId)
          : null;
      const serverSettings = yield* serverSettingsService.getSettings;
      const activityVisibilitySettings: ActivityStreamingSettings = {
        enableToolStreaming: serverSettings.enableToolStreaming,
        enableThinkingStreaming: serverSettings.enableThinkingStreaming,
      };
      const activities = runtimeEventToActivities(event, ALL_ACTIVITY_STREAMING_SETTINGS);
      const visibleActivities =
        activityVisibilitySettings.enableToolStreaming &&
        activityVisibilitySettings.enableThinkingStreaming
          ? activities
          : runtimeEventToActivities(event, activityVisibilitySettings);
      const bufferedThinkingKeysForEvent = new Set(
        activities
          .map((activity) => thinkingActivityBufferKeyFromActivity(thread.id, activity))
          .filter((key): key is string => key !== undefined),
      );
      yield* flushBufferedThinkingActivitiesForThread({
        threadId: thread.id,
        ...(bufferedThinkingKeysForEvent.size > 0
          ? { keepKeys: bufferedThinkingKeysForEvent }
          : {}),
      });

      const shouldBreakAssistantMessageSegments = (() => {
        if (
          !eventTurnId ||
          !visibleActivities.some(isRenderableAssistantBoundaryActivity) ||
          (STRICT_PROVIDER_LIFECYCLE_GUARD &&
            activeTurnId !== null &&
            !sameId(activeTurnId, eventTurnId))
        ) {
          return false;
        }
        return true;
      })();

      if (eventTurnId && shouldBreakAssistantMessageSegments) {
        yield* flushPendingStreamingAssistantDeltasForTurn(thread.id, eventTurnId);
        yield* finalizeAssistantMessageSegmentsForTurn({
          event,
          threadId: thread.id,
          turnId: eventTurnId,
          createdAt: now,
          commandTag: "assistant-complete-boundary",
          finalDeltaCommandTag: "assistant-delta-boundary",
        });
      }

      if (
        event.type === "session.started" ||
        event.type === "session.state.changed" ||
        event.type === "session.exited" ||
        event.type === "thread.started" ||
        event.type === "turn.started" ||
        event.type === "turn.completed" ||
        event.type === "turn.aborted"
      ) {
        const nextActiveTurnId =
          event.type === "turn.started"
            ? (eventTurnId ?? null)
            : event.type === "turn.completed" ||
                event.type === "turn.aborted" ||
                event.type === "session.exited"
              ? null
              : activeTurnId;
        const status = (() => {
          switch (event.type) {
            case "session.state.changed":
              return orchestrationSessionStatusFromRuntimeState(event.payload.state);
            case "turn.started":
              return "running";
            case "session.exited":
              return "stopped";
            case "turn.completed":
              return normalizeRuntimeTurnState(event.payload.state) === "failed"
                ? "error"
                : "ready";
            case "turn.aborted":
              return "ready";
            case "session.started":
            case "thread.started":
              // Provider thread/session start notifications can arrive during an
              // active turn; preserve turn-running state in that case.
              return activeTurnId !== null ? "running" : "ready";
          }
        })();
        const lastError =
          event.type === "session.state.changed" && event.payload.state === "error"
            ? (event.payload.reason ?? thread.session?.lastError ?? "Provider session error")
            : event.type === "turn.completed" &&
                normalizeRuntimeTurnState(event.payload.state) === "failed"
              ? (event.payload.errorMessage ?? thread.session?.lastError ?? "Turn failed")
              : status === "ready"
                ? null
                : (thread.session?.lastError ?? null);

        if (shouldApplyThreadLifecycle && !isProviderChildRuntimeEvent) {
          if (
            (event.type === "session.started" || event.type === "session.state.changed") &&
            eventProcessPid !== undefined
          ) {
            sessionProcessPidByThread.set(thread.id, eventProcessPid);
          }
          if (event.type === "session.exited") {
            sessionProcessPidByThread.delete(thread.id);
          }

          if (event.type === "turn.started" && acceptedTurnStartedSourcePlan !== null) {
            yield* markSourceProposedPlanImplemented(
              acceptedTurnStartedSourcePlan.sourceThreadId,
              acceptedTurnStartedSourcePlan.sourcePlanId,
              thread.id,
              now,
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "provider runtime ingestion failed to mark source proposed plan",
                  {
                    eventId: event.eventId,
                    eventType: event.type,
                    cause: Cause.pretty(cause),
                  },
                ),
              ),
            );
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "thread-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status,
              providerName: event.provider,
              capabilities: yield* resolveSessionCapabilitiesForEvent(event),
              configOptions: thread.session?.configOptions ?? [],
              commands: thread.session?.commands ?? [],
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: nextActiveTurnId,
              lastError,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      const providerCommands = providerSlashCommandsFromSessionConfigured(event);
      const providerConfigOptions = providerConfigOptionsFromSessionConfigured(event);
      const providerCapabilityOverrides = providerCapabilitiesFromSessionConfigured(event);
      if (
        !isProviderChildRuntimeEvent &&
        (providerConfigOptions !== null ||
          providerCommands !== null ||
          providerCapabilityOverrides !== null)
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: providerCommandId(event, "thread-session-configured-set"),
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: thread.session?.status ?? "ready",
            providerName: event.provider,
            capabilities: yield* resolveSessionCapabilitiesForEvent(event),
            configOptions: providerConfigOptions ?? thread.session?.configOptions ?? [],
            commands: providerCommands ?? thread.session?.commands ?? [],
            runtimeMode: thread.session?.runtimeMode ?? "full-access",
            activeTurnId: thread.session?.activeTurnId ?? null,
            lastError: thread.session?.lastError ?? null,
            updatedAt: now,
          },
          createdAt: now,
        });
      }

      const assistantDelta =
        event.type === "content.delta" &&
        event.payload.streamKind === "assistant_text" &&
        !isSubagentRuntimePayload(event.payload) &&
        !hasProviderGoalLifecycleSignal(event.payload)
          ? event.payload.delta
          : undefined;
      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      const assistantImageGenerationStart =
        event.type === "item.started" && isImageGenerationPlaceholderPayload(event.payload)
          ? {
              messageId: imageGenerationAssistantMessageId(event),
            }
          : event.type === "request.opened" && isImageGenerationToolRequestPayload(event.payload)
            ? {
                messageId: imageGenerationRequestAssistantMessageId(event),
              }
            : undefined;

      if (assistantImageGenerationStart) {
        const turnId = toTurnId(event.turnId);
        const turnKey = imageGenerationTurnKey(thread.id, turnId);
        const streamKey = imageGenerationStreamKey(thread.id, turnId);
        const messageId =
          activeImageGenerationMessageIdByTurnKey.get(turnKey) ??
          assistantImageGenerationStart.messageId;
        if (
          !activeAssistantMessageIdByStreamKey.has(streamKey) &&
          !assistantOutputSeenByStreamKey.has(streamKey)
        ) {
          activeImageGenerationMessageIdByTurnKey.set(turnKey, messageId);
          activeAssistantMessageIdByStreamKey.set(streamKey, messageId);
          assistantOutputSeenByStreamKey.add(streamKey);
          if (turnId) {
            yield* rememberAssistantMessageId(thread.id, turnId, messageId);
          }
          yield* dispatchAssistantDeltaCommand({
            event,
            threadId: thread.id,
            messageId,
            delta: "",
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-image-generation-placeholder",
          });
        }
      }

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);
        const streamKey = assistantStreamKey(thread.id, turnId, event.itemId);
        const baseAssistantMessageId = MessageId.makeUnsafe(
          `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
        );
        const assistantMessageId =
          activeAssistantMessageIdByStreamKey.get(streamKey) ??
          (assistantOutputSeenByStreamKey.has(streamKey)
            ? MessageId.makeUnsafe(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}:seg:${event.eventId}`,
              )
            : baseAssistantMessageId);
        activeAssistantMessageIdByStreamKey.set(streamKey, assistantMessageId);
        assistantOutputSeenByStreamKey.add(streamKey);
        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = serverSettings.enableAssistantStreaming
          ? "streaming"
          : "buffered";
        if (assistantDeliveryMode === "buffered") {
          yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);
          if (spillChunk.length > 0) {
            yield* dispatchAssistantDeltaCommand({
              event,
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
              commandTag: "assistant-delta-buffer-spill",
            });
          }
        } else {
          yield* queueStreamingAssistantDelta({
            event,
            threadId: thread.id,
            streamKey,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed"
          ? (() => {
              const isImageGenerationCompletion = isImageGenerationLifecyclePayload(event.payload);
              const isStructuredImageGenerationCompletion =
                isStructuredImageGenerationToolLifecyclePayload(event.payload);
              const imageDataUrl =
                isImageGenerationCompletion || isStructuredImageGenerationCompletion
                  ? extractGeneratedImageDataUrl(event.payload)
                  : undefined;
              if (
                event.payload.itemType === "assistant_message" &&
                !isImageGenerationCompletion &&
                !isStructuredImageGenerationCompletion &&
                (isSubagentRuntimePayload(event.payload) ||
                  hasProviderGoalLifecycleSignal(event.payload))
              ) {
                return undefined;
              }
              if (
                event.payload.itemType !== "assistant_message" &&
                !isImageGenerationCompletion &&
                !(isStructuredImageGenerationCompletion && imageDataUrl !== undefined)
              ) {
                return undefined;
              }
              const isImageOutputCompletion =
                isImageGenerationCompletion || isStructuredImageGenerationCompletion;
              return {
                isImageOutputCompletion,
                messageId: isImageOutputCompletion
                  ? imageGenerationAssistantMessageId(event)
                  : MessageId.makeUnsafe(
                      `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
                    ),
                fallbackText: isImageOutputCompletion ? undefined : event.payload.detail,
                imageDataUrl,
              };
            })()
          : undefined;
      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);
        const imageGenerationKey = imageGenerationTurnKey(thread.id, turnId);
        const streamKey = assistantCompletion.isImageOutputCompletion
          ? imageGenerationStreamKey(thread.id, turnId)
          : assistantStreamKey(thread.id, turnId, event.itemId);
        const generatedImageAttachment = assistantCompletion.imageDataUrl
          ? yield* materializeGeneratedImageAttachment({
              threadId: thread.id,
              dataUrl: assistantCompletion.imageDataUrl,
            })
          : undefined;
        const assistantAttachments = generatedImageAttachment ? [generatedImageAttachment] : [];
        yield* flushPendingStreamingAssistantDeltaByStreamKey(streamKey);
        const activeAssistantMessageId =
          activeAssistantMessageIdByStreamKey.get(streamKey) ??
          (assistantCompletion.isImageOutputCompletion
            ? activeImageGenerationMessageIdByTurnKey.get(imageGenerationKey)
            : undefined);
        if (activeAssistantMessageId) {
          yield* finalizeAssistantMessageSegment({
            event,
            threadId: thread.id,
            ...(turnId ? { turnId } : {}),
            streamKey,
            messageId: activeAssistantMessageId,
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            ...(assistantAttachments.length > 0 ? { attachments: assistantAttachments } : {}),
          });
        } else if (!assistantOutputSeenByStreamKey.has(streamKey)) {
          const assistantMessageId = assistantCompletion.messageId;
          if (turnId) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
          yield* finalizeAssistantMessageSegment({
            event,
            threadId: thread.id,
            ...(turnId ? { turnId } : {}),
            streamKey,
            messageId: assistantMessageId,
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            ...(assistantCompletion.fallbackText !== undefined && assistantAttachments.length === 0
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
            ...(assistantAttachments.length > 0 ? { attachments: assistantAttachments } : {}),
          });
        }
        assistantOutputSeenByStreamKey.delete(streamKey);
        if (assistantCompletion.isImageOutputCompletion) {
          activeImageGenerationMessageIdByTurnKey.delete(imageGenerationKey);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          threadProposedPlans: thread.proposedPlans,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          yield* flushPendingStreamingAssistantDeltasForTurn(thread.id, turnId);
          yield* finalizeAssistantMessageSegmentsForTurn({
            event,
            threadId: thread.id,
            turnId,
            createdAt: now,
            commandTag: "assistant-complete-finalize",
            finalDeltaCommandTag: "assistant-delta-finalize-fallback",
          });
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);
          yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              finalizeAssistantMessage({
                event,
                threadId: thread.id,
                messageId: assistantMessageId,
                turnId,
                createdAt: now,
                commandTag: "assistant-complete-finalize",
                finalDeltaCommandTag: "assistant-delta-finalize-fallback",
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          clearAssistantOutputSeenForTurn(thread.id, turnId);
          if (event.type === "turn.completed") {
            yield* finalizeBufferedProposedPlan({
              event,
              threadId: thread.id,
              threadProposedPlans: thread.proposedPlans,
              planId: proposedPlanIdForTurn(thread.id, turnId),
              turnId,
              updatedAt: now,
            });
          }
          liveTurnDiffByTurnKey.delete(providerTurnKey(thread.id, turnId));
        }
      }

      if (event.type === "session.exited" && shouldApplySessionExitedLifecycle) {
        yield* flushBufferedThinkingActivitiesForThread({ threadId: thread.id });
        yield* flushPendingStreamingAssistantDeltasForThread(thread.id);
        yield* clearTurnStateForSession(thread.id);
        clearAssistantStreamStateForThread(thread.id);
        clearPendingStreamingAssistantDeltasForThread(thread.id);
        for (const turnKey of liveTurnDiffByTurnKey.keys()) {
          if (turnKey.startsWith(`${thread.id}:`)) {
            liveTurnDiffByTurnKey.delete(turnKey);
          }
        }
        lastActivityFingerprintByThread.delete(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          const isUnscopedActiveTurnError = activeTurnId !== null && eventTurnId === undefined;
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: isUnscopedActiveTurnError ? "running" : "error",
              providerName: event.provider,
              capabilities: yield* resolveSessionCapabilities(event.provider),
              configOptions: thread.session?.configOptions ?? [],
              commands: thread.session?.commands ?? [],
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              activeTurnId: eventTurnId ?? activeTurnId,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "thread.metadata.updated" && event.payload.name) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: providerCommandId(event, "thread-meta-update"),
          threadId: thread.id,
          title: event.payload.name,
        });
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);
        if (turnId) {
          const unifiedDiff = event.payload.unifiedDiff;
          const aggregate = mergeLiveTurnDiffAggregate(
            liveTurnDiffByTurnKey.get(providerTurnKey(thread.id, turnId)),
            {
              source: "provider-native",
              files: summarizeUnifiedDiffFiles(unifiedDiff),
              ...(unifiedDiff.length > 0 ? { diff: unifiedDiff } : {}),
            },
          );
          liveTurnDiffByTurnKey.set(providerTurnKey(thread.id, turnId), aggregate);
          yield* dispatchMissingTurnDiffSummary({
            thread,
            event,
            turnId,
            source: aggregate.source,
            files: [...aggregate.files.values()],
            diff: aggregate.diff,
            now,
          });
        }
      }

      if (
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.payload.itemType === "file_change"
      ) {
        const turnId = toTurnId(event.turnId);
        const liveTurnDiffMode =
          thread.session?.providerName === event.provider
            ? thread.session.capabilities?.liveTurnDiffMode
            : undefined;
        const extracted =
          liveTurnDiffMode === "workspace" || !turnId ? null : extractLiveTurnDiffFromItem(event);
        if (turnId && extracted && (extracted.files.length > 0 || extracted.diff)) {
          const existingAggregate = liveTurnDiffByTurnKey.get(providerTurnKey(thread.id, turnId));
          if (existingAggregate?.source === "provider-native") {
            // Codex-native turn diffs are authoritative for live turn state.
            // Do not let later file_change lifecycle events degrade them.
            return;
          }
          const aggregate = mergeLiveTurnDiffAggregate(existingAggregate, {
            source: "provider-reconstructed",
            files: extracted.files,
            ...(extracted.diff ? { diff: extracted.diff } : {}),
          });
          liveTurnDiffByTurnKey.set(providerTurnKey(thread.id, turnId), aggregate);
          yield* dispatchMissingTurnDiffSummary({
            thread,
            event,
            turnId,
            source: aggregate.source,
            files: [...aggregate.files.values()],
            diff: aggregate.diff,
            now,
          });
        }
      }

      yield* Effect.forEach(
        activities,
        (activity) =>
          isBufferedThinkingActivity(activity)
            ? bufferThinkingActivity({
                threadId: thread.id,
                provider: event.provider,
                activity,
              })
            : dispatchThreadActivity({
                threadId: thread.id,
                activity,
                commandId: providerCommandId(event, "thread-activity-append"),
                createdAt: activity.createdAt,
              }),
        { concurrency: 1 },
      ).pipe(Effect.asVoid);
    }).pipe(Effect.ensuring(Effect.sync(publishRuntimeIngestionProfileStats)));
  });

  const processDomainEvent = (_event: TurnStartRequestedDomainEvent) => Effect.void;

  const processInput = (input: RuntimeIngestionInput) =>
    input.source === "runtime" ? processRuntimeEvent(input.event) : processDomainEvent(input.event);

  const processInputSafely = (input: RuntimeIngestionInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider runtime ingestion failed to process event", {
          source: input.source,
          eventId: input.event.eventId,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely, {
    capacity: PROVIDER_RUNTIME_INGESTION_QUEUE_CAPACITY,
  });

  const flushBufferedThinkingActivitiesSafely = (phase: "drain" | "shutdown") =>
    flushAllBufferedThinkingActivities().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          "provider runtime ingestion failed to flush buffered thinking activities",
          {
            phase,
            cause: Cause.pretty(cause),
          },
        ),
      ),
    );

  const flushBufferedStateOnShutdownSafely = flushAllBufferedThinkingActivities().pipe(
    Effect.flatMap(() => flushAllPendingStreamingAssistantDeltas()),
    Effect.flatMap(() => clearTransientRuntimeBuffers()),
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logWarning("provider runtime ingestion failed to flush buffered updates", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const start: ProviderRuntimeIngestionShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.addFinalizer(() => flushBufferedStateOnShutdownSafely);
    yield* Effect.forkScoped(
      Stream.runForEach(providerService.streamEvents, (event) =>
        worker.enqueue({ source: "runtime", event }),
      ),
    );
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.flatMap(() => flushBufferedThinkingActivitiesSafely("drain"))),
  } satisfies ProviderRuntimeIngestionShape;
});

export const ProviderRuntimeIngestionLive = Layer.effect(
  ProviderRuntimeIngestionService,
  make(),
).pipe(Layer.provide(ProjectionTurnRepositoryLive));
