export type ProviderAgentMetadata = {
  readonly id?: string;
  readonly parentId?: string;
  readonly type?: string;
  readonly name?: string;
  readonly model?: string;
  readonly description?: string;
  readonly prompt?: string;
  readonly transcriptPath?: string;
  readonly lastAssistantMessage?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record) {
    return record;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  for (const item of value) {
    const itemRecord = asRecord(item);
    if (itemRecord) {
      return itemRecord;
    }
  }
  return undefined;
}

function recordsFrom(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  if (record) {
    return [record];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const itemRecord = asRecord(item);
    return itemRecord ? [itemRecord] : [];
  });
}

const providerAgentContainerKeys = [
  "subagent",
  "subagents",
  "sub_agent",
  "sub_agents",
  "agent",
  "agents",
  "customAgent",
  "custom_agent",
  "customAgents",
  "custom_agents",
  "selectedAgent",
  "selected_agent",
  "selectedAgents",
  "selected_agents",
  "selectedSubagent",
  "selected_subagent",
  "selectedSubagents",
  "selected_subagents",
  "assistant",
  "assistants",
  "selectedAssistant",
  "selected_assistant",
  "selectedAssistants",
  "selected_assistants",
  "persona",
  "personas",
  "selectedPersona",
  "selected_persona",
  "selectedPersonas",
  "selected_personas",
  "profile",
  "profiles",
  "selectedProfile",
  "selected_profile",
  "selectedProfiles",
  "selected_profiles",
  "agentProfile",
  "agent_profile",
  "agentProfiles",
  "agent_profiles",
  "teamAgent",
  "team_agent",
  "teamAgents",
  "team_agents",
  "agentTeam",
  "agent_team",
  "agentTeams",
  "agent_teams",
  "fleet",
  "fleets",
  "subtask",
  "subtasks",
  "taskAgent",
  "task_agent",
  "taskAgents",
  "task_agents",
  "task",
  "tasks",
  "assignedAgent",
  "assigned_agent",
  "delegatedAgent",
  "delegated_agent",
  "delegate",
  "assignee",
  "worker",
  "childAgent",
  "child_agent",
  "childAgents",
  "child_agents",
  "childThread",
  "child_thread",
  "childThreads",
  "child_threads",
  "childSession",
  "child_session",
  "childSessions",
  "child_sessions",
  "childConversation",
  "child_conversation",
  "childConversations",
  "child_conversations",
  "sideChat",
  "side_chat",
  "sideChats",
  "side_chats",
  "sideConversation",
  "side_conversation",
  "sideConversations",
  "side_conversations",
] as const;

function firstRecordFromKeys(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): Record<string, unknown> | undefined {
  for (const key of keys) {
    const item = firstRecord(record[key]);
    if (item) {
      return item;
    }
  }
  return undefined;
}

function recordsFromKeys(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): ReadonlyArray<Record<string, unknown>> {
  return keys.flatMap((key) => recordsFrom(record[key]));
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function firstTrimmedString(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    if (Array.isArray(value)) {
      const normalized = firstTrimmedString(...value);
      if (normalized) {
        return normalized;
      }
      continue;
    }
    const normalized = asTrimmedString(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function firstProviderText(value: unknown, depth = 0): string | undefined {
  if (depth > 12) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => firstProviderText(item, depth + 1))
      .filter((item): item is string => item !== undefined);
    return parts.length > 0 ? parts.join("\n").trim() : undefined;
  }
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return firstProviderText(
    [
      record.text,
      record.outputText,
      record.output_text,
      record.message,
      record.content,
      record.contents,
      record.parts,
      record.response,
      record.result,
      record.output,
    ],
    depth + 1,
  );
}

function firstProviderTextFrom(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = firstProviderText(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

function providerMessageRole(value: unknown): string | undefined {
  const record = asRecord(value);
  const rawRole = record?.role ?? record?.speaker ?? record?.author ?? record?.type ?? record?.kind;
  return typeof rawRole === "string"
    ? rawRole
        .trim()
        .toLowerCase()
        .replace(/[_\s-]+/g, "-")
    : undefined;
}

function isProviderAssistantRole(value: unknown): boolean {
  const role = providerMessageRole(value);
  return (
    role === "assistant" ||
    role === "agent" ||
    role === "model" ||
    role === "subagent" ||
    role === "sub-agent"
  );
}

function lastProviderAssistantText(value: unknown, depth = 0): string | undefined {
  if (depth > 12) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value.toReversed()) {
      const normalized = lastProviderAssistantText(item, depth + 1);
      if (normalized) {
        return normalized;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (isProviderAssistantRole(record)) {
    return firstProviderText(record, depth + 1);
  }
  return lastProviderAssistantText(
    [
      record.messages,
      record.message,
      record.transcript,
      record.conversation,
      record.events,
      record.items,
      record.outputs,
      record.results,
    ],
    depth + 1,
  );
}

function lastProviderAssistantTextFrom(...values: ReadonlyArray<unknown>): string | undefined {
  for (const value of values) {
    const normalized = lastProviderAssistantText(value);
    if (normalized) {
      return normalized;
    }
  }
  return undefined;
}

export function providerAgentRecord(
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  return firstRecordFromKeys(record, providerAgentContainerKeys);
}

export function providerAgentRecords(
  record: Record<string, unknown> | null | undefined,
): ReadonlyArray<Record<string, unknown>> {
  if (!record) {
    return [];
  }
  return recordsFromKeys(record, providerAgentContainerKeys);
}

export function providerAgentMetadataFromRecord(
  record: Record<string, unknown> | null | undefined,
): ProviderAgentMetadata {
  if (!record) {
    return {};
  }
  const attributes = asRecord(record.attributes) ?? asRecord(record.attribute);
  const id = firstTrimmedString(
    record.id,
    record["gen_ai.agent.id"],
    attributes?.["gen_ai.agent.id"],
    record.agentId,
    record.agent_id,
    record.customAgentId,
    record.custom_agent_id,
    record.selectedAgentId,
    record.selected_agent_id,
    record.selectedSubagentId,
    record.selected_subagent_id,
    record.agentProfileId,
    record.agent_profile_id,
    record.selectedProfileId,
    record.selected_profile_id,
    record.profileId,
    record.profile_id,
    record.personaId,
    record.persona_id,
    record.selectedPersonaId,
    record.selected_persona_id,
    record.assistantId,
    record.assistant_id,
    record.selectedAssistantId,
    record.selected_assistant_id,
    record.agentSlug,
    record.agent_slug,
    record.profileSlug,
    record.profile_slug,
    record.personaSlug,
    record.persona_slug,
    record.assistantSlug,
    record.assistant_slug,
    record.slug,
    record.taskId,
    record.taskID,
    record.task_id,
    record.subagentId,
    record.subagent_id,
    record.providerThreadId,
    record.provider_thread_id,
    record.providerThreadIds,
    record.provider_thread_ids,
    record.childProviderThreadId,
    record.child_provider_thread_id,
    record.childProviderThreadIds,
    record.child_provider_thread_ids,
    record.childThreadId,
    record.child_thread_id,
    record.childThreadIds,
    record.child_thread_ids,
    record.receiverThreadId,
    record.receiver_thread_id,
    record.receiverThreadIds,
    record.receiver_thread_ids,
    record.agentThreadId,
    record.agent_thread_id,
    record.agentThreadIds,
    record.agent_thread_ids,
    record.providerConversationId,
    record.provider_conversation_id,
    record.providerSideConversationId,
    record.provider_side_conversation_id,
    record.providerSideChatId,
    record.provider_side_chat_id,
    record.childProviderConversationId,
    record.child_provider_conversation_id,
    record.childProviderConversationIds,
    record.child_provider_conversation_ids,
    record.sideConversationId,
    record.side_conversation_id,
    record.sideChatId,
    record.side_chat_id,
    record.threadId,
    record.thread_id,
    record.sessionId,
    record.session_id,
    record.conversationId,
    record.conversation_id,
  );
  const parentId = firstTrimmedString(
    record.parentId,
    record["gen_ai.agent.parent_id"],
    attributes?.["gen_ai.agent.parent_id"],
    record.parent_id,
    record.parentAgentId,
    record.parent_agent_id,
    record.parentSubagentId,
    record.parent_subagent_id,
    record.parentTaskId,
    record.parentTaskID,
    record.parent_task_id,
    record.parentToolUseId,
    record.parent_tool_use_id,
    record.parentProviderThreadId,
    record.parent_provider_thread_id,
    record.parentProviderConversationId,
    record.parent_provider_conversation_id,
    record.parentThreadId,
    record.parent_thread_id,
    record.parentSessionId,
    record.parentSessionID,
    record.parent_session_id,
    record.parentConversationId,
    record.parent_conversation_id,
  );
  const type = firstTrimmedString(
    record.type,
    record["gen_ai.agent.type"],
    attributes?.["gen_ai.agent.type"],
    record["gen_ai.agent.role"],
    attributes?.["gen_ai.agent.role"],
    record.role,
    record.agentRole,
    record.agent_role,
    record.subagentType,
    record.subagent_type,
    record.agentType,
    record.agent_type,
    record.customAgentType,
    record.custom_agent_type,
    record.profileType,
    record.profile_type,
    record.personaType,
    record.persona_type,
    record.assistantType,
    record.assistant_type,
    record.mode,
  );
  const name = firstTrimmedString(
    record.name,
    record["gen_ai.agent.name"],
    attributes?.["gen_ai.agent.name"],
    record["gen_ai.agent.nickname"],
    attributes?.["gen_ai.agent.nickname"],
    record.displayName,
    record.display_name,
    record.nickname,
    record.agentDisplayName,
    record.agent_display_name,
    record.agentNickname,
    record.agent_nickname,
    record.agentName,
    record.agent_name,
    record.subagentName,
    record.subagent_name,
    record.customAgentName,
    record.custom_agent_name,
    record.profileName,
    record.profile_name,
    record.personaName,
    record.persona_name,
    record.assistantName,
    record.assistant_name,
    record.title,
    record.label,
  );
  const model = firstTrimmedString(
    record.model,
    record["gen_ai.request.model"],
    attributes?.["gen_ai.request.model"],
    record["gen_ai.response.model"],
    attributes?.["gen_ai.response.model"],
    record.modelId,
    record.model_id,
  );
  const description = firstTrimmedString(
    record.description,
    record["gen_ai.agent.description"],
    attributes?.["gen_ai.agent.description"],
    record.summary,
    record.details,
  );
  const prompt = firstTrimmedString(
    record.prompt,
    record["gen_ai.agent.prompt"],
    attributes?.["gen_ai.agent.prompt"],
    record["gen_ai.agent.instructions"],
    attributes?.["gen_ai.agent.instructions"],
    record.systemPrompt,
    record.system_prompt,
    record.instructionsText,
    record.instructions_text,
    record.instructions,
    record.instruction,
    record.message,
    record.task,
    record.objective,
    record.request,
    record.query,
  );
  const transcriptPath = firstTrimmedString(
    record.transcriptPath,
    record["gen_ai.agent.transcript_path"],
    attributes?.["gen_ai.agent.transcript_path"],
    record.transcript_path,
    record.agentTranscriptPath,
    record.agent_transcript_path,
    record.subagentTranscriptPath,
    record.subagent_transcript_path,
  );
  const lastAssistantMessage =
    firstProviderTextFrom(
      record.lastAssistantMessage,
      record.last_assistant_message,
      record.finalAssistantMessage,
      record.final_assistant_message,
      record.finalMessage,
      record.final_message,
      record.outputText,
      record.output_text,
      record.content,
      record.response,
      record.result,
      record.output,
    ) ??
    lastProviderAssistantTextFrom(
      record.messages,
      record.transcript,
      record.conversation,
      record.events,
      record.items,
      record.outputs,
      record.results,
    );
  return {
    ...(id ? { id } : {}),
    ...(parentId ? { parentId } : {}),
    ...(type ? { type } : {}),
    ...(name ? { name } : {}),
    ...(model ? { model } : {}),
    ...(description ? { description } : {}),
    ...(prompt ? { prompt } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
    ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
  };
}

export function providerAgentLooseRecord(
  record: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  if (!record) {
    return undefined;
  }
  const loose: Record<string, unknown> = {};
  const attributes = asRecord(record.attributes) ?? asRecord(record.attribute);
  for (const key of [
    "gen_ai.agent.id",
    "gen_ai.agent.parent_id",
    "gen_ai.agent.type",
    "gen_ai.agent.role",
    "gen_ai.agent.name",
    "gen_ai.agent.nickname",
    "gen_ai.agent.description",
    "gen_ai.agent.prompt",
    "gen_ai.agent.instructions",
    "gen_ai.agent.transcript_path",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "agentId",
    "agent_id",
    "customAgentId",
    "custom_agent_id",
    "selectedAgentId",
    "selected_agent_id",
    "selectedSubagentId",
    "selected_subagent_id",
    "agentProfileId",
    "agent_profile_id",
    "selectedProfileId",
    "selected_profile_id",
    "profileId",
    "profile_id",
    "personaId",
    "persona_id",
    "selectedPersonaId",
    "selected_persona_id",
    "assistantId",
    "assistant_id",
    "selectedAssistantId",
    "selected_assistant_id",
    "agentSlug",
    "agent_slug",
    "profileSlug",
    "profile_slug",
    "personaSlug",
    "persona_slug",
    "assistantSlug",
    "assistant_slug",
    "slug",
    "subagentId",
    "subagent_id",
    "childProviderThreadId",
    "child_provider_thread_id",
    "childProviderThreadIds",
    "child_provider_thread_ids",
    "childThreadId",
    "child_thread_id",
    "childThreadIds",
    "child_thread_ids",
    "receiverThreadId",
    "receiver_thread_id",
    "receiverThreadIds",
    "receiver_thread_ids",
    "agentThreadId",
    "agent_thread_id",
    "agentThreadIds",
    "agent_thread_ids",
    "providerConversationId",
    "provider_conversation_id",
    "providerSideConversationId",
    "provider_side_conversation_id",
    "providerSideChatId",
    "provider_side_chat_id",
    "childProviderConversationId",
    "child_provider_conversation_id",
    "childProviderConversationIds",
    "child_provider_conversation_ids",
    "sideConversationId",
    "side_conversation_id",
    "sideChatId",
    "side_chat_id",
    "threadId",
    "thread_id",
    "sessionId",
    "session_id",
    "conversationId",
    "conversation_id",
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
    "agentRole",
    "agent_role",
    "subagentType",
    "subagent_type",
    "agentType",
    "agent_type",
    "customAgentType",
    "custom_agent_type",
    "profileType",
    "profile_type",
    "personaType",
    "persona_type",
    "assistantType",
    "assistant_type",
    "mode",
    "agentDisplayName",
    "agent_display_name",
    "agentNickname",
    "agent_nickname",
    "agentName",
    "agent_name",
    "subagentName",
    "subagent_name",
    "customAgentName",
    "custom_agent_name",
    "profileName",
    "profile_name",
    "personaName",
    "persona_name",
    "assistantName",
    "assistant_name",
    "title",
    "label",
    "model",
    "modelId",
    "model_id",
    "description",
    "summary",
    "details",
    "prompt",
    "systemPrompt",
    "system_prompt",
    "instructionsText",
    "instructions_text",
    "instructions",
    "instruction",
    "message",
    "task",
    "objective",
    "request",
    "query",
    "transcriptPath",
    "transcript_path",
    "agentTranscriptPath",
    "agent_transcript_path",
    "subagentTranscriptPath",
    "subagent_transcript_path",
    "lastAssistantMessage",
    "last_assistant_message",
    "finalAssistantMessage",
    "final_assistant_message",
    "finalMessage",
    "final_message",
    "outputText",
    "output_text",
    "content",
    "response",
    "result",
    "output",
    "messages",
    "transcript",
    "conversation",
    "events",
    "items",
    "outputs",
    "results",
  ]) {
    if (record[key] !== undefined) {
      loose[key] = record[key];
    } else if (attributes?.[key] !== undefined) {
      loose[key] = attributes[key];
    }
  }
  return Object.keys(loose).length > 0 ? loose : undefined;
}

export function mergeProviderAgentMetadata(
  ...records: ReadonlyArray<Record<string, unknown> | null | undefined>
): ProviderAgentMetadata {
  const merged: ProviderAgentMetadata = {};
  for (const record of records) {
    const metadata = providerAgentMetadataFromRecord(record);
    Object.assign(merged, {
      ...(merged.id === undefined && metadata.id ? { id: metadata.id } : {}),
      ...(merged.parentId === undefined && metadata.parentId
        ? { parentId: metadata.parentId }
        : {}),
      ...(merged.type === undefined && metadata.type ? { type: metadata.type } : {}),
      ...(merged.name === undefined && metadata.name ? { name: metadata.name } : {}),
      ...(merged.model === undefined && metadata.model ? { model: metadata.model } : {}),
      ...(merged.description === undefined && metadata.description
        ? { description: metadata.description }
        : {}),
      ...(merged.prompt === undefined && metadata.prompt ? { prompt: metadata.prompt } : {}),
      ...(merged.transcriptPath === undefined && metadata.transcriptPath
        ? { transcriptPath: metadata.transcriptPath }
        : {}),
      ...(merged.lastAssistantMessage === undefined && metadata.lastAssistantMessage
        ? { lastAssistantMessage: metadata.lastAssistantMessage }
        : {}),
    });
  }
  return merged;
}

export function normalizeProviderSideConversationType(value: string | undefined): string | null {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/^[./]+/, "")
    .replace(/[_\s]+/g, "-");
  return normalized && normalized.length > 0 ? normalized : null;
}

export function isProviderSideConversationType(value: string | undefined): boolean {
  const normalized = normalizeProviderSideConversationType(value);
  return (
    normalized === "side" ||
    normalized === "side-chat" ||
    normalized === "side-conversation" ||
    normalized === "btw"
  );
}
