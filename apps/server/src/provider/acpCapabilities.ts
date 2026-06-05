function isRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isEnabledCapability(value: unknown): boolean {
  if (value === true) {
    return true;
  }
  if (value === false) {
    return false;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "enabled" || normalized === "supported";
  }
  const record = isRecord(value);
  if (!record) {
    return false;
  }
  const explicitState =
    record.enabled ?? record.supported ?? record.support ?? record.value ?? record.mode;
  return explicitState === undefined ? true : isEnabledCapability(explicitState);
}

function readDottedCapability(
  record: Record<string, unknown> | null,
  path: ReadonlyArray<string>,
): unknown {
  let current: unknown = record;
  for (const key of path) {
    const currentRecord = isRecord(current);
    if (!currentRecord) {
      return undefined;
    }
    current = currentRecord[key];
  }
  return current;
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap(stringList);
}

function hasSessionForkMethod(value: unknown): boolean {
  return stringList(value).some((entry) => {
    const normalized = entry.trim().toLowerCase().replace(/_/g, "-");
    return normalized === "session/fork" || normalized === "session.fork";
  });
}

function hasSessionResumeMethod(value: unknown): boolean {
  return stringList(value).some((entry) => {
    const normalized = entry.trim().toLowerCase().replace(/_/g, "-");
    return normalized === "session/resume" || normalized === "session.resume";
  });
}

function hasSessionCloseMethod(value: unknown): boolean {
  return stringList(value).some((entry) => {
    const normalized = entry.trim().toLowerCase().replace(/_/g, "-");
    return normalized === "session/close" || normalized === "session.close";
  });
}

function normalizeMethodName(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[_.\s]+/g, "-")
    .replace(/\/+/g, "-")
    .toLowerCase();
}

function methodNames(value: unknown): ReadonlyArray<string> {
  if (typeof value === "string") {
    const normalized = normalizeMethodName(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(methodNames);
  }
  const record = isRecord(value);
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
  ].flatMap(methodNames);
}

function hasMethod(value: unknown, candidates: ReadonlySet<string>): boolean {
  return methodNames(value).some((method) => candidates.has(method));
}

function methodAndFeatureContainers(
  record: Record<string, unknown> | null | undefined,
): ReadonlyArray<unknown> {
  return [
    record?.methods,
    record?.availableMethods,
    record?.available_methods,
    record?.features,
    record?.availableFeatures,
    record?.available_features,
    record?.supportedFeatures,
    record?.supported_features,
  ];
}

const SIDE_CONVERSATION_METHODS = new Set([
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
]);

const PROVIDER_THREAD_TARGETING_METHODS = new Set([
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
]);

const MULTI_AGENT_METHODS = new Set([
  "multi-agent",
  "multi-agents",
  "agent",
  "agents",
  "agent-delegate",
  "agent-delegation",
  "agent-team",
  "agent-teams",
  "team-agent",
  "team-agents",
  "team",
  "teams",
  "agent-handoff",
  "agent-handoffs",
  "handoff",
  "handoffs",
  "subagent",
  "subagents",
  "sub-agent",
  "sub-agents",
  "task-agent",
]);

function acpMethodContainers(input: {
  readonly record: Record<string, unknown> | null;
  readonly rootCapabilities: Record<string, unknown> | null;
  readonly agentCapabilities: Record<string, unknown> | null;
  readonly rootSessionCapabilities: Record<string, unknown> | null;
  readonly agentSessionCapabilities: Record<string, unknown> | null;
  readonly rootSession?: Record<string, unknown> | null;
  readonly agentSession?: Record<string, unknown> | null;
  readonly agentSessions?: Record<string, unknown> | null;
  readonly capabilitySession?: Record<string, unknown> | null;
  readonly meta: Record<string, unknown> | null;
  readonly metaCapabilities: Record<string, unknown> | null;
  readonly metaSessionCapabilities?: Record<string, unknown> | null;
  readonly metaSession?: Record<string, unknown> | null;
}): ReadonlyArray<unknown> {
  return [
    input.record,
    input.rootCapabilities,
    input.agentCapabilities,
    input.rootSessionCapabilities,
    input.agentSessionCapabilities,
    input.rootSession,
    input.agentSession,
    input.agentSessions,
    input.capabilitySession,
    input.meta,
    input.metaCapabilities,
    input.metaSessionCapabilities,
    input.metaSession,
  ].flatMap(methodAndFeatureContainers);
}

export function hasAcpSessionForkCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const agentSession = isRecord(agentCapabilities?.session);
  const agentSessions = isRecord(agentCapabilities?.sessions);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.forkSession,
    agentCapabilities?.sessionFork,
    agentCapabilities?.canForkSession,
    agentCapabilities?.fork_session,
    agentCapabilities?.session_fork,
    agentCapabilities?.can_fork_session,
    agentCapabilities?.["session.fork"],
    agentCapabilities?.["session/fork"],
    agentSessionCapabilities?.fork,
    agentSessionCapabilities?.forkSession,
    agentSessionCapabilities?.sessionFork,
    agentSessionCapabilities?.fork_session,
    agentSessionCapabilities?.session_fork,
    agentSessionCapabilities?.["session.fork"],
    agentSessionCapabilities?.["session/fork"],
    agentSession?.fork,
    agentSession?.forkSession,
    agentSession?.sessionFork,
    agentSession?.["session.fork"],
    agentSession?.["session/fork"],
    agentSessions?.fork,
    agentSessions?.forkSession,
    agentSessions?.sessionFork,
    agentSessions?.["session.fork"],
    agentSessions?.["session/fork"],
    rootSessionCapabilities?.fork,
    rootSessionCapabilities?.forkSession,
    rootSessionCapabilities?.sessionFork,
    rootSessionCapabilities?.fork_session,
    rootSessionCapabilities?.session_fork,
    rootSessionCapabilities?.["session.fork"],
    rootSessionCapabilities?.["session/fork"],
    rootSession?.fork,
    rootSession?.forkSession,
    rootSession?.sessionFork,
    rootSession?.["session.fork"],
    rootSession?.["session/fork"],
    rootCapabilities?.forkSession,
    rootCapabilities?.sessionFork,
    rootCapabilities?.fork_session,
    rootCapabilities?.session_fork,
    rootCapabilities?.["session.fork"],
    rootCapabilities?.["session/fork"],
    capabilitySession?.fork,
    capabilitySession?.forkSession,
    capabilitySession?.sessionFork,
    capabilitySession?.["session.fork"],
    capabilitySession?.["session/fork"],
    meta?.forkSession,
    meta?.sessionFork,
    meta?.["session.fork"],
    meta?.["session/fork"],
    metaCapabilities?.forkSession,
    metaCapabilities?.sessionFork,
    metaCapabilities?.["session.fork"],
    metaCapabilities?.["session/fork"],
    metaSessionCapabilities?.fork,
    metaSessionCapabilities?.forkSession,
    metaSessionCapabilities?.sessionFork,
    metaSessionCapabilities?.["session.fork"],
    metaSessionCapabilities?.["session/fork"],
    metaSession?.fork,
    metaSession?.forkSession,
    metaSession?.sessionFork,
    metaSession?.["session.fork"],
    metaSession?.["session/fork"],
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "fork"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "forkSession"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "sessionFork"]),
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    meta,
    metaCapabilities,
  }).some(hasSessionForkMethod);
}

export function hasAcpSessionResumeCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.resumeSession,
    agentCapabilities?.sessionResume,
    agentCapabilities?.canResumeSession,
    agentCapabilities?.resume_session,
    agentCapabilities?.session_resume,
    agentCapabilities?.can_resume_session,
    agentCapabilities?.["session.resume"],
    agentCapabilities?.["session/resume"],
    agentSessionCapabilities?.resume,
    agentSessionCapabilities?.resumeSession,
    agentSessionCapabilities?.sessionResume,
    agentSessionCapabilities?.resume_session,
    agentSessionCapabilities?.session_resume,
    agentSessionCapabilities?.["session.resume"],
    agentSessionCapabilities?.["session/resume"],
    rootSessionCapabilities?.resume,
    rootSessionCapabilities?.resumeSession,
    rootSessionCapabilities?.sessionResume,
    rootSessionCapabilities?.resume_session,
    rootSessionCapabilities?.session_resume,
    rootSessionCapabilities?.["session.resume"],
    rootSessionCapabilities?.["session/resume"],
    rootSession?.resume,
    rootSession?.resumeSession,
    rootSession?.sessionResume,
    rootSession?.["session.resume"],
    rootSession?.["session/resume"],
    rootCapabilities?.resumeSession,
    rootCapabilities?.sessionResume,
    rootCapabilities?.resume_session,
    rootCapabilities?.session_resume,
    rootCapabilities?.["session.resume"],
    rootCapabilities?.["session/resume"],
    capabilitySession?.resume,
    capabilitySession?.resumeSession,
    capabilitySession?.sessionResume,
    capabilitySession?.["session.resume"],
    capabilitySession?.["session/resume"],
    meta?.resumeSession,
    meta?.sessionResume,
    meta?.["session.resume"],
    meta?.["session/resume"],
    metaCapabilities?.resumeSession,
    metaCapabilities?.sessionResume,
    metaCapabilities?.["session.resume"],
    metaCapabilities?.["session/resume"],
    metaSessionCapabilities?.resume,
    metaSessionCapabilities?.resumeSession,
    metaSessionCapabilities?.sessionResume,
    metaSessionCapabilities?.["session.resume"],
    metaSessionCapabilities?.["session/resume"],
    metaSession?.resume,
    metaSession?.resumeSession,
    metaSession?.sessionResume,
    metaSession?.["session.resume"],
    metaSession?.["session/resume"],
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "resume"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "resumeSession"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "sessionResume"]),
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    meta,
    metaCapabilities,
  }).some(hasSessionResumeMethod);
}

export function hasAcpSessionCloseCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.closeSession,
    agentCapabilities?.sessionClose,
    agentCapabilities?.canCloseSession,
    agentCapabilities?.close_session,
    agentCapabilities?.session_close,
    agentCapabilities?.can_close_session,
    agentCapabilities?.["session.close"],
    agentCapabilities?.["session/close"],
    agentSessionCapabilities?.close,
    agentSessionCapabilities?.closeSession,
    agentSessionCapabilities?.sessionClose,
    agentSessionCapabilities?.close_session,
    agentSessionCapabilities?.session_close,
    agentSessionCapabilities?.["session.close"],
    agentSessionCapabilities?.["session/close"],
    rootSessionCapabilities?.close,
    rootSessionCapabilities?.closeSession,
    rootSessionCapabilities?.sessionClose,
    rootSessionCapabilities?.close_session,
    rootSessionCapabilities?.session_close,
    rootSessionCapabilities?.["session.close"],
    rootSessionCapabilities?.["session/close"],
    rootSession?.close,
    rootSession?.closeSession,
    rootSession?.sessionClose,
    rootSession?.["session.close"],
    rootSession?.["session/close"],
    rootCapabilities?.closeSession,
    rootCapabilities?.sessionClose,
    rootCapabilities?.close_session,
    rootCapabilities?.session_close,
    rootCapabilities?.["session.close"],
    rootCapabilities?.["session/close"],
    capabilitySession?.close,
    capabilitySession?.closeSession,
    capabilitySession?.sessionClose,
    capabilitySession?.["session.close"],
    capabilitySession?.["session/close"],
    meta?.closeSession,
    meta?.sessionClose,
    meta?.["session.close"],
    meta?.["session/close"],
    metaCapabilities?.closeSession,
    metaCapabilities?.sessionClose,
    metaCapabilities?.["session.close"],
    metaCapabilities?.["session/close"],
    metaSessionCapabilities?.close,
    metaSessionCapabilities?.closeSession,
    metaSessionCapabilities?.sessionClose,
    metaSessionCapabilities?.["session.close"],
    metaSessionCapabilities?.["session/close"],
    metaSession?.close,
    metaSession?.closeSession,
    metaSession?.sessionClose,
    metaSession?.["session.close"],
    metaSession?.["session/close"],
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "close"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "closeSession"]),
    readDottedCapability(record, ["capabilities", "sessionCapabilities", "sessionClose"]),
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    meta,
    metaCapabilities,
  }).some(hasSessionCloseMethod);
}

export function hasAcpSideConversationCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const agentSession = isRecord(agentCapabilities?.session);
  const agentSessions = isRecord(agentCapabilities?.sessions);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.sideConversation,
    agentCapabilities?.side_conversation,
    agentCapabilities?.sideChat,
    agentCapabilities?.side_chat,
    agentCapabilities?.sideSession,
    agentCapabilities?.side_session,
    agentCapabilities?.sideThread,
    agentCapabilities?.side_thread,
    agentCapabilities?.["side.conversation"],
    agentCapabilities?.["side/chat"],
    agentCapabilities?.["side.session"],
    agentCapabilities?.["side/session"],
    agentCapabilities?.["side.thread"],
    agentCapabilities?.["side/thread"],
    agentSessionCapabilities?.sideConversation,
    agentSessionCapabilities?.sideChat,
    agentSessionCapabilities?.sideSession,
    agentSessionCapabilities?.sideThread,
    agentSession?.sideConversation,
    agentSession?.sideChat,
    agentSession?.sideSession,
    agentSession?.sideThread,
    agentSessions?.sideConversation,
    agentSessions?.sideChat,
    agentSessions?.sideSession,
    agentSessions?.sideThread,
    rootSessionCapabilities?.sideConversation,
    rootSessionCapabilities?.sideChat,
    rootSessionCapabilities?.sideSession,
    rootSessionCapabilities?.sideThread,
    rootSession?.sideConversation,
    rootSession?.sideChat,
    rootSession?.sideSession,
    rootSession?.sideThread,
    rootCapabilities?.sideConversation,
    rootCapabilities?.side_conversation,
    rootCapabilities?.sideChat,
    rootCapabilities?.side_chat,
    rootCapabilities?.sideSession,
    rootCapabilities?.side_session,
    rootCapabilities?.sideThread,
    rootCapabilities?.side_thread,
    rootCapabilities?.["side.conversation"],
    rootCapabilities?.["side/chat"],
    rootCapabilities?.["side.session"],
    rootCapabilities?.["side/session"],
    rootCapabilities?.["side.thread"],
    rootCapabilities?.["side/thread"],
    capabilitySession?.sideConversation,
    capabilitySession?.sideChat,
    capabilitySession?.sideSession,
    capabilitySession?.sideThread,
    meta?.sideConversation,
    meta?.sideChat,
    meta?.sideSession,
    meta?.sideThread,
    meta?.["side.conversation"],
    meta?.["side/chat"],
    metaCapabilities?.sideConversation,
    metaCapabilities?.sideChat,
    metaCapabilities?.sideSession,
    metaCapabilities?.sideThread,
    metaCapabilities?.["side.conversation"],
    metaCapabilities?.["side/chat"],
    metaSessionCapabilities?.sideConversation,
    metaSessionCapabilities?.sideChat,
    metaSessionCapabilities?.sideSession,
    metaSessionCapabilities?.sideThread,
    metaSession?.sideConversation,
    metaSession?.sideChat,
    metaSession?.sideSession,
    metaSession?.sideThread,
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    rootSession,
    agentSession,
    agentSessions,
    capabilitySession,
    meta,
    metaCapabilities,
    metaSessionCapabilities,
    metaSession,
  }).some((container) => hasMethod(container, SIDE_CONVERSATION_METHODS));
}

export function hasAcpProviderThreadTargetingCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const agentSession = isRecord(agentCapabilities?.session);
  const agentSessions = isRecord(agentCapabilities?.sessions);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.providerThreadTargeting,
    agentCapabilities?.provider_thread_targeting,
    agentCapabilities?.providerSessionTargeting,
    agentCapabilities?.provider_session_targeting,
    agentCapabilities?.childThreadTargeting,
    agentCapabilities?.child_thread_targeting,
    agentCapabilities?.childSessionTargeting,
    agentCapabilities?.child_session_targeting,
    agentCapabilities?.childConversationTargeting,
    agentCapabilities?.child_conversation_targeting,
    agentCapabilities?.providerThread,
    agentCapabilities?.provider_thread,
    agentCapabilities?.providerSession,
    agentCapabilities?.provider_session,
    agentCapabilities?.childThread,
    agentCapabilities?.child_thread,
    agentCapabilities?.childSession,
    agentCapabilities?.child_session,
    agentCapabilities?.childConversation,
    agentCapabilities?.child_conversation,
    agentSessionCapabilities?.threadTargeting,
    agentSessionCapabilities?.providerThreadTargeting,
    agentSessionCapabilities?.providerSessionTargeting,
    agentSessionCapabilities?.childThreadTargeting,
    agentSessionCapabilities?.childSessionTargeting,
    agentSession?.threadTargeting,
    agentSession?.providerThreadTargeting,
    agentSession?.providerSessionTargeting,
    agentSession?.childThreadTargeting,
    agentSession?.childSessionTargeting,
    agentSessions?.threadTargeting,
    agentSessions?.providerThreadTargeting,
    agentSessions?.providerSessionTargeting,
    agentSessions?.childThreadTargeting,
    agentSessions?.childSessionTargeting,
    rootSessionCapabilities?.threadTargeting,
    rootSessionCapabilities?.providerThreadTargeting,
    rootSessionCapabilities?.providerSessionTargeting,
    rootSessionCapabilities?.childThreadTargeting,
    rootSessionCapabilities?.childSessionTargeting,
    rootSession?.threadTargeting,
    rootSession?.providerThreadTargeting,
    rootSession?.providerSessionTargeting,
    rootSession?.childThreadTargeting,
    rootSession?.childSessionTargeting,
    rootCapabilities?.providerThreadTargeting,
    rootCapabilities?.provider_thread_targeting,
    rootCapabilities?.providerSessionTargeting,
    rootCapabilities?.provider_session_targeting,
    rootCapabilities?.childThreadTargeting,
    rootCapabilities?.child_thread_targeting,
    rootCapabilities?.childSessionTargeting,
    rootCapabilities?.child_session_targeting,
    rootCapabilities?.childConversationTargeting,
    rootCapabilities?.child_conversation_targeting,
    rootCapabilities?.providerThread,
    rootCapabilities?.provider_thread,
    rootCapabilities?.providerSession,
    rootCapabilities?.provider_session,
    rootCapabilities?.childThread,
    rootCapabilities?.child_thread,
    rootCapabilities?.childSession,
    rootCapabilities?.child_session,
    rootCapabilities?.childConversation,
    rootCapabilities?.child_conversation,
    capabilitySession?.threadTargeting,
    capabilitySession?.providerThreadTargeting,
    capabilitySession?.providerSessionTargeting,
    capabilitySession?.childThreadTargeting,
    capabilitySession?.childSessionTargeting,
    meta?.providerThreadTargeting,
    meta?.providerSessionTargeting,
    meta?.childThreadTargeting,
    meta?.childSessionTargeting,
    metaCapabilities?.providerThreadTargeting,
    metaCapabilities?.providerSessionTargeting,
    metaCapabilities?.childThreadTargeting,
    metaCapabilities?.childSessionTargeting,
    metaSessionCapabilities?.threadTargeting,
    metaSessionCapabilities?.providerThreadTargeting,
    metaSessionCapabilities?.providerSessionTargeting,
    metaSessionCapabilities?.childThreadTargeting,
    metaSessionCapabilities?.childSessionTargeting,
    metaSession?.threadTargeting,
    metaSession?.providerThreadTargeting,
    metaSession?.providerSessionTargeting,
    metaSession?.childThreadTargeting,
    metaSession?.childSessionTargeting,
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    rootSession,
    agentSession,
    agentSessions,
    capabilitySession,
    meta,
    metaCapabilities,
    metaSessionCapabilities,
    metaSession,
  }).some((container) => hasMethod(container, PROVIDER_THREAD_TARGETING_METHODS));
}

export function hasAcpMultiAgentCapability(initializeResult: unknown): boolean {
  const record = isRecord(initializeResult);
  const agentCapabilities = isRecord(record?.agentCapabilities);
  const rootSessionCapabilities = isRecord(record?.sessionCapabilities);
  const agentSessionCapabilities = isRecord(agentCapabilities?.sessionCapabilities);
  const agentSession = isRecord(agentCapabilities?.session);
  const agentSessions = isRecord(agentCapabilities?.sessions);
  const rootCapabilities = isRecord(record?.capabilities);
  const rootSession = isRecord(record?.session);
  const capabilitySession = isRecord(rootCapabilities?.session);
  const meta = isRecord(record?._meta);
  const metaCapabilities = isRecord(meta?.capabilities);
  const metaSessionCapabilities = isRecord(metaCapabilities?.sessionCapabilities);
  const metaSession = isRecord(metaCapabilities?.session);

  const capabilityValues = [
    agentCapabilities?.multiAgent,
    agentCapabilities?.multi_agent,
    agentCapabilities?.multiAgents,
    agentCapabilities?.multi_agents,
    agentCapabilities?.agents,
    agentCapabilities?.agentTeams,
    agentCapabilities?.agent_teams,
    agentCapabilities?.teams,
    agentCapabilities?.handoffs,
    agentCapabilities?.subagents,
    agentCapabilities?.subAgents,
    agentCapabilities?.sub_agents,
    agentCapabilities?.["multi.agent"],
    agentCapabilities?.["multi/agent"],
    agentCapabilities?.["agent.team"],
    agentCapabilities?.["agent/team"],
    agentCapabilities?.["agent.handoff"],
    agentCapabilities?.["agent/handoff"],
    agentSessionCapabilities?.multiAgent,
    agentSessionCapabilities?.multiAgents,
    agentSessionCapabilities?.agents,
    agentSessionCapabilities?.agentTeams,
    agentSessionCapabilities?.teams,
    agentSessionCapabilities?.handoffs,
    agentSessionCapabilities?.subagents,
    agentSessionCapabilities?.subAgents,
    agentSession?.multiAgent,
    agentSession?.multiAgents,
    agentSession?.agents,
    agentSession?.agentTeams,
    agentSession?.teams,
    agentSession?.handoffs,
    agentSession?.subagents,
    agentSession?.subAgents,
    agentSessions?.multiAgent,
    agentSessions?.multiAgents,
    agentSessions?.agents,
    agentSessions?.agentTeams,
    agentSessions?.teams,
    agentSessions?.handoffs,
    agentSessions?.subagents,
    agentSessions?.subAgents,
    rootSessionCapabilities?.multiAgent,
    rootSessionCapabilities?.multiAgents,
    rootSessionCapabilities?.agents,
    rootSessionCapabilities?.agentTeams,
    rootSessionCapabilities?.teams,
    rootSessionCapabilities?.handoffs,
    rootSessionCapabilities?.subagents,
    rootSessionCapabilities?.subAgents,
    rootSession?.multiAgent,
    rootSession?.multiAgents,
    rootSession?.agents,
    rootSession?.agentTeams,
    rootSession?.teams,
    rootSession?.handoffs,
    rootSession?.subagents,
    rootSession?.subAgents,
    rootCapabilities?.multiAgent,
    rootCapabilities?.multi_agent,
    rootCapabilities?.multiAgents,
    rootCapabilities?.multi_agents,
    rootCapabilities?.agents,
    rootCapabilities?.agentTeams,
    rootCapabilities?.agent_teams,
    rootCapabilities?.teams,
    rootCapabilities?.handoffs,
    rootCapabilities?.subagents,
    rootCapabilities?.subAgents,
    rootCapabilities?.sub_agents,
    rootCapabilities?.["multi.agent"],
    rootCapabilities?.["multi/agent"],
    rootCapabilities?.["agent.team"],
    rootCapabilities?.["agent/team"],
    rootCapabilities?.["agent.handoff"],
    rootCapabilities?.["agent/handoff"],
    capabilitySession?.multiAgent,
    capabilitySession?.multiAgents,
    capabilitySession?.agents,
    capabilitySession?.agentTeams,
    capabilitySession?.teams,
    capabilitySession?.handoffs,
    capabilitySession?.subagents,
    capabilitySession?.subAgents,
    meta?.multiAgent,
    meta?.multiAgents,
    meta?.agents,
    meta?.agentTeams,
    meta?.teams,
    meta?.handoffs,
    meta?.subagents,
    meta?.subAgents,
    meta?.["multi.agent"],
    meta?.["multi/agent"],
    meta?.["agent.team"],
    meta?.["agent/team"],
    metaCapabilities?.multiAgent,
    metaCapabilities?.multiAgents,
    metaCapabilities?.agents,
    metaCapabilities?.agentTeams,
    metaCapabilities?.teams,
    metaCapabilities?.handoffs,
    metaCapabilities?.subagents,
    metaCapabilities?.subAgents,
    metaCapabilities?.["multi.agent"],
    metaCapabilities?.["multi/agent"],
    metaCapabilities?.["agent.team"],
    metaCapabilities?.["agent/team"],
    metaSessionCapabilities?.multiAgent,
    metaSessionCapabilities?.multiAgents,
    metaSessionCapabilities?.agents,
    metaSessionCapabilities?.agentTeams,
    metaSessionCapabilities?.teams,
    metaSessionCapabilities?.handoffs,
    metaSessionCapabilities?.subagents,
    metaSessionCapabilities?.subAgents,
    metaSession?.multiAgent,
    metaSession?.multiAgents,
    metaSession?.agents,
    metaSession?.agentTeams,
    metaSession?.teams,
    metaSession?.handoffs,
    metaSession?.subagents,
    metaSession?.subAgents,
  ];
  if (capabilityValues.some(isEnabledCapability)) {
    return true;
  }

  return acpMethodContainers({
    record,
    rootCapabilities,
    agentCapabilities,
    rootSessionCapabilities,
    agentSessionCapabilities,
    rootSession,
    agentSession,
    agentSessions,
    capabilitySession,
    meta,
    metaCapabilities,
    metaSessionCapabilities,
    metaSession,
  }).some((container) => hasMethod(container, MULTI_AGENT_METHODS));
}
