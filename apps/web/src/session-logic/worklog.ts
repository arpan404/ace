import {
  PROVIDER_DISPLAY_NAMES,
  type OrchestrationThreadActivity,
  type ProviderIntegrationCapabilities,
  type ProviderKind,
  type ProviderSlashCommand,
  type TurnId,
} from "@ace/contracts";
import {
  mergeProviderAgentMetadata,
  providerAgentLooseRecord,
  providerAgentRecord,
  providerAgentRecords,
} from "@ace/shared/providerAgentMetadata";
import {
  hasProviderGoalLifecycleSignal,
  parseProviderGoalLifecycle,
} from "@ace/shared/providerGoalLifecycle";
import {
  isProviderSideConversationAlias,
  normalizeProviderSlashCommandName,
  providerSlashCommandExtensionKind,
} from "@ace/shared/providerSlashCommands";

import type {
  ActiveGoalState,
  EnvironmentMcpStatus,
  EnvironmentProviderStatus,
  WorkLogEntry,
} from "./types";
import {
  asRecord,
  asTrimmedString,
  compareActivitiesByOrder,
  extractChangedFiles,
  extractEmbeddedIntentText,
  extractToolCommand,
  extractToolDetail,
  extractToolTitle,
  extractWorkLogItemType,
  extractWorkLogRequestKind,
  sanitizeWorkLogText,
  stripTrailingExitCode,
} from "./shared";

interface DerivedWorkLogEntry extends WorkLogEntry {
  activityKind: OrchestrationThreadActivity["kind"];
  collapseKey?: string;
}

export interface ActivityVisibilitySettings {
  readonly enableToolStreaming: boolean;
  readonly enableThinkingStreaming: boolean;
}

const THINKING_ACTIVITY_KINDS = new Set<OrchestrationThreadActivity["kind"]>([
  "turn.plan.updated",
  "task.started",
  "task.progress",
  "task.completed",
  "reasoning.completed",
]);

const TOOL_ACTIVITY_KINDS = new Set<OrchestrationThreadActivity["kind"]>([
  "tool.started",
  "tool.updated",
  "tool.completed",
  "hook.started",
  "hook.progress",
  "hook.completed",
]);
const MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS = 16_000;

function shouldHideWorkLogActivityForVisibility(
  activity: OrchestrationThreadActivity,
  visibility: ActivityVisibilitySettings,
): boolean {
  if (!visibility.enableThinkingStreaming && THINKING_ACTIVITY_KINDS.has(activity.kind)) {
    return true;
  }

  if (!visibility.enableToolStreaming && TOOL_ACTIVITY_KINDS.has(activity.kind)) {
    return true;
  }

  return false;
}

export function filterVisibleWorkLogActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  visibility: ActivityVisibilitySettings,
): ReadonlyArray<OrchestrationThreadActivity> {
  const visible = activities.filter(
    (activity) =>
      isRenderableWorkLogActivity(activity) &&
      !shouldHideWorkLogActivityForVisibility(activity, visibility),
  );
  return visible.length === activities.length ? activities : visible;
}

function ensureActivitiesOrdered(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  for (let index = 1; index < activities.length; index += 1) {
    const previous = activities[index - 1];
    const current = activities[index];
    if (!previous || !current) {
      continue;
    }
    if (compareActivitiesByOrder(previous, current) > 0) {
      return [...activities].toSorted(compareActivitiesByOrder);
    }
  }
  return activities;
}

export function findLatestRenderableWorkTurnId(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnId | undefined {
  const ordered = ensureActivitiesOrdered(activities);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const activity = ordered[index];
    if (!activity) {
      continue;
    }
    if (activity.turnId && isRenderableWorkLogActivity(activity)) {
      return activity.turnId;
    }
  }
  return undefined;
}

function isRenderableWorkLogActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind === "goal.updated" || activity.kind === "goal.cleared") {
    return false;
  }
  if (isGoalLifecycleWorkLogActivity(activity)) {
    return false;
  }
  if (activity.kind === "task.started" || activity.kind === "task.completed") {
    return false;
  }
  if (activity.kind === "context-window.updated") {
    return false;
  }
  if (
    activity.kind === "mcp.status.updated" ||
    activity.kind === "mcp.oauth.completed" ||
    activity.kind === "auth.status" ||
    activity.kind === "account.updated" ||
    activity.kind === "account.rate-limits.updated" ||
    activity.kind === "model.rerouted" ||
    activity.kind === "config.warning" ||
    activity.kind === "deprecation.notice"
  ) {
    return false;
  }
  if (activity.summary === "Checkpoint captured") {
    return false;
  }
  if (activity.kind === "workspace.summary.generated") {
    return false;
  }
  return !isPlanBoundaryToolActivity(activity);
}

function isGoalLifecycleWorkLogActivity(activity: OrchestrationThreadActivity): boolean {
  return hasProviderGoalLifecycleSignal({
    summary: activity.summary,
    payload: activity.payload,
  });
}

function normalizeMcpStatusText(value: unknown): string | null {
  const text = asTrimmedString(value);
  return text ? text.replaceAll("_", " ") : null;
}

function isErrorMcpStatus(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("fail") ||
    normalized.includes("error") ||
    normalized.includes("needs auth") ||
    normalized.includes("needs client registration")
  );
}

function isPlainStatusRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mcpStatusRecordHasIdentity(record: Record<string, unknown>): boolean {
  return Boolean(
    asTrimmedString(record.name) ??
    asTrimmedString(record.server) ??
    asTrimmedString(record.serverName) ??
    asTrimmedString(record.server_name) ??
    asTrimmedString(record.id),
  );
}

function collectMcpStatusRecords(value: unknown): ReadonlyArray<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectMcpStatusRecords);
  }

  if (!isPlainStatusRecord(value)) {
    return [];
  }

  const nestedContainers = [
    value.status,
    value.statuses,
    value.serverStatuses,
    value.server_statuses,
    value.servers,
    value.mcpServers,
    value.mcp_servers,
    value.tools,
  ];
  const nestedRecords = nestedContainers.flatMap(collectMcpStatusRecords);

  if (mcpStatusRecordHasIdentity(value)) {
    return [value, ...nestedRecords];
  }

  const containerKeys = new Set([
    "status",
    "statuses",
    "serverStatuses",
    "server_statuses",
    "servers",
    "mcpServers",
    "mcp_servers",
    "tools",
  ]);
  const keyedRecords = Object.entries(value).flatMap(([key, entry]) => {
    if (containerKeys.has(key)) {
      return collectMcpStatusRecords(entry);
    }
    if (!isPlainStatusRecord(entry)) {
      return collectMcpStatusRecords(entry);
    }
    const record = mcpStatusRecordHasIdentity(entry) ? entry : { ...entry, name: key };
    return [record, ...collectMcpStatusRecords(entry)];
  });

  return [...nestedRecords, ...keyedRecords];
}

function mcpStatusName(record: Record<string, unknown>): string | null {
  return (
    asTrimmedString(record.name) ??
    asTrimmedString(record.server) ??
    asTrimmedString(record.serverName) ??
    asTrimmedString(record.server_name) ??
    asTrimmedString(record.id)
  );
}

export function deriveEnvironmentMcpStatuses(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): EnvironmentMcpStatus[] {
  const ordered = ensureActivitiesOrdered(activities);
  const byName = new Map<string, EnvironmentMcpStatus>();

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;

    if (activity.kind === "mcp.status.updated") {
      const providerLabel = optionalProviderLabelFromPayload(payload);
      for (const statusRecord of collectMcpStatusRecords(payload?.status ?? payload)) {
        const name = mcpStatusName(statusRecord);
        if (!name) {
          continue;
        }
        const status =
          normalizeMcpStatusText(statusRecord.status) ??
          normalizeMcpStatusText(statusRecord.state) ??
          normalizeMcpStatusText(statusRecord.phase) ??
          "updated";
        const detail =
          normalizeMcpStatusText(statusRecord.error) ??
          normalizeMcpStatusText(statusRecord.message) ??
          normalizeMcpStatusText(statusRecord.reason) ??
          normalizeMcpStatusText(statusRecord.scope) ??
          normalizeMcpStatusText(statusRecord.detail);
        const key = providerLabel ? `${providerLabel}:${name}` : name;
        byName.set(key, {
          id: `${activity.id}:${key}`,
          createdAt: activity.createdAt,
          name,
          ...(providerLabel ? { providerLabel } : {}),
          status,
          tone: isErrorMcpStatus(status) ? "error" : "info",
          ...(detail ? { detail } : {}),
        });
      }
      continue;
    }

    if (activity.kind === "mcp.oauth.completed") {
      const providerLabel = optionalProviderLabelFromPayload(payload);
      const name = asTrimmedString(payload?.name) ?? "MCP server";
      const success = payload?.success === true;
      const detail = normalizeMcpStatusText(payload?.error);
      const key = providerLabel ? `${providerLabel}:${name}` : name;
      byName.set(key, {
        id: `${activity.id}:${key}`,
        createdAt: activity.createdAt,
        name,
        ...(providerLabel ? { providerLabel } : {}),
        status: success ? "authenticated" : "authentication failed",
        tone: success ? "info" : "error",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return [...byName.values()].toSorted((left, right) => {
    if (left.tone !== right.tone) {
      return left.tone === "error" ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });
}

function providerLabelFromPayload(payload: Record<string, unknown> | null): string {
  const provider = asTrimmedString(payload?.provider);
  return provider && provider in PROVIDER_DISPLAY_NAMES
    ? PROVIDER_DISPLAY_NAMES[provider as keyof typeof PROVIDER_DISPLAY_NAMES]
    : (provider ?? "Provider");
}

function optionalProviderLabelFromPayload(payload: Record<string, unknown> | null): string | null {
  return payload && asTrimmedString(payload.provider) ? providerLabelFromPayload(payload) : null;
}

function normalizeStatusDetail(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const detail = value
        .map((entry) => asTrimmedString(entry))
        .filter((entry): entry is string => entry !== undefined)
        .join("\n");
      if (detail) {
        return detail;
      }
      continue;
    }
    const detail = asTrimmedString(value);
    if (detail) {
      return detail;
    }
  }
  return undefined;
}

function firstProviderAccountLabel(account: unknown): string | undefined {
  const record = asRecord(account);
  if (!record) {
    return undefined;
  }
  return (
    asTrimmedString(record.email) ??
    asTrimmedString(record.name) ??
    asTrimmedString(record.username) ??
    asTrimmedString(record.login) ??
    asTrimmedString(record.accountId) ??
    asTrimmedString(record.account_id) ??
    undefined
  );
}

function providerAuthStatusFromPayload(payload: Record<string, unknown> | null): {
  status: string;
  tone: EnvironmentProviderStatus["tone"];
  detail?: string | undefined;
} {
  const error = normalizeStatusDetail(payload?.error);
  if (error) {
    return { status: "authentication error", tone: "error", detail: error };
  }

  const accountLabel = firstProviderAccountLabel(payload?.account);
  const label = asTrimmedString(payload?.label);
  const rawStatus = asTrimmedString(payload?.status);
  const output = normalizeStatusDetail(payload?.output);
  const normalized = [rawStatus, output].filter(Boolean).join(" ").toLowerCase();

  if (payload?.isAuthenticating === true) {
    return {
      status: "authenticating",
      tone: "info",
      ...(output ? { detail: output } : {}),
    };
  }

  if (
    rawStatus === "unauthenticated" ||
    normalized.includes("unauthenticated") ||
    normalized.includes("not authenticated") ||
    normalized.includes("not logged in") ||
    normalized.includes("login required") ||
    normalized.includes("logged out")
  ) {
    return {
      status: "not authenticated",
      tone: "warning",
      ...(output ? { detail: output } : {}),
    };
  }

  if (
    rawStatus === "authenticated" ||
    normalized.includes("authenticated") ||
    normalized.includes("logged in") ||
    accountLabel ||
    label
  ) {
    return {
      status: label ?? accountLabel ?? "authenticated",
      tone: "info",
      ...(output && output !== label && output !== accountLabel ? { detail: output } : {}),
    };
  }

  return {
    status: rawStatus ?? "updated",
    tone: "info",
    ...(output ? { detail: output } : {}),
  };
}

function firstRateLimitStatus(rateLimits: unknown): string | undefined {
  if (Array.isArray(rateLimits)) {
    for (const entry of rateLimits) {
      const status = firstRateLimitStatus(entry);
      if (status) {
        return status;
      }
    }
    return undefined;
  }
  const record = asRecord(rateLimits);
  if (!record) {
    return undefined;
  }
  const remaining =
    asFiniteInteger(record.remaining) ??
    asFiniteInteger(record.remainingRequests) ??
    asFiniteInteger(record.remaining_requests);
  const limit =
    asFiniteInteger(record.limit) ??
    asFiniteInteger(record.max) ??
    asFiniteInteger(record.total) ??
    asFiniteInteger(record.requests);
  if (remaining !== undefined && limit !== undefined) {
    return `${remaining}/${limit} remaining`;
  }
  if (remaining !== undefined) {
    return `${remaining} remaining`;
  }
  return (
    asTrimmedString(record.status) ??
    asTrimmedString(record.state) ??
    asTrimmedString(record.type) ??
    asTrimmedString(record.message) ??
    undefined
  );
}

function rateLimitTone(
  rateLimits: unknown,
  status: string | undefined,
): EnvironmentProviderStatus["tone"] {
  const normalized = status?.toLowerCase() ?? "";
  if (
    normalized.includes("exhaust") ||
    normalized.includes("limited") ||
    normalized.includes("throttle") ||
    normalized.includes("quota") ||
    normalized.startsWith("0/")
  ) {
    return "warning";
  }
  if (Array.isArray(rateLimits)) {
    return rateLimits.some((entry) => rateLimitTone(entry, undefined) === "warning")
      ? "warning"
      : "info";
  }
  const record = asRecord(rateLimits);
  if (!record) {
    return "info";
  }
  const remaining =
    asFiniteInteger(record.remaining) ??
    asFiniteInteger(record.remainingRequests) ??
    asFiniteInteger(record.remaining_requests);
  return remaining === 0 ? "warning" : "info";
}

function rateLimitDetail(rateLimits: unknown): string | undefined {
  if (Array.isArray(rateLimits)) {
    return normalizeStatusDetail(
      rateLimits
        .map((entry) => rateLimitDetail(entry) ?? firstRateLimitStatus(entry))
        .filter((entry): entry is string => entry !== undefined),
    );
  }
  const record = asRecord(rateLimits);
  if (!record) {
    return undefined;
  }
  return normalizeStatusDetail(
    record.detail,
    record.details,
    record.reason,
    record.error,
    record.resetAt,
    record.reset_at,
    record.resetsAt,
    record.resets_at,
    record.retryAfter,
    record.retry_after,
    record.window,
  );
}

export function deriveEnvironmentProviderStatuses(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): EnvironmentProviderStatus[] {
  const ordered = ensureActivitiesOrdered(activities);
  const byKey = new Map<string, EnvironmentProviderStatus>();

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const providerLabel = providerLabelFromPayload(payload);
    const baseId = `${activity.id}:${activity.kind}`;

    if (activity.kind === "auth.status") {
      const authStatus = providerAuthStatusFromPayload(payload);
      byKey.set(`${providerLabel}:auth`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} auth`,
        status: authStatus.status,
        tone: authStatus.tone,
        ...(authStatus.detail ? { detail: authStatus.detail } : {}),
      });
      continue;
    }

    if (activity.kind === "account.updated") {
      const accountLabel = firstProviderAccountLabel(payload?.account);
      byKey.set(`${providerLabel}:account`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} account`,
        status: accountLabel ?? "updated",
        tone: "info",
      });
      continue;
    }

    if (activity.kind === "account.rate-limits.updated") {
      const status = firstRateLimitStatus(payload?.rateLimits) ?? "updated";
      const detail = rateLimitDetail(payload?.rateLimits);
      byKey.set(`${providerLabel}:rate-limits`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} limits`,
        status,
        tone: rateLimitTone(payload?.rateLimits, status),
        ...(detail && detail !== status ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "model.rerouted") {
      const fromModel = asTrimmedString(payload?.fromModel) ?? "unknown";
      const toModel = asTrimmedString(payload?.toModel) ?? "unknown";
      const detail = normalizeStatusDetail(payload?.reason);
      byKey.set(`${providerLabel}:model-rerouted`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} model`,
        status: `${fromModel} -> ${toModel}`,
        tone: "warning",
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "config.warning") {
      const detail = normalizeStatusDetail(payload?.details, payload?.path);
      byKey.set(`${providerLabel}:config-warning`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} config`,
        status: asTrimmedString(payload?.summary) ?? "configuration warning",
        tone: "warning",
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "deprecation.notice") {
      const detail = normalizeStatusDetail(payload?.details);
      byKey.set(`${providerLabel}:deprecation`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} deprecation`,
        status: asTrimmedString(payload?.summary) ?? "deprecation notice",
        tone: "warning",
        ...(detail ? { detail } : {}),
      });
      continue;
    }

    if (activity.kind === "runtime.error" || activity.kind === "runtime.warning") {
      const message = normalizeStatusDetail(payload?.message);
      const detail = normalizeStatusDetail(payload?.detail);
      byKey.set(`${providerLabel}:runtime`, {
        id: baseId,
        createdAt: activity.createdAt,
        label: `${providerLabel} runtime`,
        status:
          message ?? (activity.kind === "runtime.error" ? "runtime error" : "runtime warning"),
        tone: activity.kind === "runtime.error" ? "error" : "warning",
        ...(detail && detail !== message ? { detail } : {}),
      });
    }
  }

  return [...byKey.values()].toSorted((left, right) => {
    if (left.tone !== right.tone) {
      const rank = { error: 0, warning: 1, info: 2 } as const;
      return rank[left.tone] - rank[right.tone];
    }
    return left.label.localeCompare(right.label);
  });
}

export function deriveEnvironmentSessionProviderStatus(
  session:
    | {
        readonly provider: ProviderKind;
        readonly capabilities?:
          | Partial<
              Pick<
                ProviderIntegrationCapabilities,
                | "sideConversationMode"
                | "sideConversationCommands"
                | "providerThreadTargetingMode"
                | "goalControlMode"
                | "multiAgentMode"
                | "multiAgentInvocationPrefixes"
                | "multiAgentDefinitionPaths"
                | "multiAgentManagementCommands"
                | "hookMode"
                | "extensionMode"
                | "mcpMode"
                | "remoteAgentMode"
                | "webAccessMode"
                | "hostedSessionMode"
              >
            >
          | undefined;
        readonly updatedAt: string;
      }
    | null
    | undefined,
): EnvironmentProviderStatus | null {
  return deriveEnvironmentSessionProviderStatuses(session)[0] ?? null;
}

function providerAgentCommandDisplayName(command: ProviderSlashCommand): string | null {
  const name = normalizeProviderSlashCommandName(command.name);
  if (!name || isProviderSideConversationAlias(name)) {
    return null;
  }
  const commandKind =
    command.kind === "agent" ? "agent" : providerSlashCommandExtensionKind(command, name);
  if (commandKind !== "agent") {
    return null;
  }
  const promptPrefix = command.promptPrefix?.trim();
  if (promptPrefix && !isProviderSideConversationAlias(promptPrefix)) {
    return promptPrefix;
  }
  return command.name.trim();
}

function deriveEnvironmentProviderAgentCommandStatuses(input: {
  commands: ReadonlyArray<ProviderSlashCommand>;
  createdAt: string;
  provider: ProviderKind;
}): EnvironmentProviderStatus[] {
  const seen = new Set<string>();
  const agentNames: Array<{
    name: string;
    description?: string;
  }> = [];
  for (const command of input.commands) {
    const name = providerAgentCommandDisplayName(command);
    if (!name) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    agentNames.push({
      name,
      ...(command.description?.trim() ? { description: command.description.trim() } : {}),
    });
  }
  if (agentNames.length === 0) {
    return [];
  }
  const visibleAgents = agentNames.slice(0, 8);
  const hiddenCount = agentNames.length - visibleAgents.length;
  return visibleAgents.map((agent, index) => {
    const detail =
      index === visibleAgents.length - 1 && hiddenCount > 0
        ? [
            agent.description,
            `+${hiddenCount} more provider agents available in the composer menu.`,
          ]
            .filter(Boolean)
            .join("\n")
        : agent.description;
    return {
      id: `${input.provider}:discovered-agent-command:${agent.name.toLowerCase()}`,
      createdAt: input.createdAt,
      label: agent.name,
      status: "agent",
      tone: "info",
      ...(detail ? { detail } : {}),
      action: {
        kind: "composer-prompt",
        label: `Invoke ${agent.name}`,
        prompt: `${agent.name} `,
      },
    };
  });
}

export function deriveEnvironmentSessionProviderStatuses(
  session:
    | {
        readonly provider: ProviderKind;
        readonly capabilities?:
          | Partial<
              Pick<
                ProviderIntegrationCapabilities,
                | "sideConversationMode"
                | "sideConversationCommands"
                | "providerThreadTargetingMode"
                | "goalControlMode"
                | "multiAgentMode"
                | "multiAgentInvocationPrefixes"
                | "multiAgentDefinitionPaths"
                | "multiAgentManagementCommands"
                | "hookMode"
                | "extensionMode"
                | "mcpMode"
                | "remoteAgentMode"
                | "webAccessMode"
                | "hostedSessionMode"
              >
            >
          | undefined;
        readonly updatedAt: string;
      }
    | null
    | undefined,
  providerCommands: ReadonlyArray<ProviderSlashCommand> = [],
): EnvironmentProviderStatus[] {
  const multiAgentMode = session?.capabilities?.multiAgentMode;
  if (!session || !session.capabilities) {
    return [];
  }
  const providerLabel = PROVIDER_DISPLAY_NAMES[session.provider] ?? session.provider;
  const statuses: EnvironmentProviderStatus[] = [];

  const sideConversationMode = session.capabilities.sideConversationMode;
  if (sideConversationMode) {
    const status =
      sideConversationMode === "native-fork" || sideConversationMode === "native-side-thread"
        ? "native"
        : sideConversationMode === "replay-fork"
          ? "replay"
          : "unsupported";
    const detailLines = [
      sideConversationMode === "native-fork"
        ? "Ace /side starts a separate side chat through this provider's native fork support."
        : sideConversationMode === "native-side-thread"
          ? "Ace /side starts a separate side chat through this provider's native side-thread support."
          : sideConversationMode === "replay-fork"
            ? "Ace /side starts a separate side chat by replaying bounded parent context into a separate provider session."
            : "Provider has not advertised side-chat support.",
    ];
    const sideConversationCommands = (session.capabilities.sideConversationCommands ?? []).filter(
      (command) => !isProviderSideConversationAlias(command),
    );
    if (sideConversationCommands.length > 0) {
      detailLines.push("Provider-specific side-chat aliases are handled internally.");
    }
    statuses.push({
      id: `${session.provider}:side-chat-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} side chats`,
      status,
      tone: sideConversationMode === "unsupported" ? "warning" : "info",
      detail: detailLines.join("\n"),
    });
  }

  const providerThreadTargetingMode = session.capabilities.providerThreadTargetingMode;
  if (providerThreadTargetingMode) {
    statuses.push({
      id: `${session.provider}:thread-targeting-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} child threads`,
      status: providerThreadTargetingMode === "native" ? "native" : "unsupported",
      tone: providerThreadTargetingMode === "unsupported" ? "warning" : "info",
      detail:
        providerThreadTargetingMode === "native"
          ? "Ace can send follow-up messages directly to provider-managed child threads."
          : "Provider has not advertised direct child-thread targeting.",
    });
  }

  const goalControlMode = session.capabilities.goalControlMode;
  if (goalControlMode) {
    statuses.push({
      id: `${session.provider}:goal-control-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} goals`,
      status: goalControlMode === "native" ? "native" : "unsupported",
      tone: goalControlMode === "unsupported" ? "warning" : "info",
      detail:
        goalControlMode === "native"
          ? "Provider exposes native goal create, update, pause, resume, and clear controls."
          : "Provider has not advertised native goal controls.",
    });
  }

  if (multiAgentMode) {
    const status =
      multiAgentMode === "native"
        ? "native"
        : multiAgentMode === "agent-command"
          ? "command"
          : "unsupported";
    const detailLines = [
      multiAgentMode === "native"
        ? "Provider can run multi-agent delegation natively."
        : multiAgentMode === "agent-command"
          ? "Provider agents are available through command or mention routing."
          : "Provider has not advertised multi-agent delegation.",
    ];
    const invocationPrefixes = session.capabilities.multiAgentInvocationPrefixes ?? [];
    if (invocationPrefixes.length > 0) {
      detailLines.push(`Invoke: ${invocationPrefixes.join(", ")}`);
    }
    const definitionPaths = session.capabilities.multiAgentDefinitionPaths ?? [];
    if (definitionPaths.length > 0) {
      detailLines.push(`Definitions: ${definitionPaths.join(", ")}`);
    }
    const managementCommands = session.capabilities.multiAgentManagementCommands ?? [];
    if (managementCommands.length > 0) {
      detailLines.push(`Manage: ${managementCommands.join(", ")}`);
    }

    statuses.push({
      id: `${session.provider}:multi-agent-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} agents`,
      status,
      tone: multiAgentMode === "unsupported" ? "warning" : "info",
      detail: detailLines.join("\n"),
    });
  }

  const discoveredAgentStatuses = deriveEnvironmentProviderAgentCommandStatuses({
    commands: providerCommands,
    createdAt: session.updatedAt,
    provider: session.provider,
  });
  if (discoveredAgentStatuses.length > 0) {
    statuses.push(...discoveredAgentStatuses);
  }

  const hookMode = session.capabilities.hookMode;
  if (hookMode) {
    statuses.push({
      id: `${session.provider}:hook-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} hooks`,
      status: hookMode === "native" ? "native" : "unsupported",
      tone: hookMode === "unsupported" ? "warning" : "info",
      detail:
        hookMode === "native"
          ? "Provider can run configured lifecycle hooks."
          : "Provider has not advertised lifecycle hooks.",
    });
  }

  const extensionMode = session.capabilities.extensionMode;
  if (extensionMode) {
    const status =
      extensionMode === "native"
        ? "native"
        : extensionMode === "local-discovery"
          ? "local"
          : "unsupported";
    const detail =
      extensionMode === "native"
        ? "Provider supports configured skills, plugins, extensions, or custom agents."
        : extensionMode === "local-discovery"
          ? "Ace exposes locally discovered provider skills, instructions, or extension commands."
          : "Provider has not advertised customization extensions.";

    statuses.push({
      id: `${session.provider}:extension-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} extensions`,
      status,
      tone: extensionMode === "unsupported" ? "warning" : "info",
      detail,
    });
  }

  const mcpMode = session.capabilities.mcpMode;
  if (mcpMode) {
    const status =
      mcpMode === "native" ? "native" : mcpMode === "local-discovery" ? "local" : "unsupported";
    const detail =
      mcpMode === "native"
        ? "Provider can use configured MCP servers and external tool connectors."
        : mcpMode === "local-discovery"
          ? "Ace exposes locally discovered MCP server configuration."
          : "Provider has not advertised MCP server support.";

    statuses.push({
      id: `${session.provider}:mcp-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} MCP`,
      status,
      tone: mcpMode === "unsupported" ? "warning" : "info",
      detail,
    });
  }

  const remoteAgentMode = session.capabilities.remoteAgentMode;
  if (remoteAgentMode) {
    const status =
      remoteAgentMode === "native"
        ? "native"
        : remoteAgentMode === "local-bridge"
          ? "bridge"
          : "unsupported";
    const detail =
      remoteAgentMode === "native"
        ? "Provider can delegate to hosted, cloud, or remote A2A agents."
        : remoteAgentMode === "local-bridge"
          ? "Ace can bridge provider sessions to remote agent endpoints."
          : "Provider has not advertised hosted or remote agent delegation.";

    statuses.push({
      id: `${session.provider}:remote-agent-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} remote agents`,
      status,
      tone: remoteAgentMode === "unsupported" ? "warning" : "info",
      detail,
    });
  }

  const hostedSessionMode = session.capabilities.hostedSessionMode;
  if (hostedSessionMode) {
    const status =
      hostedSessionMode === "native"
        ? "native"
        : hostedSessionMode === "local-bridge"
          ? "bridge"
          : "unsupported";
    const detail =
      hostedSessionMode === "native"
        ? "Provider can run hosted, cloud, or background coding sessions."
        : hostedSessionMode === "local-bridge"
          ? "Provider can bridge Ace to a remotely controlled local provider session."
          : "Provider has not advertised hosted or background sessions.";

    statuses.push({
      id: `${session.provider}:hosted-session-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} hosted sessions`,
      status,
      tone: hostedSessionMode === "unsupported" ? "warning" : "info",
      detail,
    });
  }

  const webAccessMode = session.capabilities.webAccessMode;
  if (webAccessMode) {
    const status =
      webAccessMode === "native"
        ? "native"
        : webAccessMode === "agent-command"
          ? "command"
          : webAccessMode === "mcp-or-shell"
            ? "tool"
            : "unsupported";
    const detail =
      webAccessMode === "native"
        ? "Provider can use first-party web search, web fetch, or browsing tools."
        : webAccessMode === "agent-command"
          ? "Provider exposes web research through a command or agent route."
          : webAccessMode === "mcp-or-shell"
            ? "Provider can reach web context through MCP tools or shell/network access."
            : "Provider has not advertised web search or web fetch support.";

    statuses.push({
      id: `${session.provider}:web-access-capability`,
      createdAt: session.updatedAt,
      label: `${providerLabel} web access`,
      status,
      tone: webAccessMode === "unsupported" ? "warning" : "info",
      detail,
    });
  }

  return statuses;
}

export function deriveActiveGoalState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ActiveGoalState | null {
  const ordered = ensureActivitiesOrdered(activities);
  let activeGoal: ActiveGoalState | null = null;

  for (const activity of ordered) {
    if (activity.kind === "goal.cleared") {
      activeGoal = null;
      continue;
    }
    if (activity.kind !== "goal.updated" && !isGoalLifecycleWorkLogActivity(activity)) {
      continue;
    }
    const parsedGoal = parseProviderGoalLifecycle({
      summary: activity.summary,
      payload: activity.payload,
    });
    if (!parsedGoal) {
      continue;
    }
    if (parsedGoal.action === "cleared") {
      activeGoal = null;
      continue;
    }
    activeGoal = {
      createdAt: activity.createdAt,
      threadId: parsedGoal.threadId ?? "active-thread",
      objective: parsedGoal.objective,
      status: parsedGoal.status,
      ...(parsedGoal.tokenBudget !== undefined ? { tokenBudget: parsedGoal.tokenBudget } : {}),
      ...(parsedGoal.tokensUsed !== undefined ? { tokensUsed: parsedGoal.tokensUsed } : {}),
      ...(parsedGoal.timeUsedSeconds !== undefined
        ? { timeUsedSeconds: parsedGoal.timeUsedSeconds }
        : {}),
    };
  }

  return activeGoal;
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

const RUNTIME_DETAIL_JSON_MAX = 4000;

function stringifyRuntimeDetailUnknown(value: unknown): string | null {
  try {
    const text = JSON.stringify(value);
    if (text.length <= RUNTIME_DETAIL_JSON_MAX) {
      return text;
    }
    return `${text.slice(0, RUNTIME_DETAIL_JSON_MAX - 1)}…`;
  } catch {
    const fallback = String(value).trim();
    return fallback.length > 0 ? fallback : null;
  }
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const command = extractToolCommand(payload);
  const terminalOutput = extractTerminalOutput(payload);
  const rawChangedFiles = extractChangedFiles(payload);
  const rawChangedFileStats = extractChangedFileStats(payload);
  const title = extractToolTitle(payload);
  const embeddedIntentText = extractEmbeddedIntentText(payload);
  const status = extractToolStatus(payload);
  const exitCode = extractToolExitCode(payload);
  const durationMs = extractToolDurationMs(payload);
  const subagent = extractSubagentMetadata(payload);
  const rawPayloadItemType =
    typeof payload?.itemType === "string" ? payload.itemType.trim() : undefined;
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    ...(activity.sequence !== undefined ? { sequence: activity.sequence } : {}),
    label: sanitizeWorkLogText(activity.summary),
    tone:
      activity.kind === "task.progress" ||
      activity.kind === "reasoning.completed" ||
      payload?.itemType === "reasoning"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    activityKind: activity.kind,
    ...(activity.kind === "runtime.error"
      ? { diagnosticKind: "runtime-error" as const }
      : activity.kind === "runtime.warning"
        ? { diagnosticKind: "runtime-warning" as const }
        : {}),
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  const changedFiles = requestKind === "file-change" ? rawChangedFiles : [];
  const changedFileStats =
    requestKind === "file-change"
      ? rawChangedFileStats.filter((stat) => changedFiles.includes(stat.path))
      : [];
  const isRuntimeDiagnostic =
    activity.kind === "runtime.error" || activity.kind === "runtime.warning";
  if (isRuntimeDiagnostic && payload) {
    const parts: string[] = [];
    const rawMessage = asTrimmedString(payload.message);
    if (rawMessage) {
      const cleaned = stripTrailingExitCode(sanitizeWorkLogText(rawMessage)).output;
      if (cleaned) {
        parts.push(cleaned);
      }
    }
    const rawDetail = payload.detail;
    if (typeof rawDetail === "string" && rawDetail.trim()) {
      const stripped = stripTrailingExitCode(sanitizeWorkLogText(rawDetail));
      const cleaned = stripped.output;
      if (stripped.exitCode !== undefined && entry.exitCode === undefined) {
        entry.exitCode = stripped.exitCode;
      }
      if (cleaned && cleaned !== rawMessage) {
        parts.push(cleaned);
      }
    } else if (rawDetail !== undefined && rawDetail !== null && typeof rawDetail !== "string") {
      const serialized = stringifyRuntimeDetailUnknown(rawDetail);
      if (serialized) {
        parts.push(serialized);
      }
    }
    const combined = parts.join("\n\n");
    if (combined) {
      entry.detail = combined;
    }
  } else if (payload && typeof payload.detail === "string" && payload.detail.length > 0) {
    const extractedDetail = extractToolDetail(payload);
    const stripped = extractedDetail
      ? stripTrailingExitCode(sanitizeWorkLogText(extractedDetail))
      : null;
    const detail = stripped?.output ?? null;
    if (stripped?.exitCode !== undefined && entry.exitCode === undefined) {
      entry.exitCode = stripped.exitCode;
    }
    if (detail) {
      entry.detail = detail;
    }
  } else if (payload) {
    const detail = extractToolDetail(payload);
    if (detail) {
      const normalizedDetail = stripTrailingExitCode(sanitizeWorkLogText(detail)).output;
      if (normalizedDetail) {
        entry.detail = normalizedDetail;
      }
    }
  }
  if (command) {
    entry.command = command;
  }
  if (terminalOutput) {
    entry.terminalOutput = terminalOutput;
  }
  if (payload?.terminalOutputTruncated === true) {
    entry.terminalOutputTruncated = true;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (changedFileStats.length > 0) {
    entry.changedFileStats = changedFileStats;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (status) {
    entry.status = status;
  }
  if (exitCode !== undefined) {
    entry.exitCode = exitCode;
  }
  if (durationMs !== undefined) {
    entry.durationMs = durationMs;
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (subagent.id) {
    entry.subagentId = subagent.id;
  }
  if (subagent.parentId) {
    entry.subagentParentId = subagent.parentId;
  }
  if (subagent.type) {
    entry.subagentType = subagent.type;
  }
  if (subagent.name) {
    entry.subagentName = subagent.name;
  }
  if (subagent.model) {
    entry.subagentModel = subagent.model;
  }
  if (subagent.transcriptPath) {
    entry.subagentTranscriptPath = subagent.transcriptPath;
  }
  const subagentAssistantMessage = subagent.lastAssistantMessage;
  const subagentOpeningMessage = entry.detail ?? subagent.prompt;
  if (rawPayloadItemType === "collab_agent_tool_call" && subagent.id && subagentAssistantMessage) {
    entry.sideChatMessageId = `${activity.id}:assistant`;
    entry.sideChatMessageRole = "assistant";
    entry.sideChatMessageText = subagentAssistantMessage;
  } else if (
    rawPayloadItemType === "collab_agent_tool_call" &&
    subagent.id &&
    subagentOpeningMessage
  ) {
    entry.sideChatMessageId = activity.id;
    entry.sideChatMessageRole = "user";
    entry.sideChatMessageText = subagentOpeningMessage;
  } else if (activity.kind === "subagent.message.sent" && entry.detail) {
    entry.sideChatMessageId =
      typeof payload?.messageId === "string" && payload.messageId.trim().length > 0
        ? payload.messageId.trim()
        : activity.id;
    entry.sideChatMessageRole = "user";
    entry.sideChatMessageText = entry.detail;
  } else if (rawPayloadItemType === "assistant_message" && subagent.id && entry.detail) {
    entry.sideChatMessageId = activity.id;
    entry.sideChatMessageRole = "assistant";
    entry.sideChatMessageText = entry.detail;
  }
  if (embeddedIntentText && entry.tone === "tool") {
    entry.intentText = embeddedIntentText;
  }
  const collapseKey = deriveActivityCollapseKey(entry, payload, activity.turnId);
  if (collapseKey) {
    entry.collapseKey = collapseKey;
  }
  return entry;
}

function toProviderChildRecordEntries(
  activity: OrchestrationThreadActivity,
  baseEntry: DerivedWorkLogEntry,
): DerivedWorkLogEntry[] {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const records = [
    ...providerAgentRecords(payload),
    ...providerAgentRecords(data),
    ...providerAgentRecords(item),
  ];
  if (records.length <= 1 || !baseEntry.sideChatMessageText) {
    return [baseEntry];
  }
  const entries = [baseEntry];
  for (const [recordIndex, record] of records.slice(1).entries()) {
    const metadata = mergeProviderAgentMetadata(
      record,
      providerAgentLooseRecord(record),
      providerAgentLooseRecord(payload),
      providerAgentLooseRecord(data),
      providerAgentLooseRecord(item),
    );
    const subagentId = metadata.id;
    if (!subagentId && !metadata.type && !metadata.name) {
      continue;
    }
    const detail =
      metadata.lastAssistantMessage ??
      metadata.prompt ??
      baseEntry.sideChatMessageText ??
      baseEntry.detail;
    const { collapseKey: _collapseKey, ...baseWithoutCollapseKey } = baseEntry;
    const entry: DerivedWorkLogEntry = {
      ...baseWithoutCollapseKey,
      id: `${baseEntry.id}:provider-child:${recordIndex + 1}`,
      ...(detail ? { detail } : {}),
      ...(subagentId ? { subagentId } : {}),
      ...(metadata.parentId ? { subagentParentId: metadata.parentId } : {}),
      ...(metadata.type ? { subagentType: metadata.type } : {}),
      ...(metadata.name ? { subagentName: metadata.name } : {}),
      ...(metadata.model ? { subagentModel: metadata.model } : {}),
      ...(metadata.transcriptPath ? { subagentTranscriptPath: metadata.transcriptPath } : {}),
      sideChatMessageId: `${baseEntry.sideChatMessageId ?? baseEntry.id}:provider-child:${recordIndex + 1}`,
      ...(detail ? { sideChatMessageText: detail } : {}),
    };
    entries.push(entry);
  }
  return entries;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  const activeStableToolLifecycleIndexByKey = new Map<string, number>();

  for (const entry of entries) {
    const stableToolLifecycleKey =
      entry.collapseKey && isStableToolLifecycleCollapseKey(entry.collapseKey)
        ? entry.collapseKey
        : undefined;
    if (stableToolLifecycleKey) {
      const existingIndex = activeStableToolLifecycleIndexByKey.get(stableToolLifecycleKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex];
        if (existing && shouldCollapseToolLifecycleEntries(existing, entry)) {
          const merged = mergeDerivedWorkLogEntries(existing, entry);
          collapsed[existingIndex] = merged;
          if (merged.activityKind === "tool.completed") {
            activeStableToolLifecycleIndexByKey.delete(stableToolLifecycleKey);
          }
          continue;
        }
      }
    }

    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[collapsed.length - 1] = merged;
      const mergedStableToolLifecycleKey =
        merged.collapseKey && isStableToolLifecycleCollapseKey(merged.collapseKey)
          ? merged.collapseKey
          : undefined;
      if (mergedStableToolLifecycleKey) {
        if (merged.activityKind === "tool.completed") {
          activeStableToolLifecycleIndexByKey.delete(mergedStableToolLifecycleKey);
        } else {
          activeStableToolLifecycleIndexByKey.set(
            mergedStableToolLifecycleKey,
            collapsed.length - 1,
          );
        }
      }
      continue;
    }

    collapsed.push(entry);
    if (stableToolLifecycleKey && entry.activityKind !== "tool.completed") {
      activeStableToolLifecycleIndexByKey.set(stableToolLifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (previous.collapseKey === undefined || previous.collapseKey !== next.collapseKey) {
    return false;
  }

  if (previous.tone === "thinking" && next.tone === "thinking") {
    return true;
  }

  if (
    !isToolLifecycleActivityKind(previous.activityKind) ||
    !isToolLifecycleActivityKind(next.activityKind)
  ) {
    return false;
  }

  return previous.activityKind !== "tool.completed";
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const requestKind = next.requestKind ?? previous.requestKind;
  const changedFiles =
    requestKind === "file-change"
      ? mergeChangedFiles(previous.changedFiles, next.changedFiles)
      : [];
  const detail =
    previous.tone === "thinking" && next.tone === "thinking"
      ? mergeThinkingWorkLogDetail(previous.detail, next.detail)
      : (next.detail ?? previous.detail);
  const command = next.command ?? previous.command;
  const terminalOutputResult = mergeTerminalOutput(
    previous.terminalOutput,
    next.terminalOutput,
    previous.terminalOutputTruncated === true || next.terminalOutputTruncated === true,
  );
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const label = shouldPreservePreviousToolLabel(previous, next) ? previous.label : next.label;
  const itemType = next.itemType ?? previous.itemType;
  const collapseKey = next.collapseKey ?? previous.collapseKey;
  const changedFileStats = mergeChangedFileStats(previous.changedFileStats, next.changedFileStats);
  const status = next.status ?? previous.status;
  const exitCode = next.exitCode ?? previous.exitCode;
  const durationMs = next.durationMs ?? previous.durationMs;
  const subagentId = next.subagentId ?? previous.subagentId;
  const subagentParentId = next.subagentParentId ?? previous.subagentParentId;
  const subagentType = next.subagentType ?? previous.subagentType;
  const subagentName = next.subagentName ?? previous.subagentName;
  const subagentModel = next.subagentModel ?? previous.subagentModel;
  const subagentTranscriptPath = next.subagentTranscriptPath ?? previous.subagentTranscriptPath;
  const sideChatMessageId = next.sideChatMessageId ?? previous.sideChatMessageId;
  const sideChatMessageRole = next.sideChatMessageRole ?? previous.sideChatMessageRole;
  const sideChatMessageText =
    sideChatMessageRole !== undefined
      ? (detail ?? next.sideChatMessageText ?? previous.sideChatMessageText)
      : undefined;
  return {
    ...previous,
    ...next,
    label,
    createdAt: previous.createdAt,
    ...(previous.sequence !== undefined || next.sequence !== undefined
      ? { sequence: previous.sequence ?? next.sequence }
      : {}),
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(terminalOutputResult.terminalOutput
      ? { terminalOutput: terminalOutputResult.terminalOutput }
      : {}),
    ...(terminalOutputResult.terminalOutputTruncated ? { terminalOutputTruncated: true } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(changedFileStats.length > 0 ? { changedFileStats } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(status ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(subagentId ? { subagentId } : {}),
    ...(subagentParentId ? { subagentParentId } : {}),
    ...(subagentType ? { subagentType } : {}),
    ...(subagentName ? { subagentName } : {}),
    ...(subagentModel ? { subagentModel } : {}),
    ...(subagentTranscriptPath ? { subagentTranscriptPath } : {}),
    ...(sideChatMessageId ? { sideChatMessageId } : {}),
    ...(sideChatMessageRole ? { sideChatMessageRole } : {}),
    ...(sideChatMessageText ? { sideChatMessageText } : {}),
    ...(collapseKey ? { collapseKey } : {}),
  };
}

function extractSubagentMetadata(payload: Record<string, unknown> | null): {
  id?: string | undefined;
  parentId?: string | undefined;
  type?: string | undefined;
  name?: string | undefined;
  model?: string | undefined;
  prompt?: string | undefined;
  transcriptPath?: string | undefined;
  lastAssistantMessage?: string | undefined;
} {
  const data = asRecord(payload?.data);
  const ace = asRecord(data?.ace);
  const aceSubagent = asRecord(ace?.subagent);
  const sideConversation =
    asRecord(payload?.sideConversation) ?? asRecord(payload?.side_conversation);
  const item = asRecord(data?.item);
  const subagent =
    providerAgentRecord(payload) ??
    aceSubagent ??
    providerAgentRecord(data) ??
    providerAgentRecord(item);
  const input = asRecord(data?.input);
  const args = asRecord(data?.arguments) ?? asRecord(data?.args) ?? asRecord(data?.rawInput);
  const result = asRecord(data?.result);
  const metadata = mergeProviderAgentMetadata(
    subagent,
    providerAgentLooseRecord(item),
    providerAgentLooseRecord(data),
    providerAgentLooseRecord(payload),
    providerAgentLooseRecord(sideConversation),
    providerAgentLooseRecord(input),
    providerAgentLooseRecord(args),
    providerAgentLooseRecord(result),
  );
  const receiverThreadId = firstTrimmedString(item?.receiverThreadIds);
  const childProviderThreadId =
    asTrimmedString(payload?.childProviderThreadId) ??
    asTrimmedString(payload?.child_provider_thread_id) ??
    asTrimmedString(ace?.childProviderThreadId) ??
    asTrimmedString(ace?.child_provider_thread_id) ??
    asTrimmedString(data?.childProviderThreadId) ??
    asTrimmedString(data?.child_provider_thread_id) ??
    asTrimmedString(item?.childProviderThreadId) ??
    asTrimmedString(item?.child_provider_thread_id) ??
    receiverThreadId;
  const providerSessionId =
    metadata.id !== undefined || subagent !== undefined
      ? (asTrimmedString(payload?.sessionId) ??
        asTrimmedString(payload?.sessionID) ??
        asTrimmedString(payload?.session_id) ??
        asTrimmedString(data?.sessionId) ??
        asTrimmedString(data?.sessionID) ??
        asTrimmedString(data?.session_id) ??
        asTrimmedString(item?.sessionId) ??
        asTrimmedString(item?.sessionID) ??
        asTrimmedString(item?.session_id))
      : undefined;
  return {
    id: childProviderThreadId ?? providerSessionId ?? metadata.id ?? undefined,
    parentId: metadata.parentId ?? undefined,
    type: metadata.type ?? (childProviderThreadId ? "codex subagent" : undefined) ?? undefined,
    name: metadata.name ?? undefined,
    model: metadata.model ?? undefined,
    prompt: metadata.prompt ?? undefined,
    transcriptPath: metadata.transcriptPath ?? undefined,
    lastAssistantMessage: metadata.lastAssistantMessage ?? undefined,
  };
}

function firstTrimmedString(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return asTrimmedString(value);
  }
  for (const item of value) {
    const normalized = asTrimmedString(item);
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

function shouldPreservePreviousToolLabel(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (!isToolLifecycleActivityKind(previous.activityKind)) {
    return false;
  }
  const normalizedNextLabel = next.label.toLowerCase();
  return (
    normalizedNextLabel === "command output" ||
    normalizedNextLabel === "file output" ||
    normalizedNextLabel === "tool"
  );
}

function extractToolStatus(
  payload: Record<string, unknown> | null,
): WorkLogEntry["status"] | undefined {
  const status = asTrimmedString(payload?.status);
  if (status === "inProgress" || status === "completed" || status === "failed") {
    return status;
  }
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemStatus = asTrimmedString(item?.status);
  if (itemStatus === "inProgress" || itemStatus === "completed" || itemStatus === "failed") {
    return itemStatus;
  }
  if (itemStatus === "error") {
    return "failed";
  }
  return undefined;
}

function asFiniteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;
}

function extractToolExitCode(payload: Record<string, unknown> | null): number | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output) ?? asRecord(result?.output);
  return (
    asFiniteInteger(payload?.exitCode) ??
    asFiniteInteger(data?.exitCode) ??
    asFiniteInteger(data?.exit_code) ??
    asFiniteInteger(item?.exitCode) ??
    asFiniteInteger(item?.exit_code) ??
    asFiniteInteger(result?.exitCode) ??
    asFiniteInteger(result?.exit_code) ??
    asFiniteInteger(output?.exitCode) ??
    asFiniteInteger(output?.exit_code)
  );
}

function extractToolDurationMs(payload: Record<string, unknown> | null): number | undefined {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const duration =
    asFiniteInteger(payload?.durationMs) ??
    asFiniteInteger(payload?.duration_ms) ??
    asFiniteInteger(data?.durationMs) ??
    asFiniteInteger(data?.duration_ms) ??
    asFiniteInteger(item?.durationMs) ??
    asFiniteInteger(item?.duration_ms) ??
    asFiniteInteger(result?.durationMs) ??
    asFiniteInteger(result?.duration_ms);
  return duration !== undefined && duration >= 0 ? duration : undefined;
}

function extractTerminalOutput(payload: Record<string, unknown> | null): string | null {
  const direct = terminalOutputString(payload?.terminalOutput);
  if (direct !== null) {
    return direct;
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const result = asRecord(item?.result) ?? asRecord(data?.result);
  const output = asRecord(item?.output) ?? asRecord(data?.output) ?? asRecord(result?.output);
  for (const candidate of [
    item?.aggregatedOutput,
    item?.aggregated_output,
    result?.aggregatedOutput,
    result?.aggregated_output,
    output?.aggregatedOutput,
    output?.aggregated_output,
    data?.aggregatedOutput,
    data?.aggregated_output,
    output?.text,
    result?.text,
  ]) {
    const normalized = terminalOutputString(candidate);
    if (normalized !== null) {
      return normalized;
    }
  }
  return null;
}

function terminalOutputString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\r\n?/g, "\n");
  return normalized.trim().length > 0 ? normalized : null;
}

function mergeTerminalOutput(
  previous: string | undefined,
  next: string | undefined,
  alreadyTruncated: boolean,
): { terminalOutput: string | undefined; terminalOutputTruncated: boolean } {
  if (!previous) {
    return truncateWorkLogTerminalOutput(next, alreadyTruncated);
  }
  if (!next) {
    return { terminalOutput: previous, terminalOutputTruncated: alreadyTruncated };
  }
  if (alreadyTruncated && previous.length >= MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS) {
    return { terminalOutput: previous, terminalOutputTruncated: true };
  }
  let merged: string;
  if (next.startsWith(previous)) {
    merged = next;
  } else if (previous.endsWith(next)) {
    merged = previous;
  } else {
    merged = `${previous}${next}`;
  }
  return truncateWorkLogTerminalOutput(merged, alreadyTruncated);
}

function truncateWorkLogTerminalOutput(
  output: string | undefined,
  alreadyTruncated: boolean,
): { terminalOutput: string | undefined; terminalOutputTruncated: boolean } {
  if (!output) {
    return { terminalOutput: undefined, terminalOutputTruncated: alreadyTruncated };
  }
  if (output.length <= MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS) {
    return { terminalOutput: output, terminalOutputTruncated: alreadyTruncated };
  }
  return {
    terminalOutput: `${output.slice(0, MAX_WORK_LOG_TERMINAL_OUTPUT_CHARS - 3)}...`,
    terminalOutputTruncated: true,
  };
}

function extractChangedFileStats(
  payload: Record<string, unknown> | null,
): Array<{ path: string; additions?: number; deletions?: number }> {
  const stats: Array<{ path: string; additions?: number; deletions?: number }> = [];
  const byPath = new Map<string, { path: string; additions?: number; deletions?: number }>();
  collectChangedFileStats(asRecord(payload?.data), byPath, 0);
  for (const stat of byPath.values()) {
    stats.push(stat);
  }
  return stats;
}

function collectChangedFileStats(
  value: unknown,
  byPath: Map<string, { path: string; additions?: number; deletions?: number }>,
  depth: number,
) {
  if (depth > 5 || byPath.size >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFileStats(entry, byPath, depth + 1);
      if (byPath.size >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const path =
    asTrimmedString(record.path) ??
    asTrimmedString(record.filePath) ??
    asTrimmedString(record.file_path) ??
    asTrimmedString(record.relativePath) ??
    asTrimmedString(record.absolutePath) ??
    asTrimmedString(record.filename);
  if (path) {
    const additions =
      asFiniteInteger(record.additions) ??
      asFiniteInteger(record.added) ??
      asFiniteInteger(record.linesAdded);
    const deletions =
      asFiniteInteger(record.deletions) ??
      asFiniteInteger(record.deleted) ??
      asFiniteInteger(record.linesDeleted);
    if (additions !== undefined || deletions !== undefined) {
      const existing = byPath.get(path);
      byPath.set(path, {
        path,
        additions: Math.max(existing?.additions ?? 0, additions ?? 0),
        deletions: Math.max(existing?.deletions ?? 0, deletions ?? 0),
      });
    }
  }

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "arguments",
    "data",
    "rawOutput",
    "changes",
    "files",
    "locations",
    "edits",
  ] as const) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFileStats(record[nestedKey], byPath, depth + 1);
    if (byPath.size >= 12) {
      return;
    }
  }
}

function mergeChangedFileStats(
  previous: WorkLogEntry["changedFileStats"],
  next: WorkLogEntry["changedFileStats"],
): Array<{ path: string; additions?: number; deletions?: number }> {
  const byPath = new Map<string, { path: string; additions?: number; deletions?: number }>();
  for (const stat of [...(previous ?? []), ...(next ?? [])]) {
    const existing = byPath.get(stat.path);
    byPath.set(stat.path, {
      path: stat.path,
      additions: Math.max(existing?.additions ?? 0, stat.additions ?? 0),
      deletions: Math.max(existing?.deletions ?? 0, stat.deletions ?? 0),
    });
  }
  return [...byPath.values()];
}

function mergeThinkingWorkLogDetail(
  previous: string | undefined,
  next: string | undefined,
): string | undefined {
  if (!previous) {
    return next;
  }
  if (!next) {
    return previous;
  }
  if (next.startsWith(previous)) {
    return next;
  }
  if (previous.startsWith(next)) {
    return previous;
  }

  const needsSpace = /[A-Za-z0-9).!?]$/.test(previous) && /^[A-Za-z0-9(]/.test(next);
  return `${previous}${needsSpace ? " " : ""}${next}`;
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function isToolLifecycleActivityKind(kind: OrchestrationThreadActivity["kind"]): boolean {
  return kind === "tool.started" || kind === "tool.updated" || kind === "tool.completed";
}

function isStableToolLifecycleCollapseKey(key: string): boolean {
  return key.startsWith("tool-id:");
}

function extractToolLifecycleIdentifier(payload: Record<string, unknown> | null): string | null {
  const directCandidates = [
    asTrimmedString(payload?.itemId),
    asTrimmedString(payload?.toolCallId),
    asTrimmedString(payload?.tool_call_id),
  ];
  for (const candidate of directCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const nestedCandidates = [
    asTrimmedString(data?.toolCallId),
    asTrimmedString(data?.tool_call_id),
    asTrimmedString(item?.toolCallId),
    asTrimmedString(item?.tool_call_id),
    asTrimmedString(item?.id),
  ];
  for (const candidate of nestedCandidates) {
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

function deriveActivityCollapseKey(
  entry: DerivedWorkLogEntry,
  payload: Record<string, unknown> | null,
  turnId: TurnId | null | undefined,
): string | undefined {
  const turnSegment = turnId ?? "none";
  if (entry.tone === "thinking") {
    const taskId = asTrimmedString(payload?.taskId);
    if (taskId) {
      return `thinking:${turnSegment}:${taskId}`;
    }
  }

  if (!isToolLifecycleActivityKind(entry.activityKind)) {
    return undefined;
  }

  const toolLifecycleIdentifier = extractToolLifecycleIdentifier(payload);
  if (toolLifecycleIdentifier) {
    return `tool-id:${turnSegment}:${toolLifecycleIdentifier}`;
  }

  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return `tool-fallback:${[turnSegment, itemType, normalizedLabel].join("\u001f")}`;
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:start(?:ed)?|complete|completed)\s*$/i, "").trim();
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId?: TurnId | undefined,
): WorkLogEntry[] {
  const ordered = ensureActivitiesOrdered(activities);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (latestTurnId && activity.turnId !== latestTurnId) {
      continue;
    }
    if (!isRenderableWorkLogActivity(activity)) {
      continue;
    }
    entries.push(...toProviderChildRecordEntries(activity, toDerivedWorkLogEntry(activity)));
  }
  const collapsedEntries = collapseDerivedWorkLogEntries(entries);
  const normalizedEntries: WorkLogEntry[] = [];
  for (const {
    activityKind: _activityKind,
    collapseKey: _collapseKey,
    ...entry
  } of collapsedEntries) {
    normalizedEntries.push(entry);
  }
  return normalizedEntries;
}

export function hasToolActivityForTurn(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: TurnId | null | undefined,
): boolean {
  if (!turnId) return false;
  return activities.some((activity) => activity.turnId === turnId && activity.tone === "tool");
}
